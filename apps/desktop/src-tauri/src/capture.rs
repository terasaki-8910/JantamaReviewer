//! スクリーンショット（OS に依存しない部分）。
//!
//! 対局中にやるのは「保存するだけ」。画面の中身は読まない（SPEC 2章、S-3）。
//! - どの窓を撮るかを決める純粋な関数 `select_window`（W-7）
//! - 撮る処理の差し替え口 `Capturer`（W-1 のテストでは偽物を入れる）
//! - OS ごとの部分（窓の一覧・画面の長方形を写す・カーソルのある画面）の口 `ScreenSource` と、それを使う `ScreenCapturer`
//! - PNG への書き出し（エンコードのみ）
//!
//! 実際に窓の一覧を取り、画面を撮る処理は OS ごとの `ScreenSource`（Windows は `platform/win/capture.rs`）。
//! 窓を選び、窓が撮れなければ画面に切り替える手順は、どの OS も同じ `ScreenCapturer`。

use std::fmt;

use serde::{Deserialize, Serialize};

/// 画面上の長方形（物理ピクセル。画面全体の座標）。
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub struct Rect {
    pub left: i32,
    pub top: i32,
    pub right: i32,
    pub bottom: i32,
}

impl Rect {
    pub fn width(&self) -> i32 {
        self.right - self.left
    }

    pub fn height(&self) -> i32 {
        self.bottom - self.top
    }

    /// 幅か高さが 0 以下なら、撮れない。
    pub fn is_empty(&self) -> bool {
        self.width() <= 0 || self.height() <= 0
    }
}

/// 窓の一覧の 1 件。窓を選ぶのに必要な情報だけを持つ。
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct WindowInfo {
    pub title: String,
    /// 前面の窓か。
    pub foreground: bool,
    /// 見えているか（表示されていて、隠されていない）。
    pub visible: bool,
    /// 最小化されているか。
    pub minimized: bool,
    pub rect: Rect,
}

/// 何を撮ったか。記録に残す。
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum CaptureTarget {
    /// 雀魂の窓。
    Window,
    /// 全画面（雀魂の窓が見つからなかったとき）。
    Screen,
}

/// 撮った画像（PNG のバイト列）と、何を撮ったか。
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct Screenshot {
    pub png: Vec<u8>,
    pub target: CaptureTarget,
}

/// 撮れなかった理由。
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct CaptureError(pub String);

impl fmt::Display for CaptureError {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        f.write_str(&self.0)
    }
}

impl std::error::Error for CaptureError {}

/// スクリーンショットの取得元。実機ではその OS の画面を撮り、テストでは偽物を入れる（W-1）。
pub trait Capturer: Send + Sync {
    /// `keywords` を題名に含む窓を撮る。見つからなければ全画面を撮る。
    fn capture(&self, keywords: &[String]) -> Result<Screenshot, CaptureError>;
}

/// 画面と窓の一覧の取得元。OS ごとに実装する。ここでやるのは、窓の題名と位置を調べることと、画面の一部を写すことだけ
/// （ほかのプロセスの中身には触れない。S-1。写した画像は保存するだけで、中身の解析はしない。S-3）。
pub trait ScreenSource: Send + Sync {
    /// 題名のある最上位の窓を、手前の窓から順に並べて返す。このアプリ自身の窓は含めない。
    fn windows(&self) -> Vec<WindowInfo>;
    /// 画面の長方形（物理ピクセル。画面全体の座標）を写して PNG にする。
    fn capture_rect(&self, rect: Rect) -> Result<Vec<u8>, CaptureError>;
    /// マウスカーソルがある画面全体の長方形。雀魂の窓が見つからないときに撮る範囲
    /// （ボタンを押した場所 = 対局している画面を撮るため）。
    fn cursor_screen(&self) -> Rect;
}

/// `ScreenSource` から `Capturer` を作る。雀魂の窓を選んで撮り（W-7）、窓が見つからない・写せないときは、
/// 記録を欠かさないよう、カーソルのある画面全体を撮る。
#[derive(Debug, Default, Clone, Copy)]
pub struct ScreenCapturer<S>(pub S);

