//! 半荘の記録の保存と、記録から導く現在の状態。
//!
//! 半荘ごとに `games/<開始時刻 YYYYMMDD-HHMMSS（ローカル時刻）>/` のフォルダを作り、
//! その中の `events.jsonl` に 1 行 1 件で追記する（書き換えない）。
//! 迷いマークのスクリーンショットは `marks/<時刻>.png`、評価（〇△✕）のスクリーンショットは `ratings/<時刻>.png`（W-13）。
//!
//! 半荘のフォルダは、その半荘の最初の記録（迷いマークか評価）が作る。「新しい半荘」は今の半荘を閉じるだけで、
//! 何も記録しなければ空のフォルダは残らない。最後の記録から 30 分あいたら、次の記録は新しい半荘に入る（W-14）。
//!
//! 取り消しも「取り消した記録を指す記録」を追記するだけで、行は消さない（W-3）。
//! 現在の状態（迷いマークの数・評価の並び・次の局番号）は、記録を頭から読み直す `reduce` で導く。
//!
//! 保存先は Git のリポジトリの外に限る（D-1）。

use std::collections::BTreeMap;
use std::ffi::OsString;
use std::fmt;
use std::fs::{self, OpenOptions};
use std::io::{self, Write};
use std::path::{Path, PathBuf};

use chrono::{DateTime, Local, NaiveDateTime, TimeZone};
use serde::de::IgnoredAny;
use serde::{Deserialize, Serialize};

use crate::capture::{CaptureError, CaptureTarget, Screenshot};

/// 半荘のフォルダを入れるフォルダ名。
pub const GAMES_DIR: &str = "games";
/// 消した半荘のフォルダを、アプリを閉じるまで置いておくフォルダ名（保存先の直下。`trash.rs`）。
pub const TRASH_DIR: &str = "trash";
/// 迷いマークの画像を入れるフォルダ名（半荘のフォルダの中）。
pub const MARKS_DIR: &str = "marks";
/// 評価の画像を入れるフォルダ名（半荘のフォルダの中。W-13）。
pub const RATINGS_DIR: &str = "ratings";
/// 記録のファイル名（半荘のフォルダの中）。
pub const EVENTS_FILE: &str = "events.jsonl";
/// 最後の記録からこの時間（ミリ秒）より長くあいたら、次の記録は新しい半荘に入る（W-14）。30 分。
pub const SESSION_GAP_MS: i64 = 30 * 60 * 1000;
/// 取り込んだ mjai の結果（生の JSON）のファイル名（半荘のフォルダの中。F1）。
pub const REPORT_FILE: &str = "report.json";
/// 画像の文字認識の結果の写しのファイル名（半荘のフォルダの中。取り込みのときだけ作る。F11）。
pub const OCR_FILE: &str = "ocr.json";
/// 迷いマーク・評価の結びつけ（ユーザーが選んだもの）のファイル名（半荘のフォルダの中。F9）。
pub const LINKS_FILE: &str = "links.json";
/// 迷いマークの結びつけの値のうち、「局面を手で選ぶ」という印。
pub const LINK_MANUAL: &str = "manual";
/// 結びつけの値（局面の鍵・局の鍵）の長さの上限（バイト）。
const MAX_LINK_VALUE_LEN: usize = 64;

/// 局の評価。〇 = good、△ = fair、✕ = bad。
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum Rating {
    Good,
    Fair,
    Bad,
}

/// 記録の 1 件。`id` は半荘の中での通し番号（半荘の開始が 0）。`t_ms` は UNIX エポックからのミリ秒。
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct Event {
    pub id: u64,
    pub t_ms: i64,
    #[serde(flatten)]
    pub kind: EventKind,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(tag = "type", rename_all = "snake_case")]
pub enum EventKind {
    /// 半荘の開始。
    SessionStart,
    /// 迷いマーク。スクリーンショットは半荘のフォルダからの相対パス。
    /// 撮れなかったときは `screenshot` が無く、理由が `capture_error` に入る（マーク自体は残す）。
    Mark {
        #[serde(default, skip_serializing_if = "Option::is_none")]
        screenshot: Option<String>,
        #[serde(default, skip_serializing_if = "Option::is_none")]
        capture: Option<CaptureTarget>,
        #[serde(default, skip_serializing_if = "Option::is_none")]
        capture_error: Option<String>,
    },
    /// 局の評価。スクリーンショット（W-13）は迷いマークと同じ扱いで、半荘のフォルダからの相対パス。
    /// 撮れなかったときは `screenshot` が無く、理由が `capture_error` に入る（評価自体は残す）。
    /// 昔の記録（画像の項目が無い）もそのまま読める。
    Rating {
        rating: Rating,
        #[serde(default, skip_serializing_if = "Option::is_none")]
        screenshot: Option<String>,
        #[serde(default, skip_serializing_if = "Option::is_none")]
        capture: Option<CaptureTarget>,
        #[serde(default, skip_serializing_if = "Option::is_none")]
        capture_error: Option<String>,
    },
    /// 取り消し。`target` は取り消した記録の `id`。
    Undo { target: u64 },
    /// 半荘を閉じた（「新しい半荘」）。アプリを起動し直しても、閉じた半荘には続けて記録しない（W-14）。
    SessionClose,
}

/// 取り消されていない迷いマーク。
#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
pub struct MarkEntry {
    pub id: u64,
    pub t_ms: i64,
    pub screenshot: Option<String>,
    pub capture: Option<CaptureTarget>,
    pub capture_error: Option<String>,
}

/// 取り消されていない評価。`hand` は何局目の評価か（1 から）。
#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
pub struct RatingEntry {
    pub id: u64,
    pub t_ms: i64,
    pub rating: Rating,
    pub hand: usize,
    pub screenshot: Option<String>,
    pub capture: Option<CaptureTarget>,
    pub capture_error: Option<String>,
}

/// 記録から導いた、半荘の現在の様子。
#[derive(Debug, Clone, Default, PartialEq, Eq)]
pub struct SessionView {
    pub started_ms: Option<i64>,
    pub marks: Vec<MarkEntry>,
    pub ratings: Vec<RatingEntry>,
}

impl SessionView {
    pub fn mark_count(&self) -> usize {
        self.marks.len()
    }

    /// 次の評価が何局目に入るか（W-8）。取り消されていない評価の数 + 1。
    pub fn next_hand(&self) -> usize {
        self.ratings.len() + 1
    }

    /// 取り消せる最新の記録（取り消されていない迷いマークか評価のうち、最後のもの）。
    pub fn last_active_id(&self) -> Option<u64> {
        let last_mark = self.marks.last().map(|m| m.id);
        let last_rating = self.ratings.last().map(|r| r.id);
        last_mark.max(last_rating)
    }

    pub fn can_undo(&self) -> bool {
        self.last_active_id().is_some()
    }
}

/// 記録を頭から読み直して、現在の様子を導く。
/// 取り消しは、指している記録（まだ取り消されていない迷いマークか評価）を外す。
/// 存在しない記録や、すでに取り消された記録を指す取り消しは無視する。
pub fn reduce(events: &[Event]) -> SessionView {
    struct Active {
        id: u64,
        t_ms: i64,
        kind: ActiveKind,
        cancelled: bool,
    }
    enum ActiveKind {
        Mark {
            screenshot: Option<String>,
            capture: Option<CaptureTarget>,
            capture_error: Option<String>,
        },
        Rating {
            rating: Rating,
            screenshot: Option<String>,
            capture: Option<CaptureTarget>,
            capture_error: Option<String>,
        },
    }

    let mut started_ms = None;
    let mut records: Vec<Active> = Vec::new();
    for event in events {
        match &event.kind {
            EventKind::SessionStart => {
                started_ms.get_or_insert(event.t_ms);
            }
            EventKind::Mark {
                screenshot,
                capture,
                capture_error,
            } => records.push(Active {
                id: event.id,
                t_ms: event.t_ms,
                kind: ActiveKind::Mark {
                    screenshot: screenshot.clone(),
                    capture: *capture,
                    capture_error: capture_error.clone(),
                },
                cancelled: false,
            }),
            EventKind::Rating {
                rating,
                screenshot,
                capture,
                capture_error,
            } => records.push(Active {
                id: event.id,
                t_ms: event.t_ms,
                kind: ActiveKind::Rating {
                    rating: *rating,
                    screenshot: screenshot.clone(),
                    capture: *capture,
                    capture_error: capture_error.clone(),
                },
                cancelled: false,
            }),
            EventKind::Undo { target } => {
                if let Some(record) = records.iter_mut().find(|r| r.id == *target && !r.cancelled) {
                    record.cancelled = true;
                }
            }
            EventKind::SessionClose => {}
        }
    }

    let mut view = SessionView {
        started_ms,
        ..SessionView::default()
    };
    for record in records.into_iter().filter(|r| !r.cancelled) {
        match record.kind {
            ActiveKind::Mark {
                screenshot,
                capture,
                capture_error,
            } => view.marks.push(MarkEntry {
                id: record.id,
                t_ms: record.t_ms,
                screenshot,
                capture,
                capture_error,
            }),
            ActiveKind::Rating {
                rating,
                screenshot,
                capture,
                capture_error,
            } => {
                let hand = view.ratings.len() + 1;
                view.ratings.push(RatingEntry {
                    id: record.id,
                    t_ms: record.t_ms,
                    rating,
                    hand,
                    screenshot,
                    capture,
                    capture_error,
                });
            }
        }
    }
    view
}

/// 迷いマーク 1 件と、画像の絶対パス（画面で表示するため）。
#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
pub struct MarkRecord {
    #[serde(flatten)]
    pub entry: MarkEntry,
    pub screenshot_path: Option<String>,
}

/// 評価 1 件と、画像の絶対パス（画面で表示するため。W-13）。
#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
pub struct RatingRecord {
    #[serde(flatten)]
    pub entry: RatingEntry,
    pub screenshot_path: Option<String>,
}

/// 画像 1 枚の文字認識の結果（行ごとの文字）。読めなかったときは、理由が `error` に入る。
#[derive(Debug, Clone, PartialEq, Eq, Default, Serialize, Deserialize)]
pub struct OcrEntry {
    pub lines: Vec<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub error: Option<String>,
}

/// 半荘の画像の文字認識の結果の写し（`ocr.json`）。画像の、半荘のフォルダからの相対パスごとに持つ。
/// 読み取りは取り込みのときだけ行い、結果をここに残して、同じ画像を読み直さない（S-3）。
#[derive(Debug, Clone, PartialEq, Eq, Default, Serialize, Deserialize)]
pub struct OcrCache {
    /// 画像の切り出しと拡大の決まりの名前（文字認識の側の `GEOMETRY_ID`）。決まりが変わったら、読み直す。
    /// この写しを作るのは取り込みのときだけ。ここ（保存）は、名前を文字として持つだけ。
    pub geometry: String,
    pub entries: BTreeMap<String, OcrEntry>,
}

/// 迷いマーク・評価の結びつけ（`links.json`）。値は、画面（エンジン）が決める鍵を、そのまま持つ。
/// - `marks`: 迷いマークの id → 結びつけた判断の鍵、または `"manual"`（局面を手で選ぶ）
/// - `ratings`: 評価の id → 結びつけた局の鍵（空の文字列は「どの局にも結びつけない」）
///
/// 無い項目は「まだ決めていない」。JSON の鍵は文字列なので、id は 10 進の文字列で持つ。
#[derive(Debug, Clone, PartialEq, Eq, Default, Serialize, Deserialize)]
pub struct Links {
    #[serde(default)]
    pub marks: BTreeMap<String, String>,
    #[serde(default)]
    pub ratings: BTreeMap<String, String>,
}

/// 半荘 1 つ分の一覧用の情報。記録（迷いマークか評価）も結果も無い半荘は、一覧に入れない（W-14）。
/// 結果だけの半荘（記録の無いまま取り込んだもの）は入れる。
#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
pub struct SessionRecord {
    pub id: String,
    pub started_ms: i64,
    pub mark_count: usize,
    pub rating_count: usize,
    pub marks: Vec<MarkRecord>,
    pub ratings: Vec<RatingRecord>,
    pub events: Vec<Event>,
    /// 取り込んだ結果（`report.json`）の絶対パス。まだ取り込んでいなければ `None`。
    pub report_path: Option<String>,
    /// 画像の文字認識の結果の写し。まだ読んでいない（または読めない）ときは `None`。
    pub ocr: Option<OcrCache>,
    /// 迷いマーク・評価の結びつけ。
    pub links: Links,
}

#[derive(Debug)]
pub enum StoreError {
    /// 保存先が Git のリポジトリの中（D-1）。
    InsideGitRepo {
        path: PathBuf,
        repo: PathBuf,
    },
    /// 取り消せる記録が無い。
    NothingToUndo,
    /// 半荘の名前が正しくない・その半荘のフォルダが無い。
    UnknownSession(String),
    /// その半荘には、すでに結果が入っている。
    ReportExists(String),
    /// 結果が JSON ではない。
    InvalidReport(String),
    /// 結びつける迷いマーク・評価が、その半荘に無い（取り消された、など）。
    UnknownRecord {
        kind: &'static str,
        id: String,
    },
    /// 結びつけの値が正しくない。
    InvalidLink(String),
    /// 消した半荘の置き場に、同じ名前の半荘が残っている（消せない。置き場は、アプリを開き直すと片づく）。
    TrashOccupied(String),
    /// 消した半荘の中に、その名前が無い（戻せない）。
    NotInTrash(String),
    /// 戻す場所に、同じ名前の半荘がすでにある（戻せない）。
    RestoreBlocked(String),
    /// 半荘のフォルダを移せなかった（開いているファイルがあるなど）。
    Move {
        id: String,
        reason: String,
    },
    Io(io::Error),
    Encode(serde_json::Error),
}

