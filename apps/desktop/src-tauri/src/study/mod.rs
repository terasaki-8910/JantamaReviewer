//! 答え・解き直しの予定・今日の出題を置く SQLite（D-3、SPEC 6章）。
//!
//! 保存先の `study.sqlite` に置く。検討画面だけが使う（出題・解き直し・答え合わせ）。ウィジェット・ボタンを拾う部分・補助プログラムは、
//! ここを使わない（`tests/safety.rs` が、SQLite の部品をこの `study` の中だけに限っていることを確かめる）。
//! 日付の計算（今日・次の解き直しの日）は、画面側（エンジンの `studyDate`・`scheduleReview`）が決めた値を、そのまま置くだけ。
//!
//! - `answers`: 答え 1 件ごとの行。出題（quiz）と解き直し（review）の両方。答えた問題ごとに、最後の答えの `interval_days`・
//!   `due_date` が、次の解き直しの予定になる
//! - `daily_sets`: 日ごとの今日の出題の組（日付・順番・半荘の名前・判断の鍵）。その日の組は、作ったら入れ替えない
//!
//! 表の作りは `PRAGMA user_version` で版を持つ。新しい版のアプリが作ったファイルは、読まずにエラーにする（壊さないため）。
//! 消した半荘は、アプリを閉じるとき（落ちたときは次の起動のとき）に、答えと予定も消す（`forget_sessions`。`trash.rs` が呼ぶ）。
//! 消した半荘を置き場に置いている間は、行をそのまま残す（元に戻せば、答えも戻る）。

pub mod commands;

use std::fmt;
use std::path::{Path, PathBuf};
use std::time::Duration;

use rusqlite::{params, params_from_iter, Connection, OptionalExtension};
use serde::{Deserialize, Serialize};
use serde_json::Value;

use crate::store::{ensure_outside_git, StoreError};

/// 答えを置くファイルの名前（保存先の直下）。
pub const STUDY_FILE: &str = "study.sqlite";

/// 表の作りの版。
pub const SCHEMA_VERSION: i64 = 1;

/// 差の原因（U-20）。画面の 5 つのチェックボックスの値。
pub const CAUSES: [&str; 5] = ["ukeire", "shape", "value", "defense", "other"];

/// 文字の欄（理由・学んだ原則）の長さの上限（文字数）。
const TEXT_LIMIT: usize = 400;

/// 別の接続が書いているとき（置き場の片づけと、画面の保存が重なったとき）に待つ時間。
const BUSY_WAIT: Duration = Duration::from_secs(5);

#[derive(Debug)]
pub enum StudyError {
    /// 保存先が Git のリポジトリの中（D-1）。
    Store(StoreError),
    /// 値が正しくない（理由を含む）。
    Invalid(String),
    /// 新しい版のアプリが作ったファイル（この版では読まない）。
    NewerVersion {
        found: i64,
        supported: i64,
    },
    /// 更新する答えが無い。
    UnknownAnswer(i64),
    Sqlite(rusqlite::Error),
    Io(std::io::Error),
}

impl fmt::Display for StudyError {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        match self {
            StudyError::Store(e) => write!(f, "{e}"),
            StudyError::Invalid(reason) => write!(f, "答えの記録の値が正しくありません: {reason}"),
            StudyError::NewerVersion { found, supported } => write!(
                f,
                "答えのファイルは、新しい版のアプリで作られています（版 {found}。この版は {supported} まで）。アプリを新しくしてください。"
            ),
            StudyError::UnknownAnswer(id) => write!(f, "答えが見つかりません: {id}"),
            StudyError::Sqlite(e) => write!(f, "答えのファイルを扱えませんでした: {e}"),
            StudyError::Io(e) => write!(f, "答えのファイルを開けませんでした: {e}"),
        }
    }
}

impl std::error::Error for StudyError {}

impl From<rusqlite::Error> for StudyError {
    fn from(e: rusqlite::Error) -> Self {
        StudyError::Sqlite(e)
    }
}

impl From<std::io::Error> for StudyError {
    fn from(e: std::io::Error) -> Self {
        StudyError::Io(e)
    }
}

impl From<StoreError> for StudyError {
    fn from(e: StoreError) -> Self {
        StudyError::Store(e)
    }
}

/// 答えの種類。出題（今日の出題）か、解き直しか。
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum AnswerMode {
    Quiz,
    Review,
}

impl AnswerMode {
    fn as_str(self) -> &'static str {
        match self {
            AnswerMode::Quiz => "quiz",
            AnswerMode::Review => "review",
        }
    }

    fn parse(text: &str) -> Option<AnswerMode> {
        match text {
            "quiz" => Some(AnswerMode::Quiz),
            "review" => Some(AnswerMode::Review),
            _ => None,
        }
    }
}

