//! スクリーンショットの Windows 実装（`ScreenSource`）。窓を選んで撮り、撮れなければ画面に切り替える手順は `capture::ScreenCapturer`。
//!
//! 窓の一覧は `EnumWindows`、撮影は画面の長方形を GDI の `BitBlt` で写す。
//! 画面に出ている最終的な絵（GPU で描いた内容を含む）をそのまま写すので、
//! 対局中に雀魂の窓が手前にある前提で、見たままが残る。
//!
//! ここでやるのは「窓の題名と位置を調べる」「画面の一部を写す」ことだけで、
//! ほかのプロセスの中身（メモリ・ハンドル）には触れない（S-1）。
//! 写した画像は保存するだけで、中身の解析はしない（S-3）。

use std::ffi::c_void;
use std::mem::size_of;

use windows::core::BOOL;
use windows::Win32::Foundation::{HWND, LPARAM, POINT, RECT};
use windows::Win32::Graphics::Dwm::{
    DwmGetWindowAttribute, DWMWA_CLOAKED, DWMWA_EXTENDED_FRAME_BOUNDS,
};
use windows::Win32::Graphics::Gdi::{
    BitBlt, CreateCompatibleBitmap, CreateCompatibleDC, DeleteDC, DeleteObject, GetDC, GetDIBits,
    GetMonitorInfoW, MonitorFromPoint, ReleaseDC, SelectObject, BITMAPINFO, BITMAPINFOHEADER,
    CAPTUREBLT, DIB_RGB_COLORS, HBITMAP, HDC, HGDIOBJ, MONITORINFO, MONITOR_DEFAULTTOPRIMARY,
    SRCCOPY,
};
use windows::Win32::System::Threading::GetCurrentProcessId;
use windows::Win32::UI::WindowsAndMessaging::{
    EnumWindows, GetCursorPos, GetForegroundWindow, GetSystemMetrics, GetWindowRect,
    GetWindowTextLengthW, GetWindowTextW, GetWindowThreadProcessId, IsIconic, IsWindowVisible,
    SM_CXVIRTUALSCREEN, SM_CYVIRTUALSCREEN, SM_XVIRTUALSCREEN, SM_YVIRTUALSCREEN,
};

use crate::capture::{bgra_to_rgb, encode_png_rgb, CaptureError, Rect, ScreenSource, WindowInfo};

/// 実機の画面と窓の一覧（Windows）。`ScreenCapturer` に包んで、スクリーンショットの取得元にする。
#[derive(Debug, Default, Clone, Copy)]
pub struct WindowsScreen;

impl ScreenSource for WindowsScreen {
    fn windows(&self) -> Vec<WindowInfo> {
        enumerate_windows()
    }

    fn capture_rect(&self, rect: Rect) -> Result<Vec<u8>, CaptureError> {
        capture_region_png(rect)
    }

    fn cursor_screen(&self) -> Rect {
        cursor_monitor_rect()
    }
}

/// 題名のある最上位の窓を、手前の窓から順に並べて返す。このアプリ自身の窓は含めない。
pub fn enumerate_windows() -> Vec<WindowInfo> {
    let mut list: Vec<WindowInfo> = Vec::new();
    // SAFETY: コールバックの間だけ、list への可変参照を LPARAM で渡している。
    unsafe {
        let _ = EnumWindows(
            Some(enum_proc),
            LPARAM(&mut list as *mut Vec<WindowInfo> as isize),
        );
    }
    list
}

unsafe extern "system" fn enum_proc(hwnd: HWND, lparam: LPARAM) -> BOOL {
    // SAFETY: enumerate_windows が渡した Vec への参照。
    let list = unsafe { &mut *(lparam.0 as *mut Vec<WindowInfo>) };
    if let Some(info) = unsafe { describe(hwnd) } {
        list.push(info);
    }
    BOOL(1)
}

unsafe fn describe(hwnd: HWND) -> Option<WindowInfo> {
    let len = unsafe { GetWindowTextLengthW(hwnd) };
    if len <= 0 {
        return None;
    }
    let mut pid = 0u32;
    unsafe { GetWindowThreadProcessId(hwnd, Some(&mut pid)) };
    if pid == unsafe { GetCurrentProcessId() } {
        return None;
    }
    let mut buf = vec![0u16; len as usize + 1];
    let copied = unsafe { GetWindowTextW(hwnd, &mut buf) };
    if copied <= 0 {
        return None;
    }
    let title = String::from_utf16_lossy(&buf[..copied as usize]);
    let visible = unsafe { IsWindowVisible(hwnd) }.as_bool() && !unsafe { is_cloaked(hwnd) };
    let minimized = unsafe { IsIconic(hwnd) }.as_bool();
    let foreground = hwnd == unsafe { GetForegroundWindow() };
    let rect = unsafe { frame_rect(hwnd) }?;
    Some(WindowInfo {
        title,
        foreground,
        visible,
        minimized,
        rect,
    })
}

/// 別の仮想デスクトップにあるなど、表示はされているが見えない窓か。
unsafe fn is_cloaked(hwnd: HWND) -> bool {
    let mut cloaked = 0u32;
    let ok = unsafe {
        DwmGetWindowAttribute(
            hwnd,
            DWMWA_CLOAKED,
            &mut cloaked as *mut u32 as *mut c_void,
            size_of::<u32>() as u32,
        )
    };
    ok.is_ok() && cloaked != 0
}

/// 窓の見た目の枠（影を含まない）。取れなければ `GetWindowRect`。
unsafe fn frame_rect(hwnd: HWND) -> Option<Rect> {
    let mut r = RECT::default();
    let dwm = unsafe {
        DwmGetWindowAttribute(
            hwnd,
            DWMWA_EXTENDED_FRAME_BOUNDS,
            &mut r as *mut RECT as *mut c_void,
            size_of::<RECT>() as u32,
        )
    };
    if dwm.is_err() && unsafe { GetWindowRect(hwnd, &mut r) }.is_err() {
        return None;
    }
    Some(Rect {
        left: r.left,
        top: r.top,
        right: r.right,
        bottom: r.bottom,
    })
}

