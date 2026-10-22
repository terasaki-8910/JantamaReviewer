//! 窓の作り方。
//!
//! ウィジェットの窓の設定は `widget_window_spec` という 1 つの関数に集め、
//! 「クリックしても前面のアプリからフォーカスを奪わない」設定（W-4）などをテストで確かめる。
//! 窓の位置を画面の中に収める計算も、ここの純粋な関数。

use tauri::webview::NewWindowResponse;
use tauri::{
    LogicalSize, Manager, PhysicalPosition, Runtime, WebviewUrl, WebviewWindow,
    WebviewWindowBuilder,
};

use crate::external::{download_hook, navigation_hook, new_window_hook, open_in_default_browser};
use crate::navigation::AppOrigins;
use crate::settings::Orientation;
use crate::webview_policy::WebviewFlags;

pub const WIDGET_LABEL: &str = "widget";
pub const MAIN_LABEL: &str = "main";

/// ウィジェットの窓の題名（N-13）。アプリの日本語の名前。URL や localhost は入れない。
pub const WIDGET_TITLE: &str = "JantamaReviewer ウィジェット";
/// 検討画面の窓の題名（N-13）。
pub const MAIN_TITLE: &str = "JantamaReviewer 検討画面";

/// 縦長のウィジェットの大きさ（論理ピクセル）。幅 76px、高さは約 336px。
pub const WIDGET_VERTICAL_SIZE: (f64, f64) = (76.0, 336.0);
/// 横長のウィジェットの大きさ（論理ピクセル）。
pub const WIDGET_HORIZONTAL_SIZE: (f64, f64) = (340.0, 64.0);
/// 迷いだけ（`Settings::doubt_only`）のウィジェットの大きさ（論理ピクセル）。形（縦長・横長）によらず 48px 角（W-15）。
pub const WIDGET_DOUBT_ONLY_SIZE: (f64, f64) = (48.0, 48.0);
/// ウィジェットの窓の大きさの下限（論理ピクセル）。3 つの大きさのどれより小さく、Windows の既定の下限（幅 136px）より小さい。
pub const WIDGET_MIN_SIZE: (f64, f64) = (40.0, 40.0);

/// ウィジェットの大きさ（W-5、W-15）。迷いだけが入なら、形によらず 48px 角。切なら、選んだ形の大きさ。
pub fn widget_size(orientation: Orientation, doubt_only: bool) -> (f64, f64) {
    if doubt_only {
        return WIDGET_DOUBT_ONLY_SIZE;
    }
    match orientation {
        Orientation::Vertical => WIDGET_VERTICAL_SIZE,
        Orientation::Horizontal => WIDGET_HORIZONTAL_SIZE,
    }
}

/// 窓の作り方のすべて。
#[derive(Debug, Clone, PartialEq)]
pub struct WindowSpec {
    pub label: &'static str,
    /// フロントエンドのページ（`apps/desktop` の直下の HTML）。
    pub url: &'static str,
    pub title: &'static str,
    /// 内側の大きさ（論理ピクセル）。
    pub width: f64,
    pub height: f64,
    /// 窓の大きさの下限（論理ピクセル）。`None` なら Windows の既定の下限（幅 136px など）になり、
    /// 幅 76px のウィジェットや 48px 角の迷いだけのウィジェットが、それより広く作られてしまう。
    pub min_size: Option<(f64, f64)>,
    pub decorations: bool,
    pub always_on_top: bool,
    pub resizable: bool,
    pub skip_taskbar: bool,
    /// `false` ならクリックしても窓が有効にならない（Windows では WS_EX_NOACTIVATE）。
    pub focusable: bool,
    /// 作った直後に前面にして入力を受けるか。
    pub focused: bool,
    pub visible: bool,
    pub shadow: bool,
    pub maximizable: bool,
    pub minimizable: bool,
}

