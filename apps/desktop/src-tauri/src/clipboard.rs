//! クリップボードの文字を読む（F1、E-15）。
//!
//! 雀魂で「牌譜を共有」→ コピーしてアプリに戻ったとき、画面（検討画面）が前面に来た時点で、クリップボードの文字を読み、
//! 牌譜リンクがあれば「この半荘を取り込みますか」と出す。牌譜リンクを探すのは画面側（エンジンの `detectPaipuLink`）で、
//! ここは文字を渡すだけ。
//!
//! 読むのは文字だけ（画像・ファイル・そのほかの形式は読まない）。書き込みはしない。
//! 牌譜リンクより明らかに長い文字（文書の丸ごとなど）は、画面に渡さない。

/// 画面に渡す文字の長さの上限（文字数）。牌譜リンクは数十文字で、前後の文があっても、この長さに収まる。
pub const MAX_CHARS: usize = 16 * 1024;

/// 読んだ文字を、画面に渡してよい形にする。空・空白だけ・長すぎるものは `None`。NUL 以降は捨てる。
pub fn normalize(text: String) -> Option<String> {
    let text = match text.find('\0') {
        Some(end) => text[..end].to_string(),
        None => text,
    };
    if text.trim().is_empty() || text.chars().count() > MAX_CHARS {
        return None;
    }
    Some(text)
}

/// クリップボードの文字を読む。文字が無い（画像だけ・空など）ときは `Ok(None)`。
/// 別のアプリがクリップボードを使っていて開けないときは、短く何度か試してから、エラーにする。
#[cfg(windows)]
pub fn read_text() -> Result<Option<String>, String> {
    use clipboard_win::{formats, is_format_avail};

    if !is_format_avail(formats::CF_UNICODETEXT) {
        return Ok(None);
    }
    let text = clipboard_win::get_clipboard_string()
        .map_err(|e| format!("クリップボードを読めませんでした: {e}"))?;
    Ok(normalize(text))
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn normal_text_passes_through_unchanged() {
        assert_eq!(normalize("abc 牌譜".into()), Some("abc 牌譜".to_string()));
        // 前後の空白や改行も、そのまま（牌譜リンクの検出が、前後の空白を無視する）。
        assert_eq!(normalize("  x\r\n".into()), Some("  x\r\n".to_string()));
    }

    #[test]
    fn empty_or_blank_text_is_nothing() {
        assert_eq!(normalize(String::new()), None);
        assert_eq!(normalize("  \r\n\t".into()), None);
        assert_eq!(normalize("\0abc".into()), None);
    }

    #[test]
    fn text_after_a_nul_is_dropped() {
        assert_eq!(normalize("abc\0def".into()), Some("abc".to_string()));
    }

    #[test]
    fn text_longer_than_the_limit_is_not_passed_on() {
        assert!(normalize("あ".repeat(MAX_CHARS)).is_some());
        assert_eq!(normalize("あ".repeat(MAX_CHARS + 1)), None);
    }
}
