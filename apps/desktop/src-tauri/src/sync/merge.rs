//! 突き合わせの決まり（F15、D-4）。手元の記録・同期用の DB の行・前回の記録（ベース）の 3 つから、行ごとに「何をするか」を決める。
//! 通信も、ファイルも、時計も触らない純粋な計算（時刻は引数で受ける）。
//!
//! 決まり:
//! 1. 前回から変わったのが、手元だけ → 手元の中身を同期用の DB に書く。変わったのが同期用の DB だけ → 手元に入れる。
//! 2. 両方が変わって、同じ中身 → そのまま（記録だけ合わせる）。
//! 3. 両方が直した（中身が違う）→ 新しく直したほうを残す。更新時刻（ミリ秒）で決め、同じなら端末の名前の大きいほう（どの端末も同じ答えになる）。
//!    手元の更新時刻は、前回から変わったものは「見つけた時刻」（同期は編集のすぐあとに手元を見るので、編集の時刻に近い）。
//!    一度も同期していない行は、ファイルの更新時刻などの目印（無ければ 0 = 同期用の DB の側が勝つ）。
//! 4. 消した印は、直したものに勝つ（片方が消して、もう片方が直したら、消えたまま）。例外は 1 つ: 一度も同期していない手元の行が、
//!    消した印より新しいとき（同じ鍵で、あとから作り直したもの）は、手元が勝つ。
//! 5. 消した印を見たあと（ベースが「消えていた」）に、手元で同じ鍵を作り直したら、作り直しとして書く（消した印を上書きする）。
//! 6. 同期用の DB の行が、前回合っていたものより古くなっていた（push が競り合って、新しい書き込みが負けた）ときは、
//!    手元（前回合っていた中身）を、同じ時刻・端末のまま書き直す（新しい直しが静かに消えないように）。
//! 7. 設定は、一度も突き合わせていない端末で、手元が既定値のままなら、ほかの端末の値を先に取る（新しい端末の既定値が、
//!    すでにある設定を上書きしないように）。

use std::collections::BTreeMap;

use super::base::{hash_of, BaseEntry, BaseState};

/// 手元にある 1 行。
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct LocalItem {
    /// 中身（決まった書き方の JSON の文字。`rows::canon`）。
    pub value: String,
    /// 一度も同期していない行の更新時刻の目印（ミリ秒。ファイルの更新時刻・答えた時刻など）。
    pub hint_ms: Option<i64>,
    /// 設定で、既定値のままか（7）。
    pub is_default: bool,
}

/// 同期用の DB の 1 行（消した印は `value` が `None`）。
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct RemoteRow {
    pub value: Option<String>,
    pub updated_at: i64,
    pub device: String,
}

/// 手元に入れる操作。`expect` は、突き合わせたときの手元の中身（`None` = 無かった）。入れる直前に手元がこれと違っていたら、
/// 入れずに、次の回に回す（突き合わせている間に、画面で直されたとき）。
#[derive(Debug, Clone, PartialEq, Eq)]
pub enum LocalOp {
    Put {
        key: String,
        value: String,
        expect: Option<String>,
    },
    Delete {
        key: String,
        expect: Option<String>,
    },
}

impl LocalOp {
    pub fn key(&self) -> &str {
        match self {
            LocalOp::Put { key, .. } | LocalOp::Delete { key, .. } => key,
        }
    }
}

/// 同期用の DB に書く操作。
///
/// 書き方の約束（同期の部品は、行の変更を「変えた列だけ」の更新として送るので、これが「消した印は直しに勝つ」を支える）:
/// - `Put` は、中身・更新時刻・端末の 3 つの列だけを書く。消した印の列は書かない（ほかの端末の消した印を、静かに消さないため）。
///   `revive` が true のときだけ、消した印も外す（消した印を見たあとの作り直し）。
/// - `Tombstone` は、消した印・更新時刻・端末の列を書く。
#[derive(Debug, Clone, PartialEq, Eq)]
pub enum RemoteWrite {
    Put {
        key: String,
        value: String,
        updated_at: i64,
        device: String,
        revive: bool,
    },
    Tombstone {
        key: String,
        updated_at: i64,
        device: String,
    },
}

impl RemoteWrite {
    pub fn key(&self) -> &str {
        match self {
            RemoteWrite::Put { key, .. } | RemoteWrite::Tombstone { key, .. } => key,
        }
    }
}

/// 1 行の決定。手元に入れる・同期用の DB に書く・どちらも要らない、のどれか。
/// `base_after` は、操作が成功したあとのベース（`None` = ベースから消す）。
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct Decision {
    pub local: Option<LocalOp>,
    pub remote: Option<RemoteWrite>,
    pub base_after: Option<BaseEntry>,
    pub why: Why,
}

/// どの決まりで決めたか（統計と試験のため）。
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum Why {
    Unchanged,
    LocalOnly,
    RemoteOnly,
    Converged,
    NewerLocal,
    NewerRemote,
    DeleteWins,
    Revived,
    Repaired,
}

/// 決めるときに要る、端末の名前と、いまの時刻。
#[derive(Debug, Clone, Copy)]
pub struct Context<'a> {
    pub device: &'a str,
    pub now_ms: i64,
}

