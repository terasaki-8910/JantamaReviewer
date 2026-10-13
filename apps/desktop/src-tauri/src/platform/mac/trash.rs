//! 消した半荘のごみ箱への送り方の macOS 実装（`NSFileManager` の `trashItemAtURL`）。ごみ箱へ送る口は、ここだけ（U-9）。
//!
//! Finder の「ごみ箱に入れる」と同じ動きで、「元に戻す」（Finder の「戻す」）ができる形で、~/.Trash へ移す。確認も窓も出ない。

use std::path::Path;

use objc2_foundation::{NSFileManager, NSString, NSURL};

use crate::trash::Recycler;

/// ごみ箱へ送る項目のパスを、文字にする。完全なパス（`/` から始まる）で、UTF-8 で、NUL が入っていないものだけ。
/// 相対パスは、どこを指すかが作業フォルダに左右されるので、頼まない。
pub fn recycle_path_text(path: &Path) -> Result<&str, String> {
    if !path.is_absolute() {
        return Err(format!("完全なパスではありません: {}", path.display()));
    }
    let text = path
        .to_str()
        .ok_or_else(|| format!("パスが UTF-8 ではありません: {}", path.display()))?;
    if text.contains('\0') {
        return Err(format!("パスに NUL が入っています: {}", path.display()));
    }
    Ok(text)
}

/// 本物のごみ箱へ送る。
pub struct MacRecycler;

impl Recycler for MacRecycler {
    fn recycle(&self, path: &Path) -> Result<(), String> {
        let text = recycle_path_text(path)?;
        let url = NSURL::fileURLWithPath_isDirectory(&NSString::from_str(text), path.is_dir());
        NSFileManager::defaultManager()
            .trashItemAtURL_resultingItemURL_error(&url, None)
            .map_err(|e| format!("ごみ箱へ移せませんでした: {}", e.localizedDescription()))
    }
}

/// 本物のごみ箱の道具。
pub fn recycler() -> Box<dyn Recycler> {
    Box::new(MacRecycler)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn u9_the_macos_request_accepts_only_absolute_utf8_paths_without_nul() {
        assert_eq!(
            recycle_path_text(Path::new(
                "/Users/me/JantamaReviewerData/trash/20261009-190953"
            )),
            Ok("/Users/me/JantamaReviewerData/trash/20261009-190953")
        );
        assert!(
            recycle_path_text(Path::new("data/trash/a")).is_err(),
            "相対パス"
        );
        assert!(
            recycle_path_text(Path::new("/data/tra\0sh")).is_err(),
            "NUL"
        );
    }
}
