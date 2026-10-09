//! 名前付きパイプ（Windows）。本体（サーバー）と補助プログラム（クライアント）の連絡に使う（W-9）。
//!
//! - サーバーは、パイプを今のユーザーだけが使える許可（`protocol::pipe_sddl`）で作る。同じ名前のパイプが既にあれば失敗する
//!   （`FILE_FLAG_FIRST_PIPE_INSTANCE`）。ほかの PC からは使えない。
//! - 読みと書きは、どちらも待ち合わせ付き（overlapped）の入出力にする。読みで待っている間に、別のスレッドから書ける。
//!   同期の入出力だと、1 つのハンドルでは、読みが終わるまで書きが待たされてしまう。
//! - クライアントは、名前付きパイプの名前（`\\.\pipe\` で始まるもの）にしかつながない。
//!   ファイルの読み書きに使う窓口ではない（tests/safety.rs が、この部品だけがファイルを開く API を使うことを確かめる）。

use std::io;
use std::mem::size_of;
use std::sync::Mutex;
use std::thread;
use std::time::{Duration, Instant};

use windows::core::PCWSTR;
use windows::Win32::Foundation::{
    CloseHandle, LocalFree, ERROR_BROKEN_PIPE, ERROR_FILE_NOT_FOUND, ERROR_IO_PENDING,
    ERROR_PIPE_BUSY, ERROR_PIPE_CONNECTED, ERROR_PIPE_NOT_CONNECTED, GENERIC_READ, GENERIC_WRITE,
    HANDLE, HLOCAL, INVALID_HANDLE_VALUE,
};
use windows::Win32::Security::Authorization::{
    ConvertStringSecurityDescriptorToSecurityDescriptorW, SDDL_REVISION_1,
};
use windows::Win32::Security::{PSECURITY_DESCRIPTOR, SECURITY_ATTRIBUTES};
use windows::Win32::Storage::FileSystem::{
    CreateFileW, ReadFile, WriteFile, FILE_FLAG_FIRST_PIPE_INSTANCE, FILE_FLAG_OVERLAPPED,
    FILE_SHARE_NONE, OPEN_EXISTING, PIPE_ACCESS_DUPLEX,
};
use windows::Win32::System::IO::{CancelIoEx, GetOverlappedResult, OVERLAPPED};
use windows::Win32::System::Pipes::{
    ConnectNamedPipe, CreateNamedPipeW, DisconnectNamedPipe, WaitNamedPipeW, PIPE_READMODE_BYTE,
    PIPE_REJECT_REMOTE_CLIENTS, PIPE_TYPE_BYTE, PIPE_WAIT,
};
use windows::Win32::System::Threading::CreateEventW;

use crate::protocol::PIPE_NAME_PREFIX;

/// パイプ 1 本の両端のどちらか。複数のスレッドで共有してよい（読みは 1 つのスレッド、書きは順番に 1 つずつ）。
pub struct Pipe {
    handle: HANDLE,
    write_lock: Mutex<()>,
}

// SAFETY: ハンドルはどのスレッドからでも使える。書きの順番は write_lock で守り、読みは呼び出し側が 1 つのスレッドにする。
unsafe impl Send for Pipe {}
unsafe impl Sync for Pipe {}

impl Drop for Pipe {
    fn drop(&mut self) {
        // SAFETY: 自分が持つハンドル。
        unsafe {
            let _ = CloseHandle(self.handle);
        }
    }
}

/// 待ち合わせ用のイベント。
struct Event(HANDLE);

impl Event {
    fn new() -> io::Result<Event> {
        // SAFETY: 手動リセット・非シグナル・名前無し。
        unsafe { CreateEventW(None, true, false, PCWSTR::null()) }
            .map(Event)
            .map_err(io::Error::from)
    }
}

impl Drop for Event {
    fn drop(&mut self) {
        // SAFETY: 自分が作ったイベント。
        unsafe {
            let _ = CloseHandle(self.0);
        }
    }
}

fn to_wide(text: &str) -> Vec<u16> {
    text.encode_utf16().chain(std::iter::once(0)).collect()
}

/// Windows のエラーを、OS のエラー番号つきの `io::Error` にする。
fn os_error(error: windows::core::Error) -> io::Error {
    io::Error::from_raw_os_error((error.code().0 as u32 & 0xFFFF) as i32)
}

fn is(error: &windows::core::Error, code: windows::Win32::Foundation::WIN32_ERROR) -> bool {
    error.code() == code.to_hresult()
}

