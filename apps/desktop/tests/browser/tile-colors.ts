/**
 * 実ブラウザの検査（出題・通して見る画面の U-19）で使う、牌の描いた色を読む道具。
 * 牌の面の色は、牌を撮った絵から読む（CSS の値ではなく、描かれた色）。図柄の色は、牌の SVG（public/tiles）から集める。
 */
import { readFileSync, readdirSync } from 'node:fs';
import { join } from 'node:path';

import type { Locator, Page } from 'playwright-core';

import { parseHex, type Rgb } from '../color-math';

/** 描いた牌の面の色（牌の中の、図柄にかからない隅の 1 点）を、画面の絵から読む。 */
export async function faceColor(page: Page, tile: Locator): Promise<Rgb> {
  const png = await tile.screenshot({ type: 'png', animations: 'disabled' });
  const [r, g, b] = await page.evaluate(async (base64) => {
    const bytes = Uint8Array.from(atob(base64), (c) => c.charCodeAt(0));
    const bitmap = await createImageBitmap(new Blob([bytes], { type: 'image/png' }));
    const canvas = document.createElement('canvas');
    canvas.width = bitmap.width;
    canvas.height = bitmap.height;
    const context = canvas.getContext('2d');
    if (context === null) throw new Error('canvas が使えません');
    context.drawImage(bitmap, 0, 0);
    const x = Math.floor(bitmap.width * 0.1);
    const y = Math.floor(bitmap.height * 0.06);
    const data = context.getImageData(x, y, 1, 1).data;
    return [data[0] ?? 0, data[1] ?? 0, data[2] ?? 0];
  }, png.toString('base64'));
  return { r: r ?? 0, g: g ?? 0, b: b ?? 0 };
}

/** 牌の図柄（SVG）で使われている色（注釈・定義・見本の色を除く。白は面と同じ扱いなので除く）。 */
export function patternColors(): Rgb[] {
  const dir = join(import.meta.dirname, '../../public/tiles');
  const found = new Set<string>();
  for (const file of readdirSync(dir)) {
    if (!file.endsWith('.svg') || file === 'Front.svg') continue;
    const text = readFileSync(join(dir, file), 'utf8')
      .replace(/<metadata[\s\S]*?<\/metadata>/g, '')
      .replace(/<defs[\s\S]*?<\/defs>/g, '');
    for (const match of text.matchAll(/(?:fill|stroke)\s*[:=]\s*"?(#[0-9a-fA-F]{6})\b/g)) found.add((match[1] ?? '').toLowerCase());
    for (const match of text.matchAll(/(?:fill|stroke)\s*[:=]\s*"?rgb\((\d+),\s*(\d+),\s*(\d+)\)/g)) {
      found.add(`#${[match[1], match[2], match[3]].map((n) => Number(n).toString(16).padStart(2, '0')).join('')}`);
    }
  }
  found.delete('#ffffff');
  return [...found].map(parseHex);
}

export const multiply = (a: Rgb, b: Rgb): Rgb => ({ r: (a.r * b.r) / 255, g: (a.g * b.g) / 255, b: (a.b * b.b) / 255 });
