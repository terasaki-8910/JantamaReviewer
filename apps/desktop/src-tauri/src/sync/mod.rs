//! 記録の同期（F15、D-4。R14-9 の B、R14-10、R14-11、R15-9、R15-10）。
//!
//! 手元の SQLite（`study.sqlite`）と JSON のファイルが、元の記録のまま。同期用の DB（Turso Cloud と同期する、手元のファイル）を別に持ち、
//! 同期のときに、手元の記録と突き合わせる。記録は、端末をまたいで一意の id の行にして、2 台で別々に直したものは、新しく直したほうを残し、
//! 消したものは消えたままにする（決まりは `merge.rs`）。結果のファイル（`report.json`）は、圧縮して記録と一緒に同期する。
//! スクショ・ウィジェットの記録・文字認識の写し・設定のうちデータの保存先と窓の位置は、同期しない。
//!
//! 通信するのは、このモジュールの `remote.rs` だけ（設定に貼った Turso Cloud の DB。`endpoint.rs` が通信先を確かめる）。
//! トークンは OS の資格情報の保管庫にだけ置く（`credentials.rs`）。
//!
//! 層（下から）:
//! - `rows`・`base`・`endpoint`・`credentials`・`error`: 行の鍵、前回の記録、通信先、トークン、失敗の種類
//! - `merge`: 行ごとの突き合わせの決まり（純粋な計算）
//! - `local`: 手元の記録を行にする・行を手元に入れる
//! - `remote`: 同期用の DB（Turso）の手元の写しと通信（打ち切りの時間つき）
//! - `engine`: 1 回分の同期（取り込む → 突き合わせる → 送る）
//! - `service`: 裏のスレッド（間隔・手元の変更の見張り・つながらないときの待ち）
//! - `commands`: Tauri のコマンドと、アプリへのつなぎ

pub mod base;
pub mod commands;
pub mod credentials;
pub mod endpoint;
pub mod engine;
pub mod error;
pub mod local;
pub mod merge;
pub mod remote;
pub mod rows;
pub mod service;

#[cfg(test)]
mod engine_tests;
#[cfg(test)]
mod service_tests;
#[cfg(test)]
mod testing;
