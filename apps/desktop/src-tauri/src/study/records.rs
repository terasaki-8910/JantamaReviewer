//! 記録の書き出しと読み込み（D-2、R11-14「記録だけを 1 つの JSON に」）。
//!
//! 書き出す: 答え・解き直しの予定（答えごとの間隔と期限）・今日の出題の組・週の成績と重点（以上は `study.sqlite`）、
//! 半荘ごと（半荘の名前で。消した半荘 `trash/` は入れない）の結びつけ・自己評価の付け直し・MAKA の評価・メモ・解決した局面
//! （半荘のフォルダの `links.json`・`self-ratings.json`・`maka.json`・`memos.json`・`resolved.json` の中身）、設定。
//! 入れないもの: スクリーンショット（`marks/`・`ratings/`）、Mortal の結果（`report.json`）、ウィジェットの記録（`events.jsonl`）、
//! 文字認識の写し（`ocr.json`）、設定のうち、この PC だけで意味を持つ値（データの保存先・ウィジェットの窓の位置）。
//!
//! 読み込む: ファイルを全部確かめてから（版・形・ストアが書くときと同じ決まりの値）、いまの記録を、ファイルの内容に置き換える。
//! 途中で失敗したら、元の記録のまま残す（先に新しいファイルを別の名前で書いておき、取引の中で答えを入れ替え、確定する前に
//! 半荘のフォルダのファイルを入れ替える。どこかで失敗したら、取引を取り消し、入れ替えたファイルを戻す）。
//! この保存先にフォルダの無い半荘の記録は、`pending-records.json` に取っておき、フォルダが現れたときに付ける（`Store::apply_pending_records`）。

use std::collections::BTreeMap;
use std::fmt;
use std::fs;
use std::io::{self, Write};
use std::path::{Path, PathBuf};

use serde::{Deserialize, Serialize};
use serde_json::Value;

use super::{
    check_snapshot, AnswerRow, DailySetRecord, ReplaceError, StudyDb, StudyError, WeekRecord,
};
use crate::replay_keys::ReplayKeys;
use crate::settings::{Orientation, Settings, Trigger};
use crate::store::{
    valid_session_id, write_atomic, PendingRecords, SessionRecords, Store, StoreError,
    PENDING_VERSION,
};

/// ファイルの種類の名前（`format`）。
pub const FORMAT_NAME: &str = "jantama-reviewer-records";

/// ファイルの形の版（`version`）。形を変えるときに増やす。これより大きい版のファイルは、読まない。
pub const FORMAT_VERSION: u32 = 1;

/// 読み込むファイルの大きさの上限（バイト）。記録だけなので、これを超えるものは、記録のファイルではない。
pub const MAX_FILE_BYTES: u64 = 128 * 1024 * 1024;

/// 入れ替えの途中の、新しい中身を別の名前で置いておくときの、名前の後ろ。
const NEW_SUFFIX: &str = ".import-new";
/// 入れ替えの途中の、元の中身を取っておくときの、名前の後ろ。
const OLD_SUFFIX: &str = ".import-old";

/// 設定のうち、書き出す値（この PC だけで意味を持つデータの保存先・ウィジェットの窓の位置は入れない）。
/// 読み込むときは、これをいまの設定に重ねる（保存先と窓の位置は、いまのまま）。
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct PortableSettings {
    pub trigger: Trigger,
    pub orientation: Orientation,
    pub sound: bool,
    /// 迷いだけを記録する（W-15）。この項目が無い昔の書き出しは、入（既定）として読む。
    #[serde(default = "default_doubt_only")]
    pub doubt_only: bool,
    pub capture_keywords: Vec<String>,
    pub daily_count: u32,
    pub highlight_dora: bool,
    pub show_all_mismatches: bool,
    pub replay_keys: ReplayKeys,
    pub replay_keys_revision: u32,
}

/// 迷いだけの既定（入）。この項目が無い昔の書き出しを読むときに使う。
fn default_doubt_only() -> bool {
    Settings::default().doubt_only
}

impl PortableSettings {
    /// いまの設定から、書き出す値を取り出す。
    pub fn from_settings(settings: &Settings) -> PortableSettings {
        PortableSettings {
            trigger: settings.trigger.clone(),
            orientation: settings.orientation,
            sound: settings.sound,
            doubt_only: settings.doubt_only,
            capture_keywords: settings.capture_keywords.clone(),
            daily_count: settings.daily_count,
            highlight_dora: settings.highlight_dora,
            show_all_mismatches: settings.show_all_mismatches,
            replay_keys: settings.replay_keys.clone(),
            replay_keys_revision: settings.replay_keys_revision,
        }
    }

    /// `current`（いまの設定）に重ねた設定。データの保存先とウィジェットの窓の位置は、`current` のまま。
    /// 使える値かは、`Settings::validate` で確かめる（ここでは確かめない）。
    pub fn applied_to(&self, current: &Settings) -> Settings {
        Settings {
            trigger: self.trigger.clone(),
            orientation: self.orientation,
            widget_position: current.widget_position,
            sound: self.sound,
            doubt_only: self.doubt_only,
            capture_keywords: self.capture_keywords.clone(),
            data_dir: current.data_dir.clone(),
            daily_count: self.daily_count,
            highlight_dora: self.highlight_dora,
            show_all_mismatches: self.show_all_mismatches,
            replay_keys: self.replay_keys.clone(),
            replay_keys_revision: self.replay_keys_revision,
            // 飛ばした更新の版も、この PC だけの値（書き出しに入れず、いまのまま）
            skipped_update_version: current.skipped_update_version.clone(),
        }
        .normalized()
    }
}

/// 書き出しのファイルの中身（JSON の最上位）。
///
/// ```json
/// {
///   "format": "jantama-reviewer-records",
///   "version": 1,
///   "app_version": "0.1.0",
///   "exported_at": "2026-10-12T14:03:22+09:00",
///   "settings": { "trigger": { "kind": "mouse_x1" }, "orientation": "vertical", "...": "..." },
///   "answers": [ { "id": 1, "session_id": "20261009-190953", "decision_key": "k2h1e14", "mode": "quiz", "...": "..." } ],
///   "daily_sets": [ { "date": "2026-10-12", "items": [ { "session_id": "20261009-190953", "decision_key": "k2h1e14" } ] } ],
///   "weeks": [ { "week": "2026-10-05", "stats": { "rank4": 20.4 }, "focus": "受け入れを数えてから切る。" } ],
///   "sessions": { "20261009-190953": { "links": {}, "self_ratings": {}, "maka": {}, "memos": {}, "resolved": { "decisions": { "k2h1e14": 1760000000123 } } } }
/// }
/// ```
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
pub struct RecordsFile {
    pub format: String,
    pub version: u32,
    pub app_version: String,
    pub exported_at: String,
    pub settings: PortableSettings,
    pub answers: Vec<AnswerRow>,
    pub daily_sets: Vec<DailySetRecord>,
    pub weeks: Vec<WeekRecord>,
    pub sessions: BTreeMap<String, SessionRecords>,
}

impl RecordsFile {
    /// 半荘の数と、答えの数。
    pub fn counts(&self) -> (usize, usize) {
        (self.sessions.len(), self.answers.len())
    }

    /// 全部の値を、ストアが書くときと同じ決まりで確かめて、保存する形にそろえる（メモの前後の空白、重点の空の行）。
    fn checked(mut self) -> Result<RecordsFile, RecordsError> {
        self.settings
            .applied_to(&Settings::default())
            .validate()
            .map_err(|e| RecordsError::Invalid(format!("設定: {e}")))?;
        self.weeks = check_snapshot(&self.answers, &self.daily_sets, &self.weeks)
            .map_err(|e| RecordsError::Invalid(e.to_string()))?;
        let mut sessions = BTreeMap::new();
        for (id, records) in std::mem::take(&mut self.sessions) {
            if !valid_session_id(&id) {
                return Err(RecordsError::Invalid(format!(
                    "半荘の名前の形が違います: {id:?}"
                )));
            }
            let checked = records
                .checked()
                .map_err(|e| RecordsError::Invalid(format!("半荘 {id}: {e}")))?;
            sessions.insert(id, checked);
        }
        self.sessions = sessions;
        Ok(self)
    }
}

