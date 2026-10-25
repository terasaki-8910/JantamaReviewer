/**
 * 卓の布・伏せた牌・中央の箱・王牌の列を、出題と通して見る画面で共通して測る道具。
 * 名札は置かず、4 人の点数は中央の箱に残る。
 */
import { expect } from 'vitest';
import type { Page } from 'playwright-core';

import { contrast, parseCssColor, type Rgb } from '../color-math';
import type { BoxRect } from './harness';

export interface Box extends BoxRect {
  width: number;
  height: number;
}

interface TextMeasure {
  name: string;
  text: string;
  color: string;
  background: string;
}

export interface BoardMeasure {
  table: Box;
  riverTile: Box | null;
  felt: string;
  center: Box;
  centerBackground: string;
  centerContent: { width: number; height: number; scrollWidth: number; scrollHeight: number };
  centerText: TextMeasure[];
  tokens: { felt: string; tileBack: string; surface: string };
  backColors: string[];
  scoresInCenter: number;
  nameplates: number;
  dora: {
    row: Box;
    aria: string;
    wall: Array<{ box: Box; back: boolean; hidden: boolean; background: string }>;
    mapped: Box[];
    labelShown: boolean;
    arrowShown: boolean;
    others: Array<{ name: string; box: Box }>;
    scroll: [number, number];
  } | null;
  viewport: { width: number; height: number; scrollWidth: number; scrollHeight: number; scrollX: number; scrollY: number };
}

/** 卓の描画結果を測る。 */
export async function measureBoard(page: Page): Promise<BoardMeasure> {
  return page.evaluate(() => {
    const box = (el: Element) => {
      const r = el.getBoundingClientRect();
      return { left: r.left, right: r.right, top: r.top, bottom: r.bottom, width: r.width, height: r.height };
    };
    const shown = (el: Element) => (el as HTMLElement).checkVisibility();
    const colorOf = (css: string) => {
      const probe = document.createElement('i');
      probe.style.backgroundColor = css;
      document.body.append(probe);
      const color = getComputedStyle(probe).backgroundColor;
      probe.remove();
      return color;
    };
    const table = document.querySelector('.table') as HTMLElement;
    const center = table.querySelector('.center') as HTMLElement;
    const centerStyle = getComputedStyle(center);
    const row = center.querySelector('.dora') as HTMLElement | null;
    const label = row?.querySelector('.dora-l') ?? null;
    const arrow = row?.querySelector('.dora-arrow') ?? null;
    const others = Array.from(center.querySelectorAll<HTMLElement>(':scope > .score, :scope > .info, :scope > .round-s'))
      .filter(shown)
      .map((el) => ({ name: el.className, box: box(el) }));
    const centerText = Array.from(center.querySelectorAll<HTMLElement>('.score .wind, .score .rel, .score .pts, .score .rch, .info > span, .round-s'))
      .filter((el) => shown(el) && el.getBoundingClientRect().width > 2 && (el.textContent ?? '').trim() !== '')
      .map((el) => {
        const style = getComputedStyle(el);
        return { name: el.className, text: (el.textContent ?? '').trim(), color: style.color, background: style.backgroundColor };
      });
    return {
      table: box(table),
      riverTile: table.querySelector('.river .tile') === null ? null : box(table.querySelector('.river .tile') as Element),
      felt: getComputedStyle(table).backgroundColor,
      center: box(center),
      centerBackground: centerStyle.backgroundColor,
      centerContent: { width: center.clientWidth, height: center.clientHeight, scrollWidth: center.scrollWidth, scrollHeight: center.scrollHeight },
      centerText,
      tokens: { felt: colorOf('var(--felt)'), tileBack: colorOf('var(--tile-back)'), surface: colorOf('var(--surface)') },
      backColors: Array.from(table.querySelectorAll('.tile.back')).map((tile) => getComputedStyle(tile).backgroundColor),
      scoresInCenter: center.querySelectorAll(':scope > .score').length,
      nameplates: table.querySelectorAll('.plate, .plates, .nm').length,
      dora:
        row === null
          ? null
          : {
              row: box(row),
              aria: row.getAttribute('aria-label') ?? '',
              wall: Array.from(row.querySelectorAll('.wall > .tile')).map((tile) => ({
                box: box(tile),
                back: tile.classList.contains('back'),
                hidden: tile.getAttribute('aria-hidden') === 'true' || tile.closest('[aria-hidden="true"]') !== null,
                background: getComputedStyle(tile).backgroundColor,
              })),
              mapped: Array.from(row.querySelectorAll('.dora-to .dora-t .tile')).map(box),
              labelShown: label !== null && shown(label),
              arrowShown: arrow !== null && shown(arrow),
              others,
              scroll: [row.scrollWidth, row.clientWidth] as [number, number],
            },
      viewport: {
        width: window.innerWidth,
        height: window.innerHeight,
        scrollWidth: document.documentElement.scrollWidth,
        scrollHeight: document.documentElement.scrollHeight,
        scrollX: window.scrollX,
        scrollY: window.scrollY,
      },
    };
  });
}

const rgb = (css: string): Rgb => {
  const value = parseCssColor(css);
  return { r: value.r, g: value.g, b: value.b };
};

const inside = (inner: BoxRect, outer: BoxRect, slack = 0.5) =>
  inner.left >= outer.left - slack && inner.right <= outer.right + slack && inner.top >= outer.top - slack && inner.bottom <= outer.bottom + slack;

const overlaps = (a: BoxRect, b: BoxRect) => a.left < b.right - 0.5 && b.left < a.right - 0.5 && a.top < b.bottom - 0.5 && b.top < a.bottom - 0.5;

