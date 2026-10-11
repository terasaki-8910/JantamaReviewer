//! E-32 の、板の文字の位置の探し方の試験（どの OS でも動く。文字認識は使わない）。
//!
//! FX-6 の 19 枚（画面の中央だけを残した迷いマーク）で、局と残り枚数の水色の文字のまとまりを見つけ、切り出しの長方形に、局・残り枚数・
//! 自分の点数だけが入ること（左右の縦書きの点数・上の逆さの点数は入らない）。窓の大きさを変えた作り物の画面（FX-6 の画像を
//! 拡大・縮小して置いたもの）でも、同じまとまりを見つけること。板の文字らしくない水色（結果の画面の表の線・大きな水色の面・
//! 点だけ）は、まとまりとして選ばないこと。

mod common;

use common::browser::{browser_frame, BROWSER_FRAMES};
use common::{fill_rect, flat, load_png_bgra, scaled_onto_canvas, Bgra, FX6};
use jantama_ocr::locate::{locate_block, locate_panel, panel_crop, Block};
use jantama_ocr::CropRect;

/// 水色（B, G, R）。局・余の文字の色に近い。
const CYAN: [u8; 3] = [200, 190, 30];
/// FX-6 の塗りつぶしの色（B, G, R。`make_fx6.py` の FLAT）。
const FLAT_BGR: [u8; 3] = [32, 32, 32];

/// 手元の画面で、水色の文字のまとまりの外接の箱（左, 上, 右, 下。Python の試作で求めた値）。FX-5 は 1368×800、FX-4 は 1447×935。
fn known_block(width: u32) -> (i64, i64, i64, i64) {
    match width {
        1368 => (656, 310, 712, 353),
        1447 => (694, 376, 753, 422),
        other => panic!("想定外の幅: {other}"),
    }
}

fn near(actual: i64, expected: i64, tolerance: i64) -> bool {
    (actual - expected).abs() <= tolerance
}

fn block_box(block: &Block) -> (i64, i64, i64, i64) {
    (
        i64::from(block.x0),
        i64::from(block.y0),
        i64::from(block.x1),
        i64::from(block.y1),
    )
}

/// 橙の画素（点数の字）か。HSV で 0.04 < h < 0.15・s > 0.45・v > 0.6。
fn is_orange(b: u8, g: u8, r: u8) -> bool {
    let (rf, gf, bf) = (
        f32::from(r) / 255.0,
        f32::from(g) / 255.0,
        f32::from(b) / 255.0,
    );
    let max = rf.max(gf).max(bf);
    let min = rf.min(gf).min(bf);
    let delta = max - min;
    if max <= 0.6 || delta <= 0.0 || delta / max <= 0.45 || max != rf {
        return false;
    }
    let hue = (((gf - bf) / delta).rem_euclid(6.0)) / 6.0;
    hue > 0.04 && hue < 0.15
}

#[test]
fn e32_every_fx6_image_has_its_panel_text_found_at_the_known_place() {
    for case in &FX6 {
        let screen = load_png_bgra(&case.path());
        assert_eq!((screen.width, screen.height), (case.width, case.height));
        let block = locate_block(&screen.pixels, screen.width, screen.height)
            .unwrap_or_else(|| panic!("{}: 板の文字が見つからない", case.file));
        let (x0, y0, x1, y1) = known_block(case.width);
        let actual = block_box(&block);
        assert!(
            near(actual.0, x0, 1)
                && near(actual.1, y0, 1)
                && near(actual.2, x1, 2)
                && near(actual.3, y1, 1),
            "{}: 見つけた箱 {actual:?} が、手元の値 {:?} と違う",
            case.file,
            (x0, y0, x1, y1)
        );
    }
}

#[test]
fn e32_the_extra_cyan_above_the_panel_in_fx5_mark_3_does_not_stretch_the_block() {
    // 15:38:10 の画面には、板の上（高さの 6.6% 上）に、小さな水色の点がある。外接の箱をそのまま使うと、板の文字のまとまりが縦に伸びる。
    let screen = load_png_bgra(&FX6[2].path());
    let block = locate_block(&screen.pixels, screen.width, screen.height).unwrap();
    assert!(block.y0 >= 309, "上に伸びていない: {block:?}");
    assert!(block.height() <= 45, "縦に伸びていない: {block:?}");
}

