//! 迷いマークのボタンの判定（OS に依存しない部分）。
//!
//! フックの本体（Windows の WH_MOUSE_LL / WH_KEYBOARD_LL）は `hook_win.rs`。
//! ここには「このイベントを横取りするか」を決める純粋な関数だけを置き、単体テストで確かめる（W-2）。
//!
//! 横取りが要るのは、Chrome 版の雀魂ではサイドボタンが「戻る」として働き、
//! ページを離れてしまうため（SPEC F0）。

use std::sync::atomic::{AtomicBool, AtomicU32, Ordering};

use crate::settings::Trigger;

/// マウスのボタン。
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum MouseButton {
    Left,
    Right,
    Middle,
    /// 「戻る」（XBUTTON1）
    X1,
    /// 「進む」（XBUTTON2）
    X2,
}

/// フックが受け取る入力。キーは仮想キーコード（VK_*）。
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum InputEvent {
    MouseDown(MouseButton),
    MouseUp(MouseButton),
    KeyDown(u32),
    KeyUp(u32),
}

impl InputEvent {
    fn is_down(self) -> bool {
        matches!(self, InputEvent::MouseDown(_) | InputEvent::KeyDown(_))
    }
}

/// 設定を、フックの中で使える形（キーは仮想キーコード）にしたもの。
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum ActiveTrigger {
    Mouse(MouseButton),
    Key(u32),
}

const PACK_MOUSE: u32 = 0x0001_0000;
const PACK_KEY: u32 = 0x0002_0000;

impl ActiveTrigger {
    /// 設定から作る。割り当てられないキーなら `None`。
    pub fn from_trigger(trigger: &Trigger) -> Option<ActiveTrigger> {
        match trigger {
            Trigger::MouseX1 => Some(ActiveTrigger::Mouse(MouseButton::X1)),
            Trigger::MouseX2 => Some(ActiveTrigger::Mouse(MouseButton::X2)),
            Trigger::MouseMiddle => Some(ActiveTrigger::Mouse(MouseButton::Middle)),
            Trigger::Key { code } => vk_from_code(code).map(ActiveTrigger::Key),
        }
    }

    /// 1 つの整数に詰める。フックの手続きがロックを取らずに読めるようにするため。
    /// 0 は「割り当て無し」。
    pub fn pack(trigger: Option<ActiveTrigger>) -> u32 {
        match trigger {
            None => 0,
            Some(ActiveTrigger::Mouse(b)) => PACK_MOUSE | button_index(b),
            Some(ActiveTrigger::Key(vk)) => PACK_KEY | (vk & 0xFFFF),
        }
    }

    pub fn unpack(value: u32) -> Option<ActiveTrigger> {
        if value & PACK_MOUSE != 0 {
            button_from_index(value & 0xFF).map(ActiveTrigger::Mouse)
        } else if value & PACK_KEY != 0 {
            Some(ActiveTrigger::Key(value & 0xFFFF))
        } else {
            None
        }
    }

    /// キーボードのフックが要るか。
    pub fn needs_keyboard_hook(self) -> bool {
        matches!(self, ActiveTrigger::Key(_))
    }
}

fn button_index(b: MouseButton) -> u32 {
    match b {
        MouseButton::Left => 1,
        MouseButton::Right => 2,
        MouseButton::Middle => 3,
        MouseButton::X1 => 4,
        MouseButton::X2 => 5,
    }
}

fn button_from_index(i: u32) -> Option<MouseButton> {
    match i {
        1 => Some(MouseButton::Left),
        2 => Some(MouseButton::Right),
        3 => Some(MouseButton::Middle),
        4 => Some(MouseButton::X1),
        5 => Some(MouseButton::X2),
        _ => None,
    }
}

/// イベントをどう扱うか。
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum Decision {
    /// 横取りして、迷いマークを付ける（割り当てたボタンの押下）。
    SwallowAndTrigger,
    /// 横取りするだけ（割り当てたボタンを離したとき）。
    Swallow,
    /// そのままほかのアプリに渡す。
    Pass,
}

