//! 管理者で動くボタンの補助プログラム（W-9）。
//!
//! 雀魂のランチャーは管理者の権限で動くので、その窓が前面にあると、普通の権限の本体のフックには入力が届かない（UIPI）。
//! このプログラムは、管理者として動き、割り当てたボタンの入力を拾って、本体に名前付きパイプで知らせるだけ。
//! 画面・ネット・ファイルは扱わない（tests/safety.rs が、ソースにそれらの部品が無いことを確かめる）。
//!
//! 使い方（引数）:
//! - `run`（既定）: 本体のパイプにつなぎ、本体からの指示でフックを入れて、入力を知らせる。本体とのつなぎが切れたら終わる。
//! - `install --user-sid <SID>`: 管理者の権限で、最初の 1 回だけ。自分を Program Files の下に写し、確認なしで起動する
//!   タスクを登録する（install.rs）。
//! - `uninstall`: 管理者の権限で。タスクを外し、写したものを消す（install.rs）。

// 窓もコンソールも出さない。結果は終了コードで知らせる。
#![cfg_attr(windows, windows_subsystem = "windows")]

#[cfg(windows)]
mod install;
#[cfg(windows)]
mod run;

#[cfg(windows)]
fn main() {
    use jantama_input::setup::EXIT_UNKNOWN_COMMAND;

    let args: Vec<String> = std::env::args().skip(1).collect();
    let rest = args.get(1..).unwrap_or_default();
    let code = match args.first().map(String::as_str) {
        None | Some("run") => run::run(rest),
        Some("install") => install::install(rest),
        Some("uninstall") => install::uninstall(),
        Some(_) => EXIT_UNKNOWN_COMMAND,
    };
    std::process::exit(code);
}

#[cfg(not(windows))]
fn main() {
    eprintln!("jantama-helper は Windows 専用です。");
    std::process::exit(1);
}
