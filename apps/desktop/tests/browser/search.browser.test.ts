// @vitest-environment node
/**
 * 実ブラウザで、サイドバーの新しい見出しと検索の重ね表示を検査する（U-22・U-4・U-5・U-6・U-1）。
 *
 * - 見出し: 左にアプリのアイコン、右に枠の無い検索のアイコン、そのすぐ右に ← →（幅 1280・768）。細い列（390）では、
 *   アイコン・検索・← → の順に縦に並ぶ。検索のアイコンに、見える枠は無い
 * - U-4: 幅 390・768・1280px で、重ね表示の各状態に横スクロールが出ない。重ね表示は窓の中に収まる
 * - U-5・U-6: axe の重大な違反が 0 件（色のコントラストを含む）。ライトとダーク。Tab で重ね表示のすべての操作に届き、外へ出ない
 * - 開く・閉じる・選ぶ・開く: 本物のキー（Ctrl+K・Esc・↑ ↓・Enter・Alt+←）と、本物の inert・フォーカスで確かめる
 * - U-1: 答える前の画面を覆っても、AI の情報は DOM に出ない。外へ通信しない
 * jsdom の試験（src/main/search）と同じふるまいを、実際の描画・キー・時計で確かめる。
 */
import type { Browser, BrowserContext, Page } from 'playwright-core';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import { parseCssColor } from '../color-math';
import { REPORT_TEXTS, folderName, local, seedSession } from '../fake-sessions';
import { answerRow } from '../fake-study';
import { fx4Ocr, fx4Session } from '../import-fixtures';
import {
  TINY_PNG,
  launchBrowser,
  runAxe,
  seriousViolations,
  startPageServer,
  tauriMockScript,
  waitForMainReady,
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
  disagreement_percent: 5,
  highlight_dora: false,
};

const FX4_AT = local(2026, 10, 9, 19, 9);
const FX4_ID = folderName(FX4_AT);
const FX1A_AT = local(2026, 10, 9, 17, 12);
const FX1A_ID = folderName(FX1A_AT);

