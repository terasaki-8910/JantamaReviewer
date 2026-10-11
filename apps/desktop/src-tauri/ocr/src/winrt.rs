//! WinRT での画像の読み取り・切り出し・拡大・日本語の文字認識（Windows 専用）。
//!
//! 待ちのある呼び出し（`join`）は、すべて `OcrWorker` の専用のスレッドの中で行う。画面（UI）のスレッドや、
//! 窓のメッセージを処理するスレッドで待つと、画面が止まるため。
//! 文字認識の部品（`OcrEngine`）は、その専用のスレッドで 1 回だけ作って使い回す。
//!
//! 1 枚の画像は、1 回目の画像（`Variant::Plain`）に加えて、読み直し用の画像（`Contrast`・`Enlarged`。E-20）でも読める
//! （`read_center_variants`）。どの読み取りを使うかは、結果の文字から局・残り枚数・点数を取り出す側（エンジン）が決める。

use std::path::{Path, PathBuf};
use std::sync::mpsc::{self, Receiver, Sender};
use std::thread::{self, JoinHandle};

use windows::core::HSTRING;
use windows::Globalization::Language;
use windows::Graphics::Imaging::{
    BitmapAlphaMode, BitmapDecoder, BitmapPixelFormat, BitmapTransform, ColorManagementMode,
    ExifOrientationMode, SoftwareBitmap,
};
use windows::Media::Ocr::OcrEngine;
use windows::Storage::Streams::{Buffer, DataReader, DataWriter};
use windows::Storage::{FileAccessMode, StorageFile};

use crate::error::OcrError;
use crate::geometry::{center_crop, Variant, UPSCALE};
use crate::resample::{crop_and_upscale, variant_pixels};

/// 文字認識にかける言語（日本語）。
const LANGUAGE_TAG: &str = "ja";

/// 画像をどう切り出して文字認識にかけるか。
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
enum Region {
    /// 中央の板を切り出して、`UPSCALE` 倍にする。
    Center,
    /// 切り出さず、画像そのまま（試験の切り出し済みの画像・全体を読みたいとき）。
    Whole,
}

/// 1 通りの画像を文字認識で読んだ結果。
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct Reading {
    /// どの画像で読んだか。
    pub variant: Variant,
    /// 認識した行（上から順）。
    pub lines: Vec<String>,
}

enum Request {
    Read {
        path: PathBuf,
        region: Region,
        /// true なら、読み直し用の画像（コントラストを上げたもの・1.5 倍に広げたもの）でも読む。
        variants: bool,
        reply: Sender<Result<Vec<Reading>, OcrError>>,
    },
}

/// 日本語の文字認識を専用のスレッドで動かす担当。何枚でも続けて読める（部品は 1 回だけ作る）。
/// 落とすと、スレッドを止めて待つ。
pub struct OcrWorker {
    tx: Option<Sender<Request>>,
    thread: Option<JoinHandle<()>>,
}

impl OcrWorker {
    /// 担当を起こして、日本語の文字認識の部品が作れるまで待つ。作れなければ理由を返す。
    /// 呼ぶスレッドは待つので、画面のスレッドからは呼ばない。
    pub fn start() -> Result<OcrWorker, OcrError> {
        let (tx, rx) = mpsc::channel::<Request>();
        let (ready_tx, ready_rx) = mpsc::channel::<Result<(), OcrError>>();
        let thread = thread::Builder::new()
            .name("ocr-worker".to_string())
            .spawn(move || worker_main(rx, ready_tx))
            .map_err(|e| OcrError::Worker(e.to_string()))?;
        match ready_rx.recv() {
            Ok(Ok(())) => Ok(OcrWorker {
                tx: Some(tx),
                thread: Some(thread),
            }),
            Ok(Err(e)) => {
                let _ = thread.join();
                Err(e)
            }
            Err(_) => {
                let _ = thread.join();
                Err(OcrError::Worker("起動の知らせが届きませんでした".into()))
            }
        }
    }

