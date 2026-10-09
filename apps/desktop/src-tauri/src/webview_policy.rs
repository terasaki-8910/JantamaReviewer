//! WebView2 の設定: ブラウザの名残（ショートカット・右クリックのメニュー・ダウンロードの吹き出し・
//! 「このページに到達できません」のエラーページなど）を見せないための設定のすべて（N-1〜N-12）。
//!
//! 設定は `WebviewFlags` という 1 つの値に集める（純粋な記述）。`apply_flags` が、それを `SettingsAccess`
//! （実機では WebView2 の設定 `webview_win.rs`、テストでは偽物）に書き込み、読み戻して、合っているかまで確かめる。
//! どの設定が、どの値で書き込まれるかは、このファイルの単体テストが 1 つずつ確かめる。
//!
//! 右クリックのメニューの絞り込み（`plan_context_menu`）も、ここに純粋な関数として置く。

use std::fmt;

/// 窓の webview の設定の全部。`strict` が、このアプリで使う値。
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct WebviewFlags {
    /// N-1: ブラウザのショートカット（Ctrl+J のダウンロード・Ctrl+P の印刷・Ctrl+F と F3 の検索・Ctrl+S の保存・
    /// Ctrl+R と F5 の再読み込み・F7 のキャレットブラウズ・Alt+左右の戻る進む・Ctrl+Shift+I と F12 の開発者ツール）。
    /// アプリが自分で決めたキーの処理は、これを切っても動く。
    pub browser_accelerator_keys: bool,
    /// N-2: Ctrl+ホイールなどによる拡大・縮小。
    pub zoom_control: bool,
    /// N-2: ピンチによる拡大・縮小。
    pub pinch_zoom: bool,
    /// N-2: 左右のスワイプによる戻る・進む。
    pub swipe_navigation: bool,
    /// N-2: Tauri の `zoomHotkeysEnabled`（窓を作るときの設定）。
    pub zoom_hotkeys: bool,
    /// N-4: リンクの上に出る URL の吹き出し。
    pub status_bar: bool,
    /// N-5: 読み込みに失敗したときの、ブラウザ組み込みのエラーページ。
    pub built_in_error_page: bool,
    /// N-10: 入力欄の自動入力の候補。
    pub general_autofill: bool,
    /// N-10: パスワードを保存するかの提案。
    pub password_autosave: bool,
    /// N-12: 開発者ツール。`tauri dev` のときだけ使える。
    pub dev_tools: bool,
    /// N-3: ブラウザ標準の右クリックのメニュー。入力欄の切り取り・コピー・貼り付けのために残し、
    /// 中身は `plan_context_menu` で、入力欄の上だけ・4 項目だけに絞る。
    pub default_context_menus: bool,
    /// N-8: ファイルのドロップを Tauri が受ける（ドロップされたファイルを webview が開いて遷移することがない）。
    pub drag_drop_handler: bool,
}

impl WebviewFlags {
    /// このアプリの設定。`dev` は `tauri dev` で動いているか（`tauri::is_dev()`）。
    pub fn strict(dev: bool) -> WebviewFlags {
        WebviewFlags {
            browser_accelerator_keys: false,
            zoom_control: false,
            pinch_zoom: false,
            swipe_navigation: false,
            zoom_hotkeys: false,
            status_bar: false,
            built_in_error_page: false,
            general_autofill: false,
            password_autosave: false,
            dev_tools: dev,
            default_context_menus: true,
            drag_drop_handler: true,
        }
    }

    /// WebView2 の設定として書き込むもの（`SettingsAccess` に渡す一覧）。
    pub fn webview2_settings(&self) -> [(Setting, bool); 10] {
        [
            (
                Setting::BrowserAcceleratorKeys,
                self.browser_accelerator_keys,
            ),
            (Setting::ZoomControl, self.zoom_control),
            (Setting::PinchZoom, self.pinch_zoom),
            (Setting::SwipeNavigation, self.swipe_navigation),
            (Setting::StatusBar, self.status_bar),
            (Setting::BuiltInErrorPage, self.built_in_error_page),
            (Setting::GeneralAutofill, self.general_autofill),
            (Setting::PasswordAutosave, self.password_autosave),
            (Setting::DevTools, self.dev_tools),
            (Setting::DefaultContextMenus, self.default_context_menus),
        ]
    }

