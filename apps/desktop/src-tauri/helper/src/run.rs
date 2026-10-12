//! `run`: 本体のパイプにつなぎ、本体からの指示でフックを入れて、入力を知らせる（W-9）。
//!
//! 本体（パイプのサーバー）が、割り当てと扱い方（通常・テスト・登録）を送る。このプログラムは、その設定に必要な
//! フックだけを入れて、割り当てたボタンの押下と、登録の候補を、本体に知らせる。判定は本体の中のフックと同じ部品
//! （`jantama_input::logic`）。フックを入れ終えたら `ready`、入れられなければ `error` を返す。
//! 本体とのつなぎが切れたら（本体が終わったときなど）、フックを外して終わる。管理者の権限のまま、いつまでも残らない。

use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::mpsc;
use std::sync::Arc;
use std::thread;
use std::time::Duration;

use jantama_input::hook::HookStatus;
use jantama_input::hook_win;
use jantama_input::logic::{ActiveTrigger, Config};
use jantama_input::pipe_win::Pipe;
use jantama_input::protocol::{
    decode_line, encode_line, pipe_name, FromHelper, LineBuffer, ToHelper, WireMode, WireTrigger,
    PROTOCOL_VERSION,
};
use jantama_input::setup::{EXIT_BAD_ARGS, EXIT_FAILED, EXIT_OK};
use jantama_input::user_win::current_user_sid;

/// 本体のパイプが見つかるまで待つ時間。本体が、補助プログラムを起動する前にパイプを開いている。
const CONNECT_TIMEOUT: Duration = Duration::from_secs(15);

/// つないだあと、最初の指示（割り当て）が来るまで待つ時間。来なければ終わる。
const FIRST_CONFIG_TIMEOUT: Duration = Duration::from_secs(10);

/// 本体から届いた設定を、フックに渡す形にする。登録できない入力（左右のボタン、文字の入力のキー単独など）の
/// 割り当ては受け取らず、割り当て無しとして扱う。パイプの相手が本体でなくても、管理者の権限で、普通の権限では
/// 拾えない窓（管理者の窓）への文字の入力を拾ったり止めたりしないため。本体は、登録できる入力しか割り当てない。
pub fn config_from_wire(trigger: Option<WireTrigger>, mode: WireMode) -> Config {
    Config {
        trigger: trigger
            .map(ActiveTrigger::from)
            .filter(|trigger| trigger.registrable()),
        mode: mode.into(),
    }
}

/// 引数 `--pipe <名前>` から、つなぐパイプの名前を取り出す。試験で、本物のアプリのパイプと混ざらないために使う。
/// 無ければ `None`（いまのユーザーの既定の名前）。形が合わなければ `Err`。
pub fn parse_pipe_arg(args: &[String]) -> Result<Option<String>, ()> {
    match args {
        [] => Ok(None),
        [flag, name] if flag == "--pipe" && !name.is_empty() => Ok(Some(name.clone())),
        _ => Err(()),
    }
}

pub fn run(args: &[String]) -> i32 {
    let name = match parse_pipe_arg(args) {
        Ok(Some(name)) => name,
        Ok(None) => match current_user_sid() {
            Ok(sid) => pipe_name(&sid),
            Err(_) => return EXIT_FAILED,
        },
        Err(()) => return EXIT_BAD_ARGS,
    };
    let Ok(pipe) = Pipe::connect(&name, CONNECT_TIMEOUT) else {
        return EXIT_FAILED;
    };
    let pipe = Arc::new(pipe);

    // 本体への書き込みは、専用のスレッドで行う（フックの手続きは、すぐ返らなければならない）。
    // フックの知らせの出口は、プロセスの終わりまで残るので、書き込みのスレッドは「終わり」の印で終える。
    let (tx, rx) = mpsc::channel::<Outgoing>();
    let writer = {
        let pipe = Arc::clone(&pipe);
        thread::spawn(move || {
            for outgoing in rx {
                let Outgoing::Message(message) = outgoing else {
                    break;
                };
                if pipe.write_all(encode_line(&message).as_bytes()).is_err() {
                    // 書けなければ、本体は居ない。読みを止めて、終わる。
                    pipe.cancel_io();
                    break;
                }
            }
        })
    };
    let send = |tx: &mpsc::Sender<Outgoing>, message: FromHelper| {
        let _ = tx.send(Outgoing::Message(message));
    };

    let report_tx = tx.clone();
    let started = hook_win::start(Config::OFF, move |report| {
        let _ = report_tx.send(Outgoing::Message(FromHelper::from_report(report)));
    });
    let Ok((hook, _)) = started else {
        send(
            &tx,
            FromHelper::Error {
                message: "フックのスレッドを起こせませんでした".to_string(),
            },
        );
        let _ = tx.send(Outgoing::Done);
        let _ = writer.join();
        return EXIT_FAILED;
    };

    send(
        &tx,
        FromHelper::Hello {
            protocol: PROTOCOL_VERSION,
        },
    );

    // 最初の指示が来なければ終わる。
    let got_config = Arc::new(AtomicBool::new(false));
    {
        let pipe = Arc::clone(&pipe);
        let got_config = Arc::clone(&got_config);
        thread::spawn(move || {
            thread::sleep(FIRST_CONFIG_TIMEOUT);
            if !got_config.load(Ordering::SeqCst) {
                pipe.cancel_io();
            }
        });
    }

    serve(&pipe, &tx, &got_config, |config| hook.apply(config));

    hook.stop();
    let _ = tx.send(Outgoing::Done);
    let _ = writer.join();
    EXIT_OK
}

