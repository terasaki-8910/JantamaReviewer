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
import { OCR_GEOMETRY, fx4Ocr, fx4Session } from '../import-fixtures';
import {
  TINY_PNG,
  launchBrowser,
  runAxe,
  seriousViolations,
  startPageServer,
  tauriMockScript,
  unreachableByTab,
  waitForMainReady,
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
    await page.locator('.session-scroll [data-open]').nth(1).click();
    await page.getByRole('heading', { level: 1, name: /10月8日/ }).waitFor();
  } else {
    await page.getByRole('table', { name: '局の評価' }).waitFor();
  }
  // 画面に出ている画像が読み終わるまで待つ。
  await page.waitForFunction(() => Array.from(document.images).every((img) => img.complete));
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
};

describe('U-4・U-5・U-6: 半荘のページの各状態（実ブラウザ）', () => {
  for (const scheme of SCHEMES) {
    for (const width of [390, 768, 1280] as const) {
      for (const [name, drive] of Object.entries(STATES)) {
        // メニューと画像の表示は、幅 390 と 1280 だけ（768 は、通常の状態と同じ作り）。
        if (width === 768 && name !== 'default') continue;
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
            expect(reach.total).toBeGreaterThan(3);
            // メニューと画像の表示は、中だけに留まるので、Tab で全部には届かない。
            if (name === 'default') expect(reach.missed).toEqual([]);
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
  it('1280px: 表の幅は 760px 以内。見出しの行が見え、各行は 1 行', async () => {
    const { context, page } = await open();
    try {
      const table = await page.locator('.tbl').boundingBox();
      expect(table?.width ?? 0).toBeLessThanOrEqual(761);
      const header = await page.locator('.tbl thead').boundingBox();
      expect(header?.height ?? 0).toBeGreaterThan(20);
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
      expect(await table.getByRole('columnheader').count()).toBe(6);
      expect(await table.getByRole('rowheader').count()).toBe(6);
      expect(await table.getByRole('row').count()).toBe(7);
      const header = await page.locator('.tbl thead').boundingBox();
      expect(header?.width ?? 99).toBeLessThanOrEqual(1);
      // 1 行目: 局・結果・点が同じ高さ。2 行目: 自分・AI 基準・MAKA が、その下で同じ高さ。
      const rows = await page.locator('.tbl tbody tr').first().evaluate((tr) =>
        Array.from(tr.children).map((cell) => Math.round(cell.getBoundingClientRect().top)),
      );
      expect(new Set(rows.slice(0, 3)).size).toBe(1);
      expect(new Set(rows.slice(3)).size).toBe(1);
      expect(rows[3] ?? 0).toBeGreaterThan(rows[0] ?? 0);
      // 2 行目の小さな見出し（自分・AI 基準・MAKA）。
      const labels = await page.locator('.tbl tbody tr').first().evaluate((tr) =>
        Array.from(tr.querySelectorAll('td[data-label]')).map((td) => getComputedStyle(td, '::before').content),
      );
      expect(labels).toEqual(['"自分"', '"AI 基準"', '"MAKA"']);
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

describe('U-1 この画面に AI の答えは出さない（実ブラウザ）', () => {
  it('data-ai の属性も、確率らしい文字（%・確率・順位・prob）も、画面のどこにも無い（メニューを開いたあとも）', async () => {
    const { context, page } = await open();
    try {
      const scan = () =>
        page.evaluate(() => {
          const html = document.body.innerHTML.replace(/ src="[^"]*"/g, '');
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
      await page.locator('.session-scroll [data-open]').nth(1).click();
      await page.getByRole('heading', { level: 1, name: /10月8日/ }).waitFor();
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
