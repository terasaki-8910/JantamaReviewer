// @vitest-environment node
/**
 * 実ブラウザで、半荘のページの「迷い」の列（R11-9、U-27）と、終局直後のメモ（F4、U-28）を検査する（U-4・U-5・U-6）。
 * FX-5（10月11日の半荘。迷い 13・局の評価 9）に、メモ・追加のメモを書いた状態で開く。
 *
 * - U-4: 幅 390・768・1280px で、通常・追加のメモのパネル・メニューを開いた状態に横スクロールが出ない。表の入れ物の中も、はみ出さない
 * - U-5・U-6: axe の重大な違反が 0 件（色のコントラストを含む）。Tab で、札・メモの欄・追加のボタンなど、すべての操作に届く。ライトとダーク
 * - 形: 広い幅では、札が表の「迷い」の列に並ぶ。幅 390px では、局ごとのかたまりに、小さな見出し「迷い」つきの行が付く
 * - 札を押す・Enter で、そのカードへ移る（実際のスクロールと、キーボードの位置）。メモは、実際のキーで保存され、Ctrl+Z で戻る
 * - 取り込む前の半荘（FX-4。結果を取り込んでいない）: 「迷いマークの無い迷いを足す」の位置の入力（局のメニュー・本場・巡目）が、幅 390・1280px の
 *   ライト・ダークで、横スクロールも重大な a11y 違反も無く、Tab で届く。実際のキー・マウスで足すと、位置で保存される
 * jsdom の試験（src/main/MarksMemo.test.tsx）と同じふるまいを、実際の描画・キー・時計で確かめる。
 */
import type { Browser, BrowserContext, Page } from 'playwright-core';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import type { Memos } from '../../src/api/types';
import { REPORT_TEXTS } from '../fake-sessions';
import { FX5_ID, FX5_STARTED, FX5_USER_CHOICES, fx4Session, fx5Ocr, fx5Session } from '../import-fixtures';
import {
  TINY_PNG,
  launchBrowser,
  runAxe,
  seriousViolations,
  startPageServer,
  tauriMockScript,
  unreachableByTab,
  waitForMainReady,
  type PageServer,
  type Scenario,
} from './harness';

const SCHEMES = ['light', 'dark'] as const;
type Scheme = (typeof SCHEMES)[number];

/** 試験の「いま」: 2026 年 10 月 12 日 12:00。 */
const NOW = new Date(2026, 9, 12, 12, 0, 0);

const baseState = { status: 'idle', session_id: null, mark_count: 0, ratings: [], next_hand: 1, can_undo: false, error: null };
const settings = {
  trigger: { kind: 'mouse_x1' },
  orientation: 'vertical',
  widget_position: null,
  sound: true,
  // 迷いだけ（F0、U-46）は切: メモの欄を検査する。入の検査は、下の「U-46」
  doubt_only: false,
  capture_keywords: ['雀魂', 'Mahjong Soul'],
  data_dir: 'C:\\Users\\someone\\JantamaReviewerData',
};

/** メモを書いた状態: 迷い 3（記録の番号 4）と迷い 11（記録の番号 17）に「候補」「理由」、迷いマークの無い迷い（南1局2本場）に追加のメモ。 */
const MEMOS: Memos = {
  marks: {
    '4': { candidates: '3m・6p', reason: '形を崩したくない' },
    '17': { candidates: 'ポン・スルー', reason: '速さを取るか' },
  },
  extras: [{ id: 'x1', decision: 'k4h2e5', candidates: '5s・發', reason: '押すか引くか迷った' }],
};

/**
 * ユーザーが選んだ 7 つ（迷い 1・3・4・5・6・8・13）のうち、迷い 5（記録の番号 8）だけ外す: 選んだ札（チェック）・推定の札（枠だけ）・
 * 巡目は未定の札（点線。迷い 5）が、そろって出る。
 */
const LINKS = { marks: Object.fromEntries(Object.entries(FX5_USER_CHOICES).filter(([id]) => id !== '8')), ratings: {} };

function fx5Imported(memos: Memos = MEMOS) {
  return fx5Session(FX5_ID, FX5_STARTED, {
    report_path: `C:\\data\\games\\${FX5_ID}\\report.json`,
    ocr: fx5Ocr(),
    links: LINKS,
    memos,
  });
}

