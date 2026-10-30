//! 解析エンジンを呼ぶ層（`reads::engine_runner`。F24）の、本物のプロセスを使う試験（S-5 の「渡すのは 3 つのパスだけ」・D-8 の読みの保存）。
//!
//! 本物のエンジン（モデルが要る）が無い環境（Actions など）でも、毎回動かせるように、試験の実行ファイル自身を「偽のエンジン」にする:
//! 引数が `read` で始まるとき（= エンジンとして呼ばれたとき）は、`--report` のファイルの先頭の行に書かれた筋書きどおりに、標準エラーと
//! 出力先を作って終わる。そうでないとき（= 試験を動かす側）は、下の試験を順に動かす。
//! 通常の試験の枠（libtest）は使わない（`Cargo.toml` の `harness = false`）。枠が、`read --report ...` の引数を、自分の引数として
//! 読んで、断ってしまうため。試験の名前の一部を引数に渡すと、その試験だけを動かす。
//!
//! 本物のエンジンの試験は、環境変数 `JANTAMA_ENGINE`（エンジンの実行ファイル）と `JANTAMA_MODEL_DIR`（`tenpai.onnx` のあるフォルダ）が
//! 両方あるときだけ動く。無ければ、理由を出して通る（モデルは、リポジトリにも試験にも入れない）。

use std::ffi::OsString;
use std::fs;
use std::panic::{catch_unwind, AssertUnwindSafe};
use std::path::{Path, PathBuf};
use std::process::exit;
use std::thread;
use std::time::{Duration, Instant};

use jantama_reviewer_lib::reads::catalog::READS_MODEL;
use jantama_reviewer_lib::reads::engine_runner::{compute_reads_file, EngineError, EngineRun};
use jantama_reviewer_lib::reads::reads_file::{check, reads_part_path, reads_path};

/// 偽のエンジンが、出力に書き込むモデルの SHA-256（試験が、`EngineRun::model_sha256` に渡すのと同じ値）。
const FAKE_SHA: &str = "ab12ab12ab12ab12ab12ab12ab12ab12ab12ab12ab12ab12ab12ab12ab12ab12";

// ---- 偽のエンジン（呼ばれた側） ----

/// 筋書きの文（`report.json` の中身）。1 行目が筋書きの名前、続く行が `名前=値`。
fn scenario_text(name: &str, params: &[(&str, &str)]) -> String {
    let mut text = format!("{name}\n");
    for (key, value) in params {
        text.push_str(&format!("{key}={value}\n"));
    }
    text
}

fn valid_reads(sha: &str) -> String {
    format!(
        r#"{{"format":"jantama-reads/1","model":{{"file":"tenpai.onnx","sha256":"{sha}"}},"player_id":0,"moments":[{{"event_index":1}},{{"event_index":2}},{{"event_index":3}}]}}"#
    )
}

/// エンジンとして呼ばれたとき。終了コードを返す。
fn fake_engine(args: &[OsString]) -> i32 {
    let text: Vec<String> = args
        .iter()
        .map(|a| a.to_string_lossy().into_owned())
        .collect();
    // 引数は、決まった形の 7 つだけのはず
    let shaped = text.len() == 7
        && text[0] == "read"
        && text[1] == "--report"
        && text[3] == "--model"
        && text[5] == "--out";
    if !shaped {
        eprintln!("jantama-engine: 引数の形が違います: {text:?}");
        return 2;
    }
    let (report, out) = (&text[2], &text[6]);
    let scenario = fs::read_to_string(report).unwrap_or_default();
    let mut lines = scenario.lines();
    let name = lines.next().unwrap_or("");
    let param = |key: &str| -> Option<String> {
        scenario
            .lines()
            .skip(1)
            .find_map(|line| line.strip_prefix(&format!("{key}=")).map(str::to_string))
    };
    if let Some(side) = param("side") {
        // 受け取った引数を、そのまま記録する（呼ぶ側が、これだけだったかを確かめる）
        let _ = fs::write(side, text.join("\n"));
    }
    let sha = param("sha").unwrap_or_else(|| FAKE_SHA.to_string());
    match name {
        "ok" => {
            for done in 1..=3 {
                eprintln!("progress {done}/3");
            }
            fs::write(out, valid_reads(&sha)).expect("出力先に書ける");
            0
        }
        "fail" => {
            eprintln!("jantama-engine: 牌譜のファイルを読めません: 試験");
            1
        }
        "noisy-fail" => {
            eprintln!("warning: 雑音の行");
            eprintln!("progress 1/2");
            eprintln!("jantama-engine: 本当の理由");
            eprintln!();
            eprintln!("progress 2/2");
            1
        }
        "silent-fail" => 7,
        "partial-then-fail" => {
            fs::write(out, "{\"format\":\"jantama-reads/1\",").expect("書ける");
            eprintln!("jantama-engine: 途中で止まりました");
            1
        }
        "bad-format" => {
            fs::write(out, valid_reads(&sha).replace("reads/1", "reads/2")).expect("書ける");
            0
        }
        "no-output" => 0,
        "sleep" => {
            eprintln!("progress 1/2");
            let wait = param("sleep_ms")
                .and_then(|v| v.parse::<u64>().ok())
                .unwrap_or(60_000);
            thread::sleep(Duration::from_millis(wait));
            // 止められずに、ここまで来たことの印
            if let Some(marker) = param("survived") {
                let _ = fs::write(marker, "survived");
            }
            0
        }
        other => {
            eprintln!("jantama-engine: 知らない筋書きです: {other}");
            2
        }
    }
}

