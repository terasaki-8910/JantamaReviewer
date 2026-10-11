//! 画面の中央の板の「水色の文字」（局の名前と、残りの牌の数）を色で探して、読む所の長方形を決める（E-32、F11）。
//!
//! 割合の箱（`geometry::center_crop`）は、窓の縦横の比が変わると、板が箱の中で大きく写って、上の逆さの点数が半分に切れ、
//! 左右の縦書きの点数が横に並んで、文字認識が行を取り違える（2026-10-11 の調べ）。板の大きさは窓の大きさで変わるが、
//! 局の名前と残り枚数の文字の「色」と「形」は変わらない。そこで、探す範囲の中から水色の文字を探し、そのまとまりの位置から、
//! 局・残り枚数・自分の点数だけを切り出す。
//!
//! 純粋な計算だけで、画像のファイルにも OS にも触れない。画素は、行を詰めた BGRA の並び（`resample` と同じ）。
//!
//! 決め方:
//! 1. 探す範囲（幅 35〜65%・高さ 25〜60%）の中の、水色の画素（HSV で s > 0.45・v > 0.55・0.45 < h < 0.56）を拾う。
//! 2. 水色の画素のつながり（8 近傍）を数え、小さすぎるもの（ごみ）を捨てる。
//! 3. つながりを、高さの 2% 以内に近いものどうしで 1 つのまとまりにする（局の行と余の行の間が高さの 1.5% ほどあるので、
//!    それより大きく取る）。
//! 4. まとまりごとに、大きさ・縦横の比・水色の画素の詰まり具合・つながりの数が、局と余の 2 行らしいかを調べる。
//!    らしくないもの（結果の画面の表の線・上の方にだけ残った水色の点など）は捨てる。
//! 5. 残ったもののうち、水色の画素がいちばん多いものを板の文字とする。残らなければ `None`（呼ぶ側は、今の箱で読む）。
//! 6. 板の文字の上端の少し上から、下の自分の点数までを、文字の幅に少し足した幅で切り出す（`panel_crop`）。

use crate::geometry::CropRect;

/// 探す範囲（画面の幅・高さに対する割合。千分率）。局と残り枚数の文字は、画面の中央に出る。
pub const SEARCH_LEFT_PERMILLE: u64 = 350;
pub const SEARCH_RIGHT_PERMILLE: u64 = 650;
pub const SEARCH_TOP_PERMILLE: u64 = 250;
pub const SEARCH_BOTTOM_PERMILLE: u64 = 600;

/// 水色の画素の条件（HSV。色相は 0〜1 に直した値）。雀魂の局・余の文字（明るい青緑）に合わせた値。
const CYAN_MIN_SATURATION: f32 = 0.45;
const CYAN_MIN_VALUE: f32 = 0.55;
const CYAN_HUE_ABOVE: f32 = 0.45;
const CYAN_HUE_BELOW: f32 = 0.56;

/// つながりの面積の下限: 画面の高さの 2 乗の 1/40000（高さ 800 で 16 画素。手元の板の文字のつながりは、最も小さいものでも
/// 47 画素以上で、ごみ（1〜10 画素）はこれ未満）。ただし 4 画素より小さくはしない。
const MIN_COMPONENT_AREA_DIVISOR: u64 = 40_000;
const MIN_COMPONENT_AREA_FLOOR: u64 = 4;

/// つながりを 1 つのまとまりにする距離（外接の箱どうしの間。横も縦も）。画面の高さの 2%（千分率で 20）。
/// 局の行と余の行の間は、手元の画面で高さの 1.3〜1.5%、1 行の中の字と字の間は 1% 未満。
const MERGE_GAP_PERMILLE: u64 = 20;

/// まとまりが板の文字らしい範囲。手元の 19 枚は、高さが画面の高さの 4.9〜5.4%、幅 ÷ 高さが 1.28〜1.30、
/// 水色の画素の詰まり具合（水色の画素の数 ÷ 外接の箱の面積）が 0.25〜0.28、つながりが 6〜8 個。
/// 高さの割合は、窓の縦横の比で変わる（雀魂は 16:9 に収めて表示するので、16:9 より縦に長い窓では、
/// 板は幅に合わせて小さくなる。1280×1024 で 3.9%）ので、広く取る。
const BLOCK_MIN_HEIGHT_PERMILLE: u64 = 30;
const BLOCK_MAX_HEIGHT_PERMILLE: u64 = 75;
/// 幅 ÷ 高さ（千分率）。
const BLOCK_MIN_ASPECT_PERMILLE: u64 = 900;
const BLOCK_MAX_ASPECT_PERMILLE: u64 = 1700;
/// 詰まり具合（千分率）。
const BLOCK_MIN_FILL_PERMILLE: u64 = 120;
const BLOCK_MAX_FILL_PERMILLE: u64 = 450;
/// まとまりを作るつながりの数（局の名前 3 文字・余・数字 2 つで 6〜8 個。つながったり、欠けたりしても 4〜16）。
const BLOCK_MIN_COMPONENTS: usize = 4;
const BLOCK_MAX_COMPONENTS: usize = 16;
/// つながりの数がこれより多いときは、板の画面ではない（写真・大きな絵など）として探さない（計算量の上限も兼ねる）。
const MAX_COMPONENTS: usize = 600;

