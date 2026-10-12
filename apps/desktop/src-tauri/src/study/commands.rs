//! 答えの記録（出題・解き直し・答え合わせ）の Tauri コマンド。
//!
//! 実際の保存は `StudyDb`（`mod.rs`）に任せ、ここは薄い層にとどめる。呼べるのは検討画面だけ（ウィジェットの窓から呼ばれたら断る。
//! ウィジェットの窓には、答えの記録に触れる理由が無い）。接続は 1 つだけ、錠（`Mutex`）の後ろに持つ。保存先が変わったら、
//! 次に呼ばれたときに、新しい保存先のファイルを開き直す。

use std::fmt::Display;
use std::path::{Path, PathBuf};
use std::sync::{Mutex, PoisonError};

use serde::Serialize;
use tauri::{AppHandle, State, WebviewWindow};

use super::records::{
    self, ExportReport, ImportPreview, ImportReport, RecordsError, RecordsOverview,
};
use super::{AnswerNotes, AnswerRow, NewAnswer, ProblemRef, StudyDb, StudyError, WeekRecord};
use crate::commands::{emit_state, set_settings_now, SharedCore};
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
    pub fn with<R, E: Display>(
        &self,
        data_dir: &Path,
        f: impl FnOnce(&mut StudyDb) -> Result<R, E>,
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

/// すべての週の記録（手で入れた成績と来週の重点。週の古い順。U-30）。
#[tauri::command]
pub async fn list_weeks(
    window: WebviewWindow,
    core: State<'_, SharedCore>,
    study: State<'_, SharedStudy>,
) -> Result<Vec<WeekRecord>, String> {
    ensure_main(&window)?;
    study.with(&data_dir(&core), |db| db.list_weeks())
}

/// 1 週ぶんの成績と重点を置き換える。保存した記録を返す（成績も重点も空にしたときは、記録を消して `null`）。
#[tauri::command]
pub async fn set_week(
    window: WebviewWindow,
    core: State<'_, SharedCore>,
    study: State<'_, SharedStudy>,
    record: WeekRecord,
) -> Result<Option<WeekRecord>, String> {
    ensure_main(&window)?;
    study.with(&data_dir(&core), |db| db.set_week(record))
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
        Ok::<_, StudyError>(
            db.solved_counts(&session_ids)?
                .into_iter()
                .map(|(session_id, solved)| SolvedCount { session_id, solved })
                .collect(),
        )
    })
}

/// 記録の書き出しと読み込み（D-2）に使う、設定の写しと保存先。
fn settings_snapshot(core: &SharedCore) -> crate::settings::Settings {
    core.lock().settings().clone()
}

/// 書き出した時刻の文字（ローカル時刻。例: 2026-10-12T14:03:22+09:00）。
fn exported_at_text() -> String {
    chrono::Local::now().to_rfc3339_opts(chrono::SecondsFormat::Secs, false)
}

/// いま書き出すとしたら、何がどれだけ入るか（設定のページの「約 0.4 MB」に使う。何も書かない）。
#[tauri::command]
pub async fn records_overview(
    window: WebviewWindow,
    core: State<'_, SharedCore>,
    study: State<'_, SharedStudy>,
) -> Result<RecordsOverview, String> {
    ensure_main(&window)?;
    let settings = settings_snapshot(&core);
    study.with(&settings.data_dir, |db| {
        records::overview(&settings.data_dir, db, &settings)
    })
}

/// 記録を 1 つの JSON のファイルに書き出す。`path` は、保存のダイアログで選んだ場所（試験・試し運転では、直接渡せる）。
#[tauri::command]
pub async fn export_records(
    window: WebviewWindow,
    core: State<'_, SharedCore>,
    study: State<'_, SharedStudy>,
    path: String,
) -> Result<ExportReport, String> {
    ensure_main(&window)?;
    let settings = settings_snapshot(&core);
    study.with(&settings.data_dir, |db| {
        records::export_to_path(
            &settings.data_dir,
            db,
            &settings,
            Path::new(&path),
            &exported_at_text(),
        )
    })
}

/// 読み込む前に、ファイルを全部確かめて、半荘と答えの数（と、この保存先に半荘のフォルダが無い半荘の数）を返す。何も書き換えない。
/// 確かめられなければ、理由を返す。
#[tauri::command]
pub async fn inspect_records_file(
    window: WebviewWindow,
    core: State<'_, SharedCore>,
    path: String,
) -> Result<ImportPreview, String> {
    ensure_main(&window)?;
    let settings = settings_snapshot(&core);
    let file = records::read_records_file(Path::new(&path)).map_err(|e| e.import_message())?;
    records::preview(&settings.data_dir, &file).map_err(|e| e.import_message())
}

/// 記録のファイルを読み込んで、いまの記録を、その内容に置き換える（元には戻せない）。ファイルは、もう一度全部確かめてから使う。
/// 途中で失敗したら、元の記録のまま残す（設定も、元に戻す）。置き換えたら、記録の状態の変化と設定の変化を、全部の窓に知らせる。
#[tauri::command]
pub async fn import_records(
    window: WebviewWindow,
    app: AppHandle,
    core: State<'_, SharedCore>,
    study: State<'_, SharedStudy>,
    path: String,
) -> Result<ImportReport, String> {
    ensure_main(&window)?;
    let before = settings_snapshot(&core);
    let file = records::read_records_file(Path::new(&path)).map_err(|e| e.import_message())?;

    // 設定を先に替える（保存できなければ、ここで止まり、何も変わっていない）。記録の入れ替えに失敗したら、設定を元に戻す。
    let merged = file.settings.applied_to(&before);
    set_settings_now(&app, merged)?;
    let outcome = study.with(&before.data_dir, |db| {
        records::import_records(&before.data_dir, db, &file, &mut records::real_rename)
            .map_err(|e: RecordsError| e.import_message())
    });
    let report = match outcome {
        Ok(report) => report,
        Err(message) => {
            let _ = set_settings_now(&app, before);
            return Err(message);
        }
    };
    let state = core.lock().app_state();
    emit_state(&app, &state);
    Ok(report)
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
    fn the_weeks_follow_the_same_connection_and_data_dir() {
        let tmp = tempfile::tempdir().unwrap();
        let first = tmp.path().join("first");
        let second = tmp.path().join("second");
        let study = SharedStudy::new();
        let record = WeekRecord {
            week: "2026-10-05".to_string(),
            stats: crate::study::WeekStats {
                rank4: Some(20.4),
                ..Default::default()
            },
            focus: "重点".to_string(),
        };
        let saved = study
            .with(&first, |db| db.set_week(record.clone()))
            .unwrap();
        assert_eq!(saved, Some(record.clone()));
        assert_eq!(
            study.with(&first, |db| db.list_weeks()).unwrap(),
            vec![record]
        );
        // 保存先が変わると、新しい保存先の（空の）記録を見る
        assert_eq!(
            study.with(&second, |db| db.list_weeks()).unwrap(),
            Vec::new()
        );
        // 正しくない値は、理由の文で返る
        let error = study
            .with(&first, |db| {
                db.set_week(WeekRecord {
                    week: "2026-10-06".to_string(),
                    stats: Default::default(),
                    focus: String::new(),
                })
            })
            .unwrap_err();
        assert!(error.contains("月曜"), "{error}");
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