// ---- 試験を動かす側 ----

struct Session {
    dir: tempfile::TempDir,
    engine: PathBuf,
    model: PathBuf,
}

impl Session {
    /// 筋書きの文を `report.json` に置いた、半荘のフォルダ。
    fn new(name: &str, params: &[(&str, &str)]) -> Session {
        let dir = tempfile::tempdir().unwrap();
        fs::write(dir.path().join("report.json"), scenario_text(name, params)).unwrap();
        let model = dir.path().join("tenpai.onnx");
        fs::write(&model, b"dummy model").unwrap();
        Session {
            dir,
            engine: std::env::current_exe().expect("試験の実行ファイルの場所"),
            model,
        }
    }

    fn path(&self) -> &Path {
        self.dir.path()
    }

    fn run(
        &self,
        timeout: Duration,
        progress: &mut Vec<(usize, usize)>,
    ) -> Result<String, EngineError> {
        let run = EngineRun {
            engine: &self.engine,
            session_dir: self.path(),
            model: &self.model,
            model_sha256: FAKE_SHA,
            timeout,
        };
        compute_reads_file(&run, &mut |done, total| progress.push((done, total)))
    }

    fn run_quietly(&self) -> Result<String, EngineError> {
        self.run(Duration::from_secs(60), &mut Vec::new())
    }

    fn names(&self) -> Vec<String> {
        let mut names: Vec<String> = fs::read_dir(self.path())
            .unwrap()
            .flatten()
            .map(|e| e.file_name().to_string_lossy().into_owned())
            .collect();
        names.sort();
        names
    }
}

const OLD_READS: &str = "OLD-READS";

fn assert_nothing_left_behind(session: &Session) {
    assert!(
        !reads_part_path(session.path()).exists(),
        "途中のファイルが残っている"
    );
}

fn success_places_reads_json_and_reports_progress() {
    let session = Session::new("ok", &[]);
    let mut progress = Vec::new();
    let text = session.run(Duration::from_secs(60), &mut progress).unwrap();
    assert_eq!(text, valid_reads(FAKE_SHA));
    assert_eq!(progress, vec![(1, 3), (2, 3), (3, 3)]);
    assert_eq!(
        fs::read_to_string(reads_path(session.path())).unwrap(),
        text
    );
    assert_nothing_left_behind(&session);
    assert_eq!(check(&text, FAKE_SHA), Ok(()));
}

fn the_engine_receives_exactly_seven_arguments_and_the_output_goes_to_the_part_file() {
    let side = tempfile::tempdir().unwrap().keep().join("args.txt");
    let session = Session::new("ok", &[("side", side.to_str().unwrap())]);
    session.run_quietly().unwrap();
    let recorded = fs::read_to_string(&side).unwrap();
    let args: Vec<&str> = recorded.lines().collect();
    assert_eq!(args.len(), 7, "{args:?}");
    assert_eq!(args[0], "read");
    assert_eq!(args[1], "--report");
    assert_eq!(Path::new(args[2]), session.path().join("report.json"));
    assert_eq!(args[3], "--model");
    assert_eq!(Path::new(args[4]), session.model);
    assert_eq!(args[5], "--out");
    assert_eq!(Path::new(args[6]), reads_part_path(session.path()));
    // 出力先は、reads.json でなく、reads.json.part（計算が済んでから、本来の名前にする）
    assert!(args[6].ends_with("reads.json.part"), "{}", args[6]);
}

