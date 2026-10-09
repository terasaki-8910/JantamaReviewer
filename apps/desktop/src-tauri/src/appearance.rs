//! 窓の背景色（N-7）。
//!
//! 画面（webview）は、いま描いている背景の色（ライト・ダークのどちらのトークンかは画面が知っている）を
//! CSS の色の文字列で知らせてくる。Rust 側はそれを窓と webview の背景色にそろえる。
//! 窓を見せた直後や、窓の大きさを変えたときに、描画が追いつくまでの一瞬に白い面が見えないようにするため。
//! 色の値を Rust 側に持たないので、色は CSS のトークンだけに置いたままになる。
//!
//! ここは色の文字列を読む純粋な部分。

/// 不透明な RGB。
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub struct Rgb(pub u8, pub u8, pub u8);

/// CSS の色の文字列（`getComputedStyle` が返す形が中心）を読む。
/// 読めるのは `rgb(r, g, b)`・`rgba(r, g, b, a)`・空白区切りの `rgb(r g b / a)`・`color(srgb r g b / a)`・`#rgb`・`#rrggbb`。
/// 透明（アルファが 0）や、読めない文字列は `None`（窓の背景色は変えない）。
pub fn parse_css_color(text: &str) -> Option<Rgb> {
    let text = text.trim().to_ascii_lowercase();
    if let Some(hex) = text.strip_prefix('#') {
        return parse_hex(hex);
    }
    let (name, body) = text.split_once('(')?;
    let body = body.strip_suffix(')')?;
    let name = name.trim();
    let (channels, alpha) = match body.split_once('/') {
        Some((channels, alpha)) => (channels, Some(alpha)),
        None => (body, None),
    };
    let mut parts: Vec<&str> = channels
        .split(|c: char| c == ',' || c.is_whitespace())
        .filter(|p| !p.is_empty())
        .collect();
    // `rgba(r, g, b, a)` の 4 つ目はアルファ（`color(srgb r g b)` の 4 つ目は青なので、rgb 系だけ）。
    let alpha = match alpha {
        Some(a) => Some(a.trim()),
        None if matches!(name, "rgb" | "rgba") && parts.len() == 4 => parts.pop(),
        None => None,
    };
    if let Some(alpha) = alpha {
        if parse_alpha(alpha)? <= 0.0 {
            return None;
        }
    }
    match name {
        "rgb" | "rgba" => {
            if parts.len() != 3 {
                return None;
            }
            Some(Rgb(
                parse_rgb_channel(parts[0])?,
                parse_rgb_channel(parts[1])?,
                parse_rgb_channel(parts[2])?,
            ))
        }
        "color" => {
            if parts.len() != 4 || parts[0] != "srgb" {
                return None;
            }
            Some(Rgb(
                parse_unit_channel(parts[1])?,
                parse_unit_channel(parts[2])?,
                parse_unit_channel(parts[3])?,
            ))
        }
        _ => None,
    }
}

fn parse_hex(hex: &str) -> Option<Rgb> {
    if !hex.chars().all(|c| c.is_ascii_hexdigit()) {
        return None;
    }
    let byte = |s: &str| u8::from_str_radix(s, 16).ok();
    match hex.len() {
        3 => {
            let expand = |i: usize| byte(&hex[i..=i].repeat(2));
            Some(Rgb(expand(0)?, expand(1)?, expand(2)?))
        }
        6 => Some(Rgb(byte(&hex[0..2])?, byte(&hex[2..4])?, byte(&hex[4..6])?)),
        _ => None,
    }
}

/// 0 から 255 の値。小数も受ける（丸める）。
fn parse_rgb_channel(text: &str) -> Option<u8> {
    if let Some(percent) = text.strip_suffix('%') {
        let value: f64 = percent.parse().ok()?;
        return Some((value.clamp(0.0, 100.0) * 255.0 / 100.0).round() as u8);
    }
    let value: f64 = text.parse().ok()?;
    Some(value.clamp(0.0, 255.0).round() as u8)
}

