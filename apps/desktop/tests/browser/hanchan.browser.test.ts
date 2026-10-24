// @vitest-environment node
/**
 * 実ブラウザで、半荘のページ（迷いのカード・局の評価の表・画像の大きな表示）を検査する（U-1・U-4・U-5・U-6・U-11）。
 *
 * - U-4: 幅 390・768・1280px で、各状態（通常・メニュー・画像の表示・取り込み前）に横スクロールが出ない。表の入れ物の中も、はみ出さない
 * - U-5・U-6: axe の重大な違反が 0 件（色のコントラストを含む）。Tab ですべての操作に届く。ライトとダーク
 * - 形: カードの画像の箱は 16:9 で、画像は切り取らず収める。「選び直す」は、カードの右端に固定。表は、狭いとき 2 行のかたまりになっても、表の意味を保つ
 * - 画像の大きな表示: 裏の画面は操作できない・Esc と背景で閉じる・カードへキーボードの位置が戻る・前後で画像が変わる
 * - 編集: 迷いを選ぶ・自分の評価・MAKA が、実際のキーとマウスで保存され、Ctrl+Z で戻る
 * jsdom の試験（src/main/SessionPage.test.tsx・Hanchan.test.tsx）と同じふるまいを、実際の描画・キー・時計で確かめる。
 */
import type { Browser, BrowserContext, Locator, Page } from 'playwright-core';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import type { OcrCache } from '../../src/api/types';
import { REPORT_TEXTS, local } from '../fake-sessions';
import { contrast, parseCssColor } from '../color-math';
import { OCR_GEOMETRY, fx4Ocr, fx4Session } from '../import-fixtures';
import {
  TINY_PNG,
  boxesOverlap,
  launchBrowser,
  measureInfoTip,
  runAxe,
  seriousViolations,
  startPageServer,
  tauriMockScript,
  unreachableByTab,
  ensureSidebar,
  waitForMainReady,
  type BoxRect,
  type PageServer,
  type Scenario,
} from './harness';

const SCHEMES = ['light', 'dark'] as const;
type Scheme = (typeof SCHEMES)[number];

/** 試験の「いま」: 2026 年 10 月 9 日 22:00。 */
const NOW = new Date(2026, 9, 9, 22, 0, 0);

const ID = '20261009-190953';
const OLDER_ID = '20261008-210000';

const baseState = { status: 'idle', session_id: null, mark_count: 0, ratings: [], next_hand: 1, can_undo: false, error: null };
const settings = {
  trigger: { kind: 'mouse_x1' },
  orientation: 'vertical',
  widget_position: null,
  sound: true,
  // 迷いだけ（F0、U-46）は切: 自分の〇△✕・メモの欄を持つ画面を検査する。入の検査は、下の「U-46 迷いだけの画面」
  doubt_only: false,
  capture_keywords: ['雀魂', 'Mahjong Soul'],
  data_dir: 'C:\\Users\\someone\\JantamaReviewerData',
};

/**
 * 取り込んだ半荘: FX-4。ウィジェットの評価は、局の順に △・✕・△・✕・✕（東2局・東3局・東3局1本場に旗）。
 * `ocr` と `marks` で、読み取りの写しと、ユーザーが選んだ結びつけ（迷いの番号 → 判断の鍵）を替えられる。
 */
function importedSession(
  extra: { maka?: { kyokus: Record<string, string>; hanchan?: string }; ocr?: OcrCache; marks?: Record<string, string> } = {},
) {
  const base = fx4Session(ID, local(2026, 10, 9, 19, 9), {
    report_path: `C:\\data\\games\\${ID}\\report.json`,
    ocr: extra.ocr ?? fx4Ocr(),
    // 取り込みが保存するとおり: 迷いマークは保存しない（読めた迷い 1〜5 は推定、読めない迷い 6 は手で選ぶ）。評価は局の順。
    links: {
      marks: extra.marks ?? {},
      ratings: { '7': 'k0h0', '8': 'k1h0', '9': 'k1h1', '10': 'k2h0', '11': 'k2h1' },
    },
    self_ratings: { kyokus: {} },
    maka: extra.maka ?? { kyokus: {} },
  });
  const ratings = ['fair', 'bad', 'fair', 'bad', 'bad'] as const;
  return { ...base, ratings: base.ratings.map((r, i) => ({ ...r, rating: ratings[i] ?? r.rating })) };
}

/**
 * 手で選ぶ迷いがある半荘: 迷い 1 の読み取りが、この半荘のどの局にも合わない（別の半荘のスクショ。理由は no-kyoku）。
 * 迷い 6 は、前後の評価と迷いから局が分かる（局だけ分かった迷い）ので、手で選ぶ迷いにならない。
 */
function manualScenario(): Scenario {
  const cache = fx4Ocr();
  cache.entries['marks/m1.png'] = { lines: ['南 2 局', '余 40', '25000'] };
  return scenario({ sessions: [importedSession({ ocr: cache }), recordedSession()] });
}

/** 取り込む前の半荘（昨日）。迷い 3・評価 3。 */
function recordedSession() {
  const base = fx4Session(OLDER_ID, local(2026, 10, 8, 21, 0));
  return { ...base, marks: base.marks.slice(0, 3), mark_count: 3, ratings: base.ratings.slice(0, 3), rating_count: 3 };
}

/** 迷いごとに違う絵（番号つきの 16:9 の SVG）。大きな表示で、前後に動くと絵が変わることを確かめる。 */
function pictures(): Record<string, string> {
  const by: Record<string, string> = {};
  for (let n = 1; n <= 6; n += 1) {
    const svg = `<svg xmlns="http://www.w3.org/2000/svg" width="1280" height="720" viewBox="0 0 1280 720"><rect width="1280" height="720" fill="#1b2a4a"/><text x="640" y="400" font-size="240" text-anchor="middle" fill="#ffffff">${n}</text></svg>`;
    by[`marks\\m${n}.png`] = `data:image/svg+xml;charset=utf-8,${encodeURIComponent(svg)}`;
  }
  return by;
}

