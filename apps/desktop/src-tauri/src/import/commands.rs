//! 取り込みで、画面（検討画面）から呼ぶ Tauri のコマンド（F1・F9・F11）。
//!
//! 実際の処理は、`report_fetch`（結果の取得）・`mjai_window`（mjai の窓）・`ocr_job`（文字認識）・`store`（保存）に任せ、
//! ここは薄い層にとどめる。ウィジェットの窓には、これらのコマンドの権限は無い（検討画面だけが呼ぶ）。
//! 待ちのある処理（通信・ファイルの読み込み・文字認識）は、`spawn_blocking` で別のスレッドに回す（画面を止めない）。

use std::collections::BTreeMap;
use std::path::PathBuf;
use std::sync::{Mutex, PoisonError};

use serde::Serialize;
use tauri::{AppHandle, Emitter, Manager, State};

use super::mjai_nav;
use super::mjai_window;
use super::ocr_job::{
    finish_reread, needs_reread, plan_reread, plan_session, run_job, run_reread, LineReader,
    Progress, SessionJob, Shot, WindowsReader,
};
use super::report_fetch::{fetch_report_by_text, ReportEndpoint};
use super::report_file::read_report_file;
use crate::clipboard;
use crate::clock::now_ms;
use crate::commands::{emit_state, SharedCore};
use crate::store::{Links, OcrCache};
use crate::widget_window::MAIN_LABEL;

/// 文字認識の進み具合を知らせるイベントの名前。
pub const EVENT_OCR_PROGRESS: &str = "ocr-progress";
/// 検討画面が前面に来たことを、検討画面に知らせるイベントの名前（画面自身の focus の知らせの取りこぼしに備える）。
pub const EVENT_MAIN_FOCUSED: &str = "main-window-focused";

/// 検討画面が前面に来たことを、検討画面に知らせる。画面は、クリップボードの牌譜リンクを探し直す。
pub fn announce_main_window_focus(app: &AppHandle) {
    let _ = app.emit_to(MAIN_LABEL, EVENT_MAIN_FOCUSED, ());
}

/// クリップボードの文字を返す（文字だけ。画像などは読まない）。文字が無ければ `null`。
/// 検討画面が前面に来たときに呼ぶ。牌譜リンクを探すのは画面側（エンジンの `detectPaipuLink`）。
#[tauri::command]
pub async fn read_clipboard_text() -> Result<Option<String>, String> {
    clipboard::read_text()
}

/// mjai の窓を開いて、URL 欄に牌譜リンクを入れる。Submit はユーザーが押す。
/// `background` は、画面が描いている背景の色（CSS の色。窓の背景色をそろえる）。
/// `target` は、取り込み先の半荘の呼び名（例: 10月9日 19:09。その半荘のページから取り込むとき。窓の題名に出す。U-14）。
#[tauri::command]
pub async fn open_mjai_window(
    app: AppHandle,
    link: String,
    background: String,
    target: Option<String>,
) -> Result<(), String> {
    mjai_window::open(&app, &link, &background, target.as_deref())
}

/// mjai の窓を閉じる（「やめる」など。開いていなければ何もしない）。
#[tauri::command]
pub async fn close_mjai_window(app: AppHandle) -> Result<(), String> {
    mjai_window::close(&app);
    Ok(())
}

/// 貼り付けた文字から、mjai の結果の ID を探す（結果の URL を貼る取り込み方）。見つからなければ `null`。
#[tauri::command]
pub async fn report_id_from_text(text: String) -> Result<Option<String>, String> {
    Ok(mjai_nav::report_id_from_text(&text).map(|id| id.to_string()))
}

/// 結果の JSON を mjai のサイトから取る（`GET /report/<ID>.json` の 1 回）。アプリが外へ出す通信は、これだけ。
#[tauri::command]
pub async fn fetch_report(id: String) -> Result<String, String> {
    tauri::async_runtime::spawn_blocking(move || {
        fetch_report_by_text(&ReportEndpoint::production(), &id).map_err(|e| e.to_string())
    })
    .await
    .map_err(|e| format!("取得の処理が止まりました: {e}"))?
}

/// 結果の JSON ファイルを読む（ファイルを開くダイアログで選んだパス）。
#[tauri::command]
pub async fn read_report_file_text(path: String) -> Result<String, String> {
    tauri::async_runtime::spawn_blocking(move || {
        read_report_file(&PathBuf::from(path)).map_err(|e| e.to_string())
    })
    .await
    .map_err(|e| format!("読み込みの処理が止まりました: {e}"))?
}

/// 半荘 1 つ分の、画像の文字認識の結果の写し。
#[derive(Debug, Clone, Serialize)]
pub struct SessionOcr {
    pub session_id: String,
    pub ocr: OcrCache,
}

