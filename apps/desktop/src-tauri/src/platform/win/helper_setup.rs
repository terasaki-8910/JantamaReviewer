//! 補助プログラムの設定・解除・起動（W-9）。本体から、管理者の確認（UAC）を出す側。
//!
//! - 設定: 補助プログラムを「管理者として実行」（Windows の確認が出る。最初の 1 回だけ）で、`install` を付けて動かす。
//!   補助プログラムが、自分を Program Files の下に写し、確認なしで起動するタスクを登録する（helper/src/install.rs）。
//! - 起動: 以後は `schtasks /run` でそのタスクを動かすだけ。確認は出ない。本体の起動のときに行う。
//! - 解除: 同じく管理者の確認つきで、`uninstall` を付けて動かす。
//!
//! 管理者の確認は、Windows の画面に出る。ここで待つのは、その結果（補助プログラムの終了コード）だけ。

use std::io;
use std::path::{Path, PathBuf};
use std::process::{Command, Stdio};

use jantama_input::setup::{
    exit_message, install_args, join_args, schtasks_query_args, schtasks_run_args, uninstall_args,
    HELPER_EXE_NAME,
};

pub use win::{install, query_installed, run_task, uninstall};

/// 補助プログラムの実行ファイルの場所（本体の実行ファイルと同じフォルダ）。
pub fn helper_exe_in(app_dir: &Path) -> PathBuf {
    app_dir.join(HELPER_EXE_NAME)
}

/// 補助プログラムが見つからないときの文。
pub fn missing_message(path: &Path) -> String {
    format!(
        "補助プログラム（{}）が見つかりません。アプリと同じフォルダに置いてください: {}",
        HELPER_EXE_NAME,
        path.display()
    )
}

/// 管理者の確認の結果。
#[derive(Debug, PartialEq, Eq)]
pub enum ElevatedError {
    /// 確認で「いいえ」が選ばれた（または、確認が取り消された）。
    Cancelled,
    /// 動かせなかった・終わらなかった。
    Failed(String),
}

impl ElevatedError {
    /// 画面に出す文。
    pub fn message(&self) -> String {
        match self {
            ElevatedError::Cancelled => "Windows の確認が取り消されました".to_string(),
            ElevatedError::Failed(why) => why.clone(),
        }
    }
}

/// 設定・解除の終了コードを、結果にする（0 が成功）。
pub fn outcome_of(exit_code: u32) -> Result<(), String> {
    if exit_code == 0 {
        Ok(())
    } else {
        Err(exit_message(exit_code))
    }
}

/// `schtasks.exe` を、窓を出さずに動かして、終了コードを返す。
/// 場所は、環境変数ではなく、Windows に尋ねたシステムのフォルダ。
fn schtasks(system_dir: &Path, args: &[String]) -> io::Result<i32> {
    use std::os::windows::process::CommandExt;
    const CREATE_NO_WINDOW: u32 = 0x0800_0000;
    let status = Command::new(system_dir.join("schtasks.exe"))
        .args(args)
        .stdin(Stdio::null())
        .stdout(Stdio::null())
        .stderr(Stdio::null())
        .creation_flags(CREATE_NO_WINDOW)
        .status()?;
    Ok(status.code().unwrap_or(-1))
}

mod win {
    use std::ffi::OsStr;
    use std::mem::size_of;
    use std::os::windows::ffi::OsStrExt;
    use std::path::{Path, PathBuf};

    use jantama_input::user_win::current_user_sid;
    use windows::core::PCWSTR;
    use windows::Win32::Foundation::{CloseHandle, ERROR_CANCELLED, HANDLE, WAIT_OBJECT_0};
    use windows::Win32::System::Com::{CoInitializeEx, CoUninitialize, COINIT_APARTMENTTHREADED};
    use windows::Win32::System::SystemInformation::GetSystemDirectoryW;
    use windows::Win32::System::Threading::{GetExitCodeProcess, WaitForSingleObject};
    use windows::Win32::UI::Shell::{
        ShellExecuteExW, SEE_MASK_FLAG_NO_UI, SEE_MASK_NOASYNC, SEE_MASK_NOCLOSEPROCESS,
        SHELLEXECUTEINFOW,
    };
    use windows::Win32::UI::WindowsAndMessaging::SW_HIDE;

    use super::*;

    /// 管理者の確認を出す動詞。
    const ELEVATED_VERB: &str = "runas";

    /// 設定・解除が終わるのを待つ最長の時間（確認の画面を待つ時間を含む）。
    const ELEVATED_TIMEOUT_MS: u32 = 5 * 60 * 1000;

    fn wide(text: &OsStr) -> Vec<u16> {
        text.encode_wide().chain(std::iter::once(0)).collect()
    }

    fn system_directory() -> io::Result<PathBuf> {
        let mut buffer = [0u16; 260];
        // SAFETY: 書き込み先は、確保済みのバッファ。
        let length = unsafe { GetSystemDirectoryW(Some(&mut buffer)) } as usize;
        if length == 0 || length >= buffer.len() {
            return Err(io::Error::other("システムのフォルダを尋ねられません"));
        }
        Ok(PathBuf::from(String::from_utf16_lossy(&buffer[..length])))
    }

