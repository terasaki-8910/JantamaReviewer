//! 手元の記録を、同期の行として見る・手元に入れる（F15、D-4）。
//!
//! - `snapshot`: 手元の記録（`study.sqlite`・半荘のフォルダの JSON・設定・結果のファイル）を、鍵と値の行にして返す。何も書き換えない。
//! - `apply`: ほかの端末から届いた行を、手元の記録に入れる（入れる直前に、手元がまだ突き合わせたときのままか確かめる）。
//! - `prepare`: 迷いマークの無い迷いのメモに、同期の id（uid）を付ける（同期を入れる前に書いたものも）。
//!
//! 同期するもの・しないものは `rows.rs`。同期しない: スクショ（`marks/`・`ratings/`）・ウィジェットの記録（`events.jsonl`）・
//! 文字認識の写し（`ocr.json`）・設定のうちデータの保存先と窓の位置。ここの走査は、この 3 つのファイルに触れない（試験で確かめる）。
//!
//! 手元の状態を確かめられない半荘は、「無い」ことにせずに、見ない（消した印を作らないため）:
//! 消した半荘の置き場（`trash/`）にある半荘・JSON を読めない半荘・まだフォルダの無い半荘（結果が届くまで）。

use std::collections::{BTreeMap, BTreeSet};
use std::fs;
use std::io;
use std::path::{Path, PathBuf};

use serde::de::DeserializeOwned;

use super::base::BaseEntry;
use super::merge::{LocalItem, LocalOp};
use super::rows::{canon, make_key, parse_key, ExtraValue, Kind, ReportMeta};
use crate::ids::{new_uid, sha256_hex};
use crate::settings::Settings;
use crate::store::{
    valid_session_id, write_atomic, ExtraMemo, Links, Maka, MemoText, Memos, SelfRating,
    SelfRatings, SessionRecords, GAMES_DIR, LINKS_FILE, MAKA_FILE, MEMOS_FILE, REPORT_FILE,
    SELF_RATINGS_FILE, TRASH_DIR,
};
use crate::study::uid::legacy_extra_uid;
use crate::study::{
    AnswerRow, DailySetRecord, NewAnswer, ProblemRef, StudyDb, WeekRecord, STUDY_FILE,
};

/// 同期する設定の項目の名前（データの保存先と窓の位置は入れない）。
pub const SETTING_NAMES: [&str; 9] = [
    "trigger",
    "orientation",
    "sound",
    "capture_keywords",
    "daily_count",
    "disagreement_percent",
    "highlight_dora",
    "show_all_mismatches",
    "replay_keys",
];

/// 半荘の置き場所。
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum SessionState {
    /// 保存先の `games/` にある。
    Present,
    /// 消した半荘の置き場（`trash/`）にある（元に戻せる間）。
    Trashed,
    /// どちらにも無い。
    Gone,
}

/// 手元の記録の写し。
#[derive(Debug, Default)]
pub struct LocalSnapshot {
    pub items: BTreeMap<String, LocalItem>,
    /// 結果のファイルの目印（鍵 → `大きさ:更新時刻:SHA-256`）。ベースに残して、変わっていなければ、中身を読み直さない。
    pub fingerprints: BTreeMap<String, String>,
    /// 半荘の置き場所（`games/`・`trash/` にあるもの、と、ベースが覚えているもの）。
    pub sessions: BTreeMap<String, SessionState>,
    /// JSON を読めなかった（形が壊れている・uid が無い）半荘。
    pub unreadable: BTreeSet<String>,
    /// 前回までに突き合わせたことのある半荘の名前（ベースに出てくるもの。呼ぶ側が入れる）。
    pub known_sessions: BTreeSet<String>,
    pub warnings: Vec<String>,
}

impl LocalSnapshot {
    /// 手元の状態を確かめられる鍵か（確かめられない鍵は、突き合わせない）。
    /// `base` は、前回の記録（結果のファイルを手で消されたとき、半荘ごと消えたことにしないため）。
    pub fn is_observable(&self, key: &str, base: &BTreeMap<String, BaseEntry>) -> bool {
        let Some(parsed) = parse_key(key) else {
            return false;
        };
        let Some(session) = parsed.session else {
            return true;
        };
        match self.sessions.get(session) {
            Some(SessionState::Present) => {
                if self.unreadable.contains(session) {
                    return false;
                }
                // 半荘のフォルダはあるのに、結果のファイルが無い: 前回あった結果を、手で消したのかもしれない。消した印にはしない
                if parsed.kind == Kind::Report && !self.items.contains_key(key) {
                    return !base.contains_key(key);
                }
                true
            }
            Some(SessionState::Trashed) => false,
            Some(SessionState::Gone) | None => {
                parsed.kind == Kind::Report || self.known_sessions.contains(session)
            }
        }
    }
}

/// 手元に入れた結果。
#[derive(Debug, Clone, PartialEq, Eq)]
pub enum ApplyResult {
    /// 入れた（または、すでにそのとおりだった）。
    Applied,
    /// 入れずに、次の回に回す（手元が、突き合わせたときから変わっていた・半荘のフォルダが無い、など）。
    Skipped(String),
    /// 入れられなかった（値が正しくない・書けない）。
    Failed(String),
}