/// 半荘の迷いマーク・評価の画像を、文字認識にかける（取り込みのときだけ。F11）。結果は半荘のフォルダの `ocr.json` に残し、
/// 読み直さない。進み具合は `ocr-progress` のイベントで知らせる。日本語の文字認識が使えなければ、その理由を返す。
#[tauri::command]
pub async fn ocr_sessions(
    app: AppHandle,
    session_ids: Vec<String>,
) -> Result<Vec<SessionOcr>, String> {
    let jobs = plan_jobs(&app, &session_ids)?;
    tauri::async_runtime::spawn_blocking(move || run_ocr(&app, jobs))
        .await
        .map_err(|e| format!("文字認識の処理が止まりました: {e}"))?
}

/// 各半荘について、読む画像と、これまでの写しから、仕事を決める（記録の錠は、ここだけで取る）。
fn plan_jobs(app: &AppHandle, session_ids: &[String]) -> Result<Vec<SessionJob>, String> {
    let shared = app.state::<SharedCore>();
    let core = shared.lock();
    let store = core.store()?;
    session_ids
        .iter()
        .map(|id| {
            let shots = store
                .screenshots_of(id)
                .map_err(|e| e.to_string())?
                .into_iter()
                .map(|(relative, absolute)| Shot { relative, absolute })
                .collect();
            let existing = store.load_ocr(id).map_err(|e| e.to_string())?;
            Ok(plan_session(id, shots, existing))
        })
        .collect()
}

/// 仕事を進める（画面とは別のスレッドで動く）。読むのに記録の錠は要らない。写しを書くときだけ、短く錠を取る。
fn run_ocr(app: &AppHandle, mut jobs: Vec<SessionJob>) -> Result<Vec<SessionOcr>, String> {
    let total: usize = jobs.iter().map(|job| job.todo.len()).sum();
    if total > 0 {
        let reader = WindowsReader::start().map_err(|e| e.to_string())?;
        let mut done = 0;
        report_progress(app, done, total);
        for job in &mut jobs {
            let outcome = run_job(&reader, job, &mut || {
                done += 1;
                report_progress(app, done, total);
            });
            // 止まったときも、そこまでに読めた分は、写しに残す。
            save_job(app, job)?;
            outcome.map_err(|e| e.to_string())?;
        }
    }
    Ok(jobs
        .into_iter()
        .map(|job| SessionOcr {
            session_id: job.session_id,
            ocr: job.cache,
        })
        .collect())
}

fn save_job(app: &AppHandle, job: &SessionJob) -> Result<(), String> {
    if !job.changed {
        return Ok(());
    }
    let shared = app.state::<SharedCore>();
    let core = shared.lock();
    core.store()?
        .save_ocr(&job.session_id, &job.cache)
        .map_err(|e| e.to_string())
}

fn report_progress(app: &AppHandle, done: usize, total: usize) {
    let _ = app.emit_to(MAIN_LABEL, EVENT_OCR_PROGRESS, Progress { done, total });
}

/// 半荘の写しが、前の作り方で読んだものか（読み直しが要るか）。半荘の画面を開いたときに呼ぶ（F11）。
/// 写しの決まりの名前が、いまの作り方と違う（または名前が無い）ときだけ true。写しが無いときは false。
#[tauri::command]
pub async fn needs_ocr_reread(
    core: State<'_, SharedCore>,
    session_id: String,
) -> Result<bool, String> {
    let existing = core
        .lock()
        .store()?
        .load_ocr(&session_id)
        .map_err(|e| e.to_string())?;
    Ok(needs_reread(existing.as_ref()))
}

/// 前の作り方で読んだ半荘の画像を、いまの作り方で読み直して、新しい写し（`ocr.json`）を書く（取り込みの一部。F11、E-27）。
/// 画面を止めないよう、別のスレッドで動く。書き換えるのは `ocr.json` だけ（結びつけ・評価・MAKA・結果には触らない）。
/// 書き直したら `true`、読み直しが要らなかったら `false`。失敗したら、前の写しをそのまま残して、理由を標準エラーに書き、返す。
#[tauri::command]
pub async fn reread_ocr(app: AppHandle, session_id: String) -> Result<bool, String> {
    tauri::async_runtime::spawn_blocking(move || reread_blocking(&app, &session_id))
        .await
        .map_err(|e| format!("読み直しの処理が止まりました: {e}"))?
}

/// 読み直しを同時に 1 つしか動かさないための錠（半荘の画面を続けて開いても、文字認識の担当を一度に 1 つだけ動かす）。
static REREAD_GATE: Mutex<()> = Mutex::new(());

fn reread_blocking(app: &AppHandle, session_id: &str) -> Result<bool, String> {
    let _gate = REREAD_GATE.lock().unwrap_or_else(PoisonError::into_inner);
    let result = reread_steps(app, session_id);
    if let Err(reason) = &result {
        eprintln!(
            "半荘 {session_id} の文字認識の読み直しに失敗しました（前の読み取りのまま残します）: {reason}"
        );
    }
    result
}

