//! E-20: Windows の日本語の文字認識で、10 月 9 日の半荘の迷いマーク 6 枚の中央の画像（FX-4）を読む（Windows だけで動く試験）。
//! 1 回目の読み取りで局・残り枚数・点数が取れない迷い 6 は、コントラストを上げた画像と 1.5 倍に広げた画像（読み直し）で、
//! 東3局・残り38枚・4400点 と読める。
//!
//! `tests/fixtures/mark<N>-center.png` は、迷いマークの画面（1447×935）から、箱 (0.425W, 0.36H)–(0.575W, 0.50H) を切り出して、
//! Lanczos で 3 倍にしたもの（切り出しの決まりは `geometry::center_crop`）。局の名前・残りの牌の数・点数だけが写っていて、
//! プレイヤーの名前は写っていない。この試験は、その画像をそのまま（これ以上切り出さずに）読む。
//!
//! 読み取りの結果の文字列から局・残り枚数・点数を取り出す関数（E-16）は、エンジン（TypeScript）にある。
//! ここでは、文字認識がその材料（局の名前と 2 つの数）を返すことを、空白を除いた文字列で確かめる。
//! 残り枚数の前の印（余）は、「个」などに読み違えられるので、数だけを見る。

#![cfg(windows)]

use std::fs::File;
use std::io::{BufReader, BufWriter};
use std::path::{Path, PathBuf};

use jantama_ocr::{center_crop, OcrWorker, Reading, Variant, UPSCALE};

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

/// 読み取りのうち、`variant` の画像のものの行。
fn lines_of(readings: &[Reading], variant: Variant) -> &[String] {
    &readings
        .iter()
        .find(|r| r.variant == variant)
        .unwrap_or_else(|| panic!("{} の読み取りが無い: {readings:?}", variant.name()))
        .lines
}

/// `東|南|西` と `1〜4` と `局` が続く所があるか（局の名前）。
fn has_round_name(text: &str) -> bool {
    let chars: Vec<char> = text.chars().collect();
    chars
        .windows(3)
        .any(|w| matches!(w[0], '東' | '南' | '西') && matches!(w[1], '1'..='4') && w[2] == '局')
}

#[test]
fn e20_marks_1_to_5_give_the_round_the_tiles_left_and_the_score_in_the_first_pass() {
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

    // 迷い 6 の 1 回目は、局の名前を読み取れない（読み直しが要る）。
    let lines = worker
        .read_lines_uncropped(&fixture(6))
        .expect("迷い6 も、読めない結果として返る（失敗にはならない）");
    let text = squeezed(&lines);
    eprintln!("迷い6 の 1 回目: {lines:?} → {text}");
    assert!(
        !has_round_name(&text),
        "迷い6 の 1 回目は局の名前を読み取れないはず: {lines:?}"
    );
}

#[test]
fn e20_mark_6_reads_as_round_east_3_tiles_38_score_4400_in_the_retries() {
    let worker = OcrWorker::start().expect("日本語の文字認識を使える");
    let readings = worker
        .read_variants_uncropped(&fixture(6))
        .expect("迷い6 の読み直し");
    assert_eq!(
        readings.iter().map(|r| r.variant).collect::<Vec<_>>(),
        Variant::ALL.to_vec(),
        "1 回目・コントラスト・広げた画像の順に、3 つ読む"
    );
    let first = squeezed(lines_of(&readings, Variant::Plain));
    assert!(!has_round_name(&first), "1 回目は読めない: {first}");
    // コントラストを上げた画像も、1.5 倍に広げた画像も、東3局・残り 38 枚・4400 点と読める。
    for variant in [Variant::Contrast, Variant::Enlarged] {
        let lines = lines_of(&readings, variant);
        let text = squeezed(lines);
        eprintln!("迷い6 の {}: {lines:?} → {text}", variant.name());
        assert!(
            text.contains("東3局"),
            "{}: 東3局 が無い: {lines:?}",
            variant.name()
        );
        assert!(
            text.contains("38"),
            "{}: 残り 38 が無い: {lines:?}",
            variant.name()
        );
        assert!(
            text.contains("4400"),
            "{}: 点数 4400 が無い: {lines:?}",
            variant.name()
        );
    }
    // 迷い 6 の読み直しは、本物の記録（FX-4 の fx4-ocr.json の写し）と同じ行（エンジンの E-20 の試験が、この行を読む）。
    assert_eq!(
        lines_of(&readings, Variant::Contrast),
        ["0088 乙", "東 3 局", "8 个 38", "4400"]
    );
    assert_eq!(
        lines_of(&readings, Variant::Enlarged),
        ["「 1", "0088 乙", "東 3 局", "ー 个 38", "4400"]
    );
}

