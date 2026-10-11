//! 半荘を通して見る画面（F12）のキーの割り当て（R10-3）。設定ファイル（settings.json）の `replay_keys` に、
//! 操作の名前 → キー（割り当て無しは null）の形で保存する。画面の側（`apps/desktop/src/main/replay/keys.ts`）と同じ表を持ち、
//! ここは、保存するときの検査と、設定ファイルの読み込みの補いだけを受け持つ（キーを拾うのは画面）。
//!
//! キーは、`KeyboardEvent.code` に、押していた修飾キーを `Ctrl+` `Alt+` `Shift+` の順に付けた文字（例: `Shift+ArrowUp`・`Comma`）。
//! - 使えるのは、英字・数字・矢印・`,` `.` などの記号のキー・Home/End/PageUp/PageDown
//! - 割り当てられない: 画面の操作に使うキー（Tab・Esc・Enter・Space）、画面の戻る・進む（Alt+←・Alt+→）、検索の重ね表示（Ctrl+K）、
//!   取り消しとやり直し（Ctrl+Z・Ctrl+Y・Ctrl+Shift+Z）
//! - 同じキーを 2 つの操作に割り当てられない（入れ替えもしない）

use std::collections::BTreeMap;
use std::fmt;

/// 操作の名前 → キー。割り当て無しは `None`。
pub type ReplayKeys = BTreeMap<String, Option<String>>;

/// 操作と、既定のキー（割り当て無しは `None`）。画面の表と同じ並び・同じ名前（試験が、画面のソースと突き合わせる）。
pub const ACTIONS: [(&str, Option<&str>); 14] = [
    ("step_back", Some("Comma")),
    ("step_forward", Some("Period")),
    ("prev_decision", Some("ArrowLeft")),
    ("next_decision", Some("ArrowRight")),
    ("prev_mismatch", Some("ArrowUp")),
    ("next_mismatch", Some("ArrowDown")),
    ("prev_doubt", Some("Shift+ArrowUp")),
    ("next_doubt", Some("Shift+ArrowDown")),
    ("prev_kyoku", Some("Shift+ArrowLeft")),
    ("next_kyoku", Some("Shift+ArrowRight")),
    ("prev_turn", None),
    ("next_turn", None),
    ("kyoku_start", None),
    ("kyoku_end", None),
];

/// 割り当てられないキー（画面の操作に使う）。修飾キーを足しても、同じキーとして断る。
const RESERVED_CODES: [&str; 5] = ["Tab", "Escape", "Enter", "NumpadEnter", "Space"];

/// キーの割り当ての問題。
#[derive(Debug, Clone, PartialEq, Eq)]
pub enum ReplayKeysError {
    /// 知らない操作の名前。
    UnknownAction(String),
    /// 形が正しくない・使えないキー。
    InvalidKey { action: String, key: String },
    /// 割り当てられないキー。
    ReservedKey { action: String, key: String },
    /// 同じキーが 2 つの操作に割り当てられている。
    DuplicateKey {
        key: String,
        first: String,
        second: String,
    },
}

impl fmt::Display for ReplayKeysError {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        match self {
            ReplayKeysError::UnknownAction(action) => {
                write!(f, "キーを割り当てられない操作です: {action}")
            }
            ReplayKeysError::InvalidKey { action, key } => {
                write!(f, "このキーは割り当てられません（{action}）: {key}")
            }
            ReplayKeysError::ReservedKey { action, key } => write!(
                f,
                "このキーは、画面の操作・戻る・進む・検索・取り消しに使うので、割り当てられません（{action}）: {key}"
            ),
            ReplayKeysError::DuplicateKey { key, first, second } => write!(
                f,
                "同じキーを 2 つの操作に割り当てられません（{first} と {second}）: {key}"
            ),
        }
    }
}

impl std::error::Error for ReplayKeysError {}

/// 既定の割り当て（すべての操作が入っている）。
pub fn default_keys() -> ReplayKeys {
    ACTIONS
        .iter()
        .map(|(action, key)| ((*action).to_string(), key.map(str::to_string)))
        .collect()
}

fn is_known_code(code: &str) -> bool {
    if let Some(letter) = code.strip_prefix("Key") {
        return letter.len() == 1 && letter.chars().all(|c| c.is_ascii_uppercase());
    }
    if let Some(digit) = code.strip_prefix("Digit") {
        return digit.len() == 1 && digit.chars().all(|c| c.is_ascii_digit());
    }
    matches!(
        code,
        "ArrowUp"
            | "ArrowDown"
            | "ArrowLeft"
            | "ArrowRight"
            | "Comma"
            | "Period"
            | "Slash"
            | "Semicolon"
            | "Quote"
            | "BracketLeft"
            | "BracketRight"
            | "Backslash"
            | "Minus"
            | "Equal"
            | "Backquote"
            | "Home"
            | "End"
            | "PageUp"
            | "PageDown"
    )
}

