//! 切り出して 3 倍にする拡大（Lanczos）と、読み直し用の画像（コントラストを上げたもの・1.5 倍に広げたもの）の計算。
//! 画素の計算だけで、画像のファイルにも OS にも触れない。
//!
//! 文字認識は、拡大のしかたで読める・読めないが大きく変わる（局の名前の「東」が「京」に、残り枚数が丸ごと崩れる、など。
//! WinRT の補間 3 種で実測した）。試験の素材（`tests/fixtures/mark<N>-center.png`）は、Pillow の
//! `Image.crop(...).resize(..., Image.LANCZOS)` で作り、実際の画面で読めることを確かめてある。
//! 製品が文字認識にかける画像も同じ画素にするため、Pillow の拡大と同じ計算（フィルターの係数・端の扱い・固定小数点の丸め）を
//! ここで行う。同じ画素になることは、Pillow の出力を写した試験 `matches_pillow_lanczos_exactly` が確かめる。
//!
//! 1 回目の読み取りで読めない画像（迷い 6 は、3 倍の画像では「局」の前の字が崩れた）は、同じ画像を 2 通りに変えて読み直す（E-20）。
//! - `enhance_contrast`: コントラストを 1.8 倍にする（Pillow の `ImageEnhance.Contrast(image).enhance(1.8)`）
//! - `resize`: 1.5 倍に広げる（Pillow の `image.resize((int(w * 1.5), int(h * 1.5)), Image.LANCZOS)`）
//!
//! どちらも、迷い 6 の画像で、Pillow の出力と画素が同じになることを確かめた（小さな見本は、`tests/fixtures/variant-*.png`）。

use crate::geometry::{enlarged_size, CropRect, Variant, CONTRAST_FACTOR};

/// 画素 1 つあたりのチャンネル数（BGRA）。
const CHANNELS: usize = 4;
/// 係数を整数にするときの小数部のビット数（Pillow の PRECISION_BITS = 32 - 8 - 2）。
const PRECISION_BITS: u32 = 22;
/// Lanczos の窓の半径。
const LANCZOS_SUPPORT: f64 = 3.0;

fn sinc(x: f64) -> f64 {
    if x == 0.0 {
        return 1.0;
    }
    let x = x * std::f64::consts::PI;
    x.sin() / x
}

fn lanczos(x: f64) -> f64 {
    if (-LANCZOS_SUPPORT..LANCZOS_SUPPORT).contains(&x) {
        sinc(x) * sinc(x / LANCZOS_SUPPORT)
    } else {
        0.0
    }
}

/// 1 方向（横か縦）の拡大の係数。出力の画素ごとに、読む入力の範囲と、整数にした重み。
struct Axis {
    /// 出力の画素ごとの（読み始める入力の位置, 読む数）。
    bounds: Vec<(usize, usize)>,
    /// 1 画素あたりの重みの最大数。
    ksize: usize,
    weights: Vec<i32>,
}

impl Axis {
    fn new(in_size: usize, out_size: usize) -> Axis {
        let scale = in_size as f64 / out_size as f64;
        let filterscale = scale.max(1.0);
        let support = LANCZOS_SUPPORT * filterscale;
        let ksize = support.ceil() as usize * 2 + 1;
        let mut precise = vec![0.0f64; out_size * ksize];
        let mut bounds = Vec::with_capacity(out_size);
        for out in 0..out_size {
            let center = (out as f64 + 0.5) * scale;
            let inv = 1.0 / filterscale;
            // C の (int) と同じく、0 に向かって切り捨てる。
            let min = ((center - support + 0.5) as i64).max(0);
            let max = ((center + support + 0.5) as i64).min(in_size as i64);
            let count = (max - min).max(0) as usize;
            let row = &mut precise[out * ksize..(out + 1) * ksize];
            let mut total = 0.0;
            for (offset, slot) in row.iter_mut().take(count).enumerate() {
                let w = lanczos(((offset as i64 + min) as f64 - center + 0.5) * inv);
                *slot = w;
                total += w;
            }
            if total != 0.0 {
                for slot in row.iter_mut().take(count) {
                    *slot /= total;
                }
            }
            bounds.push((min as usize, count));
        }
        let one = f64::from(1u32 << PRECISION_BITS);
        let weights = precise
            .iter()
            .map(|&w| {
                if w < 0.0 {
                    (-0.5 + w * one) as i32
                } else {
                    (0.5 + w * one) as i32
                }
            })
            .collect();
        Axis {
            bounds,
            ksize,
            weights,
        }
    }
}

