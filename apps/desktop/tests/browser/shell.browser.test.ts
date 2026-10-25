// @vitest-environment node
/**
 * 実ブラウザで、サイドバーの出す・しまう・引き出しと、見出しの検索のアイコンを検査する（U-32・U-26・U-4・U-5・U-6）。
 *
 * - U-32: 640px 未満ではサイドバーが隠れ、本文が左端（16px 以内）から始まる。左上のボタンで、サイドバー全体が引き出しとして幕つきで開く。
 *   幕・裏側は操作できず、Tab は引き出しの中だけを回る。項目を選ぶ・Esc・幕を押す・中のボタンで閉じて、ボタンにキーボードの位置が戻る。
 *   640px 以上では同じボタンでサイドバーをしまえて、起動し直しても（ページを読み直しても）しまったまま
 * - U-26: 見出しの検索のアイコンは、重ね表示が開いている間も、閉じたあとも、緑の塗り・緑の輪が付かない。
 *   キーボードで選んだときの輪は灰色で、背景との差が 3:1 以上
 * - U-4・U-5・U-6: 幅 390・600・768・1280px・ライトとダークで、横スクロールが出ず、axe の重大な違反が 0 件
 * jsdom の試験（src/main/Drawer.test.tsx）と同じふるまいを、実際の描画・キー・保存領域で確かめる。
 */
import type { Browser, BrowserContext, Page } from 'playwright-core';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import { contrast, over, parseCssColor, type Rgb } from '../color-math';
import { REPORT_TEXTS, folderName, local, seedSession } from '../fake-sessions';
import { fx4Ocr, fx4Session } from '../import-fixtures';
import {
  TINY_PNG,
  launchBrowser,
  runAxe,
  seriousViolations,
  startPageServer,
  tauriMockScript,
  waitForMainReady,
  waitForSidebarCounts,
  type PageServer,
  type Scenario,
} from './harness';

const SCHEMES = ['light', 'dark'] as const;
type Scheme = (typeof SCHEMES)[number];

/** 試験の「いま」: 2026 年 10 月 9 日 22:00。 */
const NOW = new Date(2026, 9, 9, 22, 0, 0);

const baseState = { status: 'idle', session_id: null, mark_count: 0, ratings: [], next_hand: 1, can_undo: false, error: null };
const baseSettings = {
  trigger: { kind: 'mouse_x1' },
  orientation: 'vertical',
  widget_position: null,
  sound: true,
  capture_keywords: ['雀魂', 'Mahjong Soul'],
  data_dir: 'C:\\Users\\someone\\JantamaReviewerData',
  daily_count: 5,
  highlight_dora: false,
};

const FX4_AT = local(2026, 10, 9, 19, 9);
const FX4_ID = folderName(FX4_AT);
const FX1A_AT = local(2026, 10, 9, 17, 12);
const FX1A_ID = folderName(FX1A_AT);

/** FX-4（読み取りの写しつき）と、FX-1 の 3 半荘、結果を取り込む前の半荘。新しい順。 */
function scenario(): Scenario {
  const others = [
    { at: local(2026, 10, 8, 21, 40), report: 'fx1d' as const },
    { at: local(2026, 10, 8, 20, 55), report: 'fx1c' as const },
    { at: local(2026, 10, 7, 22, 10), report: 'fx1b' as const },
  ];
  const sessions = [
    fx4Session(FX4_ID, FX4_AT, { report_path: `C:\\data\\games\\${FX4_ID}\\report.json`, ocr: fx4Ocr() }),
    seedSession(FX1A_AT, { id: FX1A_ID, report: 'fx1a' }).session,
    ...others.map((o) => seedSession(o.at, { report: o.report }).session),
    seedSession(local(2026, 10, 2, 22, 5), { marks: 1 }).session,
  ];
  const reports: Record<string, string> = {
    [FX4_ID]: REPORT_TEXTS.fx4,
    [FX1A_ID]: REPORT_TEXTS.fx1a,
    ...Object.fromEntries(others.map((o) => [folderName(o.at), REPORT_TEXTS[o.report]])),
  };
  return {
    label: 'main',
    state: baseState,
    settings: baseSettings,
    inputStatus: null,
    sessions,
    reports,
    thumb: TINY_PNG,
    answers: [],
  };
}

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