#[test]
fn e32_the_cutout_holds_the_round_the_tiles_left_and_the_own_score_only() {
    for case in &FX6 {
        let screen = load_png_bgra(&case.path());
        let block = locate_block(&screen.pixels, screen.width, screen.height).unwrap();
        let crop = locate_panel(&screen.pixels, screen.width, screen.height).unwrap();
        let (bw, bh) = (block.width(), block.height());
        // 板の文字は、左右の縦書きの点数・上の逆さの点数より内側。切り出しは、文字の幅の 15% までしか横に広げない。
        assert!(
            crop.x + bw * 15 / 100 >= block.x0 && crop.x + crop.width <= block.x1 + bw * 15 / 100,
            "{}: 横に広い: {crop:?} / {block:?}",
            case.file
        );
        // 上は、文字の上端の少し上まで（上の逆さの点数は入らない。下の橙の画素の確かめが見る）。
        assert!(
            crop.y + bh * 4 / 10 >= block.y0 && crop.y <= block.y0,
            "{}: 上の端: {crop:?} / {block:?}",
            case.file
        );
        // 下は、自分の点数の字（文字の下端から高さの 0.33〜0.65 倍）まで入る。
        assert!(
            crop.y + crop.height >= block.y1 + bh * 7 / 10,
            "{}: 点数が入らない: {crop:?} / {block:?}",
            case.file
        );
        // 橙の画素（点数の字）は、切り出しの中では、自分の点数の行にしかない（上の逆さの点数・左右の点数・下の黄色い帯は入らない）。
        let mut orange = 0u32;
        for y in crop.y..crop.y + crop.height {
            for x in crop.x..crop.x + crop.width {
                let i = ((y * screen.width + x) * 4) as usize;
                let [b, g, r] = [screen.pixels[i], screen.pixels[i + 1], screen.pixels[i + 2]];
                if is_orange(b, g, r) {
                    orange += 1;
                    assert!(
                        y >= block.y1 + bh * 3 / 10 && y <= block.y1 + bh * 7 / 10,
                        "{}: 点数の行の外に橙がある（{x}, {y}）: {block:?}",
                        case.file
                    );
                }
            }
        }
        assert!(
            orange > 100,
            "{}: 点数の字が入っている: {orange}",
            case.file
        );
    }
}

#[test]
fn e32_the_cutout_is_the_same_whatever_the_window_size() {
    // 窓の大きさ・縦横の比が変わった画面を、FX-6 の画像を拡大・縮小して置いて作る（雀魂は 16:9 に収めて表示するので、
    // 16:9 より横に長い窓は高さに、縦に長い窓は幅に、板の大きさが合う）。見つける箱は、拡大・縮小した元の箱と同じ所。
    let sizes: [(u32, u32); 7] = [
        (1280, 720),
        (1600, 900),
        (1920, 1080),
        (2560, 1080),
        (1368, 800),
        (1447, 935),
        (1280, 1024),
    ];
    for case in [&FX6[0], &FX6[3], &FX6[7], &FX6[13], &FX6[18]] {
        let source = load_png_bgra(&case.path());
        let (x0, y0, x1, y1) = known_block(case.width);
        for (cw, ch) in sizes {
            // 16:9 より横に長ければ高さに、縦に長ければ幅に合わせる。
            let factor = if u64::from(cw) * 9 >= u64::from(ch) * 16 {
                u64::from(ch) * 1000 / u64::from(case.height)
            } else {
                u64::from(cw) * 1000 / u64::from(case.width)
            } as u32;
            let (screen, (ox, oy)) = scaled_onto_canvas(&source, factor, cw, ch, FLAT_BGR);
            let block = locate_block(&screen.pixels, cw, ch)
                .unwrap_or_else(|| panic!("{} を {cw}×{ch}: 板の文字が見つからない", case.file));
            let f = f64::from(factor) / 1000.0;
            let expect = |v: i64, origin: i64| origin + (v as f64 * f).round() as i64;
            let tolerance = 2 + (f * 1.0) as i64;
            let actual = block_box(&block);
            assert!(
                near(actual.0, expect(x0, ox), tolerance)
                    && near(actual.1, expect(y0, oy), tolerance)
                    && near(actual.2, expect(x1, ox), tolerance)
                    && near(actual.3, expect(y1, oy), tolerance),
                "{} を {cw}×{ch}（{f:.3} 倍）: 見つけた箱 {actual:?} が、期待 {:?} と違う",
                case.file,
                (
                    expect(x0, ox),
                    expect(y0, oy),
                    expect(x1, ox),
                    expect(y1, oy)
                )
            );
            // 切り出しの高さは、文字の高さの約 2 倍（上の余白 0.3 + 文字 1 + 下の余白 0.72）。
            let crop = panel_crop(&block, cw, ch).unwrap();
            let ratio = f64::from(crop.height) / f64::from(block.height());
            assert!((1.95..=2.05).contains(&ratio), "{cw}×{ch}: {ratio}");
        }
    }
}