/// 答え合わせをするときに記録する答え。
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
pub struct NewAnswer {
    /// 半荘の名前（フォルダの名前）。
    pub session_id: String,
    /// 判断の鍵（エンジンの `decisionKey`。例: k2h1e14）。
    pub decision_key: String,
    pub mode: AnswerMode,
    /// 問題を見せた時刻（ミリ秒）。
    pub shown_at: i64,
    /// 答え合わせを押した時刻（ミリ秒）。
    pub answered_at: i64,
    /// 選んだ答え（JSON。打牌なら `{"type":"dahai","tile":"1s"}`、ボタンなら `{"type":"option","id":"pon"}`）。
    pub choice: Value,
    /// 理由（1 行。必須）。
    pub reason: String,
    /// 答えるまでの時間（ミリ秒）。
    pub duration_ms: i64,
    /// 選び直した回数（一度選んだ牌や行動を変えた回数。R8-6）。
    pub reselect_count: u32,
    /// 正解か（AI がその行動に付けた確率が基準以上）。
    pub correct: bool,
    /// 差の原因（`CAUSES` のいくつか）。答え合わせのあとに付ける。
    #[serde(default)]
    pub causes: Vec<String>,
    /// 学んだ原則（1 行）。答え合わせのあとに書く。
    #[serde(default)]
    pub principle: String,
    /// MAKA が推した打牌（任意。牌の表記）。
    #[serde(default)]
    pub maka_move: Option<String>,
    /// この答えのあとの、次の解き直しまでの間隔（日）。
    pub interval_days: u32,
    /// 次に解き直す日（YYYY-MM-DD。画面側が、午前 4 時までを前の日として数えた日付から決める）。
    pub due_date: String,
}

/// 記録した答え（`NewAnswer` に番号が付いたもの）。
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
pub struct AnswerRow {
    pub id: i64,
    #[serde(flatten)]
    pub answer: NewAnswer,
}

/// 答え合わせのあとに直す欄（差の原因・学んだ原則・MAKA の打牌）。3 つとも、いまの値をそのまま渡す。
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
pub struct AnswerNotes {
    pub causes: Vec<String>,
    pub principle: String,
    pub maka_move: Option<String>,
}

/// 問題 1 つ（半荘の名前と、判断の鍵）。今日の出題の組の要素。
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct ProblemRef {
    pub session_id: String,
    pub decision_key: String,
}

/// 半荘の名前の形（英数字と `-` だけ）。
fn valid_session_id(id: &str) -> bool {
    !id.is_empty() && id.len() <= 64 && id.bytes().all(|b| b.is_ascii_alphanumeric() || b == b'-')
}

/// 判断の鍵の形（`k<数>h<数>e<数>`）。
fn valid_decision_key(key: &str) -> bool {
    let Some(rest) = key.strip_prefix('k') else {
        return false;
    };
    let Some((kyoku, rest)) = rest.split_once('h') else {
        return false;
    };
    let Some((honba, entry)) = rest.split_once('e') else {
        return false;
    };
    [kyoku, honba, entry]
        .iter()
        .all(|part| !part.is_empty() && part.len() <= 6 && part.bytes().all(|b| b.is_ascii_digit()))
}

/// 牌の表記（mjai。1m〜9s・東南西北白發中・赤五 5mr 5pr 5sr）。
fn valid_tile(tile: &str) -> bool {
    matches!(
        tile,
        "E" | "S" | "W" | "N" | "P" | "F" | "C" | "5mr" | "5pr" | "5sr"
    ) || (tile.len() == 2
        && tile.as_bytes()[0].is_ascii_digit()
        && tile.as_bytes()[0] != b'0'
        && matches!(tile.as_bytes()[1], b'm' | b'p' | b's'))
}

/// 暦の日付（YYYY-MM-DD）の形。月と日が、ありえる範囲か（実在の日かまでは見ない）。
fn valid_date(date: &str) -> bool {
    let bytes = date.as_bytes();
    if bytes.len() != 10 || bytes[4] != b'-' || bytes[7] != b'-' {
        return false;
    }
    let digits = |range: std::ops::Range<usize>| -> Option<u32> {
        date.get(range)
            .filter(|s| s.bytes().all(|b| b.is_ascii_digit()))
            .and_then(|s| s.parse().ok())
    };
    let (Some(year), Some(month), Some(day)) = (digits(0..4), digits(5..7), digits(8..10)) else {
        return false;
    };
    year >= 2000 && (1..=12).contains(&month) && (1..=31).contains(&day)
}

fn invalid(reason: impl Into<String>) -> StudyError {
    StudyError::Invalid(reason.into())
}

