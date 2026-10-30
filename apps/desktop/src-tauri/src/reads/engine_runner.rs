//! 解析エンジン（F24。別のプログラム `jantama-engine`。AGPL-3.0-or-later）を呼ぶ。本体がエンジンを呼ぶのは、このファイルの 1 か所だけ
//! （`tests/safety.rs` の S-5 が確かめる）。
//!
//! 渡すのは、取り込み済みの結果・モデルのファイル・出力先の 3 つのパスだけ（引数は `read --report <..> --model <..> --out <..>` の
//! 7 つ。shell は通さず、ほかの引数も環境も足さない）。エンジンは通信せず、ほかのプロセスを起こさず、渡された出力先のほかに何も書かない。
//! 標準エラーを 1 行ずつ読み、`progress 済み/全部` の行は進み具合として知らせ、ほかの行は、失敗したときの理由として、最後の 1 行を残す。
//! 時間（10 分）を超えたら止める。出力先は `reads.json.part` で、エンジンが 0 で終わり、形を確かめてから、`reads.json` にする。

use std::ffi::OsString;
use std::fs;
use std::io::{BufRead, BufReader, ErrorKind, Read};
use std::path::{Path, PathBuf};
use std::process::{Command, Stdio};
use std::sync::mpsc;
use std::thread;
use std::time::{Duration, Instant};

use super::reads_file::{check, reads_part_path, reads_path};
use crate::platform;
use crate::store::REPORT_FILE;

/// エンジンの場所を決める環境変数（開発と試験用。本体と一緒に配るエンジンは、本体の実行ファイルと同じフォルダに置く）。
pub const ENGINE_ENV: &str = "JANTAMA_ENGINE";
/// エンジンにかけてよい時間。超えたら、止める。
pub const ENGINE_TIMEOUT: Duration = Duration::from_secs(10 * 60);

/// エンジンの名前（Windows では `.exe` が付く）。
const ENGINE_NAME: &str = "jantama-engine";
/// エンジンに渡す命令と、3 つの引数の名前。これ以外は渡さない。
const ENGINE_COMMAND: &str = "read";
const ARG_REPORT: &str = "--report";
const ARG_MODEL: &str = "--model";
const ARG_OUT: &str = "--out";

/// エンジンの終わりを待つ間隔。
const POLL: Duration = Duration::from_millis(50);
/// エンジンが終わってから、標準エラーの残りの行を待つ時間の上限。
const AFTER_EXIT: Duration = Duration::from_millis(500);

/// エンジンを動かすのに失敗した理由。画面に出せる日本語の文を持つ。
#[derive(Debug, Clone, PartialEq, Eq)]
pub enum EngineError {
    /// この半荘には、まだ結果（`report.json`）が無い。
    NoReport,
    /// エンジンの実行ファイルが見つからない。
    NotFound(PathBuf),
    /// エンジンを起動できなかった（理由つき）。
    Start(String),
    /// エンジンが 0 以外で終わった。中身は、エンジンが標準エラーに出した最後の 1 行。
    Failed(String),
    /// 時間内に終わらなかったので、止めた。
    Timeout,
    /// エンジンが 0 で終わったのに、読みを書かなかった・書いたものが使えない形だった。
    BadOutput(String),
    /// 結果のファイルを置けなかった。
    Io(String),
}

impl std::fmt::Display for EngineError {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        match self {
            EngineError::NoReport => f.write_str("この半荘は、まだ結果を取り込んでいません"),
            EngineError::NotFound(path) => {
                write!(f, "解析エンジンが見つかりません（{}）", path.display())
            }
            EngineError::Start(reason) => {
                write!(f, "解析エンジンを起動できませんでした: {reason}")
            }
            EngineError::Failed(line) => f.write_str(line),
            EngineError::Timeout => write!(
                f,
                "解析エンジンが、{} 分たっても終わらなかったので、止めました",
                ENGINE_TIMEOUT.as_secs() / 60
            ),
            EngineError::BadOutput(reason) => {
                write!(f, "解析エンジンが書いた読みを使えません（{reason}）")
            }
            EngineError::Io(reason) => write!(f, "読みのファイルを置けませんでした: {reason}"),
        }
    }
}

impl std::error::Error for EngineError {}

/// エンジンの実行ファイルの名前（Windows は `jantama-engine.exe`）。
pub fn engine_file_name() -> String {
    format!("{ENGINE_NAME}{}", std::env::consts::EXE_SUFFIX)
}