    /// 窓を作るときに Tauri の窓の作り手へ渡す設定。
    pub fn builder_options(&self) -> BuilderOptions {
        BuilderOptions {
            zoom_hotkeys_enabled: self.zoom_hotkeys,
            general_autofill_enabled: self.general_autofill,
            devtools: self.dev_tools,
            drag_drop_handler: self.drag_drop_handler,
        }
    }
}

/// 窓を作るときに渡す設定（`WebviewWindowBuilder` の対応するメソッドの引数）。
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub struct BuilderOptions {
    pub zoom_hotkeys_enabled: bool,
    pub general_autofill_enabled: bool,
    pub devtools: bool,
    /// `false` なら `disable_drag_drop_handler()` を呼ぶ。
    pub drag_drop_handler: bool,
}

/// WebView2 の設定の 1 項目。
#[derive(Debug, Clone, Copy, PartialEq, Eq, Hash)]
pub enum Setting {
    /// `AreBrowserAcceleratorKeysEnabled`
    BrowserAcceleratorKeys,
    /// `IsZoomControlEnabled`
    ZoomControl,
    /// `IsPinchZoomEnabled`
    PinchZoom,
    /// `IsSwipeNavigationEnabled`
    SwipeNavigation,
    /// `IsStatusBarEnabled`
    StatusBar,
    /// `IsBuiltInErrorPageEnabled`
    BuiltInErrorPage,
    /// `IsGeneralAutofillEnabled`
    GeneralAutofill,
    /// `IsPasswordAutosaveEnabled`
    PasswordAutosave,
    /// `AreDevToolsEnabled`
    DevTools,
    /// `AreDefaultContextMenusEnabled`
    DefaultContextMenus,
}

impl Setting {
    /// WebView2 の API での名前（ログに出す）。
    pub fn api_name(self) -> &'static str {
        match self {
            Setting::BrowserAcceleratorKeys => "AreBrowserAcceleratorKeysEnabled",
            Setting::ZoomControl => "IsZoomControlEnabled",
            Setting::PinchZoom => "IsPinchZoomEnabled",
            Setting::SwipeNavigation => "IsSwipeNavigationEnabled",
            Setting::StatusBar => "IsStatusBarEnabled",
            Setting::BuiltInErrorPage => "IsBuiltInErrorPageEnabled",
            Setting::GeneralAutofill => "IsGeneralAutofillEnabled",
            Setting::PasswordAutosave => "IsPasswordAutosaveEnabled",
            Setting::DevTools => "AreDevToolsEnabled",
            Setting::DefaultContextMenus => "AreDefaultContextMenusEnabled",
        }
    }
}

impl fmt::Display for Setting {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        f.write_str(self.api_name())
    }
}

/// WebView2 の設定を書き込み・読み戻す口。実機では `webview_win.rs`、テストでは偽物。
pub trait SettingsAccess {
    fn set(&mut self, setting: Setting, value: bool) -> Result<(), String>;
    fn get(&self, setting: Setting) -> Result<bool, String>;
}

/// 設定をすべて書き込み、読み戻して合っているかを確かめる。
/// 書けなかった項目と、書いたのに値が違う項目を、文にして返す（空なら全部合っている）。
pub fn apply_flags(flags: &WebviewFlags, access: &mut dyn SettingsAccess) -> Vec<String> {
    let mut problems = Vec::new();
    for (setting, value) in flags.webview2_settings() {
        if let Err(e) = access.set(setting, value) {
            problems.push(format!("{setting} を {value} にできません: {e}"));
            continue;
        }
        match access.get(setting) {
            Ok(actual) if actual == value => {}
            Ok(actual) => problems.push(format!(
                "{setting} を {value} にしたのに、読み戻すと {actual} です"
            )),
            Err(e) => problems.push(format!("{setting} を読み戻せません: {e}")),
        }
    }
    problems
}

// ---- 右クリックのメニュー（N-3） ----

/// 入力欄の右クリックのメニューに残す項目の名前。
/// WebView2 の `ContextMenuItem.Name`（英語の表示名を、小文字で始まるキャメルケースにしたもの）。
pub const KEPT_MENU_ITEMS: [&str; 4] = ["cut", "copy", "paste", "selectAll"];

/// 右クリックのメニューの 1 項目（絞り込みに要る情報だけ）。
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct MenuItemInfo {
    pub name: String,
    pub separator: bool,
}

