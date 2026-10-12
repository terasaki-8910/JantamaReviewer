// @vitest-environment node
/**
 * 実ブラウザで、設定の「記録の書き出し」（D-2、R11-14。U-4・U-5・U-6 も）を検査する。
 *
 * - U-4: 幅 390・768・1280px で、欄の各状態（ふだん・書き出したあと・読み込む前の確認・読み込んだあと・失敗）に横スクロールが出ない。
 *   確認のダイアログは窓の中に収まる
 * - U-5・U-6: axe の重大な違反が 0 件（色のコントラストを含む。ライトとダーク）。Tab で、設定のページのすべての操作に届く
 * - 確認: 開くと、キーボードの位置は「やめる」。Tab は 2 つのボタンの間だけを回る。Esc・背景の押下で閉じ、「読み込む」へ戻る。
 *   開いている間、裏の画面は操作できない（inert）
 * - 説明のアイコン: キーボードで選ぶと出て、窓の中に収まる
 * - 読み込んだあとは、画面を読み直し、設定のページに「読み込みました…」を出して、そこにキーボードの位置を移す
 * jsdom の試験（RecordsBlock.test.tsx・AppRecords.test.tsx）と同じふるまいを、実際の描画・キー・時計で確かめる。
 */
import type { Browser, BrowserContext, Page } from 'playwright-core';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import {
  TINY_PNG,
  ensureSidebar,
  launchBrowser,
  measureInfoTip,
  runAxe,
  seriousViolations,
  startPageServer,
  tauriMockScript,
  unreachableByTab,
  waitForMainReady,
  type PageServer,
  type RecordsScenario,
  type Scenario,
} from './harness';

const SCHEMES = ['light', 'dark'] as const;
type Scheme = (typeof SCHEMES)[number];

const NOW = new Date(2026, 9, 12, 22, 0, 0);
const DEFAULT_NAME = 'jantama-records-20261012.json';
const PICKED = 'C:\\Users\\someone\\Documents\\jantama-records-20261009.json';
const CONFIRM_SENTENCE = 'いまの記録を、このファイルの内容に置き換えます（半荘 12・答え 84）。元には戻せません。';

