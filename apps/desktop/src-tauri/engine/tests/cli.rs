//! 実行ファイル `jantama-engine read` の試験（ACCEPTANCE の E-53 の後半と、エラーの出し方）。
//!
//! - エラー: ファイルが無い・JSON が壊れている・libriichi が断る牌譜・モデルの形が違う、のどれも、
//!   終了コードが 0 でなく、標準エラーに日本語の 1 行だけが出る。モデルは要らず、いつも動く。
//! - E-53: 固定データの牌譜に `read` を動かすと、有効な reads.json が書かれ、参照の場面がすべて入っている。
//!   モデル（環境変数 `JANTAMA_MODEL_DIR` の `tenpai.onnx`）があるときだけ動く。

mod common;

use std::ffi::OsStr;
use std::path::Path;
use std::process::{Command, Output};
use std::time::Instant;

use common::{fixture_dir, scratch_path};
use serde_json::Value;

const TILE_NAMES: [&str; 34] = jantama_engine::tiles::KIND_NAMES;

fn engine(args: &[&OsStr]) -> Output {
    Command::new(env!("CARGO_BIN_EXE_jantama-engine"))
        .args(args)
        .output()
        .expect("jantama-engine を起動できる")
}

fn os(text: &str) -> &OsStr {
    OsStr::new(text)
}

/// 失敗していて、標準エラーが日本語の 1 行だけで、`needle` を含むこと。
fn assert_one_line_failure(output: &Output, needle: &str) {
    assert!(!output.status.success(), "失敗するはず");
    let stderr = String::from_utf8_lossy(&output.stderr);
    let text = stderr.trim_end();
    assert!(!text.is_empty(), "標準エラーが空");
    assert!(!text.contains('\n'), "標準エラーが複数行: {text}");
    assert!(!text.is_ascii(), "日本語の文のはず: {text}");
    assert!(text.contains(needle), "「{needle}」を含むはず: {text}");
    assert!(output.stdout.is_empty(), "標準出力には何も出さない");
}

fn game_path() -> std::path::PathBuf {
    fixture_dir().join("game.json")
}

fn write_scratch(name: &str, bytes: &[u8]) -> std::path::PathBuf {
    let path = scratch_path(name);
    std::fs::write(&path, bytes).expect("試験の一時ファイルを書ける");
    path
}

// ---- エラー（モデルが要らない） ----

#[test]
fn a_missing_report_fails_with_one_japanese_line() {
    let out = scratch_path("never-written-1.json");
    let output = engine(&[
        os("read"),
        os("--report"),
        os("no-such-dir/no-such-report.json"),
        os("--model"),
        os("no-such-model.onnx"),
        os("--out"),
        out.as_os_str(),
    ]);
    assert_one_line_failure(&output, "牌譜のファイルを読めません");
    assert!(!out.exists(), "失敗したときは出力先を作らない");
}

#[test]
fn a_missing_model_fails_with_one_japanese_line() {
    let out = scratch_path("never-written-2.json");
    let output = engine(&[
        os("read"),
        os("--report"),
        game_path().as_os_str(),
        os("--model"),
        os("no-such-dir/no-such-model.onnx"),
        os("--out"),
        out.as_os_str(),
    ]);
    assert_one_line_failure(&output, "モデルのファイルを読めません");
    assert!(!out.exists());
}

#[test]
fn a_missing_output_folder_fails_before_any_work() {
    let output = engine(&[
        os("read"),
        os("--report"),
        game_path().as_os_str(),
        os("--model"),
        os("no-such-model.onnx"),
        os("--out"),
        scratch_path("no-such-folder")
            .join("reads.json")
            .as_os_str(),
    ]);
    assert_one_line_failure(&output, "出力先のフォルダがありません");
}

#[test]
fn invalid_json_fails_with_one_japanese_line() {
    let report = write_scratch("broken-report.json", b"{ this is not json");
    let output = engine(&[
        os("read"),
        os("--report"),
        report.as_os_str(),
        os("--model"),
        os("no-such-model.onnx"),
        os("--out"),
        scratch_path("never-written-3.json").as_os_str(),
    ]);
    assert_one_line_failure(&output, "JSON");
}

