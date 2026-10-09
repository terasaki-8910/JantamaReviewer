//! mjai のサイトを開く小さな窓（F1、R3-3）。
//!
//! 「検討結果を取り込む」を押すと、この窓で mjai のサイトを開き、URL 欄に牌譜リンクを入れておく。ユーザーが Submit を押す
//! （Cloudflare の確認もユーザーが通す。アプリが自動で送ることはしない。SPEC 2 章）。結果のページへ移ろうとした時点で、
//! その移動を止めて窓を閉じ、結果の ID を検討画面に知らせる（結果の JSON は、画面から `fetch_report` で取る）。AI の答えは画面に出さない。
//!
//! - 開けるのは mjai のサイトと Cloudflare の確認の画面だけ（`mjai_nav::decide_navigation`）。新しい窓の要求・ダウンロードは断る。
//! - ブラウザの名残を出さない設定（SPEC 3a 節）は、ほかの窓と同じ `WebviewFlags::strict` と `webview_win::harden` をかける。
//!   窓の題名は日本語の名前だけ（N-13）。隠したまま作り、最初のページを読み終えたら見せる（N-7）。
//! - この窓に、Tauri の権限（capabilities）は与えない。外のサイトのページは、アプリのコマンドを呼べない
//!   （Tauri が、権限を与えていない外のオリジンからの呼び出しを断る。`tests/safety.rs` が、権限の設定にこの窓が無いことを確かめる）。

use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::{Arc, Mutex, PoisonError};
use std::thread;
use std::time::Duration;

use serde::Serialize;
use tauri::webview::{NewWindowResponse, PageLoadEvent};
use tauri::window::Color;
use tauri::{
    AppHandle, Emitter, LogicalSize, Manager, Runtime, WebviewUrl, WebviewWindow,
    WebviewWindowBuilder,
};

use super::mjai_nav::{
    decide_navigation, prefill_script, start_url, MjaiNavigation, MJAI_HOST, NATIVE_SCRIPT,
};
use super::report_id::ReportId;
use crate::appearance::{parse_css_color, Rgb};
use crate::external::download_hook;
use crate::webview_policy::WebviewFlags;
use crate::widget_window::MAIN_LABEL;

pub const MJAI_LABEL: &str = "mjai";
/// 窓の題名（N-13）。アプリの日本語の名前。URL や localhost は入れない。
pub const MJAI_TITLE: &str = "JantamaReviewer mjai 検討";
/// 検討画面へ知らせるイベントの名前。
pub const EVENT_MJAI: &str = "mjai-window";

/// 窓の大きさ（論理ピクセル）。サイトのフォームと Cloudflare の確認が、横に収まる大きさ。
const WINDOW_SIZE: (f64, f64) = (1000.0, 780.0);
const WINDOW_MIN_SIZE: (f64, f64) = (640.0, 480.0);
/// 最初のページを読み終えたと知らせが来なくても、窓が見えないままにならないための時間（N-7）。
const SHOW_FALLBACK: Duration = Duration::from_secs(8);

/// 検討画面へ知らせること。
#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
#[serde(tag = "kind", rename_all = "snake_case")]
pub enum MjaiEvent {
    /// 結果のページへ移ろうとした（移動は止めて、窓は閉じる）。
    ReportFound { id: String },
    /// 結果が出る前に、窓が閉じられた。
    Closed,
}

/// いま開いている窓の 1 回分（窓を開くたびに作る）。
#[derive(Default)]
struct Session {
    /// 結果を見つけたか。見つけたあとの閉じる動きは、「閉じられた」と知らせない。また、2 回目以降の「見つけた」は無視する。
    found: AtomicBool,
}

/// 開いている窓の状態（Tauri の管理する状態）。
#[derive(Default)]
pub struct MjaiWindowState {
    current: Mutex<Option<Arc<Session>>>,
}

impl MjaiWindowState {
    fn set(&self, session: Option<Arc<Session>>) {
        *self.current.lock().unwrap_or_else(PoisonError::into_inner) = session;
    }

    fn take(&self) -> Option<Arc<Session>> {
        self.current
            .lock()
            .unwrap_or_else(PoisonError::into_inner)
            .take()
    }
}

fn emit_event<R: Runtime>(app: &AppHandle<R>, event: &MjaiEvent) {
    if let Err(e) = app.emit_to(MAIN_LABEL, EVENT_MJAI, event) {
        eprintln!("mjai の窓の知らせを送れませんでした: {e}");
    }
}

