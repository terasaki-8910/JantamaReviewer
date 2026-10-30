//! 読みのモデル（F23・F24）の、決まった出どころ。取るのは、この 1 つの版（コミットと sha256）だけ。
//!
//! 定数は、このファイルだけに置く（`tests/safety.rs` の S-2 が、ここで決めた配布元と版を、取る層の部品から組み立てることを確かめる）。
//! 取る通信先のホストは、取る層（`download.rs`）の中だけにある。置き場は、設定のフォルダ（`JANTAMA_CONFIG_DIR` で替わる）の
//! `models/` で、同期にも書き出しにも入らない（D-8）。

use std::path::{Path, PathBuf};

/// Hugging Face の、読みのモデルのリポジトリ（`<持ち主>/<名前>`）。
pub const MODEL_REPO: &str = "hhim8826/mortal3-b40c192";
/// 取るコミット。`main` のような動く名前ではなく、中身が変わらない版を固定する。
pub const MODEL_REVISION: &str = "7784a9deddf63df03f023474116f715850d3c7a0";
/// 取るファイルの名前（置き場でも、この名前で置く）。
pub const MODEL_FILE: &str = "tenpai.onnx";
/// 決まった版の中身の SHA-256（小文字の 16 進数）。合わないものは、取ったものも、選んだものも、使わない。
pub const MODEL_SHA256: &str = "50893ddca230bd90c678086bc8e3b9fe229492b5c9f15fe8145149464b8c1cea";
/// 決まった版の大きさ（バイト）。
pub const MODEL_BYTES: u64 = 4_013_332;
/// ライセンス。
pub const MODEL_LICENSE: &str = "AGPL-3.0";
/// 学習のデータの説明（画面に出す）。
pub const MODEL_ORIGIN: &str = "天鳳の鳳凰卓 160 万局で学習";

/// 設定のフォルダの中の、モデルを置くフォルダの名前。
pub const MODELS_DIR: &str = "models";
/// 取っている途中のファイルの名前の後ろ（取り終えて、sha256 が合ってから、本来の名前にする）。
pub const PART_SUFFIX: &str = ".part";

/// モデル 1 つ分の、決まった版。試験は、小さな偽物の版を作って、取る・選ぶ・消すの動きを確かめる。
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub struct ModelSpec {
    pub repo: &'static str,
    pub revision: &'static str,
    pub file: &'static str,
    pub sha256: &'static str,
    pub bytes: u64,
    pub license: &'static str,
    pub origin: &'static str,
}

/// 読みのモデル（`tenpai.onnx`）。
pub const READS_MODEL: ModelSpec = ModelSpec {
    repo: MODEL_REPO,
    revision: MODEL_REVISION,
    file: MODEL_FILE,
    sha256: MODEL_SHA256,
    bytes: MODEL_BYTES,
    license: MODEL_LICENSE,
    origin: MODEL_ORIGIN,
};

/// 設定のフォルダの中の、モデルを置くフォルダ（`<設定のフォルダ>/models`）。
pub fn models_dir(config_dir: &Path) -> PathBuf {
    config_dir.join(MODELS_DIR)
}

impl ModelSpec {
    /// モデルを置く場所（`models_dir` の中の、決まった名前）。
    pub fn target_in(&self, models_dir: &Path) -> PathBuf {
        models_dir.join(self.file)
    }

    /// 取っている途中のファイルの場所（`<モデルの名前>.part`）。
    pub fn part_in(&self, models_dir: &Path) -> PathBuf {
        models_dir.join(format!("{}{PART_SUFFIX}", self.file))
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn is_lower_hex(text: &str, length: usize) -> bool {
        text.len() == length && text.bytes().all(|b| matches!(b, b'0'..=b'9' | b'a'..=b'f'))
    }

    #[test]
    fn f24_the_catalog_pins_one_exact_version_of_the_reads_model() {
        assert_eq!(MODEL_REPO, "hhim8826/mortal3-b40c192");
        assert_eq!(MODEL_FILE, "tenpai.onnx");
        assert_eq!(MODEL_LICENSE, "AGPL-3.0");
        assert_eq!(MODEL_ORIGIN, "天鳳の鳳凰卓 160 万局で学習");
        assert_eq!(MODEL_BYTES, 4_013_332);
        // コミットは、40 桁の 16 進数（動く名前ではない）。中身は、64 桁の SHA-256
        assert!(is_lower_hex(MODEL_REVISION, 40), "{MODEL_REVISION}");
        assert_eq!(MODEL_REVISION, "7784a9deddf63df03f023474116f715850d3c7a0");
        assert!(is_lower_hex(MODEL_SHA256, 64), "{MODEL_SHA256}");
        assert!(MODEL_SHA256.starts_with("50893ddc"));
        // 構造体にまとめた値は、定数と同じ
        assert_eq!(READS_MODEL.repo, MODEL_REPO);
        assert_eq!(READS_MODEL.revision, MODEL_REVISION);
        assert_eq!(READS_MODEL.file, MODEL_FILE);
        assert_eq!(READS_MODEL.sha256, MODEL_SHA256);
        assert_eq!(READS_MODEL.bytes, MODEL_BYTES);
    }

    #[test]
    fn f24_the_model_lives_under_models_in_the_config_folder() {
        let config = Path::new("config");
        assert_eq!(models_dir(config), config.join("models"));
        let dir = models_dir(config);
        assert_eq!(
            READS_MODEL.target_in(&dir),
            config.join("models").join("tenpai.onnx")
        );
        assert_eq!(
            READS_MODEL.part_in(&dir),
            config.join("models").join("tenpai.onnx.part")
        );
    }

    /// 本物のモデルが手元にあるとき（環境変数 `JANTAMA_MODEL_DIR` の `tenpai.onnx`）、定数の大きさと SHA-256 が、そのファイルと合うこと。
    /// 無ければ、理由を出して通る（モデルは、リポジトリにも試験にも入れない）。
    #[test]
    fn f24_the_pinned_size_and_sha256_match_the_real_model_when_it_is_at_hand() {
        let Some(dir) = std::env::var_os("JANTAMA_MODEL_DIR") else {
            println!(
                "skip: 環境変数 JANTAMA_MODEL_DIR が無いので、本物のモデルとの照合を飛ばします"
            );
            return;
        };
        let path = Path::new(&dir).join(MODEL_FILE);
        if !path.is_file() {
            println!(
                "skip: {} が無いので、本物のモデルとの照合を飛ばします",
                path.display()
            );
            return;
        }
        let bytes = std::fs::read(&path).unwrap();
        assert_eq!(bytes.len() as u64, MODEL_BYTES);
        assert_eq!(crate::ids::sha256_hex(&bytes), MODEL_SHA256);
    }
}