fn entry(state: BaseState, hash: String, updated_at: i64, device: &str) -> BaseEntry {
    BaseEntry {
        state,
        hash,
        updated_at,
        device: device.to_string(),
        fp: None,
    }
}

/// 更新の新しさの比べ方（更新時刻、同じなら端末の名前）。
fn newer(a: (i64, &str), b: (i64, &str)) -> bool {
    a > b
}

/// 行 1 つの突き合わせ。`local` は手元の中身（無ければ `None`）、`remote` は同期用の DB の行（無ければ `None`）、
/// `base` は前回の記録（無ければ `None`）。
pub fn decide(
    key: &str,
    local: Option<&LocalItem>,
    remote: Option<&RemoteRow>,
    base: Option<&BaseEntry>,
    ctx: &Context<'_>,
) -> Decision {
    let local_hash = local.map(|item| hash_of(&item.value));
    let remote_hash = remote.and_then(|row| row.value.as_deref().map(hash_of));

    let local_changed = match (base, &local_hash) {
        (None, Some(_)) => true,
        (None, None) => false,
        (Some(b), Some(h)) => b.state != BaseState::Present || b.hash != *h,
        (Some(b), None) => b.state == BaseState::Present,
    };

    // 同期用の DB の側が、前回から変わったか。`stale` は、前回より古い状態に戻っていた（または行が消えていた）とき。
    let (remote_changed, stale) = match (base, remote) {
        (b, None) => (false, b.is_some()),
        (None, Some(_)) => (true, false),
        (Some(b), Some(row)) => {
            let row_stamp = (row.updated_at, row.device.as_str());
            let base_stamp = (b.updated_at, b.device.as_str());
            match (b.state, &remote_hash) {
                (BaseState::Present, Some(h)) if *h == b.hash => (false, false),
                // 消した印は、更新時刻に関わらず、直しに勝つ（古く見えても、取り下げない）
                (BaseState::Present, None) => (true, false),
                (BaseState::Present, Some(_)) => {
                    if newer(base_stamp, row_stamp) {
                        (false, true)
                    } else {
                        (true, false)
                    }
                }
                (BaseState::Deleted, None) => (false, false),
                (BaseState::Deleted, Some(_)) => {
                    if newer(row_stamp, base_stamp) {
                        (true, false)
                    } else {
                        (false, true)
                    }
                }
            }
        }
    };

    let apply_remote = |row: &RemoteRow| -> Decision {
        match &row.value {
            Some(value) => Decision {
                local: Some(LocalOp::Put {
                    key: key.to_string(),
                    value: value.clone(),
                    expect: local.map(|item| item.value.clone()),
                }),
                remote: None,
                base_after: Some(entry(
                    BaseState::Present,
                    hash_of(value),
                    row.updated_at,
                    &row.device,
                )),
                why: Why::RemoteOnly,
            },
            None => Decision {
                local: local.map(|item| LocalOp::Delete {
                    key: key.to_string(),
                    expect: Some(item.value.clone()),
                }),
                remote: None,
                base_after: Some(entry(
                    BaseState::Deleted,
                    base.map(|b| b.hash.clone()).unwrap_or_default(),
                    row.updated_at,
                    &row.device,
                )),
                why: Why::RemoteOnly,
            },
        }
    };

    let remote_is_tombstone = remote.is_some_and(|row| row.value.is_none());
    let write_local = |item: &LocalItem, stamp: i64, why: Why| -> Decision {
        Decision {
            local: None,
            remote: Some(RemoteWrite::Put {
                key: key.to_string(),
                value: item.value.clone(),
                updated_at: stamp,
                device: ctx.device.to_string(),
                revive: remote_is_tombstone,
            }),
            base_after: Some(entry(
                BaseState::Present,
                hash_of(&item.value),
                stamp,
                ctx.device,
            )),
            why,
        }
    };

    let write_tombstone = |why: Why| -> Decision {
        Decision {
            local: None,
            remote: Some(RemoteWrite::Tombstone {
                key: key.to_string(),
                updated_at: ctx.now_ms,
                device: ctx.device.to_string(),
            }),
            base_after: Some(entry(
                BaseState::Deleted,
                base.map(|b| b.hash.clone()).unwrap_or_default(),
                ctx.now_ms,
                ctx.device,
            )),
            why,
        }
    };

    match (local_changed, remote_changed) {
        // どちらも変わっていない
        (false, false) => {
            if stale {
                // 6: 同期用の DB が古い状態に戻った、または行が消えた。前回合っていた中身を、同じ印のまま書き直す
                if let Some(b) = base {
                    match (b.state, local) {
                        (BaseState::Present, Some(item)) => {
                            let mut decision = write_local(item, b.updated_at, Why::Repaired);
                            decision.remote = Some(RemoteWrite::Put {
                                key: key.to_string(),
                                value: item.value.clone(),
                                updated_at: b.updated_at,
                                device: b.device.clone(),
                                revive: remote_is_tombstone,
                            });
                            decision.base_after = Some(b.clone());
                            return decision;
                        }
                        (BaseState::Deleted, None) => {
                            return Decision {
                                local: None,
                                remote: Some(RemoteWrite::Tombstone {
                                    key: key.to_string(),
                                    updated_at: b.updated_at,
                                    device: b.device.clone(),
                                }),
                                base_after: Some(b.clone()),
                                why: Why::Repaired,
                            };
                        }
                        _ => {}
                    }
                }
            }
            Decision {
                local: None,
                remote: None,
                base_after: base.cloned(),
                why: Why::Unchanged,
            }
        }
        // 手元だけが変わった
        (true, false) => match local {
            Some(item) => {
                let stamp = if base.is_none() {
                    item.hint_ms.unwrap_or(ctx.now_ms)
                } else {
                    ctx.now_ms
                };
                let why = if base.is_some_and(|b| b.state == BaseState::Deleted) {
                    Why::Revived
                } else {
                    Why::LocalOnly
                };
                write_local(item, stamp, why)
            }
            None => write_tombstone(Why::LocalOnly),
        },
        // 同期用の DB だけが変わった
        (false, true) => match remote {
            Some(row) => apply_remote(row),
            None => Decision {
                local: None,
                remote: None,
                base_after: base.cloned(),
                why: Why::Unchanged,
            },
        },
        // 両方が変わった
        (true, true) => {
            let row = remote.expect("remote_changed のとき、行がある");
            match (local, &row.value) {
                (Some(item), Some(remote_value)) => {
                    if hash_of(&item.value) == hash_of(remote_value) {
                        // 2: 同じ中身に変わっていた
                        return Decision {
                            local: None,
                            remote: None,
                            base_after: Some(entry(
                                BaseState::Present,
                                hash_of(remote_value),
                                row.updated_at,
                                &row.device,
                            )),
                            why: Why::Converged,
                        };
                    }
                    // 7: 初めての突き合わせで、手元が既定値のままの設定は、同期用の DB の値を取る
                    let first = base.is_none();
                    if first && item.is_default {
                        let mut decision = apply_remote(row);
                        decision.why = Why::NewerRemote;
                        return decision;
                    }
                    // 3: 新しく直したほうを残す
                    let local_ms = if first {
                        item.hint_ms.unwrap_or(0)
                    } else {
                        ctx.now_ms
                    };
                    if newer(
                        (local_ms, ctx.device),
                        (row.updated_at, row.device.as_str()),
                    ) {
                        write_local(item, local_ms, Why::NewerLocal)
                    } else {
                        let mut decision = apply_remote(row);
                        decision.why = Why::NewerRemote;
                        decision
                    }
                }
                (Some(item), None) => {
                    // 4: 手元の直し（または、一度も同期していない手元の行）と、消した印
                    let revived =
                        base.is_none() && item.hint_ms.is_some_and(|hint| hint > row.updated_at);
                    if revived {
                        write_local(item, item.hint_ms.unwrap_or(ctx.now_ms), Why::Revived)
                    } else {
                        let mut decision = apply_remote(row);
                        decision.why = Why::DeleteWins;
                        decision
                    }
                }
                (None, Some(_)) => {
                    // 4: 手元で消したものを、ほかの端末が直した。消したまま
                    write_tombstone(Why::DeleteWins)
                }
                (None, None) => {
                    // どちらも消した
                    Decision {
                        local: None,
                        remote: None,
                        base_after: Some(entry(
                            BaseState::Deleted,
                            base.map(|b| b.hash.clone()).unwrap_or_default(),
                            row.updated_at,
                            &row.device,
                        )),
                        why: Why::Converged,
                    }
                }
            }
        }
    }
}