function scenario(overrides: Partial<Scenario> = {}): Scenario {
  return {
    label: 'main',
    state: baseState,
    settings,
    inputStatus: null,
    sessions: [fx5Imported()],
    reports: { [FX5_ID]: REPORT_TEXTS.fx5 },
    thumb: TINY_PNG,
    ...overrides,
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

async function open(
  options: { width?: number; height?: number; scheme?: Scheme; scenario?: Scenario; reduced?: boolean; table?: boolean } = {},
): Promise<Opened> {
  const context = await browser.newContext({
    viewport: { width: options.width ?? 1280, height: options.height ?? 800 },
    colorScheme: options.scheme ?? 'light',
    reducedMotion: options.reduced === false ? 'no-preference' : 'reduce',
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
  await page.addInitScript(tauriMockScript(options.scenario ?? scenario()));
  await page.goto(new URL('index.html', server.url).toString());
  await waitForMainReady(page);
  // 取り込む前の半荘には、局の評価の表が無い（記録した評価の一覧だけ）。迷いのカードが出るのを待つ
  if (options.table === false) await page.getByRole('article', { name: '迷い1' }).waitFor();
  else await page.getByRole('table', { name: '局の評価' }).waitFor();
  // 画面に近い画像が読み終わるまで待つ（遅延読み込みの、まだ遠い画像は待たない）
  await page.waitForFunction(() =>
    Array.from(document.images)
      .filter((img) => img.getBoundingClientRect().top < window.innerHeight)
      .every((img) => img.complete),
  );
  return { context, page, problems, external };
}

const card = (page: Page, n: number) => page.getByRole('article', { name: `迷い${n}` });
const isFocused = (locator: ReturnType<Page['locator']>) => locator.evaluate((el) => el === document.activeElement);
const calls = (page: Page, cmd: string) =>
  page.evaluate(
    (name) =>
      (window as unknown as { __jrCalls: Array<{ cmd: string; args: unknown }> }).__jrCalls.filter((c) => c.cmd === name).map((c) => c.args),
    cmd,
  );

async function overflow(page: Page) {
  return page.evaluate(() => ({
    scroll: document.documentElement.scrollWidth,
    client: document.documentElement.clientWidth,
    body: document.body.scrollWidth,
    table: Array.from(document.querySelectorAll<HTMLElement>('.tbl-wrap')).map((el) => el.scrollWidth - el.clientWidth),
  }));
}

/** その場の状態へ進める。 */
const STATES: Record<string, (page: Page) => Promise<void>> = {
  default: async () => undefined,
  // 迷いマークの無い迷いを足すパネルを開いて、局のメニューも開く
  addPanel: async (page) => {
    await page.getByRole('button', { name: '迷いマークの無い迷いを足す' }).click();
    await page.getByRole('region', { name: '迷いマークの無い迷いを足す' }).waitFor();
  },
  addMenu: async (page) => {
    await page.getByRole('button', { name: '迷いマークの無い迷いを足す' }).click();
    const panel = page.getByRole('region', { name: '迷いマークの無い迷いを足す' });
    await panel.waitFor();
    await panel.getByRole('button', { name: '追加するメモの局を選ぶ' }).click();
    await page.getByRole('menu', { name: '追加するメモの局' }).waitFor();
  },
};

describe('U-4・U-5・U-6: 迷いの列とメモ（FX-5。実ブラウザ）', () => {
  for (const scheme of SCHEMES) {
    for (const width of [390, 768, 1280] as const) {
      for (const [name, drive] of Object.entries(STATES)) {
        if (width === 768 && name === 'addMenu') continue;
        it(`${name} 幅${width}px ${scheme}: 横スクロールが無く、重大な a11y 違反が無く、Tab で札・メモの欄に届き、外へ通信しない`, async () => {
          const { context, page, problems, external } = await open({ width, scheme });
          try {
            await drive(page);
            await page.waitForTimeout(100);

            const m = await overflow(page);
            expect(m.scroll, `scrollWidth ${m.scroll} > clientWidth ${m.client}`).toBeLessThanOrEqual(m.client);
            expect(m.body).toBeLessThanOrEqual(m.client);
            for (const extra of m.table) expect(extra).toBeLessThanOrEqual(0);

            const axe = await runAxe(page);
            expect(seriousViolations(axe)).toEqual([]);
            expect(axe.passes.find((p) => p.id === 'color-contrast')?.nodes ?? 0).toBeGreaterThan(5);

            if (name === 'default') {
              // 札 13 と、メモの欄（迷い 13 + 追加のメモ 1）× 2 が、画面にある
              expect(await page.getByRole('button', { name: /カードへ移る$/ }).count()).toBe(13);
              expect(await page.getByLabel('候補', { exact: true }).count()).toBe(14);
              expect(await page.getByLabel('理由（1行）', { exact: true }).count()).toBe(14);
              const reach = await unreachableByTab(page);
              expect(reach.total).toBeGreaterThan(60);
              expect(reach.missed).toEqual([]);
            }
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

describe('U-27: 札の置き場所（実ブラウザ）', () => {
  it('幅 1280px: 札は表の最後の列「迷い」に、その局の行の中で並ぶ。同じ局の札は同じ高さの行に収まる', async () => {
    const { context, page } = await open();
    try {
      const layout = await page.evaluate(() => {
        const table = document.querySelector('table.tbl') as HTMLTableElement;
        const headers = Array.from(table.querySelectorAll('thead th')).map((th) => th.textContent);
        const rows = Array.from(table.querySelectorAll('tbody tr')).map((tr) => {
          const rect = tr.getBoundingClientRect();
          const chips = Array.from(tr.querySelectorAll('.mk-chip')).map((chip) => {
            const r = chip.getBoundingClientRect();
            return r.top >= rect.top - 0.5 && r.bottom <= rect.bottom + 0.5 && r.left >= rect.left - 0.5 && r.right <= rect.right + 0.5;
          });
          const cell = tr.querySelector('td.marks-cell') as HTMLElement;
          const cellRect = cell.getBoundingClientRect();
          const last = Array.from(tr.children).at(-1);
          return { chips, inLastColumn: last === cell, cellLeft: Math.round(cellRect.left), rowLeft: Math.round(rect.left) };
        });
        return { headers, rows };
      });
      expect(layout.headers.at(-1)).toBe('迷い');
      expect(layout.rows).toHaveLength(10);
      for (const row of layout.rows) {
        expect(row.inLastColumn).toBe(true);
        expect(row.chips.every(Boolean)).toBe(true);
      }
      // 列の左端は、どの行でもそろう
      expect(new Set(layout.rows.map((row) => row.cellLeft)).size).toBe(1);
    } finally {
      await context.close();
    }
  });

  it('幅 390px: 局ごとのかたまりに、小さな見出し「迷い」つきの行が付く。札が無い局には、行を出さない', async () => {
    const { context, page } = await open({ width: 390 });
    try {
      const rows = await page.evaluate(() => {
        const table = document.querySelector('table.tbl') as HTMLTableElement;
        return Array.from(table.querySelectorAll('tbody tr')).map((tr) => {
          const cell = tr.querySelector('td.marks-cell') as HTMLElement;
          const style = getComputedStyle(cell);
          const before = getComputedStyle(cell, '::before').content;
          const cellRect = cell.getBoundingClientRect();
          const trRect = tr.getBoundingClientRect();
          const maka = tr.querySelector('td[data-label="MAKA"]') as HTMLElement;
          return {
            label: tr.querySelector('th')?.textContent ?? '',
            hidden: style.display === 'none',
            chips: tr.querySelectorAll('.mk-chip').length,
            before,
            below: cellRect.top >= maka.getBoundingClientRect().bottom - 1,
            wide: Math.round(cellRect.width) >= Math.round(trRect.width) - 2,
          };
        });
      });
      for (const row of rows) {
        if (row.chips === 0) {
          expect(row.hidden, row.label).toBe(true);
        } else {
          expect(row.hidden, row.label).toBe(false);
          expect(row.before, row.label).toBe('"迷い"');
          expect(row.below, row.label).toBe(true);
          expect(row.wide, row.label).toBe(true);
        }
      }
      expect(rows.filter((row) => row.chips > 0)).toHaveLength(7);
    } finally {
      await context.close();
    }
  });

  it('札の形: 選んだ札にはチェック、巡目は未定の札の枠は点線、推定の札は実線の枠だけ（枠の線種と中身で見分けられる）', async () => {
    const { context, page } = await open();
    try {
      const shapes = await page.evaluate(() =>
        Array.from(document.querySelectorAll<HTMLElement>('.mk-chip')).map((chip) => ({
          kind: chip.getAttribute('data-kind'),
          border: getComputedStyle(chip).borderTopStyle,
          check: chip.querySelector('svg.mk-ck') !== null,
          background: getComputedStyle(chip).backgroundColor,
          surface: getComputedStyle(document.body).getPropertyValue('--surface'),
        })),
      );
      const by = (kind: string) => shapes.filter((shape) => shape.kind === kind);
      expect(by('undecided').length).toBeGreaterThan(0);
      expect(by('chosen').length).toBeGreaterThan(0);
      expect(by('estimate').length).toBeGreaterThan(0);
      for (const shape of by('undecided')) {
        expect(shape.border).toBe('dashed');
        expect(shape.check).toBe(false);
      }
      for (const shape of by('chosen')) {
        expect(shape.border).toBe('solid');
        expect(shape.check).toBe(true);
      }
      for (const shape of by('estimate')) {
        expect(shape.border).toBe('solid');
        expect(shape.check).toBe(false);
      }
      // 選んだ札だけ、塗りが違う（推定の札と背景色が違う）
      expect(new Set(by('chosen').map((shape) => shape.background)).size).toBe(1);
      expect(by('chosen')[0]?.background).not.toBe(by('estimate')[0]?.background);
    } finally {
      await context.close();
    }
  });
});

describe('U-27: 札からカードへ移る（実ブラウザ）', () => {
  it('札を押すと、そのカードが画面に入り、キーボードの位置が移り、少しの間目立って、そのあと戻る', async () => {
    const { context, page } = await open({ scheme: 'light' });
    try {
      const chip = page.getByRole('button', { name: '迷い12 4巡目 打發（推定）。カードへ移る' });
      await chip.scrollIntoViewIfNeeded();
      await chip.click();
      const target = card(page, 12);
      await page.waitForFunction(() => document.activeElement?.getAttribute('aria-labelledby') !== null && document.activeElement?.tagName === 'ARTICLE');
      expect(await isFocused(target)).toBe(true);
      expect(await target.evaluate((el) => el.classList.contains('is-flash'))).toBe(true);
      const box = await target.boundingBox();
      const viewport = page.viewportSize();
      expect(box).not.toBeNull();
      if (box !== null && viewport !== null) {
        expect(box.y).toBeGreaterThanOrEqual(-1);
        expect(box.y + box.height).toBeLessThanOrEqual(viewport.height + 1);
      }
      // 目立っている間は、縁取り（box-shadow）が付く
      expect(await target.evaluate((el) => getComputedStyle(el).boxShadow)).not.toBe('none');
      await page.waitForFunction(() => document.querySelector('.mcard.is-flash') === null, undefined, { timeout: 5000 });
      expect(await target.evaluate((el) => getComputedStyle(el).boxShadow)).toBe('none');
    } finally {
      await context.close();
    }
  });

  it('Tab で札に着いて Enter を押しても、同じ（巡目は未定の札も）。幅 390px でも', async () => {
    const { context, page } = await open({ width: 390 });
    try {
      const chip = page.getByRole('button', { name: '迷い5 巡目は未定。カードへ移る' });
      await chip.scrollIntoViewIfNeeded();
      await chip.focus();
      await page.keyboard.press('Enter');
      expect(await isFocused(card(page, 5))).toBe(true);
      expect(await card(page, 5).evaluate((el) => el.classList.contains('is-flash'))).toBe(true);
      const box = await card(page, 5).boundingBox();
      expect(box?.x ?? -1).toBeGreaterThanOrEqual(0);
      const m = await overflow(page);
      expect(m.scroll).toBeLessThanOrEqual(m.client);
    } finally {
      await context.close();
    }
  });
});

describe('U-28: メモの保存と取り消し（実ブラウザ）', () => {
  it('実際のキーで打って Tab で外へ出ると保存し、Enter でも保存する。欄の外での Ctrl+Z で戻る', async () => {
    const { context, page } = await open();
    try {
      const memo = card(page, 5).getByRole('group', { name: '迷い5のメモ' });
      await memo.getByLabel('候補', { exact: true }).click();
      await page.keyboard.type('1p・8p');
      await page.keyboard.press('Tab');
      await page.waitForFunction(() => document.querySelectorAll('.mcard').length > 0);
      await expect.poll(async () => (await calls(page, 'set_memo')).length, { timeout: 5000 }).toBeGreaterThanOrEqual(1);
      const first = (await calls(page, 'set_memo')).at(-1) as { sessionId: string; markId: number; candidates: string; reason: string };
      // 迷い 5 の記録の番号は 8
      expect(first).toMatchObject({ sessionId: FX5_ID, markId: 8, candidates: '1p・8p', reason: '' });
      await page.keyboard.type('東を残す');
      await page.keyboard.press('Enter');
      await expect.poll(async () => ((await calls(page, 'set_memo')).at(-1) as { reason: string }).reason, { timeout: 5000 }).toBe('東を残す');
      expect(await memo.getByLabel('理由（1行）', { exact: true }).inputValue()).toBe('東を残す');

      // 欄の外では、直前の保存が戻る（理由だけが消える）
      await page.locator('h1').click();
      await page.keyboard.press('Control+z');
      await expect.poll(async () => ((await calls(page, 'set_memo')).at(-1) as { reason: string }).reason, { timeout: 5000 }).toBe('');
      await expect.poll(() => memo.getByLabel('理由（1行）', { exact: true }).inputValue(), { timeout: 5000 }).toBe('');
      expect(await memo.getByLabel('候補', { exact: true }).inputValue()).toBe('1p・8p');
    } finally {
      await context.close();
    }
  });

  it('メモを足す（局 → 判断 → 候補 → 足す）と、追加のメモのカードが増え、保存が呼ばれる。足したカードの「候補」へキーボードの位置が移る', async () => {
    const { context, page } = await open();
    try {
      await page.getByRole('button', { name: '迷いマークの無い迷いを足す' }).click();
      const panel = page.getByRole('region', { name: '迷いマークの無い迷いを足す' });
      await panel.getByRole('button', { name: '追加するメモの局を選ぶ' }).click();
      await page.getByRole('menuitemradio', { name: '南3局' }).click();
      await panel.getByRole('button', { name: '追加するメモの巡目と判断を選ぶ' }).click();
      await page.getByRole('menuitemradio').first().click();
      await panel.getByLabel('候補', { exact: true }).fill('發・白');
      await panel.getByRole('button', { name: '足す' }).click();
      await expect.poll(async () => (await calls(page, 'set_extra_memo')).length, { timeout: 5000 }).toBe(1);
      expect(((await calls(page, 'set_extra_memo'))[0] as { id: string; decision: string }).id).toBe('x2');
      expect(await page.getByRole('article', { name: '追加のメモ' }).count()).toBe(2);
      await expect
        .poll(() => page.evaluate(() => (document.activeElement as HTMLInputElement | null)?.value ?? null), { timeout: 5000 })
        .toBe('發・白');
    } finally {
      await context.close();
    }
  });
});

// ---- 取り込む前の半荘（FX-4。結果を取り込んでいない）----

const PRE_ID = '20261009-190953';

/** 取り込む前に足した追加のメモ（東3局 9巡目。位置だけ）と、迷い 3（記録の番号 3）のメモ。 */
const PRE_MEMOS: Memos = {
  marks: { '3': { candidates: '南・6m', reason: '東を残して形を整えたい' } },
  extras: [{ id: 'x1', position: { kyoku: 2, honba: 0, junme: 9 }, candidates: '5s・發', reason: '押すか引くか迷った' }],
};

function preScenario(memos: Memos = PRE_MEMOS): Scenario {
  return scenario({
    sessions: [fx4Session(PRE_ID, new Date(2026, 9, 9, 19, 9, 0).getTime(), { memos })],
    reports: {},
  });
}

const openPanel = async (page: Page) => {
  await page.getByRole('button', { name: '迷いマークの無い迷いを足す' }).click();
  const panel = page.getByRole('region', { name: '迷いマークの無い迷いを足す' });
  await panel.waitFor();
  return panel;
};

const PRE_STATES: Record<string, (page: Page) => Promise<void>> = {
  default: async () => undefined,
  // 位置を入れるパネルを開く
  prePanel: async (page) => {
    await openPanel(page);
  },
  // 局のメニューを開く（12 の局が並ぶ）
  preMenu: async (page) => {
    const panel = await openPanel(page);
    await panel.getByRole('button', { name: '追加するメモの局を選ぶ' }).click();
    await page.getByRole('menu', { name: '追加するメモの局' }).waitFor();
  },
  // 局・本場・巡目・候補・理由を入れた状態（「足す」が押せる）
  preFilled: async (page) => {
    const panel = await openPanel(page);
    await panel.getByRole('button', { name: '追加するメモの局を選ぶ' }).click();
    await page.getByRole('menuitemradio', { name: '南4局' }).click();
    await panel.getByRole('spinbutton', { name: '本場' }).fill('1');
    await panel.getByRole('spinbutton', { name: '巡目' }).fill('12');
    await panel.getByLabel('候補', { exact: true }).fill('リーチ');
    await panel.getByLabel('理由（1行）', { exact: true }).fill('待ちが良い');
  },
  // 範囲の外の巡目（理由の 1 行が出る）
  preInvalid: async (page) => {
    const panel = await openPanel(page);
    await panel.getByRole('spinbutton', { name: '巡目' }).fill('31');
    await panel.getByText('巡目は 1〜30 で入れてください。').waitFor();
  },
};

describe('U-4・U-5・U-6・U-28: 取り込む前の半荘の、迷いマークの無い迷いを足す（実ブラウザ）', () => {
  for (const scheme of SCHEMES) {
    for (const width of [390, 1280] as const) {
      for (const [name, drive] of Object.entries(PRE_STATES)) {
        it(`${name} 幅${width}px ${scheme}: 横スクロールが無く、重大な a11y 違反が無く、Tab で位置の入力・メモの欄に届き、外へ通信しない`, async () => {
          const { context, page, problems, external } = await open({ width, scheme, scenario: preScenario(), table: false });
          try {
            await drive(page);
            await page.waitForTimeout(100);

            const m = await overflow(page);
            expect(m.scroll, `scrollWidth ${m.scroll} > clientWidth ${m.client}`).toBeLessThanOrEqual(m.client);
            expect(m.body).toBeLessThanOrEqual(m.client);

            const axe = await runAxe(page);
            expect(seriousViolations(axe)).toEqual([]);
            expect(axe.passes.find((p) => p.id === 'color-contrast')?.nodes ?? 0).toBeGreaterThan(5);

            if (name === 'default') {
              // 取り込む前でも、足すボタンがあり、「取り込んだあとに足せます」の 1 行は無い
              expect(await page.getByRole('button', { name: '迷いマークの無い迷いを足す' }).count()).toBe(1);
              expect(await page.getByText('取り込んだあとに足せます').count()).toBe(0);
              // 迷い 6 + 追加のメモ 1 の「候補」「理由（1行）」。追加のメモは位置の呼び名で出る
              expect(await page.getByLabel('候補', { exact: true }).count()).toBe(7);
              expect(await page.getByLabel('理由（1行）', { exact: true }).count()).toBe(7);
              expect(await page.getByText('東3局 9巡目').count()).toBe(1);
              // 説明の (i) は、見出しのそばに 1 つ
              expect(await page.getByRole('button', { name: '終局直後のメモの説明' }).count()).toBe(1);
            }
            if (name === 'default' || name === 'prePanel' || name === 'preFilled' || name === 'preInvalid') {
              const reach = await unreachableByTab(page);
              expect(reach.total).toBeGreaterThan(20);
              expect(reach.missed).toEqual([]);
            }
            if (name === 'preInvalid') {
              const junme = page.getByRole('spinbutton', { name: '巡目' });
              expect(await junme.getAttribute('aria-invalid')).toBe('true');
              expect(await page.getByRole('button', { name: '足す', exact: true }).isDisabled()).toBe(true);
            }
            if (name === 'preMenu') {
              expect(await page.getByRole('menuitemradio').count()).toBe(12);
            }
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

describe('U-28: 取り込む前の半荘で、メモを足す（実ブラウザ）', () => {
  it('Tab の順: 見出し → 局のメニュー → 本場 → 巡目 → 候補 → 理由 → 足す → やめる。局のメニューは、キーボードだけで開ける', async () => {
    const { context, page } = await open({ scenario: preScenario(), table: false });
    try {
      await PRE_STATES.preFilled?.(page);
      await page.getByRole('heading', { name: '迷いマークの無い迷いを足す' }).focus();
      const names: string[] = [];
      for (let i = 0; i < 7; i += 1) {
        await page.keyboard.press('Tab');
        names.push(
          await page.evaluate(() => {
            const el = document.activeElement as HTMLInputElement | null;
            return el?.getAttribute('aria-label') ?? el?.labels?.[0]?.textContent ?? el?.textContent ?? '';
          }),
        );
      }
      expect(names).toEqual(['追加するメモの局 南4局', '本場', '巡目', '候補', '理由（1行）', '足す', 'やめる']);
      await page.getByRole('button', { name: '追加するメモの局 南4局' }).focus();
      await page.keyboard.press('Enter');
      await page.getByRole('menu', { name: '追加するメモの局' }).waitFor();
      await page.keyboard.press('Escape');
      expect(await isFocused(page.getByRole('button', { name: '追加するメモの局 南4局' }))).toBe(true);
    } finally {
      await context.close();
    }
  });

  it('実際のマウス・キーで局・巡目・候補を入れて「足す」と、位置（判断の鍵なし）で保存し、カードが並び、キーボードの位置は新しいカードの「候補」へ移る', async () => {
    const { context, page } = await open({ scenario: preScenario({ marks: {}, extras: [] }), table: false });
    try {
      const panel = await openPanel(page);
      await panel.getByRole('button', { name: '追加するメモの局を選ぶ' }).click();
      await page.getByRole('menuitemradio', { name: '東3局' }).click();
      await panel.getByRole('spinbutton', { name: '巡目' }).click();
      await page.keyboard.type('9');
      await panel.getByLabel('候補', { exact: true }).fill('5s・發');
      await panel.getByRole('button', { name: '足す', exact: true }).click();
      await expect.poll(async () => (await calls(page, 'set_extra_memo')).length, { timeout: 5000 }).toBe(1);
      expect((await calls(page, 'set_extra_memo'))[0]).toEqual({
        sessionId: PRE_ID,
        id: 'x1',
        decision: null,
        position: { kyoku: 2, honba: 0, junme: 9 },
        candidates: '5s・發',
        reason: '',
      });
      await page.getByRole('group', { name: '追加のメモ 東3局 9巡目' }).waitFor();
      await expect
        .poll(() => page.evaluate(() => (document.activeElement as HTMLInputElement | null)?.value ?? null), { timeout: 5000 })
        .toBe('5s・發');
      // 取り込む前の半荘では、判断を選ぶ欄は出ない
      expect(await page.getByRole('button', { name: '追加のメモの局面を選んでください' }).count()).toBe(0);
    } finally {
      await context.close();
    }
  });

  it('説明の (i) に乗せると、終局直後のメモの説明が、見出しの近くに重なって出る（幅 390px でも、窓の中に収まる）', async () => {
    for (const width of [1280, 390]) {
      const { context, page } = await open({ width, scenario: preScenario(), table: false });
      try {
        await page.getByRole('button', { name: '終局直後のメモの説明' }).hover();
        const tip = page.getByRole('tooltip').filter({ hasText: 'AI の答えを見る前に' });
        await tip.waitFor();
        const box = await tip.boundingBox();
        expect(box).not.toBeNull();
        if (box !== null) {
          expect(box.x).toBeGreaterThanOrEqual(0);
          expect(box.x + box.width).toBeLessThanOrEqual(width + 1);
        }
        const m = await overflow(page);
        expect(m.scroll).toBeLessThanOrEqual(m.client);
      } finally {
        await context.close();
      }
    }
  });
});

describe('U-46: 迷いだけを記録する設定が入のとき、終局直後のメモの欄を出さない（FX-5。実ブラウザ）', () => {
  const doubtScenario = (overrides: Partial<Scenario> = {}) => scenario({ settings: { ...settings, doubt_only: true }, ...overrides });

  for (const scheme of SCHEMES) {
    for (const width of [390, 1280] as const) {
      it(`取り込んだ半荘 幅${width}px ${scheme}: メモの欄・追加のメモ・足す欄・メモの説明が無く、迷いの札と、局の評価の表の説明は残る。横スクロールが無く、重大な a11y 違反が無く、Tab で全部に届く`, async () => {
        const { context, page, problems, external } = await open({ width, scheme, scenario: doubtScenario() });
        try {
          expect(await page.locator('.mcard .memo, .marks.extras, .memo-foot, .memo-add').count()).toBe(0);
          expect(await page.getByLabel('候補').count()).toBe(0);
          expect(await page.getByRole('button', { name: /迷いマークの無い迷いを足す|終局直後のメモの説明/ }).count()).toBe(0);
          expect(await page.getByRole('button', { name: '迷いの札の説明' }).count()).toBe(1);
          // 迷いの札（局の評価の表の「迷い」の列）は、そのまま 13 枚
          expect(await page.getByRole('button', { name: /カードへ移る$/ }).count()).toBe(13);
          expect(await page.getByRole('article').count()).toBe(13);
          // 書いてあったメモの文字は、画面のどこにも出ない
          const body = await page.evaluate(() => document.body.innerText);
          for (const hidden of ['形を崩したくない', 'ポン・スルー', '押すか引くか迷った']) expect(body).not.toContain(hidden);

          const f = await page.evaluate(() => ({
            scroll: document.documentElement.scrollWidth,
            client: document.documentElement.clientWidth,
            table: [...document.querySelectorAll<HTMLElement>('.tbl-wrap')].map((el) => el.scrollWidth - el.clientWidth),
            // 札は、表の外へ出ない
            chipsOutside: [...document.querySelectorAll<HTMLElement>('.mk-chip')].filter((chip) => {
              const box = chip.getBoundingClientRect();
              const wrap = (chip.closest('.tbl-wrap') as HTMLElement).getBoundingClientRect();
              return box.right > wrap.right + 1 || box.left < wrap.left - 1;
            }).length,
          }));
          expect(f.scroll).toBeLessThanOrEqual(f.client);
          for (const extra of f.table) expect(extra).toBeLessThanOrEqual(0);
          expect(f.chipsOutside).toBe(0);
          const axe = await runAxe(page);
          expect(seriousViolations(axe)).toEqual([]);
          const reach = await unreachableByTab(page);
          expect(reach.total).toBeGreaterThan(10);
          expect(reach.missed).toEqual([]);
          expect(problems).toEqual([]);
          expect(external).toEqual([]);
        } finally {
          await context.close();
        }
      });
    }
  }

  it('札を押すと、そのカードへ移って目立つ（メモの欄が無くても、移る先のカードは同じ）。幅 390px でも', async () => {
    for (const width of [1280, 390]) {
      const { context, page } = await open({ width, scenario: doubtScenario() });
      try {
        const chip = page.getByRole('button', { name: /迷い1 .*カードへ移る$/ }).first();
        await chip.scrollIntoViewIfNeeded();
        await chip.click();
        await page.waitForFunction(() => document.activeElement?.id === 'mark-card-1');
        expect(await page.locator('#mark-card-1').evaluate((el) => el.classList.contains('is-flash'))).toBe(true);
      } finally {
        await context.close();
      }
    }
  });

  it('取り込む前の半荘 幅 390px: 迷いのカードだけが並び、メモの欄も足す欄も無い。横スクロールが無い', async () => {
    const recorded = fx4Session('20261009-161200', new Date(2026, 9, 9, 16, 12).getTime());
    const marks = recorded.marks.slice(0, 2).map((mark) => ({ ...mark, screenshot: null, capture: null, capture_error: '試験の画像なし', screenshot_path: null }));
    const session = { ...recorded, mark_count: 2, marks, rating_count: 0, ratings: [], memos: MEMOS };
    const { context, page } = await open({ width: 390, table: false, scenario: doubtScenario({ sessions: [session], reports: {} }) });
    try {
      expect(await page.getByRole('article').count()).toBe(2);
      expect(await page.locator('.mcard .memo, .memo-foot, .memo-add, .marks.extras').count()).toBe(0);
      expect(await page.getByRole('button', { name: /迷いマークの無い迷いを足す|終局直後のメモの説明/ }).count()).toBe(0);
      const f = await page.evaluate(() => ({ scroll: document.documentElement.scrollWidth, client: document.documentElement.clientWidth }));
      expect(f.scroll).toBeLessThanOrEqual(f.client);
    } finally {
      await context.close();
    }
  });

  it('設定を切ると（settings-changed）、メモの欄・追加のメモ・足す欄・説明が元どおり出て、書いてあったメモが入っている。入れ直すと隠れる', async () => {
    const { context, page } = await open({ width: 1280, scenario: doubtScenario() });
    try {
      const flip = (doubtOnly: boolean) =>
        page.evaluate(async (value) => {
          const w = window as unknown as {
            __TAURI_INTERNALS__: { invoke: (cmd: string) => Promise<Record<string, unknown>> };
            __jrEmit: (event: string, payload: unknown) => void;
          };
          const current = await w.__TAURI_INTERNALS__.invoke('get_settings');
          w.__jrEmit('settings-changed', { ...current, doubt_only: value });
        }, doubtOnly);
      await flip(false);
      const group = page.getByRole('group', { name: '迷い3のメモ' });
      await group.waitFor();
      expect(await group.getByLabel('候補').inputValue()).toBe('3m・6p');
      expect(await page.getByRole('list', { name: '追加のメモの一覧' }).count()).toBe(1);
      expect(await page.getByRole('button', { name: /迷いマークの無い迷いを足す/ }).count()).toBe(1);
      expect(await page.getByRole('button', { name: '終局直後のメモの説明' }).count()).toBe(1);
      await flip(true);
      await page.waitForFunction(() => document.querySelector('.mcard .memo') === null);
      expect(await page.getByRole('button', { name: /迷いマークの無い迷いを足す/ }).count()).toBe(0);
    } finally {
      await context.close();
    }
  });
});

