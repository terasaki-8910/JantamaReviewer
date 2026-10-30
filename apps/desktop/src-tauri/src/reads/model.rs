//! 読みのモデルの置き場（設定のフォルダの `models/`）の操作: いまの状態・自分で取ったファイルを置く・消す。通信はしない
//! （Hugging Face から取るのは `download.rs`）。
//!
//! 「入っている」は、決まった名前のファイルがあり、中身の SHA-256 が決まった版（`catalog`）と合っていること。
//! 名前だけ合って、中身の違うファイル（手で置いた別のもの）は、入っていないものとして扱う。

use std::fmt;
use std::fs::{self, File};
use std::io::{self, ErrorKind, Read, Write};
use std::path::Path;

use serde::Serialize;
use sha2::{Digest, Sha256};

use super::catalog::ModelSpec;
use crate::ids::hex;

/// 画面が読む、モデルの状態（`apps/desktop/src/api/reads.ts` の `ReadsModelStatus` と同じ形）。
#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
pub struct ReadsModelStatus {
    /// 決まった版のファイルが入っているか（SHA-256 まで確かめる）。
    pub installed: bool,
    /// 入っているファイルの大きさ（バイト）。入っていなければ `None`。
    pub bytes: Option<u64>,
    /// 入っているファイルの SHA-256。入っていなければ `None`。
    pub sha256: Option<String>,
    /// 取っている最中か。
    pub downloading: bool,
    /// 出どころ（リポジトリ・コミット・ファイル名・ライセンス・学習のデータの説明）。
    pub repo: String,
    pub revision: String,
    pub file: String,
    pub license: String,
    pub origin: String,
}

/// 選んだファイルを置く・消すのに失敗した理由。
#[derive(Debug, Clone, PartialEq, Eq)]
pub enum ModelError {
    /// 選んだファイルが、決まった版ではない。
    NotThePinnedModel,
    /// 選んだものを読めない（無い・ファイルでない）。
    Unreadable(String),
    /// 置けなかった。
    Write(String),
    /// 消せなかった。
    Remove(String),
}

impl fmt::Display for ModelError {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        match self {
            ModelError::NotThePinnedModel => {
                f.write_str("このファイルは決まった読みのモデルではありません（sha256 が違います）")
            }
            ModelError::Unreadable(reason) => write!(f, "ファイルを読めません: {reason}"),
            ModelError::Write(reason) => {
                write!(f, "モデルのファイルを置けませんでした: {reason}")
            }
            ModelError::Remove(reason) => {
                write!(f, "モデルのファイルを消せませんでした: {reason}")
            }
        }
    }
}

impl std::error::Error for ModelError {}

/// ファイルの SHA-256（小文字の 16 進数）。大きなファイルでも、少しずつ読む。
pub fn sha256_of_file(path: &Path) -> io::Result<String> {
    let mut file = File::open(path)?;
    let mut hasher = Sha256::new();
    let mut buffer = vec![0u8; 64 * 1024];
    loop {
        match file.read(&mut buffer) {
            Ok(0) => return Ok(hex(&hasher.finalize())),
            Ok(read) => hasher.update(&buffer[..read]),
            Err(e) if e.kind() == ErrorKind::Interrupted => {}
            Err(e) => return Err(e),
        }
    }
}

/// 決まった版が入っていれば、そのファイルの大きさ。大きさが違えば、中身を読まずに「入っていない」とする。
fn installed_bytes(spec: &ModelSpec, models_dir: &Path) -> Option<u64> {
    let path = spec.target_in(models_dir);
    let meta = fs::metadata(&path).ok()?;
    if !meta.is_file() || meta.len() != spec.bytes {
        return None;
    }
    let sha256 = sha256_of_file(&path).ok()?;
    (sha256 == spec.sha256).then_some(meta.len())
}

/// 決まった版のファイルが入っているか（SHA-256 まで確かめる）。
pub fn is_installed(spec: &ModelSpec, models_dir: &Path) -> bool {
    installed_bytes(spec, models_dir).is_some()
}

