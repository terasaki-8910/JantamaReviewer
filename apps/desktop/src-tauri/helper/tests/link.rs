//! 補助プログラムの本物の実行ファイルを動かして、本体（パイプのサーバー）との連絡を確かめる（W-9）。
//!
//! 試験の中でサーバーを開き、`jantama-helper run --pipe <名前>` を起動する。名前は、試験ごとに別のもの
//! （本物のアプリが開いているパイプとは混ざらない）。実際に入力を注入する試験は、ここには無い。
//! フックを入れるのは、割り当てを F24 か「進む」ボタンにしたときだけで、押される可能性の低い入力に限る。
//!
//! 管理者の権限で動いている環境では、`install`・`uninstall` を呼ぶ試験は飛ばす（本当に設定してしまうため）。

#![cfg(windows)]

use std::process::{Child, Command, Stdio};
use std::sync::mpsc::{self, Receiver};
use std::sync::Arc;
use std::thread;
use std::time::{Duration, Instant};

use jantama_input::keys::Modifiers;
use jantama_input::logic::{ActiveTrigger, Config, Mode, MouseButton};
use jantama_input::pipe_win::Pipe;
use jantama_input::protocol::{
    decode_line, encode_line, pipe_name, pipe_sddl, FromHelper, LineBuffer, ToHelper,
    PROTOCOL_VERSION,
};
use jantama_input::setup::{
    install_args, EXIT_BAD_ARGS, EXIT_NOT_ELEVATED, EXIT_OK, EXIT_UNKNOWN_COMMAND,
};
use jantama_input::user_win::{current_user_sid, is_elevated};

const HELPER: &str = env!("CARGO_BIN_EXE_jantama-helper");
const F24: u32 = 0x87;

/// 試験の間、サーバーとして振る舞う側。
struct Server {
    pipe: Arc<Pipe>,
    incoming: Receiver<FromHelper>,
}

impl Server {
    /// パイプを開き、補助プログラムを起動して、つながるまで待つ。
    fn start(tag: &str) -> (Server, Child) {
        let sid = current_user_sid().unwrap();
        let name = format!(
            "{}-helpertest-{}-{tag}",
            pipe_name(&sid),
            std::process::id()
        );
        let pipe = Arc::new(Pipe::create_server(&name, &pipe_sddl(&sid)).expect("パイプを作れる"));
        let accepting = {
            let pipe = Arc::clone(&pipe);
            thread::spawn(move || pipe.accept().expect("つながる"))
        };
        let child = Command::new(HELPER)
            .args(["run", "--pipe", &name])
            .stdin(Stdio::null())
            .stdout(Stdio::null())
            .stderr(Stdio::null())
            .spawn()
            .expect("補助プログラムを起動できる");
        accepting.join().unwrap();

        let (tx, incoming) = mpsc::channel();
        {
            let pipe = Arc::clone(&pipe);
            thread::spawn(move || {
                let mut lines = LineBuffer::new();
                let mut chunk = [0u8; 512];
                while let Ok(n) = pipe.read(&mut chunk) {
                    if n == 0 {
                        return;
                    }
                    for line in lines.push(&chunk[..n]).unwrap_or_default() {
                        if let Ok(message) = decode_line::<FromHelper>(&line) {
                            if tx.send(message).is_err() {
                                return;
                            }
                        }
                    }
                }
            });
        }
        (Server { pipe, incoming }, child)
    }

    fn send(&self, message: &ToHelper) {
        self.pipe
            .write_all(encode_line(message).as_bytes())
            .expect("送れる");
    }

    fn send_config(&self, trigger: Option<ActiveTrigger>, mode: Mode) {
        self.send(&ToHelper::config(Config { trigger, mode }));
    }

    fn expect(&self) -> FromHelper {
        self.incoming
            .recv_timeout(Duration::from_secs(5))
            .expect("補助プログラムから連絡が来る")
    }
}

/// 子プロセスが、`timeout` のうちに終わるのを待って、終了コードを返す。終わらなければ止めて `None`。
fn wait_exit(child: &mut Child, timeout: Duration) -> Option<i32> {
    let deadline = Instant::now() + timeout;
    loop {
        if let Some(status) = child.try_wait().unwrap() {
            return status.code();
        }
        if Instant::now() >= deadline {
            let _ = child.kill();
            return None;
        }
        thread::sleep(Duration::from_millis(20));
    }
}

fn f24() -> Option<ActiveTrigger> {
    Some(ActiveTrigger::key(F24, Modifiers::NONE))
}