/// 右クリックのメニューの扱い。
#[derive(Debug, Clone, PartialEq, Eq)]
pub enum ContextMenuPlan {
    /// メニューを出さない。
    Suppress,
    /// 項目を絞って出す。`keep` は、元の項目と同じ並びで、残すなら `true`。
    Keep { keep: Vec<bool> },
}

/// 右クリックのメニューをどうするか。入力欄の上でなければ出さない。
/// 入力欄の上では、切り取り・コピー・貼り付け・すべて選択だけを残し、残した項目の外側や重なった区切り線は取る。
/// 残る項目が無ければ、メニューは出さない。
pub fn plan_context_menu(editable: bool, items: &[MenuItemInfo]) -> ContextMenuPlan {
    if !editable {
        return ContextMenuPlan::Suppress;
    }
    let mut keep: Vec<bool> = items
        .iter()
        .map(|item| !item.separator && KEPT_MENU_ITEMS.contains(&item.name.as_str()))
        .collect();
    if !keep.iter().any(|k| *k) {
        return ContextMenuPlan::Suppress;
    }
    // 区切り線は、残した項目どうしの間に 1 本だけ残す。
    let mut seen_item = false;
    let mut pending_separator: Option<usize> = None;
    for (index, item) in items.iter().enumerate() {
        if item.separator {
            if seen_item && pending_separator.is_none() {
                pending_separator = Some(index);
            }
        } else if keep[index] {
            if let Some(separator) = pending_separator.take() {
                keep[separator] = true;
            }
            seen_item = true;
        }
    }
    ContextMenuPlan::Keep { keep }
}

#[cfg(test)]
mod tests {
    use std::collections::HashMap;

    use super::*;

    /// 書き込みを覚えて、そのまま読み戻させる偽物。
    #[derive(Default)]
    struct RecordingAccess {
        values: HashMap<Setting, bool>,
        writes: Vec<(Setting, bool)>,
    }

    impl SettingsAccess for RecordingAccess {
        fn set(&mut self, setting: Setting, value: bool) -> Result<(), String> {
            self.writes.push((setting, value));
            self.values.insert(setting, value);
            Ok(())
        }

        fn get(&self, setting: Setting) -> Result<bool, String> {
            self.values
                .get(&setting)
                .copied()
                .ok_or_else(|| "書き込まれていません".to_string())
        }
    }

    const ALL_SETTINGS: [Setting; 10] = [
        Setting::BrowserAcceleratorKeys,
        Setting::ZoomControl,
        Setting::PinchZoom,
        Setting::SwipeNavigation,
        Setting::StatusBar,
        Setting::BuiltInErrorPage,
        Setting::GeneralAutofill,
        Setting::PasswordAutosave,
        Setting::DevTools,
        Setting::DefaultContextMenus,
    ];

    #[test]
    fn strict_flags_turn_off_every_browser_feature_in_release() {
        // 全項目を名前で書き出す（`..` を使わない）。項目を足したら、ここも直さないとコンパイルが通らない。
        let WebviewFlags {
            browser_accelerator_keys,
            zoom_control,
            pinch_zoom,
            swipe_navigation,
            zoom_hotkeys,
            status_bar,
            built_in_error_page,
            general_autofill,
            password_autosave,
            dev_tools,
            default_context_menus,
            drag_drop_handler,
        } = WebviewFlags::strict(false);
        assert!(
            !browser_accelerator_keys,
            "N-1: ブラウザのショートカットを切る"
        );
        assert!(!zoom_control, "N-2: 拡大縮小を切る");
        assert!(!pinch_zoom, "N-2: ピンチを切る");
        assert!(!swipe_navigation, "N-2: スワイプの戻る進むを切る");
        assert!(!zoom_hotkeys, "N-2: Tauri の zoomHotkeysEnabled を切る");
        assert!(!status_bar, "N-4: URL の吹き出しを切る");
        assert!(
            !built_in_error_page,
            "N-5: ブラウザ組み込みのエラーページを切る"
        );
        assert!(!general_autofill, "N-10: 自動入力を切る");
        assert!(!password_autosave, "N-10: パスワードの保存の提案を切る");
        assert!(!dev_tools, "N-12: 製品では開発者ツールを切る");
        assert!(
            default_context_menus,
            "N-3: 入力欄の切り取り・コピー・貼り付けのため、標準のメニューは残して絞る"
        );
        assert!(
            drag_drop_handler,
            "N-8: ファイルのドロップは Tauri が受ける"
        );
    }