/// 手元の記録を見る・書く口。
pub trait LocalAccess {
    /// 同期の id が無い迷いのメモに、id を付ける。`legacy` が true（まだ一度も突き合わせていない）なら、内容から決めた id にする。
    fn prepare(&mut self, legacy: bool) -> Result<(), String>;
    /// 手元の記録の写し。`known_fingerprints` は、前回の結果のファイルの目印。
    fn snapshot(
        &mut self,
        known_fingerprints: &BTreeMap<String, String>,
    ) -> Result<LocalSnapshot, String>;
    /// 操作を、渡した順に手元に入れる。結果は、同じ順。`blobs` は、結果のファイルの行（鍵 `r:…`）を入れるための、展開した中身。
    fn apply(&mut self, ops: &[LocalOp], blobs: &BTreeMap<String, Vec<u8>>) -> Vec<ApplyResult>;
    /// 半荘の結果のファイルの中身（同期用の DB に送るため）。
    fn read_report(&mut self, session: &str) -> Result<Vec<u8>, String>;
}

/// 手元の記録に触れる、アプリの側の口。本物は、アプリの記録の錠・答えの接続・設定を使い、試験は、一時フォルダを使う。
pub trait Ports: Send + Sync {
    /// 保存先。
    fn data_dir(&self) -> PathBuf;
    /// アプリの記録の錠を持ったまま `f` を動かす（ファイルの読み書きが、画面からの保存と重ならないように）。
    fn with_records_lock(&self, f: &mut dyn FnMut());
    /// 答えの接続で `f` を動かす。
    fn with_study(
        &self,
        f: &mut dyn FnMut(&mut StudyDb) -> Result<(), String>,
    ) -> Result<(), String>;
    /// いまの設定。
    fn settings(&self) -> Settings;
    /// 設定のファイルの最後の更新の時刻（ミリ秒。無ければ `None`）。
    fn settings_hint_ms(&self) -> Option<i64>;
    /// 設定を替える（窓・フック・保存に反映して、画面に知らせる）。
    fn apply_settings(&self, settings: Settings) -> Result<(), String>;
    /// 半荘を消す（保存先の `trash/` へ移す。ウィジェットが記録中なら閉じる）。
    fn delete_session(&self, id: &str) -> Result<(), String>;
}

/// 手元の記録の読み書き（保存先のファイルと、答えの接続と、設定）。
pub struct FsLocal<P: Ports> {
    ports: P,
}

impl<P: Ports> FsLocal<P> {
    pub fn new(ports: P) -> FsLocal<P> {
        FsLocal { ports }
    }

    pub fn ports(&self) -> &P {
        &self.ports
    }
}

// ---- ファイルの道具 ----

fn mtime_ms(path: &Path) -> Option<i64> {
    let modified = fs::metadata(path).ok()?.modified().ok()?;
    let since = modified.duration_since(std::time::UNIX_EPOCH).ok()?;
    i64::try_from(since.as_millis()).ok()
}

/// JSON のファイルを、厳しく読む。無ければ `Ok(None)`、読めなければ `Err`（壊れたファイルを、空と見なして、消した印を作らないため）。
fn read_strict<T: DeserializeOwned>(path: &Path) -> Result<Option<T>, String> {
    match fs::read_to_string(path) {
        Ok(text) => serde_json::from_str(&text)
            .map(Some)
            .map_err(|e| format!("{}: {e}", file_label(path))),
        Err(e) if e.kind() == io::ErrorKind::NotFound => Ok(None),
        Err(e) => Err(format!("{}: {e}", file_label(path))),
    }
}

fn file_label(path: &Path) -> String {
    let name = path
        .file_name()
        .map(|n| n.to_string_lossy().into_owned())
        .unwrap_or_default();
    let session = path
        .parent()
        .and_then(Path::file_name)
        .map(|n| n.to_string_lossy().into_owned())
        .unwrap_or_default();
    format!("{session}/{name}")
}

/// 保存先の下のフォルダ `sub`（`games` か `trash`）の中の、半荘の名前の形のフォルダ。
fn list_session_dirs(root: &Path, sub: &str) -> BTreeSet<String> {
    let mut ids = BTreeSet::new();
    let Ok(entries) = fs::read_dir(root.join(sub)) else {
        return ids;
    };
    for entry in entries.flatten() {
        if !entry.file_type().is_ok_and(|t| t.is_dir()) {
            continue;
        }
        if let Some(name) = entry.file_name().to_str() {
            if valid_session_id(name) {
                ids.insert(name.to_string());
            }
        }
    }
    ids
}

/// 半荘のフォルダの 4 つの記録のファイルを読む。
fn read_session_records(dir: &Path) -> Result<SessionRecords, String> {
    Ok(SessionRecords {
        links: read_strict::<Links>(&dir.join(LINKS_FILE))?.unwrap_or_default(),
        self_ratings: read_strict::<SelfRatings>(&dir.join(SELF_RATINGS_FILE))?.unwrap_or_default(),
        maka: read_strict::<Maka>(&dir.join(MAKA_FILE))?.unwrap_or_default(),
        memos: read_strict::<Memos>(&dir.join(MEMOS_FILE))?.unwrap_or_default(),
    })
}

/// 4 つのファイルのうち、中身が変わったものだけを書く（空になった種類のファイルは消す）。
fn write_changed_records(dir: &Path, records: &SessionRecords) -> Result<(), String> {
    let files = records.files().map_err(|e| e.to_string())?;
    for (name, text) in files {
        let path = dir.join(name);
        let current = fs::read_to_string(&path).ok();
        match text {
            Some(text) => {
                // 同じ中身を、書き直さない（更新時刻を動かさない）。書き方（整形）が違うだけのときは、置き換える
                if current.as_deref() != Some(text.as_str()) {
                    write_atomic(&path, text.as_bytes()).map_err(|e| format!("{name}: {e}"))?;
                }
            }
            None => {
                if current.is_some() {
                    match fs::remove_file(&path) {
                        Ok(()) => {}
                        Err(e) if e.kind() == io::ErrorKind::NotFound => {}
                        Err(e) => return Err(format!("{name}: {e}")),
                    }
                }
            }
        }
    }
    Ok(())
}