function scenario(overrides: Partial<Scenario> = {}): Scenario {
  return {
    label: 'main',
    state: baseState,
    settings,
    inputStatus: null,
    sessions: [importedSession(), recordedSession()],
    reports: { [ID]: REPORT_TEXTS.fx4 },
    thumb: TINY_PNG,
    thumbBy: pictures(),
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

interface OpenOptions {
  width?: number;
  height?: number;
  scheme?: Scheme;
  scenario?: Scenario;
  /** 開く半荘。`older` は、取り込む前の半荘。 */
  session?: 'imported' | 'older';
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
  await page.addInitScript(tauriMockScript(options.scenario ?? scenario()));
  await page.goto(new URL('index.html', server.url).toString());
  await waitForMainReady(page);
  if (options.session === 'older') {
    await ensureSidebar(page);
    await page.locator('.session-scroll [data-open]').nth(1).click();
    await page.getByRole('heading', { level: 1, name: /10月8日/ }).waitFor();
  } else {
    await page.getByRole('table', { name: '局の評価' }).waitFor();
  }
  // 画面に出ている画像が読み終わるまで待つ（画面の外の遅延読み込みの画像は待たない。迷いのカードの下に、メモの欄が増えて、画面の外へ出る画像がある）。
  await page.waitForFunction(() =>
    Array.from(document.images)
      .filter((img) => img.getBoundingClientRect().top < window.innerHeight)
      .every((img) => img.complete),
  );
  return { context, page, problems, external };
}

const poll = <T>(fn: () => Promise<T>) => expect.poll(fn, { timeout: 5000, interval: 50 });

/**
 * 押す物を、見える所へ動かして、スクロールが終わるまで待つ。メニューは、スクロールがあると閉じる（開いたあとに、
 * 押す前のスクロールの知らせが届くと、すぐ閉じてしまう）ので、メニューを開くボタンは、先にここで動かしておく。
 */
async function reveal(page: Page, locator: Locator): Promise<Locator> {
  await locator.scrollIntoViewIfNeeded();
  await page.evaluate(() => new Promise((done) => requestAnimationFrame(() => requestAnimationFrame(done))));
  return locator;
}
const isFocused = (locator: Locator) => locator.evaluate((el) => el === document.activeElement);
const card = (page: Page, n: number) => page.getByRole('article', { name: `迷い${n}` });
const thumb = (page: Page, n: number) => card(page, n).getByRole('button', { name: `迷い${n}の画像を大きく見る` });
const toastText = (page: Page) => page.evaluate(() => document.querySelector('.toast .toast-t')?.textContent ?? null);
const calls = (page: Page, cmd: string) =>
  page.evaluate(
    (name) =>
      (window as unknown as { __jrCalls: Array<{ cmd: string; args: unknown }> }).__jrCalls
        .filter((c) => c.cmd === name)
        .map((c) => c.args),
    cmd,
  );

async function overflow(page: Page) {
  return page.evaluate(() => ({
    scroll: document.documentElement.scrollWidth,
    client: document.documentElement.clientWidth,
    body: document.body.scrollWidth,
    // 表の入れ物の中の横スクロール（あれば、はみ出している）
    table: Array.from(document.querySelectorAll<HTMLElement>('.tbl-wrap')).map((el) => el.scrollWidth - el.clientWidth),
  }));
}

/** その場の状態へ進める（ページの見える範囲に、その状態が出る）。 */
const STATES: Record<string, (page: Page) => Promise<void>> = {
  default: async () => undefined,
  selfMenu: async (page) => {
    await (await reveal(page, page.getByRole('button', { name: '東2局の自分の評価（✕）' }))).click();
    await page.getByRole('menu', { name: '東2局の自分の評価' }).waitFor();
  },
  makaMenu: async (page) => {
    await (await reveal(page, page.getByRole('button', { name: '東3局の MAKA を入力' }))).click();
    await page.getByRole('menu', { name: '東3局の MAKA' }).waitFor();
  },
  // 局だけ分かった迷い 6: 局は選んである（局の幅の中の局だけが並ぶ）
  pick: async (page) => {
    await (await reveal(page, page.getByRole('button', { name: '迷い6の局 東3局1本場' }))).click();
    await page.getByRole('menu', { name: '迷い6の局' }).waitFor();
  },
  // 手で選ぶ迷い 1（`manualScenario`）: 局のメニューに、半荘のすべての局が並ぶ
  pickManual: async (page) => {
    await (await reveal(page, page.getByRole('button', { name: '迷い1の局を選ぶ' }))).click();
    await page.getByRole('menu', { name: '迷い1の局' }).waitFor();
  },
  lightbox: async (page) => {
    await thumb(page, 3).click();
    await page.getByRole('dialog', { name: '迷いの画像' }).waitFor();
  },
  // 局の名前を押して、局の結果の手を開いたところ（U-36）: 放銃した局（東3局）、和了・他家のツモ・他家のロンを含む複数の行
  rowOpenDealIn: async (page) => {
    await (await reveal(page, page.getByRole('button', { name: '東3局', exact: true }))).click();
    await page.locator('tr.hx-exp').waitFor();
  },
  rowOpenMany: async (page) => {
    for (const label of ['東1局', '東2局1本場', '東3局', '東3局1本場']) {
      await (await reveal(page, page.getByRole('button', { name: label, exact: true }))).click();
    }
    await page.locator('tr.hx-exp').first().waitFor();
  },
  // 向聴数の推移（U-36）: 印のある局（東2局1本場）を開き、折れ線の最後の点（聴牌になった打牌と鳴きの迷い）を矢印キーで選んで、吹き出しを出したところ
  rowOpenTrackTip: async (page) => {
    await (await reveal(page, page.getByRole('button', { name: '東2局1本場', exact: true }))).click();
    const chart = page.getByRole('group', { name: '東2局1本場の向聴数の推移（矢印キーで点を選ぶ）' });
    await chart.scrollIntoViewIfNeeded();
    await chart.focus();
    await page.keyboard.press('End');
    await page.waitForFunction(() => document.querySelector('.wk-tip:not([hidden])') !== null);
  },
  // 「表で見る」を開いたところ（東3局1本場。最後の点が大きな不一致）
  rowOpenTrackTable: async (page) => {
    await (await reveal(page, page.getByRole('button', { name: '東3局1本場', exact: true }))).click();
    const toggle = page.locator('.hx-trk').getByRole('button', { name: '表で見る' });
    await (await reveal(page, toggle)).click();
    await page.locator('.hx-trk').getByRole('table', { name: '東3局1本場の向聴数の推移（表）' }).waitFor();
  },
};

describe('U-4・U-5・U-6: 半荘のページの各状態（実ブラウザ）', () => {
  for (const scheme of SCHEMES) {
    for (const width of [390, 768, 1280] as const) {
      for (const [name, drive] of Object.entries(STATES)) {
        // メニューと画像の表示は、幅 390 と 1280 だけ（768 は、通常の状態と同じ作り）。局の結果の手は、幅 390・768・1280 のすべて。
        if (width === 768 && name !== 'default' && !name.startsWith('rowOpen')) continue;
        it(`${name} 幅${width}px ${scheme}: 横スクロールが無く、重大な a11y 違反が無く、Tab で全部に届き、外へ通信しない`, async () => {
          const { context, page, problems, external } = await open({
            width,
            scheme,
            ...(name === 'pickManual' ? { scenario: manualScenario() } : {}),
          });
          try {
            await drive(page);
            await page.waitForTimeout(100);

            const m = await overflow(page);
            expect(m.scroll, `scrollWidth ${m.scroll} > clientWidth ${m.client}`).toBeLessThanOrEqual(m.client);
            expect(m.body).toBeLessThanOrEqual(m.client);
            for (const extra of m.table) expect(extra).toBeLessThanOrEqual(0);

            const axe = await runAxe(page);
            expect(seriousViolations(axe)).toEqual([]);
            // 色のコントラストの規則が実際に働いている（検査が空振りしていない）。画像の表示の間は、裏の画面は検査の対象にならない。
            if (name !== 'lightbox') expect(axe.passes.find((p) => p.id === 'color-contrast')?.nodes ?? 0).toBeGreaterThan(5);

            const reach = await unreachableByTab(page);
            // 画像の表示の間は、裏の画面は inert（Tab で届かないのが正しい）なので、数えるのは画像の表示の中の操作だけ
            expect(reach.total).toBeGreaterThan(name === 'lightbox' ? 1 : 3);
            // メニューと画像の表示は、中だけに留まるので、Tab で全部には届かない。
            if (name === 'default' || name.startsWith('rowOpen')) expect(reach.missed).toEqual([]);
            if (name === 'lightbox') expect(reach.missed.filter((label) => /前の画像|次の画像|閉じる/.test(label))).toEqual([]);

            expect(problems).toEqual([]);
            expect(external).toEqual([]);
          } finally {
            await context.close();
          }
        });
      }

      it(`取り込む前の半荘 幅${width}px ${scheme}: 横スクロールが無く、重大な a11y 違反が無く、Tab で全部に届く`, async () => {
        const { context, page, problems, external } = await open({ width, scheme, session: 'older' });
        try {
          const m = await overflow(page);
          expect(m.scroll).toBeLessThanOrEqual(m.client);
          expect(m.body).toBeLessThanOrEqual(m.client);
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
});

describe('F9 迷いのカードの形（実ブラウザ）', () => {
  it('画像の箱は、どのカードでも 16:9 で、画像は切り取らず箱に収まる（contain）。同じ列のカードは同じ大きさ', async () => {
    const { context, page } = await open();
    try {
      const boxes = await page.evaluate(() =>
        Array.from(document.querySelectorAll<HTMLElement>('.mthumb')).map((el) => {
          const img = el.querySelector('img') as HTMLImageElement;
          const r = el.getBoundingClientRect();
          const i = img.getBoundingClientRect();
          return {
            ratio: r.width / r.height,
            fit: getComputedStyle(img).objectFit,
            inside: i.left >= r.left - 0.5 && i.right <= r.right + 0.5 && i.top >= r.top - 0.5 && i.bottom <= r.bottom + 0.5,
            width: Math.round(r.width),
          };
        }),
      );
      expect(boxes).toHaveLength(6);
      for (const box of boxes) {
        expect(box.ratio).toBeGreaterThan(1.77);
        expect(box.ratio).toBeLessThan(1.79);
        expect(box.fit).toBe('contain');
        expect(box.inside).toBe(true);
      }
      expect(new Set(boxes.map((b) => b.width)).size).toBe(1);
    } finally {
      await context.close();
    }
  });

  it('1280px では 3 列、390px では 1 列。画像のない迷いも、同じ大きさの箱', async () => {
    const wide = await open();
    try {
      const xs = await wide.page.evaluate(() =>
        Array.from(document.querySelectorAll('.mcard')).map((el) => Math.round(el.getBoundingClientRect().left)),
      );
      expect(new Set(xs).size).toBe(3);
    } finally {
      await wide.context.close();
    }
    const base = importedSession();
    const marks = base.marks.map((m, i) => (i === 1 ? { ...m, screenshot: null, screenshot_path: null, capture_error: '画面を撮れませんでした' } : m));
    const narrow = await open({ width: 390, scenario: scenario({ sessions: [{ ...base, marks }, recordedSession()] }) });
    try {
      const xs = await narrow.page.evaluate(() =>
        Array.from(document.querySelectorAll('.mcard')).map((el) => Math.round(el.getBoundingClientRect().left)),
      );
      expect(new Set(xs).size).toBe(1);
      const empty = await narrow.page.locator('.mthumb-empty').boundingBox();
      const full = await narrow.page.locator('.mthumb').first().boundingBox();
      expect(Math.round(empty?.width ?? 0)).toBe(Math.round(full?.width ?? -1));
      expect(Math.round(empty?.height ?? 0)).toBe(Math.round(full?.height ?? -1));
    } finally {
      await narrow.context.close();
    }
  });

  it('「選び直す」は、どのカードでも、カードの右端と同じ距離・同じ高さ（自分の行動の文字の長さで動かない）', async () => {
    const { context, page } = await open();
    try {
      const places = await page.evaluate(() =>
        [1, 2, 3].map((n) => {
          const cardEl = Array.from(document.querySelectorAll<HTMLElement>('article.mcard'))[n - 1] as HTMLElement;
          const button = cardEl.querySelector('.msub .link-btn') as HTMLElement;
          const c = cardEl.getBoundingClientRect();
          const b = button.getBoundingClientRect();
          return { right: Math.round((c.right - b.right) * 10) / 10, top: Math.round((b.top - c.top) * 10) / 10 };
        }),
      );
      expect(places[1]).toEqual(places[0]);
      expect(places[2]).toEqual(places[0]);
    } finally {
      await context.close();
    }
  });

  it('候補の札・手で選ぶ欄は、カードの中に収まる（はみ出さない）。幅 390px でも', async () => {
    for (const width of [1280, 390]) {
      const { context, page } = await open({ width });
      try {
        const out = await page.evaluate(() =>
          Array.from(document.querySelectorAll<HTMLElement>('.mcard')).flatMap((cardEl) => {
            const c = cardEl.getBoundingClientRect();
            return Array.from(cardEl.querySelectorAll<HTMLElement>('.chip, .sel-btn, .link-btn, .mprompt, .mpick-lbl'))
              .filter((el) => el.getBoundingClientRect().right > c.right + 0.5 || el.getBoundingClientRect().left < c.left - 0.5)
              .map((el) => el.textContent);
          }),
        );
        expect(out, `幅 ${width}`).toEqual([]);
      } finally {
        await context.close();
      }
    }
  });
});

describe('F10 局の評価の表の形（実ブラウザ）', () => {
  it('390px: 局の名前のボタンがあっても、行ごとに縦が伸びない（名前の高さは結果の文字と同じ）。局を開いても、閉じた行の高さは変わらない。ボタンの押せる範囲は 24px 以上（U-36）', async () => {
    const { context, page } = await open({ width: 390 });
    try {
      const measure = () =>
        page.locator('.tbl tbody tr:not(.hx-exp)').evaluateAll((rows) =>
          rows.map((row) => {
            const th = row.querySelector('th') as HTMLElement;
            const result = row.querySelector('td') as HTMLElement;
            const button = th.querySelector('button');
            return {
              row: Math.round(row.getBoundingClientRect().height),
              th: Math.round(th.getBoundingClientRect().height),
              result: Math.round(result.getBoundingClientRect().height),
              button: button === null ? 0 : Math.round(button.getBoundingClientRect().height),
            };
          }),
        );
      const before = await measure();
      expect(before).toHaveLength(5);
      for (const [index, m] of before.entries()) {
        expect(m.th, `行 ${index}: 名前の高さ ${m.th}、結果の文字の高さ ${m.result}`).toBeLessThanOrEqual(m.result + 1);
        expect(m.button, `行 ${index} のボタン`).toBeGreaterThanOrEqual(24);
      }
      await page.getByRole('button', { name: '東3局', exact: true }).click();
      await page.locator('tr.hx-exp').waitFor();
      expect(await measure()).toEqual(before);
    } finally {
      await context.close();
    }
  });

  it('1280px: 開いた行は、表の全幅の 1 行。手牌・待ちは表からはみ出さず、閉じた行の高さは変わらない（42px 前後）。開いた行の下の罫線で、次の行と分かれる', async () => {
    const { context, page } = await open();
    try {
      await page.getByRole('button', { name: '東3局', exact: true }).click();
      const detail = page.locator('tr.hx-exp');
      await detail.waitFor();
      const m = await page.evaluate(() => {
        const table = document.querySelector('.tbl') as HTMLElement;
        const cell = document.querySelector('tr.hx-exp > td') as HTMLElement;
        const tiles = [...cell.querySelectorAll('.tile')].map((el) => el.getBoundingClientRect().right);
        return { tableRight: table.getBoundingClientRect().right, cellWidth: cell.getBoundingClientRect().width, tableWidth: table.getBoundingClientRect().width, tilesRight: Math.max(...tiles), cellRight: cell.getBoundingClientRect().right };
      });
      expect(m.cellWidth).toBeGreaterThanOrEqual(m.tableWidth - 1);
      expect(m.tilesRight).toBeLessThanOrEqual(m.cellRight + 1);
      const heights = await page.locator('.tbl tbody tr:not(.hx-exp)').evaluateAll((rows) => rows.map((r) => Math.round(r.getBoundingClientRect().height)));
      expect(new Set(heights).size).toBe(1);
      expect(heights[0]).toBeLessThanOrEqual(44);
    } finally {
      await context.close();
    }
  });

  it('1280px: 表の幅は 760px 以内。見出しの行が見え、各行は 1 行', async () => {
    const { context, page } = await open();
    try {
      // 迷いの札の列（U-27）がある表は、列の分だけ広い（入れ物は 1000px まで）。札が無いと、760px 以内（下の「迷いが無い半荘」）
      const table = await page.locator('.tbl').boundingBox();
      expect(table?.width ?? 0).toBeLessThanOrEqual(1001);
      expect(table?.width ?? 0).toBeGreaterThan(761);
      const header = await page.locator('.tbl thead').boundingBox();
      expect(header?.height ?? 0).toBeGreaterThan(20);
      const heights = await page.locator('.tbl tbody tr').evaluateAll((rows) => rows.map((r) => Math.round(r.getBoundingClientRect().height)));
      expect(new Set(heights).size).toBe(1);
      expect(heights[0]).toBeLessThanOrEqual(44);
    } finally {
      await context.close();
    }
  });

  it('迷いが無い半荘（札が 1 つも無い）: 「迷い」の列も説明も出ず、表の幅は 760px 以内のまま（1280px）', async () => {
    const { context, page } = await open({ scenario: scenario({ sessions: [{ ...importedSession(), marks: [], mark_count: 0 }, recordedSession()] }) });
    try {
      const table = await page.locator('.tbl').boundingBox();
      expect(table?.width ?? 0).toBeLessThanOrEqual(761);
      expect(await page.getByRole('table', { name: '局の評価' }).getByRole('columnheader').count()).toBe(6);
      expect(await page.getByText('迷いの札を押すと').count()).toBe(0);
      expect(await page.getByRole('button', { name: '迷いの札の説明' }).count()).toBe(0);
      const heights = await page.locator('.tbl tbody tr').evaluateAll((rows) => rows.map((r) => Math.round(r.getBoundingClientRect().height)));
      expect(new Set(heights).size).toBe(1);
      expect(heights[0]).toBeLessThanOrEqual(44);
    } finally {
      await context.close();
    }
  });

  it('390px: 1 局が 2 行のかたまり。見出しの行は見えない所へ寄せるが、表の意味（列の見出し・行の見出し）は読み上げに残る', async () => {
    const { context, page } = await open({ width: 390 });
    try {
      const table = page.getByRole('table', { name: '局の評価' });
      expect(await table.getByRole('columnheader').count()).toBe(7);
      expect(await table.getByRole('rowheader').count()).toBe(6);
      expect(await table.getByRole('row').count()).toBe(7);
      const header = await page.locator('.tbl thead').boundingBox();
      expect(header?.width ?? 99).toBeLessThanOrEqual(1);
      // 1 行目: 局・結果・点が同じ高さ。2 行目: 自分・AI 基準・MAKA が、その下で同じ高さ。
      const rows = await page.locator('.tbl tbody tr').first().evaluate((tr) =>
        Array.from(tr.children).map((cell) => Math.round(cell.getBoundingClientRect().top)),
      );
      expect(new Set(rows.slice(0, 3)).size).toBe(1);
      expect(new Set(rows.slice(3, 6)).size).toBe(1);
      expect(rows[3] ?? 0).toBeGreaterThan(rows[0] ?? 0);
      // 3 行目: 迷いの行（札がある局だけ。U-27）。自分・AI 基準・MAKA の行より下
      expect(rows[6] ?? 0).toBeGreaterThan(rows[3] ?? 0);
      // 2 行目の小さな見出し（自分・AI 基準・MAKA）と、3 行目の「迷い」。
      const labels = await page.locator('.tbl tbody tr').first().evaluate((tr) =>
        Array.from(tr.querySelectorAll('td[data-label]')).map((td) => getComputedStyle(td, '::before').content),
      );
      expect(labels).toEqual(['"自分"', '"AI 基準"', '"MAKA"', '"迷い"']);
      const m = await overflow(page);
      expect(m.table).toEqual([0]);
    } finally {
      await context.close();
    }
  });

  it('旗は、AI 基準と大きく違う局（東2局・東3局・東3局1本場）だけ。旗の説明は読み上げにある', async () => {
    const { context, page } = await open();
    try {
      const flagged = await page.locator('.tbl tbody tr').evaluateAll((rows) =>
        rows.map((row) => row.querySelector('[role="img"][aria-label="AI 基準と大きく違います"]') !== null),
      );
      expect(flagged).toEqual([false, true, false, true, true]);
      expect(await page.getByText('結果が悪かった局を低く付けていないか').isVisible()).toBe(true);
    } finally {
      await context.close();
    }
  });

  it('メニュー（自分の評価・MAKA の 15 項目）は、窓の中に収まる。背の低い窓（高さ 520px）でも、中でスクロールして収まる', async () => {
    const { context, page } = await open({ height: 520 });
    try {
      await (await reveal(page, page.getByRole('button', { name: '東1局の MAKA を入力' }))).click();
      const menu = page.getByRole('menu', { name: '東1局の MAKA' });
      await menu.waitFor();
      const box = await menu.boundingBox();
      expect(box).not.toBeNull();
      expect(box?.y ?? -1).toBeGreaterThanOrEqual(7);
      expect((box?.y ?? 0) + (box?.height ?? 0)).toBeLessThanOrEqual(520 - 7);
      expect(box?.x ?? -1).toBeGreaterThanOrEqual(7);
      expect((box?.x ?? 0) + (box?.width ?? 0)).toBeLessThanOrEqual(1280 - 7);
      expect(await menu.getByRole('menuitemradio').count()).toBe(15);
      await page.keyboard.press('End');
      expect(await isFocused(menu.getByRole('menuitemradio', { name: 'E', exact: true }))).toBe(true);
    } finally {
      await context.close();
    }
  });
});

describe('U-36 向聴数の推移（実ブラウザ。局の評価の行を開いたとき）', () => {
  const OPEN_ALL = ['東1局', '東2局', '東2局1本場', '東3局', '東3局1本場'];

  it('390px: 全部の行を開いて「表で見る」も開いても、閉じた行の高さは変わらず、横スクロールが無い。折れ線・輪・菱形・三角は、図の中に収まる（最後の点の菱形も）', async () => {
    const { context, page } = await open({ width: 390 });
    try {
      const heights = () => page.locator('.tbl tbody tr:not(.hx-exp)').evaluateAll((rows) => rows.map((row) => Math.round(row.getBoundingClientRect().height)));
      const before = await heights();
      expect(before).toHaveLength(5);
      for (const label of OPEN_ALL) await page.getByRole('button', { name: label, exact: true }).click();
      await page.locator('.hx-trk').nth(4).waitFor();
      for (const toggle of await page.locator('.hx-trk').getByRole('button', { name: '表で見る' }).all()) await toggle.click();
      expect(await heights()).toEqual(before);
      const m = await overflow(page);
      expect(m.scroll).toBeLessThanOrEqual(m.client);
      expect(m.body).toBeLessThanOrEqual(m.client);
      for (const extra of m.table) expect(extra).toBeLessThanOrEqual(0);
      const fit = await page.evaluate(() =>
        [...document.querySelectorAll<HTMLElement>('.hx-trk')].map((block) => {
          const cell = block.closest('td') as HTMLElement;
          const cellBox = cell.getBoundingClientRect();
          const svg = (block.querySelector('.shchart-svg') as SVGSVGElement).getBoundingClientRect();
          const marks = [...block.querySelectorAll('.shchart-svg .dbt, .shchart-svg .bgm, .shchart-svg .tpm, .shchart-svg .nd')].map((el) => el.getBoundingClientRect());
          return {
            svgInCell: svg.left >= cellBox.left - 0.5 && svg.right <= cellBox.right + 0.5,
            marksInSvg: marks.every((box) => box.left >= svg.left - 2 && box.right <= svg.right + 2),
            blockScroll: block.scrollWidth - block.clientWidth,
            tableInCell: [...block.querySelectorAll<HTMLElement>('.hx-sptbl')].every((el) => el.getBoundingClientRect().right <= cellBox.right + 0.5 && el.scrollWidth <= el.clientWidth),
            marks: marks.length,
          };
        }),
      );
      expect(fit).toHaveLength(5);
      for (const [index, item] of fit.entries()) {
        expect(item.svgInCell, `局 ${index}: 図が表の欄に収まる`).toBe(true);
        expect(item.marksInSvg, `局 ${index}: 印が図に収まる`).toBe(true);
        expect(item.blockScroll, `局 ${index}`).toBeLessThanOrEqual(0);
        expect(item.tableInCell, `局 ${index}: 表が収まる`).toBe(true);
        expect(item.marks).toBeGreaterThan(5);
      }
    } finally {
      await context.close();
    }
  });

  it('1280px: 折れ線は 440px 以内で、局の結果の手の下に出る（右に回り込まない）。表で見ると、折れ線の下に出て、表の欄をはみ出さない', async () => {
    const { context, page } = await open({ width: 1280 });
    try {
      await page.getByRole('button', { name: '東3局', exact: true }).click();
      await page.locator('.hx-trk').waitFor();
      await page.locator('.hx-trk').getByRole('button', { name: '表で見る' }).click();
      const m = await page.evaluate(() => {
        const block = document.querySelector('.hx-trk') as HTMLElement;
        const result = document.querySelector('[data-kyoku-result]') as HTMLElement;
        const chart = block.querySelector('.shchart') as HTMLElement;
        const grid = block.querySelector('.hx-sptbl') as HTMLElement;
        const cell = block.closest('td') as HTMLElement;
        return {
          chartWidth: chart.getBoundingClientRect().width,
          below: block.getBoundingClientRect().top >= result.getBoundingClientRect().bottom - 1,
          sameLeft: Math.abs(block.getBoundingClientRect().left - result.getBoundingClientRect().left) <= 1,
          gridBelowChart: grid.getBoundingClientRect().top >= chart.getBoundingClientRect().bottom,
          gridRight: grid.getBoundingClientRect().right,
          cellRight: cell.getBoundingClientRect().right,
          rows: grid.querySelectorAll('[role="row"]').length,
        };
      });
      expect(m.chartWidth).toBeLessThanOrEqual(441);
      expect(m.below).toBe(true);
      expect(m.sameLeft).toBe(true);
      expect(m.gridBelowChart).toBe(true);
      expect(m.gridRight).toBeLessThanOrEqual(m.cellRight + 0.5);
      expect(m.rows).toBe(7);
    } finally {
      await context.close();
    }
  });

  it('Tab の順: 折れ線は 1 つの止まり場所（点ごとの止まり場所は無い）。局の結果の手 → 説明のアイコン → 折れ線 → 「表で見る」 → 次の行', async () => {
    const { context, page } = await open({ width: 1280 });
    try {
      await page.getByRole('button', { name: '東2局1本場', exact: true }).click();
      await page.locator('.hx-trk').waitFor();
      expect(await page.locator('.hx-trk [tabindex]').count()).toBe(1);
      expect(await page.locator('.hx-trk svg [tabindex], .hx-trk svg a, .hx-trk svg button').count()).toBe(0);
      await page.getByRole('button', { name: '東2局1本場', exact: true }).focus();
      const names: string[] = [];
      for (let i = 0; i < 30; i += 1) {
        await page.keyboard.press('Tab');
        const name = await page.evaluate(() => {
          const el = document.activeElement as HTMLElement;
          return (el.getAttribute('aria-label') ?? el.textContent ?? '').trim().slice(0, 40);
        });
        names.push(name);
        if (name === '表で見る') break;
      }
      const at = (name: string) => names.findIndex((entry) => entry.startsWith(name));
      expect(at('向聴数の推移の説明')).toBeGreaterThan(-1);
      expect(at('東2局1本場の向聴数の推移（矢印キーで点を選ぶ）')).toBe(at('向聴数の推移の説明') + 1);
      expect(at('表で見る')).toBe(at('東2局1本場の向聴数の推移（矢印キーで点を選ぶ）') + 1);
      // 局の結果の手の符の内訳（50符のようなボタン）は、折れ線より前
      expect(names.findIndex((entry) => /符の内訳/.test(entry))).toBeLessThan(at('向聴数の推移の説明'));
      // 表で見るを閉じたまま、次の行（東3局）の操作へ進む
      await page.keyboard.press('Tab');
      expect(await page.evaluate(() => (document.activeElement as HTMLElement).textContent ?? '')).toBe('東3局');
    } finally {
      await context.close();
    }
  });

  it('「表で見る」は、実際の Enter でも Space でも開閉する。キーボードの位置はボタンに残り、表は折れ線と同じ点（東2局1本場は 配牌 + 9 打の 10 行）', async () => {
    const { context, page } = await open({ width: 1280 });
    try {
      await page.getByRole('button', { name: '東2局1本場', exact: true }).click();
      const toggle = page.locator('.hx-trk').getByRole('button', { name: '表で見る' });
      await toggle.focus();
      const state = () =>
        page.evaluate(() => ({
          expanded: document.querySelector('.hx-trk .hx-tgl')?.getAttribute('aria-expanded'),
          rows: document.querySelectorAll('.hx-trk .hx-sptbl [role="row"]').length,
          focused: document.activeElement?.classList.contains('hx-tgl') === true,
        }));
      await page.keyboard.press('Enter');
      expect(await state()).toEqual({ expanded: 'true', rows: 11, focused: true });
      await page.keyboard.press('Enter');
      expect(await state()).toEqual({ expanded: 'false', rows: 0, focused: true });
      await page.keyboard.press('Space');
      expect(await state()).toEqual({ expanded: 'true', rows: 11, focused: true });
      await page.keyboard.press('Space');
      expect(await state()).toEqual({ expanded: 'false', rows: 0, focused: true });
    } finally {
      await context.close();
    }
  });

  for (const width of [390, 768, 1280] as const) {
    it(`幅 ${width}px: 折れ線を矢印キーで選ぶと、吹き出しが窓の中に収まる。印のある点の吹き出しに、迷いと大きな不一致の文字が出る`, async () => {
      const { context, page } = await open({ width });
      try {
        await page.getByRole('button', { name: '東2局', exact: true }).click();
        const chart = page.getByRole('group', { name: '東2局の向聴数の推移（矢印キーで点を選ぶ）' });
        await chart.scrollIntoViewIfNeeded();
        await chart.focus();
        const read = () =>
          page.evaluate(() => {
            const tip = document.querySelector<HTMLElement>('.wk-tip:not([hidden])');
            if (tip === null) return null;
            const rect = tip.getBoundingClientRect();
            return {
              value: tip.querySelector('.wk-tip-v')?.textContent ?? '',
              label: tip.querySelector('.wk-tip-l')?.textContent ?? '',
              inside: rect.left >= 0 && rect.top >= 0 && rect.right <= window.innerWidth && rect.bottom <= window.innerHeight,
            };
          });
        await page.keyboard.press('Home');
        expect(await read()).toMatchObject({ value: '2向聴', label: '配牌', inside: true });
        for (let i = 0; i < 11; i += 1) await page.keyboard.press('ArrowRight');
        expect(await read()).toMatchObject({ value: '1向聴・迷い2・大きな不一致', label: '11巡目 打8p', inside: true });
        // 印の付いた値は、途中で折り返さず 1 行に収まる（吹き出しの幅が狭いと「大きな / 不一致」と割れた）
        const valueLines = await page.evaluate(() => {
          const v = document.querySelector<HTMLElement>('.wk-tip:not([hidden]) .wk-tip-v');
          if (v === null) return 0;
          return Math.round(v.getBoundingClientRect().height / parseFloat(getComputedStyle(v).lineHeight));
        });
        expect(valueLines).toBe(1);
        await page.keyboard.press('End');
        expect(await read()).toMatchObject({ value: '1向聴', label: '13巡目 打8s', inside: true });
        await page.keyboard.press('Escape');
        expect(await read()).toBeNull();
        // マウスを乗せても同じ（いちばん近い点）
        const box = (await page.locator('.hx-trk .shchart-plot').boundingBox()) as { x: number; y: number; width: number; height: number };
        await page.mouse.move(box.x + box.width * 0.2, box.y + box.height / 2);
        expect((await read())?.label).toMatch(/^(配牌|\d+巡目 打)/);
        await page.mouse.move(2, 2);
        expect(await read()).toBeNull();
      } finally {
        await context.close();
      }
    });
  }

  for (const scheme of SCHEMES) {
    it(`${scheme}: 印は色だけに頼らない（輪・菱形・三角は別の図形で、凡例と同じ形）。輪は accent、菱形は ink、三角は accent の色で、面の色との差が 3:1 以上`, async () => {
      const { context, page } = await open({ scheme });
      try {
        await page.getByRole('button', { name: '東2局1本場', exact: true }).click();
        await page.locator('.hx-trk').waitFor();
        const m = await page.evaluate(() => {
          const token = (name: string) => {
            const el = document.createElement('i');
            el.style.color = `var(${name})`;
            document.body.appendChild(el);
            const color = getComputedStyle(el).color;
            el.remove();
            return color;
          };
          const block = document.querySelector('.hx-trk') as HTMLElement;
          const style = (selector: string, prop: 'stroke' | 'fill') => getComputedStyle(block.querySelector(selector) as Element)[prop];
          return {
            accent: token('--accent'),
            ink: token('--ink'),
            surface: token('--surface'),
            ring: { chart: style('.shchart-svg .dbt', 'stroke'), legend: style('.hx-leg .dbt', 'stroke') },
            diamond: { chart: style('.shchart-svg .bgm', 'fill'), legend: style('.hx-leg .bgm', 'fill') },
            triangle: { chart: style('.shchart-svg .tpm', 'fill'), legend: style('.hx-leg .tpm', 'fill') },
            tags: ['.shchart-svg .dbt', '.shchart-svg .bgm', '.shchart-svg .tpm'].map((selector) => (block.querySelector(selector) as Element).tagName.toLowerCase()),
            diamondPath: (block.querySelector('.shchart-svg .bgm') as Element).getAttribute('d'),
            trianglePath: (block.querySelector('.shchart-svg .tpm') as Element).getAttribute('d'),
          };
        });
        expect(m.ring).toEqual({ chart: m.accent, legend: m.accent });
        expect(m.diamond).toEqual({ chart: m.ink, legend: m.ink });
        expect(m.triangle).toEqual({ chart: m.accent, legend: m.accent });
        // 形が違う: 輪は circle、菱形と三角は path（4 点と 3 点）
        expect(m.tags).toEqual(['circle', 'path', 'path']);
        expect((m.diamondPath ?? '').match(/L/g)).toHaveLength(3);
        expect((m.trianglePath ?? '').match(/L/g)).toHaveLength(2);
        const surface = parseCssColor(m.surface);
        for (const color of [m.accent, m.ink]) expect(contrast(parseCssColor(color), surface)).toBeGreaterThanOrEqual(3);
      } finally {
        await context.close();
      }
    });
  }

  it('開く前は、折れ線も凡例も表も DOM に無い。取り込む前の半荘には、開くボタンも折れ線も無い', async () => {
    const { context, page } = await open();
    try {
      expect(await page.locator('.hx-trk, .shchart, .hx-leg, .hx-sptbl').count()).toBe(0);
    } finally {
      await context.close();
    }
    const older = await open({ session: 'older' });
    try {
      expect(await older.page.locator('.hx-trk, .shchart, .hx-open').count()).toBe(0);
    } finally {
      await older.context.close();
    }
  });
});

describe('R7-4 画像の大きな表示（実ブラウザ）', () => {
  it('開くと、裏の画面は操作できない（inert）。Esc で閉じると、押したカードへキーボードの位置が戻る', async () => {
    const { context, page } = await open();
    try {
      await thumb(page, 4).click();
      const dialog = page.getByRole('dialog', { name: '迷いの画像' });
      await dialog.waitFor();
      await poll(() => isFocused(dialog)).toBe(true);
      expect(await page.evaluate(() => (document.querySelector('.app') as HTMLElement).inert)).toBe(true);
      // 裏の画面には、キーボードの位置を移せない。
      const moved = await page.evaluate(() => {
        const behind = document.querySelector('.mthumb') as HTMLElement;
        behind.focus();
        return document.activeElement === behind;
      });
      expect(moved).toBe(false);
      // 裏の画面はスクロールしない。
      expect(await page.evaluate(() => getComputedStyle(document.body).overflow)).toBe('hidden');
      await page.keyboard.press('Escape');
      await dialog.waitFor({ state: 'detached' });
      expect(await page.evaluate(() => (document.querySelector('.app') as HTMLElement).inert)).toBe(false);
      await poll(() => isFocused(thumb(page, 4))).toBe(true);
    } finally {
      await context.close();
    }
  });

  it('前・次・← →: 画像が替わり、説明が変わる。端では動かない。背景の押下で閉じる', async () => {
    const { context, page } = await open();
    try {
      await thumb(page, 1).click();
      const dialog = page.getByRole('dialog', { name: '迷いの画像' });
      await dialog.waitFor();
      const shown = () => dialog.locator('.lb-img').getAttribute('src');
      const first = await shown();
      expect(await dialog.locator('figcaption').textContent()).toBe('迷い1 · 東1局 · 4巡目 · 打牌の迷い · 推定 · 19:09:53');
      expect(await dialog.getByRole('button', { name: '前の画像' }).isDisabled()).toBe(true);
      await dialog.getByRole('button', { name: '次の画像' }).click();
      const second = await shown();
      expect(second).not.toBe(first);
      expect(await dialog.locator('figcaption').textContent()).toBe('迷い2 · 東2局 · 11〜12巡目 · 打牌の迷い · 推定 · 19:15:57');
      await page.keyboard.press('ArrowRight');
      await page.keyboard.press('ArrowRight');
      await page.keyboard.press('ArrowRight');
      await page.keyboard.press('ArrowRight');
      expect(await dialog.locator('figcaption').textContent()).toBe('迷い6 · 東3局1本場 · 巡目は決まっていません · 19:22:36');
      expect(await dialog.getByRole('button', { name: '次の画像' }).isDisabled()).toBe(true);
      await page.keyboard.press('ArrowRight');
      expect(await dialog.locator('figcaption').textContent()).toContain('迷い6');
      // 背景（画像・矢印・閉じる以外）を押すと閉じる。
      await page.mouse.click(1250, 700);
      await dialog.waitFor({ state: 'detached' });
      await poll(() => isFocused(thumb(page, 1))).toBe(true);
    } finally {
      await context.close();
    }
  });

  it('大きな画像は、窓の中に収まり、閉じる・前・次のボタンと重ならない。幅 390px でも', async () => {
    for (const [width, height] of [[1280, 800], [390, 800]] as const) {
      const { context, page } = await open({ width, height });
      try {
        await thumb(page, 2).click();
        const dialog = page.getByRole('dialog', { name: '迷いの画像' });
        await dialog.waitFor();
        await page.waitForFunction(() => (document.querySelector('.lb-img') as HTMLImageElement | null)?.complete);
        const img = await dialog.locator('.lb-img').boundingBox();
        expect(img).not.toBeNull();
        expect(img?.x ?? -1).toBeGreaterThanOrEqual(0);
        expect(img?.y ?? -1).toBeGreaterThanOrEqual(0);
        expect((img?.x ?? 0) + (img?.width ?? 0)).toBeLessThanOrEqual(width + 0.5);
        expect((img?.y ?? 0) + (img?.height ?? 0)).toBeLessThanOrEqual(height + 0.5);
        for (const name of ['前の画像', '次の画像', '閉じる']) {
          const button = await dialog.getByRole('button', { name }).boundingBox();
          expect(button).not.toBeNull();
          const overlap =
            (img?.x ?? 0) < (button?.x ?? 0) + (button?.width ?? 0) &&
            (button?.x ?? 0) < (img?.x ?? 0) + (img?.width ?? 0) &&
            (img?.y ?? 0) < (button?.y ?? 0) + (button?.height ?? 0) &&
            (button?.y ?? 0) < (img?.y ?? 0) + (img?.height ?? 0);
          expect(overlap, `幅 ${width}: ${name} が画像に重なる`).toBe(false);
        }
        const m = await overflow(page);
        expect(m.scroll).toBeLessThanOrEqual(m.client);
      } finally {
        await context.close();
      }
    }
  });

  it('Tab は、ダイアログの中の前・次・閉じるだけを回る', async () => {
    const { context, page } = await open();
    try {
      await thumb(page, 2).click();
      const dialog = page.getByRole('dialog', { name: '迷いの画像' });
      await dialog.waitFor();
      const names: string[] = [];
      for (let i = 0; i < 6; i += 1) {
        await page.keyboard.press('Tab');
        names.push(await page.evaluate(() => document.activeElement?.getAttribute('aria-label') ?? ''));
      }
      expect(new Set(names)).toEqual(new Set(['前の画像', '次の画像', '閉じる']));
    } finally {
      await context.close();
    }
  });
});

describe('F9・F10・U-11 編集（実ブラウザ。実際のキーとマウス）', () => {
  it('ほかの候補の札を押すと、保存して通知が出る（「推定」の印が外れる）。Ctrl+Z で推定に戻り、Ctrl+Y でやり直す。キーボードの位置は「選び直す」へ', async () => {
    const { context, page, problems } = await open();
    try {
      await card(page, 4).getByRole('button', { name: '9巡目 打7p' }).click();
      await poll(() => toastText(page)).toBe('迷い4を東2局1本場 9巡目の局面に結びつけました');
      await card(page, 4).getByText('自分：打7p').waitFor();
      expect(await card(page, 4).locator('.tag.est').count()).toBe(0);
      expect(await calls(page, 'set_mark_link')).toEqual([{ sessionId: ID, markId: 4, decision: 'k1h1e11' }]);
      await poll(() => isFocused(card(page, 4).getByRole('button', { name: '迷い4を選び直す' }))).toBe(true);

      await page.keyboard.press('Control+z');
      await poll(() => toastText(page)).toBe('迷い4の結びつけを元に戻しました');
      await card(page, 4).locator('.tag.est').waitFor();
      await card(page, 4).getByText('自分：東をポン').waitFor();
      expect(await calls(page, 'clear_mark_link')).toEqual([{ sessionId: ID, markId: 4 }]);

      await page.keyboard.press('Control+y');
      await poll(() => toastText(page)).toBe('迷い4を東2局1本場 9巡目の局面に結びつけました');
      await card(page, 4).getByText('自分：打7p').waitFor();
      expect(problems).toEqual([]);
    } finally {
      await context.close();
    }
  });

  it('局面を手で選ぶ: キーボードだけで、局のメニュー → 判断のメニューを開いて選べる（矢印だけでは決まらない）', async () => {
    const { context, page } = await open({ scenario: manualScenario() });
    try {
      await (await reveal(page, card(page, 1).getByRole('button', { name: '迷い1の局を選ぶ' }))).focus();
      await page.keyboard.press('Enter');
      const kyoku = page.getByRole('menu', { name: '迷い1の局' });
      await kyoku.waitFor();
      await page.keyboard.press('ArrowDown');
      await page.keyboard.press('ArrowDown');
      expect(await calls(page, 'set_mark_link')).toEqual([]);
      await page.keyboard.press('Enter');
      await kyoku.waitFor({ state: 'detached' });
      await poll(() => isFocused(card(page, 1).getByRole('button', { name: /^迷い1の局 東2局1本場/ }))).toBe(true);
      await page.keyboard.press('Tab');
      await page.keyboard.press('Enter');
      const decision = page.getByRole('menu', { name: '迷い1の判断' });
      await decision.waitFor();
      await page.keyboard.press('ArrowDown');
      await page.keyboard.press('ArrowDown');
      await page.keyboard.press('ArrowDown');
      expect(await calls(page, 'set_mark_link')).toEqual([]);
      await page.keyboard.press('Enter');
      await poll(async () => (await calls(page, 'set_mark_link')).length).toBe(1);
      expect(await calls(page, 'set_mark_link')).toEqual([{ sessionId: ID, markId: 1, decision: 'k1h1e3' }]);
      await card(page, 1).getByText('東2局1本場 3巡目 · 鳴きの迷い').waitFor();
    } finally {
      await context.close();
    }
  });

  it('U-24 局だけ分かった迷い 6: 局は選んである。キーボードだけで、判断のメニュー（局の幅の 17）を開いて選べる。局をどう決めたかの 1 文が出る', async () => {
    const { context, page } = await open();
    try {
      const six = card(page, 6);
      expect(await six.locator('.mwhat').textContent()).toBe('東3局1本場 · 巡目は決まっていません');
      expect(await six.locator('.mhow').textContent()).toBe(
        '東3局1本場の迷い5（19:21:58）と東3局1本場の評価（19:23:54）の間に押したので、東3局1本場です。',
      );
      await (await reveal(page, six.getByRole('button', { name: '迷い6の判断を選ぶ' }))).focus();
      await page.keyboard.press('Enter');
      const decision = page.getByRole('menu', { name: '迷い6の判断' });
      await decision.waitFor();
      expect(await decision.getByRole('menuitemradio').count()).toBe(17);
      for (let i = 0; i < 9; i += 1) await page.keyboard.press('ArrowDown');
      expect(await calls(page, 'set_mark_link')).toEqual([]);
      await page.keyboard.press('Enter');
      await poll(async () => (await calls(page, 'set_mark_link')).length).toBe(1);
      expect(await calls(page, 'set_mark_link')).toEqual([{ sessionId: ID, markId: 6, decision: 'k2h1e9' }]);
      await six.getByText('東3局1本場 8巡目 · 鳴きの迷い').waitFor();
      expect(await six.locator('.mhow').count()).toBe(0);
    } finally {
      await context.close();
    }
  });

  it('自分の評価をマウスで付け直すと、旗が消える。Ctrl+Z で旗が戻る。MAKA も入れて、Ctrl+Z で消える', async () => {
    const { context, page } = await open();
    try {
      const row = page.locator('.tbl tbody tr').nth(1); // 東2局
      expect(await row.locator('.flag').count()).toBe(1);
      await (await reveal(page, row.getByRole('button', { name: '東2局の自分の評価（✕）' }))).click();
      await page.getByRole('menuitemradio', { name: '〇', exact: true }).click();
      await poll(() => toastText(page)).toBe('東2局の自分の評価を〇にしました');
      await poll(async () => row.locator('.flag').count()).toBe(0);
      expect(await calls(page, 'set_self_rating')).toEqual([{ sessionId: ID, kyoku: 'k1h0', rating: 'good' }]);

      await (await reveal(page, page.getByRole('button', { name: '東1局の MAKA を入力' }))).click();
      await page.getByRole('menuitemradio', { name: 'S+', exact: true }).click();
      await poll(() => toastText(page)).toBe('東1局の MAKA を S+ にしました');
      await page.getByRole('button', { name: '東1局の MAKA S+' }).waitFor();

      await page.keyboard.press('Control+z');
      await page.getByRole('button', { name: '東1局の MAKA を入力' }).waitFor();
      await page.keyboard.press('Control+z');
      await poll(async () => row.locator('.flag').count()).toBe(1);
      await page.getByRole('button', { name: '東2局の自分の評価（✕）' }).waitFor();
    } finally {
      await context.close();
    }
  });

  it('保存してある MAKA の段階と、半荘全体の段階が、表に出る（ダークでも段階の文字が読める）', async () => {
    const scn = scenario({
      sessions: [importedSession({ maka: { kyokus: { k0h0: 'C-', k1h0: 'S' }, hanchan: 'A+' } }), recordedSession()],
    });
    const { context, page } = await open({ scheme: 'dark', scenario: scn });
    try {
      await page.getByRole('button', { name: '東1局の MAKA C-' }).waitFor();
      await page.getByRole('button', { name: '東2局の MAKA S' }).waitFor();
      await page.getByRole('button', { name: '半荘全体の MAKA A+' }).waitFor();
      const axe = await runAxe(page);
      expect(seriousViolations(axe)).toEqual([]);
    } finally {
      await context.close();
    }
  });
});

describe('U-46 迷いだけの画面（実ブラウザ。設定「迷いだけを記録する」が入）', () => {
  /** 迷いだけを入にした設定（これまでの試験は、切のままで、〇△✕ とメモを見る）。迷い 1 にメモを書いておき、隠れていても消えないことを見る。 */
  const doubtScenario = () => {
    const withMemo = importedSession();
    withMemo.memos = { marks: { '1': { candidates: '3m・6p', reason: '東を残したい' } }, extras: [{ id: 'x1', position: { kyoku: 1, honba: 0, junme: 5 }, candidates: '白', reason: '追加' }] };
    return scenario({ settings: { ...settings, doubt_only: true }, sessions: [withMemo, recordedSession()] });
  };

  for (const scheme of SCHEMES) {
    for (const width of [390, 768, 1280] as const) {
      it(`取り込んだ半荘 幅${width}px ${scheme}: 自分の列・旗・メモの欄・足す欄が無く、横スクロールが無く、重大な a11y 違反が無く、Tab で全部に届き、外へ通信しない`, async () => {
        const { context, page, problems, external } = await open({ width, scheme, scenario: doubtScenario() });
        try {
          const table = page.getByRole('table', { name: '局の評価' });
          expect(await table.getByRole('columnheader').allTextContents()).toEqual(['局', '結果', '点', 'AI 基準', 'MAKA', '迷い']);
          expect(await page.locator('.tbl [data-label="自分"], .tbl .self, .tbl .flag, .tbl-note .flag').count()).toBe(0);
          expect(await page.getByText('結果が悪かった局を低く付けていないか').count()).toBe(0);
          expect(await page.locator('.mcard .memo, .marks.extras, .memo-foot, .memo-add').count()).toBe(0);
          expect(await page.getByRole('button', { name: /迷いマークの無い迷いを足す|終局直後のメモの説明/ }).count()).toBe(0);

          const m = await overflow(page);
          expect(m.scroll, `scrollWidth ${m.scroll} > clientWidth ${m.client}`).toBeLessThanOrEqual(m.client);
          expect(m.body).toBeLessThanOrEqual(m.client);
          for (const extra of m.table) expect(extra).toBeLessThanOrEqual(0);

          const axe = await runAxe(page);
          expect(seriousViolations(axe)).toEqual([]);
          expect(axe.passes.find((p) => p.id === 'color-contrast')?.nodes ?? 0).toBeGreaterThan(5);
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

    it(`取り込む前の半荘 幅390px ${scheme}: 評価の一覧も、メモの欄も、足す欄も無く、横スクロールが無く、重大な a11y 違反が無く、Tab で全部に届く`, async () => {
      const { context, page, problems } = await open({ width: 390, scheme, session: 'older', scenario: doubtScenario() });
      try {
        expect(await page.getByRole('heading', { level: 2, name: /^評価（/ }).count()).toBe(0);
        expect(await page.getByRole('list', { name: '局の評価の一覧' }).count()).toBe(0);
        expect(await page.getByText(/取り込み前 · 迷い 3$/).count()).toBe(1);
        expect(await page.locator('.mcard .memo, .memo-foot').count()).toBe(0);
        const m = await overflow(page);
        expect(m.scroll).toBeLessThanOrEqual(m.client);
        const axe = await runAxe(page);
        expect(seriousViolations(axe)).toEqual([]);
        const reach = await unreachableByTab(page);
        expect(reach.missed).toEqual([]);
        expect(problems).toEqual([]);
      } finally {
        await context.close();
      }
    });
  }

  it('390px: 1 局が 2 行のかたまり（AI 基準・MAKA を、1 行目の局・結果の下に左をそろえる）。空の穴が無く、半荘全体の行も同じ形', async () => {
    const { context, page } = await open({ width: 390, scenario: doubtScenario() });
    try {
      const table = page.getByRole('table', { name: '局の評価' });
      expect(await table.getByRole('columnheader').count()).toBe(6);
      expect(await table.getByRole('rowheader').count()).toBe(6);
      const header = await page.locator('.tbl thead').boundingBox();
      expect(header?.width ?? 99).toBeLessThanOrEqual(1);
      // 1 行目: 局・結果・点が同じ高さ。2 行目: AI 基準・MAKA が、その下で同じ高さ。3 行目: 迷い
      const rows = await page.locator('.tbl tbody tr').first().evaluate((tr) =>
        Array.from(tr.children).map((cell) => {
          const r = cell.getBoundingClientRect();
          return { top: Math.round(r.top), left: Math.round(r.left), right: Math.round(r.right), height: r.height };
        }),
      );
      expect(rows).toHaveLength(6);
      expect(new Set(rows.slice(0, 3).map((r) => r.top)).size).toBe(1);
      expect(new Set(rows.slice(3, 5).map((r) => r.top)).size).toBe(1);
      expect(rows[3]?.top ?? 0).toBeGreaterThan(rows[0]?.top ?? 0);
      expect(rows[5]?.top ?? 0).toBeGreaterThan(rows[3]?.top ?? 0);
      // 左をそろえる: AI 基準は局の下、MAKA は結果の下
      expect(rows[3]?.left).toBe(rows[0]?.left);
      expect(rows[4]?.left).toBe(rows[1]?.left);
      // 小さな見出しは AI 基準・MAKA・迷い（自分は無い）
      const labels = await page.locator('.tbl tbody tr').first().evaluate((tr) =>
        Array.from(tr.querySelectorAll('td[data-label]')).map((td) => getComputedStyle(td, '::before').content),
      );
      expect(labels).toEqual(['"AI 基準"', '"MAKA"', '"迷い"']);
      expect(await page.locator('.tbl tbody tr').first().locator('[data-label="MAKA"]').evaluate((el) => getComputedStyle(el).textAlign)).toBe('left');
      // 半荘全体の行: 空のセルが列を押し出さない（見える物は 2 行目の AI 基準・MAKA だけ）
      const foot = await page.locator('.tbl tfoot tr').evaluate((tr) =>
        Array.from(tr.children).map((cell) => {
          const r = cell.getBoundingClientRect();
          return { text: (cell.textContent ?? '').trim(), top: Math.round(r.top), left: Math.round(r.left), height: Math.round(r.height) };
        }),
      );
      expect(foot).toHaveLength(6);
      const visible = foot.filter((c) => c.text !== '');
      expect(visible.map((c) => c.text.replace(/\s+/g, ' ')).slice(0, 1)).toEqual(['半荘全体']);
      // 空のセルは、高さが 0（行の高さを増やさない）
      for (const cell of foot.filter((c) => c.text === '')) expect(cell.height, `空のセルの高さ ${JSON.stringify(cell)}`).toBe(0);
      const aiCell = foot[3];
      const makaCell = foot[4];
      expect(aiCell?.left).toBe(foot[0]?.left);
      expect(makaCell?.top).toBe(aiCell?.top);
      // どの局の行も、同じ形（高さが、札の数に応じて 3 行目だけ違う）
      const heights = await page.locator('.tbl tbody tr').evaluateAll((trs) => trs.map((r) => Math.round(r.getBoundingClientRect().height)));
      expect(Math.min(...heights)).toBeGreaterThan(60);
      const m = await overflow(page);
      expect(m.table).toEqual([0]);
    } finally {
      await context.close();
    }
  });

  it('1280px: 表は 6 列で幅 760px 以内（迷いの列があれば 1000px 以内）。見出しの行が見え、各行は 1 行', async () => {
    const { context, page } = await open({ scenario: doubtScenario() });
    try {
      const table = await page.locator('.tbl').boundingBox();
      expect(table?.width ?? 0).toBeLessThanOrEqual(1001);
      const header = await page.locator('.tbl thead').boundingBox();
      expect(header?.height ?? 0).toBeGreaterThan(20);
      const heads = await page.locator('.tbl thead th').evaluateAll((ths) => ths.map((th) => Math.round(th.getBoundingClientRect().left)));
      expect(new Set(heads).size).toBe(6);
      // 各行の列の左端が、見出しの列の左端と同じ（行に、見出しとずれる穴が無い）
      const aligned = await page.locator('.tbl tbody tr').evaluateAll((trs, expected) =>
        trs.map((tr) => Array.from(tr.children).map((cell) => Math.round(cell.getBoundingClientRect().left)).join(',') === (expected as number[]).join(','))
      , heads);
      expect(aligned.every(Boolean)).toBe(true);
      const heights = await page.locator('.tbl tbody tr').evaluateAll((rows) => rows.map((r) => Math.round(r.getBoundingClientRect().height)));
      expect(Math.max(...heights)).toBeLessThanOrEqual(60);
    } finally {
      await context.close();
    }
  });

  it('迷いのカードは、メモの欄のぶんの余白を残さない: 各カードの中身に高さ 0 の空の要素が無く、幅 390px（1 列。行の高さにそろえて伸びない）では、最後の要素の下は、中身の下の余白だけ', async () => {
    for (const width of [390, 1280]) {
      const { context, page } = await open({ width, scenario: doubtScenario() });
      try {
        const empties = await page.locator('.mcard .mbody > *').evaluateAll((els) =>
          els.filter((el) => el.getBoundingClientRect().height === 0).map((el) => el.className),
        );
        expect(empties, `@${width}`).toEqual([]);
        const gaps = await page.locator('.mcard').evaluateAll((cards) =>
          cards.map((card) => {
            const body = card.querySelector('.mbody') as HTMLElement;
            const last = body.lastElementChild as HTMLElement;
            return Math.round(body.getBoundingClientRect().bottom - last.getBoundingClientRect().bottom);
          }),
        );
        // 最後の要素の下は、中身の下の余白（12px）だけ。幅 1280px（3 列）は、同じ行の背の高いカードにそろえて伸びるので、見ない
        if (width === 390) for (const gap of gaps) expect(gap, `@${width}`).toBeLessThanOrEqual(13);
      } finally {
        await context.close();
      }
    }
  });

  it('設定を切ると（settings-changed）、その場で、自分の列・旗・メモの欄・足す欄が元どおり出て、書いてあったメモが入っている。入れ直すとまた隠れる', async () => {
    const { context, page, problems } = await open({ width: 1280, scenario: doubtScenario() });
    try {
      const flip = (doubtOnly: boolean) =>
        page.evaluate(async (value) => {
          const w = window as unknown as {
            __TAURI_INTERNALS__: { invoke: (cmd: string) => Promise<Record<string, unknown>> };
            __jrEmit: (event: string, payload: unknown) => void;
          };
          const current = await w.__TAURI_INTERNALS__.invoke('get_settings');
          w.__jrEmit('settings-changed', { ...current, doubt_only: value });
        }, doubtOnly);
      const headers = () => page.getByRole('table', { name: '局の評価' }).getByRole('columnheader').allTextContents();
      expect(await headers()).toEqual(['局', '結果', '点', 'AI 基準', 'MAKA', '迷い']);
      await flip(false);
      await page.getByRole('group', { name: '迷い1のメモ' }).waitFor();
      expect(await headers()).toEqual(['局', '結果', '点', '自分', 'AI 基準', 'MAKA', '迷い']);
      expect(await page.getByLabel('候補').first().inputValue()).toBe('3m・6p');
      expect(await page.getByRole('button', { name: /迷いマークの無い迷いを足す/ }).count()).toBe(1);
      expect(await page.locator('.tbl .flag').count()).toBeGreaterThan(0);
      await flip(true);
      await page.waitForFunction(() => document.querySelector('.mcard .memo') === null);
      expect(await headers()).toEqual(['局', '結果', '点', 'AI 基準', 'MAKA', '迷い']);
      expect(problems).toEqual([]);
    } finally {
      await context.close();
    }
  });
});

describe('U-1 この画面に AI の答えは出さない（実ブラウザ）', () => {
  it('data-ai の属性も、確率らしい文字（%・確率・順位・prob）も、画面のどこにも無い（メニューを開いたあとも）', async () => {
    const { context, page } = await open();
    try {
      const scan = () =>
        page.evaluate(() => {
          // MAKA の当てはめの見込みの 1 行（U-31）の「34%」は、AI の確率ではないので、検査から外す（tests/fit-line.ts）。
          // 見出しの AI 一致率・類似度・悪手率の 1 行（U-48）と、その説明の文（「確率」が入る）も、半荘全体の割合なので、外す
          const html = document.body.innerHTML
            .replace(/ src="[^"]*"/g, '')
            .replace(/<p class="tbl-note fit"[\s\S]*?<\/p>/g, '')
            .replace(/<div class="head-metrics">[\s\S]*?<\/div>/g, '')
            .replace(/<span class="infotip-pop"[^>]*>AI（Mortal）と比べた数です[\s\S]*?<\/span>/g, '');
          const attrs = Array.from(document.querySelectorAll('*')).flatMap((el) => el.getAttributeNames());
          return {
            dataAi: /data-ai/i.test(html) || attrs.some((a) => /^data-ai/i.test(a)),
            probability: /\d\s*[%％]|確率|順位|probab|\bprob\b|q_value/i.test(html),
          };
        });
      expect(await scan()).toEqual({ dataAi: false, probability: false });
      await STATES.pick?.(page);
      expect(await scan()).toEqual({ dataAi: false, probability: false });
      await page.keyboard.press('Escape');
      await STATES.makaMenu?.(page);
      expect(await scan()).toEqual({ dataAi: false, probability: false });
    } finally {
      await context.close();
    }
  });
});

describe('E-27 離れている（実ブラウザ。読み直したあとの FX-4 の迷い 6）', () => {
  const FAR_LINE = 'スクショの値（残り38）と離れています。選んだ局面は残り29です。';
  const farScenario = () =>
    scenario({
      sessions: [importedSession({ ocr: fx4Ocr({ retries: true }), marks: { '6': 'k2h1e14' } }), recordedSession()],
    });

  for (const scheme of SCHEMES) {
    for (const width of [390, 1280] as const) {
      it(`幅${width}px ${scheme}: 1 行と札がカードに収まり、横スクロールが無く、重大な a11y 違反が無く、Tab で全部に届く。アイコンは文字と同じ色の線で、1 行目の高さ`, async () => {
        const { context, page, problems, external } = await open({ width, scheme, scenario: farScenario() });
        try {
          const line = card(page, 6).locator('.mfar');
          await line.waitFor();
          expect(await line.textContent()).toBe(FAR_LINE);
          expect(await card(page, 6).locator('.chip').allTextContents()).toEqual(['9巡目 打北（推定）', '8巡目 鳴かない判断']);

          // 形: カードの中に収まる。アイコンは、文字の 1 行目の高さにあり、折り返しても動かない。色は文字と同じ（新しい色を足さない）。
          const shape = await page.evaluate(() => {
            const cardEl = Array.from(document.querySelectorAll<HTMLElement>('article.mcard'))[5] as HTMLElement;
            const mfar = cardEl.querySelector('.mfar') as HTMLElement;
            const icon = mfar.querySelector('svg') as SVGElement;
            const text = mfar.querySelector('span') as HTMLElement;
            const c = cardEl.getBoundingClientRect();
            const m = mfar.getBoundingClientRect();
            const i = icon.getBoundingClientRect();
            const t = text.getBoundingClientRect();
            const lineHeight = parseFloat(getComputedStyle(text).lineHeight);
            return {
              inside: m.left >= c.left - 0.5 && m.right <= c.right + 0.5,
              chipsInside: Array.from(cardEl.querySelectorAll<HTMLElement>('.malt .chip')).every(
                (chip) => chip.getBoundingClientRect().right <= c.right + 0.5 && chip.getBoundingClientRect().left >= c.left - 0.5,
              ),
              iconCenterFromTop: i.top + i.height / 2 - t.top,
              firstLineCenter: lineHeight / 2,
              iconBeforeText: i.right <= t.left + 0.5,
              iconStroke: getComputedStyle(icon).stroke,
              textColor: getComputedStyle(text).color,
              iconFill: getComputedStyle(icon).fill,
              lines: Math.round(t.height / lineHeight),
              order: Array.from(cardEl.querySelectorAll('.msub, .mfar, .malt')).map((el) => el.className.split(' ')[0]),
            };
          });
          expect(shape.inside).toBe(true);
          expect(shape.chipsInside).toBe(true);
          expect(shape.iconBeforeText).toBe(true);
          expect(Math.abs(shape.iconCenterFromTop - shape.firstLineCenter)).toBeLessThan(2.5);
          expect(shape.iconStroke).toBe(shape.textColor);
          expect(shape.iconFill).toBe('none');
          expect(shape.order).toEqual(['msub', 'mfar', 'malt']);
          // 文は長いので、カードの幅（390px の 1 列でも、1280px の 3 列でも）では 2 行に折り返す。
          expect(shape.lines).toBeGreaterThanOrEqual(2);

          const m = await overflow(page);
          expect(m.scroll, `scrollWidth ${m.scroll} > clientWidth ${m.client}`).toBeLessThanOrEqual(m.client);
          expect(m.body).toBeLessThanOrEqual(m.client);

          const axe = await runAxe(page);
          expect(seriousViolations(axe)).toEqual([]);
          expect(axe.passes.find((p) => p.id === 'color-contrast')?.nodes ?? 0).toBeGreaterThan(5);
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

  it('離れていないカード（1〜5）には 1 行が無い。札を押すと保存して通知が出て、1 行と札が消える。Ctrl+Z で、1 行と札が戻る', async () => {
    const { context, page, problems } = await open({ scenario: farScenario() });
    try {
      expect(await page.locator('.mfar').count()).toBe(1);
      await card(page, 6).getByRole('button', { name: '9巡目 打北（推定）' }).click();
      await poll(() => toastText(page)).toBe('迷い6を東3局1本場 9巡目の局面に結びつけました');
      await card(page, 6).getByText('自分：打北').waitFor();
      expect(await page.locator('.mfar').count()).toBe(0);
      expect(await calls(page, 'set_mark_link')).toEqual([{ sessionId: ID, markId: 6, decision: 'k2h1e10' }]);
      await poll(() => isFocused(card(page, 6).getByRole('button', { name: '迷い6を選び直す' }))).toBe(true);

      await page.keyboard.press('Control+z');
      await poll(() => toastText(page)).toBe('迷い6の結びつけを元に戻しました');
      await card(page, 6).locator('.mfar').waitFor();
      expect(await card(page, 6).locator('.mfar').textContent()).toBe(FAR_LINE);
      expect(await calls(page, 'set_mark_link')).toEqual([
        { sessionId: ID, markId: 6, decision: 'k2h1e10' },
        { sessionId: ID, markId: 6, decision: 'k2h1e14' },
      ]);
      expect(problems).toEqual([]);
    } finally {
      await context.close();
    }
  });
});

describe('F11・U-23 前の作り方で読んだ半荘の読み直し（実ブラウザ）', () => {
  const STATUS = 'スクショを新しい読み取りで読み直しています';
  const FAR_LINE = 'スクショの値（残り38）と離れています。選んだ局面は残り29です。';
  const staleScenario = (hang: boolean) =>
    scenario({
      sessions: [
        importedSession({ ocr: { ...fx4Ocr(), geometry: 'center-v1-lanczos3x' }, marks: { '6': 'k2h1e14' } }),
        recordedSession(),
      ],
      reread: { currentGeometry: OCR_GEOMETRY, fresh: fx4Ocr({ retries: true }), hang },
    });

  for (const scheme of SCHEMES) {
    for (const width of [390, 1280] as const) {
      it(`読み直している間 幅${width}px ${scheme}: 状態の 1 行が 1 つだけ出て、前の値で描いてあり、横スクロールが無く、重大な a11y 違反が無く、読み直しは 1 回だけ`, async () => {
        const { context, page, problems, external } = await open({ width, scheme, scenario: staleScenario(true) });
        try {
          const status = page.getByRole('status');
          await status.waitFor();
          expect(await status.count()).toBe(1);
          expect(await status.textContent()).toBe(STATUS);
          // 前の読み取りの値のまま: 迷い 6 は読めず、離れているとも出ない。
          expect(await card(page, 6).locator('.mread').textContent()).toBe('スクショを読めませんでした');
          expect(await page.locator('.mfar').count()).toBe(0);

          // 見出しと同じ行（広い幅）。狭い幅では、見出しの下の行に回ってよいが、横にははみ出さない。
          const places = await page.evaluate(() => {
            const heading = document.querySelector('.sec-head .sec-title') as HTMLElement;
            const line = document.querySelector('.sec-head [role="status"]') as HTMLElement;
            const marks = document.querySelector('.marks') as HTMLElement;
            const h = heading.getBoundingClientRect();
            const l = line.getBoundingClientRect();
            return {
              sameRow: Math.abs(h.top - l.top) < 8,
              toTheRight: l.left >= h.right - 0.5,
              belowHeading: l.top >= h.bottom - 0.5,
              inside: l.right <= document.documentElement.clientWidth + 0.5,
              marksBelow: marks.getBoundingClientRect().top >= Math.max(h.bottom, l.bottom) - 0.5,
            };
          });
          expect(places.inside).toBe(true);
          expect(places.marksBelow).toBe(true);
          if (width >= 768) {
            expect(places.sameRow).toBe(true);
            expect(places.toTheRight).toBe(true);
          } else {
            expect(places.sameRow || places.belowHeading).toBe(true);
          }

          const m = await overflow(page);
          expect(m.scroll, `scrollWidth ${m.scroll} > clientWidth ${m.client}`).toBeLessThanOrEqual(m.client);
          const axe = await runAxe(page);
          expect(seriousViolations(axe)).toEqual([]);
          const reach = await unreachableByTab(page);
          expect(reach.missed).toEqual([]);

          expect(await calls(page, 'needs_ocr_reread')).toEqual([{ sessionId: ID }]);
          expect(await calls(page, 'reread_ocr')).toEqual([{ sessionId: ID }]);
          expect(problems).toEqual([]);
          expect(external).toEqual([]);
        } finally {
          await context.close();
        }
      });
    }
  }

  it('読み直しが済むと、状態の 1 行が消え、新しい読み取りの値で描き直す（迷い 6 が離れていると分かる）。結びつけは保存し直さず、開き直しても読み直さない', async () => {
    const { context, page, problems } = await open({ scenario: staleScenario(false) });
    try {
      await card(page, 6).locator('.mfar').waitFor();
      expect(await card(page, 6).locator('.mfar').textContent()).toBe(FAR_LINE);
      expect(await card(page, 6).locator('.mread').textContent()).toBe('スクショ: 東3局・残り38・4,400点');
      await page.getByRole('status').waitFor({ state: 'detached' });
      expect(await calls(page, 'reread_ocr')).toHaveLength(1);
      for (const cmd of ['set_mark_link', 'clear_mark_link', 'replace_links', 'set_rating_link', 'clear_rating_link']) {
        expect(await calls(page, cmd), cmd).toEqual([]);
      }
      // 別の半荘へ移って戻っても、もう読み直さない。
      await ensureSidebar(page);
      await page.locator('.session-scroll [data-open]').nth(1).click();
      await page.getByRole('heading', { level: 1, name: /10月8日/ }).waitFor();
      await ensureSidebar(page);
      await page.locator('.session-scroll [data-open]').nth(0).click();
      await page.getByRole('table', { name: '局の評価' }).waitFor();
      expect(await calls(page, 'reread_ocr')).toHaveLength(1);
      expect(await calls(page, 'needs_ocr_reread')).toHaveLength(1);
      expect(await page.getByRole('status').count()).toBe(0);
      expect(problems).toEqual([]);
    } finally {
      await context.close();
    }
  });
});

describe('U-25: 説明のアイコン（局の評価の表の迷いの札）', () => {
  const HINT = '迷いの札を押すと、その迷いのカードへ移ります。点線の札は巡目が未定、チェックの付いた札は選んだもの、ほかは推定です。';
  for (const width of [390, 768, 1280]) {
    it(`幅 ${width}px: 説明の文は本文に出ず、見出し「局の評価」のそばの (i) に乗せるかキーボードで選ぶと、窓の中に、表（札）にかからずに重なって出る。Esc で閉じる。axe の重大な違反が 0 件（ライト・ダーク）`, { timeout: 120_000 }, async () => {
      for (const scheme of SCHEMES) {
        const { context, page, problems } = await open({ width, scheme });
        try {
          const head = page.locator('.sec-head').filter({ has: page.getByRole('heading', { name: '局の評価' }) });
          const icon = head.getByRole('button', { name: '迷いの札の説明' });
          await icon.waitFor();
          // 見える文字には、説明が無い（重なりの文は、閉じている間は hidden で、innerText に入らない）
          expect(await page.locator('.tbl-wrap').evaluate((el) => (el.closest('section') as HTMLElement).innerText)).not.toContain('迷いの札を押すと');
          expect(await page.getByRole('tooltip').count()).toBe(0);
          await icon.evaluate((el) => el.scrollIntoView({ block: 'center' }));
          await icon.hover();
          await page.getByRole('tooltip').waitFor();
          let m = await measureInfoTip(page, '.tbl-wrap');
          expect(m, `${width} ${scheme}`).not.toBeNull();
          expect(m!.text).toBe(HINT);
          expect(m!.tip.left).toBeGreaterThanOrEqual(7);
          expect(m!.tip.right).toBeLessThanOrEqual(m!.innerWidth - 7);
          expect(m!.tip.top).toBeGreaterThanOrEqual(0);
          expect(m!.tip.bottom).toBeLessThanOrEqual(m!.innerHeight);
          // 表（札を含む）にも、アイコンにも、かからない。見出しの上に出る
          expect(m!.side).toBe('above');
          expect(boxesOverlap(m!.tip, m!.explained as BoxRect)).toBe(false);
          expect(boxesOverlap(m!.tip, m!.icon)).toBe(false);
          expect(seriousViolations(await runAxe(page)), `${width} ${scheme}`).toEqual([]);
          await page.keyboard.press('Escape');
          expect(await page.getByRole('tooltip').count()).toBe(0);
          await page.mouse.move(2, 2);
          await icon.focus();
          await page.keyboard.press('Shift+Tab');
          await page.keyboard.press('Tab');
          expect(await icon.evaluate((el) => el === document.activeElement)).toBe(true);
          await page.getByRole('tooltip').waitFor();
          m = await measureInfoTip(page, '.tbl-wrap');
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

describe('U-31 MAKA の当てはめの見込み（実ブラウザ。局の評価の表の下の 1 行）', () => {
  const START =
    'MAKA の評価 67局ぶんで合わせた見込み: ぴったり 34%・±1段階以内 66%（1半荘ずつ外して確かめた値。MAKA の評価を入れるたびに合わせ直します）';
  const fitLine = (page: Page) =>
    page.evaluate(() => (document.getElementById('fit-line')?.textContent ?? '').replace(/\s+/g, ' ').trim());

  for (const scheme of SCHEMES) {
    for (const width of [390, 768, 1280] as const) {
      it(`幅 ${width}px ${scheme}: 見込みの 1 行は、表の下にあり、窓の幅に収まる。承認済みの文のとおり。入れたあとの「合わせ直しました」も収まる`, async () => {
        const { context, page, problems } = await open({ width, scheme });
        try {
          expect(await fitLine(page)).toBe(START);
          const geometry = () =>
            page.evaluate(() => {
              const line = document.getElementById('fit-line') as HTMLElement;
              const table = document.querySelector('.tbl-wrap') as HTMLElement;
              const rect = line.getBoundingClientRect();
              return {
                below: rect.top >= table.getBoundingClientRect().bottom - 1,
                inside: rect.left >= 0 && rect.right <= document.documentElement.clientWidth,
                scroll: document.documentElement.scrollWidth - document.documentElement.clientWidth,
                icon: line.querySelector('.fit-ic svg') !== null,
                done: document.querySelector('.fit-done .tag')?.textContent ?? null,
                doneInside: (() => {
                  const done = document.querySelector('.fit-done');
                  return done === null ? true : done.getBoundingClientRect().right <= document.documentElement.clientWidth;
                })(),
              };
            });
          const before = await geometry();
          expect(before).toMatchObject({ below: true, inside: true, icon: true, done: null });
          expect(before.scroll).toBeLessThanOrEqual(0);
          // 東2局に S+ と入れる: 68局・ぴったり 34%・±1段階以内 65%。「合わせ直しました」が出る
          await (await reveal(page, page.getByRole('button', { name: '東2局の MAKA を入力' }))).click();
          await page.getByRole('menuitemradio', { name: 'S+', exact: true }).click();
          await poll(() => fitLine(page)).toBe(
            'MAKA の評価 68局ぶんで合わせた見込み: ぴったり 34%・±1段階以内 65%（1半荘ずつ外して確かめた値。MAKA の評価を入れるたびに合わせ直します）',
          );
          const after = await geometry();
          expect(after).toMatchObject({ below: true, inside: true, done: '合わせ直しました', doneInside: true });
          expect(after.scroll).toBeLessThanOrEqual(0);
          // 半荘全体の段階も、新しい当てはめ（S- から S）
          expect(await page.locator('.head-score .grade').textContent()).toBe('S');
          const axe = await runAxe(page);
          expect(seriousViolations(axe)).toEqual([]);
          expect(problems).toEqual([]);
          // Ctrl+Z で、基礎の 67局に戻る。「合わせ直しました」は出たまま
          await page.keyboard.press('Control+z');
          await poll(() => fitLine(page)).toBe(START);
          expect(await page.locator('.fit-done .tag').count()).toBe(1);
          expect(await page.locator('.head-score .grade').textContent()).toBe('S-');
        } finally {
          await context.close();
        }
      });
    }
  }
});

describe('U-48: AI 一致率・類似度・悪手率の1行（実ブラウザ。半荘のページの見出し）', () => {
  const LINE = 'AI 一致率 88.6% · 類似度 93.0 · 悪手率 7.1%';
  const HINT =
    'AI（Mortal）と比べた数です。AI 一致率は、自分の判断のうち、AI の1位と同じだった割合（62/70）。類似度は、Mortal の Rating と同じ値で、AI の1位なら満点、違えば AI の評価に応じた部分点です（NAGA の類似度に当たります）。悪手率は、実戦の行動の AI の確率が 5% より低かった判断の割合（5/70）で、大きな不一致と同じ基準です（NAGA の悪手と同じ線）。';

  /** 見出しの箱（題・副題・1 行・右の操作）の位置と、1 行の文字・色・数字の形。 */
  const measureHead = (page: Page) =>
    page.evaluate(() => {
      const box = (el: Element | null): BoxRect | null => {
        if (el === null) return null;
        const r = el.getBoundingClientRect();
        return { left: r.left, right: r.right, top: r.top, bottom: r.bottom };
      };
      const colorOf = (token: string) => {
        const probe = document.createElement('span');
        probe.style.color = `var(${token})`;
        document.body.append(probe);
        const color = getComputedStyle(probe).color;
        probe.remove();
        return color;
      };
      const label = document.querySelector('.metric-lbl') as HTMLElement;
      const value = document.querySelector('.metric-val') as HTMLElement;
      const list = document.querySelector('.metric-list') as HTMLElement;
      return {
        client: document.documentElement.clientWidth,
        scroll: document.documentElement.scrollWidth,
        body: document.body.scrollWidth,
        text: (list.textContent ?? '').replace(/\s+/g, ' ').trim(),
        left: box(document.querySelector('.head-l')),
        title: box(document.querySelector('.head-l .title')),
        subtitle: box(document.querySelector('.head-l > p.quiet')),
        row: box(document.querySelector('.head-metrics')),
        list: box(list),
        actions: box(document.querySelector('.head-actions')),
        items: Array.from(list.querySelectorAll('li')).map((li) => box(li) as BoxRect),
        labelColor: getComputedStyle(label).color,
        valueColor: getComputedStyle(value).color,
        muted: colorOf('--muted'),
        ink: colorOf('--ink'),
        valueFamily: getComputedStyle(value).fontFamily,
        valueNumeric: getComputedStyle(value).fontVariantNumeric,
      };
    });

  for (const scheme of SCHEMES) {
    for (const width of [390, 768, 1280] as const) {
      it(`幅 ${width}px ${scheme}: 題と副題の下に 1 行（承認済みの文のとおり）。窓に収まり、横スクロールが無く、右の操作と重ならない。ラベルは静かな色、値は文字の色の等幅の数字。axe の重大な違反が 0 件`, async () => {
        const { context, page, problems, external } = await open({ width, scheme });
        try {
          const m = await measureHead(page);
          expect(m.text).toBe(LINE);
          const left = m.left as BoxRect;
          const list = m.list as BoxRect;
          const row = m.row as BoxRect;
          const actions = m.actions as BoxRect;
          // 題 → 副題 → この 1 行の順で、見出しの左の欄の中に収まる
          expect(list.top).toBeGreaterThanOrEqual((m.subtitle as BoxRect).bottom - 1);
          expect((m.subtitle as BoxRect).top).toBeGreaterThanOrEqual((m.title as BoxRect).bottom - 1);
          expect(row.left).toBeGreaterThanOrEqual(left.left - 0.5);
          expect(row.right).toBeLessThanOrEqual(left.right + 0.5);
          for (const item of m.items) expect(item.right).toBeLessThanOrEqual(m.client);
          expect(row.right).toBeLessThanOrEqual(m.client);
          // 項目の途中では折り返さない（狭い幅では、項目の間で 2 行になってもよい。広い幅では 1 行）
          for (const item of m.items) expect(item.bottom - item.top).toBeLessThan(26);
          if (width >= 768) expect(new Set(m.items.map((item) => Math.round(item.top))).size).toBe(1);
          // 横スクロールが無い。見出しの右の操作（通して見る・段階の印と Rating）と重ならない
          expect(m.scroll, `scrollWidth ${m.scroll} > clientWidth ${m.client}`).toBeLessThanOrEqual(m.client);
          expect(m.body).toBeLessThanOrEqual(m.client);
          expect(boxesOverlap(left, actions)).toBe(false);
          expect(boxesOverlap(row, actions)).toBe(false);
          // 色はトークンだけ: ラベルは --muted、値は --ink。値は等幅の数字（IBM Plex Mono・tabular-nums）
          expect(m.labelColor).toBe(m.muted);
          expect(m.valueColor).toBe(m.ink);
          expect(m.valueFamily).toContain('IBM Plex Mono');
          expect(m.valueNumeric).toContain('tabular-nums');

          // axe: 全体で重大な違反が無い。この 1 行だけに絞っても、違反が無く、色のコントラストの規則が実際にこの 1 行に働いている
          const axe = await runAxe(page);
          expect(seriousViolations(axe)).toEqual([]);
          const scoped = await page.evaluate(async () => {
            interface Rule {
              id: string;
              impact?: string | null;
              nodes: unknown[];
            }
            const axeCore = (window as unknown as { axe: { run: (context: unknown) => Promise<{ violations: Rule[]; passes: Rule[] }> } }).axe;
            const result = await axeCore.run({ include: [['.head-metrics']] });
            return {
              violations: result.violations.map((v) => `${v.id} (${v.impact ?? ''})`),
              contrast: result.passes.find((p) => p.id === 'color-contrast')?.nodes.length ?? 0,
            };
          });
          expect(scoped.violations).toEqual([]);
          expect(scoped.contrast).toBeGreaterThanOrEqual(3);

          // 一覧は名前つきで、項目が 3 つ
          expect(await page.getByRole('list', { name: 'AI との比べ' }).getByRole('listitem').count()).toBe(3);
          expect(problems).toEqual([]);
          expect(external).toEqual([]);
        } finally {
          await context.close();
        }
      });

      it(`幅 ${width}px ${scheme}: 説明のアイコンに乗せるか、キーボードで選ぶと、3 つの意味の文が、窓の中に、1 行にもアイコンにもかからずに重なって出る。Esc で閉じる`, async () => {
        const { context, page, problems } = await open({ width, scheme });
        try {
          const icon = page.getByRole('button', { name: 'AI 一致率・類似度・悪手率の説明' });
          await icon.waitFor();
          // 見える文字には、説明が無い（閉じている間は hidden）
          expect(await page.locator('.head-l').evaluate((el) => (el as HTMLElement).innerText)).not.toContain('AI（Mortal）と比べた数です');
          expect(await page.getByRole('tooltip').count()).toBe(0);
          await icon.hover();
          await page.getByRole('tooltip').waitFor();
          let m = await measureInfoTip(page, '.metric-list');
          expect(m, `${width} ${scheme}`).not.toBeNull();
          expect(m!.text).toBe(HINT);
          expect(m!.tip.left).toBeGreaterThanOrEqual(7);
          expect(m!.tip.right).toBeLessThanOrEqual(m!.innerWidth - 7);
          expect(m!.tip.top).toBeGreaterThanOrEqual(0);
          expect(m!.tip.bottom).toBeLessThanOrEqual(m!.innerHeight);
          expect(boxesOverlap(m!.tip, m!.icon)).toBe(false);
          expect(boxesOverlap(m!.tip, m!.explained as BoxRect)).toBe(false);
          expect(seriousViolations(await runAxe(page)), `${width} ${scheme}`).toEqual([]);
          await page.keyboard.press('Escape');
          expect(await page.getByRole('tooltip').count()).toBe(0);
          // キーボード: アイコンへ Tab で届き、選ぶと出る
          await page.mouse.move(2, 2);
          await icon.focus();
          await page.keyboard.press('Shift+Tab');
          await page.keyboard.press('Tab');
          expect(await isFocused(icon)).toBe(true);
          await page.getByRole('tooltip').waitFor();
          m = await measureInfoTip(page, '.metric-list');
          expect(m!.text).toBe(HINT);
          expect(boxesOverlap(m!.tip, m!.explained as BoxRect)).toBe(false);
          await page.keyboard.press('Escape');
          expect(await page.getByRole('tooltip').count()).toBe(0);
          expect(problems).toEqual([]);
        } finally {
          await context.close();
        }
      });
    }
  }

  it('取り込む前の半荘には、1 行も説明のアイコンも無い（見出しは、題と「取り込み前」の副題だけ）', async () => {
    const { context, page } = await open({ session: 'older' });
    try {
      expect(await page.locator('.head-metrics').count()).toBe(0);
      expect(await page.getByRole('list', { name: 'AI との比べ' }).count()).toBe(0);
      expect(await page.getByRole('button', { name: 'AI 一致率・類似度・悪手率の説明' }).count()).toBe(0);
      expect(await page.locator('.head-l > *').count()).toBe(2);
    } finally {
      await context.close();
    }
  });

  it('迷いだけの設定が入でも、1 行と説明のアイコンが出る（幅 390px）', async () => {
    const { context, page, problems } = await open({ width: 390, scenario: scenario({ settings: { ...settings, doubt_only: true } }) });
    try {
      expect((await measureHead(page)).text).toBe(LINE);
      expect(await page.getByRole('button', { name: 'AI 一致率・類似度・悪手率の説明' }).count()).toBe(1);
      expect(problems).toEqual([]);
    } finally {
      await context.close();
    }
  });
});
