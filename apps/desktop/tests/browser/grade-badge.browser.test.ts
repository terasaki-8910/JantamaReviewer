// @vitest-environment node
/**
 * U-7 段階の印: 実ブラウザで、実際に描かれた色を読んで確かめる。
 * - S+〜B- の 9 段は 1 つの色相（OKLCH の色相の差が 10° 以内）で、明るさが段の順に単調に変わり、隣り合う段の差が 0.06 以上
 * - 印の文字と印の色のコントラストは全段で 4.5 以上
 * - C+〜E は塗らず、線だけ
 * ライトとダークの両方。印は、ページの面・選択中の行・カード・マウスを乗せた行の 4 つの面に置いて測る。
 * 印の HTML は、本物の部品（GradeBadge）を文字列にしたもの。色は、アプリの CSS が決めたものを getComputedStyle で読む。
 */
import { createElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import type { Browser, Page } from 'playwright-core';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import { DISPLAY_GRADES, FILLED_GRADES, GradeBadge } from '../../src/main/GradeBadge';
import { contrast, hueSpread, over, parseCssColor, parseHex, toOklch, type Rgb, type Rgba } from '../color-math';
import { readTokenThemes, resolveToken } from '../tokens-css';
import { launchBrowser, startPageServer, TINY_PNG, tauriMockScript, type PageServer } from './harness';

const SCHEMES = ['light', 'dark'] as const;
type Scheme = (typeof SCHEMES)[number];

const SURFACES = ['ページの上', '選択中の行', 'カードの上', 'マウスを乗せた行'] as const;

let server: PageServer;
let browser: Browser;

beforeAll(async () => {
  server = await startPageServer();
  browser = await launchBrowser();
});

afterAll(async () => {
  await browser?.close();
  await server?.close();
});

interface Painted {
  surface: string;
  grade: string;
  size: string;
  color: string;
  background: string;
  border: string;
  /** その印から html までの、背景色（内側から外側へ。透明のものも含む）。 */
  chain: string[];
}

/** 14 段階の印を、4 つの面に（小さいものと大きいものを）置いて、描かれた色を読む。 */
async function paintBadges(scheme: Scheme): Promise<Painted[]> {
  const context = await browser.newContext({
    viewport: { width: 1280, height: 800 },
    colorScheme: scheme,
    reducedMotion: 'reduce',
  });
  try {
    const page: Page = await context.newPage();
    await page.addInitScript(
      tauriMockScript({
        label: 'main',
        state: { status: 'idle', session_id: null, mark_count: 0, ratings: [], next_hand: 1, can_undo: false, error: null },
        settings: { trigger: { kind: 'mouse_x1' }, orientation: 'vertical', widget_position: null, sound: true, capture_keywords: [], data_dir: 'C:\\x' },
        sessions: [],
        thumb: TINY_PNG,
      }),
    );
    await page.goto(new URL('index.html', server.url).toString());
    await page.locator('.side').waitFor();
    const small = DISPLAY_GRADES.map((grade) => renderToStaticMarkup(createElement(GradeBadge, { grade }))).join(' ');
    const large = DISPLAY_GRADES.map((grade) =>
      renderToStaticMarkup(createElement(GradeBadge, { grade, size: 'lg' })),
    ).join(' ');
    return await page.evaluate(
      ({ small: smallHtml, large: largeHtml, surfaces }) => {
        const host = document.createElement('div');
        host.setAttribute('data-test-host', '');
        host.style.cssText = 'position:fixed;left:0;top:0;z-index:99;display:grid;gap:4px;padding:8px';
        const rows: Array<{ name: string; row: HTMLElement }> = [];
        const make = (name: string, attributes: Record<string, string>) => {
          const row = document.createElement('div');
          for (const [key, value] of Object.entries(attributes)) row.setAttribute(key, value);
          row.style.cssText = `${row.style.cssText};display:flex;flex-wrap:wrap;gap:6px;padding:6px`;
          rows.push({ name, row });
          host.append(row);
          return row;
        };
        // 色はトークンから（ここにも色の値は書かない）。
        make(surfaces[0] as string, { style: 'background: var(--bg)' });
        make(surfaces[1] as string, { class: 'session-row', 'aria-current': 'true' });
        make(surfaces[2] as string, { style: 'background: var(--surface)' });
        make(surfaces[3] as string, { style: 'background: var(--hover)' });
        for (const { row } of rows) {
          row.innerHTML = smallHtml;
          const bigRow = document.createElement('div');
          bigRow.style.cssText = 'display:flex;flex-wrap:wrap;gap:8px;width:100%';
          bigRow.innerHTML = largeHtml;
          row.append(bigRow);
        }
        document.body.append(host);

        const out: Painted[] = [];
        for (const { name, row } of rows) {
          for (const badge of Array.from(row.querySelectorAll<HTMLElement>('.grade'))) {
            const style = getComputedStyle(badge);
            const chain: string[] = [];
            for (let el: HTMLElement | null = badge; el; el = el.parentElement) {
              chain.push(getComputedStyle(el).backgroundColor);
            }
            out.push({
              surface: name,
              grade: badge.getAttribute('data-grade') ?? '',
              size: badge.classList.contains('lg') ? 'lg' : 'sm',
              color: style.color,
              background: style.backgroundColor,
              border: style.borderTopColor,
              chain,
            });
          }
        }
        host.remove();
        return out;
      },
      { small, large, surfaces: [...SURFACES] },
    );
  } finally {
    await context.close();
  }
}

interface Painted2 extends Painted {
  fg: Rgba;
  bg: Rgba;
  effective: Rgb;
}

function decode(list: Painted[]): Painted2[] {
  return list.map((p) => {
    const fg = parseCssColor(p.color);
    const bg = parseCssColor(p.background);
    // 何も塗られていない下地は白（ブラウザの既定）。外側から順に重ねる。
    let effective: Rgb = { r: 255, g: 255, b: 255 };
    for (const color of [...p.chain].reverse()) effective = over(parseCssColor(color), effective);
    return { ...p, fg, bg, effective };
  });
}

const tokenThemes = readTokenThemes();
const rgbOf = (c: Rgba): Rgb => ({ r: c.r, g: c.g, b: c.b });

for (const scheme of SCHEMES) {
  describe(`U-7 段階の印（描かれた色） ${scheme}`, () => {
    let painted: Painted2[];

    beforeAll(async () => {
      painted = decode(await paintBadges(scheme));
    });

    it('14 段階 × 大小 × 4 つの面が、すべて描かれている', () => {
      expect(painted).toHaveLength(14 * 2 * SURFACES.length);
      for (const surface of SURFACES) {
        for (const size of ['sm', 'lg']) {
          const grades = painted.filter((p) => p.surface === surface && p.size === size).map((p) => p.grade);
          expect(grades, `${surface} ${size}`).toEqual([...DISPLAY_GRADES]);
        }
      }
    });

    it('描かれた塗りの色が、トークン（--gr1-bg から --gr9-bg）の値と同じ（段階とトークンの対応が合っている）', () => {
      const themeName = scheme === 'light' ? 'light' : 'dark';
      for (const [index, grade] of FILLED_GRADES.entries()) {
        const expected = parseHex(resolveToken(tokenThemes, themeName, `--gr${index + 1}-bg`));
        const letters = parseHex(resolveToken(tokenThemes, themeName, `--gr${index + 1}-fg`));
        for (const p of painted.filter((x) => x.grade === grade)) {
          expect([p.bg.r, p.bg.g, p.bg.b], `${grade} の塗り`).toEqual([expected.r, expected.g, expected.b]);
          expect([p.fg.r, p.fg.g, p.fg.b], `${grade} の文字`).toEqual([letters.r, letters.g, letters.b]);
          expect(p.bg.a, `${grade} の塗りは不透明`).toBe(1);
        }
      }
    });

    it('S+〜B- の 9 段は、1 つの色相（OKLCH の色相の差が 10° 以内）', () => {
      const first = painted.filter((p) => p.surface === SURFACES[0] && p.size === 'sm');
      const hues = FILLED_GRADES.map((g) => toOklch(rgbOf((first.find((p) => p.grade === g) as Painted2).bg)).h);
      expect(hueSpread(hues), `色相 ${hues.map((h) => h.toFixed(1)).join(' ')}`).toBeLessThanOrEqual(10);
    });

    it('明るさが段の順に単調に変わり、隣り合う段の差が 0.06 以上', () => {
      const first = painted.filter((p) => p.surface === SURFACES[0] && p.size === 'sm');
      const lightness = FILLED_GRADES.map((g) => toOklch(rgbOf((first.find((p) => p.grade === g) as Painted2).bg)).L);
      const direction = scheme === 'light' ? 1 : -1;
      for (let i = 1; i < lightness.length; i += 1) {
        const gap = ((lightness[i] as number) - (lightness[i - 1] as number)) * direction;
        expect(gap, `${FILLED_GRADES[i - 1]} → ${FILLED_GRADES[i]}: ${gap.toFixed(4)}`).toBeGreaterThanOrEqual(0.06);
      }
    });

    it('印の文字と印の色のコントラストが、全段・全部の面・大小で 4.5 以上', () => {
      const failures: string[] = [];
      for (const p of painted) {
        // 印の文字の後ろにあるのは、塗りのある印なら塗り、線だけの印なら、置かれた面（effective は、印自身の背景も含めて重ねた色）。
        const behind: Rgb = p.effective;
        const text = p.fg.a < 1 ? over(p.fg, behind) : rgbOf(p.fg);
        const ratio = contrast(text, behind);
        if (ratio < 4.5) failures.push(`${p.surface} ${p.size} ${p.grade}: ${ratio.toFixed(2)}`);
      }
      expect(failures).toEqual([]);
    });

    it('C+〜E は塗らず（透明）、線だけ。線と文字の色は 5 つとも同じ', () => {
      const outline = painted.filter((p) => !FILLED_GRADES.includes(p.grade as (typeof FILLED_GRADES)[number]));
      expect(outline.length).toBe(5 * 2 * SURFACES.length);
      for (const p of outline) {
        expect(p.bg.a, `${p.grade} の背景は塗らない`).toBe(0);
      }
      const keys = new Set(outline.map((p) => `${p.surface}|${p.border}|${p.color}`));
      expect(keys.size, '面ごとに、線と文字の色は 1 通り').toBe(SURFACES.length);
      for (const p of outline) {
        const line = parseCssColor(p.border);
        expect(line.a, `${p.grade} の線は見える`).toBeGreaterThan(0);
      }
    });

    it('塗りのある印は、線の色も塗りと同じ（輪郭が浮かない）', () => {
      for (const p of painted.filter((x) => FILLED_GRADES.includes(x.grade as (typeof FILLED_GRADES)[number]))) {
        expect(p.border, `${p.grade}`).toBe(p.background);
      }
    });
  });
}