/// エンジンの場所を決める（純粋）。環境変数 `JANTAMA_ENGINE`（空でないもの）があればそれ、なければ、本体の実行ファイルのフォルダの中。
pub fn locate_engine_from(env: Option<OsString>, current_exe: &Path) -> PathBuf {
    match env {
        Some(path) if !path.is_empty() => PathBuf::from(path),
        _ => current_exe
            .parent()
            .unwrap_or_else(|| Path::new("."))
            .join(engine_file_name()),
    }
}

/// エンジンの場所。実行ファイルが無ければ、その場所を示して断る。
pub fn locate_engine() -> Result<PathBuf, EngineError> {
    let exe = std::env::current_exe()
        .map_err(|e| EngineError::Start(format!("本体の場所を調べられませんでした（{e}）")))?;
    let path = locate_engine_from(std::env::var_os(ENGINE_ENV), &exe);
    if path.is_file() {
        Ok(path)
    } else {
        Err(EngineError::NotFound(path))
    }
}

/// エンジンに渡す引数。これだけ（`read --report <結果> --model <モデル> --out <出力先>`）。
pub fn engine_args(report: &Path, model: &Path, out: &Path) -> Vec<OsString> {
    vec![
        ENGINE_COMMAND.into(),
        ARG_REPORT.into(),
        report.into(),
        ARG_MODEL.into(),
        model.into(),
        ARG_OUT.into(),
        out.into(),
    ]
}

/// 標準エラーの 1 行が進み具合（`progress 済み/全部`）なら、その 2 つの数。
pub fn parse_progress(line: &str) -> Option<(usize, usize)> {
    let rest = line.trim().strip_prefix("progress ")?;
    let (done, total) = rest.split_once('/')?;
    Some((done.trim().parse().ok()?, total.trim().parse().ok()?))
}

/// 標準エラーの行を集める。進み具合は知らせ、ほかの行は、最後の 1 行を、失敗の理由として残す。
struct Lines<'a> {
    progress: &'a mut dyn FnMut(usize, usize),
    last_text: Option<String>,
}

impl Lines<'_> {
    fn feed(&mut self, line: &str) {
        if let Some((done, total)) = parse_progress(line) {
            (self.progress)(done, total);
        } else if !line.trim().is_empty() {
            self.last_text = Some(line.trim().to_string());
        }
    }
}

/// 標準エラーを、1 行ずつ読んで送る（読めなくなるまで）。文字の形が壊れた行も、読めるところまでは読む。
fn read_lines(stderr: impl Read, sender: mpsc::Sender<String>) {
    let mut reader = BufReader::new(stderr);
    let mut raw = Vec::new();
    loop {
        raw.clear();
        match reader.read_until(b'\n', &mut raw) {
            Ok(0) | Err(_) => return,
            Ok(_) => {
                let line = String::from_utf8_lossy(&raw)
                    .trim_end_matches(['\r', '\n'])
                    .to_string();
                if sender.send(line).is_err() {
                    return;
                }
            }
        }
    }
}

/// 半荘 1 つ分の読みの計算。
pub struct EngineRun<'a> {
    /// エンジンの実行ファイル。
    pub engine: &'a Path,
    /// 半荘のフォルダ（`report.json` を読み、`reads.json` を置く）。
    pub session_dir: &'a Path,
    /// 読みのモデル（`tenpai.onnx`）。
    pub model: &'a Path,
    /// 書き出された読みが、このモデルで計算したものか確かめるための、モデルの SHA-256。
    pub model_sha256: &'a str,
    /// かけてよい時間。
    pub timeout: Duration,
}

/// エンジンで半荘の読みを計算し、`reads.json` に置いて、その文字を返す。進み具合は `progress(済み, 全部)` に知らせる。
///
/// 出力先は `reads.json.part`。エンジンが 0 で終わり、書かれたものが使える形（モデルも合う）と確かめてから、`reads.json` にする。
/// 失敗・時間切れのときは、途中のファイルを消し、いまの `reads.json` には触れない。同じ半荘を同時に計算しないのは、呼ぶ側が守る。
pub fn compute_reads_file(
    run: &EngineRun<'_>,
    progress: &mut dyn FnMut(usize, usize),
) -> Result<String, EngineError> {
    let report = run.session_dir.join(REPORT_FILE);
    if !report.is_file() {
        return Err(EngineError::NoReport);
    }
    let part = reads_part_path(run.session_dir);
    // 前に止まったときの残りがあれば、消す
    let _ = fs::remove_file(&part);
    let outcome = run_engine(run, &report, &part, progress).and_then(|()| finish(run, &part));
    if outcome.is_err() {
        let _ = fs::remove_file(&part);
    }
    outcome
}

