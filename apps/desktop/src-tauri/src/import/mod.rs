//! 取り込み（F1・F9・F11）の Rust 側。
//!
//! 取り込みは、ユーザーが「検討結果を取り込む」を押したときだけ動く（対局のあと）。ウィジェット・ボタンを拾う部分・
//! 撮影・記録のコードは、ここを使わない。
//!
//! - `report_id`: mjai の結果の ID（形の確認）
//! - `report_fetch`: 結果 JSON を取る（アプリが外へ出す通信は、これだけ。S-2）
//! - `mjai_nav`: mjai の窓の移動の判定と、URL 欄に牌譜リンクを入れるスクリプト（純粋。E-10・E-11）
//! - `mjai_window`: mjai のサイトを開く小さな窓（Tauri の窓。3a 節の設定をかける）
//! - `report_file`: 結果の JSON ファイルを直接読み込む（mjai の窓が使えないときの代わり）
//! - `ocr_job`: 保存済みのスクリーンショットを文字認識にかけて、結果を半荘のフォルダに残す（S-3）
//! - `commands`: 画面から呼ぶ Tauri のコマンド

pub mod commands;
pub mod mjai_nav;
pub mod mjai_window;
pub mod ocr_job;
pub mod report_fetch;
pub mod report_file;
pub mod report_id;
