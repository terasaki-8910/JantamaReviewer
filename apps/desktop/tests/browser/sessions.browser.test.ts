// @vitest-environment node
/**
 * 実ブラウザで、半荘の一覧・検索と絞り込み・削除・戻る進む・取り消しを検査する（U-4〜U-12）。
 *
 * - U-4: 幅 390・768・1280px で、一覧の各状態（通常・絞り込み・選択・確認・通知・メニュー）に横スクロールが出ない
 * - U-5・U-6: axe の重大な違反が 0 件（色のコントラストを含む）。Tab ですべての操作に届く。ライトとダーク
 * - U-8: 行の「…」は、行の中身（迷い 128・秒つきの時刻）が変わっても、行の右上の同じ場所に出る。細い窓では、引き出しの中で同じ形
 * - U-9: 確認（裏は操作できない）・通知の 8 秒（偽の時計）と、マウスを乗せている間は消えないこと・Ctrl+Z
 * - U-10: ← → と Alt+← / Alt+→。マウスの戻る・進むでは動かない
 * - U-11: Ctrl+Z・Ctrl+Y が、文字を打つ欄の中では効かないこと
 * jsdom の試験（src/main/Sessions.test.tsx）と同じ振る舞いを、実際の描画・キー・時計で確かめる。
 */
import type { Browser, BrowserContext, Locator, Page } from 'playwright-core';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import { REPORT_TEXTS, folderName, local, type ReportKey } from '../fake-sessions';
import {
  TINY_PNG,
  launchBrowser,
  runAxe,
  seriousViolations,
  startPageServer,
  tauriMockScript,
  unreachableByTab,
  ensureSidebar,
  waitForMainReady,
  type PageServer,
  type Scenario,
} from './harness';

const SCHEMES = ['light', 'dark'] as const;
type Scheme = (typeof SCHEMES)[number];

/** 試験の「いま」: 2026 年 10 月 9 日 22:00。 */
const NOW = new Date(2026, 9, 9, 22, 0, 0);

interface Seed {
  at: number;
  marks: number;
  report?: ReportKey;
}

const SEEDS: Seed[] = [
  { at: local(2026, 10, 9, 19, 9), marks: 6, report: 'fx4' },
  { at: local(2026, 10, 8, 21, 40), marks: 3, report: 'fx1a' },
  { at: local(2026, 10, 8, 20, 55), marks: 0, report: 'fx1b' },
  { at: local(2026, 10, 7, 22, 10), marks: 2 },
  { at: local(2026, 10, 7, 21, 15), marks: 0, report: 'fx1c' },
  { at: local(2026, 10, 4, 20, 12), marks: 128, report: 'fx1d' },
  { at: local(2026, 10, 4, 19, 30), marks: 0 },
  { at: local(2026, 10, 2, 22, 48), marks: 0, report: 'fx1e' },
];

function sessionOf(seed: Seed) {
  const id = folderName(seed.at);
  return {
    id,
    started_ms: seed.at,
    mark_count: seed.marks,
    rating_count: 0,
    marks: [],
    ratings: [],
    events: [],
    report_path: seed.report ? `C:\\data\\games\\${id}\\report.json` : null,
    ocr: null,
    links: { marks: {}, ratings: {} },
    self_ratings: { kyokus: {} },
    maka: { kyokus: {} },
    memos: { marks: {}, extras: [] },
    resolved: { decisions: {} },
  };
}

const baseState = { status: 'idle', session_id: null, mark_count: 0, ratings: [], next_hand: 1, can_undo: false, error: null };
const settings = {
  trigger: { kind: 'mouse_x1' },
  orientation: 'vertical',
  widget_position: null,
  sound: true,
  capture_keywords: ['雀魂', 'Mahjong Soul'],
  data_dir: 'C:\\Users\\someone\\JantamaReviewerData',
};

