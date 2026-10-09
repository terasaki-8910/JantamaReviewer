//! JantamaReviewer: 雀魂の半荘を検討するための個人用ツールの Rust 側（Tauri v2）。
//!
//! 対局中に動くのはウィジェットだけで、できるのは「画面の保存」と「記録の追記」だけ。
//! ゲームの画面やデータを機械で読み取らず、ゲームのプロセスにも触れず、通信もしない
//! （SPEC 2章。`tests/safety.rs` が機械的に確かめる）。

#[cfg(not(windows))]
compile_error!("JantamaReviewer は Windows 専用です。");

pub mod app_core;
pub mod appearance;
pub mod capture;
#[cfg(windows)]
pub mod capture_win;
pub mod clock;
pub mod commands;
pub mod external;
#[cfg(windows)]
pub mod helper_link;
pub mod helper_setup;
#[cfg(windows)]
pub mod input_effects;
pub mod input_flow;
pub mod menu;
pub mod navigation;
pub mod ready;
pub mod recorder;
pub mod settings;
pub mod sound;
pub mod store;
pub mod webview_policy;
#[cfg(windows)]
pub mod webview_win;
pub mod widget_window;

use std::error::Error;
use std::path::PathBuf;
use std::sync::{Arc, Mutex};

use tauri::tray::TrayIconBuilder;
use tauri::{Manager, WindowEvent};

use crate::app_core::Core;
use crate::capture_win::WindowsCapturer;
use crate::commands::{
    InputHandle, PositionSaver, SharedCore, SharedShowGate, SoundMenuItems, WidgetMenu,
    SHOW_TIMEOUT,
};
use crate::helper_link::HelperWriter;
use crate::input_effects::TauriEffects;
use crate::input_flow::{spawn_service, Input, InputState};
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
            commands::window_ready,
            commands::set_window_background,
            commands::open_devtools,
            commands::get_input_status,
            commands::start_registration,
            commands::cancel_registration,
            commands::set_probe_wanted,
            commands::report_page_key,
            commands::setup_helper,
            commands::remove_helper,
            commands::start_helper,
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
            tell_main_window_focus(window.app_handle(), false);
        }
        // 検討画面が操作を受けている間だけ、設定のテストが効く（W-11）。
        (MAIN_LABEL, WindowEvent::Focused(focused)) => {
            tell_main_window_focus(window.app_handle(), *focused);
        }
        (WIDGET_LABEL, WindowEvent::Moved(position)) => {
            commands::widget_moved(window.app_handle(), *position);
        }
        _ => {}
    }
}

/// 検討画面の窓が操作を受けているかを、入力の流れに知らせる。
fn tell_main_window_focus(app: &tauri::AppHandle, focused: bool) {
    if let Some(input) = app.try_state::<InputHandle>() {
        input.service.send(Input::WindowFocus(focused));
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

    // 入力の流れ: 本体の中のフック・補助プログラム・ボタンの登録とテスト（W-9、W-10、W-11）。
    // フックを入れられなくても、ウィジェットのボタンだけで動かせる。
    let helper_writer = HelperWriter::default();
    let (service, _worker) = spawn_service(InputState::new(settings.trigger.to_active()), {
        let handle = handle.clone();
        let writer = helper_writer.clone();
        move |feedback| TauriEffects::start(handle, writer, feedback)
    });
    // 補助プログラムは、パイプを開いてから起動する（起動した補助プログラムが、すぐにつなぎにくる）。
    match helper_link::spawn_server(service.sender(), helper_writer) {
        Ok(()) => commands::start_helper_at_launch(&service.sender()),
        Err(e) => {
            eprintln!("補助プログラムのパイプを開けませんでした（本体のフックで動かします）: {e}")
        }
    }
    app.manage(InputHandle::new(service));
    app.manage(PositionSaver(Mutex::new(commands::spawn_position_saver(
        handle.clone(),
    ))));

    // 窓は、どちらも隠したまま作る。画面が最初の絵を描き終えて知らせて（window_ready）から見せるので、
    // 描き終える前の白い面が見えない（N-7）。ウィジェットは位置を決めておき、知らせが来たら見せる。
    app.manage(SharedShowGate::new());
    let widget_spec = widget_window_spec(settings.orientation);
    let widget = build_window(app, &widget_spec)?;
    apply_native_style(&widget, &widget_spec);
    if let Some(position) = commands::initial_widget_position(&widget, settings.widget_position) {
        move_window(&widget, position);
    }

    // 検討画面の窓。起動時は隠しておく。
    let main_spec = main_window_spec();
    let main_window = build_window(app, &main_spec)?;
    apply_native_style(&main_window, &main_spec);
    // 開発と確認用: 引数に --show-main があれば、起動と同時に検討画面を開く（画面が描き終えたら見せる）。
    if std::env::args().any(|arg| arg == SHOW_MAIN_ARG) {
        commands::open_main_window_now(&handle);
    }
    // 画面からの知らせが来なくても、窓が見えないままにならないようにする。
    commands::spawn_show_watchdog(handle.clone(), SHOW_TIMEOUT);

    // 右クリックのメニューとタスクトレイ。「音を鳴らす」の印は、設定が変わるたびに両方で合わせる（W-12）。
    let widget_menu = menu::build_menu(app, settings.sound)?;
    let tray_menu = menu::build_menu(app, settings.sound)?;
    app.manage(SoundMenuItems(vec![
        widget_menu.sound.clone(),
        tray_menu.sound.clone(),
    ]));
    app.manage(WidgetMenu(widget_menu.menu));
    let mut tray = TrayIconBuilder::new()
        .tooltip("JantamaReviewer")
        .menu(&tray_menu.menu);
    if let Some(icon) = app.default_window_icon() {
        tray = tray.icon(icon.clone());
    }
    tray.build(app)?;
    Ok(())
}