/// 書き出し・読み込みの失敗。
#[derive(Debug)]
pub enum RecordsError {
    /// ファイルを読めなかった。
    Read(io::Error),
    /// ファイルを書けなかった。
    Write(io::Error),
    /// 記録のファイルではない（JSON として読めない・種類の名前が違う、など）。
    NotRecords(String),
    /// 大きすぎる。
    TooLarge(u64),
    /// 新しい版のアプリが書き出したファイル。
    NewerVersion {
        found: u64,
        supported: u32,
    },
    /// 値や形が正しくない。
    Invalid(String),
    Study(StudyError),
    Store(StoreError),
    /// 入れ替えの途中で失敗した。`restored` は、入れ替えたファイルを、元に戻せたか。
    Swap {
        reason: String,
        restored: bool,
    },
}

impl fmt::Display for RecordsError {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        match self {
            RecordsError::Read(e) => write!(f, "ファイルを読めませんでした: {e}"),
            RecordsError::Write(e) => write!(f, "ファイルを書けませんでした: {e}"),
            RecordsError::NotRecords(reason) => write!(
                f,
                "JantamaReviewer の記録のファイルとして読めませんでした（{reason}）"
            ),
            RecordsError::TooLarge(bytes) => write!(
                f,
                "ファイルが大きすぎます（{} MB）。記録のファイルではないようです",
                bytes / (1024 * 1024)
            ),
            RecordsError::NewerVersion { found, supported } => write!(
                f,
                "このファイルは、新しい版のアプリで書き出されています（ファイルの版 {found}。このアプリは {supported} まで）。アプリを新しくしてください"
            ),
            RecordsError::Invalid(reason) => {
                write!(f, "ファイルの中身が正しくありません: {reason}")
            }
            RecordsError::Study(e) => write!(f, "{e}"),
            RecordsError::Store(e) => write!(f, "{e}"),
            RecordsError::Swap { reason, .. } => {
                write!(f, "記録を入れ替えている途中で失敗しました: {reason}")
            }
        }
    }
}

impl std::error::Error for RecordsError {}

impl From<StudyError> for RecordsError {
    fn from(e: StudyError) -> Self {
        RecordsError::Study(e)
    }
}

impl From<StoreError> for RecordsError {
    fn from(e: StoreError) -> Self {
        RecordsError::Store(e)
    }
}

impl RecordsError {
    /// 読み込みの失敗を、画面に出す文にする。元の記録がどうなったかも書く（入れ替えの途中の失敗を、元に戻せなかったときだけ、
    /// 元のままではない）。
    pub fn import_message(&self) -> String {
        match self {
            RecordsError::Swap {
                restored: false, ..
            } => format!(
                "{self}。元に戻せなかったものがあります。書き出したファイルがあれば、もう一度読み込んでください。"
            ),
            _ => format!("{self}。いまの記録は変わっていません。"),
        }
    }
}

/// 書き出し・読み込みの前に見せる、中身の数と大きさ。
#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
pub struct RecordsOverview {
    /// 半荘の数（消した半荘は数えない）。
    pub sessions: usize,
    pub answers: usize,
    /// 書き出したときのファイルの大きさ（バイト）。
    pub bytes: u64,
}

/// 書き出したファイルの報告。
#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
pub struct ExportReport {
    pub path: String,
    pub sessions: usize,
    pub answers: usize,
    pub bytes: u64,
}

/// 読み込む前に、ファイルを確かめた結果。
#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
pub struct ImportPreview {
    /// ファイルの半荘の数。
    pub sessions: usize,
    /// ファイルの答えの数。
    pub answers: usize,
    /// ファイルの半荘のうち、この保存先に半荘のフォルダが無いものの数（その記録は、フォルダが現れるまで取っておく）。
    pub held: usize,
}

/// 読み込んだ結果の報告。
pub type ImportReport = ImportPreview;

/// いまの記録から、書き出すファイルの中身を作る。何も書き換えない。
/// 消した半荘（置き場の `trash/` にあって、`games/` に無いもの）の記録と答えは、入れない。
pub fn build_export(
    data_dir: &Path,
    db: &StudyDb,
    settings: &Settings,
    exported_at: &str,
) -> Result<RecordsFile, RecordsError> {
    let store = Store::open(data_dir)?;
    let local = store.local_session_ids()?;
    let trashed: Vec<String> = store
        .trashed_session_ids()
        .into_iter()
        .filter(|id| !local.contains(id))
        .collect();
    let answers = db
        .list_answers()?
        .into_iter()
        .filter(|row| !trashed.contains(&row.answer.session_id))
        .collect();
    let daily_sets = db
        .list_daily_sets()?
        .into_iter()
        .filter_map(|mut set| {
            set.items.retain(|item| !trashed.contains(&item.session_id));
            (!set.items.is_empty()).then_some(set)
        })
        .collect();
    Ok(RecordsFile {
        format: FORMAT_NAME.to_string(),
        version: FORMAT_VERSION,
        app_version: env!("CARGO_PKG_VERSION").to_string(),
        exported_at: exported_at.to_string(),
        settings: PortableSettings::from_settings(settings),
        answers,
        daily_sets,
        weeks: db.list_weeks()?,
        sessions: store.session_records()?,
    })
}

/// ファイルに書く文字（見やすいように整える）。
fn to_text(file: &RecordsFile) -> Result<String, RecordsError> {
    serde_json::to_string_pretty(file).map_err(|e| RecordsError::Store(StoreError::Encode(e)))
}

/// いま書き出すとしたら、何がどれだけ入るか（設定のページの「約 0.4 MB」に使う）。何も書かない。
pub fn overview(
    data_dir: &Path,
    db: &StudyDb,
    settings: &Settings,
) -> Result<RecordsOverview, RecordsError> {
    let file = build_export(data_dir, db, settings, "")?;
    let (sessions, answers) = file.counts();
    Ok(RecordsOverview {
        sessions,
        answers,
        bytes: to_text(&file)?.len() as u64,
    })
}

/// 記録を `path` に書き出す。別の名前で書いてから置き換えるので、途中で止まっても、半端なファイルは残らない
/// （同じ名前のファイルがあれば、置き換わる。上書きの確認は、保存のダイアログが出す）。
pub fn export_to_path(
    data_dir: &Path,
    db: &StudyDb,
    settings: &Settings,
    path: &Path,
    exported_at: &str,
) -> Result<ExportReport, RecordsError> {
    let file = build_export(data_dir, db, settings, exported_at)?;
    let text = to_text(&file)?;
    write_atomic(path, text.as_bytes()).map_err(RecordsError::Write)?;
    let (sessions, answers) = file.counts();
    Ok(ExportReport {
        path: path.to_string_lossy().into_owned(),
        sessions,
        answers,
        bytes: text.len() as u64,
    })
}

/// 記録のファイルを読んで、全部確かめる（版・形・値）。何も書き換えない。
pub fn read_records_file(path: &Path) -> Result<RecordsFile, RecordsError> {
    let meta = fs::metadata(path).map_err(RecordsError::Read)?;
    if !meta.is_file() {
        return Err(RecordsError::NotRecords("ファイルではありません".into()));
    }
    if meta.len() > MAX_FILE_BYTES {
        return Err(RecordsError::TooLarge(meta.len()));
    }
    parse_records(&fs::read(path).map_err(RecordsError::Read)?)
}

/// 文字（UTF-8。先頭の BOM は取る）から、記録のファイルを読んで、全部確かめる。
pub fn parse_records(bytes: &[u8]) -> Result<RecordsFile, RecordsError> {
    let text = std::str::from_utf8(bytes)
        .map_err(|_| RecordsError::NotRecords("UTF-8 の文字として読めません".into()))?;
    let text = text.strip_prefix('\u{feff}').unwrap_or(text);
    let value: Value = serde_json::from_str(text)
        .map_err(|e| RecordsError::NotRecords(format!("JSON として読めません: {e}")))?;
    if value.get("format").and_then(Value::as_str) != Some(FORMAT_NAME) {
        return Err(RecordsError::NotRecords("ファイルの種類が違います".into()));
    }
    let Some(version) = value.get("version").and_then(Value::as_u64) else {
        return Err(RecordsError::NotRecords("版の番号がありません".into()));
    };
    if version > u64::from(FORMAT_VERSION) {
        return Err(RecordsError::NewerVersion {
            found: version,
            supported: FORMAT_VERSION,
        });
    }
    if version < 1 {
        return Err(RecordsError::NotRecords(
            "版の番号が正しくありません".into(),
        ));
    }
    let file: RecordsFile = serde_json::from_value(value)
        .map_err(|e| RecordsError::Invalid(format!("形が合いません（{e}）")))?;
    file.checked()
}