/// いまのモデルの状態。`downloading` は、取っている最中かを知っている側（アプリの状態）が渡す。
pub fn status(spec: &ModelSpec, models_dir: &Path, downloading: bool) -> ReadsModelStatus {
    let bytes = installed_bytes(spec, models_dir);
    ReadsModelStatus {
        installed: bytes.is_some(),
        bytes,
        sha256: bytes.map(|_| spec.sha256.to_string()),
        downloading,
        repo: spec.repo.to_string(),
        revision: spec.revision.to_string(),
        file: spec.file.to_string(),
        license: spec.license.to_string(),
        origin: spec.origin.to_string(),
    }
}

/// 自分で取ったファイル `source` を、決まった版のときだけ、置き場に写す。
///
/// 写しながら SHA-256 を数え、合ったときだけ、本来の名前にする（合わなければ、途中のファイルを消して、何も置かない）。
/// 大きさが違うファイルは、中身を読まずに断る（巨大なファイルを選ばれても、待たせない）。
pub fn choose_file(spec: &ModelSpec, models_dir: &Path, source: &Path) -> Result<(), ModelError> {
    let meta = fs::metadata(source).map_err(|e| ModelError::Unreadable(e.to_string()))?;
    if !meta.is_file() {
        return Err(ModelError::Unreadable("ファイルではありません".to_string()));
    }
    if meta.len() != spec.bytes {
        return Err(ModelError::NotThePinnedModel);
    }
    fs::create_dir_all(models_dir).map_err(|e| ModelError::Write(e.to_string()))?;
    let part = spec.part_in(models_dir);
    let copied = copy_counting(source, &part, spec.bytes);
    let digest = match copied {
        Ok(digest) => digest,
        Err(e) => {
            let _ = fs::remove_file(&part);
            return Err(e);
        }
    };
    if digest != spec.sha256 {
        let _ = fs::remove_file(&part);
        return Err(ModelError::NotThePinnedModel);
    }
    fs::rename(&part, spec.target_in(models_dir)).map_err(|e| {
        let _ = fs::remove_file(&part);
        ModelError::Write(e.to_string())
    })
}

/// `source` を `part` に写し、写した中身の SHA-256 を返す。`limit` バイトを超えて写さない（読んでいる間に、大きくなったときのため）。
fn copy_counting(source: &Path, part: &Path, limit: u64) -> Result<String, ModelError> {
    let mut reader = File::open(source)
        .map_err(|e| ModelError::Unreadable(e.to_string()))?
        .take(limit.saturating_add(1));
    let mut writer = File::create(part).map_err(|e| ModelError::Write(e.to_string()))?;
    let mut hasher = Sha256::new();
    let mut buffer = vec![0u8; 64 * 1024];
    let mut total = 0u64;
    loop {
        let read = match reader.read(&mut buffer) {
            Ok(0) => break,
            Ok(read) => read,
            Err(e) if e.kind() == ErrorKind::Interrupted => continue,
            Err(e) => return Err(ModelError::Unreadable(e.to_string())),
        };
        writer
            .write_all(&buffer[..read])
            .map_err(|e| ModelError::Write(e.to_string()))?;
        hasher.update(&buffer[..read]);
        total += read as u64;
    }
    writer
        .sync_all()
        .map_err(|e| ModelError::Write(e.to_string()))?;
    if total != limit {
        // 読んでいる間に、大きさが変わった
        return Err(ModelError::NotThePinnedModel);
    }
    Ok(hex(&hasher.finalize()))
}

