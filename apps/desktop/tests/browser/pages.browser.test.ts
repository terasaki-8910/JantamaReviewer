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

import { COPIED_LINK, FX4_ID, FX4_TEXT, fx4Ocr, fx4Session } from '../import-fixtures';
import {
  TINY_PNG,
  boxesOverlap,
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

/** `get_platform_info` の答え（macOS の段階 2: 検討画面だけ。Rust の `platform/mac/mod.rs` と同じ）。 */
const MAC_STAGE_2_PLATFORM = {
  os: 'macos',
  features: { widget: false, button_hook: false, capture: false, ocr: false, helper: false },
};

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
  // 迷いだけ（F0、W-15）は切: これまでの縦長・横長（〇△✕ のボタンつき）と、〇△✕ を持つ画面を検査する。入の検査は、下の「迷いだけ」
  doubt_only: false,
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
      report_path: null,
      ocr: null,
      links: { marks: {}, ratings: {} },
      self_ratings: { kyokus: {} },
      maka: { kyokus: {} },
      memos: { marks: {}, extras: [] },
    },
    {
      id: '20261008-210000',
      started_ms: local(2026, 10, 8, 21, 0),
      mark_count: 0,
      rating_count: 0,
      marks: [],
      ratings: [],
      events: [],
      report_path: 'C:\\data\\games\\20261008-210000\\report.json',
      ocr: null,
      links: { marks: {}, ratings: {} },
      self_ratings: { kyokus: {} },
      maka: { kyokus: {} },
      memos: { marks: {}, extras: [] },
    },
    {
      id: '20250101-090000',
      started_ms: local(2025, 1, 1, 9, 0),
      mark_count: 3,
      rating_count: 1,
      marks: marks.slice(0, 3),
      ratings: ratings.slice(0, 1),
      events: [],
      report_path: null,
      ocr: null,
      links: { marks: {}, ratings: {} },
      self_ratings: { kyokus: {} },
      maka: { kyokus: {} },
      memos: { marks: {}, extras: [] },
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
    // 2 つめの半荘は、結果を取り込んである（一覧に段階の印と Rating が出る）。
    reports: { '20261008-210000': FX4_TEXT },
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
      for (const pageName of ['半荘', '設定'] as const) {
        const title = `${pageName}ページ 幅${width}px ${scheme}`;

        it(`${title}: 横スクロールが無く、重大な a11y 違反が無く、Tab で全部に届き、外へ通信しない`, async () => {
          const { context, page, problems, external } = await open(
            'index.html',
            { width, height: 800 },
            scheme,
            scenario('main'),
          );
          try {
            await waitForMainReady(page);
            if (pageName === '設定') {
              await ensureSidebar(page);
              await page.getByRole('button', { name: '設定' }).click();
              await page.getByRole('heading', { level: 1, name: '設定' }).waitFor();
              await page.getByRole('button', { name: 'ボタンを登録' }).waitFor();
            } else {
              await page.locator('nav[aria-label="半荘の一覧"]').waitFor({ state: 'attached' });
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
    {
      // macOS の段階 2: ウィジェット・迷いマークのボタン・撮影・補助プログラムの行は出さず、「まだ使えません」と書く。
      name: 'macOS（段階 2。ボタンの行は「まだ使えません」）',
      input: inputStatus,
      platform: MAC_STAGE_2_PLATFORM,
      ready: 'Mac ではまだ使えません',
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
              ...('platform' in variant ? { platform: variant.platform } : {}),
            }),
          );
          try {
            await waitForMainReady(page);
            await ensureSidebar(page);
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

  it('W-11 「受け取りました」と時刻の間に、見える空白がある（flex の中で、文字と時刻が別の項目になると消える）', async () => {
    const { context, page } = await open(
      'index.html',
      { width: 1280, height: 900 },
      'light',
      scenario('main', {
        inputStatus: { ...inputStatus, probe_ms: local(2026, 10, 9, 19, 42, 5) },
        settings,
      }),
    );
    try {
      await waitForMainReady(page);
      await page.getByRole('button', { name: '設定' }).click();
      await page.getByText('受け取りました').first().waitFor();
      const gap = await page.evaluate(() => {
        const time = document.querySelector('.probe .mono');
        const text = time?.previousSibling;
        if (!time || !text || !text.textContent) return null;
        // 「受け取りました」の見える文字の右端（最後の空白は含めない）から、時刻の左端まで。
        const range = document.createRange();
        range.setStart(text, 0);
        range.setEnd(text, text.textContent.length - 1);
        return time.getBoundingClientRect().left - range.getBoundingClientRect().right;
      });
      expect(gap).not.toBeNull();
      expect(gap ?? 0).toBeGreaterThanOrEqual(2);
    } finally {
      await context.close();
    }
  });

  it('幅 390px では、サイドバーは隠れている（細い列ではない）。左上のボタンで引き出しを開くと、行き先の名前が文字で見える', async () => {
    const { context, page } = await open('index.html', { width: 390, height: 800 }, 'light', scenario('main'));
    try {
      await waitForMainReady(page);
      // 閉じている間: 列は無く、サイドバーの物は見えない・届かない
      expect(await page.locator('.side').evaluate((el) => getComputedStyle(el).visibility)).toBe('hidden');
      expect(await page.getByRole('button', { name: '設定' }).count()).toBe(0);
      // 本文は左端から始まる
      expect(await page.locator('main .head').evaluate((el) => el.getBoundingClientRect().left)).toBeLessThanOrEqual(16);
      await ensureSidebar(page);
      const side = await page.locator('.side').boundingBox();
      expect(Math.round(side?.width ?? 0)).toBe(300);
      await expect(page.getByRole('button', { name: '設定' }).count()).resolves.toBe(1);
      const label = page.locator('.nav-item .label').first();
      const box = await label.boundingBox();
      expect(box?.width ?? 0).toBeGreaterThan(20);
    } finally {
      await context.close();
    }
  });

  it('幅 1280px では、サイドバーは固定幅（248px）で、文字が見える', async () => {
    const { context, page } = await open('index.html', { width: 1280, height: 800 }, 'light', scenario('main'));
    try {
      await waitForMainReady(page);
      const side = await page.locator('.side').boundingBox();
      expect(Math.round(side?.width ?? 0)).toBe(248);
      expect((await page.locator('.nav-item .label').first().boundingBox())?.width ?? 0).toBeGreaterThan(20);
    } finally {
      await context.close();
    }
  });

  it('テーマの切り替えボタンで、ライトとダークが入れ替わり、本文の色が変わる', async () => {
    const { context, page } = await open('index.html', { width: 1280, height: 800 }, 'light', scenario('main'));
    try {
      await waitForMainReady(page);
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

// ---- 取り込みのページ（F1）の、状態ごとの見た目 ----

interface ImportView {
  name: string;
  /** 状態ごとの、Tauri の偽物の答え。 */
  scenario: Partial<Scenario>;
  /** その状態まで進める操作。 */
  drive: (page: Page) => Promise<void>;
  /** その状態になったことを知らせる、画面の見出しか文。 */
  ready: { heading?: string; text?: string };
}

const HOUR_MS = 60 * 60 * 1000;
const importSession = (id: string, ago: number) => fx4Session(id, Date.now() - ago);

/** Rust 側のイベント（mjai の窓の知らせなど）を、偽の Tauri を通して画面に送る。 */
async function emitEvent(page: Page, event: string, payload: unknown) {
  await page.evaluate(
    ([name, body]) =>
      (window as unknown as { __jrEmit: (e: string, p: unknown) => void }).__jrEmit(name as string, body),
    [event, payload] as const,
  );
}

/** サイドバーの「検討結果を取り込む」を押して、取り込みのページを開く。 */
async function openImportPage(page: Page) {
  await waitForMainReady(page);
  // 細い窓では、サイドバーは引き出しに隠れている。開いてから押す（押すと閉じる）
  await ensureSidebar(page);
  // 完全に一致するものだけ（取り込み前の半荘のページには、「この半荘に検討結果を取り込む」もある。U-14）。
  await page.getByRole('button', { name: '検討結果を取り込む', exact: true }).click();
  await page.getByRole('heading', { level: 1, name: '検討結果を取り込む' }).waitFor();
}

/** 「mjai で検討する」を押して、mjai の窓の結果を待つ状態にする。 */
async function waitForWindow(page: Page) {
  await openImportPage(page);
  await page.getByRole('button', { name: 'mjai で検討する' }).click();
  await page.getByRole('heading', { name: 'mjai の窓で Submit を押してください' }).waitFor();
}

/** mjai の窓が結果のページを見つけた、という知らせを送る。 */
async function foundReport(page: Page) {
  await waitForWindow(page);
  await emitEvent(page, 'mjai-window', { kind: 'report_found', id: FX4_ID });
}

const IMPORT_VIEWS: ImportView[] = [
  {
    name: '牌譜リンクが無い',
    scenario: { importing: { clipboard: null } },
    drive: openImportPage,
    ready: { heading: '牌譜リンクがありません' },
  },
  {
    name: '牌譜リンクを見つけた',
    scenario: { importing: { clipboard: COPIED_LINK } },
    drive: openImportPage,
    ready: { heading: 'コピーした牌譜リンクを見つけました' },
  },
  {
    name: 'mjai の窓で Submit を待つ',
    scenario: { importing: { clipboard: COPIED_LINK } },
    drive: waitForWindow,
    ready: { heading: 'mjai の窓で Submit を押してください' },
  },
  {
    name: '取り込んでいます',
    scenario: { importing: { clipboard: COPIED_LINK, reportText: FX4_TEXT, fetchHangs: true } },
    drive: foundReport,
    ready: { heading: '取り込んでいます' },
  },
  {
    name: '半荘を選ぶ',
    scenario: {
      importing: { clipboard: COPIED_LINK, reportText: FX4_TEXT, ocr: fx4Ocr() },
      sessions: [
        importSession('20261009-190953', 17 * HOUR_MS),
        importSession('20261009-210000', 5 * HOUR_MS),
      ],
    },
    drive: foundReport,
    ready: { heading: 'どの半荘の結果か、選んでください' },
  },
  {
    name: '取り込みました',
    scenario: {
      importing: { clipboard: COPIED_LINK, reportText: FX4_TEXT, ocr: fx4Ocr() },
      sessions: [importSession('20261009-190953', 17 * HOUR_MS)],
    },
    drive: foundReport,
    ready: { heading: '取り込みました' },
  },
  {
    name: '失敗（検討結果が読めない）',
    scenario: {
      importing: { clipboard: COPIED_LINK, reportText: '{"not":"a report"}' },
      sessions: [importSession('20261009-190953', 17 * HOUR_MS)],
    },
    drive: foundReport,
    ready: { heading: '結果の JSON を読めませんでした' },
  },
  {
    name: '「この半荘を取り込みますか」の帯（記録のページ）',
    scenario: { importing: { clipboard: COPIED_LINK } },
    drive: async (page) => {
      await waitForMainReady(page);
      await emitEvent(page, 'main-window-focused', null);
    },
    ready: { text: 'この半荘を取り込みますか' },
  },
];

describe('取り込みのページ', () => {
  for (const scheme of SCHEMES) {
    for (const width of [390, 1280] as const) {
      for (const view of IMPORT_VIEWS) {
        it(`${view.name} 幅${width}px ${scheme}: 横スクロールが無く、重大な a11y 違反が無く、Tab で全部に届き、外へ通信しない`, async () => {
          const { context, page, problems, external } = await open(
            'index.html',
            { width, height: 900 },
            scheme,
            scenario('main', view.scenario),
          );
          try {
            await view.drive(page);
            if (view.ready.heading) {
              await page.getByRole('heading', { name: view.ready.heading }).waitFor();
            } else if (view.ready.text) {
              await page.getByText(view.ready.text).first().waitFor();
            }

            const m = await noHorizontalScroll(page);
            expect(m.scroll, `scrollWidth ${m.scroll} > clientWidth ${m.client}`).toBeLessThanOrEqual(m.client);
            expect(m.body).toBeLessThanOrEqual(m.client);

            const axe = await runAxe(page);
            expect(seriousViolations(axe)).toEqual([]);
            // 細い窓では、サイドバーは隠れている（検査の対象ではない）ので、文字の数が少ない。規則が働いていれば足りる
            expect(axe.passes.find((p) => p.id === 'color-contrast')?.nodes ?? 0).toBeGreaterThanOrEqual(3);

            const reach = await unreachableByTab(page);
            expect(reach.total).toBeGreaterThanOrEqual(3);
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

  it('幅 1280px では、取り込みのボタンがサイドバーの上にあり、accent で塗られている。幅 390px でも（引き出しを開くと）同じ形で、文字が見える', async () => {
    for (const width of [1280, 390] as const) {
      const { context, page } = await open('index.html', { width, height: 800 }, 'light', scenario('main'));
      try {
        await waitForMainReady(page);
        await ensureSidebar(page);
        const button = page.getByRole('button', { name: '検討結果を取り込む', exact: true });
        const box = await button.boundingBox();
        const next = await page.getByRole('button', { name: '解き直し' }).first().boundingBox();
        // ブランドの下、行き先（解き直し・ログ・週の集計）より上。
        expect(box !== null && next !== null && box.y < next.y).toBe(true);
        const label = await page.locator('.import .label').boundingBox();
        expect(label?.width ?? 0).toBeGreaterThan(40);
        expect(box?.width ?? 0).toBeGreaterThan(150);
        // 塗りは accent（背景色が、ページの背景と違う）。
        const fill = await button.evaluate((el) => getComputedStyle(el).backgroundColor);
        const base = await page.evaluate(() => getComputedStyle(document.body).backgroundColor);
        expect(fill).not.toBe(base);
      } finally {
        await context.close();
      }
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

// ---- 迷いだけを記録する（F0、W-15）: 48px 角の「迷い」ボタン 1 つ ----

const SQUARE_STATES = [
  { name: '記録中（迷い 2）', state: baseState },
  {
    name: '待機中（迷い 0）',
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
  { name: '迷い 15', state: { ...baseState, mark_count: 15 } },
  // 3 桁でも、窓からはみ出さず、右上の点と重ならない
  { name: '迷い 100', state: { ...baseState, mark_count: 100 } },
] as const;

const squareScenario = (state: unknown = baseState) =>
  scenario('widget', { state, settings: { ...settings, doubt_only: true } });

const jrCalls = (page: Page, cmd: string) =>
  page.evaluate(
    (name) =>
      (window as unknown as { __jrCalls: Array<{ cmd: string; args: unknown }> }).__jrCalls
        .filter((c) => c.cmd === name)
        .map((c) => c.args),
    cmd,
  );

describe('ウィジェット（迷いだけ。48px 角の「迷い」ボタン 1 つ）', () => {
  for (const scheme of SCHEMES) {
    for (const st of SQUARE_STATES) {
      it(`${scheme} ${st.name}: 窓（48x48）にぴったりの 1 つのボタン。文字は切れず、右上の 6px の点と重ならない。a11y 違反なし。Tab で届く`, async () => {
        const { context, page, problems, external } = await open(
          'widget.html',
          { width: 48, height: 48 },
          scheme,
          squareScenario(st.state),
        );
        try {
          const button = page.getByRole('button', { name: /^迷い/ });
          await button.waitFor();
          // 窓の中には、このボタンだけ（〇△✕・次の局・取り消しは無い）
          expect(await page.getByRole('button').count()).toBe(1);
          expect(await page.locator('.rate, .rate-btn, .undo, .next, .info, .status').count()).toBe(0);
          expect(await page.locator('.widget').boundingBox()).toMatchObject({ x: 0, y: 0, width: 48, height: 48 });
          expect(await button.boundingBox()).toMatchObject({ x: 0, y: 0, width: 48, height: 48 });

          const m = await page.evaluate(() => {
            const rect = (el: Element) => {
              const r = el.getBoundingClientRect();
              return { left: r.left, right: r.right, top: r.top, bottom: r.bottom, width: r.width, height: r.height };
            };
            // 文字の見える範囲（箱ではなく、文字そのもの）
            const textRect = (el: Element) => {
              const range = document.createRange();
              range.selectNodeContents(el);
              return rect({ getBoundingClientRect: () => range.getBoundingClientRect() } as Element);
            };
            const button = document.querySelector('button') as HTMLElement;
            const lbl = button.querySelector('.lbl') as HTMLElement;
            const num = button.querySelector('.num') as HTMLElement;
            const dot = button.querySelector('.dot') as HTMLElement;
            const style = (el: Element) => getComputedStyle(el);
            return {
              button: rect(button),
              lbl: textRect(lbl),
              num: textRect(num),
              dot: rect(dot),
              lblSize: style(lbl).fontSize,
              numSize: style(num).fontSize,
              numFamily: style(num).fontFamily,
              dotClass: dot.className,
              buttonRadius: style(button).borderTopLeftRadius,
              docScroll: [document.documentElement.scrollWidth, document.documentElement.scrollHeight],
              clipped: [lbl, num].filter((el) => el.scrollWidth > el.clientWidth + 1).length,
            };
          });
          // 文字の大きさ: 「迷い」11px、数 18px の等幅
          expect(m.lblSize).toBe('11px');
          expect(m.numSize).toBe('18px');
          expect(m.numFamily).toMatch(/mono|monospace/i);
          // 点: 6px、ボタンの右上の角（端から 8px 以内）
          expect(m.dot.width).toBeCloseTo(6, 0);
          expect(m.dot.height).toBeCloseTo(6, 0);
          expect(m.button.right - m.dot.right).toBeLessThanOrEqual(8);
          expect(m.dot.top - m.button.top).toBeLessThanOrEqual(8);
          expect(m.dot.left).toBeGreaterThan(m.button.left + 24);
          // 文字は、ボタンの中に収まり、切れず、点と重ならない
          for (const box of [m.lbl, m.num]) {
            expect(box.left).toBeGreaterThanOrEqual(m.button.left);
            expect(box.right).toBeLessThanOrEqual(m.button.right);
            expect(box.top).toBeGreaterThanOrEqual(m.button.top);
            expect(box.bottom).toBeLessThanOrEqual(m.button.bottom);
            expect(boxesOverlap(box, m.dot), '点と文字の重なり').toBe(false);
          }
          expect(m.clipped).toBe(0);
          expect(m.lbl.bottom).toBeLessThanOrEqual(m.num.top + 1);
          expect(m.docScroll).toEqual([48, 48]);
          // 状態の点: 記録中は塗り、待機中は中抜き、エラーは濃い色
          const expected = st.state.status === 'recording' ? 'dot' : `dot ${st.state.status}`;
          expect(m.dotClass).toBe(expected);

          const axe = await runAxe(page);
          expect(seriousViolations(axe)).toEqual([]);
          if (st.state.status !== 'error') expect(axe.passes.find((p) => p.id === 'color-contrast')?.nodes ?? 0).toBeGreaterThanOrEqual(1);
          const reach = await unreachableByTab(page);
          if (st.state.status === 'error') {
            expect(reach.total).toBe(0);
            // 記録できない間も、窓はつかんで動かせる: ボタンは押しを通し、下はつかめる面（data-tauri-drag-region）
            const hit = await page.evaluate(() => {
              const el = document.elementFromPoint(24, 24);
              return { cls: el?.className, drag: el?.getAttribute('data-tauri-drag-region') };
            });
            expect(hit).toEqual({ cls: 'widget sq', drag: 'deep' });
          } else {
            expect(reach.total).toBe(1);
            expect(reach.missed).toEqual([]);
          }
          expect(problems).toEqual([]);
          expect(external).toEqual([]);
        } finally {
          await context.close();
        }
      });
    }
  }

  it('見た目は .doubt のまま: 淡い accent の面・accent の縁・角丸 8px。押した直後は accent の面（flash）になり、すぐ戻る。縁や影を二重にしない', async () => {
    for (const scheme of SCHEMES) {
      const { context, page } = await open('widget.html', { width: 48, height: 48 }, scheme, squareScenario());
      try {
        const button = page.getByRole('button', { name: /^迷い/ });
        await button.waitFor();
        const colorOf = (token: string) =>
          page.evaluate((name) => {
            const probe = document.createElement('i');
            probe.style.color = `var(${name})`;
            document.body.append(probe);
            const color = getComputedStyle(probe).color;
            probe.remove();
            return color;
          }, token);
        const paint = () =>
          button.evaluate((el) => {
            const style = getComputedStyle(el);
            return { background: style.backgroundColor, border: style.borderTopColor, width: style.borderTopWidth, radius: style.borderTopLeftRadius };
          });
        const rest = await paint();
        expect(rest.border, scheme).toBe(await colorOf('--accent'));
        expect(rest.width).toBe('1px');
        expect(rest.radius).toBe('8px');
        expect(rest.background, scheme).not.toBe(await colorOf('--accent'));
        expect(rest.background, scheme).not.toBe('rgba(0, 0, 0, 0)');
        // 窓の枠線は無い（ボタンの縁が窓の縁）
        expect(await page.locator('.widget').evaluate((el) => getComputedStyle(el).borderTopWidth)).toBe('0px');
        // 押した直後
        await button.click();
        await page.waitForFunction(() => document.querySelector('button')?.classList.contains('flash') === true);
        expect((await paint()).background, scheme).toBe(await colorOf('--accent'));
        await page.waitForFunction(() => document.querySelector('button')?.classList.contains('flash') === false);
        expect((await paint()).background, scheme).toBe(rest.background);
      } finally {
        await context.close();
      }
    }
  });

  it('実際のマウス: 押して離すと記録が 1 件。3px 動かしても記録。5px 動かすと窓を動かし始めて記録しない。右クリックはメニュー', async () => {
    const { context, page, problems } = await open('widget.html', { width: 48, height: 48 }, 'light', squareScenario());
    try {
      await page.getByRole('button', { name: /^迷い/ }).waitFor();
      await page.mouse.move(24, 24);
      await page.mouse.down();
      await page.mouse.up();
      await page.waitForFunction(() => (window as unknown as { __jrCalls: unknown[] }).__jrCalls.some((c) => (c as { cmd: string }).cmd === 'add_mark'));
      expect(await jrCalls(page, 'add_mark')).toHaveLength(1);
      expect(await jrCalls(page, 'plugin:window|start_dragging')).toHaveLength(0);
      // 押したまま 3px（4px 以内）動かして離す: 記録
      await page.mouse.move(20, 24);
      await page.mouse.down();
      await page.mouse.move(23, 24);
      await page.mouse.up();
      await page.waitForFunction(() => (window as unknown as { __jrCalls: Array<{ cmd: string }> }).__jrCalls.filter((c) => c.cmd === 'add_mark').length === 2);
      expect(await jrCalls(page, 'plugin:window|start_dragging')).toHaveLength(0);
      // 押したまま 5px より大きく動かす: 窓を動かし始める（1 回だけ）。離しても記録しない
      await page.mouse.move(14, 24);
      await page.mouse.down();
      await page.mouse.move(20, 24);
      await page.mouse.move(36, 30);
      await page.mouse.up();
      await page.waitForFunction(() => (window as unknown as { __jrCalls: Array<{ cmd: string }> }).__jrCalls.some((c) => c.cmd === 'plugin:window|start_dragging'));
      expect(await jrCalls(page, 'plugin:window|start_dragging')).toHaveLength(1);
      expect(await jrCalls(page, 'add_mark')).toHaveLength(2);
      // 右クリック: ネイティブのメニュー。記録はしない
      await page.mouse.click(24, 24, { button: 'right' });
      await page.waitForFunction(() => (window as unknown as { __jrCalls: Array<{ cmd: string }> }).__jrCalls.some((c) => c.cmd === 'show_widget_menu'));
      expect(await jrCalls(page, 'add_mark')).toHaveLength(2);
      expect(problems).toEqual([]);
    } finally {
      await context.close();
    }
  });

  it('実際のキー: Tab で届き、Enter・Space で記録が 1 件ずつ。押し続けた繰り返しは数えない。焦点の枠は窓の中（内側）に描かれる', async () => {
    const { context, page, problems } = await open('widget.html', { width: 48, height: 48 }, 'light', squareScenario());
    try {
      const button = page.getByRole('button', { name: /^迷い/ });
      await button.waitFor();
      await page.keyboard.press('Tab');
      expect(await button.evaluate((el) => el === document.activeElement)).toBe(true);
      // 焦点の枠は、内側（窓の外に描くと切れる）
      const ring = await button.evaluate((el) => {
        const style = getComputedStyle(el);
        return { width: style.outlineWidth, offset: style.outlineOffset, style: style.outlineStyle };
      });
      expect(ring.style).toBe('solid');
      expect(Number.parseFloat(ring.offset)).toBeLessThan(0);
      await page.keyboard.press('Enter');
      await page.waitForFunction(() => (window as unknown as { __jrCalls: Array<{ cmd: string }> }).__jrCalls.filter((c) => c.cmd === 'add_mark').length === 1);
      await page.keyboard.press('Space');
      await page.waitForFunction(() => (window as unknown as { __jrCalls: Array<{ cmd: string }> }).__jrCalls.filter((c) => c.cmd === 'add_mark').length === 2);
      // 押し続ける（繰り返しのキーが続く）と、最初の 1 回だけ
      await page.keyboard.down('Enter');
      await page.keyboard.down('Enter');
      await page.keyboard.down('Enter');
      await page.keyboard.up('Enter');
      await page.waitForFunction(() => (window as unknown as { __jrCalls: Array<{ cmd: string }> }).__jrCalls.filter((c) => c.cmd === 'add_mark').length === 3);
      await page.waitForTimeout(200);
      expect(await jrCalls(page, 'add_mark')).toHaveLength(3);
      expect(problems).toEqual([]);
    } finally {
      await context.close();
    }
  });
});
