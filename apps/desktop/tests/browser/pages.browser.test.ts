// @vitest-environment node
/**
 * 実ブラウザで、作った画面を検査する（U-4・U-5・U-6、ウィジェットの大きさとボタンの大きさ）。
 *
 * - U-4: 幅 390・768・1280px で、検討画面の全ページに横スクロールが出ない
 * - U-5: axe-core の重大（serious・critical）な違反が 0 件。Tab キーだけですべての操作に届く
 * - U-6: ライトとダークの両方で、実際に描かれた文字のコントラストが WCAG AA（axe の color-contrast）
 * - ウィジェット: 縦 76x336・横 340x64 の窓にぴったり収まり、はみ出さず、ボタンは 40px 以上
 * - 通信: 画面を開いても、外のサイトへ一切リクエストしない（S-2 の実行時の確認）
 */
import type { Browser, BrowserContext, Page } from 'playwright-core';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import {
  TINY_PNG,
  launchBrowser,
  runAxe,
  seriousViolations,
  startPageServer,
  tauriMockScript,
  unreachableByTab,
  type PageServer,
  type Scenario,
} from './harness';

const SCHEMES = ['light', 'dark'] as const;
type Scheme = (typeof SCHEMES)[number];

const baseState = {
  status: 'recording',
  session_id: '20261009-161200',
  mark_count: 2,
  ratings: ['good', 'fair', 'good', 'good'],
  next_hand: 5,
  can_undo: true,
  error: null,
};

/** 設定ページに出す、ボタンの登録・テスト・補助プログラムの状態（既定: 補助プログラムは未設定）。 */
const inputStatus = {
  registering: false,
  probe_ms: null,
  hook: 'in_process',
  helper: { installed: false, running: false, busy: null, error: null },
  message: null,
};

const settings = {
  trigger: { kind: 'mouse_x1' },
  orientation: 'vertical',
  widget_position: null,
  sound: true,
  capture_keywords: ['雀魂', 'Mahjong Soul'],
  data_dir: 'C:\\Users\\someone\\JantamaReviewerData\\very\\long\\folder\\name\\for\\wrapping\\check',
};

const local = (y: number, mo: number, d: number, h: number, mi: number, s = 0) =>
  new Date(y, mo - 1, d, h, mi, s).getTime();

function makeSessions(): unknown[] {
  const marks = Array.from({ length: 13 }, (_, i) => ({
    id: 10 + i,
    t_ms: local(2026, 10, 9, 16, 14 + i, 32),
    screenshot: i === 5 ? null : `marks/${i}.png`,
    capture: i === 5 ? null : 'window',
    capture_error: i === 5 ? '画面を撮れませんでした' : null,
    screenshot_path: i === 5 ? null : `C:\\data\\games\\20261009-161200\\marks\\${i}.png`,
  }));
  const ratings = (['good', 'fair', 'bad', 'good', 'good', 'fair', 'bad', 'good'] as const).map(
    (rating, i) => ({ id: 100 + i, t_ms: local(2026, 10, 9, 16, 20 + i * 4, 0), rating, hand: i + 1 }),
  );
  return [
    {
      id: '20261009-161200',
      started_ms: local(2026, 10, 9, 16, 12),
      mark_count: marks.length,
      rating_count: ratings.length,
      marks,
      ratings,
      events: [],
    },
    {
      id: '20261008-210000',
      started_ms: local(2026, 10, 8, 21, 0),
      mark_count: 0,
      rating_count: 0,
      marks: [],
      ratings: [],
      events: [],
    },
    {
      id: '20250101-090000',
      started_ms: local(2025, 1, 1, 9, 0),
      mark_count: 3,
      rating_count: 1,
      marks: marks.slice(0, 3),
      ratings: ratings.slice(0, 1),
      events: [],
    },
  ];
}