/// 切り出しの余白（板の文字の幅・高さに対する割合。千分率）。
/// 上 30%: 局の行の上の枠まで（上の逆さの点数は入らない。手元の画面では、文字の上端の上 3 割までに点数の字は無い）。
/// 横 8%: 左右の縦書きの点数・供託の印は入れない。
/// 下 72%: 余の行の下の枠と自分の点数まで（点数の字は、文字の下端から高さの 0.33〜0.65 倍の所。その下の黄色い帯は、0.7 倍から
/// 始まるので入れない）。
/// 余白の割合・拡大の大きさ・まわりの余白は、手元の画像 19 枚（と、それを 0.7〜1.35 倍にした画像）を Windows の日本語の
/// 文字認識で読んで、1 回目と読み直しの読み取りが最も多く正解になる組み合わせを選んだ（上 10〜50%・横 8〜30%・下 72〜90%・
/// 文字の高さ 60〜160 画素・余白 0〜64 画素を試した。割合の箱では 13 枚中 1 枚だった所）。
pub const CROP_TOP_PERMILLE: u64 = 300;
pub const CROP_SIDE_PERMILLE: u64 = 80;
pub const CROP_BOTTOM_PERMILLE: u64 = 720;

/// 水色の文字のまとまり（外接の箱と、水色の画素の数）。
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub struct Block {
    pub x0: u32,
    pub y0: u32,
    /// 右端と下端は、箱の外（含まない）。
    pub x1: u32,
    pub y1: u32,
    /// 水色の画素の数。
    pub cyan: u64,
    /// まとまりを作るつながりの数。
    pub components: usize,
}

impl Block {
    pub fn width(&self) -> u32 {
        self.x1 - self.x0
    }
    pub fn height(&self) -> u32 {
        self.y1 - self.y0
    }
}

/// 水色の画素か。`b`・`g`・`r` は 0〜255。
fn is_cyan(b: u8, g: u8, r: u8) -> bool {
    let (rf, gf, bf) = (
        f32::from(r) / 255.0,
        f32::from(g) / 255.0,
        f32::from(b) / 255.0,
    );
    let max = rf.max(gf).max(bf);
    let min = rf.min(gf).min(bf);
    let delta = max - min;
    if max <= CYAN_MIN_VALUE || delta <= 0.0 || delta / max <= CYAN_MIN_SATURATION {
        return false;
    }
    // 色相（0〜1）。水色は緑と青の間なので、最大の成分が赤の場合は当たらない。
    let hue = if max == rf {
        return false;
    } else if max == gf {
        (2.0 + (bf - rf) / delta) / 6.0
    } else {
        (4.0 + (rf - gf) / delta) / 6.0
    };
    hue > CYAN_HUE_ABOVE && hue < CYAN_HUE_BELOW
}

/// つながり（水色の画素の 8 近傍のかたまり）の外接の箱と面積。
#[derive(Debug, Clone, Copy)]
struct Component {
    x0: u32,
    y0: u32,
    x1: u32,
    y1: u32,
    area: u64,
}

/// 探す範囲の長方形（画素。右端・下端は含まない）。範囲が空なら `None`。
fn search_region(width: u32, height: u32) -> Option<(u32, u32, u32, u32)> {
    let (w, h) = (u64::from(width), u64::from(height));
    let x0 = w * SEARCH_LEFT_PERMILLE / 1000;
    let x1 = (w * SEARCH_RIGHT_PERMILLE / 1000).min(w);
    let y0 = h * SEARCH_TOP_PERMILLE / 1000;
    let y1 = (h * SEARCH_BOTTOM_PERMILLE / 1000).min(h);
    if x1 <= x0 || y1 <= y0 {
        return None;
    }
    Some((x0 as u32, y0 as u32, x1 as u32, y1 as u32))
}