    #[test]
    fn dev_tools_are_on_only_when_running_under_tauri_dev() {
        assert!(WebviewFlags::strict(true).dev_tools);
        assert!(!WebviewFlags::strict(false).dev_tools);
        // ほかの設定は、開発のときも変わらない。
        let mut dev = WebviewFlags::strict(true);
        dev.dev_tools = false;
        assert_eq!(dev, WebviewFlags::strict(false));
    }

    #[test]
    fn the_webview2_table_lists_every_setting_exactly_once_with_the_flag_value() {
        let flags = WebviewFlags::strict(false);
        let table = flags.webview2_settings();
        let settings: Vec<Setting> = table.iter().map(|(s, _)| *s).collect();
        for expected in ALL_SETTINGS {
            assert_eq!(
                settings.iter().filter(|s| **s == expected).count(),
                1,
                "{expected}"
            );
        }
        let value_of = |wanted: Setting| table.iter().find(|(s, _)| *s == wanted).unwrap().1;
        assert!(!value_of(Setting::BrowserAcceleratorKeys));
        assert!(!value_of(Setting::ZoomControl));
        assert!(!value_of(Setting::PinchZoom));
        assert!(!value_of(Setting::SwipeNavigation));
        assert!(!value_of(Setting::StatusBar));
        assert!(!value_of(Setting::BuiltInErrorPage));
        assert!(!value_of(Setting::GeneralAutofill));
        assert!(!value_of(Setting::PasswordAutosave));
        assert!(!value_of(Setting::DevTools));
        assert!(value_of(Setting::DefaultContextMenus));
        assert!(value_of(Setting::DevTools) == flags.dev_tools);
    }

    #[test]
    fn apply_flags_writes_every_setting_and_reports_nothing_when_all_match() {
        let mut access = RecordingAccess::default();
        let problems = apply_flags(&WebviewFlags::strict(false), &mut access);
        assert_eq!(problems, Vec::<String>::new());
        assert_eq!(access.writes.len(), ALL_SETTINGS.len());
        for setting in ALL_SETTINGS {
            assert!(
                access.writes.iter().any(|(s, _)| *s == setting),
                "{setting} が書き込まれていない"
            );
        }
        // N-1 から N-12 の WebView2 の設定が、期待どおりの値で入っている。
        let expected = [
            (Setting::BrowserAcceleratorKeys, false),
            (Setting::ZoomControl, false),
            (Setting::PinchZoom, false),
            (Setting::SwipeNavigation, false),
            (Setting::StatusBar, false),
            (Setting::BuiltInErrorPage, false),
            (Setting::GeneralAutofill, false),
            (Setting::PasswordAutosave, false),
            (Setting::DevTools, false),
            (Setting::DefaultContextMenus, true),
        ];
        for (setting, value) in expected {
            assert_eq!(access.values.get(&setting), Some(&value), "{setting}");
        }
    }

    #[test]
    fn apply_flags_turns_dev_tools_on_only_for_dev() {
        let mut dev = RecordingAccess::default();
        assert!(apply_flags(&WebviewFlags::strict(true), &mut dev).is_empty());
        assert_eq!(dev.values.get(&Setting::DevTools), Some(&true));
        let mut release = RecordingAccess::default();
        assert!(apply_flags(&WebviewFlags::strict(false), &mut release).is_empty());
        assert_eq!(release.values.get(&Setting::DevTools), Some(&false));
    }

    /// 書き込みを受け付けない（読み戻すと元の値のまま）偽物。
    struct IgnoringAccess;

    impl SettingsAccess for IgnoringAccess {
        fn set(&mut self, _setting: Setting, _value: bool) -> Result<(), String> {
            Ok(())
        }

        fn get(&self, _setting: Setting) -> Result<bool, String> {
            // WebView2 の既定値は、ほとんどの設定が有効。
            Ok(true)
        }
    }

    #[test]
    fn apply_flags_reports_settings_that_did_not_take_effect() {
        let problems = apply_flags(&WebviewFlags::strict(false), &mut IgnoringAccess);
        // 有効のまま読み戻される 9 項目（既定のメニューは、true にしたので一致する）。
        assert_eq!(problems.len(), 9, "{problems:?}");
        assert!(problems
            .iter()
            .any(|p| p.contains("AreBrowserAcceleratorKeysEnabled")));
        assert!(problems.iter().all(|p| p.contains("読み戻すと")));
    }

    /// 一部の項目を使えない（古い WebView2）偽物。
    struct PartialAccess {
        inner: RecordingAccess,
        unsupported: Setting,
    }

