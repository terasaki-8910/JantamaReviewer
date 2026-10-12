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

use super::{HelperHost, Platform};
use crate::capture::ScreenCapturer;
use crate::input_flow::Input;

pub use clipboard::read_string as read_clipboard_string;
pub use hook::start_input_hook;
pub use style::style_window;
pub use trash::recycler;
pub use webview::harden as harden_webview;

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

    fn run_task(&self) -> Result<(), String> {
        helper_setup::run_task()
    }
}
