//! 画面中央の板（局・残りの牌の数・点数が出る所）の切り出しの決まり。
//!
//! 純粋な計算だけで、画像にも OS にも触れない。箱は画面の大きさに対する割合で決める。
//! 迷いマークの画面（雀魂の窓のスクリーンショット）では、この箱に、東1局などの局の名前・残り枚数・4 人の点数だけが入る
//! （プレイヤーの名前は入らない）。

/// 切り出しの箱（画面の幅・高さに対する割合を、千分率の整数で持つ。浮動小数点の誤差を避けるため）。
pub const CENTER_LEFT_PERMILLE: u64 = 425;
pub const CENTER_TOP_PERMILLE: u64 = 360;
pub const CENTER_RIGHT_PERMILLE: u64 = 575;
pub const CENTER_BOTTOM_PERMILLE: u64 = 500;

/// 切り出したあとに、文字認識の前に拡大する倍率。
pub const UPSCALE: u32 = 3;

/// 切り出しの決まりの名前。読み取りの結果を保存するとき（`ocr.json`）に添えて、決まりが変わったら読み直せるようにする。
pub const GEOMETRY_ID: &str = "center-v1-lanczos3x";

/// 切り出す長方形（画素。左上と大きさ）。
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub struct CropRect {
    pub x: u32,
    pub y: u32,
    pub width: u32,
    pub height: u32,
}

impl CropRect {
    /// 拡大したあとの大きさ（幅, 高さ）。
    pub fn scaled(&self, factor: u32) -> (u32, u32) {
        (self.width * factor, self.height * factor)
    }
}

/// 幅 `width`・高さ `height` の画面から、中央の板の箱を切り出す長方形。
///
/// 箱 (0.425W, 0.36H)–(0.575W, 0.50H) の 4 つの端を、どれも整数の画素に切り捨てる（試験の素材を作る Python の
/// `int(...)` と同じ決まり。素材と製品の切り出しをそろえる）。画面の外にははみ出さない。
/// 画面が小さすぎて長方形が空になるときは `None`。
pub fn center_crop(width: u32, height: u32) -> Option<CropRect> {
    let (w, h) = (u64::from(width), u64::from(height));
    let x0 = w * CENTER_LEFT_PERMILLE / 1000;
    let y0 = h * CENTER_TOP_PERMILLE / 1000;
    let x1 = (w * CENTER_RIGHT_PERMILLE / 1000).min(w);
    let y1 = (h * CENTER_BOTTOM_PERMILLE / 1000).min(h);
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

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn the_box_for_the_recorded_marks_is_218_by_131_at_614_336() {
        // 10 月 9 日の半荘の迷いマークの画面は 1447×935。fixtures の切り出し（Python）と同じ整数の決まり。
        assert_eq!(
            center_crop(1447, 935),
            Some(CropRect {
                x: 614,
                y: 336,
                width: 218,
                height: 131
            })
        );
        assert_eq!(center_crop(1447, 935).unwrap().scaled(UPSCALE), (654, 393));
    }

    #[test]
    fn the_box_for_a_round_resolution_is_exact() {
        // 1920×1080: 0.425·1920 = 816、0.575·1920 = 1104、0.36·1080 = 388.8 → 388、0.5·1080 = 540。
        assert_eq!(
            center_crop(1920, 1080),
            Some(CropRect {
                x: 816,
                y: 388,
                width: 288,
                height: 152
            })
        );
    }

    #[test]
    fn every_edge_is_the_real_valued_edge_cut_down_to_a_whole_pixel_and_stays_inside() {
        for (w, h) in [
            (640u32, 360u32),
            (1280, 720),
            (1447, 935),
            (1366, 768),
            (2560, 1440),
            (3840, 2160),
            (999, 777),
        ] {
            let r = center_crop(w, h).expect("通常の大きさでは空にならない");
            let (fw, fh) = (f64::from(w), f64::from(h));
            assert_eq!(r.x, (0.425 * fw).floor() as u32, "{w}x{h}: 左");
            assert_eq!(r.y, (0.36 * fh).floor() as u32, "{w}x{h}: 上");
            assert_eq!(r.x + r.width, (0.575 * fw).floor() as u32, "{w}x{h}: 右");
            assert_eq!(r.y + r.height, (0.50 * fh).floor() as u32, "{w}x{h}: 下");
            assert!(
                r.x + r.width <= w && r.y + r.height <= h,
                "{w}x{h}: はみ出す"
            );
        }
    }

    #[test]
    fn a_degenerate_screen_gives_no_box() {
        assert_eq!(center_crop(0, 0), None);
        assert_eq!(center_crop(0, 935), None);
        assert_eq!(center_crop(1447, 0), None);
        // 1 画素の画面では、箱が空になる（左 0・右 0）。
        assert_eq!(center_crop(1, 1), None);
        // 幅 20 画素: 左 = 8、右 = 11 で幅 3。高さ 100 画素: 上 = 36、下 = 50 で高さ 14。
        assert_eq!(
            center_crop(20, 100),
            Some(CropRect {
                x: 8,
                y: 36,
                width: 3,
                height: 14
            })
        );
    }

    #[test]
    fn the_scale_factor_multiplies_both_sides() {
        let r = CropRect {
            x: 1,
            y: 2,
            width: 10,
            height: 7,
        };
        assert_eq!(r.scaled(3), (30, 21));
    }
}
