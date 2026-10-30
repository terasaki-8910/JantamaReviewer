//! macOS の実装（段階 2）。検討画面に要る部品だけを作り、ウィジェット・ボタンを拾うこと・撮影・文字認識は雛形のまま。
//!
//! - 動くもの: クリップボードの文字の読み取り（`clipboard`）、ごみ箱への移し替え（`trash`）、アプリのメニュー（`menu`）、
//!   WKWebView の設定（`with_webview_options`）。
//! - 雛形のもの（どれも「まだ対応していません」と返すか、何もしない）: ボタンのフック・画面と窓の一覧・音・窓の仕上げ。
//!   画面・ゲーム・ほかのアプリ・入力には触れない（macOS の画面・入力の API は 1 つも呼ばない。作るのは段階 3 以降で、
//!   作るときは `tests/safety.rs` の macOS の禁止の一覧に従う）。
//! - 管理者の補助プログラムは macOS には無い（ブラウザは普通の権限で動くので、入力が届かない問題が起きない）。

mod clipboard;
mod trash;

use std::io;
use std::sync::mpsc::Sender;
use std::sync::Arc;

use jantama_input::logic::Report;
use jantama_input::protocol::ToHelper;
use tauri::{AppHandle, Builder, Manager, RunEvent, Runtime, WebviewWindow, WebviewWindowBuilder};

use super::{Features, HelperHost, InputHook, Os, Platform};
use crate::capture::{CaptureError, Rect, ScreenCapturer, ScreenSource, WindowInfo};
use crate::input_flow::Input;
use crate::sound::NullSound;
use crate::webview_policy::WebviewFlags;
use crate::widget_window::WindowSpec;

pub use clipboard::read_string as read_clipboard_string;
pub use trash::recycler;

/// 子のプロセス（解析エンジン）が、コンソールの窓を出さないようにする。macOS には、そのような窓は無いので、何もしない。
pub fn hide_console_window(_command: &mut std::process::Command) {}

/// OS の名前。
pub const OS: Os = Os::Macos;

/// 使える機能。段階 2 は検討画面だけ（ウィジェット・ボタンを拾うこと・撮影・文字認識は、段階 3 以降）。
pub const FEATURES: Features = Features {
    widget: false,
    button_hook: false,
    capture: false,
    ocr: false,
    helper: false,
};

/// 「まだ対応していません」の文。`what` は、対応していないもの。
fn not_yet(what: &str) -> String {
    format!("macOS の{what}は、まだ対応していません")
}

/// macOS の部品を作る。音は、いまは鳴らさない（迷いマークを記録する部分が、まだ無い）。
pub fn platform() -> Platform {
    Platform {
        capturer: Arc::new(ScreenCapturer(MacScreen)),
        sound: Arc::new(NullSound),
        helper: Arc::new(NoHelper),
    }
}

/// 画面と窓の一覧（まだ作っていない）。窓は 1 つも見つからず、画面は撮れない。
struct MacScreen;

impl ScreenSource for MacScreen {
    fn windows(&self) -> Vec<WindowInfo> {
        Vec::new()
    }

    fn capture_rect(&self, _rect: Rect) -> Result<Vec<u8>, CaptureError> {
        Err(CaptureError(not_yet("画面の撮影")))
    }

    fn cursor_screen(&self) -> Rect {
        Rect {
            left: 0,
            top: 0,
            right: 0,
            bottom: 0,
        }
    }
}

/// 補助プログラムは無い。
struct NoHelper;

impl HelperHost for NoHelper {
    fn supported(&self) -> bool {
        false
    }

    fn serve(&self, _tx: Sender<Input>) -> io::Result<()> {
        Err(io::Error::other("macOS には補助プログラムはありません"))
    }

    fn send(&self, _message: &ToHelper) -> bool {
        false
    }

    fn install(&self) -> Result<(), String> {
        Err("macOS には補助プログラムはありません".to_string())
    }

    fn uninstall(&self) -> Result<(), String> {
        Err("macOS には補助プログラムはありません".to_string())
    }

    fn query_installed(&self) -> bool {
        false
    }

