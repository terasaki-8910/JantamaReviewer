// @vitest-environment node
/**
 * 実ブラウザで、今日の出題・出題・解き直し（受け入れ枚数の小窓・役の欄・ドラを目立たせる）を検査する（U-1・U-4・U-5・U-6・U-18・U-19・U-33・N-8）。
 *
 * - U-4: 幅 390・768・1280px で、各状態（今日の出題・出題の答える前／あと・小窓・2 向聴からの先・鳴き・解き直し）に横スクロールが出ない。
 *   卓は、自分の列の中に収まる
 * - U-5・U-6: axe の重大な違反が 0 件（色のコントラストを含む）。ライトとダーク。Tab ですべての操作に届く（手牌・答えのボタンは、
 *   止まり場所が 1 つで、矢印キーで動く）
 * - U-18: 小窓は、行のそばに出て、行に重ならない。幅 390px では画面の下から出て、幅いっぱい。Esc・外の押下で閉じ、押した行へ戻る
 * - U-19: ドラ表示牌が指す牌の面が黄色（描いた色を読む）。牌の図柄と黄色のコントラストは 3:1 以上
 * - U-33: 役の欄は、答え合わせのあとの受け入れ枚数の欄の下に出て、幅 390・768・1280px で欄の中身がはみ出さない。警告（札「役無し」・太字の文）は、
 *   色以外（濃い枠・字の太さ）でも見分けられる。説明のアイコンは、Tab で受け入れ枚数のあと・差の原因の前に届く。axe の重大は、上の状態の検査に含まれる
 * - U-1: 答える前の DOM に AI の情報は無い。牌の画像はすべて読み込めて、引きずれない（N-8）。外へ通信しない
 * jsdom の試験（src/main/study）と同じふるまいを、実際の描画・キー・時計で確かめる。
 */
import { importReportText, listProblems } from '@jantama/engine';
import type { Browser, BrowserContext, Locator, Page } from 'playwright-core';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import { contrast, parseCssColor } from '../color-math';
import { REPORT_TEXTS, local, seedSession } from '../fake-sessions';
import { fx4Ocr, fx4Session } from '../import-fixtures';
import {
  TINY_PNG,
  boxesOverlap,
  ensureSidebar,
  launchBrowser,
  measureInfoTip,
  runAxe,
  seriousViolations,
  startPageServer,
  tauriMockScript,
  unreachableByTab,
  waitForMainReady,
  waitForSidebarCounts,
  type BoxRect,
  type PageServer,
  type Scenario,
} from './harness';
import { faceColor, multiply, patternColors } from './tile-colors';

const SCHEMES = ['light', 'dark'] as const;
type Scheme = (typeof SCHEMES)[number];

/** 試験の「いま」: 2026 年 10 月 9 日 22:00。 */
const NOW = new Date(2026, 9, 9, 22, 0, 0);

const FX4_ID = '20261009-190953';
const FX1A_ID = '20261009-171200';

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

/** FX-4（読み取りの写しつき。迷い 1〜5 は推定）と、f9da。 */
function sessions() {
  return [
    fx4Session(FX4_ID, local(2026, 10, 9, 19, 9), { report_path: `C:\\data\\games\\${FX4_ID}\\report.json`, ocr: fx4Ocr() }),
    seedSession(local(2026, 10, 9, 17, 12), { id: FX1A_ID, report: 'fx1a' }).session,
  ];
}

/** FX-4 の大きな不一致の先頭 3 問（`keys` を渡したときは、その判断）を、期限が今日以前の答えとして保存済みにする（解き直しの問題）。 */
function dueAnswers(keys?: readonly string[]): unknown[] {
  const imported = importReportText(REPORT_TEXTS.fx4);
  if (!imported.ok) throw new Error('FX-4 を読めません');
  const problems =
    keys ??
    listProblems([{ sessionId: FX4_ID, startedMs: local(2026, 10, 9, 19, 9), game: imported.value, markKeys: [] }], {
      threshold: 0.05,
    })
      .slice(0, 3)
      .map((problem) => problem.key);
  return problems.map((key, index) => ({
    id: index + 1,
    session_id: FX4_ID,
    decision_key: key,
    mode: 'quiz',
    shown_at: 1,
    answered_at: 2 + index,
    choice: { type: 'dahai', tile: '1m' },
    reason: '前に書いた理由',
    duration_ms: 1000,
    reselect_count: 0,
    correct: false,
    causes: [],
    principle: '',
    maka_move: null,
    interval_days: 3,
    due_date: '2026-10-09',
  }));
}