const settings = {
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

const baseState = { status: 'idle', session_id: null, mark_count: 0, ratings: [], next_hand: 1, can_undo: false, error: null };

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

/** 設定のページを開く（細い窓では、引き出しを開いてから「設定」を押す）。 */
async function open(
  records: RecordsScenario,
  options: { width?: number; height?: number; scheme?: Scheme } = {},
): Promise<Opened> {
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
  const scenario: Scenario = {
    label: 'main',
    state: baseState,
    settings,
    inputStatus: null,
    sessions: [],
    thumb: TINY_PNG,
    records,
  };
  await page.clock.setFixedTime(NOW);
  await page.addInitScript(tauriMockScript(scenario));
  await page.goto(new URL('index.html', server.url).toString());
  await waitForMainReady(page);
  await ensureSidebar(page);
  await page.getByRole('button', { name: '設定' }).click();
  await page.getByRole('heading', { level: 1, name: '設定' }).waitFor();
  await page.getByRole('group', { name: '記録の書き出し' }).waitFor();
  return { context, page, problems, external };
}

const block = (page: Page) => page.getByRole('group', { name: '記録の書き出し' });

/** 読み込む前の確認を開く。 */
async function openConfirm(page: Page): Promise<void> {
  await block(page).getByRole('button', { name: '読み込む' }).click();
  await page.getByRole('alertdialog').waitFor();
}

// ---- 各状態: 横スクロール・axe・テーマ ----

interface StateDef {
  name: string;
  records: RecordsScenario;
  run: (page: Page) => Promise<void>;
  /** 状態が出ていることの確かめ。 */
  expectText: string;
}

const STATES: StateDef[] = [
  {
    name: 'ふだん（大きさが出ている）',
    records: { overview: { sessions: 12, answers: 84, bytes: 420_000 } },
    run: async (page) => {
      await block(page).getByText('約 410 KB').waitFor();
    },
    expectText: `${DEFAULT_NAME}（1つ・約 410 KB）`,
  },
  {
    name: '書き出したあと',
    records: { overview: { sessions: 12, answers: 84, bytes: 420_000 }, savePath: `C:\\Users\\someone\\Documents\\${DEFAULT_NAME}` },
    run: async (page) => {
      await block(page).getByRole('button', { name: '書き出す' }).click();
      await block(page).getByRole('status').waitFor();
    },
    expectText: `書き出しました。${DEFAULT_NAME}（約 410 KB）`,
  },
  {
    name: '読み込む前の確認（取っておく半荘あり）',
    records: { openPath: PICKED, inspect: { sessions: 12, answers: 84, held: 3 } },
    run: openConfirm,
    expectText: CONFIRM_SENTENCE,
  },
  {
    name: '読み込んだあと',
    records: { openPath: PICKED, inspect: { sessions: 12, answers: 84, held: 0 } },
    run: async (page) => {
      await openConfirm(page);
      await page.getByRole('button', { name: '置き換える' }).click();
      await block(page).getByRole('status').waitFor();
    },
    expectText: '読み込みました（半荘 12・答え 84）。スクショと Mortal の結果は、データの保存先にあるものを使います。',
  },
  {
    name: '読み込めなかった（ファイルが正しくない）',
    records: {
      openPath: PICKED,
      inspectError:
        'このファイルは、新しい版のアプリで書き出されています（ファイルの版 2。このアプリは 1 まで）。アプリを新しくしてください。いまの記録は変わっていません。',
    },
    run: async (page) => {
      await block(page).getByRole('button', { name: '読み込む' }).click();
      await block(page).getByRole('alert').waitFor();
    },
    expectText: 'アプリを新しくしてください',
  },
];

describe('U-4・U-5・U-6: 記録の書き出しの各状態の、幅・アクセシビリティ・テーマ', () => {
  for (const state of STATES) {
    it(`${state.name}: 幅 390・768・1280px で横スクロールが出ない。axe の重大な違反が 0 件（ライト・ダーク）`, { timeout: 240_000 }, async () => {
      for (const width of [390, 768, 1280]) {
        for (const scheme of SCHEMES) {
          const { context, page, problems, external } = await open(state.records, { width, scheme });
          try {
            await state.run(page);
            const where = `${state.name} @${width} ${scheme}`;
            const f = await page.evaluate(() => {
              const group = document.querySelector<HTMLElement>('[role="group"][aria-labelledby="export-lbl"]');
              const dialog = document.querySelector<HTMLElement>('[role="alertdialog"]');
              const box = dialog?.getBoundingClientRect();
              return {
                scroll: document.documentElement.scrollWidth,
                client: document.documentElement.clientWidth,
                body: document.body.scrollWidth,
                group: group === null ? null : { scroll: group.scrollWidth, client: group.clientWidth },
                text: (dialog ?? group)?.textContent?.replace(/\s+/g, ' ') ?? '',
                dialog:
                  box === undefined
                    ? null
                    : { left: box.left, right: box.right, top: box.top, bottom: box.bottom, w: window.innerWidth, h: window.innerHeight },
              };
            });
            expect(f.scroll, where).toBeLessThanOrEqual(f.client);
            expect(f.body, `${where} body`).toBeLessThanOrEqual(f.client);
            if (f.group !== null) expect(f.group.scroll, `${where} 欄がはみ出す`).toBeLessThanOrEqual(f.group.client + 1);
            expect(f.text, where).toContain(state.expectText);
            if (f.dialog !== null) {
              expect(f.dialog.left, `${where} 確認が窓の左に収まる`).toBeGreaterThanOrEqual(0);
              expect(f.dialog.right, `${where} 確認が窓の右に収まる`).toBeLessThanOrEqual(f.dialog.w);
              expect(f.dialog.top, where).toBeGreaterThanOrEqual(0);
              expect(f.dialog.bottom, where).toBeLessThanOrEqual(f.dialog.h);
            }
            const axe = await runAxe(page);
            expect(seriousViolations(axe), where).toEqual([]);
            expect(axe.passes.find((p) => p.id === 'color-contrast')?.nodes ?? 0, `${where} コントラストの対象`).toBeGreaterThan(3);
            expect(problems, where).toEqual([]);
            expect(external, where).toEqual([]);
          } finally {
            await context.close();
          }
        }
      }
    });
  }
});

// ---- キーボード ----

describe('U-5: 記録の書き出しの、キーボードの操作', () => {
  it('Tab で、設定のページのすべての操作（記録の書き出しの 2 つのボタンと説明のアイコンを含む）に届く（幅 390・1280）', { timeout: 120_000 }, async () => {
    for (const width of [390, 1280]) {
      const { context, page } = await open({}, { width });
      try {
        const reach = await unreachableByTab(page);
        expect(reach.missed, `@${width}`).toEqual([]);
        expect(reach.total, `@${width}`).toBeGreaterThan(8);
      } finally {
        await context.close();
      }
    }
  });

  it('確認: 開くと「やめる」にキーボードの位置。Tab・Shift+Tab は 2 つのボタンの間だけを回る。裏の画面は操作できない', { timeout: 120_000 }, async () => {
    const { context, page } = await open({ openPath: PICKED });
    try {
      // キーボードだけで開く: 「読み込む」へ Tab で行き、Enter
      await block(page).getByRole('button', { name: '書き出す' }).focus();
      await page.keyboard.press('Tab');
      expect(await page.evaluate(() => document.activeElement?.textContent)).toBe('読み込む');
      await page.keyboard.press('Enter');
      const dialog = page.getByRole('alertdialog', { name: 'このファイルの記録を読み込みますか' });
      await dialog.waitFor();
      const active = () => page.evaluate(() => document.activeElement?.textContent ?? '');
      expect(await active()).toBe('やめる');
      expect(await page.evaluate(() => document.querySelector('.app')?.hasAttribute('inert'))).toBe(true);
      expect(await page.evaluate(() => document.querySelector('[role="alertdialog"]')?.closest('.app') === null)).toBe(true);
      const seen: string[] = [];
      for (let i = 0; i < 4; i += 1) {
        await page.keyboard.press('Tab');
        seen.push(await active());
      }
      expect(seen).toEqual(['置き換える', 'やめる', '置き換える', 'やめる']);
      await page.keyboard.press('Shift+Tab');
      expect(await active()).toBe('置き換える');
      // 裏の画面は、マウスでも動かない
      await expect(block(page).getByRole('button', { name: '書き出す' }).click({ timeout: 800 })).rejects.toThrow();
    } finally {
      await context.close();
    }
  });

  it('確認: Esc で何もせずに閉じ、「読み込む」にキーボードの位置が戻る。背景を押しても閉じる。どちらも、何も置き換えない', { timeout: 120_000 }, async () => {
    const { context, page } = await open({ openPath: PICKED });
    try {
      await openConfirm(page);
      await page.keyboard.press('Escape');
      await page.getByRole('alertdialog').waitFor({ state: 'detached' });
      expect(await page.evaluate(() => document.activeElement?.textContent)).toBe('読み込む');
      expect(await page.evaluate(() => document.querySelector('.app')?.hasAttribute('inert'))).toBe(false);
      await expect(block(page).getByRole('status').count()).resolves.toBe(0);

      await openConfirm(page);
      await page.mouse.click(8, 8);
      await page.getByRole('alertdialog').waitFor({ state: 'detached' });
      expect(await page.evaluate(() => document.activeElement?.textContent)).toBe('読み込む');
      await expect(block(page).getByRole('status').count()).resolves.toBe(0);
    } finally {
      await context.close();
    }
  });

  it('読み込んだあと: 画面が読み直され、設定のページに「読み込みました…」が出て、そこにキーボードの位置がある。ほかの画面から戻ると出ていない', { timeout: 120_000 }, async () => {
    const { context, page } = await open({ openPath: PICKED });
    try {
      await openConfirm(page);
      await page.getByRole('button', { name: '置き換える' }).click();
      const done = block(page).getByRole('status');
      await done.waitFor();
      await page.getByRole('heading', { level: 1, name: '設定' }).waitFor();
      expect(await page.evaluate(() => document.activeElement?.classList.contains('ex-msg'))).toBe(true);
      expect(await page.evaluate(() => document.querySelector('.app')?.hasAttribute('inert'))).toBe(false);
      await ensureSidebar(page);
      await page.getByRole('navigation', { name: 'メイン' }).getByRole('button', { name: 'ログ' }).click();
      await page.getByRole('heading', { level: 1, name: 'ログ' }).waitFor();
      await ensureSidebar(page);
      await page.getByRole('button', { name: '設定' }).click();
      await block(page).waitFor();
      await expect(block(page).getByRole('status').count()).resolves.toBe(0);
    } finally {
      await context.close();
    }
  });
});

// ---- 説明のアイコン ----

describe('R11-1: 記録の書き出しの説明は、説明のアイコン（InfoTip）に出す', () => {
  it('キーボードで選ぶと出て、窓の中に収まる（幅 390・1280）。本文には、説明の文を出さない', { timeout: 120_000 }, async () => {
    for (const width of [390, 1280]) {
      const { context, page } = await open({}, { width });
      try {
        const where = `@${width}`;
        expect(await block(page).evaluate((el) => el.textContent ?? '')).not.toContain('記録をまとめて 1 つのファイル');
        const icon = block(page).getByRole('button', { name: '記録の書き出しの説明' });
        // キーボードで届く（マウスの位置合わせではなく、Tab で）
        await block(page).getByRole('button', { name: '書き出す' }).focus();
        await page.keyboard.press('Shift+Tab');
        expect(await page.evaluate(() => document.activeElement?.getAttribute('aria-label')), where).toBe('記録の書き出しの説明');
        await page.locator('.infotip-pop:not([hidden])').waitFor();
        const m = await measureInfoTip(page, '[role="group"][aria-labelledby="export-lbl"] .setting-row');
        expect(m, where).not.toBeNull();
        expect(m?.text, where).toContain('記録をまとめて 1 つのファイル（JSON）に書き出します');
        expect(m?.tip.left, where).toBeGreaterThanOrEqual(0);
        expect(m?.tip.right, where).toBeLessThanOrEqual(m?.innerWidth ?? 0);
        expect(m?.tip.top, where).toBeGreaterThanOrEqual(0);
        await page.keyboard.press('Escape');
        await page.locator('.infotip-pop:not([hidden])').waitFor({ state: 'detached' });
        await expect(icon.count()).resolves.toBe(1);
      } finally {
        await context.close();
      }
    }
  });
});