fn check_causes(causes: &[String]) -> Result<(), StudyError> {
    for (index, cause) in causes.iter().enumerate() {
        if !CAUSES.contains(&cause.as_str()) {
            return Err(invalid(format!("差の原因が知らない値です: {cause}")));
        }
        if causes[..index].contains(cause) {
            return Err(invalid(format!("差の原因が重なっています: {cause}")));
        }
    }
    Ok(())
}

fn check_notes(principle: &str, maka_move: Option<&str>) -> Result<(), StudyError> {
    if principle.chars().count() > TEXT_LIMIT {
        return Err(invalid("学んだ原則が長すぎます"));
    }
    if let Some(tile) = maka_move {
        if !valid_tile(tile) {
            return Err(invalid(format!(
                "MAKA の打牌が牌の表記ではありません: {tile}"
            )));
        }
    }
    Ok(())
}

/// 記録する答えの値を確かめる。
fn validate(answer: &NewAnswer) -> Result<(), StudyError> {
    if !valid_session_id(&answer.session_id) {
        return Err(invalid(format!(
            "半荘の名前の形が違います: {}",
            answer.session_id
        )));
    }
    if !valid_decision_key(&answer.decision_key) {
        return Err(invalid(format!(
            "判断の鍵の形が違います: {}",
            answer.decision_key
        )));
    }
    if answer.reason.trim().is_empty() {
        return Err(invalid("理由が空です"));
    }
    if answer.reason.chars().count() > TEXT_LIMIT {
        return Err(invalid("理由が長すぎます"));
    }
    if !answer.choice.is_object() || !answer.choice.get("type").is_some_and(Value::is_string) {
        return Err(invalid("選んだ答えの形が違います"));
    }
    if answer.shown_at < 0 || answer.answered_at < 0 || answer.duration_ms < 0 {
        return Err(invalid("時刻と時間は 0 以上です"));
    }
    if answer.interval_days == 0 || answer.interval_days > 3650 {
        return Err(invalid("間隔は 1 日から 3650 日です"));
    }
    if !valid_date(&answer.due_date) {
        return Err(invalid(format!(
            "期限の日付の形が違います: {}",
            answer.due_date
        )));
    }
    check_causes(&answer.causes)?;
    check_notes(&answer.principle, answer.maka_move.as_deref())
}

/// 答えのファイルの場所。
pub fn study_path(data_dir: &Path) -> PathBuf {
    data_dir.join(STUDY_FILE)
}

pub struct StudyDb {
    conn: Connection,
}

impl StudyDb {
    /// 保存先の `study.sqlite` を開く（無ければ作る）。保存先がリポジトリの中なら拒む（D-1）。
    /// 新しい版のアプリが作ったファイルは、開かない。
    pub fn open(data_dir: &Path) -> Result<StudyDb, StudyError> {
        ensure_outside_git(data_dir)?;
        std::fs::create_dir_all(data_dir)?;
        let conn = Connection::open(study_path(data_dir))?;
        StudyDb::prepare(conn)
    }

    fn prepare(conn: Connection) -> Result<StudyDb, StudyError> {
        conn.busy_timeout(BUSY_WAIT)?;
        let version: i64 = conn.pragma_query_value(None, "user_version", |row| row.get(0))?;
        if version > SCHEMA_VERSION {
            return Err(StudyError::NewerVersion {
                found: version,
                supported: SCHEMA_VERSION,
            });
        }
        if version < 1 {
            // 版 1: 答えと、日ごとの今日の出題。途中で止まっても、半端な表が残らないよう、1 つの取引で作る。
            conn.execute_batch(
                "BEGIN;
                 CREATE TABLE IF NOT EXISTS answers (
                   id INTEGER PRIMARY KEY AUTOINCREMENT,
                   session_id TEXT NOT NULL,
                   decision_key TEXT NOT NULL,
                   mode TEXT NOT NULL CHECK (mode IN ('quiz', 'review')),
                   shown_at INTEGER NOT NULL,
                   answered_at INTEGER NOT NULL,
                   choice TEXT NOT NULL,
                   reason TEXT NOT NULL,
                   duration_ms INTEGER NOT NULL,
                   reselect_count INTEGER NOT NULL,
                   correct INTEGER NOT NULL CHECK (correct IN (0, 1)),
                   causes TEXT NOT NULL DEFAULT '[]',
                   principle TEXT NOT NULL DEFAULT '',
                   maka_move TEXT,
                   interval_days INTEGER NOT NULL,
                   due_date TEXT NOT NULL
                 );
                 CREATE INDEX IF NOT EXISTS answers_problem ON answers (session_id, decision_key);
                 CREATE INDEX IF NOT EXISTS answers_due ON answers (due_date);
                 CREATE TABLE IF NOT EXISTS daily_sets (
                   date TEXT NOT NULL,
                   position INTEGER NOT NULL,
                   session_id TEXT NOT NULL,
                   decision_key TEXT NOT NULL,
                   PRIMARY KEY (date, position)
                 );
                 PRAGMA user_version = 1;
                 COMMIT;",
            )?;
        }
        Ok(StudyDb { conn })
    }

