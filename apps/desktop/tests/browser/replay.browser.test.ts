// @vitest-environment node
/**
 * 実ブラウザで、半荘を通して見る画面（F12）を検査する（U-1・U-4・U-5・U-6・U-19・U-21・N-8）。
 *
 * - U-4: 幅 390・768・1280px で、各状態に横スクロールが出ない。1280×800 では、操作の段・卓・手牌が、ページをスクロールせずに見える
 * - U-5・U-6: axe の重大な違反が 0 件（色のコントラストを含む）。ライトとダーク。Tab ですべての操作に届く
 * - U-21: 既定のキーが働き、文字を打つ欄・メニューの中では働かない。キーの一覧は、押しても、マウスを乗せても開く。
 *   同じキーの割り当ては、割り当てずに断る。変えたキーは、設定に保存され、開き直しても働く
 * - U-1: 答える前の DOM に、AI の情報は無い（全場面。不一致を増やす設定のときの、増えた場面も）。外へ通信しない
 * - U-19: ドラを目立たせる設定が、通して見る画面でも効く
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
  capture_keywords: ['雀魂', 'Mahjong Soul'],
  data_dir: 'C:\\Users\\someone\\JantamaReviewerData',
  daily_count: 5,
  disagreement_percent: 5,
  highlight_dora: false,
  show_all_mismatches: false,
  replay_keys: defaultReplayKeys(),
};

/** ユーザーが選んだ迷いの結びつけ（links.json）。迷い 1〜6 がすべて場面になる（迷い 6 は、東3局1本場 11巡目）。 */
const USER_LINKS: Links = {
  ratings: {},
  marks: { '1': 'k0h0e4', '2': 'k1h0e12', '3': 'k1h1e7', '4': 'k1h1e10', '5': 'k2h1e6', '6': 'k2h1e14' },
};

/** FX-4 の場面（迷い 6 と大きな不一致 5。迷い 2 は大きな不一致でもある）の鍵。半荘の順。 */
const SCENE_KEYS = ['k0h0e4', 'k1h0e12', 'k1h1e6', 'k1h1e7', 'k1h1e9', 'k1h1e10', 'k2h1e2', 'k2h1e6', 'k2h1e14', 'k2h1e16'];

/** FX-4（読み取りの写しつき）と、f9da（河の段が多い長い局がある）。 */
function sessions() {
  return [
    fx4Session(FX4_ID, local(2026, 10, 9, 19, 9), {
      report_path: `C:\\data\\games\\${FX4_ID}\\report.json`,
      ocr: fx4Ocr(),
      links: USER_LINKS,
    }),
    seedSession(local(2026, 10, 9, 17, 12), { id: FX1A_ID, report: 'fx1a' }).session,
  ];
}

interface ScenarioOptions {
  dora?: boolean;
  showAll?: boolean;
  keys?: Record<string, string | null>;
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
    },
    inputStatus: null,
    sessions: sessions(),
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
  await page.getByRole('heading', { name: 'AIの評価（Mortal）' }).waitFor();
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
    name: '不一致も出す（設定が入）',
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
    name: '他家の手牌を開いたところ（局の終わり）',
    run: async (page) => {
      await openReplay(page);
      await goToKyokuEnd(page, 2);
      await page.getByRole('button', { name: '他家の手牌を開く', exact: true }).click();
      await page.locator('[data-open-hands="block"]').waitFor();
    },
  },
  {
    name: '他家の手牌を開いたところ（答えた場面）',
    run: async (page) => {
      await openReplay(page);
      await page.getByRole('button', { name: '他家の手牌を開く', exact: true }).click();
      await gotoScene(page, 'k1h1e7');
      await answerCurrent(page);
      await page.locator('[data-open-hands="block"]').waitFor();
    },
  },
  {
    name: 'タブ「他家の手牌」（答えた場面）',
    run: async (page) => {
      await openReplay(page);
      await gotoScene(page, 'k1h1e10');
      await answerCurrent(page);
      await page.getByRole('tab', { name: '他家の手牌' }).click();
      await page.locator('[data-ai="open-hands"]').waitFor();
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
    ['半荘の頭（盤面を見る）', '局の終わり（結果と点の増減）', '迷いの場面（答える前）', '鳴きの場面（答える前）', '不一致も出す（設定が入）', '長い局の終わり（f9da）'].includes(
      state.name,
    ),
  );
  it('検査する状態が、6 つそろっている', () => {
    expect(FIT_STATES.map((state) => state.name)).toHaveLength(6);
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
        ...Array.from(document.querySelectorAll('.table .tile, .hand .tile, .legend li')).map((el, i): [string, Element] => [`牌・凡例 ${i}`, el]),
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
          }
        } finally {
          await long.context.close();
        }
      }
    });
  }
});