impl fmt::Display for StoreError {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        match self {
            StoreError::InsideGitRepo { path, repo } => write!(
                f,
                "保存先がリポジトリの中です: {}（{} の下）。リポジトリの外のフォルダを指定してください。",
                path.display(),
                repo.display()
            ),
            StoreError::NothingToUndo => f.write_str("取り消せる記録がありません。"),
            StoreError::UnknownSession(id) => write!(f, "半荘が見つかりません: {id}"),
            StoreError::ReportExists(id) => {
                write!(f, "この半荘には、すでに結果が取り込まれています: {id}")
            }
            StoreError::InvalidReport(reason) => {
                write!(f, "結果が JSON として読めませんでした: {reason}")
            }
            StoreError::UnknownRecord { kind, id } => {
                write!(f, "結びつける{kind}がこの半荘にありません（番号 {id}）。")
            }
            StoreError::InvalidLink(reason) => write!(f, "結びつけの値が正しくありません: {reason}"),
            StoreError::TrashOccupied(id) => write!(
                f,
                "消した半荘の置き場に、同じ名前の半荘が残っているため、消せません: {id}。アプリを開き直すと片づきます。"
            ),
            StoreError::NotInTrash(id) => {
                write!(f, "消した半荘の中に見つからないため、戻せません: {id}")
            }
            StoreError::RestoreBlocked(id) => {
                write!(f, "元の場所に同じ名前の半荘があるため、戻せません: {id}")
            }
            StoreError::Move { id, reason } => write!(
                f,
                "半荘 {id} のフォルダを移せませんでした（開いているファイルが無いか、確かめてください）: {reason}"
            ),
            StoreError::Io(e) => write!(f, "ファイルを書けませんでした: {e}"),
            StoreError::Encode(e) => write!(f, "記録を書き出せませんでした: {e}"),
        }
    }
}

impl std::error::Error for StoreError {}

impl From<io::Error> for StoreError {
    fn from(e: io::Error) -> Self {
        StoreError::Io(e)
    }
}

impl From<serde_json::Error> for StoreError {
    fn from(e: serde_json::Error) -> Self {
        StoreError::Encode(e)
    }
}

/// 保存先がリポジトリの外であることを確かめる（D-1）。
/// 保存先と、その親をさかのぼって `.git`（フォルダでもファイルでも。worktree はファイル）があれば拒む。
/// まだ無いフォルダでも調べられるように、一番深い既存の祖先を実体のパスにして（リンクをたどる）調べる。
pub fn ensure_outside_git(path: &Path) -> Result<(), StoreError> {
    let resolved = resolve_for_check(path)?;
    for dir in resolved.ancestors() {
        if dir.join(".git").exists() {
            return Err(StoreError::InsideGitRepo {
                path: path.to_path_buf(),
                repo: dir.to_path_buf(),
            });
        }
    }
    Ok(())
}

fn resolve_for_check(path: &Path) -> io::Result<PathBuf> {
    let absolute = std::path::absolute(path)?;
    let mut existing: &Path = absolute.as_path();
    let mut rest: Vec<OsString> = Vec::new();
    while !existing.exists() {
        match (existing.parent(), existing.file_name()) {
            (Some(parent), Some(name)) => {
                rest.push(name.to_owned());
                existing = parent;
            }
            _ => break,
        }
    }
    let mut resolved = existing
        .canonicalize()
        .unwrap_or_else(|_| existing.to_path_buf());
    for name in rest.into_iter().rev() {
        resolved.push(name);
    }
    Ok(resolved)
}

/// ミリ秒の時刻をローカル時刻にする。
fn local_time(t_ms: i64) -> DateTime<Local> {
    Local
        .timestamp_millis_opt(t_ms)
        .earliest()
        .unwrap_or_else(|| DateTime::UNIX_EPOCH.with_timezone(&Local))
}

/// 半荘のフォルダ名（ローカル時刻の `YYYYMMDD-HHMMSS`）。
fn session_folder_base(t_ms: i64) -> String {
    local_time(t_ms).format("%Y%m%d-%H%M%S").to_string()
}

/// 迷いマークの画像のファイル名の元（ローカル時刻の `YYYYMMDD-HHMMSS-mmm`）。
fn mark_file_stem(t_ms: i64) -> String {
    local_time(t_ms).format("%Y%m%d-%H%M%S-%3f").to_string()
}

fn append_line(path: &Path, event: &Event) -> Result<(), StoreError> {
    let mut line = serde_json::to_string(event)?;
    line.push('\n');
    let mut file = OpenOptions::new().create(true).append(true).open(path)?;
    // 1 件を 1 回の書き込みで追記し、ディスクまで届けてから返す（途中で止まっても行が欠けにくいように）。
    file.write_all(line.as_bytes())?;
    file.sync_data()?;
    Ok(())
}

/// 記録のファイルを読む。読めない行（書きかけなど）は飛ばす。ファイルが無ければ `None`。
fn read_events(path: &Path) -> io::Result<Option<Vec<Event>>> {
    let text = match fs::read_to_string(path) {
        Ok(text) => text,
        Err(e) if e.kind() == io::ErrorKind::NotFound => return Ok(None),
        Err(e) => return Err(e),
    };
    Ok(Some(
        text.lines()
            .filter(|l| !l.trim().is_empty())
            .filter_map(|l| serde_json::from_str::<Event>(l).ok())
            .collect(),
    ))
}

struct Current {
    id: String,
    dir: PathBuf,
    events: Vec<Event>,
    /// 最後に追記した記録の時刻（30 分あいたかの判定に使う。W-14）。
    last_ms: i64,
}

impl Current {
    fn next_id(&self) -> u64 {
        self.events.iter().map(|e| e.id).max().map_or(0, |m| m + 1)
    }

    fn append(&mut self, t_ms: i64, kind: EventKind) -> Result<(), StoreError> {
        let event = Event {
            id: self.next_id(),
            t_ms,
            kind,
        };
        append_line(&self.dir.join(EVENTS_FILE), &event)?;
        self.events.push(event);
        self.last_ms = t_ms;
        Ok(())
    }
}

/// 撮った画像を保存した結果（迷いマークも評価も同じ扱い）。
struct SavedShot {
    screenshot: Option<String>,
    capture: Option<CaptureTarget>,
    capture_error: Option<String>,
}

/// 撮れなかった・保存できなかったときも、記録自体は理由つきで残す。
fn save_shot(
    session_dir: &Path,
    folder: &str,
    t_ms: i64,
    capture: Result<Screenshot, CaptureError>,
) -> SavedShot {
    match capture {
        Ok(shot) => match save_image(session_dir, folder, t_ms, &shot.png) {
            Ok(relative) => SavedShot {
                screenshot: Some(relative),
                capture: Some(shot.target),
                capture_error: None,
            },
            Err(e) => SavedShot {
                screenshot: None,
                capture: None,
                capture_error: Some(format!("画像を保存できませんでした: {e}")),
            },
        },
        Err(e) => SavedShot {
            screenshot: None,
            capture: None,
            capture_error: Some(e.to_string()),
        },
    }
}

/// データの保存先。半荘のフォルダの作成と、記録の追記を受け持つ。
pub struct Store {
    root: PathBuf,
    current: Option<Current>,
}

impl Store {
    /// 保存先を開く。リポジトリの中なら拒む（D-1）。
    pub fn open(root: impl Into<PathBuf>) -> Result<Store, StoreError> {
        let root = root.into();
        ensure_outside_git(&root)?;
        fs::create_dir_all(root.join(GAMES_DIR))?;
        Ok(Store {
            root,
            current: None,
        })
    }

    pub fn root(&self) -> &Path {
        &self.root
    }

    /// 開いている半荘の名前。
    pub fn current_session_id(&self) -> Option<&str> {
        self.current.as_ref().map(|c| c.id.as_str())
    }

    /// 開いている半荘の様子。半荘が無ければ空。
    pub fn view(&self) -> SessionView {
        self.current
            .as_ref()
            .map(|c| reduce(&c.events))
            .unwrap_or_default()
    }

    /// 今の半荘を閉じる（W-14）。フォルダは作らない。次の記録が、新しい半荘のフォルダを作る。
    /// 開いている半荘には「閉じた」記録を追記する（起動し直したときに、その半荘へ続けて記録しないため）。
    /// 追記できなくても、半荘は閉じる。
    pub fn close_session(&mut self, t_ms: i64) -> Result<(), StoreError> {
        match self.current.take() {
            Some(mut current) => current.append(t_ms, EventKind::SessionClose),
            None => Ok(()),
        }
    }

    /// 起動したとき、いちばん最近の半荘に続けて記録できるなら開く（W-14）。続けられるのは、記録（迷いマークか評価）が
    /// あり、「新しい半荘」で閉じておらず、最後の記録から `now_ms` まで 30 分以内のとき。続けられなければ何もしない
    /// （次の記録が新しい半荘を始める）。読めないフォルダは飛ばす。
    pub fn resume_recent(&mut self, now_ms: i64) {
        let Ok(entries) = fs::read_dir(self.root.join(GAMES_DIR)) else {
            return;
        };
        let mut latest: Option<Current> = None;
        for entry in entries.flatten() {
            let dir = entry.path();
            if !dir.is_dir() {
                continue;
            }
            let Ok(Some(events)) = read_events(&dir.join(EVENTS_FILE)) else {
                continue;
            };
            let has_record = events
                .iter()
                .any(|e| matches!(e.kind, EventKind::Mark { .. } | EventKind::Rating { .. }));
            let Some(last) = events.last() else {
                continue;
            };
            if !has_record || latest.as_ref().is_some_and(|l| l.last_ms >= last.t_ms) {
                continue;
            }
            let Some(id) = dir.file_name().and_then(|n| n.to_str()).map(str::to_owned) else {
                continue;
            };
            latest = Some(Current {
                id,
                last_ms: last.t_ms,
                dir,
                events,
            });
        }
        self.current = latest.filter(|c| {
            !matches!(
                c.events.last().map(|e| &e.kind),
                Some(EventKind::SessionClose)
            ) && now_ms.saturating_sub(c.last_ms) <= SESSION_GAP_MS
        });
    }

    /// 新しい半荘のフォルダを、空いている名前で作る。作ったフォルダの名前と場所を返す。
    fn claim_session_dir(&self, t_ms: i64) -> Result<(String, PathBuf), StoreError> {
        let games = self.root.join(GAMES_DIR);
        fs::create_dir_all(&games)?;
        let base = session_folder_base(t_ms);
        // 同じ秒に 2 回始めても別のフォルダになるよう、空いている名前を探す。
        let mut suffix = 1u32;
        loop {
            let id = if suffix == 1 {
                base.clone()
            } else {
                format!("{base}-{suffix}")
            };
            let dir = games.join(&id);
            match fs::create_dir(&dir) {
                Ok(()) => return Ok((id, dir)),
                Err(e) if e.kind() == io::ErrorKind::AlreadyExists => suffix += 1,
                Err(e) => return Err(e.into()),
            }
        }
    }

    /// 新しい半荘のフォルダを作って開く。半荘の最初の記録のときだけ呼ぶ（W-14）。
    fn begin_session(&mut self, t_ms: i64) -> Result<(), StoreError> {
        let (id, dir) = self.claim_session_dir(t_ms)?;
        let mut current = Current {
            id,
            dir,
            events: Vec::new(),
            last_ms: t_ms,
        };
        current.append(t_ms, EventKind::SessionStart)?;
        self.current = Some(current);
        Ok(())
    }

    /// 記録を入れる半荘を用意する（W-6、W-14）。
    /// 半荘が無ければ（最初の記録・「新しい半荘」のあと）、新しいフォルダを作る。
    /// 最後の記録から 30 分より長くあいていても、新しい半荘にする。
    pub fn ensure_session(&mut self, t_ms: i64) -> Result<(), StoreError> {
        let continues = self
            .current
            .as_ref()
            .is_some_and(|c| t_ms.saturating_sub(c.last_ms) <= SESSION_GAP_MS);
        if !continues {
            self.begin_session(t_ms)?;
        }
        Ok(())
    }

    /// 迷いマークを記録する。画像があれば `marks/<時刻>.png` に保存してから記録を追記する
    /// （記録が存在しない画像を指さないように）。
    /// 画像を撮れなかった・保存できなかったときも、マーク自体は理由つきで残す。
    pub fn add_mark(
        &mut self,
        t_ms: i64,
        capture: Result<Screenshot, CaptureError>,
    ) -> Result<(), StoreError> {
        self.ensure_session(t_ms)?;
        let current = self.current.as_mut().expect("半荘は開始済み");
        let saved = save_shot(&current.dir, MARKS_DIR, t_ms, capture);
        current.append(
            t_ms,
            EventKind::Mark {
                screenshot: saved.screenshot,
                capture: saved.capture,
                capture_error: saved.capture_error,
            },
        )
    }

    /// 局の評価を記録する。スクリーンショットも、迷いマークと同じ扱いで `ratings/<時刻>.png` に保存して、
    /// 記録にそのパスを入れる（W-13）。撮れなかったときも、評価自体は理由つきで残す。
    pub fn add_rating(
        &mut self,
        t_ms: i64,
        rating: Rating,
        capture: Result<Screenshot, CaptureError>,
    ) -> Result<(), StoreError> {
        self.ensure_session(t_ms)?;
        let current = self.current.as_mut().expect("半荘は開始済み");
        let saved = save_shot(&current.dir, RATINGS_DIR, t_ms, capture);
        current.append(
            t_ms,
            EventKind::Rating {
                rating,
                screenshot: saved.screenshot,
                capture: saved.capture,
                capture_error: saved.capture_error,
            },
        )
    }

    /// 最後の記録（取り消されていない迷いマークか評価）を 1 つだけ取り消す（W-3）。
    /// 取り消した記録の `id` を返す。
    pub fn undo(&mut self, t_ms: i64) -> Result<u64, StoreError> {
        let current = self.current.as_mut().ok_or(StoreError::NothingToUndo)?;
        let target = reduce(&current.events)
            .last_active_id()
            .ok_or(StoreError::NothingToUndo)?;
        current.append(t_ms, EventKind::Undo { target })?;
        Ok(target)
    }

