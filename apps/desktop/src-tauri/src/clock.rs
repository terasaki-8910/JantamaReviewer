//! 時刻の取得。テストでは固定の時刻に差し替える。

use std::time::{SystemTime, UNIX_EPOCH};

/// 現在の時刻（UNIX エポックからのミリ秒）。
pub fn now_ms() -> i64 {
    match SystemTime::now().duration_since(UNIX_EPOCH) {
        Ok(d) => d.as_millis() as i64,
        // 時計が 1970 年より前を指している場合。記録は止めず 0 とする。
        Err(_) => 0,
    }
}

/// 時刻の取得元。記録の時刻（W-1）をテストで固定するために差し替えられるようにしている。
pub trait Clock: Send + Sync {
    fn now_ms(&self) -> i64;
}

/// 実際の時計。
#[derive(Debug, Default, Clone, Copy)]
pub struct SystemClock;

impl Clock for SystemClock {
    fn now_ms(&self) -> i64 {
        now_ms()
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn system_clock_returns_a_plausible_time() {
        // 2020-01-01 以降であること。
        assert!(SystemClock.now_ms() > 1_577_836_800_000);
    }
}