#[test]
fn a_log_that_libriichi_rejects_fails_with_one_japanese_line() {
    // 配牌の前に自分のツモがある牌譜。libriichi は断る。
    let log = r#"{"player_id":0,"mjai_log":[
        {"type":"start_game","names":["a","b","c","d"],"seed":[1,2]},
        {"type":"tsumo","actor":0,"pai":"1m"}]}"#;
    let report = write_scratch("rejected-report.json", log.as_bytes());
    let output = engine(&[
        os("read"),
        os("--report"),
        report.as_os_str(),
        os("--model"),
        os("no-such-model.onnx"),
        os("--out"),
        scratch_path("never-written-4.json").as_os_str(),
    ]);
    assert_one_line_failure(&output, "mjai_log[1]");
}

#[test]
fn a_file_that_is_not_onnx_fails_with_one_japanese_line() {
    let model = write_scratch("garbage.onnx", b"this is not an onnx model at all");
    let output = engine(&[
        os("read"),
        os("--report"),
        game_path().as_os_str(),
        os("--model"),
        model.as_os_str(),
        os("--out"),
        scratch_path("never-written-5.json").as_os_str(),
    ]);
    assert_one_line_failure(&output, "ONNX");
}

// ---- 形の違うモデル: 最小の ONNX（Identity 1 個）を、試験の中で組み立てる ----

fn varint(mut value: u64, out: &mut Vec<u8>) {
    loop {
        let byte = (value & 0x7f) as u8;
        value >>= 7;
        if value == 0 {
            out.push(byte);
            return;
        }
        out.push(byte | 0x80);
    }
}

fn varint_field(field: u64, value: u64, out: &mut Vec<u8>) {
    varint(field << 3, out);
    varint(value, out);
}

fn bytes_field(field: u64, data: &[u8], out: &mut Vec<u8>) {
    varint((field << 3) | 2, out);
    varint(data.len() as u64, out);
    out.extend_from_slice(data);
}

/// ValueInfoProto: float のテンソル、形は「batch（名前つきの可変）+ 固定の数」。
fn value_info(name: &str, fixed_dims: &[u64]) -> Vec<u8> {
    let mut dims = Vec::new();
    let mut batch = Vec::new();
    bytes_field(2, b"batch", &mut batch); // Dimension.dim_param
    bytes_field(1, &batch, &mut dims); // TensorShapeProto.dim
    for dim in fixed_dims {
        let mut fixed = Vec::new();
        varint_field(1, *dim, &mut fixed); // Dimension.dim_value
        bytes_field(1, &fixed, &mut dims);
    }
    let mut tensor = Vec::new();
    varint_field(1, 1, &mut tensor); // elem_type = FLOAT
    bytes_field(2, &dims, &mut tensor); // shape
    let mut type_proto = Vec::new();
    bytes_field(1, &tensor, &mut type_proto); // tensor_type
    let mut info = Vec::new();
    bytes_field(1, name.as_bytes(), &mut info);
    bytes_field(2, &type_proto, &mut info);
    info
}

/// 入力 `obs` を、そのまま出力 `output_name` にする ONNX（Identity 1 個）。
fn identity_model(input_dims: &[u64], output_name: &str, output_dims: &[u64]) -> Vec<u8> {
    let mut node = Vec::new();
    bytes_field(1, b"obs", &mut node);
    bytes_field(2, output_name.as_bytes(), &mut node);
    bytes_field(3, b"identity", &mut node);
    bytes_field(4, b"Identity", &mut node);

    let mut graph = Vec::new();
    bytes_field(1, &node, &mut graph);
    bytes_field(2, b"tiny", &mut graph);
    bytes_field(11, &value_info("obs", input_dims), &mut graph);
    bytes_field(12, &value_info(output_name, output_dims), &mut graph);

    let mut opset = Vec::new();
    varint_field(2, 13, &mut opset);

    let mut model = Vec::new();
    varint_field(1, 8, &mut model); // ir_version
    bytes_field(8, &opset, &mut model);
    bytes_field(7, &graph, &mut model);
    model
}

