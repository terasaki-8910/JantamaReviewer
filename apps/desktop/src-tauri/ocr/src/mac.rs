//! macOS の文字認識（まだ作っていない。macOS 対応の段階 4 で、Vision と ImageIO で作る）。
//!
//! いまは、型と呼び方（`OcrWorker`）だけを Windows の `winrt` と同じにしてあり、どの呼び出しも「まだ対応していません」の
//! 失敗を返す。画像も画面も読まない。

use std::path::Path;

use crate::error::OcrError;
use crate::reading::Reading;

const NOT_YET: &str = "macOS の文字認識は、まだ対応していません";

/// 文字認識の担当。macOS では、まだ起こせない。
#[derive(Debug)]
pub struct OcrWorker {
    _private: (),
}

impl OcrWorker {
    /// いまは必ず失敗する（`OcrError::Unsupported`）。
    pub fn start() -> Result<OcrWorker, OcrError> {
        Err(OcrError::Unsupported(NOT_YET.to_string()))
    }

    /// 中央の板を、1 回目の画像と読み直し用の画像で読む。いまは必ず失敗する。
    pub fn read_center_variants(&self, _png: &Path) -> Result<Vec<Reading>, OcrError> {
        Err(OcrError::Unsupported(NOT_YET.to_string()))
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn the_worker_cannot_be_started_yet_and_says_so_in_japanese() {
        let error = OcrWorker::start().unwrap_err();
        assert!(matches!(error, OcrError::Unsupported(_)));
        assert!(error.to_string().contains("まだ対応していません"));
    }
}
