//! 答えの記録（出題・解き直し・答え合わせ）の Tauri コマンド。
//!
//! 実際の保存は `StudyDb`（`mod.rs`）に任せ、ここは薄い層にとどめる。呼べるのは検討画面だけ（ウィジェットの窓から呼ばれたら断る。
//! ウィジェットの窓には、答えの記録に触れる理由が無い）。接続は 1 つだけ、錠（`Mutex`）の後ろに持つ。保存先が変わったら、
//! 次に呼ばれたときに、新しい保存先のファイルを開き直す。

use std::path::{Path, PathBuf};
use std::sync::{Mutex, PoisonError};

use serde::Serialize;
use tauri::{State, WebviewWindow};

use super::{AnswerNotes, AnswerRow, NewAnswer, ProblemRef, StudyDb, StudyError};
use crate::commands::SharedCore;
use crate::widget_window::MAIN_LABEL;

struct Slot {
    /// 開いている接続の保存先。
    dir: Option<PathBuf>,
    db: Option<StudyDb>,
}

/// アプリの状態に置く、答えのファイルの接続（1 つ）。
pub struct SharedStudy(Mutex<Slot>);

impl Default for SharedStudy {
    fn default() -> Self {
        SharedStudy::new()
    }
}

impl SharedStudy {
    pub fn new() -> SharedStudy {
        SharedStudy(Mutex::new(Slot {
            dir: None,
            db: None,
        }))
    }

    /// 保存先 `data_dir` の接続で `f` を動かす。まだ開いていない・保存先が変わったときは、開く。
    pub fn with<R>(
        &self,
        data_dir: &Path,
        f: impl FnOnce(&mut StudyDb) -> Result<R, StudyError>,
    ) -> Result<R, String> {
        let mut slot = self.0.lock().unwrap_or_else(PoisonError::into_inner);
        if slot.db.is_none() || slot.dir.as_deref() != Some(data_dir) {
            slot.db = None;
            slot.dir = None;
            let db = StudyDb::open(data_dir).map_err(|e| e.to_string())?;
            slot.dir = Some(data_dir.to_path_buf());
            slot.db = Some(db);
        }
        match slot.db.as_mut() {
            Some(db) => f(db).map_err(|e| e.to_string()),
            None => Err("答えのファイルを開けませんでした".to_string()),
        }
    }
}

/// 検討画面の窓から呼ばれたか。
fn ensure_main(window: &WebviewWindow) -> Result<(), String> {
    if window.label() == MAIN_LABEL {
        Ok(())
    } else {
        Err("答えの記録は、検討画面からだけ扱えます".to_string())
    }
}

/// 設定の保存先（答えのファイルは、その直下）。
fn data_dir(core: &SharedCore) -> PathBuf {
    core.lock().settings().data_dir.clone()
}

/// 答えを記録する（答え合わせを押したとき）。番号を付けた行を返す。
#[tauri::command]
pub async fn record_answer(
    window: WebviewWindow,
    core: State<'_, SharedCore>,
    study: State<'_, SharedStudy>,
    answer: NewAnswer,
) -> Result<AnswerRow, String> {
    ensure_main(&window)?;
    study.with(&data_dir(&core), |db| db.record_answer(answer))
}

/// 答え合わせのあとに、差の原因・学んだ原則・MAKA の打牌を置き換える。直した行を返す。
#[tauri::command]
pub async fn update_answer_notes(
    window: WebviewWindow,
    core: State<'_, SharedCore>,
    study: State<'_, SharedStudy>,
    id: i64,
    notes: AnswerNotes,
) -> Result<AnswerRow, String> {
    ensure_main(&window)?;
    study.with(&data_dir(&core), |db| db.update_notes(id, notes))
}

/// すべての答え（答えた順）。
#[tauri::command]
pub async fn list_answers(
    window: WebviewWindow,
    core: State<'_, SharedCore>,
    study: State<'_, SharedStudy>,
) -> Result<Vec<AnswerRow>, String> {
    ensure_main(&window)?;
    study.with(&data_dir(&core), |db| db.list_answers())
}