    /// 迷いマーク・評価の画面（雀魂の窓のスクリーンショット）の中央の板を読んで、行ごとの文字を返す（1 回目の画像だけ）。
    pub fn read_center_lines(&self, png: &Path) -> Result<Vec<String>, OcrError> {
        Ok(first_lines(self.request(png, Region::Center, false)?))
    }

    /// 切り出さずに、画像そのままを読む。切り出し・拡大が済んだ画像（試験の素材）を読むためのもの。
    pub fn read_lines_uncropped(&self, png: &Path) -> Result<Vec<String>, OcrError> {
        Ok(first_lines(self.request(png, Region::Whole, false)?))
    }

    /// 中央の板を、1 回目の画像（3 倍）と、読み直し用の画像（コントラストを上げたもの・1.5 倍に広げたもの）で読む（E-20）。
    /// 先頭は必ず 1 回目（`Variant::Plain`。これが読めなければ失敗）。読み直しの画像が文字認識の上限より大きくなるときなどは、
    /// その画像だけを飛ばす（返す結果に入れない）。
    pub fn read_center_variants(&self, png: &Path) -> Result<Vec<Reading>, OcrError> {
        self.request(png, Region::Center, true)
    }

    /// 切り出さずに、画像そのままを 1 回目の画像として、読み直し用の画像も作って読む（試験の素材用）。
    pub fn read_variants_uncropped(&self, png: &Path) -> Result<Vec<Reading>, OcrError> {
        self.request(png, Region::Whole, true)
    }

    fn request(
        &self,
        png: &Path,
        region: Region,
        variants: bool,
    ) -> Result<Vec<Reading>, OcrError> {
        let (reply, answer) = mpsc::channel();
        let tx = self
            .tx
            .as_ref()
            .ok_or_else(|| OcrError::Worker("担当は止まっています".into()))?;
        tx.send(Request::Read {
            path: png.to_path_buf(),
            region,
            variants,
            reply,
        })
        .map_err(|_| OcrError::Worker("担当は止まっています".into()))?;
        answer
            .recv()
            .map_err(|_| OcrError::Worker("答えが届きませんでした".into()))?
    }
}

/// 読み取りの先頭（1 回目の画像）の行。
fn first_lines(readings: Vec<Reading>) -> Vec<String> {
    readings
        .into_iter()
        .next()
        .map(|reading| reading.lines)
        .unwrap_or_default()
}

impl Drop for OcrWorker {
    fn drop(&mut self) {
        // 送り口を閉じると、担当のスレッドの受け取りが終わって、スレッドが抜ける。
        self.tx.take();
        if let Some(thread) = self.thread.take() {
            let _ = thread.join();
        }
    }
}

/// 1 枚だけ読む。担当を起こして読み、止める（続けて何枚も読むときは `OcrWorker` を使う）。
/// 待つので、画面のスレッドからは呼ばない。
pub fn read_center_lines(png: &Path) -> Result<Vec<String>, OcrError> {
    OcrWorker::start()?.read_center_lines(png)
}

/// 切り出さずに、画像そのままを 1 枚読む。
pub fn read_lines_uncropped(png: &Path) -> Result<Vec<String>, OcrError> {
    OcrWorker::start()?.read_lines_uncropped(png)
}

fn worker_main(rx: Receiver<Request>, ready: Sender<Result<(), OcrError>>) {
    let engine = match create_engine() {
        Ok(engine) => {
            let _ = ready.send(Ok(()));
            engine
        }
        Err(e) => {
            let _ = ready.send(Err(e));
            return;
        }
    };
    while let Ok(request) = rx.recv() {
        match request {
            Request::Read {
                path,
                region,
                variants,
                reply,
            } => {
                let _ = reply.send(read_one(&engine, &path, region, variants));
            }
        }
    }
}