/// ウィジェットの窓。常に手前・枠なし・大きさ固定・タスクバーに出さず、クリックしても雀魂からフォーカスを奪わない。
/// 迷いだけ（`doubt_only`）が入なら 48px 角、切なら選んだ形（`orientation`）の大きさ。
pub fn widget_window_spec(orientation: Orientation, doubt_only: bool) -> WindowSpec {
    let (width, height) = widget_size(orientation, doubt_only);
    WindowSpec {
        label: WIDGET_LABEL,
        url: "widget.html",
        title: WIDGET_TITLE,
        width,
        height,
        // どの大きさにも収まる小さな下限にして、Windows の既定の下限（幅 136px）を外す。
        min_size: Some(WIDGET_MIN_SIZE),
        decorations: false,
        always_on_top: true,
        resizable: false,
        skip_taskbar: true,
        focusable: false,
        focused: false,
        // 位置を決めてから見せる。
        visible: false,
        // 影を付けると、窓の周りに見えない枠（左右・下に 8px ほど）が付いて、大きさが仕様とずれる。
        // 承認済みの見た目にも影は無く、1px の枠線だけ。
        shadow: false,
        maximizable: false,
        minimizable: false,
    }
}

/// 検討画面の窓。起動時は隠しておく。
pub fn main_window_spec() -> WindowSpec {
    WindowSpec {
        label: MAIN_LABEL,
        url: "index.html",
        title: MAIN_TITLE,
        width: 1120.0,
        height: 760.0,
        min_size: None,
        decorations: true,
        always_on_top: false,
        resizable: true,
        skip_taskbar: false,
        focusable: true,
        focused: true,
        visible: false,
        shadow: true,
        maximizable: true,
        minimizable: true,
    }
}

/// 設定どおりに窓を作る。窓の作り方はすべて `WindowSpec` から来る。
/// ブラウザの名残を出さないための設定（N-1〜N-12）は、`WebviewFlags` から来る。
/// - Tauri が出している設定は、窓を作るときに渡す。
/// - 画面の遷移・新しい窓・ダウンロードの要求は、`navigation.rs` の決まりで扱う（アプリ自身の画面だけを読み込む）。
/// - WebView の残りの設定は、作った直後に書き込んで読み戻す（`platform::harden_webview`。Windows は `platform/win/webview.rs`）。
pub fn build_window<R: Runtime, M: Manager<R>>(
    manager: &M,
    spec: &WindowSpec,
) -> tauri::Result<WebviewWindow<R>> {
    let dev = tauri::is_dev();
    let flags = WebviewFlags::strict(dev);
    let options = flags.builder_options();
    let origins = AppOrigins::for_run(dev, manager.config().build.dev_url.as_ref());
    let navigation_origins = origins.clone();
    let mut builder =
        WebviewWindowBuilder::new(manager, spec.label, WebviewUrl::App(spec.url.into()))
            .title(spec.title)
            .inner_size(spec.width, spec.height)
            .decorations(spec.decorations)
            .always_on_top(spec.always_on_top)
            .resizable(spec.resizable)
            .skip_taskbar(spec.skip_taskbar)
            .focusable(spec.focusable)
            .focused(spec.focused)
            .visible(spec.visible)
            .shadow(spec.shadow)
            .maximizable(spec.maximizable)
            .minimizable(spec.minimizable)
            .zoom_hotkeys_enabled(options.zoom_hotkeys_enabled)
            .general_autofill_enabled(options.general_autofill_enabled)
            .devtools(options.devtools)
            .on_navigation(move |url| {
                navigation_hook(url, &navigation_origins, &open_in_default_browser)
            })
            .on_new_window(move |url, _features| {
                new_window_hook(&url, &origins, &open_in_default_browser);
                // 新しい窓は、どの場合も作らない。
                NewWindowResponse::Deny
            })
            .on_download(|_webview, event| download_hook(&event));
    if !options.drag_drop_handler {
        builder = builder.disable_drag_drop_handler();
    }
    if let Some((min_width, min_height)) = spec.min_size {
        builder = builder.min_inner_size(min_width, min_height);
    }
    // 試しに動かすときは、WebView2 のデータも試しの設定フォルダの下に置く（本物のアプリのデータに混ぜない）。
    if let Some(dir) = crate::webview_data::app_webview_dir(crate::webview_data::config_env()) {
        builder = builder.data_directory(dir);
    }
    // macOS の WKWebView の設定（リンクのプレビューを出さない・保存領域を識別子で分ける）。Windows では何もしない。
    builder = crate::platform::with_webview_options(
        builder,
        crate::webview_data::app_data_store_id(crate::webview_data::config_env()),
    );
    let window = builder.build()?;
    if spec.min_size.is_some() {
        // 作る最中は Windows の既定の下限（幅 136px）が先に効いて、小さい窓が広がってしまう。
        // 下限を外した状態で、もう一度大きさを指定し直す。
        window.set_size(LogicalSize::new(spec.width, spec.height))?;
    }
    // WebView の残りの設定（N-1〜N-12）は OS ごとの実装で書き込む（Windows は WebView2。`platform/win/webview.rs`）。
    crate::platform::harden_webview(&window, flags);
    Ok(window)
}

