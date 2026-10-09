//! 入力の判定（OS に依存しない部分）。本体の中のフックと、管理者で動く補助プログラムが、同じ判定を使う（W-2、W-9）。
//!
//! 割り当てたボタンの押下・離しは横取りして、ほかのアプリに届けない（Chrome 版の雀魂でサイドボタンが
//! 「戻る」として働き、ページを離れてしまうのを防ぐため。SPEC F0）。ほかの入力は何も変えずに通す。
//! 登録の待機中は、最初に押された登録できる入力（W-10）を拾って本体に知らせ、横取りする。
//!
//! フックの手続きは遅いと Windows に外されるので、判定は割り当てと状態を整数で持ち、ロックを取らずに行う。

use std::sync::atomic::{AtomicU32, AtomicU64, Ordering};

use crate::keys::{is_modifier_vk, registrable_key, Modifiers, VK_ESCAPE, VK_TAB};

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

impl MouseButton {
    pub fn index(self) -> u32 {
        match self {
            MouseButton::Left => 1,
            MouseButton::Right => 2,
            MouseButton::Middle => 3,
            MouseButton::X1 => 4,
            MouseButton::X2 => 5,
        }
    }

    pub fn from_index(index: u32) -> Option<MouseButton> {
        match index {
            1 => Some(MouseButton::Left),
            2 => Some(MouseButton::Right),
            3 => Some(MouseButton::Middle),
            4 => Some(MouseButton::X1),
            5 => Some(MouseButton::X2),
            _ => None,
        }
    }

    /// 割り当てに登録できるボタンか。左右のボタンは、横取りすると画面の操作ができなくなる
    /// （「キャンセル」も押せなくなる）ので、登録できない。
    pub fn registrable(self) -> bool {
        matches!(
            self,
            MouseButton::Middle | MouseButton::X1 | MouseButton::X2
        )
    }

    fn bit(self) -> u32 {
        1 << self.index()
    }
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
    pub fn is_down(self) -> bool {
        matches!(self, InputEvent::MouseDown(_) | InputEvent::KeyDown(_))
    }
}

/// キーと修飾キーの組み合わせ（Ctrl+Alt+M など）。
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub struct Chord {
    pub vk: u32,
    pub mods: Modifiers,
}

/// フックの中で使う割り当て（設定を直したもの）。キーは仮想キーコード。
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum ActiveTrigger {
    Mouse(MouseButton),
    Key(Chord),
}

impl ActiveTrigger {
    pub fn key(vk: u32, mods: Modifiers) -> ActiveTrigger {
        ActiveTrigger::Key(Chord { vk, mods })
    }
}

/// 入力の扱い方。補助プログラムにも同じものを渡す（W-9）。
#[derive(Debug, Clone, Copy, Default, PartialEq, Eq)]
pub enum Mode {
    /// 割り当てたボタンの押下を、迷いマークとして知らせる。
    #[default]
    Normal,
    /// 割り当てたボタンの押下を知らせる。本体は記録せず、受け取ったことを画面に出すだけ（W-11）。
    Test,
    /// 最初に押された登録できる入力を、割り当ての候補として知らせる（W-10）。
    Register,
}

/// フックに渡す設定（割り当てと扱い方）。
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub struct Config {
    pub trigger: Option<ActiveTrigger>,
    pub mode: Mode,
}

impl Config {
    /// 何も拾わない設定。フックを入れる必要が無い。
    pub const OFF: Config = Config {
        trigger: None,
        mode: Mode::Normal,
    };

    /// マウスのフックが要るか。登録の待機中は、どのボタンも候補になる。
    pub fn needs_mouse_hook(self) -> bool {
        match self.mode {
            Mode::Register => true,
            Mode::Normal | Mode::Test => matches!(self.trigger, Some(ActiveTrigger::Mouse(_))),
        }
    }

    /// キーボードのフックが要るか。割り当てがキーのときと、登録の待機中だけ。
    pub fn needs_keyboard_hook(self) -> bool {
        match self.mode {
            Mode::Register => true,
            Mode::Normal | Mode::Test => matches!(self.trigger, Some(ActiveTrigger::Key(_))),
        }
    }

    /// キーボードのフックを入れるか。`keyboard_allowed` が `false` のときは、設定が要るものでも入れない。
    /// 本体は、自分の窓（検討画面）が前面にある間は `false` にする。その間、本体のキーボードのフックには
    /// 入力が届かず（Windows の側の事情）、先に入っているほかのアプリのフックにも届かなくなるため。
    /// そのときのキー入力は、窓の中の画面が拾う（W-10、W-11）。
    pub fn wants_keyboard_hook(self, keyboard_allowed: bool) -> bool {
        keyboard_allowed && self.needs_keyboard_hook()
    }

    /// 1 つの整数に詰める。フックの手続きがロックを取らずに読めるようにするため。
    pub fn pack(self) -> u64 {
        let mode = match self.mode {
            Mode::Normal => 0u64,
            Mode::Test => 1,
            Mode::Register => 2,
        };
        let trigger = match self.trigger {
            None => 0u64,
            Some(ActiveTrigger::Mouse(b)) => 1 | (u64::from(b.index()) << 8),
            Some(ActiveTrigger::Key(c)) => {
                2 | (u64::from(c.vk & 0xFFFF) << 8) | (u64::from(c.mods.bits()) << 24)
            }
        };
        mode | (trigger << 4)
    }