/// 探す範囲の水色のつながりを数える。小さすぎるものは捨てる。多すぎるときは `None`。
fn components(bgra: &[u8], width: u32, height: u32) -> Option<Vec<Component>> {
    let (rx0, ry0, rx1, ry1) = search_region(width, height)?;
    let (rw, rh) = ((rx1 - rx0) as usize, (ry1 - ry0) as usize);
    let stride = width as usize * 4;
    let mut cyan = vec![false; rw * rh];
    for y in 0..rh {
        let row = (ry0 as usize + y) * stride;
        for x in 0..rw {
            let i = row + (rx0 as usize + x) * 4;
            cyan[y * rw + x] = is_cyan(bgra[i], bgra[i + 1], bgra[i + 2]);
        }
    }
    let min_area = (u64::from(height) * u64::from(height) / MIN_COMPONENT_AREA_DIVISOR)
        .max(MIN_COMPONENT_AREA_FLOOR);
    let mut seen = vec![false; rw * rh];
    let mut found = Vec::new();
    let mut stack = Vec::new();
    for start in 0..rw * rh {
        if !cyan[start] || seen[start] {
            continue;
        }
        seen[start] = true;
        stack.push(start);
        let (sx, sy) = ((start % rw) as u32, (start / rw) as u32);
        let mut c = Component {
            x0: sx,
            y0: sy,
            x1: sx + 1,
            y1: sy + 1,
            area: 0,
        };
        while let Some(p) = stack.pop() {
            let (px, py) = ((p % rw) as u32, (p / rw) as u32);
            c.area += 1;
            c.x0 = c.x0.min(px);
            c.y0 = c.y0.min(py);
            c.x1 = c.x1.max(px + 1);
            c.y1 = c.y1.max(py + 1);
            for dy in -1i32..=1 {
                for dx in -1i32..=1 {
                    let (nx, ny) = (px as i32 + dx, py as i32 + dy);
                    if nx < 0 || ny < 0 || nx >= rw as i32 || ny >= rh as i32 {
                        continue;
                    }
                    let n = ny as usize * rw + nx as usize;
                    if cyan[n] && !seen[n] {
                        seen[n] = true;
                        stack.push(n);
                    }
                }
            }
        }
        if c.area >= min_area {
            found.push(Component {
                x0: c.x0 + rx0,
                y0: c.y0 + ry0,
                x1: c.x1 + rx0,
                y1: c.y1 + ry0,
                area: c.area,
            });
            if found.len() > MAX_COMPONENTS {
                return None;
            }
        }
    }
    Some(found)
}

/// 2 つの外接の箱の間（横と縦。重なっていれば 0）の大きいほう。
fn box_gap(a: &Component, b: &Component) -> u32 {
    let dx = a.x0.saturating_sub(b.x1).max(b.x0.saturating_sub(a.x1));
    let dy = a.y0.saturating_sub(b.y1).max(b.y0.saturating_sub(a.y1));
    dx.max(dy)
}

fn find_root(parent: &mut [usize], mut i: usize) -> usize {
    while parent[i] != i {
        parent[i] = parent[parent[i]];
        i = parent[i];
    }
    i
}

/// つながりを、近いものどうしでまとまりにする。
fn group(parts: &[Component], height: u32) -> Vec<Block> {
    let gap = (u64::from(height) * MERGE_GAP_PERMILLE / 1000).max(1) as u32;
    let mut parent: Vec<usize> = (0..parts.len()).collect();
    for i in 0..parts.len() {
        for j in i + 1..parts.len() {
            if box_gap(&parts[i], &parts[j]) <= gap {
                let (ri, rj) = (find_root(&mut parent, i), find_root(&mut parent, j));
                parent[ri] = rj;
            }
        }
    }
    let mut blocks: Vec<(usize, Block)> = Vec::new();
    for (i, part) in parts.iter().enumerate() {
        let root = find_root(&mut parent, i);
        match blocks.iter_mut().find(|(r, _)| *r == root) {
            Some((_, block)) => {
                block.x0 = block.x0.min(part.x0);
                block.y0 = block.y0.min(part.y0);
                block.x1 = block.x1.max(part.x1);
                block.y1 = block.y1.max(part.y1);
                block.cyan += part.area;
                block.components += 1;
            }
            None => blocks.push((
                root,
                Block {
                    x0: part.x0,
                    y0: part.y0,
                    x1: part.x1,
                    y1: part.y1,
                    cyan: part.area,
                    components: 1,
                },
            )),
        }
    }
    blocks.into_iter().map(|(_, block)| block).collect()
}