/// エンジンが書いた出力先を確かめて、本来の名前にする。使える形の文を返す。
fn finish(run: &EngineRun<'_>, part: &Path) -> Result<String, EngineError> {
    let text = match fs::read_to_string(part) {
        Ok(text) => text,
        Err(e) if e.kind() == ErrorKind::NotFound => {
            return Err(EngineError::BadOutput("読みを書きませんでした".to_string()))
        }
        Err(e) => return Err(EngineError::BadOutput(e.to_string())),
    };
    check(&text, run.model_sha256).map_err(EngineError::BadOutput)?;
    fs::rename(part, reads_path(run.session_dir)).map_err(|e| EngineError::Io(e.to_string()))?;
    Ok(text)
}

/// エンジンを起こして、終わるまで待つ（0 で終われば `Ok`）。
fn run_engine(
    run: &EngineRun<'_>,
    report: &Path,
    out: &Path,
    progress: &mut dyn FnMut(usize, usize),
) -> Result<(), EngineError> {
    let mut command = Command::new(run.engine);
    command
        .args(engine_args(report, run.model, out))
        .stdin(Stdio::null())
        .stdout(Stdio::null())
        .stderr(Stdio::piped());
    platform::hide_console_window(&mut command);
    let mut child = command.spawn().map_err(|e| {
        if e.kind() == ErrorKind::NotFound {
            EngineError::NotFound(run.engine.to_path_buf())
        } else {
            EngineError::Start(format!("{e}（{}）", run.engine.display()))
        }
    })?;
    let stderr = child.stderr.take();
    let (sender, lines) = mpsc::channel::<String>();
    if let Some(stderr) = stderr {
        let spawned = thread::Builder::new()
            .name("engine-stderr".to_string())
            .spawn(move || read_lines(stderr, sender));
        if let Err(e) = spawned {
            stop(&mut child);
            return Err(EngineError::Start(format!(
                "標準エラーを読む担当を起こせませんでした: {e}"
            )));
        }
    }

    let deadline = Instant::now() + run.timeout;
    let mut collected = Lines {
        progress,
        last_text: None,
    };
    let status = loop {
        while let Ok(line) = lines.try_recv() {
            collected.feed(&line);
        }
        match child.try_wait() {
            Ok(Some(status)) => break status,
            Ok(None) => {}
            Err(e) => {
                stop(&mut child);
                return Err(EngineError::Start(format!(
                    "エンジンの終わりを確かめられませんでした: {e}"
                )));
            }
        }
        if Instant::now() >= deadline {
            stop(&mut child);
            return Err(EngineError::Timeout);
        }
        if let Ok(line) = lines.recv_timeout(POLL) {
            collected.feed(&line);
        }
    };
    // 終わったあとに残っている行（最後の進み具合・失敗の理由）を、少しだけ待って集める。
    // エンジンから子のプロセスが標準エラーを引き継いでいても、ここで長く待たない
    let until = Instant::now() + AFTER_EXIT;
    while let Ok(line) = lines.recv_timeout(until.saturating_duration_since(Instant::now())) {
        collected.feed(&line);
    }

    if status.success() {
        return Ok(());
    }
    let reason = collected.last_text.unwrap_or_else(|| match status.code() {
        Some(code) => format!("解析エンジンが途中で止まりました（終了コード {code}）"),
        None => "解析エンジンが途中で止まりました".to_string(),
    });
    Err(EngineError::Failed(reason))
}