/// 割り当てたボタンの押下は「横取りして記録」、離すのは「横取り」、ほかはすべて「通す」（W-2）。
pub fn decide_active(event: InputEvent, trigger: ActiveTrigger) -> Decision {
    match (event, trigger) {
        (InputEvent::MouseDown(b), ActiveTrigger::Mouse(t)) if b == t => {
            Decision::SwallowAndTrigger
        }
        (InputEvent::MouseUp(b), ActiveTrigger::Mouse(t)) if b == t => Decision::Swallow,
        (InputEvent::KeyDown(k), ActiveTrigger::Key(t)) if k == t => Decision::SwallowAndTrigger,
        (InputEvent::KeyUp(k), ActiveTrigger::Key(t)) if k == t => Decision::Swallow,
        _ => Decision::Pass,
    }
}

/// 設定（`Trigger`）を直接受け取る形。割り当てられないキーの設定では何も横取りしない。
pub fn decide(event: InputEvent, trigger: &Trigger) -> Decision {
    match ActiveTrigger::from_trigger(trigger) {
        Some(active) => decide_active(event, active),
        None => Decision::Pass,
    }
}

/// キーを押し続けたときの自動リピートで、迷いマークが連続して付かないようにする。
/// 押下は離すまでの間 1 回だけ記録に回し、2 回目以降は横取りだけにする。
#[derive(Debug, Default)]
pub struct RepeatGate {
    held: AtomicBool,
}

impl RepeatGate {
    pub const fn new() -> Self {
        RepeatGate {
            held: AtomicBool::new(false),
        }
    }

    pub fn filter(&self, event: InputEvent, decision: Decision) -> Decision {
        match decision {
            Decision::SwallowAndTrigger if event.is_down() => {
                if self.held.swap(true, Ordering::SeqCst) {
                    Decision::Swallow
                } else {
                    Decision::SwallowAndTrigger
                }
            }
            Decision::Swallow if !event.is_down() => {
                self.held.store(false, Ordering::SeqCst);
                Decision::Swallow
            }
            other => other,
        }
    }

    /// 割り当てを変えたときに、押下中の状態を捨てる。
    pub fn reset(&self) {
        self.held.store(false, Ordering::SeqCst);
    }
}

/// DOM の `KeyboardEvent.code` を仮想キーコードにする。割り当てられないキーは `None`。
///
/// フックはシステム全体のキー入力を横取りするので、押せなくなると困るキー
/// （Enter・Esc・Tab・Backspace・Space・修飾キー・矢印・Windows キーなど）は割り当てられない。
pub fn vk_from_code(code: &str) -> Option<u32> {
    if let Some(rest) = code.strip_prefix("Key") {
        let mut chars = rest.chars();
        if let (Some(c), None) = (chars.next(), chars.next()) {
            if c.is_ascii_uppercase() {
                return Some(c as u32);
            }
        }
        return None;
    }
    if let Some(rest) = code.strip_prefix("Digit") {
        let mut chars = rest.chars();
        if let (Some(c), None) = (chars.next(), chars.next()) {
            if c.is_ascii_digit() {
                return Some(c as u32);
            }
        }
        return None;
    }
    if let Some(rest) = code.strip_prefix("Numpad") {
        let mut chars = rest.chars();
        if let (Some(c), None) = (chars.next(), chars.next()) {
            if c.is_ascii_digit() {
                return Some(0x60 + (c as u32 - '0' as u32));
            }
        }
        return match rest {
            "Multiply" => Some(0x6A),
            "Add" => Some(0x6B),
            "Subtract" => Some(0x6D),
            "Decimal" => Some(0x6E),
            "Divide" => Some(0x6F),
            _ => None,
        };
    }
    if let Some(rest) = code.strip_prefix('F') {
        if let Ok(n) = rest.parse::<u32>() {
            if (1..=24).contains(&n) && rest == n.to_string() {
                return Some(0x70 + n - 1);
            }
        }
        return None;
    }
    match code {
        "Insert" => Some(0x2D),
        "Delete" => Some(0x2E),
        "Home" => Some(0x24),
        "End" => Some(0x23),
        "PageUp" => Some(0x21),
        "PageDown" => Some(0x22),
        "ScrollLock" => Some(0x91),
        "Pause" => Some(0x13),
        "Backquote" => Some(0xC0),
        "Minus" => Some(0xBD),
        "Equal" => Some(0xBB),
        "BracketLeft" => Some(0xDB),
        "BracketRight" => Some(0xDD),
        "Backslash" => Some(0xDC),
        "Semicolon" => Some(0xBA),
        "Quote" => Some(0xDE),
        "Comma" => Some(0xBC),
        "Period" => Some(0xBE),
        "Slash" => Some(0xBF),
        _ => None,
    }
}

