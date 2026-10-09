//! `install` と `uninstall`: 管理者の権限が要る、最初の 1 回だけの手続き（W-9）。
//!
//! このファイルだけが、ファイルを写す・消す・書く API と、ほかのプログラム（schtasks.exe）を動かす API を使う。
//! 補助プログラムの「ボタンを拾って知らせる」部分（run.rs と共有の部品）には、どちらも無い。
//! tests/safety.rs が、そのとおりであること（この 1 ファイルだけに許していること、ここにフックやパイプが無いこと）を確かめる。
//!
//! 流れ（install）:
//! 1. 管理者の権限で動いていること、確認で選ばれたユーザーが、本体を動かしているユーザーと同じであることを確かめる。
//! 2. 自分（jantama-helper.exe）を、管理者だけが書き込める Program Files の下に写す。
//!    普通に書き換えられる場所の実行ファイルを、確認なしの管理者のタスクに指すと、権限の昇格の穴になるため。
//! 3. タスクの定義を、その写し先のフォルダ（管理者だけが書き込める）に置いて、schtasks で登録する。置いたあとは消す。
//!
//! 結果は、終了コードで本体に返す（`jantama_input::setup` の `EXIT_*`）。

use std::ffi::c_void;
use std::fs;
use std::io;
use std::os::windows::process::CommandExt;
use std::path::{Path, PathBuf};
use std::process::{Command, Stdio};
use std::thread;
use std::time::{Duration, Instant};

use jantama_input::setup::{
    install_dir, installed_exe, parse_install_args, schtasks_create_args, schtasks_delete_args,
    schtasks_end_args, schtasks_query_args, task_xml, EXIT_BAD_ARGS, EXIT_COPY_FAILED,
    EXIT_DIFFERENT_USER, EXIT_NOT_ELEVATED, EXIT_OK, EXIT_REMOVE_FAILED, EXIT_TASK_FAILED,
};
use jantama_input::user_win::{current_user_sid, is_elevated};
use windows::Win32::System::Com::CoTaskMemFree;
use windows::Win32::System::SystemInformation::GetSystemDirectoryW;
use windows::Win32::UI::Shell::{FOLDERID_ProgramFiles, SHGetKnownFolderPath, KNOWN_FOLDER_FLAG};

/// 動いている前の補助プログラムが終わるのを待つ、最長の時間（写し先のファイルを置き換えられるまで）。
const REPLACE_TIMEOUT: Duration = Duration::from_secs(5);

/// コンソールの窓を出さずに、ほかのプログラムを動かす印。
const CREATE_NO_WINDOW: u32 = 0x0800_0000;

pub fn install(args: &[String]) -> i32 {
    let Some(sid) = parse_install_args(args) else {
        return EXIT_BAD_ARGS;
    };
    if !is_elevated() {
        return EXIT_NOT_ELEVATED;
    }
    // 確認で、別のユーザーの管理者が選ばれると、本体のパイプ（本体のユーザーだけが使える）につなげない。
    match current_user_sid() {
        Ok(own) if own == sid => {}
        _ => return EXIT_DIFFERENT_USER,
    }
    let (Ok(source), Some(program_files)) = (std::env::current_exe(), program_files()) else {
        return EXIT_COPY_FAILED;
    };
    let dir = install_dir(&program_files);
    let dest = installed_exe(&program_files);
    if fs::create_dir_all(&dir).is_err() {
        return EXIT_COPY_FAILED;
    }
    // 前の設定で動いている補助プログラムがあれば止める（動いている実行ファイルは置き換えられない）。
    let _ = schtasks(&schtasks_end_args());
    if copy_replacing(&source, &dest).is_err() {
        return EXIT_COPY_FAILED;
    }
    // タスクの定義は、管理者だけが書き込める写し先に置く（普通の権限のプログラムが、登録の直前に書き換えられない）。
    let xml_path = dir.join("task.xml");
    let xml = task_xml(&sid, &dest.to_string_lossy());
    if write_utf16(&xml_path, &xml).is_err() {
        return EXIT_TASK_FAILED;
    }
    let created = schtasks(&schtasks_create_args(&xml_path.to_string_lossy()));
    let _ = fs::remove_file(&xml_path);
    if created {
        EXIT_OK
    } else {
        EXIT_TASK_FAILED
    }
}