/// 入っているモデルを消す（無ければ、何もしない）。取っている途中のファイルも、残っていれば消す。
pub fn delete_model(spec: &ModelSpec, models_dir: &Path) -> Result<(), ModelError> {
    match fs::remove_file(spec.target_in(models_dir)) {
        Ok(()) => {}
        Err(e) if e.kind() == ErrorKind::NotFound => {}
        Err(e) => return Err(ModelError::Remove(e.to_string())),
    }
    let _ = fs::remove_file(spec.part_in(models_dir));
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::ids::sha256_hex;
    use crate::reads::catalog::READS_MODEL;

    fn spec_for(content: &[u8]) -> ModelSpec {
        ModelSpec {
            sha256: Box::leak(sha256_hex(content).into_boxed_str()),
            bytes: content.len() as u64,
            ..READS_MODEL
        }
    }

    struct Fixture {
        dir: tempfile::TempDir,
    }

    impl Fixture {
        fn new() -> Fixture {
            Fixture {
                dir: tempfile::tempdir().unwrap(),
            }
        }

        fn models(&self) -> std::path::PathBuf {
            self.dir.path().join("models")
        }

        fn names(&self) -> Vec<String> {
            let mut names: Vec<String> = match fs::read_dir(self.models()) {
                Ok(entries) => entries
                    .flatten()
                    .map(|e| e.file_name().to_string_lossy().into_owned())
                    .collect(),
                Err(_) => Vec::new(),
            };
            names.sort();
            names
        }

        /// 置き場の外に、選ぶためのファイルを作る。
        fn source(&self, name: &str, content: &[u8]) -> std::path::PathBuf {
            let path = self.dir.path().join(name);
            fs::write(&path, content).unwrap();
            path
        }
    }

    #[test]
    fn the_status_of_an_empty_folder_says_not_installed_and_carries_the_origin() {
        let fx = Fixture::new();
        let status = status(&READS_MODEL, &fx.models(), false);
        assert!(!status.installed);
        assert_eq!(status.bytes, None);
        assert_eq!(status.sha256, None);
        assert!(!status.downloading);
        assert_eq!(status.repo, "hhim8826/mortal3-b40c192");
        assert_eq!(status.revision, "7784a9deddf63df03f023474116f715850d3c7a0");
        assert_eq!(status.file, "tenpai.onnx");
        assert_eq!(status.license, "AGPL-3.0");
        assert_eq!(status.origin, "天鳳の鳳凰卓 160 万局で学習");
        // 取っている最中かは、渡された値のとおり
        assert!(super::status(&READS_MODEL, &fx.models(), true).downloading);
    }

    #[test]
    fn a_file_with_the_pinned_sha256_is_installed_and_reports_its_size_and_hash() {
        let content = b"pretend this is the model".to_vec();
        let spec = spec_for(&content);
        let fx = Fixture::new();
        fs::create_dir_all(fx.models()).unwrap();
        fs::write(spec.target_in(&fx.models()), &content).unwrap();
        let status = status(&spec, &fx.models(), false);
        assert!(status.installed);
        assert_eq!(status.bytes, Some(content.len() as u64));
        assert_eq!(status.sha256.as_deref(), Some(spec.sha256));
        assert!(is_installed(&spec, &fx.models()));
    }

    #[test]
    fn a_file_with_the_right_name_but_other_contents_is_not_installed() {
        let spec = spec_for(b"the pinned bytes");
        let fx = Fixture::new();
        fs::create_dir_all(fx.models()).unwrap();
        // 同じ大きさで中身が違う
        fs::write(spec.target_in(&fx.models()), b"THE PINNED BYTES").unwrap();
        let same_size = status(&spec, &fx.models(), false);
        assert!(!same_size.installed);
        assert_eq!((same_size.bytes, same_size.sha256), (None, None));
        // 大きさも違う
        fs::write(spec.target_in(&fx.models()), b"short").unwrap();
        assert!(!is_installed(&spec, &fx.models()));
        // 名前のものがフォルダ
        fs::remove_file(spec.target_in(&fx.models())).unwrap();
        fs::create_dir(spec.target_in(&fx.models())).unwrap();
        assert!(!is_installed(&spec, &fx.models()));
    }

    #[test]
    fn a_stray_part_file_does_not_count_as_installed() {
        let content = b"the pinned bytes".to_vec();
        let spec = spec_for(&content);
        let fx = Fixture::new();
        fs::create_dir_all(fx.models()).unwrap();
        fs::write(spec.part_in(&fx.models()), &content).unwrap();
        assert!(!is_installed(&spec, &fx.models()));
    }

    #[test]
    fn the_status_has_the_json_shape_the_screen_reads() {
        let fx = Fixture::new();
        let value = serde_json::to_value(status(&READS_MODEL, &fx.models(), false)).unwrap();
        // 画面（`src/api/reads.ts` の `ReadsModelStatus`）が読む形。名前を変えるときは、画面と一緒に変える。
        assert_eq!(
            value,
            serde_json::json!({
                "installed": false,
                "bytes": null,
                "sha256": null,
                "downloading": false,
                "repo": "hhim8826/mortal3-b40c192",
                "revision": "7784a9deddf63df03f023474116f715850d3c7a0",
                "file": "tenpai.onnx",
                "license": "AGPL-3.0",
                "origin": "天鳳の鳳凰卓 160 万局で学習",
            })
        );
    }

    // ---- 選ぶ ----

    #[test]
    fn choosing_a_file_with_the_pinned_sha256_copies_it_into_the_models_folder() {
        let content = b"the pinned model".to_vec();
        let spec = spec_for(&content);
        let fx = Fixture::new();
        let source = fx.source("downloaded-by-hand.onnx", &content);
        assert_eq!(choose_file(&spec, &fx.models(), &source), Ok(()));
        assert_eq!(fs::read(spec.target_in(&fx.models())).unwrap(), content);
        // 元のファイルはそのまま。途中のファイルは残らない
        assert_eq!(fs::read(&source).unwrap(), content);
        assert_eq!(fx.names(), vec!["tenpai.onnx".to_string()]);
        assert!(is_installed(&spec, &fx.models()));
    }

    #[test]
    fn choosing_a_file_with_another_sha256_is_refused_and_leaves_nothing_behind() {
        let spec = spec_for(b"the pinned model");
        let fx = Fixture::new();
        fs::create_dir_all(fx.models()).unwrap();
        fs::write(spec.target_in(&fx.models()), b"an older file").unwrap();
        for (name, content) in [
            // 同じ大きさで、中身が違う（中身まで読んで断る）
            ("same-size.onnx", b"THE PINNED MODEL".to_vec()),
            // 大きさが違う（中身を読まずに断る）
            ("short.onnx", b"short".to_vec()),
            ("empty.onnx", Vec::new()),
            ("long.onnx", vec![0u8; 1000]),
        ] {
            let source = fx.source(name, &content);
            let error = choose_file(&spec, &fx.models(), &source).unwrap_err();
            assert_eq!(error, ModelError::NotThePinnedModel, "{name}");
            assert_eq!(
                error.to_string(),
                "このファイルは決まった読みのモデルではありません（sha256 が違います）"
            );
            // もとからあったファイルには触れず、途中のファイルも残さない
            assert_eq!(
                fs::read(spec.target_in(&fx.models())).unwrap(),
                b"an older file"
            );
            assert_eq!(fx.names(), vec!["tenpai.onnx".to_string()], "{name}");
        }
    }

    #[test]
    fn choosing_something_that_is_not_a_readable_file_is_refused() {
        let spec = spec_for(b"the pinned model");
        let fx = Fixture::new();
        let missing = fx.dir.path().join("no-such-file.onnx");
        assert!(matches!(
            choose_file(&spec, &fx.models(), &missing),
            Err(ModelError::Unreadable(_))
        ));
        let folder = fx.dir.path().join("a-folder");
        fs::create_dir(&folder).unwrap();
        assert!(matches!(
            choose_file(&spec, &fx.models(), &folder),
            Err(ModelError::Unreadable(_))
        ));
        assert!(fx.names().is_empty());
    }

    #[test]
    fn choosing_the_file_that_is_already_installed_keeps_it() {
        let content = b"the pinned model".to_vec();
        let spec = spec_for(&content);
        let fx = Fixture::new();
        fs::create_dir_all(fx.models()).unwrap();
        fs::write(spec.target_in(&fx.models()), &content).unwrap();
        assert_eq!(
            choose_file(&spec, &fx.models(), &spec.target_in(&fx.models())),
            Ok(())
        );
        assert!(is_installed(&spec, &fx.models()));
        assert_eq!(fx.names(), vec!["tenpai.onnx".to_string()]);
    }

    #[test]
    fn choosing_replaces_a_wrong_file_of_the_same_name() {
        let content = b"the pinned model".to_vec();
        let spec = spec_for(&content);
        let fx = Fixture::new();
        fs::create_dir_all(fx.models()).unwrap();
        fs::write(spec.target_in(&fx.models()), b"something else").unwrap();
        let source = fx.source("model.onnx", &content);
        assert_eq!(choose_file(&spec, &fx.models(), &source), Ok(()));
        assert!(is_installed(&spec, &fx.models()));
    }

    // ---- 消す ----

    #[test]
    fn deleting_removes_the_model_and_a_stray_part_file_and_is_harmless_when_there_is_none() {
        let content = b"the pinned model".to_vec();
        let spec = spec_for(&content);
        let fx = Fixture::new();
        // 何も無くても、エラーにならない
        assert_eq!(delete_model(&spec, &fx.models()), Ok(()));
        fs::create_dir_all(fx.models()).unwrap();
        fs::write(spec.target_in(&fx.models()), &content).unwrap();
        fs::write(spec.part_in(&fx.models()), b"half").unwrap();
        fs::write(fx.models().join("other.txt"), b"keep").unwrap();
        assert_eq!(delete_model(&spec, &fx.models()), Ok(()));
        assert!(!is_installed(&spec, &fx.models()));
        // 関係のないファイルには触れない
        assert_eq!(fx.names(), vec!["other.txt".to_string()]);
    }

    #[test]
    fn a_model_that_cannot_be_removed_is_reported() {
        let spec = spec_for(b"x");
        let fx = Fixture::new();
        // 名前のものが、中身のあるフォルダ（消せない）
        let folder = spec.target_in(&fx.models());
        fs::create_dir_all(&folder).unwrap();
        fs::write(folder.join("inside"), b"x").unwrap();
        let error = delete_model(&spec, &fx.models()).unwrap_err();
        assert!(matches!(error, ModelError::Remove(_)), "{error:?}");
        assert!(error.to_string().contains("消せませんでした"));
    }

    /// 本物のモデルが手元にあるとき（環境変数 `JANTAMA_MODEL_DIR` の `tenpai.onnx`）、決まった版として扱えること。無ければ、理由を出して通る。
    #[test]
    fn the_real_model_is_recognised_as_the_pinned_version_when_it_is_at_hand() {
        let Some(dir) = std::env::var_os("JANTAMA_MODEL_DIR") else {
            println!(
                "skip: 環境変数 JANTAMA_MODEL_DIR が無いので、本物のモデルを使う試験を飛ばします"
            );
            return;
        };
        let path = Path::new(&dir).join(READS_MODEL.file);
        if !path.is_file() {
            println!(
                "skip: {} が無いので、本物のモデルを使う試験を飛ばします",
                path.display()
            );
            return;
        }
        let fx = Fixture::new();
        assert_eq!(choose_file(&READS_MODEL, &fx.models(), &path), Ok(()));
        let status = status(&READS_MODEL, &fx.models(), false);
        assert!(status.installed);
        assert_eq!(status.bytes, Some(READS_MODEL.bytes));
        assert_eq!(delete_model(&READS_MODEL, &fx.models()), Ok(()));
        assert!(!super::status(&READS_MODEL, &fx.models(), false).installed);
    }
}