/** FX-4（読み取りの写しつき。迷い 1〜5 は推定）と、日付をずらした FX-1 の 4 半荘、結果を取り込む前の半荘。新しい順。 */
function sessionSeeds() {
  const others = [
    { at: local(2026, 10, 8, 21, 40), report: 'fx1d' as const },
    { at: local(2026, 10, 8, 20, 55), report: 'fx1c' as const },
    { at: local(2026, 10, 7, 22, 10), report: 'fx1b' as const },
    { at: local(2026, 10, 4, 20, 12), report: 'fx1e' as const },
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
  return { sessions, reports };
}

/** 答えた問題 2 つ（f9da の東4局 13巡目と、FX-4 の東2局 11巡目）。 */
function answers(): unknown[] {
  return [
    answerRow({ id: 1, session_id: FX1A_ID, decision_key: 'k3h0e15', choice: { type: 'dahai', tile: '3m' }, principle: '受け入れを数えてから切る', due_date: '2026-10-10' }),
    answerRow({ id: 2, session_id: FX4_ID, decision_key: 'k1h0e12', choice: { type: 'dahai', tile: '5p' }, principle: 'ドラは先に切らない', due_date: '2026-10-10' }),
  ];
}

function scenario(): Scenario {
  const { sessions, reports } = sessionSeeds();
  return {
    label: 'main',
    state: baseState,
    settings: baseSettings,
    inputStatus: null,
    sessions,
    reports,
    thumb: TINY_PNG,
    answers: answers(),
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

async function open(options: { width?: number; height?: number; scheme?: Scheme } = {}): Promise<Opened> {
  const context = await browser.newContext({
    viewport: { width: options.width ?? 1280, height: options.height ?? 800 },
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
  // 出題のデータ（半荘の再生・答えの記録・今日の組）が読み終わると、サイドバーに数が出る
  await page.locator('nav[aria-label="メイン"] .count').first().waitFor({ timeout: 30_000 });
  return { context, page, problems, external };
}

const dialog = (page: Page) => page.getByRole('dialog', { name: '検索' });

async function openOverlay(page: Page): Promise<void> {
  await page.getByRole('button', { name: '検索' }).click();
  await dialog(page).waitFor();
}

interface StateDef {
  name: string;
  run: (page: Page) => Promise<void>;
}

const STATES: StateDef[] = [
  { name: '開いた（検索語なし）', run: openOverlay },
  {
    name: '検索語あり（東4局）',
    run: async (page) => {
      await openOverlay(page);
      await page.getByRole('combobox', { name: '半荘と問題を検索' }).fill('東4局');
    },
  },
  {
    name: '絞り込みと並べ替え（迷いあり・7日以内・AI との差が大きい順のメニュー）',
    run: async (page) => {
      await openOverlay(page);
      await page.getByRole('button', { name: '迷いあり' }).click();
      await page.getByRole('button', { name: /^期間：/ }).click();
      await page.getByRole('menuitemradio', { name: '7日以内' }).click();
      await page.getByRole('button', { name: /^並べ替え：/ }).click();
      await page.getByRole('menuitemradio', { name: 'AI との差が大きい順' }).click();
      await page.getByRole('button', { name: /^並べ替え：/ }).click();
      await page.getByRole('menu', { name: '並べ替え' }).waitFor();
    },
  },
  {
    name: '見つからない（東5局）',
    run: async (page) => {
      await openOverlay(page);
      await page.getByRole('combobox', { name: '半荘と問題を検索' }).fill('東5局');
    },
  },
  {
    name: 'すべて表示',
    run: async (page) => {
      await openOverlay(page);
      await page.getByRole('button', { name: /^すべて表示/ }).click();
    },
  },
];

async function openState(state: StateDef, options: { width?: number; scheme?: Scheme } = {}): Promise<Opened> {
  const opened = await open(options);
  await state.run(opened.page);
  return opened;
}

// ---- 見出し ----

interface Rect {
  left: number;
  right: number;
  top: number;
  bottom: number;
  width: number;
  height: number;
}

async function headerGeometry(page: Page) {
  return page.evaluate(() => {
    const rect = (el: Element): Rect => {
      const r = el.getBoundingClientRect();
      return { left: r.left, right: r.right, top: r.top, bottom: r.bottom, width: r.width, height: r.height };
    };
    const head = document.querySelector('.side-head') as HTMLElement;
    const search = head.querySelector('.search-btn') as HTMLElement;
    const style = getComputedStyle(search);
    const sides = ['Top', 'Right', 'Bottom', 'Left'] as const;
    return {
      head: rect(head),
      mark: rect(head.querySelector('.app-mark') as Element),
      search: rect(search),
      back: rect(head.querySelector('[aria-label="戻る"]') as Element),
      forward: rect(head.querySelector('[aria-label="進む"]') as Element),
      borders: sides.map((side) => ({
        width: style.getPropertyValue(`border-${side.toLowerCase()}-width`),
        style: style.getPropertyValue(`border-${side.toLowerCase()}-style`),
        color: style.getPropertyValue(`border-${side.toLowerCase()}-color`),
      })),
      outline: style.outlineStyle,
      shadow: style.boxShadow,
      background: style.backgroundColor,
      brandText: head.textContent?.trim() ?? '',
      markAlt: head.querySelector('.app-mark')?.getAttribute('alt') ?? null,
      markDraggable: (head.querySelector('.app-mark') as HTMLImageElement).draggable,
      markLoaded: (head.querySelector('.app-mark') as HTMLImageElement).complete && (head.querySelector('.app-mark') as HTMLImageElement).naturalWidth > 0,
      sidePadding: parseFloat(getComputedStyle(document.querySelector('.side-in') as Element).paddingRight),
      sideRight: (document.querySelector('.side-in') as Element).getBoundingClientRect().right,
    };
  });
}

describe('U-22: サイドバーの見出し（アイコン・検索・← →）', () => {
  for (const width of [1280, 768]) {
    it(`幅 ${width}px: 左にアプリのアイコン、右に枠の無い検索のアイコンと、そのすぐ右に ← →（右端にそろえる）`, { timeout: 60_000 }, async () => {
      for (const scheme of SCHEMES) {
        const { context, page, problems } = await open({ width, scheme });
        try {
          const g = await headerGeometry(page);
          // アイコンは左端。アプリの名前の文字は無い。画像は読み込めていて、引きずれない
          expect(g.markLoaded).toBe(true);
          expect(g.markAlt).toBe('JantamaReviewer');
          expect(g.markDraggable).toBe(false);
          expect(g.brandText).toBe('');
          expect(Math.abs(g.mark.left - (g.head.left))).toBeLessThanOrEqual(1);
          expect(g.mark.width).toBe(30);
          expect(g.mark.height).toBe(30);
          // 検索のアイコン: 枠が見えない（線の太さが 0・線なし・透明のどれか）。影も輪郭も無い
          for (const border of g.borders) {
            const invisible = border.style === 'none' || parseFloat(border.width) === 0 || parseCssColor(border.color).a === 0;
            expect(invisible, `${scheme} ${JSON.stringify(border)}`).toBe(true);
          }
          expect(g.shadow).toBe('none');
          expect(parseCssColor(g.background).a).toBe(0);
          // 右に寄せて、矢印のすぐ左: 検索の右端と戻るの左端のすき間が小さい。← → の右端が見出しの右端
          expect(g.search.right).toBeLessThanOrEqual(g.back.left);
          expect(g.back.left - g.search.right).toBeLessThanOrEqual(8);
          expect(g.back.right).toBeLessThanOrEqual(g.forward.left + 1);
          expect(Math.abs(g.forward.right - g.head.right)).toBeLessThanOrEqual(1);
          // アイコンと検索は、同じ高さの行（縦の中心がそろう）
          const center = (r: Rect) => (r.top + r.bottom) / 2;
          expect(Math.abs(center(g.search) - center(g.mark))).toBeLessThanOrEqual(2);
          expect(Math.abs(center(g.search) - center(g.back))).toBeLessThanOrEqual(1);
          // 検索のアイコンは、アイコンのすぐ隣ではなく、離れている（右寄せ）
          expect(g.search.left - g.mark.right).toBeGreaterThan(40);
          expect(g.search.width).toBeGreaterThanOrEqual(30);
          expect(g.search.height).toBeGreaterThanOrEqual(30);
          expect(problems).toEqual([]);
        } finally {
          await context.close();
        }
      }
    });
  }

  it('幅 390px（細い列）: アイコン・検索・← → の順に縦に並び、中央にそろう。どれも押せる大きさで、列からはみ出さない', { timeout: 60_000 }, async () => {
    for (const scheme of SCHEMES) {
      const { context, page, problems } = await open({ width: 390, scheme });
      try {
        const g = await headerGeometry(page);
        expect(g.mark.bottom).toBeLessThanOrEqual(g.search.top);
        expect(g.search.bottom).toBeLessThanOrEqual(g.back.top);
        expect(g.back.bottom).toBeLessThanOrEqual(g.forward.top);
        const centers = [g.mark, g.search, g.back, g.forward].map((r) => (r.left + r.right) / 2);
        for (const c of centers) expect(Math.abs(c - (centers[0] as number))).toBeLessThanOrEqual(1);
        expect(g.search.width).toBeGreaterThanOrEqual(44);
        expect(g.search.height).toBeGreaterThanOrEqual(36);
        const sideWidth = await page.evaluate(() => (document.querySelector('.side') as Element).getBoundingClientRect().width);
        for (const r of [g.mark, g.search, g.back, g.forward]) {
          expect(r.left).toBeGreaterThanOrEqual(0);
          expect(r.right).toBeLessThanOrEqual(sideWidth);
        }
        for (const border of g.borders) {
          expect(border.style === 'none' || parseFloat(border.width) === 0 || parseCssColor(border.color).a === 0).toBe(true);
        }
        // 細い列でも、検索のアイコンは重ね表示を開く（どれにも届く）
        await page.getByRole('button', { name: '検索' }).click();
        await dialog(page).waitFor();
        expect(problems).toEqual([]);
      } finally {
        await context.close();
      }
    }
  });

  it('見出しのキー: Tab の順は、検索 → 戻る → 進む（戻る・進むは、行き先が無いので押せない）', { timeout: 60_000 }, async () => {
    const { context, page } = await open();
    try {
      await page.getByRole('button', { name: '検索' }).focus();
      expect(await page.evaluate(() => document.activeElement?.getAttribute('aria-label'))).toBe('検索');
      const states = await page.evaluate(() => ['戻る', '進む'].map((name) => (document.querySelector(`[aria-label="${name}"]`) as HTMLButtonElement).disabled));
      expect(states).toEqual([true, true]);
      await page.keyboard.press('Tab');
      // ← → が押せないので、次は「検討結果を取り込む」
      expect(await page.evaluate(() => document.activeElement?.getAttribute('title'))).toBe('検討結果を取り込む');
      // フォーカスの輪が見える（2px）
      await page.getByRole('button', { name: '検索' }).focus();
      await page.keyboard.press('Shift+Tab');
      await page.keyboard.press('Tab');
      const outline = await page.evaluate(() => {
        const style = getComputedStyle(document.activeElement as Element);
        return { width: parseFloat(style.outlineWidth), style: style.outlineStyle };
      });
      expect(outline.style).toBe('solid');
      expect(outline.width).toBeGreaterThanOrEqual(2);
    } finally {
      await context.close();
    }
  });
});

// ---- 重ね表示の状態ごとの、幅・アクセシビリティ・テーマ ----

async function overflow(page: Page) {
  return page.evaluate(() => {
    const sx = document.querySelector('.sx') as HTMLElement | null;
    const wrap = document.querySelector('.sx-wrap') as HTMLElement | null;
    const rect = sx?.getBoundingClientRect();
    return {
      scroll: document.documentElement.scrollWidth,
      client: document.documentElement.clientWidth,
      body: document.body.scrollWidth,
      innerWidth: window.innerWidth,
      innerHeight: window.innerHeight,
      sx: rect === undefined ? null : { left: rect.left, right: rect.right, top: rect.top, bottom: rect.bottom },
      sxScroll: sx === null ? null : { scroll: sx.scrollWidth, client: sx.clientWidth },
      wrapScroll: wrap === null ? null : { scroll: wrap.scrollWidth, client: wrap.clientWidth },
    };
  });
}

describe('U-4・U-5・U-6: 重ね表示の各状態の、幅・アクセシビリティ・テーマ', () => {
  for (const state of STATES) {
    it(`${state.name}: 幅 390・768・1280px で横スクロールが出ず、窓に収まる。axe の重大な違反が 0 件（ライト・ダーク）`, { timeout: 120_000 }, async () => {
      for (const width of [390, 768, 1280]) {
        for (const scheme of SCHEMES) {
          const { context, page, problems, external } = await openState(state, { width, scheme });
          try {
            const o = await overflow(page);
            expect(o.scroll, `${state.name} @${width}`).toBeLessThanOrEqual(o.client);
            expect(o.body, `${state.name} @${width} body`).toBeLessThanOrEqual(o.client);
            expect(o.sx).not.toBeNull();
            expect((o.sx as { left: number }).left).toBeGreaterThanOrEqual(0);
            expect((o.sx as { right: number }).right).toBeLessThanOrEqual(o.innerWidth);
            expect((o.sx as { bottom: number }).bottom).toBeLessThanOrEqual(o.innerHeight);
            expect(o.sxScroll).toEqual({ scroll: (o.sxScroll as { client: number }).client, client: (o.sxScroll as { client: number }).client });
            if (width === 390) expect((o.sx as { right: number; left: number }).right - (o.sx as { left: number }).left).toBeGreaterThanOrEqual(o.innerWidth - 20);
            const found = seriousViolations(await runAxe(page));
            expect(found, `${state.name} @${width} ${scheme}`).toEqual([]);
            expect(problems).toEqual([]);
            expect(external).toEqual([]);
          } finally {
            await context.close();
          }
        }
      }
    });
  }
});

describe('U-5: Tab で重ね表示のすべての操作に届き、外へ出ない', () => {
  const REACHABLE = 'button:not([disabled]), input:not([disabled]), [tabindex="0"]';

  async function tabAround(page: Page) {
    const controls = await page.evaluate((selector) => {
      const dialog = document.querySelector('.sx') as Element;
      const visible = (el: HTMLElement) => {
        const rect = el.getBoundingClientRect();
        const style = getComputedStyle(el);
        return rect.width > 0 && rect.height > 0 && style.visibility !== 'hidden' && style.display !== 'none';
      };
      const els = [...dialog.querySelectorAll<HTMLElement>(selector)].filter(visible);
      els.forEach((el, index) => el.setAttribute('data-reach-id', String(index)));
      return els.map((el, index) => ({ id: String(index), label: (el.getAttribute('aria-label') ?? el.textContent ?? el.tagName).trim().slice(0, 24) }));
    }, REACHABLE);
    await page.locator('.sx-in').focus();
    const seen = new Set<string>();
    const outside: string[] = [];
    const rings: string[] = [];
    for (let i = 0; i < controls.length + 3; i += 1) {
      await page.keyboard.press('Tab');
      const info = await page.evaluate(() => {
        const el = document.activeElement as HTMLElement | null;
        const style = el === null ? null : getComputedStyle(el);
        return {
          id: el?.getAttribute('data-reach-id') ?? null,
          inside: el?.closest('.sx') != null,
          ring: style === null ? 0 : style.outlineStyle === 'none' ? 0 : parseFloat(style.outlineWidth),
          label: el?.getAttribute('aria-label') ?? el?.textContent?.slice(0, 20) ?? '',
        };
      });
      if (info.id !== null) seen.add(info.id);
      if (!info.inside) outside.push(info.label);
      else if (info.ring < 2) rings.push(info.label);
    }
    return { controls, missing: controls.filter((c) => !seen.has(c.id)).map((c) => c.label), outside, rings };
  }

  for (const state of STATES.filter((s) => !s.name.includes('メニュー'))) {
    it(`${state.name}: 検索欄から Tab を回すと、操作がすべて止まり場所になり、ダイアログの外へ出ない。止まった所に 2px 以上の輪が見える`, { timeout: 60_000 }, async () => {
      const { context, page } = await openState(state);
      try {
        const result = await tabAround(page);
        expect(result.controls.length).toBeGreaterThan(6);
        expect(result.missing).toEqual([]);
        expect(result.outside).toEqual([]);
        expect(result.rings).toEqual([]);
      } finally {
        await context.close();
      }
    });
  }

  it('Shift+Tab で、検索欄の前へ戻ると、最後の操作へ回る（外へ出ない）', { timeout: 60_000 }, async () => {
    const { context, page } = await open();
    try {
      await openOverlay(page);
      await page.locator('.sx-in').focus();
      await page.keyboard.press('Shift+Tab');
      expect(await page.evaluate(() => document.activeElement?.closest('.sx') != null)).toBe(true);
      expect(await page.evaluate(() => document.activeElement?.classList.contains('sx-in'))).toBe(false);
      await page.keyboard.press('Tab');
      expect(await page.evaluate(() => document.activeElement?.classList.contains('sx-in'))).toBe(true);
    } finally {
      await context.close();
    }
  });
});

// ---- キーと、本物の inert・フォーカス ----

describe('U-22: Ctrl+K・Esc・↑ ↓・Enter（本物のキー）', () => {
  it('Ctrl+K で開く: 検索欄にキーボードの位置が移り、裏の画面は本当に操作できない（inert）。Esc で閉じて、開く前の位置へ戻る', { timeout: 60_000 }, async () => {
    const { context, page, problems } = await open();
    try {
      const row = page.locator('.session-scroll [data-open]').nth(1);
      await row.focus();
      await page.keyboard.press('Control+k');
      await dialog(page).waitFor();
      const state = await page.evaluate(() => ({
        active: document.activeElement?.classList.contains('sx-in') ?? false,
        inert: (document.querySelector('.app') as HTMLElement).inert,
        expanded: document.querySelector('.search-btn')?.getAttribute('aria-expanded'),
        scrollLocked: getComputedStyle(document.body).overflow,
        // 裏の画面の左上を押しても、重ね表示の背景が受ける（裏のボタンには届かない）
        topmost: document.elementFromPoint(20, 20)?.closest('.sx-wrap') != null,
      }));
      expect(state).toEqual({ active: true, inert: true, expanded: 'true', scrollLocked: 'hidden', topmost: true });
      await page.keyboard.press('Escape');
      await dialog(page).waitFor({ state: 'detached' });
      expect(await page.evaluate(() => ({ same: document.activeElement === document.querySelectorAll('.session-scroll [data-open]')[1], inert: (document.querySelector('.app') as HTMLElement).inert }))).toEqual({ same: true, inert: false });
      // Ctrl+K を押しても、もう一度で閉じる
      await page.keyboard.press('Control+k');
      await dialog(page).waitFor();
      await page.keyboard.press('Control+k');
      await dialog(page).waitFor({ state: 'detached' });
      expect(problems).toEqual([]);
    } finally {
      await context.close();
    }
  });

  it('アイコンで開いて Esc で閉じると、キーボードの位置が検索のアイコンに戻る（輪が見える）', { timeout: 60_000 }, async () => {
    const { context, page } = await open();
    try {
      await openOverlay(page);
      await page.keyboard.press('Escape');
      await dialog(page).waitFor({ state: 'detached' });
      expect(await page.evaluate(() => document.activeElement?.getAttribute('aria-label'))).toBe('検索');
      expect(await page.evaluate(() => getComputedStyle(document.activeElement as Element).outlineStyle)).toBe('solid');
    } finally {
      await context.close();
    }
  });

  it('↑ ↓ で選ぶ行が動き、選んだ行は、一覧の見える範囲に入る（すべて表示にして、最後まで ↓）。↑ で先頭から最後へ回る', { timeout: 60_000 }, async () => {
    const { context, page } = await open();
    try {
      await openOverlay(page);
      await page.getByRole('button', { name: /^すべて表示/ }).click();
      await page.locator('.sx-in').focus();
      const probe = () =>
        page.evaluate(() => {
          const body = document.querySelector('.sx-body') as HTMLElement;
          const active = document.querySelector('[role="option"][aria-selected="true"]') as HTMLElement;
          const b = body.getBoundingClientRect();
          const a = active.getBoundingClientRect();
          return { index: Number(active.dataset.i), inside: a.top >= b.top - 1 && a.bottom <= b.bottom + 1, total: document.querySelectorAll('[role="option"]').length, scrollTop: body.scrollTop };
        });
      const first = await probe();
      expect(first.index).toBe(0);
      expect(first.total).toBeGreaterThan(50);
      for (let i = 0; i < 30; i += 1) {
        await page.keyboard.press('ArrowDown');
        expect((await probe()).inside).toBe(true);
      }
      const middle = await probe();
      expect(middle.index).toBe(30);
      expect(middle.scrollTop).toBeGreaterThan(0);
      await page.keyboard.press('Control+Home');
      expect((await probe()).index).toBe(0);
      await page.keyboard.press('ArrowUp');
      const wrapped = await probe();
      expect(wrapped.index).toBe(first.total - 1);
      expect(wrapped.inside).toBe(true);
      // キーボードの位置は、ずっと検索欄
      expect(await page.evaluate(() => document.activeElement?.classList.contains('sx-in'))).toBe(true);
    } finally {
      await context.close();
    }
  });

  it('Enter で半荘を開く: 半荘のページが開き、重ね表示は閉じる。Alt+← で前の画面へ、Alt+→ でまた開いた画面へ（画面の履歴）', { timeout: 60_000 }, async () => {
    const { context, page, problems } = await open();
    try {
      await page.getByRole('heading', { level: 1, name: /10月9日\(金\) 19:09/ }).waitFor();
      await openOverlay(page);
      await page.keyboard.press('ArrowDown');
      await page.keyboard.press('Enter');
      await dialog(page).waitFor({ state: 'detached' });
      await page.getByRole('heading', { level: 1, name: /10月9日\(金\) 17:12/ }).waitFor();
      expect(await page.evaluate(() => document.activeElement?.tagName)).toBe('H1');
      await page.keyboard.press('Alt+ArrowLeft');
      await page.getByRole('heading', { level: 1, name: /10月9日\(金\) 19:09/ }).waitFor();
      await page.keyboard.press('Alt+ArrowRight');
      await page.getByRole('heading', { level: 1, name: /10月9日\(金\) 17:12/ }).waitFor();
      expect(problems).toEqual([]);
    } finally {
      await context.close();
    }
  });

  it('Enter で問題を開く: 出題の画面がその問題で開き、手牌にキーボードの位置が移る。答えた問題は、答え合わせのあとの形で開く。Alt+← で戻れる', { timeout: 60_000 }, async () => {
    const { context, page, problems } = await open();
    try {
      await openOverlay(page);
      await page.getByRole('combobox', { name: '半荘と問題を検索' }).fill('東4局 13巡目');
      await page.keyboard.press('Enter');
      await page.getByRole('heading', { level: 1, name: '東4局 13巡目' }).waitFor();
      // f9da の東4局 13巡目は、答えた問題（保存してある答えで開く）
      await page.getByRole('heading', { name: 'AIの評価（Mortal）' }).waitFor();
      await page.keyboard.press('Alt+ArrowLeft');
      await page.getByRole('heading', { level: 1, name: /10月9日\(金\) 19:09/ }).waitFor();
      // 答えていない問題: 答える前の画面。手牌にキーボードの位置。AI の情報は DOM に無い（U-1）
      await openOverlay(page);
      await page.getByRole('button', { name: '未解答' }).click();
      await page.getByRole('combobox', { name: '半荘と問題を検索' }).fill('東4局 19巡目');
      await page.keyboard.press('Enter');
      await page.getByRole('heading', { level: 1, name: '東4局 19巡目' }).waitFor();
      await page.locator('.qz[data-state="answering"]').waitFor();
      await page.waitForFunction(() => document.activeElement?.closest('.hand') != null);
      expect(await page.evaluate(() => ({ ai: document.querySelectorAll('[data-ai]').length, pct: /\d\s*%|Mortal/.test(document.body.textContent ?? '') }))).toEqual({ ai: 0, pct: false });
      expect(problems).toEqual([]);
    } finally {
      await context.close();
    }
  });

  it('答える前の出題の画面を覆って開いても、AI の情報は DOM に出ない（AI との差が大きい順でも）。確率・割合・順位は無い（U-1・U-22）', { timeout: 60_000 }, async () => {
    const { context, page } = await open();
    try {
      await page.getByRole('button', { name: '今日の出題' }).click();
      await page.getByRole('button', { name: '出題を始める' }).click();
      await page.locator('.qz[data-state="answering"]').waitFor();
      await page.keyboard.press('Control+k');
      await dialog(page).waitFor();
      await page.getByRole('button', { name: /^並べ替え：/ }).click();
      await page.getByRole('menuitemradio', { name: 'AI との差が大きい順' }).click();
      await page.getByRole('button', { name: /^すべて表示/ }).click();
      const leak = await page.evaluate(() => ({
        ai: document.querySelectorAll('[data-ai]').length,
        text: /\d\s*[%％]|確率|順位|Mortal/.test(document.body.textContent ?? ''),
        html: /data-ai|probab/i.test(document.body.innerHTML),
        rows: document.querySelectorAll('.sx [role="option"]').length,
      }));
      expect(leak.rows).toBeGreaterThan(40);
      expect(leak).toMatchObject({ ai: 0, text: false, html: false });
    } finally {
      await context.close();
    }
  });
});

// ---- 絞り込みのメニュー・当たりの印・行の見た目 ----

describe('U-22: メニュー・当たりの印・行', () => {
  it('段階・期間・並べ替えのメニューは、重ね表示の前面に出て、窓の中に収まり、押した所のそばにある（幅 390・1280）', { timeout: 60_000 }, async () => {
    for (const width of [390, 1280]) {
      const { context, page } = await open({ width });
      try {
        await openOverlay(page);
        for (const name of [/^段階：/, /^期間：/, /^並べ替え：/]) {
          const chip = page.getByRole('button', { name });
          await chip.click();
          const menu = page.getByRole('menu').last();
          await menu.waitFor();
          const geometry = await page.evaluate(() => {
            const pop = document.querySelector('.pop') as HTMLElement;
            const r = pop.getBoundingClientRect();
            const trigger = document.querySelector('.fchip[aria-expanded="true"]') as HTMLElement;
            const t = trigger.getBoundingClientRect();
            const at = document.elementFromPoint((r.left + r.right) / 2, (r.top + r.bottom) / 2);
            return {
              pop: { left: r.left, right: r.right, top: r.top, bottom: r.bottom },
              trigger: { left: t.left, right: t.right, top: t.top, bottom: t.bottom },
              vw: window.innerWidth,
              vh: window.innerHeight,
              onTop: at?.closest('.pop') != null,
            };
          });
          expect(geometry.onTop).toBe(true);
          expect(geometry.pop.left).toBeGreaterThanOrEqual(0);
          expect(geometry.pop.right).toBeLessThanOrEqual(geometry.vw);
          expect(geometry.pop.top).toBeGreaterThanOrEqual(0);
          expect(geometry.pop.bottom).toBeLessThanOrEqual(geometry.vh);
          // 押したチップのすぐ下（か、下に入らなければ上）にあり、チップに重ならない
          const overlaps = geometry.pop.left < geometry.trigger.right && geometry.pop.right > geometry.trigger.left && geometry.pop.top < geometry.trigger.bottom && geometry.pop.bottom > geometry.trigger.top;
          expect(overlaps).toBe(false);
          await page.keyboard.press('Escape');
          await menu.waitFor({ state: 'detached' });
          // Esc は、メニューだけを閉じた（重ね表示は開いたまま）
          expect(await dialog(page).isVisible()).toBe(true);
        }
      } finally {
        await context.close();
      }
    }
  });

  it('当たった文字の下線（印）が、描かれている（accent の線）。選んだ行に、輪（フォーカスの色）', { timeout: 60_000 }, async () => {
    for (const scheme of SCHEMES) {
      const { context, page } = await open({ scheme });
      try {
        await openOverlay(page);
        await page.getByRole('combobox', { name: '半荘と問題を検索' }).fill('東4局');
        const info = await page.evaluate(() => {
          const mark = document.querySelector('.sx mark.hit') as HTMLElement;
          const style = getComputedStyle(mark);
          const probe = document.createElement('i');
          probe.style.color = 'var(--accent)';
          probe.style.outlineColor = 'var(--focus)';
          document.body.append(probe);
          const accent = getComputedStyle(probe).color;
          const focus = getComputedStyle(probe).outlineColor;
          probe.remove();
          const row = document.querySelector('[role="option"][aria-selected="true"]') as HTMLElement;
          const rowStyle = getComputedStyle(row);
          return { text: mark.textContent, shadow: style.boxShadow, accent, background: style.backgroundColor, rowOutline: `${rowStyle.outlineWidth} ${rowStyle.outlineStyle} ${rowStyle.outlineColor}`, focus, rowBackground: rowStyle.backgroundColor };
        });
        expect(info.text).toBe('東4局');
        expect(info.shadow).toContain(info.accent);
        expect(info.shadow).toMatch(/inset/);
        expect(parseCssColor(info.background).a).toBeGreaterThan(0);
        expect(info.rowOutline).toBe(`2px solid ${info.focus}`);
        expect(parseCssColor(info.rowBackground).a).toBeGreaterThan(0);
      } finally {
        await context.close();
      }
    }
  });

  it('行の見た目: 半荘の行（時刻・段階・Rating・日付と卓・2 行目・右に迷いと問題の数）と、問題の行（題名・迷いの印・2 行目・右に答えの状態）が、行の中に収まる', { timeout: 60_000 }, async () => {
    for (const width of [390, 1280]) {
      const { context, page } = await open({ width });
      try {
        await openOverlay(page);
        await page.getByRole('button', { name: /^すべて表示/ }).click();
        const rows = await page.evaluate(() =>
          [...document.querySelectorAll<HTMLElement>('.sx [role="option"]')].slice(0, 60).map((row) => {
            const r = row.getBoundingClientRect();
            const inside = [...row.querySelectorAll<HTMLElement>('*')].every((child) => {
              const c = child.getBoundingClientRect();
              return c.width === 0 || (c.left >= r.left - 1 && c.right <= r.right + 1);
            });
            return { text: row.textContent ?? '', inside, scrollW: row.scrollWidth, clientW: row.clientWidth, height: r.height };
          }),
        );
        for (const row of rows) {
          expect(row.inside, row.text).toBe(true);
          expect(row.scrollW, row.text).toBeLessThanOrEqual(row.clientW + 1);
          expect(row.height, row.text).toBeGreaterThanOrEqual(44);
        }
        expect(rows.some((row) => row.text.startsWith('半荘'))).toBe(true);
        expect(rows.some((row) => row.text.includes('解答済み'))).toBe(true);
        expect(rows.some((row) => /迷い\d/.test(row.text) && row.text.startsWith('問題'))).toBe(true);
      } finally {
        await context.close();
      }
    }
  });

  it('外へ通信しない・画面のエラーが無い（重ね表示を開いて、検索し、結果を開く）', { timeout: 60_000 }, async () => {
    const { context, page, problems, external } = await open();
    try {
      await openOverlay(page);
      await page.getByRole('combobox', { name: '半荘と問題を検索' }).fill('玉の間 昨日');
      await page.keyboard.press('Enter');
      await dialog(page).waitFor({ state: 'detached' });
      expect(problems).toEqual([]);
      expect(external).toEqual([]);
    } finally {
      await context.close();
    }
  });
});

describe('N-8・N-9・N-10: 重ね表示の中の文字・カーソル・検索欄', () => {
  it('文字は選択できず（三連クリックしても、選択範囲が空のまま）、検索欄だけが選択できる。画像は無い', { timeout: 60_000 }, async () => {
    const { context, page } = await open();
    try {
      await openOverlay(page);
      for (const selector of ['.sx-fl', '.sx-count b', '.sx-gh', '.sx-foot li']) {
        await page.locator(selector).first().click({ clickCount: 3 });
        expect(await page.evaluate(() => window.getSelection()?.toString() ?? ''), selector).toBe('');
        // 文字の上を押しても、重ね表示は閉じない
        expect(await dialog(page).isVisible(), selector).toBe(true);
      }
      expect(await page.evaluate(() => getComputedStyle(document.querySelector('.sx-main') as Element).userSelect)).toBe('none');
      expect(await page.evaluate(() => getComputedStyle(document.querySelector('.sx-in') as Element).userSelect)).toBe('text');
      expect(await page.evaluate(() => document.querySelectorAll('.sx img').length)).toBe(0);
    } finally {
      await context.close();
    }
  });

  it('カーソル: 操作できるもの（ボタン・行）だけが指の形。検索欄は文字の形。そのほかの文字・余白は矢印', { timeout: 60_000 }, async () => {
    const { context, page } = await open();
    try {
      await openOverlay(page);
      await page.getByRole('combobox', { name: '半荘と問題を検索' }).fill('東4局');
      await page.getByRole('button', { name: /^期間：/ }).click();
      const bad = await page.evaluate(() => {
        const out: string[] = [];
        let pointers = 0;
        for (const el of document.querySelectorAll<HTMLElement>('.sx-wrap, .sx-wrap *, .pop, .pop *')) {
          const rect = el.getBoundingClientRect();
          if (rect.width === 0 || rect.height === 0) continue;
          const tag = el.tagName.toLowerCase();
          let expected = 'default';
          if (tag === 'input') expected = 'text';
          else if (el.closest('button:not(:disabled), [role="option"]') !== null) expected = 'pointer';
          const actual = getComputedStyle(el).cursor;
          if (expected === 'pointer' && actual === 'pointer') pointers += 1;
          if (actual !== expected) out.push(`${tag}.${el.className}: ${actual}（期待は ${expected}）`);
        }
        return { out, pointers };
      });
      expect(bad.out).toEqual([]);
      expect(bad.pointers).toBeGreaterThan(10);
    } finally {
      await context.close();
    }
  });

  it('検索欄は、入力の候補・赤い波線・自動補正を出さない（spellcheck・autocomplete・autocorrect・autocapitalize）', { timeout: 60_000 }, async () => {
    const { context, page } = await open();
    try {
      await openOverlay(page);
      const attributes = await page.evaluate(() => {
        const input = document.querySelector('.sx-in') as HTMLInputElement;
        return ['spellcheck', 'autocomplete', 'autocorrect', 'autocapitalize'].map((name) => input.getAttribute(name));
      });
      expect(attributes).toEqual(['false', 'off', 'off', 'off']);
    } finally {
      await context.close();
    }
  });
});
