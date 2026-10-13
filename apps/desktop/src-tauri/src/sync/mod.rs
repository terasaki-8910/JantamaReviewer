//! 記録の同期（作業中）。
use std::time::Duration;

pub fn probe() -> bool {
    let _ = turso::sync::Builder::new_remote("x").with_remote_url("y");
    let _ = keyring::Entry::new("a", "b");
    let _ = flate2::Compression::default();
    let _ = tokio::time::sleep(Duration::from_secs(0));
    true
}
