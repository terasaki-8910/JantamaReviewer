//! 同期の 1 回分（F15、D-4）。
//!
//! 順番: 取り込む（pull。つながらなければ飛ばす）→ 同期用の DB の名前と版を確かめる → 手元と同期用の DB の行を突き合わせる
//! （手元に入れる・同期用の DB に書く）→ 送る（push。つながらなければ飛ばす）。
//!
//! 手元の変更を見つけるのは、通信と別に、編集のすぐあとに行う（つながらなくても、手元の写しに、編集に近い時刻で書く。
//! `merge.rs` の決まり 3）。だから、この 1 回分は「つながるか」を引数で受け、つながらなくても、手元の突き合わせまでは進む。
//!
//! 手元の変更の入れ方は、確かめてから入れる（入れる直前に、手元が突き合わせたときのままか見る）。半荘のフォルダが無い記録・結果が
//! 届く前の半荘は、結果のファイルを先に入れてから（1 回目）、もう一度突き合わせる（2 回目）。

use std::io::{Read, Write};

use flate2::read::GzDecoder;
use flate2::write::GzEncoder;
use flate2::Compression;

use super::base::{hash_of, Base, BaseState};
use super::error::{MassDeleteSide, SyncError};
use super::local::{ApplyResult, LocalAccess};
use super::merge::{decide_all, Context, LocalOp, RemoteWrite, Why};
use super::remote::{Remote, SCHEMA_VERSION};
use super::rows::{kind_of, parse_key, Kind, ReportMeta};
use crate::ids::sha256_hex;

/// 大量の消去と見なす件数の下限と割合（これ以上の件数で、かつ、記録の半分以上）。
pub const MASS_DELETE_MIN: usize = 20;

/// 展開した結果のファイルの大きさの上限（バイト）。
const MAX_REPORT_BYTES: u64 = 128 * 1024 * 1024;

/// 1 回分の指定。
#[derive(Debug, Clone, Copy)]
pub struct CycleOptions<'a> {
    /// この端末の名前。
    pub device: &'a str,
    /// いまの時刻（ミリ秒）。
    pub now_ms: i64,
    /// 通信（pull・push）を試すか。false なら、手元と手元の写しの突き合わせだけ。
    pub network: bool,
    /// 大量の消去の止めを、この 1 回だけ外す。
    pub allow_mass_delete: bool,
}

/// 1 回分の結果。
#[derive(Debug, Default, Clone, PartialEq, Eq)]
pub struct CycleReport {
    pub pulled: bool,
    pub pushed: bool,
    /// 通信が失敗した（あとでやり直す。手元の突き合わせは済んでいる）。
    pub network_error: Option<SyncError>,
    /// 手元に入れた行の数（中身を入れた・消した）。
    pub local_puts: usize,
    pub local_deletes: usize,
    /// 同期用の DB に書いた行の数（中身・消した印）。
    pub remote_puts: usize,
    pub remote_tombstones: usize,
    /// 食い違いを、新しさ・消した印の決まりで決めた数。
    pub conflicts: usize,
    /// 次の回に回した行の数（手元が変わっていた・半荘のフォルダがまだ無い）。
    pub skipped: usize,
    /// 同期用の DB の名前が変わっていて（作り直された）、前回の記録を捨てた。
    pub base_reset: bool,
    /// 注意（入れられなかった行・読めなかった記録など）。
    pub warnings: Vec<String>,
}

fn gzip(bytes: &[u8]) -> Result<Vec<u8>, SyncError> {
    let mut encoder = GzEncoder::new(Vec::new(), Compression::new(6));
    encoder
        .write_all(bytes)
        .map_err(|e| SyncError::Local(format!("結果のファイルを圧縮できません: {e}")))?;
    encoder
        .finish()
        .map_err(|e| SyncError::Local(format!("結果のファイルを圧縮できません: {e}")))
}

pub(crate) fn gunzip(bytes: &[u8]) -> Result<Vec<u8>, String> {
    let mut decoder = GzDecoder::new(bytes).take(MAX_REPORT_BYTES + 1);
    let mut out = Vec::new();
    decoder
        .read_to_end(&mut out)
        .map_err(|e| format!("結果のファイルを展開できません: {e}"))?;
    if out.len() as u64 > MAX_REPORT_BYTES {
        return Err("結果のファイルが大きすぎます".to_string());
    }
    Ok(out)
}

fn is_setting(key: &str) -> bool {
    kind_of(key) == Some(Kind::Setting)
}

