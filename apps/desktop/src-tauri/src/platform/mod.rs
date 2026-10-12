//! OS ごとに違う部品の境界（macOS 対応の段階 1。R14-5）。
//!
//! 共有のコード（入力の流れ・記録・取り込み・検討画面のコマンド）は、OS の API を直接呼ばず、ここの口だけを使う。
//! OS ごとの実装は 1 つずつのモジュールにまとめ、`#[cfg]` で選ぶのはこのファイルだけ。
//!
//! - Windows（`win`）: これまでの実装を、動きを変えずにここへ集めたもの。
//! - macOS（`mac`）: 口に合わせた雛形。コンパイルは通るが、どれも「まだ対応していません」と返すか、何もしない。
//!   画面・ゲーム・ほかのアプリには触れない（段階 3 以降で作る。`analysis/mac/README.md`）。
//!
//! 口は 2 つに分かれる。起動のときに 1 度作って持ち歩くもの（`Platform`: 撮影・音・補助プログラム）と、
//! そのつど呼ぶ関数（ボタンのフック・クリップボードの文字・ごみ箱・窓の仕上げ・WebView の設定）。
//! 文字認識の口は `jantama-ocr` の中（Windows は WinRT、macOS は雛形）にあり、ここには無い。

use std::io;
use std::sync::mpsc::Sender;
use std::sync::Arc;

use jantama_input::hook::HookStatus;
use jantama_input::logic::Config;
use jantama_input::protocol::ToHelper;

use crate::capture::Capturer;
use crate::input_flow::Input;
use crate::sound::Sound;

#[cfg(target_os = "macos")]
mod mac;
#[cfg(windows)]
mod win;

#[cfg(not(any(windows, target_os = "macos")))]
compile_error!("JantamaReviewer は Windows と macOS だけに対応しています。");

#[cfg(target_os = "macos")]
use mac as native;
#[cfg(windows)]
use win as native;

pub use native::{harden_webview, read_clipboard_string, recycler, start_input_hook, style_window};

/// 本体の中でボタンを拾うフック。OS ごとの実装（Windows は低レベルのマウス・キーボードのフック）を、同じ呼び方で使う。
/// フックの手続きの中では、判定（`jantama_input::logic`）と本体への知らせ（`start_input_hook` に渡す `sink`）だけを行う。
pub trait InputHook: Send {
    /// 設定を変えて、フックが入れ直し終えるのを待つ。入れられなかった理由は `HookStatus::error` に入る。
    fn apply(&self, config: Config) -> HookStatus;
    /// キーボードのフックを入れてよいかを変える。`false` の間は、設定がキーボードのフックを要るときも入れない
    /// （検討画面が前面にある間、Windows の本体のキーボードのフックには入力が届かないため）。
    fn set_keyboard_allowed(&self, allowed: bool) -> HookStatus;
    /// フックを外して、フックのスレッドを終える。
    fn stop(&self);
    /// 原因調べ（`JANTAMA_TRACE_INPUT`）のとき、受け取った入力の記録に添える一言（フックが見た入力の数など）。
    fn trace_info(&self) -> String;
    /// 原因調べ（`JANTAMA_TRACE_INPUT`）のとき、フックが受け取った入力を標準エラーへ出す見張りを起こす。
    fn start_trace(&self);
}

/// 管理者の補助プログラム（Windows だけ。雀魂のランチャーが管理者で動くことへの備え。W-9）への口。
/// 使えない OS では、`supported` が `false` で、どの操作も失敗を返す（入力の流れは常に「補助プログラム無し」で動く）。
pub trait HelperHost: Send + Sync {
    /// この OS に補助プログラムがあるか。
    fn supported(&self) -> bool;
    /// 連絡の口を開いて、補助プログラムがつなぎにくるのを待つ。届いた連絡は `tx` へ入力として送る。
    fn serve(&self, tx: Sender<Input>) -> io::Result<()>;
    /// つながっている補助プログラムに指示を送る。送れたら `true`（つながっていなければ `false`）。
    fn send(&self, message: &ToHelper) -> bool;
    /// 補助プログラムを設定する（Windows では管理者の確認が出る）。
    fn install(&self) -> Result<(), String>;
    /// 補助プログラムの設定を解除する。
    fn uninstall(&self) -> Result<(), String>;
    /// 起動の登録があるか。
    fn query_installed(&self) -> bool;
    /// 設定済みの補助プログラムを起動する（確認は出ない）。
    fn run_task(&self) -> Result<(), String>;
}

/// 起動のときに 1 度作って持ち歩く、OS ごとの部品。
#[derive(Clone)]
pub struct Platform {
    /// 迷いマークのスクリーンショットの取得元（W-1）。
    pub capturer: Arc<dyn Capturer>,
    /// 記録したときの音。
    pub sound: Arc<dyn Sound>,
    /// 管理者の補助プログラム。
    pub helper: Arc<dyn HelperHost>,
}

impl Platform {
    /// いま動いている OS の部品を作る。
    pub fn native() -> Platform {
        native::platform()
    }
}
