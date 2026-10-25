// @vitest-environment node
/**
 * 実ブラウザで、検討ログ（U-29。U-4・U-5・U-6 も）を検査する。
 *
 * - U-4: 幅 390・768・1280px で、ログの各状態（答えを隠す・出す・絞り込んだ・空・先週）に横スクロールが出ない。
 *   行の手牌（牌は 14 枚前後。副露・ツモ牌・鳴く牌つき）は、列の幅に収まる（はみ出さない・極端に小さくならない）
 * - U-5・U-6: axe の重大な違反が 0 件（色のコントラストを含む。ライトとダーク）。Tab で、すべての操作に届く。順は、絞り込み → 答えを出す → 行
 * - 牌の画像が、すべて読み込める（手牌・副露）
 * - 配置: 絞り込みは 1 行（幅 1280）。幅 390 では、行が 1 問ずつのカードに積まれる
 * - 本物のキー: 行にキーボードの位置を置いて Enter で問題を開き、Alt+← でログに戻る（絞り込みはそのまま）
 * jsdom の試験（src/main/log）と同じふるまいを、実際の描画・キー・時計で確かめる。
 */
import { actualChoice, keyOfDecision, type Decision, type ImportedGame } from '@jantama/engine';
import type { Browser, BrowserContext, Page } from 'playwright-core';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import { handExtent } from '../../src/main/log/HandPreview';
import { handPreviewOf } from '../../src/main/log/logModel';
import { REPORT_TEXTS, folderName, local, seedSession } from '../fake-sessions';
import { answerRow, gameOf } from '../fake-study';
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

const SCHEMES = ['light', 'dark'] as const;
type Scheme = (typeof SCHEMES)[number];

/** 試験の「いま」: 2026 年 10 月 9 日（金）22:00。今週は 10 月 5 日（月）から。 */
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

const fx4 = gameOf('fx4');
const fx1a = gameOf('fx1a');

function sessionSeeds() {
  const sessions = [
    fx4Session(FX4_ID, FX4_AT, { report_path: `C:\\data\\games\\${FX4_ID}\\report.json`, ocr: fx4Ocr() }),
    seedSession(FX1A_AT, { id: FX1A_ID, report: 'fx1a' }).session,
  ];
  const reports: Record<string, string> = { [FX4_ID]: REPORT_TEXTS.fx4, [FX1A_ID]: REPORT_TEXTS.fx1a };
  return { sessions, reports };
}

interface Pick {
  sessionId: string;
  game: ImportedGame;
  decision: Decision;
}

/** 答える問題: 手牌の幅が最大になる判断（副露つき・鳴く牌つき）と、種類の違う判断を、2 つの半荘から。 */
function picks(): Pick[] {
  const all: Pick[] = [
    ...fx4.decisions.map((decision) => ({ sessionId: FX4_ID, game: fx4, decision })),
    ...fx1a.decisions.map((decision) => ({ sessionId: FX1A_ID, game: fx1a, decision })),
  ];
  const units = (p: Pick) => handExtent(handPreviewOf(p.decision)).units;
  const widest = [...all].sort((a, b) => units(b) - units(a)).slice(0, 3);
  const withMelds = all.filter((p) => handPreviewOf(p.decision).melds.length >= 2).slice(0, 3);
  const calls = all.filter((p) => p.decision.kind === 'call').filter((_, i) => i % 6 === 0).slice(0, 4);
  const discards = all.filter((p) => p.decision.kind === 'discard').filter((_, i) => i % 23 === 0).slice(0, 8);
  const chosen = new Map<string, Pick>();
  for (const p of [...widest, ...withMelds, ...calls, ...discards]) chosen.set(`${p.sessionId}/${keyOfDecision(p.decision)}`, p);
  return [...chosen.values()];
}

const PICKS = picks();

