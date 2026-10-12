//! 文字認識の失敗。画面に出せる日本語の文を持つ。

use std::fmt;

#[derive(Debug, Clone, PartialEq, Eq)]
pub enum OcrError {
    /// Windows の日本語の文字認識が使えない（言語パックが入っていない）。
    JapaneseEngineMissing,
    /// 画像のファイルを開けなかった。
    Open { path: String, reason: String },
    /// 画像を読めなかった（PNG として壊れている・小さすぎる、など）。
    Decode { path: String, reason: String },
    /// 拡大した画像が、文字認識の上限より大きい。
    TooLarge { width: u32, height: u32, max: u32 },
    /// 文字認識そのものの失敗。
    Recognize(String),
    /// 文字認識の担当のスレッドを起こせなかった・止まっていた。
    Worker(String),
    /// この OS の文字認識は、まだ作っていない（macOS 対応の途中）。
    Unsupported(String),
}

impl fmt::Display for OcrError {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        match self {
            OcrError::JapaneseEngineMissing => f.write_str(
                "Windows の日本語の文字認識が使えません。Windows の設定の「時刻と言語」→「言語と地域」で、日本語の言語パック（光学式文字認識）を入れてください。",
            ),
            OcrError::Open { path, reason } => {
                write!(f, "画像を開けませんでした: {path}（{reason}）")
            }
            OcrError::Decode { path, reason } => {
                write!(f, "画像を読めませんでした: {path}（{reason}）")
            }
            OcrError::TooLarge { width, height, max } => write!(
                f,
                "画像が大きすぎて文字認識にかけられません（{width}×{height}。上限は {max}）"
            ),
            OcrError::Recognize(reason) => write!(f, "文字認識に失敗しました: {reason}"),
            OcrError::Worker(reason) => write!(f, "文字認識の担当を動かせませんでした: {reason}"),
            OcrError::Unsupported(reason) => write!(f, "この環境では文字認識を使えません: {reason}"),
        }
    }
}

impl std::error::Error for OcrError {}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn every_message_is_japanese_and_says_what_to_do_or_what_failed() {
        let errors = [
            OcrError::JapaneseEngineMissing,
            OcrError::Open {
                path: "a.png".into(),
                reason: "x".into(),
            },
            OcrError::Decode {
                path: "a.png".into(),
                reason: "x".into(),
            },
            OcrError::TooLarge {
                width: 9000,
                height: 100,
                max: 2600,
            },
            OcrError::Recognize("x".into()),
            OcrError::Worker("x".into()),
            OcrError::Unsupported("ほげ".into()),
        ];
        for error in errors {
            let text = error.to_string();
            assert!(
                text.chars().any(|c| ('\u{3040}'..='\u{30FF}').contains(&c)
                    || ('\u{4E00}'..='\u{9FFF}').contains(&c)),
                "{text}"
            );
        }
        assert!(OcrError::JapaneseEngineMissing
            .to_string()
            .contains("言語パック"));
    }
}
