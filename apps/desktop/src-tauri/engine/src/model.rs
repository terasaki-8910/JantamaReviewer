//! 読みのモデル（`tenpai.onnx`）の推論。ONNX を Rust だけの部品（tract）で動かす。
//!
//! モデルの入出力（`hhim8826/mortal3-b40c192` の `tenpai.onnx`）:
//! - 入力 `obs`: (n, 934, 34) の f32。Mortal の v3 の観測（libriichi の `encode_obs(3, false)`）を n 場面ぶん重ねたもの。
//! - 出力 `tenpai` (n, 3)・`waits` (n, 3, 34)・`any_wait` (n, 34)・`furiten` (n, 3): どれも確率。
//!   3 は他家で、下家・対面・上家（自分の席から 1・2・3 つ先）の順。34 は牌の種類の番号。
//!
//! 読み込むときに、入出力の名前と形を確かめる。想定と違うモデルは、理由を添えて断る。

use std::path::Path;
use std::sync::Arc;

use anyhow::{anyhow, bail, Context, Result};
use ndarray::Array2;
use sha2::{Digest, Sha256};
use tract_onnx::prelude::*;
use tract_onnx::tract_hir::internal::DimLike;

use crate::tiles::KINDS;

/// 観測の行数（v3）。
pub const OBS_ROWS: usize = 934;
/// 他家の数。
pub const OPPONENTS: usize = 3;
/// 1 回の推論に重ねる場面の数の上限。
pub const BATCH: usize = 64;

/// 1 場面ぶんの出力（確率）。
#[derive(Debug, Clone, PartialEq)]
pub struct Outputs {
    /// 他家ごとの、聴牌している確率。
    pub tenpai: [f32; OPPONENTS],
    /// 他家ごとの、牌の種類ごとに待っている確率。
    pub waits: [[f32; KINDS]; OPPONENTS],
    /// 3 人をまとめた、牌の種類ごとに待っている確率。
    pub any_wait: [f32; KINDS],
    /// 他家ごとの、フリテンの確率。
    pub furiten: [f32; OPPONENTS],
}

/// 読み込んだモデル。
pub struct TenpaiModel {
    plan: Arc<TypedRunnableModel>,
    /// 出力 tenpai・waits・any_wait・furiten が、推論の結果の何番目か。
    output_index: [usize; 4],
    file_name: String,
    sha256: String,
}

impl TenpaiModel {
    /// ファイルからモデルを読む。ファイルの中身から sha256 も求める（reads.json に添える）。
    pub fn load(path: &Path) -> Result<Self> {
        let bytes = std::fs::read(path)
            .with_context(|| format!("モデルのファイルを読めません: {}", path.display()))?;
        let sha256 = hex(&Sha256::digest(&bytes));
        let file_name = path
            .file_name()
            .map(|name| name.to_string_lossy().into_owned())
            .unwrap_or_else(|| path.display().to_string());

        let (plan, output_index) = build_plan(&bytes)
            .with_context(|| format!("モデルを使えません: {}", path.display()))?;
        Ok(Self {
            plan,
            output_index,
            file_name,
            sha256,
        })
    }

    /// モデルのファイル名（フォルダを除く）。
    pub fn file_name(&self) -> &str {
        &self.file_name
    }

    /// モデルのファイルの sha256（小文字の 16 進数）。
    pub fn sha256(&self) -> &str {
        &self.sha256
    }

    /// 観測（934×34）を重ねて推論する。`BATCH` 場面ずつに分けて動かし、入力の順に出力を返す。
    pub fn run(&self, observations: &[Array2<f32>]) -> Result<Vec<Outputs>> {
        let mut outputs = Vec::with_capacity(observations.len());
        for chunk in observations.chunks(BATCH) {
            outputs.extend(self.run_batch(chunk)?);
        }
        Ok(outputs)
    }

    fn run_batch(&self, batch: &[Array2<f32>]) -> Result<Vec<Outputs>> {
        let n = batch.len();
        let mut data = Vec::with_capacity(n * OBS_ROWS * KINDS);
        for obs in batch {
            if obs.dim() != (OBS_ROWS, KINDS) {
                bail!(
                    "観測の形が想定と違います: {:?}（想定 {OBS_ROWS}×{KINDS}）",
                    obs.dim()
                );
            }
            data.extend(obs.iter().copied());
        }
        let input = Tensor::from_shape(&[n, OBS_ROWS, KINDS], &data)
            .map_err(|e| anyhow!("モデルの入力を作れません: {e}"))?;
        let result = self
            .plan
            .run(tvec!(input.into()))
            .map_err(|e| anyhow!("モデルの推論に失敗しました: {e}"))?;
        if result.len() != 4 {
            bail!(
                "モデルの出力の数が想定と違います: {}（想定 4）",
                result.len()
            );
        }
        let [tenpai, waits, any_wait, furiten] = self.output_index;
        let tenpai = slice_of(&result[tenpai], &[n, OPPONENTS], "tenpai")?;
        let waits = slice_of(&result[waits], &[n, OPPONENTS, KINDS], "waits")?;
        let any_wait = slice_of(&result[any_wait], &[n, KINDS], "any_wait")?;
        let furiten = slice_of(&result[furiten], &[n, OPPONENTS], "furiten")?;

        Ok((0..n)
            .map(|row| {
                let mut out = Outputs {
                    tenpai: [0.0; OPPONENTS],
                    waits: [[0.0; KINDS]; OPPONENTS],
                    any_wait: [0.0; KINDS],
                    furiten: [0.0; OPPONENTS],
                };
                out.tenpai
                    .copy_from_slice(&tenpai[row * OPPONENTS..(row + 1) * OPPONENTS]);
                out.furiten
                    .copy_from_slice(&furiten[row * OPPONENTS..(row + 1) * OPPONENTS]);
                out.any_wait
                    .copy_from_slice(&any_wait[row * KINDS..(row + 1) * KINDS]);
                for opponent in 0..OPPONENTS {
                    let from = (row * OPPONENTS + opponent) * KINDS;
                    out.waits[opponent].copy_from_slice(&waits[from..from + KINDS]);
                }
                out
            })
            .collect())
    }
}