/// 固定小数点の和を 8 ビットに丸める（0〜255 に収める）。
fn clip8(sum: i64) -> u8 {
    (sum >> PRECISION_BITS).clamp(0, 255) as u8
}

/// 4 チャンネル 8 ビットの画像（`width`×`height`、行は詰めて並ぶ）の `crop` の部分を、`factor` 倍に拡大した画像を返す。
/// 切り出した外の画素は、拡大の計算に使わない。返す画像の大きさは (crop.width·factor)×(crop.height·factor)。
pub fn crop_and_upscale(
    src: &[u8],
    width: u32,
    height: u32,
    crop: CropRect,
    factor: u32,
) -> Vec<u8> {
    let (width, height) = (width as usize, height as usize);
    assert_eq!(
        src.len(),
        width * height * CHANNELS,
        "画素の数が大きさと合わない"
    );
    assert!(
        crop.x + crop.width <= width as u32 && crop.y + crop.height <= height as u32,
        "切り出しが画像の外にはみ出す"
    );
    let (cx, cy) = (crop.x as usize, crop.y as usize);
    let (cw, ch) = (crop.width as usize, crop.height as usize);

    // 切り出した画像を取り出す。
    let mut cropped = vec![0u8; cw * ch * CHANNELS];
    for y in 0..ch {
        let from = ((cy + y) * width + cx) * CHANNELS;
        cropped[y * cw * CHANNELS..(y + 1) * cw * CHANNELS]
            .copy_from_slice(&src[from..from + cw * CHANNELS]);
    }
    resize(
        &cropped,
        crop.width,
        crop.height,
        crop.width * factor,
        crop.height * factor,
    )
}

/// 4 チャンネル 8 ビットの画像（`width`×`height`）を、`out_width`×`out_height` に Lanczos で拡大・縮小した画像を返す
/// （Pillow の `resize(..., Image.LANCZOS)` と同じ計算。先に横、次に縦。間は 8 ビットに丸める）。
/// 横（縦）の大きさが変わらないときは、その向きは計算しない（Pillow と同じ）。
pub fn resize(src: &[u8], width: u32, height: u32, out_width: u32, out_height: u32) -> Vec<u8> {
    let (width, height) = (width as usize, height as usize);
    assert_eq!(
        src.len(),
        width * height * CHANNELS,
        "画素の数が大きさと合わない"
    );
    let (ow, oh) = (out_width as usize, out_height as usize);
    assert!(ow > 0 && oh > 0, "広げたあとの大きさが 0");

    // 先に横。
    let wide = if ow == width {
        src.to_vec()
    } else {
        let horizontal = Axis::new(width, ow);
        let mut wide = vec![0u8; ow * height * CHANNELS];
        for y in 0..height {
            for x in 0..ow {
                let (min, count) = horizontal.bounds[x];
                let weights = &horizontal.weights[x * horizontal.ksize..];
                for c in 0..CHANNELS {
                    let mut sum = 1i64 << (PRECISION_BITS - 1);
                    for (i, w) in weights.iter().take(count).enumerate() {
                        sum += i64::from(src[(y * width + min + i) * CHANNELS + c]) * i64::from(*w);
                    }
                    wide[(y * ow + x) * CHANNELS + c] = clip8(sum);
                }
            }
        }
        wide
    };
    if oh == height {
        return wide;
    }

    // 次に縦。
    let vertical = Axis::new(height, oh);
    let mut out = vec![0u8; ow * oh * CHANNELS];
    for y in 0..oh {
        let (min, count) = vertical.bounds[y];
        let weights = &vertical.weights[y * vertical.ksize..];
        for x in 0..ow * CHANNELS {
            let mut sum = 1i64 << (PRECISION_BITS - 1);
            for (i, w) in weights.iter().take(count).enumerate() {
                sum += i64::from(wide[(min + i) * ow * CHANNELS + x]) * i64::from(*w);
            }
            out[y * ow * CHANNELS + x] = clip8(sum);
        }
    }
    out
}

/// 3 倍にした画像（B, G, R, A の並び。`width`×`height`）から、`variant` の画像を作る。戻り値は (画素, 幅, 高さ)。
/// `Plain` はそのまま、`Contrast` は同じ大きさでコントラストを上げたもの、`Enlarged` は 1.5 倍に広げたもの（コントラストはそのまま）。
pub fn variant_pixels(
    variant: Variant,
    base: &[u8],
    width: u32,
    height: u32,
) -> (Vec<u8>, u32, u32) {
    match variant {
        Variant::Plain => (base.to_vec(), width, height),
        Variant::Contrast => (enhance_contrast(base, CONTRAST_FACTOR), width, height),
        Variant::Enlarged => {
            let (out_width, out_height) = enlarged_size(width, height);
            (
                resize(base, width, height, out_width, out_height),
                out_width,
                out_height,
            )
        }
    }
}

