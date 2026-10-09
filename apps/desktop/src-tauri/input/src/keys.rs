//! キーの名前と仮想キーコード（VK_*）の対応、修飾キー、登録できるキーの決まり（W-10）。
//!
//! 設定には DOM の `KeyboardEvent.code`（"F13"・"KeyM" など）で保存し、フックの中では仮想キーコードで比べる。
//! 登録で拾ったキー（仮想キーコード）を設定に保存できるよう、逆向きの対応（`code_from_vk`）も持つ。

/// Tab の仮想キーコード。登録の待機中も、押せなくならないよう、どの場合も通す。
pub const VK_TAB: u32 = 0x09;
/// Esc の仮想キーコード。登録の待機中は、登録をやめる合図になる。
pub const VK_ESCAPE: u32 = 0x1B;

/// 修飾キーの押下の状態。
#[derive(Debug, Clone, Copy, Default, PartialEq, Eq)]
pub struct Modifiers {
    pub ctrl: bool,
    pub alt: bool,
    pub shift: bool,
    /// Windows キー。
    pub win: bool,
}

impl Modifiers {
    pub const NONE: Modifiers = Modifiers {
        ctrl: false,
        alt: false,
        shift: false,
        win: false,
    };

    pub const fn new(ctrl: bool, alt: bool, shift: bool, win: bool) -> Modifiers {
        Modifiers {
            ctrl,
            alt,
            shift,
            win,
        }
    }

    /// 1 つの整数に詰める（下位 4 ビット）。
    pub fn bits(self) -> u8 {
        u8::from(self.ctrl)
            | (u8::from(self.alt) << 1)
            | (u8::from(self.shift) << 2)
            | (u8::from(self.win) << 3)
    }

    pub fn from_bits(bits: u8) -> Modifiers {
        Modifiers {
            ctrl: bits & 1 != 0,
            alt: bits & 2 != 0,
            shift: bits & 4 != 0,
            win: bits & 8 != 0,
        }
    }

    /// Ctrl・Alt・Windows のどれかを押しているか。Shift だけでは、文字の入力と区別が付かない。
    pub fn has_command_modifier(self) -> bool {
        self.ctrl || self.alt || self.win
    }
}

/// 修飾キーそのものか（Shift・Ctrl・Alt・Windows。左右の別も含む）。修飾キー単独は、割り当てにも登録にも使わない。
pub fn is_modifier_vk(vk: u32) -> bool {
    matches!(vk, 0x10..=0x12 | 0xA0..=0xA5 | 0x5B | 0x5C)
}

/// 文字の入力に使うキー（英字・数字・テンキー・記号）。これらは、Ctrl・Alt・Windows と組み合わせたときだけ登録できる
/// （そのまま登録すると、どのアプリでも文字を打てなくなる。補助プログラムが登録のために知らせるキーも、これで絞られる）。
pub fn is_typing_key(vk: u32) -> bool {
    matches!(vk, 0x30..=0x39 | 0x41..=0x5A | 0x60..=0x6F | 0xBA..=0xC0 | 0xDB..=0xDE)
}

