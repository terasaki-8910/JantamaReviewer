//! アプリ内の更新（F21）の Tauri コマンド。
//!
//! 呼べるのは検討画面だけ（ウィジェットの窓から呼ばれたら断る。ウィジェットの窓には、更新に触れる理由が無い）。
//! 確かめる（`check_update`）は、起動のとき（1 回）と、設定の「更新を確かめる」を押したときだけ。入れ直す（`install_update`）は、
//! 「今すぐ入れ直す」を押したときだけで、記録中（ウィジェットが半荘を記録している間）は断る。
//! 実際の確かめ・ダウンロード・入れ直しは `updater.rs` に任せ、ここは薄い層にとどめる。

use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::Arc;

use tauri::{AppHandle, Manager, State, WebviewWindow};

use super::{BeforeExit, PendingUpdate, UpdateCheck, UpdateInfo, UpdateSource};
use crate::app_core::Status;
use crate::commands::{set_settings_now, SharedCore};
use crate::settings::Settings;
use crate::widget_window::{MAIN_LABEL, WIDGET_LABEL};

/// 記録中に、入れ直しを断る理由。画面の帯の文と同じ。
pub const RECORDING_MESSAGE: &str = "記録中は入れ直せません（対局のあとで）";

/// 検討画面の窓から呼ばれたか。
fn ensure_main(window: &WebviewWindow) -> Result<(), String> {
    if window.label() == MAIN_LABEL {
        Ok(())
    } else {
        Err("アプリの更新は、検討画面からだけ扱えます".to_string())
    }
}

/// 記録中でなければ通す。記録中（ウィジェットの半荘が開いている間）は、入れ直しを断る。
fn ensure_not_recording(status: Status) -> Result<(), String> {
    match status {
        Status::Recording => Err(RECORDING_MESSAGE.to_string()),
        Status::Idle | Status::Error => Ok(()),
    }
}

/// 「この版は飛ばす」を押したあとの設定。版の前後の空白を取る。空の版は断る。
fn settings_skipping(current: &Settings, version: &str) -> Result<Settings, String> {
    let version = version.trim();
    if version.is_empty() {
        return Err("飛ばす版の名前が空です".to_string());
    }
    Ok(Settings {
        skipped_update_version: Some(version.to_string()),
        ..current.clone()
    })
}

/// 入れ直す前の片づけ（閉じるときと同じ）をする関数。作ったときに、動いたかを `ran` に印す
/// （インストーラーを動かせなかったときに、閉じかけた窓を見せ直すため）。
fn exit_hook(app: &AppHandle, ran: Arc<AtomicBool>) -> BeforeExit {
    let handle = app.clone();
    Arc::new(move || {
        ran.store(true, Ordering::SeqCst);
        // インストーラーを動かしたあと、このアプリはすぐ終わる（`RunEvent::Exit` は来ない）ので、閉じるときの片づけを先にする
        crate::flush_before_exit(&handle);
        handle.cleanup_before_exit();
    })
}

/// 入れ直せなかったとき、片づけで隠した窓を見せ直す。
fn show_windows_again(app: &AppHandle) {
    for label in [MAIN_LABEL, WIDGET_LABEL] {
        if let Some(window) = app.get_webview_window(label) {
            let _ = window.show();
        }
    }
}

/// 今の版と、更新の仕組みが使える状態か。通信しない。
#[tauri::command]
pub async fn get_update_info(app: AppHandle, window: WebviewWindow) -> Result<UpdateInfo, String> {
    ensure_main(&window)?;
    Ok(UpdateInfo::new(
        &UpdateSource::production(),
        app.package_info().version.to_string(),
    ))
}

