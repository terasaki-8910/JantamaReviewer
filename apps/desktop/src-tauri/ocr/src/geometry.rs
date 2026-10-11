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

/// 水色の文字の位置から切り出した画像（E-32）を、文字認識の前に拡大・縮小するときの、水色の文字のまとまり（局と余の 2 行）の高さ（画素）。
/// 窓の大きさによらず、文字認識にかける画像の文字の大きさをそろえる（固定の倍率だと、窓が大きいと文字が大きすぎて、小さいと小さすぎて、
/// 読み間違いが増える）。手元の窓（高さ 800〜935）では、3 倍にすると 129〜138 画素だった。値（と、切り出しの余白 `locate::CROP_*`）は、
/// 手元の画像 19 枚と、それを 0.5〜1.4 倍に拡大・縮小した画像を、Windows の日本語の文字認識で読んで、1 回目と読み直しのどれかで
/// 読めた数がいちばん多い組み合わせを選んだ（上の余白 10〜50%・横 6〜30%・下 66〜90%・文字の高さ 60〜140 画素・まわりの余白 8〜64 画素を
/// 約 1700 通り試した）。1 回目だけで見ると、手元の 19 枚で読めるのは 14 枚（最良の組み合わせでも 18 枚。ただし別の大きさでは減る）。
pub const TIGHT_BLOCK_HEIGHT: u32 = 100;

/// 同じく、切り出した画像のまわりに足す余白（画素。拡大・縮小のあと）。余白が無いと、文字認識は上の行を落とす・「東」を読み違えることが多い。
pub const TIGHT_PADDING: u32 = 24;

/// 読み直し（E-20）の、コントラストの倍率。3 倍にした画像の、明るさの平均を中心に、色を 1.8 倍に広げる。
pub const CONTRAST_FACTOR: f32 = 1.8;

/// 読み直し（E-20）の、広げる倍率の分子と分母（3 倍にした画像を、さらに 3/2 = 1.5 倍に広げる）。小数は切り捨てる。
pub const ENLARGE_NUMERATOR: u32 = 3;
pub const ENLARGE_DENOMINATOR: u32 = 2;

/// 切り出しの決まりの名前。読み取りの結果を保存するとき（`ocr.json`）に添えて、決まりが変わったら読み直せるようにする。
/// 切り出しの箱・3 倍の拡大・読み直しの画像の作り方（`Variant`）のどれかを変えたら、名前を変える（古い写しは読み直す）。
/// - v1: 3 倍の画像を 1 回だけ読む
/// - v2: 3 倍の画像に加えて、コントラストを上げた画像と 1.5 倍に広げた画像も読む（読み直し）
/// - v3: 局と残り枚数の水色の文字の位置から、局・残り枚数・自分の点数だけを切り出して、文字の高さをそろえて拡大し、余白を足して読む
///   （見つからなければ v2 と同じ箱）。読み直しの画像（コントラスト・1.5 倍）は、その切り出しから作る（E-32）
pub const GEOMETRY_ID: &str = "center-v3-cyan-tight";

/// 文字認識にかける画像の作り方。1 回目は `Plain`。1 回目で読めない画像のために、`Contrast`・`Enlarged` の順で読み直す（E-20）。
/// どれで読むかを決めるのは呼ぶ側（結果を取り込む画面の側が、局・残り枚数・点数が取れた最初のものを使う）。
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum Variant {
    /// 切り出した画像を 3 倍にしたもの（そのまま）。
    Plain,
    /// コントラストを 1.8 倍にしたもの。
    Contrast,
    /// さらに 1.5 倍に広げたもの。
    Enlarged,
}

impl Variant {
    /// 1 回目と読み直しの順。
    pub const ALL: [Variant; 3] = [Variant::Plain, Variant::Contrast, Variant::Enlarged];

    /// 写し（`ocr.json`）に残す名前。
    pub fn name(self) -> &'static str {
        match self {
            Variant::Plain => "plain",
            Variant::Contrast => "contrast1.8",
            Variant::Enlarged => "upscale1.5",
        }
    }
}

/// 3 倍にした画像（幅, 高さ）を、読み直しのために広げたあとの大きさ。小数は切り捨てる（654×393 → 981×589）。
pub fn enlarged_size(width: u32, height: u32) -> (u32, u32) {
    (
        width * ENLARGE_NUMERATOR / ENLARGE_DENOMINATOR,
        height * ENLARGE_NUMERATOR / ENLARGE_DENOMINATOR,
    )
}

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
    fn the_enlarged_size_cuts_the_fraction_down() {
        // 迷いマークの画面（1447×935）の中央は、3 倍で 654×393、広げて 981×589（393 × 1.5 = 589.5 → 589）。
        let crop = center_crop(1447, 935).unwrap();
        let (w, h) = crop.scaled(UPSCALE);
        assert_eq!(enlarged_size(w, h), (981, 589));
        assert_eq!(enlarged_size(61, 28), (91, 42));
        assert_eq!(enlarged_size(2, 2), (3, 3));
    }

    #[test]
    fn the_variants_are_read_in_order_with_stable_names() {
        assert_eq!(
            Variant::ALL.map(Variant::name),
            ["plain", "contrast1.8", "upscale1.5"]
        );
        assert!(GEOMETRY_ID.starts_with("center-v3"));
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