/// 同期を 1 回分行う。通信の失敗は、`report.network_error` に入れて続ける（手元の突き合わせは進める）。
/// トークンが通らない・版が新しい・大量の消去・手元の記録を扱えない、は `Err`。
pub fn run_cycle(
    remote: &mut dyn Remote,
    local: &mut dyn LocalAccess,
    base: &mut Base,
    options: &CycleOptions<'_>,
) -> Result<CycleReport, SyncError> {
    let mut report = CycleReport::default();

    // 手元の写しを開いて、表を用意する（初めては、通信して、全体を取り込む）
    let mut meta = remote.ensure_schema(options.now_ms)?;

    if options.network {
        match remote.pull() {
            Ok(()) => {
                report.pulled = true;
                meta = remote.ensure_schema(options.now_ms)?;
            }
            Err(error) if error.is_offline() => report.network_error = Some(error),
            Err(error) => return Err(error),
        }
    }

    if meta.schema_version > SCHEMA_VERSION {
        return Err(SyncError::NewerSchema {
            found: meta.schema_version,
            supported: SCHEMA_VERSION,
        });
    }
    match base.db_id.as_deref() {
        Some(known) if known == meta.db_id => {}
        Some(_) => {
            // 同期用の DB が作り直された。前回の記録は、その DB のものなので捨てて、改めて突き合わせる
            base.forget_rows();
            base.db_id = Some(meta.db_id.clone());
            report.base_reset = true;
        }
        None => base.db_id = Some(meta.db_id.clone()),
    }

    let ctx = Context {
        device: options.device,
        now_ms: options.now_ms,
    };
    for pass in 0..2 {
        let legacy = !base.reconciled_once && pass == 0;
        local.prepare(legacy).map_err(SyncError::Local)?;
        let rows = remote.read_rows()?;
        let fingerprints = base
            .entries
            .iter()
            .filter_map(|(key, entry)| entry.fp.clone().map(|fp| (key.clone(), fp)))
            .collect();
        let mut snapshot = local.snapshot(&fingerprints).map_err(SyncError::Local)?;
        snapshot.known_sessions = base.known_sessions();
        for warning in &snapshot.warnings {
            if !report.warnings.contains(warning) {
                report.warnings.push(warning.clone());
            }
        }

        let skip = |key: &str| !snapshot.is_observable(key, &base.entries);
        let decisions = decide_all(&snapshot.items, &rows, &base.entries, &skip, &ctx);

        // 大量の消去の止め
        if !options.allow_mass_delete {
            let tombstones = decisions
                .iter()
                .filter(|(key, d)| {
                    !is_setting(key)
                        && d.why != Why::Repaired
                        && matches!(d.remote, Some(RemoteWrite::Tombstone { .. }))
                })
                .count();
            let base_present = base
                .entries
                .iter()
                .filter(|(key, e)| !is_setting(key) && e.state == BaseState::Present)
                .count();
            if tombstones >= MASS_DELETE_MIN && tombstones * 2 >= base_present {
                return Err(SyncError::MassDelete {
                    side: MassDeleteSide::Local,
                    count: tombstones,
                    total: base_present,
                });
            }
            let deletes = decisions
                .iter()
                .filter(|(key, d)| {
                    !is_setting(key) && matches!(d.local, Some(LocalOp::Delete { .. }))
                })
                .count();
            let local_total = snapshot.items.keys().filter(|key| !is_setting(key)).count();
            if deletes >= MASS_DELETE_MIN && deletes * 2 >= local_total {
                return Err(SyncError::MassDelete {
                    side: MassDeleteSide::Remote,
                    count: deletes,
                    total: local_total,
                });
            }
        }

        report.conflicts += decisions
            .iter()
            .filter(|(_, d)| matches!(d.why, Why::NewerLocal | Why::NewerRemote | Why::DeleteWins))
            .count();

        // 手元に入れる（結果のファイルは、同期用の DB から本体を取り出して、確かめてから）
        let mut ops: Vec<LocalOp> = Vec::new();
        let mut op_decision: Vec<usize> = Vec::new();
        let mut blobs = std::collections::BTreeMap::new();
        for (index, (key, decision)) in decisions.iter().enumerate() {
            let Some(op) = &decision.local else { continue };
            if let (LocalOp::Put { value, .. }, Some(Kind::Report)) = (op, kind_of(key)) {
                match fetch_report_body(remote, key, value) {
                    Ok(bytes) => {
                        blobs.insert(key.clone(), bytes);
                    }
                    Err(reason) => {
                        report.warnings.push(format!("{key}: {reason}"));
                        report.skipped += 1;
                        continue;
                    }
                }
            }
            ops.push(op.clone());
            op_decision.push(index);
        }
        let results = if ops.is_empty() {
            Vec::new()
        } else {
            local.apply(&ops, &blobs)
        };
        let mut applied_ok: std::collections::BTreeSet<usize> = std::collections::BTreeSet::new();
        let mut materialized = false;
        for ((op, index), result) in ops.iter().zip(&op_decision).zip(results) {
            match result {
                ApplyResult::Applied => {
                    applied_ok.insert(*index);
                    match op {
                        LocalOp::Put { key, .. } => {
                            report.local_puts += 1;
                            if kind_of(key) == Some(Kind::Report) {
                                materialized = true;
                            }
                        }
                        LocalOp::Delete { .. } => report.local_deletes += 1,
                    }
                }
                ApplyResult::Skipped(_) => report.skipped += 1,
                ApplyResult::Failed(reason) => {
                    report.skipped += 1;
                    report.warnings.push(format!("{}: {reason}", op.key()));
                }
            }
        }

        // 記録（ベース）: 入れた行と、何もしなかった行
        let mut remote_writes: Vec<RemoteWrite> = Vec::new();
        let mut remote_blobs = std::collections::BTreeMap::new();
        let mut remote_decisions: Vec<usize> = Vec::new();
        for (index, (key, decision)) in decisions.iter().enumerate() {
            if let Some(write) = &decision.remote {
                if let RemoteWrite::Put { value, .. } = write {
                    if kind_of(key) == Some(Kind::Report) {
                        match prepare_report_blob(local, key, value) {
                            Ok(bytes) => {
                                remote_blobs.insert(key.clone(), bytes);
                            }
                            Err(reason) => {
                                report.warnings.push(format!("{key}: {reason}"));
                                report.skipped += 1;
                                continue;
                            }
                        }
                    }
                }
                remote_writes.push(write.clone());
                remote_decisions.push(index);
                continue;
            }
            if decision.local.is_some() && !applied_ok.contains(&index) {
                continue;
            }
            record_base(base, key, decision.base_after.clone(), &snapshot);
        }

        // 同期用の DB に書く
        remote.write_rows(&remote_writes, &remote_blobs)?;
        for (write, index) in remote_writes.iter().zip(remote_decisions) {
            let (key, decision) = &decisions[index];
            record_base(base, key, decision.base_after.clone(), &snapshot);
            match write {
                RemoteWrite::Put { .. } => report.remote_puts += 1,
                RemoteWrite::Tombstone { .. } => report.remote_tombstones += 1,
            }
        }

        if !materialized {
            break;
        }
    }
    base.reconciled_once = true;

    if options.network {
        match remote.push() {
            Ok(()) => report.pushed = true,
            Err(error) if error.is_offline() => {
                report.network_error.get_or_insert(error);
            }
            Err(error) => return Err(error),
        }
    }
    if report.network_error.is_none() && options.network {
        base.last_ok_ms = Some(options.now_ms);
    }
    Ok(report)
}

