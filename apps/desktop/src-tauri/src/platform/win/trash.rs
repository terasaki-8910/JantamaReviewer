//! 消した半荘のごみ箱への送り方の Windows 実装（`SHFileOperationW`）。ごみ箱へ送る口は、ここだけ（U-9）。

use std::os::windows::ffi::OsStrExt;
use std::path::Path;

use windows::core::PCWSTR;
use windows::Win32::Foundation::HWND;
use windows::Win32::UI::Shell::{
    SHFileOperationW, FOF_ALLOWUNDO, FOF_NOCONFIRMATION, FOF_NOERRORUI, FOF_SILENT, FO_DELETE,
    SHFILEOPSTRUCTW,
};

use crate::trash::Recycler;

/// ごみ箱へ送る（元に戻せる削除）・確認を出さない・進み具合を出さない・エラーの窓を出さない。
pub const RECYCLE_FLAGS: u16 =
    (FOF_ALLOWUNDO.0 | FOF_NOCONFIRMATION.0 | FOF_SILENT.0 | FOF_NOERRORUI.0) as u16;

/// `SHFileOperationW` に渡す、削除の頼み。
#[derive(Debug, PartialEq, Eq)]
pub struct DeleteRequest {
    /// 削除する項目のパス。UTF-16 で、終わりに NUL が 2 つ付く（項目の並びの終わりの印）。
    pub from: Vec<u16>,
    pub flags: u16,
}

/// 項目 1 つを、ごみ箱へ送る頼みにする。完全なパス（ドライブ文字から始まる）だけを受け付ける。
/// 相対パスだと、ごみ箱へ送らずに消してしまうことがあるため。`\\?\` の長いパスの書き方も、この関数は扱えない。
pub fn delete_request(path: &Path) -> Result<DeleteRequest, String> {
    if !path.is_absolute() {
        return Err(format!("完全なパスではありません: {}", path.display()));
    }
    let text = path.as_os_str();
    let mut from: Vec<u16> = text.encode_wide().collect();
    if from.starts_with(&[b'\\' as u16, b'\\' as u16, b'?' as u16, b'\\' as u16]) {
        return Err(format!("長いパスの書き方は使えません: {}", path.display()));
    }
    if from.contains(&0) {
        return Err(format!("パスに NUL が入っています: {}", path.display()));
    }
    from.push(0);
    from.push(0);
    Ok(DeleteRequest {
        from,
        flags: RECYCLE_FLAGS,
    })
}

/// 本物のごみ箱へ送る。
pub struct WindowsRecycler;

impl Recycler for WindowsRecycler {
    fn recycle(&self, path: &Path) -> Result<(), String> {
        let request = delete_request(path)?;
        let mut op = SHFILEOPSTRUCTW {
            hwnd: HWND::default(),
            wFunc: FO_DELETE,
            pFrom: PCWSTR(request.from.as_ptr()),
            pTo: PCWSTR::null(),
            fFlags: request.flags,
            ..Default::default()
        };
        // SAFETY: `op` は、この呼び出しの間だけ有効な、正しく作った構造体。`pFrom` は、終わりに NUL が 2 つ付いた
        // UTF-16 の並びで、`request.from` が呼び出しのあとまで生きている。
        let code = unsafe { SHFileOperationW(&mut op) };
        if code != 0 {
            return Err(format!("Windows のエラーコード {code:#x}"));
        }
        if op.fAnyOperationsAborted.as_bool() {
            return Err("中断されました".to_string());
        }
        Ok(())
    }
}

/// 本物のごみ箱の道具。
pub fn recycler() -> Box<dyn Recycler> {
    Box::new(WindowsRecycler)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn u9_the_windows_request_is_built_exactly_as_the_recycle_bin_needs() {
        // 試験は、本物のごみ箱を呼ばない。頼みの組み立て（パスの終わりの NUL 2 つ・旗）だけを確かめる。
        let request = delete_request(Path::new(
            r"C:\Users\me\JantamaReviewerData\trash\20261009-190953",
        ))
        .expect("完全なパスは通る");
        assert_eq!(
            &request.from[request.from.len() - 2..],
            &[0u16, 0u16],
            "NUL が 2 つで終わる"
        );
        assert!(
            !request.from[..request.from.len() - 2].contains(&0),
            "途中に NUL が無い"
        );
        let text = String::from_utf16(&request.from[..request.from.len() - 2]).unwrap();
        assert_eq!(
            text,
            r"C:\Users\me\JantamaReviewerData\trash\20261009-190953"
        );
        // 旗: ごみ箱へ送る（元に戻せる）・確認を出さない・進み具合を出さない・エラーの窓を出さない。
        // FOF_SILENT 4 + FOF_NOCONFIRMATION 16 + FOF_ALLOWUNDO 64 + FOF_NOERRORUI 1024
        assert_eq!(request.flags, 4 + 16 + 64 + 1024);
        assert_eq!(request.flags, RECYCLE_FLAGS);
        assert_ne!(
            request.flags & 64,
            0,
            "ごみ箱へ送る旗（FOF_ALLOWUNDO）が立っている"
        );
    }

    #[test]
    fn u9_the_windows_request_refuses_relative_long_form_and_nul_paths() {
        assert!(
            delete_request(Path::new(r"data\trash\a")).is_err(),
            "相対パス"
        );
        assert!(
            delete_request(Path::new(r"\trash\a")).is_err(),
            "ドライブ文字が無い"
        );
        assert!(
            delete_request(Path::new(r"\\?\C:\data\trash\a")).is_err(),
            "長いパスの書き方"
        );
        assert!(
            delete_request(Path::new("C:\\data\\tra\0sh")).is_err(),
            "NUL"
        );
    }
}
