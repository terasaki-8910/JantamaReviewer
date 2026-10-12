//! 窓の一覧と、押した瞬間の 1 枚の撮影の雛形。型検査だけ通した。実機では動かしていない。
//!
//! Windows の `src/capture_win.rs`（EnumWindows + BitBlt）の置き換えにあたる。
//! - 窓の一覧: `CGWindowListCopyWindowInfo`（手前から順。題名 `kCGWindowName` は「画面収録」の許可が無いと空）。
//! - 撮影: `SCScreenshotManager` の 1 枚だけ（`captureImageInRect`＝画面の長方形を写す。Windows の BitBlt と同じ考え方。使える版は macOS 15.2 以降のはずだが未確認）。
//!   `SCStream`（続けて撮る仕組み）は使わない（対局中に画面を読み続けないため。SPEC 2章、S-3）。

use std::ffi::c_void;
use std::sync::mpsc;
use std::time::Duration;

use core_foundation::array::CFArray;
use core_foundation::base::{CFType, TCFType};
use core_foundation::dictionary::{CFDictionary, CFDictionaryRef};
use core_foundation::number::CFNumber;
use core_foundation::string::CFString;
use core_graphics::access::ScreenCaptureAccess;
use core_graphics::window::{
    copy_window_info, kCGNullWindowID, kCGWindowBounds, kCGWindowLayer,
    kCGWindowListExcludeDesktopElements, kCGWindowListOptionOnScreenOnly, kCGWindowName,
    kCGWindowOwnerPID,
};

use std::ptr::NonNull;

use block2::RcBlock;
use objc2_core_foundation::{CFRetained, CGPoint, CGRect, CGSize};
use objc2_core_graphics::{CGDataProvider, CGImage};
use objc2_foundation::NSError;
use objc2_screen_capture_kit::SCScreenshotManager;

/// 窓の一覧の 1 件。`capture::WindowInfo` にあたる（手前の窓から順に並ぶ）。
#[derive(Debug, Clone, PartialEq)]
pub struct WinInfo {
    pub title: String,
    pub owner_pid: i64,
    /// 0 が普通の窓。メニューバーやドックなどは 0 以外。
    pub layer: i64,
    /// 画面の座標（ポイント。左上が原点）。
    pub bounds: (f64, f64, f64, f64),
}

/// 「画面収録」の許可があるか（ダイアログは出さない）。
pub fn screen_capture_granted() -> bool {
    ScreenCaptureAccess.preflight()
}

fn number_of(dict: &CFDictionary<CFString, CFType>, key: &CFString) -> Option<f64> {
    dict.find(key)?.downcast::<CFNumber>()?.to_f64()
}

/// 画面に出ている窓を、手前から順に返す。題名の無い窓も含む（許可が無いと、他のアプリの題名は空になる）。
pub fn list_windows(own_pid: i64) -> Vec<WinInfo> {
    let options = kCGWindowListOptionOnScreenOnly | kCGWindowListExcludeDesktopElements;
    let Some(array) = copy_window_info(options, kCGNullWindowID) else {
        return Vec::new();
    };
    let array: CFArray<*const c_void> = array;
    let mut out = Vec::new();
    for item in array.iter() {
        // SAFETY: 配列の中身は CFDictionary（CGWindowListCopyWindowInfo の決まり）。
        let dict: CFDictionary<CFString, CFType> =
            unsafe { CFDictionary::wrap_under_get_rule(*item as CFDictionaryRef) };
        // SAFETY: CoreGraphics の定数の読み出しだけ。
        let (k_name, k_pid, k_layer, k_bounds) = unsafe {
            (
                CFString::wrap_under_get_rule(kCGWindowName),
                CFString::wrap_under_get_rule(kCGWindowOwnerPID),
                CFString::wrap_under_get_rule(kCGWindowLayer),
                CFString::wrap_under_get_rule(kCGWindowBounds),
            )
        };
        let pid = number_of(&dict, &k_pid).unwrap_or(-1.0) as i64;
        if pid == own_pid {
            continue;
        }
        let title = dict
            .find(&k_name)
            .and_then(|v| v.downcast::<CFString>())
            .map(|s| s.to_string())
            .unwrap_or_default();
        let layer = number_of(&dict, &k_layer).unwrap_or(0.0) as i64;
        let bounds = dict
            .find(&k_bounds)
            .and_then(|v| v.downcast::<CFDictionary>())
            .map(|b| {
                // SAFETY: 長方形の辞書の値は CFNumber。
                let d: CFDictionary<CFString, CFType> =
                    unsafe { CFDictionary::wrap_under_get_rule(b.as_concrete_TypeRef()) };
                let get = |name: &str| number_of(&d, &CFString::new(name)).unwrap_or(0.0);
                (get("X"), get("Y"), get("Width"), get("Height"))
            })
            .unwrap_or_default();
        out.push(WinInfo {
            title,
            owner_pid: pid,
            layer,
            bounds,
        });
    }
    out
}