impl<S: ScreenSource> Capturer for ScreenCapturer<S> {
    fn capture(&self, keywords: &[String]) -> Result<Screenshot, CaptureError> {
        let windows = self.0.windows();
        if let Some(window) = select_window(&windows, keywords) {
            if let Ok(png) = self.0.capture_rect(window.rect) {
                return Ok(Screenshot {
                    png,
                    target: CaptureTarget::Window,
                });
            }
            // 窓を写せなかったときは、記録を欠かさないよう全画面に切り替える。
        }
        let png = self.0.capture_rect(self.0.cursor_screen())?;
        Ok(Screenshot {
            png,
            target: CaptureTarget::Screen,
        })
    }
}

/// 雀魂の窓を選ぶ（W-7）。
///
/// 題名に語（大文字小文字は区別しない）を含む窓のうち、
/// 1. 前面の窓があればそれ、
/// 2. なければ、見えていて最小化されていない最初の窓（一覧は手前の窓から順に並ぶ）
///
/// を選ぶ。どちらも無ければ `None`（全画面を撮る）。
/// 空の語は無視する（空の語はどの題名にも含まれてしまうため）。大きさの無い窓も選ばない。
pub fn select_window<'a>(windows: &'a [WindowInfo], keywords: &[String]) -> Option<&'a WindowInfo> {
    let words: Vec<String> = keywords
        .iter()
        .map(|w| w.trim().to_lowercase())
        .filter(|w| !w.is_empty())
        .collect();
    if words.is_empty() {
        return None;
    }
    let candidates: Vec<&WindowInfo> = windows
        .iter()
        .filter(|w| {
            w.visible && !w.minimized && !w.rect.is_empty() && {
                let title = w.title.to_lowercase();
                words.iter().any(|word| title.contains(word))
            }
        })
        .collect();
    candidates
        .iter()
        .find(|w| w.foreground)
        .or_else(|| candidates.first())
        .copied()
}

/// 24bit の RGB を PNG に書き出す。速さを優先して軽い圧縮にする（迷いマークの記録を遅らせないため）。
pub fn encode_png_rgb(width: u32, height: u32, rgb: &[u8]) -> Result<Vec<u8>, CaptureError> {
    let expected = width as usize * height as usize * 3;
    if width == 0 || height == 0 || rgb.len() != expected {
        return Err(CaptureError(format!(
            "画像の大きさと画素数が合いません（{width}x{height}、{} バイト）",
            rgb.len()
        )));
    }
    let mut out = Vec::with_capacity(expected / 4);
    {
        let mut encoder = png::Encoder::new(&mut out, width, height);
        encoder.set_color(png::ColorType::Rgb);
        encoder.set_depth(png::BitDepth::Eight);
        encoder.set_compression(png::Compression::Fast);
        let mut writer = encoder
            .write_header()
            .map_err(|e| CaptureError(format!("PNG のヘッダを書けません: {e}")))?;
        writer
            .write_image_data(rgb)
            .map_err(|e| CaptureError(format!("PNG を書き出せません: {e}")))?;
    }
    Ok(out)
}

/// Windows の画面取得が返す BGRA（1 画素 4 バイト）を RGB（3 バイト）にする。
pub fn bgra_to_rgb(bgra: &[u8]) -> Vec<u8> {
    let mut rgb = Vec::with_capacity(bgra.len() / 4 * 3);
    for px in bgra.chunks_exact(4) {
        rgb.push(px[2]);
        rgb.push(px[1]);
        rgb.push(px[0]);
    }
    rgb
}

#[cfg(test)]
mod tests {
    use super::*;

    fn rect(w: i32, h: i32) -> Rect {
        Rect {
            left: 0,
            top: 0,
            right: w,
            bottom: h,
        }
    }

    fn win(title: &str, foreground: bool, visible: bool, minimized: bool) -> WindowInfo {
        WindowInfo {
            title: title.to_string(),
            foreground,
            visible,
            minimized,
            rect: rect(1280, 720),
        }
    }