impl Pipe {
    fn from_handle(handle: HANDLE) -> Pipe {
        Pipe {
            handle,
            write_lock: Mutex::new(()),
        }
    }

    /// サーバーとして、名前付きパイプを 1 本作る。`sddl` が、使える人の許可。
    /// 同じ名前のパイプが既にあれば失敗する（別のプロセスが先に作っていても、そのまま使わない）。
    pub fn create_server(name: &str, sddl: &str) -> io::Result<Pipe> {
        if !name.starts_with(PIPE_NAME_PREFIX) {
            return Err(io::Error::new(
                io::ErrorKind::InvalidInput,
                "名前付きパイプの名前ではありません",
            ));
        }
        let wide_name = to_wide(name);
        let wide_sddl = to_wide(sddl);
        // SAFETY: セキュリティ記述子は LocalFree で返し、パイプを作る呼び出しの間だけ使う。
        unsafe {
            let mut descriptor = PSECURITY_DESCRIPTOR::default();
            ConvertStringSecurityDescriptorToSecurityDescriptorW(
                PCWSTR(wide_sddl.as_ptr()),
                SDDL_REVISION_1,
                &mut descriptor,
                None,
            )
            .map_err(os_error)?;
            let attributes = SECURITY_ATTRIBUTES {
                nLength: size_of::<SECURITY_ATTRIBUTES>() as u32,
                lpSecurityDescriptor: descriptor.0,
                bInheritHandle: false.into(),
            };
            let handle = CreateNamedPipeW(
                PCWSTR(wide_name.as_ptr()),
                PIPE_ACCESS_DUPLEX | FILE_FLAG_OVERLAPPED | FILE_FLAG_FIRST_PIPE_INSTANCE,
                PIPE_TYPE_BYTE | PIPE_READMODE_BYTE | PIPE_WAIT | PIPE_REJECT_REMOTE_CLIENTS,
                1,
                8192,
                8192,
                0,
                Some(&attributes),
            );
            let failure = io::Error::last_os_error();
            let _ = LocalFree(Some(HLOCAL(descriptor.0)));
            if handle == INVALID_HANDLE_VALUE {
                return Err(failure);
            }
            Ok(Pipe::from_handle(handle))
        }
    }

    /// クライアントとして、名前付きパイプにつなぐ。サーバーがまだ無い・ほかの相手とつながっている間は、`timeout` まで待つ。
    /// 名前付きパイプ（`\\.\pipe\` で始まる名前）以外は開かない。
    pub fn connect(name: &str, timeout: Duration) -> io::Result<Pipe> {
        if !name.starts_with(PIPE_NAME_PREFIX) {
            return Err(io::Error::new(
                io::ErrorKind::InvalidInput,
                "名前付きパイプの名前ではありません",
            ));
        }
        let wide_name = to_wide(name);
        let deadline = Instant::now() + timeout;
        loop {
            // SAFETY: 名前は終端つきの UTF-16。
            let opened = unsafe {
                CreateFileW(
                    PCWSTR(wide_name.as_ptr()),
                    GENERIC_READ.0 | GENERIC_WRITE.0,
                    FILE_SHARE_NONE,
                    None,
                    OPEN_EXISTING,
                    FILE_FLAG_OVERLAPPED,
                    None,
                )
            };
            match opened {
                Ok(handle) => return Ok(Pipe::from_handle(handle)),
                Err(error) => {
                    let busy = is(&error, ERROR_PIPE_BUSY);
                    if !(busy || is(&error, ERROR_FILE_NOT_FOUND)) || Instant::now() >= deadline {
                        return Err(os_error(error));
                    }
                    if busy {
                        // SAFETY: 名前は終端つきの UTF-16。
                        unsafe {
                            let _ = WaitNamedPipeW(PCWSTR(wide_name.as_ptr()), 250);
                        }
                    } else {
                        thread::sleep(Duration::from_millis(100));
                    }
                }
            }
        }
    }

    /// （サーバー）相手がつながるまで待つ。`cancel_io` で、待ちをやめさせられる。
    pub fn accept(&self) -> io::Result<()> {
        let event = Event::new()?;
        let mut overlapped = OVERLAPPED {
            hEvent: event.0,
            ..Default::default()
        };
        // SAFETY: overlapped とイベントは、完了まで待つので、この関数の間は生きている。
        unsafe {
            match ConnectNamedPipe(self.handle, Some(&mut overlapped)) {
                Ok(()) => Ok(()),
                Err(error) if is(&error, ERROR_PIPE_CONNECTED) => Ok(()),
                Err(error) if is(&error, ERROR_IO_PENDING) => {
                    let mut transferred = 0u32;
                    GetOverlappedResult(self.handle, &overlapped, &mut transferred, true)
                        .map_err(os_error)
                }
                Err(error) => Err(os_error(error)),
            }
        }
    }