/// 書き込みのスレッドに渡すもの。
enum Outgoing {
    Message(FromHelper),
    /// ここまで書いたら終わる。
    Done,
}

/// 本体からの指示を読み続ける。つなぎが切れる・終了の指示が来る・読めない連絡が来るまで。
fn serve(
    pipe: &Pipe,
    tx: &mpsc::Sender<Outgoing>,
    got_config: &AtomicBool,
    apply: impl Fn(Config) -> HookStatus,
) {
    let mut lines = LineBuffer::new();
    let mut chunk = [0u8; 1024];
    loop {
        let read = match pipe.read(&mut chunk) {
            Ok(0) | Err(_) => return,
            Ok(n) => n,
        };
        let Ok(complete) = lines.push(&chunk[..read]) else {
            return;
        };
        for line in complete {
            match decode_line::<ToHelper>(&line) {
                Ok(ToHelper::Config { trigger, mode }) => {
                    got_config.store(true, Ordering::SeqCst);
                    let status = apply(config_from_wire(trigger, mode));
                    let reply = match status.error {
                        Some(message) => FromHelper::Error { message },
                        None => FromHelper::Ready {
                            mouse_hook: status.mouse,
                            keyboard_hook: status.keyboard,
                        },
                    };
                    let _ = tx.send(Outgoing::Message(reply));
                }
                Ok(ToHelper::Shutdown) => return,
                // 知らない指示は、読み飛ばす（新しい本体が、古い補助プログラムに新しい指示を送っても止まらない）。
                Err(_) => {}
            }
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use jantama_input::logic::{Mode, MouseButton};
    use jantama_input::protocol::WireButton;

    fn key(vk: u32, ctrl: bool, alt: bool) -> WireTrigger {
        WireTrigger::Key {
            vk,
            ctrl,
            alt,
            shift: false,
            win: false,
        }
    }

    #[test]
    fn w9_the_helper_accepts_only_registrable_triggers_from_the_pipe() {
        const F13: u32 = 0x7C;
        const KEY_A: u32 = 0x41;
        // 登録できる割り当ては、そのまま使う。
        let x1 = config_from_wire(
            Some(WireTrigger::Mouse {
                button: WireButton::X1,
            }),
            WireMode::Normal,
        );
        assert_eq!(x1.trigger, Some(ActiveTrigger::Mouse(MouseButton::X1)));
        assert_eq!(x1.mode, Mode::Normal);
        assert!(
            config_from_wire(Some(key(F13, false, false)), WireMode::Test)
                .trigger
                .is_some()
        );
        assert!(
            config_from_wire(Some(key(KEY_A, true, true)), WireMode::Normal)
                .trigger
                .is_some(),
            "Ctrl+Alt+A は登録できる"
        );
        // 文字のキー単独と、左右のボタンは、割り当て無しになる（扱い方はそのまま）。
        let typing = config_from_wire(Some(key(KEY_A, false, false)), WireMode::Test);
        assert_eq!(typing.trigger, None);
        assert_eq!(typing.mode, Mode::Test);
        for button in [WireButton::Left, WireButton::Right] {
            let config = config_from_wire(Some(WireTrigger::Mouse { button }), WireMode::Normal);
            assert_eq!(config.trigger, None, "{button:?}");
        }
        assert_eq!(
            config_from_wire(None, WireMode::Register).mode,
            Mode::Register
        );
    }

    #[test]
    fn w9_the_pipe_argument_is_optional_and_must_be_well_formed() {
        assert_eq!(parse_pipe_arg(&[]), Ok(None));
        assert_eq!(
            parse_pipe_arg(&["--pipe".to_string(), r"\\.\pipe\x".to_string()]),
            Ok(Some(r"\\.\pipe\x".to_string()))
        );
        assert_eq!(parse_pipe_arg(&["--pipe".to_string()]), Err(()));
        assert_eq!(
            parse_pipe_arg(&["--pipe".to_string(), String::new()]),
            Err(())
        );
        assert_eq!(
            parse_pipe_arg(&["--other".to_string(), "x".to_string()]),
            Err(())
        );
        assert_eq!(
            parse_pipe_arg(&["a".to_string(), "b".to_string(), "c".to_string()]),
            Err(())
        );
    }
}