/// まとまりの大きさ・形・詰まり具合・つながりの数が、局と余の 2 行らしいか。
fn looks_like_the_panel_text(block: &Block, height: u32) -> bool {
    let (w, h) = (u64::from(block.width()), u64::from(block.height()));
    if w == 0 || h == 0 {
        return false;
    }
    let screen = u64::from(height);
    let tall_enough = h * 1000 >= screen * BLOCK_MIN_HEIGHT_PERMILLE;
    let not_too_tall = h * 1000 <= screen * BLOCK_MAX_HEIGHT_PERMILLE;
    let aspect = w * 1000 / h;
    let fill = block.cyan * 1000 / (w * h);
    tall_enough
        && not_too_tall
        && (BLOCK_MIN_ASPECT_PERMILLE..=BLOCK_MAX_ASPECT_PERMILLE).contains(&aspect)
        && (BLOCK_MIN_FILL_PERMILLE..=BLOCK_MAX_FILL_PERMILLE).contains(&fill)
        && (BLOCK_MIN_COMPONENTS..=BLOCK_MAX_COMPONENTS).contains(&block.components)
}

/// 幅 `width`・高さ `height` の画面（行を詰めた BGRA の並び）から、局と残り枚数の水色の文字のまとまりを探す。
/// 板の文字らしいまとまりが無ければ `None`。
///
/// 画素の数が大きさと合わないときは、`None`（読めない画像として、呼ぶ側が今の箱に戻る）。
pub fn locate_block(bgra: &[u8], width: u32, height: u32) -> Option<Block> {
    if bgra.len() != width as usize * height as usize * 4 {
        return None;
    }
    let parts = components(bgra, width, height)?;
    group(&parts, height)
        .into_iter()
        .filter(|block| looks_like_the_panel_text(block, height))
        .max_by_key(|block| block.cyan)
}

/// 板の文字のまとまりから、読む所の長方形（局・残り枚数・自分の点数だけが入る）。画面の外にははみ出さない。
pub fn panel_crop(block: &Block, width: u32, height: u32) -> Option<CropRect> {
    let (bw, bh) = (u64::from(block.width()), u64::from(block.height()));
    let side = bw * CROP_SIDE_PERMILLE / 1000;
    let top = bh * CROP_TOP_PERMILLE / 1000;
    let bottom = bh * CROP_BOTTOM_PERMILLE / 1000;
    let x0 = u64::from(block.x0).saturating_sub(side);
    let y0 = u64::from(block.y0).saturating_sub(top);
    let x1 = (u64::from(block.x1) + side).min(u64::from(width));
    let y1 = (u64::from(block.y1) + bottom).min(u64::from(height));
    if x1 <= x0 || y1 <= y0 {
        return None;
    }
    Some(CropRect {
        x: x0 as u32,
        y: y0 as u32,
        width: (x1 - x0) as u32,
        height: (y1 - y0) as u32,
    })
}

/// 画面から、局・残り枚数・自分の点数を切り出す長方形を探す（板の文字が見つからなければ `None`）。
pub fn locate_panel(bgra: &[u8], width: u32, height: u32) -> Option<CropRect> {
    locate(bgra, width, height).map(|panel| panel.crop)
}

/// 見つけた板の文字のまとまりと、そこから決めた切り出し。
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub struct Panel {
    pub block: Block,
    pub crop: CropRect,
}

/// 画面から、板の文字のまとまりと切り出しの長方形を探す（見つからなければ `None`）。
pub fn locate(bgra: &[u8], width: u32, height: u32) -> Option<Panel> {
    let block = locate_block(bgra, width, height)?;
    let crop = panel_crop(&block, width, height)?;
    Some(Panel { block, crop })
}

#[cfg(test)]
mod tests {
    use super::*;

    /// 一色の BGRA の画面に、水色の長方形（左上 x, y と大きさ）を描く。
    fn screen_with(width: u32, height: u32, rects: &[(u32, u32, u32, u32)]) -> Vec<u8> {
        let mut pixels = Vec::new();
        for _ in 0..width * height {
            pixels.extend_from_slice(&[40, 40, 40, 255]);
        }
        for &(x, y, w, h) in rects {
            for yy in y..y + h {
                for xx in x..x + w {
                    let i = ((yy * width + xx) * 4) as usize;
                    pixels[i..i + 4].copy_from_slice(&[200, 190, 30, 255]);
                }
            }
        }
        pixels
    }

