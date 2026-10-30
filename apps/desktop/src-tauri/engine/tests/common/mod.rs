//! 試験の共通の道具: 固定データ FX-E の読み込み、観測の sha256、モデルの探し方。
//!
//! 固定データ（`tests/fixtures/fx-e`）は、S42 同士の自己対局 1 局の牌譜と、Python の libriichi（Mortal 0cff2b5）・
//! PyTorch・onnxruntime で求めた参照の値。個人の記録は含まない。

#![allow(dead_code)] // 試験ごとに使う道具が違う

use std::path::{Path, PathBuf};

use jantama_engine::report::{load_report, Report};
use ndarray::{Array1, Array2};
use serde_json::Value;
use sha2::{Digest, Sha256};

/// 読みのモデル（`tenpai.onnx`）の sha256。固定データの参照値を作ったファイルと同じもの。
pub const MODEL_SHA256: &str = "50893ddca230bd90c678086bc8e3b9fe229492b5c9f15fe8145149464b8c1cea";

pub fn fixture_dir() -> PathBuf {
    Path::new(env!("CARGO_MANIFEST_DIR")).join("tests/fixtures/fx-e")
}

pub fn fixture_json(name: &str) -> Value {
    let path = fixture_dir().join(name);
    let text = std::fs::read_to_string(&path).unwrap_or_else(|e| panic!("{}: {e}", path.display()));
    serde_json::from_str(&text).unwrap_or_else(|e| panic!("{}: {e}", path.display()))
}

/// 固定データの牌譜（席 0 の `player_id` つき）。
pub fn load_game() -> Report {
    load_report(&fixture_dir().join("game.json"), None).expect("固定データの牌譜を読める")
}

/// 参照の場面（`moments.json` の `moments`。席 0 の自分のツモ 126 場面）。
pub fn reference_moments() -> Vec<Value> {
    let moments = fixture_json("moments.json");
    moments["moments"].as_array().expect("moments").clone()
}

/// 観測の float32（リトルエンディアン、行の順）の sha256。
pub fn obs_sha256(obs: &Array2<f32>) -> String {
    let mut hasher = Sha256::new();
    for value in obs.iter() {
        hasher.update(value.to_le_bytes());
    }
    hex(&hasher.finalize())
}

/// 合法手の印を、'0' と '1' の文字列にする。
pub fn mask_string(mask: &Array1<bool>) -> String {
    mask.iter().map(|&b| if b { '1' } else { '0' }).collect()
}

pub fn hex(bytes: &[u8]) -> String {
    bytes.iter().map(|b| format!("{b:02x}")).collect()
}

/// 環境変数 `JANTAMA_MODEL_DIR` の `tenpai.onnx`。無い・sha256 が違うときは、理由を出して `None`（試験は飛ばして通る）。
pub fn model_path() -> Option<PathBuf> {
    let Some(dir) = std::env::var_os("JANTAMA_MODEL_DIR") else {
        println!("skip: 環境変数 JANTAMA_MODEL_DIR が無いので、モデルを使う試験を飛ばします");
        return None;
    };
    let path = PathBuf::from(dir).join("tenpai.onnx");
    let reason = match std::fs::read(&path) {
        Err(e) => Some(format!("{} を読めません（{e}）", path.display())),
        Ok(bytes) => {
            let sha = hex(&Sha256::digest(&bytes));
            (sha != MODEL_SHA256)
                .then(|| format!("{} の sha256 が違います（{sha}）", path.display()))
        }
    };
    if let Some(reason) = reason {
        println!("skip: {reason}。モデルを使う試験を飛ばします");
        return None;
    }
    Some(path)
}

/// 試験が書いてよい場所（`target/tmp`）の、試験ごとに別の名前のファイル。同じ名前は、次の実行で上書きする。
pub fn scratch_path(name: &str) -> PathBuf {
    let dir = PathBuf::from(env!("CARGO_TARGET_TMPDIR"));
    std::fs::create_dir_all(&dir).expect("試験の一時フォルダを作れる");
    dir.join(name)
}
