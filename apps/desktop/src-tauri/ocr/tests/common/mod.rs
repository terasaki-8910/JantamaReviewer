//! 試験の共通の部品: FX-6 の画像（画面の中央だけを残した迷いマーク 19 枚）と、目で読んだ正解。
//!
//! FX-6 は、FX-5 の迷い 13 枚（1368×800）と FX-4 の迷い 6 枚（1447×935）の、画面の中央（幅 35〜65%・高さ 25〜60%）だけを残して、
//! ほかを一色で塗りつぶした画像（`tests/fixtures/make_fx6.py` が本物のスクリーンショットから作る。窓の大きさはそのまま。
//! プレイヤー名・アバター・称号・チャットは入らない）。
//! 縦に長い窓の画面は、窓の大きさと板の大きさの関係を確かめるために、この画像を縮めて置いて作る（`scaled_onto_canvas`）。

#![allow(dead_code)]

pub mod browser;

use std::fs::File;
use std::io::BufReader;
use std::path::PathBuf;

use jantama_ocr::resample::resize;

/// FX-6 の 1 枚。
pub struct Fx6 {
    /// `tests/fixtures/` の中のファイル名。
    pub file: &'static str,
    pub width: u32,
    pub height: u32,
    /// 局の風（東・南）と番号（1〜4）。
    pub wind: char,
    pub number: u8,
    /// 残りの牌の数。
    pub tiles_left: u32,
    /// 自分の点数。
    pub score: u32,
}

impl Fx6 {
    pub fn path(&self) -> PathBuf {
        PathBuf::from(env!("CARGO_MANIFEST_DIR"))
            .join("tests")
            .join("fixtures")
            .join(self.file)
    }

    /// 局の名前（例: 東2局）。
    pub fn round_name(&self) -> String {
        format!("{}{}局", self.wind, self.number)
    }
}

const fn fx5(file: &'static str, wind: char, number: u8, tiles_left: u32, score: u32) -> Fx6 {
    Fx6 {
        file,
        width: 1368,
        height: 800,
        wind,
        number,
        tiles_left,
        score,
    }
}

const fn fx4(file: &'static str, wind: char, number: u8, tiles_left: u32, score: u32) -> Fx6 {
    Fx6 {
        file,
        width: 1447,
        height: 935,
        wind,
        number,
        tiles_left,
        score,
    }
}

/// FX-6 の 19 枚と、目で読んだ正解（ACCEPTANCE の FX-6）。FX-5 の 13 枚は押した順、FX-4 の 6 枚は E-16 の 5 枚と 6 枚目。
pub const FX6: [Fx6; 19] = [
    fx5("fx6-fx5-mark01.png", '東', 2, 50, 25000),
    fx5("fx6-fx5-mark02.png", '東', 2, 46, 25000),
    fx5("fx6-fx5-mark03.png", '東', 2, 37, 25000),
    fx5("fx6-fx5-mark04.png", '東', 3, 59, 23700),
    fx5("fx6-fx5-mark05.png", '東', 4, 52, 31700),
    fx5("fx6-fx5-mark06.png", '東', 4, 49, 31700),
    fx5("fx6-fx5-mark07.png", '東', 4, 39, 31700),
    fx5("fx6-fx5-mark08.png", '南', 1, 60, 33700),
    fx5("fx6-fx5-mark09.png", '南', 1, 34, 33700),
    fx5("fx6-fx5-mark10.png", '南', 2, 46, 32500),
    fx5("fx6-fx5-mark11.png", '南', 2, 32, 32500),
    fx5("fx6-fx5-mark12.png", '南', 3, 53, 20500),
    fx5("fx6-fx5-mark13.png", '南', 4, 49, 28500),
    fx4("fx6-fx4-mark1.png", '東', 1, 59, 25000),
    fx4("fx6-fx4-mark2.png", '東', 2, 23, 19000),
    fx4("fx6-fx4-mark3.png", '東', 2, 47, 15100),
    fx4("fx6-fx4-mark4.png", '東', 2, 35, 15100),
    fx4("fx6-fx4-mark5.png", '東', 3, 46, 4400),
    fx4("fx6-fx4-mark6.png", '東', 3, 38, 4400),
];

/// 画像の画素（行を詰めた BGRA）と大きさ。
pub struct Bgra {
    pub pixels: Vec<u8>,
    pub width: u32,
    pub height: u32,
}

/// PNG（RGB か RGBA の 8 ビット）を、BGRA の並びで読む。
pub fn load_png_bgra(path: &std::path::Path) -> Bgra {
    let decoder = png::Decoder::new(BufReader::new(File::open(path).unwrap()));
    let mut reader = decoder.read_info().unwrap();
    let mut buffer = vec![0u8; reader.output_buffer_size().unwrap()];
    let info = reader.next_frame(&mut buffer).unwrap();
    assert_eq!(info.bit_depth, png::BitDepth::Eight);
    let channels = match info.color_type {
        png::ColorType::Rgb => 3,
        png::ColorType::Rgba => 4,
        other => panic!("想定外の色の形式: {other:?}"),
    };
    let mut pixels = Vec::with_capacity((info.width * info.height * 4) as usize);
    for chunk in buffer[..(info.width * info.height) as usize * channels].chunks_exact(channels) {
        pixels.extend_from_slice(&[chunk[2], chunk[1], chunk[0], 255]);
    }
    Bgra {
        pixels,
        width: info.width,
        height: info.height,
    }
}