/// 読み込む前の確認に出す数。ファイルの半荘のうち、この保存先に半荘のフォルダが無いものの数も数える。何も書き換えない。
pub fn preview(data_dir: &Path, file: &RecordsFile) -> Result<ImportPreview, RecordsError> {
    let store = Store::open(data_dir)?;
    let local = store.local_session_ids()?;
    let (sessions, answers) = file.counts();
    Ok(ImportPreview {
        sessions,
        answers,
        held: file
            .sessions
            .keys()
            .filter(|id| !local.contains(*id))
            .count(),
    })
}

/// 入れ替えるファイル 1 つ: 置き場所と、新しい中身（`None` はファイルを置かない = いまのファイルを消す）。
struct Target {
    path: PathBuf,
    text: Option<String>,
}

fn suffixed(path: &Path, suffix: &str) -> PathBuf {
    let mut name = path.as_os_str().to_owned();
    name.push(suffix);
    PathBuf::from(name)
}

/// 入れ替えでやったこと（戻すときのために、順に覚える）。
enum Step {
    /// `target` を `old` に動かした（元の中身を取っておいた）。
    BackedUp { target: PathBuf, old: PathBuf },
    /// 新しい `new` を `target` の場所に動かした。
    Installed { target: PathBuf, new: PathBuf },
}

/// ファイルの入れ替え。置き場所ごとに、いまのファイルを取っておき（`.import-old`）、新しいファイル（`.import-new`）を置く。
struct Swap {
    steps: Vec<Step>,
}

type Rename<'a> = &'a mut dyn FnMut(&Path, &Path) -> io::Result<()>;

impl Swap {
    fn apply(&mut self, targets: &[Target], rename: Rename<'_>) -> io::Result<()> {
        for target in targets {
            if target.path.exists() {
                let old = suffixed(&target.path, OLD_SUFFIX);
                rename(&target.path, &old)?;
                self.steps.push(Step::BackedUp {
                    target: target.path.clone(),
                    old,
                });
            }
            if target.text.is_some() {
                let new = suffixed(&target.path, NEW_SUFFIX);
                rename(&new, &target.path)?;
                self.steps.push(Step::Installed {
                    target: target.path.clone(),
                    new,
                });
            }
        }
        Ok(())
    }

    /// やったことを、逆の順に取り消す。元の中身を、すべて元の場所に戻せたら true。
    fn rollback(&mut self, rename: Rename<'_>) -> bool {
        let mut restored = true;
        while let Some(step) = self.steps.pop() {
            match step {
                Step::Installed { target, new } => {
                    // 新しい中身は、元の名前（`.import-new`）に戻す。戻せなければ、消す（元の中身は、別に取ってある）
                    if rename(&target, &new).is_err() && fs::remove_file(&target).is_err() {
                        restored = false;
                    }
                }
                Step::BackedUp { target, old } => {
                    if rename(&old, &target).is_err() {
                        restored = false;
                    }
                }
            }
        }
        restored
    }

    /// 成功したあと、取っておいた元の中身を消す（消せなくても、困らない）。
    fn discard_backups(&mut self) {
        for step in self.steps.drain(..) {
            if let Step::BackedUp { old, .. } = step {
                let _ = fs::remove_file(old);
            }
        }
    }
}

/// 新しい中身を、別の名前で書く（確実に書き終えてから、入れ替える）。
fn write_new(path: &Path, text: &str) -> io::Result<()> {
    let mut file = fs::File::create(path)?;
    file.write_all(text.as_bytes())?;
    file.sync_data()
}

/// いまの記録を、`file` の内容に置き換える。失敗したら、元の記録のまま残す。
/// - この保存先に半荘のフォルダがある半荘: その 4 つの記録のファイルを、`file` の内容に置き換える（`file` に無い半荘や、
///   `file` で空の種類は、ファイルを消す）
/// - フォルダが無い半荘: `pending-records.json` に取っておく（フォルダが現れたとき、付ける）
/// - 答え・今日の出題・週の成績: 1 つの取引で、全部置き換える
///
/// `rename` は、ファイルを動かす操作（試験で、失敗する動かし方に差し替える）。設定は、呼ぶ側が、これとは別に扱う。
pub fn import_records(
    data_dir: &Path,
    db: &mut StudyDb,
    file: &RecordsFile,
    rename: Rename<'_>,
) -> Result<ImportReport, RecordsError> {
    let store = Store::open(data_dir)?;
    let local = store.local_session_ids()?;

    // 置き換えるファイルと、新しい中身
    let mut targets: Vec<Target> = Vec::new();
    for id in &local {
        let Some(dir) = store.session_folder(id) else {
            continue;
        };
        let records = file.sessions.get(id).cloned().unwrap_or_default();
        for (name, text) in records.files()? {
            targets.push(Target {
                path: dir.join(name),
                text,
            });
        }
    }
    let held: BTreeMap<String, SessionRecords> = file
        .sessions
        .iter()
        .filter(|(id, _)| !local.contains(*id))
        .map(|(id, records)| (id.clone(), records.clone()))
        .collect();
    let held_count = held.len();
    targets.push(Target {
        path: store.pending_path(),
        text: if held.is_empty() {
            None
        } else {
            Some(
                serde_json::to_string_pretty(&PendingRecords {
                    version: PENDING_VERSION,
                    sessions: held,
                })
                .map_err(|e| RecordsError::Store(StoreError::Encode(e)))?,
            )
        },
    });

    // 新しい中身を、先に全部、別の名前で書いておく（ここで失敗しても、何も変わっていない）
    let mut staged: Vec<PathBuf> = Vec::new();
    for target in &targets {
        let Some(text) = &target.text else {
            continue;
        };
        let new = suffixed(&target.path, NEW_SUFFIX);
        let written = write_new(&new, text);
        staged.push(new);
        if let Err(e) = written {
            discard(&staged);
            return Err(RecordsError::Write(e));
        }
    }

    // 答えの入れ替え（取引）の確定の前に、ファイルを入れ替える。どこかで失敗したら、どちらも元に戻す
    let mut swap = Swap { steps: Vec::new() };
    let outcome = db.replace_all(&file.answers, &file.daily_sets, &file.weeks, || {
        swap.apply(&targets, &mut *rename)
    });
    match outcome {
        Ok(()) => {
            swap.discard_backups();
            discard(&staged);
            let (sessions, answers) = file.counts();
            Ok(ImportReport {
                sessions,
                answers,
                held: held_count,
            })
        }
        Err(error) => {
            let restored = swap.rollback(&mut *rename);
            discard(&staged);
            Err(match error {
                ReplaceError::Study(e) => {
                    if restored {
                        RecordsError::Study(e)
                    } else {
                        RecordsError::Swap {
                            reason: e.to_string(),
                            restored,
                        }
                    }
                }
                ReplaceError::Hook(e) => RecordsError::Swap {
                    reason: e.to_string(),
                    restored,
                },
            })
        }
    }
}

/// 別の名前で書いた新しい中身のうち、残っているものを消す。
fn discard(staged: &[PathBuf]) {
    for path in staged {
        let _ = fs::remove_file(path);
    }
}

/// 試験と、ふだんの動き（本物の `fs::rename`）の、ファイルの動かし方。
pub fn real_rename(from: &Path, to: &Path) -> io::Result<()> {
    fs::rename(from, to)
}

#[cfg(test)]
mod tests {
    use std::cell::Cell;

    use serde_json::json;

    use super::*;
    use crate::capture::{CaptureError, CaptureTarget, Screenshot};
    use crate::replay_keys;
    use crate::settings::WidgetPosition;
    use crate::store::{
        Links, Maka, MemoPosition, OcrCache, OcrEntry, Rating, SelfRating, SESSION_GAP_MS,
    };
    use crate::study::{AnswerMode, NewAnswer, ProblemRef, WeekStats};

    const T0: i64 = 1_760_000_000_123;
    const REPORT_SENTINEL: &str = "REPORT-SENTINEL-4f2a";
    const OCR_SENTINEL: &str = "OCR-SENTINEL-9b1c";
    const RECORD_FILES: [&str; 5] = [
        "links.json",
        "self-ratings.json",
        "maka.json",
        "memos.json",
        "resolved.json",
    ];

    fn shot() -> Result<Screenshot, CaptureError> {
        Ok(Screenshot {
            png: vec![0x89, b'P', b'N', b'G', 9, 9, 9],
            target: CaptureTarget::Window,
        })
    }

    /// 全種類の記録を入れた保存先。半荘 a（迷いマーク 2・評価 1・結果・文字認識の写し・全種類の記録）、半荘 b（少しの記録）。
    struct Fixture {
        tmp: tempfile::TempDir,
        data: PathBuf,
        store: Store,
        db: StudyDb,
        a: String,
        b: String,
        settings: Settings,
    }

