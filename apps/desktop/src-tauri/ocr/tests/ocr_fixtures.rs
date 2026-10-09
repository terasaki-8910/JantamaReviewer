//! E-20: Windows の日本語の文字認識で、10 月 9 日の半荘の迷いマーク 6 枚の中央の画像（FX-4）を読む（Windows だけで動く試験）。
//!
//! `tests/fixtures/mark<N>-center.png` は、迷いマークの画面（1447×935）から、箱 (0.425W, 0.36H)–(0.575W, 0.50H) を切り出して、
//! Lanczos で 3 倍にしたもの（切り出しの決まりは `geometry::center_crop`）。局の名前・残りの牌の数・点数だけが写っていて、
//! プレイヤーの名前は写っていない。この試験は、その画像をそのまま（これ以上切り出さずに）読む。
//!
//! 読み取りの結果の文字列から局・残り枚数・点数を取り出す関数（E-16）は、エンジン（TypeScript）にある。
//! ここでは、文字認識がその材料（局の名前と 2 つの数）を返すことを、空白を除いた文字列で確かめる。
//! 残り枚数の前の印（余）は、「个」などに読み違えられるので、数だけを見る。

#![cfg(windows)]

use std::path::PathBuf;

use jantama_ocr::OcrWorker;

fn fixture(number: usize) -> PathBuf {
    PathBuf::from(env!("CARGO_MANIFEST_DIR"))
        .join("tests")
        .join("fixtures")
        .join(format!("mark{number}-center.png"))
}

/// 読み取った行を、空白を除いて 1 つにつなぐ。
fn squeezed(lines: &[String]) -> String {
    lines
        .iter()
        .flat_map(|line| line.chars())
        .filter(|c| !c.is_whitespace())
        .collect()
}

/// `東|南|西` と `1〜4` と `局` が続く所があるか（局の名前）。
fn has_round_name(text: &str) -> bool {
    let chars: Vec<char> = text.chars().collect();
    chars
        .windows(3)
        .any(|w| matches!(w[0], '東' | '南' | '西') && matches!(w[1], '1'..='4') && w[2] == '局')
}

#[test]
fn e20_marks_1_to_5_give_the_round_the_tiles_left_and_the_score_and_mark_6_gives_no_round() {
    let worker = OcrWorker::start().expect("日本語の文字認識を使える");
    // (番号, 局の名前, 残りの牌の数, 自分の点数)
    let expected = [
        (1, "東1局", "59", "25000"),
        (2, "東2局", "23", "19000"),
        (3, "東2局", "47", "15100"),
        (4, "東2局", "35", "15100"),
        (5, "東3局", "46", "4400"),
    ];
    for (number, round, left, score) in expected {
        let lines = worker
            .read_lines_uncropped(&fixture(number))
            .unwrap_or_else(|e| panic!("迷い{number}: {e}"));
        let text = squeezed(&lines);
        eprintln!("迷い{number}: {lines:?} → {text}");
        assert!(
            text.contains(round),
            "迷い{number}: {round} が無い: {lines:?}"
        );
        assert!(
            text.contains(left),
            "迷い{number}: 残り {left} が無い: {lines:?}"
        );
        assert!(
            text.contains(score),
            "迷い{number}: 点数 {score} が無い: {lines:?}"
        );
    }

    let lines = worker
        .read_lines_uncropped(&fixture(6))
        .expect("迷い6 も、読めない結果として返る（失敗にはならない）");
    let text = squeezed(&lines);
    eprintln!("迷い6: {lines:?} → {text}");
    assert!(
        !has_round_name(&text),
        "迷い6 は局の名前を読み取れないはず（E-16 の「読めない」）: {lines:?}"
    );
}

#[test]
fn the_round_name_check_finds_only_a_real_round_name() {
    assert!(has_round_name("8个59東1局25000"));
    assert!(has_round_name("南4局"));
    assert!(has_round_name("西3局"));
    assert!(!has_round_name("東5局"));
    assert!(!has_round_name("北1局"));
    assert!(!has_round_name("局80833一3詈0"));
    assert!(!has_round_name(""));
}
