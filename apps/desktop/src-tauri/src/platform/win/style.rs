//! 窓を作ったあとの Windows 固有の仕上げ。
//! - 有効にならない設定（WS_EX_NOACTIVATE）が窓に付いていなければ付ける（W-4 の保険）。
//! - 枠なしの窓の角を、Windows 11 の標準の丸みにそろえる（承認済みの見た目の角丸）。

use std::ffi::c_void;
use std::mem::size_of;

use tauri::{Runtime, WebviewWindow};
use windows::Win32::Foundation::HWND;
use windows::Win32::Graphics::Dwm::{
    DwmSetWindowAttribute, DWMWA_WINDOW_CORNER_PREFERENCE, DWMWCP_ROUND,
    DWM_WINDOW_CORNER_PREFERENCE,
};
use windows::Win32::UI::WindowsAndMessaging::{
    GetWindowLongPtrW, SetWindowLongPtrW, GWL_EXSTYLE, WS_EX_NOACTIVATE,
};

use crate::widget_window::WindowSpec;

pub fn style_window<R: Runtime>(window: &WebviewWindow<R>, spec: &WindowSpec) {
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
