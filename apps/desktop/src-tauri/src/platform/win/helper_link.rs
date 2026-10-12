//! 補助プログラムとの連絡の、本体の側（名前付きパイプのサーバー）。W-9。
//!
//! 本体がパイプを開き、補助プログラムが（確認なしのタスクで起動されて）つなぎにくる。つながったら、
//! 本体が割り当てと扱い方を送り（`HelperWriter`）、補助プログラムが入力を知らせてくる。
//! 届いた連絡は、`Input` にして、入力の流れ（`input_flow`）の列に入れる。つながりが切れたら `HelperLost`。
//! 切れたあとは、同じパイプで、次の補助プログラムを待つ。
//!
//! パイプは、今のユーザーだけが使える許可で作る（`protocol::pipe_sddl`）。連絡の中身は、ボタンの種類と時刻だけ。

use std::io;
use std::sync::mpsc::Sender;
use std::sync::{Arc, Mutex, PoisonError};
use std::thread;
use std::time::Duration;

use jantama_input::pipe_win::Pipe;
use jantama_input::protocol::{
    decode_line, encode_line, pipe_name, pipe_sddl, FromHelper, LineBuffer, ToHelper,
    PROTOCOL_VERSION,
};
use jantama_input::user_win::current_user_sid;

use crate::input_flow::Input;

/// 補助プログラムへの指示の窓口。つながっていないときは、何もせず `false` を返す。
#[derive(Clone, Default)]
pub struct HelperWriter {
    pipe: Arc<Mutex<Option<Arc<Pipe>>>>,
}

impl HelperWriter {
    /// つながっている補助プログラムに、指示を送る。送れたら `true`。
    pub fn send(&self, message: &ToHelper) -> bool {
        let pipe = self
            .pipe
            .lock()
            .unwrap_or_else(PoisonError::into_inner)
            .clone();
        match pipe {
            Some(pipe) => pipe.write_all(encode_line(message).as_bytes()).is_ok(),
            None => false,
        }
    }

    fn set(&self, pipe: Option<Arc<Pipe>>) {
        *self.pipe.lock().unwrap_or_else(PoisonError::into_inner) = pipe;
    }
}

/// 補助プログラムからの連絡を、どう扱うか。
#[derive(Debug, Clone, PartialEq, Eq)]
pub enum Heard {
    /// 挨拶（決まりの版も合っている）。
    Hello,
    /// 決まりの版が合わない（つなぎを切る）。
    WrongProtocol(u32),
    /// 入力の流れに渡す。
    Forward(Input),
    /// 読み飛ばす。
    Ignore,
}

/// 連絡 1 件を解釈する。挨拶の前の連絡と、2 度目の挨拶は読み飛ばす。
pub fn hear(message: FromHelper, said_hello: bool) -> Heard {
    match message {
        FromHelper::Hello { protocol } if protocol == PROTOCOL_VERSION && !said_hello => {
            Heard::Hello
        }
        FromHelper::Hello { protocol } if protocol != PROTOCOL_VERSION => {
            Heard::WrongProtocol(protocol)
        }
        _ if !said_hello => Heard::Ignore,
        FromHelper::Hello { .. } => Heard::Ignore,
        FromHelper::Ready { .. } => Heard::Forward(Input::HelperReady),
        FromHelper::Error { message } => Heard::Forward(Input::HelperFailed(message)),
        FromHelper::Trigger { t_ms } => Heard::Forward(Input::Trigger { t_ms }),
        FromHelper::Captured { input } => Heard::Forward(Input::Captured(input.into())),
        FromHelper::Cancel => Heard::Forward(Input::CancelKey),
    }
}

/// いまのユーザー用のパイプを開いて、補助プログラムを待つスレッドを起こす。
/// 同じ名前のパイプが既にある（本体を 2 つ動かしているなど）ときは、失敗する。
pub fn spawn_server(tx: Sender<Input>, writer: HelperWriter) -> io::Result<()> {
    let sid = current_user_sid()?;
    spawn_server_named(&pipe_name(&sid), &pipe_sddl(&sid), tx, writer)
}

/// 名前と許可を指定して開く（試験では、本物のアプリのパイプと混ざらない名前を使う）。
pub fn spawn_server_named(
    name: &str,
    sddl: &str,
    tx: Sender<Input>,
    writer: HelperWriter,
) -> io::Result<()> {
    let pipe = Arc::new(Pipe::create_server(name, sddl)?);
    thread::Builder::new()
        .name("helper-link".to_string())
        .spawn(move || serve_forever(&pipe, &writer, &tx))?;
    Ok(())
}