/// マウスカーソルがあるモニター全体。見つからなければ主モニター。
/// 雀魂の窓が見つからないときに撮る範囲で、ボタンを押した場所（= 対局している画面）を撮るため。
fn cursor_monitor_rect() -> Rect {
    // SAFETY: 出力先は初期化済みの構造体。
    unsafe {
        let mut pt = POINT::default();
        if GetCursorPos(&mut pt).is_err() {
            pt = POINT { x: 0, y: 0 };
        }
        let monitor = MonitorFromPoint(pt, MONITOR_DEFAULTTOPRIMARY);
        let mut info = MONITORINFO {
            cbSize: size_of::<MONITORINFO>() as u32,
            ..Default::default()
        };
        if GetMonitorInfoW(monitor, &mut info).as_bool() {
            let r = info.rcMonitor;
            return Rect {
                left: r.left,
                top: r.top,
                right: r.right,
                bottom: r.bottom,
            };
        }
        virtual_screen_rect()
    }
}

/// 全モニターを合わせた画面全体。
fn virtual_screen_rect() -> Rect {
    // SAFETY: 値を読むだけ。
    unsafe {
        let left = GetSystemMetrics(SM_XVIRTUALSCREEN);
        let top = GetSystemMetrics(SM_YVIRTUALSCREEN);
        Rect {
            left,
            top,
            right: left + GetSystemMetrics(SM_CXVIRTUALSCREEN),
            bottom: top + GetSystemMetrics(SM_CYVIRTUALSCREEN),
        }
    }
}

/// 長方形を画面全体の範囲に収める。収めた結果が空ならエラー。
fn clamp_to_virtual_screen(rect: Rect) -> Result<Rect, CaptureError> {
    let screen = virtual_screen_rect();
    let clamped = Rect {
        left: rect.left.max(screen.left),
        top: rect.top.max(screen.top),
        right: rect.right.min(screen.right),
        bottom: rect.bottom.min(screen.bottom),
    };
    if clamped.is_empty() {
        return Err(CaptureError("撮る範囲が画面の外です".to_string()));
    }
    Ok(clamped)
}

struct ScreenDc(HDC);
impl Drop for ScreenDc {
    fn drop(&mut self) {
        // SAFETY: GetDC(None) で得たもの。
        unsafe {
            ReleaseDC(None, self.0);
        }
    }
}

struct MemoryDc(HDC);
impl Drop for MemoryDc {
    fn drop(&mut self) {
        // SAFETY: CreateCompatibleDC で得たもの。
        unsafe {
            let _ = DeleteDC(self.0);
        }
    }
}

struct Bitmap(HBITMAP);
impl Drop for Bitmap {
    fn drop(&mut self) {
        // SAFETY: CreateCompatibleBitmap で得たもの。
        unsafe {
            let _ = DeleteObject(HGDIOBJ(self.0 .0));
        }
    }
}

/// 画面の長方形を写して PNG にする。
fn capture_region_png(rect: Rect) -> Result<Vec<u8>, CaptureError> {
    let rect = clamp_to_virtual_screen(rect)?;
    let (width, height) = (rect.width(), rect.height());
    if width > 16_384 || height > 16_384 {
        return Err(CaptureError(format!(
            "撮る範囲が大きすぎます（{width}x{height}）"
        )));
    }
    let mut bgra = vec![0u8; width as usize * height as usize * 4];

    // SAFETY: GDI の資源は上の Drop で必ず解放する。bgra は width*height*4 バイトで確保済み。
    unsafe {
        let screen = ScreenDc(GetDC(None));
        if screen.0.is_invalid() {
            return Err(CaptureError("画面の描画先を取得できません".to_string()));
        }
        let memory = MemoryDc(CreateCompatibleDC(Some(screen.0)));
        if memory.0.is_invalid() {
            return Err(CaptureError("作業用の描画先を作れません".to_string()));
        }
        let bitmap = Bitmap(CreateCompatibleBitmap(screen.0, width, height));
        if bitmap.0.is_invalid() {
            return Err(CaptureError("作業用の画像を作れません".to_string()));
        }
        let previous = SelectObject(memory.0, HGDIOBJ(bitmap.0 .0));
        let blit = BitBlt(
            memory.0,
            0,
            0,
            width,
            height,
            Some(screen.0),
            rect.left,
            rect.top,
            SRCCOPY | CAPTUREBLT,
        );
        if blit.is_err() {
            SelectObject(memory.0, previous);
            return Err(CaptureError("画面を写せませんでした".to_string()));
        }
        let mut info = BITMAPINFO {
            bmiHeader: BITMAPINFOHEADER {
                biSize: size_of::<BITMAPINFOHEADER>() as u32,
                biWidth: width,
                // 負の高さ = 上の行から順に並ぶ。
                biHeight: -height,
                biPlanes: 1,
                biBitCount: 32,
                biCompression: 0, // BI_RGB
                ..Default::default()
            },
            ..Default::default()
        };
        let lines = GetDIBits(
            memory.0,
            bitmap.0,
            0,
            height as u32,
            Some(bgra.as_mut_ptr().cast()),
            &mut info,
            DIB_RGB_COLORS,
        );
        SelectObject(memory.0, previous);
        if lines == 0 {
            return Err(CaptureError("写した画像を取り出せませんでした".to_string()));
        }
    }

    encode_png_rgb(width as u32, height as u32, &bgra_to_rgb(&bgra))
}