/// 登録できる入力か。設定に保存できるキー（`code_from_vk` がある）で、
/// 文字の入力に使うキーなら Ctrl・Alt・Windows のどれかと組み合わせていること。
pub fn registrable_key(vk: u32, mods: Modifiers) -> bool {
    code_from_vk(vk).is_some() && (!is_typing_key(vk) || mods.has_command_modifier())
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

/// 仮想キーコードを DOM の `KeyboardEvent.code` にする（`vk_from_code` の逆）。割り当てられないキーは `None`。
pub fn code_from_vk(vk: u32) -> Option<String> {
    let named = match vk {
        0x41..=0x5A => return Some(format!("Key{}", char::from_u32(vk)?)),
        0x30..=0x39 => return Some(format!("Digit{}", char::from_u32(vk)?)),
        0x60..=0x69 => return Some(format!("Numpad{}", vk - 0x60)),
        0x70..=0x87 => return Some(format!("F{}", vk - 0x70 + 1)),
        0x6A => "NumpadMultiply",
        0x6B => "NumpadAdd",
        0x6D => "NumpadSubtract",
        0x6E => "NumpadDecimal",
        0x6F => "NumpadDivide",
        0x2D => "Insert",
        0x2E => "Delete",
        0x24 => "Home",
        0x23 => "End",
        0x21 => "PageUp",
        0x22 => "PageDown",
        0x91 => "ScrollLock",
        0x13 => "Pause",
        0xC0 => "Backquote",
        0xBD => "Minus",
        0xBB => "Equal",
        0xDB => "BracketLeft",
        0xDD => "BracketRight",
        0xDC => "Backslash",
        0xBA => "Semicolon",
        0xDE => "Quote",
        0xBC => "Comma",
        0xBE => "Period",
        0xBF => "Slash",
        _ => return None,
    };
    Some(named.to_string())
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn key_codes_map_to_virtual_keys() {
        assert_eq!(vk_from_code("KeyA"), Some(0x41));
        assert_eq!(vk_from_code("KeyZ"), Some(0x5A));
        assert_eq!(vk_from_code("Digit0"), Some(0x30));
        assert_eq!(vk_from_code("Digit9"), Some(0x39));
        assert_eq!(vk_from_code("F1"), Some(0x70));
        assert_eq!(vk_from_code("F8"), Some(0x77));
        assert_eq!(vk_from_code("F12"), Some(0x7B));
        assert_eq!(vk_from_code("F13"), Some(0x7C));
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

    #[test]
    fn w10_code_from_vk_is_the_exact_inverse_of_vk_from_code() {
        let mut count = 0;
        for vk in 0..=0xFFu32 {
            if let Some(code) = code_from_vk(vk) {
                assert_eq!(vk_from_code(&code), Some(vk), "vk {vk:#04x} -> {code}");
                count += 1;
            }
        }
        // 英字 26・数字 10・テンキー 10 + 5・ファンクション 24・編集と制御 8・記号 11
        assert_eq!(count, 26 + 10 + 10 + 5 + 24 + 8 + 11);
        // 割り当てられるキーの名前は、逆にたどっても同じ名前に戻る。
        for code in [
            "KeyM",
            "Digit7",
            "F13",
            "Numpad3",
            "NumpadDivide",
            "Insert",
            "Slash",
        ] {
            let vk = vk_from_code(code).unwrap();
            assert_eq!(code_from_vk(vk).as_deref(), Some(code));
        }
    }

    #[test]
    fn w10_modifier_bits_round_trip() {
        for bits in 0..16u8 {
            assert_eq!(Modifiers::from_bits(bits).bits(), bits);
        }
        let m = Modifiers::new(true, true, false, false);
        assert_eq!(m.bits(), 0b0011);
        assert!(m.has_command_modifier());
        assert!(!Modifiers::new(false, false, true, false).has_command_modifier());
        assert!(!Modifiers::NONE.has_command_modifier());
        assert!(Modifiers::new(false, false, false, true).has_command_modifier());
    }

    #[test]
    fn w10_modifier_keys_are_recognized_left_and_right() {
        for vk in [
            0x10, 0x11, 0x12, 0xA0, 0xA1, 0xA2, 0xA3, 0xA4, 0xA5, 0x5B, 0x5C,
        ] {
            assert!(is_modifier_vk(vk), "{vk:#04x}");
        }
        for vk in [0x41, 0x7C, 0x09, 0x1B, 0x5D, 0x14] {
            assert!(!is_modifier_vk(vk), "{vk:#04x}");
        }
    }

    #[test]
    fn w10_function_and_editing_keys_register_alone_but_typing_keys_need_ctrl_alt_or_win() {
        let none = Modifiers::NONE;
        let shift = Modifiers::new(false, false, true, false);
        let ctrl_alt = Modifiers::new(true, true, false, false);
        let win = Modifiers::new(false, false, false, true);
        // F13（ゲーミングマウスのマクロでよく使われる）は、そのまま登録できる。
        assert!(registrable_key(0x7C, none));
        assert!(registrable_key(0x70, none));
        assert!(registrable_key(0x2D, none)); // Insert
        assert!(registrable_key(0x13, none)); // Pause
                                              // 文字の入力に使うキーは、そのままでは登録できない。Shift だけでも足りない。
        assert!(!registrable_key(0x4D, none)); // M
        assert!(!registrable_key(0x4D, shift));
        assert!(!registrable_key(0x35, none)); // 5
        assert!(!registrable_key(0x65, none)); // テンキーの 5
        assert!(!registrable_key(0xBF, none)); // /
                                               // Ctrl+Alt+M のように組み合わせれば登録できる。
        assert!(registrable_key(0x4D, ctrl_alt));
        assert!(registrable_key(0x4D, win));
        assert!(registrable_key(
            0x65,
            Modifiers::new(true, false, false, false)
        ));
        // 割り当てられないキー（Esc・Tab・Enter・Space・矢印など）は、修飾キーがあっても登録できない。
        for vk in [
            0x1B, 0x09, 0x0D, 0x20, 0x08, 0x25, 0x26, 0x27, 0x28, 0x14, 0xA0,
        ] {
            assert!(!registrable_key(vk, ctrl_alt), "{vk:#04x}");
        }
    }
}
