//! 半荘ごとの読みの写し（`reads.json`。F23）が、いま使える写しか（D-8）。
//!
//! 解析エンジンが書いた写しは、形の名前（`jantama-reads/1`）が合い、いまのモデルで計算したもの（`model.sha256` が決まった版）で、
//! そのモデルがいま入っているときだけ使う。ひとつでも違えば「無い」ものとして返し、画面が計算し直す（モデルが替わったら作り直す）。
//! 写しは、手元のモデルでどの端末でも作り直せるので、同期にも書き出しにも入れない。

use std::fs;
use std::path::{Path, PathBuf};

use serde::de::IgnoredAny;
use serde::Deserialize;

use super::catalog::PART_SUFFIX;
use crate::store::READS_FILE;

/// 読みの写しの形の名前（`format`）。解析エンジンの `reads.json` と同じ（`engine/README.md`）。
pub const READS_FORMAT: &str = "jantama-reads/1";

/// 写しの置き場所（半荘のフォルダの中）。
pub fn reads_path(session_dir: &Path) -> PathBuf {
    session_dir.join(READS_FILE)
}

/// 計算の途中の出力先（半荘のフォルダの中の `reads.json.part`）。計算が済んで、形を確かめてから、本来の名前にする。
pub fn reads_part_path(session_dir: &Path) -> PathBuf {
    session_dir.join(format!("{READS_FILE}{PART_SUFFIX}"))
}

/// 写しの見出し。使えるかを決める欄だけを読む（場面の中身は、読み飛ばす。画面が読む）。
#[derive(Deserialize)]
struct Header {
    format: String,
    model: ModelRef,
    // 見た席と場面の一覧があること（欠けた写しを、使えるものとして渡さない）
    #[allow(dead_code)]
    player_id: u8,
    #[allow(dead_code)]
    moments: Vec<IgnoredAny>,
}

#[derive(Deserialize)]
struct ModelRef {
    sha256: String,
}

/// 写しの文字が、使える形で、`model_sha256` のモデルで計算したものか。違うときは、その理由（記録に残す文）。
pub fn check(text: &str, model_sha256: &str) -> Result<(), String> {
    let header: Header = serde_json::from_str(text).map_err(|e| format!("読めません: {e}"))?;
    if header.format != READS_FORMAT {
        return Err(format!(
            "形の名前が違います: {}（{READS_FORMAT} のはず）",
            header.format
        ));
    }
    if header.model.sha256 != model_sha256 {
        return Err("いまのモデルで計算したものではありません".to_string());
    }
    Ok(())
}

/// 半荘のフォルダの写しを、使えるときだけ返す。写しが無い・読めない・形が違う・いまのモデルのものでない・モデルが入っていない、の
/// どれでも `None`（画面が計算し直す）。`model_installed` は、モデルがいま入っているか（中身まで確かめる）を答える関数で、
/// 写しが使える形のときだけ呼ぶ（モデルを読むのを、無駄に繰り返さない）。
pub fn read_valid(
    session_dir: &Path,
    model_sha256: &str,
    model_installed: impl FnOnce() -> bool,
) -> Option<String> {
    let text = fs::read_to_string(reads_path(session_dir)).ok()?;
    check(&text, model_sha256).ok()?;
    model_installed().then_some(text)
}

#[cfg(test)]
mod tests {
    use super::*;

    const SHA: &str = "50893ddca230bd90c678086bc8e3b9fe229492b5c9f15fe8145149464b8c1cea";

    fn reads_text(format: &str, sha: &str) -> String {
        format!(
            r#"{{"format":"{format}","model":{{"file":"tenpai.onnx","sha256":"{sha}"}},"player_id":0,"moments":[{{"event_index":3}}]}}"#
        )
    }

    fn session_with(text: &str) -> tempfile::TempDir {
        let dir = tempfile::tempdir().unwrap();
        fs::write(reads_path(dir.path()), text).unwrap();
        dir
    }

    #[test]
    fn d8_a_file_of_the_right_format_made_with_the_installed_model_is_returned_as_it_is() {
        let text = reads_text(READS_FORMAT, SHA);
        let dir = session_with(&text);
        assert_eq!(read_valid(dir.path(), SHA, || true), Some(text));
        // 場面が 0 でも、形が合っていれば使える（自分の手番が無い半荘）
        let empty = format!(
            r#"{{"format":"{READS_FORMAT}","model":{{"file":"tenpai.onnx","sha256":"{SHA}"}},"player_id":2,"moments":[]}}"#
        );
        let dir = session_with(&empty);
        assert!(read_valid(dir.path(), SHA, || true).is_some());
        // 知らない欄があっても読める（あとの版が足したもの）
        let extra = reads_text(READS_FORMAT, SHA).replace("\"moments\"", "\"later\":1,\"moments\"");
        let dir = session_with(&extra);
        assert!(read_valid(dir.path(), SHA, || true).is_some());
    }

