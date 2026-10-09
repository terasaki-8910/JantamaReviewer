//! 結果の JSON ファイルを直接読み込む（F1 のもう 1 つの取り込み方。mjai の窓が使えないときの代わり）。
//!
//! ファイルの選び方は、画面側のファイルを開くダイアログ（ユーザーが選んだパスだけを返す）。ここでは、そのパスのファイルを
//! 読んで、取得した結果と同じ決まりで確かめる: JSON のファイル名・大きさの上限（32 MB）・UTF-8・JSON であること。
//! 通信はしない。

use std::fmt;
use std::fs;
use std::io;
use std::path::Path;

use serde::de::IgnoredAny;

use super::report_fetch::MAX_REPORT_BYTES;

/// 結果のファイルを読めなかった理由。画面に出せる日本語の文を持つ。
#[derive(Debug)]
pub enum ReportFileError {
    /// 拡張子が `.json` ではない。
    NotJsonName,
    /// 大きさの上限を超えている。
    TooLarge(u64),
    /// ファイルを開けない・読めない。
    Io(io::Error),
    /// UTF-8 の文字ではない。
    NotUtf8,
    /// JSON ではない。
    NotJson,
}

impl fmt::Display for ReportFileError {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        match self {
            ReportFileError::NotJsonName => {
                f.write_str("結果の JSON ファイル（拡張子が .json のもの）を選んでください。")
            }
            ReportFileError::TooLarge(bytes) => write!(
                f,
                "ファイルが大きすぎます（{} MB。上限は {} MB）。",
                bytes / (1024 * 1024),
                MAX_REPORT_BYTES / (1024 * 1024)
            ),
            ReportFileError::Io(e) => write!(f, "ファイルを読めませんでした: {e}"),
            ReportFileError::NotUtf8 => f.write_str("ファイルを文字として読めませんでした。"),
            ReportFileError::NotJson => {
                f.write_str("ファイルの中身が、JSON として正しくありません。")
            }
        }
    }
}

impl std::error::Error for ReportFileError {}

impl From<io::Error> for ReportFileError {
    fn from(e: io::Error) -> Self {
        ReportFileError::Io(e)
    }
}

/// 結果の JSON ファイルを読んで、中身の文字を返す（先頭の BOM は取る）。
pub fn read_report_file(path: &Path) -> Result<String, ReportFileError> {
    let is_json = path
        .extension()
        .and_then(|e| e.to_str())
        .is_some_and(|e| e.eq_ignore_ascii_case("json"));
    if !is_json {
        return Err(ReportFileError::NotJsonName);
    }
    let size = fs::metadata(path)?.len();
    if size > MAX_REPORT_BYTES {
        return Err(ReportFileError::TooLarge(size));
    }
    let bytes = fs::read(path)?;
    let text = String::from_utf8(bytes).map_err(|_| ReportFileError::NotUtf8)?;
    let text = text.strip_prefix('\u{feff}').unwrap_or(&text).to_string();
    serde_json::from_str::<IgnoredAny>(&text).map_err(|_| ReportFileError::NotJson)?;
    Ok(text)
}

#[cfg(test)]
mod tests {
    use super::*;

    fn write(dir: &tempfile::TempDir, name: &str, bytes: &[u8]) -> std::path::PathBuf {
        let path = dir.path().join(name);
        fs::write(&path, bytes).unwrap();
        path
    }

    #[test]
    fn a_json_file_is_read_as_is() {
        let dir = tempfile::tempdir().unwrap();
        let text = r#"{"a":[1,2],"b":"日本語"}"#;
        let path = write(&dir, "report.json", text.as_bytes());
        assert_eq!(read_report_file(&path).unwrap(), text);
        let upper = write(&dir, "REPORT.JSON", text.as_bytes());
        assert_eq!(read_report_file(&upper).unwrap(), text);
    }

    #[test]
    fn a_leading_bom_is_dropped() {
        let dir = tempfile::tempdir().unwrap();
        let path = write(&dir, "bom.json", "\u{feff}{\"a\":1}".as_bytes());
        assert_eq!(read_report_file(&path).unwrap(), "{\"a\":1}");
    }

    #[test]
    fn only_json_files_that_hold_json_are_accepted() {
        let dir = tempfile::tempdir().unwrap();
        let text = write(&dir, "report.txt", b"{}");
        assert!(matches!(
            read_report_file(&text),
            Err(ReportFileError::NotJsonName)
        ));
        let none = write(&dir, "report", b"{}");
        assert!(matches!(
            read_report_file(&none),
            Err(ReportFileError::NotJsonName)
        ));
        let html = write(&dir, "page.json", b"<html>error</html>");
        assert!(matches!(
            read_report_file(&html),
            Err(ReportFileError::NotJson)
        ));
        let binary = write(&dir, "binary.json", &[0xff, 0xfe, 0x00, 0x01]);
        assert!(matches!(
            read_report_file(&binary),
            Err(ReportFileError::NotUtf8)
        ));
        let missing = dir.path().join("missing.json");
        assert!(matches!(
            read_report_file(&missing),
            Err(ReportFileError::Io(_))
        ));
    }

    #[test]
    fn a_folder_named_like_a_json_file_is_an_io_error() {
        let dir = tempfile::tempdir().unwrap();
        let folder = dir.path().join("folder.json");
        fs::create_dir(&folder).unwrap();
        assert!(matches!(
            read_report_file(&folder),
            Err(ReportFileError::Io(_))
        ));
    }

    #[test]
    fn every_error_has_a_japanese_message() {
        for error in [
            ReportFileError::NotJsonName,
            ReportFileError::TooLarge(40 * 1024 * 1024),
            ReportFileError::Io(io::Error::other("x")),
            ReportFileError::NotUtf8,
            ReportFileError::NotJson,
        ] {
            let text = error.to_string();
            assert!(
                text.chars().any(|c| ('\u{3040}'..='\u{30FF}').contains(&c)
                    || ('\u{4E00}'..='\u{9FFF}').contains(&c)),
                "{text}"
            );
        }
        assert!(ReportFileError::TooLarge(40 * 1024 * 1024)
            .to_string()
            .contains("32 MB"));
    }
}