/// 検討画面を前面に出す（mjai の窓を閉じたあと、取り込みの続きが見えるように）。
fn focus_main<R: Runtime>(app: &AppHandle<R>) {
    if let Some(main) = app.get_webview_window(MAIN_LABEL) {
        let _ = main.unminimize();
        let _ = main.show();
        let _ = main.set_focus();
    }
}

/// 結果のページへ移ろうとした。検討画面に ID を知らせて、窓を閉じる（1 回だけ）。
fn handle_found<R: Runtime>(app: &AppHandle<R>, session: &Session, id: &ReportId) {
    if session.found.swap(true, Ordering::SeqCst) {
        return;
    }
    emit_event(app, &MjaiEvent::ReportFound { id: id.to_string() });
    // 移動の判定の中から窓を壊さない。判定が戻ってから、別のスレッドで閉じる。
    let app = app.clone();
    let spawned = thread::Builder::new()
        .name("mjai-close".to_string())
        .spawn(move || {
            thread::sleep(Duration::from_millis(30));
            if let Some(window) = app.get_webview_window(MJAI_LABEL) {
                if let Err(e) = window.destroy() {
                    eprintln!("mjai の窓を閉じられませんでした: {e}");
                }
            }
            focus_main(&app);
        });
    if let Err(e) = spawned {
        eprintln!("mjai の窓を閉じるスレッドを起こせませんでした: {e}");
    }
}

/// 窓を見せる（前面に出す）。
fn present<R: Runtime>(window: &WebviewWindow<R>) {
    let _ = window.unminimize();
    let _ = window.show();
    let _ = window.set_focus();
}

/// mjai の窓を開いて、URL 欄に `link`（牌譜リンク）を入れる。すでに開いていれば、前面に出して入れ直す。
/// `background` は、検討画面が描いている背景の色（CSS の色。窓の背景色をそろえる）。
pub fn open<R: Runtime>(app: &AppHandle<R>, link: &str, background: &str) -> Result<(), String> {
    let script = prefill_script(link).map_err(|e| e.to_string())?;
    if let Some(window) = app.get_webview_window(MJAI_LABEL) {
        present(&window);
        if let Err(e) = window.eval(&script) {
            eprintln!("mjai の窓に牌譜リンクを入れ直せませんでした: {e}");
        }
        return Ok(());
    }

    let session = Arc::new(Session::default());
    let flags = WebviewFlags::strict(tauri::is_dev());
    let options = flags.builder_options();
    let shown = Arc::new(AtomicBool::new(false));

    let navigation_app = app.clone();
    let navigation_session = Arc::clone(&session);
    let new_window_app = app.clone();
    let new_window_session = Arc::clone(&session);
    let load_shown = Arc::clone(&shown);

    let mut builder = WebviewWindowBuilder::new(app, MJAI_LABEL, WebviewUrl::External(start_url()))
        .title(MJAI_TITLE)
        .inner_size(WINDOW_SIZE.0, WINDOW_SIZE.1)
        .min_inner_size(WINDOW_MIN_SIZE.0, WINDOW_MIN_SIZE.1)
        .center()
        .visible(false)
        .focused(true)
        .zoom_hotkeys_enabled(options.zoom_hotkeys_enabled)
        .general_autofill_enabled(options.general_autofill_enabled)
        .devtools(options.devtools)
        .initialization_script(NATIVE_SCRIPT)
        .on_navigation(move |url| match decide_navigation(url) {
            MjaiNavigation::Allow => true,
            MjaiNavigation::ReportFound(id) => {
                handle_found(&navigation_app, &navigation_session, &id);
                false
            }
            MjaiNavigation::Block => {
                eprintln!("mjai の窓の移動を止めました: {url}");
                false
            }
        })
        .on_new_window(move |url, _features| {
            // 新しい窓は、どの場合も作らない。結果のページを新しい窓で開こうとしたときだけ、見つけた扱いにする。
            match decide_navigation(&url) {
                MjaiNavigation::ReportFound(id) => {
                    handle_found(&new_window_app, &new_window_session, &id)
                }
                _ => eprintln!("mjai の窓の、新しい窓の要求を断りました: {url}"),
            }
            NewWindowResponse::Deny
        })
        .on_download(|_webview, event| download_hook(&event))
        .on_page_load(move |window, payload| {
            if payload.event() != PageLoadEvent::Finished {
                return;
            }
            // サイトの中のページを読み終えるたびに、URL 欄に入れる（Cloudflare の確認のあとの読み直しにも効く）。
            if payload.url().host_str() == Some(MJAI_HOST) {
                if let Err(e) = window.eval(&script) {
                    eprintln!("mjai の窓に牌譜リンクを入れられませんでした: {e}");
                }
            }
            // 最初のページを読み終えてから、窓を見せる（N-7）。
            if !load_shown.swap(true, Ordering::SeqCst) {
                present(&window);
            }
        });
    if let Some(Rgb(r, g, b)) = parse_css_color(background) {
        builder = builder.background_color(Color(r, g, b, 255));
    }
    if !options.drag_drop_handler {
        builder = builder.disable_drag_drop_handler();
    }

    app.state::<MjaiWindowState>()
        .set(Some(Arc::clone(&session)));
    let window = match builder.build() {
        Ok(window) => window,
        Err(e) => {
            app.state::<MjaiWindowState>().set(None);
            return Err(format!("mjai の窓を開けませんでした: {e}"));
        }
    };
    let _ = window.set_size(LogicalSize::new(WINDOW_SIZE.0, WINDOW_SIZE.1));
    #[cfg(windows)]
    crate::webview_win::harden(&window, flags);

    // ページの読み込みの知らせが来なくても、窓が見えないままにならないようにする（N-7）。
    let watchdog_app = app.clone();
    let spawned = thread::Builder::new()
        .name("mjai-show".to_string())
        .spawn(move || {
            thread::sleep(SHOW_FALLBACK);
            if !shown.swap(true, Ordering::SeqCst) {
                if let Some(window) = watchdog_app.get_webview_window(MJAI_LABEL) {
                    present(&window);
                }
            }
        });
    if let Err(e) = spawned {
        eprintln!("mjai の窓を見せる見張りのスレッドを起こせませんでした: {e}");
    }
    Ok(())
}