/// 画面の長方形（ポイント）を 1 枚だけ撮る。使える版は macOS 15.2 以降のはず（未確認）。完了を待つので、画面のスレッドでは呼ばない。
pub fn capture_rect(rect: (f64, f64, f64, f64)) -> Result<CFRetained<CGImage>, String> {
    let (tx, rx) = mpsc::channel::<Result<CFRetained<CGImage>, String>>();
    let block = RcBlock::new(move |image: *mut CGImage, error: *mut NSError| {
        // SAFETY: 完了の知らせの間だけ有効な引数。image は null でなければ保持して持ち出す（CF の保持）。
        let result = unsafe {
            match NonNull::new(image) {
                Some(image) => Ok(CFRetained::retain(image)),
                None => Err(error
                    .as_ref()
                    .map(|e| e.localizedDescription().to_string())
                    .unwrap_or_else(|| "撮れませんでした".to_string())),
            }
        };
        let _ = tx.send(result);
    });
    let rect = CGRect::new(CGPoint::new(rect.0, rect.1), CGSize::new(rect.2, rect.3));
    // SAFETY: 引数は有効な長方形と、上で作ったブロック。
    unsafe { SCScreenshotManager::captureImageInRect_completionHandler(rect, Some(&block)) };
    rx.recv_timeout(Duration::from_secs(3))
        .map_err(|_| "撮影の返事が来ませんでした".to_string())?
}

/// 撮った画像の画素。行の余白（`bytes_per_row` のうち幅に足りない分）を詰めた BGRA（1 画素 4 バイト）と、大きさ（画素）。
/// ScreenCaptureKit が返す画像は、BGRA の 8 ビット（`captureImage` の説明による）。そのまま既存の
/// `capture::bgra_to_rgb` → `encode_png_rgb` に渡せる。
pub fn bgra_pixels(image: &CGImage) -> Result<(usize, usize, Vec<u8>), String> {
    let width = CGImage::width(Some(image));
    let height = CGImage::height(Some(image));
    let stride = CGImage::bytes_per_row(Some(image));
    if CGImage::bits_per_pixel(Some(image)) != 32 {
        return Err(format!(
            "想定外の画素の形です（{} ビット）",
            CGImage::bits_per_pixel(Some(image))
        ));
    }
    let provider = CGImage::data_provider(Some(image)).ok_or("画素の入れ物がありません")?;
    let data = CGDataProvider::data(Some(&provider)).ok_or("画素を取り出せません")?;
    // SAFETY: data はこの関数の間だけ使い、変更しない。
    let bytes = unsafe { data.as_bytes_unchecked() };
    if bytes.len() < stride * height {
        return Err("画素の数が足りません".to_string());
    }
    let mut out = Vec::with_capacity(width * height * 4);
    for row in bytes.chunks(stride).take(height) {
        out.extend_from_slice(&row[..width * 4]);
    }
    Ok((width, height, out))
}
