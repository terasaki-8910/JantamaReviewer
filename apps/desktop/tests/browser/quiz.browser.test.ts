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
 * - U-34: 答え合わせのタブ。待ちと打点・守備のタブは、場面に関係があるときだけ出る（守備は他家のリーチがある場面だけ）。← → Home End で選べて、Tab の止まり場所は
 *   選んでいるタブ 1 つ。守備の欄は、幅 390・768・1280px・ライト・ダークで、はみ出さない（axe の重大は 0 件）
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
/** 守備のタブで、2 人がリーチしている場面を持つ半荘（FX-1 c）。 */
const FX1C_ID = '20261009-161000';

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
  // 拮抗の場面（F17）の既定は入だが、問題の数を数える試験が多いので、試験の見本は切にしておく（入の試験は、設定を重ねる）
  contest_enabled: false,
};

/** FX-4（読み取りの写しつき。迷い 1〜5 は推定）と、f9da。 */
function sessions() {
  return [
    fx4Session(FX4_ID, local(2026, 10, 9, 19, 9), { report_path: `C:\\data\\games\\${FX4_ID}\\report.json`, ocr: fx4Ocr() }),
    seedSession(local(2026, 10, 9, 17, 12), { id: FX1A_ID, report: 'fx1a' }).session,
  ];
}

/** FX-4 の今日の組（細かいミス（迷い 2）が先頭、あとは迷いの順）の判断の鍵。 */
const DAILY_KEYS = ['k1h0e12', 'k0h0e4', 'k1h1e7', 'k1h1e10', 'k2h1e6'];

/** 組が保存済みで、そのうちの 2 問（迷い 1 と迷い 3）を解決した状態（F16）。解決した問題は、組に残り、薄い行になる。 */
function resolvedScenario(): Partial<Scenario> {
  return {
    sessions: [
      fx4Session(FX4_ID, local(2026, 10, 9, 19, 9), {
        report_path: `C:\\data\\games\\${FX4_ID}\\report.json`,
        ocr: fx4Ocr(),
        resolved: { decisions: { k0h0e4: 1_760_000_000_000, k1h1e7: 1_760_000_000_000 } },
      }),
      seedSession(local(2026, 10, 9, 17, 12), { id: FX1A_ID, report: 'fx1a' }).session,
    ],
    dailySets: { '2026-10-09': DAILY_KEYS.map((decision_key) => ({ session_id: FX4_ID, decision_key })) },
  };
}

/**
 * FX-4 の大きな不一致の先頭 3 問（`keys` を渡したときは、その判断）を、期限が今日以前の答えとして保存済みにする（解き直しの問題）。
 * `sessionId` を渡すと、その半荘の判断として保存する（FX-1 の半荘の場面を解き直したいとき）。
 */