function scenario(label: Scenario['label'], overrides: Partial<Scenario> = {}): Scenario {
  return {
    label,
    state: baseState,
    settings,
    inputStatus,
    sessions: makeSessions(),
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

/** 偽の Tauri を入れてページを開く。実行時の例外・コンソールのエラー・外へのリクエストを集める。 */
async function open(
  file: 'index.html' | 'widget.html',
  viewport: { width: number; height: number },
  scheme: Scheme,
  scn: Scenario,
): Promise<Opened> {
  // 動きを減らす設定にして、色の遷移の途中（半端な色）を axe が見ないようにする。
  // tokens.css は、この設定のとき遷移とアニメーションを止める。
  const context = await browser.newContext({
    viewport,
    colorScheme: scheme,
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
  await page.addInitScript(tauriMockScript(scn));
  await page.goto(new URL(file, server.url).toString());
  return { context, page, problems, external };
}

async function noHorizontalScroll(page: Page): Promise<{ scroll: number; client: number; body: number }> {
  return page.evaluate(() => ({
    scroll: document.documentElement.scrollWidth,
    client: document.documentElement.clientWidth,
    body: document.body.scrollWidth,
  }));
}

/** 画面に出ている画像が読み終わるまで待つ（画面の外の遅延読み込みの画像は待たない）。 */
async function waitForImages(page: Page): Promise<void> {
  await page.waitForFunction(() =>
    Array.from(document.images)
      .filter((img) => img.getBoundingClientRect().top < window.innerHeight)
      .every((img) => img.complete),
  );
}

const MAIN_WIDTHS = [390, 768, 1280] as const;

describe('検討画面（メインの窓）', () => {
  for (const scheme of SCHEMES) {
    for (const width of MAIN_WIDTHS) {
      for (const pageName of ['記録', '設定'] as const) {
        const title = `${pageName}ページ 幅${width}px ${scheme}`;

        it(`${title}: 横スクロールが無く、重大な a11y 違反が無く、Tab で全部に届き、外へ通信しない`, async () => {
          const { context, page, problems, external } = await open(
            'index.html',
            { width, height: 800 },
            scheme,
            scenario('main'),
          );
          try {
            await page.getByRole('heading', { level: 1, name: '記録' }).waitFor();
            if (pageName === '設定') {
              await page.getByRole('button', { name: '設定' }).click();
              await page.getByRole('heading', { level: 1, name: '設定' }).waitFor();
              await page.getByRole('button', { name: 'ボタンを登録' }).waitFor();
            } else {
              await page.getByRole('navigation', { name: '半荘の一覧' }).waitFor();
              await waitForImages(page);
            }

            // U-4: 横スクロール
            const m = await noHorizontalScroll(page);
            expect(m.scroll, `scrollWidth ${m.scroll} > clientWidth ${m.client}`).toBeLessThanOrEqual(m.client);
            expect(m.body).toBeLessThanOrEqual(m.client);

            // U-5 と U-6: axe（色のコントラストを含む）
            const axe = await runAxe(page);
            expect(seriousViolations(axe)).toEqual([]);
            // 色のコントラストの規則が実際に働いている（検査が空振りしていない）。
            const contrastRule = axe.passes.find((p) => p.id === 'color-contrast');
            expect(contrastRule?.nodes ?? 0, 'color-contrast の対象の要素').toBeGreaterThan(5);

            // U-5: キーボード
            const reach = await unreachableByTab(page);
            expect(reach.total).toBeGreaterThan(3);
            expect(reach.missed).toEqual([]);

            expect(problems).toEqual([]);
            expect(external).toEqual([]);
          } finally {
            await context.close();
          }
        });
      }
    }
  }

  /** 設定ページの、状態ごとの見た目（W-9・W-10・W-11）。 */
  const SETTINGS_VARIANTS = [
    {
      name: '登録の待機中（長い案内文）',
      input: { ...inputStatus, registering: true },
      ready: '登録したいボタンを押してください（マウスのボタンでもキーでも）',
    },
    {
      name: 'テストで受け取った・補助プログラムが動いている',
      input: {
        ...inputStatus,
        probe_ms: local(2026, 10, 9, 19, 42, 5),
        hook: 'helper',
        helper: { installed: true, running: true, busy: null, error: null },
      },
      settings: { ...settings, trigger: { kind: 'key', code: 'KeyM', ctrl: true, alt: true } },
      ready: '受け取りました',
    },
    {
      name: '設定済みだが動いていない・失敗の理由つき',
      input: {
        ...inputStatus,
        helper: {
          installed: true,
          running: false,
          busy: null,
          error: 'Windows の確認が取り消されました',
        },
        message: 'ボタンを拾う仕組みが動いていません。補助プログラムを設定するか、アプリを開き直してください',
      },
      ready: '起動する',
    },
    {
      name: '設定の途中（確認を待っている）',
      input: {
        ...inputStatus,
        helper: { installed: false, running: false, busy: 'installing', error: null },
      },
      ready: '設定しています',
    },
  ] as const;

  for (const scheme of SCHEMES) {
    for (const width of [390, 1280] as const) {
      for (const variant of SETTINGS_VARIANTS) {
        it(`設定ページ ${variant.name} 幅${width}px ${scheme}: 横スクロールが無く、重大な a11y 違反が無く、Tab で全部に届く`, async () => {
          const { context, page, problems, external } = await open(
            'index.html',
            { width, height: 900 },
            scheme,
            scenario('main', {
              inputStatus: variant.input,
              settings: 'settings' in variant ? variant.settings : settings,
            }),
          );
          try {
            await page.getByRole('heading', { level: 1, name: '記録' }).waitFor();
            await page.getByRole('button', { name: '設定' }).click();
            await page.getByRole('heading', { level: 1, name: '設定' }).waitFor();
            await page.getByText(variant.ready).first().waitFor();

            const m = await noHorizontalScroll(page);
            expect(m.scroll, `scrollWidth ${m.scroll} > clientWidth ${m.client}`).toBeLessThanOrEqual(m.client);

            const axe = await runAxe(page);
            expect(seriousViolations(axe)).toEqual([]);
            const reach = await unreachableByTab(page);
            expect(reach.missed).toEqual([]);

            expect(problems).toEqual([]);
            expect(external).toEqual([]);
          } finally {
            await context.close();
          }
        });
      }
    }
  }

  it('幅 390px では、サイドバーがアイコンだけの細い列になり、行き先の名前は読み上げに残る', async () => {
    const { context, page } = await open('index.html', { width: 390, height: 800 }, 'light', scenario('main'));
    try {
      await page.getByRole('heading', { level: 1, name: '記録' }).waitFor();
      const side = await page.locator('.side').boundingBox();
      expect(side?.width).toBeLessThanOrEqual(61);
      // 文字は見えないが、アクセシブルな名前は残っている。
      await expect(page.getByRole('button', { name: '設定' }).count()).resolves.toBe(1);
      const label = page.locator('.nav-item .label').first();
      const box = await label.boundingBox();
      expect(box?.width ?? 0).toBeLessThanOrEqual(1);
    } finally {
      await context.close();
    }
  });

  it('幅 1280px では、サイドバーは固定幅（224px）で、文字が見える', async () => {
    const { context, page } = await open('index.html', { width: 1280, height: 800 }, 'light', scenario('main'));
    try {
      await page.getByRole('heading', { level: 1, name: '記録' }).waitFor();
      const side = await page.locator('.side').boundingBox();
      expect(Math.round(side?.width ?? 0)).toBe(224);
      expect((await page.locator('.nav-item .label').first().boundingBox())?.width ?? 0).toBeGreaterThan(20);
    } finally {
      await context.close();
    }
  });

  it('テーマの切り替えボタンで、ライトとダークが入れ替わり、本文の色が変わる', async () => {
    const { context, page } = await open('index.html', { width: 1280, height: 800 }, 'light', scenario('main'));
    try {
      await page.getByRole('heading', { level: 1, name: '記録' }).waitFor();
      const colorOf = () => page.evaluate(() => getComputedStyle(document.body).backgroundColor);
      const light = await colorOf();
      await page.getByRole('button', { name: 'ダークテーマに切り替え' }).click();
      const dark = await colorOf();
      expect(dark).not.toBe(light);
      await page.getByRole('button', { name: 'ライトテーマに切り替え' }).click();
      expect(await colorOf()).toBe(light);
    } finally {
      await context.close();
    }
  });
});

const WIDGET_SHAPES = [
  { name: '縦長', orientation: 'vertical', width: 76, height: 336 },
  { name: '横長', orientation: 'horizontal', width: 340, height: 64 },
] as const;

const WIDGET_STATES = [
  { name: '記録中', state: baseState },
  {
    name: '待機中',
    state: { ...baseState, status: 'idle', session_id: null, mark_count: 0, ratings: [], next_hand: 1, can_undo: false },
  },
  {
    name: 'エラー',
    state: {
      ...baseState,
      status: 'error',
      session_id: null,
      mark_count: 0,
      ratings: [],
      next_hand: 1,
      can_undo: false,
      error: '保存先がリポジトリの中です',
    },
  },
  // 評価が 2 桁になっても、表示が窓からはみ出さない。
  {
    name: '12 局目まで評価済み・迷い 15',
    state: { ...baseState, mark_count: 15, ratings: Array.from({ length: 11 }, () => 'good'), next_hand: 12 },
  },
] as const;

describe('ウィジェット', () => {
  for (const shape of WIDGET_SHAPES) {
    for (const scheme of SCHEMES) {
      for (const st of WIDGET_STATES) {
        it(`${shape.name}（${shape.width}x${shape.height}） ${scheme} ${st.name}: 窓にぴったり収まり、はみ出さず、ボタンは 40px 以上、a11y 違反なし、Tab で全部に届く`, async () => {
          const { context, page, problems, external } = await open(
            'widget.html',
            { width: shape.width, height: shape.height },
            scheme,
            scenario('widget', {
              state: st.state,
              settings: { ...settings, orientation: shape.orientation },
            }),
          );
          try {
            await page.getByRole('group', { name: '終わった局の評価' }).waitFor();

            // 窓の大きさに、枠がぴったり合う。
            const box = await page.locator('.widget').boundingBox();
            expect(box).toMatchObject({ x: 0, y: 0, width: shape.width, height: shape.height });

            // はみ出し（横にも縦にも）。内側の要素が窓の外へ出ていない。
            const overflow = await page.evaluate(() => {
              const root = document.querySelector('.widget') as HTMLElement;
              const rootRect = root.getBoundingClientRect();
              const outside: string[] = [];
              for (const el of Array.from(root.querySelectorAll<HTMLElement>('*'))) {
                const r = el.getBoundingClientRect();
                if (r.width === 0 || r.height === 0) continue;
                if (r.left < rootRect.left - 0.5 || r.right > rootRect.right + 0.5 || r.top < rootRect.top - 0.5 || r.bottom > rootRect.bottom + 0.5) {
                  outside.push(`${el.tagName}.${el.className} ${Math.round(r.left)},${Math.round(r.top)} ${Math.round(r.width)}x${Math.round(r.height)}`);
                }
              }
              return {
                outside,
                docScroll: [document.documentElement.scrollWidth, document.documentElement.scrollHeight],
                clientSize: [document.documentElement.clientWidth, document.documentElement.clientHeight],
                clipped: Array.from(root.querySelectorAll<HTMLElement>('.status, .next, .num, .lbl, .undo')).filter(
                  (el) => el.scrollWidth > el.clientWidth + 1,
                ).map((el) => el.className),
              };
            });
            expect(overflow.outside, '窓の外へ出た要素').toEqual([]);
            expect(overflow.docScroll[0]).toBeLessThanOrEqual(overflow.clientSize[0] ?? 0);
            expect(overflow.docScroll[1]).toBeLessThanOrEqual(overflow.clientSize[1] ?? 0);
            expect(overflow.clipped, '文字が切れている要素').toEqual([]);

            // ボタンは 40px 以上（U-4 の趣旨: マウスだけで確実に押せる）。
            const sizes = await page.evaluate(() =>
              Array.from(document.querySelectorAll('button')).map((b) => {
                const r = b.getBoundingClientRect();
                return { name: b.getAttribute('aria-label') ?? b.textContent ?? '', w: r.width, h: r.height };
              }),
            );
            expect(sizes).toHaveLength(5);
            for (const s of sizes) {
              expect(s.w, `${s.name} の幅`).toBeGreaterThanOrEqual(40);
              expect(s.h, `${s.name} の高さ`).toBeGreaterThanOrEqual(40);
            }

            // U-5 と U-6
            const axe = await runAxe(page);
            expect(seriousViolations(axe)).toEqual([]);
            // エラーの間は評価のボタンが無効で（axe は無効なボタンの文字を見ない）、対象が少ない。
            expect(axe.passes.find((p) => p.id === 'color-contrast')?.nodes ?? 0).toBeGreaterThanOrEqual(1);
            const reach = await unreachableByTab(page);
            expect(reach.missed).toEqual([]);

            expect(problems).toEqual([]);
            expect(external).toEqual([]);
          } finally {
            await context.close();
          }
        });
      }
    }
  }

  it('光らせた直後のボタン（flash）も、文字のコントラストが足りている', async () => {
    for (const scheme of SCHEMES) {
      const { context, page } = await open(
        'widget.html',
        { width: 76, height: 336 },
        scheme,
        scenario('widget'),
      );
      try {
        await page.getByRole('group', { name: '終わった局の評価' }).waitFor();
        await page.getByRole('button', { name: /^迷い/ }).evaluate((el) => el.classList.add('flash'));
        await page.getByRole('button', { name: /〇/ }).evaluate((el) => el.classList.add('flash'));
        const axe = await runAxe(page);
        expect(seriousViolations(axe), scheme).toEqual([]);
      } finally {
        await context.close();
      }
    }
  });
});
