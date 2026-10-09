//! 本体と補助プログラムの連絡の決まり（W-9）。名前付きパイプの上で、1 行 1 件の JSON をやり取りする。
//!
//! - 本体 → 補助プログラム: 割り当てと扱い方（`Config`）、終了（`Shutdown`）
//! - 補助プログラム → 本体: つながったこと（`Hello`）、フックを入れ終えたこと（`Ready`）・入れられなかったこと（`Error`）、
//!   割り当てたボタンが押されたこと（`Trigger`）、登録の候補（`Captured`）、登録をやめる合図（`Cancel`）
//!
//! 補助プログラムが運ぶのは、ボタンの種類と時刻だけ。画面・ファイル・ネットのものは何も運ばない。

use serde::de::DeserializeOwned;
use serde::{Deserialize, Serialize};

use crate::keys::Modifiers;
use crate::logic::{ActiveTrigger, Chord, Config, Mode, MouseButton, Report};

/// 連絡の決まりの版。合わなければ、つなぎ直さずに補助プログラムを使わない。
pub const PROTOCOL_VERSION: u32 = 1;

/// 1 行の最大の長さ。これを超える行は、相手の不具合として切る。
pub const MAX_LINE_BYTES: usize = 4096;

/// 名前付きパイプの名前の前の部分。
pub const PIPE_NAME_PREFIX: &str = r"\\.\pipe\";

/// 本体が開く名前付きパイプの名前。ユーザーごとに別の名前にする（同じ PC のほかのユーザーのものと混ざらない）。
pub fn pipe_name(user_sid: &str) -> String {
    format!("{PIPE_NAME_PREFIX}jantama-reviewer-helper-{user_sid}")
}

/// パイプを使える人を、いまのユーザーだけにする許可（SDDL）。ファイルの読み書きの権利（FILE_GENERIC_READ と
/// FILE_GENERIC_WRITE、0x12019f）をユーザー本人の SID にだけ与え、継承はしない（`P`）。
/// 管理者として動く補助プログラムも、同じユーザーの昇格した権限（同じ SID）なので、つなげる。
pub fn pipe_sddl(user_sid: &str) -> String {
    format!("D:P(A;;0x12019f;;;{user_sid})")
}

/// 連絡の中のボタンの名前。
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "lowercase")]
pub enum WireButton {
    Left,
    Right,
    Middle,
    X1,
    X2,
}

impl From<MouseButton> for WireButton {
    fn from(button: MouseButton) -> Self {
        match button {
            MouseButton::Left => WireButton::Left,
            MouseButton::Right => WireButton::Right,
            MouseButton::Middle => WireButton::Middle,
            MouseButton::X1 => WireButton::X1,
            MouseButton::X2 => WireButton::X2,
        }
    }
}

impl From<WireButton> for MouseButton {
    fn from(button: WireButton) -> Self {
        match button {
            WireButton::Left => MouseButton::Left,
            WireButton::Right => MouseButton::Right,
            WireButton::Middle => MouseButton::Middle,
            WireButton::X1 => MouseButton::X1,
            WireButton::X2 => MouseButton::X2,
        }
    }
}

/// 連絡の中の割り当て（ボタン、またはキーと修飾キー）。
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(tag = "kind", rename_all = "snake_case")]
pub enum WireTrigger {
    Mouse {
        button: WireButton,
    },
    Key {
        /// 仮想キーコード（VK_*）。
        vk: u32,
        #[serde(default)]
        ctrl: bool,
        #[serde(default)]
        alt: bool,
        #[serde(default)]
        shift: bool,
        #[serde(default)]
        win: bool,
    },
}

impl From<ActiveTrigger> for WireTrigger {
    fn from(trigger: ActiveTrigger) -> Self {
        match trigger {
            ActiveTrigger::Mouse(button) => WireTrigger::Mouse {
                button: button.into(),
            },
            ActiveTrigger::Key(chord) => WireTrigger::Key {
                vk: chord.vk,
                ctrl: chord.mods.ctrl,
                alt: chord.mods.alt,
                shift: chord.mods.shift,
                win: chord.mods.win,
            },
        }
    }
}

impl From<WireTrigger> for ActiveTrigger {
    fn from(trigger: WireTrigger) -> Self {
        match trigger {
            WireTrigger::Mouse { button } => ActiveTrigger::Mouse(button.into()),
            WireTrigger::Key {
                vk,
                ctrl,
                alt,
                shift,
                win,
            } => ActiveTrigger::Key(Chord {
                vk,
                mods: Modifiers::new(ctrl, alt, shift, win),
            }),
        }
    }
}