interface Opened {
  context: BrowserContext;
  page: Page;
  problems: string[];
  external: string[];
}

interface OpenOptions {
  width?: number;
  height?: number;
  scheme?: Scheme;
}

/** 新しい窓（保存領域は空）で開く。同じ窓で開き直すときは、`reopen` を使う。 */
async function open(options: OpenOptions = {}): Promise<Opened> {
  const height = options.height ?? ((options.width ?? 1280) < 640 ? 844 : 800);
  const context = await browser.newContext({
    viewport: { width: options.width ?? 1280, height },
    colorScheme: options.scheme ?? 'light',
    reducedMotion: 'reduce',
    deviceScaleFactor: 1,
  });
  const page = await context.newPage();
  const problems: string[] = [];
  const external: string[] = [];
  const origin = new URL(server.url).origin;
  page.on('pageerror', (error) => problems.push(`pageerror: ${error.message}`));
  page.on('console', (message) => {
    if (message.type() === 'error') problems.push(`console.error: ${message.text()}`);
  });
  page.on('request', (request) => {
    const url = request.url();
    if (!url.startsWith(origin) && !url.startsWith('data:') && !url.startsWith('blob:')) external.push(url);
  });
  await page.clock.setFixedTime(NOW);
  await page.addInitScript(tauriMockScript(scenario()));
  await page.goto(new URL('index.html', server.url).toString());
  await waitForMainReady(page);
  await waitForSidebarCounts(page, 30_000);
  return { context, page, problems, external };
}

/** 同じ窓（保存領域はそのまま）でページを読み直す（アプリを起動し直したのと同じ）。 */
async function reopen(page: Page): Promise<void> {
  await page.reload();
  await waitForMainReady(page);
  await waitForSidebarCounts(page, 30_000);
}

const dialog = (page: Page) => page.getByRole('dialog', { name: '検索' });
const topToggle = (page: Page) => page.locator('header.topbar .sb-toggle');
const sideToggle = (page: Page) => page.locator('#sidebar .sb-toggle');
const isTopToggleFocused = (page: Page) =>
  page.evaluate(() => document.activeElement === document.querySelector('header.topbar .sb-toggle'));

interface Rect {
  left: number;
  right: number;
  top: number;
  bottom: number;
  width: number;
  height: number;
}

/** 配置と状態をまとめて読む。 */
async function layout(page: Page) {
  return page.evaluate(() => {
    const rect = (el: Element | null): Rect | null => {
      if (el === null) return null;
      const r = el.getBoundingClientRect();
      return { left: r.left, right: r.right, top: r.top, bottom: r.bottom, width: r.width, height: r.height };
    };
    const side = document.getElementById('sidebar') as HTMLElement;
    const sideStyle = getComputedStyle(side);
    const sideRect = side.getBoundingClientRect();
    const main = document.querySelector('main.main') as HTMLElement;
    const topbar = document.querySelector('header.topbar');
    const scrim = document.querySelector('.scrim');
    const scrimRect = rect(scrim);
    const head = document.querySelector('main .head');
    const title = document.querySelector('main h1');
    const page = document.querySelector('main .page');
    const labels = [...side.querySelectorAll('.nav-item .label')].map((el) => (getComputedStyle(el).position === 'absolute' ? '(隠れている)' : (el.textContent ?? '').trim()));
    return {
      iw: window.innerWidth,
      ih: window.innerHeight,
      sw: document.documentElement.scrollWidth,
      bw: document.body.scrollWidth,
      sideVisible: sideStyle.display !== 'none' && sideStyle.visibility !== 'hidden' && sideRect.right > 1 && sideRect.width > 0,
      sideRect: rect(side),
      sideInert: side.hasAttribute('inert'),
      sideRole: side.getAttribute('role'),
      sideModal: side.getAttribute('aria-modal'),
      mainRect: rect(main),
      mainInert: main.hasAttribute('inert'),
      topbar: topbar === null ? null : { rect: rect(topbar), display: getComputedStyle(topbar).display },
      scrim: scrimRect === null ? null : { rect: scrimRect, background: getComputedStyle(scrim as Element).backgroundColor },
      headLeft: head === null ? null : head.getBoundingClientRect().left,
      titleLeft: title === null ? null : title.getBoundingClientRect().left,
      pageLeft: page === null ? null : page.getBoundingClientRect().left,
      labels,
      overflow: document.body.style.overflow,
      dataSb: document.querySelector('.app')?.getAttribute('data-sb') ?? null,
      dataDrawer: document.querySelector('.app')?.getAttribute('data-drawer') ?? null,
    };
  });
}