fn x2() -> Option<ActiveTrigger> {
    Some(ActiveTrigger::Mouse(MouseButton::X2))
}

#[test]
fn w9_the_helper_says_hello_applies_each_configuration_and_exits_on_shutdown() {
    let (server, mut child) = Server::start("config");
    assert_eq!(
        server.expect(),
        FromHelper::Hello {
            protocol: PROTOCOL_VERSION
        }
    );

    // キーの割り当て: キーボードのフックだけ。
    server.send_config(f24(), Mode::Normal);
    assert_eq!(
        server.expect(),
        FromHelper::Ready {
            mouse_hook: false,
            keyboard_hook: true
        }
    );
    // マウスの割り当て: マウスのフックだけ（キーボードのフックは外れる）。
    server.send_config(x2(), Mode::Test);
    assert_eq!(
        server.expect(),
        FromHelper::Ready {
            mouse_hook: true,
            keyboard_hook: false
        }
    );
    // 登録の待機中: 両方。
    server.send_config(None, Mode::Register);
    assert_eq!(
        server.expect(),
        FromHelper::Ready {
            mouse_hook: true,
            keyboard_hook: true
        }
    );
    // 何も拾わない設定: フックは 1 つも要らない。
    server.send_config(None, Mode::Normal);
    assert_eq!(
        server.expect(),
        FromHelper::Ready {
            mouse_hook: false,
            keyboard_hook: false
        }
    );

    server.send(&ToHelper::Shutdown);
    assert_eq!(wait_exit(&mut child, Duration::from_secs(5)), Some(EXIT_OK));
}

#[test]
fn w9_the_helper_exits_by_itself_when_the_app_goes_away() {
    let (server, mut child) = Server::start("goodbye");
    assert!(matches!(server.expect(), FromHelper::Hello { .. }));
    server.send_config(f24(), Mode::Normal);
    assert!(matches!(server.expect(), FromHelper::Ready { .. }));
    // 本体が終わった（パイプが切れた）。補助プログラムは、管理者の権限のまま残らずに終わる。
    server.pipe.cancel_io();
    server.pipe.disconnect();
    assert_eq!(wait_exit(&mut child, Duration::from_secs(5)), Some(EXIT_OK));
}

#[test]
fn w9_the_helper_skips_instructions_it_does_not_know() {
    let (server, mut child) = Server::start("unknown");
    assert!(matches!(server.expect(), FromHelper::Hello { .. }));
    server
        .pipe
        .write_all(b"{\"type\":\"from_the_future\",\"x\":1}\nnot json at all\n")
        .unwrap();
    server.send_config(f24(), Mode::Normal);
    assert_eq!(
        server.expect(),
        FromHelper::Ready {
            mouse_hook: false,
            keyboard_hook: true
        }
    );
    server.send(&ToHelper::Shutdown);
    assert_eq!(wait_exit(&mut child, Duration::from_secs(5)), Some(EXIT_OK));
}

#[test]
fn w9_the_helper_refuses_unknown_commands_and_malformed_arguments() {
    for (args, expected) in [
        (vec!["bogus"], EXIT_UNKNOWN_COMMAND),
        (vec!["run", "--pipe"], EXIT_BAD_ARGS),
        (vec!["run", "--elsewhere", "x"], EXIT_BAD_ARGS),
        (vec!["install"], EXIT_BAD_ARGS),
        (vec!["install", "--user-sid", "someone"], EXIT_BAD_ARGS),
    ] {
        let mut child = Command::new(HELPER)
            .args(&args)
            .stdin(Stdio::null())
            .stdout(Stdio::null())
            .stderr(Stdio::null())
            .spawn()
            .unwrap();
        assert_eq!(
            wait_exit(&mut child, Duration::from_secs(5)),
            Some(expected),
            "{args:?}"
        );
    }
}

#[test]
fn w9_install_and_uninstall_stop_at_once_when_not_run_as_administrator() {
    if is_elevated() {
        // 管理者の権限で試験を動かしているときは、本当に設定してしまうので、飛ばす。
        return;
    }
    let sid = current_user_sid().unwrap();
    let args = install_args(&sid);
    let mut install = Command::new(HELPER).args(&args).spawn().unwrap();
    assert_eq!(
        wait_exit(&mut install, Duration::from_secs(5)),
        Some(EXIT_NOT_ELEVATED)
    );
    let mut uninstall = Command::new(HELPER).arg("uninstall").spawn().unwrap();
    assert_eq!(
        wait_exit(&mut uninstall, Duration::from_secs(5)),
        Some(EXIT_NOT_ELEVATED)
    );
}