fn create_engine() -> Result<OcrEngine, OcrError> {
    let language = Language::CreateLanguage(&HSTRING::from(LANGUAGE_TAG))
        .map_err(|e| OcrError::Recognize(format!("言語を作れません: {e}")))?;
    if !OcrEngine::IsLanguageSupported(&language).unwrap_or(false) {
        return Err(OcrError::JapaneseEngineMissing);
    }
    OcrEngine::TryCreateFromLanguage(&language).map_err(|_| OcrError::JapaneseEngineMissing)
}

/// 画像を読む。`variants` が true なら、1 回目の画像のあとに、読み直し用の画像（`Variant::ALL` の順）も読む。
/// 1 回目の失敗は、そのまま返す。読み直しの画像の失敗（上限を超える大きさなど）は、その画像だけ飛ばす。
fn read_one(
    engine: &OcrEngine,
    path: &Path,
    region: Region,
    variants: bool,
) -> Result<Vec<Reading>, OcrError> {
    let base = decode_base(path, region)?;
    let plain = bitmap_of(path, &base.pixels, base.width, base.height)?;
    let mut readings = vec![Reading {
        variant: Variant::Plain,
        lines: recognize(engine, &plain)?,
    }];
    if variants {
        for variant in Variant::ALL.into_iter().filter(|v| *v != Variant::Plain) {
            let (pixels, width, height) =
                variant_pixels(variant, &base.pixels, base.width, base.height);
            let read = bitmap_of(path, &pixels, width, height)
                .and_then(|bitmap| recognize(engine, &bitmap));
            if let Ok(lines) = read {
                readings.push(Reading { variant, lines });
            }
        }
    }
    Ok(readings)
}

/// 行を詰めた BGRA の並びから、文字認識にかける `SoftwareBitmap` を作る（失敗は、画像を読めなかった失敗にする）。
fn bitmap_of(
    path: &Path,
    pixels: &[u8],
    width: u32,
    height: u32,
) -> Result<SoftwareBitmap, OcrError> {
    bitmap_from_bgra(pixels, width, height).map_err(|e| OcrError::Decode {
        path: path.display().to_string(),
        reason: e.message(),
    })
}

fn recognize(engine: &OcrEngine, bitmap: &SoftwareBitmap) -> Result<Vec<String>, OcrError> {
    let max = OcrEngine::MaxImageDimension().unwrap_or(2600);
    let width = bitmap.PixelWidth().unwrap_or(0) as u32;
    let height = bitmap.PixelHeight().unwrap_or(0) as u32;
    if width > max || height > max {
        return Err(OcrError::TooLarge { width, height, max });
    }
    let fail = |e: windows::core::Error| OcrError::Recognize(e.message());
    let result = engine
        .RecognizeAsync(bitmap)
        .and_then(|op| op.join())
        .map_err(fail)?;
    let lines = result.Lines().map_err(fail)?;
    let count = lines.Size().map_err(fail)?;
    let mut texts = Vec::with_capacity(count as usize);
    for index in 0..count {
        let line = lines.GetAt(index).map_err(fail)?;
        texts.push(line.Text().map_err(fail)?.to_string());
    }
    Ok(texts)
}

/// 文字認識にかける 1 回目の画像の画素（B, G, R, A の並び）と大きさ。
struct Base {
    pixels: Vec<u8>,
    width: u32,
    height: u32,
}