    /// 保存先にある半荘を、新しい順に返す。記録（迷いマークか評価）も結果も無い半荘は入れない（W-14）。
    /// 昔に作られた空のフォルダも消さずに、一覧に出さないだけ。結果だけの半荘（記録の無いまま取り込んだもの）は入れる。
    pub fn list_sessions(&self) -> Result<Vec<SessionRecord>, StoreError> {
        let games = self.root.join(GAMES_DIR);
        let entries = match fs::read_dir(&games) {
            Ok(entries) => entries,
            Err(e) if e.kind() == io::ErrorKind::NotFound => return Ok(Vec::new()),
            Err(e) => return Err(e.into()),
        };
        let mut sessions = Vec::new();
        for entry in entries {
            let entry = entry?;
            if !entry.file_type()?.is_dir() {
                continue;
            }
            let dir = entry.path();
            let name = entry.file_name().to_string_lossy().into_owned();
            let events = read_events(&dir.join(EVENTS_FILE))?.unwrap_or_default();
            let report_file = dir.join(REPORT_FILE);
            let has_report = report_file.is_file();
            let view = reduce(&events);
            if view.marks.is_empty() && view.ratings.is_empty() && !has_report {
                continue;
            }
            let Some(started_ms) = view
                .started_ms
                .or_else(|| events.first().map(|e| e.t_ms))
                .or_else(|| started_ms_from_folder_name(&name))
            else {
                continue;
            };
            let absolute = |relative: &Option<String>| {
                relative
                    .as_ref()
                    .map(|rel| dir.join(rel).to_string_lossy().into_owned())
            };
            let marks = view
                .marks
                .iter()
                .map(|entry| MarkRecord {
                    entry: entry.clone(),
                    screenshot_path: absolute(&entry.screenshot),
                })
                .collect();
            let ratings = view
                .ratings
                .iter()
                .map(|entry| RatingRecord {
                    entry: entry.clone(),
                    screenshot_path: absolute(&entry.screenshot),
                })
                .collect();
            sessions.push(SessionRecord {
                id: name,
                started_ms,
                mark_count: view.marks.len(),
                rating_count: view.ratings.len(),
                marks,
                ratings,
                events,
                report_path: has_report.then(|| report_file.to_string_lossy().into_owned()),
                ocr: read_json_file::<OcrCache>(&dir.join(OCR_FILE)),
                links: read_json_file::<Links>(&dir.join(LINKS_FILE)).unwrap_or_default(),
            });
        }
        sessions.sort_by(|a, b| {
            b.started_ms
                .cmp(&a.started_ms)
                .then_with(|| b.id.cmp(&a.id))
        });
        Ok(sessions)
    }

    // ---- 半荘の削除（U-9）: フォルダを `trash/` へ移す。アプリを閉じるまで、戻せる ----

    /// 半荘のフォルダを、保存先の `trash/` へ移す（同じボリュームなので一瞬）。消した半荘は、一覧にも、起動したときの
    /// 続きの記録にも出ない。アプリを閉じるとき、置き場の中身は Windows のごみ箱へ送られる（`trash.rs`）。それまでは
    /// `restore_sessions` で戻せる。
    ///
    /// 先に全部を確かめて（名前の形・フォルダがあること・置き場に同じ名前が無いこと）から移す。途中で移せなくなったら、
    /// 移した分を戻して、何も変えない。ウィジェットが記録中の半荘が入っていれば、移したあとにその半荘を閉じる
    /// （移した先のフォルダに、記録を追記しない。呼ぶ側が記録の錠を持っているので、移す間に追記は起きない）。
    pub fn delete_sessions(&mut self, ids: &[String]) -> Result<(), StoreError> {
        let ids = unique_ids(ids);
        let trash = self.root.join(TRASH_DIR);
        let mut moves = Vec::new();
        for id in &ids {
            let from = self.session_path(id)?;
            let to = trash.join(id);
            if to.exists() {
                return Err(StoreError::TrashOccupied(id.clone()));
            }
            moves.push((id.clone(), from, to));
        }
        if moves.is_empty() {
            return Ok(());
        }
        fs::create_dir_all(&trash)?;
        move_all(&moves, &mut |from, to| fs::rename(from, to))?;
        if self
            .current
            .as_ref()
            .is_some_and(|current| ids.contains(&current.id))
        {
            self.current = None;
        }
        Ok(())
    }

    /// 消した半荘を、元の場所（`games/`）へ戻す。戻す場所に同じ名前があるとき・置き場に無いときは、何も戻さない。
    /// 戻しても、その半荘は「記録中」にはならない（次に記録を押したときは、新しい半荘になる）。
    pub fn restore_sessions(&self, ids: &[String]) -> Result<(), StoreError> {
        let trash = self.root.join(TRASH_DIR);
        let games = self.root.join(GAMES_DIR);
        let mut moves = Vec::new();
        for id in unique_ids(ids) {
            if !valid_session_id(&id) {
                return Err(StoreError::UnknownSession(id));
            }
            let from = trash.join(&id);
            if !from.is_dir() {
                return Err(StoreError::NotInTrash(id));
            }
            let to = games.join(&id);
            if to.exists() {
                return Err(StoreError::RestoreBlocked(id));
            }
            moves.push((id, from, to));
        }
        if moves.is_empty() {
            return Ok(());
        }
        fs::create_dir_all(&games)?;
        move_all(&moves, &mut |from, to| fs::rename(from, to))?;
        // 空になったら、置き場のフォルダも片づける（中身があれば、何もしない）。
        let _ = fs::remove_dir(&trash);
        Ok(())
    }

    // ---- 取り込み（F1・F9・F11）: 結果・文字認識の写し・結びつけ。半荘のフォルダに、別のファイルとして置く ----

    /// 半荘の名前から、そのフォルダの場所を求める。名前の形（英数字と `-` だけ）と、フォルダがあることを確かめる。
    fn session_path(&self, id: &str) -> Result<PathBuf, StoreError> {
        if !valid_session_id(id) {
            return Err(StoreError::UnknownSession(id.to_string()));
        }
        let dir = self.root.join(GAMES_DIR).join(id);
        if dir.is_dir() {
            Ok(dir)
        } else {
            Err(StoreError::UnknownSession(id.to_string()))
        }
    }

    /// 取り込んだ結果（生の JSON）を、半荘のフォルダに `report.json` として残す。半荘の名前を返す。
    /// - `session_id` がある: その半荘に結びつける。すでに結果があれば断る（上書きしない）。
    /// - `None`: 記録の無い半荘の結果として、新しい半荘のフォルダを作る（開始の記録 1 行と結果だけ。開始の時刻は `now_ms`）。
    ///   開いている半荘（ウィジェットが記録中のもの）は、そのまま。
    ///
    /// 結果が JSON として読めなければ、何も書かない。
    pub fn save_report(
        &mut self,
        session_id: Option<&str>,
        raw: &str,
        now_ms: i64,
    ) -> Result<String, StoreError> {
        serde_json::from_str::<IgnoredAny>(raw)
            .map_err(|e| StoreError::InvalidReport(e.to_string()))?;
        let (id, dir, created) = match session_id {
            Some(id) => {
                let dir = self.session_path(id)?;
                if dir.join(REPORT_FILE).exists() {
                    return Err(StoreError::ReportExists(id.to_string()));
                }
                (id.to_string(), dir, false)
            }
            None => {
                let (id, dir) = self.claim_session_dir(now_ms)?;
                let start = Event {
                    id: 0,
                    t_ms: now_ms,
                    kind: EventKind::SessionStart,
                };
                if let Err(e) = append_line(&dir.join(EVENTS_FILE), &start) {
                    discard_new_session_dir(&dir);
                    return Err(e);
                }
                (id, dir, true)
            }
        };
        if let Err(e) = write_atomic(&dir.join(REPORT_FILE), raw.as_bytes()) {
            if created {
                discard_new_session_dir(&dir);
            }
            return Err(e.into());
        }
        Ok(id)
    }

    /// 取り込んだ結果の生の JSON。まだ取り込んでいなければ `None`。
    pub fn read_report(&self, session_id: &str) -> Result<Option<String>, StoreError> {
        let dir = self.session_path(session_id)?;
        match fs::read_to_string(dir.join(REPORT_FILE)) {
            Ok(text) => Ok(Some(text)),
            Err(e) if e.kind() == io::ErrorKind::NotFound => Ok(None),
            Err(e) => Err(e.into()),
        }
    }

    /// 半荘の迷いマーク・評価の画像（取り消されていないもの）の、（半荘のフォルダからの相対パス, 絶対パス）。
    /// 文字認識にかける画像の一覧に使う。画像が撮れなかった記録は入らない。
    pub fn screenshots_of(&self, session_id: &str) -> Result<Vec<(String, PathBuf)>, StoreError> {
        let dir = self.session_path(session_id)?;
        let events = read_events(&dir.join(EVENTS_FILE))?.unwrap_or_default();
        let view = reduce(&events);
        let marks = view.marks.iter().map(|m| m.screenshot.as_ref());
        let ratings = view.ratings.iter().map(|r| r.screenshot.as_ref());
        Ok(marks
            .chain(ratings)
            .flatten()
            .map(|relative| (relative.clone(), dir.join(relative)))
            .collect())
    }

    /// 文字認識の結果の写し。まだ無い・読めないときは `None`。
    pub fn load_ocr(&self, session_id: &str) -> Result<Option<OcrCache>, StoreError> {
        let dir = self.session_path(session_id)?;
        Ok(read_json_file::<OcrCache>(&dir.join(OCR_FILE)))
    }

    /// 文字認識の結果の写しを書く（まるごと置き換える）。計算は取り込みのときだけ（S-3）。ここは、ファイルに書くだけ。
    pub fn save_ocr(&self, session_id: &str, cache: &OcrCache) -> Result<(), StoreError> {
        let dir = self.session_path(session_id)?;
        let text = serde_json::to_string_pretty(cache)?;
        write_atomic(&dir.join(OCR_FILE), text.as_bytes())?;
        Ok(())
    }

    /// 迷いマーク・評価の結びつけ。まだ無い・読めないときは空。
    pub fn load_links(&self, session_id: &str) -> Result<Links, StoreError> {
        let dir = self.session_path(session_id)?;
        Ok(read_json_file::<Links>(&dir.join(LINKS_FILE)).unwrap_or_default())
    }

    /// 結びつけをまるごと置き換える（取り込みのときに、自動で決めた結びつけを一度に書く）。
    /// 迷いマーク・評価の番号は、その半荘にある（取り消されていない）ものだけ受け付ける。
    pub fn replace_links(&self, session_id: &str, links: Links) -> Result<(), StoreError> {
        let dir = self.session_path(session_id)?;
        let events = read_events(&dir.join(EVENTS_FILE))?.unwrap_or_default();
        let view = reduce(&events);
        for (key, value) in &links.marks {
            check_record_id(key, "迷いマーク", view.marks.iter().map(|m| m.id))?;
            check_link_value(value, false)?;
        }
        for (key, value) in &links.ratings {
            check_record_id(key, "評価", view.ratings.iter().map(|r| r.id))?;
            check_link_value(value, true)?;
        }
        write_links(&dir, &links)
    }

    /// 迷いマークを、判断の鍵（または `"manual"`）に結びつける。選び直しにも使う。
    pub fn set_mark_link(
        &self,
        session_id: &str,
        mark_id: u64,
        decision: &str,
    ) -> Result<(), StoreError> {
        check_link_value(decision, false)?;
        self.update_links(session_id, |links, view| {
            let key = mark_id.to_string();
            check_record_id(&key, "迷いマーク", view.marks.iter().map(|m| m.id))?;
            links.marks.insert(key, decision.to_string());
            Ok(())
        })
    }

    /// 迷いマークの結びつけを消す（「まだ決めていない」に戻す。取り消しにも使う）。
    pub fn clear_mark_link(&self, session_id: &str, mark_id: u64) -> Result<(), StoreError> {
        self.update_links(session_id, |links, _| {
            links.marks.remove(&mark_id.to_string());
            Ok(())
        })
    }

    /// 評価を、局の鍵に結びつける。空の文字列は、「どの局にも結びつけない」。
    pub fn set_rating_link(
        &self,
        session_id: &str,
        rating_id: u64,
        kyoku: &str,
    ) -> Result<(), StoreError> {
        check_link_value(kyoku, true)?;
        self.update_links(session_id, |links, view| {
            let key = rating_id.to_string();
            check_record_id(&key, "評価", view.ratings.iter().map(|r| r.id))?;
            links.ratings.insert(key, kyoku.to_string());
            Ok(())
        })
    }

    /// 評価の結びつけを消す（「まだ決めていない」に戻す）。
    pub fn clear_rating_link(&self, session_id: &str, rating_id: u64) -> Result<(), StoreError> {
        self.update_links(session_id, |links, _| {
            links.ratings.remove(&rating_id.to_string());
            Ok(())
        })
    }

    /// 結びつけを読んで、`change` で書き換えて、書き戻す。
    fn update_links(
        &self,
        session_id: &str,
        change: impl FnOnce(&mut Links, &SessionView) -> Result<(), StoreError>,
    ) -> Result<(), StoreError> {
        let dir = self.session_path(session_id)?;
        let events = read_events(&dir.join(EVENTS_FILE))?.unwrap_or_default();
        let view = reduce(&events);
        let mut links = read_json_file::<Links>(&dir.join(LINKS_FILE)).unwrap_or_default();
        change(&mut links, &view)?;
        write_links(&dir, &links)
    }
}

/// 名前の並びから、重なりを除く（最初に出た順）。
fn unique_ids(ids: &[String]) -> Vec<String> {
    let mut out: Vec<String> = Vec::new();
    for id in ids {
        if !out.contains(id) {
            out.push(id.clone());
        }
    }
    out
}