fn serve_forever(pipe: &Arc<Pipe>, writer: &HelperWriter, tx: &Sender<Input>) {
    loop {
        if let Err(e) = pipe.accept() {
            eprintln!("補助プログラムのつなぎを待てませんでした: {e}");
            thread::sleep(Duration::from_secs(1));
            continue;
        }
        writer.set(Some(Arc::clone(pipe)));
        listen(pipe, tx);
        writer.set(None);
        if tx.send(Input::HelperLost).is_err() {
            // 入力の流れが終わっている（アプリの終わり）。
            return;
        }
        pipe.disconnect();
    }
}

/// つながっている間、補助プログラムの連絡を読み続ける。切れる・読めなくなる・決まりが合わないときに戻る。
fn listen(pipe: &Pipe, tx: &Sender<Input>) {
    let mut lines = LineBuffer::new();
    let mut chunk = [0u8; 1024];
    let mut said_hello = false;
    loop {
        let read = match pipe.read(&mut chunk) {
            Ok(0) | Err(_) => return,
            Ok(n) => n,
        };
        let Ok(complete) = lines.push(&chunk[..read]) else {
            eprintln!("補助プログラムの連絡が長すぎるので、つなぎを切ります");
            return;
        };
        for line in complete {
            // 読めない連絡は、読み飛ばす。
            let Ok(message) = decode_line::<FromHelper>(&line) else {
                continue;
            };
            match hear(message, said_hello) {
                Heard::Hello => {
                    said_hello = true;
                    if tx.send(Input::HelperConnected).is_err() {
                        return;
                    }
                }
                Heard::WrongProtocol(version) => {
                    eprintln!("補助プログラムの連絡の決まりの版（{version}）が合わないので、つなぎを切ります");
                    return;
                }
                Heard::Forward(input) => {
                    if tx.send(input).is_err() {
                        return;
                    }
                }
                Heard::Ignore => {}
            }
        }
    }
}

#[cfg(test)]
mod tests {
    use std::sync::mpsc::{self, Receiver};

    use jantama_input::keys::Modifiers;
    use jantama_input::logic::{ActiveTrigger, Config, Mode, MouseButton};
    use jantama_input::protocol::{WireButton, WireTrigger};

    use super::*;

    fn test_name(tag: &str) -> String {
        let sid = current_user_sid().unwrap();
        format!("{}-linktest-{}-{tag}", pipe_name(&sid), std::process::id())
    }

    fn start(tag: &str) -> (String, HelperWriter, Receiver<Input>) {
        let name = test_name(tag);
        let sid = current_user_sid().unwrap();
        let (tx, rx) = mpsc::channel();
        let writer = HelperWriter::default();
        spawn_server_named(&name, &pipe_sddl(&sid), tx, writer.clone()).expect("開ける");
        (name, writer, rx)
    }

    fn say(client: &Pipe, message: &FromHelper) {
        client.write_all(encode_line(message).as_bytes()).unwrap();
    }

    fn next(rx: &Receiver<Input>) -> Input {
        rx.recv_timeout(Duration::from_secs(5)).expect("入力が届く")
    }

    #[test]
    fn w9_messages_are_interpreted_only_after_hello_and_only_for_the_right_protocol() {
        assert_eq!(
            hear(
                FromHelper::Hello {
                    protocol: PROTOCOL_VERSION
                },
                false
            ),
            Heard::Hello
        );
        assert_eq!(
            hear(FromHelper::Hello { protocol: 99 }, false),
            Heard::WrongProtocol(99)
        );
        assert_eq!(
            hear(FromHelper::Hello { protocol: 99 }, true),
            Heard::WrongProtocol(99)
        );
        // 2 度目の挨拶と、挨拶の前の連絡は、読み飛ばす。
        assert_eq!(
            hear(
                FromHelper::Hello {
                    protocol: PROTOCOL_VERSION
                },
                true
            ),
            Heard::Ignore
        );
        assert_eq!(hear(FromHelper::Trigger { t_ms: 1 }, false), Heard::Ignore);
        assert_eq!(hear(FromHelper::Cancel, false), Heard::Ignore);
    }

    #[test]
    fn w9_messages_after_hello_become_inputs() {
        let x1 = WireTrigger::Mouse {
            button: WireButton::X1,
        };
        assert_eq!(
            hear(
                FromHelper::Ready {
                    mouse_hook: true,
                    keyboard_hook: false
                },
                true
            ),
            Heard::Forward(Input::HelperReady)
        );
        assert_eq!(
            hear(
                FromHelper::Error {
                    message: "x".into()
                },
                true
            ),
            Heard::Forward(Input::HelperFailed("x".into()))
        );
        assert_eq!(
            hear(FromHelper::Trigger { t_ms: 42 }, true),
            Heard::Forward(Input::Trigger { t_ms: 42 })
        );
        assert_eq!(
            hear(FromHelper::Captured { input: x1 }, true),
            Heard::Forward(Input::Captured(ActiveTrigger::Mouse(MouseButton::X1)))
        );
        assert_eq!(
            hear(FromHelper::Cancel, true),
            Heard::Forward(Input::CancelKey)
        );
    }