#[test]
fn e32_the_panel_is_found_in_a_browser_window_with_tabs_an_address_bar_and_margins() {
    // 雀魂をブラウザ（Chrome など）で開いたときの画面: 上にタブとアドレスバーの帯（80〜130px）、まわりに余白の帯。
    // FX-6 の中央を縮めて、帯と余白の中に置く（16:9・16:10・縦長・横長・ノート PC・4K・余白つき。帯・余白の色もいろいろ）。
    // 帯にはおとりの水色（タブの小さな絵・読み込み中の線）もある。見つける箱は、縮めた元の箱と同じ所。
    for frame in &BROWSER_FRAMES {
        for case in [&FX6[0], &FX6[7], &FX6[13], &FX6[18]] {
            let source = load_png_bgra(&case.path());
            let (screen, placement) = browser_frame(&source, frame);
            let (cw, ch) = frame.canvas;
            let block = locate_block(&screen.pixels, cw, ch).unwrap_or_else(|| {
                panic!("{} / {}: 板の文字が見つからない", frame.name, case.file)
            });
            let (x0, y0, x1, y1) = known_block(case.width);
            let (ex0, ey0) = placement.map(x0, y0);
            let (ex1, ey1) = placement.map(x1, y1);
            let tolerance = 2 + i64::from(placement.factor_permille) / 1000;
            let actual = block_box(&block);
            assert!(
                near(actual.0, ex0, tolerance)
                    && near(actual.1, ey0, tolerance)
                    && near(actual.2, ex1, tolerance)
                    && near(actual.3, ey1, tolerance),
                "{} / {}（{} 倍）: 見つけた箱 {actual:?} が、期待 {:?} と違う",
                frame.name,
                case.file,
                f64::from(placement.factor_permille) / 1000.0,
                (ex0, ey0, ex1, ey1)
            );
            // 切り出しは、板の文字の高さの約 2 倍で、画像の中に収まる。
            let crop = panel_crop(&block, cw, ch).unwrap();
            assert!(crop.x + crop.width <= cw && crop.y + crop.height <= ch);
            let ratio = f64::from(crop.height) / f64::from(block.height());
            assert!((1.9..=2.05).contains(&ratio), "{}: {ratio}", frame.name);
        }
    }
}

#[test]
fn e32_a_browser_window_without_the_game_picture_gives_no_block() {
    // ゲームの絵が無い（ブラウザの帯とおとりだけ）画面では、見つからない（今の箱で読む）。
    for frame in &BROWSER_FRAMES {
        let (cw, ch) = frame.canvas;
        let empty = common::Bgra {
            pixels: flat(cw, ch, frame.margin).pixels,
            width: cw,
            height: ch,
        };
        // 余白だけの「ゲームの絵」を置いた画面を作る（FX-6 の代わりに、一色の画像）。
        let blank = flat(1368, 800, FLAT_BGR);
        let (screen, _) = browser_frame(&blank, frame);
        assert_eq!(locate_block(&screen.pixels, cw, ch), None, "{}", frame.name);
        assert_eq!(locate_block(&empty.pixels, cw, ch), None, "{}", frame.name);
    }
}

/// 窓の大きさを変えた画面（1920×1080。FX-5 の 15:37:02 の画像を 1.35 倍にして置いたもの）。まわりの塗りつぶしに、おとりを描き足す。
fn decoy_base() -> (Bgra, CropRect) {
    let source = load_png_bgra(&FX6[0].path());
    let (screen, _) = scaled_onto_canvas(&source, 1350, 1920, 1080, FLAT_BGR);
    let panel = locate_panel(&screen.pixels, 1920, 1080).expect("おとりを足す前の画面で見つかる");
    (screen, panel)
}

/// 画像の一部（左上と大きさ）を、行を詰めた BGRA の並びで取り出す。
fn sub_image(screen: &Bgra, x: u32, y: u32, w: u32, h: u32) -> Vec<u8> {
    let mut out = Vec::with_capacity((w * h * 4) as usize);
    for row in y..y + h {
        let from = ((row * screen.width + x) * 4) as usize;
        out.extend_from_slice(&screen.pixels[from..from + (w * 4) as usize]);
    }
    out
}