const NARROW = (width: number) => width < 640;

describe('U-32・U-4・U-5・U-6: 幅 390・600・768・1280px の、サイドバーの状態（ライト・ダーク）', () => {
  for (const width of [390, 600, 768, 1280] as const) {
    it(`幅 ${width}px: 既定の状態と、${NARROW(width) ? '引き出しを開いた' : 'サイドバーをしまった'}状態。横スクロールが無く、axe の重大な違反が 0 件`, { timeout: 180_000 }, async () => {
      for (const scheme of SCHEMES) {
        const { context, page, problems, external } = await open({ width, scheme });
        try {
          // ---- 既定 ----
          const first = await layout(page);
          expect(first.sw, `${width} ${scheme}`).toBeLessThanOrEqual(first.iw);
          expect(first.bw).toBeLessThanOrEqual(first.iw);
          if (NARROW(width)) {
            // 細い窓: サイドバーは隠れ、本文は左端から始まる。左上のボタンがある
            expect(first.sideVisible).toBe(false);
            expect(first.sideInert).toBe(true);
            expect(first.topbar).not.toBeNull();
            expect(first.headLeft).toBeLessThanOrEqual(16);
            expect(first.titleLeft).toBeLessThanOrEqual(16);
            expect(first.pageLeft).toBeLessThanOrEqual(16);
            const toggle = topToggle(page);
            expect(await toggle.getAttribute('aria-label')).toBe('サイドバーを開く');
            expect(await toggle.getAttribute('aria-expanded')).toBe('false');
            const box = (await toggle.boundingBox()) as { x: number; y: number; width: number; height: number };
            expect(box.x).toBeLessThanOrEqual(16);
            expect(box.width).toBeGreaterThanOrEqual(36);
            expect(box.y).toBeLessThanOrEqual(24);
          } else {
            // 広い窓: 固定幅のサイドバーが出ている。帯は無い
            expect(first.sideVisible).toBe(true);
            expect(Math.round(first.sideRect?.width ?? 0)).toBe(248);
            expect(first.topbar).toBeNull();
            expect(await sideToggle(page).getAttribute('aria-label')).toBe('サイドバーを閉じる');
          }
          expect(seriousViolations(await runAxe(page)), `既定 ${width} ${scheme}`).toEqual([]);

          // ---- 引き出しを開く / しまう ----
          if (NARROW(width)) {
            await topToggle(page).click();
            await page.waitForFunction(() => document.getElementById('sidebar')?.hasAttribute('inert') === false);
            const o = await layout(page);
            expect(o.sideVisible).toBe(true);
            expect(o.sideRole).toBe('dialog');
            expect(o.sideModal).toBe('true');
            expect(o.sideRect?.left).toBe(0);
            // min(86vw, 300px)
            expect(Math.round(o.sideRect?.width ?? 0)).toBe(Math.round(Math.min(width * 0.86, 300)));
            expect(o.sideRect?.top).toBe(0);
            expect(o.sideRect?.bottom).toBe(o.ih);
            // 幕: 窓いっぱい。裏（本文）は操作できない
            expect(o.scrim?.rect.width).toBe(o.iw);
            expect(o.scrim?.rect.height).toBe(o.ih);
            expect(parseCssColor(o.scrim?.background ?? 'rgba(0,0,0,0)').a).toBeGreaterThan(0.3);
            expect(o.mainInert).toBe(true);
            // 全部の項目（名前の文字が見える）
            expect(o.labels).toEqual(['今日の出題', '解き直し', 'ログ', '週の集計', '設定']);
            expect(await page.locator('#sidebar .session-row').first().isVisible()).toBe(true);
            expect(await page.locator('#sidebar .s-time').first().isVisible()).toBe(true);
            expect(await page.locator('#sidebar .search-in').isVisible()).toBe(true);
            expect(o.overflow).toBe('hidden');
            expect(o.sw).toBeLessThanOrEqual(o.iw);
            expect(o.bw).toBeLessThanOrEqual(o.iw);
            expect(seriousViolations(await runAxe(page)), `引き出し ${width} ${scheme}`).toEqual([]);
          } else {
            await sideToggle(page).click();
            const hidden = await layout(page);
            expect(hidden.sideVisible).toBe(false);
            expect(hidden.sideInert).toBe(true);
            expect(hidden.dataSb).toBe('hidden');
            expect(hidden.topbar).not.toBeNull();
            // 本文は全幅になり、帯のボタンが左上に出て、位置がそこへ移る
            expect(hidden.mainRect?.left).toBe(0);
            expect(hidden.mainRect?.width).toBe(hidden.iw);
            expect(await isTopToggleFocused(page)).toBe(true);
            expect(hidden.sw).toBeLessThanOrEqual(hidden.iw);
            expect(hidden.bw).toBeLessThanOrEqual(hidden.iw);
            expect(await topToggle(page).getAttribute('aria-label')).toBe('サイドバーを開く');
            expect(seriousViolations(await runAxe(page)), `しまった ${width} ${scheme}`).toEqual([]);
            // もう一度押すと、戻る。位置はサイドバーの中のボタンへ
            await topToggle(page).click();
            const back = await layout(page);
            expect(back.sideVisible).toBe(true);
            expect(back.topbar).toBeNull();
            expect(await page.evaluate(() => document.activeElement === document.querySelector('#sidebar .sb-toggle'))).toBe(true);
          }
          expect(problems).toEqual([]);
          expect(external).toEqual([]);
        } finally {
          await context.close();
        }
      }
    });
  }
});