    #[test]
    fn w9_a_helper_connecting_is_announced_its_reports_arrive_and_its_departure_is_noticed() {
        let (name, writer, rx) = start("session");
        // つながっていない間は、送れない。
        assert!(!writer.send(&ToHelper::Shutdown));

        let client = Pipe::connect(&name, Duration::from_secs(5)).unwrap();
        say(
            &client,
            &FromHelper::Hello {
                protocol: PROTOCOL_VERSION,
            },
        );
        assert_eq!(next(&rx), Input::HelperConnected);

        // 本体 → 補助プログラム: 割り当てと扱い方。
        let config = Config {
            trigger: Some(ActiveTrigger::key(0x7C, Modifiers::NONE)),
            mode: Mode::Register,
        };
        assert!(writer.send(&ToHelper::config(config)));
        let mut lines = LineBuffer::new();
        let mut chunk = [0u8; 512];
        let n = client.read(&mut chunk).unwrap();
        let got = lines.push(&chunk[..n]).unwrap();
        assert_eq!(
            decode_line::<ToHelper>(&got[0]).unwrap(),
            ToHelper::config(config)
        );

        // 補助プログラム → 本体。
        say(
            &client,
            &FromHelper::Ready {
                mouse_hook: false,
                keyboard_hook: true,
            },
        );
        assert_eq!(next(&rx), Input::HelperReady);
        say(
            &client,
            &FromHelper::Trigger {
                t_ms: 1_760_000_000_123,
            },
        );
        assert_eq!(
            next(&rx),
            Input::Trigger {
                t_ms: 1_760_000_000_123
            }
        );
        let chord = ActiveTrigger::key(0x4D, Modifiers::new(true, true, false, false));
        say(
            &client,
            &FromHelper::Captured {
                input: chord.into(),
            },
        );
        assert_eq!(next(&rx), Input::Captured(chord));
        say(&client, &FromHelper::Cancel);
        assert_eq!(next(&rx), Input::CancelKey);

        // 読めない連絡は読み飛ばし、つながりは続く。
        client.write_all(b"garbage\n{\"type\":\"nope\"}\n").unwrap();
        say(&client, &FromHelper::Trigger { t_ms: 7 });
        assert_eq!(next(&rx), Input::Trigger { t_ms: 7 });

        // 補助プログラムが居なくなった。
        drop(client);
        assert_eq!(next(&rx), Input::HelperLost);
        assert!(!writer.send(&ToHelper::Shutdown));
    }

    #[test]
    fn w9_after_a_helper_leaves_the_next_one_can_connect_to_the_same_pipe() {
        let (name, writer, rx) = start("again");
        for round in 0..2 {
            let client = Pipe::connect(&name, Duration::from_secs(5)).unwrap();
            say(
                &client,
                &FromHelper::Hello {
                    protocol: PROTOCOL_VERSION,
                },
            );
            assert_eq!(next(&rx), Input::HelperConnected, "{round} 回目");
            say(&client, &FromHelper::Trigger { t_ms: round });
            assert_eq!(next(&rx), Input::Trigger { t_ms: round });
            assert!(writer.send(&ToHelper::Shutdown));
            drop(client);
            assert_eq!(next(&rx), Input::HelperLost);
        }
    }

    #[test]
    fn w9_a_peer_with_the_wrong_protocol_version_is_cut_off_without_being_trusted() {
        let (name, writer, rx) = start("version");
        let client = Pipe::connect(&name, Duration::from_secs(5)).unwrap();
        say(&client, &FromHelper::Hello { protocol: 99 });
        // 版が合わないので、つながったことにはせず、切る。
        assert_eq!(next(&rx), Input::HelperLost);
        assert!(!writer.send(&ToHelper::Shutdown));
        drop(client);
    }

    #[test]
    fn w9_reports_before_hello_are_not_forwarded() {
        let (name, _writer, rx) = start("early");
        let client = Pipe::connect(&name, Duration::from_secs(5)).unwrap();
        say(&client, &FromHelper::Trigger { t_ms: 1 });
        say(
            &client,
            &FromHelper::Hello {
                protocol: PROTOCOL_VERSION,
            },
        );
        // 挨拶の前の押下は、入力の流れに渡らない。最初に届くのは、つながったという知らせ。
        assert_eq!(next(&rx), Input::HelperConnected);
        drop(client);
    }

    #[test]
    fn w9_a_second_server_on_the_same_name_cannot_be_started() {
        let (name, _writer, _rx) = start("dup");
        let sid = current_user_sid().unwrap();
        let (tx, _rx2) = mpsc::channel();
        assert!(spawn_server_named(&name, &pipe_sddl(&sid), tx, HelperWriter::default()).is_err());
    }
}
