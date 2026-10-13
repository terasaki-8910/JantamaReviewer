//! 同期の Tauri のコマンドと、アプリへのつなぎ（F15）。呼べるのは検討画面だけ（ウィジェットの窓には、同期に触れる理由が無い）。
//!
//! 実際の同期は `service.rs` の担当が裏のスレッドで行い、ここは、設定の保存・状態の読み取り・「今すぐ同期」などの入口と、
//! アプリの記録（錠・答えの接続・設定）を同期の部品に渡す口（`AppPorts`）だけを持つ。
//! トークンは、画面からこのコマンドの引数で 1 回だけ受け取り、OS の資格情報の保管庫に入れる。画面には返さない。

use std::path::PathBuf;
use std::sync::Arc;

use tauri::{AppHandle, Emitter, Manager, State, WebviewWindow};

use super::credentials::{OsTokenStore, TokenStore};
use super::local::{change_marker, Ports};
use super::remote::{Remote, Timeouts, TursoRemote};
use super::service::{Notifier, SyncHost, SyncService, SyncStatus, Timers, EVENT_SYNC_STATUS};
use crate::clock::now_ms;
use crate::commands::{emit_state, set_settings_now, SharedCore};
use crate::settings::{settings_path, Settings};
use crate::study::commands::SharedStudy;
use crate::study::StudyDb;
use crate::widget_window::MAIN_LABEL;

/// アプリの記録を、同期の部品に渡す口。
pub struct AppPorts {
    app: AppHandle,
    config_dir: PathBuf,
}

impl Ports for AppPorts {
    fn data_dir(&self) -> PathBuf {
        self.app
            .state::<SharedCore>()
            .lock()
            .settings()
            .data_dir
            .clone()
    }

    fn with_records_lock(&self, f: &mut dyn FnMut()) {
        let core = self.app.state::<SharedCore>();
        let _guard = core.lock();
        f();
    }

    fn with_study(
        &self,
        f: &mut dyn FnMut(&mut StudyDb) -> Result<(), String>,
    ) -> Result<(), String> {
        let data_dir = self.data_dir();
        let study = self.app.state::<SharedStudy>();
        study.with(&data_dir, |db| f(db))
    }

    fn settings(&self) -> Settings {
        self.app.state::<SharedCore>().lock().settings().clone()
    }

    fn settings_hint_ms(&self) -> Option<i64> {
        let modified = std::fs::metadata(settings_path(&self.config_dir))
            .ok()?
            .modified()
            .ok()?;
        let since = modified.duration_since(std::time::UNIX_EPOCH).ok()?;
        i64::try_from(since.as_millis()).ok()
    }

    fn apply_settings(&self, settings: Settings) -> Result<(), String> {
        set_settings_now(&self.app, settings).map(|_| ())
    }

    fn delete_session(&self, id: &str) -> Result<(), String> {
        let state = {
            let core = self.app.state::<SharedCore>();
            let mut core = core.lock();
            core.delete_sessions(&[id.to_string()])?
        };
        emit_state(&self.app, &state);
        Ok(())
    }
}

/// 画面への知らせ。
struct TauriNotifier {
    app: AppHandle,
}

impl Notifier for TauriNotifier {
    fn status_changed(&self, status: &SyncStatus) {
        let _ = self.app.emit(EVENT_SYNC_STATUS, status);
    }

    fn records_changed(&self) {
        let state = self.app.state::<SharedCore>().lock().app_state();
        emit_state(&self.app, &state);
    }
}

/// 同期の担当を始めて、アプリの状態に置く。起動のとき 1 回だけ呼ぶ。
pub fn start(app: &AppHandle, config_dir: PathBuf) {
    let tokens: Arc<dyn TokenStore> = Arc::new(OsTokenStore::for_config_dir(&config_dir));
    let marker_app = app.clone();
    let marker_config = config_dir.clone();
    let host = SyncHost {
        ports: AppPorts {
            app: app.clone(),
            config_dir: config_dir.clone(),
        },
        notifier: Arc::new(TauriNotifier { app: app.clone() }),
        change_marker: Arc::new(move || {
            let data_dir = marker_app
                .state::<SharedCore>()
                .lock()
                .settings()
                .data_dir
                .clone();
            change_marker(&data_dir, &settings_path(&marker_config))
        }),
        open_remote: Arc::new(|path, endpoint, token, name| {
            let remote: Box<dyn Remote> = Box::new(TursoRemote::new(
                path,
                endpoint,
                token,
                name,
                Timeouts::default(),
            )?);
            Ok(remote)
        }),
        now_ms: Arc::new(now_ms),
        timers: Timers::default(),
    };
    let service = SyncService::start(config_dir, tokens, host);
    app.manage(service);
}

fn ensure_main(window: &WebviewWindow) -> Result<(), String> {
    if window.label() == MAIN_LABEL {
        Ok(())
    } else {
        Err("同期は、検討画面からだけ扱えます".to_string())
    }
}

/// いまの同期の状態。
#[tauri::command]
pub async fn get_sync_status(
    window: WebviewWindow,
    sync: State<'_, SyncService>,
) -> Result<SyncStatus, String> {
    ensure_main(&window)?;
    Ok(sync.status())
}

/// 同期先の URL と、トークン（貼ったときだけ）を保存する。トークンは、OS の資格情報の保管庫にだけ入る。
#[tauri::command]
pub async fn save_sync_connection(
    window: WebviewWindow,
    sync: State<'_, SyncService>,
    url: Option<String>,
    token: Option<String>,
) -> Result<SyncStatus, String> {
    ensure_main(&window)?;
    sync.save_connection(url.as_deref(), token.as_deref())
}

/// 同期を使う・使わない。
#[tauri::command]
pub async fn set_sync_enabled(
    window: WebviewWindow,
    sync: State<'_, SyncService>,
    enabled: bool,
) -> Result<SyncStatus, String> {
    ensure_main(&window)?;
    sync.set_enabled(enabled)
}

/// 今すぐ同期する（裏で行う。結果は、状態の知らせで届く）。
#[tauri::command]
pub async fn sync_now(window: WebviewWindow, sync: State<'_, SyncService>) -> Result<(), String> {
    ensure_main(&window)?;
    sync.sync_now();
    Ok(())
}

/// 同期用の DB を作り直して、手元の記録から入れ直す（裏で行う）。
#[tauri::command]
pub async fn rebuild_sync_db(
    window: WebviewWindow,
    sync: State<'_, SyncService>,
) -> Result<(), String> {
    ensure_main(&window)?;
    sync.rebuild();
    Ok(())
}

/// 大量の消去の止めを、1 回だけ外して同期する（裏で行う）。
#[tauri::command]
pub async fn allow_sync_mass_delete(
    window: WebviewWindow,
    sync: State<'_, SyncService>,
) -> Result<(), String> {
    ensure_main(&window)?;
    sync.allow_mass_delete();
    Ok(())
}

/// この端末の同期を切る（トークンを保管庫から消し、同期の作業のフォルダを消す）。手元の記録と、同期用の DB には触れない。
#[tauri::command]
pub async fn disconnect_sync(
    window: WebviewWindow,
    sync: State<'_, SyncService>,
) -> Result<SyncStatus, String> {
    ensure_main(&window)?;
    sync.disconnect()
}
