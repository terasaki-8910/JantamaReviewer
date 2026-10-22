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
        "crate::platform::harden_webview(&window, flags)",
        // 開発サーバーを許すのは dev のときだけ（N-5）。
        "AppOrigins::for_run(dev,",
    ] {
        assert!(product.contains(needle), "build_window に {needle} が無い");
    }
    // 製品の画面は http のオリジンで配る前提（navigation::PRODUCTION_HOST）。https に変えると遷移の許可が合わなくなる。
    assert!(!product.contains("use_https_scheme"));
}

#[test]
fn trial_runs_keep_webview_data_out_of_the_real_app_and_the_mjai_window_has_its_own() {
    // 試しに動かすとき（JANTAMA_CONFIG_DIR）は、検討画面とウィジェットの WebView2 のデータも試しのフォルダに置く。
    // mjai の窓は、いつもアプリの画面とは別の場所。どちらも webview_data.rs の決まりを通す。
    let product = |name: &[&str]| {
        let mut path = crate_dir().join("src");
        for part in name {
            path = path.join(part);
        }
        read(path)
            .split("#[cfg(test)]")
            .next()
            .expect("製品の部分がある")
            .to_string()
    };
    let windows = product(&["widget_window.rs"]);
    assert!(
        windows.contains("webview_data::app_webview_dir(crate::webview_data::config_env())")
            && windows.contains(".data_directory(dir)"),
        "build_window が、試しのときの WebView2 のデータの場所を使っていない"
    );
    let mjai = product(&["import", "mjai_window.rs"]);
    assert!(
        mjai.contains("webview_data::mjai_webview_dir(") && mjai.contains(".data_directory(dir)"),
        "mjai の窓が、自分の WebView2 のデータの場所を使っていない"
    );
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

#[test]
fn w12_the_widget_menu_and_the_tray_menu_both_offer_the_sound_toggle_and_stay_in_step_with_the_setting(
) {
    let lib = read(crate_dir().join("src").join("lib.rs"));
    let setup = lib.split("fn setup(").nth(1).expect("setup がある");
    // どちらのメニューも、いまの音の設定の印つき（と、迷いだけの設定・取り消せるか）で作る。
    assert_eq!(
        setup
            .matches("menu::build_menu(app, settings.sound, settings.doubt_only, can_undo)")
            .count(),
        2,
        "右クリックのメニューとトレイのメニューを、同じ作り方で作る"
    );
    // 2 つの「音を鳴らす」の項目を覚えておき、設定が変わったときに印を合わせる。
    assert!(setup.contains("app.manage(SoundMenuItems(vec!["));
    assert!(setup.contains("widget_menu.sound.clone()"));
    assert!(setup.contains("tray_menu.sound.clone()"));

    let commands = read(crate_dir().join("src").join("commands.rs"));
    let side_effects = commands
        .split("fn apply_side_effects")
        .nth(1)
        .and_then(|rest| rest.split("\n}\n").next())
        .expect("apply_side_effects がある");
    assert!(
        side_effects.contains("if change.sound {")
            && side_effects.contains("sync_sound_menus(app, settings.sound)"),
        "設定のチェックから変えたときも、メニューの印を合わせる"
    );

    // メニューから選ぶと、設定の音を切り替える（設定の保存・画面への知らせは、設定を変える共通の経路）。
    let menu = read(crate_dir().join("src").join("menu.rs"));
    assert!(menu.contains("MENU_TOGGLE_SOUND => {"));
    assert!(menu.contains("commands::toggle_sound_now(app)"));
    let toggle = commands
        .split("pub fn toggle_sound_now")
        .nth(1)
        .and_then(|rest| rest.split("\n}\n").next())
        .expect("toggle_sound_now がある");
    assert!(toggle.contains("settings.sound = !settings.sound;"));
    assert!(toggle.contains("set_settings_now(app, settings)"));
}

#[test]
fn w15_the_widget_window_the_two_menus_and_undo_follow_the_doubt_only_setting() {
    let lib = read(crate_dir().join("src").join("lib.rs"));
    let setup = lib.split("fn setup(").nth(1).expect("setup がある");
    // 窓は、設定の迷いだけで大きさを決めて作る（入なら 48px 角）。
    assert!(
        setup.contains("widget_window_spec(settings.orientation, settings.doubt_only)"),
        "ウィジェットの窓を、迷いだけの設定の大きさで作っていない"
    );
    // 2 つのメニューの入れ替わる項目を覚えておき、設定と記録の状態が変わったときに合わせる。
    assert!(setup.contains("app.manage(ModeMenus(vec![widget_menu.mode, tray_menu.mode]))"));

    let commands = read(crate_dir().join("src").join("commands.rs"));
    let side_effects = commands
        .split("fn apply_side_effects")
        .nth(1)
        .and_then(|rest| rest.split("\n}\n").next())
        .expect("apply_side_effects がある");
    // 設定のチェックから変えたときも、同期で変わったときも（どちらも set_settings_now を通る）、窓とメニューを合わせる。
    assert!(
        side_effects.contains("if change.doubt_only {")
            && side_effects.contains("sync_mode_menus(app, settings.doubt_only)"),
        "迷いだけが変わったとき、メニューの項目を入れ替えていない"
    );
    assert!(
        side_effects.contains("if change.orientation || change.doubt_only {")
            && side_effects
                .contains("resize_widget(app, settings.orientation, settings.doubt_only)"),
        "迷いだけが変わったとき、ウィジェットの窓の大きさを直していない"
    );
    let sync_settings = read(crate_dir().join("src").join("sync").join("commands.rs"));
    assert!(
        sync_settings.contains("set_settings_now(&self.app, settings)"),
        "同期で変わった設定も、設定を変える共通の経路を通す"
    );
    // 「取り消し」の押せる・押せないは、記録の状態を知らせるたびに合わせる。
    let emit = commands
        .split("pub fn emit_state")
        .nth(1)
        .and_then(|rest| rest.split("\n}\n").next())
        .expect("emit_state がある");
    assert!(emit.contains("sync_undo_menus(app, state.can_undo)"));
    // 「取り消し」を選ぶと、ウィジェットの取り消しのボタンと同じ動き（最後の記録を 1 つ消す）をする。
    let menu = read(crate_dir().join("src").join("menu.rs"));
    assert!(menu.contains("MENU_UNDO => {"));
    assert!(menu.contains("commands::undo_now(app)"));
    let undo_command = commands
        .split("pub async fn undo(")
        .nth(1)
        .and_then(|rest| rest.split("\n}\n").next())
        .expect("undo がある");
    assert!(undo_command.contains("undo_now(&app)"));
}

// ---- 取り込み（F1）: mjai の窓と、画面から呼ぶコマンドの配線 ----

#[test]
fn n1_to_n13_the_mjai_window_gets_every_browser_remnant_setting_and_every_navigation_hook() {
    let source = read(
        crate_dir()
            .join("src")
            .join("import")
            .join("mjai_window.rs"),
    );
    let product = source
        .split("#[cfg(test)]")
        .next()
        .expect("製品の部分がある");
    for needle in [
        // 設定の元は、ほかの窓と同じ 1 つ。tauri dev のときだけ開発者ツールが開く（N-12）。
        "WebviewFlags::strict(tauri::is_dev())",
        ".zoom_hotkeys_enabled(options.zoom_hotkeys_enabled)",
        ".general_autofill_enabled(options.general_autofill_enabled)",
        ".devtools(options.devtools)",
        "disable_drag_drop_handler",
        // WebView2 の残りの設定（N-1、N-2、N-4、N-5、N-10）と、右クリックのメニュー（N-3）。
        "crate::platform::harden_webview(&window, flags)",
        // ページの中でしか止められないもの（N-9、N-10）。
        ".initialization_script(NATIVE_SCRIPT)",
        // 画面の遷移・新しい窓・ダウンロード（N-5、N-6）。E-10 の判定を通す。
        ".on_navigation(move |url| match decide_navigation(url)",
        ".on_new_window(move |url, _features|",
        "NewWindowResponse::Deny",
        ".on_download(|_webview, event| download_hook(&event))",
        // 題名は日本語の名前だけ（N-13）。取り込み先の半荘を名指しする題名も、決めた字だけ（`mjai_title`）。
        // 隠したまま作り、最初のページを読み終えてから見せる（N-7）。
        ".title(&title)",
        "let title = mjai_title(target);",
        "window.set_title(&title)",
        ".visible(false)",
        ".background_color(",
        // 開くのは mjai のサイトの入り口だけ。牌譜リンクは、E-11 のスクリプトで URL 欄に入れるだけ。
        "WebviewUrl::External(start_url())",
        "prefill_script(link)",
        // 置き場所は、検討画面と同じ画面の、検討画面の上（見せる前に決める）。
        "place_near_main(app, &window)",
    ] {
        assert!(
            product.contains(needle),
            "mjai_window.rs に {needle} が無い"
        );
    }
    // 「画面の真ん中」を OS に任せない（別のモニターに出て、窓を見失ったため。実機で確かめた）。
    assert!(
        !product.contains(".center()"),
        "mjai の窓は、検討画面の上に置く（place_near_main）"
    );
    // 窓を見せるのは、最初のページを読み終えたとき・見張りの時間が来たとき・開いている窓を前面に出すときだけ。
    assert_eq!(product.matches("present(&window)").count(), 3);
    // 窓を見せる呼び出しは 2 つだけ: mjai の窓を見せる `present` と、閉じたあとに検討画面を前面に出す `focus_main`。
    assert_eq!(product.matches(".show()").count(), 2);
    for function in ["fn present<", "fn focus_main<"] {
        let body = product
            .split(function)
            .nth(1)
            .and_then(|rest| rest.split("\n}\n").next())
            .unwrap_or_else(|| panic!("{function} がある"));
        assert_eq!(body.matches(".show()").count(), 1, "{function}");
    }
    // 評価するスクリプトは、牌譜リンクを入れるものだけ（呼び出しは 2 か所。どちらも作ったスクリプトを渡す）。
    assert_eq!(product.matches(".eval(").count(), 2);
    assert_eq!(product.matches(".eval(&script)").count(), 2);
    // 窓の移動を許すかどうかを、ここで独自に決めない（判定は mjai_nav の 1 か所）。
    assert!(
        !product.contains("MJAI_HOST ==")
            || product.contains("payload.url().host_str() == Some(MJAI_HOST)")
    );
    // 起動のときに、mjai の窓は作らない。
    let lib = read(crate_dir().join("src").join("lib.rs"));
    let setup = lib.split("fn setup(").nth(1).expect("setup がある");
    assert!(!setup.contains("mjai_window::open"));
}

#[test]
fn every_import_command_is_registered_and_the_mjai_window_is_wired_into_the_app() {
    let lib = read(crate_dir().join("src").join("lib.rs"));
    let commands = read(crate_dir().join("src").join("import").join("commands.rs"));
    // import/commands.rs の `#[tauri::command]` が、すべて登録されている（登録の忘れを防ぐ）。
    let mut names = Vec::new();
    let mut lines = commands.lines();
    while let Some(line) = lines.next() {
        if line.trim() == "#[tauri::command]" {
            let signature = lines.next().expect("関数が続く");
            let name = signature
                .trim_start_matches("pub async fn ")
                .split('(')
                .next()
                .expect("関数名");
            names.push(name.to_string());
        }
    }
    assert!(names.len() >= 14, "{names:?}");
    for name in &names {
        assert!(
            lib.contains(&format!("import::commands::{name},")),
            "{name} を generate_handler に登録していない"
        );
    }
    // mjai の窓の状態を管理し、窓が壊れたときの知らせをつないでいる。
    assert!(lib.contains("app.manage(import::mjai_window::MjaiWindowState::default())"));
    assert!(lib.contains("(import::mjai_window::MJAI_LABEL, WindowEvent::Destroyed)"));
    assert!(lib.contains("import::mjai_window::on_destroyed("));
}

#[test]
fn every_evaluation_command_is_registered_and_none_of_them_writes_the_recording() {
    // evaluation.rs（局の評価の表の保存）の `#[tauri::command]` が、すべて登録されている（登録の忘れを防ぐ）。
    let lib = read(crate_dir().join("src").join("lib.rs"));
    let source = read(crate_dir().join("src").join("evaluation.rs"));
    let mut names = Vec::new();
    let mut lines = source.lines();
    while let Some(line) = lines.next() {
        if line.trim() == "#[tauri::command]" {
            let signature = lines.next().expect("関数が続く");
            let name = signature
                .trim_start_matches("pub async fn ")
                .split('(')
                .next()
                .expect("関数名");
            names.push(name.to_string());
        }
    }
    assert_eq!(
        names,
        [
            "set_self_rating",
            "clear_self_rating",
            "set_maka_grade",
            "clear_maka_grade",
            "set_maka_hanchan",
            "clear_maka_hanchan",
        ]
    );
    for name in &names {
        assert!(
            lib.contains(&format!("evaluation::{name},")),
            "{name} を generate_handler に登録していない"
        );
    }
    // ウィジェットの記録（追記だけの events.jsonl）は、ここからは書き換えない。
    for forbidden in ["add_mark", "add_rating", "undo(", "append", "EVENTS_FILE"] {
        assert!(
            !source.contains(forbidden),
            "evaluation.rs に {forbidden} がある"
        );
    }
}

#[test]
fn every_memo_command_is_registered_and_none_of_them_writes_the_recording() {
    // memo.rs（終局直後のメモの保存。F4・U-28）の `#[tauri::command]` が、すべて登録されている（登録の忘れを防ぐ）。
    let lib = read(crate_dir().join("src").join("lib.rs"));
    let source = read(crate_dir().join("src").join("memo.rs"));
    let mut names = Vec::new();
    let mut lines = source.lines();
    while let Some(line) = lines.next() {
        if line.trim() == "#[tauri::command]" {
            let signature = lines.next().expect("関数が続く");
            let name = signature
                .trim_start_matches("pub async fn ")
                .split('(')
                .next()
                .expect("関数名");
            names.push(name.to_string());
        }
    }
    assert_eq!(
        names,
        [
            "set_memo",
            "clear_memo",
            "set_extra_memo",
            "clear_extra_memo"
        ]
    );
    for name in &names {
        assert!(
            lib.contains(&format!("memo::{name},")),
            "{name} を generate_handler に登録していない"
        );
    }
    // ウィジェットの記録（追記だけの events.jsonl）は、ここからは書き換えない。
    for forbidden in ["add_mark", "add_rating", "undo(", "append", "EVENTS_FILE"] {
        assert!(!source.contains(forbidden), "memo.rs に {forbidden} がある");
    }
}

#[test]
fn the_records_commands_are_registered_and_the_records_module_never_touches_the_widget_files() {
    // 記録の書き出し・読み込み（D-2）の `#[tauri::command]` が、すべて登録されている（登録の忘れを防ぐ）。
    let lib = read(crate_dir().join("src").join("lib.rs"));
    for name in [
        "records_overview",
        "export_records",
        "inspect_records_file",
        "import_records",
    ] {
        assert!(
            lib.contains(&format!("study::commands::{name},")),
            "{name} を generate_handler に登録していない"
        );
    }
    // 書き出しに入れないもの（スクショ・Mortal の結果・ウィジェットの記録・文字認識の写し）の置き場の名前を、一度も使わない。
    // 読み書きするのは、4 つの記録のファイルと、取っておいた記録のファイルだけ。
    let source = read(crate_dir().join("src").join("study").join("records.rs"));
    let product = source.split("#[cfg(test)]").next().unwrap_or("");
    for forbidden in [
        "EVENTS_FILE",
        "REPORT_FILE",
        "OCR_FILE",
        "MARKS_DIR",
        "RATINGS_DIR",
        "add_mark",
        "add_rating",
        "undo(",
        "append",
        "OpenOptions",
    ] {
        assert!(
            !product.contains(forbidden),
            "records.rs に {forbidden} がある"
        );
    }
}
