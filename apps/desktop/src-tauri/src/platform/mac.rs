//! macOS の雛形（段階 1）。口（`platform` の `InputHook`・`HelperHost`・`ScreenSource` など）に合わせて、コンパイルが通るだけのもの。
//!
//! どれも「まだ対応していません」と返すか、何もしない。画面・ゲーム・ほかのアプリ・入力には触れない
//! （macOS の API は 1 つも呼ばない。作るのは段階 3 以降で、作るときは `tests/safety.rs` の macOS の禁止の一覧に従う）。
//! 管理者の補助プログラムは macOS には無い（ブラウザは普通の権限で動くので、入力が届かない問題が起きない）。

use std::io;
use std::sync::mpsc::Sender;
use std::sync::Arc;

use jantama_input::logic::Report;
use jantama_input::protocol::ToHelper;
use tauri::{Runtime, WebviewWindow};

use super::{HelperHost, InputHook, Platform};
use crate::capture::{CaptureError, Rect, ScreenCapturer, ScreenSource, WindowInfo};
use crate::input_flow::Input;
use crate::sound::NullSound;
use crate::trash::Recycler;
use crate::webview_policy::WebviewFlags;
use crate::widget_window::WindowSpec;

/// 「まだ対応していません」の文。`what` は、対応していないもの。
fn not_yet(what: &str) -> String {
    format!("macOS の{what}は、まだ対応していません")
}

/// macOS の部品を作る。音は、いまは鳴らさない。
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

/// クリップボードの文字の読み取り（まだ作っていない）。
pub fn read_clipboard_string() -> Result<Option<String>, String> {
    Err(not_yet("クリップボードの読み取り"))
}

/// ごみ箱へ送る口（まだ作っていない）。送れないので、消した半荘は置き場（`<保存先>/trash`）に残る。
pub fn recycler() -> Box<dyn Recycler> {
    Box::new(NoRecycler)
}

struct NoRecycler;

impl Recycler for NoRecycler {
    fn recycle(&self, _path: &std::path::Path) -> Result<(), String> {
        Err(not_yet("ごみ箱への移し替え"))
    }
}

/// 窓を作ったあとの OS 固有の仕上げ（まだ作っていない。何もしない）。
pub fn style_window<R: Runtime>(_window: &WebviewWindow<R>, _spec: &WindowSpec) {}

/// WebView の残りの設定（まだ作っていない。何もしない）。
pub fn harden_webview<R: Runtime>(_window: &WebviewWindow<R>, _flags: WebviewFlags) {}