describe('U-32 細い窓の引き出し: 閉じる・フォーカス', () => {
  for (const width of [390, 600] as const) {
    it(`幅 ${width}px: Tab は引き出しの中だけを回る。Esc・幕・項目・中のボタンで閉じて、左上のボタンへ位置が戻る`, { timeout: 120_000 }, async () => {
      const { context, page, problems } = await open({ width });
      try {
        await topToggle(page).click();
        await page.waitForFunction(() => document.getElementById('sidebar')?.hasAttribute('inert') === false);
        // 開いた直後、位置は引き出し自身にある
        expect(await page.evaluate(() => document.activeElement?.id)).toBe('sidebar');
        // Tab 40 回・Shift+Tab 12 回、すべて引き出しの中
        const inside: boolean[] = [];
        for (let i = 0; i < 40; i += 1) {
          await page.keyboard.press('Tab');
          inside.push(await page.evaluate(() => document.activeElement?.closest('#sidebar') !== null));
        }
        for (let i = 0; i < 12; i += 1) {
          await page.keyboard.press('Shift+Tab');
          inside.push(await page.evaluate(() => document.activeElement?.closest('#sidebar') !== null));
        }
        expect(inside.filter((value) => !value), `外へ出た回数（${inside.length} 回中）`).toEqual([]);
        // Esc
        await page.keyboard.press('Escape');
        let o = await layout(page);
        expect(o.dataDrawer).toBe('closed');
        expect(o.sideVisible).toBe(false);
        expect(o.scrim).toBeNull();
        expect(o.mainInert).toBe(false);
        expect(o.overflow).toBe('');
        expect(await isTopToggleFocused(page)).toBe(true);
        // 幕を押す
        await topToggle(page).click();
        await page.mouse.click(width - 20, 400);
        o = await layout(page);
        expect(o.dataDrawer).toBe('closed');
        expect(await isTopToggleFocused(page)).toBe(true);
        // 項目（半荘）を選ぶ: その半荘が開き、引き出しが閉じる
        await topToggle(page).click();
        await page.locator('#sidebar .session-row').nth(1).click();
        await page.getByRole('heading', { level: 1, name: /17:12/ }).waitFor();
        o = await layout(page);
        expect(o.dataDrawer).toBe('closed');
        expect(await isTopToggleFocused(page)).toBe(true);
        // 中のボタン
        await topToggle(page).click();
        await sideToggle(page).click();
        o = await layout(page);
        expect(o.dataDrawer).toBe('closed');
        expect(await isTopToggleFocused(page)).toBe(true);
        // 設定
        await topToggle(page).click();
        await page.locator('#sidebar').getByRole('button', { name: '設定' }).click();
        await page.getByRole('heading', { level: 1, name: '設定' }).waitFor();
        expect((await layout(page)).dataDrawer).toBe('closed');
        expect(await isTopToggleFocused(page)).toBe(true);
        expect(problems).toEqual([]);
      } finally {
        await context.close();
      }
    });
  }

  it('幅 390px: 引き出しの中の行のメニュー・段階のメニューは、窓の中に出て、Esc はメニューだけを閉じる。検索の重ね表示を開いて閉じても、引き出しは開いたまま', { timeout: 120_000 }, async () => {
    const { context, page, problems } = await open({ width: 390 });
    try {
      await topToggle(page).click();
      await page.waitForFunction(() => document.getElementById('sidebar')?.hasAttribute('inert') === false);
      // 行のメニュー（Menu キー）
      await page.locator('#sidebar .session-row').nth(2).focus();
      await page.keyboard.press('ContextMenu');
      const menu = page.getByRole('menu');
      await menu.waitFor();
      const box = (await menu.boundingBox()) as { x: number; y: number; width: number; height: number };
      expect(box.x).toBeGreaterThanOrEqual(0);
      expect(box.x + box.width).toBeLessThanOrEqual(390);
      expect(box.y + box.height).toBeLessThanOrEqual(844);
      await page.keyboard.press('Escape');
      await menu.waitFor({ state: 'detached' });
      expect((await layout(page)).dataDrawer).toBe('open');
      // 段階のメニュー
      await page.locator('#sidebar').getByRole('button', { name: /^段階/ }).click();
      await page.getByRole('menu', { name: '段階で絞り込む' }).waitFor();
      await page.keyboard.press('Escape');
      expect((await layout(page)).dataDrawer).toBe('open');
      // 検索の重ね表示
      await page.locator('#sidebar').getByRole('button', { name: '検索' }).click();
      await dialog(page).waitFor();
      await page.keyboard.press('Escape');
      await dialog(page).waitFor({ state: 'detached' });
      expect((await layout(page)).dataDrawer).toBe('open');
      expect(await page.evaluate(() => document.activeElement?.getAttribute('aria-label'))).toBe('検索');
      expect(problems).toEqual([]);
    } finally {
      await context.close();
    }
  });

  it('幅 390px: 引き出しを開いたまま窓を広げると、引き出しは閉じて、サイドバーが列として出る（幕・スクロールの固定も外れる）', { timeout: 60_000 }, async () => {
    const { context, page } = await open({ width: 390 });
    try {
      await topToggle(page).click();
      await page.waitForFunction(() => document.getElementById('sidebar')?.hasAttribute('inert') === false);
      await page.setViewportSize({ width: 900, height: 800 });
      await page.waitForFunction(() => document.querySelector('.app')?.getAttribute('data-drawer') === 'closed');
      const o = await layout(page);
      expect(o.sideVisible).toBe(true);
      expect(Math.round(o.sideRect?.width ?? 0)).toBe(248);
      expect(o.scrim).toBeNull();
      expect(o.mainInert).toBe(false);
      expect(o.overflow).toBe('');
      expect(o.topbar).toBeNull();
      expect(o.sw).toBeLessThanOrEqual(o.iw);
      // また細くすると、閉じた状態に戻る
      await page.setViewportSize({ width: 390, height: 844 });
      await page.waitForFunction(() => getComputedStyle(document.getElementById('sidebar') as Element).visibility === 'hidden');
      expect((await layout(page)).dataDrawer).toBe('closed');
    } finally {
      await context.close();
    }
  });
});

