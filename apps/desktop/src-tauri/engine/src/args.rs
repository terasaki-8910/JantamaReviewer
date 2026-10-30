//! コマンドラインの引数（標準ライブラリだけで読む。clap は使わない）。
//!
//! ```text
//! jantama-engine read --report <report.json> --model <tenpai.onnx> --out <reads.json> [--player 0-3]
//! ```
//!
//! 読み違いは、どれも日本語の 1 行の文（`Err`）で返す。`--名前=値` と `--名前 値` の両方を受け付ける。

use std::ffi::OsString;
use std::path::PathBuf;

/// 使い方（1 行）。引数の誤りの文にも添える。
pub const USAGE: &str = "使い方: jantama-engine read --report <report.json> --model <tenpai.onnx> --out <reads.json> [--player 0-3]";

/// `read` コマンドの引数。
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct ReadArgs {
    /// 取り込み済みの report.json（`mjai_log` と `player_id` を持つ）。
    pub report: PathBuf,
    /// 読みのモデル（tenpai.onnx）。
    pub model: PathBuf,
    /// 書き出す reads.json。エンジンが書くのは、ここだけ。
    pub out: PathBuf,
    /// 見る席。省略すると、report.json の `player_id`。
    pub player: Option<u8>,
}

/// 読み取った命令。
#[derive(Debug, Clone, PartialEq, Eq)]
pub enum Invocation {
    Read(ReadArgs),
    /// `--help`（使い方を出して終わる）。
    Help,
}

/// プログラム名を除いた引数を読む。誤りは、使い方つきの日本語の 1 行。
pub fn parse<I>(args: I) -> Result<Invocation, String>
where
    I: IntoIterator<Item = OsString>,
{
    let mut args = args.into_iter();
    let Some(command) = args.next() else {
        return Err(format!("コマンドがありません。{USAGE}"));
    };
    match command.to_str() {
        Some("read") => parse_read(args).map(Invocation::Read),
        Some("-h" | "--help" | "help") => Ok(Invocation::Help),
        _ => Err(format!(
            "知らないコマンドです: {}。{USAGE}",
            command.to_string_lossy()
        )),
    }
}

fn parse_read<I>(args: I) -> Result<ReadArgs, String>
where
    I: Iterator<Item = OsString>,
{
    let mut report = None;
    let mut model = None;
    let mut out = None;
    let mut player: Option<u8> = None;

    let mut args = args.peekable();
    while let Some(arg) = args.next() {
        let Some(text) = arg.to_str() else {
            return Err(format!(
                "読めない引数があります: {}。{USAGE}",
                arg.to_string_lossy()
            ));
        };
        let Some(option) = text.strip_prefix("--") else {
            return Err(format!("余分な引数です: {text}。{USAGE}"));
        };
        // `--名前=値` は、その場で値を取る。
        let (name, inline) = match option.split_once('=') {
            Some((name, value)) => (name, Some(OsString::from(value))),
            None => (option, None),
        };
        if !matches!(name, "report" | "model" | "out" | "player") {
            return Err(format!("知らないオプションです: --{name}。{USAGE}"));
        }
        let value = match inline {
            Some(value) => value,
            None => match args.peek() {
                // 次が別のオプションなら、値が抜けている。
                Some(next) if !next.to_string_lossy().starts_with("--") => {
                    args.next().expect("peek したので次がある")
                }
                _ => return Err(format!("--{name} に値がありません。{USAGE}")),
            },
        };
        if value.is_empty() {
            return Err(format!("--{name} の値が空です。{USAGE}"));
        }
        let duplicated = match name {
            "report" => report.replace(PathBuf::from(&value)).is_some(),
            "model" => model.replace(PathBuf::from(&value)).is_some(),
            "out" => out.replace(PathBuf::from(&value)).is_some(),
            _ => {
                let seat = value
                    .to_str()
                    .and_then(|v| v.parse::<u8>().ok())
                    .filter(|seat| *seat < 4)
                    .ok_or_else(|| {
                        format!(
                            "--player は 0 から 3 の数です: {}。{USAGE}",
                            value.to_string_lossy()
                        )
                    })?;
                player.replace(seat).is_some()
            }
        };
        if duplicated {
            return Err(format!("--{name} が 2 回あります。{USAGE}"));
        }
    }

    let need = |value: Option<PathBuf>, name: &str| {
        value.ok_or_else(|| format!("--{name} がありません。{USAGE}"))
    };
    Ok(ReadArgs {
        report: need(report, "report")?,
        model: need(model, "model")?,
        out: need(out, "out")?,
        player,
    })
}

#[cfg(test)]
mod tests {
    use super::*;

    fn run(args: &[&str]) -> Result<Invocation, String> {
        parse(args.iter().map(OsString::from))
    }

    #[test]
    fn reads_all_options_in_both_forms() {
        let expected = Invocation::Read(ReadArgs {
            report: "a.json".into(),
            model: "m.onnx".into(),
            out: "o.json".into(),
            player: Some(2),
        });
        let spaced = run(&[
            "read", "--report", "a.json", "--model", "m.onnx", "--out", "o.json", "--player", "2",
        ]);
        assert_eq!(spaced, Ok(expected.clone()));
        let joined = run(&[
            "read",
            "--out=o.json",
            "--player=2",
            "--model=m.onnx",
            "--report=a.json",
        ]);
        assert_eq!(joined, Ok(expected));
    }

    #[test]
    fn player_is_optional() {
        let parsed = run(&["read", "--report", "a", "--model", "b", "--out", "c"]).unwrap();
        let Invocation::Read(args) = parsed else {
            panic!("read のはず");
        };
        assert_eq!(args.player, None);
    }

    #[test]
    fn rejects_bad_input_with_one_japanese_line() {
        let cases: &[&[&str]] = &[
            &[],
            &["scan"],
            &["read"],
            &["read", "--report", "a", "--model", "b"],
            &[
                "read", "--report", "a", "--model", "b", "--out", "c", "--player", "4",
            ],
            &[
                "read", "--report", "a", "--model", "b", "--out", "c", "--player", "x",
            ],
            &[
                "read", "--report", "a", "--report", "b", "--model", "b", "--out", "c",
            ],
            &["read", "--report", "--model", "b", "--out", "c"],
            &[
                "read",
                "--report",
                "a",
                "--model",
                "b",
                "--out",
                "c",
                "--nothing",
                "1",
            ],
            &[
                "read", "--report", "a", "stray", "--model", "b", "--out", "c",
            ],
            &["read", "--report="],
        ];
        for case in cases {
            let message = run(case).expect_err(&format!("{case:?} は誤り"));
            assert!(!message.contains('\n'), "{case:?}: {message}");
            assert!(message.contains("使い方"), "{case:?}: {message}");
        }
    }

    #[test]
    fn help_is_not_an_error() {
        assert_eq!(run(&["--help"]), Ok(Invocation::Help));
        assert_eq!(run(&["-h"]), Ok(Invocation::Help));
    }
}