    /// 表の作りの版。
    pub fn schema_version(&self) -> Result<i64, StudyError> {
        Ok(self
            .conn
            .pragma_query_value(None, "user_version", |row| row.get(0))?)
    }

    /// 答えを記録する。番号を付けた行を返す。
    pub fn record_answer(&mut self, answer: NewAnswer) -> Result<AnswerRow, StudyError> {
        validate(&answer)?;
        let choice = serde_json::to_string(&answer.choice).map_err(|e| invalid(e.to_string()))?;
        let causes = serde_json::to_string(&answer.causes).map_err(|e| invalid(e.to_string()))?;
        self.conn.execute(
            "INSERT INTO answers (session_id, decision_key, mode, shown_at, answered_at, choice, reason,
               duration_ms, reselect_count, correct, causes, principle, maka_move, interval_days, due_date)
             VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?9, ?10, ?11, ?12, ?13, ?14, ?15)",
            params![
                answer.session_id,
                answer.decision_key,
                answer.mode.as_str(),
                answer.shown_at,
                answer.answered_at,
                choice,
                answer.reason.trim(),
                answer.duration_ms,
                answer.reselect_count,
                i32::from(answer.correct),
                causes,
                answer.principle,
                answer.maka_move,
                answer.interval_days,
                answer.due_date,
            ],
        )?;
        let id = self.conn.last_insert_rowid();
        self.answer(id)
    }

    /// 番号の答え。
    pub fn answer(&self, id: i64) -> Result<AnswerRow, StudyError> {
        self.conn
            .query_row(
                &format!("{SELECT_ANSWER} WHERE id = ?1"),
                params![id],
                row_to_answer,
            )
            .optional()?
            .ok_or(StudyError::UnknownAnswer(id))
    }

    /// 答え合わせのあとに直す欄（差の原因・学んだ原則・MAKA の打牌）を置き換える。直した行を返す。
    pub fn update_notes(&mut self, id: i64, notes: AnswerNotes) -> Result<AnswerRow, StudyError> {
        check_causes(&notes.causes)?;
        check_notes(&notes.principle, notes.maka_move.as_deref())?;
        let causes = serde_json::to_string(&notes.causes).map_err(|e| invalid(e.to_string()))?;
        let changed = self.conn.execute(
            "UPDATE answers SET causes = ?2, principle = ?3, maka_move = ?4 WHERE id = ?1",
            params![id, causes, notes.principle, notes.maka_move],
        )?;
        if changed == 0 {
            return Err(StudyError::UnknownAnswer(id));
        }
        self.answer(id)
    }

    /// すべての答え（答えた順）。
    pub fn list_answers(&self) -> Result<Vec<AnswerRow>, StudyError> {
        let mut statement = self
            .conn
            .prepare(&format!("{SELECT_ANSWER} ORDER BY answered_at, id"))?;
        let rows = statement.query_map([], row_to_answer)?;
        Ok(rows.collect::<Result<Vec<_>, _>>()?)
    }

    /// 日付の今日の出題の組。まだ作っていなければ `None`。
    pub fn daily_set(&self, date: &str) -> Result<Option<Vec<ProblemRef>>, StudyError> {
        if !valid_date(date) {
            return Err(invalid(format!("日付の形が違います: {date}")));
        }
        let mut statement = self.conn.prepare(
            "SELECT session_id, decision_key FROM daily_sets WHERE date = ?1 ORDER BY position",
        )?;
        let items = statement
            .query_map(params![date], |row| {
                Ok(ProblemRef {
                    session_id: row.get(0)?,
                    decision_key: row.get(1)?,
                })
            })?
            .collect::<Result<Vec<_>, _>>()?;
        Ok(if items.is_empty() { None } else { Some(items) })
    }

    /// その日の今日の出題の組を作る。その日の組がすでにあれば、入れ替えずに、あるものを返す（その日のうちは入れ替えない。E-24）。
    /// 組が空なら、何も作らない（問題が増えたあとで、その日の組を作れるように）。いまの組（作ったもの、または元からあるもの）を返す。
    pub fn save_daily_set(
        &mut self,
        date: &str,
        items: &[ProblemRef],
    ) -> Result<Vec<ProblemRef>, StudyError> {
        if let Some(existing) = self.daily_set(date)? {
            return Ok(existing);
        }
        for item in items {
            if !valid_session_id(&item.session_id) || !valid_decision_key(&item.decision_key) {
                return Err(invalid("今日の出題の問題の形が違います"));
            }
        }
        if items.is_empty() {
            return Ok(Vec::new());
        }
        let tx = self.conn.transaction()?;
        {
            let mut insert = tx.prepare(
                "INSERT OR IGNORE INTO daily_sets (date, position, session_id, decision_key)
                 VALUES (?1, ?2, ?3, ?4)",
            )?;
            for (position, item) in items.iter().enumerate() {
                insert.execute(params![
                    date,
                    position as i64,
                    item.session_id,
                    item.decision_key
                ])?;
            }
        }
        tx.commit()?;
        Ok(self.daily_set(date)?.unwrap_or_default())
    }

    /// 半荘ごとの、答えた問題の数（同じ問題を何度答えても 1 問）。答えの無い半荘は 0。渡した順。
    pub fn solved_counts(&self, session_ids: &[String]) -> Result<Vec<(String, u32)>, StudyError> {
        let mut statement = self
            .conn
            .prepare("SELECT COUNT(DISTINCT decision_key) FROM answers WHERE session_id = ?1")?;
        let mut counts = Vec::with_capacity(session_ids.len());
        for id in session_ids {
            let count: u32 = statement.query_row(params![id], |row| row.get(0))?;
            counts.push((id.clone(), count));
        }
        Ok(counts)
    }

    /// 半荘の答えと、今日の出題の組の行を消す。消した行の数（答え、組）を返す。
    pub fn forget_sessions(
        &mut self,
        session_ids: &[String],
    ) -> Result<(usize, usize), StudyError> {
        if session_ids.is_empty() {
            return Ok((0, 0));
        }
        let tx = self.conn.transaction()?;
        let placeholders = vec!["?"; session_ids.len()].join(", ");
        let answers = tx.execute(
            &format!("DELETE FROM answers WHERE session_id IN ({placeholders})"),
            params_from_iter(session_ids.iter()),
        )?;
        let sets = tx.execute(
            &format!("DELETE FROM daily_sets WHERE session_id IN ({placeholders})"),
            params_from_iter(session_ids.iter()),
        )?;
        tx.commit()?;
        Ok((answers, sets))
    }
}