/// 画像のファイルを読んで、1 回目の画像の画素にする。
/// `Region::Center` なら、中央の板を切り出して `UPSCALE` 倍にした画像（WinRT で読み、切り出しと拡大は `resample`）。
/// `Region::Whole` なら、画像そのまま。
fn decode_base(path: &Path, region: Region) -> Result<Base, OcrError> {
    let shown = path.display().to_string();
    let decode_err = |reason: String| OcrError::Decode {
        path: shown.clone(),
        reason,
    };
    let full = decode_whole(path)?;
    let width = full.PixelWidth().map_err(|e| decode_err(e.message()))? as u32;
    let height = full.PixelHeight().map_err(|e| decode_err(e.message()))? as u32;
    let pixels = copy_pixels(&full).map_err(|e| decode_err(e.message()))?;
    if region == Region::Whole {
        return Ok(Base {
            pixels,
            width,
            height,
        });
    }
    let crop = center_crop(width, height)
        .ok_or_else(|| decode_err(format!("画像が小さすぎます（{width}×{height}）")))?;
    let (big_width, big_height) = crop.scaled(UPSCALE);
    Ok(Base {
        pixels: crop_and_upscale(&pixels, width, height, crop, UPSCALE),
        width: big_width,
        height: big_height,
    })
}

/// 画像のファイルを読んで、文字認識にかける `SoftwareBitmap`（Bgra8）にする（1 回目の画像。切り出しと拡大の試験が使う）。
#[cfg(test)]
fn decode(path: &Path, region: Region) -> Result<SoftwareBitmap, OcrError> {
    let base = decode_base(path, region)?;
    bitmap_of(path, &base.pixels, base.width, base.height)
}

/// 画像のファイルを、そのまま（切り出しも拡大も、色の補正もせずに）`SoftwareBitmap`（Bgra8）として読む。
fn decode_whole(path: &Path) -> Result<SoftwareBitmap, OcrError> {
    let shown = path.display().to_string();
    let open = |reason: String| OcrError::Open {
        path: shown.clone(),
        reason,
    };
    let decode_err = |reason: String| OcrError::Decode {
        path: shown.clone(),
        reason,
    };
    let absolute = std::path::absolute(path).map_err(|e| open(e.to_string()))?;
    let file = StorageFile::GetFileFromPathAsync(&HSTRING::from(absolute.as_os_str()))
        .and_then(|op| op.join())
        .map_err(|e| open(e.message()))?;
    let stream = file
        .OpenAsync(FileAccessMode::Read)
        .and_then(|op| op.join())
        .map_err(|e| open(e.message()))?;
    let decoder = BitmapDecoder::CreateAsync(&stream)
        .and_then(|op| op.join())
        .map_err(|e| decode_err(e.message()))?;
    let transform = BitmapTransform::new().map_err(|e| decode_err(e.message()))?;
    decoder
        .GetSoftwareBitmapTransformedAsync(
            BitmapPixelFormat::Bgra8,
            BitmapAlphaMode::Ignore,
            &transform,
            ExifOrientationMode::IgnoreExifOrientation,
            ColorManagementMode::DoNotColorManage,
        )
        .and_then(|op| op.join())
        .map_err(|e| decode_err(e.message()))
}

/// `SoftwareBitmap`（Bgra8）の画素を、行を詰めた BGRA の並びで取り出す。
fn copy_pixels(bitmap: &SoftwareBitmap) -> windows::core::Result<Vec<u8>> {
    let width = bitmap.PixelWidth()? as u32;
    let height = bitmap.PixelHeight()? as u32;
    let size = width * height * 4;
    let buffer = Buffer::Create(size)?;
    bitmap.CopyToBuffer(&buffer)?;
    buffer.SetLength(size)?;
    let reader = DataReader::FromBuffer(&buffer)?;
    let mut bytes = vec![0u8; size as usize];
    reader.ReadBytes(&mut bytes)?;
    Ok(bytes)
}

/// 行を詰めた BGRA の並びから、`SoftwareBitmap`（Bgra8、透明度は使わない）を作る。
fn bitmap_from_bgra(
    bytes: &[u8],
    width: u32,
    height: u32,
) -> windows::core::Result<SoftwareBitmap> {
    let writer = DataWriter::new()?;
    writer.WriteBytes(bytes)?;
    let buffer = writer.DetachBuffer()?;
    SoftwareBitmap::CreateCopyWithAlphaFromBuffer(
        &buffer,
        BitmapPixelFormat::Bgra8,
        width as i32,
        height as i32,
        BitmapAlphaMode::Ignore,
    )
}