/// 日付（YYYY-MM-DD）の今日の出題の組。まだ作っていなければ `null`。
#[tauri::command]
pub async fn get_daily_set(
    window: WebviewWindow,
    core: State<'_, SharedCore>,
    study: State<'_, SharedStudy>,
    date: String,
) -> Result<Option<Vec<ProblemRef>>, String> {
    ensure_main(&window)?;
    study.with(&data_dir(&core), |db| db.daily_set(&date))
}

/// その日の今日の出題の組を作る。その日の組がすでにあれば、入れ替えずに、あるものを返す。
#[tauri::command]
pub async fn save_daily_set(
    window: WebviewWindow,
    core: State<'_, SharedCore>,
    study: State<'_, SharedStudy>,
    date: String,
    items: Vec<ProblemRef>,
) -> Result<Vec<ProblemRef>, String> {
    ensure_main(&window)?;
    study.with(&data_dir(&core), |db| db.save_daily_set(&date, &items))
}

/// 半荘ごとの、答えた問題の数。
#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
pub struct SolvedCount {
    pub session_id: String,
    pub solved: u32,
}

/// 半荘ごとの、答えた問題の数（半荘を消す確認の「解いた問題 N問」に使う）。
#[tauri::command]
pub async fn count_solved(
    window: WebviewWindow,
    core: State<'_, SharedCore>,
    study: State<'_, SharedStudy>,
    session_ids: Vec<String>,
) -> Result<Vec<SolvedCount>, String> {
    ensure_main(&window)?;
    study.with(&data_dir(&core), |db| {
        Ok(db
            .solved_counts(&session_ids)?
            .into_iter()
            .map(|(session_id, solved)| SolvedCount { session_id, solved })
            .collect())
    })
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::study::{study_path, AnswerMode};
    use serde_json::json;

    fn answer() -> NewAnswer {
        NewAnswer {
            session_id: "20261009-190953".to_string(),
            decision_key: "k0h0e4".to_string(),
            mode: AnswerMode::Quiz,
            shown_at: 1,
            answered_at: 2,
            choice: json!({"type": "dahai", "tile": "5p"}),
            reason: "理由".to_string(),
            duration_ms: 1,
            reselect_count: 0,
            correct: true,
            causes: Vec::new(),
            principle: String::new(),
            maka_move: None,
            interval_days: 1,
            due_date: "2026-10-10".to_string(),
        }
    }

    #[test]
    fn the_one_connection_opens_lazily_and_follows_the_data_dir() {
        let tmp = tempfile::tempdir().unwrap();
        let first = tmp.path().join("first");
        let second = tmp.path().join("second");
        let study = SharedStudy::new();
        // まだ何も開いていない（保存先にファイルも無い）
        assert!(!study_path(&first).exists());
        study.with(&first, |db| db.record_answer(answer())).unwrap();
        assert!(study_path(&first).is_file());
        assert_eq!(study.with(&first, |db| db.list_answers()).unwrap().len(), 1);
        // 保存先が変わると、新しい保存先のファイルを開く（前の保存先の答えは、そこに残る）
        assert_eq!(
            study.with(&second, |db| db.list_answers()).unwrap().len(),
            0
        );
        assert!(study_path(&second).is_file());
        assert_eq!(study.with(&first, |db| db.list_answers()).unwrap().len(), 1);
    }

    #[test]
    fn a_data_dir_inside_a_repository_gives_a_message_instead_of_a_connection() {
        let tmp = tempfile::tempdir().unwrap();
        std::fs::create_dir_all(tmp.path().join("repo").join(".git")).unwrap();
        let study = SharedStudy::new();
        let error = study
            .with(&tmp.path().join("repo").join("data"), |db| {
                db.list_answers()
            })
            .unwrap_err();
        assert!(error.contains("リポジトリの中"), "{error}");
    }
}