    /// 本体の実行ファイルと同じフォルダにある、補助プログラムの場所。
    fn helper_exe() -> Result<PathBuf, String> {
        let exe =
            std::env::current_exe().map_err(|e| format!("本体の場所を調べられません: {e}"))?;
        let dir = exe
            .parent()
            .ok_or_else(|| "本体のフォルダを調べられません".to_string())?;
        let helper = helper_exe_in(dir);
        if helper.is_file() {
            Ok(helper)
        } else {
            Err(missing_message(&helper))
        }
    }

    /// `verb` で `exe` を `args` つきで動かし、終わるのを待って、終了コードを返す。
    /// 実機では `runas`（管理者の確認が出る）。試験では、確認の出ない `open` で、終了コードの受け取りを確かめる。
    pub(super) fn run_with_verb(
        verb: &str,
        exe: &Path,
        args: &[String],
    ) -> Result<u32, ElevatedError> {
        let verb = wide(OsStr::new(verb));
        let file = wide(exe.as_os_str());
        let parameters = wide(OsStr::new(&join_args(args)));
        // SAFETY: 渡す文字列は、この関数の間だけ生きていて、終端つき。ハンドルは終わりに必ず閉じる。
        unsafe {
            let com = CoInitializeEx(None, COINIT_APARTMENTTHREADED).is_ok();
            let result = (|| {
                let mut info = SHELLEXECUTEINFOW {
                    cbSize: size_of::<SHELLEXECUTEINFOW>() as u32,
                    // エラーの箱は出さない（失敗は、返り値で知る）。管理者の確認は、この印とは別に出る。
                    fMask: SEE_MASK_NOCLOSEPROCESS | SEE_MASK_NOASYNC | SEE_MASK_FLAG_NO_UI,
                    lpVerb: PCWSTR(verb.as_ptr()),
                    lpFile: PCWSTR(file.as_ptr()),
                    lpParameters: PCWSTR(parameters.as_ptr()),
                    nShow: SW_HIDE.0,
                    ..Default::default()
                };
                if let Err(e) = ShellExecuteExW(&mut info) {
                    return Err(if e.code() == ERROR_CANCELLED.to_hresult() {
                        ElevatedError::Cancelled
                    } else {
                        ElevatedError::Failed(format!("補助プログラムを動かせませんでした: {e}"))
                    });
                }
                let process: HANDLE = info.hProcess;
                if process.is_invalid() {
                    return Err(ElevatedError::Failed(
                        "補助プログラムの終わりを待てません".to_string(),
                    ));
                }
                let waited = WaitForSingleObject(process, ELEVATED_TIMEOUT_MS);
                let mut code = 0u32;
                let got = GetExitCodeProcess(process, &mut code);
                let _ = CloseHandle(process);
                if waited != WAIT_OBJECT_0 {
                    return Err(ElevatedError::Failed(
                        "設定が終わりませんでした（Windows の確認に答えなかったか、時間がかかりすぎました）".to_string(),
                    ));
                }
                got.map_err(|e| ElevatedError::Failed(format!("結果を読めませんでした: {e}")))?;
                Ok(code)
            })();
            if com {
                CoUninitialize();
            }
            result
        }
    }

    fn run_elevated(exe: &Path, args: &[String]) -> Result<u32, ElevatedError> {
        run_with_verb(ELEVATED_VERB, exe, args)
    }

    /// 補助プログラムを設定する。Windows の確認が出る（最初の 1 回だけ）。
    pub fn install() -> Result<(), String> {
        let exe = helper_exe()?;
        let sid = current_user_sid().map_err(|e| format!("ユーザーを調べられません: {e}"))?;
        match run_elevated(&exe, &install_args(&sid)) {
            Ok(code) => outcome_of(code),
            Err(e) => Err(e.message()),
        }
    }

    /// 補助プログラムの設定を解除する。Windows の確認が出る。
    pub fn uninstall() -> Result<(), String> {
        let exe = helper_exe()?;
        match run_elevated(&exe, &uninstall_args()) {
            Ok(code) => outcome_of(code),
            Err(e) => Err(e.message()),
        }
    }

    /// 起動の登録（タスク）があるか。
    pub fn query_installed() -> bool {
        system_directory()
            .and_then(|dir| schtasks(&dir, &schtasks_query_args()))
            .is_ok_and(|code| code == 0)
    }

    /// 登録したタスクを動かして、補助プログラムを起動する。確認は出ない。
    /// 起動したあと、補助プログラムが本体につなぎにくる（つながったことは、パイプの側が知らせる）。
    pub fn run_task() -> Result<(), String> {
        let dir = system_directory().map_err(|e| e.to_string())?;
        match schtasks(&dir, &schtasks_run_args()) {
            Ok(0) => Ok(()),
            Ok(code) => Err(format!(
                "補助プログラムを起動できませんでした（タスクの終了コード {code}）"
            )),
            Err(e) => Err(format!("補助プログラムを起動できませんでした: {e}")),
        }
    }

