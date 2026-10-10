// @vitest-environment node
/**
 * U-7 段階の印の色（トークンの値そのものの検査）。
 * - 印の色はトークンで定義される。S+〜B- の 9 段は 1 つの色相（OKLCH の色相の差が 10° 以内）
 * - 明るさが段の順に単調に変わり、隣り合う段の差が 0.06 以上（ライト・ダークそれぞれ）
 * - 印の文字と印の色のコントラストは全段で 4.5 以上
 * - C+〜E は塗らず、線だけ
 * 実際に描かれた色は、実ブラウザの検査（tests/browser/grade-badge.browser.test.ts）が読み返して確かめる。
 */
import { describe, expect, it } from 'vitest';

import { contrast, hueSpread, parseHex, toOklch } from './color-math';
import { readTokenThemes, resolveToken, type ThemeName } from './tokens-css';

/** 塗りの 9 段（強い順）。トークンの番号は 1 から 9。 */
const FILLED_STEPS = [1, 2, 3, 4, 5, 6, 7, 8, 9] as const;

const THEMES: readonly ThemeName[] = ['light', 'dark', 'darkViaMedia'];

const themes = readTokenThemes();

function fills(theme: ThemeName): string[] {
  return FILLED_STEPS.map((n) => resolveToken(themes, theme, `--gr${n}-bg`));
}

function texts(theme: ThemeName): string[] {
  return FILLED_STEPS.map((n) => resolveToken(themes, theme, `--gr${n}-fg`));
}

describe('U-7: 段階の印の色（トークン）', () => {
  it('9 段の塗りと文字の色が、ライトと、ダークの 2 つの書き方のすべてに定義されている', () => {
    for (const n of FILLED_STEPS) {
      expect(themes.light.has(`--gr${n}-bg`), `light --gr${n}-bg`).toBe(true);
      for (const theme of ['dark', 'darkViaMedia'] as const) {
        expect(themes[theme].has(`--gr${n}-bg`), `${theme} --gr${n}-bg`).toBe(true);
        expect(themes[theme].has(`--gr${n}-fg`), `${theme} --gr${n}-fg`).toBe(true);
      }
    }
    for (const theme of THEMES) {
      for (const hex of fills(theme)) expect(hex, theme).toMatch(/^#[0-9A-F]{6}$/i);
    }
  });

  it('OS に従うダークと、手で選んだダークは、同じ値を持つ', () => {
    for (const n of FILLED_STEPS) {
      for (const kind of ['bg', 'fg'] as const) {
        const name = `--gr${n}-${kind}`;
        expect(themes.darkViaMedia.get(name), name).toBe(themes.dark.get(name));
      }
    }
    for (const name of ['--scrim-soft', '--menu-shadow']) {
      expect(themes.darkViaMedia.get(name), name).toBe(themes.dark.get(name));
    }
  });

  for (const theme of THEMES) {
    describe(theme, () => {
      const lch = fills(theme).map((hex) => toOklch(parseHex(hex)));

      it('9 段は 1 つの色相（OKLCH の色相の差が 10° 以内）', () => {
        const spread = hueSpread(lch.map((c) => c.h));
        expect(spread, `色相の幅 ${spread.toFixed(2)}°`).toBeLessThanOrEqual(10);
      });

      it('明るさが段の順に単調に変わり、隣り合う段の差が 0.06 以上', () => {
        // 強さ = 面からの遠さ。ライトは濃いほど強く（明るさは増えていく）、ダークは淡いほど強い（明るさは減っていく）。
        const direction = theme === 'light' ? 1 : -1;
        const gaps = lch.slice(1).map((c, i) => (c.L - (lch[i] as { L: number }).L) * direction);
        for (const [i, gap] of gaps.entries()) {
          expect(gap, `段 ${i + 1} → ${i + 2} の明るさの差 ${gap.toFixed(4)}`).toBeGreaterThanOrEqual(0.06);
        }
      });

      it('印の文字と印の色のコントラストが、全段で 4.5 以上', () => {
        const colors = fills(theme);
        const letters = texts(theme);
        for (const [i, fill] of colors.entries()) {
          const ratio = contrast(parseHex(letters[i] as string), parseHex(fill));
          expect(ratio, `段 ${i + 1} ${letters[i]} / ${fill}`).toBeGreaterThanOrEqual(4.5);
        }
      });

      it('いちばん弱い段（B-）も、ページの面とカードの面の上で見分けがつく（2 以上）', () => {
        const weakest = parseHex(fills(theme)[8] as string);
        for (const surface of ['--bg', '--surface']) {
          const ratio = contrast(weakest, parseHex(resolveToken(themes, theme, surface)));
          expect(ratio, `B- と ${surface}`).toBeGreaterThanOrEqual(2);
        }
      });

      it('C+〜E の印は塗らず、線と控えめな文字の色だけ', () => {
        expect(resolveToken(themes, theme, '--grn-bg')).toBe('transparent');
        expect(resolveToken(themes, theme, '--grn-fg')).toBe(resolveToken(themes, theme, '--muted'));
        expect(themes.light.get('--grn-bd')).toBe('var(--line-strong)');
        // 線の上の文字（muted）は、ページの面とカードの面の上で読める。
        for (const surface of ['--bg', '--surface']) {
          const ratio = contrast(
            parseHex(resolveToken(themes, theme, '--grn-fg')),
            parseHex(resolveToken(themes, theme, surface)),
          );
          expect(ratio, `C+〜E の文字と ${surface}`).toBeGreaterThanOrEqual(4.5);
        }
      });
    });
  }

  it('検査の道具そのものが働いている（わざと外れた色の並びを、見つけられる）', () => {
    // 色相が離れている・明るさが逆転している・差が小さい並びは、上の検査で落ちる値になる。
    const green = toOklch(parseHex('#1B6A49'));
    const red = toOklch(parseHex('#B3261E'));
    expect(hueSpread([green.h, red.h])).toBeGreaterThan(10);
    const near = toOklch(parseHex('#136C47')).L - toOklch(parseHex('#0C583A')).L;
    expect(Math.abs(near)).toBeGreaterThan(0.06); // 承認済みの隣り合う段は 0.06 以上離れている
    expect(Math.abs(toOklch(parseHex('#136C47')).L - toOklch(parseHex('#146E48')).L)).toBeLessThan(0.06);
    expect(contrast(parseHex('#777777'), parseHex('#888888'))).toBeLessThan(4.5);
    // 円の端をまたぐ色相の幅（350° と 10° は 20° 離れている）。
    expect(hueSpread([350, 10])).toBeCloseTo(20, 5);
  });
});
