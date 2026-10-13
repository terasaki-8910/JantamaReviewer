//! 画面（ウィジェットと検討画面）から呼ばれる Tauri のコマンドと、メニューやフックから呼ぶ共通の動き。
//!
//! どの変更のあとも `state-changed`（記録の状態）か `settings-changed`（設定）を送り、
//! 2 つの窓が同じ内容に更新されるようにする。
//! 実際の処理は `app_core::Core`（Tauri に依存しない）に任せ、ここは薄い層にとどめる。

use std::path::Path;
use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::mpsc::{self, RecvTimeoutError, Sender};
use std::sync::{Arc, Mutex, MutexGuard, PoisonError};
use std::thread;
use std::time::Duration;

use jantama_input::keys::Modifiers;
use tauri::menu::{CheckMenuItem, Menu};
use tauri::window::Color;
use tauri::{
    AppHandle, Emitter, LogicalSize, Manager, PhysicalPosition, Runtime, State, WebviewWindow, Wry,
};

use crate::app_core::{AppState, Core, SettingsChange};
use crate::appearance::{parse_css_color, Rgb};
use crate::clock::now_ms;
use crate::input_flow::{page_key_input, HelperOp, Input, InputService, InputStatus};
use crate::platform::{HelperHost, PlatformInfo};
use crate::ready::ShowGate;
use crate::settings::{Orientation, Settings, WidgetPosition};
use crate::store::{Rating, SessionRecord};
use crate::trash;
use crate::widget_window::{
    clamp_to_monitors, default_widget_position, move_window, widget_size, Area, MAIN_LABEL,
    WIDGET_LABEL,
};

/// 記録の状態が変わったときに全部の窓へ送るイベント。
pub const EVENT_STATE_CHANGED: &str = "state-changed";
/// 設定が変わったときに全部の窓へ送るイベント。
pub const EVENT_SETTINGS_CHANGED: &str = "settings-changed";

/// アプリ全体の状態。`Mutex` で包んで、コマンドとフックの担当が共有する。
pub struct SharedCore(pub Arc<Mutex<Core>>);

impl SharedCore {
    /// 別のスレッドが途中で止まっていても、記録を続けられるよう、毒された錠は使い続ける。
    pub fn lock(&self) -> MutexGuard<'_, Core> {
        self.0.lock().unwrap_or_else(PoisonError::into_inner)
    }

    /// 錠を、`wait` の間だけ待って取る。取れなければ `None`（アプリを閉じるときに、ほかの処理に待たされて、
    /// 閉じられなくならないため）。
    pub fn lock_within(&self, wait: Duration) -> Option<MutexGuard<'_, Core>> {
        let deadline = std::time::Instant::now() + wait;
        loop {
            match self.0.try_lock() {
                Ok(guard) => return Some(guard),
                Err(std::sync::TryLockError::Poisoned(poisoned)) => {
                    return Some(poisoned.into_inner())
                }
                Err(std::sync::TryLockError::WouldBlock) => {
                    if std::time::Instant::now() >= deadline {
                        return None;
                    }
                    thread::sleep(Duration::from_millis(10));
                }
            }
        }
    }
}

/// 窓を見せる時機の管理（N-7）。ウィジェットは画面が最初の絵を描き終えたら見せる。検討画面は、見せる要求もそろったら見せる。
pub struct SharedShowGate(pub Mutex<ShowGate>);

impl SharedShowGate {
    pub fn new() -> SharedShowGate {
        SharedShowGate(Mutex::new(ShowGate::new(&[WIDGET_LABEL])))
    }

    pub fn lock(&self) -> MutexGuard<'_, ShowGate> {
        self.0.lock().unwrap_or_else(PoisonError::into_inner)
    }
}

impl Default for SharedShowGate {
    fn default() -> Self {
        SharedShowGate::new()
    }
}

/// 画面からの知らせが無いときに、窓を見せるまで待つ時間（N-7）。
pub const SHOW_TIMEOUT: Duration = Duration::from_secs(5);