/// グレーにした値（Pillow の `convert("L")`。R·19595 + G·38470 + B·7471 を 16 ビットの固定小数点で丸める）。
fn luma(b: u8, g: u8, r: u8) -> u32 {
    (u32::from(r) * 19595 + u32::from(g) * 38470 + u32::from(b) * 7471 + 0x8000) >> 16
}

/// 4 チャンネル 8 ビット（B, G, R, A の並び）の画像のコントラストを `factor` 倍にした画像を返す
/// （Pillow の `ImageEnhance.Contrast(image).enhance(factor)` と同じ計算）。
/// 画像全体の明るさの平均 `m`（グレーにした値の平均に 0.5 を足して整数にしたもの）を中心に、各色を `m + factor·(値 - m)` に広げて、
/// 0〜255 に収める（小数は切り捨て）。透明度（A）は変えない。
pub fn enhance_contrast(src: &[u8], factor: f32) -> Vec<u8> {
    assert_eq!(src.len() % CHANNELS, 0, "画素の数が合わない");
    let pixels = src.len() / CHANNELS;
    if pixels == 0 {
        return Vec::new();
    }
    let total: u64 = src
        .chunks_exact(CHANNELS)
        .map(|p| u64::from(luma(p[0], p[1], p[2])))
        .sum();
    let mean = (total as f64 / pixels as f64 + 0.5) as u32;
    let center = mean as f32;
    let spread = |value: u8| -> u8 {
        let widened = center + factor * (f32::from(value) - center);
        if widened <= 0.0 {
            0
        } else if widened >= 255.0 {
            255
        } else {
            widened as u8
        }
    };
    let mut out = Vec::with_capacity(src.len());
    for p in src.chunks_exact(CHANNELS) {
        out.extend_from_slice(&[spread(p[0]), spread(p[1]), spread(p[2]), p[3]]);
    }
    out
}

#[cfg(test)]
mod tests {
    use std::fs::File;
    use std::path::PathBuf;

    use super::*;

    fn fixture(name: &str) -> PathBuf {
        PathBuf::from(env!("CARGO_MANIFEST_DIR"))
            .join("tests")
            .join("fixtures")
            .join(name)
    }

    /// RGB の PNG を読んで、BGRA の並び（A は 255）にする。
    fn read_bgra(name: &str) -> (u32, u32, Vec<u8>) {
        let decoder =
            png::Decoder::new(std::io::BufReader::new(File::open(fixture(name)).unwrap()));
        let mut reader = decoder.read_info().unwrap();
        let mut buffer = vec![0u8; reader.output_buffer_size().unwrap()];
        let info = reader.next_frame(&mut buffer).unwrap();
        assert_eq!(info.color_type, png::ColorType::Rgb, "{name}");
        assert_eq!(info.bit_depth, png::BitDepth::Eight, "{name}");
        let mut bgra = Vec::with_capacity((info.width * info.height * 4) as usize);
        for rgb in buffer[..info.buffer_size()].chunks_exact(3) {
            bgra.extend_from_slice(&[rgb[2], rgb[1], rgb[0], 255]);
        }
        (info.width, info.height, bgra)
    }

    #[test]
    fn matches_pillow_lanczos_exactly() {
        // tests/fixtures/resample-source.png（40×30 の乱数の画素）の (5, 4)–(33, 26) を切り出して 3 倍にしたものを、
        // Pillow の `Image.crop(box).resize((84, 66), Image.LANCZOS)` で作ったのが resample-expected.png。
        let (sw, sh, source) = read_bgra("resample-source.png");
        let (ew, eh, expected) = read_bgra("resample-expected.png");
        assert_eq!((sw, sh), (40, 30));
        assert_eq!((ew, eh), (84, 66));
        let crop = CropRect {
            x: 5,
            y: 4,
            width: 28,
            height: 22,
        };
        let actual = crop_and_upscale(&source, sw, sh, crop, 3);
        assert_eq!(actual.len(), expected.len());
        let different: Vec<usize> = (0..expected.len())
            .filter(|&i| actual[i] != expected[i])
            .collect();
        assert!(
            different.is_empty(),
            "Pillow と違う画素が {} 個ある（最初の 5 個: {:?}）",
            different.len(),
            different
                .iter()
                .take(5)
                .map(|&i| (i / 4 % 84, i / 4 / 84, i % 4, actual[i], expected[i]))
                .collect::<Vec<_>>()
        );
    }

