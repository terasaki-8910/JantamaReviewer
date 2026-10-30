//! 内部の panic を、日本語の 1 行のエラーにする。
//!
//! libriichi の一部は、壊れた牌譜に対して `Err` でなく panic で止まることがある（内部の約束事を `assert!` で確かめている）。
//! そのままだと、標準エラーに英語の複数行が出て、終了コードも 101 になる。入口（`main`）で panic の既定の出力を止め、
//! 起きた場所だけ覚えておき、拾った panic を「内部エラーで止まりました: 理由（場所）」の 1 行にする。

use std::any::Any;
use std::panic::{catch_unwind, UnwindSafe};
use std::sync::Mutex;

/// 最後に panic した場所（`ファイル:行`）。
static LAST_PLACE: Mutex<Option<String>> = Mutex::new(None);

/// panic の既定の出力（複数行）を止め、起きた場所だけ覚える。プロセスの最初に 1 回呼ぶ。
pub fn quiet_panics() {
    std::panic::set_hook(Box::new(|info| {
        let place = info
            .location()
            .map(|place| format!("{}:{}", place.file(), place.line()));
        if let Ok(mut slot) = LAST_PLACE.lock() {
            *slot = place;
        }
    }));
}

/// `work` を動かす。途中で panic したら、日本語の 1 行の文（改行なし）にして `Err` で返す。
pub fn run_guarded<T>(work: impl FnOnce() -> T + UnwindSafe) -> Result<T, String> {
    catch_unwind(work).map_err(|payload| describe(payload.as_ref()))
}

fn describe(payload: &(dyn Any + Send)) -> String {
    let reason = payload
        .downcast_ref::<&str>()
        .map(ToString::to_string)
        .or_else(|| payload.downcast_ref::<String>().cloned())
        .unwrap_or_else(|| "理由は分かりません".to_string());
    let place = LAST_PLACE.lock().ok().and_then(|slot| slot.clone());
    let text = match place {
        Some(place) => format!("内部エラーで止まりました: {reason}（{place}）"),
        None => format!("内部エラーで止まりました: {reason}"),
    };
    text.replace(['\r', '\n'], " ")
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn passes_the_value_through_when_nothing_panics() {
        assert_eq!(run_guarded(|| 7), Ok(7));
    }

    #[test]
    fn turns_a_panic_into_one_japanese_line() {
        let text = run_guarded(|| -> u8 { panic!("tehai is not 3n+2\nsecond line") }).unwrap_err();
        assert!(
            text.starts_with("内部エラーで止まりました: tehai is not 3n+2"),
            "{text}"
        );
        assert!(!text.contains('\n'), "{text}");

        let owned =
            run_guarded(|| -> u8 { panic!("{}", String::from("owned message")) }).unwrap_err();
        assert!(owned.contains("owned message"), "{owned}");
    }
}