    fn kw(words: &[&str]) -> Vec<String> {
        words.iter().map(|s| s.to_string()).collect()
    }

    fn default_kw() -> Vec<String> {
        kw(&["雀魂", "Mahjong Soul"])
    }

    #[test]
    fn w7_picks_the_window_whose_title_contains_a_keyword() {
        let windows = vec![
            win("メモ帳", false, true, false),
            win("雀魂 -じゃんたま- - Google Chrome", false, true, false),
        ];
        let picked = select_window(&windows, &default_kw()).unwrap();
        assert_eq!(picked.title, "雀魂 -じゃんたま- - Google Chrome");
    }

    #[test]
    fn w7_matches_the_english_keyword_ignoring_case() {
        let windows = vec![win("mahjong soul", false, true, false)];
        assert!(select_window(&windows, &default_kw()).is_some());
    }

    #[test]
    fn w7_prefers_the_foreground_window_over_an_earlier_one() {
        let windows = vec![
            win("雀魂 (後ろ)", false, true, false),
            win("雀魂 (前面)", true, true, false),
        ];
        assert_eq!(
            select_window(&windows, &default_kw()).unwrap().title,
            "雀魂 (前面)"
        );
    }

    #[test]
    fn w7_without_a_foreground_match_takes_the_first_visible_one() {
        let windows = vec![
            win("雀魂 (最小化)", false, true, true),
            win("雀魂 (見えない)", false, false, false),
            win("雀魂 (見える1)", false, true, false),
            win("雀魂 (見える2)", false, true, false),
        ];
        assert_eq!(
            select_window(&windows, &default_kw()).unwrap().title,
            "雀魂 (見える1)"
        );
    }

    #[test]
    fn w7_skips_minimized_and_hidden_windows_even_if_they_match() {
        let windows = vec![
            win("雀魂 (最小化)", false, true, true),
            win("雀魂 (見えない)", false, false, false),
        ];
        assert_eq!(select_window(&windows, &default_kw()), None);
    }

    #[test]
    fn w7_returns_none_when_nothing_matches_so_the_full_screen_is_captured() {
        let windows = vec![
            win("メモ帳", true, true, false),
            win("Explorer", false, true, false),
        ];
        assert_eq!(select_window(&windows, &default_kw()), None);
        assert_eq!(select_window(&[], &default_kw()), None);
    }

    #[test]
    fn w7_empty_keywords_never_match() {
        let windows = vec![win("メモ帳", true, true, false)];
        assert_eq!(select_window(&windows, &[]), None);
        assert_eq!(select_window(&windows, &kw(&["", "   "])), None);
    }

    #[test]
    fn w7_a_foreground_window_that_does_not_match_is_ignored() {
        let windows = vec![
            win("メモ帳", true, true, false),
            win("雀魂", false, true, false),
        ];
        assert_eq!(
            select_window(&windows, &default_kw()).unwrap().title,
            "雀魂"
        );
    }

    #[test]
    fn w7_windows_without_an_area_are_not_chosen() {
        let mut empty = win("雀魂", true, true, false);
        empty.rect = rect(0, 0);
        assert_eq!(select_window(&[empty], &default_kw()), None);
    }

    #[test]
    fn w7_custom_keywords_are_honoured() {
        let windows = vec![win("My Game", false, true, false)];
        assert!(select_window(&windows, &kw(&["my game"])).is_some());
        assert!(select_window(&windows, &default_kw()).is_none());
    }

    /// 窓の一覧と、写せる長方形を決めておく偽物。写した長方形を覚える。
    struct FakeScreen {
        windows: Vec<WindowInfo>,
        /// 写せない長方形（窓の長方形を入れると、窓を写せなかった場面になる）。
        refuse: Option<Rect>,
        asked: std::sync::Mutex<Vec<Rect>>,
    }

    const SCREEN_RECT: Rect = Rect {
        left: 0,
        top: 0,
        right: 2560,
        bottom: 1440,
    };