/// 修飾キーとキーに分ける（`Ctrl+` `Alt+` `Shift+` を、順は問わず、1 つずつ。キーの部分は、どんな文字でもよい）。形が正しくなければ `None`。
fn split_chord(chord: &str) -> Option<(bool, bool, bool, &str)> {
    let mut parts: Vec<&str> = chord.trim().split('+').collect();
    let code = parts.pop()?;
    let (mut ctrl, mut alt, mut shift) = (false, false, false);
    for part in parts {
        let flag = match part {
            "Ctrl" => &mut ctrl,
            "Alt" => &mut alt,
            "Shift" => &mut shift,
            _ => return None,
        };
        if *flag {
            return None;
        }
        *flag = true;
    }
    if code.is_empty() {
        return None;
    }
    Some((ctrl, alt, shift, code))
}

/// 修飾キーとキーを、決まった並び（`Ctrl+Alt+Shift+` の順）の文字にする。形が正しくなければ `None`。
/// キーの部分が、使えるキーでなければ `None`（割り当てられないキーも、ここでは `None`）。
pub fn canonical_chord(chord: &str) -> Option<String> {
    let (ctrl, alt, shift, code) = split_chord(chord)?;
    if !is_known_code(code) {
        return None;
    }
    let mut out = String::new();
    if ctrl {
        out.push_str("Ctrl+");
    }
    if alt {
        out.push_str("Alt+");
    }
    if shift {
        out.push_str("Shift+");
    }
    out.push_str(code);
    Some(out)
}

/// 割り当てられない入力か。
/// - Tab・Esc・Enter・Space: 画面の操作に使う（修飾キーが付いていても）
/// - Alt+←・Alt+→: 画面の戻る・進む
/// - Ctrl+K: 検索の重ね表示。Ctrl+Z・Ctrl+Y（Shift が付いても）: 取り消しとやり直し
pub fn is_reserved(chord: &str) -> bool {
    let Some((ctrl, alt, shift, code)) = split_chord(chord) else {
        return false;
    };
    if RESERVED_CODES.contains(&code) {
        return true;
    }
    if ctrl && matches!(code, "KeyK" | "KeyZ" | "KeyY") {
        return true;
    }
    alt && !ctrl && !shift && matches!(code, "ArrowLeft" | "ArrowRight")
}

fn known_action(action: &str) -> bool {
    ACTIONS.iter().any(|(name, _)| *name == action)
}

/// 割り当てを検査する。知らない操作・使えないキー・割り当てられないキー・同じキーの重なりがあればエラー。
/// 操作が足りないものは、問題にしない（足りない分は、読み込みで既定値が入る）。
pub fn validate(keys: &ReplayKeys) -> Result<(), ReplayKeysError> {
    let mut used: BTreeMap<String, String> = BTreeMap::new();
    for (action, key) in keys {
        if !known_action(action) {
            return Err(ReplayKeysError::UnknownAction(action.clone()));
        }
        let Some(key) = key else { continue };
        if is_reserved(key) {
            return Err(ReplayKeysError::ReservedKey {
                action: action.clone(),
                key: key.clone(),
            });
        }
        let Some(canonical) = canonical_chord(key) else {
            return Err(ReplayKeysError::InvalidKey {
                action: action.clone(),
                key: key.clone(),
            });
        };
        if canonical != *key {
            return Err(ReplayKeysError::InvalidKey {
                action: action.clone(),
                key: key.clone(),
            });
        }
        if let Some(first) = used.insert(canonical.clone(), action.clone()) {
            return Err(ReplayKeysError::DuplicateKey {
                key: canonical,
                first,
                second: action.clone(),
            });
        }
    }
    Ok(())
}

/// 保存するときの整え方: 知らない操作を捨て、足りない操作に既定のキーを入れ、キーを決まった書き方にする。
/// 使えないキーや重なりは、そのまま残して、`validate` が理由つきで断る（黙って書き換えない）。
pub fn normalized(keys: ReplayKeys) -> ReplayKeys {
    let mut out = default_keys();
    for (action, key) in keys {
        if !known_action(&action) {
            continue;
        }
        let kept = key.map(|chord| canonical_chord(&chord).unwrap_or(chord));
        out.insert(action, kept);
    }
    out
}

