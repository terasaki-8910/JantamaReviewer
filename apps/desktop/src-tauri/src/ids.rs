//! 端末をまたいで重ならない id と、内容の指紋（F15 同期）。
//!
//! - `new_uid`: 新しく作る記録の id。作った時刻（ミリ秒）の 12 桁の 16 進数 + 乱数 16 桁。文字の並びが作った順になる。
//!   端末の名前は入れない（どの端末で作ったかを、id に頼らないため）。
//! - `sha256_hex`: 内容の指紋（同期の突き合わせで「変わったか」を調べるのに使う）。

use sha2::{Digest, Sha256};

use crate::clock::now_ms;

/// バイト列を、小文字の 16 進数の文字にする。
pub fn hex(bytes: &[u8]) -> String {
    const DIGITS: &[u8; 16] = b"0123456789abcdef";
    let mut out = String::with_capacity(bytes.len() * 2);
    for byte in bytes {
        out.push(char::from(DIGITS[usize::from(byte >> 4)]));
        out.push(char::from(DIGITS[usize::from(byte & 0x0f)]));
    }
    out
}

/// 内容の SHA-256 を、小文字の 16 進数（64 文字）にする。
pub fn sha256_hex(bytes: &[u8]) -> String {
    hex(&Sha256::digest(bytes))
}

/// 乱数のバイト列（OS の乱数）。取れなければ、時刻とカウンターから作る（id が重ならないことのほうが大事で、推測されにくさは要らない）。
pub fn random_bytes<const N: usize>() -> [u8; N] {
    let mut bytes = [0u8; N];
    if getrandom::fill(&mut bytes).is_err() {
        use std::sync::atomic::{AtomicU64, Ordering};
        static COUNTER: AtomicU64 = AtomicU64::new(0);
        let seed = u128::from(now_ms().unsigned_abs()) << 64
            | u128::from(COUNTER.fetch_add(1, Ordering::Relaxed));
        let digest = Sha256::digest(seed.to_be_bytes());
        for (slot, byte) in bytes.iter_mut().zip(digest.iter()) {
            *slot = *byte;
        }
    }
    bytes
}

/// 新しい記録の id。例: `n019f3a2c91b4-0f3c9a7d52e18b64`（36 文字未満。英数字とハイフンだけ）。
pub fn new_uid() -> String {
    format!("n{:012x}-{}", now_ms().max(0), hex(&random_bytes::<8>()))
}

/// 端末の名前（同期の「どの端末が直したか」に使う）。`d-` と 8 桁の 16 進数。
pub fn new_device_id() -> String {
    format!("d-{}", hex(&random_bytes::<4>()))
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn sha256_of_abc_is_the_known_value() {
        assert_eq!(
            sha256_hex(b"abc"),
            "ba7816bf8f01cfea414140de5dae2223b00361a396177a9cb410ff61f20015ad"
        );
    }

    #[test]
    fn new_uids_are_distinct_and_sort_by_time() {
        let a = new_uid();
        let b = new_uid();
        assert_ne!(a, b);
        assert!(a.starts_with('n') && a.len() == 30, "{a}");
        assert!(a.bytes().all(|c| c.is_ascii_alphanumeric() || c == b'-'));
        // 時刻の部分が先に並ぶ（同じミリ秒でなければ、後に作ったほうが大きい）
        assert!(a[..13] <= b[..13]);
    }

    #[test]
    fn device_ids_have_a_fixed_shape() {
        let id = new_device_id();
        assert!(id.starts_with("d-") && id.len() == 10, "{id}");
    }
}
