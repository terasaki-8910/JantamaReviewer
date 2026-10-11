//! ブラウザ（Chrome など）で雀魂を開いたときの画面の、作り物の画像（E-32）。
//!
//! ブラウザで開くと、画像に、上のタブとアドレスバーの帯（およそ 80〜130 画素）と、左右・上下の余白の帯が入り、ゲームの絵は
//! 画像の一部になる（板は画像の中央ではなく、画像に対して小さくなる）。FX-6 の画像（画面の中央だけを残したもの）を縮めて、
//! その帯と余白の中に置いて作る。

use jantama_ocr::resample::resize;

use super::{fill_rect, flat, Bgra};

/// ブラウザの窓の作り物の形。
#[derive(Debug, Clone, Copy)]
pub struct BrowserFrame {
    pub name: &'static str,
    /// 画像（ウィンドウの中身）の大きさ。
    pub canvas: (u32, u32),
    /// 上のタブとアドレスバーの帯の高さ（画素）。
    pub top_band: u32,
    /// ゲームの絵の大きさを、帯の下の空きに収まる最大の大きさの何割にするか（千分率。1000 なら、いっぱいに収める。
    /// それより小さいと、上下左右に余白ができる）。
    pub fit_permille: u32,
    /// 余白（ゲームの絵のまわり）の色（B, G, R）。
    pub margin: [u8; 3],
    /// タブの帯・アドレスバーの帯の色（B, G, R）。
    pub tab_strip: [u8; 3],
    pub address_bar: [u8; 3],
    /// 文字認識で読めるだけの大きさで板が写っているか（板の高さが 25 画素ほど以上）。false の窓は、板は見つかるが、字が小さすぎて、
    /// Windows の文字認識では読めない（読めなければ、カードは「読めませんでした」になり、ユーザーが手で選ぶ）。
    pub ocr_readable: bool,
}

/// 置いたあとの、元の画像の位置と倍率。
#[derive(Debug, Clone, Copy)]
pub struct Placement {
    /// 元の画像の左上の位置（画面の画素）。
    pub x: i64,
    pub y: i64,
    /// 倍率（千分率）。
    pub factor_permille: u32,
}

impl Placement {
    /// 元の画像の座標を、置いたあとの画面の座標にする。
    pub fn map(&self, x: i64, y: i64) -> (i64, i64) {
        let f = f64::from(self.factor_permille) / 1000.0;
        (
            self.x + (x as f64 * f).round() as i64,
            self.y + (y as f64 * f).round() as i64,
        )
    }
}

/// `source`（FX-6 の画面）を、ブラウザの窓の中に置いた画像を作る。
/// 帯の下の空きに、縦横の比を保って収まる大きさ（`fit_permille` 割）にして、空きの真ん中に置く。
/// 帯には、おとりの水色（タブの小さな絵の四角と、読み込み中の細い線）を描く。
pub fn browser_frame(source: &Bgra, frame: &BrowserFrame) -> (Bgra, Placement) {
    let (cw, ch) = frame.canvas;
    let (avail_w, avail_h) = (u64::from(cw), u64::from(ch - frame.top_band));
    // 縦横どちらかがいっぱいになる倍率（千分率）。
    let fit =
        (avail_w * 1000 / u64::from(source.width)).min(avail_h * 1000 / u64::from(source.height));
    let factor = (fit * u64::from(frame.fit_permille) / 1000) as u32;
    let sw = (u64::from(source.width) * u64::from(factor) / 1000).max(1) as u32;
    let sh = (u64::from(source.height) * u64::from(factor) / 1000).max(1) as u32;
    let scaled = resize(&source.pixels, source.width, source.height, sw, sh);
    let mut canvas = flat(cw, ch, frame.margin);
    let ox = (i64::from(cw) - i64::from(sw)) / 2;
    let oy = i64::from(frame.top_band) + (avail_h as i64 - i64::from(sh)) / 2;
    for y in 0..sh {
        let cy = i64::from(y) + oy;
        if cy < 0 || cy >= i64::from(ch) {
            continue;
        }
        for x in 0..sw {
            let cx = i64::from(x) + ox;
            if cx < 0 || cx >= i64::from(cw) {
                continue;
            }
            let from = ((y * sw + x) * 4) as usize;
            let to = ((cy as u32 * cw + cx as u32) * 4) as usize;
            canvas.pixels[to..to + 4].copy_from_slice(&scaled[from..from + 4]);
        }
    }
    // 上の帯: タブの帯（上半分）とアドレスバー（下半分）。
    let half = frame.top_band / 2;
    fill_rect(&mut canvas, 0, 0, cw, half, frame.tab_strip);
    fill_rect(
        &mut canvas,
        0,
        half,
        cw,
        frame.top_band - half,
        frame.address_bar,
    );
    // おとりの水色: タブの小さな絵（16×16）と、読み込み中の線（高さ 3・幅 300）。
    fill_rect(&mut canvas, 28, half / 2 - 8, 16, 16, [200, 190, 30]);
    fill_rect(
        &mut canvas,
        0,
        frame.top_band - 3,
        300.min(cw),
        3,
        [200, 190, 30],
    );
    (
        canvas,
        Placement {
            x: ox,
            y: oy,
            factor_permille: factor,
        },
    )
}

const fn frame(
    name: &'static str,
    canvas: (u32, u32),
    top_band: u32,
    fit_permille: u32,
    margin: u8,
    dark: bool,
    ocr_readable: bool,
) -> BrowserFrame {
    BrowserFrame {
        name,
        canvas,
        top_band,
        fit_permille,
        margin: [margin, margin, margin],
        tab_strip: if dark { [36, 33, 32] } else { [231, 225, 222] },
        address_bar: if dark { [53, 54, 58] } else { [255, 255, 255] },
        ocr_readable,
    }
}

/// ブラウザの窓の作り物の組（16:9・16:10・縦長・横長・ノート PC・4K・余白を足したもの。帯の色・余白の色もいろいろ）。
pub const BROWSER_FRAMES: [BrowserFrame; 8] = [
    frame(
        "16:9（明るい帯 120px）",
        (1920, 1080),
        120,
        1000,
        0,
        false,
        true,
    ),
    frame(
        "16:10（暗い帯 100px）",
        (1920, 1200),
        100,
        1000,
        40,
        true,
        true,
    ),
    frame(
        "縦長（900×1400、帯 130px）",
        (900, 1400),
        130,
        1000,
        0,
        false,
        true,
    ),
    frame(
        "横長（2560×1080、帯 80px）",
        (2560, 1080),
        80,
        1000,
        20,
        true,
        true,
    ),
    frame(
        "余白つき 16:9（1600×900、帯 110px、絵は 85%）",
        (1600, 900),
        110,
        850,
        235,
        false,
        true,
    ),
    frame(
        "ノート PC（1366×768、帯 90px）",
        (1366, 768),
        90,
        1000,
        60,
        false,
        true,
    ),
    frame(
        "細い縦長（700×1500、帯 130px、絵は 90%）",
        (700, 1500),
        130,
        900,
        12,
        true,
        false,
    ),
    frame(
        "4K（3840×2160、帯 130px、絵は 95%）",
        (3840, 2160),
        130,
        950,
        0,
        false,
        true,
    ),
];
