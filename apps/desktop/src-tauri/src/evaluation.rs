//! 局の評価の表（F10）を、画面（検討画面）から保存するコマンド: 局の自己評価の上書きと、MAKA の評価。
//!
//! 実際の保存は `store`（半荘のフォルダの `self-ratings.json`・`maka.json`）に任せ、ここは薄い層にとどめる。
//! ウィジェットの記録（`events.jsonl`。追記だけ）は書き換えない。
//! どの変更のあとも、状態の変化を知らせて、半荘の一覧（自己評価・MAKA の評価も入っている）が読み直されるようにする。
//! ウィジェットの窓は、これらを呼ばない（検討画面だけが呼ぶ）。

use tauri::{AppHandle, State};

use crate::commands::{emit_state, SharedCore};
use crate::store::SelfRating;

/// 保存したあとに、記録の一覧が更新されるよう、状態の変化を知らせる。
fn changed(app: &AppHandle, core: &SharedCore) {
    let state = core.lock().app_state();
    emit_state(app, &state);
}

/// 局の自己評価を上書きする。`kyoku` は局の鍵（`k<局の通し番号>h<本場>`）。`rating` は good・fair・bad・none。
/// 選び直しにも使う。
#[tauri::command]
pub async fn set_self_rating(
    app: AppHandle,
    core: State<'_, SharedCore>,
    session_id: String,
    kyoku: String,
    rating: SelfRating,
) -> Result<(), String> {
    core.lock()
        .store()?
        .set_self_rating(&session_id, &kyoku, rating)
        .map_err(|e| e.to_string())?;
    changed(&app, &core);
    Ok(())
}

/// 局の自己評価の上書きを消す（ウィジェットで付けた評価に戻す。取り消しに使う）。
#[tauri::command]
pub async fn clear_self_rating(
    app: AppHandle,
    core: State<'_, SharedCore>,
    session_id: String,
    kyoku: String,
) -> Result<(), String> {
    core.lock()
        .store()?
        .clear_self_rating(&session_id, &kyoku)
        .map_err(|e| e.to_string())?;
    changed(&app, &core);
    Ok(())
}

/// 局の MAKA の評価を入れる。`grade` は S+ から E の 14 段階のどれか。
#[tauri::command]
pub async fn set_maka_grade(
    app: AppHandle,
    core: State<'_, SharedCore>,
    session_id: String,
    kyoku: String,
    grade: String,
) -> Result<(), String> {
    core.lock()
        .store()?
        .set_maka_grade(&session_id, &kyoku, &grade)
        .map_err(|e| e.to_string())?;
    changed(&app, &core);
    Ok(())
}

/// 局の MAKA の評価を消す（入れていない状態に戻す。取り消しに使う）。
#[tauri::command]
pub async fn clear_maka_grade(
    app: AppHandle,
    core: State<'_, SharedCore>,
    session_id: String,
    kyoku: String,
) -> Result<(), String> {
    core.lock()
        .store()?
        .clear_maka_grade(&session_id, &kyoku)
        .map_err(|e| e.to_string())?;
    changed(&app, &core);
    Ok(())
}

/// 半荘全体の MAKA の評価を入れる。
#[tauri::command]
pub async fn set_maka_hanchan(
    app: AppHandle,
    core: State<'_, SharedCore>,
    session_id: String,
    grade: String,
) -> Result<(), String> {
    core.lock()
        .store()?
        .set_maka_hanchan(&session_id, &grade)
        .map_err(|e| e.to_string())?;
    changed(&app, &core);
    Ok(())
}

/// 半荘全体の MAKA の評価を消す。
#[tauri::command]
pub async fn clear_maka_hanchan(
    app: AppHandle,
    core: State<'_, SharedCore>,
    session_id: String,
) -> Result<(), String> {
    core.lock()
        .store()?
        .clear_maka_hanchan(&session_id)
        .map_err(|e| e.to_string())?;
    changed(&app, &core);
    Ok(())
}
