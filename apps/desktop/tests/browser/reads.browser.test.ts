// @vitest-environment node
/**
 * 実ブラウザで、読みの画面（F23）を検査する（U-53・U-1・U-39・U-4〜U-6）。
 *
 * - 幅 390・768・1280×800（と 1440×900・1920×1080）、ライト・ダークで、通して見る画面（上家がリーチ中に自分が打つ場面）と、
 *   解き直しの答え合わせのあとに、読みを出す。横スクロールが無く、手牌の下の数が隣と重ならず、自分の牌の列の中に収まる。
 *   他家の席の札は中央の箱に収まり（狭い箱では卓の上の 1 行）、折り返さない。axe の重大が 0
 * - 手牌の下の帯: 好みが切の画面は、これまでと同じ（帯を取らない）。入の画面は、切っても入れ直しても、卓も手牌も文書も動かない。
 *   1280×800・1440×900・1920×1080 で、文書は窓の高さに収まる（U-39）
 * - 答える前は、読みの切り替えも数も札も DOM に無く、読みのコマンドも呼ばない（U-1）
 * - 吹き出しは、牌の列の上に出て（幅 390px では画面の下から）、Esc・外を押すと閉じる。数は Tab で届く
 * - 見て確かめるための画面写真を、tests/browser/zz-reads-ui-shots/ に撮る（リポジトリには入れない）
 * 読みは本物の出力（packages/engine/tests/fixtures/reads-fx4.json）。jsdom の試験（src/main/reads）と同じふるまいを、実際の描画で確かめる。
 */
import { mkdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';

import { buildReplayTimeline, importReportText, keyOfDecision } from '@jantama/engine';
import type { Browser, BrowserContext, Locator, Page } from 'playwright-core';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import { defaultReplayKeys } from '../../src/main/replay/keys';
import { contrast, parseCssColor } from '../color-math';
import { REPORT_TEXTS, local, seedSession } from '../fake-sessions';
import { fx4Ocr, fx4Session } from '../import-fixtures';
import { expectNoHorizontalScroll, measureBoard } from './board-checks';
import {
  TINY_PNG,
  ensureSidebar,
  launchBrowser,
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
import { readsMockScript, type ReadsMockOptions } from './reads-mock';

const SCHEMES = ['light', 'dark'] as const;
type Scheme = (typeof SCHEMES)[number];

const NOW = new Date(2026, 9, 9, 22, 0, 0);
const FX4_ID = '20261009-190953';
const FX1A_ID = '20261009-171200';
const SHOTS = join(import.meta.dirname, 'zz-reads-ui-shots');
const REAL_READS = readFileSync(join(import.meta.dirname, '../../../../packages/engine/tests/fixtures/reads-fx4.json'), 'utf8');

/** 上家がリーチ中に自分が打つ場面（牌譜の位置 88）の、通して見る画面の手の位置と、解き直しにする判断の鍵。 */
const imported = importReportText(REPORT_TEXTS.fx4);
if (!imported.ok) throw new Error('FX-4 を読めません');
const timeline = buildReplayTimeline(imported.value);
const RIICHI_STEP = (timeline.steps.find((step) => step.eventIndex === 88) as { index: number }).index;
const RIICHI_KEY = keyOfDecision(imported.value.decisions.find((decision) => decision.eventIndex === 88) as never);

const baseState = { status: 'idle', session_id: null, mark_count: 0, ratings: [], next_hand: 1, can_undo: false, error: null };
const baseSettings = {
  trigger: { kind: 'mouse_x1' },
  orientation: 'vertical',
  widget_position: null,
  sound: true,
  doubt_only: false,
  capture_keywords: ['雀魂', 'Mahjong Soul'],
  data_dir: 'C:\\Users\\someone\\JantamaReviewerData',
  daily_count: 5,
  highlight_dora: false,
  show_all_mismatches: false,
  replay_keys: defaultReplayKeys(),
};

function scenario(): Scenario {
  return {
    label: 'main',
    state: baseState,
    settings: baseSettings,
    inputStatus: null,
    sessions: [
      fx4Session(FX4_ID, local(2026, 10, 9, 19, 9), { report_path: `C:\\data\\games\\${FX4_ID}\\report.json`, ocr: fx4Ocr() }),
      seedSession(local(2026, 10, 9, 17, 12), { id: FX1A_ID, report: 'fx1a' }).session,
    ],
    reports: { [FX4_ID]: REPORT_TEXTS.fx4, [FX1A_ID]: REPORT_TEXTS.fx1a },
    thumb: TINY_PNG,
    // 解き直し: 上家がリーチ中の場面を、今日が期限の問題にする
    answers: [
      {
        id: 1,
        session_id: FX4_ID,
        decision_key: RIICHI_KEY,
        mode: 'quiz',
        shown_at: 1,
        answered_at: 2,
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
      },
    ],
  };
}

let server: PageServer;
let browser: Browser;

beforeAll(async () => {
  server = await startPageServer();
  browser = await launchBrowser();
  mkdirSync(SHOTS, { recursive: true });
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
  reads?: Partial<ReadsMockOptions>;
}

async function open(options: OpenOptions = {}): Promise<Opened> {
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
  await page.addInitScript(readsMockScript({ visible: true, reads: REAL_READS, ...options.reads }));
  await page.goto(new URL('index.html', server.url).toString());
  await waitForMainReady(page);
  await waitForSidebarCounts(page, 20_000);
  return { context, page, problems, external };
}

/** 通して見る画面を開き、上家がリーチ中に自分が打つ場面（牌譜の位置 88）まで、1 手ずつ進める。 */
async function openReplayAtRiichi(page: Page): Promise<void> {
  await page.getByRole('button', { name: 'この半荘を通して見る' }).click();
  await page.locator('.pbar').waitFor();
  for (let count = 0; count < RIICHI_STEP; count += 1) await page.keyboard.press('Period');
  await page.locator('.rd-cell').first().waitFor();
}

/** 解き直しを開いて、答え合わせまで進める（打牌は手牌の右端）。 */
async function openReviewAndReveal(page: Page): Promise<void> {
  await ensureSidebar(page);
  await page.getByRole('navigation', { name: 'メイン' }).getByRole('button', { name: /^解き直し/ }).click();
  await page.locator('.qz').waitFor();
  await page.locator('.hand .tile-btn').last().click();
  await page.getByLabel('理由（1行）').fill('待ちを避けて');
  await page.getByRole('button', { name: '答え合わせ' }).click();
  await page.locator('#reveal-h').waitFor({ state: 'attached' });
}

async function shot(page: Page, name: string): Promise<void> {
  await page.screenshot({ path: join(SHOTS, `${name}.png`) });
}

// ---- 測る ----

interface Box extends BoxRect {
  width: number;
  height: number;
}

interface CellMeasure {
  label: string;
  strong: boolean;
  cell: Box;
  tile: Box;
  number: Box;
  barFill: number;
  barTrack: number;
  numberColor: string;
  fontFamily: string;
}

interface ChipMeasure {
  position: string;
  box: Box;
  label: string;
  text: string;
  wordShown: boolean;
  color: string;
  scrollWidth: number;
  clientWidth: number;
  lineCount: number;
}

interface ReadsLayout {
  cells: CellMeasure[];
  chips: ChipMeasure[];
  /** 中央の箱が狭いときの、卓の上の 1 行。無ければ null。 */
  line: { box: Box; scrollWidth: number; clientWidth: number; text: string; tools: Box; neighbors: Box[] } | null;
  marks: Box[];
  center: Box;
  /** 中央の箱の中身の幅（container query の cbox が見る幅。余白を除く）。 */
  centerInner: number;
  centerBackground: string;
  /** 札が重なってはいけないもの: 同じ席の風・点数・リーチの札、中央の箱の局名・王牌の列、ほかの席の札。 */
  others: Array<{ name: string; box: Box; seat: string | null }>;
  handWrap: Box | null;
  table: Box | null;
  document: { scrollHeight: number; scrollWidth: number; clientWidth: number; innerHeight: number; innerWidth: number };
}

async function measureReads(page: Page): Promise<ReadsLayout> {
  return page.evaluate(() => {
    const box = (el: Element): Box => {
      const r = el.getBoundingClientRect();
      return { left: r.left, right: r.right, top: r.top, bottom: r.bottom, width: r.width, height: r.height };
    };
    const textBox = (el: Element): Box => {
      const range = document.createRange();
      range.selectNodeContents(el);
      const r = range.getBoundingClientRect();
      return { left: r.left, right: r.right, top: r.top, bottom: r.bottom, width: r.width, height: r.height };
    };
    const cells = [...document.querySelectorAll<HTMLElement>('.rd-cell')].map((cell) => {
      const slot = cell.closest('.slot') as HTMLElement;
      const tile = slot.querySelector(':scope > .tile, :scope > .tile-btn') as HTMLElement;
      const n = cell.querySelector('.rd-n') as HTMLElement;
      const track = cell.querySelector('.rd-bar') as HTMLElement;
      const fill = cell.querySelector('.rd-fill') as HTMLElement;
      return {
        label: cell.getAttribute('aria-label') ?? '',
        strong: cell.classList.contains('is-strong'),
        cell: box(cell),
        tile: box(tile),
        number: textBox(n),
        barFill: fill.getBoundingClientRect().width,
        barTrack: track.getBoundingClientRect().width,
        numberColor: getComputedStyle(n).color,
        fontFamily: getComputedStyle(n).fontFamily,
      };
    });
    const center = document.querySelector('.table .center') as HTMLElement;
    const chips = [...document.querySelectorAll<HTMLElement>('.rd-tp')].map((chip) => {
      const word = chip.querySelector('.rd-tp-w') as HTMLElement;
      const style = getComputedStyle(chip);
      const line = Number.parseFloat(style.lineHeight) || Number.parseFloat(style.fontSize) * 1.2;
      return {
        position: (chip.closest('.score') as HTMLElement).className.replace('score ', ''),
        box: box(chip),
        label: chip.getAttribute('aria-label') ?? '',
        text: chip.textContent ?? '',
        wordShown: getComputedStyle(word).display !== 'none',
        color: style.color,
        scrollWidth: chip.scrollWidth,
        clientWidth: chip.clientWidth,
        lineCount: Math.round(chip.getBoundingClientRect().height / line),
      };
    });
    const shown = (el: Element) => (el as HTMLElement).checkVisibility();
    const others = [...center.querySelectorAll<HTMLElement>('.score > *, :scope > .info, :scope > .round-s, :scope > .dora')]
      .filter((el) => shown(el) && el.getBoundingClientRect().width > 0)
      .map((el) => ({
        name: el.className,
        box: box(el),
        seat: el.closest('.score') === null ? null : (el.closest('.score') as HTMLElement).className.replace('score ', ''),
      }));
    const lineEl = document.querySelector<HTMLElement>('.board-tools .rd-line');
    const tools = document.querySelector('.board-tools');
    return {
      cells,
      chips,
      line:
        lineEl === null || tools === null
          ? null
          : {
              box: box(lineEl),
              scrollWidth: lineEl.scrollWidth,
              clientWidth: lineEl.clientWidth,
              text: lineEl.textContent ?? '',
              tools: box(tools),
              neighbors: [...tools.children].filter((child) => child !== lineEl).map(box),
            },
      marks: [...document.querySelectorAll<HTMLElement>('.hand .mk')].map(box),
      center: box(center),
      centerInner: center.clientWidth - Number.parseFloat(getComputedStyle(center).paddingLeft) - Number.parseFloat(getComputedStyle(center).paddingRight),
      centerBackground: getComputedStyle(center).backgroundColor,
      others,
      handWrap: document.querySelector('.hand-wrap') === null ? null : box(document.querySelector('.hand-wrap') as Element),
      table: document.querySelector('.table') === null ? null : box(document.querySelector('.table') as Element),
      document: {
        scrollHeight: document.documentElement.scrollHeight,
        scrollWidth: document.documentElement.scrollWidth,
        clientWidth: document.documentElement.clientWidth,
        innerHeight: window.innerHeight,
        innerWidth: window.innerWidth,
      },
    };
  });
}

const overlaps = (a: BoxRect, b: BoxRect, slack = 0.5) => a.left < b.right - slack && b.left < a.right - slack && a.top < b.bottom - slack && b.top < a.bottom - slack;
const rgb = (css: string) => {
  const value = parseCssColor(css);
  return { r: value.r, g: value.g, b: value.b };
};

/** 手牌の下の数と、他家の席の札が、決まりどおりに収まっている。 */
function expectReadsFit(layout: ReadsLayout, where: string, options: { expectChips?: boolean } = {}): void {
  expect(layout.cells.length, `${where} 数がある`).toBeGreaterThan(0);
  for (const item of layout.cells) {
    const at = `${where} ${item.label}`;
    // 自分の牌の真下: 牌と同じ列（幅）に収まり、牌の下から始まる
    expect(Math.abs(item.cell.left - item.tile.left), `${at} 左`).toBeLessThanOrEqual(1);
    expect(Math.abs(item.cell.width - item.tile.width), `${at} 幅`).toBeLessThanOrEqual(1);
    expect(item.cell.top, `${at} 牌の下`).toBeGreaterThanOrEqual(item.tile.bottom - 1);
    expect(item.cell.height, `${at} 高さ`).toBeGreaterThan(20);
    // 数の文字そのものが、自分の牌の列から出ない
    expect(item.number.left, `${at} 数の左`).toBeGreaterThanOrEqual(item.tile.left - 0.5);
    expect(item.number.right, `${at} 数の右`).toBeLessThanOrEqual(item.tile.right + 0.5);
    // 帯は、確率 25% で全幅（地の幅に収まる）
    expect(item.barFill, `${at} 帯`).toBeLessThanOrEqual(item.barTrack + 0.5);
    expect(item.fontFamily, `${at} 数の字体`).toMatch(/mono/i);
    expect(item.cell.right, `${at} 窓の中`).toBeLessThanOrEqual(layout.document.innerWidth + 0.5);
    expect(item.cell.left, `${at} 窓の中`).toBeGreaterThanOrEqual(-0.5);
  }
  // 同じ段の隣どうしは、重ならない（数の文字も、ボタンも）
  const rows = new Map<number, CellMeasure[]>();
  for (const item of layout.cells) {
    const key = [...rows.keys()].find((top) => Math.abs(top - item.cell.top) < 2) ?? item.cell.top;
    rows.set(key, [...(rows.get(key) ?? []), item]);
  }
  for (const row of rows.values()) {
    row.sort((a, b) => a.cell.left - b.cell.left);
    for (let index = 1; index < row.length; index += 1) {
      const [a, b] = [row[index - 1] as CellMeasure, row[index] as CellMeasure];
      expect(a.cell.right, `${where} ボタンの重なり`).toBeLessThanOrEqual(b.cell.left + 0.5);
      expect(a.number.right, `${where} 数の重なり`).toBeLessThanOrEqual(b.number.left + 0.1);
    }
  }
  // 印（自分・実戦・AI）と重ならない
  for (const mark of layout.marks) for (const item of layout.cells) expect(overlaps(mark, item.cell), `${where} 印と数`).toBe(false);
  if (options.expectChips === false) return;
  // 箱の中身が 150px 未満なら卓の上の 1 行、それ以上なら席の札（どちらか片方だけ）
  if (layout.centerInner < 150) {
    expect(layout.chips, `${where} 箱 ${layout.centerInner}px は札なし`).toEqual([]);
    const line = layout.line;
    if (line === null) throw new Error(`${where} 箱 ${layout.centerInner}px に卓の上の行が無い`);
    expect(line.text, `${where} 行の文`).toMatch(/^聴牌下家\d+%·対面\d+%·上家(（リーチ）)?\d+%$/);
    // 切れず、折り返さず、窓の中で、隣（切り替え・盤面の見方）と重ならない
    expect(line.scrollWidth, `${where} 行のあふれ ${line.text}`).toBeLessThanOrEqual(line.clientWidth + 0.5);
    expect(line.box.height, `${where} 行の高さ`).toBeLessThanOrEqual(18.5);
    expect(line.box.left, `${where} 行の左`).toBeGreaterThanOrEqual(-0.5);
    expect(line.box.right, `${where} 行の右`).toBeLessThanOrEqual(layout.document.innerWidth + 0.5);
    for (const neighbor of line.neighbors) expect(overlaps(line.box, neighbor), `${where} 行と隣`).toBe(false);
    return;
  }
  expect(layout.line, `${where} 箱 ${layout.centerInner}px は行なし`).toBeNull();
  expect(layout.chips.map((chip) => chip.position).sort(), `${where} 札の席`).toEqual(['left', 'right', 'top']);
  for (const chip of layout.chips) {
    const at = `${where} 札 ${chip.position}`;
    expect(chip.text, `${at} 文字`).toMatch(/^聴牌 \d+%$/);
    expect(chip.wordShown, `${at} 聴牌の字`).toBe(true);
    expect(chip.label, `${at} 名前`).toMatch(/^聴牌 \d+%$/);
    // 中央の箱に収まり、折り返さず、ほかの文字と重ならない
    expect(chip.box.left, `${at} 箱の左`).toBeGreaterThanOrEqual(layout.center.left - 0.5);
    expect(chip.box.right, `${at} 箱の右`).toBeLessThanOrEqual(layout.center.right + 0.5);
    expect(chip.box.top, `${at} 箱の上`).toBeGreaterThanOrEqual(layout.center.top - 0.5);
    expect(chip.box.bottom, `${at} 箱の下`).toBeLessThanOrEqual(layout.center.bottom + 0.5);
    expect(chip.lineCount, `${at} 1 行`).toBe(1);
    expect(chip.scrollWidth, `${at} あふれ`).toBeLessThanOrEqual(chip.clientWidth + 0.5);
    const round = (b: Box) => [b.left, b.top, b.right, b.bottom].map((n) => Math.round(n * 10) / 10).join(',');
    for (const other of layout.others) {
      // 同じ席の風・点数・リーチの札と、局名・王牌の列と、ほかの席の札（ほかの席の風・点数は、もとの配置のままで、ここでは見ない）
      const mine = other.seat === chip.position;
      const chipOfOther = other.name.includes('rd-tp') && other.seat !== chip.position;
      const middle = other.seat === null;
      if (!mine && !chipOfOther && !middle) continue;
      if (other.name.includes('rd-tp') && other.seat === chip.position) continue;
      // 箱の角が触れる程度（札の文字の左右の余白の分）は、重なりに数えない
      const slack = chipOfOther ? 2.5 : 1;
      expect(overlaps(chip.box, other.box, slack), `${at} と ${other.name}（札 ${round(chip.box)} 相手 ${round(other.box)}）`).toBe(false);
    }
    expect(contrast(rgb(chip.color), rgb(layout.centerBackground)), `${at} の文字のコントラスト`).toBeGreaterThanOrEqual(4.5);
  }
}

async function expectBoardOk(page: Page, where: string): Promise<void> {
  const board = await measureBoard(page);
  expectNoHorizontalScroll(board, where);
  expect(board.centerContent.scrollWidth, `${where} 中央の箱の横あふれ`).toBeLessThanOrEqual(board.centerContent.width + 0.5);
  expect(board.centerContent.scrollHeight, `${where} 中央の箱の縦あふれ`).toBeLessThanOrEqual(board.centerContent.height + 0.5);
  expect(seriousViolations(await runAxe(page)), `${where} axe`).toEqual([]);
}

const toggle = (page: Page): Locator => page.getByRole('button', { name: '読み', exact: true });

// ---- 検査 ----

const SIZES = [
  [390, 844],
  [768, 1024],
  [1280, 800],
] as const;

describe('U-53・U-4〜U-6: 通して見る画面（上家がリーチ中に自分が打つ場面）で、読みが収まる', () => {
  for (const [width, height] of SIZES) {
    it(`${width}×${height}: ライト・ダークで、数は自分の牌の下に収まり、隣と重ならない。札は中央の箱に収まる。横スクロールなし・axe の重大 0`, { timeout: 300_000 }, async () => {
      for (const scheme of SCHEMES) {
        const { context, page, problems, external } = await open({ width, height, scheme });
        try {
          await openReplayAtRiichi(page);
          const where = `${width}×${height} ${scheme} 通して見る`;
          // 画面写真は、検査より先に撮る（検査が落ちたときも、見て確かめられるように）
          if (width === 1280 || (width === 390 && scheme === 'light') || (width === 768 && scheme === 'light')) {
            await shot(page, `replay-riichi-${width}-${scheme}`);
          }
          expect(await toggle(page).getAttribute('aria-pressed'), `${where} 入`).toBe('true');
          expectReadsFit(await measureReads(page), where);
          await expectBoardOk(page, where);
          expect(problems).toEqual([]);
          expect(external).toEqual([]);
        } finally {
          await context.close();
        }
      }
    });

    it(`${width}×${height}: 解き直しの答え合わせのあとにも、同じように収まる（印と数が重ならない）`, { timeout: 300_000 }, async () => {
      for (const scheme of SCHEMES) {
        const { context, page, problems } = await open({ width, height, scheme });
        try {
          await openReviewAndReveal(page);
          await page.locator('.rd-cell').first().waitFor();
          const where = `${width}×${height} ${scheme} 解き直し`;
          expect(await toggle(page).getAttribute('aria-pressed'), `${where} 入`).toBe('true');
          expectReadsFit(await measureReads(page), where);
          await expectBoardOk(page, where);
          if (width === 1280 && scheme === 'light') await shot(page, 'quiz-reveal-1280-light');
          if (width === 1280 && scheme === 'dark') await shot(page, 'quiz-reveal-1280-dark');
          if (width === 390 && scheme === 'light') await shot(page, 'quiz-reveal-390-light');
          expect(problems).toEqual([]);
        } finally {
          await context.close();
        }
      }
    });
  }
});

describe('U-39: 手牌の下の帯の取り方。好みが切の画面は変わらず、入の画面は入切で動かない。文書は窓の高さに収まる', () => {
  /** 卓・手牌・文書の大きさが、2 つの測りで同じ（0.5px まで）。 */
  function expectSameLayout(a: ReadsLayout, b: ReadsLayout, where: string): void {
    for (const key of ['top', 'left', 'width', 'height'] as const) {
      expect(Math.abs((a.table as Box)[key] - (b.table as Box)[key]), `${where} 卓の ${key}`).toBeLessThanOrEqual(0.5);
    }
    expect(Math.abs((a.handWrap as Box).top - (b.handWrap as Box).top), `${where} 手牌の上`).toBeLessThanOrEqual(0.5);
    expect(Math.abs((a.handWrap as Box).bottom - (b.handWrap as Box).bottom), `${where} 手牌の下`).toBeLessThanOrEqual(0.5);
    expect(a.document.scrollHeight, `${where} 文書の高さ`).toBe(b.document.scrollHeight);
    expect(Math.abs(a.center.width - b.center.width), `${where} 中央の箱`).toBeLessThanOrEqual(0.5);
  }

  const rootReads = (page: Page) => page.evaluate(() => document.querySelector('.rp, .qz')?.getAttribute('data-reads') ?? null);
  const slotPadding = (page: Page) => page.evaluate(() => getComputedStyle(document.querySelector('.hand .slot') as Element).paddingBottom);

  for (const [width, height] of [
    [1280, 800],
    [1440, 900],
    [1920, 1080],
  ] as const) {
    it(`${width}×${height}: 通して見る画面・解き直しで、好みが切なら帯を取らず（これまでと同じ）、入なら取る。入の画面は、切っても入れ直しても、卓も手牌も文書も動かず、文書は窓の高さに収まる`, { timeout: 300_000 }, async () => {
      for (const kind of ['replay', 'review'] as const) {
        const where = `${width}×${height} ${kind === 'replay' ? '通して見る' : '解き直し'}`;
        // 好みが入: 開いたときから帯を取っている
        const on = await open({ width, height, reads: { visible: true } });
        try {
          if (kind === 'replay') await openReplayAtRiichi(on.page);
          else {
            await openReviewAndReveal(on.page);
            await on.page.locator('.rd-cell').first().waitFor();
          }
          expect(await rootReads(on.page), `${where} 入`).toBe('on');
          expect(await slotPadding(on.page), `${where} 帯`).toBe('22px');
          const shown = await measureReads(on.page);
          expect(shown.document.scrollHeight, `${where} 文書は窓に収まる`).toBeLessThanOrEqual(shown.document.innerHeight);
          expect((shown.handWrap as Box).bottom, `${where} 手牌の下は窓の中`).toBeLessThanOrEqual(shown.document.innerHeight);
          // 切っても、画面を離れるまで取ったまま（卓も手牌も動かない）
          await toggle(on.page).click();
          await expect.poll(() => on.page.locator('.rd-cell').count()).toBe(0);
          expectSameLayout(shown, await measureReads(on.page), `${where} 切る`);
          await toggle(on.page).click();
          await on.page.locator('.rd-cell').first().waitFor();
          expectSameLayout(shown, await measureReads(on.page), `${where} 入れ直す`);
          expect(on.problems).toEqual([]);
        } finally {
          await on.context.close();
        }
        // 好みが切: 帯を取らない（これまでと同じ）。入にすると取る（卓が小さくなりうるが、文書は窓の高さに収まる）
        const off = await open({ width, height, reads: { visible: false } });
        try {
          if (kind === 'replay') {
            await off.page.getByRole('button', { name: 'この半荘を通して見る' }).click();
            await off.page.locator('.pbar').waitFor();
            for (let count = 0; count < RIICHI_STEP; count += 1) await off.page.keyboard.press('Period');
            await toggle(off.page).waitFor();
          } else {
            await openReviewAndReveal(off.page);
            await toggle(off.page).waitFor();
          }
          expect(await rootReads(off.page), `${where} 切`).toBeNull();
          expect(await slotPadding(off.page), `${where} 帯なし`).toBe('0px');
          const before = await measureReads(off.page);
          expect(before.document.scrollHeight, `${where} 切 文書は窓に収まる`).toBeLessThanOrEqual(before.document.innerHeight);
          await toggle(off.page).click();
          await off.page.locator('.rd-cell').first().waitFor();
          expect(await rootReads(off.page), `${where} 入にした`).toBe('on');
          const after = await measureReads(off.page);
          expect(after.document.scrollHeight, `${where} 入にしたあとも文書は窓に収まる`).toBeLessThanOrEqual(after.document.innerHeight);
          expect(off.problems).toEqual([]);
        } finally {
          await off.context.close();
        }
      }
    });
  }
});

describe('U-1・U-53: 答える前は、読みの切り替えも数も札も DOM に無く、読みのコマンドも呼ばない', () => {
  const COMMANDS = ['read_reads', 'get_reads_model', 'compute_reads', 'set_reads_visible'];
  const calls = (page: Page) => page.evaluate(() => (window as unknown as { __jrCalls: Array<{ cmd: string }> }).__jrCalls.map((call) => call.cmd));
  const traces = (page: Page) =>
    page.evaluate(() => ({
      ai: document.querySelectorAll('[data-ai]').length,
      html: /data-ai|data-mark|data-ring/.test(document.body.innerHTML),
      text: /\d\s*%|Mortal/.test(document.body.textContent ?? ''),
      reads: document.querySelectorAll('.rd-cell, .rd-tp, .rd-line, .rd-status, .reads-group, .pb-reads, #rdpop').length,
    }));

  it('解き直し（答える前）: 設定が入でも、何も無い。答えると出る', { timeout: 120_000 }, async () => {
    const { context, page } = await open({ width: 1280, height: 800 });
    try {
      await ensureSidebar(page);
      await page.getByRole('navigation', { name: 'メイン' }).getByRole('button', { name: /^解き直し/ }).click();
      await page.locator('.qz').waitFor();
      expect(await traces(page)).toEqual({ ai: 0, html: false, text: false, reads: 0 });
      expect(await toggle(page).count()).toBe(0);
      const names = await calls(page);
      for (const command of COMMANDS) expect(names, command).not.toContain(command);
      await page.locator('.hand .tile-btn').last().click();
      await page.getByLabel('理由（1行）').fill('x');
      expect(await traces(page)).toEqual({ ai: 0, html: false, text: false, reads: 0 });
      await page.getByRole('button', { name: '答え合わせ' }).click();
      await page.locator('#reveal-h').waitFor({ state: 'attached' });
      await page.locator('.rd-cell').first().waitFor();
      expect(await calls(page)).toContain('read_reads');
    } finally {
      await context.close();
    }
  });

  it('通して見る画面の答える場面: 設定が入でも、答えるまで、切り替え・数・札が無い。答えると出る', { timeout: 120_000 }, async () => {
    const { context, page } = await open({ width: 1280, height: 800 });
    try {
      await page.getByRole('button', { name: 'この半荘を通して見る' }).click();
      await page.locator('.pbar').waitFor();
      await page.getByRole('button', { name: /^次の悪手へ/ }).click();
      await page.locator('.qz[data-state="answering"]').waitFor();
      expect(await traces(page)).toEqual({ ai: 0, html: false, text: false, reads: 0 });
      expect(await toggle(page).count()).toBe(0);
      await page.locator('.hand .tile-btn').last().click();
      await page.getByLabel('理由（1行）').fill('x');
      await page.getByRole('button', { name: '答え合わせ' }).click();
      await page.locator('#reveal-h').waitFor({ state: 'attached' });
      await toggle(page).waitFor();
      expect(await toggle(page).getAttribute('aria-pressed')).toBe('true');
    } finally {
      await context.close();
    }
  });
});

describe('U-53: 数を押すと吹き出しが出る（牌の列の上。幅 390px では画面の下から）', () => {
  async function popoverBox(page: Page) {
    return page.evaluate(() => {
      const pop = document.querySelector<HTMLElement>('#rdpop');
      if (pop === null) return null;
      const r = pop.getBoundingClientRect();
      const tiles = [...document.querySelectorAll<HTMLElement>('.hand .slot > .tile, .hand .slot > .tile-btn')].map((el) => el.getBoundingClientRect());
      return {
        box: { left: r.left, right: r.right, top: r.top, bottom: r.bottom, width: r.width, height: r.height },
        sheet: pop.classList.contains('sheet'),
        tileTop: Math.min(...tiles.map((tile) => tile.top)),
        tileBottom: Math.max(...tiles.map((tile) => tile.bottom)),
        innerWidth: window.innerWidth,
        innerHeight: window.innerHeight,
        text: pop.textContent ?? '',
        scrollWidth: document.documentElement.scrollWidth,
      };
    });
  }

  for (const [width, height] of SIZES) {
    it(`${width}×${height}: 窓に収まり、手牌の牌にかからない（幅 390px は画面の下から）。Esc・外を押すと閉じる。axe の重大 0`, { timeout: 300_000 }, async () => {
      for (const scheme of SCHEMES) {
        const { context, page, problems } = await open({ width, height, scheme });
        try {
          await openReplayAtRiichi(page);
          const cell = page.locator('.rd-cell').nth(1);
          await cell.click();
          await page.locator('#rdpop').waitFor();
          const where = `${width}×${height} ${scheme}`;
          const measured = (await popoverBox(page)) as NonNullable<Awaited<ReturnType<typeof popoverBox>>>;
          expect(measured.text, where).toContain('だれかが待っている確率');
          expect(measured.text, where).toContain('上家（リーチ）');
          expect(measured.box.left, `${where} 左`).toBeGreaterThanOrEqual(-0.5);
          expect(measured.box.right, `${where} 右`).toBeLessThanOrEqual(measured.innerWidth + 0.5);
          expect(measured.box.top, `${where} 上`).toBeGreaterThanOrEqual(-0.5);
          expect(measured.box.bottom, `${where} 下`).toBeLessThanOrEqual(measured.innerHeight + 0.5);
          expect(measured.scrollWidth, `${where} 横スクロール`).toBeLessThanOrEqual(measured.innerWidth);
          if (width < 640) {
            expect(measured.sheet, `${where} 画面の下から`).toBe(true);
            expect(Math.abs(measured.box.bottom - measured.innerHeight), `${where} 下端`).toBeLessThanOrEqual(1);
          } else {
            expect(measured.sheet, `${where} 横に置く`).toBe(false);
            expect(measured.box.bottom, `${where} 牌の列の上`).toBeLessThanOrEqual(measured.tileTop + 0.5);
          }
          expect(seriousViolations(await runAxe(page)), `${where} axe`).toEqual([]);
          if (scheme === 'light') await shot(page, `replay-popover-${width}-${scheme}`);
          if (scheme === 'dark' && width === 1280) await shot(page, `replay-popover-${width}-${scheme}`);
          // Esc で閉じて、押した数へ戻る
          await page.keyboard.press('Escape');
          await page.locator('#rdpop').waitFor({ state: 'detached' });
          expect(await cell.evaluate((el) => el === document.activeElement), `${where} 位置が戻る`).toBe(true);
          // 外を押すと閉じる
          await cell.click();
          await page.locator('#rdpop').waitFor();
          await page.getByRole('heading', { level: 1 }).click({ position: { x: 4, y: 4 } });
          await page.locator('#rdpop').waitFor({ state: 'detached' });
          expect(problems).toEqual([]);
        } finally {
          await context.close();
        }
      }
    });
  }

  it('Tab で数に届き、矢印キーで動き、Enter で開いて Esc で閉じる。Tab の止まり場所は数の組で 1 つ。キーボードだけで、すべての操作に届く', { timeout: 120_000 }, async () => {
    const { context, page } = await open({ width: 1280, height: 800 });
    try {
      await openReplayAtRiichi(page);
      const reach = await unreachableByTab(page, { roving: '.rd-cell, .hand .tile-btn' });
      expect(reach.missed).toEqual([]);
      expect(await page.locator('.rd-cell[tabindex="0"]').count()).toBe(1);
      await page.locator('.rd-cell[tabindex="0"]').focus();
      await page.keyboard.press('ArrowRight');
      expect(await page.evaluate(() => document.activeElement?.classList.contains('rd-cell'))).toBe(true);
      await page.keyboard.press('Enter');
      await page.locator('#rdpop').waitFor();
      await page.keyboard.press('Escape');
      await page.locator('#rdpop').waitFor({ state: 'detached' });
      expect(await page.evaluate(() => document.activeElement?.classList.contains('rd-cell'))).toBe(true);
    } finally {
      await context.close();
    }
  });
});

describe('U-53: 用意の様子（画面写真つき）', () => {
  it('モデルが入っていない: 案内と「設定を開く」。右の欄の上に出て、卓も手牌の帯も動かない', { timeout: 120_000 }, async () => {
    const { context, page, problems } = await open({ width: 1280, height: 800, reads: { reads: null, installed: false } });
    try {
      await page.getByRole('button', { name: 'この半荘を通して見る' }).click();
      await page.locator('.pbar').waitFor();
      for (let count = 0; count < RIICHI_STEP; count += 1) await page.keyboard.press('Period');
      const note = page.getByText('読みのモデルが入っていません。');
      await note.waitFor();
      expect(await page.getByRole('button', { name: '設定を開く' }).count()).toBe(1);
      expect(await page.locator('.rd-cell').count()).toBe(0);
      const layout = await measureReads(page);
      expect(layout.document.scrollHeight).toBeLessThanOrEqual(layout.document.innerHeight);
      expect(seriousViolations(await runAxe(page))).toEqual([]);
      await shot(page, 'replay-no-model-1280-light');
      expect(problems).toEqual([]);
    } finally {
      await context.close();
    }
  });

  it('計算している間: 「読みを計算しています… 64/117」。終わると数が出る', { timeout: 120_000 }, async () => {
    const { context, page, problems } = await open({ width: 1280, height: 800, reads: { reads: null } });
    try {
      await page.getByRole('button', { name: 'この半荘を通して見る' }).click();
      await page.locator('.pbar').waitFor();
      for (let count = 0; count < RIICHI_STEP; count += 1) await page.keyboard.press('Period');
      await page.getByText(/読みを計算しています/).waitFor();
      await page.evaluate((id) => (window as unknown as { __jrEmit: (event: string, payload: unknown) => void }).__jrEmit('reads-progress', { session_id: id, done: 64, total: 117 }), FX4_ID);
      await page.getByText('読みを計算しています… 64/117').waitFor();
      expect(await page.locator('.rd-cell').count()).toBe(0);
      expect(seriousViolations(await runAxe(page))).toEqual([]);
      await shot(page, 'replay-computing-1280-light');
      await page.evaluate((text) => (window as unknown as { __jrReads: { release: (text: string) => void } }).__jrReads.release(text), REAL_READS);
      await page.locator('.rd-cell').first().waitFor();
      expect(await page.getByText(/読みを計算しています/).count()).toBe(0);
      expect(problems).toEqual([]);
    } finally {
      await context.close();
    }
  });
});

describe('U-53: 中央の箱の大きさで、聴牌の確率の置き場所が替わる', () => {
  it('箱の中身が 150px 以上なら席の札、未満なら卓の上の 1 行（両方を見る）。窓を変えると替わる', { timeout: 300_000 }, async () => {
    const seen = new Set<string>();
    const cases: Array<{ where: string; width: number; height: number; reveal: boolean }> = [
      { where: '通して見る 390', width: 390, height: 844, reveal: false },
      { where: '通して見る 1280', width: 1280, height: 800, reveal: false },
      { where: '通して見る 1920', width: 1920, height: 1080, reveal: false },
      { where: '解き直し 1280', width: 1280, height: 800, reveal: true },
      { where: '解き直し 1920', width: 1920, height: 1080, reveal: true },
    ];
    for (const { where, width, height, reveal } of cases) {
      const { context, page } = await open({ width, height });
      try {
        if (reveal) {
          await openReviewAndReveal(page);
          await page.locator('.rd-cell').first().waitFor();
        } else {
          await openReplayAtRiichi(page);
        }
        const layout = await measureReads(page);
        expectReadsFit(layout, where);
        seen.add(layout.centerInner < 150 ? 'line' : 'chips');
      } finally {
        await context.close();
      }
    }
    expect([...seen].sort()).toEqual(['chips', 'line']);
  });

  it('窓を小さくすると、札が卓の上の行に替わり、大きくすると戻る', { timeout: 120_000 }, async () => {
    const { context, page } = await open({ width: 1920, height: 1080 });
    try {
      await openReplayAtRiichi(page);
      await page.locator('.rd-tp').first().waitFor();
      await page.setViewportSize({ width: 1280, height: 800 });
      await page.locator('.board-tools .rd-line').waitFor();
      expect(await page.locator('.rd-tp').count()).toBe(0);
      await page.setViewportSize({ width: 1920, height: 1080 });
      await page.locator('.rd-tp').first().waitFor();
      expect(await page.locator('.rd-line').count()).toBe(0);
    } finally {
      await context.close();
    }
  });
});