describe('U-32 広い窓: しまった選びは、起動し直しても残る', () => {
  it('1280px: しまってページを読み直すと、しまったまま。出して読み直すと、出たまま。細い窓にしても、引き出しは開く', { timeout: 120_000 }, async () => {
    const { context, page, problems } = await open({ width: 1280 });
    try {
      expect(await page.evaluate(() => localStorage.getItem('jr-sidebar'))).toBeNull();
      await sideToggle(page).click();
      expect(await page.evaluate(() => localStorage.getItem('jr-sidebar'))).toBe('hidden');
      await reopen(page);
      let o = await layout(page);
      expect(o.sideVisible).toBe(false);
      expect(o.topbar).not.toBeNull();
      expect(o.mainRect?.left).toBe(0);
      // しまったまま、窓を細くしても、引き出しが開く（しまった選びが、引き出しを塞がない）
      await page.setViewportSize({ width: 390, height: 844 });
      await page.waitForFunction(() => document.getElementById('sidebar')?.hasAttribute('inert') === true);
      await topToggle(page).click();
      await page.waitForFunction(() => document.getElementById('sidebar')?.hasAttribute('inert') === false);
      o = await layout(page);
      expect(o.sideVisible).toBe(true);
      expect(Math.round(o.sideRect?.width ?? 0)).toBe(300);
      // 引き出しを閉じて、窓を広げると、しまったまま
      await page.keyboard.press('Escape');
      await page.setViewportSize({ width: 1280, height: 800 });
      await page.waitForFunction(() => document.querySelector('.app')?.getAttribute('data-sb') === 'hidden');
      expect((await layout(page)).sideVisible).toBe(false);
      expect(await page.evaluate(() => localStorage.getItem('jr-sidebar'))).toBe('hidden');
      // 出す
      await topToggle(page).click();
      expect(await page.evaluate(() => localStorage.getItem('jr-sidebar'))).toBe('shown');
      await reopen(page);
      o = await layout(page);
      expect(o.sideVisible).toBe(true);
      expect(o.topbar).toBeNull();
      expect(problems).toEqual([]);
    } finally {
      await context.close();
    }
  });
});