/// 入力の流れ（本体のフック・補助プログラム・ボタンの登録とテスト）への窓口（W-9、W-10、W-11）。
pub struct InputHandle {
    pub service: InputService,
    /// 管理者の補助プログラム（Windows だけ。ほかの OS では、どの操作も失敗を返す）。
    helper: Arc<dyn HelperHost>,
    /// 補助プログラムの設定・解除・起動が進んでいる間は `true`（重ねて始めない）。
    helper_op_running: Arc<AtomicBool>,
}

impl InputHandle {
    pub fn new(service: InputService, helper: Arc<dyn HelperHost>) -> InputHandle {
        InputHandle {
            service,
            helper,
            helper_op_running: Arc::new(AtomicBool::new(false)),
        }
    }
}

/// ウィジェットの右クリックのメニュー。
pub struct WidgetMenu(pub Menu<Wry>);

/// 2 つのメニュー（右クリックとトレイ）の「音を鳴らす」の項目。設定が変わったときに、印を合わせる（W-12）。
pub struct SoundMenuItems(pub Vec<CheckMenuItem<Wry>>);

/// ウィジェットを動かしたときの位置を、動かし終わってから保存する担当への窓口。
pub struct PositionSaver(pub Mutex<Sender<WidgetPosition>>);

pub fn emit_state<R: Runtime>(app: &AppHandle<R>, state: &AppState) {
    let _ = app.emit(EVENT_STATE_CHANGED, state);
}

fn emit_settings<R: Runtime>(app: &AppHandle<R>, settings: &Settings) {
    let _ = app.emit(EVENT_SETTINGS_CHANGED, settings);
}

/// 保存先のフォルダの画像を、検討画面に出せるようにする（asset プロトコルの許可範囲）。
pub fn allow_asset_dir<R: Runtime>(app: &AppHandle<R>, dir: &Path) {
    if let Err(e) = app.asset_protocol_scope().allow_directory(dir, true) {
        eprintln!("画像の表示を許可できませんでした: {e}");
    }
}

// ---- 共通の動き（コマンド・メニュー・フックから使う） ----

pub fn mark_now<R: Runtime>(app: &AppHandle<R>, t_ms: i64) -> Result<AppState, String> {
    let shared = app.state::<SharedCore>();
    let result = shared.lock().mark(t_ms);
    let state = result.inspect_err(|_| {
        // 失敗しても、保存先の状態は画面に出し直す（「保存先エラー」の表示が最新になるように）。
        emit_state(app, &shared.lock().app_state());
    })?;
    emit_state(app, &state);
    Ok(state)
}

pub fn new_session_now<R: Runtime>(app: &AppHandle<R>) -> Result<AppState, String> {
    let shared = app.state::<SharedCore>();
    let state = shared.lock().new_session(now_ms())?;
    emit_state(app, &state);
    Ok(state)
}

/// 検討画面を開く。画面がまだ最初の絵を描き終えていなければ、描き終えてから見せる（N-7）。
pub fn open_main_window_now<R: Runtime>(app: &AppHandle<R>) {
    let show_now = app
        .state::<SharedShowGate>()
        .lock()
        .request_show(MAIN_LABEL);
    if show_now {
        present_window(app, MAIN_LABEL);
    }
}

/// 窓を実際に見せる。検討画面は前面に出す。ウィジェットは、前面のアプリからフォーカスを奪わない。
fn present_window<R: Runtime>(app: &AppHandle<R>, label: &str) {
    let Some(window) = app.get_webview_window(label) else {
        return;
    };
    if label == MAIN_LABEL {
        let _ = window.unminimize();
        let _ = window.show();
        let _ = window.set_focus();
    } else {
        let _ = window.show();
    }
}

/// 窓と webview の背景色を、画面が知らせてきた色にそろえる（N-7）。読めない色なら変えない。
fn apply_background<R: Runtime>(window: &WebviewWindow<R>, css_color: &str) {
    match parse_css_color(css_color) {
        Some(Rgb(r, g, b)) => {
            if let Err(e) = window.set_background_color(Some(Color(r, g, b, 255))) {
                eprintln!("[{}] 背景色を変えられませんでした: {e}", window.label());
            }
        }
        None => eprintln!(
            "[{}] 背景色を読めませんでした: {css_color:?}",
            window.label()
        ),
    }
}