/// フックから記録の担当に渡す合図。押された時刻（ミリ秒）だけを運ぶ。
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub struct TriggerEvent {
    pub t_ms: i64,
}

/// フックの手続きがイベント 1 つごとに行う判定のすべて。
/// 戻り値は「横取りするか」と「記録の担当に渡す合図（あれば）」。
/// フックの手続きを小さく保つため、判定はここに集め、実際の記録は別のスレッドに任せる。
pub fn process_event(
    event: InputEvent,
    trigger: Option<ActiveTrigger>,
    gate: &RepeatGate,
    now_ms: i64,
) -> (bool, Option<TriggerEvent>) {
    let Some(trigger) = trigger else {
        return (false, None);
    };
    match gate.filter(event, decide_active(event, trigger)) {
        Decision::SwallowAndTrigger => (true, Some(TriggerEvent { t_ms: now_ms })),
        Decision::Swallow => (true, None),
        Decision::Pass => (false, None),
    }
}

/// Windows のメッセージ番号（WM_*）と X ボタンの番号。低レベルフックの手続きが受け取る値を、
/// 判定用のイベントにするために使う（`translate_mouse`・`translate_keyboard`）。
/// 値が Windows のものと同じことは、Windows 上のテスト（`message_numbers_match_windows`）が確かめる。
pub mod wm {
    pub const KEYDOWN: u32 = 0x0100;
    pub const KEYUP: u32 = 0x0101;
    pub const SYSKEYDOWN: u32 = 0x0104;
    pub const SYSKEYUP: u32 = 0x0105;
    pub const LBUTTONDOWN: u32 = 0x0201;
    pub const LBUTTONUP: u32 = 0x0202;
    pub const RBUTTONDOWN: u32 = 0x0204;
    pub const RBUTTONUP: u32 = 0x0205;
    pub const MBUTTONDOWN: u32 = 0x0207;
    pub const MBUTTONUP: u32 = 0x0208;
    pub const XBUTTONDOWN: u32 = 0x020B;
    pub const XBUTTONUP: u32 = 0x020C;
    /// `MSLLHOOKSTRUCT.mouseData` の上位ワードが、どちらの X ボタンかを表す。
    pub const XBUTTON1: u32 = 1;
    pub const XBUTTON2: u32 = 2;
}

/// WH_MOUSE_LL のメッセージ（`wparam`）と `MSLLHOOKSTRUCT.mouseData` を、判定用のイベントにする。
/// 移動・ホイールなどは `None`（判定せず、そのまま通す）。
pub fn translate_mouse(message: u32, mouse_data: u32) -> Option<InputEvent> {
    let x_button = || match (mouse_data >> 16) & 0xFFFF {
        wm::XBUTTON1 => Some(MouseButton::X1),
        wm::XBUTTON2 => Some(MouseButton::X2),
        _ => None,
    };
    match message {
        wm::LBUTTONDOWN => Some(InputEvent::MouseDown(MouseButton::Left)),
        wm::LBUTTONUP => Some(InputEvent::MouseUp(MouseButton::Left)),
        wm::RBUTTONDOWN => Some(InputEvent::MouseDown(MouseButton::Right)),
        wm::RBUTTONUP => Some(InputEvent::MouseUp(MouseButton::Right)),
        wm::MBUTTONDOWN => Some(InputEvent::MouseDown(MouseButton::Middle)),
        wm::MBUTTONUP => Some(InputEvent::MouseUp(MouseButton::Middle)),
        wm::XBUTTONDOWN => x_button().map(InputEvent::MouseDown),
        wm::XBUTTONUP => x_button().map(InputEvent::MouseUp),
        _ => None,
    }
}