#[test]
fn e32_a_smaller_panel_shaped_decoy_anywhere_in_the_image_does_not_win() {
    let (clean, panel) = decoy_base();
    let mut screen = Bgra {
        pixels: clean.pixels.clone(),
        width: clean.width,
        height: clean.height,
    };
    // 板と同じ形・同じ色で、水色の画素が少ないもの（半分の大きさの写し）を、画像の四隅に置く。板のまとまりのほうが選ばれる。
    let block = locate_block(&clean.pixels, 1920, 1080).unwrap();
    let (half_w, half_h) = (block.width() / 2, block.height() / 2);
    let small = jantama_ocr::resample::resize(
        &sub_image(&clean, block.x0, block.y0, block.width(), block.height()),
        block.width(),
        block.height(),
        half_w,
        half_h,
    );
    for (x, y) in [(40u32, 40u32), (1800, 40), (40, 1000), (1800, 1000)] {
        for row in 0..half_h {
            let to = (((y + row) * 1920 + x) * 4) as usize;
            let from = (row * half_w * 4) as usize;
            screen.pixels[to..to + (half_w * 4) as usize]
                .copy_from_slice(&small[from..from + (half_w * 4) as usize]);
        }
    }
    let found = locate_block(&screen.pixels, 1920, 1080).expect("板が見つかる");
    assert_eq!(
        (found.x0, found.y0, found.x1, found.y1),
        (block.x0, block.y0, block.x1, block.y1)
    );
    assert_eq!(locate_panel(&screen.pixels, 1920, 1080), Some(panel));
    // 板の形でない水色の塊を、四隅に置いても同じ。
    fill_rect(&mut screen, 100, 100, 80, 60, CYAN);
    fill_rect(&mut screen, 1700, 900, 80, 60, CYAN);
    assert_eq!(locate_panel(&screen.pixels, 1920, 1080), Some(panel));
}

#[test]
fn e32_decoys_with_the_wrong_shape_are_not_chosen() {
    let (clean, panel) = decoy_base();
    let copy = |c: &Bgra| Bgra {
        pixels: c.pixels.clone(),
        width: c.width,
        height: c.height,
    };
    // 結果の画面の表の線: 横に長く細い（幅 190・高さ 6 の線が 2 本）。水色の画素の数は、板の文字より多い。
    let mut bars = copy(&clean);
    fill_rect(&mut bars, 700, 560, 380, 12, CYAN);
    fill_rect(&mut bars, 700, 600, 380, 12, CYAN);
    assert_eq!(locate_panel(&bars.pixels, 1920, 1080), Some(panel));
    // 大きな水色の面: 縦横の比は合うが、詰まり具合が違う（全部が水色）。画素の数は板の文字より多い。
    let mut square = copy(&clean);
    fill_rect(&mut square, 1140, 420, 90, 70, CYAN);
    assert_eq!(locate_panel(&square.pixels, 1920, 1080), Some(panel));
    // 縦に長い細い線。
    let mut tall = copy(&clean);
    fill_rect(&mut tall, 1100, 300, 6, 200, CYAN);
    assert_eq!(locate_panel(&tall.pixels, 1920, 1080), Some(panel));
    // 板の文字のすぐ上の小さな水色の点（高さの 6% 上）。まとまりには入らない。
    let mut dot = copy(&clean);
    let y = panel.y.saturating_sub(70);
    fill_rect(&mut dot, panel.x + 10, y, 12, 6, CYAN);
    assert_eq!(locate_panel(&dot.pixels, 1920, 1080), Some(panel));
    // 結果の画面の水色の文字の表に似た、横に長い（幅 ÷ 高さ 1.6）まとまり: 板のほうが選ばれる（水色の画素は、板より多い）。
    let mut table = copy(&clean);
    for row in 0..5u32 {
        for col in 0..5u32 {
            fill_rect(&mut table, 100 + col * 24, 100 + row * 13, 16, 8, CYAN);
        }
    }
    assert_eq!(locate_panel(&table.pixels, 1920, 1080), Some(panel));
}