    #[derive(Debug, PartialEq)]
    struct State {
        files: BTreeMap<String, Vec<u8>>,
        answers: Vec<AnswerRow>,
        daily: Vec<DailySetRecord>,
        weeks: Vec<WeekRecord>,
    }

    fn answer(session: &str, key: &str, mode: AnswerMode, at: i64) -> NewAnswer {
        NewAnswer {
            session_id: session.to_string(),
            decision_key: key.to_string(),
            mode,
            shown_at: at - 40_000,
            answered_at: at,
            choice: json!({"type": "dahai", "tile": "5p"}),
            reason: "孤立を切る".to_string(),
            duration_ms: 40_000,
            reselect_count: 1,
            correct: true,
            causes: Vec::new(),
            principle: String::new(),
            maka_move: None,
            interval_days: 3,
            due_date: "2026-10-15".to_string(),
        }
    }

    fn fixture_settings(data: &Path) -> Settings {
        let mut replay = replay_keys::default_keys();
        replay.insert("prev_turn".to_string(), None);
        Settings {
            trigger: Trigger::Key {
                code: "F13".to_string(),
                ctrl: true,
                alt: false,
                shift: false,
                win: false,
            },
            orientation: Orientation::Horizontal,
            widget_position: Some(WidgetPosition { x: 12, y: 34 }),
            sound: false,
            // 既定（入）とは違う値にして、書き出し・読み込みで落ちないことを確かめる
            doubt_only: false,
            capture_keywords: vec![
                "雀魂".into(),
                "Mahjong Soul".into(),
                "Majsoul client".into(),
            ],
            data_dir: data.to_path_buf(),
            daily_count: 9,
            highlight_dora: true,
            show_all_mismatches: true,
            replay_keys: replay,
            replay_keys_revision: replay_keys::KEYS_REVISION,
            skipped_update_version: None,
        }
        .normalized()
    }

    fn fixture() -> Fixture {
        let tmp = tempfile::tempdir().unwrap();
        let data = tmp.path().join("data");
        let mut store = Store::open(&data).unwrap();

        store.add_mark(T0, shot()).unwrap();
        store.add_mark(T0 + 1_000, shot()).unwrap();
        store.add_rating(T0 + 2_000, Rating::Good, shot()).unwrap();
        let a = store.current_session_id().unwrap().to_string();
        store.close_session(T0 + 3_000).unwrap();
        store.add_mark(T0 + SESSION_GAP_MS * 2, shot()).unwrap();
        store
            .add_rating(T0 + SESSION_GAP_MS * 2 + 1, Rating::Bad, shot())
            .unwrap();
        let b = store.current_session_id().unwrap().to_string();
        store.close_session(T0 + SESSION_GAP_MS * 2 + 2).unwrap();

        // 結果・文字認識の写し（書き出しに入らないもの）
        store
            .save_report(Some(&a), &format!("{{\"note\":\"{REPORT_SENTINEL}\"}}"), T0)
            .unwrap();
        let mut ocr = OcrCache {
            geometry: "center-v3".to_string(),
            ..OcrCache::default()
        };
        ocr.entries.insert(
            "marks/x.png".to_string(),
            OcrEntry {
                lines: vec![OCR_SENTINEL.to_string()],
                ..OcrEntry::default()
            },
        );
        store.save_ocr(&a, &ocr).unwrap();

        // 半荘 a: 全種類の記録
        let mut links = Links::default();
        links.marks.insert("1".into(), "k0h0e3".into());
        links.marks.insert("2".into(), "manual".into());
        links.ratings.insert("3".into(), "k0h0".into());
        links.ratings_version = Some(3);
        store.replace_links(&a, links).unwrap();
        store.set_self_rating(&a, "k0h0", SelfRating::Bad).unwrap();
        store
            .set_self_rating(&a, "k1h0", SelfRating::Unrated)
            .unwrap();
        store.set_maka_grade(&a, "k0h0", "A-").unwrap();
        store.set_maka_hanchan(&a, "B+").unwrap();
        store.set_resolved(&a, "k0h0e3", true, T0 + 5_000).unwrap();
        store.set_resolved(&a, "k2h1e14", true, T0 + 6_000).unwrap();
        store.set_memo(&a, 1, "3m・6p", "東を残したい").unwrap();
        let pos = MemoPosition {
            kyoku: 2,
            honba: 0,
            junme: 9,
        };
        store
            .set_extra_memo(&a, "x1", None, Some(pos), "5s・發", "")
            .unwrap();
        store
            .set_extra_memo(&a, "x2", Some("k1h1e7"), Some(pos), "", "速さ")
            .unwrap();
        store
            .set_extra_memo(&a, "x3", Some("k4h2e5"), None, "", "判断の鍵だけの古い形")
            .unwrap();
        // 半荘 b: 少しの記録
        store.set_mark_link(&b, 1, "k0h0e2").unwrap();
        store.set_memo(&b, 1, "", "理由だけ").unwrap();

        // 答え・今日の出題・週
        let mut db = StudyDb::open(&data).unwrap();
        db.record_answer(answer(&a, "k0h0e3", AnswerMode::Quiz, T0 + 10_000))
            .unwrap();
        let mut wrong = answer(&a, "k1h0e4", AnswerMode::Quiz, T0 + 20_000);
        wrong.correct = false;
        wrong.causes = vec!["ukeire".to_string(), "defense".to_string()];
        wrong.principle = "受け入れを数えてから切る".to_string();
        wrong.maka_move = Some("5pr".to_string());
        wrong.interval_days = 1;
        wrong.due_date = "2026-10-13".to_string();
        wrong.choice = json!({"type": "option", "id": "pon"});
        db.record_answer(wrong).unwrap();
        db.record_answer(answer(&a, "k0h0e3", AnswerMode::Review, T0 + 30_000))
            .unwrap();
        db.record_answer(answer(&b, "k0h0e2", AnswerMode::Quiz, T0 + 40_000))
            .unwrap();
        db.save_daily_set(
            "2026-10-12",
            &[
                ProblemRef {
                    session_id: a.clone(),
                    decision_key: "k0h0e3".to_string(),
                },
                ProblemRef {
                    session_id: b.clone(),
                    decision_key: "k0h0e2".to_string(),
                },
            ],
        )
        .unwrap();
        db.set_week(WeekRecord {
            week: "2026-10-05".to_string(),
            stats: WeekStats {
                rank4: Some(20.4),
                deal: Some(11.5),
                avg: Some(2.41),
                win: Some(24.0),
                call: Some(31.2),
                riichi: Some(19.9),
            },
            focus: "受け入れを数えてから切る。\n押し引きを見直す。".to_string(),
        })
        .unwrap();
        db.set_week(WeekRecord {
            week: "2026-10-12".to_string(),
            stats: WeekStats::default(),
            focus: "守備".to_string(),
        })
        .unwrap();

        let settings = fixture_settings(&data);
        Fixture {
            tmp,
            data,
            store,
            db,
            a,
            b,
            settings,
        }
    }

    impl Fixture {
        fn export(&self) -> RecordsFile {
            build_export(
                &self.data,
                &self.db,
                &self.settings,
                "2026-10-12T14:03:22+09:00",
            )
            .unwrap()
        }

        fn export_text(&self) -> String {
            to_text(&self.export()).unwrap()
        }

        fn import(&mut self, file: &RecordsFile) -> Result<ImportReport, RecordsError> {
            import_records(&self.data, &mut self.db, file, &mut real_rename)
        }

        fn state(&self) -> State {
            State {
                files: dir_snapshot(&self.data),
                answers: self.db.list_answers().unwrap(),
                daily: self.db.list_daily_sets().unwrap(),
                weeks: self.db.list_weeks().unwrap(),
            }
        }

        /// 半荘のフォルダの 4 つの記録のファイルと、取っておいた記録のファイル、答え・出題・週を、すべて消す。
        fn wipe(&mut self) {
            for id in self.store.local_session_ids().unwrap() {
                let dir = self.store.session_folder(&id).unwrap();
                for name in RECORD_FILES {
                    let _ = fs::remove_file(dir.join(name));
                }
            }
            let _ = fs::remove_file(self.store.pending_path());
            self.db
                .replace_all(&[], &[], &[], || Ok::<(), String>(()))
                .unwrap();
        }
    }