/// 画面の領域（物理ピクセル）。
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub struct Area {
    pub x: i32,
    pub y: i32,
    pub width: i32,
    pub height: i32,
}

impl Area {
    fn right(&self) -> i64 {
        i64::from(self.x) + i64::from(self.width)
    }

    fn bottom(&self) -> i64 {
        i64::from(self.y) + i64::from(self.height)
    }

    fn center(&self) -> (i64, i64) {
        (
            i64::from(self.x) + i64::from(self.width) / 2,
            i64::from(self.y) + i64::from(self.height) / 2,
        )
    }
}

/// 窓が画面の外にはみ出さないように位置を直す。
/// 窓の中心がある画面（どの画面にも無ければ、いちばん近い画面）の中に、窓全体が収まるようにする。
/// 画面が無ければそのまま。モニターを外したあとに、窓が行方不明にならないための処理。
pub fn clamp_to_monitors(pos: (i32, i32), size: (i32, i32), monitors: &[Area]) -> (i32, i32) {
    if monitors.is_empty() {
        return pos;
    }
    let center = (
        i64::from(pos.0) + i64::from(size.0) / 2,
        i64::from(pos.1) + i64::from(size.1) / 2,
    );
    let contains = |m: &Area| {
        center.0 >= i64::from(m.x)
            && center.0 < m.right()
            && center.1 >= i64::from(m.y)
            && center.1 < m.bottom()
    };
    let monitor = monitors.iter().find(|m| contains(m)).unwrap_or_else(|| {
        monitors
            .iter()
            .min_by_key(|m| {
                let c = m.center();
                (c.0 - center.0).pow(2) + (c.1 - center.1).pow(2)
            })
            .expect("画面が 1 つ以上ある")
    });
    let max_x = (monitor.right() - i64::from(size.0)).max(i64::from(monitor.x));
    let max_y = (monitor.bottom() - i64::from(size.1)).max(i64::from(monitor.y));
    let x = i64::from(pos.0).clamp(i64::from(monitor.x), max_x);
    let y = i64::from(pos.1).clamp(i64::from(monitor.y), max_y);
    (x as i32, y as i32)
}

/// 初めて起動したときの位置: 主画面の右端から少し内側、上から少し下。
pub fn default_widget_position(size: (i32, i32), primary: Area) -> (i32, i32) {
    const MARGIN: i32 = 24;
    const TOP: i32 = 120;
    clamp_to_monitors(
        (primary.x + primary.width - size.0 - MARGIN, primary.y + TOP),
        size,
        &[primary],
    )
}

/// 窓を指定の位置に動かす（物理ピクセル）。
pub fn move_window<R: Runtime>(window: &WebviewWindow<R>, pos: (i32, i32)) {
    let _ = window.set_position(PhysicalPosition::new(pos.0, pos.1));
}

#[cfg(test)]
mod tests {
    use super::*;

    const SCREEN: Area = Area {
        x: 0,
        y: 0,
        width: 2560,
        height: 1400,
    };
    const LEFT: Area = Area {
        x: -1920,
        y: 0,
        width: 1920,
        height: 1080,
    };

    /// 迷いだけの入・切と、形の組み合わせ（ウィジェットの窓の大きさが決まる 4 通り）。
    const MODES: [(Orientation, bool); 4] = [
        (Orientation::Vertical, false),
        (Orientation::Horizontal, false),
        (Orientation::Vertical, true),
        (Orientation::Horizontal, true),
    ];