/// 出力のテンソルを、形を確かめたうえで f32 の並びとして取り出す。
fn slice_of<'a>(value: &'a TValue, shape: &[usize], name: &str) -> Result<&'a [f32]> {
    if value.shape() != shape {
        bail!(
            "モデルの出力 {name} の形が想定と違います: {:?}（想定 {shape:?}）",
            value.shape()
        );
    }
    value
        .try_as_plain_ram()
        .and_then(|view| view.as_slice::<f32>())
        .map_err(|e| anyhow!("モデルの出力 {name} を f32 として読めません: {e}"))
}

/// ONNX の中身から、推論の計画を作る。入出力の名前と形が想定どおりでなければ、エラー。
fn build_plan(bytes: &[u8]) -> Result<(Arc<TypedRunnableModel>, [usize; 4])> {
    let inference = tract_onnx::onnx()
        .model_for_read(&mut &bytes[..])
        .map_err(|e| anyhow!("ONNX として読めません: {e}"))?;
    let typed = inference
        .into_typed()
        .map_err(|e| anyhow!("モデルの形を解析できません: {e}"))?;
    let output_index = check_shapes(&typed)?;
    let plan = typed
        .into_optimized()
        .and_then(|model| model.into_runnable())
        .map_err(|e| anyhow!("モデルを推論の形に整えられません: {e}"))?;
    Ok((plan, output_index))
}

/// 入力が (n, 934, 34)、出力が名前 `tenpai`・`waits`・`any_wait`・`furiten` の形であることを確かめる。
/// 返すのは、この 4 つの出力が、出力の並びの何番目か。
fn check_shapes(model: &TypedModel) -> Result<[usize; 4]> {
    let inputs = model.input_outlets()?;
    if inputs.len() != 1 {
        bail!(
            "モデルの入力の数が想定と違います: {}（想定 1）",
            inputs.len()
        );
    }
    let input = model.outlet_fact(inputs[0])?;
    check_fact(input, &[OBS_ROWS, KINDS], "入力 obs")?;

    let outputs = model.output_outlets()?;
    let expected: [(&str, &[usize]); 4] = [
        ("tenpai", &[OPPONENTS]),
        ("waits", &[OPPONENTS, KINDS]),
        ("any_wait", &[KINDS]),
        ("furiten", &[OPPONENTS]),
    ];
    let mut index = [0usize; 4];
    for (slot, (name, tail)) in expected.into_iter().enumerate() {
        let Some(position) = outputs
            .iter()
            .position(|outlet| model.outlet_label(*outlet) == Some(name))
        else {
            bail!("モデルに出力 {name} がありません");
        };
        check_fact(
            model.outlet_fact(outputs[position])?,
            tail,
            &format!("出力 {name}"),
        )?;
        index[slot] = position;
    }
    Ok(index)
}

/// 先頭が場面の数（決まった数でない文字の名前）で、残りが `tail` の f32 であること。
fn check_fact(fact: &TypedFact, tail: &[usize], what: &str) -> Result<()> {
    let dims = fact.shape.dims();
    let shown = format!("{:?}", fact.shape);
    let batch_is_symbolic = dims.first().is_some_and(|dim| dim.to_usize().is_err());
    let tail_matches = dims.len() == tail.len() + 1
        && dims[1..]
            .iter()
            .zip(tail)
            .all(|(dim, want)| dim.to_usize().ok() == Some(*want));
    if fact.datum_type != f32::datum_type() || !batch_is_symbolic || !tail_matches {
        bail!(
            "モデルの{what}の形が想定と違います: {shown}（想定 n×{}の f32）",
            tail.iter()
                .map(ToString::to_string)
                .collect::<Vec<_>>()
                .join("×")
        );
    }
    Ok(())
}

fn hex(bytes: &[u8]) -> String {
    use std::fmt::Write;
    bytes
        .iter()
        .fold(String::with_capacity(bytes.len() * 2), |mut out, byte| {
            let _ = write!(out, "{byte:02x}");
            out
        })
}