// ---- 半荘ごとの記録 ⇄ 行 ----

/// 半荘の記録を、行（鍵・値・どのファイルか）にする。`extras` の uid が無いと、`None`（見ない）。
fn session_rows(
    session: &str,
    records: &SessionRecords,
) -> Option<Vec<(String, String, &'static str)>> {
    let mut rows: Vec<(String, String, &'static str)> = Vec::new();
    for (id, value) in &records.links.marks {
        rows.push((
            make_key(Kind::MarkLink, &[session, id]),
            canon(value),
            LINKS_FILE,
        ));
    }
    for (id, value) in &records.links.ratings {
        rows.push((
            make_key(Kind::RatingLink, &[session, id]),
            canon(value),
            LINKS_FILE,
        ));
    }
    if let Some(version) = records.links.ratings_version {
        rows.push((
            make_key(Kind::RatingsVersion, &[session]),
            canon(&version),
            LINKS_FILE,
        ));
    }
    for (kyoku, rating) in &records.self_ratings.kyokus {
        rows.push((
            make_key(Kind::SelfRating, &[session, kyoku]),
            canon(rating),
            SELF_RATINGS_FILE,
        ));
    }
    for (kyoku, grade) in &records.maka.kyokus {
        rows.push((
            make_key(Kind::MakaKyoku, &[session, kyoku]),
            canon(grade),
            MAKA_FILE,
        ));
    }
    if let Some(grade) = &records.maka.hanchan {
        rows.push((
            make_key(Kind::MakaHanchan, &[session]),
            canon(grade),
            MAKA_FILE,
        ));
    }
    for (id, memo) in &records.memos.marks {
        rows.push((
            make_key(Kind::MarkMemo, &[session, id]),
            canon(memo),
            MEMOS_FILE,
        ));
    }
    for extra in &records.memos.extras {
        let uid = extra.uid.as_deref()?;
        rows.push((
            make_key(Kind::ExtraMemo, &[session, uid]),
            canon(&ExtraValue::of(extra)),
            MEMOS_FILE,
        ));
    }
    Some(rows)
}

/// 半荘の記録の中の、鍵の行の、いまの中身（無ければ `None`）。
fn session_value(records: &SessionRecords, kind: Kind, rest: &str) -> Option<String> {
    match kind {
        Kind::MarkLink => records.links.marks.get(rest).map(canon),
        Kind::RatingLink => records.links.ratings.get(rest).map(canon),
        Kind::RatingsVersion => records.links.ratings_version.as_ref().map(canon),
        Kind::SelfRating => records.self_ratings.kyokus.get(rest).map(canon),
        Kind::MakaKyoku => records.maka.kyokus.get(rest).map(canon),
        Kind::MakaHanchan => records.maka.hanchan.as_ref().map(canon),
        Kind::MarkMemo => records.memos.marks.get(rest).map(canon),
        Kind::ExtraMemo => records
            .memos
            .extras
            .iter()
            .find(|extra| extra.uid.as_deref() == Some(rest))
            .map(|extra| canon(&ExtraValue::of(extra))),
        _ => None,
    }
}

fn parse_value<T: DeserializeOwned>(text: &str, what: &str) -> Result<T, String> {
    serde_json::from_str(text).map_err(|e| format!("{what}の値を読めません: {e}"))
}

/// 迷いマークの無い迷いのメモの、次の呼び名（`x` + 数字。いまある呼び名の最大の数字の次）。
fn next_extra_label(extras: &[ExtraMemo]) -> String {
    let max = extras
        .iter()
        .filter_map(|extra| extra.id.strip_prefix('x')?.parse::<u64>().ok())
        .max()
        .unwrap_or(0);
    let mut n = max + 1;
    loop {
        let label = format!("x{n}");
        if !extras.iter().any(|extra| extra.id == label) {
            return label;
        }
        n += 1;
    }
}

/// 半荘の記録に、鍵の行を 1 つ入れる（値が `None` なら、消す）。
fn set_session_row(
    records: &mut SessionRecords,
    kind: Kind,
    rest: &str,
    value: Option<&str>,
) -> Result<(), String> {
    match (kind, value) {
        (Kind::MarkLink, Some(v)) => {
            records
                .links
                .marks
                .insert(rest.to_string(), parse_value::<String>(v, "結びつけ")?);
        }
        (Kind::MarkLink, None) => {
            records.links.marks.remove(rest);
        }
        (Kind::RatingLink, Some(v)) => {
            records
                .links
                .ratings
                .insert(rest.to_string(), parse_value::<String>(v, "結びつけ")?);
        }
        (Kind::RatingLink, None) => {
            records.links.ratings.remove(rest);
        }
        (Kind::RatingsVersion, Some(v)) => {
            records.links.ratings_version = Some(parse_value::<u32>(v, "当てはめ方の版")?);
        }
        (Kind::RatingsVersion, None) => records.links.ratings_version = None,
        (Kind::SelfRating, Some(v)) => {
            records
                .self_ratings
                .kyokus
                .insert(rest.to_string(), parse_value::<SelfRating>(v, "自己評価")?);
        }
        (Kind::SelfRating, None) => {
            records.self_ratings.kyokus.remove(rest);
        }
        (Kind::MakaKyoku, Some(v)) => {
            records
                .maka
                .kyokus
                .insert(rest.to_string(), parse_value::<String>(v, "MAKA の評価")?);
        }
        (Kind::MakaKyoku, None) => {
            records.maka.kyokus.remove(rest);
        }
        (Kind::MakaHanchan, Some(v)) => {
            records.maka.hanchan = Some(parse_value::<String>(v, "MAKA の評価")?);
        }
        (Kind::MakaHanchan, None) => records.maka.hanchan = None,
        (Kind::MarkMemo, Some(v)) => {
            records
                .memos
                .marks
                .insert(rest.to_string(), parse_value::<MemoText>(v, "メモ")?);
        }
        (Kind::MarkMemo, None) => {
            records.memos.marks.remove(rest);
        }
        (Kind::ExtraMemo, Some(v)) => {
            let value = parse_value::<ExtraValue>(v, "メモ")?;
            match records
                .memos
                .extras
                .iter_mut()
                .find(|extra| extra.uid.as_deref() == Some(rest))
            {
                Some(found) => {
                    found.decision = value.decision;
                    found.position = value.position;
                    found.candidates = value.candidates;
                    found.reason = value.reason;
                }
                None => {
                    let label = next_extra_label(&records.memos.extras);
                    let extra = ExtraMemo {
                        id: label,
                        uid: Some(rest.to_string()),
                        decision: value.decision,
                        position: value.position,
                        candidates: value.candidates,
                        reason: value.reason,
                    };
                    // 並びは、uid の並び（作った順）にそろえる
                    let at = records
                        .memos
                        .extras
                        .iter()
                        .position(|other| other.uid.as_deref().is_some_and(|u| u > rest))
                        .unwrap_or(records.memos.extras.len());
                    records.memos.extras.insert(at, extra);
                }
            }
        }
        (Kind::ExtraMemo, None) => {
            records
                .memos
                .extras
                .retain(|extra| extra.uid.as_deref() != Some(rest));
        }
        _ => return Err("半荘ごとの記録ではありません".to_string()),
    }
    Ok(())
}

// ---- 設定 ⇄ 行 ----

fn setting_value(settings: &Settings, name: &str) -> Option<serde_json::Value> {
    let value = match name {
        "trigger" => serde_json::to_value(&settings.trigger),
        "orientation" => serde_json::to_value(settings.orientation),
        "sound" => serde_json::to_value(settings.sound),
        "capture_keywords" => serde_json::to_value(&settings.capture_keywords),
        "daily_count" => serde_json::to_value(settings.daily_count),
        "disagreement_percent" => serde_json::to_value(settings.disagreement_percent),
        "highlight_dora" => serde_json::to_value(settings.highlight_dora),
        "show_all_mismatches" => serde_json::to_value(settings.show_all_mismatches),
        "replay_keys" => serde_json::to_value(&settings.replay_keys),
        _ => return None,
    };
    value.ok()
}

fn set_setting(settings: &mut Settings, name: &str, text: &str) -> Result<(), String> {
    let bad = |e: serde_json::Error| format!("設定 {name} の値を読めません: {e}");
    match name {
        "trigger" => settings.trigger = serde_json::from_str(text).map_err(bad)?,
        "orientation" => settings.orientation = serde_json::from_str(text).map_err(bad)?,
        "sound" => settings.sound = serde_json::from_str(text).map_err(bad)?,
        "capture_keywords" => {
            settings.capture_keywords = serde_json::from_str(text).map_err(bad)?
        }
        "daily_count" => settings.daily_count = serde_json::from_str(text).map_err(bad)?,
        "disagreement_percent" => {
            settings.disagreement_percent = serde_json::from_str(text).map_err(bad)?
        }
        "highlight_dora" => settings.highlight_dora = serde_json::from_str(text).map_err(bad)?,
        "show_all_mismatches" => {
            settings.show_all_mismatches = serde_json::from_str(text).map_err(bad)?
        }
        "replay_keys" => settings.replay_keys = serde_json::from_str(text).map_err(bad)?,
        _ => return Err(format!("知らない設定です: {name}")),
    }
    Ok(())
}

// ---- 結果のファイル ----

/// 結果のファイルの行の値と目印。大きさと更新時刻が前回と同じなら、中身を読まずに、前回の指紋を使う。
fn report_item(
    path: &Path,
    key: &str,
    known_fingerprints: &BTreeMap<String, String>,
) -> Result<Option<(LocalItem, String)>, String> {
    let meta = match fs::metadata(path) {
        Ok(meta) if meta.is_file() => meta,
        Ok(_) => return Ok(None),
        Err(e) if e.kind() == io::ErrorKind::NotFound => return Ok(None),
        Err(e) => return Err(format!("{}: {e}", file_label(path))),
    };
    let size = meta.len();
    let modified = mtime_ms(path).unwrap_or(0);
    let prefix = format!("{size}:{modified}:");
    let sha = match known_fingerprints.get(key) {
        Some(known) if known.starts_with(&prefix) => known[prefix.len()..].to_string(),
        _ => {
            let bytes = fs::read(path).map_err(|e| format!("{}: {e}", file_label(path)))?;
            sha256_hex(&bytes)
        }
    };
    let meta_value = ReportMeta {
        bytes: size,
        sha256: sha,
    };
    let fingerprint = format!("{prefix}{}", meta_value.sha256);
    Ok(Some((
        LocalItem {
            value: canon(&meta_value),
            hint_ms: Some(modified),
            is_default: false,
        },
        fingerprint,
    )))
}

impl<P: Ports> LocalAccess for FsLocal<P> {
    fn prepare(&mut self, legacy: bool) -> Result<(), String> {
        let root = self.ports.data_dir();
        let sessions = list_session_dirs(&root, GAMES_DIR);
        let mut failure: Option<String> = None;
        self.ports.with_records_lock(&mut || {
            for session in &sessions {
                let path = root.join(GAMES_DIR).join(session).join(MEMOS_FILE);
                let mut memos = match read_strict::<Memos>(&path) {
                    Ok(Some(memos)) => memos,
                    Ok(None) => continue,
                    Err(_) => continue,
                };
                if memos.extras.iter().all(|extra| extra.uid.is_some()) {
                    continue;
                }
                for (index, extra) in memos.extras.iter_mut().enumerate() {
                    if extra.uid.is_none() {
                        extra.uid = Some(if legacy {
                            legacy_extra_uid(session, &extra.id, index)
                        } else {
                            new_uid()
                        });
                    }
                }
                // 同じ uid が 2 つにならないように（内容から決めた id が重なる、まず無いとき）
                let mut seen = BTreeSet::new();
                for extra in memos.extras.iter_mut() {
                    if let Some(uid) = &extra.uid {
                        if !seen.insert(uid.clone()) {
                            extra.uid = Some(new_uid());
                            if let Some(fresh) = &extra.uid {
                                seen.insert(fresh.clone());
                            }
                        }
                    }
                }
                let text = match serde_json::to_string_pretty(&memos) {
                    Ok(text) => text,
                    Err(e) => {
                        failure.get_or_insert(e.to_string());
                        continue;
                    }
                };
                if let Err(e) = write_atomic(&path, text.as_bytes()) {
                    failure.get_or_insert(format!("{session}/{MEMOS_FILE}: {e}"));
                }
            }
        });
        match failure {
            Some(reason) => Err(reason),
            None => Ok(()),
        }
    }

    fn snapshot(
        &mut self,
        known_fingerprints: &BTreeMap<String, String>,
    ) -> Result<LocalSnapshot, String> {
        let root = self.ports.data_dir();
        let mut snapshot = LocalSnapshot::default();

        // 答え・今日の出題・週の成績
        let mut answers: Vec<AnswerRow> = Vec::new();
        let mut daily: Vec<DailySetRecord> = Vec::new();
        let mut weeks: Vec<WeekRecord> = Vec::new();
        self.ports.with_study(&mut |db| {
            answers = db.list_answers().map_err(|e| e.to_string())?;
            daily = db.list_daily_sets().map_err(|e| e.to_string())?;
            weeks = db.list_weeks().map_err(|e| e.to_string())?;
            Ok(())
        })?;
        let study_hint = mtime_ms(&root.join(STUDY_FILE));
        for row in &answers {
            let Some(uid) = &row.uid else {
                snapshot
                    .warnings
                    .push("同期の id の無い答えがあります".to_string());
                continue;
            };
            snapshot.items.insert(
                make_key(Kind::Answer, &[uid]),
                LocalItem {
                    value: canon(&row.answer),
                    hint_ms: Some(row.answer.answered_at),
                    is_default: false,
                },
            );
        }
        for set in &daily {
            snapshot.items.insert(
                make_key(Kind::Daily, &[&set.date]),
                LocalItem {
                    value: canon(&set.items),
                    hint_ms: study_hint,
                    is_default: false,
                },
            );
        }
        for week in &weeks {
            snapshot.items.insert(
                make_key(Kind::Week, &[&week.week]),
                LocalItem {
                    value: canon(week),
                    hint_ms: study_hint,
                    is_default: false,
                },
            );
        }

        // 設定
        let settings = self.ports.settings();
        let defaults = Settings::default().normalized();
        let settings_hint = self.ports.settings_hint_ms();
        for name in SETTING_NAMES {
            let (Some(now), Some(default)) = (
                setting_value(&settings, name),
                setting_value(&defaults, name),
            ) else {
                continue;
            };
            snapshot.items.insert(
                make_key(Kind::Setting, &[name]),
                LocalItem {
                    value: now.to_string(),
                    hint_ms: settings_hint,
                    is_default: now == default,
                },
            );
        }

        // 半荘ごとの記録・結果のファイル
        let games = list_session_dirs(&root, GAMES_DIR);
        let trash = list_session_dirs(&root, TRASH_DIR);
        for session in &games {
            snapshot
                .sessions
                .insert(session.clone(), SessionState::Present);
        }
        for session in &trash {
            snapshot
                .sessions
                .entry(session.clone())
                .or_insert(SessionState::Trashed);
        }
        for session in &games {
            let dir = root.join(GAMES_DIR).join(session);
            match read_session_records(&dir) {
                Ok(records) => match session_rows(session, &records) {
                    Some(rows) => {
                        for (key, value, file) in rows {
                            snapshot.items.insert(
                                key,
                                LocalItem {
                                    value,
                                    hint_ms: mtime_ms(&dir.join(file)),
                                    is_default: false,
                                },
                            );
                        }
                    }
                    None => {
                        snapshot.unreadable.insert(session.clone());
                    }
                },
                Err(reason) => {
                    snapshot.unreadable.insert(session.clone());
                    snapshot.warnings.push(format!(
                        "読めない記録があるので、同期を見送りました: {reason}"
                    ));
                }
            }
            let key = make_key(Kind::Report, &[session]);
            match report_item(&dir.join(REPORT_FILE), &key, known_fingerprints) {
                Ok(Some((item, fingerprint))) => {
                    snapshot.fingerprints.insert(key.clone(), fingerprint);
                    snapshot.items.insert(key, item);
                }
                Ok(None) => {}
                Err(reason) => {
                    snapshot.unreadable.insert(session.clone());
                    snapshot
                        .warnings
                        .push(format!("結果のファイルを読めません: {reason}"));
                }
            }
        }
        Ok(snapshot)
    }

    fn apply(&mut self, ops: &[LocalOp], blobs: &BTreeMap<String, Vec<u8>>) -> Vec<ApplyResult> {
        let root = self.ports.data_dir();
        let mut results: Vec<Option<ApplyResult>> = vec![None; ops.len()];

        // 種類ごとにまとめる（半荘ごと・答えの接続・設定・半荘の削除）
        let mut by_session: BTreeMap<String, Vec<usize>> = BTreeMap::new();
        let mut study_ops: Vec<usize> = Vec::new();
        let mut setting_ops: Vec<usize> = Vec::new();
        let mut report_puts: Vec<usize> = Vec::new();
        let mut session_deletes: Vec<usize> = Vec::new();
        for (index, op) in ops.iter().enumerate() {
            let Some(parsed) = parse_key(op.key()) else {
                results[index] = Some(ApplyResult::Failed("知らない鍵です".to_string()));
                continue;
            };
            match (parsed.kind, parsed.session) {
                (Kind::Answer | Kind::Daily | Kind::Week, _) => study_ops.push(index),
                (Kind::Setting, _) => setting_ops.push(index),
                (Kind::Report, Some(_)) => match op {
                    LocalOp::Put { .. } => report_puts.push(index),
                    LocalOp::Delete { .. } => session_deletes.push(index),
                },
                (_, Some(session)) => by_session
                    .entry(session.to_string())
                    .or_default()
                    .push(index),
                (_, None) => {
                    results[index] = Some(ApplyResult::Failed("知らない鍵です".to_string()))
                }
            }
        }

        // 1. 結果のファイル（まだ無い半荘のフォルダは、ここで作る）
        for index in report_puts {
            let LocalOp::Put {
                key, value, expect, ..
            } = &ops[index]
            else {
                continue;
            };
            let session = parse_key(key)
                .and_then(|p| p.session.map(str::to_string))
                .unwrap_or_default();
            results[index] = Some(self.put_report(&root, &session, key, value, expect, blobs));
        }

        // 2. 半荘ごとの記録
        for (session, indexes) in by_session {
            let outcome = self.apply_session_records(&root, &session, ops, &indexes);
            for (index, result) in indexes.into_iter().zip(outcome) {
                results[index] = Some(result);
            }
        }

        // 3. 答え・今日の出題・週の成績
        if !study_ops.is_empty() {
            let mut outcome: Vec<ApplyResult> = Vec::new();
            let run = self.ports.with_study(&mut |db| {
                outcome = study_ops
                    .iter()
                    .map(|index| apply_study_op(db, &ops[*index]))
                    .collect();
                Ok(())
            });
            match run {
                Ok(()) => {
                    for (index, result) in study_ops.iter().zip(outcome) {
                        results[*index] = Some(result);
                    }
                }
                Err(reason) => {
                    for index in &study_ops {
                        results[*index] = Some(ApplyResult::Failed(reason.clone()));
                    }
                }
            }
        }

        // 4. 設定
        if !setting_ops.is_empty() {
            let outcome = self.apply_settings(ops, &setting_ops);
            for (index, result) in setting_ops.iter().zip(outcome) {
                results[*index] = Some(result);
            }
        }

        // 5. 半荘の削除（ほかの端末が、その半荘を消した）
        for index in session_deletes {
            let LocalOp::Delete { key, expect } = &ops[index] else {
                continue;
            };
            let session = parse_key(key)
                .and_then(|p| p.session.map(str::to_string))
                .unwrap_or_default();
            results[index] = Some(self.delete_session(&root, &session, expect));
        }

        results
            .into_iter()
            .map(|r| r.unwrap_or(ApplyResult::Skipped("操作が決まりませんでした".to_string())))
            .collect()
    }

    fn read_report(&mut self, session: &str) -> Result<Vec<u8>, String> {
        if !valid_session_id(session) {
            return Err("半荘の名前の形が違います".to_string());
        }
        let path = self
            .ports
            .data_dir()
            .join(GAMES_DIR)
            .join(session)
            .join(REPORT_FILE);
        fs::read(&path).map_err(|e| format!("{}: {e}", file_label(&path)))
    }
}

impl<P: Ports> FsLocal<P> {
    fn put_report(
        &self,
        root: &Path,
        session: &str,
        key: &str,
        value: &str,
        expect: &Option<String>,
        blobs: &BTreeMap<String, Vec<u8>>,
    ) -> ApplyResult {
        if !valid_session_id(session) {
            return ApplyResult::Failed("半荘の名前の形が違います".to_string());
        }
        let Some(bytes) = blobs.get(key) else {
            return ApplyResult::Failed("結果のファイルの中身が届いていません".to_string());
        };
        let Ok(meta) = serde_json::from_str::<ReportMeta>(value) else {
            return ApplyResult::Failed("結果のファイルの行を読めません".to_string());
        };
        if sha256_hex(bytes) != meta.sha256 {
            return ApplyResult::Failed(
                "結果のファイルの中身が、記録の指紋と合いません".to_string(),
            );
        }
        if serde_json::from_slice::<serde::de::IgnoredAny>(bytes).is_err() {
            return ApplyResult::Failed("結果のファイルが JSON として読めません".to_string());
        }
        let dir = root.join(GAMES_DIR).join(session);
        let path = dir.join(REPORT_FILE);
        let mut result = ApplyResult::Applied;
        self.ports.with_records_lock(&mut || {
            if root.join(TRASH_DIR).join(session).is_dir() && !dir.is_dir() {
                result = ApplyResult::Skipped("消した半荘の置き場にあります".to_string());
                return;
            }
            // 突き合わせたときのままか
            let current = match report_item(&path, key, &BTreeMap::new()) {
                Ok(current) => current.map(|(item, _)| item.value),
                Err(reason) => {
                    result = ApplyResult::Failed(reason);
                    return;
                }
            };
            if &current != expect {
                result = ApplyResult::Skipped("手元の結果のファイルが変わっていました".to_string());
                return;
            }
            if let Err(e) = fs::create_dir_all(&dir) {
                result = ApplyResult::Failed(format!("{session}: {e}"));
                return;
            }
            if let Err(e) = write_atomic(&path, bytes) {
                result = ApplyResult::Failed(format!("{session}/{REPORT_FILE}: {e}"));
            }
        });
        result
    }

    fn apply_session_records(
        &self,
        root: &Path,
        session: &str,
        ops: &[LocalOp],
        indexes: &[usize],
    ) -> Vec<ApplyResult> {
        let all = |result: ApplyResult| vec![result; indexes.len()];
        if !valid_session_id(session) {
            return all(ApplyResult::Failed("半荘の名前の形が違います".to_string()));
        }
        let dir = root.join(GAMES_DIR).join(session);
        let mut outcome: Vec<ApplyResult> = all(ApplyResult::Applied);
        self.ports.with_records_lock(&mut || {
            if !dir.is_dir() {
                outcome = all(ApplyResult::Skipped(
                    "半荘のフォルダがまだありません".to_string(),
                ));
                return;
            }
            let mut records = match read_session_records(&dir) {
                Ok(records) => records,
                Err(reason) => {
                    outcome = all(ApplyResult::Failed(reason));
                    return;
                }
            };
            let mut changed = false;
            for (slot, index) in indexes.iter().enumerate() {
                let (key, new_value, expect) = match &ops[*index] {
                    LocalOp::Put { key, value, expect } => (key, Some(value.as_str()), expect),
                    LocalOp::Delete { key, expect } => (key, None, expect),
                };
                let Some(parsed) = parse_key(key) else {
                    outcome[slot] = ApplyResult::Failed("知らない鍵です".to_string());
                    continue;
                };
                let current = session_value(&records, parsed.kind, parsed.rest);
                if &current != expect {
                    outcome[slot] =
                        ApplyResult::Skipped("手元の記録が変わっていました".to_string());
                    continue;
                }
                if let Err(reason) =
                    set_session_row(&mut records, parsed.kind, parsed.rest, new_value)
                {
                    outcome[slot] = ApplyResult::Failed(reason);
                    continue;
                }
                changed = true;
            }
            if !changed {
                return;
            }
            let checked = match records.checked() {
                Ok(checked) => checked,
                Err(e) => {
                    outcome = indexes
                        .iter()
                        .zip(outcome.iter())
                        .map(|(_, r)| match r {
                            ApplyResult::Applied => ApplyResult::Failed(e.to_string()),
                            other => other.clone(),
                        })
                        .collect();
                    return;
                }
            };
            if let Err(reason) = write_changed_records(&dir, &checked) {
                outcome = indexes
                    .iter()
                    .zip(outcome.iter())
                    .map(|(_, r)| match r {
                        ApplyResult::Applied => ApplyResult::Failed(reason.clone()),
                        other => other.clone(),
                    })
                    .collect();
            }
        });
        outcome
    }

    fn apply_settings(&self, ops: &[LocalOp], indexes: &[usize]) -> Vec<ApplyResult> {
        let current = self.ports.settings();
        let mut merged = current.clone();
        let mut results: Vec<ApplyResult> = Vec::with_capacity(indexes.len());
        let mut any = false;
        for index in indexes {
            let (key, value, expect) = match &ops[*index] {
                LocalOp::Put { key, value, expect } => (key, Some(value.as_str()), expect),
                LocalOp::Delete { key, expect } => (key, None, expect),
            };
            let Some(parsed) = parse_key(key) else {
                results.push(ApplyResult::Failed("知らない鍵です".to_string()));
                continue;
            };
            let name = parsed.rest;
            let now = setting_value(&current, name).map(|v| v.to_string());
            if &now != expect {
                results.push(ApplyResult::Skipped("設定が変わっていました".to_string()));
                continue;
            }
            let Some(value) = value else {
                // 設定の行は、消さない（消した印が届いても、手元の設定は、そのまま）
                results.push(ApplyResult::Applied);
                continue;
            };
            match set_setting(&mut merged, name, value) {
                Ok(()) => {
                    any = true;
                    results.push(ApplyResult::Applied);
                }
                Err(reason) => results.push(ApplyResult::Failed(reason)),
            }
        }
        if any {
            let merged = merged.normalized();
            let outcome = merged
                .validate()
                .map_err(|e| e.to_string())
                .and_then(|()| self.ports.apply_settings(merged));
            if let Err(reason) = outcome {
                for result in results.iter_mut() {
                    if *result == ApplyResult::Applied {
                        *result = ApplyResult::Failed(reason.clone());
                    }
                }
            }
        }
        results
    }

    fn delete_session(&self, root: &Path, session: &str, expect: &Option<String>) -> ApplyResult {
        if !valid_session_id(session) {
            return ApplyResult::Failed("半荘の名前の形が違います".to_string());
        }
        let dir = root.join(GAMES_DIR).join(session);
        if !dir.is_dir() {
            // すでに無い（置き場にあっても、消すことは変わらない）
            return ApplyResult::Applied;
        }
        let _ = expect;
        match self.ports.delete_session(session) {
            Ok(()) => ApplyResult::Applied,
            Err(reason) => ApplyResult::Failed(reason),
        }
    }
}

/// 答え・今日の出題・週の成績の操作 1 つを、答えの接続に入れる。
fn apply_study_op(db: &mut StudyDb, op: &LocalOp) -> ApplyResult {
    let (key, value, expect) = match op {
        LocalOp::Put { key, value, expect } => (key, Some(value.as_str()), expect),
        LocalOp::Delete { key, expect } => (key, None, expect),
    };
    let Some(parsed) = parse_key(key) else {
        return ApplyResult::Failed("知らない鍵です".to_string());
    };
    let result: Result<ApplyResult, String> = (|| match parsed.kind {
        Kind::Answer => {
            let uid = parsed.rest;
            let current = db
                .answer_by_uid(uid)
                .map_err(|e| e.to_string())?
                .map(|row| canon(&row.answer));
            if &current != expect {
                return Ok(ApplyResult::Skipped(
                    "手元の答えが変わっていました".to_string(),
                ));
            }
            match value {
                Some(text) => {
                    let answer: NewAnswer = parse_value(text, "答え")?;
                    db.put_answer_by_uid(uid, &answer)
                        .map_err(|e| e.to_string())?;
                }
                None => {
                    db.delete_answer_by_uid(uid).map_err(|e| e.to_string())?;
                }
            }
            Ok(ApplyResult::Applied)
        }
        Kind::Daily => {
            let date = parsed.rest;
            let current = db
                .daily_set(date)
                .map_err(|e| e.to_string())?
                .map(|items| canon(&items));
            if &current != expect {
                return Ok(ApplyResult::Skipped(
                    "手元の今日の出題が変わっていました".to_string(),
                ));
            }
            match value {
                Some(text) => {
                    let items: Vec<ProblemRef> = parse_value(text, "今日の出題")?;
                    db.put_daily_set(date, &items).map_err(|e| e.to_string())?;
                }
                None => db.delete_daily_set(date).map_err(|e| e.to_string())?,
            }
            Ok(ApplyResult::Applied)
        }
        Kind::Week => {
            let week = parsed.rest;
            let current = db
                .list_weeks()
                .map_err(|e| e.to_string())?
                .into_iter()
                .find(|record| record.week == week)
                .map(|record| canon(&record));
            if &current != expect {
                return Ok(ApplyResult::Skipped(
                    "手元の週の成績が変わっていました".to_string(),
                ));
            }
            match value {
                Some(text) => {
                    let record: WeekRecord = parse_value(text, "週の成績")?;
                    if record.week != week {
                        return Err("週の行の鍵と中身が合いません".to_string());
                    }
                    db.set_week(record).map_err(|e| e.to_string())?;
                }
                None => {
                    db.set_week(WeekRecord {
                        week: week.to_string(),
                        stats: Default::default(),
                        focus: String::new(),
                    })
                    .map_err(|e| e.to_string())?;
                }
            }
            Ok(ApplyResult::Applied)
        }
        _ => Err("答えの接続の記録ではありません".to_string()),
    })();
    match result {
        Ok(result) => result,
        Err(reason) => ApplyResult::Failed(reason),
    }
}

/// 手元の記録が変わったかを、安く調べるための目印（同期の見張りが、数秒ごとに呼ぶ）。
/// 答えのファイル・設定のファイル・半荘ごとの記録と結果のファイルの、大きさと更新時刻と、半荘のフォルダの並びを、1 つの文字にする。
/// 内容は読まない。目印が前回と同じなら、手元は変わっていない。
pub fn change_marker(data_dir: &Path, settings_file: &Path) -> String {
    let mut parts = String::new();
    let stat = |path: &Path, out: &mut String| {
        match fs::metadata(path) {
            Ok(meta) => {
                let modified = mtime_ms(path).unwrap_or(0);
                out.push_str(&format!("{}:{modified};", meta.len()));
            }
            Err(_) => out.push_str("-;"),
        };
    };
    for suffix in ["", "-wal", "-journal"] {
        let name = format!("{STUDY_FILE}{suffix}");
        stat(&data_dir.join(name), &mut parts);
    }
    stat(settings_file, &mut parts);
    for sub in [GAMES_DIR, TRASH_DIR] {
        let ids = list_session_dirs(data_dir, sub);
        parts.push_str(&format!("{sub}={};", ids.len()));
        for id in ids {
            parts.push_str(&id);
            parts.push('=');
            if sub == GAMES_DIR {
                let dir = data_dir.join(GAMES_DIR).join(&id);
                for file in [
                    LINKS_FILE,
                    SELF_RATINGS_FILE,
                    MAKA_FILE,
                    MEMOS_FILE,
                    REPORT_FILE,
                ] {
                    stat(&dir.join(file), &mut parts);
                }
            }
            parts.push('|');
        }
    }
    sha256_hex(parts.as_bytes())
}