fn assert_model_rejected(name: &str, bytes: &[u8], needle: &str) {
    let model = write_scratch(name, bytes);
    let output = engine(&[
        os("read"),
        os("--report"),
        game_path().as_os_str(),
        os("--model"),
        model.as_os_str(),
        os("--out"),
        scratch_path("never-written-6.json").as_os_str(),
    ]);
    assert_one_line_failure(&output, needle);
}

#[test]
fn a_model_with_a_different_input_shape_is_rejected_with_the_reason() {
    let bytes = identity_model(&[10, 34], "tenpai", &[10, 34]);
    assert_model_rejected("wrong-input.onnx", &bytes, "入力 obs");
}

#[test]
fn a_model_with_a_different_output_shape_is_rejected_with_the_reason() {
    let bytes = identity_model(&[934, 34], "tenpai", &[934, 34]);
    assert_model_rejected("wrong-output.onnx", &bytes, "出力 tenpai");
}

#[test]
fn a_model_without_the_expected_outputs_is_rejected_with_the_reason() {
    let bytes = identity_model(&[934, 34], "something_else", &[934, 34]);
    assert_model_rejected("other-outputs.onnx", &bytes, "出力 tenpai がありません");
}

// ---- 引数 ----

#[test]
fn bad_arguments_exit_with_code_2_and_one_line() {
    for args in [
        vec![os("read")],
        vec![os("scan")],
        vec![os("read"), os("--report"), os("a"), os("--model"), os("b")],
        vec![
            os("read"),
            os("--report"),
            os("a"),
            os("--model"),
            os("b"),
            os("--out"),
            os("c"),
            os("--player"),
            os("9"),
        ],
    ] {
        let output = engine(&args);
        assert_eq!(output.status.code(), Some(2), "{args:?}");
        assert_one_line_failure(&output, "使い方");
    }
}

#[test]
fn help_prints_the_usage_and_succeeds() {
    let output = engine(&[os("--help")]);
    assert!(output.status.success());
    let stdout = String::from_utf8_lossy(&output.stdout);
    assert!(stdout.contains("jantama-engine read --report"), "{stdout}");
}

// ---- E-53: 固定データの牌譜に read を動かす（モデルがあるときだけ） ----

fn is_rounded_to_4_decimals(value: f64) -> bool {
    ((value * 10_000.0).round() - value * 10_000.0).abs() < 1e-6
}

/// 小数 4 桁に丸めた確率（0 以上 1 以下）。
fn probability(value: &Value, what: &str) -> f64 {
    let x = value.as_f64().unwrap_or_else(|| panic!("{what}: 数のはず"));
    assert!((0.0..=1.0).contains(&x), "{what}: 確率の範囲外 {x}");
    assert!(is_rounded_to_4_decimals(x), "{what}: 小数 4 桁でない {x}");
    x
}

fn numbers(value: &Value, len: usize, what: &str) -> Vec<f64> {
    let list = value
        .as_array()
        .unwrap_or_else(|| panic!("{what}: 配列のはず"));
    assert_eq!(list.len(), len, "{what}");
    list.iter().map(|v| probability(v, what)).collect()
}

fn tile_index(name: &Value) -> usize {
    let name = name.as_str().expect("牌の名前は文字列");
    TILE_NAMES
        .iter()
        .position(|n| *n == name)
        .unwrap_or_else(|| panic!("牌の名前が mjai の 34 種でない: {name}"))
}