/// 全部の行の突き合わせ。鍵は、手元・同期用の DB・ベースの鍵をすべて集めたもの。`skip` が true の鍵は、見ない
/// （手元の状態を、いま確かめられない半荘の記録。手元に無いからといって、消したことにしないため）。
pub fn decide_all(
    local: &BTreeMap<String, LocalItem>,
    remote: &BTreeMap<String, RemoteRow>,
    base: &BTreeMap<String, BaseEntry>,
    skip: &dyn Fn(&str) -> bool,
    ctx: &Context<'_>,
) -> Vec<(String, Decision)> {
    let mut keys: Vec<&String> = local
        .keys()
        .chain(remote.keys())
        .chain(base.keys())
        .collect();
    keys.sort();
    keys.dedup();
    let mut decisions = Vec::new();
    for key in keys {
        if skip(key) {
            continue;
        }
        let decision = decide(key, local.get(key), remote.get(key), base.get(key), ctx);
        decisions.push((key.clone(), decision));
    }
    decisions
}

#[cfg(test)]
mod tests {
    use super::*;

    const ME: &str = "d-aaaa";
    const OTHER: &str = "d-bbbb";

    fn ctx(now_ms: i64) -> Context<'static> {
        Context { device: ME, now_ms }
    }

    fn item(value: &str) -> LocalItem {
        LocalItem {
            value: value.to_string(),
            hint_ms: None,
            is_default: false,
        }
    }

    fn row(value: &str, at: i64, device: &str) -> RemoteRow {
        RemoteRow {
            value: Some(value.to_string()),
            updated_at: at,
            device: device.to_string(),
        }
    }

    fn tomb(at: i64, device: &str) -> RemoteRow {
        RemoteRow {
            value: None,
            updated_at: at,
            device: device.to_string(),
        }
    }

    fn present(value: &str, at: i64, device: &str) -> BaseEntry {
        entry(BaseState::Present, hash_of(value), at, device)
    }

    fn deleted(at: i64, device: &str) -> BaseEntry {
        entry(BaseState::Deleted, String::new(), at, device)
    }

    fn put_value(decision: &Decision) -> Option<(&str, i64, &str)> {
        match &decision.remote {
            Some(RemoteWrite::Put {
                value,
                updated_at,
                device,
                ..
            }) => Some((value.as_str(), *updated_at, device.as_str())),
            _ => None,
        }
    }

    #[test]
    fn nothing_changed_means_nothing_to_do() {
        let b = present("\"v\"", 100, OTHER);
        let d = decide(
            "k",
            Some(&item("\"v\"")),
            Some(&row("\"v\"", 100, OTHER)),
            Some(&b),
            &ctx(500),
        );
        assert_eq!(d.why, Why::Unchanged);
        assert!(d.local.is_none() && d.remote.is_none());
        assert_eq!(d.base_after, Some(b));
        // どこにも無い行も、何もしない
        let d = decide("k", None, None, None, &ctx(500));
        assert_eq!(d.why, Why::Unchanged);
        assert_eq!(d.base_after, None);
    }

    #[test]
    fn a_new_local_row_is_written_with_its_hint_or_now() {
        let mut with_hint = item("\"v\"");
        with_hint.hint_ms = Some(70);
        let d = decide("k", Some(&with_hint), None, None, &ctx(500));
        assert_eq!(put_value(&d), Some(("\"v\"", 70, ME)));
        let d = decide("k", Some(&item("\"v\"")), None, None, &ctx(500));
        assert_eq!(put_value(&d), Some(("\"v\"", 500, ME)));
        assert_eq!(d.base_after.as_ref().unwrap().state, BaseState::Present);
    }

    #[test]
    fn a_local_edit_is_written_at_the_time_it_was_noticed() {
        let b = present("\"old\"", 100, ME);
        let d = decide(
            "k",
            Some(&item("\"new\"")),
            Some(&row("\"old\"", 100, ME)),
            Some(&b),
            &ctx(900),
        );
        assert_eq!(d.why, Why::LocalOnly);
        assert_eq!(put_value(&d), Some(("\"new\"", 900, ME)));
    }

    #[test]
    fn a_remote_edit_is_put_into_the_local_records() {
        let b = present("\"old\"", 100, ME);
        let d = decide(
            "k",
            Some(&item("\"old\"")),
            Some(&row("\"new\"", 300, OTHER)),
            Some(&b),
            &ctx(900),
        );
        assert_eq!(d.why, Why::RemoteOnly);
        assert_eq!(
            d.local,
            Some(LocalOp::Put {
                key: "k".into(),
                value: "\"new\"".into(),
                expect: Some("\"old\"".into())
            })
        );
        assert_eq!(d.base_after, Some(present("\"new\"", 300, OTHER)));
    }

    #[test]
    fn a_new_remote_row_is_put_into_an_empty_local() {
        let d = decide("k", None, Some(&row("\"v\"", 300, OTHER)), None, &ctx(900));
        assert_eq!(
            d.local,
            Some(LocalOp::Put {
                key: "k".into(),
                value: "\"v\"".into(),
                expect: None
            })
        );
    }

    #[test]
    fn both_edited_to_the_same_content_just_converges() {
        let b = present("\"old\"", 100, ME);
        let d = decide(
            "k",
            Some(&item("\"same\"")),
            Some(&row("\"same\"", 300, OTHER)),
            Some(&b),
            &ctx(900),
        );
        assert_eq!(d.why, Why::Converged);
        assert!(d.local.is_none() && d.remote.is_none());
        assert_eq!(d.base_after, Some(present("\"same\"", 300, OTHER)));
    }

    #[test]
    fn both_edited_different_content_the_newer_edit_wins() {
        let b = present("\"old\"", 100, ME);
        // ほかの端末の直しのほうが新しい（手元の直しは、見つけた時刻 250）
        let d = decide(
            "k",
            Some(&item("\"mine\"")),
            Some(&row("\"theirs\"", 300, OTHER)),
            Some(&b),
            &ctx(250),
        );
        assert_eq!(d.why, Why::NewerRemote);
        assert!(matches!(d.local, Some(LocalOp::Put { .. })));
        assert!(d.remote.is_none());
        // 手元の直しのほうが新しい
        let d = decide(
            "k",
            Some(&item("\"mine\"")),
            Some(&row("\"theirs\"", 300, OTHER)),
            Some(&b),
            &ctx(400),
        );
        assert_eq!(d.why, Why::NewerLocal);
        assert_eq!(put_value(&d), Some(("\"mine\"", 400, ME)));
    }

    #[test]
    fn a_tie_goes_to_the_larger_device_name_so_every_device_agrees() {
        let b = present("\"old\"", 100, "d-0000");
        // 同じ時刻。手元 d-aaaa と相手 d-bbbb: 大きいのは相手
        let d = decide(
            "k",
            Some(&item("\"mine\"")),
            Some(&row("\"theirs\"", 300, OTHER)),
            Some(&b),
            &ctx(300),
        );
        assert_eq!(d.why, Why::NewerRemote);
        // 相手が d-0001 なら、手元が勝つ
        let d = decide(
            "k",
            Some(&item("\"mine\"")),
            Some(&row("\"theirs\"", 300, "d-0001")),
            Some(&b),
            &ctx(300),
        );
        assert_eq!(d.why, Why::NewerLocal);
    }

    #[test]
    fn deleting_beats_editing_whichever_came_last() {
        let b = present("\"old\"", 100, ME);
        // ほかの端末が消した。手元は直した → 消える
        let d = decide(
            "k",
            Some(&item("\"mine\"")),
            Some(&tomb(300, OTHER)),
            Some(&b),
            &ctx(900),
        );
        assert_eq!(d.why, Why::DeleteWins);
        assert_eq!(
            d.local,
            Some(LocalOp::Delete {
                key: "k".into(),
                expect: Some("\"mine\"".into())
            })
        );
        assert_eq!(d.base_after.as_ref().unwrap().state, BaseState::Deleted);
        // 手元で消した。ほかの端末は直した（あとから） → 消した印を書く
        let d = decide(
            "k",
            None,
            Some(&row("\"theirs\"", 9_000, OTHER)),
            Some(&b),
            &ctx(500),
        );
        assert_eq!(d.why, Why::DeleteWins);
        assert!(matches!(d.remote, Some(RemoteWrite::Tombstone { .. })));
    }

    #[test]
    fn both_deleted_converges_and_a_remote_delete_of_a_local_row_deletes_it() {
        let b = present("\"old\"", 100, ME);
        let d = decide("k", None, Some(&tomb(300, OTHER)), Some(&b), &ctx(900));
        assert_eq!(d.why, Why::Converged);
        assert!(d.local.is_none() && d.remote.is_none());
        // 手元は直していない。ほかの端末が消した → 手元でも消す
        let d = decide(
            "k",
            Some(&item("\"old\"")),
            Some(&tomb(300, OTHER)),
            Some(&b),
            &ctx(900),
        );
        assert_eq!(d.why, Why::RemoteOnly);
        assert!(matches!(d.local, Some(LocalOp::Delete { .. })));
    }

    #[test]
    fn a_local_delete_writes_a_tombstone() {
        let b = present("\"old\"", 100, ME);
        let d = decide(
            "k",
            None,
            Some(&row("\"old\"", 100, ME)),
            Some(&b),
            &ctx(900),
        );
        assert_eq!(d.why, Why::LocalOnly);
        assert_eq!(
            d.remote,
            Some(RemoteWrite::Tombstone {
                key: "k".into(),
                updated_at: 900,
                device: ME.into()
            })
        );
    }

    #[test]
    fn recreating_a_key_after_seeing_its_delete_revives_it() {
        let b = deleted(300, OTHER);
        let d = decide(
            "k",
            Some(&item("\"again\"")),
            Some(&tomb(300, OTHER)),
            Some(&b),
            &ctx(900),
        );
        assert_eq!(d.why, Why::Revived);
        assert_eq!(put_value(&d), Some(("\"again\"", 900, ME)));
    }

    #[test]
    fn a_row_never_synced_here_loses_to_an_older_tombstone_unless_it_is_newer() {
        // 一度も同期していない手元の行（目印 100）と、新しい消した印（300）→ 消える
        let mut old = item("\"v\"");
        old.hint_ms = Some(100);
        let d = decide("k", Some(&old), Some(&tomb(300, OTHER)), None, &ctx(900));
        assert_eq!(d.why, Why::DeleteWins);
        // 目印が消した印より新しい → 手元が勝つ（作り直し）
        let mut newer_item = item("\"v\"");
        newer_item.hint_ms = Some(500);
        let d = decide(
            "k",
            Some(&newer_item),
            Some(&tomb(300, OTHER)),
            None,
            &ctx(900),
        );
        assert_eq!(d.why, Why::Revived);
        assert_eq!(put_value(&d), Some(("\"v\"", 500, ME)));
        // 目印の無い行は、消えるほうに倒す
        let d = decide(
            "k",
            Some(&item("\"v\"")),
            Some(&tomb(300, OTHER)),
            None,
            &ctx(900),
        );
        assert_eq!(d.why, Why::DeleteWins);
    }

    #[test]
    fn first_sync_conflicts_use_the_hint_and_prefer_the_remote_without_one() {
        let mut newer_local = item("\"mine\"");
        newer_local.hint_ms = Some(500);
        let d = decide(
            "k",
            Some(&newer_local),
            Some(&row("\"theirs\"", 300, OTHER)),
            None,
            &ctx(900),
        );
        assert_eq!(d.why, Why::NewerLocal);
        assert_eq!(put_value(&d), Some(("\"mine\"", 500, ME)));
        let d = decide(
            "k",
            Some(&item("\"mine\"")),
            Some(&row("\"theirs\"", 300, OTHER)),
            None,
            &ctx(900),
        );
        assert_eq!(d.why, Why::NewerRemote);
    }

    #[test]
    fn a_default_setting_never_overwrites_the_remote_on_the_first_sync() {
        let mut default = item("true");
        default.is_default = true;
        default.hint_ms = Some(9_999_999);
        let d = decide(
            "s:sound",
            Some(&default),
            Some(&row("false", 300, OTHER)),
            None,
            &ctx(900),
        );
        assert_eq!(d.why, Why::NewerRemote);
        assert!(matches!(d.local, Some(LocalOp::Put { .. })));
        // 既定値でない設定は、時刻で決める
        let mut changed = item("true");
        changed.hint_ms = Some(9_999_999);
        let d = decide(
            "s:sound",
            Some(&changed),
            Some(&row("false", 300, OTHER)),
            None,
            &ctx(900),
        );
        assert_eq!(d.why, Why::NewerLocal);
    }

    #[test]
    fn a_remote_row_that_went_back_in_time_is_written_again_with_its_old_stamp() {
        // 前回、手元（時刻 500、端末 ME）で合っていた。push が競り合って、同期用の DB の行が古い中身（時刻 200）に戻った
        let b = present("\"mine\"", 500, ME);
        let d = decide(
            "k",
            Some(&item("\"mine\"")),
            Some(&row("\"stale\"", 200, OTHER)),
            Some(&b),
            &ctx(900),
        );
        assert_eq!(d.why, Why::Repaired);
        assert_eq!(put_value(&d), Some(("\"mine\"", 500, ME)));
        assert!(d.local.is_none());
        assert_eq!(d.base_after, Some(b));
    }

    #[test]
    fn a_vanished_remote_row_is_restored_from_the_local_copy() {
        let b = present("\"mine\"", 500, ME);
        let d = decide("k", Some(&item("\"mine\"")), None, Some(&b), &ctx(900));
        assert_eq!(d.why, Why::Repaired);
        assert_eq!(put_value(&d), Some(("\"mine\"", 500, ME)));
        // 消した印の行が消えたときも、消した印を書き直す
        let b = deleted(500, ME);
        let d = decide("k", None, None, Some(&b), &ctx(900));
        assert_eq!(d.why, Why::Repaired);
        assert!(matches!(
            d.remote,
            Some(RemoteWrite::Tombstone {
                updated_at: 500,
                ..
            })
        ));
    }

    #[test]
    fn a_stale_remote_with_a_newer_local_edit_writes_the_edit() {
        let b = present("\"mine\"", 500, ME);
        let d = decide(
            "k",
            Some(&item("\"edited\"")),
            Some(&row("\"stale\"", 200, OTHER)),
            Some(&b),
            &ctx(900),
        );
        assert_eq!(d.why, Why::LocalOnly);
        assert_eq!(put_value(&d), Some(("\"edited\"", 900, ME)));
    }

    #[test]
    fn decide_all_visits_every_key_once_and_skips_the_unobservable_ones() {
        let mut local = BTreeMap::new();
        local.insert("a:1".to_string(), item("\"x\""));
        local.insert("mm:S:1".to_string(), item("\"m\""));
        let mut remote = BTreeMap::new();
        remote.insert("a:2".to_string(), row("\"y\"", 10, OTHER));
        remote.insert("mm:S:1".to_string(), row("\"m\"", 5, OTHER));
        let mut base = BTreeMap::new();
        base.insert("mm:S:9".to_string(), present("\"gone\"", 1, ME));
        let skip = |key: &str| key.starts_with("mm:S:");
        let decisions = decide_all(&local, &remote, &base, &skip, &ctx(100));
        let keys: Vec<&str> = decisions.iter().map(|(k, _)| k.as_str()).collect();
        assert_eq!(keys, ["a:1", "a:2"]);
        // skip しなければ、手元に無いベースの行は、消した扱いになる
        let all = decide_all(&local, &remote, &base, &|_| false, &ctx(100));
        let gone = all.iter().find(|(k, _)| k == "mm:S:9").unwrap();
        assert!(matches!(gone.1.remote, Some(RemoteWrite::Tombstone { .. })));
    }

    // ---- 2 台の端末の模擬（1 つの鍵） ----
    //
    // 同期用の DB は 2 層: 各端末の手元の写し（`view`）と、サーバー。手元の写しへの書き込みは、「変えた列だけの更新」として溜まり
    // （`pending`）、push で初めてサーバーに届く。サーバーの行に対しては、あとに届いた更新が、その列を上書きする。
    // pull は、サーバーの行を取り込んだうえで、未送信の更新を重ね直す（手元の写しは、自分の未送信の直しを持ち続ける）。
    // 実際の同期の部品（Turso の同期）も、この動き（試験 `tursodb --sync-server` で確かめる）。

    #[derive(Clone, Debug)]
    struct Row2 {
        value: Option<String>,
        deleted: bool,
        stamp: (i64, String),
    }

    #[derive(Clone, Debug)]
    enum Op {
        Put {
            value: String,
            stamp: (i64, String),
            revive: bool,
        },
        Tomb {
            stamp: (i64, String),
        },
    }

    fn apply_op(row: &mut Option<Row2>, op: &Op) {
        match op {
            Op::Put {
                value,
                stamp,
                revive,
            } => {
                let r = row.get_or_insert_with(|| Row2 {
                    value: None,
                    deleted: false,
                    stamp: stamp.clone(),
                });
                r.value = Some(value.clone());
                r.stamp = stamp.clone();
                if *revive {
                    r.deleted = false;
                }
            }
            Op::Tomb { stamp } => {
                let r = row.get_or_insert_with(|| Row2 {
                    value: None,
                    deleted: false,
                    stamp: stamp.clone(),
                });
                r.deleted = true;
                r.stamp = stamp.clone();
            }
        }
    }

    fn as_remote(row: &Option<Row2>) -> Option<RemoteRow> {
        row.as_ref().map(|r| RemoteRow {
            value: if r.deleted { None } else { r.value.clone() },
            updated_at: r.stamp.0,
            device: r.stamp.1.clone(),
        })
    }

    #[derive(Clone)]
    struct Device {
        name: &'static str,
        local: Option<String>,
        base: Option<BaseEntry>,
        view: Option<Row2>,
        pending: Vec<Op>,
        hint: Option<i64>,
    }

    /// 手元を見て、突き合わせる（通信なし）。手元の写しに書く。
    fn reconcile(device: &mut Device, now: i64) {
        let ctx = Context {
            device: device.name,
            now_ms: now,
        };
        let local = device.local.as_ref().map(|value| LocalItem {
            value: value.clone(),
            hint_ms: device.hint,
            is_default: false,
        });
        let view = as_remote(&device.view);
        let d = decide(
            "k",
            local.as_ref(),
            view.as_ref(),
            device.base.as_ref(),
            &ctx,
        );
        match d.local {
            Some(LocalOp::Put { value, .. }) => device.local = Some(value),
            Some(LocalOp::Delete { .. }) => device.local = None,
            None => {}
        }
        let op = match d.remote {
            Some(RemoteWrite::Put {
                value,
                updated_at,
                device: by,
                revive,
                ..
            }) => Some(Op::Put {
                value,
                stamp: (updated_at, by),
                revive,
            }),
            Some(RemoteWrite::Tombstone {
                updated_at,
                device: by,
                ..
            }) => Some(Op::Tomb {
                stamp: (updated_at, by),
            }),
            None => None,
        };
        if let Some(op) = op {
            apply_op(&mut device.view, &op);
            device.pending.push(op);
        }
        device.base = d.base_after;
        device.hint = None;
    }

    fn pull(device: &mut Device, server: &Option<Row2>) {
        let mut view = server.clone();
        for op in &device.pending {
            apply_op(&mut view, op);
        }
        device.view = view;
    }

    fn push(device: &mut Device, server: &mut Option<Row2>) {
        for op in device.pending.drain(..) {
            apply_op(server, &op);
        }
    }

    /// 1 回の同期: pull → 突き合わせ → push。
    fn cycle(device: &mut Device, server: &mut Option<Row2>, now: i64) {
        pull(device, server);
        reconcile(device, now);
        push(device, server);
    }

    fn settle(a: &mut Device, b: &mut Device, server: &mut Option<Row2>, mut now: i64) {
        for _ in 0..5 {
            now += 10;
            cycle(a, server, now);
            now += 10;
            cycle(b, server, now);
        }
    }

    fn two_devices(initial: Option<&str>) -> (Device, Device, Option<Row2>) {
        let (base, server) = match initial {
            Some(value) => (
                Some(present(value, 100, "d-seed")),
                Some(Row2 {
                    value: Some(value.to_string()),
                    deleted: false,
                    stamp: (100, "d-seed".to_string()),
                }),
            ),
            None => (None, None),
        };
        let make = |name| Device {
            name,
            local: initial.map(str::to_string),
            base: base.clone(),
            view: server.clone(),
            pending: Vec::new(),
            hint: None,
        };
        (make("d-aaaa"), make("d-bbbb"), server)
    }

    fn server_value(server: &Option<Row2>) -> Option<String> {
        as_remote(server).and_then(|row| row.value)
    }

    #[test]
    fn two_devices_editing_the_same_row_settle_on_the_newer_edit() {
        for a_pushes_first in [true, false] {
            let (mut a, mut b, mut server) = two_devices(Some("\"old\""));
            // A が 1000 に、B が 2000 に直す。手元を見るのは、直したすぐあと（オフラインでも、手元の写しに書く）
            a.local = Some("\"A\"".into());
            reconcile(&mut a, 1_000);
            b.local = Some("\"B\"".into());
            reconcile(&mut b, 2_000);
            // つながって、push の順は、どちらもありえる
            if a_pushes_first {
                cycle(&mut a, &mut server, 3_000);
                cycle(&mut b, &mut server, 3_010);
            } else {
                cycle(&mut b, &mut server, 3_000);
                cycle(&mut a, &mut server, 3_010);
            }
            settle(&mut a, &mut b, &mut server, 4_000);
            assert_eq!(a.local.as_deref(), Some("\"B\""), "{a_pushes_first}");
            assert_eq!(b.local.as_deref(), Some("\"B\""), "{a_pushes_first}");
            assert_eq!(
                server_value(&server).as_deref(),
                Some("\"B\""),
                "{a_pushes_first}"
            );
        }
    }

    #[test]
    fn an_older_offline_edit_that_is_pushed_last_is_repaired_by_the_newer_device() {
        let (mut a, mut b, mut server) = two_devices(Some("\"old\""));
        // A は 1000 にオフラインで直す（手元の写しに、時刻 1000 で書く）
        a.local = Some("\"A\"".into());
        reconcile(&mut a, 1_000);
        // B は 2000 に直して、すぐ同期する
        b.local = Some("\"B\"".into());
        reconcile(&mut b, 2_000);
        push(&mut b, &mut server);
        assert_eq!(server_value(&server).as_deref(), Some("\"B\""));
        // A がやっとつながる: push で、古い 1000 の直しが、サーバーの B を上書きする
        push(&mut a, &mut server);
        assert_eq!(server_value(&server).as_deref(), Some("\"A\""));
        // B が次に同期すると、サーバーの行が前回より古いと気づいて、B を同じ印で書き直す（6）
        cycle(&mut b, &mut server, 3_000);
        assert_eq!(server_value(&server).as_deref(), Some("\"B\""));
        assert_eq!(server.as_ref().unwrap().stamp.0, 2_000);
        // A は、新しいほうを取り込む
        cycle(&mut a, &mut server, 3_500);
        assert_eq!(a.local.as_deref(), Some("\"B\""));
        settle(&mut a, &mut b, &mut server, 4_000);
        assert_eq!(a.local, b.local);
        assert_eq!(b.local.as_deref(), Some("\"B\""));
    }

    #[test]
    fn delete_versus_edit_settles_deleted_for_both_orders() {
        for a_first in [true, false] {
            let (mut a, mut b, mut server) = two_devices(Some("\"old\""));
            a.local = None;
            reconcile(&mut a, 1_000);
            b.local = Some("\"B\"".into());
            reconcile(&mut b, 2_000);
            if a_first {
                cycle(&mut a, &mut server, 3_000);
                cycle(&mut b, &mut server, 3_010);
            } else {
                cycle(&mut b, &mut server, 3_000);
                cycle(&mut a, &mut server, 3_010);
            }
            settle(&mut a, &mut b, &mut server, 4_000);
            assert_eq!(a.local, None, "a_first={a_first}");
            assert_eq!(b.local, None, "a_first={a_first}");
            assert_eq!(server_value(&server), None, "a_first={a_first}");
            assert!(as_remote(&server).is_some(), "消した印の行は残る");
        }
    }

    #[test]
    fn two_new_rows_with_the_same_key_settle_on_one_value_on_both() {
        // 同じ鍵を、2 台が別々に作った（一度も同期していない）
        let (mut a, mut b, mut server) = two_devices(None);
        a.local = Some("\"A\"".into());
        a.hint = Some(1_000);
        b.local = Some("\"B\"".into());
        b.hint = Some(2_000);
        cycle(&mut a, &mut server, 5_000);
        cycle(&mut b, &mut server, 5_010);
        settle(&mut a, &mut b, &mut server, 6_000);
        assert_eq!(a.local, b.local);
        assert_eq!(a.local.as_deref(), Some("\"B\""), "目印が新しい B が残る");
    }

    #[test]
    fn a_delete_then_a_recreate_after_syncing_comes_back_everywhere() {
        let (mut a, mut b, mut server) = two_devices(Some("\"old\""));
        a.local = None;
        cycle(&mut a, &mut server, 1_000);
        settle(&mut a, &mut b, &mut server, 1_100);
        assert_eq!(b.local, None);
        // A が、同じ鍵で作り直す（消した印を外す書き込み）
        a.local = Some("\"again\"".into());
        cycle(&mut a, &mut server, 5_000);
        settle(&mut a, &mut b, &mut server, 5_100);
        assert_eq!(b.local.as_deref(), Some("\"again\""));
        assert_eq!(a.local.as_deref(), Some("\"again\""));
    }

    #[test]
    fn a_new_row_made_on_one_device_reaches_the_other_and_a_later_edit_flows_back() {
        let (mut a, mut b, mut server) = two_devices(None);
        a.local = Some("\"first\"".into());
        cycle(&mut a, &mut server, 1_000);
        cycle(&mut b, &mut server, 1_100);
        assert_eq!(b.local.as_deref(), Some("\"first\""));
        b.local = Some("\"second\"".into());
        cycle(&mut b, &mut server, 2_000);
        cycle(&mut a, &mut server, 2_100);
        assert_eq!(a.local.as_deref(), Some("\"second\""));
        // 何も変えずに何度回しても、動かない
        settle(&mut a, &mut b, &mut server, 3_000);
        assert_eq!(server.as_ref().unwrap().stamp.0, 2_000);
    }

    #[test]
    fn the_server_row_vanishing_after_a_rebuild_is_restored_by_each_device_without_loss() {
        let (mut a, mut b, _server) = two_devices(Some("\"keep\""));
        let mut server: Option<Row2> = None;
        a.view = None;
        b.view = None;
        settle(&mut a, &mut b, &mut server, 5_000);
        assert_eq!(a.local.as_deref(), Some("\"keep\""));
        assert_eq!(b.local.as_deref(), Some("\"keep\""));
        assert_eq!(server_value(&server).as_deref(), Some("\"keep\""));
    }

    #[test]
    fn a_stale_tombstone_that_looks_old_still_deletes() {
        // B の直し（2000）のあとに、A の消した印（1000。古い時刻）が、サーバーに届いた。それでも消える
        let (mut a, mut b, mut server) = two_devices(Some("\"old\""));
        b.local = Some("\"B\"".into());
        cycle(&mut b, &mut server, 2_000);
        a.local = None;
        reconcile(&mut a, 1_000);
        push(&mut a, &mut server);
        settle(&mut a, &mut b, &mut server, 4_000);
        assert_eq!(a.local, None);
        assert_eq!(b.local, None);
    }
}