/// 記録（ベース）の 1 行を、決定のあとの状態にする。結果のファイルは、目印（大きさ・更新時刻・指紋）も残す。
fn record_base(
    base: &mut Base,
    key: &str,
    after: Option<super::base::BaseEntry>,
    snapshot: &super::local::LocalSnapshot,
) {
    match after {
        Some(mut entry) => {
            if entry.state == BaseState::Present {
                if let (Some(fp), Some(item)) =
                    (snapshot.fingerprints.get(key), snapshot.items.get(key))
                {
                    if hash_of(&item.value) == entry.hash {
                        entry.fp = Some(fp.clone());
                    }
                }
            }
            base.entries.insert(key.to_string(), entry);
        }
        None => {
            base.entries.remove(key);
        }
    }
}

/// 同期用の DB の結果のファイルの本体を取り出して、展開し、指紋と合うか確かめる。
fn fetch_report_body(remote: &mut dyn Remote, key: &str, value: &str) -> Result<Vec<u8>, String> {
    let meta: ReportMeta =
        serde_json::from_str(value).map_err(|e| format!("結果のファイルの行を読めません: {e}"))?;
    let gz = remote
        .read_blob(key)
        .map_err(|e| e.to_string())?
        .ok_or_else(|| "結果のファイルの本体が、まだ届いていません".to_string())?;
    let bytes = gunzip(&gz)?;
    if sha256_hex(&bytes) != meta.sha256 || bytes.len() as u64 != meta.bytes {
        return Err("結果のファイルの本体が、記録の指紋と合いません".to_string());
    }
    Ok(bytes)
}

/// 手元の結果のファイルを読んで、行の指紋と合うか確かめ、圧縮する。
fn prepare_report_blob(
    local: &mut dyn LocalAccess,
    key: &str,
    value: &str,
) -> Result<Vec<u8>, String> {
    let meta: ReportMeta =
        serde_json::from_str(value).map_err(|e| format!("結果のファイルの行を読めません: {e}"))?;
    let session = parse_key(key)
        .and_then(|p| p.session.map(str::to_string))
        .ok_or_else(|| "鍵を読めません".to_string())?;
    let bytes = local.read_report(&session)?;
    if sha256_hex(&bytes) != meta.sha256 {
        return Err("結果のファイルが、読んでいる間に変わりました。次の回に送ります".to_string());
    }
    gzip(&bytes).map_err(|e| e.to_string())
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn gzip_round_trips_and_shrinks_repetitive_json() {
        let text = "{\"a\":[1,2,3,4,5,6,7,8,9]}".repeat(2000);
        let gz = gzip(text.as_bytes()).unwrap();
        assert!(gz.len() * 10 < text.len());
        assert_eq!(gunzip(&gz).unwrap(), text.as_bytes());
        assert!(gunzip(b"not gzip").is_err());
    }
}
