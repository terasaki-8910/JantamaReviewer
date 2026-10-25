// @vitest-environment node
/**
 * 実ブラウザで、半荘を通して見る画面（F12）を検査する（U-1・U-4・U-5・U-6・U-19・U-21・N-8）。
 *
 * - U-4: 幅 390・768・1280px で、各状態に横スクロールが出ない。1280×800 では、操作の段・卓・手牌が、ページをスクロールせずに見える
 * - U-5・U-6: axe の重大な違反が 0 件（色のコントラストを含む）。ライトとダーク。Tab ですべての操作に届く
 * - U-21: 既定のキーが働き、文字を打つ欄・メニューの中では働かない。キーの一覧は、押しても、マウスを乗せても開く。
 *   同じキーの割り当ては、割り当てずに断る。変えたキーは、設定に保存され、開き直しても働く
 * - U-1: 答える前の DOM に、AI の情報は無い（全場面。悪手の段の飛び先を広げる設定のときの、増えた場面も）。外へ通信しない
 * - U-19: ドラを目立たせる設定が、通して見る画面でも効く
 * - U-41・U-42・U-49: 解決した場面（薄い印・一覧の「解決」）と、2 つの段（悪手・迷い。「細かいミスだけ」つき）の操作の段が、各幅で 1 行に収まる。
 *   拮抗の段は無い（F19）
 * jsdom の試験（src/main/replay/Replay.test.tsx）と同じふるまいを、実際の描画・キー・時計で確かめる。
 */
import type { Browser, BrowserContext, Page } from 'playwright-core';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import type { Links } from '../../src/api/types';
import { defaultReplayKeys } from '../../src/main/replay/keys';
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
  // 迷いだけ（F0、U-46）は切: 迷いの場面のメモの欄を検査する。入の検査は、下の「U-46」
  doubt_only: false,
  capture_keywords: ['雀魂', 'Mahjong Soul'],
  data_dir: 'C:\\Users\\someone\\JantamaReviewerData',
  daily_count: 5,
  highlight_dora: false,
  show_all_mismatches: false,
  replay_keys: defaultReplayKeys(),
};

/** ユーザーが選んだ迷いの結びつけ（links.json）。迷い 1〜6 がすべて場面になる（迷い 6 は、東3局1本場 11巡目）。 */
const USER_LINKS: Links = {
  ratings: {},
  marks: { '1': 'k0h0e4', '2': 'k1h0e12', '3': 'k1h1e7', '4': 'k1h1e10', '5': 'k2h1e6', '6': 'k2h1e14' },
};

/** FX-4 の場面（迷い 6 と悪手 5。迷い 2 は悪手でもある）の鍵。半荘の順。 */
const SCENE_KEYS = ['k0h0e4', 'k1h0e12', 'k1h1e6', 'k1h1e7', 'k1h1e9', 'k1h1e10', 'k2h1e2', 'k2h1e6', 'k2h1e14', 'k2h1e16'];

/** FX-4（読み取りの写しつき）と、f9da（河の段が多い長い局がある）。`resolved` は、最初から解決している FX-4 の判断の鍵。 */
function sessions(resolved: readonly string[] = []) {
  return [
    fx4Session(FX4_ID, local(2026, 10, 9, 19, 9), {
      report_path: `C:\\data\\games\\${FX4_ID}\\report.json`,
      ocr: fx4Ocr(),
      links: USER_LINKS,
      resolved: { decisions: Object.fromEntries(resolved.map((key) => [key, 1_760_000_000_000])) },
    }),
    seedSession(local(2026, 10, 9, 17, 12), { id: FX1A_ID, report: 'fx1a' }).session,
  ];
}

interface ScenarioOptions {
  dora?: boolean;
  showAll?: boolean;
  keys?: Record<string, string | null>;
  /** 設定の「迷いだけを記録する」を入にする（迷いの場面の、答える前のメモの欄が出なくなる。U-46）。 */
  doubtOnly?: boolean;
  /** 最初から解決している FX-4 の判断の鍵（F16）。 */
  resolved?: readonly string[];
}

