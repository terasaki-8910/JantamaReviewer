//! 時刻の取得。

use std::time::{SystemTime, UNIX_EPOCH};

/// 現在の時刻（UNIX エポックからのミリ秒）。
pub fn now_ms() -> i64 {
    match SystemTime::now().duration_since(UNIX_EPOCH) {
        Ok(d) => d.as_millis() as i64,
        // 時計が 1970 年より前を指している場合。記録は止めず 0 とする。
        Err(_) => 0,
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn now_is_after_2020() {
        assert!(now_ms() > 1_577_836_800_000);
    }
}