function scenario(overrides: Partial<Scenario> & { dora?: boolean; due?: boolean; dueKeys?: readonly string[] } = {}): Scenario {
  const { dora = false, due = false, dueKeys, ...rest } = overrides;
  return {
    label: 'main',
    state: baseState,
    settings: { ...baseSettings, highlight_dora: dora },
    inputStatus: null,
    sessions: sessions(),
    reports: { [FX4_ID]: REPORT_TEXTS.fx4, [FX1A_ID]: REPORT_TEXTS.fx1a },
    thumb: TINY_PNG,
    answers: dueKeys !== undefined ? dueAnswers(dueKeys) : due ? dueAnswers() : [],
    ...rest,
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
  scenario?: Scenario;
}

async function open(options: OpenOptions = {}): Promise<Opened> {
  const context = await browser.newContext({
    viewport: { width: options.width ?? 1280, height: options.height ?? 900 },
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
  await page.addInitScript(tauriMockScript(options.scenario ?? scenario()));
  await page.goto(new URL('index.html', server.url).toString());
  await waitForMainReady(page);
  // 出題のデータ（半荘の再生・答えの記録・今日の組）が読み終わると、サイドバーに数が出る
  await waitForSidebarCounts(page, 20_000);
  return { context, page, problems, external };
}

const sideButton = (page: Page, name: RegExp) =>
  page.getByRole('navigation', { name: 'メイン' }).getByRole('button', { name });

/** 今日の出題の一覧を開く。 */
async function openToday(page: Page): Promise<void> {
  await ensureSidebar(page);
  await sideButton(page, /^今日の出題/).click();
  await page.getByRole('list', { name: '今日の出題' }).waitFor();
}

/** 今日の出題の n 行目（1 から）の問題を開く。 */
async function openRow(page: Page, n: number): Promise<void> {
  await openToday(page);
  await page.getByRole('list', { name: '今日の出題' }).getByRole('button').nth(n - 1).click();
  await page.locator('.qz').waitFor();
}

/** 解き直しを開く。 */
async function openReview(page: Page): Promise<void> {
  await ensureSidebar(page);
  await sideButton(page, /^解き直し/).click();
  await page.locator('.qz').waitFor();
}

/** 答えを選んで、理由を書いて、答え合わせまで進める（打牌は手牌の右端、ほかは 1 つ目のボタン）。 */
async function answerCurrent(page: Page, pick: 'last' | 'first' = 'last'): Promise<void> {
  const hand = page.locator('.hand .tile-btn');
  if ((await hand.count()) > 0) await (pick === 'last' ? hand.last() : hand.first()).click();
  else await page.getByRole('radio').first().click();
  await page.getByLabel('理由（1行）').fill('孤立牌を切って、受け入れを広く');
  await page.getByRole('button', { name: '答え合わせ' }).click();
  await page.getByRole('heading', { name: 'AIの評価（Mortal）' }).waitFor();
}

/** 受け入れ枚数の n 行目（0 から）を開く。 */
async function openUkeire(page: Page, n = 0): Promise<Locator> {
  const row = page.locator('.uk-open').nth(n);
  await row.scrollIntoViewIfNeeded();
  await row.click();
  await page.locator('#ukpop').waitFor();
  return row;
}

interface StateDef {
  name: string;
  scenario?: Partial<Scenario> & { dora?: boolean; due?: boolean; dueKeys?: readonly string[] };
  run: (page: Page) => Promise<void>;
}

/** 答えを選んで（`pick`）、理由を書いて、答え合わせまで進める。 */
async function answerWith(page: Page, pick: () => Promise<void>): Promise<void> {
  await pick();
  await page.getByLabel('理由（1行）').fill('役を見て選んだ');
  await page.getByRole('button', { name: '答え合わせ' }).click();
  await page.getByRole('heading', { name: 'AIの評価（Mortal）' }).waitFor();
}

/** 役の欄の見本の場面（FX-4）。東2局1本場 8巡目の打牌（実戦 4p・AI 7p）と、東3局1本場 11巡目のチー（5s 7s は役無し聴牌）。 */
const YAKU_DISCARD_KEY = 'k1h1e9';
const YAKU_CHI_KEY = 'k2h1e15';

/** 検査する状態。FX-4 の今日の組は、迷い 1〜5（1 行目: 打牌・1 向聴、3 行目: 打牌・2 向聴、4 行目: 鳴き）。 */
const STATES: StateDef[] = [
  { name: '今日の出題の一覧', run: openToday },
  { name: '出題（打牌・答える前）', run: (page) => openRow(page, 1) },
  {
    name: '出題（打牌・答え合わせのあと）',
    run: async (page) => {
      await openRow(page, 1);
      await answerCurrent(page);
    },
  },
  {
    name: '出題（受け入れ枚数の小窓）',
    run: async (page) => {
      await openRow(page, 1);
      await answerCurrent(page);
      await openUkeire(page, 0);
    },
  },
  {
    name: '出題（2 向聴からの先）',
    run: async (page) => {
      await openRow(page, 3);
      await answerCurrent(page);
      await openUkeire(page, 0);
      await page.getByRole('tab', { name: '2向聴からの先' }).click();
    },
  },
  { name: '出題（鳴き・答える前）', run: (page) => openRow(page, 4) },
  {
    name: '出題（鳴き・答え合わせのあと）',
    run: async (page) => {
      await openRow(page, 4);
      await answerCurrent(page);
    },
  },
  { name: '解き直し（答える前）', scenario: { due: true }, run: openReview },
  {
    name: '解き直し（答え合わせのあと）',
    scenario: { due: true },
    run: async (page) => {
      await openReview(page);
      await answerCurrent(page);
    },
  },
  {
    name: '出題（ドラを目立たせる・答え合わせのあと）',
    scenario: { dora: true },
    run: async (page) => {
      await openRow(page, 3);
      await answerCurrent(page);
    },
  },
  {
    name: '解き直し（役の欄: 打牌・行動が 3 行に分かれる・答え合わせのあと）',
    scenario: { dueKeys: [YAKU_DISCARD_KEY] },
    run: async (page) => {
      await openReview(page);
      await answerWith(page, () => page.getByRole('button', { name: '東を切る' }).first().click());
    },
  },
  {
    name: '解き直し（役の欄: チー・役無しの警告・答え合わせのあと）',
    scenario: { dueKeys: [YAKU_CHI_KEY] },
    run: async (page) => {
      await openReview(page);
      await answerWith(page, () => page.locator('[data-option="chi:5s+7s"]').click());
    },
  },
  {
    name: '解き直し（役の欄: 1 つにまとまる・答え合わせのあと）',
    scenario: { dueKeys: [YAKU_DISCARD_KEY] },
    run: async (page) => {
      await openReview(page);
      await answerWith(page, () => page.getByRole('button', { name: '四筒を切る' }).first().click());
    },
  },
];

async function openState(state: StateDef, options: Omit<OpenOptions, 'scenario'> = {}): Promise<Opened> {
  const opened = await open({ ...options, scenario: scenario(state.scenario) });
  await state.run(opened.page);
  await opened.page.waitForFunction(() => Array.from(document.images).every((img) => img.complete));
  return opened;
}

async function overflow(page: Page) {
  return page.evaluate(() => {
    const table = document.querySelector('.table');
    const column = document.querySelector('.board-col');
    return {
      scroll: document.documentElement.scrollWidth,
      client: document.documentElement.clientWidth,
      body: document.body.scrollWidth,
      // 卓は、自分の列からはみ出さない
      tableRight: table === null ? 0 : table.getBoundingClientRect().right,
      columnRight: column === null ? 0 : column.getBoundingClientRect().right,
    };
  });
}

describe('U-4・U-5・U-6: 各状態の、幅・アクセシビリティ・テーマ', () => {
  for (const state of STATES) {
    it(`${state.name}: 幅 390・768・1280px で横スクロールが出ない。axe の重大な違反が 0 件（ライト・ダーク）`, { timeout: 120_000 }, async () => {
      for (const width of [390, 768, 1280]) {
        const { context, page, problems, external } = await openState(state, { width });
        try {
          const o = await overflow(page);
          expect(o.scroll, `${state.name} @${width}`).toBeLessThanOrEqual(o.client);
          expect(o.body, `${state.name} @${width} body`).toBeLessThanOrEqual(o.client);
          expect(o.tableRight, `${state.name} @${width} table`).toBeLessThanOrEqual(o.columnRight + 1);
          if (width !== 768) {
            for (const scheme of SCHEMES) {
              const themed = scheme === 'light' ? { context, page } : await openState(state, { width, scheme });
              try {
                const found = seriousViolations(await runAxe(themed.page));
                expect(found, `${state.name} @${width} ${scheme}`).toEqual([]);
              } finally {
                if (scheme !== 'light') await themed.context.close();
              }
            }
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

describe('U-5: Tab ですべての操作に届く', () => {
  const ROVING = '.hand .tile-btn, [role="radio"], [role="tab"]';
  for (const state of STATES.filter((s) => !s.name.includes('小窓') && !s.name.includes('2 向聴'))) {
    it(`${state.name}: 手牌・答えのボタンは止まり場所が 1 つ。残りはすべて、Tab で届く`, { timeout: 60_000 }, async () => {
      const { context, page } = await openState(state);
      try {
        const reach = await unreachableByTab(page, { roving: ROVING });
        expect(reach.total).toBeGreaterThan(5);
        expect(reach.missed).toEqual([]);
        // 手牌は 1 か所だけ、答えのボタンも 1 か所だけが、Tab の止まり場所
        const stops = await page.evaluate(() => ({
          hand: document.querySelectorAll('.hand .tile-btn:not([disabled])[tabindex="0"]').length,
          handAll: document.querySelectorAll('.hand .tile-btn:not([disabled])').length,
          radio: document.querySelectorAll('[role="radio"][tabindex="0"]').length,
          radioAll: document.querySelectorAll('[role="radio"]').length,
        }));
        if (stops.handAll > 0) expect(stops.hand).toBe(1);
        if (stops.radioAll > 0) expect(stops.radio).toBe(1);
      } finally {
        await context.close();
      }
    });
  }

  it('キーボードだけで答える: 手牌の矢印キーと Space で選び、Tab で理由、もう一度 Tab で答え合わせ。答えの見出しへ移る', { timeout: 60_000 }, async () => {
    const { context, page } = await openState(STATES[1] as StateDef);
    try {
      const stop = page.locator('.hand .tile-btn[tabindex="0"]');
      await stop.focus();
      await page.keyboard.press('ArrowRight');
      await page.keyboard.press('End');
      await page.keyboard.press('Space');
      await expect.poll(() => page.locator('.hand .tile-btn[aria-pressed="true"]').count()).toBe(1);
      // 選んだ牌が、Tab の止まり場所
      expect(await page.evaluate(() => document.activeElement?.getAttribute('aria-pressed'))).toBe('true');
      await page.keyboard.press('Tab');
      expect(await page.evaluate(() => document.activeElement?.id)).toBe('reason');
      await page.keyboard.type('キーボードだけで答える');
      await page.keyboard.press('Tab');
      expect(await page.evaluate(() => document.activeElement?.id)).toBe('submit');
      await page.keyboard.press('Enter');
      await page.getByRole('heading', { name: 'AIの評価（Mortal）' }).waitFor();
      expect(await page.evaluate(() => document.activeElement?.id)).toBe('reveal-h');
      // 答え合わせのあと: 次の問題へ（キーボードの位置は、次の問題の手牌へ）
      await page.getByRole('button', { name: '次の問題へ' }).focus();
      await page.keyboard.press('Enter');
      await page.getByRole('heading', { level: 1, name: '東2局 11巡目' }).waitFor();
      await expect
        .poll(() => page.evaluate(() => document.activeElement?.closest('.hand') !== null))
        .toBe(true);
    } finally {
      await context.close();
    }
  });

  it('鳴きの答えのボタンは、矢印キーで動かすだけ（選ぶのは Space）。Tab の止まり場所は 1 つ', { timeout: 60_000 }, async () => {
    const { context, page } = await openState(STATES[5] as StateDef);
    try {
      const radios = page.getByRole('radio');
      await radios.first().focus();
      await page.keyboard.press('ArrowDown');
      expect(await page.evaluate(() => document.activeElement?.getAttribute('data-option'))).toBe('pass');
      expect(await radios.evaluateAll((all) => all.map((r) => r.getAttribute('aria-checked')))).toEqual(['false', 'false']);
      await page.keyboard.press('Space');
      expect(await radios.evaluateAll((all) => all.map((r) => r.getAttribute('aria-checked')))).toEqual(['false', 'true']);
      // 選んだボタンが、Tab の止まり場所
      expect(await radios.evaluateAll((all) => all.map((r) => (r as HTMLElement).tabIndex))).toEqual([-1, 0]);
    } finally {
      await context.close();
    }
  });
});

describe('U-18: 受け入れ枚数の小窓', () => {
  it('幅 1280px: 行のそばに出て、行に重ならず、窓の中に収まる。Esc で閉じて、押した行に戻る', { timeout: 60_000 }, async () => {
    const { context, page } = await openState(STATES[2] as StateDef);
    try {
      const row = await openUkeire(page, 0);
      const geometry = await page.evaluate(() => {
        const pop = document.getElementById('ukpop') as HTMLElement;
        const trigger = document.querySelector('.uk-open[aria-expanded="true"]') as HTMLElement;
        const a = pop.getBoundingClientRect();
        const b = trigger.getBoundingClientRect();
        return {
          pop: { left: a.left, right: a.right, top: a.top, bottom: a.bottom },
          row: { left: b.left, right: b.right, top: b.top, bottom: b.bottom },
          vw: window.innerWidth,
          vh: window.innerHeight,
          sheet: pop.classList.contains('sheet'),
          position: getComputedStyle(pop).position,
          scrollWidth: document.documentElement.scrollWidth,
        };
      });
      expect(geometry.sheet).toBe(false);
      expect(geometry.position).toBe('fixed');
      expect(geometry.pop.left).toBeGreaterThanOrEqual(0);
      expect(geometry.pop.right).toBeLessThanOrEqual(geometry.vw);
      expect(geometry.pop.top).toBeGreaterThanOrEqual(0);
      expect(geometry.pop.bottom).toBeLessThanOrEqual(geometry.vh);
      // 行に重ならない（横に置くか、上か下に置く）
      const overlaps =
        geometry.pop.left < geometry.row.right &&
        geometry.pop.right > geometry.row.left &&
        geometry.pop.top < geometry.row.bottom &&
        geometry.pop.bottom > geometry.row.top;
      expect(overlaps).toBe(false);
      expect(geometry.scrollWidth).toBeLessThanOrEqual(geometry.vw);
      // 小窓にキーボードの位置が移り、Esc で閉じる
      expect(await page.evaluate(() => document.activeElement?.id)).toBe('ukpop');
      await page.keyboard.press('Escape');
      await expect.poll(() => page.locator('#ukpop').count()).toBe(0);
      expect(await row.evaluate((el) => el === document.activeElement)).toBe(true);
      expect(await row.getAttribute('aria-expanded')).toBe('false');
    } finally {
      await context.close();
    }
  });

  it('幅 390px: 画面の下から出て、幅いっぱい。横スクロールは出ない。2 向聴からの先の表も、はみ出さない', { timeout: 60_000 }, async () => {
    const { context, page } = await openState(STATES[4] as StateDef, { width: 390 });
    try {
      const info = await page.evaluate(() => {
        const pop = document.getElementById('ukpop') as HTMLElement;
        const a = pop.getBoundingClientRect();
        return {
          sheet: pop.classList.contains('sheet'),
          left: a.left,
          right: a.right,
          bottom: a.bottom,
          top: a.top,
          vw: window.innerWidth,
          vh: window.innerHeight,
          scroll: document.documentElement.scrollWidth,
          client: document.documentElement.clientWidth,
          tableWrap: (() => {
            const wrap = document.querySelector('.fl-wrap') as HTMLElement | null;
            return wrap === null ? null : { scroll: wrap.scrollWidth, client: wrap.clientWidth };
          })(),
        };
      });
      expect(info.sheet).toBe(true);
      expect(info.left).toBe(0);
      expect(info.right).toBe(info.vw);
      expect(info.bottom).toBe(info.vh);
      expect(info.top).toBeGreaterThanOrEqual(0);
      expect(info.scroll).toBeLessThanOrEqual(info.client);
      expect(info.tableWrap).not.toBeNull();
    } finally {
      await context.close();
    }
  });

  it('小窓の外を押すと閉じる（キーボードの位置は、押したところ）。Tab で端から出ると、閉じて押した行に戻る', { timeout: 60_000 }, async () => {
    const { context, page } = await openState(STATES[2] as StateDef);
    try {
      let row = await openUkeire(page, 0);
      await page.getByRole('heading', { name: 'AIの評価（Mortal）' }).click();
      await expect.poll(() => page.locator('#ukpop').count()).toBe(0);
      // Tab で小窓の中を進み、端を出ると閉じる
      row = await openUkeire(page, 0);
      for (let i = 0; i < 8; i += 1) {
        if ((await page.locator('#ukpop').count()) === 0) break;
        await page.keyboard.press('Tab');
      }
      expect(await page.locator('#ukpop').count()).toBe(0);
      expect(await row.evaluate((el) => el === document.activeElement)).toBe(true);
      // Shift+Tab で、小窓の先頭から戻っても閉じる
      await row.click();
      await page.locator('#ukpop').waitFor();
      await page.keyboard.press('Shift+Tab');
      await expect.poll(() => page.locator('#ukpop').count()).toBe(0);
      expect(await row.evaluate((el) => el === document.activeElement)).toBe(true);
    } finally {
      await context.close();
    }
  });

  it('行は、手牌だけで数えた枚数と、小さな「残り」を並べる。小窓の合計の行にも「残り」', { timeout: 60_000 }, async () => {
    const { context, page } = await openState(STATES[3] as StateDef);
    try {
      const row = await page.evaluate(() => {
        const first = document.querySelector('[data-ai="ukeire"]') as HTMLElement;
        const rem = first.querySelector('.uk-rem') as HTMLElement;
        const n = first.querySelector('.uk-n') as HTMLElement;
        return {
          text: n.textContent,
          remFont: parseFloat(getComputedStyle(rem).fontSize),
          nFont: parseFloat(getComputedStyle(n).fontSize),
        };
      });
      expect(row.text).toMatch(/^\d+枚 残り\d+$/);
      expect(row.remFont).toBeLessThan(row.nFont);
      expect(await page.locator('#ukpop .up-sum').textContent()).toMatch(/^\d+向聴・受け入れ \d+枚（\d+種類）・残り \d+枚$|^聴牌・受け入れ \d+枚（\d+種類）・残り \d+枚$/);
    } finally {
      await context.close();
    }
  });
});

describe('U-1・N-8: 答える前の DOM と、牌の画像', () => {
  it('答える前（打牌・鳴き・解き直し）の DOM に、AI の候補・確率・順位・実戦の印が無い。答え合わせのあとにだけ出る', { timeout: 90_000 }, async () => {
    for (const index of [1, 5, 7]) {
      const state = STATES[index] as StateDef;
      const { context, page } = await openState(state);
      try {
        const before = await page.evaluate(() => ({
          ai: document.querySelectorAll('[data-ai]').length,
          html: /data-ai|data-mark|data-ring/.test(document.body.innerHTML),
          text: /\d\s*%|Mortal/.test(document.body.textContent ?? ''),
          actual: (document.body.textContent ?? '').includes('実戦'),
        }));
        expect(before.ai, state.name).toBe(0);
        expect(before.html, state.name).toBe(false);
        expect(before.text, state.name).toBe(false);
        // 見出しに実戦の行動を出すのは、出題だけ（解き直しは出さない）
        expect(before.actual, state.name).toBe(!state.name.startsWith('解き直し'));
        await answerCurrent(page);
        const after = await page.evaluate(() => document.querySelectorAll('[data-ai]').length);
        expect(after, state.name).toBeGreaterThan(0);
      } finally {
        await context.close();
      }
    }
  });

  it('牌の画像（public/tiles）はすべて読み込めて、引きずれない。卓・手牌・答えの欄の牌の図柄は、画像として読み上げられる', { timeout: 60_000 }, async () => {
    const { context, page, external } = await openState(STATES[2] as StateDef);
    try {
      const images = await page.evaluate(() =>
        Array.from(document.images).map((img) => ({
          src: new URL(img.src).pathname,
          ok: img.complete && img.naturalWidth > 0,
          draggable: img.draggable,
          alt: img.alt,
          userDrag: getComputedStyle(img).getPropertyValue('-webkit-user-drag'),
          pointer: getComputedStyle(img).pointerEvents,
        })),
      );
      const tiles = images.filter((img) => img.src.startsWith('/tiles/'));
      expect(tiles.length).toBeGreaterThan(40);
      expect(tiles.filter((img) => !img.ok)).toEqual([]);
      expect(tiles.filter((img) => img.draggable)).toEqual([]);
      expect(tiles.every((img) => img.userDrag === 'none' && img.pointer === 'none')).toBe(true);
      // 図柄に読み上げる名前がある（飾りの牌は alt が空）
      expect(tiles.filter((img) => img.alt !== '').length).toBeGreaterThan(30);
      // 牌の面（背景の画像）も、読み込めている
      const face = await page.evaluate(async () => {
        const tile = document.querySelector('.hand .tile') as HTMLElement;
        const url = /url\("?([^")]+)"?\)/.exec(getComputedStyle(tile).backgroundImage)?.[1] ?? '';
        const response = await window.fetch(url);
        return { url: new URL(url).pathname, ok: response.ok };
      });
      expect(face).toEqual({ url: '/tiles/Front.svg', ok: true });
      expect(external).toEqual([]);
    } finally {
      await context.close();
    }
  });
});

describe('U-19: ドラを目立たせる', () => {
  it('既定は切: どの牌にも黄色を重ねない', { timeout: 60_000 }, async () => {
    const { context, page } = await openState(STATES[2] as StateDef);
    try {
      expect(await page.evaluate(() => document.querySelector('.qz')?.getAttribute('data-dora'))).toBe('off');
      const tinted = await page.evaluate(
        () => Array.from(document.querySelectorAll('.tile.is-dora')).filter((el) => el.closest('.legend') === null).length,
      );
      expect(tinted).toBe(0);
    } finally {
      await context.close();
    }
  });

  for (const scheme of SCHEMES) {
    it(`入: ドラ表示牌が指す牌の面だけが黄色（描いた色）。図柄と黄色のコントラストは 3:1 以上（${scheme}）`, { timeout: 90_000 }, async () => {
      const state = STATES[9] as StateDef;
      const { context, page } = await openState(state, { scheme });
      try {
        expect(await page.evaluate(() => document.querySelector('.qz')?.getAttribute('data-dora'))).toBe('on');
        const doraTile = page.locator('.hand .tile-btn.is-dora').first();
        const plainTile = page.locator('.hand .tile-btn:not(.is-dora)').first();
        expect(await doraTile.count()).toBe(1);
        // 重ねる色（描いた色）と、重ね方
        const overlay = await doraTile.evaluate((el) => {
          const style = getComputedStyle(el, '::after');
          return { color: style.backgroundColor, blend: style.mixBlendMode, content: style.content };
        });
        expect(overlay.blend).toBe('multiply');
        expect(overlay.content).not.toBe('none');
        const tint = parseCssColor(overlay.color);
        expect(tint.a).toBe(1);
        // ドラでない牌には重ねない
        const none = await plainTile.evaluate((el) => {
          const style = getComputedStyle(el, '::after');
          return style.content === 'none' || style.content === 'normal' ? 'none' : style.backgroundColor;
        });
        expect(none).toBe('none');
        // 描いた面の色: ふつうの面に黄色を重ねた色になっている
        const face = await faceColor(page, plainTile);
        const tintedFace = await faceColor(page, doraTile);
        const expected = multiply(face, tint);
        expect(Math.abs(tintedFace.r - expected.r)).toBeLessThanOrEqual(3);
        expect(Math.abs(tintedFace.g - expected.g)).toBeLessThanOrEqual(3);
        expect(Math.abs(tintedFace.b - expected.b)).toBeLessThanOrEqual(3);
        expect(tintedFace.b).toBeLessThan(face.b - 40);
        // 図柄の色（黄色を重ねたあと）と、黄色い面のコントラスト
        const colors = patternColors();
        expect(colors.length).toBeGreaterThanOrEqual(6);
        const hexes = colors.map((c) => [c.r, c.g, c.b].join(','));
        for (const needed of ['0,0,0', '0,73,0', '185,60,60']) expect(hexes).toContain(needed);
        const low = colors
          .map((c) => ({ c, ratio: contrast(multiply(c, tint), tintedFace) }))
          .filter((x) => x.ratio < 3);
        expect(low.map((x) => `${x.c.r},${x.c.g},${x.c.b}: ${x.ratio.toFixed(2)}`)).toEqual([]);
      } finally {
        await context.close();
      }
    });
  }

  it('鳴かれて薄くなった牌・ドラ表示牌そのものには付けない。赤五は、指される牌でもあるときだけ付く', { timeout: 60_000 }, async () => {
    const { context, page } = await openState(STATES[9] as StateDef);
    try {
      const result = await page.evaluate(() => {
        const tinted = Array.from(document.querySelectorAll('.tile.is-dora')).filter((el) => el.closest('.legend') === null);
        return {
          called: tinted.filter((el) => el.classList.contains('called')).length,
          indicator: tinted.filter((el) => el.closest('.dora-t, .info-strip') !== null).length,
          red: tinted.filter((el) => /赤五/.test(el.querySelector('img')?.getAttribute('alt') ?? el.getAttribute('aria-label') ?? '')).length,
          total: tinted.length,
        };
      });
      expect(result.total).toBeGreaterThan(0);
      expect(result.called).toBe(0);
      expect(result.indicator).toBe(0);
    } finally {
      await context.close();
    }
  });
});

describe('U-25: 説明のアイコン（受け入れ枚数の「行を押すと…」）', () => {
  const HINT = '行を押すと、受け入れ牌と枚数・残りの一覧を開きます。';
  for (const width of [390, 768, 1280]) {
    it(`幅 ${width}px: 本文には出ず、アイコンにマウスを乗せるかキーボードで選ぶと、窓の中に、説明している物にかからずに重なって出る。Esc で閉じる。axe の重大な違反が 0 件（ライト・ダーク）`, { timeout: 120_000 }, async () => {
      for (const scheme of SCHEMES) {
        const { context, page, problems } = await openState(STATES[2] as StateDef, { width, scheme });
        try {
          const head = page.locator('[data-ai="ukeire-box"] .sec-head');
          const icon = head.getByRole('button', { name: '受け入れ枚数の操作の説明' });
          expect(await page.locator('[data-ai="ukeire-box"]').innerText()).not.toContain('一覧を開きます');
          expect(await page.getByRole('tooltip').count()).toBe(0);
          await icon.evaluate((el) => el.scrollIntoView({ block: 'center' }));
          // マウスを乗せる
          await icon.hover();
          await page.getByRole('tooltip').waitFor();
          let m = await measureInfoTip(page, '.uk');
          expect(m, `${width} ${scheme}`).not.toBeNull();
          expect(m!.text).toBe(HINT);
          // 窓の中（左右に 8px の余白）に収まる
          expect(m!.tip.left).toBeGreaterThanOrEqual(7);
          expect(m!.tip.right).toBeLessThanOrEqual(m!.innerWidth - 7);
          expect(m!.tip.top).toBeGreaterThanOrEqual(0);
          expect(m!.tip.bottom).toBeLessThanOrEqual(m!.innerHeight);
          // 説明している物にも、アイコンにも、かからない。アイコンの上に出る
          expect(m!.side).toBe('above');
          expect(boxesOverlap(m!.tip, m!.explained as BoxRect)).toBe(false);
          expect(boxesOverlap(m!.tip, m!.icon)).toBe(false);
          // 開いている間も、重大な違反が無い（色のコントラストを含む）
          expect(seriousViolations(await runAxe(page)), `${width} ${scheme}`).toEqual([]);
          // Esc で閉じる
          await page.keyboard.press('Escape');
          expect(await page.getByRole('tooltip').count()).toBe(0);
          await page.mouse.move(2, 2);
          // キーボードで選ぶと出る。Esc で閉じて、位置はアイコンに残る
          await icon.focus();
          await page.keyboard.press('Shift+Tab');
          await page.keyboard.press('Tab');
          expect(await icon.evaluate((el) => el === document.activeElement)).toBe(true);
          await page.getByRole('tooltip').waitFor();
          m = await measureInfoTip(page, '.uk');
          expect(m!.text).toBe(HINT);
          expect(boxesOverlap(m!.tip, m!.explained as BoxRect)).toBe(false);
          await page.keyboard.press('Escape');
          expect(await page.getByRole('tooltip').count()).toBe(0);
          expect(await icon.evaluate((el) => el === document.activeElement)).toBe(true);
          expect(problems).toEqual([]);
        } finally {
          await context.close();
        }
      }
    });
  }
});

describe('U-33: 役の欄（答え合わせのあと。受け入れ枚数の欄の下）', () => {
  // 出題（打牌・鳴き）と、役の欄の見本の場面（3 行に分かれる・チーの警告・1 つにまとまる）
  const YAKU_STATES = [10, 11, 12, 2, 6].map((index) => STATES[index] as StateDef);

  it('答える前の DOM に、役の欄も役の文字も無い。答え合わせのあとにだけ出る（打牌・鳴き・解き直し）', { timeout: 90_000 }, async () => {
    for (const index of [1, 5, 7]) {
      const state = STATES[index] as StateDef;
      const { context, page } = await openState(state);
      try {
        const before = await page.evaluate(() => ({
          box: document.querySelectorAll('[data-ai="yaku-box"], .yk').length,
          text: /確定している役|近い役|役無し/.test(document.body.textContent ?? ''),
        }));
        expect(before, state.name).toEqual({ box: 0, text: false });
        await answerCurrent(page);
        expect(await page.locator('[data-ai="yaku-box"]').count(), state.name).toBe(1);
        expect(await page.getByRole('heading', { level: 2, name: '役', exact: true }).count(), state.name).toBe(1);
      } finally {
        await context.close();
      }
    }
  });

  for (const width of [390, 768, 1280]) {
    it(`幅 ${width}px: 受け入れ枚数の欄の下に出て、欄の中身が欄からも画面からもはみ出さない。牌の画像は読み込めている`, { timeout: 120_000 }, async () => {
      for (const state of YAKU_STATES) {
        const { context, page, problems } = await openState(state, { width });
        try {
          const found = await page.evaluate(() => {
            const box = document.querySelector<HTMLElement>('[data-ai="yaku-box"]');
            if (box === null) return null;
            const area = box.getBoundingClientRect();
            const outside: string[] = [];
            for (const el of Array.from(box.querySelectorAll<HTMLElement>('*'))) {
              if (el.closest('.infotip') !== null) continue;
              const r = el.getBoundingClientRect();
              if (r.width === 0 && r.height === 0) continue;
              if (r.right > area.right + 1 || r.left < area.left - 1) outside.push(`${el.className}:${(el.textContent ?? '').slice(0, 12)}`);
            }
            const ukeire = document.querySelector('[data-ai="ukeire-box"]');
            return {
              rows: box.querySelectorAll('li.yk-row').length,
              scroll: box.scrollWidth,
              client: box.clientWidth,
              docScroll: document.documentElement.scrollWidth,
              docClient: document.documentElement.clientWidth,
              outside,
              afterUkeire: ukeire === null ? null : (ukeire.compareDocumentPosition(box) & Node.DOCUMENT_POSITION_FOLLOWING) !== 0,
              brokenImages: Array.from(box.querySelectorAll('img')).filter((img) => !(img.complete && img.naturalWidth > 0)).length,
              images: box.querySelectorAll('img').length,
            };
          });
          expect(found, `${state.name} @${width}`).not.toBeNull();
          expect(found!.rows, `${state.name} @${width}`).toBeGreaterThanOrEqual(1);
          expect(found!.scroll, `${state.name} @${width}`).toBeLessThanOrEqual(found!.client);
          expect(found!.docScroll, `${state.name} @${width}`).toBeLessThanOrEqual(found!.docClient);
          expect(found!.outside, `${state.name} @${width}`).toEqual([]);
          expect(found!.brokenImages, `${state.name} @${width}`).toBe(0);
          if (state.name.includes('役の欄')) expect(found!.images, `${state.name} @${width}`).toBeGreaterThan(0);
          // 打牌の判断には受け入れ枚数の欄があり、その下に役の欄が続く
          if (found!.afterUkeire !== null) expect(found!.afterUkeire, state.name).toBe(true);
          expect(problems).toEqual([]);
        } finally {
          await context.close();
        }
      }
    });
  }

  for (const scheme of SCHEMES) {
    it(`警告（札「役無し」・太字の文）は、色以外（濃い枠・字の太さ）でも見分けられる。近い役の札とも違う（${scheme}）`, { timeout: 60_000 }, async () => {
      const { context, page } = await openState(STATES[11] as StateDef, { scheme });
      try {
        const style = await page.evaluate(() => {
          const read = (el: Element) => {
            const s = getComputedStyle(el);
            return { weight: Number(s.fontWeight), border: parseFloat(s.borderTopWidth), borderColor: s.borderTopColor, color: s.color };
          };
          const chip = document.querySelector('.yk .q-tag.none');
          const strong = document.querySelector('.yk .yk-d.strong');
          const plain = document.querySelector('.yk .q-tag:not(.none):not(.sure):not(.partial)');
          const normalText = document.querySelector('.yk .yk-d:not(.strong)');
          return {
            chip: chip === null ? null : { ...read(chip), text: chip.textContent },
            strong: strong === null ? null : read(strong),
            plain: plain === null ? null : read(plain),
            normalText: normalText === null ? null : read(normalText),
          };
        });
        expect(style.chip?.text).toBe('役無し');
        expect(style.chip!.weight).toBeGreaterThanOrEqual(700);
        expect(style.chip!.border).toBeGreaterThanOrEqual(1);
        // 近い役の札（薄い枠・細い字）と、枠の色も字の太さも違う。枠は、字と同じ濃さ
        expect(style.plain!.weight).toBeLessThan(700);
        expect(style.chip!.borderColor).not.toBe(style.plain!.borderColor);
        expect(style.chip!.borderColor).toBe(style.chip!.color);
        // 説明の文も太字（ほかの説明の文は細い字）
        expect(style.strong!.weight).toBeGreaterThanOrEqual(700);
        expect(style.normalText!.weight).toBeLessThan(700);
      } finally {
        await context.close();
      }
    });
  }

  it('Tab の順番: 受け入れ枚数の行 → 天鳳牌理 → 役の説明のアイコン → 差の原因。欄の中の止まり場所は、説明のアイコンだけ', { timeout: 60_000 }, async () => {
    const { context, page } = await openState(STATES[10] as StateDef);
    try {
      await page.locator('.uk-open').last().focus();
      const step = async () => {
        await page.keyboard.press('Tab');
        return page.evaluate(() => {
          const el = document.activeElement as HTMLElement | null;
          const label = el instanceof HTMLInputElement ? (el.labels?.[0]?.textContent ?? '') : (el?.getAttribute('aria-label') ?? el?.textContent ?? '');
          return label.trim().slice(0, 20);
        });
      };
      expect(await step()).toContain('天鳳牌理で見る');
      expect(await step()).toBe('役の欄の説明');
      expect(await step()).toContain('受け入れ枚数');
      expect(await page.locator('[data-ai="yaku-box"] :is(button, a, input, select, textarea, [tabindex]:not([tabindex="-1"]))').count()).toBe(1);
    } finally {
      await context.close();
    }
  });

  for (const width of [390, 768, 1280]) {
    it(`幅 ${width}px: 説明のアイコンは、乗せると、窓の中に、欄にかからずに出る。axe の重大な違反が 0 件（ライト・ダーク）`, { timeout: 120_000 }, async () => {
      for (const scheme of SCHEMES) {
        const { context, page } = await openState(STATES[10] as StateDef, { width, scheme });
        try {
          const icon = page.locator('[data-ai="yaku-box"] .sec-head').getByRole('button', { name: '役の欄の説明' });
          expect(await page.locator('[data-ai="yaku-box"]').innerText()).not.toContain('どう和了っても付く役です');
          await icon.evaluate((el) => el.scrollIntoView({ block: 'center' }));
          await icon.hover();
          await page.getByRole('tooltip').waitFor();
          const m = await measureInfoTip(page, '.yk');
          expect(m, `${width} ${scheme}`).not.toBeNull();
          expect(m!.text).toContain('確定している役は、その行動のあとの手が、どう和了っても付く役です');
          expect(m!.tip.left).toBeGreaterThanOrEqual(7);
          expect(m!.tip.right).toBeLessThanOrEqual(m!.innerWidth - 7);
          expect(m!.tip.top).toBeGreaterThanOrEqual(0);
          expect(m!.tip.bottom).toBeLessThanOrEqual(m!.innerHeight);
          expect(boxesOverlap(m!.tip, m!.explained as BoxRect)).toBe(false);
          expect(boxesOverlap(m!.tip, m!.icon)).toBe(false);
          expect(seriousViolations(await runAxe(page)), `${width} ${scheme}`).toEqual([]);
          await page.keyboard.press('Escape');
          expect(await page.getByRole('tooltip').count()).toBe(0);
        } finally {
          await context.close();
        }
      }
    });
  }
});