function scenario(overrides: Partial<Scenario> = {}): Scenario {
  const sessions = SEEDS.map(sessionOf);
  const reports: Record<string, string> = {};
  SEEDS.forEach((seed, i) => {
    if (seed.report) reports[(sessions[i] as { id: string }).id] = REPORT_TEXTS[seed.report];
  });
  return { label: 'main', state: baseState, settings, inputStatus: null, sessions, reports, thumb: TINY_PNG, ...overrides };
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
  /** true なら、時計を偽物にする（時間を進めるまで、タイマーは動かない）。 */
  fakeClock?: boolean;
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
  if (options.fakeClock) await page.clock.install({ time: NOW });
  else await page.clock.setFixedTime(NOW);
  await page.addInitScript(tauriMockScript(options.scenario ?? scenario()));
  await page.goto(new URL('index.html', server.url).toString());
  await waitForMainReady(page);
  // 結果を取り込んだ半荘の段階の印が出そろうまで待つ。
  const imported = SEEDS.filter((s) => s.report).length;
  await page.waitForFunction(
    (n) => document.querySelectorAll('.session-scroll .grade:not(.ghost)').length >= n,
    imported,
  );
  return { context, page, problems, external };
}

/** 実ブラウザの状態が整うまで、短い間隔で確かめる（Playwright のテスト用の expect は入っていないので、vitest の poll を使う）。 */
const poll = <T>(fn: () => Promise<T>) => expect.poll(fn, { timeout: 5000, interval: 50 });
const isFocused = (locator: Locator) => locator.evaluate((el) => el === document.activeElement);
const toastText = (page: Page) =>
  page.evaluate(() => document.querySelector('.toast .toast-t')?.textContent ?? null);
const toastVisible = (page: Page) => page.evaluate(() => document.querySelector('.toast') !== null);

const list = (page: Page) => page.getByRole('navigation', { name: '半荘の一覧' });
const times = (page: Page) =>
  page.locator('.session-scroll .s-item .s-time').evaluateAll((els) => els.map((e) => e.textContent));
const calls = (page: Page, cmd?: string) =>
  page.evaluate(
    (name) =>
      (window as unknown as { __jrCalls: Array<{ cmd: string; args: unknown }> }).__jrCalls.filter(
        (c) => name === undefined || c.cmd === name,
      ),
    cmd,
  );
const toast = (page: Page) => page.locator('.toast');

async function noHorizontalScroll(page: Page) {
  return page.evaluate(() => ({
    scroll: document.documentElement.scrollWidth,
    client: document.documentElement.clientWidth,
    body: document.body.scrollWidth,
  }));
}

/** その場の状態へ進める。 */
const STATES: Record<string, (page: Page) => Promise<void>> = {
  default: async () => undefined,
  filtered: async (page) => {
    await page.getByRole('button', { name: /^段階/ }).click();
    await page.getByRole('menuitemradio', { name: /^A 以下/ }).click();
  },
  noMatch: async (page) => {
    await page.getByRole('searchbox').fill('zzzzz');
  },
  select: async (page) => {
    await list(page).getByRole('button', { name: '選択', exact: true }).click();
    await page.locator('.s-item .s-cb').nth(2).check();
    await page.locator('.s-item .s-cb').nth(4).check();
  },
  confirm: async (page) => {
    await list(page).getByRole('button', { name: '選択', exact: true }).click();
    await page.locator('.s-item .s-cb').nth(2).check();
    await page.locator('.s-item .s-cb').nth(4).check();
    await list(page).getByRole('button', { name: '削除', exact: true }).click();
    await page.getByRole('alertdialog').waitFor();
  },
  toast: async (page) => {
    await list(page).getByRole('button', { name: '選択', exact: true }).click();
    await page.locator('.s-item .s-cb').nth(2).check();
    await list(page).getByRole('button', { name: '削除', exact: true }).click();
    await page.getByRole('alertdialog').getByRole('button', { name: '削除' }).click();
    await toast(page).waitFor();
  },
  menu: async (page) => {
    const row = page.locator('.s-item').nth(3);
    await row.hover();
    await row.getByRole('button', { name: /のメニュー/ }).click();
    await page.getByRole('menu').waitFor();
  },
  stage: async (page) => {
    await page.getByRole('button', { name: /^段階/ }).click();
    await page.getByRole('menu').waitFor();
  },
};