/** 横スクロールが無く、文書の位置が横にずれていない。 */
export function expectNoHorizontalScroll(m: BoardMeasure, where: string): void {
  expect(m.viewport.scrollWidth, `${where} 横スクロール`).toBeLessThanOrEqual(m.viewport.width);
  expect(m.viewport.scrollX, `${where} 横位置`).toBe(0);
}

/** 布・背・中央の箱と文字の色、および名札が無いことを確かめる。 */
export function expectBoardContrast(m: BoardMeasure, where: string): void {
  expect(m.felt, `${where} 卓の背景`).toBe(m.tokens.felt);
  expect(m.centerBackground, `${where} 中央の箱の背景`).toBe(m.tokens.surface);
  expect(m.scoresInCenter, `${where} 点数は中央の箱の 4 辺`).toBe(4);
  expect(m.nameplates, `${where} 名札は無い`).toBe(0);
  expect(m.backColors.length, `${where} 伏せた牌がある`).toBeGreaterThan(0);
  for (const color of m.backColors) {
    expect(color, `${where} 伏せた牌の色`).toBe(m.tokens.tileBack);
    expect(contrast(rgb(color), rgb(m.felt)), `${where} 背と布のコントラスト`).toBeGreaterThanOrEqual(3);
  }
  for (const part of m.centerText) {
    const ownBackground = parseCssColor(part.background);
    const background = ownBackground.a === 0 ? rgb(m.centerBackground) : rgb(part.background);
    expect(contrast(rgb(part.color), background), `${where} 中央の文字 ${part.name}（${part.text}）`).toBeGreaterThanOrEqual(4.5);
  }
}

/** 王牌の列と「→ ドラ」が、中央の箱で折り返さず、ほかの情報と重ならない。 */
export function expectWallFits(m: BoardMeasure, where: string, options: { markers?: number } = {}): void {
  const dora = m.dora;
  expect(dora, `${where} 王牌の行`).not.toBeNull();
  if (dora === null) return;
  const markers = options.markers ?? dora.mapped.length;
  expect(dora.wall, `${where} 王牌は 7 枚`).toHaveLength(7);
  expect(dora.mapped, `${where} ドラの牌`).toHaveLength(markers);
  expect(dora.wall.flatMap((tile, index) => (tile.back ? [] : [index])), `${where} 表向きの位置`).toEqual(Array.from({ length: markers }, (_, index) => index + 2));
  const widths = dora.wall.map((tile) => tile.box.width);
  expect(Math.max(...widths) - Math.min(...widths), `${where} 王牌の幅`).toBeLessThanOrEqual(0.5);
  const wallTops = dora.wall.map((tile) => tile.box.top);
  expect(Math.max(...wallTops) - Math.min(...wallTops), `${where} 王牌は 1 行`).toBeLessThanOrEqual(0.5);
  if (dora.mapped.length > 1) {
    const mappedTops = dora.mapped.map((tile) => tile.top);
    expect(Math.max(...mappedTops) - Math.min(...mappedTops), `${where} ドラの牌は 1 行`).toBeLessThanOrEqual(0.5);
  }
  for (const tile of dora.wall) {
    expect(inside(tile.box, dora.row), `${where} 王牌が行に収まる`).toBe(true);
    if (tile.back) {
      expect(tile.hidden, `${where} 背は読み上げない`).toBe(true);
      expect(tile.background, `${where} 王牌の背の色`).toBe(m.tokens.tileBack);
    }
  }
  for (const tile of dora.mapped) expect(inside(tile, dora.row), `${where} ドラの牌が行に収まる`).toBe(true);
  expect(inside(dora.row, m.center), `${where} 行が中央の箱に収まる`).toBe(true);
  for (const other of dora.others) expect(overlaps(dora.row, other.box), `${where} ${other.name} と重ならない`).toBe(false);
  expect(dora.scroll[0], `${where} 行のあふれ`).toBeLessThanOrEqual(dora.scroll[1] + 0.5);
  expect(m.centerContent.scrollWidth, `${where} 中央の箱の横あふれ`).toBeLessThanOrEqual(m.centerContent.width + 0.5);
  expect(m.centerContent.scrollHeight, `${where} 中央の箱の縦あふれ`).toBeLessThanOrEqual(m.centerContent.height + 0.5);
  expect(dora.arrowShown, `${where} 矢印`).toBe(true);
  expect(dora.aria, `${where} 読み上げ`).toMatch(/^ドラ表示牌 .+、ドラ .+$/);
  const threshold = [0, 176, 194, 212, 230, 248][markers] ?? 248;
  if (m.centerContent.width < threshold) expect(dora.labelShown, `${where} 狭い箱では「ドラ」を隠す`).toBe(false);
}

/** 答える前後などで、卓と河の牌の大きさが変わらない。位置は文書の上の位置で比べる（狭い窓では、答えたあとにページがスクロールするため）。 */
export function expectSameTable(before: BoardMeasure, after: BoardMeasure, where: string): void {
  const placed = (m: BoardMeasure) => ({ left: m.table.left + m.viewport.scrollX, top: m.table.top + m.viewport.scrollY, width: m.table.width, height: m.table.height });
  const [a, b] = [placed(before), placed(after)];
  for (const key of ['left', 'top', 'width', 'height'] as const) {
    expect(Math.abs(a[key] - b[key]), `${where} 卓の ${key}`).toBeLessThanOrEqual(0.5);
  }
  expect(before.riverTile, `${where} 変更前の河の牌`).not.toBeNull();
  expect(after.riverTile, `${where} 変更後の河の牌`).not.toBeNull();
  if (before.riverTile !== null && after.riverTile !== null) {
    expect(Math.abs(before.riverTile.width - after.riverTile.width), `${where} 河の牌の幅`).toBeLessThanOrEqual(0.5);
  }
}
