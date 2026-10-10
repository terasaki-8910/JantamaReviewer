//! mjai の結果の ID（F1）。16 桁の小文字の 16 進数（例: `f9da87cbcd7af5e9`）。
//!
//! 結果の置き場所（`/report/<ID>.json`）と、結果のページ（`/killerducky/?data=/report/<ID>.json`）の両方に出てくる。
//! ID の形を確かめるのは、ここだけにする（通信先の組み立て `report_fetch` も、窓の移動の判定 `mjai_nav` も、ここを通す）。

use std::fmt;

/// ID の桁数。
pub const REPORT_ID_LEN: usize = 16;

/// 形を確かめ済みの結果の ID。
#[derive(Debug, Clone, PartialEq, Eq, Hash)]
pub struct ReportId(String);

impl ReportId {
    /// 16 桁の小文字の 16 進数だけを受け付ける（大文字・長さの違い・空白・記号が混ざったものは受け付けない）。
    pub fn parse(text: &str) -> Option<ReportId> {
        let valid = text.len() == REPORT_ID_LEN
            && text.bytes().all(|b| matches!(b, b'0'..=b'9' | b'a'..=b'f'));
        valid.then(|| ReportId(text.to_string()))
    }

    pub fn as_str(&self) -> &str {
        &self.0
    }
}

impl fmt::Display for ReportId {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        f.write_str(&self.0)
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn only_sixteen_lowercase_hex_digits_are_an_id() {
        for ok in ["f9da87cbcd7af5e9", "0000000000000000", "0123456789abcdef"] {
            assert_eq!(ReportId::parse(ok).unwrap().as_str(), ok);
        }
        for bad in [
            "",
            "f9da87cbcd7af5e",       // 15 桁
            "f9da87cbcd7af5e90",     // 17 桁
            "F9DA87CBCD7AF5E9",      // 大文字
            "f9da87cbcd7af5eg",      // 16 進数でない文字
            " f9da87cbcd7af5e9",     // 空白
            "f9da87cbcd7af5e9\n",    // 改行
            "../etc/passwd0000",     // 区切り
            "f9da87cb.d7af5e9",      // 記号
            "ｆ9da87cbcd7af5e9",     // 全角
            "f9da87cbcd7af5e9.json", // 拡張子つき
        ] {
            assert!(ReportId::parse(bad).is_none(), "{bad:?}");
        }
    }

    #[test]
    fn display_is_the_plain_id() {
        assert_eq!(
            ReportId::parse("f9da87cbcd7af5e9").unwrap().to_string(),
            "f9da87cbcd7af5e9"
        );
    }
}