    #[cfg(test)]
    mod tests {
        use super::*;

        fn cmd() -> PathBuf {
            system_directory().unwrap().join("cmd.exe")
        }

        #[test]
        fn w9_the_exit_code_of_the_launched_program_is_read_back() {
            // 確認の出ない動詞で、終了コードの受け取り（待つ・読む・閉じる）を確かめる。
            let args = ["/c".to_string(), "exit".to_string(), "7".to_string()];
            assert_eq!(run_with_verb("open", &cmd(), &args), Ok(7));
            let ok = ["/c".to_string(), "exit".to_string(), "0".to_string()];
            assert_eq!(run_with_verb("open", &cmd(), &ok), Ok(0));
        }

        /// Windows 自身のコマンドラインの読み方（CommandLineToArgvW）で、引数を読み戻す。
        fn parse_like_windows(command_line: &str) -> Vec<String> {
            use windows::Win32::Foundation::{LocalFree, HLOCAL};
            use windows::Win32::UI::Shell::CommandLineToArgvW;
            let wide_line = wide(OsStr::new(command_line));
            let mut count = 0i32;
            // SAFETY: 返ってきた配列は、読んだあとに LocalFree で返す。
            unsafe {
                let argv = CommandLineToArgvW(PCWSTR(wide_line.as_ptr()), &mut count);
                assert!(!argv.is_null());
                let args = (0..count as usize)
                    .map(|i| (*argv.add(i)).to_string().unwrap())
                    .collect();
                let _ = LocalFree(Some(HLOCAL(argv.cast())));
                args
            }
        }

        #[test]
        fn w9_the_command_line_we_build_is_read_back_by_windows_as_the_same_arguments() {
            let tricky = [
                "install",
                "--user-sid",
                "S-1-5-21-1-2-3-1001",
                "plain",
                "with space",
                "C:\\Program Files\\JantamaReviewer\\",
                "trailing backslash\\",
                "quote\"inside",
                "two\\\\\"slashes quote",
                "",
                "tab\there",
                "日本語 の パス",
            ];
            let args: Vec<String> = tricky.iter().map(|a| a.to_string()).collect();
            let line = format!("jantama-helper.exe {}", join_args(&args));
            let mut parsed = parse_like_windows(&line);
            assert_eq!(parsed.remove(0), "jantama-helper.exe");
            assert_eq!(parsed, args);
        }

        #[test]
        fn w9_a_missing_program_is_a_failure_with_a_reason_not_a_panic() {
            let result = run_with_verb("open", Path::new("C:\\no\\such\\dir\\none.exe"), &[]);
            assert!(
                matches!(result, Err(ElevatedError::Failed(_))),
                "{result:?}"
            );
        }

        #[test]
        fn w9_the_task_can_be_asked_about_without_a_window_or_a_prompt() {
            // 登録があるかないかは環境しだい。尋ねられて、真偽が返ること（落ちない・固まらない）だけを見る。
            let _ = query_installed();
        }

        #[test]
        fn w9_the_system_directory_holds_the_task_tool() {
            assert!(system_directory().unwrap().join("schtasks.exe").is_file());
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn w9_the_helper_is_looked_for_next_to_the_app() {
        assert_eq!(
            helper_exe_in(Path::new("C:\\Apps\\JantamaReviewer")),
            PathBuf::from("C:\\Apps\\JantamaReviewer\\jantama-helper.exe")
        );
        let message = missing_message(Path::new("C:\\x\\jantama-helper.exe"));
        assert!(
            message.contains("見つかりません") && message.contains("C:\\x\\jantama-helper.exe")
        );
    }

    #[test]
    fn w9_install_is_launched_with_the_users_sid_and_uninstall_with_nothing_else() {
        let sid = "S-1-5-21-1-2-3-1001";
        assert_eq!(
            join_args(&install_args(sid)),
            "install --user-sid S-1-5-21-1-2-3-1001"
        );
        assert_eq!(join_args(&uninstall_args()), "uninstall");
    }

    #[test]
    fn w9_the_exit_code_of_the_helper_becomes_a_result_with_a_message() {
        assert_eq!(outcome_of(0), Ok(()));
        let err = outcome_of(3).unwrap_err();
        assert!(err.contains("管理者"), "{err}");
        assert!(outcome_of(4).unwrap_err().contains("同じユーザー"));
        assert!(outcome_of(5).unwrap_err().contains("Program Files"));
        assert!(outcome_of(6).unwrap_err().contains("タスクスケジューラ"));
    }

    #[test]
    fn w9_a_cancelled_confirmation_has_its_own_message() {
        assert_eq!(
            ElevatedError::Cancelled.message(),
            "Windows の確認が取り消されました"
        );
        assert_eq!(ElevatedError::Failed("理由".into()).message(), "理由");
    }
}