const SELECT_ANSWER: &str = "SELECT id, session_id, decision_key, mode, shown_at, answered_at, choice, reason,
   duration_ms, reselect_count, correct, causes, principle, maka_move, interval_days, due_date FROM answers";

fn row_to_answer(row: &rusqlite::Row<'_>) -> rusqlite::Result<AnswerRow> {
    let corrupt = |column: usize, what: &str| {
        rusqlite::Error::FromSqlConversionFailure(
            column,
            rusqlite::types::Type::Text,
            what.to_string().into(),
        )
    };
    let mode_text: String = row.get(3)?;
    let choice_text: String = row.get(6)?;
    let causes_text: String = row.get(11)?;
    Ok(AnswerRow {
        id: row.get(0)?,
        answer: NewAnswer {
            session_id: row.get(1)?,
            decision_key: row.get(2)?,
            mode: AnswerMode::parse(&mode_text)
                .ok_or_else(|| corrupt(3, "答えの種類が読めません"))?,
            shown_at: row.get(4)?,
            answered_at: row.get(5)?,
            choice: serde_json::from_str(&choice_text)
                .map_err(|_| corrupt(6, "選んだ答えが読めません"))?,
            reason: row.get(7)?,
            duration_ms: row.get(8)?,
            reselect_count: row.get(9)?,
            correct: row.get::<_, i32>(10)? != 0,
            causes: serde_json::from_str(&causes_text)
                .map_err(|_| corrupt(11, "差の原因が読めません"))?,
            principle: row.get(12)?,
            maka_move: row.get(13)?,
            interval_days: row.get(14)?,
            due_date: row.get(15)?,
        },
    })
}