/// 設定ファイルの `replay_keys` を読む。無い・型が合わない項目は、その操作だけ既定のキーにする。
/// 読んだ結果に、割り当てられないキーや重なりがあれば（手で書き換えたファイル）、すべて既定に戻す。
pub fn from_value(value: Option<&serde_json::Value>) -> ReplayKeys {
    let Some(serde_json::Value::Object(map)) = value else {
        return default_keys();
    };
    let mut keys = default_keys();
    for (action, _) in ACTIONS {
        match map.get(action) {
            Some(serde_json::Value::Null) => {
                keys.insert(action.to_string(), None);
            }
            Some(serde_json::Value::String(chord)) => {
                if let Some(canonical) = canonical_chord(chord) {
                    keys.insert(action.to_string(), Some(canonical));
                }
            }
            _ => {}
        }
    }
    if validate(&keys).is_err() {
        return default_keys();
    }
    keys
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;

    #[test]
    fn u21_defaults_follow_the_decision_of_round_10() {
        let keys = default_keys();
        assert_eq!(keys.len(), ACTIONS.len());
        let key = |action: &str| keys.get(action).cloned().flatten();
        assert_eq!(key("step_back").as_deref(), Some("Comma"));
        assert_eq!(key("step_forward").as_deref(), Some("Period"));
        assert_eq!(key("prev_decision").as_deref(), Some("ArrowLeft"));
        assert_eq!(key("next_decision").as_deref(), Some("ArrowRight"));
        assert_eq!(key("prev_mismatch").as_deref(), Some("ArrowUp"));
        assert_eq!(key("next_mismatch").as_deref(), Some("ArrowDown"));
        assert_eq!(key("prev_doubt").as_deref(), Some("Shift+ArrowUp"));
        assert_eq!(key("next_doubt").as_deref(), Some("Shift+ArrowDown"));
        assert_eq!(key("prev_kyoku").as_deref(), Some("Shift+ArrowLeft"));
        assert_eq!(key("next_kyoku").as_deref(), Some("Shift+ArrowRight"));
        // 巡目の移動はボタンだけ（キーは、割り当てで足せる）
        assert_eq!(key("prev_turn"), None);
        assert_eq!(key("next_turn"), None);
        assert_eq!(validate(&keys), Ok(()));
    }

    #[test]
    fn u21_a_chord_is_written_with_modifiers_in_a_fixed_order() {
        assert_eq!(
            canonical_chord("Shift+Ctrl+KeyJ").as_deref(),
            Some("Ctrl+Shift+KeyJ")
        );
        assert_eq!(
            canonical_chord("Alt+Shift+Digit3").as_deref(),
            Some("Alt+Shift+Digit3")
        );
        assert_eq!(canonical_chord("Comma").as_deref(), Some("Comma"));
        assert_eq!(canonical_chord(" ArrowUp ").as_deref(), Some("ArrowUp"));
        for bad in [
            "",
            "+",
            "Shift+",
            "Shift+Shift+KeyA",
            "Meta+KeyA",
            "KeyAB",
            "Keya",
            "F5",
            "Digit10",
            "ShiftLeft",
        ] {
            assert_eq!(canonical_chord(bad), None, "{bad}");
        }
    }

    #[test]
    fn u21_keys_for_the_screen_history_search_undo_and_the_controls_cannot_be_assigned() {
        for reserved in [
            "Alt+ArrowLeft",
            "Alt+ArrowRight",
            "Ctrl+KeyK",
            "Ctrl+KeyZ",
            "Ctrl+KeyY",
            "Ctrl+Shift+KeyZ",
            "Tab",
            "Shift+Tab",
            "Escape",
            "Enter",
            "Ctrl+Enter",
            "Space",
        ] {
            assert!(is_reserved(reserved), "{reserved}");
            let mut keys = default_keys();
            keys.insert("step_back".into(), Some(reserved.into()));
            assert!(
                matches!(validate(&keys), Err(ReplayKeysError::ReservedKey { .. })),
                "{reserved}"
            );
        }
        // 矢印そのもの・Shift 付きの矢印・文字のキーは割り当てられる
        for fine in [
            "ArrowLeft",
            "Shift+ArrowLeft",
            "Ctrl+ArrowLeft",
            "KeyJ",
            "Alt+KeyJ",
            "Digit1",
            "Slash",
        ] {
            assert!(!is_reserved(fine), "{fine}");
        }
    }

    #[test]
    fn u21_the_same_key_cannot_go_to_two_actions() {
        let mut keys = default_keys();
        keys.insert("prev_turn".into(), Some("Comma".into()));
        match validate(&keys) {
            Err(ReplayKeysError::DuplicateKey { key, first, second }) => {
                assert_eq!(key, "Comma");
                let mut pair = [first, second];
                pair.sort();
                assert_eq!(pair, ["prev_turn".to_string(), "step_back".to_string()]);
            }
            other => panic!("{other:?}"),
        }
        // 割り当て無し（null）どうしは、重ならない
        let mut none = default_keys();
        none.insert("prev_turn".into(), None);
        none.insert("step_back".into(), None);
        assert_eq!(validate(&none), Ok(()));
    }

    #[test]
    fn u21_unknown_actions_and_unwritten_keys_are_refused() {
        let mut keys = default_keys();
        keys.insert("jump_to_moon".into(), Some("KeyM".into()));
        assert_eq!(
            validate(&keys),
            Err(ReplayKeysError::UnknownAction("jump_to_moon".into()))
        );
        let mut keys = default_keys();
        keys.insert("step_back".into(), Some("Shift+Ctrl+KeyJ".into()));
        assert!(matches!(
            validate(&keys),
            Err(ReplayKeysError::InvalidKey { .. })
        ));
        keys.insert("step_back".into(), Some("F5".into()));
        assert!(matches!(
            validate(&keys),
            Err(ReplayKeysError::InvalidKey { .. })
        ));
        assert!(validate(&keys).unwrap_err().to_string().contains("F5"));
    }

    #[test]
    fn u21_normalizing_fills_the_missing_actions_and_drops_unknown_ones() {
        let mut given = ReplayKeys::new();
        given.insert("step_back".into(), Some("Shift+Ctrl+KeyJ".into()));
        given.insert("prev_turn".into(), Some("KeyH".into()));
        given.insert("next_decision".into(), None);
        given.insert("jump_to_moon".into(), Some("KeyM".into()));
        let keys = normalized(given);
        assert_eq!(keys.len(), ACTIONS.len());
        assert_eq!(keys["step_back"].as_deref(), Some("Ctrl+Shift+KeyJ"));
        assert_eq!(keys["prev_turn"].as_deref(), Some("KeyH"));
        assert_eq!(keys["next_decision"], None);
        assert_eq!(keys["step_forward"].as_deref(), Some("Period"));
        assert!(!keys.contains_key("jump_to_moon"));
        assert_eq!(validate(&keys), Ok(()));
    }

    #[test]
    fn u21_normalizing_does_not_rewrite_a_key_that_cannot_be_used_so_that_saving_refuses_it() {
        for bad in ["F5", "Escape", "Alt+ArrowLeft", "Meta+KeyA"] {
            let mut given = default_keys();
            given.insert("step_back".into(), Some(bad.into()));
            let keys = normalized(given);
            assert_eq!(keys["step_back"].as_deref(), Some(bad));
            assert!(validate(&keys).is_err(), "{bad}");
        }
    }

    #[test]
    fn u21_a_settings_file_without_keys_or_with_broken_keys_falls_back_to_defaults() {
        assert_eq!(from_value(None), default_keys());
        assert_eq!(from_value(Some(&json!("Comma"))), default_keys());
        // 一部だけの設定: 書いてある分は使い、無い分は既定
        let keys = from_value(Some(
            &json!({ "step_back": "KeyJ", "prev_turn": null, "next_turn": "KeyL" }),
        ));
        assert_eq!(keys["step_back"].as_deref(), Some("KeyJ"));
        assert_eq!(keys["next_turn"].as_deref(), Some("KeyL"));
        assert_eq!(keys["step_forward"].as_deref(), Some("Period"));
        // 読めない項目は、その操作だけ既定
        let keys = from_value(Some(
            &json!({ "step_back": 5, "step_forward": "F5", "prev_decision": "KeyJ" }),
        ));
        assert_eq!(keys["step_back"].as_deref(), Some("Comma"));
        assert_eq!(keys["step_forward"].as_deref(), Some("Period"));
        assert_eq!(keys["prev_decision"].as_deref(), Some("KeyJ"));
        // 重なり・割り当てられないキーが入っているファイルは、すべて既定
        assert_eq!(
            from_value(Some(
                &json!({ "step_back": "KeyJ", "step_forward": "KeyJ" })
            )),
            default_keys()
        );
        assert_eq!(
            from_value(Some(&json!({ "step_back": "Escape" }))),
            default_keys()
        );
        assert_eq!(
            from_value(Some(&json!({ "step_back": "Alt+ArrowLeft" }))),
            default_keys()
        );
    }
}