    impl FakeScreen {
        fn new(windows: Vec<WindowInfo>, refuse: Option<Rect>) -> FakeScreen {
            FakeScreen {
                windows,
                refuse,
                asked: std::sync::Mutex::new(Vec::new()),
            }
        }
    }

    impl ScreenSource for FakeScreen {
        fn windows(&self) -> Vec<WindowInfo> {
            self.windows.clone()
        }

        fn capture_rect(&self, rect: Rect) -> Result<Vec<u8>, CaptureError> {
            self.asked.lock().unwrap().push(rect);
            if self.refuse == Some(rect) {
                return Err(CaptureError("写せません".to_string()));
            }
            Ok(vec![rect.width() as u8])
        }

        fn cursor_screen(&self) -> Rect {
            SCREEN_RECT
        }
    }

    #[test]
    fn w7_the_selected_window_is_captured_by_its_own_rectangle() {
        let capturer = ScreenCapturer(FakeScreen::new(
            vec![
                win("メモ帳", false, true, false),
                win("雀魂", true, true, false),
            ],
            None,
        ));
        let shot = capturer.capture(&default_kw()).unwrap();
        assert_eq!(shot.target, CaptureTarget::Window);
        assert_eq!(*capturer.0.asked.lock().unwrap(), vec![rect(1280, 720)]);
    }

    #[test]
    fn w7_without_a_matching_window_the_screen_under_the_cursor_is_captured() {
        let capturer = ScreenCapturer(FakeScreen::new(
            vec![win("メモ帳", true, true, false)],
            None,
        ));
        let shot = capturer.capture(&default_kw()).unwrap();
        assert_eq!(shot.target, CaptureTarget::Screen);
        assert_eq!(*capturer.0.asked.lock().unwrap(), vec![SCREEN_RECT]);
    }

    #[test]
    fn w7_a_window_that_cannot_be_captured_falls_back_to_the_screen() {
        let capturer = ScreenCapturer(FakeScreen::new(
            vec![win("雀魂", true, true, false)],
            Some(rect(1280, 720)),
        ));
        let shot = capturer.capture(&default_kw()).unwrap();
        assert_eq!(shot.target, CaptureTarget::Screen);
        assert_eq!(
            *capturer.0.asked.lock().unwrap(),
            vec![rect(1280, 720), SCREEN_RECT]
        );
    }

    #[test]
    fn w7_when_even_the_screen_cannot_be_captured_the_reason_is_returned() {
        let capturer = ScreenCapturer(FakeScreen::new(Vec::new(), Some(SCREEN_RECT)));
        let error = capturer.capture(&default_kw()).unwrap_err();
        assert_eq!(error.0, "写せません");
    }

    #[test]
    fn bgra_is_converted_to_rgb() {
        let bgra = [10u8, 20, 30, 255, 1, 2, 3, 0];
        assert_eq!(bgra_to_rgb(&bgra), vec![30, 20, 10, 3, 2, 1]);
    }

    #[test]
    fn png_encoding_produces_a_decodable_image_of_the_same_size() {
        let (w, h) = (4u32, 3u32);
        let rgb: Vec<u8> = (0..w * h * 3).map(|i| (i % 251) as u8).collect();
        let bytes = encode_png_rgb(w, h, &rgb).unwrap();
        assert_eq!(
            &bytes[..8],
            &[0x89, b'P', b'N', b'G', 0x0D, 0x0A, 0x1A, 0x0A]
        );
        let decoder = png::Decoder::new(std::io::Cursor::new(bytes));
        let mut reader = decoder.read_info().unwrap();
        let mut buf = vec![0; reader.output_buffer_size().unwrap()];
        let info = reader.next_frame(&mut buf).unwrap();
        assert_eq!((info.width, info.height), (w, h));
        assert_eq!(&buf[..rgb.len()], &rgb[..]);
    }

    #[test]
    fn png_encoding_rejects_a_wrong_pixel_count() {
        assert!(encode_png_rgb(2, 2, &[0; 5]).is_err());
        assert!(encode_png_rgb(0, 2, &[]).is_err());
    }
}