    /// （サーバー）つながっている相手を切り、次の相手を待てる状態に戻す。
    pub fn disconnect(&self) {
        // SAFETY: 自分のハンドル。
        unsafe {
            let _ = DisconnectNamedPipe(self.handle);
        }
    }

    /// 読む。相手が閉じたときは `Ok(0)`。ほかのスレッドが `cancel_io` したときはエラー。
    pub fn read(&self, buffer: &mut [u8]) -> io::Result<usize> {
        let event = Event::new()?;
        let mut overlapped = OVERLAPPED {
            hEvent: event.0,
            ..Default::default()
        };
        // SAFETY: buffer・overlapped・イベントは、完了まで待つので、この関数の間は生きている。
        unsafe {
            match ReadFile(self.handle, Some(buffer), None, Some(&mut overlapped)) {
                Ok(()) => {}
                Err(error) if is(&error, ERROR_IO_PENDING) => {}
                Err(error) if closed_by_peer(&error) => return Ok(0),
                Err(error) => return Err(os_error(error)),
            }
            let mut transferred = 0u32;
            match GetOverlappedResult(self.handle, &overlapped, &mut transferred, true) {
                Ok(()) => Ok(transferred as usize),
                Err(error) if closed_by_peer(&error) => Ok(0),
                Err(error) => Err(os_error(error)),
            }
        }
    }

    /// 全部書く。ほかのスレッドと混ざらないよう、1 つずつ順番に書く。
    pub fn write_all(&self, data: &[u8]) -> io::Result<()> {
        let _turn = self
            .write_lock
            .lock()
            .unwrap_or_else(std::sync::PoisonError::into_inner);
        let mut sent = 0usize;
        while sent < data.len() {
            let event = Event::new()?;
            let mut overlapped = OVERLAPPED {
                hEvent: event.0,
                ..Default::default()
            };
            // SAFETY: data・overlapped・イベントは、完了まで待つので、この繰り返しの間は生きている。
            let written = unsafe {
                match WriteFile(self.handle, Some(&data[sent..]), None, Some(&mut overlapped)) {
                    Ok(()) => {}
                    Err(error) if is(&error, ERROR_IO_PENDING) => {}
                    Err(error) => return Err(os_error(error)),
                }
                let mut transferred = 0u32;
                GetOverlappedResult(self.handle, &overlapped, &mut transferred, true)
                    .map_err(os_error)?;
                transferred as usize
            };
            if written == 0 {
                return Err(io::ErrorKind::WriteZero.into());
            }
            sent += written;
        }
        Ok(())
    }

    /// 待っている読み・つなぎの待ちを、ほかのスレッドから取り消す。
    pub fn cancel_io(&self) {
        // SAFETY: 自分のハンドル。
        unsafe {
            let _ = CancelIoEx(self.handle, None);
        }
    }
}

/// 相手が閉じた（切れた）ことを表すエラーか。
fn closed_by_peer(error: &windows::core::Error) -> bool {
    is(error, ERROR_BROKEN_PIPE) || is(error, ERROR_PIPE_NOT_CONNECTED)
}

#[cfg(test)]
mod tests {
    use std::sync::Arc;

    use super::*;
    use crate::protocol::{pipe_name, pipe_sddl};
    use crate::user_win::current_user_sid;

    /// 試験ごとに別の名前（本物のアプリが開いているパイプと混ざらない）。
    fn test_pipe_name(tag: &str) -> String {
        let sid = current_user_sid().unwrap();
        format!("{}-test-{}-{tag}", pipe_name(&sid), std::process::id())
    }

    fn read_exact_line(pipe: &Pipe) -> String {
        let mut out = Vec::new();
        let mut byte = [0u8; 1];
        loop {
            let n = pipe.read(&mut byte).expect("読める");
            if n == 0 || byte[0] == b'\n' {
                break;
            }
            out.push(byte[0]);
        }
        String::from_utf8(out).unwrap()
    }