function dueAnswers(keys?: readonly string[], sessionId: string = FX4_ID): unknown[] {
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
    session_id: sessionId,
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

/** 上の 2 つに、FX-1 c の半荘を足したもの（守備のタブの検査用）。 */
function sessionsWithFx1c() {
  return [...sessions(), seedSession(local(2026, 10, 9, 16, 10), { id: FX1C_ID, report: 'fx1c' }).session];
}

function scenario(overrides: Partial<Scenario> & { dora?: boolean; due?: boolean; dueKeys?: readonly string[]; dueSession?: string } = {}): Scenario {
  const { dora = false, due = false, dueKeys, dueSession, ...rest } = overrides;
  return {
    label: 'main',
    state: baseState,
    settings: { ...baseSettings, highlight_dora: dora },
    inputStatus: null,
    sessions: sessions(),
    reports: { [FX4_ID]: REPORT_TEXTS.fx4, [FX1A_ID]: REPORT_TEXTS.fx1a },
    thumb: TINY_PNG,
    answers: dueKeys !== undefined ? dueAnswers(dueKeys, dueSession) : due ? dueAnswers() : [],
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

/** 閉じている役の欄を開く。 */
async function openYaku(page: Page): Promise<void> {
  const toggle = page.locator('[data-ai="yaku-box"]').getByRole('button', { name: '役', exact: true });
  if ((await toggle.getAttribute('aria-expanded')) === 'false') await toggle.click();
  await page.locator('[data-ai="yaku-box"] .yk').waitFor();
  // 開いたときに初めて描く牌の画像が、読み終わるまで待つ（読み込み中のまま調べると、負荷で落ちる）
  await page.waitForFunction(() => Array.from(document.querySelectorAll('[data-ai="yaku-box"] img')).every((img) => (img as HTMLImageElement).complete));
}

interface StateDef {
  name: string;
  scenario?: Partial<Scenario> & { dora?: boolean; due?: boolean; dueKeys?: readonly string[]; dueSession?: string };
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

/**
 * 待ちと打点のタブの見本の場面。FX-4 の東2局1本場 9巡目の打牌（7p を切って聴牌。両面）、FX-1 a の東2局 10巡目のリーチの判断（聴牌になる切り方）、
 * 東4局1本場 8巡目の打牌（多面張）。チーの場面（東3局1本場 11巡目。ダマでロンできない待ちがある）は、役の欄の見本と同じ `YAKU_CHI_KEY`。
 */
const WAIT_DISCARD_KEY = 'k1h1e11';
const WAIT_RIICHI_KEY = 'k1h0e10';
const WAIT_WIDE_KEY = 'k3h1e9';

/** 答え合わせのあと、タブ「待ちと打点」を選ぶ。 */
async function selectWaitsTab(page: Page): Promise<void> {
  await page.getByRole('tab', { name: '待ちと打点' }).click();
  await page.locator('[data-ai="waits-box"]').waitFor();
}

/**
 * 守備のタブの見本の場面（他家のリーチ中）。FX-4 の東1局 14巡目の打牌（上家のリーチ。聴牌なので、待ちと打点のタブも出る。1s がスジ）、
 * FX-1 a の東2局1本場 9巡目の打牌（対面のリーチ。聴牌ではない）と、南2局1本場 7巡目の鳴きの判断（対面のリーチ）、
 * FX-1 c の東2局 16巡目の打牌（対面と下家の 2 人がリーチ。対面が先に宣言）。
 */
const DANGER_TENPAI_KEY = 'k0h0e15';
const DANGER_ONLY_KEY = 'k1h1e13';
const DANGER_CALL_KEY = 'k5h1e8';
const DANGER_TWO_KEY = 'k1h0e19';

/** 答え合わせのあと、タブ「守備」を選ぶ。 */
async function selectDangerTab(page: Page): Promise<void> {
  await page.getByRole('tab', { name: '守備' }).click();
  await page.locator('[data-ai="danger-box"]').waitFor();
}

/** 検査する状態。FX-4 の今日の組は、迷い 2・1・3・4・5 の順（細かいミス（迷い 2）が先頭。1 行目: 打牌・1 向聴、3 行目: 打牌・2 向聴、4 行目: 鳴き）。 */
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
  {
    name: '解き直し（聴牌・タブは既定の「受け入れ・役」・答え合わせのあと）',
    scenario: { dueKeys: [WAIT_DISCARD_KEY] },
    run: async (page) => {
      await openReview(page);
      await answerCurrent(page);
    },
  },
  {
    name: '解き直し（待ちと打点: 打牌・両面）',
    scenario: { dueKeys: [WAIT_DISCARD_KEY] },
    run: async (page) => {
      await openReview(page);
      await answerCurrent(page);
      await selectWaitsTab(page);
    },
  },
  {
    name: '解き直し（待ちと打点: チー・スルー・ダマでロンできない待ち）',
    scenario: { dueKeys: [YAKU_CHI_KEY] },
    run: async (page) => {
      await openReview(page);
      await answerWith(page, () => page.locator('[data-option="chi:5s+7s"]').click());
      await selectWaitsTab(page);
    },
  },
  {
    name: '解き直し（待ちと打点: リーチの判断・門前のダマとリーチ）',
    scenario: { dueKeys: [WAIT_RIICHI_KEY], dueSession: FX1A_ID },
    run: async (page) => {
      await openReview(page);
      await answerWith(page, () => page.locator('[data-option="pass"]').click());
      await selectWaitsTab(page);
    },
  },
  {
    name: '解き直し（待ちと打点: 多面張）',
    scenario: { dueKeys: [WAIT_WIDE_KEY], dueSession: FX1A_ID },
    run: async (page) => {
      await openReview(page);
      await answerCurrent(page);
      await selectWaitsTab(page);
    },
  },
  {
    name: '解き直し（守備: 打牌・上家のリーチ・聴牌）',
    scenario: { dueKeys: [DANGER_TENPAI_KEY] },
    run: async (page) => {
      await openReview(page);
      await answerCurrent(page, 'first');
      await selectDangerTab(page);
    },
  },
  {
    name: '解き直し（守備: 打牌・対面のリーチ・聴牌ではない）',
    scenario: { dueKeys: [DANGER_ONLY_KEY], dueSession: FX1A_ID },
    run: async (page) => {
      await openReview(page);
      await answerCurrent(page);
      await selectDangerTab(page);
    },
  },
  {
    name: '解き直し（守備: 鳴きの判断・鳴いたあとに切れる牌）',
    scenario: { dueKeys: [DANGER_CALL_KEY], dueSession: FX1A_ID },
    run: async (page) => {
      await openReview(page);
      await answerWith(page, () => page.locator('[data-option="pass"]').click());
      await selectDangerTab(page);
    },
  },
  {
    name: '解き直し（守備: 2 人がリーチ・人ごとの欄）',
    scenario: { dueKeys: [DANGER_TWO_KEY], dueSession: FX1C_ID, sessions: sessionsWithFx1c(), reports: { [FX4_ID]: REPORT_TEXTS.fx4, [FX1A_ID]: REPORT_TEXTS.fx1a, [FX1C_ID]: REPORT_TEXTS.fx1c } },
    run: async (page) => {
      await openReview(page);
      await answerCurrent(page);
      await selectDangerTab(page);
    },
  },
  { name: '今日の出題の一覧（解決した問題が組に残っている。薄い行）', scenario: resolvedScenario(), run: openToday },
  {
    name: '出題（解決した問題を開いたところ。答える前。上の段に解決と次へ）',
    scenario: resolvedScenario(),
    run: (page) => openRow(page, 2),
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

describe('U-39: 広い窓は右の答えの欄だけをスクロールする', () => {
  for (const [width, height] of [
    [1280, 800],
    [1440, 900],
    [1920, 1080],
  ] as const) {
    it(`${width}×${height}: 答える前後とも文書はスクロールせず、答えの本文だけが動き、上段と盤面は動かない`, { timeout: 90_000 }, async () => {
      const { context, page } = await open({ width, height });
      try {
        await openRow(page, 1);
        const before = await page.evaluate(() => ({
          documentHeight: document.documentElement.scrollHeight,
          windowHeight: window.innerHeight,
          boardTop: document.querySelector('.board-col')?.getBoundingClientRect().top ?? 0,
        }));
        expect(before.documentHeight).toBeLessThanOrEqual(before.windowHeight);
        await answerCurrent(page);
        // 大きな窓では、閉じた役の欄のままだと中身が欄に収まる。役の欄を開いて、欄の中がスクロールする長さにしてから確かめる
        await openYaku(page);
        const panel = page.locator('.answer-scroll');
        const bar = page.locator('.answer-bar');
        const next = page.locator('#next');
        const revealed = await page.evaluate(() => ({
          documentHeight: document.documentElement.scrollHeight,
          windowHeight: window.innerHeight,
          panelScrollHeight: document.querySelector<HTMLElement>('.answer-scroll')?.scrollHeight ?? 0,
          panelClientHeight: document.querySelector<HTMLElement>('.answer-scroll')?.clientHeight ?? 0,
          boardTop: document.querySelector('.board-col')?.getBoundingClientRect().top ?? 0,
        }));
        expect(revealed.documentHeight).toBeLessThanOrEqual(revealed.windowHeight);
        expect(revealed.panelScrollHeight).toBeGreaterThan(revealed.panelClientHeight);
        expect(revealed.boardTop).toBe(before.boardTop);
        const barBefore = await bar.boundingBox();
        const boardBefore = await page.locator('.board-col').boundingBox();
        await panel.hover();
        await page.mouse.wheel(0, 100_000);
        await expect
          .poll(() => panel.evaluate((element) => Math.abs(element.scrollHeight - element.clientHeight - element.scrollTop)))
          .toBeLessThanOrEqual(1);
        expect(await page.evaluate(() => window.scrollY)).toBe(0);
        expect(await bar.boundingBox()).toEqual(barBefore);
        expect(await page.locator('.board-col').boundingBox()).toEqual(boardBefore);
        expect(await next.isVisible()).toBe(true);
      } finally {
        await context.close();
      }
    });
  }

  for (const width of [768, 390]) {
    it(`幅 ${width}: 答えの欄は内部スクロールせず、横スクロールが出ない`, { timeout: 60_000 }, async () => {
      const { context, page } = await open({ width, height: 800 });
      try {
        await openRow(page, 1);
        await answerCurrent(page);
        const layout = await page.evaluate(() => {
          const panel = document.querySelector<HTMLElement>('.answer-scroll');
          return {
            overflowY: panel === null ? '' : getComputedStyle(panel).overflowY,
            documentWidth: document.documentElement.scrollWidth,
            windowWidth: window.innerWidth,
          };
        });
        expect(layout.overflowY).not.toBe('auto');
        expect(layout.documentWidth).toBeLessThanOrEqual(layout.windowWidth);
      } finally {
        await context.close();
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
      // 手牌のあとは、答えの欄の上の段の「解決」（F16）、それから理由
      await page.keyboard.press('Tab');
      expect(await page.evaluate(() => document.activeElement?.id)).toBe('resolve');
      await page.keyboard.press('Tab');
      expect(await page.evaluate(() => document.activeElement?.id)).toBe('reason');
      await page.keyboard.type('キーボードだけで答える');
      await page.keyboard.press('Tab');
      expect(await page.evaluate(() => document.activeElement?.id)).toBe('submit');
      await page.keyboard.press('Enter');
      await page.getByRole('heading', { name: 'AIの評価（Mortal）' }).waitFor();
      expect(await page.evaluate(() => document.activeElement?.id)).toBe('reveal-h');
      // 答え合わせのあと: 次の問題へ（キーボードの位置は、次の問題の手牌へ）。1 問目が細かいミス（迷い2）なので、2 問目は迷い1
      await page.getByRole('button', { name: '次の問題へ' }).focus();
      await page.keyboard.press('Enter');
      await page.getByRole('heading', { level: 1, name: '東1局 4巡目' }).waitFor();
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
          await openYaku(page);
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
        await openYaku(page);
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

  it('Tab の順番: 受け入れ枚数の行 → 天鳳牌理 → 役の開閉 → 役の説明のアイコン → 差の原因', { timeout: 60_000 }, async () => {
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
      expect(await step()).toBe('役');
      expect(await step()).toBe('役の欄の説明');
      expect(await step()).toContain('受け入れ枚数');
      expect(await page.locator('[data-ai="yaku-box"] :is(button, a, input, select, textarea, [tabindex]:not([tabindex="-1"]))').count()).toBe(2);
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
          // 役の欄は既定で閉じている（U-40）。開いてから、説明が中身にかからないことを確かめる
          await openYaku(page);
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

describe('U-34: 答え合わせのタブ（待ちと打点・待ちの形・符の内訳）', () => {
  // 待ちと打点のタブを開いた状態（打牌・両面 / チー・スルー / リーチの判断 / 多面張）と、既定のタブのまま
  const WAIT_STATES = STATES.filter((s) => s.name.startsWith('解き直し（待ちと打点'));
  const DEFAULT_STATE = STATES.find((s) => s.name.startsWith('解き直し（聴牌・タブは既定')) as StateDef;

  it('答える前は、タブも、待ちと打点も、形の言葉も DOM に無い。答え合わせのあと、既定は「受け入れ・役」で、「待ちと打点」のタブが足される（聴牌でない場面には出ない）', { timeout: 90_000 }, async () => {
    const before = await open({ scenario: scenario({ dueKeys: [WAIT_DISCARD_KEY] }) });
    try {
      await openReview(before.page);
      const found = await before.page.evaluate(() => ({
        tabs: document.querySelectorAll('[role="tablist"], [role="tab"], [data-ai]').length,
        text: /待ちと打点|受け入れ・役|両面|双碰|嵌張|多面張|フリテン/.test(document.body.textContent ?? ''),
      }));
      expect(found).toEqual({ tabs: 0, text: false });
      await answerCurrent(before.page);
      const tabs = before.page.getByRole('tab');
      // 「他家の手牌」のタブは無い（盤面の手牌を押して開く。R16-7）
      expect(await tabs.allInnerTexts()).toEqual(['受け入れ・役', '待ちと打点']);
      expect(await before.page.getByRole('tab', { name: '受け入れ・役' }).getAttribute('aria-selected')).toBe('true');
      // 既定のタブの中身は、これまでと同じ（受け入れ枚数の欄と役の欄）で、待ちと打点の中身は描かれていない
      expect(await before.page.locator('[data-ai="ukeire-box"], [data-ai="yaku-box"]').count()).toBe(2);
      expect(await before.page.locator('[data-ai="waits-box"]').count()).toBe(0);
    } finally {
      await before.context.close();
    }
    // 聴牌でない判断（FX-4 東1局 4巡目）には、待ちと打点のタブは出ない（リーチも副露の気配も無いので、タブの並びも無い）
    const far = await open({ scenario: scenario({ dueKeys: ['k0h0e4'] }) });
    try {
      await openReview(far.page);
      await answerCurrent(far.page);
      expect(await far.page.getByRole('tab').allInnerTexts()).toEqual([]);
      expect(await far.page.getByRole('tablist').count()).toBe(0);
    } finally {
      await far.context.close();
    }
  });

  it('← → Home End でタブを選び、キーボードの位置もタブへ移る。選んでいるタブだけが Tab の止まり場所。Tab で欄の中へ進む', { timeout: 90_000 }, async () => {
    const { context, page } = await openState(DEFAULT_STATE);
    try {
      const first = page.getByRole('tab', { name: '受け入れ・役' });
      const second = page.getByRole('tab', { name: '待ちと打点' });
      await first.focus();
      await page.keyboard.press('ArrowRight');
      expect(await second.getAttribute('aria-selected')).toBe('true');
      expect(await page.evaluate(() => document.activeElement?.textContent)).toBe('待ちと打点');
      expect(await page.evaluate(() => [...document.querySelectorAll('[role="tab"]')].map((t) => (t as HTMLElement).tabIndex))).toEqual([-1, 0]);
      // 通して見る画面のキーにも割り当てられている ← → Home End は、タブが受ける（画面は動かない）。端では反対の端へ
      await page.keyboard.press('ArrowRight');
      expect(await first.getAttribute('aria-selected')).toBe('true');
      await page.keyboard.press('End');
      expect(await second.getAttribute('aria-selected')).toBe('true');
      await page.keyboard.press('Home');
      expect(await first.getAttribute('aria-selected')).toBe('true');
      await page.keyboard.press('ArrowLeft');
      expect(await second.getAttribute('aria-selected')).toBe('true');
      await page.keyboard.press('ArrowLeft');
      expect(await first.getAttribute('aria-selected')).toBe('true');
      await page.keyboard.press('ArrowRight');
      expect(await second.getAttribute('aria-selected')).toBe('true');
      // 選んでいるタブから Tab で、欄の中の最初の操作（説明のアイコン）へ。選んでいないタブには止まらない
      await page.keyboard.press('Tab');
      expect(await page.evaluate(() => document.activeElement?.getAttribute('aria-label'))).toBe('待ちと打点の説明');
      await page.keyboard.press('Shift+Tab');
      expect(await page.evaluate(() => document.activeElement?.getAttribute('aria-selected'))).toBe('true');
    } finally {
      await context.close();
    }
  });

  it('Tab の順番: 選んでいるタブ → 説明のアイコン → 待ちごとの符（ダマのロン・ツモ、リーチのロン・ツモの順）→ 差の原因。符はどれも Tab で届く', { timeout: 90_000 }, async () => {
    // 門前の手（リーチの判断）の場面
    const { context, page } = await openState(WAIT_STATES[2] as StateDef);
    try {
      const expected = await page.locator('.wt-panel .wt-fu').count();
      expect(expected).toBeGreaterThanOrEqual(4);
      await page.getByRole('tab', { name: '待ちと打点' }).focus();
      const labels: string[] = [];
      for (let i = 0; i < expected + 1; i++) {
        await page.keyboard.press('Tab');
        labels.push(await page.evaluate(() => document.activeElement?.getAttribute('aria-label') ?? document.activeElement?.textContent ?? ''));
      }
      expect(labels[0]).toBe('待ちと打点の説明');
      // 符は、待ち牌の行の順に、ダマのロン・ダマのツモ・リーチのロン・リーチのツモ
      expect(labels.slice(1, 5).map((l) => l.replace(/^\d+符の内訳（\S+ /, '').replace(/）$/, ''))).toEqual(['ダマ ロン', 'ダマ ツモ', 'リーチ ロン', 'リーチ ツモ']);
      for (const label of labels.slice(1)) expect(label).toMatch(/^\d+符の内訳（/);
      // 符の次は、差の原因（欄の外）。説明のアイコンと符のほかに、欄の中の止まり場所は無い（行・表の見出しは、止まり場所ではない）
      await page.keyboard.press('Tab');
      expect(await page.evaluate(() => document.activeElement?.closest('.pills-set') !== null)).toBe(true);
      const stops = await page.locator('.wt-panel :is(button, a, input, select, textarea, [tabindex]:not([tabindex="-1"]))').count();
      expect(stops).toBe(expected + 1);
    } finally {
      await context.close();
    }
  });

  for (const width of [390, 768, 1280]) {
    it(`幅 ${width}px: 待ちと打点の欄の中身は、欄からも画面からもはみ出さない。牌の画像は読み込めて、符の数は読める大きさ（ライト・ダーク）`, { timeout: 180_000 }, async () => {
      for (const scheme of SCHEMES) {
        for (const state of WAIT_STATES) {
          const { context, page, problems, external } = await openState(state, { width, scheme });
          try {
            const found = await page.evaluate(() => {
              const box = document.querySelector<HTMLElement>('[data-ai="waits-box"]');
              if (box === null) return null;
              const area = box.getBoundingClientRect();
              const outside: string[] = [];
              for (const el of Array.from(box.querySelectorAll<HTMLElement>('*'))) {
                if (el.closest('.sr-only') !== null) continue;
                const r = el.getBoundingClientRect();
                if (r.width === 0 && r.height === 0) continue;
                if (r.right > area.right + 1 || r.left < area.left - 1) outside.push(`${el.className}:${(el.textContent ?? '').slice(0, 12)}`);
              }
              return {
                tables: box.querySelectorAll('[data-ai="waits"]').length,
                rows: box.querySelectorAll('tbody tr').length,
                scroll: box.scrollWidth,
                client: box.clientWidth,
                docScroll: document.documentElement.scrollWidth,
                docClient: document.documentElement.clientWidth,
                outside,
                brokenImages: Array.from(box.querySelectorAll('img')).filter((img) => !(img.complete && img.naturalWidth > 0)).length,
                fuSize: Math.min(...Array.from(box.querySelectorAll<HTMLElement>('.wt-fu')).map((el) => parseFloat(getComputedStyle(el).fontSize))),
                fuCount: box.querySelectorAll('.wt-fu').length,
              };
            });
            const where = `${state.name} @${width} ${scheme}`;
            expect(found, where).not.toBeNull();
            expect(found!.tables, where).toBeGreaterThanOrEqual(1);
            expect(found!.rows, where).toBeGreaterThanOrEqual(1);
            expect(found!.scroll, where).toBeLessThanOrEqual(found!.client);
            expect(found!.docScroll, where).toBeLessThanOrEqual(found!.docClient);
            expect(found!.outside, where).toEqual([]);
            expect(found!.brokenImages, where).toBe(0);
            // チーのあとの聴牌は、どの待ちも役が無く、符が出ない（符の数が無いので、内訳の重なりも無い）
            if (state.name.includes('チー')) expect(found!.fuCount, where).toBe(0);
            else {
              expect(found!.fuCount, where).toBeGreaterThan(0);
              expect(found!.fuSize, where).toBeGreaterThanOrEqual(12);
            }
            expect(problems).toEqual([]);
            expect(external).toEqual([]);
          } finally {
            await context.close();
          }
        }
      }
    });
  }

  it('欄の幅が広いとき（幅 1040px。答えの欄が全幅になる）は、表の形（列の見出しが見える）。狭いとき（幅 390・1280px）は、待ち 1 つを 1 かたまりに積む', { timeout: 120_000 }, async () => {
    const layout = async (width: number) => {
      const { context, page } = await openState(WAIT_STATES[0] as StateDef, { width });
      try {
        return await page.evaluate(() => {
          const head = document.querySelector<HTMLElement>('.wt-tbl thead');
          const panel = document.querySelector<HTMLElement>('.wt-panel');
          const row = document.querySelector<HTMLElement>('.wt-tbl tbody tr');
          return {
            panelWidth: Math.round(panel?.getBoundingClientRect().width ?? 0),
            headVisible: head !== null && head.getBoundingClientRect().width > 1 && head.getBoundingClientRect().height > 1,
            rowDisplay: row === null ? '' : getComputedStyle(row).display,
            docScroll: document.documentElement.scrollWidth,
            docClient: document.documentElement.clientWidth,
          };
        });
      } finally {
        await context.close();
      }
    };
    const wide = await layout(1040);
    expect(wide.panelWidth).toBeGreaterThanOrEqual(680);
    expect(wide.headVisible).toBe(true);
    expect(wide.rowDisplay).toBe('table-row');
    expect(wide.docScroll).toBeLessThanOrEqual(wide.docClient);
    for (const width of [390, 1280]) {
      const narrow = await layout(width);
      expect(narrow.panelWidth, `@${width}`).toBeLessThan(680);
      expect(narrow.headVisible, `@${width}`).toBe(false);
      expect(narrow.rowDisplay, `@${width}`).toBe('grid');
    }
  });

  it('表の形（幅 1040px）でも、axe の重大な違反が 0 件（ライト・ダーク）', { timeout: 120_000 }, async () => {
    for (const scheme of SCHEMES) {
      const { context, page } = await openState(WAIT_STATES[2] as StateDef, { width: 1040, scheme });
      try {
        expect(seriousViolations(await runAxe(page)), scheme).toEqual([]);
      } finally {
        await context.close();
      }
    }
  });

  for (const width of [390, 768, 1280]) {
    it(`幅 ${width}px: 符の内訳は、乗せる・Tab で選ぶと、窓の中に、符の数にかからずに出る。axe の重大な違反が 0 件（ライト・ダーク）。Esc で閉じる`, { timeout: 180_000 }, async () => {
      for (const scheme of SCHEMES) {
        const { context, page } = await openState(WAIT_STATES[0] as StateDef, { width, scheme });
        try {
          const measure = () =>
            page.evaluate(() => {
              const tip = document.querySelector<HTMLElement>('.wt-fu-pop:not([hidden])');
              const fu = document.querySelector<HTMLElement>('.wt-fu[data-open="1"]');
              if (tip === null || fu === null) return null;
              const box = (el: Element) => {
                const r = el.getBoundingClientRect();
                return { left: r.left, right: r.right, top: r.top, bottom: r.bottom };
              };
              return { tip: box(tip), fu: box(fu), innerWidth: window.innerWidth, innerHeight: window.innerHeight, text: tip.textContent ?? '', parentIsBody: tip.parentElement === document.body };
            });
          const check = (m: NonNullable<Awaited<ReturnType<typeof measure>>>, how: string) => {
            expect(m.text, `${width} ${scheme} ${how}`).toContain('の内訳');
            expect(m.text, `${width} ${scheme} ${how}`).toContain('副底');
            expect(m.parentIsBody).toBe(true);
            expect(m.tip.left, how).toBeGreaterThanOrEqual(7);
            expect(m.tip.right, how).toBeLessThanOrEqual(m.innerWidth - 7);
            expect(m.tip.top, how).toBeGreaterThanOrEqual(0);
            expect(m.tip.bottom, how).toBeLessThanOrEqual(m.innerHeight);
            expect(boxesOverlap(m.tip, m.fu), how).toBe(false);
          };
          // 乗せる
          const fu = page.locator('.wt-panel .wt-fu').first();
          await fu.evaluate((el) => el.scrollIntoView({ block: 'center' }));
          expect(await page.getByRole('tooltip').count()).toBe(0);
          await fu.hover();
          await page.locator('.wt-fu-pop:not([hidden])').waitFor();
          const hovered = await measure();
          expect(hovered, `${width} ${scheme} hover`).not.toBeNull();
          check(hovered!, 'hover');
          expect(seriousViolations(await runAxe(page)), `${width} ${scheme}`).toEqual([]);
          await page.keyboard.press('Escape');
          expect(await page.getByRole('tooltip').count()).toBe(0);
          await page.mouse.move(0, 0);
          // キーボードで選ぶ（説明のアイコンのあと、最初の符へ Tab）
          await page.getByRole('tab', { name: '待ちと打点' }).focus();
          await page.keyboard.press('Tab');
          await page.keyboard.press('Tab');
          expect(await page.evaluate(() => document.activeElement?.classList.contains('wt-fu'))).toBe(true);
          await page.locator('.wt-fu-pop:not([hidden])').waitFor();
          const focused = await measure();
          expect(focused, `${width} ${scheme} focus`).not.toBeNull();
          check(focused!, 'focus');
          await page.keyboard.press('Escape');
          expect(await page.getByRole('tooltip').count()).toBe(0);
        } finally {
          await context.close();
        }
      }
    });
  }
});

describe('U-34: 答え合わせのタブ「守備」（他家のリーチがある場面だけ）', () => {
  const DANGER_STATES = STATES.filter((s) => s.name.startsWith('解き直し（守備'));
  const [TENPAI_STATE, ONLY_STATE, CALL_STATE, TWO_STATE] = DANGER_STATES as [StateDef, StateDef, StateDef, StateDef];

  /** 守備の欄を、見えている部分ごとに読む（はみ出し・画像・行の中の並び）。 */
  const measureDanger = (page: Page) =>
    page.evaluate(() => {
      const box = document.querySelector<HTMLElement>('[data-ai="danger-box"]');
      if (box === null) return null;
      const area = box.getBoundingClientRect();
      const outside: string[] = [];
      for (const el of Array.from(box.querySelectorAll<HTMLElement>('*'))) {
        if (el.closest('.sr-only') !== null) continue;
        const r = el.getBoundingClientRect();
        if (r.width === 0 && r.height === 0) continue;
        if (r.right > area.right + 1 || r.left < area.left - 1) outside.push(`${el.className}:${(el.textContent ?? '').slice(0, 12)}`);
      }
      // 行の中: 牌・札・補足が、行からはみ出さず、重ならない
      const rowProblems: string[] = [];
      for (const row of Array.from(box.querySelectorAll<HTMLElement>('.dg-row'))) {
        const r = row.getBoundingClientRect();
        const parts = Array.from(row.children).map((c) => (c as HTMLElement).getBoundingClientRect());
        for (const p of parts) if (p.right > r.right + 1 || p.left < r.left - 1) rowProblems.push('はみ出し');
        for (let i = 1; i < parts.length; i++) if ((parts[i] as DOMRect).left < (parts[i - 1] as DOMRect).right - 1) rowProblems.push('重なり');
      }
      return {
        sections: box.querySelectorAll('.dg-sec').length,
        rows: box.querySelectorAll('.dg-row').length,
        marks: box.querySelectorAll('.dg-row .mk').length,
        scroll: box.scrollWidth,
        client: box.clientWidth,
        docScroll: document.documentElement.scrollWidth,
        docClient: document.documentElement.clientWidth,
        outside,
        rowProblems,
        brokenImages: Array.from(box.querySelectorAll('img')).filter((img) => !(img.complete && img.naturalWidth > 0)).length,
        riverMarks: box.querySelectorAll('.dg-river .dg-riichi').length,
        sectionNames: Array.from(box.querySelectorAll('.dg-sec .nm')).map((el) => el.textContent ?? ''),
      };
    });

  it('答える前は、タブも、守備の目安も、分類の言葉も DOM に無い。答え合わせのあと、リーチ中の場面にだけ「守備」のタブが足される。中身は、選ぶまで描かれない', { timeout: 120_000 }, async () => {
    const before = await open({ scenario: scenario({ dueKeys: [DANGER_TENPAI_KEY] }) });
    try {
      await openReview(before.page);
      const found = await before.page.evaluate(() => ({
        tabs: document.querySelectorAll('[role="tablist"], [role="tab"], [data-ai]').length,
        text: /守備の目安|形式的な分類|現物|無スジ/.test(document.body.textContent ?? ''),
      }));
      expect(found).toEqual({ tabs: 0, text: false });
      await answerCurrent(before.page, 'first');
      expect(await before.page.getByRole('tab').allInnerTexts()).toEqual(['受け入れ・役', '待ちと打点', '守備']);
      expect(await before.page.getByRole('tab', { name: '受け入れ・役' }).getAttribute('aria-selected')).toBe('true');
      expect(await before.page.locator('[data-ai="danger-box"]').count()).toBe(0);
    } finally {
      await before.context.close();
    }
    // 聴牌ではないがリーチ中: 受け入れ・役と守備の 2 つ。リーチが無い聴牌の場面: 守備は出ない（待ちと打点だけ）
    const only = await open({ scenario: scenario({ dueKeys: [DANGER_ONLY_KEY], dueSession: FX1A_ID }) });
    try {
      await openReview(only.page);
      await answerCurrent(only.page);
      expect(await only.page.getByRole('tab').allInnerTexts()).toEqual(['受け入れ・役', '守備']);
    } finally {
      await only.context.close();
    }
    const noRiichi = await open({ scenario: scenario({ dueKeys: [WAIT_DISCARD_KEY] }) });
    try {
      await openReview(noRiichi.page);
      await answerCurrent(noRiichi.page);
      expect(await noRiichi.page.getByRole('tab').allInnerTexts()).toEqual(['受け入れ・役', '待ちと打点']);
    } finally {
      await noRiichi.context.close();
    }
  });

  it('← → Home End で、待ちと打点・守備を含む 3 つのタブを選べて、キーボードの位置も移る。Tab は選んでいるタブから欄の中（説明のアイコン）へ、その次は差の原因へ。守備の欄の止まり場所は、説明のアイコンだけ', { timeout: 90_000 }, async () => {
    const { context, page } = await openState(TENPAI_STATE);
    try {
      const names = ['受け入れ・役', '待ちと打点', '守備'];
      await page.getByRole('tab', { name: '守備' }).focus();
      const selected = async () =>
        page.evaluate(() => [...document.querySelectorAll('[role="tab"]')].filter((t) => t.getAttribute('aria-selected') === 'true').map((t) => t.textContent));
      await page.keyboard.press('ArrowRight');
      expect(await selected()).toEqual([names[0]]);
      expect(await page.evaluate(() => document.activeElement?.textContent)).toBe(names[0]);
      await page.keyboard.press('ArrowLeft');
      expect(await selected()).toEqual([names[2]]);
      await page.keyboard.press('Home');
      expect(await selected()).toEqual([names[0]]);
      await page.keyboard.press('ArrowRight');
      expect(await selected()).toEqual([names[1]]);
      await page.keyboard.press('End');
      expect(await selected()).toEqual([names[2]]);
      await page.keyboard.press('ArrowLeft');
      expect(await selected()).toEqual([names[1]]);
      await page.keyboard.press('ArrowRight');
      expect(await selected()).toEqual([names[2]]);
      expect(await page.evaluate(() => [...document.querySelectorAll('[role="tab"]')].map((t) => (t as HTMLElement).tabIndex))).toEqual([-1, -1, 0]);
      // Tab: 説明のアイコン → 差の原因（欄の外）
      await page.keyboard.press('Tab');
      expect(await page.evaluate(() => document.activeElement?.getAttribute('aria-label'))).toBe('守備の目安の説明');
      await page.keyboard.press('Tab');
      expect(await page.evaluate(() => document.activeElement?.closest('.pills-set') !== null)).toBe(true);
      expect(await page.locator('.dg-panel :is(button, a, input, select, textarea, [tabindex]:not([tabindex="-1"]))').count()).toBe(1);
    } finally {
      await context.close();
    }
  });

  for (const width of [390, 768, 1280]) {
    it(`幅 ${width}px: 守備の欄の中身は、欄からも画面からもはみ出さない。行の牌・札・補足は重ならない。牌の画像は読み込めている（ライト・ダーク。4 つの場面）`, { timeout: 240_000 }, async () => {
      for (const scheme of SCHEMES) {
        for (const state of DANGER_STATES) {
          const { context, page, problems, external } = await openState(state, { width, scheme });
          try {
            const found = await measureDanger(page);
            const where = `${state.name} @${width} ${scheme}`;
            expect(found, where).not.toBeNull();
            expect(found!.sections, where).toBeGreaterThanOrEqual(1);
            expect(found!.rows, where).toBeGreaterThanOrEqual(5);
            expect(found!.scroll, where).toBeLessThanOrEqual(found!.client);
            expect(found!.docScroll, where).toBeLessThanOrEqual(found!.docClient);
            expect(found!.outside, where).toEqual([]);
            expect(found!.rowProblems, where).toEqual([]);
            expect(found!.brokenImages, where).toBe(0);
            // リーチした人ごとに、河のリーチ宣言牌の印が 1 つずつ
            expect(found!.riverMarks, where).toBe(found!.sections);
            // 比べる打牌の印（自分・実戦・AI）は、打牌の判断では行に出る。鳴きの判断（鳴いたあとの打牌は牌譜に無い）では出ない
            if (state === CALL_STATE) expect(found!.marks, where).toBe(0);
            else expect(found!.marks, where).toBeGreaterThanOrEqual(1);
            expect(problems).toEqual([]);
            expect(external).toEqual([]);
          } finally {
            await context.close();
          }
        }
      }
    });
  }

  it('2 人がリーチしている場面は、人ごとの欄が、宣言した順（対面、下家）に 2 つ縦に並ぶ', { timeout: 90_000 }, async () => {
    const { context, page } = await openState(TWO_STATE);
    try {
      const found = await measureDanger(page);
      expect(found?.sectionNames).toEqual(['対面がリーチ（河。太い枠がリーチ宣言牌）', '下家がリーチ（河。太い枠がリーチ宣言牌）']);
      const tops = await page.evaluate(() => [...document.querySelectorAll('.dg-sec')].map((el) => Math.round(el.getBoundingClientRect().top)));
      expect(tops[1] as number).toBeGreaterThan(tops[0] as number);
    } finally {
      await context.close();
    }
  });

  for (const width of [390, 768, 1280]) {
    it(`幅 ${width}px: 説明のアイコンは、乗せると、窓の中に、欄にかからずに出る。5 つの分類の説明と「形式的な分類です。AI の確率ではありません」が読める。axe の重大な違反が 0 件（ライト・ダーク）。Esc で閉じる`, { timeout: 180_000 }, async () => {
      for (const scheme of SCHEMES) {
        const { context, page } = await openState(TENPAI_STATE, { width, scheme });
        try {
          const icon = page.locator('.dg-panel .sec-head').getByRole('button', { name: '守備の目安の説明' });
          expect(await page.locator('.dg-panel').innerText()).not.toContain('両面で待たれる形が');
          await icon.evaluate((el) => el.scrollIntoView({ block: 'center' }));
          await icon.hover();
          await page.getByRole('tooltip').waitFor();
          const m = await measureInfoTip(page, '.dg-secs');
          expect(m, `${width} ${scheme}`).not.toBeNull();
          for (const word of ['形式的な分類です。AI の確率ではありません', '現物:', 'スジ:', '壁:', '字牌:', '無スジ:']) expect(m!.text).toContain(word);
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

  it('分類の札は、色だけでなく、枠と字の太さでも見分けられる（現物は accent の塗りと枠、無スジは濃い枠で太字、スジ・壁・字牌は薄い枠）。比べる打牌の行は、塗りで目立つ', { timeout: 120_000 }, async () => {
    for (const scheme of SCHEMES) {
      const { context, page } = await openState(ONLY_STATE, { scheme });
      try {
        const styles = await page.evaluate(() => {
          const read = (el: Element | null) => {
            if (el === null) return null;
            const cs = getComputedStyle(el);
            return { text: el.textContent, border: cs.borderTopColor, bg: cs.backgroundColor, weight: Number(cs.fontWeight) };
          };
          return {
            safe: read(document.querySelector('.dg-c.safe')),
            risky: read(document.querySelector('.dg-c.risky')),
            mid: read(document.querySelector('.dg-c.mid')),
            picked: read(document.querySelector('.dg-row.picked')),
            plain: read(document.querySelector('.dg-row:not(.picked)')),
          };
        });
        expect(styles.safe?.text, scheme).toBe('現物');
        expect(styles.risky?.text, scheme).toBe('無スジ');
        expect(styles.safe!.weight, scheme).toBeGreaterThanOrEqual(700);
        expect(styles.risky!.weight, scheme).toBeGreaterThanOrEqual(700);
        // 現物は塗りがある。無スジは塗りが無い。枠の色が違う（現物は accent、無スジは ink）
        expect(styles.safe!.bg, scheme).not.toBe('rgba(0, 0, 0, 0)');
        expect(styles.risky!.bg, scheme).toBe('rgba(0, 0, 0, 0)');
        expect(styles.safe!.border, scheme).not.toBe(styles.risky!.border);
        if (styles.mid !== null) {
          expect(styles.mid.border, scheme).not.toBe(styles.risky!.border);
          expect(styles.mid.weight, scheme).toBeLessThan(700);
        }
        // 比べる打牌の行は塗りがあり、ほかの行は塗りが無い
        expect(styles.picked!.bg, scheme).not.toBe('rgba(0, 0, 0, 0)');
        expect(styles.plain!.bg, scheme).toBe('rgba(0, 0, 0, 0)');
      } finally {
        await context.close();
      }
    }
  });

  it('欄の幅が広いとき（幅 1040px）は、札の列を少し広げる（6.2em）。狭いとき（幅 390px）は 5.6em。どちらも画面は横にはみ出さない', { timeout: 120_000 }, async () => {
    const column = async (width: number) => {
      const { context, page } = await openState(ONLY_STATE, { width });
      try {
        return await page.evaluate(() => {
          const row = document.querySelector<HTMLElement>('.dg-row');
          const panel = document.querySelector<HTMLElement>('.dg-panel');
          const cols = row === null ? [] : getComputedStyle(row).gridTemplateColumns.split(' ').map(parseFloat);
          return {
            cols,
            em: row === null ? 0 : parseFloat(getComputedStyle(row).fontSize),
            panelWidth: Math.round(panel?.getBoundingClientRect().width ?? 0),
            docScroll: document.documentElement.scrollWidth,
            docClient: document.documentElement.clientWidth,
          };
        });
      } finally {
        await context.close();
      }
    };
    const wide = await column(1040);
    expect(wide.panelWidth).toBeGreaterThanOrEqual(560);
    expect(Math.round(((wide.cols[1] as number) / wide.em) * 10) / 10).toBe(6.2);
    const narrow = await column(390);
    expect(narrow.panelWidth).toBeLessThan(560);
    expect(Math.round(((narrow.cols[1] as number) / narrow.em) * 10) / 10).toBe(5.6);
    expect(wide.docScroll).toBeLessThanOrEqual(wide.docClient);
    expect(narrow.docScroll).toBeLessThanOrEqual(narrow.docClient);
  });
});

describe('U-35・U-38: 出題・解き直しの盤面の他家の手牌（実ブラウザ）', () => {
  const faceUpInDom = (page: Page) =>
    page.evaluate(() => document.querySelectorAll('[data-open-hands], .oh-row, .oh-hand, .ohand img, .tile.tp, .tp-line, .shchart, .hands-hint').length);

  it('解き直し: 答える前は、盤面に裏向きの手牌が 3 つ（押せない）。表の牌・欄・印は DOM に無い。答えると押せて、1 人の手牌を押すと 3 人分が開き、答えの欄の上に「他家の手牌」の欄が出る。もう一度押すと閉じる', { timeout: 120_000 }, async () => {
    const { context, page } = await open({ scenario: scenario({ due: true }) });
    try {
      await openReview(page);
      expect(await page.locator('.ohand').count()).toBe(3);
      for (let i = 0; i < 3; i++) {
        expect(await page.locator('.ohand').nth(i).isDisabled()).toBe(true);
        expect(await page.locator('.ohand').nth(i).locator('.tile.back').count()).toBeGreaterThan(0);
      }
      expect(await page.locator('.ohand .tile.back').count()).toBeGreaterThan(20);
      expect(await faceUpInDom(page)).toBe(0);
      // 押そうとしても、開かない（disabled）
      await page.locator('.ohand').first().click({ force: true, timeout: 2000 }).catch(() => undefined);
      expect(await faceUpInDom(page)).toBe(0);
      await answerCurrent(page);
      for (let i = 0; i < 3; i++) expect(await page.locator('.ohand').nth(i).isEnabled()).toBe(true);
      expect(await page.locator('.hands-hint').textContent()).toBe('他家の手牌は、押すと3人とも開きます（もう一度押すと閉じます）');
      await page.locator('.ohand').nth(2).click();
      expect(await page.locator('[data-open-hands="block"] .oh-row').count()).toBe(3);
      expect(await page.locator('.ohand img').count()).toBeGreaterThan(20);
      expect(await page.locator('.ohand .tile.back').count()).toBe(0);
      // 欄は、答えの欄の上の段（次へ進むボタン）のすぐ下、スクロールする部分の先頭（答えのタブ・差の原因より上）
      expect(
        await page.evaluate(() => document.querySelector('section.answer .answer-scroll')?.firstElementChild?.getAttribute('data-open-hands')),
      ).toBe('block');
      await page.locator('.ohand').first().click();
      expect(await faceUpInDom(page)).toBe(1);
    } finally {
      await context.close();
    }
  });

  for (const width of [390, 768, 1280]) {
    it(`幅 ${width}px: 他家の手牌を開いた出題の画面（答えたあと）は、横スクロールが無く、卓が列からはみ出さず、手牌の帯が卓の中で河・中央の箱と重ならない。axe の重大が 0（ライト・ダーク）`, { timeout: 180_000 }, async () => {
      for (const scheme of SCHEMES) {
        const { context, page } = await open({ width, scheme, scenario: scenario({ due: true }) });
        try {
          await openReview(page);
          await answerCurrent(page);
          await page.locator('.ohand').first().click();
          await page.locator('[data-open-hands="block"]').waitFor();
          const o = await overflow(page);
          expect(o.scroll, `@${width} ${scheme}`).toBeLessThanOrEqual(o.client);
          const clash = await page.evaluate(() => {
            const rect = (el: Element) => el.getBoundingClientRect();
            const table = rect(document.querySelector('.table') as Element);
            const column = rect(document.querySelector('.board-col') as Element);
            const center = rect(document.querySelector('.table .center') as Element);
            const bad: string[] = [];
            if (table.right > column.right + 1) bad.push('卓が列からはみ出す');
            for (const hand of document.querySelectorAll('.ohand')) {
              const r = rect(hand);
              if (r.left < table.left - 1 || r.right > table.right + 1 || r.top < table.top - 1 || r.bottom > table.bottom + 1) bad.push('卓の外');
              if (!(r.right <= center.left || r.left >= center.right || r.bottom <= center.top || r.top >= center.bottom)) bad.push('中央の箱と重なる');
              for (const river of document.querySelectorAll('.table .river .rt')) {
                const q = rect(river);
                if (!(r.right <= q.left + 1 || r.left >= q.right - 1 || r.bottom <= q.top + 1 || r.top >= q.bottom - 1)) {
                  bad.push('河と重なる');
                  break;
                }
              }
            }
            return bad;
          });
          expect(clash, `@${width} ${scheme}`).toEqual([]);
          const found = seriousViolations(await runAxe(page));
          expect(found, `@${width} ${scheme}`).toEqual([]);
        } finally {
          await context.close();
        }
      }
    });
  }
});