/// 窓を隠したまま作ったあと、画面からの知らせが一定の時間来なくても、窓が見えないままにならないようにする（N-7）。
pub fn spawn_show_watchdog<R: Runtime>(app: AppHandle<R>, after: Duration) {
    let spawned = thread::Builder::new()
        .name("show-watchdog".to_string())
        .spawn(move || {
            thread::sleep(after);
            for label in [WIDGET_LABEL, MAIN_LABEL] {
                // ウィジェットの無い OS（macOS の段階 2）では、ウィジェットの窓は作っていない。
                if app.get_webview_window(label).is_none() {
                    continue;
                }
                let show = app.state::<SharedShowGate>().lock().timeout(label);
                if show {
                    eprintln!(
                        "画面からの知らせが無いまま {after:?} たったので、{label} を見せます"
                    );
                    present_window(&app, label);
                }
            }
        });
    if let Err(e) = spawned {
        eprintln!("窓を見せる見張りのスレッドを起こせませんでした: {e}");
    }
}

pub fn toggle_orientation_now<R: Runtime>(app: &AppHandle<R>) -> Result<Settings, String> {
    let next = app
        .state::<SharedCore>()
        .lock()
        .settings()
        .orientation
        .toggled();
    set_orientation_now(app, next)
}

/// 音の入・切を反対にする（メニューの「音を鳴らす」。設定のチェックと同じ設定を切り替える。W-12）。
pub fn toggle_sound_now<R: Runtime>(app: &AppHandle<R>) -> Result<Settings, String> {
    let mut settings = app.state::<SharedCore>().lock().settings().clone();
    settings.sound = !settings.sound;
    set_settings_now(app, settings)
}

pub fn set_orientation_now<R: Runtime>(
    app: &AppHandle<R>,
    orientation: Orientation,
) -> Result<Settings, String> {
    let mut settings = app.state::<SharedCore>().lock().settings().clone();
    settings.orientation = orientation;
    set_settings_now(app, settings)
}

pub fn set_settings_now<R: Runtime>(
    app: &AppHandle<R>,
    settings: Settings,
) -> Result<Settings, String> {
    let shared = app.state::<SharedCore>();
    let (applied, change, state, previous_data_dir) = {
        let mut core = shared.lock();
        let previous_data_dir = core.settings().data_dir.clone();
        let change = core.apply_settings(settings)?;
        (
            core.settings().clone(),
            change,
            core.app_state(),
            previous_data_dir,
        )
    };
    if change.data_dir {
        // 保存先を変えると、前の保存先の置き場は、もう誰も見ない。消した半荘が残っていたら、いまごみ箱へ送る。
        trash::recycle_pending(&previous_data_dir);
    }
    apply_side_effects(app, &applied, change);
    emit_settings(app, &applied);
    if change.data_dir {
        emit_state(app, &state);
    }
    Ok(applied)
}

/// 設定の変更を、フック・窓・画像の許可範囲に反映する。変わったものだけ。
fn apply_side_effects<R: Runtime>(app: &AppHandle<R>, settings: &Settings, change: SettingsChange) {
    if change.trigger {
        if let Some(input) = app.try_state::<InputHandle>() {
            input
                .service
                .send(Input::TriggerChanged(settings.trigger.to_active()));
        }
    }
    if change.sound {
        sync_sound_menus(app, settings.sound);
    }
    if change.orientation {
        resize_widget(app, settings.orientation);
    }
    if change.data_dir {
        allow_asset_dir(app, &settings.data_dir);
    }
}

/// メニューの「音を鳴らす」の印を、設定に合わせる（設定のチェックから変えたときも、メニューから変えたときも）。
fn sync_sound_menus<R: Runtime>(app: &AppHandle<R>, on: bool) {
    let Some(items) = app.try_state::<SoundMenuItems>() else {
        return;
    };
    for item in &items.0 {
        if let Err(e) = item.set_checked(on) {
            eprintln!("メニューの音の印を変えられませんでした: {e}");
        }
    }
}