/// WH_KEYBOARD_LL のメッセージ（`wparam`）と `KBDLLHOOKSTRUCT.vkCode` を、判定用のイベントにする。
pub fn translate_keyboard(message: u32, vk_code: u32) -> Option<InputEvent> {
    match message {
        wm::KEYDOWN | wm::SYSKEYDOWN => Some(InputEvent::KeyDown(vk_code)),
        wm::KEYUP | wm::SYSKEYUP => Some(InputEvent::KeyUp(vk_code)),
        _ => None,
    }
}

/// フックの手続きの中身のすべて（OS に依存しない）。割り当てを覚え、OS から渡された値を
/// イベントにして判定し、「横取りするか」と「記録の担当に渡す合図」を返す。
/// 割り当ては 1 つの整数で持つので、フックの手続きはロックを取らずに読める。
pub struct HookCore {
    trigger: AtomicU32,
    gate: RepeatGate,
}

impl HookCore {
    pub const fn new() -> HookCore {
        HookCore {
            trigger: AtomicU32::new(0),
            gate: RepeatGate::new(),
        }
    }

    /// いまの割り当て。
    pub fn trigger(&self) -> Option<ActiveTrigger> {
        ActiveTrigger::unpack(self.trigger.load(Ordering::SeqCst))
    }

    /// 割り当てを変える。押し続けの状態は捨てる。
    pub fn set_trigger(&self, trigger: Option<ActiveTrigger>) {
        self.trigger
            .store(ActiveTrigger::pack(trigger), Ordering::SeqCst);
        self.gate.reset();
    }

    /// マウスのフックの手続きが受け取った値を判定する。
    pub fn on_mouse(
        &self,
        message: u32,
        mouse_data: u32,
        now_ms: i64,
    ) -> (bool, Option<TriggerEvent>) {
        match translate_mouse(message, mouse_data) {
            Some(event) => process_event(event, self.trigger(), &self.gate, now_ms),
            None => (false, None),
        }
    }

    /// キーボードのフックの手続きが受け取った値を判定する。
    pub fn on_keyboard(
        &self,
        message: u32,
        vk_code: u32,
        now_ms: i64,
    ) -> (bool, Option<TriggerEvent>) {
        match translate_keyboard(message, vk_code) {
            Some(event) => process_event(event, self.trigger(), &self.gate, now_ms),
            None => (false, None),
        }
    }
}