/// 1 つの他家の欄の形と、読みの値どうしの整合を確かめる。`hand` は、その場面の手牌（牌の名前）。
fn check_opponent(opponent: &Value, step: u64, player: u64, hand: &[usize]) {
    assert_eq!(opponent["step"], step);
    assert_eq!(opponent["seat"], (player + step) % 4);
    assert!(opponent["riichi"].is_boolean());
    let tenpai = probability(&opponent["tenpai"], "tenpai");
    probability(&opponent["furiten"], "furiten");
    let waits = numbers(&opponent["waits"], 34, "waits");

    // 上位 5 牌: 確率の高い順で、残りのどの牌よりも低くない。
    let top = opponent["top_waits"].as_array().expect("top_waits");
    assert_eq!(top.len(), 5);
    let mut previous = f64::INFINITY;
    let mut chosen = Vec::new();
    for entry in top {
        let kind = tile_index(&entry["tile"]);
        let p = entry["p"].as_f64().unwrap();
        assert_eq!(p, waits[kind], "top_waits の p は waits と同じ");
        assert!(p <= previous, "高い順");
        previous = p;
        chosen.push(kind);
    }
    let lowest_top = chosen
        .iter()
        .map(|&k| waits[k])
        .fold(f64::INFINITY, f64::min);
    for (kind, p) in waits.iter().enumerate() {
        if !chosen.contains(&kind) {
            assert!(*p <= lowest_top, "上位 5 牌より高い牌がある: {kind}");
        }
    }

    let actual: Vec<usize> = opponent["actual_waits"]
        .as_array()
        .expect("actual_waits")
        .iter()
        .map(tile_index)
        .collect();
    assert!(actual.windows(2).all(|w| w[0] < w[1]), "実際の待ちは牌の順");

    // 読み直すのは、リーチした他家と、聴牌の確率が 50% 以上の他家だけ。
    let reasons = opponent["reasons"].as_object().expect("reasons は object");
    let reread = opponent["riichi"].as_bool().unwrap() || tenpai >= 0.5;
    if !reread {
        assert!(reasons.is_empty(), "読み直さない他家に reasons がある");
    }
    for (tile, list) in reasons {
        assert!(
            hand.contains(&tile_index(&Value::from(tile.as_str()))),
            "reasons のキーは手牌の牌: {tile}"
        );
        let list = list.as_array().expect("reasons の値は配列");
        assert!(
            (1..=2).contains(&list.len()),
            "効いた捨て牌は 1〜2 個: {tile}"
        );
        for reason in list {
            assert!(reason["turn"].as_u64().unwrap() >= 1);
            assert!(reason["event_index"].as_u64().is_some());
            tile_index(&reason["pai"]);
            let without = reason["without"].as_f64().unwrap();
            assert!((0.0..=1.0).contains(&without) && is_rounded_to_4_decimals(without));
        }
    }
}

fn run_read(model: &Path, player: Option<&str>, out: &Path) -> (Output, std::time::Duration) {
    let game = game_path();
    let mut args: Vec<&OsStr> = vec![
        os("read"),
        os("--report"),
        game.as_os_str(),
        os("--model"),
        model.as_os_str(),
        os("--out"),
        out.as_os_str(),
    ];
    if let Some(player) = player {
        args.push(os("--player"));
        args.push(os(player));
    }
    let started = Instant::now();
    let output = engine(&args);
    (output, started.elapsed())
}