/// 仕事を決める → 読む → 書く。記録の錠は、決めるときと書くときだけ、短く取る（読んでいる間は、ウィジェットの記録を止めない）。
fn reread_steps(app: &AppHandle, session_id: &str) -> Result<bool, String> {
    let planned = {
        let shared = app.state::<SharedCore>();
        let core = shared.lock();
        plan_reread(core.store()?, session_id).map_err(|e| e.to_string())?
    };
    let Some(job) = planned else {
        return Ok(false);
    };
    let job = run_reread(job, || {
        WindowsReader::start().map(|reader| Box::new(reader) as Box<dyn LineReader>)
    })
    .map_err(|e| e.to_string())?;
    let shared = app.state::<SharedCore>();
    let core = shared.lock();
    finish_reread(core.store()?, &job).map_err(|e| e.to_string())?;
    Ok(true)
}

/// 取り込んだ結果（生の JSON）を、半荘のフォルダに保存する。`session_id` が無ければ、記録の無い半荘として新しいフォルダを作る。
/// 保存した半荘の名前を返す。
#[tauri::command]
pub async fn save_report(
    app: AppHandle,
    core: State<'_, SharedCore>,
    session_id: Option<String>,
    text: String,
) -> Result<String, String> {
    let (id, state) = {
        let mut core = core.lock();
        let id = core
            .store_mut()?
            .save_report(session_id.as_deref(), &text, now_ms())
            .map_err(|e| e.to_string())?;
        (id, core.app_state())
    };
    emit_state(&app, &state);
    Ok(id)
}

/// 取り込んだ結果の生の JSON。まだ取り込んでいなければ `null`。
#[tauri::command]
pub async fn read_report(
    core: State<'_, SharedCore>,
    session_id: String,
) -> Result<Option<String>, String> {
    core.lock()
        .store()?
        .read_report(&session_id)
        .map_err(|e| e.to_string())
}

/// 結びつけを変えたあとに、記録の一覧が更新されるよう、状態の変化を知らせる。
fn changed_links(app: &AppHandle, core: &SharedCore) {
    let state = core.lock().app_state();
    emit_state(app, &state);
}

/// 迷いマークを、判断の鍵（または `"manual"`）に結びつける。選び直しにも使う。
#[tauri::command]
pub async fn set_mark_link(
    app: AppHandle,
    core: State<'_, SharedCore>,
    session_id: String,
    mark_id: u64,
    decision: String,
) -> Result<(), String> {
    core.lock()
        .store()?
        .set_mark_link(&session_id, mark_id, &decision)
        .map_err(|e| e.to_string())?;
    changed_links(&app, &core);
    Ok(())
}

/// 迷いマークの結びつけを消す（取り消し）。
#[tauri::command]
pub async fn clear_mark_link(
    app: AppHandle,
    core: State<'_, SharedCore>,
    session_id: String,
    mark_id: u64,
) -> Result<(), String> {
    core.lock()
        .store()?
        .clear_mark_link(&session_id, mark_id)
        .map_err(|e| e.to_string())?;
    changed_links(&app, &core);
    Ok(())
}

/// 評価を、局の鍵に結びつける（空の文字列は「どの局にも結びつけない」）。
#[tauri::command]
pub async fn set_rating_link(
    app: AppHandle,
    core: State<'_, SharedCore>,
    session_id: String,
    rating_id: u64,
    kyoku: String,
) -> Result<(), String> {
    core.lock()
        .store()?
        .set_rating_link(&session_id, rating_id, &kyoku)
        .map_err(|e| e.to_string())?;
    changed_links(&app, &core);
    Ok(())
}

/// 評価の結びつけを消す（取り消し）。
#[tauri::command]
pub async fn clear_rating_link(
    app: AppHandle,
    core: State<'_, SharedCore>,
    session_id: String,
    rating_id: u64,
) -> Result<(), String> {
    core.lock()
        .store()?
        .clear_rating_link(&session_id, rating_id)
        .map_err(|e| e.to_string())?;
    changed_links(&app, &core);
    Ok(())
}

/// 評価の結びつけだけをまるごと置き換える（前の当てはめ方で当てはめた評価を、半荘の画面を開いたときに当てはめ直す。E-31）。
/// 当てはめ方の版（`version`）も書く。迷いマークの結びつけと、局の自己評価・MAKA の評価は変えない。
#[tauri::command]
pub async fn replace_rating_links(
    app: AppHandle,
    core: State<'_, SharedCore>,
    session_id: String,
    ratings: BTreeMap<String, String>,
    version: u32,
) -> Result<(), String> {
    core.lock()
        .store()?
        .replace_rating_links(&session_id, ratings, version)
        .map_err(|e| e.to_string())?;
    changed_links(&app, &core);
    Ok(())
}

/// 結びつけをまるごと置き換える（取り込みのときに、自動で決めた結びつけを一度に書く）。
#[tauri::command]
pub async fn replace_links(
    app: AppHandle,
    core: State<'_, SharedCore>,
    session_id: String,
    links: Links,
) -> Result<(), String> {
    core.lock()
        .store()?
        .replace_links(&session_id, links)
        .map_err(|e| e.to_string())?;
    changed_links(&app, &core);
    Ok(())
}