    #[test]
    fn contrast_matches_pillow_exactly() {
        // variant-source.png（61×28）に Pillow の `ImageEnhance.Contrast(...).enhance(1.8)` をかけたものが、variant-contrast-expected.png。
        let (w, h, source) = read_bgra("variant-source.png");
        let (ew, eh, expected) = read_bgra("variant-contrast-expected.png");
        assert_eq!((w, h), (61, 28));
        assert_eq!((ew, eh), (61, 28));
        let actual = enhance_contrast(&source, 1.8);
        let different: Vec<usize> = (0..expected.len())
            .filter(|&i| actual[i] != expected[i])
            .collect();
        assert!(
            different.is_empty(),
            "Pillow と違う画素が {} 個ある（最初の 5 個: {:?}）",
            different.len(),
            different
                .iter()
                .take(5)
                .map(|&i| (i / 4 % 61, i / 4 / 61, i % 4, actual[i], expected[i]))
                .collect::<Vec<_>>()
        );
    }

    #[test]
    fn one_and_a_half_times_matches_pillow_exactly_and_cuts_the_size_down() {
        // variant-source.png（61×28）を、Pillow の `resize((int(61 * 1.5), int(28 * 1.5)), Image.LANCZOS)`（91×42）で広げたものが、
        // variant-enlarged-expected.png。小数は切り捨て（61 × 1.5 = 91.5 → 91）。
        let (w, h, source) = read_bgra("variant-source.png");
        let (ew, eh, expected) = read_bgra("variant-enlarged-expected.png");
        assert_eq!((ew, eh), (91, 42));
        let actual = resize(&source, w, h, w * 3 / 2, h * 3 / 2);
        assert_eq!(actual.len(), expected.len());
        let different: Vec<usize> = (0..expected.len())
            .filter(|&i| actual[i] != expected[i])
            .collect();
        assert!(
            different.is_empty(),
            "Pillow と違う画素が {} 個ある（最初の 5 個: {:?}）",
            different.len(),
            different
                .iter()
                .take(5)
                .map(|&i| (i / 4 % 91, i / 4 / 91, i % 4, actual[i], expected[i]))
                .collect::<Vec<_>>()
        );
    }

    #[test]
    fn contrast_widens_around_the_mean_clips_and_keeps_alpha() {
        // 半分が 100、半分が 140 の画像（グレー）: 平均は 120。1.8 倍で 120 + 1.8 × (-20) = 84、120 + 1.8 × 20 = 156。
        let mut src = Vec::new();
        for i in 0..8 {
            let v = if i % 2 == 0 { 100u8 } else { 140 };
            src.extend_from_slice(&[v, v, v, 200]);
        }
        let out = enhance_contrast(&src, 1.8);
        for (i, p) in out.chunks_exact(4).enumerate() {
            let expected = if i % 2 == 0 { 84u8 } else { 156 };
            assert_eq!(p, [expected, expected, expected, 200], "画素 {i}");
        }
        // 0 と 255 を超える分は収める。平均 128 の、0 と 255 の画像は、変わらない。
        let extremes: Vec<u8> = [0u8, 255, 0, 255]
            .iter()
            .flat_map(|&v| [v, v, v, 255])
            .collect();
        assert_eq!(enhance_contrast(&extremes, 1.8), extremes);
        // 全部が同じ灰色なら、変わらない（平均がその灰色）。色のある画像は、平均の灰色から、色ごとに離れる（Pillow と同じ）。
        let flat: Vec<u8> = (0..16).flat_map(|_| [90u8, 90, 90, 255]).collect();
        assert_eq!(enhance_contrast(&flat, 1.8), flat);
        let colored: Vec<u8> = (0..16).flat_map(|_| [30u8, 90, 200, 255]).collect();
        assert_eq!(&enhance_contrast(&colored, 1.8)[..4], [0, 69, 255, 255]);
        assert!(enhance_contrast(&[], 1.8).is_empty());
    }

    #[test]
    fn each_variant_has_its_own_size_and_plain_is_the_picture_itself() {
        let (w, h, source) = read_bgra("variant-source.png");
        let (plain, pw, ph) = variant_pixels(Variant::Plain, &source, w, h);
        assert_eq!((pw, ph), (61, 28));
        assert_eq!(plain, source);
        let (contrast, cw, ch) = variant_pixels(Variant::Contrast, &source, w, h);
        assert_eq!((cw, ch), (61, 28));
        assert_eq!(contrast, enhance_contrast(&source, 1.8));
        assert_ne!(contrast, source);
        let (enlarged, ew, eh) = variant_pixels(Variant::Enlarged, &source, w, h);
        assert_eq!((ew, eh), (91, 42));
        assert_eq!(enlarged.len(), 91 * 42 * 4);
        // コントラストは、広げた画像には、かけない。
        assert_eq!(enlarged, resize(&source, w, h, 91, 42));
    }