/** 答えた問題: 今週（10/5〜）と、先週。原因・原則・選び直し・MAKA の食い違いも混ぜる。 */
function answers(): unknown[] {
  return PICKS.map((p, i) =>
    answerRow({
      id: i + 1,
      session_id: p.sessionId,
      decision_key: keyOfDecision(p.decision),
      mode: i % 4 === 3 ? 'review' : 'quiz',
      answered_at: i < 3 ? local(2026, 10, 1 + i, 20, 0) : local(2026, 10, 9, 21, 59) - i * 600_000,
      choice: actualChoice(p.decision),
      reason: '試験の理由',
      correct: i % 3 !== 0,
      duration_ms: 20_000 + i * 7_000,
      reselect_count: i % 5 === 0 ? 2 : 0,
      causes: i % 2 === 0 ? ['ukeire', 'defense'] : i % 3 === 0 ? ['shape'] : [],
      principle: i % 2 === 0 ? 'リーチが無いときは、受け入れを優先する' : '',
      maka_move: i % 6 === 2 && p.decision.kind === 'discard' ? p.decision.board.hand[0] : null,
      interval_days: 3,
      due_date: i % 2 === 0 ? '2026-10-12' : '2026-10-09',
    }),
  );
}

function scenario(withAnswers = true): Scenario {
  const { sessions, reports } = sessionSeeds();
  return {
    label: 'main',
    state: baseState,
    settings: baseSettings,
    inputStatus: null,
    sessions,
    reports,
    thumb: TINY_PNG,
    answers: withAnswers ? answers() : [],
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

async function open(options: { width?: number; height?: number; scheme?: Scheme; answers?: boolean } = {}): Promise<Opened> {
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
  await page.addInitScript(tauriMockScript(scenario(options.answers ?? true)));
  await page.goto(new URL('index.html', server.url).toString());
  await waitForMainReady(page);
  // 出題のデータ（半荘の再生・答えの記録）が読み終わると、サイドバーに数が出る
  await waitForSidebarCounts(page, 30_000);
  return { context, page, problems, external };
}

/** ログを開く（サイドバーの「ログ」）。行が出るまで待つ。 */
async function openLog(page: Page, options: { rows?: boolean } = {}): Promise<void> {
  // 細い窓（640px 未満）では、サイドバーは引き出しに隠れている。開いてから押す（押すと閉じる）
  await ensureSidebar(page);
  await page.getByRole('navigation', { name: 'メイン' }).getByRole('button', { name: 'ログ' }).click();
  await page.getByRole('heading', { level: 1, name: 'ログ' }).waitFor();
  if (options.rows !== false) await page.locator('button.lrow').first().waitFor({ timeout: 30_000 });
  await page.waitForFunction(() => Array.from(document.images).every((img) => img.complete));
}

interface StateDef {
  name: string;
  run: (page: Page) => Promise<void>;
  /** 行が出る状態か。 */
  rows?: boolean;
}

const filterButton = (page: Page, name: RegExp) => page.getByRole('group', { name: '絞り込み' }).getByRole('button', { name });

const STATES: StateDef[] = [
  { name: '一覧（答えは隠す）', run: async () => undefined },
  {
    name: '答えを出す',
    run: async (page) => {
      await page.getByRole('checkbox', { name: '答えを出す' }).check();
    },
  },
  {
    name: '絞り込み（結果 = 不正解。メニューを開いたまま）',
    run: async (page) => {
      await filterButton(page, /^結果/).click();
      await page.getByRole('menuitemcheckbox', { name: /^不正解/ }).click();
      await page.getByRole('menu', { name: '結果' }).waitFor();
    },
  },
  {
    name: '先週（期間 = 先週。答えを出す）',
    run: async (page) => {
      await filterButton(page, /^期間/).click();
      await page.getByRole('menuitemradio', { name: /^先週/ }).click();
      await page.getByRole('checkbox', { name: '答えを出す' }).check();
    },
  },
  {
    name: '0 件（種類 = カン。絞り込みを解除が出る）',
    rows: false,
    run: async (page) => {
      await filterButton(page, /^種類/).click();
      await page.getByRole('menuitemcheckbox', { name: /^カン/ }).click();
      await page.keyboard.press('Escape');
      await page.getByText('この条件に合う問題はありません。').waitFor();
    },
  },
];

async function openState(state: StateDef, options: { width?: number; scheme?: Scheme } = {}): Promise<Opened> {
  const opened = await open(options);
  await openLog(opened.page);
  await state.run(opened.page);
  return opened;
}

// ---- 横スクロール・手牌の収まり・axe・テーマ ----

interface Fit {
  scroll: number;
  client: number;
  body: number;
  rows: number;
  worst: Array<{ label: string; hand: number; column: number; scrollWidth: number; clientWidth: number; tile: number }>;
  rowOverflow: number;
}

async function fit(page: Page): Promise<Fit> {
  return page.evaluate(() => {
    const rows = [...document.querySelectorAll<HTMLElement>('button.lrow')];
    return {
      scroll: document.documentElement.scrollWidth,
      client: document.documentElement.clientWidth,
      body: document.body.scrollWidth,
      rows: rows.length,
      rowOverflow: rows.filter((row) => row.scrollWidth > row.clientWidth + 1).length,
      worst: rows.map((row) => {
        const hand = row.querySelector<HTMLElement>('.l-hand');
        const column = row.querySelector<HTMLElement>('.l-main');
        const tile = row.querySelector<HTMLElement>('.l-hand .tile');
        const last = hand?.lastElementChild;
        return {
          label: row.querySelector('.l-t')?.textContent ?? '',
          // 手牌の右端（最後の牌・副露の右端）が、列の右端に収まるか
          hand: last === null || last === undefined ? 0 : last.getBoundingClientRect().right,
          column: column?.getBoundingClientRect().right ?? 0,
          scrollWidth: hand?.scrollWidth ?? 0,
          clientWidth: hand?.clientWidth ?? 0,
          tile: tile?.getBoundingClientRect().width ?? 0,
        };
      }),
    };
  });
}

describe('U-4・U-5・U-6: ログの各状態の、幅・手牌の収まり・アクセシビリティ・テーマ', () => {
  it('答える問題に、手牌の幅が最大の判断（副露・鳴く牌つき）が入っている（収まりの検査が空振りしない）', () => {
    expect(PICKS.length).toBeGreaterThan(12);
    const extents = PICKS.map((p) => handExtent(handPreviewOf(p.decision)));
    expect(Math.max(...extents.map((e) => e.units))).toBeGreaterThan(14);
    expect(PICKS.some((p) => handPreviewOf(p.decision).melds.length >= 2)).toBe(true);
    expect(PICKS.some((p) => p.decision.kind === 'call')).toBe(true);
  });

  for (const state of STATES) {
    it(`${state.name}: 幅 390・768・1280px で横スクロールが出ず、手牌は列に収まる。axe の重大な違反が 0 件（ライト・ダーク）`, { timeout: 180_000 }, async () => {
      for (const width of [390, 768, 1280]) {
        for (const scheme of SCHEMES) {
          const { context, page, problems, external } = await openState(state, { width, scheme });
          try {
            const f = await fit(page);
            const where = `${state.name} @${width} ${scheme}`;
            expect(f.scroll, where).toBeLessThanOrEqual(f.client);
            expect(f.body, `${where} body`).toBeLessThanOrEqual(f.client);
            if (state.rows !== false) {
              expect(f.rows, where).toBeGreaterThan(2);
              expect(f.rowOverflow, `${where} 行がはみ出す`).toBe(0);
              for (const row of f.worst) {
                expect(row.hand, `${where} ${row.label}: 手牌が列からはみ出す`).toBeLessThanOrEqual(row.column + 1);
                expect(row.scrollWidth, `${where} ${row.label}`).toBeLessThanOrEqual(row.clientWidth + 1);
                // 牌が極端に小さくならない（13px = 下限）
                expect(row.tile, `${where} ${row.label}: 牌の幅`).toBeGreaterThanOrEqual(12.5);
                expect(row.tile, `${where} ${row.label}: 牌の幅`).toBeLessThanOrEqual(22.5);
              }
            } else {
              expect(f.rows).toBe(0);
            }
            const axe = await runAxe(page);
            expect(seriousViolations(axe), where).toEqual([]);
            expect(axe.passes.find((p) => p.id === 'color-contrast')?.nodes ?? 0, `${where} コントラストの対象`).toBeGreaterThan(5);
            expect(problems, where).toEqual([]);
            expect(external, where).toEqual([]);
          } finally {
            await context.close();
          }
        }
      }
    });
  }

  it('答えを隠しているとき、答えの欄は DOM に無い。出すと、すべての行に出る（本物のブラウザで）', { timeout: 60_000 }, async () => {
    const { context, page } = await open();
    try {
      await openLog(page);
      expect(await page.locator('.l-ans').count()).toBe(0);
      expect(await page.locator('button.lrow').evaluateAll((rows) => rows.every((row) => !/自分|実戦|AI の1位/.test(row.textContent ?? '')))).toBe(true);
      await page.getByRole('checkbox', { name: '答えを出す' }).check();
      const counts = await page.evaluate(() => ({ rows: document.querySelectorAll('button.lrow').length, ans: document.querySelectorAll('button.lrow .l-ans').length }));
      expect(counts.ans).toBe(counts.rows);
      await page.getByRole('checkbox', { name: '答えを出す' }).uncheck();
      expect(await page.locator('.l-ans').count()).toBe(0);
    } finally {
      await context.close();
    }
  });
});

describe('U-29: 牌の画像（手牌・副露）が読み込める', () => {
  it('すべての行の手牌の画像が、読み込めている（幅 1280・390）。牌の数は、再生した手牌と同じ', { timeout: 90_000 }, async () => {
    for (const width of [1280, 390]) {
      const { context, page, problems } = await open({ width });
      try {
        await openLog(page);
        await filterButton(page, /^期間/).click();
        await page.getByRole('menuitemradio', { name: /^すべて/ }).click();
        const info = await page.evaluate(() => {
          const images = [...document.querySelectorAll<HTMLImageElement>('.l-hand img')];
          return {
            total: images.length,
            broken: images.filter((img) => !img.complete || img.naturalWidth === 0).map((img) => img.getAttribute('src')),
            sources: new Set(images.map((img) => img.getAttribute('src'))).size,
            // 牌の面（背景の画像）も、描かれている
            faces: [...document.querySelectorAll<HTMLElement>('.l-hand .tile')].filter((tile) => getComputedStyle(tile).backgroundImage.includes('Front.svg')).length,
            tiles: document.querySelectorAll('.l-hand .tile').length,
            back: document.querySelectorAll('.l-hand .tile.back').length,
          };
        });
        expect(info.total).toBeGreaterThan(100);
        expect(info.broken, `@${width}`).toEqual([]);
        expect(info.sources).toBeGreaterThan(10);
        // 裏向きの牌（暗槓の両端）以外は、牌の面がある
        expect(info.faces).toBe(info.tiles - info.back);
        expect(problems).toEqual([]);
      } finally {
        await context.close();
      }
    }
  });
});

describe('U-29: 配置', () => {
  it('幅 1280px: 絞り込みは 1 行（期間・種類・局面・原因・結果の順）。行は、日付・本文・結果の 3 つの列', { timeout: 60_000 }, async () => {
    const { context, page } = await open({ width: 1280 });
    try {
      await openLog(page);
      const g = await page.evaluate(() => {
        const buttons = [...document.querySelectorAll<HTMLElement>('.lfilters .lf')];
        const row = document.querySelector('button.lrow') as HTMLElement;
        const r = (el: Element) => el.getBoundingClientRect();
        return {
          names: buttons.map((b) => b.querySelector('.lf-k')?.textContent),
          oneRow: buttons.every((b) => Math.abs(r(b).top - r(buttons[0] as HTMLElement).top) < 4),
          cols: {
            when: r(row.querySelector('.l-when') as Element).right,
            main: [r(row.querySelector('.l-main') as Element).left, r(row.querySelector('.l-main') as Element).right],
            meta: r(row.querySelector('.l-meta') as Element).left,
          },
        };
      });
      expect(g.names).toEqual(['期間', '種類', '局面', '原因', '結果']);
      expect(g.oneRow).toBe(true);
      expect(g.cols.when).toBeLessThanOrEqual(g.cols.main[0] as number);
      expect(g.cols.main[1]).toBeLessThanOrEqual(g.cols.meta);
    } finally {
      await context.close();
    }
  });

  for (const width of [390, 768]) {
    it(`幅 ${width}px: 行が 1 問ずつのカードに積まれる（日付と結果 → 問題 → 時間と次の解き直し）。答えを出すと、問題と時間の間に出る`, { timeout: 60_000 }, async () => {
      const { context, page } = await open({ width });
      try {
        await openLog(page);
        await page.getByRole('checkbox', { name: '答えを出す' }).check();
        const stacked = await page.evaluate(() => {
          const row = document.querySelector('button.lrow') as HTMLElement;
          const r = (sel: string) => (row.querySelector(sel) as Element).getBoundingClientRect();
          return {
            main: r('.l-main').top >= r('.l-when').bottom - 2,
            res: Math.abs(r('.l-res').top - r('.l-when').top) < 12,
            ans: r('.l-ans').top >= r('.l-main').bottom - 2,
            sub: r('.l-sub').top >= r('.l-ans').bottom - 2,
          };
        });
        expect(stacked).toEqual({ main: true, res: true, ans: true, sub: true });
      } finally {
        await context.close();
      }
    });
  }
});

describe('U-5: Tab で、すべての操作に届く（順: 絞り込み → 答えを出す → 答えを出すの説明 → 行）', () => {
  it('幅 1280・390px: 絞り込み・解除・答えを出す・行のすべてに、Tab だけで届く', { timeout: 90_000 }, async () => {
    for (const width of [1280, 390]) {
      const { context, page } = await open({ width });
      try {
        await openLog(page);
        await filterButton(page, /^結果/).click();
        await page.getByRole('menuitemcheckbox', { name: /^不正解/ }).click();
        await page.keyboard.press('Escape');
        await page.getByRole('button', { name: '解除' }).waitFor();
        const reach = await unreachableByTab(page);
        expect(reach.total).toBeGreaterThan(8);
        expect(reach.missed, `@${width}`).toEqual([]);
      } finally {
        await context.close();
      }
    }
  });

  it('Tab の順: 絞り込みの 5 つ → 解除 → 答えを出す → 行（上から）。止まった所に 2px 以上の輪が見える', { timeout: 60_000 }, async () => {
    const { context, page } = await open({ width: 1280 });
    try {
      await openLog(page);
      await filterButton(page, /^結果/).click();
      await page.getByRole('menuitemcheckbox', { name: /^不正解/ }).click();
      await page.keyboard.press('Escape');
      await page.getByRole('button', { name: '解除' }).waitFor();
      await filterButton(page, /^期間/).focus();
      const seen: string[] = [];
      const rings: number[] = [];
      for (let i = 0; i < 10; i += 1) {
        const info = await page.evaluate(() => {
          const el = document.activeElement as HTMLElement;
          const style = getComputedStyle(el);
          return {
            label: el.classList.contains('lrow')
              ? `行 ${el.querySelector('.l-t')?.textContent}`
              : (el as HTMLInputElement).labels?.[0]?.textContent?.trim() ?? el.getAttribute('aria-label') ?? el.textContent?.trim() ?? '',
            ring: style.outlineStyle === 'none' ? 0 : parseFloat(style.outlineWidth),
          };
        });
        seen.push(info.label);
        rings.push(info.ring);
        await page.keyboard.press('Tab');
      }
      // 「答えを出す」のすぐ次は、その説明の (i)（U-25）。そのあとが行
      expect(seen.slice(0, 8)).toEqual(['期間 今週', '種類 すべて', '局面 すべて', '原因 すべて', '結果 不正解', '解除', '答えを出す', '「答えを出す」の説明']);
      expect(seen[8]).toMatch(/^行 /);
      expect(seen[9]).toMatch(/^行 /);
      expect(seen[8]).not.toBe(seen[9]);
      for (const ring of rings) expect(ring).toBeGreaterThanOrEqual(2);
    } finally {
      await context.close();
    }
  });
});

describe('U-29: 本物のキー（行・メニュー・戻る）', () => {
  it('行にキーボードの位置を置いて Enter: その問題が保存した答えで開く。Alt+← でログに戻り、絞り込みと「答えを出す」はそのまま', { timeout: 60_000 }, async () => {
    const { context, page, problems } = await open();
    try {
      await openLog(page);
      await page.getByRole('checkbox', { name: '答えを出す' }).check();
      await filterButton(page, /^結果/).click();
      await page.getByRole('menuitemcheckbox', { name: /^不正解/ }).click();
      await page.keyboard.press('Escape');
      const before = await page.locator('button.lrow').count();
      expect(before).toBeGreaterThan(2);
      const second = page.locator('button.lrow').nth(1);
      const title = await second.locator('.l-t').textContent();
      await second.focus();
      await page.keyboard.press('Enter');
      await page.getByRole('heading', { level: 1, name: title ?? '' }).waitFor();
      // 答え合わせのあとの形（保存した答え）: 答える前の欄（理由の入力欄）は無い
      await page.getByText('試験の理由').first().waitFor();
      expect(await page.getByLabel('理由（1行）').count()).toBe(0);
      await page.keyboard.press('Alt+ArrowLeft');
      await page.getByRole('heading', { level: 1, name: 'ログ' }).waitFor();
      expect(await page.locator('button.lrow').count()).toBe(before);
      expect(await page.getByRole('checkbox', { name: '答えを出す' }).isChecked()).toBe(true);
      expect(await filterButton(page, /^結果/).textContent()).toContain('不正解');
      // 進む（Alt+→）で、また問題へ
      await page.keyboard.press('Alt+ArrowRight');
      await page.getByRole('heading', { level: 1, name: title ?? '' }).waitFor();
      expect(problems).toEqual([]);
    } finally {
      await context.close();
    }
  });

  it('見ていた位置: 下の方の行を開いて Alt+← で戻ると、ログは見ていた位置のまま（先頭に戻らない）', { timeout: 60_000 }, async () => {
    const { context, page } = await open({ width: 1280, height: 700 });
    try {
      await openLog(page);
      await page.evaluate(() => window.scrollTo(0, 900));
      await page.waitForFunction(() => window.scrollY > 800);
      const before = await page.evaluate(() => window.scrollY);
      // 見えている行を押す
      const target = page.locator('button.lrow').nth(6);
      const title = await target.locator('.l-t').textContent();
      await target.click();
      await page.getByRole('heading', { level: 1, name: title ?? '' }).waitFor();
      await page.keyboard.press('Alt+ArrowLeft');
      await page.getByRole('heading', { level: 1, name: 'ログ' }).waitFor();
      await page.waitForFunction((y) => Math.abs(window.scrollY - y) < 4, before);
      expect(Math.abs((await page.evaluate(() => window.scrollY)) - before)).toBeLessThan(4);
    } finally {
      await context.close();
    }
  });

  it('絞り込みのメニュー: 本物のキーで開く（Enter）・↓ で動く・Space で選ぶ（閉じない）・Esc で閉じて、ボタンに戻る', { timeout: 60_000 }, async () => {
    const { context, page } = await open();
    try {
      await openLog(page);
      const button = filterButton(page, /^原因/);
      await button.focus();
      await page.keyboard.press('Enter');
      const menu = page.getByRole('menu', { name: '原因' });
      await menu.waitFor();
      expect(await page.evaluate(() => document.activeElement?.getAttribute('role'))).toBe('menuitemcheckbox');
      await page.keyboard.press('ArrowDown');
      await page.keyboard.press('Space');
      const checked = await page.evaluate(() => [...document.querySelectorAll('[role="menuitemcheckbox"]')].map((el) => el.getAttribute('aria-checked')));
      expect(checked).toEqual(['false', 'true', 'false', 'false', 'false']);
      expect(await menu.isVisible()).toBe(true);
      await page.keyboard.press('Escape');
      await menu.waitFor({ state: 'detached' });
      expect(await page.evaluate(() => document.activeElement?.textContent)).toContain('原因 形の質');
    } finally {
      await context.close();
    }
  });

  it('答えた問題が 1 つも無いとき: ログは空の形（絞り込みの欄も、答えを出すの欄も出ない）。axe の重大な違反も 0 件', { timeout: 60_000 }, async () => {
    for (const scheme of SCHEMES) {
      const { context, page, problems } = await open({ answers: false, scheme, width: 390 });
      try {
        await openLog(page, { rows: false });
        await page.getByText(/答えた問題がまだありません/).waitFor();
        expect(await page.getByRole('group', { name: '絞り込み' }).count()).toBe(0);
        expect(await page.getByRole('checkbox', { name: '答えを出す' }).count()).toBe(0);
        expect(seriousViolations(await runAxe(page))).toEqual([]);
        expect(problems).toEqual([]);
      } finally {
        await context.close();
      }
    }
  });
});

describe('U-25: 説明のアイコン（ログの「答えを出す」）', () => {
  const HINT = 'あとで解き直すときに答えが見えてしまわないよう、ふだんは隠します。';
  for (const width of [390, 768, 1280]) {
    it(`幅 ${width}px: 説明の文は本文に出ず、(i) にマウスを乗せるかキーボードで選ぶと、窓の中に、「答えを出す」にかからずに重なって出る。Esc で閉じる。axe の重大な違反が 0 件（ライト・ダーク）`, { timeout: 120_000 }, async () => {
      for (const scheme of SCHEMES) {
        const { context, page, problems } = await open({ width, scheme });
        try {
          await openLog(page);
          const bar = page.locator('.lbar');
          const icon = bar.getByRole('button', { name: '「答えを出す」の説明' });
          expect(await bar.innerText()).not.toContain('ふだんは隠します');
          expect(await page.getByRole('tooltip').count()).toBe(0);
          await icon.hover();
          await page.getByRole('tooltip').waitFor();
          let m = await measureInfoTip(page, '.lans label.check');
          expect(m, `${width} ${scheme}`).not.toBeNull();
          expect(m!.text).toBe(HINT);
          expect(m!.tip.left).toBeGreaterThanOrEqual(7);
          expect(m!.tip.right).toBeLessThanOrEqual(m!.innerWidth - 7);
          expect(m!.tip.top).toBeGreaterThanOrEqual(0);
          expect(m!.tip.bottom).toBeLessThanOrEqual(m!.innerHeight);
          expect(boxesOverlap(m!.tip, m!.explained as BoxRect)).toBe(false);
          expect(boxesOverlap(m!.tip, m!.icon)).toBe(false);
          expect(seriousViolations(await runAxe(page)), `${width} ${scheme}`).toEqual([]);
          await page.keyboard.press('Escape');
          expect(await page.getByRole('tooltip').count()).toBe(0);
          await page.mouse.move(2, 2);
          // キーボード: 「答えを出す」から Tab で (i) に来ると出る
          await page.getByRole('checkbox', { name: '答えを出す' }).focus();
          await page.keyboard.press('Tab');
          expect(await icon.evaluate((el) => el === document.activeElement)).toBe(true);
          await page.getByRole('tooltip').waitFor();
          m = await measureInfoTip(page, '.lans label.check');
          expect(m!.text).toBe(HINT);
          expect(boxesOverlap(m!.tip, m!.explained as BoxRect)).toBe(false);
          await page.keyboard.press('Escape');
          expect(await page.getByRole('tooltip').count()).toBe(0);
          expect(problems).toEqual([]);
        } finally {
          await context.close();
        }
      }
    });
  }
});