    /// 保存先のファイルすべての中身（`study.sqlite` は、別に調べるので除く）。
    fn dir_snapshot(root: &Path) -> BTreeMap<String, Vec<u8>> {
        fn walk(dir: &Path, root: &Path, out: &mut BTreeMap<String, Vec<u8>>) {
            for entry in fs::read_dir(dir).unwrap().flatten() {
                let path = entry.path();
                if path.is_dir() {
                    walk(&path, root, out);
                } else {
                    let name = path
                        .strip_prefix(root)
                        .unwrap()
                        .to_string_lossy()
                        .replace('\\', "/");
                    if !name.starts_with("study.sqlite") {
                        out.insert(name, fs::read(&path).unwrap());
                    }
                }
            }
        }
        let mut out = BTreeMap::new();
        walk(root, root, &mut out);
        out
    }

    /// フォルダを、中身ごと写す（`skip` の名前のファイルは写さない）。
    fn copy_dir(from: &Path, to: &Path, skip: &[&str]) {
        fs::create_dir_all(to).unwrap();
        for entry in fs::read_dir(from).unwrap().flatten() {
            let path = entry.path();
            let name = entry.file_name();
            if path.is_dir() {
                copy_dir(&path, &to.join(&name), skip);
            } else if !skip.contains(&name.to_string_lossy().as_ref()) {
                fs::copy(&path, to.join(&name)).unwrap();
            }
        }
    }

    /// `src` の保存先の半荘のフォルダから、記録の 4 つのファイル以外（events.jsonl・report.json・画像など）を、`dst` の保存先へ写す。
    fn copy_session_without_records(src: &Path, dst: &Path, id: &str) {
        copy_dir(
            &src.join("games").join(id),
            &dst.join("games").join(id),
            &RECORD_FILES,
        );
    }

    fn edited(base: &RecordsFile, edit: impl FnOnce(&mut Value)) -> String {
        let mut value = serde_json::to_value(base).unwrap();
        edit(&mut value);
        serde_json::to_string_pretty(&value).unwrap()
    }