/// ウィジェットの窓の大きさを形に合わせる。左上は動かさず、画面の外に出るなら内側に寄せる。
fn resize_widget<R: Runtime>(app: &AppHandle<R>, orientation: Orientation) {
    let Some(window) = app.get_webview_window(WIDGET_LABEL) else {
        return;
    };
    let (width, height) = widget_size(orientation);
    let _ = window.set_size(LogicalSize::new(width, height));
    let scale = window.scale_factor().unwrap_or(1.0);
    let size = (
        (width * scale).round() as i32,
        (height * scale).round() as i32,
    );
    if let Ok(position) = window.outer_position() {
        let monitors = monitor_areas(&window);
        let fixed = clamp_to_monitors((position.x, position.y), size, &monitors);
        if fixed != (position.x, position.y) {
            move_window(&window, fixed);
        }
    }
}

/// 画面の作業領域（タスクバーを除く）の一覧。
pub fn monitor_areas<R: Runtime>(window: &WebviewWindow<R>) -> Vec<Area> {
    window
        .available_monitors()
        .unwrap_or_default()
        .iter()
        .map(|m| Area {
            x: m.work_area().position.x,
            y: m.work_area().position.y,
            width: m.work_area().size.width as i32,
            height: m.work_area().size.height as i32,
        })
        .collect()
}

/// 起動時のウィジェットの位置: 保存した位置（画面の中に収める）、無ければ主画面の右寄り。
pub fn initial_widget_position<R: Runtime>(
    window: &WebviewWindow<R>,
    saved: Option<WidgetPosition>,
) -> Option<(i32, i32)> {
    let size = window.outer_size().ok()?;
    let size = (size.width as i32, size.height as i32);
    let monitors = monitor_areas(window);
    match saved {
        Some(p) => Some(clamp_to_monitors((p.x, p.y), size, &monitors)),
        None => {
            let primary = window.primary_monitor().ok().flatten()?;
            let work = primary.work_area();
            Some(default_widget_position(
                size,
                Area {
                    x: work.position.x,
                    y: work.position.y,
                    width: work.size.width as i32,
                    height: work.size.height as i32,
                },
            ))
        }
    }
}

/// ウィジェットを動かし終わってから、位置を保存する担当のスレッド。
pub fn spawn_position_saver<R: Runtime>(app: AppHandle<R>) -> Sender<WidgetPosition> {
    let (tx, rx) = mpsc::channel::<WidgetPosition>();
    let spawned = thread::Builder::new()
        .name("position-saver".to_string())
        .spawn(move || {
            while let Ok(mut latest) = rx.recv() {
                // 0.5 秒のあいだ新しい位置が来なくなったら、動かし終わったとみなして保存する。
                loop {
                    match rx.recv_timeout(Duration::from_millis(500)) {
                        Ok(next) => latest = next,
                        Err(RecvTimeoutError::Timeout) => break,
                        Err(RecvTimeoutError::Disconnected) => return,
                    }
                }
                let shared = app.state::<SharedCore>();
                let saved = shared.lock().set_widget_position(latest);
                if let Err(e) = saved {
                    eprintln!("ウィジェットの位置を保存できませんでした: {e}");
                }
            }
        });
    if let Err(e) = spawned {
        eprintln!("位置を保存する担当のスレッドを起こせませんでした: {e}");
    }
    tx
}

/// ウィジェットの窓が動いたときに呼ぶ。位置の保存は動かし終わってから。
pub fn widget_moved<R: Runtime>(app: &AppHandle<R>, position: PhysicalPosition<i32>) {
    // 最小化などで窓が画面の外（-32000）に退避されたときの位置は覚えない。
    if position.x <= -30_000 || position.y <= -30_000 {
        return;
    }
    let saver = app.state::<PositionSaver>();
    let sender = saver.0.lock().unwrap_or_else(PoisonError::into_inner);
    let _ = sender.send(WidgetPosition {
        x: position.x,
        y: position.y,
    });
}

// ---- Tauri のコマンド ----

