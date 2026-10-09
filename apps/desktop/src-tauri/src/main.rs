// リリースビルドでは、起動時にコンソール窓を出さない。
#![cfg_attr(not(debug_assertions), windows_subsystem = "windows")]

fn main() {
    jantama_reviewer_lib::run();
}