/// 0 から 1 の値を 0 から 255 にする。
fn parse_unit_channel(text: &str) -> Option<u8> {
    let value: f64 = text.parse().ok()?;
    Some((value.clamp(0.0, 1.0) * 255.0).round() as u8)
}

fn parse_alpha(text: &str) -> Option<f64> {
    if let Some(percent) = text.strip_suffix('%') {
        let value: f64 = percent.parse().ok()?;
        return Some(value / 100.0);
    }
    text.parse().ok()
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn n7_reads_the_computed_style_forms() {
        assert_eq!(
            parse_css_color("rgb(244, 244, 244)"),
            Some(Rgb(244, 244, 244))
        );
        assert_eq!(parse_css_color("rgb(18,18,18)"), Some(Rgb(18, 18, 18)));
        assert_eq!(
            parse_css_color("rgba(28, 28, 28, 1)"),
            Some(Rgb(28, 28, 28))
        );
        assert_eq!(
            parse_css_color("rgb(244 244 244)"),
            Some(Rgb(244, 244, 244))
        );
        assert_eq!(
            parse_css_color("rgb(244 244 244 / 1)"),
            Some(Rgb(244, 244, 244))
        );
        assert_eq!(
            parse_css_color("rgb(244 244 244 / 100%)"),
            Some(Rgb(244, 244, 244))
        );
        assert_eq!(parse_css_color("  RGB(1, 2, 3)  "), Some(Rgb(1, 2, 3)));
    }

    #[test]
    fn n7_reads_srgb_color_functions_and_hex() {
        assert_eq!(
            parse_css_color("color(srgb 0.9568 0.9568 0.9568)"),
            Some(Rgb(244, 244, 244))
        );
        assert_eq!(
            parse_css_color("color(srgb 0 0.5 1 / 1)"),
            Some(Rgb(0, 128, 255))
        );
        assert_eq!(parse_css_color("#F4F4F4"), Some(Rgb(244, 244, 244)));
        assert_eq!(parse_css_color("#1c1c1c"), Some(Rgb(28, 28, 28)));
        assert_eq!(parse_css_color("#fff"), Some(Rgb(255, 255, 255)));
    }

    #[test]
    fn n7_percentages_and_fractions_round_to_the_nearest_value() {
        assert_eq!(
            parse_css_color("rgb(100%, 50%, 0%)"),
            Some(Rgb(255, 128, 0))
        );
        assert_eq!(
            parse_css_color("rgb(243.6, 0.4, 255)"),
            Some(Rgb(244, 0, 255))
        );
        assert_eq!(parse_css_color("rgb(300, -5, 10)"), Some(Rgb(255, 0, 10)));
    }

    #[test]
    fn n7_a_transparent_color_is_not_a_background() {
        assert_eq!(parse_css_color("rgba(0, 0, 0, 0)"), None);
        assert_eq!(parse_css_color("rgb(0 0 0 / 0)"), None);
        assert_eq!(parse_css_color("rgb(0 0 0 / 0%)"), None);
        // 半透明は、色そのものを使う（背景は下の面と重ねて見えるため、近似でよい）。
        assert_eq!(
            parse_css_color("rgba(10, 20, 30, 0.5)"),
            Some(Rgb(10, 20, 30))
        );
    }

    #[test]
    fn n7_unreadable_strings_give_nothing() {
        for text in [
            "",
            "transparent",
            "red",
            "rgb(1, 2)",
            "rgb(1, 2, 3, 4, 5)",
            "rgb(a, b, c)",
            "#12",
            "#12345",
            "#ggg",
            "hsl(0, 0%, 50%)",
            "color(display-p3 1 0 0)",
            "rgb(1, 2, 3",
            "rgb 1 2 3)",
        ] {
            assert_eq!(parse_css_color(text), None, "{text:?}");
        }
    }
}