#[cfg(test)]
mod tests {
    use std::fs::File;
    use std::io::BufWriter;

    use super::*;

    /// 幅・高さの画素を、黒で塗って、`paint` で上書きした PNG（RGBA）を作る。
    fn write_png(
        path: &Path,
        width: u32,
        height: u32,
        paint: &dyn Fn(u32, u32) -> Option<[u8; 3]>,
    ) {
        let mut data = Vec::with_capacity((width * height * 4) as usize);
        for y in 0..height {
            for x in 0..width {
                let [r, g, b] = paint(x, y).unwrap_or([0, 0, 0]);
                data.extend_from_slice(&[r, g, b, 255]);
            }
        }
        let file = BufWriter::new(File::create(path).unwrap());
        let mut encoder = png::Encoder::new(file, width, height);
        encoder.set_color(png::ColorType::Rgba);
        encoder.set_depth(png::BitDepth::Eight);
        let mut writer = encoder.write_header().unwrap();
        writer.write_image_data(&data).unwrap();
    }

    /// `SoftwareBitmap`（Bgra8）の画素を、(幅, 高さ, B,G,R,A の並び) で取り出す。
    fn pixels(bitmap: &SoftwareBitmap) -> (u32, u32, Vec<u8>) {
        let width = bitmap.PixelWidth().unwrap() as u32;
        let height = bitmap.PixelHeight().unwrap() as u32;
        (width, height, copy_pixels(bitmap).unwrap())
    }

    fn at(bytes: &[u8], width: u32, x: u32, y: u32) -> [u8; 3] {
        let i = ((y * width + x) * 4) as usize;
        // B, G, R の順で入っている。R, G, B に直して返す。
        [bytes[i + 2], bytes[i + 1], bytes[i]]
    }

    fn near(actual: [u8; 3], expected: [u8; 3]) -> bool {
        actual
            .iter()
            .zip(expected)
            .all(|(a, e)| (i32::from(*a) - i32::from(e)).abs() <= 24)
    }

    #[test]
    fn the_center_box_is_cut_exactly_and_enlarged_three_times() {
        let (width, height) = (1447u32, 935u32);
        let crop = center_crop(width, height).unwrap();
        // 箱の外は黒。箱の中の、左端の列は緑・右端の列は青・上端の行は赤・下端の行は黄・そのほかは白。
        // 画面の読み取り（WinRT）と切り出し（箱の位置）が 1 画素でもずれると、端の色が変わる。
        let paint = |x: u32, y: u32| {
            if x < crop.x || x >= crop.x + crop.width || y < crop.y || y >= crop.y + crop.height {
                return None;
            }
            let (dx, dy) = (x - crop.x, y - crop.y);
            Some(if dx == 0 {
                [0, 255, 0]
            } else if dx == crop.width - 1 {
                [0, 0, 255]
            } else if dy == 0 {
                [255, 0, 0]
            } else if dy == crop.height - 1 {
                [255, 255, 0]
            } else {
                [255, 255, 255]
            })
        };
        let dir = tempfile::tempdir().unwrap();
        let path = dir.path().join("screen.png");
        write_png(&path, width, height, &paint);

        let bitmap = decode(&path, Region::Center).unwrap();
        let (w, h, bytes) = pixels(&bitmap);
        assert_eq!((w, h), crop.scaled(UPSCALE), "切り出して 3 倍の大きさ");
        let px = |x: u32, y: u32| at(&bytes, w, x, y);
        // 外の黒は混ざらない（端の画素も、その端の色。四隅は 2 つの端の色が混ざるので見ない）。
        assert!(
            near(px(0, h / 2), [0, 255, 0]),
            "左端は緑: {:?}",
            px(0, h / 2)
        );
        assert!(
            near(px(w - 1, h / 2), [0, 0, 255]),
            "右端は青: {:?}",
            px(w - 1, h / 2)
        );
        assert!(
            near(px(w / 2, 0), [255, 0, 0]),
            "上端は赤: {:?}",
            px(w / 2, 0)
        );
        assert!(
            near(px(w / 2, h - 1), [255, 255, 0]),
            "下端は黄: {:?}",
            px(w / 2, h - 1)
        );
        assert!(
            near(px(w / 2, h / 2), [255, 255, 255]),
            "中央は白: {:?}",
            px(w / 2, h / 2)
        );
    }

