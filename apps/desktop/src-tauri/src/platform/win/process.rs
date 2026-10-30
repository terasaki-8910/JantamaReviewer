//! 子のプロセス（解析エンジン。`reads::engine_runner`）を起こすときの、Windows の設定。

use std::os::windows::process::CommandExt;
use std::process::Command;

/// コンソールの窓を作らない（Windows の `CREATE_NO_WINDOW`）。エンジンはコンソールのプログラムなので、
/// 画面のアプリから起こすと、黒い窓が一瞬出てしまう。
const CREATE_NO_WINDOW: u32 = 0x0800_0000;

/// `command` で起こす子のプロセスが、コンソールの窓を出さないようにする。
pub fn hide_console_window(command: &mut Command) {
    command.creation_flags(CREATE_NO_WINDOW);
}