    #[test]
    fn w4_the_widget_window_is_created_without_taking_focus() {
        // 迷いだけの 48px 角も、これまでの縦長・横長も、同じ作り方（常に手前・フォーカスを奪わない）。
        for (orientation, doubt_only) in MODES {
            let spec = widget_window_spec(orientation, doubt_only);
            assert!(
                !spec.focusable,
                "クリックしても有効にならない（WS_EX_NOACTIVATE）"
            );
            assert!(!spec.focused, "作った直後に前面にしない");
            assert!(spec.always_on_top, "常に手前");
            assert!(!spec.decorations, "枠なし");
            assert!(!spec.resizable, "大きさ固定");
            assert!(spec.skip_taskbar, "タスクバーに出さない");
            assert!(!spec.shadow, "影の分の見えない枠が付くと、大きさがずれる");
            assert_eq!(spec.label, WIDGET_LABEL);
            assert_eq!(spec.url, "widget.html");
        }
    }

    #[test]
    fn w5_the_vertical_widget_is_76px_wide_and_the_horizontal_one_is_340_by_64() {
        let v = widget_window_spec(Orientation::Vertical, false);
        assert_eq!((v.width, v.height), (76.0, 336.0));
        let h = widget_window_spec(Orientation::Horizontal, false);
        assert_eq!((h.width, h.height), (340.0, 64.0));
        assert_eq!(
            widget_size(Orientation::default(), false),
            (76.0, 336.0),
            "既定の形は縦長"
        );
    }

    #[test]
    fn w15_with_doubt_only_the_widget_is_a_48px_square_whatever_the_chosen_shape() {
        for orientation in [Orientation::Vertical, Orientation::Horizontal] {
            assert_eq!(
                widget_size(orientation, true),
                (48.0, 48.0),
                "{orientation:?}"
            );
            let spec = widget_window_spec(orientation, true);
            assert_eq!((spec.width, spec.height), (48.0, 48.0), "{orientation:?}");
        }
        assert_eq!(WIDGET_DOUBT_ONLY_SIZE, (48.0, 48.0));
    }

    #[test]
    fn w15_turning_doubt_only_off_returns_to_the_chosen_shape_and_its_size() {
        // 切にすると、選んでいた形と大きさに戻る（形の設定は、迷いだけを入れても書き換えない）。
        assert_eq!(
            widget_size(Orientation::Vertical, false),
            WIDGET_VERTICAL_SIZE
        );
        assert_eq!(
            widget_size(Orientation::Horizontal, false),
            WIDGET_HORIZONTAL_SIZE
        );
        for orientation in [Orientation::Vertical, Orientation::Horizontal] {
            assert_ne!(
                widget_size(orientation, true),
                widget_size(orientation, false)
            );
        }
    }

    #[test]
    fn w5_the_widget_minimum_size_is_below_every_size_so_windows_does_not_widen_it() {
        let (min_w, min_h) = WIDGET_MIN_SIZE;
        for (orientation, doubt_only) in MODES {
            let spec = widget_window_spec(orientation, doubt_only);
            assert_eq!(spec.min_size, Some(WIDGET_MIN_SIZE), "下限を明示する");
            let (w, h) = widget_size(orientation, doubt_only);
            assert!(min_w <= w && min_h <= h, "{orientation:?} {doubt_only}");
        }
        // 48px 角は、下限より大きい（下限に当たって広げられない）。
        assert!(min_w < 48.0 && min_h < 48.0);
        // Windows の既定の下限（幅 136px）より小さい。
        assert!(min_w < 136.0);
    }

    #[test]
    fn n7_both_windows_are_created_hidden_so_they_can_be_shown_after_the_first_paint() {
        for spec in [
            widget_window_spec(Orientation::Vertical, false),
            widget_window_spec(Orientation::Horizontal, false),
            widget_window_spec(Orientation::Vertical, true),
            main_window_spec(),
        ] {
            assert!(!spec.visible, "{}: 隠したまま作る", spec.label);
        }
    }