/// 半荘のフォルダを、1 つずつ移す（名前、元、先）。途中で移せなくなったら、移した分を逆の順に戻してから、その理由を返す。
/// 移し方（`mover`）は、試験で差し替えられる。
fn move_all(
    moves: &[(String, PathBuf, PathBuf)],
    mover: &mut dyn FnMut(&Path, &Path) -> io::Result<()>,
) -> Result<(), StoreError> {
    for (index, (id, from, to)) in moves.iter().enumerate() {
        if let Err(e) = mover(from, to) {
            for (_, done_from, done_to) in moves[..index].iter().rev() {
                let _ = mover(done_to, done_from);
            }
            return Err(StoreError::Move {
                id: id.clone(),
                reason: e.to_string(),
            });
        }
    }
    Ok(())
}

fn write_links(dir: &Path, links: &Links) -> Result<(), StoreError> {
    let text = serde_json::to_string_pretty(links)?;
    write_atomic(&dir.join(LINKS_FILE), text.as_bytes())?;
    Ok(())
}

/// 半荘の名前として正しい形か（英数字と `-` だけ。区切り・`..` を通さない）。
fn valid_session_id(id: &str) -> bool {
    !id.is_empty() && id.len() <= 64 && id.bytes().all(|b| b.is_ascii_alphanumeric() || b == b'-')
}

/// フォルダの名前（`YYYYMMDD-HHMMSS` で始まる）から、開始の時刻（ミリ秒）を求める。読めなければ `None`。
fn started_ms_from_folder_name(name: &str) -> Option<i64> {
    let head = name.get(..15)?;
    let naive = NaiveDateTime::parse_from_str(head, "%Y%m%d-%H%M%S").ok()?;
    Local
        .from_local_datetime(&naive)
        .earliest()
        .map(|t| t.timestamp_millis())
}

/// 結びつけの値（局面の鍵・局の鍵）が正しい形か。長さの上限と、見える ASCII 文字だけ。`allow_empty` なら空も可。
fn check_link_value(value: &str, allow_empty: bool) -> Result<(), StoreError> {
    if value.is_empty() {
        return if allow_empty {
            Ok(())
        } else {
            Err(StoreError::InvalidLink("空の値は結びつけられません".into()))
        };
    }
    if value.len() > MAX_LINK_VALUE_LEN || !value.bytes().all(|b| b.is_ascii_graphic()) {
        return Err(StoreError::InvalidLink(format!(
            "{MAX_LINK_VALUE_LEN} 文字以内の、見える ASCII 文字だけにしてください"
        )));
    }
    Ok(())
}

/// 結びつけの鍵（10 進の文字列にした番号）が、その半荘の取り消されていない記録の番号か。
fn check_record_id(
    key: &str,
    kind: &'static str,
    mut ids: impl Iterator<Item = u64>,
) -> Result<(), StoreError> {
    let known = key
        .parse::<u64>()
        .ok()
        .is_some_and(|id| ids.any(|known| known == id));
    if known {
        Ok(())
    } else {
        Err(StoreError::UnknownRecord {
            kind,
            id: key.to_string(),
        })
    }
}

/// JSON のファイルを読む。無い・読めないときは `None`（壊れたファイルで、一覧全体を止めない）。
fn read_json_file<T: serde::de::DeserializeOwned>(path: &Path) -> Option<T> {
    serde_json::from_str(&fs::read_to_string(path).ok()?).ok()
}

/// 別の名前で書いてから置き換える（途中で止まっても、半端なファイルが残らない）。
fn write_atomic(path: &Path, bytes: &[u8]) -> io::Result<()> {
    let mut temp = path.as_os_str().to_owned();
    temp.push(".tmp");
    let temp = PathBuf::from(temp);
    {
        let mut file = fs::File::create(&temp)?;
        file.write_all(bytes)?;
        file.sync_data()?;
    }
    fs::rename(&temp, path).inspect_err(|_| {
        let _ = fs::remove_file(&temp);
    })
}

/// 取り込みのために作ったばかりの半荘のフォルダを、書き込みに失敗したときに片づける（開始の行だけの、空のフォルダ）。
/// 再帰では消さない（中身が増えていれば、消さずに残す）。
fn discard_new_session_dir(dir: &Path) {
    let _ = fs::remove_file(dir.join(EVENTS_FILE));
    let _ = fs::remove_dir(dir);
}