    /// 動かすたびに数え、`fail_at` 回目だけ失敗する、ファイルの動かし方。
    fn failing_at(
        fail_at: usize,
        calls: &Cell<usize>,
    ) -> impl FnMut(&Path, &Path) -> io::Result<()> + '_ {
        move |from, to| {
            calls.set(calls.get() + 1);
            if calls.get() == fail_at {
                Err(io::Error::other("ここで失敗させた"))
            } else {
                fs::rename(from, to)
            }
        }
    }

    // ---- D-2: 往復 ----

    #[test]
    fn d2_every_kind_of_record_survives_export_wipe_import_unchanged() {
        let mut fx = fixture();
        let before = fx.state();
        let sessions_before = fx.store.session_records().unwrap();
        let exported = fx.export();
        // 入れた全種類が、ファイルの中身に入っている
        assert_eq!(exported.answers.len(), 4);
        assert_eq!(exported.daily_sets.len(), 1);
        assert_eq!(exported.weeks.len(), 2);
        assert_eq!(exported.sessions.len(), 2);
        let a = &exported.sessions[&fx.a];
        assert_eq!(a.links.marks.len(), 2);
        assert_eq!(a.links.marks["2"], "manual");
        assert_eq!(a.links.ratings_version, Some(3));
        assert_eq!(a.self_ratings.kyokus["k1h0"], SelfRating::Unrated);
        assert_eq!(a.maka.kyokus["k0h0"], "A-");
        assert_eq!(a.maka.hanchan.as_deref(), Some("B+"));
        // 解決した局面（D-6）: 判断の鍵ごとに、解決を入れた時刻
        assert_eq!(a.resolved.decisions.len(), 2);
        assert_eq!(a.resolved.decisions["k0h0e3"], T0 + 5_000);
        assert_eq!(a.resolved.decisions["k2h1e14"], T0 + 6_000);
        assert_eq!(a.memos.marks["1"].reason, "東を残したい");
        assert_eq!(a.memos.extras.len(), 3);
        assert!(a.memos.extras[0].decision.is_none() && a.memos.extras[0].position.is_some());
        assert_eq!(exported.settings.daily_count, 9);
        assert!(!exported.settings.doubt_only);

        // ファイルに書いて、読み戻す（ファイルを通っても、同じ）
        let text = to_text(&exported).unwrap();
        let reread = parse_records(text.as_bytes()).unwrap();
        assert_eq!(reread, exported);

        fx.wipe();
        assert_ne!(fx.state(), before, "消えている");
        assert!(fx.db.list_answers().unwrap().is_empty());
        assert!(fx
            .store
            .session_records()
            .unwrap()
            .values()
            .all(SessionRecords::is_empty));

        let report = fx.import(&reread).unwrap();
        assert_eq!(
            report,
            ImportReport {
                sessions: 2,
                answers: 4,
                held: 0
            }
        );
        // 保存先のファイル（半荘のフォルダの全部）と、答え・出題・週が、書き出す前と同じ
        assert_eq!(fx.state(), before);
        assert_eq!(fx.store.session_records().unwrap(), sessions_before);
        // もう一度書き出しても、同じ
        assert_eq!(fx.export(), exported);
        // 次に記録する答えの番号は、書き出す前と同じ続き
        let next = fx
            .db
            .record_answer(answer(&fx.b, "k0h0e9", AnswerMode::Quiz, T0 + 50_000))
            .unwrap();
        assert_eq!(next.id, 5);
        // 設定は、いまの設定に重ねると、書き出した設定になる（保存先と窓の位置は、いまのまま）
        let other = Settings {
            data_dir: PathBuf::from("D:\\elsewhere"),
            widget_position: None,
            ..Settings::default()
        };
        let applied = reread.settings.applied_to(&other);
        assert_eq!(applied.data_dir, PathBuf::from("D:\\elsewhere"));
        assert_eq!(applied.widget_position, None);
        assert_eq!(
            Settings {
                data_dir: fx.settings.data_dir.clone(),
                widget_position: fx.settings.widget_position,
                ..applied
            },
            fx.settings
        );
    }

    #[test]
    fn d2_the_file_lists_the_kinds_of_records_and_nothing_else() {
        let fx = fixture();
        let value: Value = serde_json::from_str(&fx.export_text()).unwrap();
        let keys_of = |v: &Value| -> Vec<String> {
            let mut keys: Vec<String> = v.as_object().unwrap().keys().cloned().collect();
            keys.sort_unstable();
            keys
        };
        assert_eq!(
            keys_of(&value),
            [
                "answers",
                "app_version",
                "daily_sets",
                "exported_at",
                "format",
                "sessions",
                "settings",
                "version",
                "weeks"
            ]
        );
        assert_eq!(value["format"], FORMAT_NAME);
        assert_eq!(value["version"], FORMAT_VERSION);
        assert_eq!(value["app_version"], env!("CARGO_PKG_VERSION"));
        assert_eq!(value["exported_at"], "2026-10-12T14:03:22+09:00");
        assert_eq!(
            keys_of(&value["settings"]),
            [
                "capture_keywords",
                "daily_count",
                "doubt_only",
                "highlight_dora",
                "orientation",
                "replay_keys",
                "replay_keys_revision",
                "show_all_mismatches",
                "sound",
                "trigger"
            ]
        );
        // 半荘ごとの項目は、5 種類の記録だけ（空の種類は書かない）
        for session in value["sessions"].as_object().unwrap().values() {
            for key in session.as_object().unwrap().keys() {
                assert!(
                    ["links", "self_ratings", "maka", "memos", "resolved"].contains(&key.as_str()),
                    "{key}"
                );
            }
        }
        assert!(value["sessions"][&fx.b].get("maka").is_none());
        assert!(value["sessions"][&fx.b].get("resolved").is_none());
        assert_eq!(
            value["sessions"][&fx.a]["resolved"],
            json!({"decisions": {"k0h0e3": T0 + 5_000, "k2h1e14": T0 + 6_000}})
        );
    }

    #[test]
    fn d2_screenshots_mortal_results_widget_records_ocr_and_machine_values_are_not_in_the_file() {
        let fx = fixture();
        let text = fx.export_text();
        // 結果・文字認識の写しの中身
        assert!(!text.contains(REPORT_SENTINEL));
        assert!(!text.contains(OCR_SENTINEL));
        // 画像のパス・ウィジェットの記録（events.jsonl）の項目
        for needle in [
            "screenshot",
            "marks/",
            "ratings/",
            ".png",
            "capture_error",
            "session_start",
            "t_ms",
            "events",
            "report",
            "ocr",
        ] {
            assert!(!text.contains(needle), "{needle} が入っている");
        }
        // この PC だけで意味を持つ設定
        assert!(!text.contains("data_dir"));
        assert!(!text.contains("widget_position"));
        assert!(!text.contains(&fx.data.to_string_lossy().replace('\\', "\\\\")));
        // 書き出しは、何も書き換えない
        let before = fx.state();
        let _ = fx.export_text();
        assert_eq!(fx.state(), before);
    }

    #[test]
    fn d2_sessions_in_the_trash_are_left_out_with_their_answers_and_come_back_when_restored() {
        let mut fx = fixture();
        let id_a = fx.a.clone();
        fx.store
            .delete_sessions(std::slice::from_ref(&id_a))
            .unwrap();
        let file = fx.export();
        assert!(!file.sessions.contains_key(&id_a));
        assert!(file.sessions.contains_key(&fx.b));
        assert!(file.answers.iter().all(|row| row.answer.session_id != id_a));
        assert_eq!(file.answers.len(), 1);
        assert_eq!(file.daily_sets.len(), 1);
        assert_eq!(file.daily_sets[0].items.len(), 1);
        assert_eq!(file.daily_sets[0].items[0].session_id, fx.b);
        assert!(!to_text(&file).unwrap().contains(&id_a));
        // 元に戻すと、また入る
        fx.store
            .restore_sessions(std::slice::from_ref(&id_a))
            .unwrap();
        let file = fx.export();
        assert!(file.sessions.contains_key(&id_a));
        assert_eq!(file.answers.len(), 4);
    }

    #[test]
    fn d2_the_overview_and_the_preview_count_sessions_answers_and_what_would_be_held() {
        let fx = fixture();
        let shown = overview(&fx.data, &fx.db, &fx.settings).unwrap();
        assert_eq!((shown.sessions, shown.answers), (2, 4));
        let bare = build_export(&fx.data, &fx.db, &fx.settings, "").unwrap();
        assert_eq!(shown.bytes, to_text(&bare).unwrap().len() as u64);
        let file = fx.export();
        assert_eq!(
            preview(&fx.data, &file).unwrap(),
            ImportPreview {
                sessions: 2,
                answers: 4,
                held: 0
            }
        );
        // 保存先に無い半荘が入ったファイル
        let mut other = file.clone();
        other
            .sessions
            .insert("20250101-000000".to_string(), SessionRecords::default());
        assert_eq!(
            preview(&fx.data, &other).unwrap(),
            ImportPreview {
                sessions: 3,
                answers: 4,
                held: 1
            }
        );
    }

    #[test]
    fn d2_exporting_to_a_path_writes_one_file_and_leaves_no_temporary_file() {
        let fx = fixture();
        let out = fx.tmp.path().join("out");
        fs::create_dir_all(&out).unwrap();
        let path = out.join("jantama-records-20261012.json");
        let report = export_to_path(
            &fx.data,
            &fx.db,
            &fx.settings,
            &path,
            "2026-10-12T14:03:22+09:00",
        )
        .unwrap();
        assert_eq!((report.sessions, report.answers), (2, 4));
        assert_eq!(report.bytes, fs::metadata(&path).unwrap().len());
        let names: Vec<String> = fs::read_dir(&out)
            .unwrap()
            .flatten()
            .map(|e| e.file_name().to_string_lossy().into_owned())
            .collect();
        assert_eq!(names, ["jantama-records-20261012.json"]);
        // 書いたファイルは、読み込める
        assert_eq!(read_records_file(&path).unwrap(), fx.export());
        // 書けない場所は、理由つきの失敗
        let error = export_to_path(
            &fx.data,
            &fx.db,
            &fx.settings,
            &out.join("missing-dir").join("x.json"),
            "",
        )
        .unwrap_err();
        assert!(matches!(error, RecordsError::Write(_)), "{error}");
    }

    // ---- D-2: 確かめる（正しくないファイルは、何も変えずに断る） ----

    #[test]
    fn d2_invalid_files_are_refused_with_a_reason_and_nothing_is_touched() {
        let mut fx = fixture();
        let base = fx.export();
        let a = fx.a.clone();
        let before = fx.state();
        let long_reason = "あ".repeat(81);

        let cases: Vec<(&str, String, &str)> = vec![
            ("JSON ではない", "これは記録ではない".to_string(), "JSON"),
            ("空", String::new(), "JSON"),
            (
                "途中で切れている",
                fx.export_text()[..200].to_string(),
                "JSON",
            ),
            (
                "種類が違う",
                edited(&base, |v| v["format"] = json!("other")),
                "種類",
            ),
            (
                "版が無い",
                edited(&base, |v| {
                    v.as_object_mut().unwrap().remove("version");
                }),
                "版",
            ),
            ("版が 0", edited(&base, |v| v["version"] = json!(0)), "版"),
            (
                "新しい版",
                edited(&base, |v| v["version"] = json!(2)),
                "新しい版",
            ),
            (
                "答えが配列ではない",
                edited(&base, |v| v["answers"] = json!({})),
                "形",
            ),
            (
                "項目が足りない",
                edited(&base, |v| {
                    v.as_object_mut().unwrap().remove("weeks");
                }),
                "形",
            ),
            (
                "判断の鍵が違う答え",
                edited(&base, |v| v["answers"][0]["decision_key"] = json!("bad")),
                "判断の鍵",
            ),
            (
                "答えの番号が重なる",
                edited(&base, |v| {
                    v["answers"][1]["id"] = v["answers"][0]["id"].clone();
                }),
                "重なって",
            ),
            (
                "間隔が 0 の答え",
                edited(&base, |v| v["answers"][0]["interval_days"] = json!(0)),
                "間隔",
            ),
            (
                "月曜ではない週",
                edited(&base, |v| v["weeks"][0]["week"] = json!("2026-10-06")),
                "月曜",
            ),
            (
                "同じ週が 2 つ",
                edited(&base, |v| {
                    v["weeks"][1]["week"] = v["weeks"][0]["week"].clone();
                }),
                "重なって",
            ),
            (
                "出題の日付が違う",
                edited(&base, |v| v["daily_sets"][0]["date"] = json!("10/12")),
                "日付",
            ),
            (
                "設定が範囲の外",
                edited(&base, |v| v["settings"]["daily_count"] = json!(0)),
                "設定",
            ),
            (
                "設定の型が違う",
                edited(&base, |v| v["settings"]["sound"] = json!("yes")),
                "形",
            ),
            (
                "迷いだけの型が違う",
                edited(&base, |v| v["settings"]["doubt_only"] = json!("yes")),
                "形",
            ),
            (
                "結びつけの値が ASCII ではない",
                edited(&base, |v| {
                    v["sessions"][a.as_str()]["links"]["marks"]["1"] = json!("全角");
                }),
                "結びつけ",
            ),
            (
                "結びつけの番号の形が違う",
                edited(&base, |v| {
                    let marks = v["sessions"][a.as_str()]["links"]["marks"]
                        .as_object_mut()
                        .unwrap();
                    let value = marks.remove("1").unwrap();
                    marks.insert("01".to_string(), value);
                }),
                "番号",
            ),
            (
                "局の鍵の形が違う",
                edited(&base, |v| {
                    let kyokus = v["sessions"][a.as_str()]["self_ratings"]["kyokus"]
                        .as_object_mut()
                        .unwrap();
                    let value = kyokus.remove("k0h0").unwrap();
                    kyokus.insert("x1".to_string(), value);
                }),
                "局の鍵",
            ),
            (
                "MAKA の段階が違う",
                edited(&base, |v| {
                    v["sessions"][a.as_str()]["maka"]["hanchan"] = json!("Z");
                }),
                "MAKA",
            ),
            (
                "解決の鍵の形が違う",
                edited(&base, |v| {
                    v["sessions"][a.as_str()]["resolved"]["decisions"]["bad"] = json!(1);
                }),
                "判断の鍵",
            ),
            (
                "解決の時刻が負",
                edited(&base, |v| {
                    v["sessions"][a.as_str()]["resolved"]["decisions"]["k0h0e3"] = json!(-1);
                }),
                "時刻",
            ),
            (
                "メモの理由が長すぎる",
                edited(&base, |v| {
                    v["sessions"][a.as_str()]["memos"]["marks"]["1"]["reason"] = json!(long_reason);
                }),
                "文字以内",
            ),
            (
                "メモの名前が重なる",
                edited(&base, |v| {
                    v["sessions"][a.as_str()]["memos"]["extras"][1]["id"] = json!("x1");
                }),
                "重なって",
            ),
            (
                "局面の無いメモ",
                edited(&base, |v| {
                    let extra = v["sessions"][a.as_str()]["memos"]["extras"][0]
                        .as_object_mut()
                        .unwrap();
                    extra.remove("position");
                }),
                "局面",
            ),
            (
                "半荘の名前に区切りが入っている",
                edited(&base, |v| {
                    let sessions = v["sessions"].as_object_mut().unwrap();
                    sessions.insert("..\\evil".to_string(), json!({}));
                }),
                "半荘の名前",
            ),
        ];

        let dir = fx.tmp.path().join("files");
        fs::create_dir_all(&dir).unwrap();
        for (index, (name, text, expect)) in cases.iter().enumerate() {
            let path = dir.join(format!("case-{index}.json"));
            fs::write(&path, text).unwrap();
            let error = read_records_file(&path).expect_err(name);
            let shown = error.to_string();
            assert!(shown.contains(expect), "{name}: {shown}");
            // 確かめるところで止まる。確かめただけでは、何も変わらない
            assert_eq!(fx.state(), before, "{name}");
            assert!(error
                .import_message()
                .contains("いまの記録は変わっていません"));
        }
        // 新しい版の文は、アプリを新しくするよう言う
        let newer =
            parse_records(edited(&base, |v| v["version"] = json!(2)).as_bytes()).unwrap_err();
        assert!(
            matches!(newer, RecordsError::NewerVersion { found: 2, .. }),
            "{newer}"
        );
        assert!(newer.to_string().contains("アプリを新しくしてください"));
        // 無いファイル・フォルダも、理由つき
        assert!(matches!(
            read_records_file(&dir.join("none.json")),
            Err(RecordsError::Read(_))
        ));
        assert!(matches!(
            read_records_file(&dir),
            Err(RecordsError::NotRecords(_))
        ));
        // 正しいファイルは、通る（ここまでで、何も変わっていない）
        assert_eq!(fx.import(&base).unwrap().answers, 4);
    }

    #[test]
    fn w15_doubt_only_goes_into_the_file_and_a_file_without_it_reads_as_on() {
        let fx = fixture();
        let base = fx.export();
        // 書き出した設定に、迷いだけが入っている（fixture は切）。読み戻しても同じ
        assert!(!base.settings.doubt_only);
        let text = to_text(&base).unwrap();
        let value: Value = serde_json::from_str(&text).unwrap();
        assert_eq!(value["settings"]["doubt_only"], json!(false));
        assert!(!parse_records(text.as_bytes()).unwrap().settings.doubt_only);
        // 入のとき
        let mut on = base.clone();
        on.settings.doubt_only = true;
        let reread = parse_records(to_text(&on).unwrap().as_bytes()).unwrap();
        assert!(reread.settings.doubt_only);
        // この項目が無い昔の書き出しは、断らずに、入（既定）として読む。ほかの設定は守る
        let old = edited(&base, |v| {
            v["settings"].as_object_mut().unwrap().remove("doubt_only");
        });
        let file = parse_records(old.as_bytes()).unwrap();
        assert!(file.settings.doubt_only);
        assert_eq!(file.settings.daily_count, base.settings.daily_count);
        assert!(!file.settings.sound);
        // 重ねると、いまの設定に入が入る（保存先と窓の位置は、いまのまま）
        let applied = file.settings.applied_to(&Settings::default());
        assert!(applied.doubt_only);
        assert_eq!(applied.validate(), Ok(()));
    }

    #[test]
    fn e49_an_old_export_with_removed_settings_and_key_actions_still_reads() {
        let fx = fixture();
        let base = fx.export();
        let old = edited(&base, |v| {
            let settings = v["settings"].as_object_mut().unwrap();
            settings.insert("disagreement_percent".into(), json!(10));
            settings.insert("contest_enabled".into(), json!(false));
            settings.insert("contest_gap_percent".into(), json!(35));
            settings.insert("contest_by_junme".into(), json!(false));
            settings.insert("contest_min_junme".into(), json!(9));
            settings.insert("contest_after_riichi".into(), json!(false));
            settings.insert("contest_two_calls".into(), json!(false));
            settings["replay_keys"]["prev_contest"] = json!("KeyH");
            settings["replay_keys"]["next_contest"] = json!("KeyL");
        });
        let file = parse_records(old.as_bytes()).unwrap();
        let restored = file.settings.applied_to(&Settings::default());
        assert!(!restored.replay_keys.contains_key("prev_contest"));
        assert!(!restored.replay_keys.contains_key("next_contest"));
        assert_eq!(restored.validate(), Ok(()));
        let next = serde_json::to_value(PortableSettings::from_settings(&restored)).unwrap();
        for removed in [
            "disagreement_percent",
            "contest_enabled",
            "contest_gap_percent",
            "contest_by_junme",
            "contest_min_junme",
            "contest_after_riichi",
            "contest_two_calls",
        ] {
            assert!(next.get(removed).is_none(), "{removed}");
        }
    }

    #[test]
    fn d2_a_byte_order_mark_and_unknown_fields_are_tolerated_and_text_is_normalized() {
        let fx = fixture();
        let base = fx.export();
        let text = edited(&base, |v| {
            v["future_field"] = json!({"x": 1});
            v["sessions"][fx.a.as_str()]["memos"]["marks"]["1"]["reason"] =
                json!("  東を残したい  ");
            v["sessions"][fx.a.as_str()]["memos"]["marks"]["2"] =
                json!({"candidates": " ", "reason": ""});
        });
        let mut bytes = vec![0xEF, 0xBB, 0xBF];
        bytes.extend_from_slice(text.as_bytes());
        let file = parse_records(&bytes).unwrap();
        // 前後の空白は取り、空のメモは持たない（ストアが保存するときと同じ形）
        let memos = &file.sessions[&fx.a].memos;
        assert_eq!(memos.marks["1"].reason, "東を残したい");
        assert!(!memos.marks.contains_key("2"));
        assert_eq!(file, base);
    }

    // ---- D-2: 途中で失敗したら、元のまま ----

    #[test]
    fn d2_a_failure_at_any_step_of_the_swap_leaves_every_old_record_in_place() {
        let mut fx = fixture();
        let exported = fx.export();
        // 書き出したあとに、記録を変える（読み込む内容と、いまの記録が違うように）
        fx.store.clear_memo(&fx.a, 1).unwrap();
        fx.store.set_maka_grade(&fx.a, "k2h0", "S").unwrap();
        fx.store.set_mark_link(&fx.b, 1, "k0h0e8").unwrap();
        fx.store.clear_maka_hanchan(&fx.a).unwrap();
        fx.db
            .record_answer(answer(&fx.b, "k5h0e5", AnswerMode::Quiz, T0 + 60_000))
            .unwrap();
        fx.db
            .set_week(WeekRecord {
                week: "2026-10-19".to_string(),
                stats: WeekStats::default(),
                focus: "あとから".to_string(),
            })
            .unwrap();
        let before = fx.state();

        let mut failed_steps = 0;
        for fail_at in 1.. {
            let calls = Cell::new(0);
            let mut rename = failing_at(fail_at, &calls);
            match import_records(&fx.data, &mut fx.db, &exported, &mut rename) {
                Ok(_) => break,
                Err(error) => {
                    assert!(
                        matches!(error, RecordsError::Swap { restored: true, .. }),
                        "{fail_at}: {error}"
                    );
                    assert!(error
                        .import_message()
                        .contains("いまの記録は変わっていません"));
                    // 半荘のフォルダの全部のファイル（途中の名前の残りが無いことも含む）・答え・出題・週が、元のまま
                    assert_eq!(fx.state(), before, "{fail_at} 回目の動かしで失敗");
                    failed_steps += 1;
                }
            }
        }
        assert!(failed_steps >= 8, "{failed_steps}");

        // 失敗させなかった回は、置き換わっている
        assert_ne!(fx.state(), before);
        assert_eq!(fx.export(), exported);
        assert!(
            !dir_snapshot(&fx.data)
                .keys()
                .any(|name| name.ends_with(NEW_SUFFIX) || name.ends_with(OLD_SUFFIX)),
            "途中の名前のファイルが残っていない"
        );
    }

    #[test]
    fn d2_a_failure_while_writing_the_new_files_changes_nothing_and_cleans_up() {
        let mut fx = fixture();
        let exported = fx.export();
        fx.store.set_maka_grade(&fx.a, "k2h0", "S").unwrap();
        let before = fx.state();
        // 半荘 a の 4 つ目のファイルの置き場に、同じ名前のフォルダがあって、書けない
        let blocker = fx
            .store
            .session_folder(&fx.a)
            .unwrap()
            .join(format!("memos.json{NEW_SUFFIX}"));
        fs::create_dir_all(&blocker).unwrap();
        let error = fx.import(&exported).unwrap_err();
        assert!(matches!(error, RecordsError::Write(_)), "{error}");
        fs::remove_dir(&blocker).unwrap();
        // 先に書いた新しいファイルも片づいていて、何も変わっていない
        assert_eq!(fx.state(), before);
    }

    #[test]
    fn d2_when_putting_the_files_back_also_fails_the_message_says_so() {
        let mut fx = fixture();
        let exported = fx.export();
        fx.store.set_maka_grade(&fx.a, "k2h0", "S").unwrap();
        // 3 回目の動かしで失敗し、そのあとの「戻す」の動かしも、1 つ失敗する
        let calls = Cell::new(0);
        let mut rename = |from: &Path, to: &Path| -> io::Result<()> {
            calls.set(calls.get() + 1);
            if calls.get() == 3 || calls.get() == 5 {
                Err(io::Error::other("失敗"))
            } else {
                fs::rename(from, to)
            }
        };
        let error = import_records(&fx.data, &mut fx.db, &exported, &mut rename).unwrap_err();
        assert!(
            matches!(
                error,
                RecordsError::Swap {
                    restored: false,
                    ..
                }
            ),
            "{error}"
        );
        assert!(error.import_message().contains("元に戻せなかった"));
        assert!(!error.import_message().contains("変わっていません"));
    }

    // ---- D-2: この保存先に無い半荘の記録は、フォルダが現れるまで取っておく ----

    #[test]
    fn d2_records_of_sessions_missing_here_are_held_and_applied_when_the_folder_appears() {
        let fx = fixture();
        let exported = fx.export();
        let originals = fx.store.session_records().unwrap();
        let files_a = dir_snapshot(&fx.data);

        // 新しい（空の）保存先。半荘 b のフォルダだけを写してある（a は無い）
        let tmp = tempfile::tempdir().unwrap();
        let other = tmp.path().join("other");
        let store = Store::open(&other).unwrap();
        let mut db = StudyDb::open(&other).unwrap();
        copy_session_without_records(&fx.data, &other, &fx.b);

        let shown = preview(&other, &exported).unwrap();
        assert_eq!(
            shown,
            ImportPreview {
                sessions: 2,
                answers: 4,
                held: 1
            }
        );
        let report = import_records(&other, &mut db, &exported, &mut real_rename).unwrap();
        assert_eq!(report, shown);

        // 写してあった半荘 b には、すぐ付く。無い半荘 a は、取っておく
        assert!(store
            .session_folder(&fx.b)
            .unwrap()
            .join("links.json")
            .is_file());
        assert!(!store.session_folder(&fx.a).unwrap().exists());
        let pending = store.pending_records();
        assert_eq!(pending.keys().collect::<Vec<_>>(), [&fx.a]);
        assert_eq!(pending[&fx.a], originals[&fx.a]);
        // 答えは、半荘が無くても、そのまま入っている（その半荘が現れるまで、出題などには出ない）
        assert_eq!(db.list_answers().unwrap().len(), 4);

        // 半荘 a のフォルダが半端な間（events.jsonl も report.json も無い）は、付けない
        let a_dir = other.join("games").join(&fx.a);
        fs::create_dir_all(&a_dir).unwrap();
        assert_eq!(store.list_sessions().unwrap().len(), 1);
        assert!(!a_dir.join("links.json").exists());
        assert!(store.pending_path().is_file());

        // フォルダの中身が入ったら、次に一覧を読んだときに付く（フォルダにあった、古い記録を置き換えて）
        copy_session_without_records(&fx.data, &other, &fx.a);
        fs::write(a_dir.join("maka.json"), r#"{"kyokus":{"k9h0":"E"}}"#).unwrap();
        let listed = store.list_sessions().unwrap();
        assert_eq!(listed.len(), 2);
        for id in [&fx.a, &fx.b] {
            let dir = other.join("games").join(id);
            for name in RECORD_FILES {
                let want = files_a.get(&format!("games/{id}/{name}"));
                let got = fs::read(dir.join(name)).ok();
                assert_eq!(got.as_ref(), want, "{id}/{name}");
            }
        }
        assert_eq!(store.session_records().unwrap(), originals);
        // 付けたら、取っておいた記録のファイルは消える
        assert!(!store.pending_path().exists());
        // 一覧に出る内容にも、付いている
        let listed_a = listed.iter().find(|s| s.id == fx.a).unwrap();
        assert_eq!(listed_a.memos.extras.len(), 3);
        assert_eq!(listed_a.maka.hanchan.as_deref(), Some("B+"));
        assert_eq!(listed_a.resolved.decisions.len(), 2);
    }

    #[test]
    fn d2_a_new_import_replaces_what_was_held_and_a_restored_trash_session_gets_its_records() {
        let mut fx = fixture();
        let exported = fx.export();
        let id_a = fx.a.clone();
        let originals = fx.store.session_records().unwrap();

        // 半荘 a がごみ箱にある間に読み込むと、a は「この保存先に無い」として取っておく
        fx.store
            .delete_sessions(std::slice::from_ref(&id_a))
            .unwrap();
        let report = fx.import(&exported).unwrap();
        assert_eq!(report.held, 1);
        assert_eq!(
            fx.store.pending_records().keys().collect::<Vec<_>>(),
            [&id_a]
        );
        // 戻すと、次に一覧を読んだときに付く（フォルダにある記録も、ファイルの内容になる）
        fx.store
            .restore_sessions(std::slice::from_ref(&id_a))
            .unwrap();
        fs::remove_file(fx.store.session_folder(&id_a).unwrap().join("memos.json")).unwrap();
        assert_ne!(fx.store.session_records().unwrap(), originals);
        fx.store.list_sessions().unwrap();
        assert_eq!(fx.store.session_records().unwrap(), originals);
        assert!(!fx.store.pending_path().exists());

        // 取っておいた記録は、あとの読み込みで、置き換わる
        fx.store
            .delete_sessions(std::slice::from_ref(&id_a))
            .unwrap();
        fx.import(&exported).unwrap();
        assert!(fx.store.pending_path().is_file());
        let mut without = exported.clone();
        without.sessions.remove(&id_a);
        let report = fx.import(&without).unwrap();
        assert_eq!(report.held, 0);
        assert!(!fx.store.pending_path().exists());
    }

    #[test]
    fn d2_importing_replaces_the_records_of_local_sessions_that_are_not_in_the_file() {
        let mut fx = fixture();
        let mut without = fx.export();
        without.sessions.remove(&fx.b);
        fx.import(&without).unwrap();
        let after = fx.store.session_records().unwrap();
        assert!(
            after[&fx.b].is_empty(),
            "ファイルに無い半荘の記録は、無くなる"
        );
        assert_eq!(after[&fx.a], without.sessions[&fx.a]);
        for name in RECORD_FILES {
            assert!(!fx.store.session_folder(&fx.b).unwrap().join(name).exists());
        }
        // 取り込んだ結果・文字認識の写し・画像・ウィジェットの記録は、そのまま
        let a_dir = fx.store.session_folder(&fx.a).unwrap();
        assert!(a_dir.join("report.json").is_file());
        assert!(a_dir.join("ocr.json").is_file());
        assert!(a_dir.join("events.jsonl").is_file());
        assert!(a_dir.join("marks").is_dir());
    }

    #[test]
    fn d2_held_records_that_are_not_valid_are_dropped_and_a_hand_made_name_never_leaves_the_folder()
    {
        let fx = fixture();
        let pending = PendingRecords {
            version: PENDING_VERSION,
            sessions: BTreeMap::from([
                (
                    "20250101-000000".to_string(),
                    SessionRecords {
                        maka: Maka {
                            hanchan: Some("Z".to_string()),
                            ..Default::default()
                        },
                        ..Default::default()
                    },
                ),
                ("..".to_string(), SessionRecords::default()),
            ]),
        };
        fs::write(
            fx.store.pending_path(),
            serde_json::to_string(&pending).unwrap(),
        )
        .unwrap();
        // 正しくない記録の半荘のフォルダが現れても、付けずに捨てる。名前の形が違うものは、触らない
        let dir = fx.data.join("games").join("20250101-000000");
        fs::create_dir_all(&dir).unwrap();
        fs::write(dir.join("events.jsonl"), "").unwrap();
        assert_eq!(fx.store.apply_pending_records().unwrap(), 0);
        assert!(!dir.join("maka.json").exists());
        let left = fx.store.pending_records();
        assert_eq!(left.keys().collect::<Vec<_>>(), [".."]);
    }
}
