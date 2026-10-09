//! 窓の作り方。
//!
//! ウィジェットの窓の設定は `widget_window_spec` という 1 つの関数に集め、
//! 「クリックしても前面のアプリからフォーカスを奪わない」設定（W-4）などをテストで確かめる。
//! 窓の位置を画面の中に収める計算も、ここの純粋な関数。

use tauri::{Manager, PhysicalPosition, Runtime, WebviewUrl, WebviewWindow, WebviewWindowBuilder};

use crate::settings::Orientation;

pub const WIDGET_LABEL: &str = "widget";
pub const MAIN_LABEL: &str = "main";

/// 縦長のウィジェットの大きさ（論理ピクセル）。幅 76px、高さは約 336px。
pub const WIDGET_VERTICAL_SIZE: (f64, f64) = (76.0, 336.0);
/// 横長のウィジェットの大きさ（論理ピクセル）。
pub const WIDGET_HORIZONTAL_SIZE: (f64, f64) = (340.0, 64.0);

/// ウィジェットの大きさ（W-5）。
pub fn widget_size(orientation: Orientation) -> (f64, f64) {
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
pub fn widget_window_spec(orientation: Orientation) -> WindowSpec {
    let (width, height) = widget_size(orientation);
    WindowSpec {
        label: WIDGET_LABEL,
        url: "widget.html",
        title: "JantamaReviewer ウィジェット",
        width,
        height,
        decorations: false,
        always_on_top: true,
        resizable: false,
        skip_taskbar: true,
        focusable: false,
        focused: false,
        // 位置を決めてから見せる。
        visible: false,
        shadow: true,
        maximizable: false,
        minimizable: false,
    }
}

/// 検討画面の窓。起動時は隠しておく。
pub fn main_window_spec() -> WindowSpec {
    WindowSpec {
        label: MAIN_LABEL,
        url: "index.html",
        title: "JantamaReviewer",
        width: 1120.0,
        height: 760.0,
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
pub fn build_window<R: Runtime, M: Manager<R>>(
    manager: &M,
    spec: &WindowSpec,
) -> tauri::Result<WebviewWindow<R>> {
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
        .build()
}

/// 窓を作ったあとの Windows 固有の仕上げ。
/// - 有効にならない設定（WS_EX_NOACTIVATE）が窓に付いていなければ付ける（W-4 の保険）。
/// - 枠なしの窓の角を、Windows 11 の標準の丸みにそろえる（承認済みの見た目の角丸）。
#[cfg(windows)]
pub fn apply_native_style<R: Runtime>(window: &WebviewWindow<R>, spec: &WindowSpec) {
    use std::ffi::c_void;
    use std::mem::size_of;

    use windows::Win32::Foundation::HWND;
    use windows::Win32::Graphics::Dwm::{
        DwmSetWindowAttribute, DWMWA_WINDOW_CORNER_PREFERENCE, DWMWCP_ROUND,
        DWM_WINDOW_CORNER_PREFERENCE,
    };
    use windows::Win32::UI::WindowsAndMessaging::{
        GetWindowLongPtrW, SetWindowLongPtrW, GWL_EXSTYLE, WS_EX_NOACTIVATE,
    };

    let Ok(raw) = window.hwnd() else {
        return;
    };
    let hwnd = HWND(raw.0);
    // SAFETY: hwnd は今作った窓のもの。
    unsafe {
        if !spec.focusable {
            let style = GetWindowLongPtrW(hwnd, GWL_EXSTYLE);
            if style & WS_EX_NOACTIVATE.0 as isize == 0 {
                SetWindowLongPtrW(hwnd, GWL_EXSTYLE, style | WS_EX_NOACTIVATE.0 as isize);
            }
        }
        if !spec.decorations {
            let preference: DWM_WINDOW_CORNER_PREFERENCE = DWMWCP_ROUND;
            // Windows 10 などで効かなくても、見た目が角張るだけなので結果は見ない。
            let _ = DwmSetWindowAttribute(
                hwnd,
                DWMWA_WINDOW_CORNER_PREFERENCE,
                &preference as *const DWM_WINDOW_CORNER_PREFERENCE as *const c_void,
                size_of::<DWM_WINDOW_CORNER_PREFERENCE>() as u32,
            );
        }
    }
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

    #[test]
    fn w4_the_widget_window_is_created_without_taking_focus() {
        for orientation in [Orientation::Vertical, Orientation::Horizontal] {
            let spec = widget_window_spec(orientation);
            assert!(
                !spec.focusable,
                "クリックしても有効にならない（WS_EX_NOACTIVATE）"
            );
            assert!(!spec.focused, "作った直後に前面にしない");
            assert!(spec.always_on_top, "常に手前");
            assert!(!spec.decorations, "枠なし");
            assert!(!spec.resizable, "大きさ固定");
            assert!(spec.skip_taskbar, "タスクバーに出さない");
            assert_eq!(spec.label, WIDGET_LABEL);
            assert_eq!(spec.url, "widget.html");
        }
    }

    #[test]
    fn w5_the_vertical_widget_is_76px_wide_and_the_horizontal_one_is_340_by_64() {
        let v = widget_window_spec(Orientation::Vertical);
        assert_eq!((v.width, v.height), (76.0, 336.0));
        let h = widget_window_spec(Orientation::Horizontal);
        assert_eq!((h.width, h.height), (340.0, 64.0));
        assert_eq!(widget_size(Orientation::default()), (76.0, 336.0));
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