pub fn uninstall() -> i32 {
    if !is_elevated() {
        return EXIT_NOT_ELEVATED;
    }
    let _ = schtasks(&schtasks_end_args());
    // タスクが無いときの削除は失敗するので、無いなら外せたものとみなす。
    if !schtasks(&schtasks_delete_args()) && schtasks(&schtasks_query_args()) {
        return EXIT_TASK_FAILED;
    }
    let Some(program_files) = program_files() else {
        return EXIT_REMOVE_FAILED;
    };
    let exe = installed_exe(&program_files);
    // 動いていた補助プログラムが終わるまで、少し待って消す。
    if remove_file_waiting(&exe, REPLACE_TIMEOUT).is_err() {
        return EXIT_REMOVE_FAILED;
    }
    // フォルダが空なら消す（ほかのものがあれば、そのまま残す）。
    let _ = fs::remove_dir(install_dir(&program_files));
    EXIT_OK
}

/// 写し先に、自分の実行ファイルを写す。いったん別の名前で写してから置き換えるので、途中で止まっても、
/// 動かない実行ファイルが残らない。写し終えたファイルの大きさを、元と照らす。
fn copy_replacing(source: &Path, dest: &Path) -> io::Result<()> {
    if let (Ok(a), Ok(b)) = (fs::canonicalize(source), fs::canonicalize(dest)) {
        if a == b {
            // すでに写し先から動いている（設定し直し）。
            return Ok(());
        }
    }
    let staging = dest.with_extension("exe.new");
    fs::copy(source, &staging)?;
    if fs::metadata(&staging)?.len() != fs::metadata(source)?.len() {
        let _ = fs::remove_file(&staging);
        return Err(io::Error::other(
            "写した実行ファイルの大きさが元と合いません",
        ));
    }
    let deadline = Instant::now() + REPLACE_TIMEOUT;
    loop {
        match fs::rename(&staging, dest) {
            Ok(()) => return Ok(()),
            Err(e) if Instant::now() >= deadline => {
                let _ = fs::remove_file(&staging);
                return Err(e);
            }
            Err(_) => thread::sleep(Duration::from_millis(200)),
        }
    }
}

/// ファイルを消す。使われている間は、`timeout` まで待ってやり直す。無ければ成功。
fn remove_file_waiting(path: &Path, timeout: Duration) -> io::Result<()> {
    let deadline = Instant::now() + timeout;
    loop {
        match fs::remove_file(path) {
            Ok(()) => return Ok(()),
            Err(e) if e.kind() == io::ErrorKind::NotFound => return Ok(()),
            Err(e) if Instant::now() >= deadline => return Err(e),
            Err(_) => thread::sleep(Duration::from_millis(200)),
        }
    }
}

/// タスクスケジューラの XML は、UTF-16（先頭に BOM）で渡す。
fn write_utf16(path: &Path, text: &str) -> io::Result<()> {
    let mut bytes = vec![0xFF, 0xFE];
    for unit in text.encode_utf16() {
        bytes.extend_from_slice(&unit.to_le_bytes());
    }
    fs::write(path, bytes)
}

/// schtasks.exe を動かして、成功したか（終了コード 0）を返す。
/// 場所は、環境変数ではなく、Windows に尋ねたシステムのフォルダ。実行ファイルのあるフォルダは探さない。
fn schtasks(args: &[String]) -> bool {
    let Some(system) = system_directory() else {
        return false;
    };
    Command::new(system.join("schtasks.exe"))
        .args(args)
        .stdin(Stdio::null())
        .stdout(Stdio::null())
        .stderr(Stdio::null())
        .creation_flags(CREATE_NO_WINDOW)
        .status()
        .is_ok_and(|status| status.success())
}