    impl SettingsAccess for PartialAccess {
        fn set(&mut self, setting: Setting, value: bool) -> Result<(), String> {
            if setting == self.unsupported {
                return Err("このバージョンの WebView2 には無い".to_string());
            }
            self.inner.set(setting, value)
        }

        fn get(&self, setting: Setting) -> Result<bool, String> {
            self.inner.get(setting)
        }
    }

    #[test]
    fn apply_flags_keeps_going_after_an_unsupported_setting() {
        let mut access = PartialAccess {
            inner: RecordingAccess::default(),
            unsupported: Setting::PasswordAutosave,
        };
        let problems = apply_flags(&WebviewFlags::strict(false), &mut access);
        assert_eq!(problems.len(), 1);
        assert!(problems[0].contains("IsPasswordAutosaveEnabled"));
        // ほかの 9 項目は書き込まれている。
        assert_eq!(access.inner.writes.len(), 9);
    }

    #[test]
    fn builder_options_follow_the_flags() {
        let release = WebviewFlags::strict(false).builder_options();
        assert_eq!(
            release,
            BuilderOptions {
                zoom_hotkeys_enabled: false,
                general_autofill_enabled: false,
                devtools: false,
                drag_drop_handler: true,
            }
        );
        let dev = WebviewFlags::strict(true).builder_options();
        assert!(dev.devtools);
        assert!(!dev.zoom_hotkeys_enabled && !dev.general_autofill_enabled);
    }

    // ---- 右クリックのメニュー ----

    fn item(name: &str) -> MenuItemInfo {
        MenuItemInfo {
            name: name.to_string(),
            separator: false,
        }
    }

    fn separator() -> MenuItemInfo {
        MenuItemInfo {
            name: String::new(),
            separator: true,
        }
    }

    #[test]
    fn the_context_menu_is_suppressed_outside_editable_fields() {
        let items = vec![item("copy"), item("selectAll"), item("inspectElement")];
        assert_eq!(plan_context_menu(false, &items), ContextMenuPlan::Suppress);
        assert_eq!(plan_context_menu(false, &[]), ContextMenuPlan::Suppress);
    }

    #[test]
    fn an_editable_field_keeps_only_cut_copy_paste_and_select_all() {
        let items = vec![
            item("undo"),
            separator(),
            item("cut"),
            item("copy"),
            item("paste"),
            item("pasteAsPlainText"),
            separator(),
            item("selectAll"),
            separator(),
            item("spellCheck"),
            item("writingDirection"),
            item("emoji"),
            item("inspectElement"),
        ];
        let ContextMenuPlan::Keep { keep } = plan_context_menu(true, &items) else {
            panic!("入力欄ではメニューを出す");
        };
        let kept: Vec<&str> = items
            .iter()
            .zip(&keep)
            .filter(|(_, k)| **k)
            .map(|(i, _)| if i.separator { "|" } else { i.name.as_str() })
            .collect();
        assert_eq!(kept, vec!["cut", "copy", "paste", "|", "selectAll"]);
    }

    #[test]
    fn separators_never_lead_trail_or_double_up() {
        let items = vec![
            separator(),
            item("emoji"),
            separator(),
            item("cut"),
            separator(),
            separator(),
            item("paste"),
            separator(),
            item("inspectElement"),
        ];
        let ContextMenuPlan::Keep { keep } = plan_context_menu(true, &items) else {
            panic!("入力欄ではメニューを出す");
        };
        let kept: Vec<&str> = items
            .iter()
            .zip(&keep)
            .filter(|(_, k)| **k)
            .map(|(i, _)| if i.separator { "|" } else { i.name.as_str() })
            .collect();
        assert_eq!(kept, vec!["cut", "|", "paste"]);
    }

    #[test]
    fn an_editable_field_with_nothing_to_keep_shows_no_menu() {
        let items = vec![item("emoji"), separator(), item("inspectElement")];
        assert_eq!(plan_context_menu(true, &items), ContextMenuPlan::Suppress);
    }

    #[test]
    fn a_separator_is_not_mistaken_for_an_item_with_a_kept_name() {
        let items = vec![
            MenuItemInfo {
                name: "copy".to_string(),
                separator: true,
            },
            item("cut"),
        ];
        let ContextMenuPlan::Keep { keep } = plan_context_menu(true, &items) else {
            panic!("入力欄ではメニューを出す");
        };
        assert_eq!(keep, vec![false, true]);
    }
}
