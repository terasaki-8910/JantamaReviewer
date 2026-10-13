// @vitest-environment node
/**
 * 実ブラウザで、設定の「同期」の欄（F15、D-4）を検査する。
 *
 * - 幅 390・768・1280px で、欄の各状態（未設定・保存済み・待機・同期中・つながらない・要確認・大量の消去を止めた・失敗・注意つき・確認）に
 *   横スクロールが出ない。確認のダイアログは窓の中に収まる
 * - axe の重大な違反が 0 件（色のコントラストを含む。ライトとダーク）。Tab で、設定のページのすべての操作に届く
 * - トークンの欄は、種類が password で、貼って保存すると空に戻り、ページのどこにもトークンの文字が残らない
 * - 確認: 開くと、キーボードの位置は「やめる」。Tab は 2 つのボタンの間だけ。Esc・背景の押下で閉じ、押したボタンに位置が戻る
 * - 説明のアイコン: キーボードで選ぶと出て、窓の中に収まる
 * jsdom の試験（SyncBlock.test.tsx）と同じふるまいを、実際の描画・キー・時計で確かめる。
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
  type Scenario,
  type SyncScenario,
} from './harness';

const SCHEMES = ['light', 'dark'] as const;
type Scheme = (typeof SCHEMES)[number];

const NOW = new Date(2026, 9, 13, 23, 0, 0);
const LAST_OK = new Date(2026, 9, 13, 22, 10, 0).getTime();
const HOST = 'jantama-test-org.aws-ap-northeast-1.turso.io';
const TOKEN = 'TOKEN-SENTINEL-8c1e5a77-do-not-leak';

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
  sync: SyncScenario,
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
    sync,
  };
  await page.clock.setFixedTime(NOW);
  await page.addInitScript(tauriMockScript(scenario));
  await page.goto(new URL('index.html', server.url).toString());
  await waitForMainReady(page);
  await ensureSidebar(page);
  await page.getByRole('button', { name: '設定' }).click();
  await page.getByRole('heading', { level: 1, name: '設定' }).waitFor();
  await page.getByRole('group', { name: '同期', exact: true }).waitFor();
  return { context, page, problems, external };
}

const block = (page: Page) => page.getByRole('group', { name: '同期', exact: true });

const READY = { url_host: HOST, has_token: true };
const RUNNING = { ...READY, enabled: true, state: 'idle' as const, last_ok_ms: LAST_OK };

// ---- 各状態: 横スクロール・axe・テーマ ----

interface StateDef {
  name: string;
  sync: SyncScenario;
  run: (page: Page) => Promise<void>;
  /** 状態が出ていることの確かめ。 */
  expectText: string;
}

const nothing = async () => undefined;

const STATES: StateDef[] = [
  { name: '未設定', sync: {}, run: nothing, expectText: 'まだ設定していません' },
  {
    name: '保存済み（まだ使っていない）',
    sync: { status: READY },
    run: nothing,
    expectText: '同期していません',
  },
  {
    name: '待機（最後の同期あり）',
    sync: { status: RUNNING },
    run: nothing,
    expectText: '最後の同期: 10月13日 22:10',
  },
  {
    name: '同期中',
    sync: { status: { ...RUNNING, state: 'syncing' } },
    run: nothing,
    expectText: '同期しています…',
  },
  {
    name: 'つながらない',
    sync: { status: { ...RUNNING, state: 'offline' } },
    run: nothing,
    expectText: '同期先につながりません。つながったときに、続きを同期します（最後の同期: 10月13日 22:10）',
  },
  {
    name: '要確認（トークンが通らない）',
    sync: {
      status: {
        ...RUNNING,
        state: 'attention',
        message: '同期先がトークンを受け付けません。トークンを貼り直してください（DB 用のトークンか、確かめてください）',
      },
    },
    run: nothing,
    expectText: '同期先がトークンを受け付けません',
  },
  {
    name: '要確認（大量の消去を止めた）',
    sync: {
      status: {
        ...RUNNING,
        state: 'attention',
        message: '手元の記録が 80 件のうち 70 件、無くなっています。ほかの端末の記録を消さないよう、同期を止めました。',
        can_allow_mass_delete: true,
      },
    },
    run: nothing,
    expectText: '同期を止めました',
  },
  {
    name: '失敗',
    sync: { status: { ...RUNNING, state: 'error', message: '手元の記録を扱えませんでした: 読めない記録があります' } },
    run: nothing,
    expectText: '手元の記録を扱えませんでした',
  },
  {
    name: '注意つき',
    sync: { status: { ...RUNNING, warnings: ['読めない記録があるので、同期を見送りました: 20261009-190953/memos.json'] } },
    run: nothing,
    expectText: '読めない記録があるので、同期を見送りました',
  },
  {
    name: '保存の失敗',
    sync: { saveError: '同期先は、Turso Cloud の DB（ホスト名が .turso.io で終わるもの）だけです' },
    run: async (page) => {
      await block(page).getByLabel('同期先の DB の URL').fill('libsql://example.com');
      await block(page).getByRole('button', { name: '接続を保存' }).click();
      await block(page).getByRole('alert').waitFor();
    },
    expectText: 'Turso Cloud の DB',
  },
  {
    name: '保存したあと',
    sync: {},
    run: async (page) => {
      await block(page).getByLabel('同期先の DB の URL').fill(`libsql://${HOST}`);
      await block(page).getByLabel('トークン').fill(TOKEN);
      await block(page).getByRole('button', { name: '接続を保存' }).click();
      await block(page).getByText('接続を保存しました').waitFor();
    },
    expectText: '接続を保存しました',
  },
  {
    name: '確認（作り直す）',
    sync: { status: RUNNING },
    run: async (page) => {
      await block(page).getByRole('button', { name: '同期用の DB を作り直す' }).click();
      await page.getByRole('alertdialog').waitFor();
    },
    expectText: '同期用の DB の中身を全部消して、この端末の記録から入れ直します',
  },
  {
    name: '確認（同期を切る）',
    sync: { status: RUNNING },
    run: async (page) => {
      await block(page).getByRole('button', { name: 'この端末の同期を切る' }).click();
      await page.getByRole('alertdialog').waitFor();
    },
    expectText: 'この端末に貼ったトークンと、同期用の作業ファイルを消します',
  },
];