#[test]
fn e32_a_frame_with_only_decoys_gives_no_block() {
    let mut screen = flat(1920, 1080, FLAT_BGR);
    // 範囲の中の、形が合わないものだけ。
    fill_rect(&mut screen, 700, 560, 380, 12, CYAN);
    fill_rect(&mut screen, 1140, 420, 90, 70, CYAN);
    fill_rect(&mut screen, 1100, 300, 6, 200, CYAN);
    assert_eq!(locate_block(&screen.pixels, 1920, 1080), None);
    // 形が合うものは、画像のどこにあっても見つかる（左上の隅に写した板）。
    let mut moved = flat(1920, 1080, FLAT_BGR);
    let source = load_png_bgra(&FX6[0].path());
    let (panel_frame, _) = scaled_onto_canvas(&source, 1350, 1920, 1080, FLAT_BGR);
    let block = locate_block(&panel_frame.pixels, 1920, 1080).unwrap();
    for y in 0..block.height() {
        for x in 0..block.width() {
            let from = (((block.y0 + y) * 1920 + block.x0 + x) * 4) as usize;
            let to = (((100 + y) * 1920 + 100 + x) * 4) as usize;
            let pixel = [
                panel_frame.pixels[from],
                panel_frame.pixels[from + 1],
                panel_frame.pixels[from + 2],
            ];
            moved.pixels[to..to + 3].copy_from_slice(&pixel);
        }
    }
    let found = locate_block(&moved.pixels, 1920, 1080).expect("隅でも見つかる");
    assert_eq!((found.x0, found.y0), (100, 100));
    // 何も無い画面・水色の点だけの画面。
    assert_eq!(
        locate_block(&flat(1920, 1080, FLAT_BGR).pixels, 1920, 1080),
        None
    );
    let mut dots = flat(1920, 1080, FLAT_BGR);
    for i in 0..300u32 {
        fill_rect(
            &mut dots,
            700 + (i * 7) % 500,
            300 + (i * 13) % 330,
            1,
            1,
            CYAN,
        );
    }
    assert_eq!(locate_block(&dots.pixels, 1920, 1080), None);
}

#[test]
fn e32_a_broken_input_gives_no_block() {
    assert_eq!(locate_block(&[], 0, 0), None);
    assert_eq!(
        locate_block(&[0; 16], 10, 10),
        None,
        "画素の数が大きさと合わない"
    );
    assert_eq!(locate_block(&[0; 4], 1, 1), None);
    assert_eq!(locate_panel(&[0; 16], 2, 2), None);
}

#[test]
fn the_test_copy_of_the_strict_parse_agrees_with_e16_on_the_fx4_lines() {
    // エンジンの E-16 の試験（center-text.test.ts）と同じ行。試験用の写し（common::strict_parse）が、エンジンの関数と同じ答えになる。
    let lines = |text: &str| -> Vec<String> { text.split(" | ").map(str::to_string).collect() };
    let parse = |text: &str| common::strict_parse(&lines(text));
    assert_eq!(
        parse("0009 乙 | 東 1 局 | 8 个 59 | 25000"),
        Some(('東', 1, 59, 25000))
    );
    assert_eq!(
        parse("000 乙 乙 | 東 2 局 | 个 2 3 | 19000"),
        Some(('東', 2, 23, 19000))
    );
    assert_eq!(
        parse("00 し 8 し | 東 2 局 | 个 4 7 | 15100"),
        Some(('東', 2, 47, 15100))
    );
    assert_eq!(
        parse("0088 乙 | 東 3 局 | 个 4 6 | 4400"),
        Some(('東', 3, 46, 4400))
    );
    // 局が読めない・点数が 100 点単位でない・残り枚数が無い・点数が無い、は読めない。
    assert_eq!(parse("第 局 | 个 52 | 31700"), None);
    assert_eq!(parse("東 2 局 | 个 52 | 31750"), None);
    assert_eq!(parse("東 2 局 | 25000"), None);
    assert_eq!(parse("東 2 局 | 个 52"), None);
    // 左右の点数が下に混ざると、いちばん下の数字だけの行を点数にする（エンジンと同じ。前の読み方の読み違いの元）。
    assert_eq!(
        parse("東 2 局 | 个 23 | 19000 | 37000"),
        Some(('東', 2, 23, 37000))
    );
    // 3 桁以上は残り枚数ではない。全角の数字は半角として読む。
    assert_eq!(parse("東 2 局 | 个 123 | 19000"), None);
    assert_eq!(
        parse("東２局 | 个 ２３ | １９０００"),
        Some(('東', 2, 23, 19000))
    );
    // 残り枚数は局の行の続きにあってもよい。71 以上は取らない。
    assert_eq!(parse("東 2 局 余 46 | 25000"), Some(('東', 2, 46, 25000)));
    assert_eq!(parse("東 2 局 | 个 71 | 25000"), None);
}
