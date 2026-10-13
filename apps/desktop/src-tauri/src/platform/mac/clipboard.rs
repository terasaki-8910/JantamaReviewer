//! クリップボードの文字の読み取りの macOS 実装（F1、E-15）。文字の形式（`NSPasteboardTypeString`）だけを読む。
//!
//! 呼ぶのは、鍵を持つ `src/clipboard.rs` の読み取りだけ（鍵の中で呼ぶ）。書き込み・消去・ほかの形式（画像・ファイル・HTML）・
//! 変更の監視は使わない（`tests/safety.rs` の S-4）。

use objc2_app_kit::{NSPasteboard, NSPasteboardTypeString};

/// クリップボードの文字を、そのまま読む。文字が無い（画像だけ・空など）ときは `Ok(None)`。
pub fn read_string() -> Result<Option<String>, String> {
    // SAFETY: `NSPasteboardTypeString` は AppKit が持つ、変わらない定数。
    let kind = unsafe { NSPasteboardTypeString };
    let pasteboard = NSPasteboard::generalPasteboard();
    Ok(pasteboard.stringForType(kind).map(|text| text.to_string()))
}