#[test]
fn e53_read_writes_a_valid_reads_json_with_every_fixture_moment() {
    let Some(model) = common::model_path() else {
        return;
    };
    let out = scratch_path("reads-seat0.json");
    let (output, elapsed) = run_read(&model, None, &out);
    println!(
        "E-53: jantama-engine read（固定データの 1 局、デバッグ版）の実行時間 {:.2} 秒",
        elapsed.as_secs_f64()
    );
    assert!(
        output.status.success(),
        "{}",
        String::from_utf8_lossy(&output.stderr)
    );

    let reads: Value =
        serde_json::from_slice(&std::fs::read(&out).unwrap()).expect("reads.json は JSON");
    assert_eq!(reads["format"], "jantama-reads/1");
    assert_eq!(reads["model"]["file"], "tenpai.onnx");
    assert_eq!(reads["model"]["sha256"], common::MODEL_SHA256);
    assert_eq!(reads["player_id"], 0);

    let moments = reads["moments"].as_array().expect("moments");
    // 進み具合: 標準エラーは progress の行だけで、最後は 全部/全部。
    let stderr = String::from_utf8_lossy(&output.stderr);
    let lines: Vec<&str> = stderr.lines().collect();
    assert!(lines.iter().all(|l| l.starts_with("progress ")), "{stderr}");
    assert_eq!(
        lines.first().copied(),
        Some(format!("progress 0/{}", moments.len()).as_str())
    );
    assert_eq!(
        lines.last().copied(),
        Some(format!("progress {0}/{0}", moments.len()).as_str())
    );

    // 参照の 126 場面がすべて入っている（自分のチー・ポンの場面が足されて、130 になる）。
    let reference = common::reference_moments();
    let present: Vec<u64> = moments
        .iter()
        .map(|m| m["event_index"].as_u64().unwrap())
        .collect();
    assert!(present.windows(2).all(|w| w[0] < w[1]));
    for moment in &reference {
        let index = moment["event_index"].as_u64().unwrap();
        assert!(
            present.contains(&index),
            "場面 {index} が reads.json に無い"
        );
    }
    assert_eq!(moments.len(), 130);

    let mut any_reasons = false;
    for moment in moments {
        let index = moment["event_index"].as_u64().unwrap();
        assert!(["E", "S", "W", "N"].contains(&moment["bakaze"].as_str().unwrap()));
        assert!((1..=4).contains(&moment["kyoku"].as_u64().unwrap()));
        assert!(moment["honba"].as_u64().is_some());
        assert!(moment["junme"].as_u64().unwrap() >= 1);
        assert!(moment["kyoku_index"].as_u64().is_some());
        numbers(&moment["any_wait"], 34, "any_wait");

        let hand: Vec<usize> = moment["hand"]
            .as_array()
            .unwrap()
            .iter()
            .map(tile_index)
            .collect();
        assert!(
            !hand.is_empty() && hand.windows(2).all(|w| w[0] < w[1]),
            "手牌は牌の順で重ならない: event {index}"
        );

        let opponents = moment["opponents"].as_array().expect("opponents");
        assert_eq!(opponents.len(), 3);
        for (offset, opponent) in opponents.iter().enumerate() {
            check_opponent(opponent, offset as u64 + 1, 0, &hand);
            any_reasons |= !opponent["reasons"].as_object().unwrap().is_empty();
        }

        // 参照の場面は、実際の待ちとリーチも一致する。
        if let Some(r) = reference
            .iter()
            .find(|r| r["event_index"].as_u64() == Some(index))
        {
            for step in 0..3 {
                let expected: Vec<&str> = r["true_waits"][step]
                    .as_array()
                    .unwrap()
                    .iter()
                    .map(|t| t.as_str().unwrap())
                    .collect();
                let actual: Vec<&str> = opponents[step]["actual_waits"]
                    .as_array()
                    .unwrap()
                    .iter()
                    .map(|t| t.as_str().unwrap())
                    .collect();
                assert_eq!(actual, expected, "event {index} step {}", step + 1);
                assert_eq!(
                    opponents[step]["riichi"],
                    r["opponent_riichi"][step],
                    "event {index} step {}",
                    step + 1
                );
            }
        }
    }
    assert!(
        any_reasons,
        "リーチした他家のいる場面に、効いた捨て牌が 1 つも出ていない"
    );
}