/** 見出しの組（サイドバーの見出しか、本文の上の帯）の配置。 */
async function headerGeometry(page: Page) {
  return page.evaluate(() => {
    const side = document.getElementById('sidebar') as HTMLElement;
    const sideVisible = !side.hasAttribute('inert');
    const head = (sideVisible ? side.querySelector('.side-head') : document.querySelector('header.topbar')) as HTMLElement;
    const rect = (el: Element | null) => {
      if (el === null) throw new Error('見出しの部品が無い');
      const r = el.getBoundingClientRect();
      return { left: r.left, right: r.right, top: r.top, bottom: r.bottom, width: r.width, height: r.height };
    };
    return {
      iw: window.innerWidth,
      where: sideVisible ? 'サイドバー' : '帯',
      head: rect(head),
      toggle: rect(head.querySelector('.sb-toggle')),
      mark: rect(head.querySelector('.app-mark')),
      search: rect(head.querySelector('.search-btn')),
      back: rect(head.querySelector('[aria-label="戻る"]')),
      forward: rect(head.querySelector('[aria-label="進む"]')),
    };
  });
}

describe('U-32・U-22 見出し: 左にサイドバーのボタンとアプリのアイコン、右に検索と ← →（どの幅でも）', () => {
  for (const width of [390, 600, 768, 1280] as const) {
    it(`幅 ${width}px: 並び順・縦の中心・はみ出し（サイドバーの見出しと、しまったあとの帯の両方）`, { timeout: 120_000 }, async () => {
      const { context, page } = await open({ width });
      try {
        const states: Array<() => Promise<void>> = NARROW(width)
          ? [async () => undefined, async () => { await topToggle(page).click(); await page.waitForFunction(() => document.getElementById('sidebar')?.hasAttribute('inert') === false); }]
          : [async () => undefined, async () => { await sideToggle(page).click(); }];
        for (const go of states) {
          await go();
          const g = await headerGeometry(page);
          const label = `${g.where} ${width}`;
          expect(g.toggle.right, label).toBeLessThanOrEqual(g.mark.left + 1);
          expect(g.mark.right, label).toBeLessThanOrEqual(g.search.left);
          expect(g.search.right, label).toBeLessThanOrEqual(g.back.left + 1);
          expect(g.back.right, label).toBeLessThanOrEqual(g.forward.left + 1);
          expect(g.forward.right, label).toBeLessThanOrEqual(g.head.right + 1);
          expect(g.forward.right, label).toBeLessThanOrEqual(g.iw);
          expect(g.toggle.left, label).toBeGreaterThanOrEqual(g.head.left - 1);
          expect(g.toggle.width, label).toBe(40);
          expect(g.toggle.height, label).toBe(40);
          const center = (r: { top: number; bottom: number }) => (r.top + r.bottom) / 2;
          for (const part of [g.mark, g.search, g.back, g.forward]) expect(Math.abs(center(part) - center(g.toggle)), label).toBeLessThanOrEqual(6);
          // 右に寄る: 検索と ← → は、アイコンから離れている
          expect(g.search.left - g.mark.right, label).toBeGreaterThan(8);
        }
      } finally {
        await context.close();
      }
    });
  }
});