/// 動いている OS の名前と、使える機能（macOS の段階 2。設定ページが、使えない機能の行を出さないために、起動のとき 1 回呼ぶ）。
#[tauri::command]
pub async fn get_platform_info() -> Result<PlatformInfo, String> {
    Ok(crate::platform::info())
}

#[tauri::command]
pub async fn get_state(core: State<'_, SharedCore>) -> Result<AppState, String> {
    Ok(core.lock().app_state())
}

/// ウィジェットの「迷い」ボタンも、割り当てたボタンと同じ記録をつくる。
#[tauri::command]
pub async fn add_mark(app: AppHandle) -> Result<AppState, String> {
    mark_now(&app, now_ms())
}

#[tauri::command]
pub async fn add_rating(
    app: AppHandle,
    core: State<'_, SharedCore>,
    rating: Rating,
) -> Result<AppState, String> {
    let state = core.lock().rate(now_ms(), rating)?;
    emit_state(&app, &state);
    Ok(state)
}

#[tauri::command]
pub async fn undo(app: AppHandle, core: State<'_, SharedCore>) -> Result<AppState, String> {
    let state = core.lock().undo(now_ms())?;
    emit_state(&app, &state);
    Ok(state)
}

#[tauri::command]
pub async fn new_session(app: AppHandle) -> Result<AppState, String> {
    new_session_now(&app)
}

#[tauri::command]
pub async fn get_settings(core: State<'_, SharedCore>) -> Result<Settings, String> {
    Ok(core.lock().settings().clone())
}

#[tauri::command]
pub async fn set_settings(app: AppHandle, settings: Settings) -> Result<Settings, String> {
    set_settings_now(&app, settings)
}

#[tauri::command]
pub async fn set_orientation(app: AppHandle, orientation: Orientation) -> Result<Settings, String> {
    set_orientation_now(&app, orientation)
}

#[tauri::command]
pub async fn open_main_window(app: AppHandle) -> Result<(), String> {
    open_main_window_now(&app);
    Ok(())
}

#[tauri::command]
pub async fn list_sessions(core: State<'_, SharedCore>) -> Result<Vec<SessionRecord>, String> {
    core.lock().list_sessions()
}

/// 半荘を消す（U-9）。半荘のフォルダを、保存先の `trash/` へ移す（一瞬）。アプリを閉じるとき（落ちたときは、次の起動のとき）に、
/// Windows のごみ箱へ送る。それまでは `restore_sessions` で戻せる。ウィジェットが記録中の半荘も、消せる（その半荘は閉じる）。
#[tauri::command]
pub async fn delete_sessions(
    app: AppHandle,
    core: State<'_, SharedCore>,
    ids: Vec<String>,
) -> Result<(), String> {
    let state = core.lock().delete_sessions(&ids)?;
    emit_state(&app, &state);
    Ok(())
}

/// 消した半荘を戻す（U-9。「元に戻す」と Ctrl+Z）。
#[tauri::command]
pub async fn restore_sessions(
    app: AppHandle,
    core: State<'_, SharedCore>,
    ids: Vec<String>,
) -> Result<(), String> {
    let state = core.lock().restore_sessions(&ids)?;
    emit_state(&app, &state);
    Ok(())
}

/// 起動時に伝えたいこと（壊れた設定ファイルを退避した、など）。
#[tauri::command]
pub async fn get_startup_note(core: State<'_, SharedCore>) -> Result<Option<String>, String> {
    Ok(core.lock().startup_note().map(str::to_string))
}

/// 画面が最初の絵を描き終えたときに呼ぶ（N-7）。窓と webview の背景色を、画面が描いている背景の色にそろえてから、窓を見せる。
/// 画面が描き終える前に窓を見せると、白い面が一瞬見えてしまう。
#[tauri::command]
pub async fn window_ready(
    app: AppHandle,
    window: WebviewWindow,
    background: String,
) -> Result<(), String> {
    apply_background(&window, &background);
    let show = app
        .state::<SharedShowGate>()
        .lock()
        .mark_ready(window.label());
    if show {
        present_window(&app, window.label());
    }
    Ok(())
}

