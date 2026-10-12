//! 文字認識の結果の型（どの OS の読み取りも、この形で返す）。

use crate::geometry::{CropRect, Variant};

/// 1 通りの画像を文字認識で読んだ結果。
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct Reading {
    /// どの画像で読んだか。
    pub variant: Variant,
    /// 認識した行（上から順）。
    pub lines: Vec<String>,
}

/// 画像 1 枚の読み取りの結果と、どこを読んだか。
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct Outcome {
    /// 水色の文字の位置から決めた切り出し（画面の画素。見つからず、割合の箱や画像そのままで読んだときは `None`）。
    pub located: Option<CropRect>,
    pub readings: Vec<Reading>,
}