/// 連絡の中の扱い方。
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum WireMode {
    Normal,
    Test,
    Register,
}

impl From<Mode> for WireMode {
    fn from(mode: Mode) -> Self {
        match mode {
            Mode::Normal => WireMode::Normal,
            Mode::Test => WireMode::Test,
            Mode::Register => WireMode::Register,
        }
    }
}

impl From<WireMode> for Mode {
    fn from(mode: WireMode) -> Self {
        match mode {
            WireMode::Normal => Mode::Normal,
            WireMode::Test => Mode::Test,
            WireMode::Register => Mode::Register,
        }
    }
}

/// 本体 → 補助プログラム。
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(tag = "type", rename_all = "snake_case")]
pub enum ToHelper {
    /// 割り当てと扱い方。変わるたびに送る。割り当てが無ければ `trigger` は `null`。
    Config {
        trigger: Option<WireTrigger>,
        mode: WireMode,
    },
    /// 終了してよい。
    Shutdown,
}

impl ToHelper {
    pub fn config(config: Config) -> ToHelper {
        ToHelper::Config {
            trigger: config.trigger.map(WireTrigger::from),
            mode: config.mode.into(),
        }
    }
}

/// 補助プログラム → 本体。
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(tag = "type", rename_all = "snake_case")]
pub enum FromHelper {
    /// つながった。最初に 1 度だけ送る。
    Hello { protocol: u32 },
    /// 受け取った設定どおりにフックを入れ終えた（要らないフックは入れていない）。
    Ready {
        mouse_hook: bool,
        keyboard_hook: bool,
    },
    /// 受け取った設定のフックを入れられなかった。
    Error { message: String },
    /// 割り当てたボタンが押された。
    Trigger { t_ms: i64 },
    /// 登録の待機中に、候補の入力が押された。
    Captured { input: WireTrigger },
    /// 登録の待機中に Esc が押された。
    Cancel,
}

impl FromHelper {
    pub fn from_report(report: Report) -> FromHelper {
        match report {
            Report::Trigger { t_ms } => FromHelper::Trigger { t_ms },
            Report::Captured(trigger) => FromHelper::Captured {
                input: trigger.into(),
            },
            Report::Cancel => FromHelper::Cancel,
        }
    }
}

/// 連絡の読み取りの失敗。
#[derive(Debug, Clone, PartialEq, Eq)]
pub enum ProtocolError {
    /// 1 行が長すぎる。
    LineTooLong,
    /// JSON として読めない・知らない種類。
    Malformed(String),
}

impl std::fmt::Display for ProtocolError {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        match self {
            ProtocolError::LineTooLong => write!(f, "連絡の 1 行が長すぎます（{MAX_LINE_BYTES} バイト超）"),
            ProtocolError::Malformed(why) => write!(f, "連絡を読めません: {why}"),
        }
    }
}

impl std::error::Error for ProtocolError {}

/// 1 件を、改行で終わる 1 行の JSON にする。
pub fn encode_line<T: Serialize>(message: &T) -> String {
    let mut line = serde_json::to_string(message).expect("連絡は JSON にできる");
    line.push('\n');
    line
}

/// 1 行を読む。
pub fn decode_line<T: DeserializeOwned>(line: &str) -> Result<T, ProtocolError> {
    serde_json::from_str(line.trim()).map_err(|e| ProtocolError::Malformed(e.to_string()))
}

/// パイプから届いたバイト列を、1 行ずつに分ける。途中で切れた行は、次のバイト列と合わせる。
#[derive(Debug, Default)]
pub struct LineBuffer {
    pending: Vec<u8>,
}

impl LineBuffer {
    pub fn new() -> LineBuffer {
        LineBuffer::default()
    }