    #[test]
    fn w9_a_client_and_the_server_exchange_lines_both_ways_at_the_same_time() {
        let sid = current_user_sid().unwrap();
        let name = test_pipe_name("duplex");
        let server = Arc::new(Pipe::create_server(&name, &pipe_sddl(&sid)).expect("作れる"));

        let accepting = {
            let server = Arc::clone(&server);
            thread::spawn(move || server.accept().expect("つながる"))
        };
        let client = Arc::new(Pipe::connect(&name, Duration::from_secs(5)).expect("つなげる"));
        accepting.join().unwrap();

        // サーバーは読みで待っている間に、別のスレッドから書ける（同期の入出力だと、ここで固まる）。
        let reader = {
            let server = Arc::clone(&server);
            thread::spawn(move || read_exact_line(&server))
        };
        thread::sleep(Duration::from_millis(100));
        server.write_all(b"to-client\n").unwrap();
        assert_eq!(read_exact_line(&client), "to-client");
        client.write_all(b"to-server\n").unwrap();
        assert_eq!(reader.join().unwrap(), "to-server");
    }

    #[test]
    fn w9_a_second_pipe_with_the_same_name_cannot_be_created() {
        let sid = current_user_sid().unwrap();
        let name = test_pipe_name("first");
        let _first = Pipe::create_server(&name, &pipe_sddl(&sid)).expect("作れる");
        assert!(
            Pipe::create_server(&name, &pipe_sddl(&sid)).is_err(),
            "先に作られているパイプを、そのまま使わない"
        );
    }

    #[test]
    fn w9_a_reader_sees_end_of_file_when_the_other_side_goes_away() {
        let sid = current_user_sid().unwrap();
        let name = test_pipe_name("eof");
        let server = Arc::new(Pipe::create_server(&name, &pipe_sddl(&sid)).unwrap());
        let accepting = {
            let server = Arc::clone(&server);
            thread::spawn(move || server.accept().unwrap())
        };
        let client = Pipe::connect(&name, Duration::from_secs(5)).unwrap();
        accepting.join().unwrap();
        drop(client);
        let mut buffer = [0u8; 16];
        assert_eq!(server.read(&mut buffer).unwrap(), 0);
    }

    #[test]
    fn w9_a_waiting_read_can_be_cancelled_from_another_thread() {
        let sid = current_user_sid().unwrap();
        let name = test_pipe_name("cancel");
        let server = Arc::new(Pipe::create_server(&name, &pipe_sddl(&sid)).unwrap());
        let accepting = {
            let server = Arc::clone(&server);
            thread::spawn(move || server.accept().unwrap())
        };
        let _client = Pipe::connect(&name, Duration::from_secs(5)).unwrap();
        accepting.join().unwrap();
        let reader = {
            let server = Arc::clone(&server);
            thread::spawn(move || server.read(&mut [0u8; 16]))
        };
        thread::sleep(Duration::from_millis(100));
        server.cancel_io();
        assert!(reader.join().unwrap().is_err(), "待ちが取り消される");
    }

    #[test]
    fn w9_connecting_to_a_missing_pipe_times_out_and_non_pipe_names_are_refused() {
        let started = Instant::now();
        let missing = Pipe::connect(&test_pipe_name("missing"), Duration::from_millis(300));
        assert!(missing.is_err());
        assert!(started.elapsed() >= Duration::from_millis(250));
        // ファイルの読み書きには使えない。
        for path in ["C:\\Windows\\win.ini", "\\\\?\\C:\\x", "pipe\\x", ""] {
            let err = Pipe::connect(path, Duration::from_millis(10)).err().expect("断る");
            assert_eq!(err.kind(), io::ErrorKind::InvalidInput, "{path}");
        }
        assert!(Pipe::create_server("C:\\x", "D:P(A;;GA;;;WD)").is_err());
    }

    #[test]
    fn w9_a_server_is_reused_for_the_next_client_after_disconnect() {
        let sid = current_user_sid().unwrap();
        let name = test_pipe_name("reuse");
        let server = Arc::new(Pipe::create_server(&name, &pipe_sddl(&sid)).unwrap());
        for round in 0..2 {
            let accepting = {
                let server = Arc::clone(&server);
                thread::spawn(move || server.accept().unwrap())
            };
            let client = Pipe::connect(&name, Duration::from_secs(5)).unwrap();
            accepting.join().unwrap();
            client.write_all(format!("round-{round}\n").as_bytes()).unwrap();
            assert_eq!(read_exact_line(&server), format!("round-{round}"));
            drop(client);
            server.disconnect();
        }
    }
}