    #[test]
    fn resizing_to_the_same_size_is_a_copy_and_a_zero_size_is_refused() {
        let (w, h, source) = read_bgra("variant-source.png");
        assert_eq!(resize(&source, w, h, w, h), source);
        let result = std::panic::catch_unwind(|| resize(&[0, 0, 0, 255], 1, 1, 0, 1));
        assert!(result.is_err());
    }

    #[test]
    fn a_flat_picture_stays_flat_and_the_size_is_scaled() {
        let (w, h) = (50u32, 40u32);
        let src: Vec<u8> = (0..w * h).flat_map(|_| [10u8, 120, 240, 255]).collect();
        let crop = CropRect {
            x: 3,
            y: 2,
            width: 20,
            height: 11,
        };
        let out = crop_and_upscale(&src, w, h, crop, 3);
        assert_eq!(out.len(), 60 * 33 * 4);
        assert!(out.chunks_exact(4).all(|p| p == [10, 120, 240, 255]));
    }

    #[test]
    fn pixels_outside_the_crop_never_leak_in() {
        // 外は白、切り出しの中は黒。切り出しの外の画素を 1 つでも使うと、白が混ざる。
        let (w, h) = (60u32, 50u32);
        let crop = CropRect {
            x: 10,
            y: 8,
            width: 25,
            height: 17,
        };
        let src: Vec<u8> = (0..w * h)
            .flat_map(|i| {
                let (x, y) = (i % w, i / w);
                let inside = x >= crop.x
                    && x < crop.x + crop.width
                    && y >= crop.y
                    && y < crop.y + crop.height;
                if inside {
                    [0u8, 0, 0, 255]
                } else {
                    [255u8, 255, 255, 255]
                }
            })
            .collect();
        let out = crop_and_upscale(&src, w, h, crop, 3);
        assert!(out.chunks_exact(4).all(|p| p == [0, 0, 0, 255]));
    }

    #[test]
    fn a_marker_on_each_edge_of_the_box_stays_on_that_edge() {
        // 切り出しの中の、左端の列は緑、右端の列は青、上端の行は赤、下端の行は黄。1 画素でも箱がずれると、端の色が変わる。
        let (w, h) = (80u32, 60u32);
        let crop = CropRect {
            x: 20,
            y: 12,
            width: 30,
            height: 24,
        };
        let src: Vec<u8> = (0..w * h)
            .flat_map(|i| {
                let (x, y) = (i % w, i / w);
                if x < crop.x || x >= crop.x + crop.width || y < crop.y || y >= crop.y + crop.height
                {
                    return [0u8, 0, 0, 255];
                }
                let (dx, dy) = (x - crop.x, y - crop.y);
                // B, G, R, A の順。
                if dx == 0 {
                    [0, 255, 0, 255]
                } else if dx == crop.width - 1 {
                    [255, 0, 0, 255]
                } else if dy == 0 {
                    [0, 0, 255, 255]
                } else if dy == crop.height - 1 {
                    [0, 255, 255, 255]
                } else {
                    [255, 255, 255, 255]
                }
            })
            .collect();
        let out = crop_and_upscale(&src, w, h, crop, 3);
        let (ow, oh) = (90usize, 72usize);
        let px = |x: usize, y: usize| {
            let i = (y * ow + x) * 4;
            (out[i], out[i + 1], out[i + 2])
        };
        let (b, g, r) = px(0, oh / 2);
        assert!(
            g > 200 && b < 100 && r < 100,
            "左端は緑: {:?}",
            px(0, oh / 2)
        );
        let (b, g, r) = px(ow - 1, oh / 2);
        assert!(
            b > 200 && g < 100 && r < 100,
            "右端は青: {:?}",
            px(ow - 1, oh / 2)
        );
        let (b, g, r) = px(ow / 2, 0);
        assert!(
            r > 200 && b < 100 && g < 100,
            "上端は赤: {:?}",
            px(ow / 2, 0)
        );
        let (b, g, r) = px(ow / 2, oh - 1);
        assert!(
            g > 200 && r > 200 && b < 100,
            "下端は黄: {:?}",
            px(ow / 2, oh - 1)
        );
    }
}
