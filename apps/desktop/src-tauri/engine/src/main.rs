//! 解析エンジンの入口。引数を読んで、`jantama_engine` の部品を呼ぶだけ。
//!
//! - 成功: 終了コード 0。進み具合は標準エラーに `progress <済み>/<全部>` の行で出す。
//! - 失敗: 終了コードは 0 でなく、標準エラーに日本語の 1 行を出す（引数の誤りは 2、ほかは 1）。
//!   libriichi が panic で止まったときも、同じ 1 行にする（`guard`）。

use std::process::ExitCode;

use jantama_engine::args::{self, Invocation};
use jantama_engine::guard;
use jantama_engine::reads::run_read;

/// エラーの文を、改行のない 1 行にする。
fn one_line(error: &anyhow::Error) -> String {
    format!("jantama-engine: {error:#}")
        .replace(['\r', '\n'], " ")
        .trim()
        .to_string()
}

fn run() -> ExitCode {
    match args::parse(std::env::args_os().skip(1)) {
        Err(message) => {
            eprintln!("jantama-engine: {message}");
            ExitCode::from(2)
        }
        Ok(Invocation::Help) => {
            println!("{}", args::USAGE);
            ExitCode::SUCCESS
        }
        Ok(Invocation::Read(read)) => {
            let mut progress = |done: usize, total: usize| eprintln!("progress {done}/{total}");
            match run_read(&read, &mut progress) {
                Ok(()) => ExitCode::SUCCESS,
                Err(error) => {
                    eprintln!("{}", one_line(&error));
                    ExitCode::from(1)
                }
            }
        }
    }
}

fn main() -> ExitCode {
    guard::quiet_panics();
    match guard::run_guarded(run) {
        Ok(code) => code,
        Err(text) => {
            eprintln!("jantama-engine: {text}");
            ExitCode::from(1)
        }
    }
}