describe('U-4・U-5・U-6: 一覧の各状態（実ブラウザ）', () => {
  for (const scheme of SCHEMES) {
    for (const width of [390, 768, 1280] as const) {
      for (const [name, drive] of Object.entries(STATES)) {
        it(`${name} 幅${width}px ${scheme}: 横スクロールが無く、重大な a11y 違反が無く、Tab で全部に届き、外へ通信しない`, async () => {
          const { context, page, problems, external } = await open({ width, scheme });
          try {
            // 細い窓（640px 未満）では、サイドバーは隠れている。一覧の状態は、引き出しを開いて作る（既定の状態は、閉じたまま）
            if (width < 640 && name !== 'default') await ensureSidebar(page);
            await drive(page);
            await page.waitForTimeout(100);

            const m = await noHorizontalScroll(page);
            expect(m.scroll, `scrollWidth ${m.scroll} > clientWidth ${m.client}`).toBeLessThanOrEqual(m.client);
            expect(m.body).toBeLessThanOrEqual(m.client);

            const axe = await runAxe(page);
            expect(seriousViolations(axe)).toEqual([]);
            // 色のコントラストの規則が実際に働いている（検査が空振りしていない）。取り込んだ半荘のページ（幅 768px では、表が縦に
            // 長くなる）が裏にあるとき、確認の説明の文だけは、axe が「背景を決められない」（incomplete）に入れる。裏の画面のサイドバーか
            // 表を隠すと、その文も数えられる。原因までは調べていない。確認の文字の色そのものは、トークンの試験（contrast.test.ts）が確かめている。
            // 確認の中の、題と 2 つのボタンの 3 つは、いつも数える。
            expect(axe.passes.find((p) => p.id === 'color-contrast')?.nodes ?? 0).toBeGreaterThanOrEqual(name === 'confirm' ? 3 : 4);
            if (name === 'confirm') {
              // axe が数えられない確認の説明の文は、描いた色を読んで、ここで直接コントラストを確かめる
              // （文字の色と、いちばん近い不透明な背景の色。AA の 4.5 以上）。
              const ratio = await page.evaluate(() => {
                const dialog = document.querySelector('[role="alertdialog"]');
                const describedBy = dialog?.getAttribute('aria-describedby');
                const desc = describedBy ? document.getElementById(describedBy) : null;
                if (!desc) return 0;
                const rgba = (css: string): [number, number, number, number] => {
                  const [r = 0, g = 0, b = 0, a = 1] = (css.match(/[\d.]+/g) ?? []).map(Number);
                  return [r, g, b, a];
                };
                let background: [number, number, number, number] | null = null;
                for (let el: Element | null = desc; el && !background; el = el.parentElement) {
                  const color = rgba(getComputedStyle(el).backgroundColor);
                  if (color[3] >= 1) background = color;
                }
                if (!background) return 0;
                const [fr, fg, fb, fa] = rgba(getComputedStyle(desc).color);
                const [br, bg, bb] = background;
                // 文字の色に透明度があれば、背景の上に重ねた色にする。
                const mix = (f: number, b: number) => f * fa + b * (1 - fa);
                const channel = (v: number) => {
                  const s = v / 255;
                  return s <= 0.04045 ? s / 12.92 : ((s + 0.055) / 1.055) ** 2.4;
                };
                const luminance = (r: number, g: number, b: number) =>
                  0.2126 * channel(r) + 0.7152 * channel(g) + 0.0722 * channel(b);
                const text = luminance(mix(fr, br), mix(fg, bg), mix(fb, bb));
                const back = luminance(br, bg, bb);
                return (Math.max(text, back) + 0.05) / (Math.min(text, back) + 0.05);
              });
              expect(ratio, '確認の説明の文のコントラスト').toBeGreaterThanOrEqual(4.5);
            }

            // 確認が開いている間は、裏が inert なので、Tab で行ける所は確認の中の 2 つだけ。
            const reach = await unreachableByTab(page);
            expect(reach.total).toBeGreaterThan(1);
            // 確認とメニューは、中だけに留まる（メニューは ↑ ↓ で動き、Tab で閉じる）ので、Tab で全部には届かない。
            if (!['confirm', 'menu', 'stage'].includes(name)) expect(reach.missed).toEqual([]);

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

describe('U-8: 行の「…」と、細い列', () => {
  it('「…」は、どの行でも、行の右上（上から 4px・右から 4px・28x28）の同じ場所。迷い 128・秒つきの時刻でも動かず、はみ出さない', async () => {
    const { context, page } = await open();
    try {
      const geometry = await page.evaluate(() =>
        Array.from(document.querySelectorAll('.session-scroll .s-item')).map((li) => {
          const more = li.querySelector('.row-more')?.getBoundingClientRect() as DOMRect;
          const row = li.getBoundingClientRect();
          return [
            Math.round((more.top - row.top) * 10) / 10,
            Math.round((row.right - more.right) * 10) / 10,
            Math.round(more.width),
            Math.round(more.height),
            Math.round(row.height),
          ];
        }),
      );
      expect(geometry).toHaveLength(8);
      for (const g of geometry) expect(g, JSON.stringify(g)).toEqual(geometry[0]);
      expect(geometry[0]?.slice(0, 4)).toEqual([4, 4, 28, 28]);

      // 迷いが 128 の行（6 番目）に、秒つきの長い時刻を入れても、「…」は動かず、行はあふれない。
      const long = await page.evaluate(() => {
        const li = document.querySelectorAll('.session-scroll .s-item')[5] as HTMLElement;
        (li.querySelector('.s-time') as HTMLElement).textContent = '20:12:59';
        const more = (li.querySelector('.row-more') as HTMLElement).getBoundingClientRect();
        const row = li.getBoundingClientRect();
        return { top: more.top - row.top, right: row.right - more.right, overflow: li.scrollWidth - li.clientWidth };
      });
      expect(long.top).toBe(4);
      expect(long.right).toBe(4);
      expect(long.overflow).toBeLessThanOrEqual(0);
      expect(await page.locator('.session-scroll .s-item').nth(5).textContent()).toContain('迷い128');

      // 見えるのは、マウスを乗せた行・キーボードの位置がある行だけ。そのとき、同じ場所の「迷い」の数は薄くなる。
      const opacity = (selector: string) => page.locator(selector).first().evaluate((e) => getComputedStyle(e).opacity);
      expect(await opacity('.s-item:nth-child(1) .row-more')).toBe('0');
      await page.locator('.session-scroll .s-item').nth(1).hover();
      await page.waitForTimeout(200);
      const hovered = page.locator('.session-scroll .s-item').nth(1);
      expect(await hovered.locator('.row-more').evaluate((e) => getComputedStyle(e).opacity)).toBe('1');
      expect(await hovered.locator('.s-doubt').evaluate((e) => getComputedStyle(e).opacity)).toBe('0');
    } finally {
      await context.close();
    }
  });

  it('幅 390px: サイドバーは隠れている。引き出しを開くと、全部の形の一覧（日付の見出し・検索・段階・選択・時刻・Rating・迷いの数）が出る（細い列ではない）', async () => {
    const { context, page } = await open({ width: 390 });
    try {
      // 閉じている間: 隠れていて、操作できない
      const side = page.locator('#sidebar');
      expect(await side.evaluate((el) => el.hasAttribute('inert'))).toBe(true);
      expect(await page.locator('.session-scroll .srow').first().isVisible()).toBe(false);
      await ensureSidebar(page);
      const box = await side.boundingBox();
      expect(box?.width).toBe(300);
      for (const shown of ['.filter', '.list-head', '.date-head', '.sessions .sec-title']) {
        expect(await page.locator(shown).first().isVisible(), shown).toBe(true);
      }
      const rows = page.locator('.session-scroll .srow');
      const first = await rows.first().boundingBox();
      expect(first?.width).toBeGreaterThan(200);
      // 時刻・段階の印・Rating・迷いの数が、見える（寄せて隠していない）
      for (const shown of ['.s-time', '.grade:not(.ghost)', '.s-rate', '.s-doubt']) {
        expect(await rows.first().locator(shown).first().isVisible(), shown).toBe(true);
      }
      expect(await rows.first().textContent()).toContain('19:09');
      expect(await rows.first().textContent()).toContain('93.0');
      // 取り込み前の行は、文字で「取り込み前」。細い列のための点線の印は無い
      expect(await page.locator('.session-scroll .s-pending').first().isVisible()).toBe(true);
      expect(await page.locator('.narrow-only').count()).toBe(0);
      // 「…」は、行に乗せる・位置を置くと出る
      await rows.nth(1).hover();
      await page.waitForTimeout(200);
      expect(await page.locator('.session-scroll .s-item').nth(1).locator('.row-more').evaluate((e) => getComputedStyle(e).opacity)).toBe('1');
    } finally {
      await context.close();
    }
  });

  it('幅 390px: 引き出しの中の行のメニュー（Menu キー）は、窓の中に収まり、Esc でその行の「…」にキーボードの位置が戻る（引き出しは開いたまま）', async () => {
    const { context, page } = await open({ width: 390 });
    try {
      await ensureSidebar(page);
      const menu = page.getByRole('menu');
      const rows = page.locator('.session-scroll .srow');
      // 真ん中あたりの行と、一覧のいちばん下の行。
      for (const index of [3, 7]) {
        const row = rows.nth(index);
        await row.focus();
        // 行を見える所へ動かすスクロールが、終わってから押す（メニューは、スクロールがあると閉じる）。
        await page.evaluate(() => new Promise((done) => requestAnimationFrame(() => requestAnimationFrame(done))));
        await page.keyboard.press('ContextMenu');
        await menu.waitFor();
        await poll(() => isFocused(menu.getByRole('menuitem', { name: '開く' }))).toBe(true);
        const menuBox = await menu.boundingBox();
        expect(menuBox, `メニュー ${index}`).not.toBeNull();
        if (menuBox === null) continue;
        // 窓の外へ出ない。左上の隅に出ない
        expect(menuBox.x, `行 ${index}`).toBeGreaterThanOrEqual(8);
        expect(menuBox.x + menuBox.width).toBeLessThanOrEqual(390);
        expect(menuBox.y).toBeGreaterThanOrEqual(8);
        expect(menuBox.y + menuBox.height).toBeLessThanOrEqual(844 - 8 + 1);
        // その行の「…」のそば（縦は、その行の高さのあたり）
        const moreBox = await page.locator('.session-scroll .s-item').nth(index).locator('.row-more').boundingBox();
        expect(moreBox).not.toBeNull();
        if (moreBox !== null) {
          expect(menuBox.y, `行 ${index}: 「…」より下へ離れない`).toBeLessThanOrEqual(moreBox.y + moreBox.height + 8);
          expect(menuBox.y + menuBox.height, `行 ${index}: 「…」より上へ離れない`).toBeGreaterThanOrEqual(moreBox.y - 8);
        }
        await page.keyboard.press('Escape');
        await menu.waitFor({ state: 'detached' });
        expect(
          await page.locator('.session-scroll .s-item').nth(index).locator('.row-more').evaluate((el) => el === document.activeElement),
          `行 ${index}: 閉じたあと、キーボードの位置が「…」に戻る`,
        ).toBe(true);
        expect(await page.locator('.app').getAttribute('data-drawer')).toBe('open');
      }
    } finally {
      await context.close();
    }
  });

  it('幅 390px: 本文の見出しで、卓の名前（玉の間・南）の途中では折り返さない', async () => {
    const { context, page } = await open({ width: 390 });
    try {
      // 卓の名前は、1 かたまり（途中で折り返されると、行ごとに別の矩形になる）。
      const tops = await page
        .locator('.head .title .nowrap')
        .evaluate((el) => Array.from(el.getClientRects()).map((r) => Math.round(r.top)));
      expect(new Set(tops).size).toBe(1);
    } finally {
      await context.close();
    }
  });
});

describe('U-9: 削除（実ブラウザ）', () => {
  it('確認が開いている間は、裏の画面（一覧・サイドバー）は押せない。Tab は確認の 2 つのボタンの間だけ。Esc で何もせずに閉じる', async () => {
    const { context, page } = await open();
    try {
      await STATES.confirm?.(page);
      const dialog = page.getByRole('alertdialog');
      await poll(() => isFocused(dialog.getByRole('button', { name: 'キャンセル' }))).toBe(true);
      expect(await page.evaluate(() => (document.querySelector('.app') as HTMLElement).inert)).toBe(true);
      // 裏の画面には、キーボードの位置を移せない（inert）。
      const moved = await page.evaluate(() => {
        const behind = document.querySelector('.stage-btn') as HTMLElement;
        behind.focus();
        return document.activeElement === behind;
      });
      expect(moved).toBe(false);
      await poll(() => isFocused(dialog.getByRole('button', { name: 'キャンセル' }))).toBe(true);
      const seen: Array<string | undefined> = [];
      for (let i = 0; i < 5; i += 1) {
        await page.keyboard.press('Tab');
        seen.push(await page.evaluate(() => document.activeElement?.textContent?.trim()));
      }
      expect(new Set(seen)).toEqual(new Set(['削除', 'キャンセル']));
      await page.keyboard.press('Escape');
      await dialog.waitFor({ state: 'detached' });
      expect(await calls(page, 'delete_sessions')).toHaveLength(0);
      expect(await page.evaluate(() => (document.querySelector('.app') as HTMLElement).inert)).toBe(false);
      expect(await times(page)).toHaveLength(8);
      // 背景の押下でも閉じる。
      await page.getByRole('button', { name: '削除', exact: true }).click();
      await dialog.waitFor();
      await page.mouse.click(1180, 700);
      await dialog.waitFor({ state: 'detached' });
      expect(await calls(page, 'delete_sessions')).toHaveLength(0);
    } finally {
      await context.close();
    }
  });

  it('確定すると消え、通知の「元に戻す」と Ctrl+Z で元の位置に戻る。Ctrl+Y でもう一度消える', async () => {
    const { context, page } = await open();
    try {
      const before = await times(page);
      await STATES.toast?.(page);
      await poll(() => toastText(page)).toBe('1件の半荘を削除しました');
      const afterDelete = await times(page);
      expect(afterDelete).toEqual(before.filter((_, i) => i !== 2));
      expect(await calls(page, 'delete_sessions')).toHaveLength(1);

      await toast(page).getByRole('button', { name: '元に戻す' }).click();
      await poll(() => toastText(page)).toBe('1件の半荘を元に戻しました');
      await poll(() => times(page)).toEqual(before);

      await page.keyboard.press('Control+y');
      await poll(() => toastText(page)).toBe('1件の半荘を削除しました');
      await poll(() => times(page)).toEqual(afterDelete);
      await page.keyboard.press('Control+z');
      await poll(() => toastText(page)).toBe('1件の半荘を元に戻しました');
      await poll(() => times(page)).toEqual(before);
    } finally {
      await context.close();
    }
  });

  it('通知は 8 秒で消える。消えたあとも、Ctrl+Z は効く（アプリを閉じるまで戻せる）', async () => {
    const { context, page } = await open({ fakeClock: true });
    try {
      const before = await times(page);
      await STATES.toast?.(page);
      expect(await toastVisible(page)).toBe(true);
      await page.clock.fastForward(7500);
      await poll(() => toastVisible(page)).toBe(true);
      await page.clock.fastForward(1000);
      await poll(() => toastVisible(page)).toBe(false);
      expect(await times(page)).toHaveLength(7);
      await page.keyboard.press('Control+z');
      await poll(() => toastText(page)).toBe('1件の半荘を元に戻しました');
      await poll(() => times(page)).toEqual(before);
      // 「元に戻しました」の通知は、短く（3.5 秒）消える。
      await page.clock.fastForward(4000);
      await poll(() => toastVisible(page)).toBe(false);
    } finally {
      await context.close();
    }
  });

  it('通知にマウスを乗せている間は消えない。離れたら、数秒で消える。キーボードの位置が中にある間も消えない', async () => {
    const { context, page } = await open({ fakeClock: true });
    try {
      await STATES.toast?.(page);
      await page.getByRole('button', { name: '元に戻す' }).hover();
      await page.clock.fastForward(30_000);
      expect(await toastVisible(page)).toBe(true);
      await page.mouse.move(700, 300);
      await page.clock.fastForward(3000);
      expect(await toastVisible(page)).toBe(true);
      await page.clock.fastForward(1500);
      await poll(() => toastVisible(page)).toBe(false);

      // もう一度消して、今度はキーボードの位置で止める。
      await page.keyboard.press('Control+z');
      await poll(() => toastText(page)).toBe('1件の半荘を元に戻しました');
      await page.keyboard.press('Control+y');
      await poll(() => toastText(page)).toBe('1件の半荘を削除しました');
      await page.getByRole('button', { name: '元に戻す' }).focus();
      await page.clock.fastForward(30_000);
      expect(await toastVisible(page)).toBe(true);
      await page.keyboard.press('Escape');
      await poll(() => toastVisible(page)).toBe(false);
    } finally {
      await context.close();
    }
  });

  it('幅 390px でも、通知は窓の中に収まる（サイドバーは隠れているので、左端から出る）。引き出しの中で消しても同じ', async () => {
    const { context, page } = await open({ width: 390 });
    try {
      await ensureSidebar(page);
      await page.locator('.session-scroll .srow').nth(2).focus();
      await page.keyboard.press('ContextMenu');
      await page.getByRole('menuitem', { name: '削除' }).click();
      await page.getByRole('alertdialog').getByRole('button', { name: '削除' }).click();
      await toast(page).waitFor();
      const box = await toast(page).boundingBox();
      expect(box).not.toBeNull();
      expect((box?.x ?? 0) + (box?.width ?? 0)).toBeLessThanOrEqual(390);
      expect(box?.x ?? -1).toBeGreaterThanOrEqual(0);
      expect(box?.x ?? 99).toBeLessThanOrEqual(16);
    } finally {
      await context.close();
    }
  });

  it('幅 380px（実機は縦のスクロール バーのぶん、390px の窓がこれだけ狭い）: 通知の文が 2 行になっても、1 文字だけ次の行へ落ちない', async () => {
    const { context, page } = await open({ width: 380 });
    try {
      await ensureSidebar(page);
      await page.locator('.session-scroll .srow').nth(2).focus();
      await page.keyboard.press('ContextMenu');
      await page.getByRole('menuitem', { name: '削除' }).click();
      await page.getByRole('alertdialog').getByRole('button', { name: '削除' }).click();
      await toast(page).waitFor();
      // 文の各行の幅（1 行目・2 行目）。1 行に収まれば 1 つ。
      const lineWidths = await page.locator('.toast .toast-t').evaluate((el) => {
        const range = document.createRange();
        range.selectNodeContents(el);
        const byTop = new Map<number, number>();
        for (const rect of Array.from(range.getClientRects())) {
          const top = Math.round(rect.top);
          byTop.set(top, (byTop.get(top) ?? 0) + rect.width);
        }
        return Array.from(byTop.entries())
          .sort((a, b) => a[0] - b[0])
          .map(([, width]) => width);
      });
      expect(lineWidths.length, JSON.stringify(lineWidths)).toBeLessThanOrEqual(2);
      if (lineWidths.length === 2) {
        expect(Math.min(...lineWidths), JSON.stringify(lineWidths)).toBeGreaterThan(Math.max(...lineWidths) * 0.4);
      }
    } finally {
      await context.close();
    }
  });

  it('文字を打つ欄（検索）の中の Ctrl+Z は、削除を戻さない', async () => {
    const { context, page } = await open();
    try {
      await STATES.toast?.(page);
      expect(await toastVisible(page)).toBe(true);
      await page.getByRole('searchbox').click();
      await page.keyboard.type('昨日');
      await page.keyboard.press('Control+z');
      expect(await calls(page, 'restore_sessions')).toHaveLength(0);
      await page.getByRole('button', { name: '解除' }).click();
      expect(await times(page)).toHaveLength(7);
      // 欄の外に出れば、効く。
      await page.getByRole('button', { name: '設定' }).focus();
      await page.keyboard.press('Control+z');
      await poll(() => times(page)).toHaveLength(8);
    } finally {
      await context.close();
    }
  });

  it('消せなかったときは、理由を通知に出し、一覧は変わらない', async () => {
    const { context, page } = await open({ scenario: scenario({ failDelete: 'フォルダを移せませんでした' }) });
    try {
      await list(page).getByRole('button', { name: '選択', exact: true }).click();
      await page.locator('.s-item .s-cb').nth(2).check();
      await list(page).getByRole('button', { name: '削除', exact: true }).click();
      await page.getByRole('alertdialog').getByRole('button', { name: '削除' }).click();
      await poll(() => toastText(page)).toBe('半荘の削除ができませんでした: フォルダを移せませんでした');
      expect(await times(page)).toHaveLength(8);
      expect(await toast(page).getByRole('button', { name: '元に戻す' }).count()).toBe(0);
    } finally {
      await context.close();
    }
  });
});

describe('U-10: 戻る・進む（実ブラウザ）', () => {
  it('← → と Alt+← / Alt+→ で行き来する。マウスの戻る・進むでは動かない', async () => {
    const { context, page } = await open();
    try {
      const back = page.getByRole('button', { name: '戻る' });
      const forward = page.getByRole('button', { name: '進む' });
      expect(await back.isDisabled()).toBe(true);
      expect(await forward.isDisabled()).toBe(true);
      await page.locator('.session-scroll [data-open]').nth(3).click();
      await page.getByRole('heading', { level: 1, name: /10月7日\(水\) 22:10/ }).waitFor();
      await page.getByRole('button', { name: '設定' }).click();
      await page.getByRole('heading', { level: 1, name: '設定' }).waitFor();
      expect(await back.isEnabled()).toBe(true);

      await page.keyboard.press('Alt+ArrowLeft');
      await page.getByRole('heading', { level: 1, name: /10月7日\(水\) 22:10/ }).waitFor();
      await page.keyboard.press('Alt+ArrowLeft');
      await page.getByRole('heading', { level: 1, name: /10月9日\(金\) 19:09/ }).waitFor();
      expect(await back.isDisabled()).toBe(true);
      await page.keyboard.press('Alt+ArrowRight');
      await page.getByRole('heading', { level: 1, name: /10月7日\(水\) 22:10/ }).waitFor();
      await forward.click();
      await page.getByRole('heading', { level: 1, name: '設定' }).waitFor();
      expect(await forward.isDisabled()).toBe(true);

      // マウスの戻る・進むのボタン（3・4）には、何も割り当てない。
      await page.evaluate(() => {
        for (const button of [3, 4]) {
          for (const type of ['mousedown', 'mouseup', 'auxclick']) {
            document.body.dispatchEvent(new MouseEvent(type, { button, bubbles: true, cancelable: true }));
          }
        }
      });
      await page.getByRole('heading', { level: 1, name: '設定' }).waitFor();
      expect(await forward.isDisabled()).toBe(true);
      expect(await back.isEnabled()).toBe(true);
    } finally {
      await context.close();
    }
  });

  it('矢印で行から行へ。→ で行の「…」、← で行へ戻る。Alt+← は、行にキーボードの位置があっても履歴として働く', async () => {
    const { context, page } = await open();
    try {
      const rows = page.locator('.session-scroll [data-open]');
      await rows.nth(0).focus();
      await page.keyboard.press('ArrowDown');
      await poll(() => isFocused(rows.nth(1))).toBe(true);
      await page.keyboard.press('ArrowRight');
      await poll(() => isFocused(page.locator('.session-scroll [data-more]').nth(1))).toBe(true);
      await page.keyboard.press('ArrowLeft');
      await poll(() => isFocused(rows.nth(1))).toBe(true);
      await page.keyboard.press('Enter');
      await page.getByRole('heading', { level: 1, name: /10月8日\(木\) 21:40/ }).waitFor();
      await page.keyboard.press('Alt+ArrowLeft');
      await page.getByRole('heading', { level: 1, name: /10月9日\(金\) 19:09/ }).waitFor();
      await poll(() => isFocused(rows.nth(1))).toBe(true);
    } finally {
      await context.close();
    }
  });
});

describe('U-12: 検索と絞り込み（実ブラウザ）', () => {
  it('日付・卓・段階で絞り込める。件数と「解除」。見えなくなった行の選択は外れる', async () => {
    const { context, page } = await open();
    try {
      const search = page.getByRole('searchbox');
      await search.fill('昨日');
      expect(await times(page)).toEqual(['21:40', '20:55']);
      expect(await page.locator('.fstat').textContent()).toContain('「昨日」 2件');
      await page.getByRole('button', { name: /^段階/ }).click();
      await page.getByRole('menuitemradio', { name: /^A 以下/ }).click();
      expect(await page.locator('.fstat').textContent()).toContain('A 以下 · 「昨日」 2件');
      await page.getByRole('button', { name: '解除' }).click();
      expect(await times(page)).toHaveLength(8);
      await poll(() => isFocused(search)).toBe(true);

      await search.fill('10月7日');
      expect(await times(page)).toEqual(['22:10', '21:15']);
      await search.fill('zzzzz');
      await list(page).getByText('一致する半荘がありません').waitFor();
      expect(await list(page).getByRole('button', { name: '選択', exact: true }).count()).toBe(0);
    } finally {
      await context.close();
    }
  });

  it('IME の変換中の Esc・↓ は、変換のもの（検索の語を消さない・行へ移らない）', async () => {
    const { context, page } = await open();
    try {
      const search = page.getByRole('searchbox');
      await search.fill('昨日');
      await search.evaluate((el) => {
        el.dispatchEvent(new CompositionEvent('compositionstart', { bubbles: true }));
        el.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', isComposing: true, bubbles: true, cancelable: true }));
      });
      expect(await search.inputValue()).toBe('昨日');
      await search.evaluate((el) => {
        el.dispatchEvent(new CompositionEvent('compositionend', { bubbles: true }));
      });
      await search.press('Escape');
      expect(await search.inputValue()).toBe('');
    } finally {
      await context.close();
    }
  });
});
