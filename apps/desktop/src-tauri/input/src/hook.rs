//! ボタンのフックの、OS に依らない部分（フックの状態）。
//!
//! 実際にフックを入れるのは OS ごとの実装（Windows は `hook_win`）。本体の側の口は、
//! 本体のクレートの `platform::InputHook`（フックの状態をこの型で受け取る）。

/// いまのフックの状態。
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct HookStatus {
    /// マウスのフックが入っている。
    pub mouse: bool,
    /// キーボードのフックが入っている。
    pub keyboard: bool,
    /// 要るフックを入れられなかったときの理由。
    pub error: Option<String>,
}

impl HookStatus {
    /// フックを 1 つも入れていない状態。`error` は、入れられなかった理由。
    pub fn none(error: impl Into<String>) -> HookStatus {
        HookStatus {
            mouse: false,
            keyboard: false,
            error: Some(error.into()),
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn none_has_no_hook_and_keeps_the_reason() {
        let status = HookStatus::none("理由");
        assert!(!status.mouse && !status.keyboard);
        assert_eq!(status.error.as_deref(), Some("理由"));
    }
}