    /// バイト列を足して、そろった行（改行と末尾の復帰は除く）を返す。
    /// 改行が来ないまま `MAX_LINE_BYTES` を超えたら、`LineTooLong`（相手の不具合として、つなぎを切る）。
    pub fn push(&mut self, bytes: &[u8]) -> Result<Vec<String>, ProtocolError> {
        let mut lines = Vec::new();
        for &byte in bytes {
            if byte == b'\n' {
                let mut line = std::mem::take(&mut self.pending);
                if line.last() == Some(&b'\r') {
                    line.pop();
                }
                if !line.is_empty() {
                    lines.push(String::from_utf8_lossy(&line).into_owned());
                }
            } else {
                self.pending.push(byte);
                if self.pending.len() > MAX_LINE_BYTES {
                    self.pending.clear();
                    return Err(ProtocolError::LineTooLong);
                }
            }
        }
        Ok(lines)
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::keys::Modifiers;

    fn chord(vk: u32, ctrl: bool, alt: bool) -> ActiveTrigger {
        ActiveTrigger::key(vk, Modifiers::new(ctrl, alt, false, false))
    }

    #[test]
    fn w9_the_pipe_is_named_per_user_and_only_that_user_may_open_it() {
        let sid = "S-1-5-21-1-2-3-1001";
        assert_eq!(
            pipe_name(sid),
            r"\\.\pipe\jantama-reviewer-helper-S-1-5-21-1-2-3-1001"
        );
        assert!(pipe_name(sid).starts_with(PIPE_NAME_PREFIX));
        assert_ne!(pipe_name(sid), pipe_name("S-1-5-21-1-2-3-1002"));
        // 許可は、そのユーザーの SID の 1 件だけ。ほかの人・Everyone・認証済みユーザーには与えない。
        assert_eq!(pipe_sddl(sid), "D:P(A;;0x12019f;;;S-1-5-21-1-2-3-1001)");
        let sddl = pipe_sddl(sid);
        assert_eq!(sddl.matches("(A;").count(), 1);
        for broad in [";WD)", ";AU)", ";BU)", ";AN)", ";IU)"] {
            assert!(!sddl.contains(broad), "{broad}");
        }
    }

    #[test]
    fn w9_the_configuration_sent_to_the_helper_has_a_stable_json_shape() {
        let mouse = ToHelper::config(Config {
            trigger: Some(ActiveTrigger::Mouse(MouseButton::X1)),
            mode: Mode::Normal,
        });
        assert_eq!(
            encode_line(&mouse),
            "{\"type\":\"config\",\"trigger\":{\"kind\":\"mouse\",\"button\":\"x1\"},\"mode\":\"normal\"}\n"
        );
        let key = ToHelper::config(Config {
            trigger: Some(chord(0x4D, true, true)),
            mode: Mode::Register,
        });
        assert_eq!(
            encode_line(&key),
            "{\"type\":\"config\",\"trigger\":{\"kind\":\"key\",\"vk\":77,\"ctrl\":true,\"alt\":true,\"shift\":false,\"win\":false},\"mode\":\"register\"}\n"
        );
        let none = ToHelper::config(Config::OFF);
        assert_eq!(
            encode_line(&none),
            "{\"type\":\"config\",\"trigger\":null,\"mode\":\"normal\"}\n"
        );
        assert_eq!(encode_line(&ToHelper::Shutdown), "{\"type\":\"shutdown\"}\n");
    }

    #[test]
    fn w9_every_message_survives_a_round_trip() {
        let to_helper = [
            ToHelper::config(Config::OFF),
            ToHelper::config(Config {
                trigger: Some(ActiveTrigger::Mouse(MouseButton::Middle)),
                mode: Mode::Test,
            }),
            ToHelper::config(Config {
                trigger: Some(chord(0x7C, false, false)),
                mode: Mode::Normal,
            }),
            ToHelper::Shutdown,
        ];
        for message in to_helper {
            let line = encode_line(&message);
            assert!(line.ends_with('\n') && !line[..line.len() - 1].contains('\n'));
            assert_eq!(decode_line::<ToHelper>(&line).unwrap(), message);
        }
        let from_helper = [
            FromHelper::Hello {
                protocol: PROTOCOL_VERSION,
            },
            FromHelper::Ready {
                mouse_hook: true,
                keyboard_hook: false,
            },
            FromHelper::Error {
                message: "フックを入れられません".into(),
            },
            FromHelper::Trigger {
                t_ms: 1_760_000_000_123,
            },
            FromHelper::Captured {
                input: ActiveTrigger::Mouse(MouseButton::X2).into(),
            },
            FromHelper::Captured {
                input: chord(0x4D, true, true).into(),
            },
            FromHelper::Cancel,
        ];
        for message in from_helper {
            let line = encode_line(&message);
            assert_eq!(decode_line::<FromHelper>(&line).unwrap(), message);
        }
    }

    #[test]
    fn w9_reports_from_the_hook_become_the_messages_the_server_understands() {
        assert_eq!(
            FromHelper::from_report(Report::Trigger { t_ms: 42 }),
            FromHelper::Trigger { t_ms: 42 }
        );
        assert_eq!(
            FromHelper::from_report(Report::Captured(ActiveTrigger::Mouse(MouseButton::X1))),
            FromHelper::Captured {
                input: WireTrigger::Mouse {
                    button: WireButton::X1
                }
            }
        );
        assert_eq!(FromHelper::from_report(Report::Cancel), FromHelper::Cancel);
    }

    #[test]
    fn w9_wire_triggers_convert_back_to_the_same_active_trigger() {
        for trigger in [
            ActiveTrigger::Mouse(MouseButton::X1),
            ActiveTrigger::Mouse(MouseButton::Middle),
            chord(0x7C, false, false),
            ActiveTrigger::key(0x4D, Modifiers::new(true, true, true, true)),
        ] {
            assert_eq!(ActiveTrigger::from(WireTrigger::from(trigger)), trigger);
        }
        assert_eq!(Mode::from(WireMode::from(Mode::Register)), Mode::Register);
    }

    #[test]
    fn w9_a_key_without_modifier_flags_is_read_with_all_flags_off() {
        let message: ToHelper =
            decode_line("{\"type\":\"config\",\"trigger\":{\"kind\":\"key\",\"vk\":124},\"mode\":\"normal\"}")
                .unwrap();
        assert_eq!(
            message,
            ToHelper::Config {
                trigger: Some(WireTrigger::Key {
                    vk: 124,
                    ctrl: false,
                    alt: false,
                    shift: false,
                    win: false
                }),
                mode: WireMode::Normal
            }
        );
    }

    #[test]
    fn w9_unknown_or_broken_lines_are_errors_not_panics() {
        for bad in [
            "",
            "not json",
            "{}",
            "{\"type\":\"unknown\"}",
            "{\"type\":\"config\",\"mode\":\"sideways\",\"trigger\":null}",
            "{\"type\":\"trigger\"}",
            "[1,2,3]",
        ] {
            assert!(decode_line::<FromHelper>(bad).is_err(), "{bad:?}");
            assert!(decode_line::<ToHelper>(bad).is_err(), "{bad:?}");
        }
    }

    #[test]
    fn w9_the_line_buffer_joins_split_reads_and_splits_joined_ones() {
        let mut buffer = LineBuffer::new();
        assert_eq!(buffer.push(b"{\"type\":\"can").unwrap(), Vec::<String>::new());
        assert_eq!(
            buffer.push(b"cel\"}\n{\"type\":\"hello\",\"protocol\":1}\r\n{\"ty").unwrap(),
            vec![
                "{\"type\":\"cancel\"}".to_string(),
                "{\"type\":\"hello\",\"protocol\":1}".to_string()
            ]
        );
        assert_eq!(buffer.push(b"pe\":\"cancel\"}\n").unwrap(), vec!["{\"type\":\"cancel\"}".to_string()]);
        // 空行は飛ばす。
        assert_eq!(buffer.push(b"\n\r\n\n").unwrap(), Vec::<String>::new());
    }

    #[test]
    fn w9_a_line_that_never_ends_is_cut_off_instead_of_growing_forever() {
        let mut buffer = LineBuffer::new();
        let chunk = vec![b'a'; MAX_LINE_BYTES];
        assert_eq!(buffer.push(&chunk).unwrap(), Vec::<String>::new());
        assert_eq!(buffer.push(b"a"), Err(ProtocolError::LineTooLong));
        // 切ったあとは、また読める。
        assert_eq!(buffer.push(b"{}\n").unwrap(), vec!["{}".to_string()]);
    }

    #[test]
    fn w9_the_protocol_carries_only_buttons_and_times() {
        // 運ぶ種類は、この一覧だけ（画面・ファイル・ネットのものを運ぶ口を、うっかり足さないための番人）。
        let kinds = [
            "hello", "ready", "error", "trigger", "captured", "cancel", "config", "shutdown",
        ];
        for message in [
            encode_line(&FromHelper::Hello { protocol: 1 }),
            encode_line(&FromHelper::Ready {
                mouse_hook: false,
                keyboard_hook: false,
            }),
            encode_line(&FromHelper::Error {
                message: String::new(),
            }),
            encode_line(&FromHelper::Trigger { t_ms: 0 }),
            encode_line(&FromHelper::Captured {
                input: WireTrigger::Mouse {
                    button: WireButton::X1,
                },
            }),
            encode_line(&FromHelper::Cancel),
            encode_line(&ToHelper::Shutdown),
            encode_line(&ToHelper::config(Config::OFF)),
        ] {
            let value: serde_json::Value = serde_json::from_str(&message).unwrap();
            let kind = value["type"].as_str().unwrap();
            assert!(kinds.contains(&kind), "{kind}");
        }
    }
}