/** 色を、背景に重ねた不透明な色にして返す。 */
function flatten(css: string, base: Rgb): Rgb {
  return over(parseCssColor(css), base);
}

const spread = (c: Rgb) => Math.max(c.r, c.g, c.b) - Math.min(c.r, c.g, c.b);

describe('U-26 見出しの検索のアイコン: 緑の塗り・緑の輪は付けない（開いている間も、閉じたあとも）。キーボードで選んだ輪は灰色で 3:1 以上', () => {
  for (const width of [1280, 390] as const) {
    it(`幅 ${width}px: マウスで開いて閉じる・キーボードで開いて閉じる・キーボードで選ぶ（ライト・ダーク）`, { timeout: 180_000 }, async () => {
      for (const scheme of SCHEMES) {
        const { context, page, problems } = await open({ width, scheme });
        try {
          // 見えているほうの検索のアイコン（広い窓はサイドバーの見出し、細い窓は帯）
          const icon = page.locator(NARROW(width) ? 'header.topbar .search-btn' : '#sidebar .search-btn');
          const pageBackground = await page.evaluate(() => getComputedStyle(document.body).backgroundColor);
          const base = flatten(pageBackground, { r: 255, g: 255, b: 255 });
          const paint = () =>
            icon.evaluate((el) => {
              const style = getComputedStyle(el);
              return { background: style.backgroundColor, outlineStyle: style.outlineStyle, outlineWidth: parseFloat(style.outlineWidth), outlineColor: style.outlineColor, expanded: el.getAttribute('aria-expanded') };
            });
          const notGreen = (state: Awaited<ReturnType<typeof paint>>, label: string) => {
            // 塗り: 透明か、灰色（赤・緑・青の差が小さい）
            const fill = parseCssColor(state.background);
            if (fill.a > 0) expect(spread(flatten(state.background, base)), `${label} 塗り ${state.background}`).toBeLessThanOrEqual(8);
            // 輪: 無いか、灰色
            if (state.outlineStyle !== 'none' && state.outlineWidth > 0) {
              expect(spread(flatten(state.outlineColor, base)), `${label} 輪 ${state.outlineColor}`).toBeLessThanOrEqual(8);
            }
          };

          // ---- マウスで開く: 開いている間 ----
          expect((await paint()).expanded).toBe('false');
          notGreen(await paint(), '開く前');
          await icon.click();
          await dialog(page).waitFor();
          const opened = await paint();
          expect(opened.expanded).toBe('true');
          notGreen(opened, '開いている間');
          // 開いている間の塗りは、灰色で、見える（透明ではない）
          expect(parseCssColor(opened.background).a).toBeGreaterThan(0);

          // ---- マウスで閉じる（背景を押す）: 閉じたあと ----
          await page.mouse.click(6, 6);
          await dialog(page).waitFor({ state: 'detached' });
          const closed = await paint();
          expect(closed.expanded).toBe('false');
          notGreen(closed, 'マウスで閉じたあと');
          expect(parseCssColor(closed.background).a).toBe(0);

          // ---- キーボードで開いて、Esc で閉じる ----
          await icon.focus();
          await page.keyboard.press('Enter');
          await dialog(page).waitFor();
          notGreen(await paint(), 'キーボードで開いている間');
          await page.keyboard.press('Escape');
          await dialog(page).waitFor({ state: 'detached' });
          const afterKeys = await paint();
          notGreen(afterKeys, 'Esc で閉じたあと');
          // 位置は、押したアイコンに戻る
          expect(await icon.evaluate((el) => el === document.activeElement)).toBe(true);

          // ---- キーボードで選んだとき: 灰色の輪が見える（2px 以上、背景との差が 3:1 以上） ----
          await page.evaluate(() => (document.activeElement as HTMLElement | null)?.blur());
          await icon.focus();
          await page.keyboard.press('Shift+Tab');
          await page.keyboard.press('Tab');
          expect(await icon.evaluate((el) => el === document.activeElement)).toBe(true);
          const focused = await paint();
          expect(focused.outlineStyle).toBe('solid');
          expect(focused.outlineWidth).toBeGreaterThanOrEqual(2);
          const ring = flatten(focused.outlineColor, base);
          expect(spread(ring), `輪 ${focused.outlineColor}`).toBeLessThanOrEqual(8);
          expect(contrast(ring, base), `輪と背景のコントラスト（${scheme}）`).toBeGreaterThanOrEqual(3);
          // 緑の輪（--focus）ではない: 同じ要素で、ほかのボタン（検討結果を取り込む）の輪の色と違う
          expect(problems).toEqual([]);
        } finally {
          await context.close();
        }
      }
    });
  }
});