/// 一色（B, G, R）で塗った BGRA の画面。
pub fn flat(width: u32, height: u32, bgr: [u8; 3]) -> Bgra {
    let mut pixels = Vec::with_capacity((width * height * 4) as usize);
    for _ in 0..width * height {
        pixels.extend_from_slice(&[bgr[0], bgr[1], bgr[2], 255]);
    }
    Bgra {
        pixels,
        width,
        height,
    }
}

/// 長方形（左上と大きさ）を、一色（B, G, R）で塗る。画面の外は塗らない。
pub fn fill_rect(screen: &mut Bgra, x: u32, y: u32, w: u32, h: u32, bgr: [u8; 3]) {
    for yy in y..(y + h).min(screen.height) {
        for xx in x..(x + w).min(screen.width) {
            let i = ((yy * screen.width + xx) * 4) as usize;
            screen.pixels[i..i + 3].copy_from_slice(&bgr);
        }
    }
}

/// `source`（FX-6 の画面）を `factor`（千分率）倍に Lanczos で拡大・縮小して、`canvas_width`×`canvas_height` の画面の
/// 真ん中に置く。まわりは `fill`（B, G, R）の一色。画面からはみ出す所は切り捨てる。
/// 返す 2 つ目は、置いたあとの、元の画像の左上の位置（x, y。負にもなる）。
pub fn scaled_onto_canvas(
    source: &Bgra,
    factor_permille: u32,
    canvas_width: u32,
    canvas_height: u32,
    fill: [u8; 3],
) -> (Bgra, (i64, i64)) {
    let sw = (u64::from(source.width) * u64::from(factor_permille) / 1000).max(1) as u32;
    let sh = (u64::from(source.height) * u64::from(factor_permille) / 1000).max(1) as u32;
    let scaled = resize(&source.pixels, source.width, source.height, sw, sh);
    let mut canvas = flat(canvas_width, canvas_height, fill);
    let ox = (i64::from(canvas_width) - i64::from(sw)) / 2;
    let oy = (i64::from(canvas_height) - i64::from(sh)) / 2;
    for y in 0..sh {
        let cy = i64::from(y) + oy;
        if cy < 0 || cy >= i64::from(canvas_height) {
            continue;
        }
        for x in 0..sw {
            let cx = i64::from(x) + ox;
            if cx < 0 || cx >= i64::from(canvas_width) {
                continue;
            }
            let from = ((y * sw + x) * 4) as usize;
            let to = ((cy as u32 * canvas_width + cx as u32) * 4) as usize;
            canvas.pixels[to..to + 4].copy_from_slice(&scaled[from..from + 4]);
        }
    }
    (canvas, (ox, oy))
}

/// 文字認識の行から、局・残り枚数・自分の点数を取り出す（エンジン `parseCenterText`（E-16）と同じ規則の、試験用の写し。
/// 読み取りの成否を数えるためだけに使う。規則の本体はエンジンにあり、写しの行での確かめは `fx6-center-text.test.ts`）。
/// 返すのは (風, 番号, 残りの牌の数, 点数)。読めなければ `None`。
pub fn strict_parse(lines: &[String]) -> Option<(char, u8, u32, u32)> {
    // 空白（全角を含む）を除き、全角の数字を半角にする。
    let cleaned: Vec<Vec<char>> = lines
        .iter()
        .map(|line| {
            line.chars()
                .filter(|c| !c.is_whitespace())
                .map(|c| match c {
                    '０'..='９' => {
                        char::from_u32(u32::from(c) - u32::from('０') + u32::from('0')).unwrap()
                    }
                    other => other,
                })
                .collect()
        })
        .collect();
    // 局: 空白を除いた行に (東|南|西)([1-4])局 がある最初の行。
    let (kyoku_line, kyoku_at) = cleaned.iter().enumerate().find_map(|(i, line)| {
        line.windows(3)
            .position(|w| {
                matches!(w[0], '東' | '南' | '西') && matches!(w[1], '1'..='4') && w[2] == '局'
            })
            .map(|at| (i, at))
    })?;
    let wind = cleaned[kyoku_line][kyoku_at];
    let number = cleaned[kyoku_line][kyoku_at + 1].to_digit(10)? as u8;
    // 点数: 局の行より後ろの、数字だけの 3〜6 桁（先頭は 0 でない）の行のうち、いちばん下のもの。100 点単位でなければ読めない。
    let score_line = (kyoku_line + 1..cleaned.len()).rev().find(|&i| {
        let line = &cleaned[i];
        (3..=6).contains(&line.len()) && line[0] != '0' && line.iter().all(char::is_ascii_digit)
    })?;
    let score: u32 = cleaned[score_line]
        .iter()
        .collect::<String>()
        .parse()
        .ok()?;
    if !score.is_multiple_of(100) {
        return None;
    }
    // 残りの牌の数: 局の行の残りと、局と点数の間の行のうち、行の終わりが「数字でない字 + 1〜2 桁」のもの（いちばん下から）。0〜70。
    let rest: Vec<char> = cleaned[kyoku_line][kyoku_at + 3..].to_vec();
    let mut candidates = vec![rest];
    candidates.extend(cleaned[kyoku_line + 1..score_line].iter().cloned());
    for line in candidates.iter().rev() {
        let digits = line.iter().rev().take_while(|c| c.is_ascii_digit()).count();
        if (1..=2).contains(&digits) && digits < line.len() {
            let value: u32 = line[line.len() - digits..]
                .iter()
                .collect::<String>()
                .parse()
                .ok()?;
            if value <= 70 {
                return Some((wind, number, value, score));
            }
        }
    }
    None
}
