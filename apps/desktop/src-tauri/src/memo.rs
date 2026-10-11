//! 終局直後のメモ（F4）を、画面（検討画面）から保存するコマンド: 迷いマークごとの「候補」「理由」と、迷いマークの無い迷いのメモ。
//!
//! 実際の保存は `store`（半荘のフォルダの `memos.json`）に任せ、ここは薄い層にとどめる。
//! ウィジェットの記録（`events.jsonl`。追記だけ）は書き換えない。
//! どの変更のあとも、状態の変化を知らせて、半荘の一覧（メモも入っている）が読み直されるようにする。
//! ウィジェットの窓は、これらを呼ばない（検討画面だけが呼ぶ）。

use tauri::{AppHandle, State};

use crate::commands::{emit_state, SharedCore};

/// 保存したあとに、記録の一覧が更新されるよう、状態の変化を知らせる。
fn changed(app: &AppHandle, core: &SharedCore) {
    let state = core.lock().app_state();
    emit_state(app, &state);
}

/// 迷いマークのメモを書く（置き換える）。「候補」も「理由」も空なら、メモを消す。
#[tauri::command]
pub async fn set_memo(
    app: AppHandle,
    core: State<'_, SharedCore>,
    session_id: String,
    mark_id: u64,
    candidates: String,
    reason: String,
) -> Result<(), String> {
    core.lock()
        .store()?
        .set_memo(&session_id, mark_id, &candidates, &reason)
        .map_err(|e| e.to_string())?;
    changed(&app, &core);
    Ok(())
}

/// 迷いマークのメモを消す（取り消しに使う）。
#[tauri::command]
pub async fn clear_memo(
    app: AppHandle,
    core: State<'_, SharedCore>,
    session_id: String,
    mark_id: u64,
) -> Result<(), String> {
    core.lock()
        .store()?
        .clear_memo(&session_id, mark_id)
        .map_err(|e| e.to_string())?;
    changed(&app, &core);
    Ok(())
}

/// 迷いマークの無い迷いのメモを書く（同じ名前があれば置き換え、無ければ足す）。`decision` は判断の鍵。
#[tauri::command]
pub async fn set_extra_memo(
    app: AppHandle,
    core: State<'_, SharedCore>,
    session_id: String,
    id: String,
    decision: String,
    candidates: String,
    reason: String,
) -> Result<(), String> {
    core.lock()
        .store()?
        .set_extra_memo(&session_id, &id, &decision, &candidates, &reason)
        .map_err(|e| e.to_string())?;
    changed(&app, &core);
    Ok(())
}

/// 迷いマークの無い迷いのメモを消す（取り消しに使う）。
#[tauri::command]
pub async fn clear_extra_memo(
    app: AppHandle,
    core: State<'_, SharedCore>,
    session_id: String,
    id: String,
) -> Result<(), String> {
    core.lock()
        .store()?
        .clear_extra_memo(&session_id, &id)
        .map_err(|e| e.to_string())?;
    changed(&app, &core);
    Ok(())
}
