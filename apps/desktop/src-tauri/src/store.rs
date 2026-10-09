//! 半荘の記録の保存と、記録から導く現在の状態。
//!
//! 半荘ごとに `games/<開始時刻 YYYYMMDD-HHMMSS（ローカル時刻）>/` のフォルダを作り、
//! その中の `events.jsonl` に 1 行 1 件で追記する（書き換えない）。
//! 迷いマークのスクリーンショットは `marks/<時刻>.png`。
//!
//! 取り消しも「取り消した記録を指す記録」を追記するだけで、行は消さない（W-3）。
//! 現在の状態（迷いマークの数・評価の並び・次の局番号）は、記録を頭から読み直す `reduce` で導く。
//!
//! 保存先は Git のリポジトリの外に限る（D-1）。

use std::ffi::OsString;
use std::fmt;
use std::fs::{self, OpenOptions};
use std::io::{self, Write};
use std::path::{Path, PathBuf};

use chrono::{DateTime, Local, TimeZone};
use serde::{Deserialize, Serialize};

use crate::capture::{CaptureError, CaptureTarget, Screenshot};

/// 半荘のフォルダを入れるフォルダ名。
pub const GAMES_DIR: &str = "games";
/// 迷いマークの画像を入れるフォルダ名（半荘のフォルダの中）。
pub const MARKS_DIR: &str = "marks";
/// 記録のファイル名（半荘のフォルダの中）。
pub const EVENTS_FILE: &str = "events.jsonl";

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
    /// 局の評価。
    Rating { rating: Rating },
    /// 取り消し。`target` は取り消した記録の `id`。
    Undo { target: u64 },
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
        Rating(Rating),
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
            EventKind::Rating { rating } => records.push(Active {
                id: event.id,
                t_ms: event.t_ms,
                kind: ActiveKind::Rating(*rating),
                cancelled: false,
            }),
            EventKind::Undo { target } => {
                if let Some(record) = records.iter_mut().find(|r| r.id == *target && !r.cancelled) {
                    record.cancelled = true;
                }
            }
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
            ActiveKind::Rating(rating) => {
                let hand = view.ratings.len() + 1;
                view.ratings.push(RatingEntry {
                    id: record.id,
                    t_ms: record.t_ms,
                    rating,
                    hand,
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

/// 半荘 1 つ分の一覧用の情報。
#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
pub struct SessionRecord {
    pub id: String,
    pub started_ms: i64,
    pub mark_count: usize,
    pub rating_count: usize,
    pub marks: Vec<MarkRecord>,
    pub ratings: Vec<RatingEntry>,
    pub events: Vec<Event>,
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
        Ok(())
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

    /// 新しい半荘を始める（W-6）。前の半荘は閉じ、以後の記録は新しいフォルダに入る。
    pub fn start_session(&mut self, t_ms: i64) -> Result<String, StoreError> {
        let games = self.root.join(GAMES_DIR);
        fs::create_dir_all(&games)?;
        let base = session_folder_base(t_ms);
        // 同じ秒に 2 回始めても別のフォルダになるよう、空いている名前を探す。
        let mut suffix = 1u32;
        let (id, dir) = loop {
            let id = if suffix == 1 {
                base.clone()
            } else {
                format!("{base}-{suffix}")
            };
            let dir = games.join(&id);
            match fs::create_dir(&dir) {
                Ok(()) => break (id, dir),
                Err(e) if e.kind() == io::ErrorKind::AlreadyExists => suffix += 1,
                Err(e) => return Err(e.into()),
            }
        };
        fs::create_dir(dir.join(MARKS_DIR))?;
        let mut current = Current {
            id: id.clone(),
            dir,
            events: Vec::new(),
        };
        current.append(t_ms, EventKind::SessionStart)?;
        self.current = Some(current);
        Ok(id)
    }

    /// 半荘が無ければ始める（W-6: 半荘が無いときの最初の記録は、新しい半荘を自動で始める）。
    pub fn ensure_session(&mut self, t_ms: i64) -> Result<(), StoreError> {
        if self.current.is_none() {
            self.start_session(t_ms)?;
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
        let kind = match capture {
            Ok(shot) => match save_mark_image(&current.dir, t_ms, &shot.png) {
                Ok(relative) => EventKind::Mark {
                    screenshot: Some(relative),
                    capture: Some(shot.target),
                    capture_error: None,
                },
                Err(e) => EventKind::Mark {
                    screenshot: None,
                    capture: None,
                    capture_error: Some(format!("画像を保存できませんでした: {e}")),
                },
            },
            Err(e) => EventKind::Mark {
                screenshot: None,
                capture: None,
                capture_error: Some(e.to_string()),
            },
        };
        current.append(t_ms, kind)
    }

    /// 局の評価を記録する。
    pub fn add_rating(&mut self, t_ms: i64, rating: Rating) -> Result<(), StoreError> {
        self.ensure_session(t_ms)?;
        let current = self.current.as_mut().expect("半荘は開始済み");
        current.append(t_ms, EventKind::Rating { rating })
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

    /// 保存先にある半荘を、新しい順に返す。
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
            let Some(events) = read_events(&dir.join(EVENTS_FILE))? else {
                continue;
            };
            let Some(first) = events.first() else {
                continue;
            };
            let view = reduce(&events);
            let started_ms = view.started_ms.unwrap_or(first.t_ms);
            let marks = view
                .marks
                .iter()
                .map(|entry| MarkRecord {
                    entry: entry.clone(),
                    screenshot_path: entry
                        .screenshot
                        .as_ref()
                        .map(|rel| dir.join(rel).to_string_lossy().into_owned()),
                })
                .collect();
            sessions.push(SessionRecord {
                id: entry.file_name().to_string_lossy().into_owned(),
                started_ms,
                mark_count: view.marks.len(),
                rating_count: view.ratings.len(),
                marks,
                ratings: view.ratings,
                events,
            });
        }
        sessions.sort_by(|a, b| {
            b.started_ms
                .cmp(&a.started_ms)
                .then_with(|| b.id.cmp(&a.id))
        });
        Ok(sessions)
    }
}

/// 画像を `marks/` に新しいファイルとして保存し、半荘のフォルダからの相対パスを返す。
fn save_mark_image(session_dir: &Path, t_ms: i64, png: &[u8]) -> io::Result<String> {
    let marks = session_dir.join(MARKS_DIR);
    fs::create_dir_all(&marks)?;
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
            .open(marks.join(&name))
        {
            Ok(mut file) => {
                file.write_all(png)?;
                file.sync_data()?;
                return Ok(format!("{MARKS_DIR}/{name}"));
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
    fn w6_new_session_creates_a_folder_and_later_records_go_there() {
        let (_tmp, mut store) = open_store();
        let first = store.start_session(T0).unwrap();
        store.add_rating(T0 + 10, Rating::Good).unwrap();
        let second = store.start_session(T0 + 5_000).unwrap();
        assert_ne!(first, second);
        store.add_rating(T0 + 6_000, Rating::Bad).unwrap();

        let games = store.root().join(GAMES_DIR);
        let first_lines = fs::read_to_string(games.join(&first).join(EVENTS_FILE)).unwrap();
        let second_lines = fs::read_to_string(games.join(&second).join(EVENTS_FILE)).unwrap();
        assert_eq!(first_lines.lines().count(), 2, "半荘の開始と評価1件");
        assert!(first_lines.contains("\"good\""));
        assert!(!first_lines.contains("\"bad\""));
        assert_eq!(second_lines.lines().count(), 2);
        assert!(second_lines.contains("\"bad\""));
        assert!(games.join(&first).join(MARKS_DIR).is_dir());
        assert!(games.join(&second).join(MARKS_DIR).is_dir());
    }

    #[test]
    fn w6_session_folder_name_is_local_time_yyyymmdd_hhmmss() {
        let (_tmp, mut store) = open_store();
        let id = store.start_session(T0).unwrap();
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
        let a = store.start_session(T0).unwrap();
        let b = store.start_session(T0 + 400).unwrap();
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
        store.add_rating(T0, Rating::Fair).unwrap();
        assert!(store.current_session_id().is_some());
        assert_eq!(store.view().next_hand(), 2);
    }

    #[test]
    fn w6_marks_and_ratings_do_not_start_extra_sessions() {
        let (_tmp, mut store) = open_store();
        store.add_mark(T0, shot()).unwrap();
        let id = store.current_session_id().unwrap().to_string();
        store.add_rating(T0 + 1, Rating::Good).unwrap();
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
        assert_eq!(
            fs::read_dir(session_dir(&store).join(MARKS_DIR))
                .unwrap()
                .count(),
            0
        );
    }

    // ---- W-3 / W-8 ----

    #[test]
    fn w3_undo_cancels_only_the_most_recent_record() {
        let (_tmp, mut store) = open_store();
        store.add_mark(T0, shot()).unwrap(); // id 1
        store.add_rating(T0 + 1, Rating::Good).unwrap(); // id 2
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
        store.start_session(T0).unwrap();
        let before = event_lines(&store).len();
        assert!(matches!(store.undo(T0 + 1), Err(StoreError::NothingToUndo)));
        assert_eq!(event_lines(&store).len(), before);
    }

    #[test]
    fn w3_undo_points_at_the_record_it_cancels_and_never_deletes_lines() {
        let (_tmp, mut store) = open_store();
        store.add_rating(T0, Rating::Bad).unwrap(); // id 1
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
        store.add_rating(T0, Rating::Good).unwrap();
        assert_eq!(store.view().next_hand(), 2);
        store.add_rating(T0 + 1, Rating::Fair).unwrap();
        assert_eq!(store.view().next_hand(), 3);
        store.add_rating(T0 + 2, Rating::Bad).unwrap();
        assert_eq!(store.view().next_hand(), 4);
        store.undo(T0 + 3).unwrap();
        assert_eq!(store.view().next_hand(), 3);
        store.undo(T0 + 4).unwrap();
        assert_eq!(store.view().next_hand(), 2);
        store.add_rating(T0 + 5, Rating::Good).unwrap();
        assert_eq!(store.view().next_hand(), 3);
    }

    #[test]
    fn w8_marks_do_not_change_the_next_hand() {
        let (_tmp, mut store) = open_store();
        store.add_rating(T0, Rating::Good).unwrap();
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
        store.add_rating(T0, Rating::Good).unwrap();
        store.add_rating(T0 + 1, Rating::Bad).unwrap();
        store.add_rating(T0 + 2, Rating::Fair).unwrap();
        store.undo(T0 + 3).unwrap();
        store.add_rating(T0 + 4, Rating::Good).unwrap();
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
                0 => store.add_rating(T0 + step, Rating::Good).unwrap(),
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
            kind: EventKind::Rating {
                rating: Rating::Fair,
            },
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
                kind: EventKind::Rating {
                    rating: Rating::Good,
                },
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
                kind: EventKind::Rating {
                    rating: Rating::Bad,
                },
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
        store.start_session(T0).unwrap();
        store.add_mark(T0 + 1, shot()).unwrap();
        store.add_rating(T0 + 2, Rating::Good).unwrap();
        store.add_rating(T0 + 3, Rating::Bad).unwrap();
        store.undo(T0 + 4).unwrap();
        store.start_session(T0 + 100_000).unwrap();
        store.add_mark(T0 + 100_001, shot()).unwrap();
        store.add_mark(T0 + 100_002, shot()).unwrap();

        let sessions = store.list_sessions().unwrap();
        assert_eq!(sessions.len(), 2);
        assert_eq!(sessions[0].started_ms, T0 + 100_000);
        assert_eq!(sessions[0].mark_count, 2);
        assert_eq!(sessions[0].rating_count, 0);
        assert_eq!(sessions[1].started_ms, T0);
        assert_eq!(sessions[1].mark_count, 1);
        assert_eq!(sessions[1].rating_count, 1, "取り消した評価は数えない");
        assert_eq!(sessions[1].ratings[0].hand, 1);
        assert_eq!(
            sessions[1].events.len(),
            5,
            "開始・マーク・評価2件・取り消し。取り消しも含めて全部の記録を返す"
        );
        let path = sessions[1].marks[0].screenshot_path.as_ref().unwrap();
        assert!(Path::new(path).is_absolute());
        assert!(Path::new(path).is_file());
    }

    #[test]
    fn list_sessions_skips_folders_without_a_log_and_survives_a_broken_line() {
        let (_tmp, mut store) = open_store();
        store.add_rating(T0, Rating::Good).unwrap();
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
}
