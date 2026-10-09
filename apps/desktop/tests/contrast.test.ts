// @vitest-environment node
/**
 * U-6: ライトとダークの両方で、本文と背景のコントラストが WCAG AA を満たす（トークンの値そのものの検査）。
 * 実際に描かれた画面のコントラストは、実ブラウザでの axe の検査（tests/browser）が確かめる。
 */
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';

import { describe, expect, it } from 'vitest';

const TOKENS = readFileSync(
  fileURLToPath(new URL('../src/styles/tokens.css', import.meta.url)),
  'utf8',
);

type Rgba = { r: number; g: number; b: number; a: number };

/** `selector { ... }` の中身（波括弧の対応を見て取り出す）。 */
function blockAfter(css: string, selector: string): string {
  const start = css.indexOf(selector);
  if (start < 0) throw new Error(`セレクタが見つからない: ${selector}`);
  const open = css.indexOf('{', start);
  let depth = 0;
  for (let i = open; i < css.length; i += 1) {
    if (css[i] === '{') depth += 1;
    if (css[i] === '}') {
      depth -= 1;
      if (depth === 0) return css.slice(open + 1, i);
    }
  }
  throw new Error(`波括弧が閉じていない: ${selector}`);
}

function declarations(block: string): Map<string, string> {
  const map = new Map<string, string>();
  for (const match of block.matchAll(/(--[a-z0-9-]+)\s*:\s*([^;]+);/g)) {
    const name = match[1];
    const value = match[2];
    if (name && value) map.set(name, value.trim());
  }
  return map;
}

function parseColor(value: string): Rgba {
  const hex = /^#([0-9a-f]{6})$/i.exec(value);
  if (hex?.[1]) {
    const n = Number.parseInt(hex[1], 16);
    return { r: (n >> 16) & 255, g: (n >> 8) & 255, b: n & 255, a: 1 };
  }
  const fn = /^rgba?\(\s*(\d+)\s*,\s*(\d+)\s*,\s*(\d+)\s*(?:,\s*([\d.]+)\s*)?\)$/i.exec(value);
  if (fn) {
    return { r: Number(fn[1]), g: Number(fn[2]), b: Number(fn[3]), a: fn[4] ? Number(fn[4]) : 1 };
  }
  throw new Error(`読めない色: ${value}`);
}

/** 半透明の色を、下の色の上に重ねた結果の色にする。 */
function over(top: Rgba, below: Rgba): Rgba {
  const a = top.a;
  return {
    r: top.r * a + below.r * (1 - a),
    g: top.g * a + below.g * (1 - a),
    b: top.b * a + below.b * (1 - a),
    a: 1,
  };
}

function luminance(c: Rgba): number {
  const channel = (v: number) => {
    const s = v / 255;
    return s <= 0.03928 ? s / 12.92 : ((s + 0.055) / 1.055) ** 2.4;
  };
  return 0.2126 * channel(c.r) + 0.7152 * channel(c.g) + 0.0722 * channel(c.b);
}

function contrast(a: Rgba, b: Rgba): number {
  const [hi, lo] = [luminance(a), luminance(b)].sort((x, y) => y - x) as [number, number];
  return (hi + 0.05) / (lo + 0.05);
}

const themes = {
  light: declarations(blockAfter(TOKENS, ':root {')),
  dark: declarations(blockAfter(TOKENS, ':root[data-theme="dark"]')),
};
const darkViaMedia = declarations(blockAfter(TOKENS, ':root:not([data-theme="light"])'));

function color(theme: keyof typeof themes, name: string): Rgba {
  const value = themes[theme].get(name);
  if (!value) throw new Error(`トークンが無い: ${theme} ${name}`);
  return parseColor(value);
}

describe('デザイントークンのコントラスト（U-6）', () => {
  it('OS の設定に従うダークと、手で選んだダークは、同じ値を持つ', () => {
    for (const [name, value] of themes.dark) {
      if (!name.startsWith('--') || !darkViaMedia.has(name)) continue;
      expect(darkViaMedia.get(name), name).toBe(value);
    }
    // 色に関わるトークンは、両方の書き方にそろっている。
    for (const name of ['--bg', '--surface', '--ink', '--muted', '--accent', '--accent-fill', '--on-accent']) {
      expect(darkViaMedia.has(name), `media にある ${name}`).toBe(true);
    }
  });

  for (const theme of ['light', 'dark'] as const) {
    describe(theme, () => {
      const bg = () => color(theme, '--bg');
      const surface = () => color(theme, '--surface');
      const accentFillOver = (base: Rgba) => over(color(theme, '--accent-fill'), base);

      it('本文（ink）は、ページの面とカードの面の上で 4.5 以上', () => {
        expect(contrast(color(theme, '--ink'), bg())).toBeGreaterThanOrEqual(4.5);
        expect(contrast(color(theme, '--ink'), surface())).toBeGreaterThanOrEqual(4.5);
      });

      it('補助の文字（muted）は、ページの面とカードの面の上で 4.5 以上', () => {
        expect(contrast(color(theme, '--muted'), bg())).toBeGreaterThanOrEqual(4.5);
        expect(contrast(color(theme, '--muted'), surface())).toBeGreaterThanOrEqual(4.5);
      });

      it('選択中の行・迷いのボタン（accent の淡い塗り）の上の文字は 4.5 以上', () => {
        for (const base of [bg(), surface()]) {
          const fill = accentFillOver(base);
          expect(contrast(color(theme, '--ink'), fill)).toBeGreaterThanOrEqual(4.5);
          expect(contrast(color(theme, '--muted'), fill)).toBeGreaterThanOrEqual(4.5);
        }
      });

      it('accent の塗りの上の文字（on-accent）は 4.5 以上', () => {
        expect(contrast(color(theme, '--on-accent'), color(theme, '--accent'))).toBeGreaterThanOrEqual(4.5);
      });

      it('accent・focus は、面の上で 3 以上（アイコン・点・フォーカスの輪郭）', () => {
        for (const base of [bg(), surface()]) {
          expect(contrast(color(theme, '--accent'), base)).toBeGreaterThanOrEqual(3);
          expect(contrast(color(theme, '--focus'), base)).toBeGreaterThanOrEqual(3);
        }
      });
    });
  }
});
