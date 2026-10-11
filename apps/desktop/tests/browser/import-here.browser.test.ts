// @vitest-environment node
/**
 * 実ブラウザで、取り込み前の半荘のページの「この半荘に検討結果を取り込む」と、その進み具合（ページの中。U-14）を検査する
 * （U-4・U-5・U-6）。
 *
 * - U-4: 幅 390・768・1280px で、操作・窓を待つ案内・取り込んでいる途中・確認・失敗・完了・始められない理由のどれも、横スクロールが出ない
 * - U-5・U-6: axe の重大な違反が 0 件（色のコントラストを含む）。Tab ですべての操作に届く。ライトとダーク
 * - 形: 主な操作は、見出しの右（狭いときは見出しの下）にある。進み具合のパネルは、ページの幅に収まる
 * - 動き: 押すと、牌譜リンクと取り込み先の呼び名で mjai の窓を開く。取り込みのページへは移らない
 * jsdom の試験（src/main/ImportHere.test.tsx）と同じふるまいを、実際の描画・キーで確かめる。
 */
import type { Browser, BrowserContext, Page } from 'playwright-core';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import { local } from '../fake-sessions';
import { COPIED_LINK, FX4_ID, FX4_TEXT, fx4Ocr, fx4Session } from '../import-fixtures';
import {
  TINY_PNG,
  launchBrowser,
  runAxe,
  seriousViolations,
  startPageServer,
  tauriMockScript,
  unreachableByTab,
  waitForMainReady,
  type ImportScenario,
  type PageServer,
  type Scenario,
} from './harness';

const SCHEMES = ['light', 'dark'] as const;
type Scheme = (typeof SCHEMES)[number];

/** 試験の「いま」: 2026 年 10 月 9 日 22:00。 */
const NOW = new Date(2026, 9, 9, 22, 0, 0);
const ID = '20261009-190953';
const ACTION = 'この半荘に検討結果を取り込む';

const baseState = { status: 'idle', session_id: null, mark_count: 0, ratings: [], next_hand: 1, can_undo: false, error: null };
const settings = {
  trigger: { kind: 'mouse_x1' },
  orientation: 'vertical',
  widget_position: null,
  sound: true,
  capture_keywords: ['雀魂', 'Mahjong Soul'],
  data_dir: 'C:\\Users\\someone\\JantamaReviewerData',
};

/** 取り込み前の半荘: FX-4 の迷い 6・評価 5（結果はまだ無い）。 */
function target() {
  return fx4Session(ID, local(2026, 10, 9, 19, 9));
}

function scenario(importing: ImportScenario): Scenario {
  return { label: 'main', state: baseState, settings, inputStatus: null, sessions: [target()], thumb: TINY_PNG, importing };
}