/// 動いているエンジンを止めて、終わりを待つ（残りを残さない）。
fn stop(child: &mut std::process::Child) {
    let _ = child.kill();
    let _ = child.wait();
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn s5_the_engine_gets_exactly_read_report_model_out_and_nothing_else() {
        let args = engine_args(
            Path::new("games/x/report.json"),
            Path::new("cfg/models/tenpai.onnx"),
            Path::new("games/x/reads.json.part"),
        );
        let text: Vec<String> = args
            .iter()
            .map(|a| a.to_string_lossy().replace('\\', "/"))
            .collect();
        assert_eq!(
            text,
            [
                "read",
                "--report",
                "games/x/report.json",
                "--model",
                "cfg/models/tenpai.onnx",
                "--out",
                "games/x/reads.json.part",
            ]
        );
    }

    #[test]
    fn s5_the_engine_is_found_by_the_environment_variable_or_next_to_the_app() {
        let exe = Path::new("app-dir").join("jantama-reviewer.exe");
        // 環境変数があれば、その場所（開発と試験）
        assert_eq!(
            locate_engine_from(Some(OsString::from("dev/engine.exe")), &exe),
            PathBuf::from("dev/engine.exe")
        );
        // 無い・空なら、本体の実行ファイルと同じフォルダ
        let expected = Path::new("app-dir").join(engine_file_name());
        assert_eq!(locate_engine_from(None, &exe), expected);
        assert_eq!(locate_engine_from(Some(OsString::new()), &exe), expected);
    }

    #[test]
    fn the_engine_file_name_has_the_platform_suffix() {
        let name = engine_file_name();
        assert!(name.starts_with("jantama-engine"));
        #[cfg(windows)]
        assert_eq!(name, "jantama-engine.exe");
        #[cfg(not(windows))]
        assert_eq!(name, "jantama-engine");
    }

    #[test]
    fn progress_lines_are_read_and_everything_else_is_not() {
        assert_eq!(parse_progress("progress 3/126"), Some((3, 126)));
        assert_eq!(parse_progress("progress 0/0"), Some((0, 0)));
        assert_eq!(parse_progress("  progress 7/9  "), Some((7, 9)));
        for not in [
            "",
            "progress",
            "progress 3",
            "progress /3",
            "progress a/b",
            "progress -1/3",
            "Progress 3/4",
            "jantama-engine: 牌譜のファイルを読めません: x",
            "progress 3/4/5",
        ] {
            assert_eq!(parse_progress(not), None, "{not:?}");
        }
    }

    #[test]
    fn the_last_non_progress_line_is_kept_as_the_reason() {
        let mut seen = Vec::new();
        let mut progress = |done: usize, total: usize| seen.push((done, total));
        let mut lines = Lines {
            progress: &mut progress,
            last_text: None,
        };
        for line in [
            "warning: first",
            "progress 1/3",
            "",
            "   ",
            "progress 2/3",
            "jantama-engine: 最後の 1 行",
            "progress 3/3",
        ] {
            lines.feed(line);
        }
        assert_eq!(
            lines.last_text.as_deref(),
            Some("jantama-engine: 最後の 1 行")
        );
        assert_eq!(seen, vec![(1, 3), (2, 3), (3, 3)]);
    }

    #[test]
    fn the_messages_are_japanese_and_the_two_named_ones_are_exact() {
        assert_eq!(
            EngineError::NoReport.to_string(),
            "この半荘は、まだ結果を取り込んでいません"
        );
        assert_eq!(
            EngineError::NotFound(PathBuf::from("x/jantama-engine.exe")).to_string(),
            "解析エンジンが見つかりません（x/jantama-engine.exe）"
        );
        // エンジンの 1 行は、そのまま出す
        assert_eq!(
            EngineError::Failed("jantama-engine: 牌譜のファイルを読めません".to_string())
                .to_string(),
            "jantama-engine: 牌譜のファイルを読めません"
        );
        for error in [
            EngineError::Start("x".into()),
            EngineError::Timeout,
            EngineError::BadOutput("x".into()),
            EngineError::Io("x".into()),
        ] {
            let text = error.to_string();
            assert!(
                text.chars().any(|c| ('\u{3040}'..='\u{30FF}').contains(&c)
                    || ('\u{4E00}'..='\u{9FFF}').contains(&c)),
                "{text}"
            );
        }
        assert!(EngineError::Timeout.to_string().contains("10 分"));
    }

    #[test]
    fn a_session_without_a_report_is_refused_before_any_process_is_started() {
        let dir = tempfile::tempdir().unwrap();
        let run = EngineRun {
            engine: Path::new("no-such-engine"),
            session_dir: dir.path(),
            model: Path::new("no-such-model"),
            model_sha256: "x",
            timeout: Duration::from_secs(1),
        };
        let error = compute_reads_file(&run, &mut |_, _| {}).unwrap_err();
        assert_eq!(error, EngineError::NoReport);
        assert!(!reads_part_path(dir.path()).exists());
    }

    #[test]
    fn an_engine_that_is_not_there_is_reported_with_its_path() {
        let dir = tempfile::tempdir().unwrap();
        fs::write(dir.path().join(REPORT_FILE), "{}").unwrap();
        let engine = dir.path().join("no-such-engine");
        let run = EngineRun {
            engine: &engine,
            session_dir: dir.path(),
            model: Path::new("no-such-model"),
            model_sha256: "x",
            timeout: Duration::from_secs(1),
        };
        let error = compute_reads_file(&run, &mut |_, _| {}).unwrap_err();
        assert_eq!(error, EngineError::NotFound(engine.clone()));
        assert!(error.to_string().contains("解析エンジンが見つかりません"));
        assert!(!reads_part_path(dir.path()).exists());
    }
}
