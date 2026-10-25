//! Windows の実装。これまで本体の各所にあった Windows 専用の部品を、動きを変えずに集めたもの。

mod capture;
mod clipboard;
mod helper_link;
mod helper_setup;
mod hook;
mod sound;
mod style;
mod trash;
mod webview;

use std::io;
use std::sync::mpsc::Sender;
use std::sync::Arc;

use jantama_input::protocol::ToHelper;
use tauri::{AppHandle, Builder, Manager, RunEvent, Runtime, WebviewWindowBuilder};

use super::{Features, HelperHost, Os, Platform};
use crate::capture::ScreenCapturer;
use crate::input_flow::Input;

pub use clipboard::read_string as read_clipboard_string;
pub use hook::start_input_hook;
pub use style::style_window;
pub use trash::recycler;
pub use webview::harden as harden_webview;

/// OS の名前。
pub const OS: Os = Os::Windows;

/// 使える機能。Windows は、すべて使える。
pub const FEATURES: Features = Features {
    widget: true,
    button_hook: true,
    capture: true,
    ocr: true,
    helper: true,
};

/// 窓を作るときに渡す、WebView の設定。WebView2 の設定は、窓を作ったあとに書き込む（`harden_webview`）ので、ここでは何もしない。
/// 保存領域は、`data_directory`（`widget_window::build_window`・mjai の窓）で分ける。
pub fn with_webview_options<'a, R: Runtime, M: Manager<R>>(
    builder: WebviewWindowBuilder<'a, R, M>,
    _store: Option<[u8; 16]>,
) -> WebviewWindowBuilder<'a, R, M> {
    builder
}

/// アプリ全体のメニューは、Windows には無い（メニューバーが窓ごとに付いてしまう。右クリックのメニューとトレイのメニューだけ）。
pub fn with_app_menu<R: Runtime>(builder: Builder<R>) -> Builder<R> {
    builder
}

/// アプリの実行中の出来事（`RunEvent`）への、OS ごとの対応。Windows は、共通の対応（終了のときの片づけ）のほかは無い。
pub fn on_run_event<R: Runtime>(_app: &AppHandle<R>, _event: &RunEvent) {}

/// Windows の部品を作る。
pub fn platform() -> Platform {
    Platform {
        capturer: Arc::new(ScreenCapturer(capture::WindowsScreen)),
        sound: Arc::new(sound::WindowsSound),
        helper: Arc::new(WindowsHelper::default()),
    }
}

/// 管理者の補助プログラム: 名前付きパイプのサーバー（`helper_link`）と、設定・解除・起動（`helper_setup`）。
#[derive(Default)]
struct WindowsHelper {
    writer: helper_link::HelperWriter,
}

impl HelperHost for WindowsHelper {
    fn supported(&self) -> bool {
        true
    }

    fn serve(&self, tx: Sender<Input>) -> io::Result<()> {
        helper_link::spawn_server(tx, self.writer.clone())
    }

    fn send(&self, message: &ToHelper) -> bool {
        self.writer.send(message)
    }

    fn install(&self) -> Result<(), String> {
        helper_setup::install()
    }

    fn uninstall(&self) -> Result<(), String> {
        helper_setup::uninstall()
    }

    fn query_installed(&self) -> bool {
        helper_setup::query_installed()
    }

    fn outdated(&self) -> Option<bool> {
        helper_setup::query_outdated()
    }

    fn run_task(&self) -> Result<(), String> {
        helper_setup::run_task()
    }
}
