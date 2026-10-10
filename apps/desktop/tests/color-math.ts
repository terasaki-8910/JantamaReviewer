/**
 * 色の計算（試験の道具）。トークンの値（16 進）と、実ブラウザが返す描画後の色（rgb() / color(srgb ...)）の両方から、
 * コントラスト比（WCAG）と OKLCH を求める。画面の部品ではないので、src には置かない。
 */

export interface Rgb {
  /** 0 から 255。 */
  r: number;
  g: number;
  b: number;
}

export interface Rgba extends Rgb {
  /** 0 から 1。 */
  a: number;
}

export interface Oklch {
  /** 明るさ（0 から 1）。 */
  L: number;
  /** 彩度。 */
  C: number;
  /** 色相（度。0 から 360 未満）。 */
  h: number;
}

/** `#RRGGBB` を読む。 */
export function parseHex(value: string): Rgb {
  const m = /^#([0-9a-f]{6})$/i.exec(value.trim());
  if (!m?.[1]) throw new Error(`読めない色（#RRGGBB のみ）: ${value}`);
  const n = Number.parseInt(m[1], 16);
  return { r: (n >> 16) & 255, g: (n >> 8) & 255, b: n & 255 };
}

/**
 * ブラウザが返す色の文字列を読む。`rgb(…)`・`rgba(…)`（カンマ区切りも空白区切りも）と `color(srgb r g b / a)`。
 * 読めなければ例外。
 */
export function parseCssColor(value: string): Rgba {
  const text = value.trim();
  const rgb = /^rgba?\(([^)]+)\)$/i.exec(text);
  if (rgb?.[1]) {
    const parts = rgb[1].split(/[\s,/]+/).filter(Boolean).map(Number);
    const [r, g, b, a] = parts;
    if (r === undefined || g === undefined || b === undefined || [r, g, b].some(Number.isNaN)) {
      throw new Error(`読めない色: ${value}`);
    }
    return { r, g, b, a: a === undefined ? 1 : a };
  }
  const srgb = /^color\(srgb ([^)]+)\)$/i.exec(text);
  if (srgb?.[1]) {
    const parts = srgb[1].split(/[\s/]+/).filter(Boolean).map(Number);
    const [r, g, b, a] = parts;
    if (r === undefined || g === undefined || b === undefined || [r, g, b].some(Number.isNaN)) {
      throw new Error(`読めない色: ${value}`);
    }
    return { r: r * 255, g: g * 255, b: b * 255, a: a === undefined ? 1 : a };
  }
  throw new Error(`読めない色: ${value}`);
}

/** 半透明の色を、下の色の上に重ねた結果の色にする。 */
export function over(top: Rgba, below: Rgb): Rgb {
  return {
    r: top.r * top.a + below.r * (1 - top.a),
    g: top.g * top.a + below.g * (1 - top.a),
    b: top.b * top.a + below.b * (1 - top.a),
  };
}

function srgbToLinear(channel255: number): number {
  const s = channel255 / 255;
  return s <= 0.04045 ? s / 12.92 : ((s + 0.055) / 1.055) ** 2.4;
}

/** WCAG の相対輝度。 */
export function luminance(c: Rgb): number {
  return 0.2126 * srgbToLinear(c.r) + 0.7152 * srgbToLinear(c.g) + 0.0722 * srgbToLinear(c.b);
}

/** WCAG のコントラスト比（1 から 21）。 */
export function contrast(a: Rgb, b: Rgb): number {
  const [hi, lo] = [luminance(a), luminance(b)].sort((x, y) => y - x) as [number, number];
  return (hi + 0.05) / (lo + 0.05);
}

/** sRGB を OKLCH にする（Björn Ottosson の OKLab の式）。 */
export function toOklch(c: Rgb): Oklch {
  const r = srgbToLinear(c.r);
  const g = srgbToLinear(c.g);
  const b = srgbToLinear(c.b);
  const l = Math.cbrt(0.4122214708 * r + 0.5363325363 * g + 0.0514459929 * b);
  const m = Math.cbrt(0.2119034982 * r + 0.6806995451 * g + 0.1073969566 * b);
  const s = Math.cbrt(0.0883024619 * r + 0.2817188376 * g + 0.6299787005 * b);
  const L = 0.2104542553 * l + 0.793617785 * m - 0.0040720468 * s;
  const a = 1.9779984951 * l - 2.428592205 * m + 0.4505937099 * s;
  const bb = 0.0259040371 * l + 0.7827717662 * m - 0.808675766 * s;
  return { L, C: Math.hypot(a, bb), h: (((Math.atan2(bb, a) * 180) / Math.PI) % 360 + 360) % 360 };
}

/** 色相の幅（度）。円の上で、すべての色相を含む最も短い弧の長さ。 */
export function hueSpread(hues: readonly number[]): number {
  if (hues.length < 2) return 0;
  const sorted = [...hues].sort((x, y) => x - y);
  let largestGap = 0;
  for (let i = 0; i < sorted.length; i += 1) {
    const current = sorted[i] as number;
    const next = (sorted[(i + 1) % sorted.length] as number) + (i === sorted.length - 1 ? 360 : 0);
    largestGap = Math.max(largestGap, next - current);
  }
  return 360 - largestGap;
}