    #[test]
    fn n13_window_titles_are_japanese_app_names_and_never_a_url() {
        let specs = [
            widget_window_spec(Orientation::Vertical, false),
            main_window_spec(),
        ];
        assert_eq!(specs[0].title, WIDGET_TITLE);
        assert_eq!(specs[1].title, MAIN_TITLE);
        assert_ne!(WIDGET_TITLE, MAIN_TITLE, "2 つの窓の題名は区別できる");
        for spec in specs {
            let title = spec.title;
            assert!(title.starts_with("JantamaReviewer"), "{title}");
            assert!(
                title
                    .chars()
                    .any(|c| matches!(c, '\u{3040}'..='\u{30FF}' | '\u{4E00}'..='\u{9FFF}')),
                "日本語の名前を含む: {title}"
            );
            for forbidden in ["localhost", "://", "http", "tauri", ".html", "127.0.0.1"] {
                assert!(
                    !title.to_lowercase().contains(forbidden),
                    "題名に {forbidden} を入れない: {title}"
                );
            }
        }
    }

    #[test]
    fn the_main_window_starts_hidden_and_is_a_normal_window() {
        let spec = main_window_spec();
        assert!(!spec.visible);
        assert!(spec.decorations && spec.resizable && spec.focusable);
        assert!(!spec.always_on_top);
        assert_eq!(spec.label, MAIN_LABEL);
        assert_eq!(spec.url, "index.html");
    }

    #[test]
    fn a_position_inside_a_monitor_is_kept() {
        assert_eq!(
            clamp_to_monitors((2400, 100), (76, 336), &[SCREEN]),
            (2400, 100)
        );
    }

    #[test]
    fn a_position_past_the_edge_is_pulled_back_inside() {
        assert_eq!(
            clamp_to_monitors((2540, 1390), (76, 336), &[SCREEN]),
            (2560 - 76, 1400 - 336)
        );
        assert_eq!(clamp_to_monitors((-30, -30), (76, 336), &[SCREEN]), (0, 0));
    }

    #[test]
    fn w15_a_widget_that_shrinks_to_the_square_keeps_its_top_left_and_one_that_grows_is_pulled_inside(
    ) {
        // 縦長（76×336）から 48px 角に縮める: 左上はそのまま（画面の中なので動かさない）
        assert_eq!(
            clamp_to_monitors((2400, 100), (48, 48), &[SCREEN]),
            (2400, 100)
        );
        // 48px 角から縦長・横長に戻す: 画面の下・右にはみ出すなら内側に寄せる
        assert_eq!(
            clamp_to_monitors((2400, 1380), (76, 336), &[SCREEN]),
            (2400, 1400 - 336)
        );
        assert_eq!(
            clamp_to_monitors((2500, 100), (340, 64), &[SCREEN]),
            (2560 - 340, 100)
        );
        // 角の位置の 48px 角は、画面の端に収まる
        assert_eq!(
            clamp_to_monitors((2540, 1390), (48, 48), &[SCREEN]),
            (2560 - 48, 1400 - 48)
        );
    }

    #[test]
    fn a_window_on_a_removed_monitor_moves_to_the_nearest_remaining_one() {
        // 左のモニター（x が負）にあった窓。左のモニターを外した。
        let pos = clamp_to_monitors((-1800, 240), (76, 336), &[SCREEN]);
        assert_eq!(pos, (0, 240));
    }

    #[test]
    fn a_window_on_a_secondary_monitor_stays_there() {
        assert_eq!(
            clamp_to_monitors((-1800, 240), (76, 336), &[SCREEN, LEFT]),
            (-1800, 240)
        );
    }

    #[test]
    fn with_no_monitor_information_the_position_is_unchanged() {
        assert_eq!(clamp_to_monitors((5, 6), (76, 336), &[]), (5, 6));
    }

    #[test]
    fn a_window_larger_than_the_monitor_is_aligned_to_its_corner() {
        let small = Area {
            x: 0,
            y: 0,
            width: 100,
            height: 100,
        };
        assert_eq!(clamp_to_monitors((50, 50), (340, 336), &[small]), (0, 0));
    }

    #[test]
    fn the_default_position_is_near_the_right_edge_of_the_primary_monitor() {
        let (x, y) = default_widget_position((114, 504), SCREEN);
        assert_eq!(x, 2560 - 114 - 24);
        assert_eq!(y, 120);
    }
}