/// 消した半荘（ごみ箱へ送ったもの）の答えと予定を、保存先の `study.sqlite` から消す（D-3）。
/// ファイルがまだ無ければ、何もしない（ファイルを作らない）。
pub fn forget_sessions(data_dir: &Path, session_ids: &[String]) -> Result<(), StudyError> {
    let session_ids: Vec<String> = session_ids
        .iter()
        .filter(|id| valid_session_id(id))
        .cloned()
        .collect();
    if session_ids.is_empty() {
        return Ok(());
    }
    let path = match std::path::absolute(study_path(data_dir)) {
        Ok(path) => path,
        Err(e) => return Err(StudyError::Io(e)),
    };
    if !path.is_file() {
        return Ok(());
    }
    let mut db = StudyDb::prepare(Connection::open(path)?)?;
    db.forget_sessions(&session_ids)?;
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;

    fn sample(session: &str, key: &str, answered_at: i64) -> NewAnswer {
        NewAnswer {
            session_id: session.to_string(),
            decision_key: key.to_string(),
            mode: AnswerMode::Quiz,
            shown_at: (answered_at - 38_000).max(0),
            answered_at,
            choice: json!({"type": "dahai", "tile": "1s"}),
            reason: "孤立の1sを切り、受け入れを広く".to_string(),
            duration_ms: 38_000,
            reselect_count: 0,
            correct: false,
            causes: Vec::new(),
            principle: String::new(),
            maka_move: None,
            interval_days: 1,
            due_date: "2026-10-10".to_string(),
        }
    }

    fn open() -> (tempfile::TempDir, PathBuf, StudyDb) {
        let tmp = tempfile::tempdir().unwrap();
        let data = tmp.path().join("data");
        let db = StudyDb::open(&data).unwrap();
        (tmp, data, db)
    }

    #[test]
    fn d3_the_file_is_created_in_the_data_dir_with_a_versioned_schema() {
        let (_tmp, data, db) = open();
        assert!(study_path(&data).is_file());
        assert_eq!(db.schema_version().unwrap(), SCHEMA_VERSION);
        assert_eq!(db.list_answers().unwrap(), Vec::new());
        assert_eq!(db.daily_set("2026-10-09").unwrap(), None);
    }

    #[test]
    fn d3_answers_and_the_days_set_survive_closing_and_opening_again() {
        let (_tmp, data, mut db) = open();
        let mut a = sample("20261009-190953", "k2h1e14", 1_000_000);
        a.causes = vec!["ukeire".to_string(), "value".to_string()];
        a.principle = "ドラは先に切らない".to_string();
        a.maka_move = Some("5pr".to_string());
        let row = db.record_answer(a.clone()).unwrap();
        db.save_daily_set(
            "2026-10-09",
            &[ProblemRef {
                session_id: "20261009-190953".to_string(),
                decision_key: "k2h1e14".to_string(),
            }],
        )
        .unwrap();
        drop(db);

        let db = StudyDb::open(&data).unwrap();
        assert_eq!(db.list_answers().unwrap(), vec![row.clone()]);
        assert_eq!(row.answer, a);
        assert_eq!(db.answer(row.id).unwrap(), row);
        assert_eq!(
            db.daily_set("2026-10-09").unwrap().unwrap()[0].decision_key,
            "k2h1e14"
        );
    }

    #[test]
    fn u16_every_field_of_an_answer_is_saved_as_given() {
        let (_tmp, _data, mut db) = open();
        let mut a = sample("20261009-190953", "k0h0e4", 5_000);
        a.mode = AnswerMode::Review;
        a.choice = json!({"type": "option", "id": "chi:4s+5s"});
        a.reselect_count = 2;
        a.correct = true;
        a.interval_days = 7;
        a.due_date = "2026-10-16".to_string();
        let row = db.record_answer(a.clone()).unwrap();
        let read = db.answer(row.id).unwrap();
        assert_eq!(read.answer, a);
        assert!(row.id > 0);
        // 続けて記録した答えは、番号が増え、答えた順に並ぶ
        let later = db
            .record_answer(sample("20261009-190953", "k0h0e4", 9_000))
            .unwrap();
        assert!(later.id > row.id);
        let earlier = db
            .record_answer(sample("20261009-190953", "k1h0e1", 7_000))
            .unwrap();
        let order: Vec<i64> = db.list_answers().unwrap().iter().map(|r| r.id).collect();
        assert_eq!(order, vec![row.id, earlier.id, later.id]);
    }

    #[test]
    fn u20_causes_the_principle_and_the_maka_move_can_be_replaced_after_the_reveal() {
        let (_tmp, _data, mut db) = open();
        let row = db
            .record_answer(sample("20261009-190953", "k2h1e14", 1_000))
            .unwrap();
        let updated = db
            .update_notes(
                row.id,
                AnswerNotes {
                    causes: vec!["value".to_string(), "defense".to_string()],
                    principle: "リーチに無筋は切らない".to_string(),
                    maka_move: Some("3m".to_string()),
                },
            )
            .unwrap();
        assert_eq!(updated.answer.causes, vec!["value", "defense"]);
        assert_eq!(updated.answer.principle, "リーチに無筋は切らない");
        assert_eq!(updated.answer.maka_move.as_deref(), Some("3m"));
        // 答えそのものは変わらない
        assert_eq!(updated.answer.reason, row.answer.reason);
        assert_eq!(updated.answer.choice, row.answer.choice);
        // 取り消し（Ctrl+Z）は、前の値で置き換える
        let undone = db
            .update_notes(
                row.id,
                AnswerNotes {
                    causes: Vec::new(),
                    principle: "リーチに無筋は切らない".to_string(),
                    maka_move: None,
                },
            )
            .unwrap();
        assert!(undone.answer.causes.is_empty());
        assert_eq!(undone.answer.maka_move, None);
        assert!(matches!(
            db.update_notes(
                999,
                AnswerNotes {
                    causes: Vec::new(),
                    principle: String::new(),
                    maka_move: None
                }
            ),
            Err(StudyError::UnknownAnswer(999))
        ));
    }

    #[test]
    fn d3_values_that_are_not_valid_are_refused_and_nothing_is_saved() {
        let (_tmp, _data, mut db) = open();
        let base = sample("20261009-190953", "k2h1e14", 1_000);
        let cases: Vec<(&str, NewAnswer)> = vec![
            (
                "理由が空",
                NewAnswer {
                    reason: "  ".to_string(),
                    ..base.clone()
                },
            ),
            (
                "半荘の名前",
                NewAnswer {
                    session_id: "../x".to_string(),
                    ..base.clone()
                },
            ),
            (
                "判断の鍵",
                NewAnswer {
                    decision_key: "k1h1".to_string(),
                    ..base.clone()
                },
            ),
            (
                "選んだ答え",
                NewAnswer {
                    choice: json!("1s"),
                    ..base.clone()
                },
            ),
            (
                "間隔 0",
                NewAnswer {
                    interval_days: 0,
                    ..base.clone()
                },
            ),
            (
                "期限",
                NewAnswer {
                    due_date: "2026/10/10".to_string(),
                    ..base.clone()
                },
            ),
            (
                "期限の月",
                NewAnswer {
                    due_date: "2026-13-10".to_string(),
                    ..base.clone()
                },
            ),
            (
                "原因",
                NewAnswer {
                    causes: vec!["nothing".to_string()],
                    ..base.clone()
                },
            ),
            (
                "原因の重なり",
                NewAnswer {
                    causes: vec!["ukeire".to_string(), "ukeire".to_string()],
                    ..base.clone()
                },
            ),
            (
                "MAKA の牌",
                NewAnswer {
                    maka_move: Some("0m".to_string()),
                    ..base.clone()
                },
            ),
            (
                "時間",
                NewAnswer {
                    duration_ms: -1,
                    ..base.clone()
                },
            ),
        ];
        for (label, answer) in cases {
            assert!(
                matches!(db.record_answer(answer), Err(StudyError::Invalid(_))),
                "{label} を断る"
            );
        }
        assert_eq!(db.list_answers().unwrap(), Vec::new());
    }

    #[test]
    fn e24_the_days_set_is_made_once_and_then_stays_the_same_that_day() {
        let (_tmp, _data, mut db) = open();
        let item = |key: &str| ProblemRef {
            session_id: "20261009-190953".to_string(),
            decision_key: key.to_string(),
        };
        // 空の組は作らない（問題が増えたあとで作れるように）
        assert_eq!(db.save_daily_set("2026-10-09", &[]).unwrap(), Vec::new());
        assert_eq!(db.daily_set("2026-10-09").unwrap(), None);

        let first = db
            .save_daily_set(
                "2026-10-09",
                &[item("k0h0e4"), item("k1h0e12"), item("k2h1e6")],
            )
            .unwrap();
        assert_eq!(first.len(), 3);
        // 同じ日に、別の組を保存しても、入れ替えない（あるものを返す）
        let again = db
            .save_daily_set("2026-10-09", &[item("k9h9e9"), item("k8h8e8")])
            .unwrap();
        assert_eq!(again, first);
        assert_eq!(db.daily_set("2026-10-09").unwrap().unwrap(), first);
        // 並びは、保存した順
        assert_eq!(
            first
                .iter()
                .map(|p| p.decision_key.as_str())
                .collect::<Vec<_>>(),
            vec!["k0h0e4", "k1h0e12", "k2h1e6"]
        );
        // 別の日は、別の組
        let next_day = db.save_daily_set("2026-10-10", &[item("k5h0e1")]).unwrap();
        assert_eq!(next_day.len(), 1);
        assert_eq!(db.daily_set("2026-10-09").unwrap().unwrap(), first);
        // 形が違う問題・日付は断る
        assert!(db.save_daily_set("2026-10-11", &[item("zzz")]).is_err());
        assert!(db.daily_set("tomorrow").is_err());
    }

    #[test]
    fn u9_solved_counts_are_per_session_and_count_a_problem_once() {
        let (_tmp, _data, mut db) = open();
        db.record_answer(sample("20261009-190953", "k0h0e4", 1_000))
            .unwrap();
        db.record_answer(sample("20261009-190953", "k1h0e12", 2_000))
            .unwrap();
        // 解き直しで同じ問題をもう一度答えても、1 問
        let mut review = sample("20261009-190953", "k0h0e4", 3_000);
        review.mode = AnswerMode::Review;
        db.record_answer(review).unwrap();
        db.record_answer(sample("20261009-171200", "k3h0e15", 4_000))
            .unwrap();
        let ids = vec![
            "20261009-190953".to_string(),
            "20261009-171200".to_string(),
            "20260101-000000".to_string(),
        ];
        assert_eq!(
            db.solved_counts(&ids).unwrap(),
            vec![
                ("20261009-190953".to_string(), 2),
                ("20261009-171200".to_string(), 1),
                ("20260101-000000".to_string(), 0),
            ]
        );
    }

    #[test]
    fn d3_forgetting_a_session_deletes_its_answers_and_its_days_set_rows_only() {
        let (_tmp, data, mut db) = open();
        db.record_answer(sample("20261009-190953", "k0h0e4", 1_000))
            .unwrap();
        db.record_answer(sample("20261009-190953", "k1h0e12", 2_000))
            .unwrap();
        db.record_answer(sample("20261009-171200", "k3h0e15", 3_000))
            .unwrap();
        db.save_daily_set(
            "2026-10-09",
            &[
                ProblemRef {
                    session_id: "20261009-190953".to_string(),
                    decision_key: "k0h0e4".to_string(),
                },
                ProblemRef {
                    session_id: "20261009-171200".to_string(),
                    decision_key: "k3h0e15".to_string(),
                },
            ],
        )
        .unwrap();
        let (answers, sets) = db
            .forget_sessions(&["20261009-190953".to_string()])
            .unwrap();
        assert_eq!((answers, sets), (2, 1));
        let left = db.list_answers().unwrap();
        assert_eq!(left.len(), 1);
        assert_eq!(left[0].answer.session_id, "20261009-171200");
        assert_eq!(db.daily_set("2026-10-09").unwrap().unwrap().len(), 1);
        drop(db);

        // 保存先から、別の接続で消す（アプリを閉じるとき・起動したときの片づけ）
        forget_sessions(
            &data,
            &["20261009-171200".to_string(), "../bad".to_string()],
        )
        .unwrap();
        let db = StudyDb::open(&data).unwrap();
        assert_eq!(db.list_answers().unwrap(), Vec::new());
        assert_eq!(db.daily_set("2026-10-09").unwrap(), None);
    }

    #[test]
    fn d3_forgetting_without_a_study_file_does_nothing_and_creates_none() {
        let tmp = tempfile::tempdir().unwrap();
        let data = tmp.path().join("data");
        std::fs::create_dir_all(&data).unwrap();
        forget_sessions(&data, &["20261009-190953".to_string()]).unwrap();
        assert!(!study_path(&data).exists());
        forget_sessions(
            &tmp.path().join("missing"),
            &["20261009-190953".to_string()],
        )
        .unwrap();
    }

    #[test]
    fn d3_a_file_made_by_a_newer_version_is_refused_and_left_alone() {
        let tmp = tempfile::tempdir().unwrap();
        let data = tmp.path().join("data");
        std::fs::create_dir_all(&data).unwrap();
        {
            let conn = Connection::open(study_path(&data)).unwrap();
            conn.execute_batch("CREATE TABLE answers (x); PRAGMA user_version = 99;")
                .unwrap();
        }
        let result = StudyDb::open(&data);
        assert!(matches!(
            result,
            Err(StudyError::NewerVersion { found: 99, .. })
        ));
        let conn = Connection::open(study_path(&data)).unwrap();
        let version: i64 = conn
            .pragma_query_value(None, "user_version", |r| r.get(0))
            .unwrap();
        assert_eq!(version, 99);
    }

    #[test]
    fn d1_a_data_dir_inside_a_repository_is_refused() {
        let tmp = tempfile::tempdir().unwrap();
        std::fs::create_dir_all(tmp.path().join("repo").join(".git")).unwrap();
        let result = StudyDb::open(&tmp.path().join("repo").join("data"));
        assert!(matches!(result, Err(StudyError::Store(_))));
        assert!(!tmp.path().join("repo").join("data").exists());
    }

    #[test]
    fn the_shapes_of_keys_tiles_and_dates_are_checked() {
        assert!(valid_decision_key("k2h1e14"));
        assert!(valid_decision_key("k0h0e0"));
        assert!(!valid_decision_key("k2h1"));
        assert!(!valid_decision_key("2h1e14"));
        assert!(!valid_decision_key("kXh1e14"));
        assert!(valid_tile("5pr"));
        assert!(valid_tile("E"));
        assert!(valid_tile("9s"));
        assert!(!valid_tile("0m"));
        assert!(!valid_tile("5x"));
        assert!(!valid_tile("Z"));
        assert!(valid_date("2026-10-09"));
        assert!(!valid_date("2026-1-09"));
        assert!(!valid_date("2026-00-09"));
        assert!(!valid_date("2026-10-32"));
    }
}