/// 更新を確かめる。公開鍵が空なら、通信せずに「設定されていません」を返す。失敗は、結果の中に理由を入れて返す。
#[tauri::command]
pub async fn check_update(
    app: AppHandle,
    window: WebviewWindow,
    pending: State<'_, PendingUpdate>,
) -> Result<UpdateCheck, String> {
    ensure_main(&window)?;
    let hook = exit_hook(&app, Arc::new(AtomicBool::new(false)));
    Ok(super::check(&app, &UpdateSource::production(), &pending, &hook).await)
}

/// 見つけた更新を、ダウンロードして、署名を確かめて、入れ直す。「今すぐ入れ直す」を押したときだけ呼ぶ。
/// Windows では、インストーラーを動かして、ここでアプリが終わる（インストーラーが、入れ終えたあとに開き直す）。
/// 記録中は断る。書きかけのメモなどは、画面が先に保存してから呼ぶ。
#[tauri::command]
pub async fn install_update(
    app: AppHandle,
    window: WebviewWindow,
    core: State<'_, SharedCore>,
    pending: State<'_, PendingUpdate>,
) -> Result<(), String> {
    ensure_main(&window)?;
    let status = core.lock().app_state().status;
    ensure_not_recording(status)?;
    let ran = Arc::new(AtomicBool::new(false));
    let hook = exit_hook(&app, Arc::clone(&ran));
    let result = super::install(&app, &pending, &hook).await;
    // インストーラーを動かす直前の片づけまで済んでから失敗したとき（まれ）: 隠した窓を見せ直す。片づけで止めた同期などは戻せないので、開き直してもらう
    match result {
        Err(reason) if ran.load(Ordering::SeqCst) => {
            show_windows_again(&app);
            Err(format!("{reason}。アプリを開き直してください"))
        }
        other => other,
    }
}

/// 「この版は飛ばす」: 版を設定（settings.json の `skipped_update_version`）に覚える。同期にも書き出しにも入れない（この PC だけ）。
/// 設定が変わったことは、全部の窓に知らせる（設定のページが、古い値で上書きしないため）。
#[tauri::command]
pub async fn skip_update_version(
    app: AppHandle,
    window: WebviewWindow,
    version: String,
) -> Result<Settings, String> {
    ensure_main(&window)?;
    let current = app.state::<SharedCore>().lock().settings().clone();
    set_settings_now(&app, settings_skipping(&current, &version)?)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn f21_installing_is_refused_only_while_recording() {
        assert_eq!(
            ensure_not_recording(Status::Recording),
            Err("記録中は入れ直せません（対局のあとで）".to_string())
        );
        assert_eq!(ensure_not_recording(Status::Idle), Ok(()));
        // 保存先を開けず記録できないとき（ウィジェットは半荘を記録していない）は、入れ直せる
        assert_eq!(ensure_not_recording(Status::Error), Ok(()));
    }

    #[test]
    fn f21_skipping_a_version_keeps_every_other_setting() {
        let current = Settings {
            sound: false,
            daily_count: 8,
            skipped_update_version: Some("0.2.0".to_string()),
            ..Settings::default()
        };
        let next = settings_skipping(&current, " 0.2.1 ").unwrap();
        assert_eq!(next.skipped_update_version.as_deref(), Some("0.2.1"));
        assert!(!next.sound);
        assert_eq!(next.daily_count, 8);
        assert_eq!(next.data_dir, current.data_dir);
        // 空の版は覚えない（いまの値のまま）
        assert!(settings_skipping(&current, "").is_err());
        assert!(settings_skipping(&current, "  ").is_err());
    }

    #[test]
    fn f21_a_skipped_version_survives_a_restart() {
        use crate::settings::settings_path;
        let dir = tempfile::tempdir().unwrap();
        let path = settings_path(dir.path());
        let next = settings_skipping(&Settings::default(), "0.2.1").unwrap();
        next.save(&path).unwrap();
        let loaded = Settings::load(&path).unwrap();
        assert_eq!(loaded.skipped_update_version.as_deref(), Some("0.2.1"));
        assert_eq!(loaded, next);
    }
}