/// 画像を `folder`（`marks` か `ratings`）に新しいファイルとして保存し、半荘のフォルダからの相対パスを返す。
fn save_image(session_dir: &Path, folder: &str, t_ms: i64, png: &[u8]) -> io::Result<String> {
    let images = session_dir.join(folder);
    fs::create_dir_all(&images)?;
    let stem = mark_file_stem(t_ms);
    let mut suffix = 1u32;
    loop {
        let name = if suffix == 1 {
            format!("{stem}.png")
        } else {
            format!("{stem}-{suffix}.png")
        };
        match OpenOptions::new()
            .write(true)
            .create_new(true)
            .open(images.join(&name))
        {
            Ok(mut file) => {
                file.write_all(png)?;
                file.sync_data()?;
                return Ok(format!("{folder}/{name}"));
            }
            Err(e) if e.kind() == io::ErrorKind::AlreadyExists => suffix += 1,
            Err(e) => return Err(e),
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    const T0: i64 = 1_760_000_000_123;

    fn shot() -> Result<Screenshot, CaptureError> {
        Ok(Screenshot {
            png: vec![0x89, b'P', b'N', b'G'],
            target: CaptureTarget::Window,
        })
    }

    /// 画像の無い評価の記録の中身（昔の形）。
    fn rating_kind(rating: Rating) -> EventKind {
        EventKind::Rating {
            rating,
            screenshot: None,
            capture: None,
            capture_error: None,
        }
    }

    fn open_store() -> (tempfile::TempDir, Store) {
        let dir = tempfile::tempdir().unwrap();
        let store = Store::open(dir.path().join("data")).unwrap();
        (dir, store)
    }

    fn event_lines(store: &Store) -> Vec<String> {
        let id = store.current_session_id().unwrap();
        let path = store.root().join(GAMES_DIR).join(id).join(EVENTS_FILE);
        fs::read_to_string(path)
            .unwrap()
            .lines()
            .map(str::to_string)
            .collect()
    }

    fn session_dir(store: &Store) -> PathBuf {
        store
            .root()
            .join(GAMES_DIR)
            .join(store.current_session_id().unwrap())
    }

    // ---- D-1 ----

    #[test]
    fn d1_a_data_dir_inside_a_git_work_tree_is_refused() {
        let tmp = tempfile::tempdir().unwrap();
        let repo = tmp.path().join("repo");
        fs::create_dir_all(repo.join(".git")).unwrap();
        let inside = repo.join("data");
        let err = Store::open(&inside).err().expect("拒まれる");
        assert!(matches!(err, StoreError::InsideGitRepo { .. }));
        // 拒んだときは何も作らない。
        assert!(!inside.exists());
    }

    #[test]
    fn d1_a_deeply_nested_path_inside_a_repo_is_refused() {
        let tmp = tempfile::tempdir().unwrap();
        let repo = tmp.path().join("repo");
        fs::create_dir_all(repo.join(".git")).unwrap();
        let nested = repo.join("a").join("b").join("c");
        assert!(matches!(
            ensure_outside_git(&nested),
            Err(StoreError::InsideGitRepo { .. })
        ));
    }

    #[test]
    fn d1_a_worktree_style_git_file_also_counts_as_a_repository() {
        let tmp = tempfile::tempdir().unwrap();
        let worktree = tmp.path().join("wt");
        fs::create_dir_all(&worktree).unwrap();
        fs::write(worktree.join(".git"), "gitdir: ../main/.git/worktrees/wt").unwrap();
        assert!(matches!(
            Store::open(worktree.join("data")),
            Err(StoreError::InsideGitRepo { .. })
        ));
    }

    #[test]
    fn d1_the_repo_root_itself_is_refused() {
        let tmp = tempfile::tempdir().unwrap();
        fs::create_dir_all(tmp.path().join(".git")).unwrap();
        assert!(matches!(
            Store::open(tmp.path()),
            Err(StoreError::InsideGitRepo { .. })
        ));
    }

    #[test]
    fn d1_a_folder_outside_any_repository_is_accepted_and_created() {
        let tmp = tempfile::tempdir().unwrap();
        let data = tmp.path().join("outside").join("data");
        let store = Store::open(&data).unwrap();
        assert!(data.join(GAMES_DIR).is_dir());
        assert_eq!(store.root(), data.as_path());
    }

    #[test]
    fn d1_the_error_message_names_the_repository() {
        let tmp = tempfile::tempdir().unwrap();
        fs::create_dir_all(tmp.path().join(".git")).unwrap();
        let err = ensure_outside_git(&tmp.path().join("x")).unwrap_err();
        let text = err.to_string();
        assert!(text.contains("リポジトリの中"), "{text}");
    }

    // ---- W-6 ----

    #[test]
    fn w6_after_a_new_session_later_records_go_to_a_new_folder() {
        let (_tmp, mut store) = open_store();
        store.add_rating(T0 + 10, Rating::Good, shot()).unwrap();
        let first = store.current_session_id().unwrap().to_string();
        store.close_session(T0 + 20).unwrap();
        store.add_rating(T0 + 6_000, Rating::Bad, shot()).unwrap();
        let second = store.current_session_id().unwrap().to_string();
        assert_ne!(first, second);

        let games = store.root().join(GAMES_DIR);
        let first_lines = fs::read_to_string(games.join(&first).join(EVENTS_FILE)).unwrap();
        let second_lines = fs::read_to_string(games.join(&second).join(EVENTS_FILE)).unwrap();
        assert_eq!(
            first_lines.lines().count(),
            3,
            "半荘の開始と評価1件と、閉じた記録"
        );
        assert!(first_lines.contains("\"good\""));
        assert!(!first_lines.contains("\"bad\""));
        assert_eq!(second_lines.lines().count(), 2);
        assert!(second_lines.contains("\"bad\""));
    }

    #[test]
    fn w6_session_folder_name_is_local_time_yyyymmdd_hhmmss() {
        let (_tmp, mut store) = open_store();
        store.add_mark(T0, shot()).unwrap();
        let id = store.current_session_id().unwrap().to_string();
        let b = id.as_bytes();
        assert_eq!(id.len(), 15, "{id}");
        assert!(b[..8].iter().all(u8::is_ascii_digit), "{id}");
        assert_eq!(b[8], b'-');
        assert!(b[9..].iter().all(u8::is_ascii_digit), "{id}");
        assert_eq!(id, session_folder_base(T0));
    }

    #[test]
    fn w6_two_sessions_in_the_same_second_get_different_folders() {
        let (_tmp, mut store) = open_store();
        store.add_mark(T0, shot()).unwrap();
        let a = store.current_session_id().unwrap().to_string();
        store.close_session(T0 + 200).unwrap();
        store.add_mark(T0 + 400, shot()).unwrap();
        let b = store.current_session_id().unwrap().to_string();
        assert_ne!(a, b);
        assert!(store.root().join(GAMES_DIR).join(&a).is_dir());
        assert!(store.root().join(GAMES_DIR).join(&b).is_dir());
    }

    #[test]
    fn w6_the_first_mark_without_a_session_starts_one() {
        let (_tmp, mut store) = open_store();
        assert!(store.current_session_id().is_none());
        store.add_mark(T0, shot()).unwrap();
        assert!(store.current_session_id().is_some());
        assert_eq!(store.view().mark_count(), 1);
        // 半荘の開始 + マークの 2 行
        assert_eq!(event_lines(&store).len(), 2);
    }

    #[test]
    fn w6_the_first_rating_without_a_session_starts_one() {
        let (_tmp, mut store) = open_store();
        store.add_rating(T0, Rating::Fair, shot()).unwrap();
        assert!(store.current_session_id().is_some());
        assert_eq!(store.view().next_hand(), 2);
    }

    #[test]
    fn w6_marks_and_ratings_do_not_start_extra_sessions() {
        let (_tmp, mut store) = open_store();
        store.add_mark(T0, shot()).unwrap();
        let id = store.current_session_id().unwrap().to_string();
        store.add_rating(T0 + 1, Rating::Good, shot()).unwrap();
        store.add_mark(T0 + 2, shot()).unwrap();
        assert_eq!(store.current_session_id().unwrap(), id);
        assert_eq!(
            fs::read_dir(store.root().join(GAMES_DIR)).unwrap().count(),
            1
        );
    }

    // ---- W-1 の保存側（記録1件 + 画像1枚） ----

    #[test]
    fn w1_a_mark_writes_one_record_with_a_millisecond_time_and_one_png() {
        let (_tmp, mut store) = open_store();
        store.add_mark(T0, shot()).unwrap();

        let lines = event_lines(&store);
        let mark_lines: Vec<&String> = lines.iter().filter(|l| l.contains("\"mark\"")).collect();
        assert_eq!(mark_lines.len(), 1);
        let event: Event = serde_json::from_str(mark_lines[0]).unwrap();
        assert_eq!(event.t_ms, T0, "ミリ秒まで記録する");
        let EventKind::Mark {
            screenshot,
            capture,
            capture_error,
        } = event.kind
        else {
            panic!("マークの記録のはず");
        };
        assert_eq!(capture, Some(CaptureTarget::Window));
        assert_eq!(capture_error, None);
        let relative = screenshot.expect("画像のパスが入る");
        assert!(relative.starts_with("marks/") && relative.ends_with(".png"));
        assert!(relative.contains(&mark_file_stem(T0)));

        let pngs: Vec<_> = fs::read_dir(session_dir(&store).join(MARKS_DIR))
            .unwrap()
            .collect();
        assert_eq!(pngs.len(), 1, "画像は 1 枚");
        assert_eq!(
            fs::read(session_dir(&store).join(&relative)).unwrap(),
            vec![0x89, b'P', b'N', b'G']
        );
    }

    #[test]
    fn w1_two_marks_in_the_same_millisecond_get_distinct_files() {
        let (_tmp, mut store) = open_store();
        store.add_mark(T0, shot()).unwrap();
        store.add_mark(T0, shot()).unwrap();
        let count = fs::read_dir(session_dir(&store).join(MARKS_DIR))
            .unwrap()
            .count();
        assert_eq!(count, 2);
        let view = store.view();
        assert_ne!(view.marks[0].screenshot, view.marks[1].screenshot);
    }

    #[test]
    fn w1_a_failed_capture_still_records_the_mark_with_the_reason() {
        let (_tmp, mut store) = open_store();
        store
            .add_mark(T0, Err(CaptureError("画面を撮れませんでした".into())))
            .unwrap();
        let view = store.view();
        assert_eq!(view.mark_count(), 1);
        assert_eq!(view.marks[0].screenshot, None);
        assert_eq!(
            view.marks[0].capture_error.as_deref(),
            Some("画面を撮れませんでした")
        );
        // 画像が無ければ、画像のフォルダも作らない（フォルダは最初の画像が作る）。
        assert!(!session_dir(&store).join(MARKS_DIR).exists());
    }

    // ---- W-3 / W-8 ----

    #[test]
    fn w3_undo_cancels_only_the_most_recent_record() {
        let (_tmp, mut store) = open_store();
        store.add_mark(T0, shot()).unwrap(); // id 1
        store.add_rating(T0 + 1, Rating::Good, shot()).unwrap(); // id 2
        store.add_mark(T0 + 2, shot()).unwrap(); // id 3

        assert_eq!(store.undo(T0 + 3).unwrap(), 3);
        let view = store.view();
        assert_eq!(view.mark_count(), 1, "最後のマークだけが消える");
        assert_eq!(view.ratings.len(), 1, "評価は残る");

        assert_eq!(store.undo(T0 + 4).unwrap(), 2);
        let view = store.view();
        assert_eq!(view.mark_count(), 1);
        assert_eq!(view.ratings.len(), 0, "次に消えるのは評価");

        assert_eq!(store.undo(T0 + 5).unwrap(), 1);
        assert_eq!(store.view().mark_count(), 0);
        assert!(!store.view().can_undo());
    }

    #[test]
    fn w3_undo_with_nothing_to_undo_is_an_error_and_writes_nothing() {
        let (_tmp, mut store) = open_store();
        assert!(matches!(store.undo(T0), Err(StoreError::NothingToUndo)));
        // 半荘が無いうちの取り消しは、半荘のフォルダも作らない。
        assert!(fs::read_dir(store.root().join(GAMES_DIR))
            .unwrap()
            .next()
            .is_none());
        // 記録をすべて取り消したあとは、取り消せるものが無い。
        store.add_rating(T0, Rating::Good, shot()).unwrap();
        store.undo(T0 + 1).unwrap();
        let before = event_lines(&store).len();
        assert!(matches!(store.undo(T0 + 2), Err(StoreError::NothingToUndo)));
        assert_eq!(event_lines(&store).len(), before);
    }

    #[test]
    fn w3_undo_points_at_the_record_it_cancels_and_never_deletes_lines() {
        let (_tmp, mut store) = open_store();
        store.add_rating(T0, Rating::Bad, shot()).unwrap(); // id 1
        let before = event_lines(&store);
        store.undo(T0 + 1).unwrap();
        let after = event_lines(&store);
        assert_eq!(after.len(), before.len() + 1);
        assert_eq!(
            &after[..before.len()],
            &before[..],
            "既存の行は書き換えない"
        );
        let last: Event = serde_json::from_str(after.last().unwrap()).unwrap();
        assert_eq!(last.kind, EventKind::Undo { target: 1 });
    }

    #[test]
    fn w3_an_undone_marks_screenshot_stays_on_disk() {
        let (_tmp, mut store) = open_store();
        store.add_mark(T0, shot()).unwrap();
        store.undo(T0 + 1).unwrap();
        assert_eq!(
            fs::read_dir(session_dir(&store).join(MARKS_DIR))
                .unwrap()
                .count(),
            1,
            "記録は消さない方針"
        );
    }

    #[test]
    fn w8_each_rating_advances_the_next_hand_and_undo_steps_back() {
        let (_tmp, mut store) = open_store();
        assert_eq!(store.view().next_hand(), 1);
        store.add_rating(T0, Rating::Good, shot()).unwrap();
        assert_eq!(store.view().next_hand(), 2);
        store.add_rating(T0 + 1, Rating::Fair, shot()).unwrap();
        assert_eq!(store.view().next_hand(), 3);
        store.add_rating(T0 + 2, Rating::Bad, shot()).unwrap();
        assert_eq!(store.view().next_hand(), 4);
        store.undo(T0 + 3).unwrap();
        assert_eq!(store.view().next_hand(), 3);
        store.undo(T0 + 4).unwrap();
        assert_eq!(store.view().next_hand(), 2);
        store.add_rating(T0 + 5, Rating::Good, shot()).unwrap();
        assert_eq!(store.view().next_hand(), 3);
    }

    #[test]
    fn w8_marks_do_not_change_the_next_hand() {
        let (_tmp, mut store) = open_store();
        store.add_rating(T0, Rating::Good, shot()).unwrap();
        store.add_mark(T0 + 1, shot()).unwrap();
        store.add_mark(T0 + 2, shot()).unwrap();
        assert_eq!(store.view().next_hand(), 2);
        // 取り消しがマークに当たっても、次の局番号は動かない。
        store.undo(T0 + 3).unwrap();
        assert_eq!(store.view().next_hand(), 2);
    }

    #[test]
    fn w8_ratings_keep_their_order_and_hand_numbers_after_an_undo() {
        let (_tmp, mut store) = open_store();
        store.add_rating(T0, Rating::Good, shot()).unwrap();
        store.add_rating(T0 + 1, Rating::Bad, shot()).unwrap();
        store.add_rating(T0 + 2, Rating::Fair, shot()).unwrap();
        store.undo(T0 + 3).unwrap();
        store.add_rating(T0 + 4, Rating::Good, shot()).unwrap();
        let view = store.view();
        let seq: Vec<(usize, Rating)> = view.ratings.iter().map(|r| (r.hand, r.rating)).collect();
        assert_eq!(
            seq,
            vec![(1, Rating::Good), (2, Rating::Bad), (3, Rating::Good)]
        );
    }

    // ---- 記録の形（追記式・読み戻し） ----

    #[test]
    fn events_file_is_append_only_json_lines() {
        let (_tmp, mut store) = open_store();
        store.add_mark(T0, shot()).unwrap();
        let mut previous = event_lines(&store);
        for step in 0..4 {
            match step % 2 {
                0 => store.add_rating(T0 + step, Rating::Good, shot()).unwrap(),
                _ => store.add_mark(T0 + step, shot()).unwrap(),
            }
            let now = event_lines(&store);
            assert_eq!(now.len(), previous.len() + 1);
            assert_eq!(&now[..previous.len()], &previous[..]);
            for line in &now {
                serde_json::from_str::<Event>(line).expect("各行が 1 件の記録");
            }
            previous = now;
        }
    }

    #[test]
    fn event_json_shape_is_stable() {
        let start = Event {
            id: 0,
            t_ms: 5,
            kind: EventKind::SessionStart,
        };
        assert_eq!(
            serde_json::to_string(&start).unwrap(),
            r#"{"id":0,"t_ms":5,"type":"session_start"}"#
        );
        let rating = Event {
            id: 2,
            t_ms: 7,
            kind: rating_kind(Rating::Fair),
        };
        assert_eq!(
            serde_json::to_string(&rating).unwrap(),
            r#"{"id":2,"t_ms":7,"type":"rating","rating":"fair"}"#
        );
        let undo = Event {
            id: 3,
            t_ms: 9,
            kind: EventKind::Undo { target: 2 },
        };
        assert_eq!(
            serde_json::to_string(&undo).unwrap(),
            r#"{"id":3,"t_ms":9,"type":"undo","target":2}"#
        );
        let mark = Event {
            id: 1,
            t_ms: 6,
            kind: EventKind::Mark {
                screenshot: Some("marks/a.png".into()),
                capture: Some(CaptureTarget::Screen),
                capture_error: None,
            },
        };
        assert_eq!(
            serde_json::to_string(&mark).unwrap(),
            r#"{"id":1,"t_ms":6,"type":"mark","screenshot":"marks/a.png","capture":"screen"}"#
        );
    }

    #[test]
    fn reduce_ignores_undo_of_unknown_or_already_cancelled_records() {
        let events = vec![
            Event {
                id: 0,
                t_ms: 0,
                kind: EventKind::SessionStart,
            },
            Event {
                id: 1,
                t_ms: 1,
                kind: rating_kind(Rating::Good),
            },
            Event {
                id: 2,
                t_ms: 2,
                kind: EventKind::Undo { target: 1 },
            },
            Event {
                id: 3,
                t_ms: 3,
                kind: EventKind::Undo { target: 1 },
            },
            Event {
                id: 4,
                t_ms: 4,
                kind: EventKind::Undo { target: 99 },
            },
        ];
        let view = reduce(&events);
        assert!(view.ratings.is_empty());
        assert_eq!(view.next_hand(), 1);
        assert_eq!(view.started_ms, Some(0));
    }

    #[test]
    fn reduce_cannot_undo_a_session_start_or_another_undo() {
        let events = vec![
            Event {
                id: 0,
                t_ms: 0,
                kind: EventKind::SessionStart,
            },
            Event {
                id: 1,
                t_ms: 1,
                kind: rating_kind(Rating::Bad),
            },
            Event {
                id: 2,
                t_ms: 2,
                kind: EventKind::Undo { target: 0 },
            },
            Event {
                id: 3,
                t_ms: 3,
                kind: EventKind::Undo { target: 1 },
            },
            Event {
                id: 4,
                t_ms: 4,
                kind: EventKind::Undo { target: 3 },
            },
        ];
        let view = reduce(&events);
        assert!(view.ratings.is_empty(), "評価の取り消しは有効のまま");
    }

    #[test]
    fn list_sessions_returns_newest_first_with_counts_and_absolute_image_paths() {
        let (_tmp, mut store) = open_store();
        store.add_mark(T0 + 1, shot()).unwrap();
        store.add_rating(T0 + 2, Rating::Good, shot()).unwrap();
        store.add_rating(T0 + 3, Rating::Bad, shot()).unwrap();
        store.undo(T0 + 4).unwrap();
        store.close_session(T0 + 5).unwrap();
        store.add_mark(T0 + 100_001, shot()).unwrap();
        store.add_mark(T0 + 100_002, shot()).unwrap();

        let sessions = store.list_sessions().unwrap();
        assert_eq!(sessions.len(), 2);
        assert_eq!(
            sessions[0].started_ms,
            T0 + 100_001,
            "半荘は最初の記録で始まる"
        );
        assert_eq!(sessions[0].mark_count, 2);
        assert_eq!(sessions[0].rating_count, 0);
        assert_eq!(sessions[1].started_ms, T0 + 1);
        assert_eq!(sessions[1].mark_count, 1);
        assert_eq!(sessions[1].rating_count, 1, "取り消した評価は数えない");
        assert_eq!(sessions[1].ratings[0].entry.hand, 1);
        assert_eq!(
            sessions[1].events.len(),
            6,
            "開始・マーク・評価2件・取り消し・閉じた記録。取り消しも含めて全部の記録を返す"
        );
        let path = sessions[1].marks[0].screenshot_path.as_ref().unwrap();
        assert!(Path::new(path).is_absolute());
        assert!(Path::new(path).is_file());
        let rating_path = sessions[1].ratings[0].screenshot_path.as_ref().unwrap();
        assert!(Path::new(rating_path).is_absolute());
        assert!(Path::new(rating_path).is_file());
        assert!(rating_path.contains(RATINGS_DIR));
    }

    #[test]
    fn list_sessions_skips_folders_without_a_log_and_survives_a_broken_line() {
        let (_tmp, mut store) = open_store();
        store.add_rating(T0, Rating::Good, shot()).unwrap();
        let games = store.root().join(GAMES_DIR);
        fs::create_dir_all(games.join("not-a-session")).unwrap();
        fs::write(games.join("stray.txt"), "x").unwrap();
        // 書きかけの行
        let id = store.current_session_id().unwrap().to_string();
        let mut f = OpenOptions::new()
            .append(true)
            .open(games.join(&id).join(EVENTS_FILE))
            .unwrap();
        f.write_all(b"{\"id\":9,\"t_ms\":").unwrap();
        let sessions = store.list_sessions().unwrap();
        assert_eq!(sessions.len(), 1);
        assert_eq!(sessions[0].rating_count, 1);
    }

    #[test]
    fn list_sessions_of_an_empty_store_is_empty() {
        let (_tmp, store) = open_store();
        assert!(store.list_sessions().unwrap().is_empty());
    }

    // ---- W-14: 空の半荘 ----

    fn session_folders(store: &Store) -> Vec<String> {
        let mut names: Vec<String> = fs::read_dir(store.root().join(GAMES_DIR))
            .unwrap()
            .map(|e| e.unwrap().file_name().to_string_lossy().into_owned())
            .collect();
        names.sort();
        names
    }

    #[test]
    fn w14_a_session_folder_is_created_only_by_its_first_record() {
        let (_tmp, mut store) = open_store();
        assert!(session_folders(&store).is_empty());
        store.close_session(T0).unwrap();
        store.close_session(T0).unwrap();
        assert!(
            session_folders(&store).is_empty(),
            "閉じるだけではフォルダを作らない"
        );
        store.add_mark(T0, shot()).unwrap();
        assert_eq!(session_folders(&store).len(), 1);
    }

    #[test]
    fn w14_closing_a_session_creates_no_folder_and_leaves_no_session_open() {
        let (_tmp, mut store) = open_store();
        store.add_rating(T0, Rating::Good, shot()).unwrap();
        assert_eq!(session_folders(&store).len(), 1);
        store.close_session(T0 + 1).unwrap();
        assert_eq!(
            session_folders(&store).len(),
            1,
            "新しい半荘でフォルダは増えない"
        );
        assert!(store.current_session_id().is_none());
        let view = store.view();
        assert_eq!(view.mark_count(), 0);
        assert_eq!(view.next_hand(), 1);
        assert!(!view.can_undo());
        // 続けて何度閉じても、フォルダは増えない。
        store.close_session(T0 + 2).unwrap();
        store.close_session(T0 + 2).unwrap();
        assert_eq!(session_folders(&store).len(), 1);
    }

    #[test]
    fn w14_the_first_record_after_closing_makes_the_new_folder() {
        let (_tmp, mut store) = open_store();
        store.add_mark(T0, shot()).unwrap();
        let first = store.current_session_id().unwrap().to_string();
        store.close_session(T0 + 1).unwrap();
        store.add_rating(T0 + 5_000, Rating::Fair, shot()).unwrap();
        let second = store.current_session_id().unwrap().to_string();
        assert_ne!(first, second);
        assert_eq!(session_folders(&store).len(), 2);
        // 新しい半荘の数字は、ここから数え直す。
        assert_eq!(store.view().mark_count(), 0);
        assert_eq!(store.view().next_hand(), 2);
    }

    #[test]
    fn w14_a_record_more_than_30_minutes_after_the_previous_one_starts_a_new_session() {
        let (_tmp, mut store) = open_store();
        store.add_mark(T0, shot()).unwrap();
        let first = store.current_session_id().unwrap().to_string();
        // ちょうど 30 分後までは、同じ半荘。
        store
            .add_rating(T0 + SESSION_GAP_MS, Rating::Good, shot())
            .unwrap();
        assert_eq!(store.current_session_id().unwrap(), first);
        // その記録から、さらに 30 分より長くあいたら、新しい半荘。
        store
            .add_mark(T0 + SESSION_GAP_MS + SESSION_GAP_MS + 1, shot())
            .unwrap();
        let second = store.current_session_id().unwrap().to_string();
        assert_ne!(second, first);
        assert_eq!(session_folders(&store).len(), 2);
        assert_eq!(store.view().mark_count(), 1, "新しい半荘の数字は 1 から");
        assert_eq!(store.view().next_hand(), 1);
    }

    #[test]
    fn w14_records_within_30_minutes_of_each_other_stay_in_one_session() {
        let (_tmp, mut store) = open_store();
        // 29 分ごとに 6 回（全体では 2 時間半近く）。毎回、前の記録からは 30 分以内。
        let step = 29 * 60 * 1000;
        for i in 0..6 {
            store.add_mark(T0 + i * step, shot()).unwrap();
        }
        assert_eq!(session_folders(&store).len(), 1);
        assert_eq!(store.view().mark_count(), 6);
    }

    #[test]
    fn w14_the_gap_is_measured_from_the_last_record_not_from_the_start_of_the_session() {
        let (_tmp, mut store) = open_store();
        store.add_mark(T0, shot()).unwrap();
        let id = store.current_session_id().unwrap().to_string();
        store.add_mark(T0 + 20 * 60 * 1000, shot()).unwrap();
        // 開始から 40 分、最後の記録から 20 分: 同じ半荘。
        store.add_mark(T0 + 40 * 60 * 1000, shot()).unwrap();
        assert_eq!(store.current_session_id().unwrap(), id);
    }

    #[test]
    fn w14_the_gap_is_30_minutes() {
        assert_eq!(SESSION_GAP_MS, 1_800_000);
    }

    /// 同じ保存先を、アプリを起動し直したときと同じように開き直す。
    fn reopen(root: &Path, now_ms: i64) -> Store {
        let mut again = Store::open(root).unwrap();
        again.resume_recent(now_ms);
        again
    }

    #[test]
    fn w14_after_a_restart_a_record_within_30_minutes_continues_the_same_session() {
        let (_tmp, mut store) = open_store();
        store.add_mark(T0, shot()).unwrap();
        store.add_rating(T0 + 60_000, Rating::Good, shot()).unwrap();
        let id = store.current_session_id().unwrap().to_string();
        let root = store.root().to_path_buf();
        drop(store);

        let now = T0 + 60_000 + 10 * 60 * 1000;
        let mut store = reopen(&root, now);
        assert_eq!(store.current_session_id(), Some(id.as_str()));
        let view = store.view();
        assert_eq!(view.mark_count(), 1, "ウィジェットの数字も続きから");
        assert_eq!(view.next_hand(), 2);
        store.add_mark(now, shot()).unwrap();
        assert_eq!(store.current_session_id(), Some(id.as_str()));
        let sessions = store.list_sessions().unwrap();
        assert_eq!(sessions.len(), 1);
        assert_eq!(sessions[0].marks.len(), 2);
    }

    #[test]
    fn w14_after_a_restart_a_record_more_than_30_minutes_later_starts_a_new_session() {
        let (_tmp, mut store) = open_store();
        store.add_mark(T0, shot()).unwrap();
        let root = store.root().to_path_buf();
        drop(store);
        let now = T0 + SESSION_GAP_MS + 1;
        let mut store = reopen(&root, now);
        assert_eq!(store.current_session_id(), None, "古い半荘の数字は出さない");
        store.add_mark(now, shot()).unwrap();
        assert_eq!(store.list_sessions().unwrap().len(), 2);
    }

    #[test]
    fn w14_a_session_closed_with_new_hanchan_is_not_continued_after_a_restart() {
        let (_tmp, mut store) = open_store();
        store.add_mark(T0, shot()).unwrap();
        store.close_session(T0 + 1_000).unwrap();
        let root = store.root().to_path_buf();
        drop(store);
        let mut store = reopen(&root, T0 + 2_000);
        assert_eq!(store.current_session_id(), None);
        store.add_mark(T0 + 2_000, shot()).unwrap();
        assert_eq!(store.list_sessions().unwrap().len(), 2);
    }

    #[test]
    fn w14_only_the_most_recent_session_is_continued_and_empty_folders_never_are() {
        let (_tmp, mut store) = open_store();
        // 古い半荘（閉じていない）と、新しい半荘（閉じた）。新しい方を閉じたなら、古い方にも戻らない。
        store.add_mark(T0, shot()).unwrap();
        store.add_mark(T0 + SESSION_GAP_MS + 1, shot()).unwrap();
        store.close_session(T0 + SESSION_GAP_MS + 2).unwrap();
        // 昔の形の空の半荘（開始の行だけ）。いちばん新しくても、続けて記録しない。
        let empty = store.root().join(GAMES_DIR).join("20991231-235959");
        fs::create_dir_all(&empty).unwrap();
        let start = Event {
            id: 0,
            t_ms: T0 + SESSION_GAP_MS + 3,
            kind: EventKind::SessionStart,
        };
        fs::write(
            empty.join(EVENTS_FILE),
            format!("{}\n", serde_json::to_string(&start).unwrap()),
        )
        .unwrap();
        let root = store.root().to_path_buf();
        drop(store);
        let store = reopen(&root, T0 + SESSION_GAP_MS + 4);
        assert_eq!(store.current_session_id(), None);
    }

    #[test]
    fn w14_closing_writes_a_close_record_that_the_lists_and_counts_ignore() {
        let (_tmp, mut store) = open_store();
        store.add_mark(T0, shot()).unwrap();
        let id = store.current_session_id().unwrap().to_string();
        store.close_session(T0 + 5).unwrap();
        let text =
            fs::read_to_string(store.root().join(GAMES_DIR).join(&id).join(EVENTS_FILE)).unwrap();
        let last: Event = serde_json::from_str(text.lines().last().unwrap()).unwrap();
        assert_eq!(last.kind, EventKind::SessionClose);
        assert_eq!(last.t_ms, T0 + 5);
        let sessions = store.list_sessions().unwrap();
        assert_eq!(sessions.len(), 1);
        assert_eq!(sessions[0].marks.len(), 1);
    }

    #[test]
    fn w14_an_undo_does_not_create_a_folder_and_keeps_the_session_alive() {
        let (_tmp, mut store) = open_store();
        store.add_mark(T0, shot()).unwrap();
        store.undo(T0 + 60_000).unwrap();
        assert_eq!(session_folders(&store).len(), 1);
        // 取り消しも「最後の操作」。そこから 30 分以内なら、同じ半荘。
        let id = store.current_session_id().unwrap().to_string();
        store
            .add_mark(T0 + 60_000 + SESSION_GAP_MS, shot())
            .unwrap();
        assert_eq!(store.current_session_id().unwrap(), id);
    }

    #[test]
    fn w14_the_records_list_does_not_show_sessions_without_records_and_keeps_the_old_folders() {
        let (_tmp, mut store) = open_store();
        let games = store.root().join(GAMES_DIR);
        // 昔の版が「新しい半荘」で作った、記録の無い半荘のフォルダ（開始の行だけ）。
        let legacy = games.join("20261009-190000");
        fs::create_dir_all(legacy.join(MARKS_DIR)).unwrap();
        fs::write(
            legacy.join(EVENTS_FILE),
            "{\"id\":0,\"t_ms\":1,\"type\":\"session_start\"}\n",
        )
        .unwrap();
        // 開始の行も無い、空のフォルダ。
        fs::create_dir_all(games.join("20261009-190100").join(MARKS_DIR)).unwrap();
        // 記録を 1 つ付けて、全部取り消した半荘も、記録が無いのと同じ。
        store.add_mark(T0, shot()).unwrap();
        store.undo(T0 + 1).unwrap();
        store.close_session(T0 + 2).unwrap();
        // 記録のある半荘。
        store.add_rating(T0 + 10_000, Rating::Good, shot()).unwrap();

        let sessions = store.list_sessions().unwrap();
        assert_eq!(
            sessions.len(),
            1,
            "{:?}",
            sessions.iter().map(|s| &s.id).collect::<Vec<_>>()
        );
        assert_eq!(sessions[0].rating_count, 1);
        // 一覧に出さないだけで、フォルダは消さない（履歴の削除は、あとの機能）。
        assert!(legacy.join(EVENTS_FILE).is_file());
        assert!(games.join("20261009-190100").is_dir());
        assert_eq!(session_folders(&store).len(), 4);
    }

    // ---- W-13: 評価のスクリーンショット ----

    #[test]
    fn w13_a_rating_saves_a_png_under_ratings_and_stores_its_path() {
        let (_tmp, mut store) = open_store();
        store.add_rating(T0, Rating::Good, shot()).unwrap();
        let events = store.current.as_ref().unwrap().events.clone();
        let EventKind::Rating {
            rating,
            screenshot,
            capture,
            capture_error,
        } = &events.last().unwrap().kind
        else {
            panic!("評価の記録のはず");
        };
        assert_eq!(*rating, Rating::Good);
        assert_eq!(*capture, Some(CaptureTarget::Window));
        assert_eq!(*capture_error, None);
        let relative = screenshot.as_deref().expect("画像のパスが入る");
        assert!(
            relative.starts_with("ratings/") && relative.ends_with(".png"),
            "{relative}"
        );
        assert!(relative.contains(&mark_file_stem(T0)));
        assert_eq!(
            fs::read(session_dir(&store).join(relative)).unwrap(),
            vec![0x89, b'P', b'N', b'G']
        );
        // 迷いマークの画像と混ざらない。
        assert!(!session_dir(&store).join(MARKS_DIR).exists());
        // 取り消されていない評価として、パスが状態にも出る。
        assert_eq!(
            store.view().ratings[0].screenshot.as_deref(),
            Some(relative)
        );
    }

    #[test]
    fn w13_a_rating_whose_capture_failed_is_still_recorded_with_the_reason() {
        let (_tmp, mut store) = open_store();
        store
            .add_rating(
                T0,
                Rating::Bad,
                Err(CaptureError("画面を撮れませんでした".into())),
            )
            .unwrap();
        let view = store.view();
        assert_eq!(view.ratings.len(), 1);
        assert_eq!(view.ratings[0].screenshot, None);
        assert_eq!(
            view.ratings[0].capture_error.as_deref(),
            Some("画面を撮れませんでした")
        );
        assert!(!session_dir(&store).join(RATINGS_DIR).exists());
    }

    #[test]
    fn w13_two_ratings_in_the_same_millisecond_get_distinct_files() {
        let (_tmp, mut store) = open_store();
        store.add_rating(T0, Rating::Good, shot()).unwrap();
        store.add_rating(T0, Rating::Fair, shot()).unwrap();
        let view = store.view();
        assert_ne!(view.ratings[0].screenshot, view.ratings[1].screenshot);
        assert_eq!(
            fs::read_dir(session_dir(&store).join(RATINGS_DIR))
                .unwrap()
                .count(),
            2
        );
    }

    #[test]
    fn w13_ratings_written_before_screenshots_existed_still_load() {
        let events = [
            r#"{"id":0,"t_ms":1,"type":"session_start"}"#,
            r#"{"id":1,"t_ms":2,"type":"rating","rating":"good"}"#,
        ]
        .map(|l| serde_json::from_str::<Event>(l).unwrap());
        let view = reduce(&events);
        assert_eq!(view.ratings.len(), 1);
        assert_eq!(view.ratings[0].screenshot, None);
        assert_eq!(view.ratings[0].capture_error, None);
    }

    #[test]
    fn w13_a_rating_event_with_a_screenshot_has_a_stable_json_shape() {
        let rating = Event {
            id: 2,
            t_ms: 7,
            kind: EventKind::Rating {
                rating: Rating::Fair,
                screenshot: Some("ratings/a.png".into()),
                capture: Some(CaptureTarget::Window),
                capture_error: None,
            },
        };
        assert_eq!(
            serde_json::to_string(&rating).unwrap(),
            r#"{"id":2,"t_ms":7,"type":"rating","rating":"fair","screenshot":"ratings/a.png","capture":"window"}"#
        );
    }

    // ---- 取り込み（F1・F9・F11）の保存: report.json・ocr.json・links.json ----

    const REPORT_TEXT: &str = r#"{"review":{"kyokus":[]},"note":"結果の見本"}"#;

    /// 迷いマーク 2 件と評価 1 件のある半荘を作って、その名前を返す（記録の id: 開始 0・迷い 1・迷い 2・評価 3）。
    fn session_with_records(store: &mut Store) -> String {
        store.add_mark(T0, shot()).unwrap();
        store.add_mark(T0 + 1, shot()).unwrap();
        store.add_rating(T0 + 2, Rating::Good, shot()).unwrap();
        store.current_session_id().unwrap().to_string()
    }

    fn only_session(store: &Store) -> SessionRecord {
        let mut sessions = store.list_sessions().unwrap();
        assert_eq!(sessions.len(), 1);
        sessions.remove(0)
    }

    #[test]
    fn the_report_is_saved_raw_in_the_matched_session_folder_and_listed() {
        let (_tmp, mut store) = open_store();
        let id = session_with_records(&mut store);
        assert_eq!(only_session(&store).report_path, None);

        let saved = store.save_report(Some(&id), REPORT_TEXT, T0 + 99).unwrap();
        assert_eq!(saved, id);
        let path = store.root().join(GAMES_DIR).join(&id).join(REPORT_FILE);
        assert_eq!(fs::read_to_string(&path).unwrap(), REPORT_TEXT, "生のまま");
        assert_eq!(
            store.read_report(&id).unwrap().as_deref(),
            Some(REPORT_TEXT)
        );
        let session = only_session(&store);
        assert_eq!(
            session.report_path.as_deref(),
            Some(path.to_string_lossy().as_ref())
        );
        assert_eq!(session.mark_count, 2, "迷いマークはそのまま");
        // 一時ファイルは残らない。
        assert!(!path.with_file_name("report.json.tmp").exists());
        // 記録中の半荘は、取り込みで動かない。
        assert_eq!(store.current_session_id(), Some(id.as_str()));
    }

    #[test]
    fn a_session_that_already_has_a_report_is_not_overwritten() {
        let (_tmp, mut store) = open_store();
        let id = session_with_records(&mut store);
        store.save_report(Some(&id), REPORT_TEXT, T0).unwrap();
        let err = store
            .save_report(Some(&id), r#"{"other":true}"#, T0 + 1)
            .unwrap_err();
        assert!(matches!(err, StoreError::ReportExists(_)), "{err}");
        assert_eq!(
            store.read_report(&id).unwrap().as_deref(),
            Some(REPORT_TEXT)
        );
    }

    #[test]
    fn a_report_without_a_recorded_session_makes_a_new_session_that_the_list_shows() {
        let (_tmp, mut store) = open_store();
        let recording = session_with_records(&mut store);
        let imported = store.save_report(None, REPORT_TEXT, T0 + 500_000).unwrap();
        assert_ne!(imported, recording);

        // 新しい半荘のフォルダ: 開始の記録 1 行と、結果だけ。
        let dir = store.root().join(GAMES_DIR).join(&imported);
        let lines: Vec<String> = fs::read_to_string(dir.join(EVENTS_FILE))
            .unwrap()
            .lines()
            .map(str::to_string)
            .collect();
        assert_eq!(lines.len(), 1);
        let start: Event = serde_json::from_str(&lines[0]).unwrap();
        assert_eq!(start.kind, EventKind::SessionStart);
        assert_eq!(start.t_ms, T0 + 500_000);
        assert_eq!(
            fs::read_to_string(dir.join(REPORT_FILE)).unwrap(),
            REPORT_TEXT
        );
        assert!(!dir.join(MARKS_DIR).exists());

        // 一覧には、記録の無い半荘も出る（新しい順）。迷いも評価も 0。
        let sessions = store.list_sessions().unwrap();
        assert_eq!(sessions.len(), 2);
        assert_eq!(sessions[0].id, imported);
        assert_eq!(sessions[0].started_ms, T0 + 500_000);
        assert_eq!((sessions[0].mark_count, sessions[0].rating_count), (0, 0));
        assert!(sessions[0].report_path.is_some());
        assert_eq!(sessions[1].id, recording);
        // 記録中の半荘には、触れていない。
        assert_eq!(store.current_session_id(), Some(recording.as_str()));
    }

    #[test]
    fn two_imports_in_the_same_second_get_different_folders() {
        let (_tmp, mut store) = open_store();
        let a = store.save_report(None, REPORT_TEXT, T0).unwrap();
        let b = store.save_report(None, REPORT_TEXT, T0).unwrap();
        assert_ne!(a, b);
        assert_eq!(store.list_sessions().unwrap().len(), 2);
    }

    #[test]
    fn a_report_that_is_not_json_writes_nothing_and_creates_no_folder() {
        let (_tmp, mut store) = open_store();
        for bad in ["", "<html>error</html>", "{\"a\":", "not json"] {
            let err = store.save_report(None, bad, T0).unwrap_err();
            assert!(
                matches!(err, StoreError::InvalidReport(_)),
                "{bad:?}: {err}"
            );
        }
        assert!(session_folders(&store).is_empty());
        let id = session_with_records(&mut store);
        let err = store.save_report(Some(&id), "oops", T0).unwrap_err();
        assert!(matches!(err, StoreError::InvalidReport(_)));
        assert_eq!(store.read_report(&id).unwrap(), None);
    }

    #[test]
    fn a_session_name_that_is_not_a_plain_folder_name_is_refused() {
        let (_tmp, mut store) = open_store();
        for bad in ["", "..", "../x", "a/b", "a\\b", "x y", "あ", "C:\\x"] {
            let err = store.save_report(Some(bad), REPORT_TEXT, T0).unwrap_err();
            assert!(
                matches!(err, StoreError::UnknownSession(_)),
                "{bad:?}: {err}"
            );
            assert!(store.read_report(bad).is_err(), "{bad:?}");
            assert!(store.set_mark_link(bad, 1, "x").is_err(), "{bad:?}");
        }
        // 形は正しくても、フォルダが無ければ断る。
        let err = store
            .save_report(Some("20991231-235959"), REPORT_TEXT, T0)
            .unwrap_err();
        assert!(matches!(err, StoreError::UnknownSession(_)));
        assert!(!store
            .root()
            .join(GAMES_DIR)
            .join("20991231-235959")
            .exists());
    }

    #[test]
    fn a_report_only_folder_without_events_is_listed_by_the_time_in_its_name() {
        let (_tmp, store) = open_store();
        let dir = store.root().join(GAMES_DIR).join("20261009-190953");
        fs::create_dir_all(&dir).unwrap();
        fs::write(dir.join(REPORT_FILE), REPORT_TEXT).unwrap();
        let sessions = store.list_sessions().unwrap();
        assert_eq!(sessions.len(), 1);
        assert_eq!(
            sessions[0].started_ms,
            started_ms_from_folder_name("20261009-190953").unwrap()
        );
        assert_eq!(
            local_time(sessions[0].started_ms)
                .format("%Y%m%d-%H%M%S")
                .to_string(),
            "20261009-190953"
        );
    }

    #[test]
    fn an_imported_only_session_is_never_continued_after_a_restart() {
        let (_tmp, mut store) = open_store();
        store.save_report(None, REPORT_TEXT, T0).unwrap();
        let root = store.root().to_path_buf();
        drop(store);
        let store = reopen(&root, T0 + 1_000);
        assert_eq!(store.current_session_id(), None);
    }

    #[test]
    fn screenshots_of_lists_the_active_marks_and_ratings_images_with_both_paths() {
        let (_tmp, mut store) = open_store();
        store.add_mark(T0, shot()).unwrap(); // id 1
        store.add_mark(T0 + 1, shot()).unwrap(); // id 2（取り消す）
        store.undo(T0 + 2).unwrap();
        store
            .add_mark(T0 + 3, Err(CaptureError("撮れない".into())))
            .unwrap(); // 画像なし
        store.add_rating(T0 + 4, Rating::Fair, shot()).unwrap();
        let id = store.current_session_id().unwrap().to_string();
        let shots = store.screenshots_of(&id).unwrap();
        assert_eq!(shots.len(), 2, "{shots:?}");
        assert!(shots[0].0.starts_with("marks/") && shots[1].0.starts_with("ratings/"));
        for (relative, absolute) in &shots {
            assert_eq!(
                absolute,
                &store.root().join(GAMES_DIR).join(&id).join(relative)
            );
            assert!(absolute.is_file());
        }
    }

    #[test]
    fn the_ocr_cache_is_saved_per_session_and_comes_back_in_the_list() {
        let (_tmp, mut store) = open_store();
        let id = session_with_records(&mut store);
        assert_eq!(store.load_ocr(&id).unwrap(), None);
        let mut cache = OcrCache {
            geometry: "center-v1-lanczos3x".into(),
            entries: BTreeMap::new(),
        };
        cache.entries.insert(
            "marks/a.png".into(),
            OcrEntry {
                lines: vec!["東 1 局".into(), "个 5 9".into(), "25000".into()],
                error: None,
            },
        );
        cache.entries.insert(
            "marks/b.png".into(),
            OcrEntry {
                lines: vec![],
                error: Some("画像を開けませんでした".into()),
            },
        );
        store.save_ocr(&id, &cache).unwrap();
        assert_eq!(store.load_ocr(&id).unwrap(), Some(cache.clone()));
        assert_eq!(only_session(&store).ocr, Some(cache));
        // 写しはファイルとして半荘のフォルダにあり、一時ファイルは残らない。
        let dir = store.root().join(GAMES_DIR).join(&id);
        assert!(dir.join(OCR_FILE).is_file());
        assert!(!dir.join("ocr.json.tmp").exists());
    }

    #[test]
    fn a_broken_ocr_or_links_file_does_not_stop_the_list() {
        let (_tmp, mut store) = open_store();
        let id = session_with_records(&mut store);
        let dir = store.root().join(GAMES_DIR).join(&id);
        fs::write(dir.join(OCR_FILE), "{broken").unwrap();
        fs::write(dir.join(LINKS_FILE), "[]").unwrap();
        let session = only_session(&store);
        assert_eq!(session.ocr, None);
        assert_eq!(session.links, Links::default());
        assert_eq!(store.load_links(&id).unwrap(), Links::default());
    }

    #[test]
    fn mark_links_can_be_set_chosen_again_and_cleared() {
        let (_tmp, mut store) = open_store();
        let id = session_with_records(&mut store);
        assert_eq!(store.load_links(&id).unwrap(), Links::default());

        store.set_mark_link(&id, 1, "k2:d7").unwrap();
        store.set_mark_link(&id, 2, LINK_MANUAL).unwrap();
        let links = store.load_links(&id).unwrap();
        assert_eq!(links.marks.get("1").map(String::as_str), Some("k2:d7"));
        assert_eq!(links.marks.get("2").map(String::as_str), Some("manual"));

        // 選び直し: 同じ迷いマークに別の判断を入れると、置き換わる。
        store.set_mark_link(&id, 1, "k2:d9").unwrap();
        assert_eq!(
            store
                .load_links(&id)
                .unwrap()
                .marks
                .get("1")
                .map(String::as_str),
            Some("k2:d9")
        );
        // 消すと、「まだ決めていない」に戻る。ほかの結びつけは残る。
        store.clear_mark_link(&id, 1).unwrap();
        let links = store.load_links(&id).unwrap();
        assert!(!links.marks.contains_key("1"));
        assert!(links.marks.contains_key("2"));
        // 無い結びつけを消してもエラーにならない。
        store.clear_mark_link(&id, 1).unwrap();
        // 一覧にも出る。
        assert_eq!(only_session(&store).links, links);
    }

    #[test]
    fn rating_links_allow_an_empty_kyoku_meaning_no_hand() {
        let (_tmp, mut store) = open_store();
        let id = session_with_records(&mut store);
        store.set_rating_link(&id, 3, "k4").unwrap();
        assert_eq!(
            store
                .load_links(&id)
                .unwrap()
                .ratings
                .get("3")
                .map(String::as_str),
            Some("k4")
        );
        store.set_rating_link(&id, 3, "").unwrap();
        assert_eq!(
            store
                .load_links(&id)
                .unwrap()
                .ratings
                .get("3")
                .map(String::as_str),
            Some(""),
            "空は「どの局にも結びつけない」という選び。消した状態（決めていない）とは別"
        );
        store.clear_rating_link(&id, 3).unwrap();
        assert!(store.load_links(&id).unwrap().ratings.is_empty());
    }

    #[test]
    fn links_to_records_that_are_not_active_in_the_session_are_refused() {
        let (_tmp, mut store) = open_store();
        let id = session_with_records(&mut store); // 迷い 1・2、評価 3
                                                   // 存在しない番号。迷いマークの番号を評価に使うのも断る。
        for (kind, result) in [
            ("迷い 99", store.set_mark_link(&id, 99, "x")),
            ("評価の番号 1", store.set_rating_link(&id, 1, "x")),
            ("迷いの番号 3", store.set_mark_link(&id, 3, "x")),
            ("開始の記録 0", store.set_mark_link(&id, 0, "x")),
        ] {
            let err = result.unwrap_err();
            assert!(
                matches!(err, StoreError::UnknownRecord { .. }),
                "{kind}: {err}"
            );
        }
        // 取り消した迷いマークにも結びつけない。
        store.undo(T0 + 10).unwrap(); // いちばん後ろの記録 = 評価 3
        store.undo(T0 + 11).unwrap(); // 迷い 2
        assert!(store.set_mark_link(&id, 2, "x").is_err());
        assert!(store.set_rating_link(&id, 3, "x").is_err());
        assert!(store.set_mark_link(&id, 1, "x").is_ok());
        assert!(!store
            .root()
            .join(GAMES_DIR)
            .join(&id)
            .join("links.json.tmp")
            .exists());
    }

    #[test]
    fn link_values_must_be_short_visible_ascii_and_a_mark_value_cannot_be_empty() {
        let (_tmp, mut store) = open_store();
        let id = session_with_records(&mut store);
        for bad in ["", "has space", "改行\n", &"x".repeat(65), "tab\t"] {
            assert!(
                matches!(
                    store.set_mark_link(&id, 1, bad),
                    Err(StoreError::InvalidLink(_))
                ),
                "{bad:?}"
            );
        }
        assert!(store.set_mark_link(&id, 1, &"x".repeat(64)).is_ok());
        assert!(matches!(
            store.set_rating_link(&id, 3, "has space"),
            Err(StoreError::InvalidLink(_))
        ));
        // 値が悪いとき、ファイルは書き換わらない。
        assert_eq!(store.load_links(&id).unwrap().marks.len(), 1);
    }

    #[test]
    fn replace_links_writes_everything_at_once_and_checks_every_entry_first() {
        let (_tmp, mut store) = open_store();
        let id = session_with_records(&mut store);
        let mut links = Links::default();
        links.marks.insert("1".into(), "a".into());
        links.marks.insert("2".into(), LINK_MANUAL.into());
        links.ratings.insert("3".into(), "k1".into());
        store.replace_links(&id, links.clone()).unwrap();
        assert_eq!(store.load_links(&id).unwrap(), links);

        // 1 つでも正しくなければ、何も書き換えない。
        let mut bad = links.clone();
        bad.marks.insert("1".into(), "changed".into());
        bad.marks.insert("77".into(), "x".into());
        assert!(matches!(
            store.replace_links(&id, bad),
            Err(StoreError::UnknownRecord { .. })
        ));
        assert_eq!(store.load_links(&id).unwrap(), links);
        let mut bad = links.clone();
        bad.ratings.insert("3".into(), "bad value".into());
        assert!(matches!(
            store.replace_links(&id, bad),
            Err(StoreError::InvalidLink(_))
        ));
        // 空の結びつけで、まるごと置き換えると、消える。
        store.replace_links(&id, Links::default()).unwrap();
        assert_eq!(store.load_links(&id).unwrap(), Links::default());
    }

    #[test]
    fn the_links_file_has_a_stable_json_shape() {
        let (_tmp, mut store) = open_store();
        let id = session_with_records(&mut store);
        store.set_mark_link(&id, 1, "k0:d3").unwrap();
        store.set_rating_link(&id, 3, "").unwrap();
        let text =
            fs::read_to_string(store.root().join(GAMES_DIR).join(&id).join(LINKS_FILE)).unwrap();
        let value: serde_json::Value = serde_json::from_str(&text).unwrap();
        assert_eq!(
            value,
            serde_json::json!({"marks": {"1": "k0:d3"}, "ratings": {"3": ""}})
        );
    }

    #[test]
    fn import_files_do_not_change_what_the_recording_sees() {
        // 結果・文字認識・結びつけを書いても、記録（events.jsonl）は 1 行も増えず、ウィジェットの数字も変わらない。
        let (_tmp, mut store) = open_store();
        let id = session_with_records(&mut store);
        let before = event_lines(&store);
        let view_before = store.view();
        store.save_report(Some(&id), REPORT_TEXT, T0).unwrap();
        store.save_ocr(&id, &OcrCache::default()).unwrap();
        store.set_mark_link(&id, 1, "k0:d0").unwrap();
        assert_eq!(event_lines(&store), before);
        assert_eq!(store.view(), view_before);
        // 記録の続きも、これまでどおり同じ半荘に入る。
        store.add_mark(T0 + 5, shot()).unwrap();
        assert_eq!(store.current_session_id(), Some(id.as_str()));
    }

    // ---- U-9: 半荘の削除（trash/ へ移す）と、元に戻す ----

    /// 30 分より離して 2 つの半荘を作る。（古いほう、新しいほう）の名前を返す。
    fn two_sessions(store: &mut Store) -> (String, String) {
        store.add_mark(T0, shot()).unwrap();
        let older = store.current_session_id().unwrap().to_string();
        store.close_session(T0 + 1).unwrap();
        store.add_mark(T0 + SESSION_GAP_MS * 2, shot()).unwrap();
        let newer = store.current_session_id().unwrap().to_string();
        (older, newer)
    }

    fn ids_in_list(store: &Store) -> Vec<String> {
        store
            .list_sessions()
            .unwrap()
            .into_iter()
            .map(|s| s.id)
            .collect()
    }

    fn games(store: &Store) -> PathBuf {
        store.root().join(GAMES_DIR)
    }

    fn trash(store: &Store) -> PathBuf {
        store.root().join(TRASH_DIR)
    }

    #[test]
    fn u9_deleting_moves_the_whole_session_folder_into_trash_and_the_list_no_longer_shows_it() {
        let (_tmp, mut store) = open_store();
        let (older, newer) = two_sessions(&mut store);
        store
            .add_rating(T0 + SESSION_GAP_MS * 2 + 5, Rating::Good, shot())
            .unwrap();
        assert_eq!(ids_in_list(&store), vec![newer.clone(), older.clone()]);

        store.delete_sessions(std::slice::from_ref(&older)).unwrap();

        assert!(!games(&store).join(&older).exists(), "元の場所からは消える");
        let moved = trash(&store).join(&older);
        assert!(moved.join(EVENTS_FILE).is_file(), "記録ごと移る");
        assert!(moved.join(MARKS_DIR).is_dir(), "画像ごと移る");
        assert_eq!(fs::read_dir(moved.join(MARKS_DIR)).unwrap().count(), 1);
        assert_eq!(ids_in_list(&store), vec![newer.clone()], "一覧に出ない");
        assert!(
            games(&store).join(&newer).is_dir(),
            "ほかの半荘は、そのまま"
        );
    }

    #[test]
    fn u9_a_deleted_session_is_not_continued_after_a_restart_either() {
        let (tmp, mut store) = open_store();
        store.add_mark(T0, shot()).unwrap();
        let id = store.current_session_id().unwrap().to_string();
        store.delete_sessions(std::slice::from_ref(&id)).unwrap();
        let mut again = Store::open(tmp.path().join("data")).unwrap();
        again.resume_recent(T0 + 60_000);
        assert_eq!(
            again.current_session_id(),
            None,
            "置き場の中の半荘に、続けて記録しない"
        );
        assert!(again.list_sessions().unwrap().is_empty());
    }

    #[test]
    fn u9_deleting_the_session_being_recorded_closes_it_and_never_appends_into_the_moved_folder() {
        let (_tmp, mut store) = open_store();
        store.add_mark(T0, shot()).unwrap();
        let id = store.current_session_id().unwrap().to_string();
        let moved_events = trash(&store).join(&id).join(EVENTS_FILE);
        let lines_before = event_lines(&store).len();

        store.delete_sessions(std::slice::from_ref(&id)).unwrap();
        assert_eq!(store.current_session_id(), None, "記録中の半荘は閉じる");
        assert_eq!(store.view(), SessionView::default());

        // 30 分以内の次の記録でも、新しい半荘（新しいフォルダ）になる。移したフォルダには、1 行も増えない。
        store.add_mark(T0 + 1_000, shot()).unwrap();
        let fresh = store.current_session_id().unwrap().to_string();
        assert_ne!(fresh, id);
        assert!(games(&store).join(&fresh).is_dir());
        assert_eq!(
            fs::read_to_string(&moved_events).unwrap().lines().count(),
            lines_before
        );
        assert_eq!(ids_in_list(&store), vec![fresh]);
    }

    #[test]
    fn u9_deleting_another_session_does_not_close_the_one_being_recorded() {
        let (_tmp, mut store) = open_store();
        let (older, newer) = two_sessions(&mut store);
        store.delete_sessions(std::slice::from_ref(&older)).unwrap();
        assert_eq!(store.current_session_id(), Some(newer.as_str()));
        store
            .add_mark(T0 + SESSION_GAP_MS * 2 + 10, shot())
            .unwrap();
        assert_eq!(store.current_session_id(), Some(newer.as_str()));
    }

    #[test]
    fn u9_restoring_puts_the_folder_back_where_it_was_and_removes_the_empty_trash() {
        let (_tmp, mut store) = open_store();
        let (older, newer) = two_sessions(&mut store);
        let before = fs::read_to_string(games(&store).join(&older).join(EVENTS_FILE)).unwrap();

        store
            .delete_sessions(&[older.clone(), newer.clone()])
            .unwrap();
        assert!(ids_in_list(&store).is_empty());
        assert_eq!(store.current_session_id(), None);
        store
            .restore_sessions(&[older.clone(), newer.clone()])
            .unwrap();

        assert_eq!(
            ids_in_list(&store),
            vec![newer.clone(), older.clone()],
            "元の位置（新しい順）に戻る"
        );
        assert_eq!(
            fs::read_to_string(games(&store).join(&older).join(EVENTS_FILE)).unwrap(),
            before,
            "中身は、そのまま"
        );
        assert!(!trash(&store).exists(), "空になった置き場は片づける");
        // 戻しても、記録中にはならない（次の記録は、新しい半荘）。
        assert_eq!(store.current_session_id(), None);
    }

    #[test]
    fn u9_a_session_can_be_deleted_restored_and_deleted_again() {
        let (_tmp, mut store) = open_store();
        let (older, _newer) = two_sessions(&mut store);
        for _ in 0..3 {
            store.delete_sessions(std::slice::from_ref(&older)).unwrap();
            assert!(trash(&store).join(&older).is_dir());
            store
                .restore_sessions(std::slice::from_ref(&older))
                .unwrap();
            assert!(games(&store).join(&older).is_dir());
        }
    }

    #[test]
    fn u9_deleting_checks_everything_first_so_a_bad_name_moves_nothing() {
        let (_tmp, mut store) = open_store();
        let (older, newer) = two_sessions(&mut store);
        for bad in ["..", "../x", "a/b", "", "no-such-session", "nul\0"] {
            let err = store
                .delete_sessions(&[older.clone(), bad.to_string()])
                .unwrap_err();
            assert!(matches!(err, StoreError::UnknownSession(_)), "{bad}: {err}");
        }
        assert!(
            games(&store).join(&older).is_dir(),
            "ほかの名前が正しくても、何も移さない"
        );
        assert!(!trash(&store).exists());
        assert_eq!(store.current_session_id(), Some(newer.as_str()));
        // 重なった名前は、1 つとして扱う。
        store
            .delete_sessions(&[older.clone(), older.clone()])
            .unwrap();
        assert_eq!(ids_in_list(&store), vec![newer]);
    }

    #[test]
    fn u9_an_occupied_trash_name_refuses_the_whole_deletion() {
        let (_tmp, mut store) = open_store();
        let (older, newer) = two_sessions(&mut store);
        fs::create_dir_all(trash(&store).join(&older)).unwrap();
        let err = store
            .delete_sessions(&[newer.clone(), older.clone()])
            .unwrap_err();
        assert!(
            matches!(err, StoreError::TrashOccupied(ref id) if *id == older),
            "{err}"
        );
        assert!(err.to_string().contains("アプリを開き直すと片づきます"));
        assert!(games(&store).join(&newer).is_dir(), "newer も移していない");
        assert_eq!(
            store.current_session_id(),
            Some(newer.as_str()),
            "記録中の半荘も閉じない"
        );
    }

    #[test]
    fn u9_restoring_refuses_when_the_name_is_not_in_trash_or_the_place_is_taken() {
        let (_tmp, mut store) = open_store();
        let (older, newer) = two_sessions(&mut store);
        store.delete_sessions(std::slice::from_ref(&older)).unwrap();
        assert!(matches!(
            store.restore_sessions(&[older.clone(), newer.clone()]),
            Err(StoreError::NotInTrash(ref id)) if *id == newer
        ));
        assert!(trash(&store).join(&older).is_dir(), "どれも戻していない");
        assert!(matches!(
            store.restore_sessions(&["../x".to_string()]),
            Err(StoreError::UnknownSession(_))
        ));
        // 元の場所に、同じ名前の半荘ができていたら、戻さない。
        fs::create_dir_all(games(&store).join(&older)).unwrap();
        assert!(matches!(
            store.restore_sessions(std::slice::from_ref(&older)),
            Err(StoreError::RestoreBlocked(ref id)) if *id == older
        ));
        assert!(trash(&store).join(&older).is_dir());
    }

    #[test]
    fn u9_a_failing_move_puts_back_what_was_already_moved() {
        let tmp = tempfile::tempdir().unwrap();
        let moves: Vec<(String, PathBuf, PathBuf)> = ["a", "b", "c"]
            .iter()
            .map(|n| {
                (
                    n.to_string(),
                    tmp.path().join("from").join(n),
                    tmp.path().join("to").join(n),
                )
            })
            .collect();
        for (_, from, _) in &moves {
            fs::create_dir_all(from).unwrap();
        }
        fs::create_dir_all(tmp.path().join("to")).unwrap();
        // 2 つ目の移しで失敗する移し方。
        let mut calls = 0;
        let mut mover = |from: &Path, to: &Path| -> io::Result<()> {
            calls += 1;
            if calls == 2 {
                return Err(io::Error::other("開いているファイルがあります"));
            }
            fs::rename(from, to)
        };
        let err = move_all(&moves, &mut mover).unwrap_err();
        assert!(
            matches!(err, StoreError::Move { ref id, .. } if id == "b"),
            "{err}"
        );
        assert!(err.to_string().contains("開いているファイル"));
        for (_, from, to) in &moves {
            assert!(from.is_dir(), "{} は元の場所に戻っている", from.display());
            assert!(!to.exists());
        }
    }

    #[test]
    fn u9_trash_never_appears_in_the_list_even_when_it_holds_a_valid_looking_session() {
        let (_tmp, mut store) = open_store();
        let (older, _newer) = two_sessions(&mut store);
        store.delete_sessions(std::slice::from_ref(&older)).unwrap();
        // 置き場の中の半荘は、フォルダの名前も記録も正しい。それでも一覧には出ない。
        assert!(trash(&store).join(&older).join(EVENTS_FILE).is_file());
        assert!(!ids_in_list(&store).contains(&older));
        assert!(
            store.read_report(&older).is_err(),
            "取り込みの操作も、消した半荘には届かない"
        );
    }
}