    /// 試験の素材（3 倍の切り出し）を、3×3 の平均で 1 倍に戻して、1447×935 の画面の箱の位置に貼った PNG を作る。
    /// 元の画素そのものではない（少しぼやける）ので、文字認識の結果は素材と同じとは限らない。
    /// 画像の読み取り・切り出し・拡大・文字認識の部品がつながって動くことの確認に使う。
    fn write_screen_from_fixture(path: &Path, fixture: &str) {
        let source = PathBuf::from(env!("CARGO_MANIFEST_DIR"))
            .join("tests")
            .join("fixtures")
            .join(fixture);
        let decoder = png::Decoder::new(std::io::BufReader::new(File::open(source).unwrap()));
        let mut reader = decoder.read_info().unwrap();
        let mut buffer = vec![0u8; reader.output_buffer_size().unwrap()];
        let info = reader.next_frame(&mut buffer).unwrap();
        assert_eq!(info.color_type, png::ColorType::Rgb);
        let (big_w, big_h) = (info.width as usize, info.height as usize);
        let (small_w, small_h) = (big_w / 3, big_h / 3);
        let average = |sx: usize, sy: usize, channel: usize| -> u8 {
            let mut sum = 0u32;
            for dy in 0..3 {
                for dx in 0..3 {
                    sum += u32::from(buffer[((sy * 3 + dy) * big_w + sx * 3 + dx) * 3 + channel]);
                }
            }
            (sum / 9) as u8
        };
        let (width, height) = (1447u32, 935u32);
        let crop = center_crop(width, height).unwrap();
        assert_eq!(
            (crop.width as usize, crop.height as usize),
            (small_w, small_h)
        );
        write_png(path, width, height, &|x, y| {
            let inside =
                x >= crop.x && x < crop.x + crop.width && y >= crop.y && y < crop.y + crop.height;
            inside.then(|| {
                let (sx, sy) = ((x - crop.x) as usize, (y - crop.y) as usize);
                [average(sx, sy, 0), average(sx, sy, 1), average(sx, sy, 2)]
            })
        });
    }

    #[test]
    fn a_whole_screen_goes_through_decode_crop_enlarge_and_recognition() {
        let dir = tempfile::tempdir().unwrap();
        let path = dir.path().join("screen.png");
        write_screen_from_fixture(&path, "mark3-center.png");
        let lines = read_center_lines(&path).expect("画面の中央を読める");
        eprintln!("画面の中央: {lines:?}");
        // 文字認識の結果は、画像のぼやけで変わりうる。ここでは、部品がつながって、文字を返すことだけを見る。
        assert!(!lines.is_empty(), "行が返る");
        assert!(
            lines
                .iter()
                .any(|line| line.chars().any(|c| c.is_ascii_digit())),
            "数字を読める: {lines:?}"
        );
    }

    #[test]
    fn a_picture_that_is_not_a_png_is_reported_not_panicked() {
        let dir = tempfile::tempdir().unwrap();
        let path = dir.path().join("broken.png");
        std::fs::write(&path, b"this is not a png").unwrap();
        let error = decode(&path, Region::Center).unwrap_err();
        assert!(matches!(error, OcrError::Decode { .. }), "{error:?}");
        let missing = dir.path().join("missing.png");
        let error = decode(&missing, Region::Center).unwrap_err();
        assert!(matches!(error, OcrError::Open { .. }), "{error:?}");
    }
}