    #[test]
    fn the_cyan_of_the_panel_text_is_cyan_and_the_other_colours_of_the_screen_are_not() {
        // is_cyan(b, g, r): 局・余の文字の水色（R 30・G 190・B 200）。
        assert!(is_cyan(200, 190, 30));
        // 明るい青緑・やや暗い水色も水色。
        assert!(is_cyan(220, 215, 60));
        assert!(is_cyan(150, 150, 20));
        // 点数の橙・黄色い帯・白・灰色の枠・暗い所・緑の牌・青い卓は、水色ではない。
        assert!(!is_cyan(40, 150, 230));
        assert!(!is_cyan(30, 220, 240));
        assert!(!is_cyan(255, 255, 255));
        assert!(!is_cyan(90, 90, 90));
        assert!(!is_cyan(70, 60, 10));
        assert!(!is_cyan(60, 200, 40));
        assert!(!is_cyan(220, 60, 40));
        // 彩度が足りない青緑（灰色がかった水色）は水色ではない。
        assert!(!is_cyan(190, 190, 150));
    }

    #[test]
    fn the_panel_crop_is_the_block_with_the_margins_of_the_constants_and_stays_inside() {
        let block = Block {
            x0: 656,
            y0: 310,
            x1: 712,
            y1: 353,
            cyan: 600,
            components: 8,
        };
        // 幅 56・高さ 43: 横は 8% = 4、上は 30% = 12、下は 72% = 30。
        assert_eq!(
            panel_crop(&block, 1368, 800),
            Some(CropRect {
                x: 652,
                y: 298,
                width: 64,
                height: 85
            })
        );
        // 画面の端では、はみ出さずに切る。
        let edge = Block {
            x0: 2,
            y0: 1,
            x1: 58,
            y1: 44,
            cyan: 600,
            components: 8,
        };
        let crop = panel_crop(&edge, 70, 60).unwrap();
        assert_eq!((crop.x, crop.y), (0, 0));
        assert!(crop.x + crop.width <= 70 && crop.y + crop.height <= 60);
    }

    #[test]
    fn the_search_region_is_the_middle_30_by_35_percent() {
        assert_eq!(search_region(1000, 800), Some((350, 200, 650, 480)));
        assert_eq!(search_region(1368, 800), Some((478, 200, 889, 480)));
        assert_eq!(search_region(0, 0), None);
        assert_eq!(search_region(1, 1), None);
    }

    /// 局の行と余の行らしい、2 行 6 個の水色の塊（1 つが 10×12。1 行目は上の端が y、2 行目は 26 下）。
    fn two_lines(x: u32, y: u32, glyph: (u32, u32)) -> Vec<(u32, u32, u32, u32)> {
        let mut rects = Vec::new();
        for row in 0..2 {
            for col in 0..3 {
                rects.push((x + col * 20, y + row * 26, glyph.0, glyph.1));
            }
        }
        rects
    }

    #[test]
    fn two_text_lines_of_the_right_shape_are_found_and_a_single_stroke_is_not() {
        // 1000×800 の画面（探す範囲は (350,200)–(650,480)）。幅 50 × 高さ 38、詰まり 0.38。
        let screen = screen_with(1000, 800, &two_lines(460, 300, (10, 12)));
        let block = locate_block(&screen, 1000, 800).expect("見つかる");
        assert_eq!(
            (block.x0, block.y0, block.x1, block.y1),
            (460, 300, 510, 338)
        );
        assert_eq!(block.components, 6);
        assert_eq!(block.cyan, 720);
        // 細い線が 1 本だけでは、板の文字ではない。
        let stroke = screen_with(1000, 800, &[(460, 300, 70, 4)]);
        assert_eq!(locate_block(&stroke, 1000, 800), None);
    }

    #[test]
    fn the_block_with_the_most_cyan_wins_among_blocks_of_the_right_shape() {
        // 同じ形の塊が 2 つ（探す範囲の左と右）。水色の画素が多いほうを選ぶ。
        let mut rects = two_lines(370, 300, (8, 10));
        rects.extend(two_lines(560, 300, (10, 12)));
        let screen = screen_with(1000, 800, &rects);
        let block = locate_block(&screen, 1000, 800).unwrap();
        assert_eq!(block.x0, 560);
        // 左のほうが多ければ、左。
        let mut rects = two_lines(370, 300, (10, 12));
        rects.extend(two_lines(560, 300, (8, 10)));
        let screen = screen_with(1000, 800, &rects);
        assert_eq!(locate_block(&screen, 1000, 800).unwrap().x0, 370);
    }

    #[test]
    fn a_noisy_frame_with_too_many_pieces_is_not_searched() {
        // つながりが多すぎる（600 個より多い）画面は、板の画面ではないとして探さない。
        let mut rects = Vec::new();
        for i in 0..40u32 {
            for j in 0..20u32 {
                rects.push((352 + i * 7, 202 + j * 13, 4, 4));
            }
        }
        let screen = screen_with(1000, 800, &rects);
        assert_eq!(locate_block(&screen, 1000, 800), None);
    }
}