describe('U-4・U-5・U-6: 同期の欄の各状態の、幅・アクセシビリティ・テーマ', () => {
  for (const state of STATES) {
    it(`${state.name}: 幅 390・768・1280px で横スクロールが出ない。axe の重大な違反が 0 件（ライト・ダーク）`, { timeout: 240_000 }, async () => {
      for (const width of [390, 768, 1280]) {
        for (const scheme of SCHEMES) {
          const { context, page, problems, external } = await open(state.sync, { width, scheme });
          try {
            await state.run(page);
            const where = `${state.name} @${width} ${scheme}`;
            const f = await page.evaluate(() => {
              const group = document.querySelector<HTMLElement>('[role="group"][aria-labelledby="sync-lbl"]');
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
            // 確認を開いている間は、裏の画面が調べの対象にならないので、対象の数は少ない
            expect(axe.passes.find((p) => p.id === 'color-contrast')?.nodes ?? 0, `${where} コントラストの対象`).toBeGreaterThan(
              f.dialog === null ? 3 : 1,
            );
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

// ---- トークン ----

describe('D-4: トークンの欄', () => {
  it('種類が password。貼って保存すると、欄が空に戻り、ページのどこにも（文章にも属性にも）トークンの文字が残らない', { timeout: 120_000 }, async () => {
    const { context, page } = await open({});
    try {
      const token = block(page).getByLabel('トークン');
      expect(await token.getAttribute('type')).toBe('password');
      await block(page).getByLabel('同期先の DB の URL').fill(`libsql://${HOST}`);
      await token.fill(TOKEN);
      expect(await token.inputValue()).toBe(TOKEN);
      await block(page).getByRole('button', { name: '接続を保存' }).click();
      await block(page).getByText('接続を保存しました').waitFor();
      expect(await token.inputValue()).toBe('');
      const html = await page.content();
      expect(html).not.toContain(TOKEN);
      expect(await page.evaluate(() => JSON.stringify(Array.from(document.querySelectorAll('input')).map((i) => i.value)))).not.toContain(TOKEN);
      // 保存済みの印と、ホスト名だけが出る
      await expect(block(page).getByText('この PC の保管庫に保存済み').count()).resolves.toBe(1);
      await expect(block(page).getByText(HOST, { exact: true }).count()).resolves.toBe(1);
      expect(await token.getAttribute('placeholder')).toBe('保存済み（貼り直すと置き換わります）');
      // 入力欄の自動入力・文字の検査は、切ってある
      expect(await token.getAttribute('autocomplete')).toBe('off');
      expect(await token.getAttribute('spellcheck')).toBe('false');
    } finally {
      await context.close();
    }
  });

  it('保存して、同期を使うにして、今すぐ同期すると、状態が 同期中 → 待機（最後の同期あり）と変わる', { timeout: 120_000 }, async () => {
    const { context, page } = await open({});
    try {
      await block(page).getByLabel('同期先の DB の URL').fill(`libsql://${HOST}`);
      await block(page).getByLabel('トークン').fill(TOKEN);
      await block(page).getByRole('button', { name: '接続を保存' }).click();
      await block(page).getByText('接続を保存しました').waitFor();
      const box = block(page).getByRole('checkbox', { name: 'この端末で同期する' });
      await box.check();
      await block(page).getByText('まだ同期していません').waitFor();
      await block(page).getByRole('button', { name: '今すぐ同期' }).click();
      await block(page).getByText('最後の同期: 10月13日 23:00').waitFor();
    } finally {
      await context.close();
    }
  });
});

// ---- キーボード ----

describe('U-5: 同期の欄の、キーボードの操作', () => {
  it('Tab で、設定のページのすべての操作（同期の欄の入力・選択・ボタン・説明のアイコンを含む）に届く（幅 390・1280）', { timeout: 120_000 }, async () => {
    for (const width of [390, 1280]) {
      const { context, page } = await open({ status: { ...RUNNING, can_allow_mass_delete: true, state: 'attention', message: 'x を止めました' } }, { width });
      try {
        const reach = await unreachableByTab(page);
        expect(reach.missed, `@${width}`).toEqual([]);
        expect(reach.total, `@${width}`).toBeGreaterThan(12);
      } finally {
        await context.close();
      }
    }
  });

  it('確認: 開くと「やめる」にキーボードの位置。Tab は 2 つのボタンの間だけ。Esc で閉じて、押したボタンに戻る。裏の画面は操作できない', { timeout: 120_000 }, async () => {
    const { context, page } = await open({ status: RUNNING });
    try {
      const open = block(page).getByRole('button', { name: '同期用の DB を作り直す' });
      await open.focus();
      await page.keyboard.press('Enter');
      const dialog = page.getByRole('alertdialog', { name: '同期用の DB を作り直しますか' });
      await dialog.waitFor();
      const active = () => page.evaluate(() => document.activeElement?.textContent ?? '');
      expect(await active()).toBe('やめる');
      expect(await page.evaluate(() => document.querySelector('.app')?.hasAttribute('inert'))).toBe(true);
      const seen: string[] = [];
      for (let i = 0; i < 4; i += 1) {
        await page.keyboard.press('Tab');
        seen.push(await active());
      }
      expect(seen).toEqual(['作り直す', 'やめる', '作り直す', 'やめる']);
      await expect(block(page).getByRole('button', { name: '今すぐ同期' }).click({ timeout: 800 })).rejects.toThrow();
      await page.keyboard.press('Escape');
      await page.getByRole('alertdialog').waitFor({ state: 'detached' });
      expect(await page.evaluate(() => document.activeElement?.textContent)).toBe('同期用の DB を作り直す');
      expect(await page.evaluate(() => document.querySelector('.app')?.hasAttribute('inert'))).toBe(false);
      // 背景を押しても閉じる
      await open.click();
      await page.getByRole('alertdialog').waitFor();
      await page.mouse.click(8, 8);
      await page.getByRole('alertdialog').waitFor({ state: 'detached' });
      expect(await page.evaluate(() => document.activeElement?.textContent)).toBe('同期用の DB を作り直す');
    } finally {
      await context.close();
    }
  });

  it('作り直すを選ぶと、確認が閉じて、状態が 同期中 → 待機 と変わる', { timeout: 120_000 }, async () => {
    const { context, page } = await open({ status: RUNNING });
    try {
      await block(page).getByRole('button', { name: '同期用の DB を作り直す' }).click();
      await page.getByRole('button', { name: '作り直す', exact: true }).click();
      await page.getByRole('alertdialog').waitFor({ state: 'detached' });
      await block(page).getByText('最後の同期: 10月13日 23:00').waitFor();
    } finally {
      await context.close();
    }
  });

  it('同期を切ると、状態が「同期していません」になり、トークンは未保存になる', { timeout: 120_000 }, async () => {
    const { context, page } = await open({ status: RUNNING });
    try {
      await block(page).getByRole('button', { name: 'この端末の同期を切る' }).click();
      await page.getByRole('button', { name: '同期を切る', exact: true }).click();
      await page.getByRole('alertdialog').waitFor({ state: 'detached' });
      await block(page).getByText('同期していません').waitFor();
      await expect(block(page).getByText('未保存', { exact: true }).count()).resolves.toBe(1);
      expect(await block(page).getByRole('checkbox', { name: 'この端末で同期する' }).isChecked()).toBe(false);
    } finally {
      await context.close();
    }
  });
});

// ---- 説明のアイコン ----

describe('R11-1: 同期の説明は、説明のアイコン（InfoTip）に出す', () => {
  it('キーボードで選ぶと出て、窓の中に収まる（幅 390・1280）。本文には、説明の文を出さない', { timeout: 120_000 }, async () => {
    for (const width of [390, 1280]) {
      const { context, page } = await open({}, { width });
      try {
        const where = `@${width}`;
        expect(await block(page).evaluate((el) => el.textContent ?? '')).not.toContain('つながったときに続きを同期します');
        await block(page).getByLabel('同期先の DB の URL').focus();
        await page.keyboard.press('Shift+Tab');
        expect(await page.evaluate(() => document.activeElement?.getAttribute('aria-label')), where).toBe('同期の説明');
        await page.locator('.infotip-pop:not([hidden])').waitFor();
        const m = await measureInfoTip(page, '[role="group"][aria-labelledby="sync-lbl"] .sync-fields');
        expect(m, where).not.toBeNull();
        expect(m?.text, where).toContain('Turso Cloud を通して同期します');
        expect(m?.tip.left, where).toBeGreaterThanOrEqual(0);
        expect(m?.tip.right, where).toBeLessThanOrEqual(m?.innerWidth ?? 0);
        expect(m?.tip.top, where).toBeGreaterThanOrEqual(0);
        await page.keyboard.press('Escape');
        await page.locator('.infotip-pop:not([hidden])').waitFor({ state: 'detached' });
      } finally {
        await context.close();
      }
    }
  });
});
