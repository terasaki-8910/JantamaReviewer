//! クリップボードの文字の読み取りの Windows 実装（F1、E-15）。文字の形式（`CF_UNICODETEXT`）だけを読む。
//!
//! 呼ぶのは、鍵を持つ `src/clipboard.rs` の読み取りだけ（鍵の中で呼ぶ。2 つのスレッドが同時に読むと、ヒープが壊れて落ちたため）。

use clipboard_win::{formats, is_format_avail};

/// クリップボードの文字を、そのまま読む。文字が無い（画像だけ・空など）ときは `Ok(None)`。
pub fn read_string() -> Result<Option<String>, String> {
    if !is_format_avail(formats::CF_UNICODETEXT) {
        return Ok(None);
    }
    clipboard_win::get_clipboard_string()
        .map(Some)
        .map_err(|e| format!("クリップボードを読めませんでした: {e}"))
}
