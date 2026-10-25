//! JantamaReviewer: 雀魂の半荘を検討するための個人用ツールの Rust 側（Tauri v2）。
//!
//! 対局中に動くのはウィジェットだけで、できるのは「画面の保存」と「記録の追記」だけ。
//! ゲームの画面やデータを機械で読み取らず、ゲームのプロセスにも触れず、通信もしない
//! （SPEC 2章。`tests/safety.rs` が機械的に確かめる）。

pub mod app_core;
pub mod appearance;
pub mod capture;
pub mod clipboard;
pub mod clock;
pub mod commands;
pub mod evaluation;
pub mod external;
pub mod ids;
pub mod import;
pub mod input_effects;
pub mod input_flow;
pub mod memo;
pub mod menu;
pub mod navigation;
pub mod platform;
pub mod ready;
pub mod recorder;
pub mod replay_keys;
pub mod settings;
pub mod sound;
pub mod store;
pub mod study;
pub mod sync;
pub mod trash;
pub mod update;
pub mod webview_data;
pub mod webview_policy;
pub mod widget_window;

use std::error::Error;
use std::path::PathBuf;
use std::sync::{Arc, Mutex};

use tauri::tray::TrayIconBuilder;
use tauri::{Manager, WindowEvent};

use crate::app_core::Core;
use crate::commands::{
    InputHandle, ModeMenus, PositionSaver, SharedCore, SharedShowGate, SoundMenuItems, WidgetMenu,
    SHOW_TIMEOUT,
};
use crate::input_effects::TauriEffects;
use crate::input_flow::{spawn_service, Input, InputState};
use crate::platform::Platform;
use crate::widget_window::{
    build_window, main_window_spec, move_window, widget_window_spec, MAIN_LABEL, WIDGET_LABEL,
};

/// 設定フォルダを置き換える環境変数。試しに動かすときに、本物の設定やデータに触れないために使う。
pub const CONFIG_DIR_ENV: &str = "JANTAMA_CONFIG_DIR";

/// 起動と同時に検討画面を開く引数（開発と確認用）。
pub const SHOW_MAIN_ARG: &str = "--show-main";

pub fn run() {
    let builder = tauri::Builder::default()
        .plugin(tauri_plugin_dialog::init())
        // アプリ内の更新（F21）。画面（webview）には部品の命令を使う権限を与えず、update::commands の命令だけが更新を扱う。
        .plugin(update::plugin())
        .invoke_handler(tauri::generate_handler![
            commands::get_platform_info,
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
            commands::delete_sessions,
            commands::restore_sessions,
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
            update::commands::get_update_info,
            update::commands::check_update,
            update::commands::install_update,
            update::commands::skip_update_version,
            import::commands::read_clipboard_text,
            import::commands::open_mjai_window,
            import::commands::close_mjai_window,
            import::commands::report_id_from_text,
            import::commands::fetch_report,
            import::commands::read_report_file_text,
            import::commands::ocr_sessions,
            import::commands::needs_ocr_reread,
            import::commands::reread_ocr,
            import::commands::save_report,
            import::commands::read_report,
            import::commands::set_mark_link,
            import::commands::clear_mark_link,
            import::commands::set_rating_link,
            import::commands::clear_rating_link,
            import::commands::replace_links,
            import::commands::replace_rating_links,
            evaluation::set_self_rating,
            evaluation::clear_self_rating,
            evaluation::set_maka_grade,
            evaluation::clear_maka_grade,
            evaluation::set_maka_hanchan,
            evaluation::clear_maka_hanchan,
            evaluation::set_resolved,
            memo::set_memo,
            memo::clear_memo,
            memo::set_extra_memo,
            memo::clear_extra_memo,
            study::commands::record_answer,
            study::commands::update_answer_notes,
            study::commands::list_answers,
            study::commands::get_daily_set,
            study::commands::save_daily_set,
            study::commands::count_solved,
            study::commands::list_weeks,
            study::commands::set_week,
            study::commands::records_overview,
            study::commands::export_records,
            study::commands::inspect_records_file,
            study::commands::import_records,
            sync::commands::get_sync_status,
            sync::commands::save_sync_connection,
            sync::commands::set_sync_enabled,
            sync::commands::sync_now,
            sync::commands::rebuild_sync_db,
            sync::commands::allow_sync_mass_delete,
            sync::commands::disconnect_sync,
        ])
        .on_menu_event(|app, event| menu::handle_menu_event(app, event.id().as_ref()))
        .on_window_event(on_window_event)
        .setup(setup);
    // 更新の部品の設定は、tauri.conf.json には書かず、ここで入れる（公開鍵が空でも起動できるように。update::plugin_config）。
    let mut context = tauri::generate_context!();
    update::prepare_config(context.config_mut());
    // macOS だけ、アプリ全体のメニュー（メニューバー）を付ける。Windows では何もしない。
    let app = platform::with_app_menu(builder)
        .build(context)
        .expect("アプリを起動できませんでした");
    app.run(|app, event| {
        // アプリを閉じるとき: 消した半荘のフォルダを、OS のごみ箱へ送る（U-9）。落ちたときは、次の起動で送る。
        if let tauri::RunEvent::Exit = event {
            flush_before_exit(app);
        }
        // macOS: Dock のアイコンを押したときに、検討画面を開く（OS ごとの知らせは platform に任せる）。
        platform::on_run_event(app, &event);
    });
}