    fn run_task(&self) -> Result<(), String> {
        Err("macOS には補助プログラムはありません".to_string())
    }
}

/// ボタンのフック（まだ作っていない）。入力の流れは「本体のフックを入れられなかった」として、ウィジェットのボタンだけで動く。
pub fn start_input_hook(
    _sink: impl Fn(Report) + Send + Sync + 'static,
) -> Result<Box<dyn InputHook>, String> {
    Err(not_yet("ボタンのフック"))
}

/// 窓を作ったあとの OS 固有の仕上げ（まだ作っていない。何もしない。ウィジェットの窓は、段階 3 で作る）。
pub fn style_window<R: Runtime>(_window: &WebviewWindow<R>, _spec: &WindowSpec) {}

/// WebView の残りの設定（作ったあとに書き込むもの）。WKWebView は、WebView2 のような設定を持たないので、何もしない。
/// ブラウザの名残の対策は、次のものが担う。
/// - ブラウザのショートカット（N-1）: WKWebView には、元から再読み込み・印刷・検索などのショートカットが無い（アプリのメニューにも入れない）。
/// - 拡大・スワイプでの移動（N-2）: WKWebView の既定が切（`allowsMagnification`・`allowsBackForwardNavigationGestures`）。
///   Tauri の `zoom_hotkeys_enabled(false)` は、窓を作るときに渡している。
/// - 右クリックのメニュー（N-3）・選択・ドラッグ・入力欄の候補（N-8〜N-11）: 画面側の JS・CSS・属性（共通）。
/// - 画面の遷移・新しい窓・ダウンロード（N-5、N-6）: Tauri の `on_navigation` などの手続き（共通）。
/// - 開発者ツール（N-12）: Tauri の `devtools`（共通）。
/// - リンクのプレビュー・保存領域の分け方: 窓を作るときに渡す（`with_webview_options`）。
pub fn harden_webview<R: Runtime>(_window: &WebviewWindow<R>, _flags: WebviewFlags) {}

/// 窓を作るときに渡す、WKWebView の設定。
/// - リンクのプレビュー（長押しで出る小さな窓）を出さない。ブラウザの名残の 1 つ。
/// - 保存領域（Cookie・localStorage など）を、`store` の識別子で分ける（macOS 14 以降）。WebView2 の `data_directory` に当たるもので、
///   mjai の窓を画面と分け、試しに動かすときを本物のアプリと分けるために使う。`None` なら既定の保存領域。
pub fn with_webview_options<'a, R: Runtime, M: Manager<R>>(
    builder: WebviewWindowBuilder<'a, R, M>,
    store: Option<[u8; 16]>,
) -> WebviewWindowBuilder<'a, R, M> {
    let builder = builder.allow_link_preview(false);
    match store {
        Some(id) => builder.data_store_identifier(id),
        None => builder,
    }
}

/// アプリの実行中の出来事への、macOS の対応。Dock のアイコンを押されたら、検討画面を開く
/// （検討画面を閉じても、アプリは Dock に残る。ウィジェットが無い段階 2 では、これが開き直す入口）。
pub fn on_run_event<R: Runtime>(app: &AppHandle<R>, event: &RunEvent) {
    if let RunEvent::Reopen { .. } = event {
        crate::commands::open_main_window_now(app);
    }
}

/// アプリのメニュー（Cmd+Q で終わる・入力欄で Cmd+C/V/X/A/Z が効く・Cmd+W で窓を閉じる）を、アプリ全体のメニューにする。
/// Windows では、メニューバーが窓ごとに付くので、設定しない（`platform::with_app_menu`）。
pub fn with_app_menu<R: Runtime>(builder: Builder<R>) -> Builder<R> {
    builder.menu(crate::menu::mac_app_menu)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn stage_2_offers_only_the_review_screens_and_the_helper_flag_matches_the_stub() {
        assert_eq!(OS, Os::Macos);
        assert_eq!(
            FEATURES,
            Features {
                widget: false,
                button_hook: false,
                capture: false,
                ocr: false,
                helper: false,
            }
        );
        assert_eq!(platform().helper.supported(), FEATURES.helper);
        assert!(start_input_hook(|_| {}).is_err());
    }
}