#[test]
fn e53_the_reasons_of_the_riichi_moment_match_the_onnxruntime_reference() {
    let Some(model) = common::model_path() else {
        return;
    };
    let out = scratch_path("reads-seat0-reasons.json");
    let (output, _) = run_read(&model, None, &out);
    assert!(
        output.status.success(),
        "{}",
        String::from_utf8_lossy(&output.stderr)
    );
    let reads: Value = serde_json::from_slice(&std::fs::read(&out).unwrap()).unwrap();

    // 場面 17（最初に他家がリーチしている場面）の、下家（step 1）。参照は onnxruntime の値（小数 6 桁）。
    let fixture = common::fixture_json("moments.json");
    let cf = &fixture["counterfactual"];
    let moment_index = cf["moment"].as_u64().unwrap() as usize;
    let event_index = common::reference_moments()[moment_index]["event_index"]
        .as_u64()
        .unwrap();
    let reference = common::fixture_json("reads_ref.json");
    let base = &reference["moments"][moment_index]["waits"][0];
    let rows = cf["rows"].as_array().unwrap();
    let swapped = reference["counterfactual"].as_array().unwrap();

    let moment = reads["moments"]
        .as_array()
        .unwrap()
        .iter()
        .find(|m| m["event_index"].as_u64() == Some(event_index))
        .expect("場面 17 がある");
    let opponent = &moment["opponents"][0];
    assert_eq!(opponent["riichi"], true);
    let reasons = opponent["reasons"].as_object().unwrap();

    let mut expected_keys = 0;
    for tile in moment["hand"].as_array().unwrap() {
        let kind = tile_index(tile);
        // 動き = |元の読み - 替えた読み|。0.01 以上のうち、大きい順（同じなら先の捨て牌）に 2 つ。
        let mut movers: Vec<(f64, usize)> = (0..rows.len())
            .filter_map(|row| {
                let delta =
                    base[kind].as_f64().unwrap() - swapped[row]["waits"][0][kind].as_f64().unwrap();
                (delta.abs() >= 0.01).then_some((delta.abs(), row))
            })
            .collect();
        movers.sort_by(|a, b| b.0.total_cmp(&a.0));
        movers.truncate(2);

        let name = tile.as_str().unwrap();
        match reasons.get(name) {
            None => assert!(
                movers.is_empty(),
                "{name}: reasons が無いが、参照では動きがある {movers:?}"
            ),
            Some(list) => {
                expected_keys += 1;
                let list = list.as_array().unwrap();
                assert_eq!(list.len(), movers.len(), "{name}");
                for (reason, (_, row)) in list.iter().zip(&movers) {
                    assert_eq!(reason["turn"], rows[*row]["turn"], "{name}");
                    assert_eq!(reason["event_index"], rows[*row]["event_index"], "{name}");
                    let pai = rows[*row]["pai"].as_str().unwrap();
                    assert_eq!(
                        reason["pai"].as_str().unwrap(),
                        pai.trim_end_matches('r'),
                        "{name}"
                    );
                    let without = swapped[*row]["waits"][0][kind].as_f64().unwrap();
                    assert!(
                        (reason["without"].as_f64().unwrap() - without).abs() <= 1.5e-4,
                        "{name}"
                    );
                }
            }
        }
    }
    assert_eq!(reasons.len(), expected_keys);
    assert!(expected_keys > 0, "場面 17 に効いた捨て牌が無い");
}

#[test]
fn the_player_option_reads_another_seat() {
    let Some(model) = common::model_path() else {
        return;
    };
    let out = scratch_path("reads-seat1.json");
    let (output, _) = run_read(&model, Some("1"), &out);
    assert!(
        output.status.success(),
        "{}",
        String::from_utf8_lossy(&output.stderr)
    );
    let reads: Value = serde_json::from_slice(&std::fs::read(&out).unwrap()).unwrap();
    assert_eq!(reads["player_id"], 1);

    let game = common::fixture_json("game.json");
    let log = game["mjai_log"].as_array().unwrap();
    let moments = reads["moments"].as_array().unwrap();
    assert!(!moments.is_empty());
    for moment in moments {
        let event = &log[moment["event_index"].as_u64().unwrap() as usize];
        assert_eq!(event["actor"], 1);
        assert!(["tsumo", "chi", "pon"].contains(&event["type"].as_str().unwrap()));
        let seats: Vec<u64> = moment["opponents"]
            .as_array()
            .unwrap()
            .iter()
            .map(|o| o["seat"].as_u64().unwrap())
            .collect();
        assert_eq!(seats, [2, 3, 0]);
    }
}