    pub fn unpack(value: u64) -> Config {
        let mode = match value & 0xF {
            1 => Mode::Test,
            2 => Mode::Register,
            _ => Mode::Normal,
        };
        let trigger = value >> 4;
        let trigger = match trigger & 0xFF {
            1 => MouseButton::from_index(((trigger >> 8) & 0xFF) as u32).map(ActiveTrigger::Mouse),
            2 => Some(ActiveTrigger::key(
                ((trigger >> 8) & 0xFFFF) as u32,
                Modifiers::from_bits(((trigger >> 24) & 0xF) as u8),
            )),
            _ => None,
        };
        Config { trigger, mode }
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
/// キーは、修飾キーが割り当てと同じときだけ当たる（押下のとき。離すのは、キーだけを見る）。
/// 「押下を横取りしていたものだけ離すのを横取りする」という絞り込みは `HeldGate` が行う。
pub fn decide_active(event: InputEvent, trigger: ActiveTrigger, mods: Modifiers) -> Decision {
    match (event, trigger) {
        (InputEvent::MouseDown(b), ActiveTrigger::Mouse(t)) if b == t => {
            Decision::SwallowAndTrigger
        }
        (InputEvent::MouseUp(b), ActiveTrigger::Mouse(t)) if b == t => Decision::Swallow,
        (InputEvent::KeyDown(k), ActiveTrigger::Key(c)) if k == c.vk && mods == c.mods => {
            Decision::SwallowAndTrigger
        }
        (InputEvent::KeyUp(k), ActiveTrigger::Key(c)) if k == c.vk => Decision::Swallow,
        _ => Decision::Pass,
    }
}

impl ActiveTrigger {
    /// 割り当てに登録してよい入力か（W-10）。左右のボタン・割り当てられないキー・文字の入力のキー単独は登録できない。
    /// 補助プログラムが知らせてきた候補を、本体が受け取る前に確かめるのにも使う。
    pub fn registrable(self) -> bool {
        match self {
            ActiveTrigger::Mouse(button) => button.registrable(),
            ActiveTrigger::Key(chord) => registrable_key(chord.vk, chord.mods),
        }
    }
}

/// 登録の待機中の判定（W-10）。
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum RegisterDecision {
    /// 割り当ての候補として拾う（横取りもする）。
    Capture(ActiveTrigger),
    /// Esc。登録をやめる合図（Esc 自体は通す）。
    Cancel,
    /// 何もしない（Tab・修飾キー単独・左右のボタン・登録できないキーなど）。
    Pass,
}

/// 登録の待機中に、最初に押された登録できる入力を選ぶ（W-10）。離す側は `HeldGate` が扱う。
pub fn decide_register(event: InputEvent, mods: Modifiers) -> RegisterDecision {
    match event {
        InputEvent::MouseDown(b) if b.registrable() => {
            RegisterDecision::Capture(ActiveTrigger::Mouse(b))
        }
        InputEvent::KeyDown(VK_ESCAPE) => RegisterDecision::Cancel,
        InputEvent::KeyDown(VK_TAB) => RegisterDecision::Pass,
        InputEvent::KeyDown(vk) if !is_modifier_vk(vk) && registrable_key(vk, mods) => {
            RegisterDecision::Capture(ActiveTrigger::key(vk, mods))
        }
        _ => RegisterDecision::Pass,
    }
}

/// 押下を横取りした入力を覚えて、離すのを横取りし、キーの押し続け（自動リピート）で何度も知らせないようにする。
/// 設定が途中で変わっても、押下を横取りしたものは、離すときに必ず横取りする（片方だけ届くと、ほかのアプリが戸惑う）。
#[derive(Debug, Default)]
pub struct HeldGate {
    mouse: AtomicU32,
    key: AtomicU32,
}

impl HeldGate {
    pub const fn new() -> Self {
        HeldGate {
            mouse: AtomicU32::new(0),
            key: AtomicU32::new(0),
        }
    }

    pub fn filter(&self, event: InputEvent, decision: Decision) -> Decision {
        match event {
            InputEvent::MouseDown(b) => {
                if decision == Decision::SwallowAndTrigger {
                    // マウスのボタンには自動リピートが無い。離すのを取りこぼしていても、新しい押下として扱う。
                    self.mouse.fetch_or(b.bit(), Ordering::SeqCst);
                }
                decision
            }
            InputEvent::MouseUp(b) => {
                if self.mouse.fetch_and(!b.bit(), Ordering::SeqCst) & b.bit() != 0 {
                    Decision::Swallow
                } else {
                    Decision::Pass
                }
            }
            InputEvent::KeyDown(vk) => {
                if decision != Decision::SwallowAndTrigger {
                    return decision;
                }
                // 押し続けたときの自動リピートは、横取りだけにする（迷いマークが連続して付かないように）。
                if self.key.swap(vk, Ordering::SeqCst) == vk {
                    Decision::Swallow
                } else {
                    Decision::SwallowAndTrigger
                }
            }
            InputEvent::KeyUp(vk) => {
                if self
                    .key
                    .compare_exchange(vk, 0, Ordering::SeqCst, Ordering::SeqCst)
                    .is_ok()
                {
                    Decision::Swallow
                } else {
                    Decision::Pass
                }
            }
        }
    }

    /// 押下中の状態を捨てる（フックを外したときなど、離す知らせが届かなくなるとき）。
    pub fn reset(&self) {
        self.reset_mouse();
        self.reset_keys();
    }

    /// マウスのボタンの押下中の状態だけを捨てる（マウスのフックを外したとき）。
    pub fn reset_mouse(&self) {
        self.mouse.store(0, Ordering::SeqCst);
    }

    /// キーの押下中の状態だけを捨てる（キーボードのフックを外したとき）。
    pub fn reset_keys(&self) {
        self.key.store(0, Ordering::SeqCst);
    }
}

/// フックから本体への知らせ。
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum Report {
    /// 割り当てたボタンが押された（時刻はミリ秒）。
    Trigger { t_ms: i64 },
    /// 登録の待機中に、候補の入力が押された。
    Captured(ActiveTrigger),
    /// 登録の待機中に Esc が押された。
    Cancel,
}

/// 入力 1 つの判定の結果。
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub struct Outcome {
    /// ほかのアプリに届けないか。
    pub swallow: bool,
    pub report: Option<Report>,
}

impl Outcome {
    pub const PASS: Outcome = Outcome {
        swallow: false,
        report: None,
    };
    pub const SWALLOW: Outcome = Outcome {
        swallow: true,
        report: None,
    };
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

/// フックの手続きの中身のすべて（OS に依存しない）。設定を覚え、OS から渡された値をイベントにして判定し、
/// 「横取りするか」と「本体への知らせ」を返す。設定は 1 つの整数で持つので、フックの手続きはロックを取らずに読める。
#[derive(Debug)]
pub struct InputCore {
    config: AtomicU64,
    gate: HeldGate,
}

impl InputCore {
    pub const fn new() -> InputCore {
        InputCore {
            // Config::OFF を詰めた値（モードは通常、割り当て無し）。
            config: AtomicU64::new(0),
            gate: HeldGate::new(),
        }
    }

    /// いまの設定。
    pub fn config(&self) -> Config {
        Config::unpack(self.config.load(Ordering::SeqCst))
    }

    /// 設定を変える。押下中の状態は残す（変える前に押下を横取りした入力は、離すときも横取りする）。
    pub fn set_config(&self, config: Config) {
        self.config.store(config.pack(), Ordering::SeqCst);
    }

    /// 押下中の状態を捨てる。
    pub fn reset(&self) {
        self.gate.reset();
    }

    /// マウスのボタンの押下中の状態だけを捨てる（マウスのフックを外したとき）。
    pub fn reset_mouse(&self) {
        self.gate.reset_mouse();
    }

    /// キーの押下中の状態だけを捨てる（キーボードのフックを外したとき）。
    pub fn reset_keys(&self) {
        self.gate.reset_keys();
    }

    /// イベント 1 つを判定する。`mods` は、修飾キーの状態が要るときだけ呼ばれる（押されるたびに OS へ問い合わせないため）。
    pub fn process(
        &self,
        event: InputEvent,
        mods: impl FnOnce() -> Modifiers,
        now_ms: i64,
    ) -> Outcome {
        let config = self.config();
        let decision = match config.mode {
            Mode::Register => match decide_register(event, current_mods(event, mods, true)) {
                RegisterDecision::Capture(candidate) => {
                    return match self.gate.filter(event, Decision::SwallowAndTrigger) {
                        Decision::SwallowAndTrigger => Outcome {
                            swallow: true,
                            report: Some(Report::Captured(candidate)),
                        },
                        _ => Outcome::SWALLOW,
                    };
                }
                RegisterDecision::Cancel => {
                    return Outcome {
                        swallow: false,
                        report: Some(Report::Cancel),
                    };
                }
                RegisterDecision::Pass => Decision::Pass,
            },
            Mode::Normal | Mode::Test => match config.trigger {
                Some(trigger) => decide_active(
                    event,
                    trigger,
                    current_mods(event, mods, wants_mods(trigger, event)),
                ),
                None => Decision::Pass,
            },
        };
        match self.gate.filter(event, decision) {
            Decision::SwallowAndTrigger => Outcome {
                swallow: true,
                report: Some(Report::Trigger { t_ms: now_ms }),
            },
            Decision::Swallow => Outcome::SWALLOW,
            Decision::Pass => Outcome::PASS,
        }
    }

    /// マウスのフックの手続きが受け取った値を判定する。
    pub fn on_mouse(&self, message: u32, mouse_data: u32, now_ms: i64) -> Outcome {
        match translate_mouse(message, mouse_data) {
            Some(event) => self.process(event, || Modifiers::NONE, now_ms),
            None => Outcome::PASS,
        }
    }

    /// キーボードのフックの手続きが受け取った値を判定する。
    pub fn on_keyboard(
        &self,
        message: u32,
        vk_code: u32,
        now_ms: i64,
        mods: impl FnOnce() -> Modifiers,
    ) -> Outcome {
        match translate_keyboard(message, vk_code) {
            Some(event) => self.process(event, mods, now_ms),
            None => Outcome::PASS,
        }
    }
}

impl Default for InputCore {
    fn default() -> Self {
        InputCore::new()
    }
}

/// 割り当てがキーで、押されたのが同じキーのときだけ、修飾キーの状態が要る。
fn wants_mods(trigger: ActiveTrigger, event: InputEvent) -> bool {
    matches!((trigger, event), (ActiveTrigger::Key(c), InputEvent::KeyDown(vk)) if c.vk == vk)
}

/// キーの押下のときだけ（`needed` のとき）修飾キーの状態を取る。
fn current_mods(event: InputEvent, mods: impl FnOnce() -> Modifiers, needed: bool) -> Modifiers {
    match event {
        InputEvent::KeyDown(vk) if needed && !is_modifier_vk(vk) => mods(),
        _ => Modifiers::NONE,
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::keys::vk_from_code;

    const ALL_BUTTONS: [MouseButton; 5] = [
        MouseButton::Left,
        MouseButton::Right,
        MouseButton::Middle,
        MouseButton::X1,
        MouseButton::X2,
    ];
    const NONE: Modifiers = Modifiers::NONE;
    const F8: u32 = 0x77;
    const F13: u32 = 0x7C;
    const KEY_M: u32 = 0x4D;
    const CTRL_ALT: Modifiers = Modifiers::new(true, true, false, false);

    fn mouse(button: MouseButton) -> ActiveTrigger {
        ActiveTrigger::Mouse(button)
    }

    fn core_with(trigger: Option<ActiveTrigger>, mode: Mode) -> InputCore {
        let core = InputCore::new();
        core.set_config(Config { trigger, mode });
        core
    }

    // ---- W-2: 判定の関数 ----

    #[test]
    fn w2_assigned_mouse_button_down_is_swallowed_and_triggers() {
        for button in [MouseButton::X1, MouseButton::X2, MouseButton::Middle] {
            assert_eq!(
                decide_active(InputEvent::MouseDown(button), mouse(button), NONE),
                Decision::SwallowAndTrigger,
                "{button:?} の押下"
            );
        }
    }

    #[test]
    fn w2_assigned_mouse_button_up_is_swallowed_without_triggering() {
        for button in [MouseButton::X1, MouseButton::X2, MouseButton::Middle] {
            assert_eq!(
                decide_active(InputEvent::MouseUp(button), mouse(button), NONE),
                Decision::Swallow,
                "{button:?} を離したとき"
            );
        }
    }

    #[test]
    fn w2_other_mouse_buttons_pass_through() {
        for assigned in [MouseButton::X1, MouseButton::X2, MouseButton::Middle] {
            for other in ALL_BUTTONS.into_iter().filter(|b| *b != assigned) {
                assert_eq!(
                    decide_active(InputEvent::MouseDown(other), mouse(assigned), NONE),
                    Decision::Pass,
                    "{assigned:?} を割り当てたとき、{other:?} の押下は通す"
                );
                assert_eq!(
                    decide_active(InputEvent::MouseUp(other), mouse(assigned), NONE),
                    Decision::Pass,
                    "{assigned:?} を割り当てたとき、{other:?} を離すのも通す"
                );
            }
        }
    }

    #[test]
    fn w2_keyboard_events_pass_through_when_a_mouse_button_is_assigned() {
        let trigger = mouse(MouseButton::X1);
        assert_eq!(
            decide_active(InputEvent::KeyDown(F8), trigger, NONE),
            Decision::Pass
        );
        assert_eq!(
            decide_active(InputEvent::KeyUp(F8), trigger, NONE),
            Decision::Pass
        );
    }

    #[test]
    fn w2_assigned_key_is_swallowed_and_others_pass() {
        let trigger = ActiveTrigger::key(F8, NONE);
        assert_eq!(
            decide_active(InputEvent::KeyDown(F8), trigger, NONE),
            Decision::SwallowAndTrigger
        );
        assert_eq!(
            decide_active(InputEvent::KeyUp(F8), trigger, NONE),
            Decision::Swallow
        );
        assert_eq!(
            decide_active(InputEvent::KeyDown(F8 + 1), trigger, NONE),
            Decision::Pass
        );
        assert_eq!(
            decide_active(InputEvent::MouseDown(MouseButton::X1), trigger, NONE),
            Decision::Pass
        );
    }

    #[test]
    fn w10_a_key_with_modifiers_matches_only_when_the_modifiers_are_the_same() {
        let trigger = ActiveTrigger::key(KEY_M, CTRL_ALT);
        assert_eq!(
            decide_active(InputEvent::KeyDown(KEY_M), trigger, CTRL_ALT),
            Decision::SwallowAndTrigger
        );
        for other in [
            NONE,
            Modifiers::new(true, false, false, false),
            Modifiers::new(false, true, false, false),
            Modifiers::new(true, true, true, false),
            Modifiers::new(true, true, false, true),
        ] {
            assert_eq!(
                decide_active(InputEvent::KeyDown(KEY_M), trigger, other),
                Decision::Pass,
                "{other:?}"
            );
        }
        // 修飾キー無しの割り当て（F13）は、Ctrl を押しながらでは当たらない。
        let plain = ActiveTrigger::key(F13, NONE);
        assert_eq!(
            decide_active(InputEvent::KeyDown(F13), plain, NONE),
            Decision::SwallowAndTrigger
        );
        assert_eq!(
            decide_active(
                InputEvent::KeyDown(F13),
                plain,
                Modifiers::new(true, false, false, false)
            ),
            Decision::Pass
        );
        // 離すときは、修飾キーを見ない（先に修飾キーを離しても、押下を横取りしたキーは離すのも横取りする）。
        assert_eq!(
            decide_active(InputEvent::KeyUp(KEY_M), trigger, NONE),
            Decision::Swallow
        );
    }

    // ---- 押下中の状態（離すのを横取りする・自動リピート） ----

    #[test]
    fn held_gate_lets_only_the_first_key_down_trigger() {
        let gate = HeldGate::new();
        let down = InputEvent::KeyDown(F8);
        let up = InputEvent::KeyUp(F8);
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
    fn held_gate_swallows_a_release_only_when_it_swallowed_the_press() {
        let gate = HeldGate::new();
        // 押下を横取りしていない入力を離すのは、通す。
        assert_eq!(
            gate.filter(InputEvent::MouseUp(MouseButton::X1), Decision::Swallow),
            Decision::Pass
        );
        assert_eq!(
            gate.filter(InputEvent::KeyUp(F8), Decision::Swallow),
            Decision::Pass
        );
        // 横取りしていたものは、離すのも横取りする。1 度だけ。
        gate.filter(
            InputEvent::MouseDown(MouseButton::X1),
            Decision::SwallowAndTrigger,
        );
        assert_eq!(
            gate.filter(InputEvent::MouseUp(MouseButton::X1), Decision::Swallow),
            Decision::Swallow
        );
        assert_eq!(
            gate.filter(InputEvent::MouseUp(MouseButton::X1), Decision::Swallow),
            Decision::Pass
        );
        // 割り当ての判定が Pass でも（途中で割り当てが変わっても）、横取りしていたものは離すのを横取りする。
        gate.filter(InputEvent::KeyDown(F8), Decision::SwallowAndTrigger);
        assert_eq!(
            gate.filter(InputEvent::KeyUp(F8), Decision::Pass),
            Decision::Swallow
        );
    }

    #[test]
    fn held_gate_passes_through_unrelated_decisions() {
        let gate = HeldGate::new();
        assert_eq!(
            gate.filter(InputEvent::KeyDown(0x41), Decision::Pass),
            Decision::Pass
        );
        assert_eq!(
            gate.filter(InputEvent::MouseDown(MouseButton::Left), Decision::Pass),
            Decision::Pass
        );
    }

    #[test]
    fn held_gate_reset_forgets_a_held_key_and_button() {
        let gate = HeldGate::new();
        let down = InputEvent::KeyDown(F8);
        gate.filter(down, Decision::SwallowAndTrigger);
        gate.filter(
            InputEvent::MouseDown(MouseButton::X2),
            Decision::SwallowAndTrigger,
        );
        gate.reset();
        assert_eq!(
            gate.filter(down, Decision::SwallowAndTrigger),
            Decision::SwallowAndTrigger
        );
        assert_eq!(
            gate.filter(InputEvent::MouseUp(MouseButton::X2), Decision::Swallow),
            Decision::Pass
        );
    }

    #[test]
    fn a_mouse_press_after_a_missed_release_is_a_new_press_not_a_repeat() {
        let gate = HeldGate::new();
        let down = InputEvent::MouseDown(MouseButton::X1);
        assert_eq!(
            gate.filter(down, Decision::SwallowAndTrigger),
            Decision::SwallowAndTrigger
        );
        // 離す知らせを取りこぼしても、次の押下はまた記録する（マウスのボタンに自動リピートは無い）。
        assert_eq!(
            gate.filter(down, Decision::SwallowAndTrigger),
            Decision::SwallowAndTrigger
        );
    }

    // ---- 設定の詰め方 ----

    #[test]
    fn config_pack_and_unpack_round_trip() {
        let triggers = [
            None,
            Some(ActiveTrigger::Mouse(MouseButton::X1)),
            Some(ActiveTrigger::Mouse(MouseButton::X2)),
            Some(ActiveTrigger::Mouse(MouseButton::Middle)),
            Some(ActiveTrigger::key(F8, NONE)),
            Some(ActiveTrigger::key(0xDE, NONE)),
            Some(ActiveTrigger::key(KEY_M, CTRL_ALT)),
            Some(ActiveTrigger::key(
                F13,
                Modifiers::new(true, true, true, true),
            )),
        ];
        for trigger in triggers {
            for mode in [Mode::Normal, Mode::Test, Mode::Register] {
                let config = Config { trigger, mode };
                assert_eq!(Config::unpack(config.pack()), config);
            }
        }
        assert_eq!(Config::OFF.pack(), 0);
        assert_eq!(Config::unpack(0), Config::OFF);
    }

    #[test]
    fn w9_the_hooks_that_are_needed_follow_the_trigger_and_the_mode() {
        let mouse_cfg = Config {
            trigger: Some(mouse(MouseButton::X1)),
            mode: Mode::Normal,
        };
        assert!(mouse_cfg.needs_mouse_hook() && !mouse_cfg.needs_keyboard_hook());
        let key_cfg = Config {
            trigger: Some(ActiveTrigger::key(F13, NONE)),
            mode: Mode::Test,
        };
        assert!(!key_cfg.needs_mouse_hook() && key_cfg.needs_keyboard_hook());
        // 登録の待機中は、どちらの入力も候補になるので、両方のフックが要る。
        for trigger in [None, mouse_cfg.trigger, key_cfg.trigger] {
            let register = Config {
                trigger,
                mode: Mode::Register,
            };
            assert!(register.needs_mouse_hook() && register.needs_keyboard_hook());
        }
        // 割り当てが無ければ、フックは要らない。
        assert!(!Config::OFF.needs_mouse_hook() && !Config::OFF.needs_keyboard_hook());
    }

    #[test]
    fn w10_the_keyboard_hook_is_left_out_while_it_is_not_allowed_whatever_the_configuration() {
        let configs = [
            Config::OFF,
            Config {
                trigger: Some(mouse(MouseButton::X1)),
                mode: Mode::Normal,
            },
            Config {
                trigger: Some(ActiveTrigger::key(F13, NONE)),
                mode: Mode::Normal,
            },
            Config {
                trigger: Some(ActiveTrigger::key(F13, NONE)),
                mode: Mode::Test,
            },
            Config {
                trigger: None,
                mode: Mode::Register,
            },
        ];
        for config in configs {
            assert!(
                !config.wants_keyboard_hook(false),
                "許可されていない間は、{config:?} でも入れない"
            );
            assert_eq!(
                config.wants_keyboard_hook(true),
                config.needs_keyboard_hook(),
                "許可されていれば、設定が要るとおり: {config:?}"
            );
            // マウスのフックは、キーボードの許可に関わらず、設定が要るとおり。
            let _ = config.needs_mouse_hook();
        }
    }

    // ---- 登録の待機中の判定（W-10） ----

    #[test]
    fn w10_registering_captures_x1_x2_and_the_middle_button() {
        for button in [MouseButton::X1, MouseButton::X2, MouseButton::Middle] {
            assert_eq!(
                decide_register(InputEvent::MouseDown(button), NONE),
                RegisterDecision::Capture(ActiveTrigger::Mouse(button))
            );
        }
    }

    #[test]
    fn w10_registering_never_captures_the_left_or_right_button() {
        for button in [MouseButton::Left, MouseButton::Right] {
            assert_eq!(
                decide_register(InputEvent::MouseDown(button), NONE),
                RegisterDecision::Pass,
                "{button:?} は画面の操作に要る"
            );
        }
    }

    #[test]
    fn w10_registering_captures_a_key_with_its_modifiers() {
        assert_eq!(
            decide_register(InputEvent::KeyDown(F13), NONE),
            RegisterDecision::Capture(ActiveTrigger::key(F13, NONE))
        );
        assert_eq!(
            decide_register(InputEvent::KeyDown(KEY_M), CTRL_ALT),
            RegisterDecision::Capture(ActiveTrigger::key(KEY_M, CTRL_ALT))
        );
        // 文字の入力のキーは、そのままでは拾わない。
        assert_eq!(
            decide_register(InputEvent::KeyDown(KEY_M), NONE),
            RegisterDecision::Pass
        );
    }

    #[test]
    fn w10_escape_cancels_tab_is_not_registrable_and_modifiers_alone_do_not_register() {
        assert_eq!(
            decide_register(InputEvent::KeyDown(VK_ESCAPE), NONE),
            RegisterDecision::Cancel
        );
        assert_eq!(
            decide_register(InputEvent::KeyDown(VK_ESCAPE), CTRL_ALT),
            RegisterDecision::Cancel
        );
        for mods in [NONE, CTRL_ALT, Modifiers::new(false, true, false, false)] {
            assert_eq!(
                decide_register(InputEvent::KeyDown(VK_TAB), mods),
                RegisterDecision::Pass,
                "Alt+Tab のような切り替えも邪魔しない"
            );
        }
        for vk in [0x10, 0x11, 0x12, 0xA0, 0xA2, 0xA4, 0x5B] {
            assert_eq!(
                decide_register(InputEvent::KeyDown(vk), CTRL_ALT),
                RegisterDecision::Pass,
                "修飾キー単独 {vk:#04x}"
            );
        }
        // キーを離すことは、登録の判定には入らない。
        assert_eq!(
            decide_register(InputEvent::KeyUp(F13), NONE),
            RegisterDecision::Pass
        );
    }

    #[test]
    fn w10_only_registrable_inputs_are_accepted_as_candidates() {
        assert!(ActiveTrigger::Mouse(MouseButton::X1).registrable());
        assert!(ActiveTrigger::Mouse(MouseButton::Middle).registrable());
        assert!(!ActiveTrigger::Mouse(MouseButton::Left).registrable());
        assert!(!ActiveTrigger::Mouse(MouseButton::Right).registrable());
        assert!(ActiveTrigger::key(F13, NONE).registrable());
        assert!(ActiveTrigger::key(KEY_M, CTRL_ALT).registrable());
        assert!(!ActiveTrigger::key(KEY_M, NONE).registrable());
        assert!(!ActiveTrigger::key(VK_ESCAPE, CTRL_ALT).registrable());
        assert!(!ActiveTrigger::key(VK_TAB, NONE).registrable());
    }

    // ---- InputCore ----

    #[test]
    fn w2_core_swallows_the_back_button_hands_over_the_time_and_passes_everything_else() {
        let core = InputCore::new();
        assert_eq!(core.config(), Config::OFF);
        assert_eq!(
            core.on_mouse(wm::XBUTTONDOWN, wm::XBUTTON1 << 16, 1),
            Outcome::PASS,
            "割り当ての前は、何も止めない"
        );

        core.set_config(Config {
            trigger: Some(mouse(MouseButton::X1)),
            mode: Mode::Normal,
        });
        // 「戻る」: 押下は止めて合図を渡し、離すのは止めるだけ。
        assert_eq!(
            core.on_mouse(wm::XBUTTONDOWN, wm::XBUTTON1 << 16, 1_760_000_000_123),
            Outcome {
                swallow: true,
                report: Some(Report::Trigger {
                    t_ms: 1_760_000_000_123
                })
            }
        );
        assert_eq!(
            core.on_mouse(wm::XBUTTONUP, wm::XBUTTON1 << 16, 1_760_000_000_200),
            Outcome::SWALLOW
        );
        // 「進む」・左・右・中・移動は、そのまま通す。
        for (message, data) in [
            (wm::XBUTTONDOWN, wm::XBUTTON2 << 16),
            (wm::XBUTTONUP, wm::XBUTTON2 << 16),
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
                Outcome::PASS,
                "{message:#06x}"
            );
        }
        assert_eq!(core.on_keyboard(wm::KEYDOWN, F8, 6, || NONE), Outcome::PASS);
    }

    #[test]
    fn w2_changing_the_assignment_takes_effect_on_the_next_input() {
        let core = core_with(Some(mouse(MouseButton::X2)), Mode::Normal);
        let x1 = wm::XBUTTON1 << 16;
        let x2 = wm::XBUTTON2 << 16;
        assert_eq!(core.on_mouse(wm::XBUTTONDOWN, x1, 1), Outcome::PASS);
        assert_eq!(
            core.on_mouse(wm::XBUTTONDOWN, x2, 2).report,
            Some(Report::Trigger { t_ms: 2 })
        );
        assert_eq!(core.on_mouse(wm::XBUTTONUP, x2, 2), Outcome::SWALLOW);
        core.set_config(Config {
            trigger: Some(mouse(MouseButton::Middle)),
            mode: Mode::Normal,
        });
        assert_eq!(core.on_mouse(wm::XBUTTONDOWN, x2, 3), Outcome::PASS);
        assert_eq!(
            core.on_mouse(wm::MBUTTONDOWN, 0, 4).report,
            Some(Report::Trigger { t_ms: 4 })
        );
        assert_eq!(core.on_mouse(wm::MBUTTONUP, 0, 5), Outcome::SWALLOW);
        core.set_config(Config::OFF);
        assert_eq!(core.on_mouse(wm::MBUTTONDOWN, 0, 6), Outcome::PASS);
    }

    #[test]
    fn w2_a_key_assignment_swallows_the_key_only_and_records_once_while_held() {
        let core = core_with(Some(ActiveTrigger::key(F8, NONE)), Mode::Normal);
        assert_eq!(
            core.on_keyboard(wm::KEYDOWN, F8, 10, || NONE),
            Outcome {
                swallow: true,
                report: Some(Report::Trigger { t_ms: 10 })
            }
        );
        // 押し続けたときの自動リピート（2 回目以降の押下）は、止めるだけ。
        assert_eq!(
            core.on_keyboard(wm::KEYDOWN, F8, 11, || NONE),
            Outcome::SWALLOW
        );
        assert_eq!(
            core.on_keyboard(wm::KEYDOWN, F8, 12, || NONE),
            Outcome::SWALLOW
        );
        assert_eq!(
            core.on_keyboard(wm::KEYUP, F8, 13, || NONE),
            Outcome::SWALLOW
        );
        // 離したあとの次の押下は、また記録する。
        assert_eq!(
            core.on_keyboard(wm::SYSKEYDOWN, F8, 14, || NONE).report,
            Some(Report::Trigger { t_ms: 14 })
        );
        // ほかのキーとマウスのボタンは通す。
        assert_eq!(
            core.on_keyboard(wm::KEYDOWN, F8 + 1, 15, || NONE),
            Outcome::PASS
        );
        assert_eq!(
            core.on_mouse(wm::XBUTTONDOWN, wm::XBUTTON1 << 16, 16),
            Outcome::PASS
        );
    }

    #[test]
    fn w10_a_chord_assignment_needs_the_same_modifiers_and_swallows_the_release_after_a_modifier_let_go(
    ) {
        let core = core_with(Some(ActiveTrigger::key(KEY_M, CTRL_ALT)), Mode::Normal);
        // 修飾キーが違えば通す。
        assert_eq!(
            core.on_keyboard(wm::KEYDOWN, KEY_M, 1, || NONE),
            Outcome::PASS
        );
        assert_eq!(
            core.on_keyboard(wm::KEYUP, KEY_M, 2, || NONE),
            Outcome::PASS,
            "押下を通したキーを離すのも通す"
        );
        // Ctrl+Alt+M: 止めて知らせる。修飾キーを先に離しても、M を離すのは止める。
        assert_eq!(
            core.on_keyboard(wm::KEYDOWN, KEY_M, 3, || CTRL_ALT),
            Outcome {
                swallow: true,
                report: Some(Report::Trigger { t_ms: 3 })
            }
        );
        assert_eq!(
            core.on_keyboard(wm::KEYUP, KEY_M, 4, || NONE),
            Outcome::SWALLOW
        );
        // 修飾キー自体は、いつも通す。
        for vk in [0xA2, 0xA4] {
            assert_eq!(
                core.on_keyboard(wm::KEYDOWN, vk, 5, || CTRL_ALT),
                Outcome::PASS
            );
        }
    }

    #[test]
    fn the_modifier_state_is_only_asked_for_when_it_matters() {
        let core = core_with(Some(ActiveTrigger::key(F13, NONE)), Mode::Normal);
        let asked = std::cell::Cell::new(0);
        let ask = || {
            asked.set(asked.get() + 1);
            NONE
        };
        core.on_keyboard(wm::KEYDOWN, 0x41, 1, ask);
        core.on_keyboard(wm::KEYDOWN, 0xA2, 1, ask);
        core.on_keyboard(wm::KEYUP, F13, 1, ask);
        assert_eq!(asked.get(), 0, "関係の無いキーのたびに OS へ問い合わせない");
        core.on_keyboard(wm::KEYDOWN, F13, 1, ask);
        assert_eq!(asked.get(), 1);
    }

    #[test]
    fn w2_changing_the_assignment_while_held_still_swallows_the_release() {
        let core = core_with(Some(ActiveTrigger::key(F8, NONE)), Mode::Normal);
        assert!(core.on_keyboard(wm::KEYDOWN, F8, 1, || NONE).swallow);
        core.set_config(Config {
            trigger: Some(ActiveTrigger::key(F13, NONE)),
            mode: Mode::Normal,
        });
        assert_eq!(
            core.on_keyboard(wm::KEYUP, F8, 2, || NONE),
            Outcome::SWALLOW,
            "割り当てを変えたあとも、横取りした押下の離しは横取りする"
        );
        // 割り当てを外したあと（フックを外すとき）は、押下中の状態を捨てる。
        assert!(core.on_keyboard(wm::KEYDOWN, F13, 3, || NONE).swallow);
        core.set_config(Config::OFF);
        core.reset();
        assert_eq!(core.on_keyboard(wm::KEYUP, F13, 4, || NONE), Outcome::PASS);
    }

    #[test]
    fn w10_register_mode_reports_the_first_registrable_input_and_swallows_it_with_its_release() {
        let core = core_with(Some(mouse(MouseButton::X1)), Mode::Register);
        let x2 = wm::XBUTTON2 << 16;
        // 左右のボタンは通す（「キャンセル」を押せる）。
        assert_eq!(core.on_mouse(wm::LBUTTONDOWN, 0, 1), Outcome::PASS);
        assert_eq!(core.on_mouse(wm::LBUTTONUP, 0, 1), Outcome::PASS);
        assert_eq!(core.on_mouse(wm::RBUTTONDOWN, 0, 1), Outcome::PASS);
        assert_eq!(core.on_mouse(wm::RBUTTONUP, 0, 1), Outcome::PASS);
        // 「進む」ボタン: 拾って止める。離すのも止める。
        assert_eq!(
            core.on_mouse(wm::XBUTTONDOWN, x2, 2),
            Outcome {
                swallow: true,
                report: Some(Report::Captured(mouse(MouseButton::X2)))
            }
        );
        assert_eq!(core.on_mouse(wm::XBUTTONUP, x2, 3), Outcome::SWALLOW);
        // 割り当て済みのボタンを押しても、迷いマークの合図ではなく、候補として拾う。
        assert_eq!(
            core.on_mouse(wm::XBUTTONDOWN, wm::XBUTTON1 << 16, 4).report,
            Some(Report::Captured(mouse(MouseButton::X1)))
        );
    }

    #[test]
    fn w10_register_mode_keys_escape_tab_and_chords() {
        let core = core_with(None, Mode::Register);
        // Tab は通す。登録しない。
        assert_eq!(
            core.on_keyboard(wm::KEYDOWN, VK_TAB, 1, || NONE),
            Outcome::PASS
        );
        // Esc は通したうえで、やめる合図を出す。
        assert_eq!(
            core.on_keyboard(wm::KEYDOWN, VK_ESCAPE, 2, || NONE),
            Outcome {
                swallow: false,
                report: Some(Report::Cancel)
            }
        );
        // 文字のキーは通す（登録しない）。
        assert_eq!(
            core.on_keyboard(wm::KEYDOWN, KEY_M, 3, || NONE),
            Outcome::PASS
        );
        // 修飾キー単独は通す。
        assert_eq!(
            core.on_keyboard(wm::KEYDOWN, 0xA2, 4, || CTRL_ALT),
            Outcome::PASS
        );
        // F13: 拾って止める。押し続けても 1 度だけ知らせる。離すのも止める。
        assert_eq!(
            core.on_keyboard(wm::KEYDOWN, F13, 5, || NONE),
            Outcome {
                swallow: true,
                report: Some(Report::Captured(ActiveTrigger::key(F13, NONE)))
            }
        );
        assert_eq!(
            core.on_keyboard(wm::KEYDOWN, F13, 6, || NONE),
            Outcome::SWALLOW
        );
        assert_eq!(
            core.on_keyboard(wm::KEYUP, F13, 7, || NONE),
            Outcome::SWALLOW
        );
        // Ctrl+Alt+M も拾う。
        assert_eq!(
            core.on_keyboard(wm::KEYDOWN, KEY_M, 8, || CTRL_ALT).report,
            Some(Report::Captured(ActiveTrigger::key(KEY_M, CTRL_ALT)))
        );
    }

    #[test]
    fn w10_the_release_of_a_captured_input_is_swallowed_even_after_registration_ends() {
        let core = core_with(None, Mode::Register);
        let x1 = wm::XBUTTON1 << 16;
        assert!(core.on_mouse(wm::XBUTTONDOWN, x1, 1).swallow);
        // 登録が終わって、通常の動きに戻る（割り当ては保存の途中でまだ古い）。
        core.set_config(Config {
            trigger: Some(mouse(MouseButton::X2)),
            mode: Mode::Normal,
        });
        assert_eq!(core.on_mouse(wm::XBUTTONUP, x1, 2), Outcome::SWALLOW);
    }

    #[test]
    fn w11_test_mode_reports_the_assigned_button_like_normal_mode() {
        let core = core_with(Some(mouse(MouseButton::X1)), Mode::Test);
        assert_eq!(
            core.on_mouse(wm::XBUTTONDOWN, wm::XBUTTON1 << 16, 9),
            Outcome {
                swallow: true,
                report: Some(Report::Trigger { t_ms: 9 })
            }
        );
    }

    // ---- Windows のメッセージの読み取り ----

    #[test]
    fn w2_mouse_messages_become_events_and_x_buttons_are_told_apart_by_the_high_word() {
        use InputEvent::{MouseDown, MouseUp};
        let x1 = wm::XBUTTON1 << 16;
        let x2 = wm::XBUTTON2 << 16;
        assert_eq!(
            translate_mouse(wm::XBUTTONDOWN, x1),
            Some(MouseDown(MouseButton::X1))
        );
        assert_eq!(
            translate_mouse(wm::XBUTTONUP, x1),
            Some(MouseUp(MouseButton::X1))
        );
        assert_eq!(
            translate_mouse(wm::XBUTTONDOWN, x2),
            Some(MouseDown(MouseButton::X2))
        );
        assert_eq!(
            translate_mouse(wm::XBUTTONUP, x2),
            Some(MouseUp(MouseButton::X2))
        );
        // 下位ワードの値には左右されない（上位ワードだけが番号）。
        assert_eq!(
            translate_mouse(wm::XBUTTONDOWN, x1 | 0x1234),
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
            assert_eq!(translate_mouse(other, x1), None, "{other:#06x}");
        }
    }

    #[test]
    fn w2_keyboard_messages_become_events() {
        assert_eq!(
            translate_keyboard(wm::KEYDOWN, F8),
            Some(InputEvent::KeyDown(F8))
        );
        assert_eq!(
            translate_keyboard(wm::SYSKEYDOWN, F8),
            Some(InputEvent::KeyDown(F8)),
            "Alt を押しながらの押下も同じ"
        );
        assert_eq!(
            translate_keyboard(wm::KEYUP, F8),
            Some(InputEvent::KeyUp(F8))
        );
        assert_eq!(
            translate_keyboard(wm::SYSKEYUP, F8),
            Some(InputEvent::KeyUp(F8))
        );
        assert_eq!(translate_keyboard(0x0102, F8), None, "WM_CHAR は判定しない");
    }

    #[test]
    fn registered_codes_resolve_to_the_virtual_keys_the_hook_compares() {
        // 設定の名前（F13・KeyM）から、フックが比べる仮想キーコードになる。
        assert_eq!(vk_from_code("F13"), Some(F13));
        assert_eq!(vk_from_code("KeyM"), Some(KEY_M));
    }
}