fn a_failed_run_reports_the_engines_one_line_and_leaves_no_trace() {
    let session = Session::new("fail", &[]);
    let error = session.run_quietly().unwrap_err();
    assert_eq!(
        error,
        EngineError::Failed("jantama-engine: 牌譜のファイルを読めません: 試験".to_string())
    );
    assert_eq!(
        error.to_string(),
        "jantama-engine: 牌譜のファイルを読めません: 試験"
    );
    assert!(!reads_path(session.path()).exists());
    assert_nothing_left_behind(&session);
}

fn only_the_last_non_progress_line_is_the_reason_and_progress_is_still_reported() {
    let session = Session::new("noisy-fail", &[]);
    let mut progress = Vec::new();
    let error = session
        .run(Duration::from_secs(60), &mut progress)
        .unwrap_err();
    assert_eq!(
        error,
        EngineError::Failed("jantama-engine: 本当の理由".to_string())
    );
    assert_eq!(progress, vec![(1, 2), (2, 2)]);
}

fn a_silent_failure_names_the_exit_code() {
    let session = Session::new("silent-fail", &[]);
    let error = session.run_quietly().unwrap_err();
    match error {
        EngineError::Failed(text) => assert!(text.contains("終了コード 7"), "{text}"),
        other => panic!("{other:?}"),
    }
}

fn a_failed_run_keeps_the_existing_reads_json_and_removes_the_part_file() {
    for scenario in [
        "fail",
        "partial-then-fail",
        "bad-format",
        "no-output",
        "silent-fail",
    ] {
        let session = Session::new(scenario, &[]);
        fs::write(reads_path(session.path()), OLD_READS).unwrap();
        // 前に止まったときの残りがあっても、消える
        fs::write(reads_part_path(session.path()), "stale").unwrap();
        assert!(session.run_quietly().is_err(), "{scenario}");
        assert_eq!(
            fs::read_to_string(reads_path(session.path())).unwrap(),
            OLD_READS,
            "{scenario}"
        );
        assert_nothing_left_behind(&session);
    }
}

fn output_that_the_engine_wrote_but_cannot_be_used_is_refused_before_it_replaces_anything() {
    // 0 で終わっても、形の名前が違う・モデルが違う・何も書いていない出力は、使わない
    for (scenario, params, expected) in [
        ("bad-format", vec![], "形の名前"),
        ("ok", vec![("sha", "0000")], "モデル"),
        ("no-output", vec![], "書きませんでした"),
    ] {
        let session = Session::new(scenario, &params);
        fs::write(reads_path(session.path()), OLD_READS).unwrap();
        match session.run_quietly().unwrap_err() {
            EngineError::BadOutput(reason) => {
                assert!(reason.contains(expected), "{scenario}: {reason}")
            }
            other => panic!("{scenario}: {other:?}"),
        }
        assert_eq!(
            fs::read_to_string(reads_path(session.path())).unwrap(),
            OLD_READS
        );
        assert_nothing_left_behind(&session);
    }
}

fn a_run_that_takes_too_long_is_killed_and_leaves_no_trace() {
    let marker = tempfile::tempdir().unwrap().keep().join("survived");
    let session = Session::new(
        "sleep",
        &[("sleep_ms", "2000"), ("survived", marker.to_str().unwrap())],
    );
    let started = Instant::now();
    let mut progress = Vec::new();
    let error = session
        .run(Duration::from_millis(400), &mut progress)
        .unwrap_err();
    assert_eq!(error, EngineError::Timeout);
    assert!(
        started.elapsed() < Duration::from_millis(1800),
        "止めるのが遅い: {:?}",
        started.elapsed()
    );
    // 止めたあとも、動き続けていないこと（動いていたら、2 秒後に印のファイルを作る）
    thread::sleep(Duration::from_millis(2600));
    assert!(!marker.exists(), "エンジンが止まっていない");
    assert_nothing_left_behind(&session);
    assert!(!reads_path(session.path()).exists());
}

fn a_slow_but_finishing_run_is_not_cut_short() {
    let marker = tempfile::tempdir().unwrap().keep().join("survived");
    let session = Session::new(
        "sleep",
        &[("sleep_ms", "300"), ("survived", marker.to_str().unwrap())],
    );
    // 偽の筋書き「sleep」は出力を書かないので、時間内に終わっても、使える読みが無く、断られる（時間切れではない）
    let error = session
        .run(Duration::from_secs(30), &mut Vec::new())
        .unwrap_err();
    assert!(matches!(error, EngineError::BadOutput(_)), "{error:?}");
    assert!(marker.exists());
}

