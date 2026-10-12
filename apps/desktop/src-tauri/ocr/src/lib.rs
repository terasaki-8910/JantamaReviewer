//! jantama-ocr: 保存済みのスクリーンショットから、画面中央の板（局・残りの牌の数・点数）の文字を読む（F11、S-3）。
//!
//! 使ってよいのは取り込みのとき（対局のあと）だけ。ウィジェット・ボタンを拾う部分・撮影・記録・補助プログラムのコードには入れない
//! （本体のうち、取り込みの読み取り `src/import/ocr_job.rs` だけがこのクレートを使う。`tests/safety.rs` が確かめる）。
//! 読むのは、すでにファイルに保存された画像だけ。画面を撮ったり、動いているゲームを読んだりはしない。
//!
//! - `geometry`: 画面から中央の板を切り出す箱（割合）と拡大の倍率、読み直し用の画像の作り方の名前（`Variant`）（純粋な計算。どの OS でも試験できる）。
//! - `locate`: 局と残り枚数の水色の文字の位置を色で探し、局・残り枚数・自分の点数だけの切り出しを決める（E-32。純粋な計算。窓の大きさによらない）。
//! - `resample`: 切り出したものを Lanczos で拡大・縮小する、コントラストを上げる、1.5 倍に広げる（Pillow と同じ画素になる計算。純粋な計算）。
//! - `reading`: 読み取りの結果の型（どの OS も同じ形で返す）。
//! - `winrt`（Windows 専用）: PNG を WinRT で読み、水色の文字の位置（見つからなければ割合の箱）から切り出して拡大し、Windows の日本語の文字認識にかける。
//!   1 回目の画像で読めないときのために、読み直し用の画像（コントラストを上げたもの・1.5 倍に広げたもの）でも読める（E-20）。
//!   待ちのある WinRT の呼び出しは、専用のスレッドの中だけで行う（画面のスレッドを止めない）。
//! - `mac`（macOS 専用）: まだ作っていない。`OcrWorker` は同じ名前と呼び方で、必ず `OcrError::Unsupported` を返す（段階 4 で Vision と ImageIO にする）。

pub mod error;
pub mod geometry;
pub mod locate;
mod reading;
pub mod resample;
#[cfg(target_os = "macos")]
mod mac;
#[cfg(windows)]
mod winrt;

pub use error::OcrError;
pub use geometry::{
    center_crop, CropRect, Variant, GEOMETRY_ID, TIGHT_BLOCK_HEIGHT, TIGHT_PADDING, UPSCALE,
};
#[cfg(target_os = "macos")]
pub use mac::OcrWorker;
pub use reading::{Outcome, Reading};
#[cfg(windows)]
pub use winrt::{read_center_lines, read_lines_uncropped, OcrWorker};
