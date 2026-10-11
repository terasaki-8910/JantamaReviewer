// @vitest-environment node
/**
 * U-26（R11-5）: 見出しの検索のアイコンに、緑の塗り・緑の輪を付けない（CSS のソースと、トークンの値の検査）。
 * 実際に描かれた色（重ね表示が開いている間・閉じたあと・キーボードで選んだとき）は、tests/browser/shell.browser.test.ts が確かめる。
 */
import { readFileSync, readdirSync } from 'node:fs';
import { join, resolve } from 'node:path';

import { describe, expect, it } from 'vitest';

import { contrast, over, parseHex } from './color-math';
import { readTokenThemes, resolveToken } from './tokens-css';

const STYLES = resolve(import.meta.dirname, '../src/styles');

/** CSS のコメントを除いて、`セレクタ { 宣言 }` の組にする（入れ子の @media の中も平らに読む）。 */
function rules(css: string): Array<{ selector: string; body: string }> {
  const code = css.replace(/\/\*[\s\S]*?\*\//g, '');
  const out: Array<{ selector: string; body: string }> = [];
  for (const match of code.matchAll(/([^{}]+)\{([^{}]*)\}/g)) {
    const selector = (match[1] ?? '').trim();
    if (selector.startsWith('@')) continue;
    out.push({ selector, body: match[2] ?? '' });
  }
  return out;
}

/** 緑（accent・focus）のトークン。 */
const GREEN_TOKENS = ['--accent', '--accent-fill', '--accent-bar', '--accent-strong', '--focus'];

function searchButtonRules() {
  const found: Array<{ file: string; selector: string; body: string }> = [];
  for (const file of readdirSync(STYLES).filter((name) => name.endsWith('.css'))) {
    for (const rule of rules(readFileSync(join(STYLES, file), 'utf8'))) {
      // 検索のアイコンに当たる規則（`.search-btn` を含み、`.search-btn` が最後の部品のもの）
      if (/\.search-btn(?![\w-])/.test(rule.selector)) found.push({ file, ...rule });
    }
  }
  return found;
}

describe('U-26 見出しの検索のアイコン: 緑の塗り・緑の輪は付けない', () => {
  it('検索のアイコンの規則が見つかる（検査が空振りしていない）', () => {
    const found = searchButtonRules();
    expect(found.length).toBeGreaterThanOrEqual(3);
    expect(found.map((rule) => rule.selector)).toContain('.search-btn[aria-expanded="true"]');
    expect(found.map((rule) => rule.selector)).toContain('.search-btn:focus-visible');
  });

  it('検索のアイコンに当たる規則は、緑のトークン（accent・focus）を 1 つも使わない', () => {
    for (const rule of searchButtonRules()) {
      for (const token of GREEN_TOKENS) {
        expect(rule.body, `${rule.file} ${rule.selector}`).not.toContain(`var(${token})`);
      }
    }
  });

  it('開いている間（aria-expanded=true）は、灰色の塗り（--hover）。キーボードで選んだときの輪は、灰色（--muted）', () => {
    const rule = (selector: string) => searchButtonRules().find((r) => r.selector === selector)?.body ?? '';
    expect(rule('.search-btn[aria-expanded="true"]')).toMatch(/background:\s*var\(--hover\)/);
    expect(rule('.search-btn:focus-visible')).toMatch(/outline-color:\s*var\(--muted\)/);
  });

  it('輪の色（--muted）は、サイドバーと本文の背景（--bg）に対して、ライト・ダークとも 3:1 以上。灰色（赤・緑・青の差が小さい）', () => {
    const themes = readTokenThemes();
    for (const theme of ['light', 'dark'] as const) {
      const ring = parseHex(resolveToken(themes, theme, '--muted'));
      const background = parseHex(resolveToken(themes, theme, '--bg'));
      expect(contrast(ring, background), theme).toBeGreaterThanOrEqual(3);
      // 灰色: 3 つの値の差が 1 割以内（緑や青みが無い）
      const spread = Math.max(ring.r, ring.g, ring.b) - Math.min(ring.r, ring.g, ring.b);
      expect(spread, theme).toBeLessThanOrEqual(8);
    }
  });

  it('開いている間の塗り（--hover）は、背景の上で、緑ではなく灰色になる（ink の透明な重ね）', () => {
    const themes = readTokenThemes();
    for (const theme of ['light', 'dark'] as const) {
      const ink = parseHex(resolveToken(themes, theme, '--ink'));
      const background = parseHex(resolveToken(themes, theme, '--bg'));
      // --hover は color-mix(in srgb, var(--ink) 7%, transparent)。ink の 7% を背景に重ねた色
      const filled = over({ ...ink, a: 0.07 }, background);
      const spread = Math.max(filled.r, filled.g, filled.b) - Math.min(filled.r, filled.g, filled.b);
      expect(spread, theme).toBeLessThanOrEqual(8);
    }
  });
});