#[test]
fn the_variants_of_every_mark_always_start_with_the_first_reading() {
    // 1 回目は、`read_lines_uncropped`（読み直しをしない読み取り）と同じ行。読み直しは、あとに続く。
    let worker = OcrWorker::start().expect("日本語の文字認識を使える");
    for number in 1..=6 {
        let plain = worker.read_lines_uncropped(&fixture(number)).unwrap();
        let readings = worker.read_variants_uncropped(&fixture(number)).unwrap();
        assert_eq!(readings.first().map(|r| r.variant), Some(Variant::Plain));
        assert_eq!(
            lines_of(&readings, Variant::Plain),
            plain.as_slice(),
            "迷い{number}"
        );
        assert_eq!(
            readings.len(),
            3,
            "迷い{number}: 広げても上限（2600）を超えない"
        );
    }
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

/// 試験の素材（3 倍の切り出し）から、元の切り出しの画素を取り戻して、迷いマークの画面（1447×935）の箱の位置に貼った PNG を作る。
///
/// Lanczos で 3 倍にすると、出力の (3k+1) 番目の画素は、元の k 番目の画素の中心にちょうど当たる（窓つきの sinc は、整数の
/// 位置で 1 と 0 になる）。だから、3 つおきに（1 番目から）取れば、元の画素がほぼそのまま戻る（端の画素は、少し違う）。
/// 本物の画面は素材の元の画面で、手元の保存先の外へは出せないので、この取り戻した画面が、製品の読み取り
/// （画面から箱を切り出して、Lanczos で 3 倍にして読む）を、素材と同じ画素で確かめる、代わりになる。
fn recovered_screen(number: usize, dir: &Path) -> PathBuf {
    let decoder = png::Decoder::new(BufReader::new(File::open(fixture(number)).unwrap()));
    let mut reader = decoder.read_info().unwrap();
    let mut buffer = vec![0u8; reader.output_buffer_size().unwrap()];
    let info = reader.next_frame(&mut buffer).unwrap();
    assert_eq!(info.color_type, png::ColorType::Rgb);
    let (width, height) = (1447u32, 935u32);
    let crop = center_crop(width, height).unwrap();
    assert_eq!(
        crop.scaled(UPSCALE),
        (info.width, info.height),
        "素材は、この箱の 3 倍"
    );

    let mut pixels = vec![0u8; (width * height * 3) as usize];
    for chunk in pixels.chunks_exact_mut(3) {
        chunk.copy_from_slice(&[20, 30, 60]);
    }
    for y in 0..crop.height {
        for x in 0..crop.width {
            let from = (((3 * y + 1) * info.width + (3 * x + 1)) * 3) as usize;
            let to = (((crop.y + y) * width + (crop.x + x)) * 3) as usize;
            pixels[to..to + 3].copy_from_slice(&buffer[from..from + 3]);
        }
    }
    let path = dir.join(format!("screen{number}.png"));
    let mut encoder =
        png::Encoder::new(BufWriter::new(File::create(&path).unwrap()), width, height);
    encoder.set_color(png::ColorType::Rgb);
    encoder.set_depth(png::BitDepth::Eight);
    encoder
        .write_header()
        .unwrap()
        .write_image_data(&pixels)
        .unwrap();
    path
}

#[test]
fn the_production_path_reads_a_whole_screen_the_same_way_as_the_fixture_of_it() {
    // 製品の読み取り（画面 → 箱の切り出し → Lanczos で 3 倍 → 日本語の文字認識）が、素材（E-20）と同じ行を返す。
    let dir = tempfile::tempdir().unwrap();
    let worker = OcrWorker::start().expect("日本語の文字認識を使える");
    for number in 1..=6 {
        let from_fixture = worker.read_lines_uncropped(&fixture(number)).unwrap();
        let screen = recovered_screen(number, dir.path());
        let from_screen = worker.read_center_lines(&screen).unwrap();
        eprintln!("迷い{number}: 素材 {from_fixture:?} / 画面 {from_screen:?}");
        assert_eq!(
            squeezed(&from_screen),
            squeezed(&from_fixture),
            "迷い{number}: 画面から読んだ結果が、素材を読んだ結果と違う"
        );
    }
}

#[test]
fn the_production_path_reads_mark_6_of_a_whole_screen_as_east_3_tiles_38_score_4400_in_the_retries()
{
    // 画面（1447×935）から、製品の読み取り（箱の切り出し → 3 倍 → 読み直しの画像も作る）で読んでも、迷い 6 は、読み直しで読める。
    let dir = tempfile::tempdir().unwrap();
    let worker = OcrWorker::start().expect("日本語の文字認識を使える");
    let screen = recovered_screen(6, dir.path());
    let readings = worker.read_center_variants(&screen).unwrap();
    assert_eq!(
        readings.iter().map(|r| r.variant).collect::<Vec<_>>(),
        Variant::ALL.to_vec()
    );
    assert!(!has_round_name(&squeezed(lines_of(
        &readings,
        Variant::Plain
    ))));
    for variant in [Variant::Contrast, Variant::Enlarged] {
        let lines = lines_of(&readings, variant);
        let text = squeezed(lines);
        eprintln!("画面の迷い6 の {}: {lines:?}", variant.name());
        assert!(
            text.contains("東3局") && text.contains("38") && text.contains("4400"),
            "{}: {lines:?}",
            variant.name()
        );
    }
}