/// アプリを閉じる前の片づけ（同期を止める・消した半荘をごみ箱へ送る）。閉じるとき（`RunEvent::Exit`）と、更新を入れ直すとき
/// （インストーラーを動かしてすぐ終わるので、`RunEvent::Exit` が来ない）の両方で呼ぶ。
pub(crate) fn flush_before_exit(app: &tauri::AppHandle) {
    if let Some(sync) = app.try_state::<sync::service::SyncService>() {
        sync.shutdown();
    }
    recycle_deleted_sessions(app);
}

/// 消した半荘の置き場を、ごみ箱へ送る。保存先は、設定から読む（記録の錠を取れなければ、あきらめる。次の起動で送る）。
fn recycle_deleted_sessions(app: &tauri::AppHandle) {
    let Some(core) = app.try_state::<SharedCore>() else {
        return;
    };
    let data_dir = core
        .lock_within(std::time::Duration::from_secs(1))
        .map(|core| core.settings().data_dir.clone());
    match data_dir {
        Some(dir) => trash::recycle_pending(&dir),
        None => {
            eprintln!("記録の錠を取れなかったので、消した半荘は、次の起動のときにごみ箱へ送ります")
        }
    }
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
        // 前面に来たときは、画面（取り込み）にも知らせる: クリップボードの牌譜リンクを探し直すため（F1、E-15）。
        (MAIN_LABEL, WindowEvent::Focused(focused)) => {
            tell_main_window_focus(window.app_handle(), *focused);
            if *focused {
                import::commands::announce_main_window_focus(window.app_handle());
            }
        }
        // mjai の窓が結果を見つける前に閉じられたら、検討画面に知らせる（取り込みの待ちをやめるため）。
        (import::mjai_window::MJAI_LABEL, WindowEvent::Destroyed) => {
            import::mjai_window::on_destroyed(window.app_handle());
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

    // OS ごとの部品（撮影・音・補助プログラム）。OS の違いは platform の中に閉じる。
    let platform = Platform::native();
    let core = Core::load(
        config_dir(app)?,
        Arc::clone(&platform.capturer),
        Arc::clone(&platform.sound),
    );
    let settings = core.settings().clone();
    // メニューの「取り消し」の、押せる・押せないの最初の状態（起動し直しても続けている半荘に、取り消せる記録がある）。
    let can_undo = core.app_state().can_undo;
    if let Some(note) = core.startup_note() {
        eprintln!("{note}");
    }
    // 前の起動で閉じきれずに（落ちて）、置き場に残った「消した半荘」を、ごみ箱へ送る（U-9）。
    trash::recycle_pending(&settings.data_dir);
    app.manage(SharedCore(Arc::new(Mutex::new(core))));
    app.manage(import::mjai_window::MjaiWindowState::default());
    // 答え・解き直しの予定・今日の出題を置く SQLite の接続（検討画面だけが使う。最初に呼ばれたとき開く）。
    app.manage(study::commands::SharedStudy::new());
    // 見つけた更新（「今すぐ入れ直す」が、確かめたときに見つけた更新をそのまま入れるため。F21）。
    app.manage(update::PendingUpdate::default());
    commands::allow_asset_dir(&handle, &settings.data_dir);
    // 記録の同期（F15）。使わない設定なら、裏のスレッドは何もしない。
    sync::commands::start(&handle, config_dir(app)?);

    // 入力の流れ: 本体の中のフック・補助プログラム・ボタンの登録とテスト（W-9、W-10、W-11）。
    // フックを入れられなくても、ウィジェットのボタンだけで動かせる。
    let (service, _worker) = spawn_service(InputState::new(settings.trigger.to_active()), {
        let handle = handle.clone();
        let helper = Arc::clone(&platform.helper);
        move |feedback| TauriEffects::start(handle, helper, feedback)
    });
    // 補助プログラムは、パイプを開いてから起動する（起動した補助プログラムが、すぐにつなぎにくる）。
    // 補助プログラムの無い OS では、開かない（入力の流れは、常に本体のフックだけで動く）。
    if platform.helper.supported() {
        match platform.helper.serve(service.sender()) {
            Ok(()) => commands::start_helper_at_launch(&service.sender(), &platform.helper),
            Err(e) => {
                eprintln!(
                    "補助プログラムのパイプを開けませんでした（本体のフックで動かします）: {e}"
                )
            }
        }
    }
    app.manage(InputHandle::new(service, Arc::clone(&platform.helper)));
    app.manage(PositionSaver(Mutex::new(commands::spawn_position_saver(
        handle.clone(),
    ))));

    // 窓は、どちらも隠したまま作る。画面が最初の絵を描き終えて知らせて（window_ready）から見せるので、
    // 描き終える前の白い面が見えない（N-7）。ウィジェットは位置を決めておき、知らせが来たら見せる。
    // ウィジェットの無い OS（macOS の段階 2。`Features::widget`）では、ウィジェットの窓・右クリックのメニュー・タスクトレイを作らない。
    let features = platform::info().features;
    app.manage(SharedShowGate::new());
    if features.widget {
        // 迷いだけ（既定）なら 48px 角、切なら選んだ形の大きさで作る（W-15）。
        let widget_spec = widget_window_spec(settings.orientation, settings.doubt_only);
        let widget = build_window(app, &widget_spec)?;
        platform::style_window(&widget, &widget_spec);
        if let Some(position) = commands::initial_widget_position(&widget, settings.widget_position)
        {
            move_window(&widget, position);
        }
    }

    // 検討画面の窓。起動時は隠しておく。
    let main_spec = main_window_spec();
    let main_window = build_window(app, &main_spec)?;
    platform::style_window(&main_window, &main_spec);
    // 開発と確認用: 引数に --show-main があれば、起動と同時に検討画面を開く（画面が描き終えたら見せる）。
    // ウィジェットの無い OS では、ほかに開く入口が無いので、いつも起動と同時に開く（閉じたあとは、Dock のアイコンから開き直す）。
    if !features.widget || std::env::args().any(|arg| arg == SHOW_MAIN_ARG) {
        commands::open_main_window_now(&handle);
    }
    // 画面からの知らせが来なくても、窓が見えないままにならないようにする。
    commands::spawn_show_watchdog(handle.clone(), SHOW_TIMEOUT);

    // 右クリックのメニューとタスクトレイ。「音を鳴らす」の印は、設定が変わるたびに両方で合わせる（W-12）。
    // 迷いだけ（W-15）の入・切で入れ替わる項目（「取り消し」と「縦長と横長を切り替える」）も、設定が変わるたびに両方で合わせ、
    // 「取り消し」の押せる・押せないは、記録の状態が変わるたびに合わせる。
    if features.widget {
        let widget_menu = menu::build_menu(app, settings.sound, settings.doubt_only, can_undo)?;
        let tray_menu = menu::build_menu(app, settings.sound, settings.doubt_only, can_undo)?;
        app.manage(SoundMenuItems(vec![
            widget_menu.sound.clone(),
            tray_menu.sound.clone(),
        ]));
        app.manage(ModeMenus(vec![widget_menu.mode, tray_menu.mode]));
        app.manage(WidgetMenu(widget_menu.menu));
        let mut tray = TrayIconBuilder::new()
            .tooltip("JantamaReviewer")
            .menu(&tray_menu.menu);
        if let Some(icon) = app.default_window_icon() {
            tray = tray.icon(icon.clone());
        }
        tray.build(app)?;
    }
    Ok(())
}