/// テーマが変わったときに呼ぶ。窓と webview の背景色を、画面が描いている背景の色にそろえる（N-7）。
#[tauri::command]
pub async fn set_window_background(
    window: WebviewWindow,
    background: String,
) -> Result<(), String> {
    apply_background(&window, &background);
    Ok(())
}

/// 開発者ツールを開く（N-12）。`tauri dev` のときだけ。製品のビルドでは何もしない。
/// ブラウザのショートカット（F12 など）は切っているので、開発のときだけ、画面側の F12 のキー処理がこれを呼ぶ。
#[tauri::command]
pub async fn open_devtools(window: WebviewWindow) -> Result<(), String> {
    #[cfg(debug_assertions)]
    if tauri::is_dev() {
        window.open_devtools();
    }
    #[cfg(not(debug_assertions))]
    let _ = window;
    Ok(())
}

/// ウィジェットの右クリックで、ネイティブのメニューを出す。
#[tauri::command]
pub async fn show_widget_menu(
    window: WebviewWindow,
    menu: State<'_, WidgetMenu>,
) -> Result<(), String> {
    window.popup_menu(&menu.0).map_err(|e| e.to_string())
}

// ---- 入力の流れ（ボタンの登録・テスト・補助プログラム。W-9、W-10、W-11） ----

/// 入力の状態。設定ページを開いたときに呼ぶ。起動の登録（タスク）があるかは、裏で確かめ直す。
/// 変わったときは `input-status-changed` で知らせる。
#[tauri::command]
pub async fn get_input_status(input: State<'_, InputHandle>) -> Result<InputStatus, String> {
    refresh_installed(&input.service.sender(), &input.helper);
    Ok(input.service.status())
}

/// 「ボタンを登録」。次に押された登録できる入力が、割り当てになる（W-10）。
#[tauri::command]
pub async fn start_registration(input: State<'_, InputHandle>) -> Result<(), String> {
    input.service.send(Input::StartRegistration);
    Ok(())
}

/// 登録をやめる（キャンセルのボタン・Esc）。
#[tauri::command]
pub async fn cancel_registration(input: State<'_, InputHandle>) -> Result<(), String> {
    input.service.send(Input::CancelRegistration);
    Ok(())
}

/// 設定ページが、テストの欄を見せているか。見せている間（かつ窓が操作を受けている間）、
/// 割り当てたボタンを押しても記録せず、受け取ったことだけを知らせる（W-11）。
/// 窓が操作を受けているかは、窓の知らせ（`Focused`）で追っているが、取りこぼしても合うよう、ここでも確かめ直す。
#[tauri::command]
pub async fn set_probe_wanted(
    app: AppHandle,
    input: State<'_, InputHandle>,
    wanted: bool,
) -> Result<(), String> {
    input.service.send(Input::ProbeWanted(wanted));
    if wanted {
        if let Some(window) = app.get_webview_window(MAIN_LABEL) {
            input
                .service
                .send(Input::WindowFocus(window.is_focused().unwrap_or(false)));
        }
    }
    Ok(())
}

/// 検討画面が拾ったキー入力（DOM の `KeyboardEvent` の `code` と修飾キー）。
#[derive(Debug, Clone, serde::Deserialize)]
pub struct PageKeyEvent {
    pub code: String,
    #[serde(default)]
    pub ctrl: bool,
    #[serde(default)]
    pub alt: bool,
    #[serde(default)]
    pub shift: bool,
    #[serde(default)]
    pub meta: bool,
}

/// 検討画面が前面にある間、本体のキーボードのフックには入力が届かない（Windows の側の事情。フックは外してある）。
/// その間のキー入力を、設定ページがここへ知らせる。登録の待機中は登録の候補になり、テストの間は、
/// 割り当てたキーなら押下になる（W-10、W-11）。それ以外のときは何もしない。
#[tauri::command]
pub async fn report_page_key(
    input: State<'_, InputHandle>,
    key: PageKeyEvent,
) -> Result<(), String> {
    let mods = Modifiers::new(key.ctrl, key.alt, key.shift, key.meta);
    if let Some(event) = page_key_input(&key.code, mods, now_ms()) {
        input.service.send(event);
    }
    Ok(())
}