impl Default for HookCore {
    fn default() -> Self {
        HookCore::new()
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    const ALL_BUTTONS: [MouseButton; 5] = [
        MouseButton::Left,
        MouseButton::Right,
        MouseButton::Middle,
        MouseButton::X1,
        MouseButton::X2,
    ];

    fn mouse_trigger(button: MouseButton) -> Trigger {
        match button {
            MouseButton::X1 => Trigger::MouseX1,
            MouseButton::X2 => Trigger::MouseX2,
            MouseButton::Middle => Trigger::MouseMiddle,
            _ => panic!("割り当てられるのは X1・X2・中ボタンだけ"),
        }
    }

    #[test]
    fn w2_assigned_mouse_button_down_is_swallowed_and_triggers() {
        for button in [MouseButton::X1, MouseButton::X2, MouseButton::Middle] {
            assert_eq!(
                decide(InputEvent::MouseDown(button), &mouse_trigger(button)),
                Decision::SwallowAndTrigger,
                "{button:?} の押下"
            );
        }
    }

    #[test]
    fn w2_assigned_mouse_button_up_is_swallowed_without_triggering() {
        for button in [MouseButton::X1, MouseButton::X2, MouseButton::Middle] {
            assert_eq!(
                decide(InputEvent::MouseUp(button), &mouse_trigger(button)),
                Decision::Swallow,
                "{button:?} を離したとき"
            );
        }
    }

    #[test]
    fn w2_other_mouse_buttons_pass_through() {
        for assigned in [MouseButton::X1, MouseButton::X2, MouseButton::Middle] {
            let trigger = mouse_trigger(assigned);
            for other in ALL_BUTTONS.into_iter().filter(|b| *b != assigned) {
                assert_eq!(
                    decide(InputEvent::MouseDown(other), &trigger),
                    Decision::Pass,
                    "{assigned:?} を割り当てたとき、{other:?} の押下は通す"
                );
                assert_eq!(
                    decide(InputEvent::MouseUp(other), &trigger),
                    Decision::Pass,
                    "{assigned:?} を割り当てたとき、{other:?} を離すのも通す"
                );
            }
        }
    }

    #[test]
    fn w2_keyboard_events_pass_through_when_a_mouse_button_is_assigned() {
        assert_eq!(
            decide(InputEvent::KeyDown(0x77), &Trigger::MouseX1),
            Decision::Pass
        );
        assert_eq!(
            decide(InputEvent::KeyUp(0x77), &Trigger::MouseX1),
            Decision::Pass
        );
    }

    #[test]
    fn w2_assigned_key_is_swallowed_and_others_pass() {
        let trigger = Trigger::Key { code: "F8".into() };
        let f8 = vk_from_code("F8").unwrap();
        assert_eq!(
            decide(InputEvent::KeyDown(f8), &trigger),
            Decision::SwallowAndTrigger
        );
        assert_eq!(decide(InputEvent::KeyUp(f8), &trigger), Decision::Swallow);
        assert_eq!(
            decide(InputEvent::KeyDown(f8 + 1), &trigger),
            Decision::Pass
        );
        assert_eq!(
            decide(InputEvent::MouseDown(MouseButton::X1), &trigger),
            Decision::Pass
        );
    }

    #[test]
    fn w2_unsupported_key_assignment_swallows_nothing() {
        let trigger = Trigger::Key {
            code: "NoSuchKey".into(),
        };
        assert_eq!(decide(InputEvent::KeyDown(0x41), &trigger), Decision::Pass);
    }

    #[test]
    fn repeat_gate_lets_only_the_first_key_down_trigger() {
        let gate = RepeatGate::new();
        let down = InputEvent::KeyDown(0x77);
        let up = InputEvent::KeyUp(0x77);
        let trig = Decision::SwallowAndTrigger;
        assert_eq!(gate.filter(down, trig), Decision::SwallowAndTrigger);
        // 押し続けたときの自動リピート
        assert_eq!(gate.filter(down, trig), Decision::Swallow);
        assert_eq!(gate.filter(down, trig), Decision::Swallow);
        // 離すと次の押下からまた記録する
        assert_eq!(gate.filter(up, Decision::Swallow), Decision::Swallow);
        assert_eq!(gate.filter(down, trig), Decision::SwallowAndTrigger);
    }

    #[test]
    fn repeat_gate_passes_through_unrelated_decisions() {
        let gate = RepeatGate::new();
        assert_eq!(
            gate.filter(InputEvent::KeyDown(0x41), Decision::Pass),
            Decision::Pass
        );
    }

    #[test]
    fn repeat_gate_reset_forgets_a_held_key() {
        let gate = RepeatGate::new();
        let down = InputEvent::KeyDown(0x77);
        gate.filter(down, Decision::SwallowAndTrigger);
        gate.reset();
        assert_eq!(
            gate.filter(down, Decision::SwallowAndTrigger),
            Decision::SwallowAndTrigger
        );
    }

    #[test]
    fn process_event_swallows_and_signals_only_for_the_assigned_button() {
        let gate = RepeatGate::new();
        let trigger = Some(ActiveTrigger::Mouse(MouseButton::X1));
        let down = process_event(InputEvent::MouseDown(MouseButton::X1), trigger, &gate, 1234);
        assert_eq!(down, (true, Some(TriggerEvent { t_ms: 1234 })));
        let up = process_event(InputEvent::MouseUp(MouseButton::X1), trigger, &gate, 1300);
        assert_eq!(up, (true, None));
        let left = process_event(
            InputEvent::MouseDown(MouseButton::Left),
            trigger,
            &gate,
            1400,
        );
        assert_eq!(left, (false, None));
    }

    #[test]
    fn process_event_without_an_assignment_passes_everything() {
        let gate = RepeatGate::new();
        let out = process_event(InputEvent::MouseDown(MouseButton::X1), None, &gate, 1);
        assert_eq!(out, (false, None));
    }

    #[test]
    fn pack_and_unpack_round_trip() {
        let cases = [
            None,
            Some(ActiveTrigger::Mouse(MouseButton::X1)),
            Some(ActiveTrigger::Mouse(MouseButton::X2)),
            Some(ActiveTrigger::Mouse(MouseButton::Middle)),
            Some(ActiveTrigger::Key(0x77)),
            Some(ActiveTrigger::Key(0xDE)),
        ];
        for case in cases {
            assert_eq!(ActiveTrigger::unpack(ActiveTrigger::pack(case)), case);
        }
    }

    #[test]
    fn key_codes_map_to_virtual_keys() {
        assert_eq!(vk_from_code("KeyA"), Some(0x41));
        assert_eq!(vk_from_code("KeyZ"), Some(0x5A));
        assert_eq!(vk_from_code("Digit0"), Some(0x30));
        assert_eq!(vk_from_code("Digit9"), Some(0x39));
        assert_eq!(vk_from_code("F1"), Some(0x70));
        assert_eq!(vk_from_code("F8"), Some(0x77));
        assert_eq!(vk_from_code("F12"), Some(0x7B));
        assert_eq!(vk_from_code("F24"), Some(0x87));
        assert_eq!(vk_from_code("Numpad0"), Some(0x60));
        assert_eq!(vk_from_code("Numpad9"), Some(0x69));
        assert_eq!(vk_from_code("NumpadAdd"), Some(0x6B));
        assert_eq!(vk_from_code("Insert"), Some(0x2D));
        assert_eq!(vk_from_code("Backquote"), Some(0xC0));
    }

    #[test]
    fn keys_that_would_lock_the_user_out_are_not_assignable() {
        for code in [
            "Enter",
            "Escape",
            "Tab",
            "Backspace",
            "Space",
            "ShiftLeft",
            "ControlLeft",
            "AltLeft",
            "MetaLeft",
            "ArrowUp",
            "CapsLock",
            "",
            "Key",
            "KeyAB",
            "Fx",
            "F0",
            "F25",
            "F01",
            "Numpad",
        ] {
            assert_eq!(vk_from_code(code), None, "{code:?}");
        }
    }

    // ---- Windows のメッセージの読み取りと、フックの手続きの中身（OS に依存しない配線） ----

    const XBUTTON1_DATA: u32 = wm::XBUTTON1 << 16;
    const XBUTTON2_DATA: u32 = wm::XBUTTON2 << 16;

    #[cfg(windows)]
    #[test]
    fn message_numbers_match_windows() {
        use windows::Win32::UI::WindowsAndMessaging as w;
        assert_eq!(wm::KEYDOWN, w::WM_KEYDOWN);
        assert_eq!(wm::KEYUP, w::WM_KEYUP);
        assert_eq!(wm::SYSKEYDOWN, w::WM_SYSKEYDOWN);
        assert_eq!(wm::SYSKEYUP, w::WM_SYSKEYUP);
        assert_eq!(wm::LBUTTONDOWN, w::WM_LBUTTONDOWN);
        assert_eq!(wm::LBUTTONUP, w::WM_LBUTTONUP);
        assert_eq!(wm::RBUTTONDOWN, w::WM_RBUTTONDOWN);
        assert_eq!(wm::RBUTTONUP, w::WM_RBUTTONUP);
        assert_eq!(wm::MBUTTONDOWN, w::WM_MBUTTONDOWN);
        assert_eq!(wm::MBUTTONUP, w::WM_MBUTTONUP);
        assert_eq!(wm::XBUTTONDOWN, w::WM_XBUTTONDOWN);
        assert_eq!(wm::XBUTTONUP, w::WM_XBUTTONUP);
        assert_eq!(wm::XBUTTON1, u32::from(w::XBUTTON1));
        assert_eq!(wm::XBUTTON2, u32::from(w::XBUTTON2));
    }

    #[test]
    fn w2_mouse_messages_become_events_and_x_buttons_are_told_apart_by_the_high_word() {
        use InputEvent::{MouseDown, MouseUp};
        assert_eq!(
            translate_mouse(wm::XBUTTONDOWN, XBUTTON1_DATA),
            Some(MouseDown(MouseButton::X1))
        );
        assert_eq!(
            translate_mouse(wm::XBUTTONUP, XBUTTON1_DATA),
            Some(MouseUp(MouseButton::X1))
        );
        assert_eq!(
            translate_mouse(wm::XBUTTONDOWN, XBUTTON2_DATA),
            Some(MouseDown(MouseButton::X2))
        );
        assert_eq!(
            translate_mouse(wm::XBUTTONUP, XBUTTON2_DATA),
            Some(MouseUp(MouseButton::X2))
        );
        // 下位ワードの値には左右されない（上位ワードだけが番号）。
        assert_eq!(
            translate_mouse(wm::XBUTTONDOWN, XBUTTON1_DATA | 0x1234),
            Some(MouseDown(MouseButton::X1))
        );
        // 知らない番号の X ボタンは判定しない。
        assert_eq!(translate_mouse(wm::XBUTTONDOWN, 3 << 16), None);
        assert_eq!(translate_mouse(wm::XBUTTONDOWN, 0), None);
        assert_eq!(
            translate_mouse(wm::LBUTTONDOWN, 0),
            Some(MouseDown(MouseButton::Left))
        );
        assert_eq!(
            translate_mouse(wm::LBUTTONUP, 0),
            Some(MouseUp(MouseButton::Left))
        );
        assert_eq!(
            translate_mouse(wm::RBUTTONDOWN, 0),
            Some(MouseDown(MouseButton::Right))
        );
        assert_eq!(
            translate_mouse(wm::RBUTTONUP, 0),
            Some(MouseUp(MouseButton::Right))
        );
        assert_eq!(
            translate_mouse(wm::MBUTTONDOWN, 0),
            Some(MouseDown(MouseButton::Middle))
        );
        assert_eq!(
            translate_mouse(wm::MBUTTONUP, 0),
            Some(MouseUp(MouseButton::Middle))
        );
        // 移動（0x0200）・ホイール（0x020A）・左のダブルクリック（0x0203）などは判定しない。
        for other in [0x0200, 0x020A, 0x0203, 0x020E, 0] {
            assert_eq!(translate_mouse(other, XBUTTON1_DATA), None, "{other:#06x}");
        }
    }

    #[test]
    fn w2_keyboard_messages_become_events() {
        assert_eq!(
            translate_keyboard(wm::KEYDOWN, 0x77),
            Some(InputEvent::KeyDown(0x77))
        );
        assert_eq!(
            translate_keyboard(wm::SYSKEYDOWN, 0x77),
            Some(InputEvent::KeyDown(0x77)),
            "Alt を押しながらの押下も同じ"
        );
        assert_eq!(
            translate_keyboard(wm::KEYUP, 0x77),
            Some(InputEvent::KeyUp(0x77))
        );
        assert_eq!(
            translate_keyboard(wm::SYSKEYUP, 0x77),
            Some(InputEvent::KeyUp(0x77))
        );
        assert_eq!(
            translate_keyboard(0x0102, 0x77),
            None,
            "WM_CHAR は判定しない"
        );
    }

    #[test]
    fn w2_the_default_assignment_swallows_only_the_back_button_and_hands_over_the_time() {
        let core = HookCore::new();
        assert_eq!(core.trigger(), None, "割り当ての前は、何も止めない");
        assert_eq!(
            core.on_mouse(wm::XBUTTONDOWN, XBUTTON1_DATA, 1),
            (false, None)
        );

        core.set_trigger(ActiveTrigger::from_trigger(&Trigger::default()));
        assert_eq!(core.trigger(), Some(ActiveTrigger::Mouse(MouseButton::X1)));
        // 「戻る」: 押下は止めて合図を渡し、離すのは止めるだけ。
        assert_eq!(
            core.on_mouse(wm::XBUTTONDOWN, XBUTTON1_DATA, 1_760_000_000_123),
            (
                true,
                Some(TriggerEvent {
                    t_ms: 1_760_000_000_123
                })
            )
        );
        assert_eq!(
            core.on_mouse(wm::XBUTTONUP, XBUTTON1_DATA, 1_760_000_000_200),
            (true, None)
        );
        // 「進む」・左・右・中・キー・移動は、そのまま通す。
        for (message, data) in [
            (wm::XBUTTONDOWN, XBUTTON2_DATA),
            (wm::XBUTTONUP, XBUTTON2_DATA),
            (wm::LBUTTONDOWN, 0),
            (wm::LBUTTONUP, 0),
            (wm::RBUTTONDOWN, 0),
            (wm::RBUTTONUP, 0),
            (wm::MBUTTONDOWN, 0),
            (wm::MBUTTONUP, 0),
            (0x0200, 0),
            (0x020A, 0),
        ] {
            assert_eq!(
                core.on_mouse(message, data, 5),
                (false, None),
                "{message:#06x}"
            );
        }
        assert_eq!(core.on_keyboard(wm::KEYDOWN, 0x77, 6), (false, None));
    }

    #[test]
    fn w2_changing_the_assignment_takes_effect_on_the_next_input() {
        let core = HookCore::new();
        core.set_trigger(Some(ActiveTrigger::Mouse(MouseButton::X2)));
        assert_eq!(
            core.on_mouse(wm::XBUTTONDOWN, XBUTTON1_DATA, 1),
            (false, None)
        );
        assert_eq!(
            core.on_mouse(wm::XBUTTONDOWN, XBUTTON2_DATA, 2),
            (true, Some(TriggerEvent { t_ms: 2 }))
        );
        core.set_trigger(Some(ActiveTrigger::Mouse(MouseButton::Middle)));
        assert_eq!(
            core.on_mouse(wm::XBUTTONDOWN, XBUTTON2_DATA, 3),
            (false, None)
        );
        assert_eq!(
            core.on_mouse(wm::MBUTTONDOWN, 0, 4),
            (true, Some(TriggerEvent { t_ms: 4 }))
        );
        assert_eq!(core.on_mouse(wm::MBUTTONUP, 0, 5), (true, None));
        core.set_trigger(None);
        assert_eq!(core.on_mouse(wm::MBUTTONDOWN, 0, 6), (false, None));
    }

    #[test]
    fn w2_a_key_assignment_swallows_the_key_only_and_records_once_while_held() {
        let core = HookCore::new();
        let f8 = vk_from_code("F8").unwrap();
        core.set_trigger(ActiveTrigger::from_trigger(&Trigger::Key {
            code: "F8".into(),
        }));
        assert!(ActiveTrigger::Key(f8).needs_keyboard_hook());
        assert_eq!(
            core.on_keyboard(wm::KEYDOWN, f8, 10),
            (true, Some(TriggerEvent { t_ms: 10 }))
        );
        // 押し続けたときの自動リピート（2 回目以降の押下）は、止めるだけ。
        assert_eq!(core.on_keyboard(wm::KEYDOWN, f8, 11), (true, None));
        assert_eq!(core.on_keyboard(wm::KEYDOWN, f8, 12), (true, None));
        assert_eq!(core.on_keyboard(wm::KEYUP, f8, 13), (true, None));
        // 離したあとの次の押下は、また記録する。
        assert_eq!(
            core.on_keyboard(wm::SYSKEYDOWN, f8, 14),
            (true, Some(TriggerEvent { t_ms: 14 }))
        );
        // ほかのキーとマウスのボタンは通す。
        assert_eq!(core.on_keyboard(wm::KEYDOWN, f8 + 1, 15), (false, None));
        assert_eq!(
            core.on_mouse(wm::XBUTTONDOWN, XBUTTON1_DATA, 16),
            (false, None)
        );
    }

    #[test]
    fn w2_changing_the_assignment_forgets_a_held_key() {
        let core = HookCore::new();
        let f8 = vk_from_code("F8").unwrap();
        core.set_trigger(Some(ActiveTrigger::Key(f8)));
        assert!(core.on_keyboard(wm::KEYDOWN, f8, 1).1.is_some());
        core.set_trigger(Some(ActiveTrigger::Key(f8)));
        assert!(
            core.on_keyboard(wm::KEYDOWN, f8, 2).1.is_some(),
            "割り当てを変えたら、押し続けの状態は捨てる"
        );
    }
}
