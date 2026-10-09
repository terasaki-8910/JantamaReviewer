//! 実行中のユーザーの SID と、管理者の権限で動いているかの確認（Windows）。
//!
//! 名前付きパイプの名前と許可（本体と補助プログラムが同じユーザーでだけつながる）に使う。
//! 自分のプロセスの情報を読むだけで、ほかのプロセスには触れない。

use std::ffi::c_void;
use std::io;
use std::mem::size_of;

use windows::core::PWSTR;
use windows::Win32::Foundation::{LocalFree, HANDLE, HLOCAL};
use windows::Win32::Security::Authorization::ConvertSidToStringSidW;
use windows::Win32::Security::{
    GetTokenInformation, TokenElevation, TokenUser, TOKEN_ELEVATION, TOKEN_USER,
};

/// 自分のプロセスのトークンを指す疑似ハンドル（`GetCurrentProcessToken` と同じ値 -4。Windows 8 以降）。
/// 開いたり閉じたりする必要が無い。
fn own_token() -> HANDLE {
    HANDLE(-4isize as *mut c_void)
}

/// 実行中のユーザーの SID の文字列（S-1-5-21-…）。管理者に昇格したプロセスでも、同じユーザーなら同じ値。
pub fn current_user_sid() -> io::Result<String> {
    // SAFETY: 疑似ハンドルは自分のプロセスのトークンを指す。バッファは返ってきた長さで確保し、8 バイトにそろえている。
    unsafe {
        let mut needed = 0u32;
        // 1 回目は、長さを知るためだけの呼び出し（足りないという失敗が普通）。
        let _ = GetTokenInformation(own_token(), TokenUser, None, 0, &mut needed);
        if needed == 0 {
            return Err(io::Error::last_os_error());
        }
        let mut buffer = vec![0u64; (needed as usize).div_ceil(size_of::<u64>())];
        GetTokenInformation(
            own_token(),
            TokenUser,
            Some(buffer.as_mut_ptr().cast::<c_void>()),
            needed,
            &mut needed,
        )
        .map_err(io::Error::from)?;
        let token_user = &*(buffer.as_ptr().cast::<TOKEN_USER>());
        let mut text = PWSTR::null();
        ConvertSidToStringSidW(token_user.User.Sid, &mut text).map_err(io::Error::from)?;
        let sid = text.to_string().map_err(io::Error::other);
        // ConvertSidToStringSidW が確保した文字列は、LocalFree で返す。
        let _ = LocalFree(Some(HLOCAL(text.0.cast::<c_void>())));
        sid
    }
}

/// 管理者の権限で動いているか（昇格したトークンか）。
pub fn is_elevated() -> bool {
    // SAFETY: 出力先は初期化済みの構造体。
    unsafe {
        let mut elevation = TOKEN_ELEVATION::default();
        let mut returned = 0u32;
        GetTokenInformation(
            own_token(),
            TokenElevation,
            Some((&mut elevation as *mut TOKEN_ELEVATION).cast::<c_void>()),
            size_of::<TOKEN_ELEVATION>() as u32,
            &mut returned,
        )
        .is_ok()
            && elevation.TokenIsElevated != 0
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::setup::is_valid_sid;

    #[test]
    fn w9_the_current_user_sid_is_a_well_formed_sid() {
        let sid = current_user_sid().expect("自分の SID を取れる");
        assert!(is_valid_sid(&sid), "{sid}");
        // 何度呼んでも同じ。
        assert_eq!(current_user_sid().unwrap(), sid);
    }

    #[test]
    fn w9_the_elevation_check_does_not_fail() {
        // 昇格しているかどうかは実行する環境しだいなので、値は問わない（呼べて、真偽が返ること）。
        let _ = is_elevated();
    }
}
