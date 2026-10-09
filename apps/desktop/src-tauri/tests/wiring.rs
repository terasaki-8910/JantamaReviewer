//! 「ブラウザの名残を見せない」設定（N-1〜N-13）が、窓を作る関数まで配線されていることの検査。
//!
//! 設定の値そのものは `webview_policy.rs` などの単体テストが確かめている。ここでは、
//! その値が実際に窓の作り方に渡されていること（配線の忘れ）と、設定ファイルや HTML がそれを崩していないことを、
//! ソースと設定を読んで確かめる。
//!
//! 注意: このファイルのテストは、Tauri の窓や実行環境の型（`Wry`・`MockRuntime` など）を使わない。
//! テストの実行ファイルには Common Controls v6 のマニフェストが無く、それらを使うと、読み込みの時点で
//! STATUS_ENTRYPOINT_NOT_FOUND で止まる。

use std::fs;
use std::path::PathBuf;

use jantama_reviewer_lib::widget_window::{MAIN_TITLE, WIDGET_TITLE};

fn crate_dir() -> PathBuf {
    PathBuf::from(env!("CARGO_MANIFEST_DIR"))
}

fn desktop_dir() -> PathBuf {
    crate_dir().join("..")
}

fn read(path: PathBuf) -> String {
    fs::read_to_string(&path).unwrap_or_else(|e| panic!("{} を読めません: {e}", path.display()))
}

/// HTML の `<title>` の中身。
fn html_title(html: &str) -> String {
    let start = html.find("<title>").expect("<title> がある") + "<title>".len();
    let end = html[start..].find("</title>").expect("</title> がある");
    html[start..start + end].trim().to_string()
}

#[test]
fn n13_the_html_titles_equal_the_native_window_titles() {
    // 窓の題名は Rust が決める。HTML の題名が食い違うと、読み込み中などに別の名前が見えうる。
    assert_eq!(
        html_title(&read(desktop_dir().join("index.html"))),
        MAIN_TITLE
    );
    assert_eq!(
        html_title(&read(desktop_dir().join("widget.html"))),
        WIDGET_TITLE
    );
}

#[test]
fn n12_the_release_build_has_no_devtools() {
    // tauri の `devtools` 機能が入っていなければ、リリースビルドでは開発者ツールを開けない。
    let toml = read(crate_dir().join("Cargo.toml"));
    let tauri_line = toml
        .lines()
        .find(|l| l.trim_start().starts_with("tauri = "))
        .expect("tauri の依存がある");
    assert!(
        !tauri_line.contains("devtools"),
        "tauri の devtools 機能を入れない: {tauri_line}"
    );
    let conf = read(crate_dir().join("tauri.conf.json"));
    assert!(
        !conf.to_lowercase().contains("devtools"),
        "設定でも開発者ツールを開かない"
    );
}

#[test]
fn the_windows_are_built_in_code_so_the_flags_cannot_be_bypassed_by_the_config() {
    let conf: serde_json::Value =
        serde_json::from_str(&read(crate_dir().join("tauri.conf.json"))).expect("設定は JSON");
    assert_eq!(
        conf["app"]["windows"],
        serde_json::json!([]),
        "窓は設定ファイルでは作らない（設定は widget_window::build_window に集める）"
    );
    let text = conf.to_string();
    for forbidden in ["useHttpsScheme", "zoomHotkeysEnabled", "dragDropEnabled"] {
        assert!(
            !text.contains(forbidden),
            "{forbidden} を設定ファイルで変えない"
        );
    }
}

#[test]
fn n1_to_n12_build_window_applies_every_option_and_hook() {
    let source = read(crate_dir().join("src").join("widget_window.rs"));
    // 製品の部分（テストを除く）を読む。
    let product = source
        .split("#[cfg(test)]")
        .next()
        .expect("製品の部分がある");
    for needle in [
        // 設定の元は 1 つ。tauri dev のときだけ開発者ツールが開く（N-12）。
        "WebviewFlags::strict(dev)",
        "let dev = tauri::is_dev();",
        // Tauri が出している設定（N-2、N-10、N-12、N-8）。
        ".zoom_hotkeys_enabled(options.zoom_hotkeys_enabled)",
        ".general_autofill_enabled(options.general_autofill_enabled)",
        ".devtools(options.devtools)",
        "disable_drag_drop_handler",
        // 画面の遷移・新しい窓・ダウンロード（N-5、N-6）。
        ".on_navigation(",
        ".on_new_window(",
        ".on_download(",
        "NewWindowResponse::Deny",
        // WebView2 の残りの設定（N-1、N-2、N-4、N-5、N-10）と、右クリックのメニュー（N-3）。
        "crate::webview_win::harden(&window, flags)",
        // 開発サーバーを許すのは dev のときだけ（N-5）。
        "AppOrigins::for_run(dev,",
    ] {
        assert!(product.contains(needle), "build_window に {needle} が無い");
    }
    // 製品の画面は http のオリジンで配る前提（navigation::PRODUCTION_HOST）。https に変えると遷移の許可が合わなくなる。
    assert!(!product.contains("use_https_scheme"));
}

#[test]
fn n12_the_devtools_command_does_nothing_outside_tauri_dev() {
    let lib = read(crate_dir().join("src").join("lib.rs"));
    assert!(
        lib.contains("commands::open_devtools"),
        "コマンドを登録していない"
    );
    let commands = read(crate_dir().join("src").join("commands.rs"));
    let body = commands
        .split("pub async fn open_devtools(")
        .nth(1)
        .and_then(|rest| rest.split("\n}\n").next())
        .expect("open_devtools がある");
    // 開くのは、デバッグ用のビルドで、かつ tauri dev のときだけ。
    assert!(body.contains("#[cfg(debug_assertions)]"));
    assert!(body.contains("if tauri::is_dev()"));
    assert!(body.contains("window.open_devtools()"));
    // 製品のビルドでは、窓を使わずに何もしない（open_devtools は製品のビルドには存在しない）。
    assert!(body.contains("#[cfg(not(debug_assertions))]"));
}

#[test]
fn n7_windows_are_shown_only_through_the_ready_gate() {
    let lib = read(crate_dir().join("src").join("lib.rs"));
    for command in ["commands::window_ready", "commands::set_window_background"] {
        assert!(lib.contains(command), "{command} を登録していない");
    }
    // 起動時に、窓を直接見せない（画面が描き終えてから、commands.rs が見せる）。
    let setup = lib.split("fn setup(").nth(1).expect("setup がある");
    assert!(!setup.contains(".show()"), "setup で窓を直接見せている");
    assert!(setup.contains("SharedShowGate::new()"));
    assert!(setup.contains("spawn_show_watchdog"));
}

#[test]
fn n7_the_window_is_never_shown_before_the_background_matches_the_page() {
    // 窓を見せる前に、背景色をそろえる順番になっている。
    let commands = read(crate_dir().join("src").join("commands.rs"));
    let ready = commands
        .split("pub async fn window_ready(")
        .nth(1)
        .expect("window_ready がある");
    let background = ready.find("apply_background(").expect("背景色をそろえる");
    let show = ready.find("present_window(").expect("窓を見せる");
    assert!(background < show, "背景色をそろえてから見せる");
}