/** 迷い 2・4 と、評価 3 が、結果と合わない読み取り。 */
function mismatching() {
  const cache = fx4Ocr();
  cache.entries['marks/m2.png'] = { lines: ['南 2 局', '个 4 0', '25000'] };
  cache.entries['marks/m4.png'] = { lines: ['東 2 局', '个 3 5', '17000'] };
  cache.entries['ratings/r3.png'] = { lines: ['西 1 局', '个 6 0', '25000'] };
  return cache;
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

async function open(importing: ImportScenario, width = 1280, scheme: Scheme = 'light'): Promise<Opened> {
  const context = await browser.newContext({
    viewport: { width, height: 900 },
    colorScheme: scheme,
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
  await page.addInitScript(tauriMockScript(scenario(importing)));
  await page.goto(new URL('index.html', server.url).toString());
  await waitForMainReady(page);
  await page.getByRole('button', { name: ACTION }).waitFor();
  await page.waitForFunction(() => Array.from(document.images).every((img) => img.complete));
  return { context, page, problems, external };
}

const action = (page: Page) => page.getByRole('button', { name: ACTION });
const foundReport = (page: Page) =>
  page.evaluate(
    (id) => (window as unknown as { __jrEmit: (e: string, p: unknown) => void }).__jrEmit('mjai-window', { kind: 'report_found', id }),
    FX4_ID,
  );
const calls = (page: Page, cmd: string) =>
  page.evaluate(
    (name) =>
      (window as unknown as { __jrCalls: Array<{ cmd: string; args: unknown }> }).__jrCalls
        .filter((c) => c.cmd === name)
        .map((c) => c.args),
    cmd,
  );

/** 横スクロールの有無。 */
async function overflow(page: Page) {
  return page.evaluate(() => ({
    scroll: document.documentElement.scrollWidth,
    client: document.documentElement.clientWidth,
    body: document.body.scrollWidth,
  }));
}

interface ImportView {
  name: string;
  importing: ImportScenario;
  drive: (page: Page) => Promise<void>;
  ready: { heading?: string; alert?: string };
}

const VIEWS: ImportView[] = [
  { name: '操作（取り込み前の半荘）', importing: { clipboard: COPIED_LINK }, drive: async () => undefined, ready: {} },
  {
    name: '始められない理由（クリップボードに牌譜リンクが無い）',
    importing: { clipboard: 'おはようございます' },
    drive: async (page) => {
      await action(page).click();
    },
    ready: { alert: 'クリップボードに、雀魂の牌譜リンクがありません。' },
  },
  {
    name: 'mjai の窓で Submit を待つ',
    importing: { clipboard: COPIED_LINK },
    drive: async (page) => {
      await action(page).click();
    },
    ready: { heading: 'mjai の窓で Submit を押してください' },
  },
  {
    name: '取り込んでいます',
    importing: { clipboard: COPIED_LINK, reportText: FX4_TEXT, fetchHangs: true },
    drive: async (page) => {
      await action(page).click();
      await page.getByRole('heading', { name: 'mjai の窓で Submit を押してください' }).waitFor();
      await foundReport(page);
    },
    ready: { heading: '取り込んでいます' },
  },
  {
    name: '読んだ局・点数が合わない（聞く）',
    importing: { clipboard: COPIED_LINK, reportText: FX4_TEXT, ocr: mismatching() },
    drive: async (page) => {
      await action(page).click();
      await page.getByRole('heading', { name: 'mjai の窓で Submit を押してください' }).waitFor();
      await foundReport(page);
    },
    ready: { heading: '画面から読んだ局・点数が、この結果と合いません' },
  },
  {
    name: '失敗（検討結果が読めない）',
    importing: { clipboard: COPIED_LINK, reportText: '{"not":"a report"}' },
    drive: async (page) => {
      await action(page).click();
      await page.getByRole('heading', { name: 'mjai の窓で Submit を押してください' }).waitFor();
      await foundReport(page);
    },
    ready: { heading: '結果の JSON を読めませんでした' },
  },
  {
    name: '取り込みました',
    importing: { clipboard: COPIED_LINK, reportText: FX4_TEXT, ocr: fx4Ocr({ retries: true }) },
    drive: async (page) => {
      await action(page).click();
      await page.getByRole('heading', { name: 'mjai の窓で Submit を押してください' }).waitFor();
      await foundReport(page);
    },
    ready: { heading: '取り込みました' },
  },
];

describe('U-4・U-5・U-6: 半荘のページの中の取り込み（実ブラウザ）', () => {
  for (const scheme of SCHEMES) {
    for (const width of [390, 768, 1280] as const) {
      for (const view of VIEWS) {
        it(`${view.name} 幅${width}px ${scheme}: 横スクロールが無く、重大な a11y 違反が無く、Tab で全部に届き、外へ通信しない`, async () => {
          const { context, page, problems, external } = await open(view.importing, width, scheme);
          try {
            await view.drive(page);
            if (view.ready.heading) await page.getByRole('heading', { name: view.ready.heading }).waitFor();
            if (view.ready.alert) await page.getByRole('alert').filter({ hasText: view.ready.alert }).waitFor();
            await page.waitForTimeout(100);

            const m = await overflow(page);
            expect(m.scroll, `scrollWidth ${m.scroll} > clientWidth ${m.client}`).toBeLessThanOrEqual(m.client);
            expect(m.body).toBeLessThanOrEqual(m.client);

            const axe = await runAxe(page);
            expect(seriousViolations(axe)).toEqual([]);
            expect(axe.passes.find((p) => p.id === 'color-contrast')?.nodes ?? 0).toBeGreaterThan(5);

            const reach = await unreachableByTab(page);
            expect(reach.total).toBeGreaterThan(3);
            expect(reach.missed).toEqual([]);

            expect(problems).toEqual([]);
            expect(external).toEqual([]);
          } finally {
            await context.close();
          }
        });
      }
    }
  }
});

describe('U-14 形と動き（実ブラウザ）', () => {
  it('主な操作は、見出しの中の右端にある（1280px）。狭いとき（390px）は、見出しの下の行で、画面に収まる', async () => {
    const wide = await open({ clipboard: COPIED_LINK }, 1280);
    try {
      const head = await wide.page.locator('header.head').boundingBox();
      const button = await action(wide.page).boundingBox();
      const title = await wide.page.locator('header.head h1').boundingBox();
      expect(button).not.toBeNull();
      expect(head && button ? Math.round(head.x + head.width - (button.x + button.width)) : -1).toBeLessThanOrEqual(1);
      expect(button && title ? button.x >= title.x + title.width : false).toBe(true);
      expect(button?.height ?? 0).toBeGreaterThanOrEqual(36);
    } finally {
      await wide.context.close();
    }
    const narrow = await open({ clipboard: COPIED_LINK }, 390);
    try {
      const button = await action(narrow.page).boundingBox();
      const title = await narrow.page.locator('header.head h1').boundingBox();
      expect(button && title ? button.y >= title.y + title.height - 1 : false).toBe(true);
      expect((button?.x ?? -1) + (button?.width ?? 0)).toBeLessThanOrEqual(390);
      expect(button?.x ?? -1).toBeGreaterThanOrEqual(0);
    } finally {
      await narrow.context.close();
    }
  });

  it('押すと、牌譜リンクと取り込み先の呼び名で mjai の窓を開く。取り込みのページへは移らず、見出しの下にパネルが出る。キーボードの位置は、パネルの見出しへ', async () => {
    const { context, page } = await open({ clipboard: COPIED_LINK });
    try {
      await action(page).click();
      await page.getByRole('heading', { name: 'mjai の窓で Submit を押してください' }).waitFor();
      expect(await calls(page, 'open_mjai_window')).toEqual([
        {
          link: 'https://game.mahjongsoul.com/?paipu=261009-7c1e9b2a-4f3d-4e11-8a55-0123456789ab_a12345',
          background: expect.any(String),
          target: '10月9日 19:09',
        },
      ]);
      expect(await page.getByRole('heading', { level: 1 }).first().textContent()).toContain('10月9日');
      expect(await page.getByRole('heading', { level: 1, name: '検討結果を取り込む' }).count()).toBe(0);
      // パネルは、ページの幅（640px 以内）に収まり、見出しより下にある。迷いのカードも、そのまま下に見える。
      const panel = await page.locator('.inline-import').boundingBox();
      const head = await page.locator('header.head').boundingBox();
      expect(panel?.width ?? 999).toBeLessThanOrEqual(641);
      expect(panel && head ? panel.y >= head.y + head.height : false).toBe(true);
      expect(await page.getByRole('article', { name: '迷い1' }).count()).toBe(1);
      expect(await page.evaluate(() => document.activeElement?.tagName)).toBe('H2');
      expect(await action(page).isDisabled()).toBe(true);
    } finally {
      await context.close();
    }
  });

  it('確かめるときは、「やめる」が主な操作（塗りのボタン）。キーボードだけで、やめる・それでも取り込むに届く', async () => {
    const { context, page } = await open({ clipboard: COPIED_LINK, reportText: FX4_TEXT, ocr: mismatching() });
    try {
      await action(page).click();
      await page.getByRole('heading', { name: 'mjai の窓で Submit を押してください' }).waitFor();
      await foundReport(page);
      await page.getByRole('heading', { name: '画面から読んだ局・点数が、この結果と合いません' }).waitFor();
      const cancel = page.getByRole('button', { name: 'やめる' });
      expect(await cancel.evaluate((el) => el.classList.contains('primary'))).toBe(true);
      expect(await page.getByRole('list', { name: '結果と合わない画面' }).getByRole('listitem').allTextContents()).toEqual([
        '迷い2南2局・残り40・25,000点',
        '迷い4東2局・残り35・17,000点',
        '評価3局目西1局・残り60・25,000点',
      ]);
      expect(await calls(page, 'save_report')).toEqual([]);
      await page.keyboard.press('Tab');
      await page.keyboard.press('Tab');
      await page.keyboard.press('Enter');
      await page.getByRole('heading', { name: '取り込みました' }).waitFor();
      expect(await calls(page, 'save_report')).toEqual([{ sessionId: ID, text: FX4_TEXT }]);
    } finally {
      await context.close();
    }
  });
});