describe('U-32 どちらの形でも、検索・Ctrl+K・Alt+← →・既存のキーが動く', () => {
  for (const width of [1280, 390] as const) {
    it(`幅 ${width}px: Ctrl+K で検索が開き Esc で閉じる。Alt+← で、前に見た画面へ戻り、Alt+→ で進む`, { timeout: 120_000 }, async () => {
      const { context, page, problems } = await open({ width });
      try {
        await page.keyboard.press('Control+k');
        await dialog(page).waitFor();
        await page.keyboard.press('Escape');
        await dialog(page).waitFor({ state: 'detached' });
        // 別の半荘を開いて、戻る・進む
        if (NARROW(width)) await topToggle(page).click();
        await page.locator('#sidebar .session-row').nth(1).click();
        await page.getByRole('heading', { level: 1, name: /17:12/ }).waitFor();
        await page.keyboard.press('Alt+ArrowLeft');
        await page.getByRole('heading', { level: 1, name: /19:09/ }).waitFor();
        await page.keyboard.press('Alt+ArrowRight');
        await page.getByRole('heading', { level: 1, name: /17:12/ }).waitFor();
        // 検索の結果から開く
        await page.keyboard.press('Control+k');
        await dialog(page).waitFor();
        await page.getByRole('combobox', { name: '半荘と問題を検索' }).fill('10月7日');
        await page.keyboard.press('Enter');
        await page.getByRole('heading', { level: 1, name: /22:10/ }).waitFor();
        expect((await layout(page)).dataDrawer).toBe('closed');
        expect(problems).toEqual([]);
      } finally {
        await context.close();
      }
    });
  }
});