describe('U-5: Tab ですべての操作に届く', () => {
  const ROVING = '.hand .tile-btn, [role="radio"], [role="tab"]';
  const REACH = [
    '半荘の頭（盤面を見る）',
    '局の終わり（結果と点の増減）',
    '迷いの場面（答える前）',
    '迷いの場面（答え合わせのあと）',
    '他家の手牌を開いたところ（局の終わり）',
    '他家の手牌を開いたところ（答えた場面）',
    'タブ「他家の手牌」（答えた場面）',
    '鳴きの場面（答える前）',
    'キーの一覧を開いたところ',
    '不一致も出す（設定が入）',
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
      await page.keyboard.press('Tab');
      expect(await page.evaluate(() => document.activeElement?.id)).toBe('reason');
      await page.keyboard.type('キーボードだけで答える');
      await page.keyboard.press('Tab');
      expect(await page.evaluate(() => document.activeElement?.id)).toBe('submit');
      await page.keyboard.press('Enter');
      await page.getByRole('heading', { name: 'AIの評価（Mortal）' }).waitFor();
      expect(await page.evaluate(() => document.activeElement?.id)).toBe('reveal-h');
    } finally {
      await context.close();
    }
  });
});

describe('U-35: 他家の手牌を開く（実ブラウザ）', () => {
  const toggle = (page: Page) => page.locator('#b-openhands');
  const handsInDom = (page: Page) => page.locator('[data-open-hands], .oh-row, .oh-hand').count();

  it('既定は閉じている。答える場面でない手では押せる。開くと、手を進めても開いたまま。答える場面の答える前は、全 10 場面で、押せず、他家の手牌が DOM にも無い。答えると出る', { timeout: 240_000 }, async () => {
    const { context, page } = await open();
    try {
      await openReplay(page);
      expect(await handsInDom(page)).toBe(0);
      expect(await toggle(page).isEnabled()).toBe(true);
      expect(((await toggle(page).textContent()) ?? '').trim()).toBe('他家の手牌を開く');
      await toggle(page).click();
      expect(await page.locator('.oh-row').count()).toBe(3);
      await page.locator('#b-next').click();
      await page.locator('#b-next').click();
      expect(await page.locator('.oh-row').count()).toBe(3);
      expect(((await toggle(page).textContent()) ?? '').trim()).toBe('他家の手牌を閉じる');
      // 開いたまま、各場面へ。答える前は、押せず、DOM にも無い
      for (const key of SCENE_KEYS) {
        await page.locator(`.pin[data-key="${key}"]`).first().click();
        await page.locator('.qz[data-state="answering"]').waitFor();
        expect(await toggle(page).isDisabled(), key).toBe(true);
        expect(await handsInDom(page), key).toBe(0);
        expect(await page.locator('[data-ai]').count(), key).toBe(0);
      }
      // 答えたあと: 押せて、開いたままなので出る
      await answerCurrent(page);
      expect(await toggle(page).isEnabled()).toBe(true);
      expect(await page.locator('[data-open-hands="block"] .oh-row').count()).toBe(3);
    } finally {
      await context.close();
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
      // ↓ は次の不一致（東2局 11巡目。迷い 2 でもある）。↑ は前の不一致（無い）
      await page.keyboard.press('ArrowDown');
      expect(await titleText(page)).toBe('東2局 11巡目');
      expect(await page.locator('.q-chips .q-chip').allTextContents()).toEqual(['1向聴', '実戦：打8p', '迷い2', '大きな不一致']);
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

  it('「AI の1位と違う判断も、不一致として出す」が入のとき、増えた場面（FX-4 は 3 か所）も、答える前の DOM に AI の情報が無い', { timeout: 120_000 }, async () => {
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
        expect(await page.locator('.q-chips .q-chip').last().textContent()).toBe('不一致');
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