fn an_engine_that_does_not_exist_is_reported_with_its_path() {
    let mut session = Session::new("ok", &[]);
    session.engine = session.path().join("no-such-engine.exe");
    let error = session.run_quietly().unwrap_err();
    assert_eq!(error, EngineError::NotFound(session.engine.clone()));
    assert!(error
        .to_string()
        .starts_with("解析エンジンが見つかりません（"));
    assert_nothing_left_behind(&session);
}

fn a_session_without_a_report_does_not_start_the_engine() {
    let session = Session::new("ok", &[]);
    fs::remove_file(session.path().join("report.json")).unwrap();
    let error = session.run_quietly().unwrap_err();
    assert_eq!(error, EngineError::NoReport);
    assert_eq!(
        error.to_string(),
        "この半荘は、まだ結果を取り込んでいません"
    );
    assert_eq!(session.names(), vec!["tenpai.onnx".to_string()]);
}

fn two_runs_in_a_row_replace_the_reads_file_each_time() {
    let session = Session::new("ok", &[]);
    let first = session.run_quietly().unwrap();
    // 同じ半荘を、もう一度計算する（モデルが替わったときの作り直し）。前の写しは、新しいものに替わる
    let second = session.run_quietly().unwrap();
    assert_eq!(first, second);
    assert_eq!(
        session.names(),
        vec![
            "reads.json".to_string(),
            "report.json".to_string(),
            "tenpai.onnx".to_string()
        ]
    );
}

// ---- 本物のエンジン（あるときだけ） ----

/// 本物のエンジンの実行ファイルと、本物のモデルのフォルダ。どちらかが無ければ、理由を出して `None`。
fn real_engine() -> Option<(PathBuf, PathBuf)> {
    let engine = std::env::var_os("JANTAMA_ENGINE").map(PathBuf::from);
    let models = std::env::var_os("JANTAMA_MODEL_DIR").map(PathBuf::from);
    match (engine, models) {
        (Some(engine), Some(models)) => {
            let model = models.join("tenpai.onnx");
            if !engine.is_file() || !model.is_file() {
                println!(
                    "skip: {} か {} が無いので、本物のエンジンの試験を飛ばします",
                    engine.display(),
                    model.display()
                );
                return None;
            }
            Some((engine, model))
        }
        _ => {
            println!(
                "skip: 環境変数 JANTAMA_ENGINE か JANTAMA_MODEL_DIR が無いので、本物のエンジンの試験を飛ばします"
            );
            None
        }
    }
}

fn the_real_engine_computes_the_reads_of_the_fixture_game() {
    let Some((engine, model)) = real_engine() else {
        return;
    };
    let dir = tempfile::tempdir().unwrap();
    // 固定データ FX-E の牌譜（S42 同士の自己対局 1 局。個人の記録を含まない）を、半荘の結果として置く
    let game = Path::new(env!("CARGO_MANIFEST_DIR")).join("engine/tests/fixtures/fx-e/game.json");
    fs::copy(&game, dir.path().join("report.json")).unwrap();
    let mut progress = Vec::new();
    let run = EngineRun {
        engine: &engine,
        session_dir: dir.path(),
        model: &model,
        model_sha256: READS_MODEL.sha256,
        timeout: Duration::from_secs(600),
    };
    let text = compute_reads_file(&run, &mut |done, total| progress.push((done, total)))
        .unwrap_or_else(|e| panic!("本物のエンジンが失敗した: {e}"));
    assert_eq!(check(&text, READS_MODEL.sha256), Ok(()));
    assert_eq!(fs::read_to_string(reads_path(dir.path())).unwrap(), text);
    assert_nothing_left_behind_in(dir.path());
    // 進み具合: 全部は場面の数、済みは増えていき、最後に全部になる
    let value: serde_json::Value = serde_json::from_str(&text).unwrap();
    let moments = value["moments"].as_array().unwrap().len();
    assert!(moments > 0);
    assert!(!progress.is_empty());
    assert!(
        progress
            .iter()
            .all(|(done, total)| *total == moments && done <= total),
        "{progress:?}"
    );
    assert!(progress.windows(2).all(|w| w[0].0 <= w[1].0));
    assert_eq!(progress.last(), Some(&(moments, moments)));
    // 場面の中身: 他家 3 人の聴牌の確率
    let first = &value["moments"][0];
    assert_eq!(first["opponents"].as_array().unwrap().len(), 3);
}