/// Program Files のフォルダ（Windows に尋ねる）。
fn program_files() -> Option<PathBuf> {
    // SAFETY: 返ってきた文字列は、読んだあとに CoTaskMemFree で返す。
    unsafe {
        let path = SHGetKnownFolderPath(&FOLDERID_ProgramFiles, KNOWN_FOLDER_FLAG(0), None).ok()?;
        let text = path.to_string().ok();
        CoTaskMemFree(Some(path.0 as *const c_void));
        text.map(PathBuf::from)
    }
}

/// System32 のフォルダ（Windows に尋ねる）。
fn system_directory() -> Option<PathBuf> {
    let mut buffer = [0u16; 260];
    // SAFETY: 書き込み先は、確保済みのバッファ。
    let length = unsafe { GetSystemDirectoryW(Some(&mut buffer)) } as usize;
    if length == 0 || length >= buffer.len() {
        return None;
    }
    Some(PathBuf::from(String::from_utf16_lossy(&buffer[..length])))
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn w9_install_and_uninstall_refuse_to_run_without_administrator_rights_or_with_bad_arguments() {
        // 管理者でないとき（試験は普通の権限で動く）は、何も変えずに断る。
        if is_elevated() {
            return;
        }
        let sid = current_user_sid().unwrap();
        assert_eq!(install(&["--user-sid".to_string(), sid]), EXIT_NOT_ELEVATED);
        assert_eq!(uninstall(), EXIT_NOT_ELEVATED);
        // 形の合わない引数は、権限を見る前に断る。
        assert_eq!(install(&[]), EXIT_BAD_ARGS);
        assert_eq!(
            install(&["--user-sid".to_string(), "someone".to_string()]),
            EXIT_BAD_ARGS
        );
    }

    #[test]
    fn w9_the_install_location_and_the_system_tools_are_asked_of_windows() {
        let program_files = program_files().expect("Program Files を尋ねられる");
        assert!(program_files.is_absolute());
        assert!(program_files.to_string_lossy().contains("Program Files"));
        let system = system_directory().expect("System32 を尋ねられる");
        assert!(system.join("schtasks.exe").is_file());
    }

    #[test]
    fn w9_copy_replacing_copies_checks_the_size_and_replaces_an_existing_copy() {
        let tmp = tempfile::tempdir().unwrap();
        let source = tmp.path().join("source.exe");
        let dest = tmp.path().join("dest").join("helper.exe");
        fs::write(&source, b"new contents").unwrap();
        fs::create_dir_all(dest.parent().unwrap()).unwrap();
        fs::write(&dest, b"old").unwrap();
        copy_replacing(&source, &dest).unwrap();
        assert_eq!(fs::read(&dest).unwrap(), b"new contents");
        assert!(
            !dest.with_extension("exe.new").exists(),
            "途中のファイルを残さない"
        );
        // 写し先から動いているとき（設定し直し）は、何もしない。
        copy_replacing(&dest, &dest).unwrap();
        assert_eq!(fs::read(&dest).unwrap(), b"new contents");
    }

    #[test]
    fn w9_the_task_definition_is_written_as_utf16_with_a_byte_order_mark() {
        let tmp = tempfile::tempdir().unwrap();
        let path = tmp.path().join("task.xml");
        write_utf16(&path, "<a>雀</a>").unwrap();
        let bytes = fs::read(&path).unwrap();
        assert_eq!(&bytes[..2], &[0xFF, 0xFE]);
        let units: Vec<u16> = bytes[2..]
            .chunks_exact(2)
            .map(|c| u16::from_le_bytes([c[0], c[1]]))
            .collect();
        assert_eq!(String::from_utf16(&units).unwrap(), "<a>雀</a>");
    }

    #[test]
    fn w9_removing_a_missing_file_succeeds() {
        let tmp = tempfile::tempdir().unwrap();
        remove_file_waiting(&tmp.path().join("none.exe"), Duration::from_millis(50)).unwrap();
        let file = tmp.path().join("x.exe");
        fs::write(&file, b"x").unwrap();
        remove_file_waiting(&file, Duration::from_millis(50)).unwrap();
        assert!(!file.exists());
    }
}