/// 「管理者の補助プログラムを設定する」。Windows の確認が出る（最初の 1 回だけ）。進み具合は状態で知らせる。
#[tauri::command]
pub async fn setup_helper(input: State<'_, InputHandle>) -> Result<(), String> {
    run_helper_op(&input, HelperOp::Installing);
    Ok(())
}

/// 補助プログラムの設定を解除する。Windows の確認が出る。
#[tauri::command]
pub async fn remove_helper(input: State<'_, InputHandle>) -> Result<(), String> {
    run_helper_op(&input, HelperOp::Removing);
    Ok(())
}

/// 設定済みの補助プログラムを起動する。確認は出ない。
#[tauri::command]
pub async fn start_helper(input: State<'_, InputHandle>) -> Result<(), String> {
    run_helper_op(&input, HelperOp::Starting);
    Ok(())
}

/// 起動の登録（タスク）があるかを、裏で確かめて、入力の流れに知らせる。
pub fn refresh_installed(tx: &Sender<Input>, helper: &Arc<dyn HelperHost>) {
    let tx = tx.clone();
    let helper = Arc::clone(helper);
    let spawned = thread::Builder::new()
        .name("helper-installed".to_string())
        .spawn(move || {
            let _ = tx.send(Input::InstalledKnown(helper.query_installed()));
        });
    if let Err(e) = spawned {
        eprintln!("補助プログラムの登録を確かめるスレッドを起こせませんでした: {e}");
    }
}

/// 本体の起動のとき、補助プログラムが設定済みなら、確認なしで起動する（W-9）。
/// パイプを開いてから呼ぶ（補助プログラムが、すぐにつなぎにくるため）。
pub fn start_helper_at_launch(tx: &Sender<Input>, helper: &Arc<dyn HelperHost>) {
    let tx = tx.clone();
    let helper = Arc::clone(helper);
    let spawned = thread::Builder::new()
        .name("helper-launch".to_string())
        .spawn(move || {
            let installed = helper.query_installed();
            let _ = tx.send(Input::InstalledKnown(installed));
            if installed {
                if let Err(e) = helper.run_task() {
                    eprintln!("{e}");
                }
            }
        });
    if let Err(e) = spawned {
        eprintln!("補助プログラムを起動するスレッドを起こせませんでした: {e}");
    }
}

/// 補助プログラムの設定・解除・起動を、裏で進める。すでに別の操作が進んでいれば、何もしない。
fn run_helper_op(input: &InputHandle, op: HelperOp) {
    if input.helper_op_running.swap(true, Ordering::SeqCst) {
        return;
    }
    let tx = input.service.sender();
    let running = Arc::clone(&input.helper_op_running);
    let _ = tx.send(Input::HelperOpStarted(op));
    let spawned = thread::Builder::new().name("helper-op".to_string()).spawn({
        let tx = tx.clone();
        let running = Arc::clone(&running);
        let helper = Arc::clone(&input.helper);
        move || {
            let result = perform_helper_op(op, &tx, helper.as_ref());
            let _ = tx.send(Input::HelperOpFinished { result });
            running.store(false, Ordering::SeqCst);
        }
    });
    if let Err(e) = spawned {
        let _ = tx.send(Input::HelperOpFinished {
            result: Err(format!("操作のスレッドを起こせませんでした: {e}")),
        });
        running.store(false, Ordering::SeqCst);
    }
}

fn perform_helper_op(
    op: HelperOp,
    tx: &Sender<Input>,
    helper: &dyn HelperHost,
) -> Result<(), String> {
    match op {
        HelperOp::Installing => {
            helper.install()?;
            let _ = tx.send(Input::InstalledKnown(helper.query_installed()));
            // 設定できたら、そのまま起動する（アプリを開き直さなくてよい）。
            helper
                .run_task()
                .map_err(|e| format!("設定はできましたが、{e}"))
        }
        HelperOp::Removing => {
            let result = helper.uninstall();
            let _ = tx.send(Input::InstalledKnown(helper.query_installed()));
            result
        }
        HelperOp::Starting => helper.run_task(),
    }
}
