//! JantamaReviewer: 雀魂の半荘を検討するための個人用ツールの Rust 側（Tauri v2）。
//!
//! 対局中に動くのはウィジェットだけで、できるのは「画面の保存」と「記録の追記」だけ。
//! ゲームの画面やデータを機械で読み取らず、ゲームのプロセスにも触れず、通信もしない
//! （SPEC 2章。`tests/safety.rs` が機械的に確かめる）。

#[cfg(not(windows))]
compile_error!("JantamaReviewer は Windows 専用です。");

pub mod app_core;
pub mod capture;
#[cfg(windows)]
pub mod capture_win;
pub mod clock;
pub mod commands;
pub mod hook;
#[cfg(windows)]
pub mod hook_win;
pub mod menu;
pub mod recorder;
pub mod settings;
pub mod sound;
pub mod store;
pub mod widget_window;

use std::error::Error;
use std::path::PathBuf;
use std::sync::mpsc;
use std::sync::{Arc, Mutex};

use tauri::tray::TrayIconBuilder;
use tauri::{Manager, WindowEvent};

use crate::app_core::Core;
use crate::capture_win::WindowsCapturer;
use crate::commands::{HookState, PositionSaver, SharedCore, WidgetMenu};
use crate::hook::ActiveTrigger;
use crate::sound::WindowsSound;
use crate::widget_window::{
    apply_native_style, build_window, main_window_spec, move_window, widget_window_spec,
    MAIN_LABEL, WIDGET_LABEL,
};

/// 設定フォルダを置き換える環境変数。試しに動かすときに、本物の設定やデータに触れないために使う。
pub const CONFIG_DIR_ENV: &str = "JANTAMA_CONFIG_DIR";

/// 起動と同時に検討画面を開く引数（開発と確認用）。
pub const SHOW_MAIN_ARG: &str = "--show-main";

pub fn run() {
    tauri::Builder::default()
        .plugin(tauri_plugin_dialog::init())
        .invoke_handler(tauri::generate_handler![
            commands::get_state,
            commands::add_mark,
            commands::add_rating,
            commands::undo,
            commands::new_session,
            commands::get_settings,
            commands::set_settings,
            commands::set_orientation,
            commands::open_main_window,
            commands::list_sessions,
            commands::get_startup_note,
            commands::show_widget_menu,
        ])
        .on_menu_event(|app, event| menu::handle_menu_event(app, event.id().as_ref()))
        .on_window_event(on_window_event)
        .setup(setup)
        .run(tauri::generate_context!())
        .expect("アプリを起動できませんでした");
}

fn on_window_event(window: &tauri::Window, event: &WindowEvent) {
    match (window.label(), event) {
        // 検討画面を閉じても、アプリ（ウィジェット）は動かし続ける。終了はメニューから。
        (MAIN_LABEL, WindowEvent::CloseRequested { api, .. }) => {
            api.prevent_close();
            let _ = window.hide();
        }
        (WIDGET_LABEL, WindowEvent::Moved(position)) => {
            commands::widget_moved(window.app_handle(), *position);
        }
        _ => {}
    }
}

fn config_dir(app: &tauri::App) -> Result<PathBuf, Box<dyn Error>> {
    match std::env::var_os(CONFIG_DIR_ENV) {
        Some(dir) if !dir.is_empty() => Ok(PathBuf::from(dir)),
        _ => Ok(app.path().app_config_dir()?),
    }
}

fn setup(app: &mut tauri::App) -> Result<(), Box<dyn Error>> {
    let handle = app.handle().clone();

    let core = Core::load(
        config_dir(app)?,
        Arc::new(WindowsCapturer),
        Arc::new(WindowsSound),
    );
    let settings = core.settings().clone();
    if let Some(note) = core.startup_note() {
        eprintln!("{note}");
    }
    app.manage(SharedCore(Arc::new(Mutex::new(core))));
    commands::allow_asset_dir(&handle, &settings.data_dir);

    // 割り当てたボタンのフック。入れられなくても、ウィジェットのボタンだけで動かせる。
    let (tx, rx) = mpsc::channel();
    let hook = match hook_win::start(ActiveTrigger::from_trigger(&settings.trigger), tx) {
        Ok(hook) => Some(hook),
        Err(e) => {
            eprintln!("ボタンのフックを入れられませんでした: {e}");
            None
        }
    };
    app.manage(HookState(hook));
    commands::spawn_trigger_worker(handle.clone(), rx);
    app.manage(PositionSaver(Mutex::new(commands::spawn_position_saver(
        handle.clone(),
    ))));

    // ウィジェットの窓。位置を決めてから見せる。
    let widget_spec = widget_window_spec(settings.orientation);
    let widget = build_window(app, &widget_spec)?;
    apply_native_style(&widget, &widget_spec);
    if let Some(position) = commands::initial_widget_position(&widget, settings.widget_position) {
        move_window(&widget, position);
    }
    widget.show()?;

    // 検討画面の窓。起動時は隠しておく。
    let main_spec = main_window_spec();
    let main_window = build_window(app, &main_spec)?;
    apply_native_style(&main_window, &main_spec);
    // 開発と確認用: 引数に --show-main があれば、起動と同時に検討画面を開く。
    if std::env::args().any(|arg| arg == SHOW_MAIN_ARG) {
        commands::open_main_window_now(&handle);
    }

    // 右クリックのメニューとタスクトレイ。
    app.manage(WidgetMenu(menu::build_menu(app)?));
    let tray_menu = menu::build_menu(app)?;
    let mut tray = TrayIconBuilder::new()
        .tooltip("JantamaReviewer")
        .menu(&tray_menu);
    if let Some(icon) = app.default_window_icon() {
        tray = tray.icon(icon.clone());
    }
    tray.build(app)?;
    Ok(())
}