function scenario(options: ScenarioOptions = {}): Scenario {
  return {
    label: 'main',
    state: baseState,
    settings: {
      ...baseSettings,
      highlight_dora: options.dora === true,
      show_all_mismatches: options.showAll === true,
      replay_keys: options.keys ?? defaultReplayKeys(),
      doubt_only: options.doubtOnly === true,
    },
    inputStatus: null,
    sessions: sessions(options.resolved),
    reports: { [FX4_ID]: REPORT_TEXTS.fx4, [FX1A_ID]: REPORT_TEXTS.fx1a },
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

/** 半荘のページから、通して見る画面を開く（既定は FX-4、`f9da` は 17:12 の半荘）。 */
async function openReplay(page: Page, which: 'fx4' | 'f9da' = 'fx4'): Promise<void> {
  if (which === 'f9da') {
    await ensureSidebar(page);
    await page.getByRole('navigation', { name: '半荘の一覧' }).getByText('17:12').click();
    await page.getByRole('heading', { level: 1, name: /17:12/ }).waitFor();
  }
  await page.getByRole('button', { name: 'この半荘を通して見る' }).click();
  await page.locator('.pbar').waitFor();
}

/** 局を選んで（0 から数えた何番目か）、その局の終わりへ。 */
async function goToKyokuEnd(page: Page, kyoku: number): Promise<void> {
  await page.getByRole('button', { name: /^局を選ぶ/ }).click();
  await page.getByRole('menuitemradio').nth(kyoku).click();
  await page.locator('#b-kend').click();
  await page.locator('.now-res').waitFor();
}

/** 場面の印（位置の帯の丸かひし形）を押して、その場面へ飛ぶ。答える前の画面になる。 */
async function gotoScene(page: Page, key: string): Promise<void> {
  await page.locator(`.pin[data-key="${key}"]`).first().click();
  await page.locator('.qz[data-state="answering"]').waitFor();
}

/** 答えを選んで、理由を書いて、答え合わせまで進める（打牌は手牌の右端、ほかは 1 つ目のボタン）。 */
async function answerCurrent(page: Page): Promise<void> {
  const hand = page.locator('.hand .tile-btn');
  if ((await hand.count()) > 0) await hand.last().click();
  else await page.getByRole('radio').first().click();
  await page.getByLabel('理由（1行）').fill('孤立牌を切って、受け入れを広く');
  await page.getByRole('button', { name: '答え合わせ' }).click();
  await page.locator('#reveal-h').waitFor({ state: 'attached' });
}

const posText = async (page: Page) => ((await page.locator('#pos').textContent()) ?? '').replace(/\s+/g, ' ').trim();
const titleText = async (page: Page) => ((await page.getByRole('heading', { level: 1 }).textContent()) ?? '').trim();
const openKeyHelp = async (page: Page) => {
  await page.getByRole('button', { name: 'キーの一覧と割り当て' }).click();
  await page.getByRole('dialog', { name: 'キーの一覧と割り当て' }).waitFor();
};

interface StateDef {
  name: string;
  scenario?: ScenarioOptions;
  run: (page: Page) => Promise<void>;
}

/** 検査する状態。 */
const STATES: StateDef[] = [
  { name: '半荘の頭（盤面を見る）', run: (page) => openReplay(page) },
  {
    name: '局の終わり（結果と点の増減）',
    run: async (page) => {
      await openReplay(page);
      await goToKyokuEnd(page, 2);
    },
  },
  {
    name: '迷いの場面（答える前）',
    run: async (page) => {
      await openReplay(page);
      await gotoScene(page, 'k1h1e7');
    },
  },
  {
    name: '迷いの場面（答え合わせのあと）',
    run: async (page) => {
      await openReplay(page);
      await gotoScene(page, 'k1h1e7');
      await answerCurrent(page);
    },
  },
  {
    name: '鳴きの場面（答える前）',
    run: async (page) => {
      await openReplay(page);
      await gotoScene(page, 'k1h1e10');
    },
  },
  {
    name: '鳴きの場面（答え合わせのあと）',
    run: async (page) => {
      await openReplay(page);
      await gotoScene(page, 'k1h1e10');
      await answerCurrent(page);
    },
  },
  {
    name: '局の選択を開いたところ',
    run: async (page) => {
      await openReplay(page);
      await page.getByRole('button', { name: /^局を選ぶ/ }).click();
      await page.getByRole('menu', { name: '局を選ぶ' }).waitFor();
    },
  },
  {
    name: 'キーの一覧を開いたところ',
    run: async (page) => {
      await openReplay(page);
      await openKeyHelp(page);
    },
  },
  {
    name: 'キーの一覧（同じキーを断ったあと）',
    run: async (page) => {
      await openReplay(page);
      await openKeyHelp(page);
      await page.getByRole('button', { name: '次の巡目のキーを変更' }).click();
      await page.keyboard.press('ArrowRight');
      await page.getByRole('alert').filter({ hasText: 'すでに' }).waitFor();
    },
  },
  {
    name: '広げる設定が入（AI の1位と違う判断も飛び先）',
    scenario: { showAll: true },
    run: (page) => openReplay(page),
  },
  {
    name: 'ドラを目立たせる（入・場面）',
    scenario: { dora: true },
    run: async (page) => {
      await openReplay(page);
      await gotoScene(page, 'k1h1e6');
    },
  },
  {
    name: '長い局の終わり（f9da）',
    run: async (page) => {
      await openReplay(page, 'f9da');
      await goToKyokuEnd(page, 5);
    },
  },
  {
    name: '他家の手牌を開いたところ（局の終わり。聴牌の印つき）',
    run: async (page) => {
      await openReplay(page);
      await goToKyokuEnd(page, 0);
      await page.locator('.ohand').first().click();
      await page.locator('[data-open-hands="block"]').waitFor();
    },
  },
  {
    name: '他家の手牌を開いたところ（答えた場面）',
    run: async (page) => {
      await openReplay(page);
      await page.locator('.ohand').first().click();
      await gotoScene(page, 'k1h1e7');
      await answerCurrent(page);
      await page.locator('[data-open-hands="block"]').waitFor();
    },
  },
  {
    name: '守備のタブ（副露の気配の 1 行。答えた場面）',
    run: async (page) => {
      await openReplay(page);
      await gotoScene(page, 'k1h0e12');
      await answerCurrent(page);
      await page.getByRole('tab', { name: '守備' }).click();
      await page.locator('[data-ai="danger-box"]').waitFor();
    },
  },
  // ---- 盤面の作業（U-43〜U-45）----
  {
    name: '自分の判断の手番（打牌。手牌の上に棒）',
    run: async (page) => {
      await openReplay(page);
      await nextDecision(page);
      await page.locator('.hand .ai-bar').first().waitFor();
    },
  },
  {
    name: '自分の判断の手番（鳴き。右の欄に評価の一覧）',
    run: async (page) => {
      await openReplay(page);
      await nextDecision(page, 3);
      await page.locator('section.answer [data-ai="eval"]').waitFor();
    },
  },
  {
    name: '迷いの場面（答える前。盤面の見方を開いた）',
    run: async (page) => {
      await openReplay(page);
      await gotoScene(page, 'k1h1e7');
      await page.getByRole('button', { name: '盤面の見方' }).click();
      await page.locator('.legend-pop:not([hidden])').waitFor();
    },
  },
  {
    name: '細かいミスだけが入（操作の段の 2 つの段）',
    run: async (page) => {
      await openReplay(page);
      await page.getByRole('button', { name: '細かいミスだけ' }).click();
    },
  },
  {
    name: '解決した場面がある（一覧と印が薄い）',
    scenario: { resolved: ['k1h1e7', 'k1h0e12'] },
    run: (page) => openReplay(page),
  },
  {
    name: '解決した場面（答える前。解決が押されて、次の場面へが出る）',
    scenario: { resolved: ['k1h1e7'] },
    run: async (page) => {
      await openReplay(page);
      await gotoScene(page, 'k1h1e7');
      await page.locator('#next').waitFor();
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
    const bar = document.querySelector('.pbar');
    return {
      scroll: document.documentElement.scrollWidth,
      client: document.documentElement.clientWidth,
      body: document.body.scrollWidth,
      // 卓は、自分の列からはみ出さない
      tableRight: table === null ? 0 : table.getBoundingClientRect().right,
      columnRight: column === null ? 0 : column.getBoundingClientRect().right,
      // 操作の段は、自分の枠からはみ出さない
      barScroll: bar === null ? 0 : bar.scrollWidth,
      barClient: bar === null ? 0 : bar.clientWidth,
    };
  });
}

describe('U-4・U-5・U-6: 各状態の、幅・アクセシビリティ・テーマ', () => {
  for (const state of STATES) {
    it(`${state.name}: 幅 390・768・1280px で横スクロールが出ない。axe の重大な違反が 0 件（ライト・ダーク）。外へ通信しない`, { timeout: 180_000 }, async () => {
      for (const width of [390, 768, 1280]) {
        const { context, page, problems, external } = await openState(state, { width });
        try {
          const o = await overflow(page);
          expect(o.scroll, `${state.name} @${width}`).toBeLessThanOrEqual(o.client);
          expect(o.body, `${state.name} @${width} body`).toBeLessThanOrEqual(o.client);
          expect(o.tableRight, `${state.name} @${width} table`).toBeLessThanOrEqual(o.columnRight + 1);
          expect(o.barScroll, `${state.name} @${width} bar`).toBeLessThanOrEqual(o.barClient);
          if (width !== 768) {
            // 配色は、開き直さず、同じページで切り替える（色はトークンが、配色の指定（prefers-color-scheme）で変わる）
            for (const scheme of SCHEMES) {
              await page.emulateMedia({ colorScheme: scheme });
              const found = seriousViolations(await runAxe(page));
              expect(found, `${state.name} @${width} ${scheme}`).toEqual([]);
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

describe('U-4: 1280×800 で、操作の段・卓・手牌が、ページをスクロールせずに見える', () => {
  const FIT_STATES = STATES.filter((state) =>
    [
      '半荘の頭（盤面を見る）',
      '局の終わり（結果と点の増減）',
      '迷いの場面（答える前）',
      '鳴きの場面（答える前）',
      '広げる設定が入（AI の1位と違う判断も飛び先）',
      '長い局の終わり（f9da）',
      '細かいミスだけが入（操作の段の 2 つの段）',
    ].includes(state.name),
  );
  it('検査する状態が、7 つそろっている', () => {
    expect(FIT_STATES.map((state) => state.name)).toHaveLength(7);
  });

  for (const state of FIT_STATES) {
    it(`${state.name}`, { timeout: 90_000 }, async () => {
      const { context, page } = await openState(state, { width: 1280, height: 800 });
      try {
        const m = await page.evaluate(() => {
          const rect = (selector: string) => {
            const el = document.querySelector(selector);
            if (el === null) return null;
            const r = el.getBoundingClientRect();
            return { top: r.top, bottom: r.bottom, left: r.left, right: r.right };
          };
          return {
            height: window.innerHeight,
            width: window.innerWidth,
            scrollY: window.scrollY,
            title: rect('.rp .head .title'),
            bar: rect('.pbar'),
            strip: rect('.pbar .tl'),
            table: rect('.board-col .table'),
            hand: rect('.board-col .hand'),
          };
        });
        expect(m.height).toBe(800);
        expect(m.scrollY).toBe(0);
        for (const [name, box] of Object.entries({ title: m.title, bar: m.bar, strip: m.strip, table: m.table, hand: m.hand })) {
          expect(box, `${state.name}: ${name} が描かれていない`).not.toBeNull();
          expect(box!.top, `${state.name}: ${name} の上`).toBeGreaterThanOrEqual(0);
          expect(box!.bottom, `${state.name}: ${name} の下（窓の高さ ${m.height}）`).toBeLessThanOrEqual(m.height);
          expect(box!.left, `${state.name}: ${name} の左`).toBeGreaterThanOrEqual(0);
          expect(box!.right, `${state.name}: ${name} の右`).toBeLessThanOrEqual(m.width);
        }
        // 卓は、手牌の上にある（重ならない）
        expect(m.table!.bottom).toBeLessThanOrEqual(m.hand!.top + 1);
      } finally {
        await context.close();
      }
    });
  }
});

describe('U-39: 通して見る画面は、広い窓で右の答えの欄だけをスクロールする', () => {
  for (const [width, height] of [
    [1280, 800],
    [1440, 900],
    [1920, 1080],
  ] as const) {
    it(`${width}×${height}: 答える前後とも文書はスクロールせず、答えの本文だけが動き、上段と盤面は動かない`, { timeout: 90_000 }, async () => {
      const { context, page } = await open({ width, height });
      try {
        await openReplay(page);
        await gotoScene(page, 'k1h1e7');
        const before = await page.evaluate(() => ({
          documentHeight: document.documentElement.scrollHeight,
          windowHeight: window.innerHeight,
          boardTop: document.querySelector('.board-col')?.getBoundingClientRect().top ?? 0,
        }));
        expect(before.documentHeight).toBeLessThanOrEqual(before.windowHeight);
        await answerCurrent(page);
        const panel = page.locator('.answer-scroll');
        const bar = page.locator('.answer-bar');
        const revealed = await page.evaluate(() => ({
          documentHeight: document.documentElement.scrollHeight,
          windowHeight: window.innerHeight,
          panelScrollHeight: document.querySelector<HTMLElement>('.answer-scroll')?.scrollHeight ?? 0,
          panelClientHeight: document.querySelector<HTMLElement>('.answer-scroll')?.clientHeight ?? 0,
        }));
        expect(revealed.documentHeight).toBeLessThanOrEqual(revealed.windowHeight);
        expect(revealed.panelScrollHeight).toBeGreaterThan(revealed.panelClientHeight);
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
        expect(await page.locator('#next').isVisible()).toBe(true);
      } finally {
        await context.close();
      }
    });
  }

  for (const width of [768, 390]) {
    it(`幅 ${width}: 答えの欄は内部スクロールせず、横スクロールが出ない`, { timeout: 60_000 }, async () => {
      const { context, page } = await open({ width, height: 800 });
      try {
        await openReplay(page);
        await gotoScene(page, 'k1h1e7');
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

describe('U-4: 盤面（卓・手牌）と、右の答えの欄が、重ならない（1024・1280・1440px。河の長い局・答え合わせのあと）', () => {
  /** 卓の牌・卓・手牌・凡例の箱が、右の欄（いまの一手・答えの欄）の箱と重なっているものを、名前で返す。 */
  async function overlaps(page: Page): Promise<string[]> {
    const m = await page.evaluate(() => {
      const box = (el: Element) => {
        const r = el.getBoundingClientRect();
        return { left: r.left, top: r.top, right: r.right, bottom: r.bottom };
      };
      const answer = document.querySelector('section.answer');
      const board = document.querySelector('.board-col');
      if (answer === null || board === null) return null;
      const named: Array<[string, Element]> = [
        ['卓', document.querySelector('.table') as Element],
        ['盤面の列', board],
        ...Array.from(document.querySelectorAll('.table .tile, .table .ohand, .hand .tile, .legend li, .hands-hint')).map((el, i): [string, Element] => [`牌・手牌・凡例 ${i}`, el]),
      ];
      return { answer: box(answer), items: named.map(([name, el]) => ({ name, box: box(el) })) };
    });
    expect(m).not.toBeNull();
    const { answer, items } = m as { answer: BoxRect; items: Array<{ name: string; box: BoxRect }> };
    return items.filter((item) => boxesOverlap(item.box, answer)).map((item) => item.name);
  }

  for (const width of [1024, 1280, 1440]) {
    it(`幅 ${width}px: 河の長い局の終わり（f9da の 6・8 局目、FX-4 の東1局）と、答えた場面で、重ならない`, { timeout: 180_000 }, async () => {
      for (const height of [800, 900]) {
        const fx4 = await open({ width, height });
        try {
          await openReplay(fx4.page);
          for (const kyoku of [0, 1, 2]) {
            await goToKyokuEnd(fx4.page, kyoku);
            expect(await overlaps(fx4.page), `FX-4 ${kyoku} 局目の終わり @${width}x${height}`).toEqual([]);
            // 他家の手牌を開いたときも（手牌は盤面に出る。欄が右の欄の上に増える）
            await fx4.page.locator('.ohand').first().click();
            await fx4.page.locator('[data-open-hands="block"]').waitFor();
            expect(await overlaps(fx4.page), `FX-4 ${kyoku} 局目の終わり（他家の手牌を開いて） @${width}x${height}`).toEqual([]);
            await fx4.page.locator('.ohand').first().click();
          }
          for (const key of ['k1h0e12', 'k1h1e7']) {
            await gotoScene(fx4.page, key);
            expect(await overlaps(fx4.page), `${key}（答える前） @${width}x${height}`).toEqual([]);
            await answerCurrent(fx4.page);
            expect(await overlaps(fx4.page), `${key}（答え合わせのあと） @${width}x${height}`).toEqual([]);
          }
        } finally {
          await fx4.context.close();
        }
        const long = await open({ width, height });
        try {
          await openReplay(long.page, 'f9da');
          for (const kyoku of [5, 7]) {
            await goToKyokuEnd(long.page, kyoku);
            expect(await overlaps(long.page), `f9da ${kyoku} 局目の終わり @${width}x${height}`).toEqual([]);
            await long.page.locator('.ohand').first().click();
            await long.page.locator('[data-open-hands="block"]').waitFor();
            expect(await overlaps(long.page), `f9da ${kyoku} 局目の終わり（他家の手牌を開いて） @${width}x${height}`).toEqual([]);
            await long.page.locator('.ohand').first().click();
          }
        } finally {
          await long.context.close();
        }
      }
    });
  }
});

/**
 * 手牌から Tab で、理由の欄まで進む。迷いの場面は、答えの欄のいちばん上の「迷いのスクショ」の操作（写真・前の手・次の手）を
 * 先に通る（欄は答えのフォームより前。U-45）。途中の止まり場所は、すべてその欄の中。
 */
async function tabToReason(page: Page): Promise<void> {
  for (let i = 0; i < 8; i += 1) {
    await page.keyboard.press('Tab');
    const at = await page.evaluate(() => ({ id: document.activeElement?.id ?? '', inShots: document.activeElement?.closest('[data-shots="block"]') != null }));
    if (at.id === 'reason') return;
    expect(at.inShots, '理由の前の止まり場所は、迷いのスクショの欄の中').toBe(true);
  }
  throw new Error('Tab で理由の欄に届きません');
}

describe('U-5: Tab ですべての操作に届く', () => {
  const ROVING = '.hand .tile-btn, [role="radio"], [role="tab"]';
  const REACH = [
    '半荘の頭（盤面を見る）',
    '局の終わり（結果と点の増減）',
    '迷いの場面（答える前）',
    '迷いの場面（答え合わせのあと）',
    '他家の手牌を開いたところ（局の終わり。聴牌の印つき）',
    '他家の手牌を開いたところ（答えた場面）',
    '守備のタブ（副露の気配の 1 行。答えた場面）',
    '鳴きの場面（答える前）',
    'キーの一覧を開いたところ',
    '広げる設定が入（AI の1位と違う判断も飛び先）',
  ];
  for (const state of STATES.filter((s) => REACH.includes(s.name))) {
    it(`${state.name}: 手牌・答えのボタンは止まり場所が 1 つ。残りはすべて、Tab で届く`, { timeout: 60_000 }, async () => {
      const { context, page } = await openState(state);
      try {
        const reach = await unreachableByTab(page, { roving: ROVING });
        expect(reach.total).toBeGreaterThan(15);
        expect(reach.missed).toEqual([]);
      } finally {
        await context.close();
      }
    });
  }

  it('位置の帯は、止まり場所が 1 つのスライダー。印（丸・ひし形）は、それぞれ Tab で届き、押すとその場面へ飛ぶ', { timeout: 60_000 }, async () => {
    const { context, page } = await openState(STATES[0] as StateDef);
    try {
      const slider = page.getByRole('slider', { name: '半荘の中の位置（左右の矢印で1手ずつ）' });
      expect(await slider.getAttribute('tabindex')).toBe('0');
      await slider.focus();
      await page.keyboard.press('ArrowRight');
      expect(await slider.getAttribute('aria-valuenow')).toBe('2');
      await page.keyboard.press('End');
      expect(await slider.getAttribute('aria-valuenow')).toBe('289');
      await page.keyboard.press('Home');
      expect(await slider.getAttribute('aria-valuenow')).toBe('1');
      // 印は、ボタン（Tab で届く）。Enter で、その場面へ
      const pin = page.locator('.pin[data-key="k1h1e7"]');
      await pin.focus();
      await page.keyboard.press('Enter');
      await page.locator('.qz[data-state="answering"]').waitFor();
      expect(await titleText(page)).toBe('東2局1本場 6巡目');
    } finally {
      await context.close();
    }
  });

  it('キーボードだけで答える: 手牌の矢印キーと Space で牌を選び、Tab で理由、もう一度 Tab で答え合わせ。答えの見出しへ移る', { timeout: 60_000 }, async () => {
    const { context, page } = await openState(STATES[2] as StateDef);
    try {
      const stop = page.locator('.hand .tile-btn[tabindex="0"]');
      await stop.focus();
      await page.keyboard.press('ArrowRight');
      await page.keyboard.press('End');
      await page.keyboard.press('Space');
      await expect.poll(() => page.locator('.hand .tile-btn[aria-pressed="true"]').count()).toBe(1);
      // 手牌のあとは、答えの欄の上の段の「解決」（F16）、それから（迷いのスクショの欄を通って）理由
      await page.keyboard.press('Tab');
      expect(await page.evaluate(() => document.activeElement?.id)).toBe('resolve');
      await tabToReason(page);
      await page.keyboard.type('キーボードだけで答える');
      await page.keyboard.press('Tab');
      expect(await page.evaluate(() => document.activeElement?.id)).toBe('submit');
      await page.keyboard.press('Enter');
      await page.locator('#reveal-h').waitFor({ state: 'attached' });
      expect(await page.evaluate(() => document.activeElement?.id)).toBe('reveal-h');
    } finally {
      await context.close();
    }
  });
});

describe('U-35・U-38: 他家の手牌（実ブラウザ。盤面の手牌を押すと 3 人分が開く）', () => {
  const hands = (page: Page) => page.locator('.ohand');
  /** 表向きの他家の手牌・欄・聴牌の印のどれかが DOM にあるか（閉じているとき・答える前は、どれも無い）。 */
  const faceUpInDom = (page: Page) =>
    page.evaluate(
      () =>
        document.querySelectorAll('[data-open-hands], .oh-row, .oh-hand, .ohand img, .tile.tp, .tp-line, .shchart, .tk, .tl-note').length,
    );

  it('既定は閉じている（裏向きの 3 つの手牌のボタン）。操作の段に開閉のボタンは無い。1 人の手牌を押すと 3 人分が開き、手を進めても開いたまま。答える場面の答える前は、全 10 場面で、押せず、表の牌・印も DOM に無い。答えると出る', { timeout: 240_000 }, async () => {
    const { context, page } = await open();
    try {
      await openReplay(page);
      expect(await faceUpInDom(page)).toBe(0);
      expect(await hands(page).count()).toBe(3);
      expect(await page.locator('.pbar #b-openhands, .pbar .pb-open').count()).toBe(0);
      for (let i = 0; i < 3; i++) {
        expect(await hands(page).nth(i).isEnabled()).toBe(true);
        expect(await hands(page).nth(i).getAttribute('aria-label')).toBe('他家の手牌を開く');
      }
      await hands(page).nth(1).click();
      expect(await page.locator('.oh-row').count()).toBe(3);
      expect(await page.locator('.ohand img').count()).toBeGreaterThan(30);
      await page.locator('#b-next').click();
      await page.locator('#b-next').click();
      expect(await page.locator('.oh-row').count()).toBe(3);
      for (let i = 0; i < 3; i++) expect(await hands(page).nth(i).getAttribute('aria-label')).toBe('他家の手牌を閉じる');
      // 開いたまま、各場面へ。答える前は、押せず、DOM にも無い
      for (const key of SCENE_KEYS) {
        await page.locator(`.pin[data-key="${key}"]`).first().click();
        await page.locator('.qz[data-state="answering"]').waitFor();
        for (let i = 0; i < 3; i++) expect(await hands(page).nth(i).isDisabled(), key).toBe(true);
        expect(await faceUpInDom(page), key).toBe(0);
        expect(await page.locator('[data-ai]').count(), key).toBe(0);
      }
      // 答えたあと: 押せて、開いたままなので出る
      await answerCurrent(page);
      expect(await hands(page).first().isEnabled()).toBe(true);
      expect(await page.locator('[data-open-hands="block"] .oh-row').count()).toBe(3);
      expect(await page.locator('.ohand img').count()).toBeGreaterThan(30);
      // もう一度押すと、3 人分が閉じる
      await hands(page).nth(2).click();
      expect(await faceUpInDom(page)).toBe(0);
    } finally {
      await context.close();
    }
  });

  it('河を押しても開かない。Enter・Space で開閉できる。手牌のボタンには、位置の帯から Tab で進むと届く', { timeout: 90_000 }, async () => {
    const { context, page } = await open();
    try {
      await openReplay(page);
      // 手牌の外（自分の河）を押しても、開かない
      const box = await page.locator('.zone.bottom .river').boundingBox();
      expect(box).not.toBeNull();
      await page.mouse.click((box as { x: number }).x + 6, (box as { y: number }).y + 6);
      expect(await faceUpInDom(page)).toBe(0);
      // キーボード: 位置の帯から Tab で進むと、手牌のボタンに届く
      await page.getByRole('slider', { name: '半荘の中の位置（左右の矢印で1手ずつ）' }).focus();
      let reached = false;
      for (let i = 0; i < 30 && !reached; i++) {
        await page.keyboard.press('Tab');
        reached = await page.evaluate(() => document.activeElement?.classList.contains('ohand') === true);
      }
      expect(reached).toBe(true);
      await page.keyboard.press('Enter');
      expect(await page.locator('[data-open-hands="block"]').count()).toBe(1);
      await page.keyboard.press('Space');
      expect(await faceUpInDom(page)).toBe(0);
    } finally {
      await context.close();
    }
  });

  it('表向きの手牌・枠・目盛りは、幅 390・768・1280px のライト・ダークで、横スクロールが無く、卓が列からはみ出さない。手牌の帯は、卓の中に収まり、河・中央の箱と重ならない（局の終わりの、聴牌の印つき）', { timeout: 300_000 }, async () => {
    for (const width of [390, 768, 1280]) {
      for (const scheme of SCHEMES) {
        const { context, page } = await open({ width, scheme });
        try {
          await openReplay(page);
          await goToKyokuEnd(page, 0);
          await hands(page).first().click();
          await page.locator('[data-open-hands="block"]').waitFor();
          const o = await overflow(page);
          expect(o.scroll, `@${width} ${scheme}`).toBeLessThanOrEqual(o.client);
          expect(o.tableRight, `@${width} ${scheme} table`).toBeLessThanOrEqual(o.columnRight + 1);
          // 聴牌になった打牌の枠（河）と、帯の目盛りがある
          expect(await page.locator('.river .tile.tp').count()).toBeGreaterThan(0);
          expect(await page.locator('.tl-track .tk').count()).toBeGreaterThan(0);
          const track = await page.locator('.tl-track').boundingBox();
          expect((track as { height: number }).height).toBeGreaterThan(20);
          // 他家の手牌の帯（3 つ）は、卓の中に収まり、河・中央の箱と重ならない
          const clash = await page.evaluate(() => {
            const rect = (el: Element) => el.getBoundingClientRect();
            const table = rect(document.querySelector('.table') as Element);
            const center = rect(document.querySelector('.table .center') as Element);
            const bad: string[] = [];
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
        } finally {
          await context.close();
        }
      }
    }
  });
});

describe('U-21: 既定のキー（実ブラウザ）', () => {
  it(', . ← → ↑ ↓ Shift+矢印 が働く。押したキーで窓はスクロールしない', { timeout: 90_000 }, async () => {
    const { context, page, problems, external } = await openState(STATES[0] as StateDef, { width: 1280, height: 900 });
    try {
      expect(await posText(page)).toBe('手 1 / 80');
      await page.keyboard.press('Period');
      await page.keyboard.press('Period');
      expect(await posText(page)).toBe('手 3 / 80');
      await page.keyboard.press('Comma');
      expect(await posText(page)).toBe('手 2 / 80');
      // ← → は、自分の判断（ツモ）へ
      await page.keyboard.press('ArrowRight');
      expect(await titleText(page)).toMatch(/^東1局 \d+巡目$/);
      const decisionPos = await posText(page);
      await page.keyboard.press('ArrowRight');
      expect(await posText(page)).not.toBe(decisionPos);
      await page.keyboard.press('ArrowLeft');
      expect(await posText(page)).toBe(decisionPos);
      // ↓ は次の悪手（東2局 11巡目。迷い 2 でもある）。↑ は前の悪手（無い）
      await page.keyboard.press('ArrowDown');
      expect(await titleText(page)).toBe('東2局 11巡目');
      expect(await page.locator('.q-chips .q-chip').allTextContents()).toEqual(['1向聴', '実戦：打8p', '迷い2', '細かいミス', '悪手']);
      await page.keyboard.press('ArrowUp');
      expect(await titleText(page)).toBe('東2局 11巡目');
      // Shift+↑ は前の迷い（東1局 4巡目）。Shift+→ は次の局の頭。Shift+← は前の局の頭
      await page.keyboard.press('Shift+ArrowUp');
      expect(await titleText(page)).toBe('東1局 4巡目');
      await page.keyboard.press('Shift+ArrowRight');
      expect(await titleText(page)).toBe('東2局 配牌');
      await page.keyboard.press('Shift+ArrowLeft');
      expect(await titleText(page)).toBe('東1局 配牌');
      await page.keyboard.press('Shift+ArrowDown');
      expect(await titleText(page)).toBe('東1局 4巡目');
      // 割り当てたキーは、窓のスクロールを止める（390px の縦長の窓で、押しても scrollY が変わらない）
      await page.setViewportSize({ width: 390, height: 600 });
      const before = await page.evaluate(() => window.scrollY);
      await page.keyboard.press('ArrowDown');
      expect(await page.evaluate(() => window.scrollY)).toBe(before);
      // ボタンだけの操作（巡目）は、キーを押しても動かない
      const here = await posText(page);
      await page.keyboard.press('BracketRight');
      expect(await posText(page)).toBe(here);
      expect(problems).toEqual([]);
      expect(external).toEqual([]);
    } finally {
      await context.close();
    }
  });

  it('文字を打つ欄・メニューの中では、キーは何もしない。手牌の ← → は牌の移動のまま', { timeout: 90_000 }, async () => {
    const { context, page } = await openState(STATES[2] as StateDef);
    try {
      const here = await posText(page);
      await page.getByLabel('理由（1行）').click();
      await page.keyboard.type('a,b.c');
      expect(await page.getByLabel('理由（1行）').inputValue()).toBe('a,b.c');
      await page.keyboard.press('ArrowRight');
      await page.keyboard.press('ArrowDown');
      expect(await posText(page)).toBe(here);
      // 手牌に位置があるとき、← → は牌の移動（画面は動かない）
      await page.locator('.hand .tile-btn[tabindex="0"]').focus();
      await page.keyboard.press('ArrowLeft');
      expect(await posText(page)).toBe(here);
      expect(await page.evaluate(() => document.activeElement?.closest('.hand') !== null)).toBe(true);
      // メニューが開いている間は、矢印はメニューの中だけで動く
      await page.getByRole('button', { name: /^局を選ぶ/ }).click();
      await page.getByRole('menu', { name: '局を選ぶ' }).waitFor();
      await page.keyboard.press('ArrowDown');
      await page.keyboard.press('Period');
      expect(await posText(page)).toBe(here);
      await page.keyboard.press('Escape');
      await expect.poll(() => page.getByRole('menu').count()).toBe(0);
      expect(await posText(page)).toBe(here);
    } finally {
      await context.close();
    }
  });
});

describe('U-21: キーの一覧と割り当ての変更（実ブラウザ）', () => {
  type Call = { cmd: string; args: { settings?: { replay_keys?: Record<string, string | null> } } };
  const savedKeys = (page: Page) =>
    page.evaluate(
      () =>
        (window as unknown as { __jrCalls: Call[] }).__jrCalls
          .filter((call) => call.cmd === 'set_settings')
          .map((call) => call.args.settings?.replay_keys ?? null),
    );

  it('アイコンを押すと開き、マウスを乗せても開く。離すと閉じ、押して出したものは出たまま。窓の中に収まり、アイコンに重ならない（390・768・1280px）', { timeout: 120_000 }, async () => {
    for (const width of [390, 768, 1280]) {
      const { context, page } = await openState(STATES[0] as StateDef, { width });
      try {
        const button = page.getByRole('button', { name: 'キーの一覧と割り当て' });
        const dialog = page.getByRole('dialog', { name: 'キーの一覧と割り当て' });
        // マウスを乗せると出る
        await button.hover();
        await dialog.waitFor();
        expect(await dialog.locator('.kp-row').count()).toBe(14);
        // 離すと閉じる
        await page.mouse.move(2, 2);
        await expect.poll(() => dialog.count(), { timeout: 3000 }).toBe(0);
        // 押すと出る。もう一度押すと閉じる
        await button.click();
        await dialog.waitFor();
        expect(await button.getAttribute('aria-expanded')).toBe('true');
        // 窓の中に収まる。アイコンに重ならない
        const geometry = await page.evaluate(() => {
          const panel = (document.querySelector('.keypanel') as HTMLElement).getBoundingClientRect();
          const icon = (document.querySelector('.key-btn') as HTMLElement).getBoundingClientRect();
          return {
            panel: { left: panel.left, right: panel.right, top: panel.top, bottom: panel.bottom },
            icon: { left: icon.left, right: icon.right, top: icon.top, bottom: icon.bottom },
            vw: window.innerWidth,
            vh: window.innerHeight,
            scrollWidth: document.documentElement.scrollWidth,
          };
        });
        expect(geometry.panel.left, `@${width} 左`).toBeGreaterThanOrEqual(0);
        expect(geometry.panel.right, `@${width} 右`).toBeLessThanOrEqual(geometry.vw);
        expect(geometry.panel.top, `@${width} 上`).toBeGreaterThanOrEqual(0);
        expect(geometry.panel.bottom, `@${width} 下`).toBeLessThanOrEqual(geometry.vh);
        if (width < 640) {
          // 狭いときは、画面の下から、幅いっぱい（左右 8px）に出る
          expect(geometry.panel.left, `@${width} 左`).toBe(8);
          expect(geometry.panel.right, `@${width} 右`).toBe(geometry.vw - 8);
          expect(geometry.panel.bottom, `@${width} 下`).toBe(geometry.vh - 8);
        } else {
          // 広いときは、アイコンのそばに出て、アイコンに重ならない
          const overlaps =
            geometry.panel.left < geometry.icon.right &&
            geometry.panel.right > geometry.icon.left &&
            geometry.panel.top < geometry.icon.bottom &&
            geometry.panel.bottom > geometry.icon.top;
          expect(overlaps, `@${width} アイコンに重なる`).toBe(false);
        }
        expect(geometry.scrollWidth).toBeLessThanOrEqual(geometry.vw);
        // マウスを離しても、押して出したものは出たまま
        await page.mouse.move(2, 2);
        await page.waitForTimeout(500);
        expect(await dialog.count()).toBe(1);
        // Esc で閉じて、アイコンへ位置が戻る
        await page.keyboard.press('Escape');
        await expect.poll(() => dialog.count()).toBe(0);
        expect(await button.evaluate((el) => el === document.activeElement)).toBe(true);
      } finally {
        await context.close();
      }
    }
  });

  it('同じキーは断る（どの操作が使っているかを出す）。割り当てず、保存もしない。割り当てられないキーも、理由を出して断る', { timeout: 90_000 }, async () => {
    const { context, page } = await openState(STATES[0] as StateDef);
    try {
      await openKeyHelp(page);
      const dialog = page.getByRole('dialog', { name: 'キーの一覧と割り当て' });
      await page.getByRole('button', { name: '次の巡目のキーを変更' }).click();
      await page.keyboard.press('ArrowRight');
      await expect
        .poll(() => dialog.getByRole('alert').textContent())
        .toBe('→ は、すでに「次の自分の判断」に使っています。先に「次の自分の判断」のキーを変えてください。');
      expect(await dialog.locator('.kp-row[data-action="next_decision"] .kp-key').textContent()).toBe('→');
      expect(await dialog.locator('.kp-row[data-action="next_turn"] .kp-key').textContent()).toBe('新しいキーを押してください');
      expect(await savedKeys(page)).toEqual([]);
      for (const chord of ['Alt+ArrowLeft', 'Control+KeyK', 'Control+KeyZ', 'Control+KeyY', 'Tab', 'Enter', 'Space']) {
        await page.keyboard.press(chord);
        await expect.poll(() => dialog.getByRole('alert').textContent()).toContain('割り当てられません');
      }
      expect(await savedKeys(page)).toEqual([]);
      // Esc で変更をやめる。割り当ては元のまま
      await page.keyboard.press('Escape');
      await expect.poll(() => dialog.locator('.kp-wait').count()).toBe(0);
      expect(await dialog.locator('.kp-row[data-action="next_turn"] .kp-key').textContent()).toBe('なし');
    } finally {
      await context.close();
    }
  });

  it('変えたキーは、働き（古いキーは働かない）、設定に保存され、開き直しても働く。「既定に戻す」で戻る', { timeout: 120_000 }, async () => {
    const { context, page } = await openState(STATES[0] as StateDef);
    let saved: Record<string, string | null> | null = null;
    try {
      await openKeyHelp(page);
      const dialog = page.getByRole('dialog', { name: 'キーの一覧と割り当て' });
      await page.getByRole('button', { name: '1手戻るのキーを変更' }).click();
      await page.keyboard.press('KeyJ');
      await expect.poll(() => dialog.locator('.kp-row[data-action="step_back"] .kp-key').textContent()).toBe('J');
      const calls = await savedKeys(page);
      expect(calls).toHaveLength(1);
      saved = calls[0] ?? null;
      expect(saved).toEqual({ ...defaultReplayKeys(), step_back: 'KeyJ' });
      await dialog.getByRole('button', { name: '閉じる' }).click();
      await page.keyboard.press('Period');
      await page.keyboard.press('Period');
      expect(await posText(page)).toBe('手 3 / 80');
      await page.keyboard.press('Comma');
      expect(await posText(page)).toBe('手 3 / 80');
      await page.keyboard.press('KeyJ');
      expect(await posText(page)).toBe('手 2 / 80');
      // 「既定に戻す」
      await openKeyHelp(page);
      await dialog.getByRole('button', { name: '既定に戻す' }).click();
      await expect.poll(() => dialog.locator('.kp-row[data-action="step_back"] .kp-key').textContent()).toBe(',');
      expect((await savedKeys(page)).at(-1)).toEqual(defaultReplayKeys());
    } finally {
      await context.close();
    }
    // 開き直し（保存した設定を読んで始まる）。変えたキーが働く
    expect(saved).not.toBeNull();
    const reopened = await open({ scenario: scenario({ keys: saved as Record<string, string | null> }) });
    try {
      await openReplay(reopened.page);
      await reopened.page.keyboard.press('Period');
      await reopened.page.keyboard.press('Period');
      await reopened.page.keyboard.press('Comma');
      expect(await posText(reopened.page)).toBe('手 3 / 80');
      await reopened.page.keyboard.press('KeyJ');
      expect(await posText(reopened.page)).toBe('手 2 / 80');
      await openKeyHelp(reopened.page);
      expect(await reopened.page.locator('.kp-row[data-action="step_back"] .kp-key').textContent()).toBe('J');
      expect(reopened.problems).toEqual([]);
      expect(reopened.external).toEqual([]);
    } finally {
      await reopened.context.close();
    }
  });
});

describe('U-1・N-8: 答える前の DOM と、牌の画像', () => {
  async function aiTraces(page: Page) {
    return page.evaluate(() => ({
      state: document.querySelector('.qz')?.getAttribute('data-state') ?? null,
      ai: document.querySelectorAll('[data-ai]').length,
      html: /data-ai|data-mark|data-ring/.test(document.body.innerHTML),
      text: /\d\s*%|Mortal/.test(document.body.textContent ?? ''),
      actual: (document.body.textContent ?? '').includes('実戦'),
    }));
  }

  it('全 10 場面の、答える前の DOM に、AI の候補・確率・順位・印が無い（実戦の行動は出る）。答え合わせのあとにだけ出て、場面を離れると消える', { timeout: 180_000 }, async () => {
    const { context, page, problems, external } = await openState(STATES[0] as StateDef);
    try {
      expect(await aiTraces(page)).toMatchObject({ state: 'browse', ai: 0, html: false, text: false });
      for (const key of SCENE_KEYS) {
        await gotoScene(page, key);
        const traces = await aiTraces(page);
        expect(traces, key).toEqual({ state: 'answering', ai: 0, html: false, text: false, actual: true });
      }
      // 答えると、AI の情報が出る。1 手動くと（盤面を見ているだけの手）消え、戻ると、答え合わせのあとの形で開く
      await gotoScene(page, 'k1h1e7');
      await answerCurrent(page);
      expect((await aiTraces(page)).ai).toBeGreaterThan(0);
      await page.keyboard.press('Period');
      expect(await aiTraces(page)).toMatchObject({ state: 'browse', ai: 0, html: false, text: false });
      await page.keyboard.press('Comma');
      const back = await aiTraces(page);
      expect(back.state).toBe('revealed');
      expect(back.ai).toBeGreaterThan(0);
      expect(problems).toEqual([]);
      expect(external).toEqual([]);
    } finally {
      await context.close();
    }
  });

  it('「AI の1位と違う判断も、飛び先に入れる」が入のとき、増えた場面（FX-4 は 3 か所）も、答える前の DOM に AI の情報が無い', { timeout: 120_000 }, async () => {
    const { context, page } = await openState(STATES[9] as StateDef);
    try {
      const small = page.locator('.pin.mis.small');
      expect(await small.count()).toBe(3);
      expect(await page.locator('.pin.mis').count()).toBe(8);
      expect(await page.locator('.pin.dbt').count()).toBe(6);
      for (let index = 0; index < 3; index += 1) {
        await small.nth(index).click();
        await page.locator('.qz[data-state="answering"]').waitFor();
        expect(await aiTraces(page)).toEqual({ state: 'answering', ai: 0, html: false, text: false, actual: true });
        expect(await page.locator('.q-chips .q-chip').last().textContent()).toBe('悪手');
      }
      // ↑ ↓ は、増えた場面にも止まる（8 か所）
      await page.getByRole('button', { name: '局の頭へ' }).click();
      await page.keyboard.press('Shift+ArrowLeft');
      await page.keyboard.press('Shift+ArrowLeft');
      await page.keyboard.press('Shift+ArrowLeft');
      await page.keyboard.press('Shift+ArrowLeft');
      expect(await titleText(page)).toBe('東1局 配牌');
      const seen = new Set<string>();
      for (let index = 0; index < 8; index += 1) {
        await page.keyboard.press('ArrowDown');
        seen.add(`${await titleText(page)}|${await posText(page)}`);
      }
      expect(seen.size).toBe(8);
    } finally {
      await context.close();
    }
  });

  it('操作部分（操作の段・位置の帯・いまの一手・場面の一覧・キーの一覧）の文字は、選択できない（N-8）', { timeout: 60_000 }, async () => {
    const { context, page } = await openState(STATES[7] as StateDef);
    try {
      const selects = await page.evaluate(() =>
        ['.pbar', '#pos', '.pin', '.kyoku-btn', '.key-btn', '.keypanel', '.kp-row', '.hand', '.table', '.now-t', '.sc-row'].map((selector) => {
          const el = document.querySelector(selector);
          return [selector, el === null ? null : getComputedStyle(el).userSelect];
        }),
      );
      expect(selects.filter(([, value]) => value === null).map(([selector]) => selector)).toEqual([]);
      expect(selects.filter(([, value]) => value !== 'none')).toEqual([]);
    } finally {
      await context.close();
    }
  });

  it('牌の画像はすべて読み込めて、引きずれない。外へ通信しない', { timeout: 60_000 }, async () => {
    const { context, page, external } = await openState(STATES[3] as StateDef);
    try {
      const images = await page.evaluate(() =>
        Array.from(document.images).map((img) => ({
          src: new URL(img.src).pathname,
          ok: img.complete && img.naturalWidth > 0,
          draggable: img.draggable,
          userDrag: getComputedStyle(img).getPropertyValue('-webkit-user-drag'),
        })),
      );
      const tiles = images.filter((img) => img.src.startsWith('/tiles/'));
      expect(tiles.length).toBeGreaterThan(40);
      expect(tiles.filter((img) => !img.ok)).toEqual([]);
      expect(tiles.filter((img) => img.draggable)).toEqual([]);
      expect(tiles.every((img) => img.userDrag === 'none')).toBe(true);
      expect(external).toEqual([]);
    } finally {
      await context.close();
    }
  });
});

describe('U-19: ドラを目立たせる（通して見る画面）', () => {
  it('既定は切: 場面でも、盤面を見ているだけの手でも、どの牌にも黄色を重ねない', { timeout: 60_000 }, async () => {
    const { context, page } = await openState(STATES[2] as StateDef);
    try {
      const tinted = () =>
        page.evaluate(() => ({
          mode: document.querySelector('.qz')?.getAttribute('data-dora'),
          tinted: Array.from(document.querySelectorAll('.tile.is-dora')).filter((el) => el.closest('.legend') === null).length,
        }));
      expect(await tinted()).toEqual({ mode: 'off', tinted: 0 });
      await page.keyboard.press('Comma');
      expect(await tinted()).toEqual({ mode: 'off', tinted: 0 });
    } finally {
      await context.close();
    }
  });

  for (const scheme of SCHEMES) {
    it(`入: ドラ表示牌が指す牌にだけ、黄色を乗せる（描いた色。場面と、盤面を見ているだけの手の両方。${scheme}）`, { timeout: 90_000 }, async () => {
      const { context, page } = await openState(STATES[10] as StateDef, { scheme });
      try {
        const overlay = (selector: string) =>
          page.locator(selector).first().evaluate((el) => {
            const style = getComputedStyle(el, '::after');
            return { color: style.backgroundColor, blend: style.mixBlendMode, content: style.content };
          });
        for (const phase of ['場面', '盤面を見ているだけの手']) {
          if (phase !== '場面') await page.keyboard.press('Comma');
          expect(await page.evaluate(() => document.querySelector('.qz')?.getAttribute('data-dora'))).toBe('on');
          const doraTile = '.hand .tile.is-dora';
          expect(await page.locator(doraTile).count(), phase).toBeGreaterThan(0);
          const tint = await overlay(doraTile);
          expect(tint.blend, phase).toBe('multiply');
          expect(tint.content, phase).not.toBe('none');
          expect(tint.color, phase).toMatch(/^rgb\(/);
          const plain = await page.locator('.hand .tile:not(.is-dora)').first().evaluate((el) => {
            const style = getComputedStyle(el, '::after');
            return style.content === 'none' || style.content === 'normal' ? 'none' : style.backgroundColor;
          });
          expect(plain, phase).toBe('none');
          // 描いた面の色: ふつうの面に黄色を重ねた色になっている。図柄の色と黄色のコントラストは 3:1 以上
          const tintColor = parseCssColor(tint.color);
          expect(tintColor.a, phase).toBe(1);
          const plainTile = page.locator('.hand .tile:not(.is-dora)').first();
          const doraFace = page.locator(doraTile).first();
          const face = await faceColor(page, plainTile);
          const tintedFace = await faceColor(page, doraFace);
          const expected = multiply(face, tintColor);
          expect(Math.abs(tintedFace.r - expected.r), `${phase} r`).toBeLessThanOrEqual(3);
          expect(Math.abs(tintedFace.g - expected.g), `${phase} g`).toBeLessThanOrEqual(3);
          expect(Math.abs(tintedFace.b - expected.b), `${phase} b`).toBeLessThanOrEqual(3);
          expect(tintedFace.b, phase).toBeLessThan(face.b - 40);
          const low = patternColors()
            .map((color) => ({ color, ratio: contrast(multiply(color, tintColor), tintedFace) }))
            .filter((item) => item.ratio < 3);
          expect(low.map((item) => `${item.color.r},${item.color.g},${item.color.b}: ${item.ratio.toFixed(2)}`), phase).toEqual([]);
        }
        // 河の牌にも、同じ重ね方で付く（局の終わりまで進めて、河にドラ表示牌が指す牌がある局を探す）
        let riverTint: { blend: string; color: string } | null = null;
        for (let kyoku = 0; kyoku < 5 && riverTint === null; kyoku += 1) {
          await goToKyokuEnd(page, kyoku);
          const river = page.locator('.zone .tile.is-dora:not(.called)').first();
          if ((await river.count()) > 0) {
            riverTint = await river.evaluate((el) => {
              const style = getComputedStyle(el, '::after');
              return { blend: style.mixBlendMode, color: style.backgroundColor };
            });
          }
        }
        expect(riverTint, 'FX-4 の局の終わりのどれかに、河にドラが見えるはず').not.toBeNull();
        expect(riverTint!.blend).toBe('multiply');
        expect(riverTint!.color).toMatch(/^rgb\(/);
        // 鳴かれて薄くなった牌・ドラ表示牌そのものには付けない
        const odd = await page.evaluate(() => {
          const marked = Array.from(document.querySelectorAll('.tile.is-dora')).filter((el) => el.closest('.legend') === null);
          return {
            called: marked.filter((el) => el.classList.contains('called')).length,
            indicator: marked.filter((el) => el.closest('.dora-t, .info-strip') !== null).length,
          };
        });
        expect(odd).toEqual({ called: 0, indicator: 0 });
      } finally {
        await context.close();
      }
    });
  }
});

describe('U-25: 説明のアイコン（通して見る画面の「場面を押すと…」）', () => {
  const HINT = '場面を押すと、その場面へ飛びます。場面に着くまで、AIの答えは出ません。';
  for (const width of [390, 768, 1280]) {
    it(`幅 ${width}px: 本文には出ず、アイコンにマウスを乗せるかキーボードで選ぶと、窓の中に、説明している物にかからずに重なって出る。Esc で閉じる。axe の重大な違反が 0 件（ライト・ダーク）`, { timeout: 120_000 }, async () => {
      for (const scheme of SCHEMES) {
        const { context, page, problems } = await openState(STATES[0] as StateDef, { width, scheme });
        try {
          const head = page.locator('.scenes-h');
          const icon = head.getByRole('button', { name: '場面の一覧の操作の説明' });
          expect(await page.locator('.answer').innerText()).not.toContain('場面を押すと');
          expect(await page.getByRole('tooltip').count()).toBe(0);
          await icon.evaluate((el) => el.scrollIntoView({ block: 'center' }));
          // マウスを乗せる
          await icon.hover();
          await page.getByRole('tooltip').waitFor();
          let m = await measureInfoTip(page, '.scenes');
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
          m = await measureInfoTip(page, '.scenes');
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

describe('U-46: 迷いだけを記録する設定が入のとき、迷いの場面に、答える前のメモの欄を出さない（実ブラウザ）', () => {
  /** 迷い 3（東2局1本場 6巡目の打牌）に、メモを書いてある半荘。迷いだけでも、答えたあとには出る。 */
  function doubtScenario(doubtOnly: boolean): Scenario {
    const base = scenario({ doubtOnly });
    const withMemo = fx4Session(FX4_ID, local(2026, 10, 9, 19, 9), {
      report_path: `C:\\data\\games\\${FX4_ID}\\report.json`,
      ocr: fx4Ocr(),
      links: USER_LINKS,
      memos: { marks: { '3': { candidates: '南・6m', reason: '東を残したい' } }, extras: [] },
    });
    return { ...base, sessions: [withMemo, ...base.sessions.slice(1)] };
  }

  const DOUBT_SCENES = ['k0h0e4', 'k1h0e12', 'k1h1e7', 'k1h1e10', 'k2h1e6', 'k2h1e14'];

  for (const scheme of SCHEMES) {
    for (const width of [390, 1280] as const) {
      it(`迷いの場面（全 6 つ） 幅${width}px ${scheme}: 答える前に、メモの欄（候補・理由）が無い。横スクロールが無く、重大な a11y 違反が無い。AI の情報は無い`, { timeout: 240_000 }, async () => {
        const { context, page, problems, external } = await open({ width, scheme, scenario: doubtScenario(true) });
        try {
          await openReplay(page);
          for (const key of DOUBT_SCENES) {
            await gotoScene(page, key);
            const where = `${key} @${width} ${scheme}`;
            expect(await page.locator('.q-chips .is-doubt').count(), `${where} 迷いの場面`).toBeGreaterThan(0);
            expect(await page.locator('[data-memo]').count(), where).toBe(0);
            expect(await page.getByLabel('候補').count(), where).toBe(0);
            expect(await page.getByRole('group', { name: /^迷い\d+のメモ$/ }).count(), where).toBe(0);
            expect(await page.getByLabel('理由（1行）').count(), where).toBe(1);
            expect(await page.locator('[data-ai]').count(), where).toBe(0);
            const f = await page.evaluate(() => ({
              scroll: document.documentElement.scrollWidth,
              client: document.documentElement.clientWidth,
              text: document.body.innerText,
            }));
            expect(f.scroll, where).toBeLessThanOrEqual(f.client);
            expect(f.text, where).not.toContain('東を残したい');
          }
          const axe = await runAxe(page);
          expect(seriousViolations(axe)).toEqual([]);
          expect(problems).toEqual([]);
          expect(external).toEqual([]);
        } finally {
          await context.close();
        }
      });
    }
  }

  it('答えると、書いてあるメモが、自分の答えの下に出る（迷いだけでも）。答える前は出ない', { timeout: 120_000 }, async () => {
    const { context, page } = await open({ width: 1280, scenario: doubtScenario(true) });
    try {
      await openReplay(page);
      await gotoScene(page, 'k1h1e7');
      expect(await page.locator('[data-memo]').count()).toBe(0);
      await answerCurrent(page);
      const shown = page.locator('[data-memo="shown"]');
      await shown.waitFor();
      expect(await shown.locator('dd').allTextContents()).toEqual(['南・6m', '東を残したい']);
      expect(await shown.locator('input, textarea').count()).toBe(0);
    } finally {
      await context.close();
    }
  });

  it('設定を切ると（settings-changed）、答える前の迷いの場面に、メモの欄が出る。書いてあったメモが入っている。入れ直すと消える', { timeout: 120_000 }, async () => {
    const { context, page } = await open({ width: 1280, scenario: doubtScenario(true) });
    try {
      await openReplay(page);
      await gotoScene(page, 'k1h1e7');
      const flip = (doubtOnly: boolean) =>
        page.evaluate(async (value) => {
          const w = window as unknown as {
            __TAURI_INTERNALS__: { invoke: (cmd: string) => Promise<Record<string, unknown>> };
            __jrEmit: (event: string, payload: unknown) => void;
          };
          const current = await w.__TAURI_INTERNALS__.invoke('get_settings');
          w.__jrEmit('settings-changed', { ...current, doubt_only: value });
        }, doubtOnly);
      expect(await page.locator('[data-memo="editor"]').count()).toBe(0);
      await flip(false);
      const editor = page.locator('[data-memo="editor"]');
      await editor.waitFor();
      expect(await editor.getByLabel('候補').inputValue()).toBe('南・6m');
      await flip(true);
      await page.waitForFunction(() => document.querySelector('[data-memo="editor"]') === null);
    } finally {
      await context.close();
    }
  });
});

// ---- 盤面の作業（U-43 棒・U-44 ドラ表示牌・U-45 迷いのスクショ・盤面の見方。通して見る画面）----

/** 次の自分の判断へ（→）。`times` 回。 */
async function nextDecision(page: Page, times = 1): Promise<void> {
  for (let i = 0; i < times; i += 1) await page.keyboard.press('ArrowRight');
}

/** 手牌の棒と牌の位置・大きさ（ページの中で測る）。 */
async function replayBars(page: Page) {
  return page.evaluate(() => {
    const box = (el: Element) => {
      const r = el.getBoundingClientRect();
      return { left: r.left, right: r.right, top: r.top, bottom: r.bottom, width: r.width, height: r.height };
    };
    const slots = Array.from(document.querySelectorAll<HTMLElement>('.hand .slot')).filter((slot) => slot.querySelector('.ai-bar') !== null);
    return slots.map((slot) => {
      const tile = slot.querySelector('.tile') as HTMLElement;
      const bar = slot.querySelector('.ai-bar') as HTMLElement;
      const fill = slot.querySelector<HTMLElement>('.ai-fill');
      return { tile: box(tile), bar: box(bar), fill: fill === null ? null : box(fill), h: Number.parseFloat(bar.style.getPropertyValue('--h')), labelled: slot.querySelector('.ai-num') !== null };
    });
  });
}

/** 盤面の外側の位置と大きさ（動かないことを確かめる）。 */
async function replayBoxes(page: Page) {
  return page.evaluate(() => {
    const box = (selector: string) => {
      const r = (document.querySelector(selector) as Element).getBoundingClientRect();
      return { left: r.left, top: r.top, width: r.width, height: r.height };
    };
    return { column: box('.board-col'), table: box('.table'), hand: box('.hand'), handWrap: box('.hand-wrap') };
  });
}

describe('U-43: 通して見る画面の AI の評価の棒（実ブラウザ）', () => {
  for (const [width, height] of [
    [1280, 800],
    [1440, 900],
    [1920, 1080],
  ] as const) {
    it(`${width}×${height}: 自分の打牌の手番で、手牌の上に棒が出る（牌と同じ列・帯 56px）。卓・手牌は、手を進めても・場面に着いても・答えても動かない。文書はスクロールしない`, { timeout: 120_000 }, async () => {
      const { context, page } = await open({ width, height });
      try {
        await openReplay(page);
        const fit = () => page.evaluate(() => ({ document: document.documentElement.scrollHeight, window: window.innerHeight }));
        const start = await replayBoxes(page);
        expect((await fit()).document).toBeLessThanOrEqual(height);
        // 次の自分の判断（東1局 1巡目。場面ではない）
        await nextDecision(page);
        await page.locator('.hand .ai-bar').first().waitFor();
        const bars = await replayBars(page);
        expect(bars.length).toBeGreaterThanOrEqual(13);
        for (const [index, slot] of bars.entries()) {
          expect(Math.abs(slot.bar.left - slot.tile.left), `${index} 枚目 左`).toBeLessThanOrEqual(0.6);
          expect(Math.abs(slot.bar.width - slot.tile.width), `${index} 枚目 幅`).toBeLessThanOrEqual(0.6);
          expect(Math.abs(slot.bar.height - 56), `${index} 枚目 帯`).toBeLessThanOrEqual(0.6);
          if (slot.fill !== null) {
            expect(Math.abs(slot.fill.width - slot.tile.width * 0.6), `${index} 枚目 棒の幅`).toBeLessThanOrEqual(1);
            expect(Math.abs(slot.fill.height - slot.h), `${index} 枚目 棒の高さ`).toBeLessThanOrEqual(0.6);
          }
        }
        expect(bars.some((slot) => slot.labelled)).toBe(true);
        expect((await fit()).document).toBeLessThanOrEqual(height);
        const browseBoxes = await replayBoxes(page);
        // 同じ局の中では、卓も手牌も、手を進めても動かない
        for (const name of ['column', 'table', 'hand', 'handWrap'] as const) {
          for (const key of ['left', 'top', 'width', 'height'] as const) {
            expect(Math.abs(start[name][key] - browseBoxes[name][key]), `手を進めたあと ${name}.${key}`).toBeLessThanOrEqual(0.5);
          }
        }
        // 打牌のあとの手: 棒は無い（帯は、そのまま）
        await page.keyboard.press('.');
        expect(await page.locator('.hand .ai-bar').count()).toBe(0);
        expect((await replayBoxes(page)).hand.top).toBe(browseBoxes.hand.top);
        // 迷いの場面（東2局1本場。別の局）: 答える前後で、卓・手牌が動かず、文書もスクロールしない
        await gotoScene(page, 'k1h1e7');
        expect(await page.locator('.hand .ai-bar').count()).toBe(0);
        const before = await replayBoxes(page);
        expect((await fit()).document).toBeLessThanOrEqual(height);
        await answerCurrent(page);
        expect(await page.locator('.hand .ai-bar').count()).toBeGreaterThanOrEqual(13);
        const after = await replayBoxes(page);
        for (const name of ['column', 'table', 'hand', 'handWrap'] as const) {
          for (const key of ['left', 'top', 'width', 'height'] as const) {
            expect(Math.abs(before[name][key] - after[name][key]), `答えたあと ${name}.${key}`).toBeLessThanOrEqual(0.5);
          }
        }
        expect((await fit()).document).toBeLessThanOrEqual(height);
      } finally {
        await context.close();
      }
    });

    it(`${width}×${height}: 自分の鳴きの判断の手番は、右の欄に評価の一覧（棒は無い）。文書はスクロールせず、欄は窓の下からはみ出さない`, { timeout: 90_000 }, async () => {
      const { context, page } = await open({ width, height });
      try {
        await openReplay(page);
        await nextDecision(page, 3);
        await page.locator('section.answer [data-ai="eval"]').waitFor();
        expect(await page.locator('.hand .ai-bar').count()).toBe(0);
        const m = await page.evaluate(() => {
          const panel = document.querySelector('section.answer') as HTMLElement;
          const scroll = panel.querySelector<HTMLElement>('.answer-scroll');
          const r = panel.getBoundingClientRect();
          return {
            document: document.documentElement.scrollHeight,
            window: window.innerHeight,
            panelBottom: r.bottom,
            content: scroll === null ? 0 : scroll.scrollHeight - scroll.clientHeight,
            rows: panel.querySelectorAll('[data-ai="candidate"]').length,
            tags: Array.from(panel.querySelectorAll('[data-ai="candidate"] .btag')).map((tag) => tag.textContent ?? ''),
          };
        });
        expect(m.document).toBeLessThanOrEqual(m.window);
        expect(m.panelBottom).toBeLessThanOrEqual(m.window);
        expect(m.rows).toBeGreaterThanOrEqual(2);
        expect(m.tags.some((tag) => tag.includes('実戦'))).toBe(true);
        expect(m.tags.some((tag) => tag.includes('自分'))).toBe(false);
      } finally {
        await context.close();
      }
    });
  }

  it('色: 棒は --accent-bar、AI の 1 位は --accent（ダークで違う色）。数字は等幅の 11px', { timeout: 90_000 }, async () => {
    const { context, page } = await open({ width: 1440, height: 900, scheme: 'dark' });
    try {
      await openReplay(page);
      await nextDecision(page);
      await page.locator('.hand .ai-bar').first().waitFor();
      const m = await page.evaluate(() => {
        const colorOf = (css: string) => {
          const probe = document.createElement('i');
          probe.style.backgroundColor = css;
          document.body.append(probe);
          const color = getComputedStyle(probe).backgroundColor;
          probe.remove();
          return color;
        };
        const fills = Array.from(document.querySelectorAll<HTMLElement>('.hand .ai-bar')).map((bar) => ({
          top: bar.classList.contains('is-top'),
          color: bar.querySelector('.ai-fill') === null ? null : getComputedStyle(bar.querySelector('.ai-fill') as Element).backgroundColor,
          num: bar.querySelector('.ai-num') === null ? null : { size: getComputedStyle(bar.querySelector('.ai-num') as Element).fontSize, family: getComputedStyle(bar.querySelector('.ai-num') as Element).fontFamily },
        }));
        return { accent: colorOf('var(--accent)'), accentBar: colorOf('var(--accent-bar)'), fills };
      });
      expect(m.accent).not.toBe(m.accentBar);
      for (const fill of m.fills) {
        if (fill.color !== null) expect(fill.color).toBe(fill.top ? m.accent : m.accentBar);
        if (fill.num !== null) {
          expect(fill.num.size).toBe('11px');
          expect(fill.num.family).toContain('IBM Plex Mono');
        }
      }
      expect(m.fills.some((fill) => fill.top)).toBe(true);
    } finally {
      await context.close();
    }
  });
});

describe('U-44・盤面の見方: 通して見る画面（実ブラウザ）', () => {
  for (const [width, height] of [
    [1440, 900],
    [1280, 800],
    [768, 900],
    [390, 900],
  ] as const) {
    it(`幅 ${width}px: ドラ表示牌の行が中央の箱に出る（卓の上の 1 行には無い）。盤面の見方のアイコンは卓の上の右端。凡例は重なりの中`, { timeout: 90_000 }, async () => {
      const { context, page } = await open({ width, height });
      try {
        await openReplay(page);
        const m = await page.evaluate(() => {
          const box = (el: Element) => {
            const r = el.getBoundingClientRect();
            return { left: r.left, right: r.right, top: r.top, bottom: r.bottom, width: r.width };
          };
          const row = document.querySelector('.center .dora') as HTMLElement | null;
          const center = document.querySelector('.table .center') as Element;
          const strip = document.querySelector('.info-strip') as HTMLElement;
          const icon = document.querySelector('.board-tools .infotip-btn') as Element;
          return {
            row: row === null ? null : box(row),
            visible: row !== null && row.checkVisibility(),
            center: box(center),
            scores: Array.from(document.querySelectorAll('.table .center .score')).map(box),
            tiles: Array.from(row?.querySelectorAll('.tile') ?? []).map((tile) => tile.getBoundingClientRect().width),
            aria: row?.getAttribute('aria-label') ?? '',
            stripHasDora: strip.querySelector('.dora, .tile') !== null || (strip.textContent ?? '').includes('ドラ'),
            icon: box(icon),
            column: box(document.querySelector('.board-col') as Element),
            table: box(document.querySelector('.table') as Element),
            legendOutside: document.querySelector('.board-col > .legend, .board-col > .hands-hint') === null,
            scroll: [document.documentElement.scrollWidth, document.documentElement.clientWidth],
          };
        });
        expect(m.visible).toBe(true);
        const row = m.row as { left: number; right: number; top: number; bottom: number };
        expect(row.left).toBeGreaterThanOrEqual(m.center.left - 0.5);
        expect(row.right).toBeLessThanOrEqual(m.center.right + 0.5);
        expect(row.top).toBeGreaterThanOrEqual(m.center.top - 0.5);
        expect(row.bottom).toBeLessThanOrEqual(m.center.bottom + 0.5);
        for (const score of m.scores) expect(boxesOverlap(row, score)).toBe(false);
        expect(m.tiles).toHaveLength(2);
        // 通して見る画面の卓は、窓の高さが足りないと小さい配置（狭い卓）になる: 18px、広い卓は 24px
        for (const tile of m.tiles) expect([18, 24].some((size) => Math.abs(tile - size) <= 0.6)).toBe(true);
        expect(m.aria).toMatch(/^ドラ表示牌 .+、ドラ .+$/);
        expect(m.stripHasDora).toBe(false);
        expect(m.icon.right).toBeLessThanOrEqual(m.column.right + 1);
        expect(m.icon.right).toBeGreaterThanOrEqual(m.column.right - 8);
        expect(m.icon.bottom).toBeLessThanOrEqual(m.table.top + 1);
        expect(m.legendOutside).toBe(true);
        expect(m.scroll[0]).toBeLessThanOrEqual(m.scroll[1] as number);
        // 凡例（と、他家の手牌の一言）は、アイコンの重なりの中。窓に収まる
        await page.getByRole('button', { name: '盤面の見方' }).click();
        await page.locator('.legend-pop:not([hidden])').waitFor();
        const tip = await measureInfoTip(page, '.board-col .table');
        expect(tip).not.toBeNull();
        expect(tip!.tip.left).toBeGreaterThanOrEqual(0);
        expect(tip!.tip.right).toBeLessThanOrEqual(tip!.innerWidth);
        expect(tip!.tip.bottom).toBeLessThanOrEqual(tip!.innerHeight);
        expect(tip!.text).toContain('ツモ切り');
        expect(tip!.text).toContain('他家の手牌は、押すと3人とも開きます');
        await page.keyboard.press('Escape');
        await expect.poll(() => page.locator('.legend-pop:not([hidden])').count()).toBe(0);
      } finally {
        await context.close();
      }
    });
  }
});

describe('U-45: 迷いのスクショ（通して見る画面。実ブラウザ）', () => {
  it('迷いの場面: 答えの欄のいちばん上。写真は幅 112px、値・ボタンは欄の中。ほかの場面（悪手だけ）・見ているだけの手には無い。幅 390・768・1280 で横スクロールが無い', { timeout: 120_000 }, async () => {
    for (const width of [1280, 768, 390]) {
      const { context, page } = await open({ width, height: 900 });
      try {
        await openReplay(page);
        expect(await page.locator('[data-shots="block"]').count()).toBe(0);
        await gotoScene(page, 'k1h1e7');
        const m = await page.evaluate(() => {
          const box = (el: Element) => {
            const r = el.getBoundingClientRect();
            return { left: r.left, right: r.right, width: r.width };
          };
          const panel = document.querySelector('section.answer') as Element;
          const shots = document.querySelector('[data-shots="block"]') as Element;
          return {
            panel: box(panel),
            first: document.querySelector('.answer-scroll')?.firstElementChild === shots,
            thumb: box(shots.querySelector('.mthumb') as Element),
            buttons: Array.from(shots.querySelectorAll('.shot-actions .btn')).map(box),
            scroll: [document.documentElement.scrollWidth, document.documentElement.clientWidth],
          };
        });
        expect(m.first, `@${width}`).toBe(true);
        expect(Math.abs(m.thumb.width - 112), `@${width}`).toBeLessThanOrEqual(0.6);
        expect(m.buttons).toHaveLength(2);
        for (const button of m.buttons) {
          expect(button.right, `@${width}`).toBeLessThanOrEqual(m.panel.right + 0.5);
          expect(button.left, `@${width}`).toBeGreaterThanOrEqual(m.panel.left - 0.5);
        }
        expect(m.scroll[0], `@${width}`).toBeLessThanOrEqual(m.scroll[1] as number);
        // 悪手だけの場面と、見ているだけの手には無い
        await page.locator('.pin[data-key="k1h1e6"]').first().click();
        await page.locator('.qz[data-state="answering"]').waitFor();
        expect(await page.locator('[data-shots="block"]').count()).toBe(0);
      } finally {
        await context.close();
      }
    }
  });

  it('「次の手に付け替える」: 付け替えた先の場面へ移り、その迷いの写真にキーボードの位置が移る。取り消すと、結びつけが戻る', { timeout: 90_000 }, async () => {
    const { context, page } = await open({ width: 1440, height: 900 });
    try {
      await openReplay(page);
      await gotoScene(page, 'k1h1e7');
      expect(await titleText(page)).toBe('東2局1本場 6巡目');
      await page.getByRole('button', { name: '迷い3を次の手に付け替える' }).click();
      await expect.poll(() => titleText(page)).not.toBe('東2局1本場 6巡目');
      await page.locator('.qz[data-state="answering"]').waitFor();
      await expect.poll(() => page.evaluate(() => document.activeElement?.getAttribute('aria-label'))).toBe('迷い3の画像を大きく見る');
      // 付け替えた先の場面の見出しに、迷い 3 の札
      expect(await page.locator('.q-chips .q-chip.is-doubt').allTextContents()).toEqual(['迷い3']);
      // Ctrl+Z: 付け替える前の結びつけに戻る（見ている手は、そのまま。迷いの場面ではなくなる）
      await page.keyboard.press('Control+z');
      await expect.poll(() => page.locator('[data-shots="block"]').count()).toBe(0);
      const calls = await page.evaluate(() =>
        (window as unknown as { __jrCalls: Array<{ cmd: string; args: { decision?: string } }> }).__jrCalls.filter((c) => c.cmd === 'set_mark_link').map((c) => c.args.decision),
      );
      expect(calls).toHaveLength(2);
      expect(calls[1]).toBe('k1h1e7');
    } finally {
      await context.close();
    }
  });

  it('写真: Enter で大きく見られ、Esc で閉じて写真に戻る。Space で開き、外の押下で閉じて写真に戻る', { timeout: 90_000 }, async () => {
    const { context, page } = await open({ width: 1440, height: 900 });
    try {
      await openReplay(page);
      await gotoScene(page, 'k1h1e7');
      const thumb = page.locator('[data-shots="block"] .mthumb').first();
      await thumb.focus();
      await page.keyboard.press('Enter');
      const dialog = page.getByRole('dialog', { name: '迷いの画像' });
      await dialog.waitFor();
      await page.keyboard.press('Escape');
      await dialog.waitFor({ state: 'detached' });
      expect(await thumb.evaluate((el) => el === document.activeElement)).toBe(true);
      await page.keyboard.press('Space');
      await dialog.waitFor();
      await page.locator('.lb-backdrop').click({ force: true, position: { x: 4, y: 4 } });
      await dialog.waitFor({ state: 'detached' });
      expect(await thumb.evaluate((el) => el === document.activeElement)).toBe(true);
    } finally {
      await context.close();
    }
  });
});

/**
 * 中央の箱のドラ表示牌の行を測って、決まりを確かめる（U-44）: 折り返さない（牌の上端がそろう）・行の箱が、中央の箱の中の点数・席の名前・
 * リーチの札・局の名前・本場・残りの箱と重ならない・行の中身が行からあふれない。箱が狭くて 2 語（表示・ドラ）を入れられないときは、2 語は見えない
 * （見えているときは、行に収まっている）。読み上げの名前（aria-label）は、どちらでも残る。
 */
async function expectDoraRowFits(page: Page, where: string): Promise<{ centre: number; labels: boolean; tiles: number }> {
  const m = await page.evaluate(() => {
    const box = (el: Element) => {
      const r = el.getBoundingClientRect();
      return { left: r.left, right: r.right, top: r.top, bottom: r.bottom };
    };
    const center = document.querySelector('.table .center') as HTMLElement;
    const row = center.querySelector('.dora') as HTMLElement;
    const shown = (el: Element) => (el as HTMLElement).checkVisibility();
    const others: Array<{ name: string; box: ReturnType<typeof box> }> = [];
    for (const selector of ['.score .who', '.score .pts', '.score .rch', '.round', '.round-s', '.honba', '.rest']) {
      for (const el of Array.from(center.querySelectorAll(selector))) if (shown(el)) others.push({ name: selector, box: box(el) });
    }
    const labels = Array.from(row.querySelectorAll('.dora-l'));
    return {
      centre: center.clientWidth,
      center: box(center),
      row: box(row),
      others,
      tileTops: Array.from(row.querySelectorAll('.tile')).map((tile) => tile.getBoundingClientRect().top),
      labelsShown: labels.length > 0 && labels.every(shown),
      labelsHidden: labels.every((label) => !shown(label)),
      scroll: [row.scrollWidth, row.clientWidth],
      aria: row.getAttribute('aria-label') ?? '',
    };
  });
  // 牌は 1 行（上端がそろう）。ドラ表示牌とドラの 2 つ以上の牌
  expect(m.tileTops.length, `${where} 牌の数`).toBeGreaterThanOrEqual(2);
  expect(Math.max(...m.tileTops) - Math.min(...m.tileTops), `${where} 牌の上端`).toBeLessThanOrEqual(0.5);
  // 中央の箱の中。点数・席の名前・局の名前と重ならない
  expect(m.row.left, `${where} 箱の左`).toBeGreaterThanOrEqual(m.center.left - 0.5);
  expect(m.row.right, `${where} 箱の右`).toBeLessThanOrEqual(m.center.right + 0.5);
  expect(m.row.bottom, `${where} 箱の下`).toBeLessThanOrEqual(m.center.bottom + 0.5);
  for (const other of m.others) {
    const hit = m.row.left < other.box.right && other.box.left < m.row.right && m.row.top < other.box.bottom && other.box.top < m.row.bottom;
    expect(hit, `${where} ${other.name} と重なる`).toBe(false);
  }
  // 行の中身は、行からあふれない。2 語は、全部見えるか、全部隠れるか
  expect(m.scroll[0], `${where} あふれ`).toBeLessThanOrEqual((m.scroll[1] as number) + 0.5);
  expect(m.labelsShown || m.labelsHidden, `${where} 2 語は、そろって出るか、そろって隠れる`).toBe(true);
  expect(m.aria, `${where} 読み上げ`).toMatch(/^ドラ表示牌 .+、ドラ .+$/);
  // 箱が狭い（牌 1 枚の行の 2 語が入らない 124px 未満）ときは 2 語を隠し、広い（200px 以上）ときは出す
  if (m.centre < 124) expect(m.labelsHidden, `${where} 狭い箱（${m.centre}px）では 2 語を隠す`).toBe(true);
  if (m.centre >= 200) expect(m.labelsShown, `${where} 広い箱（${m.centre}px）では 2 語を出す`).toBe(true);
  return { centre: m.centre, labels: m.labelsShown, tiles: m.tileTops.length };
}

describe('U-44: ドラ表示牌の行は折り返さず、中央の箱の点数・局の名前と重ならない（通して見る画面。実ブラウザ）', () => {
  for (const [width, height] of [
    [1280, 800],
    [1440, 900],
  ] as const) {
    it(`${width}×${height}: 迷いの場面（東2局 11巡目）と、東3局1本場の局の終わり（鳴きが卓にある）で、行は 1 行・重ならない。箱が狭ければ「表示」「ドラ」は隠れる`, { timeout: 120_000 }, async () => {
      const { context, page } = await open({ width, height, scheme: 'dark' });
      try {
        await openReplay(page);
        await gotoScene(page, 'k1h0e12');
        await answerCurrent(page);
        const scene = await expectDoraRowFits(page, `場面 ${width}×${height}`);
        expect(scene.tiles).toBe(2);
        await goToKyokuEnd(page, 4);
        await expectDoraRowFits(page, `東3局1本場の局の終わり ${width}×${height}`);
      } finally {
        await context.close();
      }
    });

    it(`${width}×${height}: ドラ表示牌が 2 つの局（f9da の西1局の終わり）でも、1 行・重ならない`, { timeout: 120_000 }, async () => {
      const { context, page } = await open({ width, height, scheme: 'dark' });
      try {
        await openReplay(page, 'f9da');
        // いちばん最後の局（西1局）の終わり
        await page.getByRole('button', { name: /^局を選ぶ/ }).click();
        await page.getByRole('menuitemradio').last().click();
        await page.locator('#b-kend').click();
        await page.locator('.now-res').waitFor();
        expect(await page.getByRole('heading', { level: 1 }).textContent()).toContain('西1局');
        const result = await expectDoraRowFits(page, `f9da 西1局 ${width}×${height}`);
        expect(result.tiles).toBeGreaterThanOrEqual(4);
      } finally {
        await context.close();
      }
    });
  }
});

describe('U-41・U-42・U-49: 操作の段の 2 つの段（悪手・迷い）と、解決した場面の薄い印', () => {
  /** 操作の段の「飛ぶ」段（.jump）の箱と、操作の段・文書の高さ。 */
  async function barLayout(page: Page) {
    return page.evaluate(() => {
      const groups = [...document.querySelectorAll<HTMLElement>('.pb-jumps .jump')].map((el) => {
        const r = el.getBoundingClientRect();
        return { kind: el.getAttribute('data-kind'), top: Math.round(r.top), bottom: Math.round(r.bottom), left: Math.round(r.left), right: Math.round(r.right) };
      });
      const bar = document.querySelector('.pbar')?.getBoundingClientRect();
      const jumps = document.querySelector('.pb-jumps')?.getBoundingClientRect();
      return {
        groups,
        barHeight: Math.round(bar?.height ?? 0),
        jumpsWidth: Math.round(jumps?.width ?? 0),
        jumpsRight: Math.round(jumps?.right ?? 0),
        documentHeight: document.documentElement.scrollHeight,
        windowHeight: window.innerHeight,
        barExtra: document.querySelector('.rp')?.getAttribute('style') ?? '',
      };
    });
  }

  for (const [width, height] of [
    [1920, 1080],
    [1440, 900],
    [1280, 800],
  ] as const) {
    it(`${width}×${height}: 段は悪手・迷いの 2 つで、1 行に並ぶ。拮抗の段は無く、卓は小さくしない。文書は、窓の高さに収まる`, { timeout: 90_000 }, async () => {
      const { context, page } = await open({ width, height });
      try {
        await openReplay(page);
        const layout = await barLayout(page);
        expect(layout.groups.map((g) => g.kind)).toEqual(['mismatch', 'doubt']);
        expect(new Set(layout.groups.map((g) => g.top)).size).toBe(1);
        expect(layout.groups[1]!.right).toBeLessThanOrEqual(layout.jumpsRight);
        expect(layout.groups[0]!.right).toBeLessThanOrEqual(layout.groups[1]!.left);
        expect(layout.barExtra).toBe('');
        expect(layout.documentHeight).toBeLessThanOrEqual(layout.windowHeight);
        expect(await page.locator('.jump[data-kind="contest"], .pin.cst').count()).toBe(0);
        expect(await page.getByRole('button', { name: /拮抗/ }).count()).toBe(0);
      } finally {
        await context.close();
      }
    });
  }

  it('悪手の段: 名前は「悪手の場面へ飛ぶ」、文字は「悪手 N か所」、前・次のボタンは「前の悪手へ」「次の悪手へ」', { timeout: 60_000 }, async () => {
    const { context, page } = await open({ width: 1280, height: 800 });
    try {
      await openReplay(page);
      const group = page.locator('.jump[data-kind="mismatch"]');
      expect(await group.getAttribute('aria-label')).toBe('悪手の場面へ飛ぶ');
      expect(((await group.textContent()) ?? '').replace(/\s+/g, ' ')).toMatch(/^悪手 5か所/);
      expect(await group.getByRole('button', { name: '前の悪手へ' }).count()).toBe(1);
      await group.getByRole('button', { name: /^次の悪手へ/ }).click();
      await page.locator('.qz[data-state="answering"]').waitFor();
      expect(await page.locator('.q-chips .q-chip', { hasText: '悪手' }).count()).toBe(1);
      // 答える前に AI の情報は無い
      expect(await page.locator('[data-ai]').count()).toBe(0);
    } finally {
      await context.close();
    }
  });

  it('印の形: 迷いは丸、細かいミスだけ四角、悪手はひし形（描かれた形で確かめる。拮抗の横棒は無い）。解決した場面の印は薄い', { timeout: 60_000 }, async () => {
    const { context, page } = await open({ width: 1440, height: 900, scenario: scenario({ resolved: ['k1h1e7'] }) });
    try {
      await openReplay(page);
      const shape = (selector: string) =>
        page.evaluate((target) => {
          const pin = document.querySelector(target);
          if (pin === null) return null;
          const before = getComputedStyle(pin, '::before');
          return {
            width: Number.parseFloat(before.width),
            height: Number.parseFloat(before.height),
            radius: before.borderTopLeftRadius,
            transform: before.transform,
            opacity: getComputedStyle(pin).opacity,
            up: pin.closest('.tl-pins')?.classList.contains('up') ?? false,
          };
        }, selector);
      const round = await shape('.pin.dbt[data-key="k0h0e4"]');
      expect(round).toMatchObject({ width: 12, height: 12, up: true, opacity: '1' });
      expect(Number.parseFloat(round!.radius)).toBeGreaterThanOrEqual(6);
      const square = await shape('.pin.dbt.sq[data-key="k1h0e12"]');
      expect(square).toMatchObject({ width: 12, height: 12, up: true });
      expect(Number.parseFloat(square!.radius)).toBeLessThanOrEqual(2);
      const diamond = await shape('.pin.mis[data-key="k1h1e9"]');
      expect(diamond).toMatchObject({ width: 10, height: 10, up: false });
      expect(diamond!.transform).not.toBe('none');
      expect(await page.locator('.pin.cst').count()).toBe(0);
      // 解決した場面（迷い 3）の印は薄い。押せる
      const resolved = await shape('.pin.dbt[data-key="k1h1e7"]');
      expect(resolved).toMatchObject({ opacity: '0.35' });
      await page.locator('.pin.dbt[data-key="k1h1e7"]').click();
      await page.locator('.qz[data-state="answering"]').waitFor();
      expect(await page.getByRole('button', { name: '解決', exact: true }).getAttribute('aria-pressed')).toBe('true');
    } finally {
      await context.close();
    }
  });

  it('解決した場面の、場面の一覧の行は薄い（解決の印は薄くしない）。解決を入れると、その場で印と数が変わる', { timeout: 60_000 }, async () => {
    const { context, page } = await open({ width: 1440, height: 900, scenario: scenario({ resolved: ['k1h1e7'] }) });
    try {
      await openReplay(page);
      // 薄くするのは、透明にせず（読める濃さを保つ）、場所と札の文字を静かな色（補助の文字と同じ色）にすること。解決の印は ink のまま
      const colors = (key: string) =>
        page.locator(`.sc-row[data-key="${key}"]`).evaluate((el) => ({
          place: getComputedStyle(el.querySelector('.sc-where b') as Element).color,
          weight: getComputedStyle(el.querySelector('.sc-where b') as Element).fontWeight,
          tag: getComputedStyle(el.querySelector('.sc-tags .tag') as Element).color,
          sub: getComputedStyle(el.querySelector('.sc-sub') as Element).color,
          status: el.querySelector('.sc-st.resolved') === null ? null : getComputedStyle(el.querySelector('.sc-st.resolved') as Element).color,
          ink: getComputedStyle(el).color,
        }));
      const dim = await colors('k1h1e7');
      expect(dim.place).toBe(dim.sub);
      expect(dim.tag).toBe(dim.sub);
      expect(dim.weight).toBe('400');
      expect(dim.status).toBe(dim.ink);
      expect(dim.sub).not.toBe(dim.ink);
      const live = await colors('k1h0e12');
      expect(live.place).toBe(live.ink);
      expect(live.status).toBeNull();
      expect(await page.locator('.jump[data-kind="doubt"]').textContent()).toContain('5か所');
      // 別の場面で解決を入れると、数が減り、印が薄くなる
      await page.locator('.sc-row[data-key="k2h1e6"]').click();
      await page.getByRole('button', { name: '解決', exact: true }).click();
      await page.waitForFunction(() => document.querySelector('.pin.dbt[data-key="k2h1e6"]')?.getAttribute('data-resolved') === '1');
      expect(await page.locator('.jump[data-kind="doubt"]').textContent()).toContain('4か所');
      // Ctrl+Z で戻る
      await page.keyboard.press('Control+z');
      await page.waitForFunction(() => document.querySelector('.pin.dbt[data-key="k2h1e6"]')?.getAttribute('data-resolved') === '0');
      expect(await page.locator('.jump[data-kind="doubt"]').textContent()).toContain('5か所');
    } finally {
      await context.close();
    }
  });

  it('「細かいミスだけ」は、押すと入り、開き直しても入のまま（画面の保存領域に覚える）。押されているかは、文字とチェックの印でも分かる', { timeout: 60_000 }, async () => {
    const { context, page } = await open({ width: 1440, height: 900 });
    try {
      await openReplay(page);
      const toggle = () => page.getByRole('button', { name: '細かいミスだけ' });
      expect(await toggle().getAttribute('aria-pressed')).toBe('false');
      expect(await toggle().locator('svg').count()).toBe(0);
      await toggle().click();
      expect(await toggle().getAttribute('aria-pressed')).toBe('true');
      expect(await toggle().locator('svg').count()).toBe(1);
      expect(await page.evaluate(() => window.localStorage.getItem('jantama.fineMissOnly'))).toBe('1');
      expect(await page.locator('.jump[data-kind="doubt"]').textContent()).toContain('1か所');
      await page.reload();
      await waitForMainReady(page);
      await waitForSidebarCounts(page, 20_000);
      await openReplay(page);
      expect(await toggle().getAttribute('aria-pressed')).toBe('true');
      // 色だけに頼らない: 押されているときは、枠と文字の色が accent に変わり、チェックの印が付く
      const colors = await toggle().evaluate((el) => ({ border: getComputedStyle(el).borderTopColor, text: getComputedStyle(el).color }));
      expect(colors.border).toBe(colors.text);
    } finally {
      await context.close();
    }
  });
});

describe('U-41: 答えの欄の上の段の「解決」（実ブラウザ）', () => {
  it('答える前も、上の段の先頭に「解決」。答えの本文をスクロールしても、見える。解決を入れると次の場面へのボタンが出る', { timeout: 90_000 }, async () => {
    const { context, page } = await open({ width: 1280, height: 800 });
    try {
      await openReplay(page);
      await gotoScene(page, 'k1h1e7');
      const bar = page.locator('.answer-bar');
      const resolve = page.getByRole('button', { name: '解決', exact: true });
      expect(await resolve.isVisible()).toBe(true);
      expect(await page.locator('#next').count()).toBe(0);
      const first = await bar.evaluate((el) => el.firstElementChild?.id);
      expect(first).toBe('resolve');
      await resolve.click();
      await page.locator('#next').waitFor();
      expect(await resolve.getAttribute('aria-pressed')).toBe('true');
      expect(await resolve.locator('svg').count()).toBe(1);
      // 答えの本文をいちばん下までスクロールしても、上の段（解決と次へ）は見えている
      const panel = page.locator('.answer-scroll');
      const before = await bar.boundingBox();
      await panel.hover();
      await page.mouse.wheel(0, 100_000);
      expect(await bar.boundingBox()).toEqual(before);
      expect(await resolve.isVisible()).toBe(true);
      expect(await page.locator('#next').isVisible()).toBe(true);
      // 文書全体はスクロールしない（U-39）
      expect(await page.evaluate(() => document.documentElement.scrollHeight <= window.innerHeight)).toBe(true);
      // 切る
      await resolve.click();
      await page.locator('#next').waitFor({ state: 'detached' });
      expect(await resolve.getAttribute('aria-pressed')).toBe('false');
    } finally {
      await context.close();
    }
  });

  it('答え合わせのあとも、上の段の先頭に「解決」と、右に次へ。axe の重大な違反が無い（ライト・ダーク）', { timeout: 90_000 }, async () => {
    const { context, page } = await open({ width: 1280, height: 800, scenario: scenario({ resolved: ['k1h1e7'] }) });
    try {
      await openReplay(page);
      await gotoScene(page, 'k1h1e7');
      await answerCurrent(page);
      const ids = await page.locator('.answer-bar').evaluate((el) => [...el.children].map((child) => child.id));
      expect(ids).toEqual(['resolve', 'next']);
      expect(await page.getByRole('button', { name: '解決', exact: true }).getAttribute('aria-pressed')).toBe('true');
      for (const scheme of SCHEMES) {
        await page.emulateMedia({ colorScheme: scheme });
        expect(seriousViolations(await runAxe(page)), scheme).toEqual([]);
      }
    } finally {
      await context.close();
    }
  });
});