fn the_real_engine_refuses_a_broken_report_with_one_japanese_line() {
    let Some((engine, model)) = real_engine() else {
        return;
    };
    let dir = tempfile::tempdir().unwrap();
    fs::write(dir.path().join("report.json"), "{ this is not json").unwrap();
    let run = EngineRun {
        engine: &engine,
        session_dir: dir.path(),
        model: &model,
        model_sha256: READS_MODEL.sha256,
        timeout: Duration::from_secs(600),
    };
    match compute_reads_file(&run, &mut |_, _| {}).unwrap_err() {
        EngineError::Failed(line) => {
            assert!(line.starts_with("jantama-engine:"), "{line}");
            assert!(!line.contains('\n'));
        }
        other => panic!("{other:?}"),
    }
    assert!(!reads_path(dir.path()).exists());
    assert_nothing_left_behind_in(dir.path());
}

fn assert_nothing_left_behind_in(dir: &Path) {
    assert!(!reads_part_path(dir).exists(), "途中のファイルが残っている");
}

fn main() {
    let args: Vec<OsString> = std::env::args_os().skip(1).collect();
    // エンジンとして呼ばれたとき
    if args.first().is_some_and(|a| a == "read") {
        exit(fake_engine(&args));
    }

    // 試験を動かす側
    let filter: Option<String> = args
        .iter()
        .filter_map(|a| a.to_str())
        .find(|a| !a.starts_with('-'))
        .map(str::to_string);
    let tests: &[(&str, fn())] = &[
        (
            "success_places_reads_json_and_reports_progress",
            success_places_reads_json_and_reports_progress,
        ),
        (
            "the_engine_receives_exactly_seven_arguments_and_the_output_goes_to_the_part_file",
            the_engine_receives_exactly_seven_arguments_and_the_output_goes_to_the_part_file,
        ),
        (
            "a_failed_run_reports_the_engines_one_line_and_leaves_no_trace",
            a_failed_run_reports_the_engines_one_line_and_leaves_no_trace,
        ),
        (
            "only_the_last_non_progress_line_is_the_reason_and_progress_is_still_reported",
            only_the_last_non_progress_line_is_the_reason_and_progress_is_still_reported,
        ),
        (
            "a_silent_failure_names_the_exit_code",
            a_silent_failure_names_the_exit_code,
        ),
        (
            "a_failed_run_keeps_the_existing_reads_json_and_removes_the_part_file",
            a_failed_run_keeps_the_existing_reads_json_and_removes_the_part_file,
        ),
        (
            "output_that_the_engine_wrote_but_cannot_be_used_is_refused_before_it_replaces_anything",
            output_that_the_engine_wrote_but_cannot_be_used_is_refused_before_it_replaces_anything,
        ),
        (
            "a_run_that_takes_too_long_is_killed_and_leaves_no_trace",
            a_run_that_takes_too_long_is_killed_and_leaves_no_trace,
        ),
        (
            "a_slow_but_finishing_run_is_not_cut_short",
            a_slow_but_finishing_run_is_not_cut_short,
        ),
        (
            "an_engine_that_does_not_exist_is_reported_with_its_path",
            an_engine_that_does_not_exist_is_reported_with_its_path,
        ),
        (
            "a_session_without_a_report_does_not_start_the_engine",
            a_session_without_a_report_does_not_start_the_engine,
        ),
        (
            "two_runs_in_a_row_replace_the_reads_file_each_time",
            two_runs_in_a_row_replace_the_reads_file_each_time,
        ),
        (
            "the_real_engine_computes_the_reads_of_the_fixture_game",
            the_real_engine_computes_the_reads_of_the_fixture_game,
        ),
        (
            "the_real_engine_refuses_a_broken_report_with_one_japanese_line",
            the_real_engine_refuses_a_broken_report_with_one_japanese_line,
        ),
    ];

    let selected: Vec<&(&str, fn())> = tests
        .iter()
        .filter(|(name, _)| filter.as_deref().is_none_or(|f| name.contains(f)))
        .collect();
    println!("\nrunning {} tests", selected.len());
    let mut failed = Vec::new();
    for (name, test) in selected.iter().map(|t| (t.0, t.1)) {
        match catch_unwind(AssertUnwindSafe(test)) {
            Ok(()) => println!("test {name} ... ok"),
            Err(_) => {
                println!("test {name} ... FAILED");
                failed.push(name);
            }
        }
    }
    let passed = selected.len() - failed.len();
    println!(
        "\ntest result: {}. {passed} passed; {} failed",
        if failed.is_empty() { "ok" } else { "FAILED" },
        failed.len()
    );
    if !failed.is_empty() {
        println!("failures:\n    {}", failed.join("\n    "));
        exit(101);
    }
}