/// mjai の窓を閉じる（開いていなければ何もしない）。「閉じられた」とは知らせない（呼んだ側が閉じたので）。
pub fn close<R: Runtime>(app: &AppHandle<R>) {
    if let Some(session) = app.state::<MjaiWindowState>().take() {
        session.found.store(true, Ordering::SeqCst);
    }
    if let Some(window) = app.get_webview_window(MJAI_LABEL) {
        if let Err(e) = window.destroy() {
            eprintln!("mjai の窓を閉じられませんでした: {e}");
        }
    }
}

/// mjai の窓が壊れたときに呼ぶ。結果を見つける前に閉じられたのなら、検討画面に知らせる。
pub fn on_destroyed<R: Runtime>(app: &AppHandle<R>) {
    let Some(session) = app.state::<MjaiWindowState>().take() else {
        return;
    };
    if !session.found.load(Ordering::SeqCst) {
        emit_event(app, &MjaiEvent::Closed);
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn n13_the_window_title_is_a_japanese_name_and_never_a_url() {
        assert!(MJAI_TITLE.starts_with("JantamaReviewer"));
        assert!(
            MJAI_TITLE
                .chars()
                .any(|c| matches!(c, '\u{3040}'..='\u{30FF}' | '\u{4E00}'..='\u{9FFF}')),
            "日本語の名前を含む: {MJAI_TITLE}"
        );
        for forbidden in [
            "localhost",
            "://",
            "http",
            "tauri",
            ".html",
            "127.0.0.1",
            "ekyu",
            ".moe",
        ] {
            assert!(
                !MJAI_TITLE.to_lowercase().contains(forbidden),
                "題名に {forbidden} を入れない: {MJAI_TITLE}"
            );
        }
        assert_ne!(MJAI_TITLE, crate::widget_window::MAIN_TITLE);
        assert_ne!(MJAI_TITLE, crate::widget_window::WIDGET_TITLE);
    }

    #[test]
    fn the_window_label_is_not_one_of_the_app_windows() {
        assert_ne!(MJAI_LABEL, MAIN_LABEL);
        assert_ne!(MJAI_LABEL, crate::widget_window::WIDGET_LABEL);
    }

    #[test]
    fn events_have_a_stable_json_shape() {
        assert_eq!(
            serde_json::to_string(&MjaiEvent::ReportFound {
                id: "f9da87cbcd7af5e9".into()
            })
            .unwrap(),
            r#"{"kind":"report_found","id":"f9da87cbcd7af5e9"}"#
        );
        assert_eq!(
            serde_json::to_string(&MjaiEvent::Closed).unwrap(),
            r#"{"kind":"closed"}"#
        );
    }

    #[test]
    fn the_found_flag_lets_only_the_first_report_through() {
        let session = Session::default();
        assert!(!session.found.swap(true, Ordering::SeqCst));
        assert!(session.found.swap(true, Ordering::SeqCst));
    }

    #[test]
    fn the_state_hands_out_the_session_once() {
        let state = MjaiWindowState::default();
        assert!(state.take().is_none());
        state.set(Some(Arc::new(Session::default())));
        assert!(state.take().is_some());
        assert!(state.take().is_none());
    }
}