    #[test]
    fn d8_a_missing_or_unreadable_file_gives_nothing() {
        let dir = tempfile::tempdir().unwrap();
        assert_eq!(read_valid(dir.path(), SHA, || true), None);
        for broken in [
            "",
            "{ not json",
            "[]",
            "null",
            "\"jantama-reads/1\"",
            // 欠けた欄
            r#"{"format":"jantama-reads/1"}"#,
            r#"{"format":"jantama-reads/1","model":{"sha256":"x"},"player_id":0}"#,
            r#"{"format":"jantama-reads/1","moments":[],"player_id":0}"#,
            // 型が違う欄
            r#"{"format":"jantama-reads/1","model":{"sha256":7},"player_id":0,"moments":[]}"#,
            r#"{"format":"jantama-reads/1","model":{"sha256":"x"},"player_id":0,"moments":{}}"#,
        ] {
            let dir = session_with(broken);
            assert_eq!(read_valid(dir.path(), SHA, || true), None, "{broken:?}");
        }
        // 文字として読めない中身
        let dir = tempfile::tempdir().unwrap();
        fs::write(reads_path(dir.path()), [0xff, 0xfe, 0x00]).unwrap();
        assert_eq!(read_valid(dir.path(), SHA, || true), None);
    }

    #[test]
    fn d8_a_file_with_another_format_name_is_not_used() {
        for format in ["jantama-reads/2", "jantama-reads/0", "reads", ""] {
            let dir = session_with(&reads_text(format, SHA));
            assert_eq!(read_valid(dir.path(), SHA, || true), None, "{format:?}");
        }
    }

    #[test]
    fn d8_a_file_made_with_another_model_is_rebuilt_not_used() {
        let other = "0".repeat(64);
        let dir = session_with(&reads_text(READS_FORMAT, &other));
        assert_eq!(read_valid(dir.path(), SHA, || true), None);
        // 大文字・前後の空白の違いも、別のモデルとして扱う（SHA-256 の書き方は、エンジンの出力のとおりに比べる）
        let upper = reads_text(READS_FORMAT, &SHA.to_uppercase());
        let dir = session_with(&upper);
        assert_eq!(read_valid(dir.path(), SHA, || true), None);
        let spaced = reads_text(READS_FORMAT, &format!(" {SHA}"));
        let dir = session_with(&spaced);
        assert_eq!(read_valid(dir.path(), SHA, || true), None);
    }

    #[test]
    fn d8_without_the_model_installed_nothing_is_used_even_if_the_file_is_fine() {
        let dir = session_with(&reads_text(READS_FORMAT, SHA));
        assert_eq!(read_valid(dir.path(), SHA, || false), None);
    }

    #[test]
    fn d8_the_model_is_only_looked_at_when_the_file_itself_is_usable() {
        let asked = std::cell::Cell::new(0);
        let ask = || {
            asked.set(asked.get() + 1);
            true
        };
        // 写しが無い・別のモデルのもの: モデルは確かめない
        let empty = tempfile::tempdir().unwrap();
        assert_eq!(read_valid(empty.path(), SHA, ask), None);
        let other = session_with(&reads_text(READS_FORMAT, &"0".repeat(64)));
        assert_eq!(read_valid(other.path(), SHA, ask), None);
        assert_eq!(asked.get(), 0);
        // 使える形の写し: 1 回だけ確かめる
        let fine = session_with(&reads_text(READS_FORMAT, SHA));
        assert!(read_valid(fine.path(), SHA, ask).is_some());
        assert_eq!(asked.get(), 1);
    }

    #[test]
    fn the_reasons_name_what_is_wrong() {
        assert!(check("{", SHA).unwrap_err().contains("読めません"));
        assert!(check(&reads_text("x/1", SHA), SHA)
            .unwrap_err()
            .contains("形の名前"));
        assert!(check(&reads_text(READS_FORMAT, "abc"), SHA)
            .unwrap_err()
            .contains("モデル"));
        assert_eq!(check(&reads_text(READS_FORMAT, SHA), SHA), Ok(()));
    }

    #[test]
    fn the_part_file_sits_next_to_the_reads_file_with_the_part_suffix() {
        let dir = Path::new("session");
        assert_eq!(reads_path(dir), dir.join("reads.json"));
        assert_eq!(reads_part_path(dir), dir.join("reads.json.part"));
    }
}
