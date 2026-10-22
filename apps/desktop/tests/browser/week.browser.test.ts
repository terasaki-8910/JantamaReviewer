// @vitest-environment node
/**
 * 実ブラウザで、週の集計（U-30、R11-12。U-4・U-5・U-6 も）を検査する。
 *
 * - U-4: 幅 390・768・1280px で、週の集計の各状態（今週・「表で見る」・吹き出し・答えの無い週）に横スクロールが出ない。
 *   図は読める大きさ（小さな折れ線の幅と高さ・目盛りの文字が重ならない・横棒の名前と数字が切れない）
 * - U-5・U-6: axe の重大な違反が 0 件（色のコントラストを含む。ライトとダーク）。Tab で、すべての操作と図の点（1 つの止まり場所）に届く
 * - 図の約束（dataviz）: 色は 1 色（棒・線とも、面と背景に 3:1 以上）・線は 2px で丸い・点は 8px 以上で面の色の輪つき・棒は細い・格子は実線
 * - 吹き出し: マウスを乗せる・キーボードで選ぶと出て、窓の中に収まる。Esc で消える
 * - 入力: 成績と重点を、本物のキーで入れて保存し、画面を替えて戻っても残る
 * jsdom の試験（src/main/week）と同じふるまいを、実際の描画・キー・時計で確かめる。
 */
import type { Browser, BrowserContext, Page } from 'playwright-core';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import {
  ensureSidebar,
  launchBrowser,
  runAxe,
  seriousViolations,
  startPageServer,
  tauriMockScript,
  unreachableByTab,
  waitForMainReady,
  waitForSidebarCounts,
  type PageServer,
} from './harness';
import { NOW, scenario, type ScenarioOptions } from './week-fixtures';

const SCHEMES = ['light', 'dark'] as const;
type Scheme = (typeof SCHEMES)[number];

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

async function open(options: { width?: number; height?: number; scheme?: Scheme } & ScenarioOptions = {}): Promise<Opened> {
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
  await page.addInitScript(tauriMockScript(scenario(options)));
  await page.goto(new URL('index.html', server.url).toString());
  await waitForMainReady(page);
  // 出題のデータ（半荘の再生・答えの記録）が読み終わると、サイドバーに数が出る
  await waitForSidebarCounts(page, 30_000);
  return { context, page, problems, external };
}

/** 週の集計を開く（サイドバーの「週の集計」）。数の札が出るまで待つ。 */
async function openWeek(page: Page): Promise<void> {
  // 細い窓（640px 未満）では、サイドバーは引き出しに隠れている。開いてから押す（押すと閉じる）
  await ensureSidebar(page);
  await page.getByRole('navigation', { name: 'メイン' }).getByRole('button', { name: '週の集計' }).click();
  await page.getByRole('heading', { level: 1, name: '週の集計' }).waitFor();
  await page.locator('.wk-tile').first().waitFor({ timeout: 30_000 });
  await page.getByRole('textbox', { name: '4位率' }).waitFor();
}

const text = (page: Page, selector: string) => page.locator(selector).first().evaluate((el) => (el.textContent ?? '').replace(/\s+/g, ' ').trim());

// ---- 横スクロール・図の大きさ・axe・テーマ ----

interface StateDef {
  name: string;
  run: (page: Page) => Promise<void>;
}

const STATES: StateDef[] = [
  { name: '今週', run: async () => undefined },
  {
    name: '表で見る（すべての図）',
    run: async (page) => {
      // 押すたびに、押したボタンの名前が「グラフで見る」に替わるので、「表で見る」が残っている間、先頭を押す
      while ((await page.getByRole('button', { name: '表で見る' }).count()) > 0) await page.getByRole('button', { name: '表で見る' }).first().click();
    },
  },
  {
    name: '吹き出し（折れ線を選んだ状態）',
    run: async (page) => {
      await page.getByRole('group', { name: /^受け入れ枚数の割合（直近8週）/ }).focus();
      await page.waitForFunction(() => document.querySelector('.wk-tip:not([hidden])') !== null);
    },
  },
  {
    name: '取り込んだ半荘から数えた値（半荘ごとに見るを開いた状態。7半荘）',
    run: async (page) => {
      await page.getByRole('table', { name: /値ともとの数/ }).waitFor({ timeout: 30_000 });
      await page.getByRole('button', { name: /^半荘ごとに見る/ }).click();
      await page.getByRole('table', { name: '取り込んだ半荘ごとの成績' }).waitFor();
    },
  },
  {
    name: '先週（記録が今週だけの週の前。答えの無い週）',
    run: async (page) => {
      await page.getByRole('button', { name: '前の週' }).click();
      await page.getByText('この週は、答えた問題がありません。').first().waitFor();
      await page.getByText('この週に取り込んだ半荘はありません。').waitFor();
    },
  },
];

async function openState(state: StateDef, options: { width?: number; scheme?: Scheme } = {}): Promise<Opened> {
  const sparse = state.name.startsWith('先週');
  const imported = state.name.startsWith('取り込んだ半荘');
  const opened = await open({ ...options, sparse, imported });
  await openWeek(opened.page);
  await state.run(opened.page);
  return opened;
}

describe('U-4・U-5・U-6: 週の集計の各状態の、幅・図の大きさ・アクセシビリティ・テーマ', () => {
  for (const state of STATES) {
    it(`${state.name}: 幅 390・768・1280px で横スクロールが出ない。axe の重大な違反が 0 件（ライト・ダーク）`, { timeout: 240_000 }, async () => {
      for (const width of [390, 768, 1280]) {
        for (const scheme of SCHEMES) {
          const { context, page, problems, external } = await openState(state, { width, scheme });
          try {
            const where = `${state.name} @${width} ${scheme}`;
            const f = await page.evaluate(() => ({
              scroll: document.documentElement.scrollWidth,
              client: document.documentElement.clientWidth,
              body: document.body.scrollWidth,
              // 表の入れ物の中は、はみ出して良い（キーボードで動かせる領域になる）が、図の入れ物は、はみ出さない
              figs: [...document.querySelectorAll<HTMLElement>('.wk-chart, .wk-multi, .wk-bars, .wk-rec, .wk-tiles')].filter((el) => el.scrollWidth > el.clientWidth + 1).length,
            }));
            expect(f.scroll, where).toBeLessThanOrEqual(f.client);
            expect(f.body, `${where} body`).toBeLessThanOrEqual(f.client);
            expect(f.figs, `${where} 図の入れ物がはみ出す`).toBe(0);
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

  it('図は読める大きさ: 小さな折れ線は幅 120px 以上・高さ 36px 以上。縦軸の目盛りの文字は重ならず、図の外へ出ない。横棒の名前と数字は切れない（幅 390・768・1280）', { timeout: 120_000 }, async () => {
    for (const width of [390, 768, 1280]) {
      const { context, page } = await open({ width });
      try {
        await openWeek(page);
        const info = await page.evaluate(() => {
          const r = (el: Element) => el.getBoundingClientRect();
          const plots = [...document.querySelectorAll<HTMLElement>('.lc-plot')].map((plot) => ({
            width: r(plot).width,
            height: r(plot).height,
            spark: plot.closest('.lc')?.classList.contains('lc-spark') ?? false,
          }));
          // 縦軸の目盛り（ふつうの折れ線だけ）: 互いに重ならず、図の左に収まる
          const ticks = [...document.querySelectorAll('.wk-small .lc')].map((lc) => {
            const spans = [...lc.querySelectorAll('.lc-y span')].map((s) => r(s));
            const plot = r(lc.querySelector('.lc-plot') as Element);
            const overlap = spans.some((a, i) => spans.some((b, j) => i < j && a.left < b.right && b.left < a.right && a.top < b.bottom && b.top < a.bottom));
            return { overlap, outside: spans.some((s) => s.right > plot.left + 1 || s.left < 0) };
          });
          const bars = [...document.querySelectorAll<HTMLElement>('.wk-bar')].map((bar) => {
            const nm = bar.querySelector<HTMLElement>('.nm') as HTMLElement;
            const val = bar.querySelector<HTMLElement>('.val') as HTMLElement;
            return {
              nameCut: nm.scrollWidth > nm.clientWidth + 1,
              valCut: val.scrollWidth > val.clientWidth + 1 || r(val).right > r(bar).right + 1,
              track: r(bar.querySelector('.wk-track') as Element).width,
            };
          });
          const rec = [...document.querySelectorAll<HTMLElement>('.wk-recc')].map((c) => ({ over: c.scrollWidth > c.clientWidth + 1, input: r(c.querySelector('input') as Element).width }));
          return { plots, ticks, bars, rec };
        });
        const where = `@${width}`;
        expect(info.plots.length, where).toBeGreaterThanOrEqual(12);
        for (const plot of info.plots) {
          expect(plot.width, where).toBeGreaterThanOrEqual(plot.spark ? 90 : 120);
          expect(plot.height, where).toBeGreaterThanOrEqual(36);
        }
        for (const t of info.ticks) {
          expect(t.overlap, `${where} 目盛りが重なる`).toBe(false);
          expect(t.outside, `${where} 目盛りが図の外へ出る`).toBe(false);
        }
        for (const bar of info.bars) {
          expect(bar.nameCut, `${where} 名前が切れる`).toBe(false);
          expect(bar.valCut, `${where} 数字が切れる`).toBe(false);
          expect(bar.track, `${where} 棒の溝`).toBeGreaterThanOrEqual(60);
        }
        for (const c of info.rec) {
          expect(c.over, `${where} 成績の札がはみ出す`).toBe(false);
          expect(c.input, `${where} 入力欄の幅`).toBeGreaterThanOrEqual(60);
        }
      } finally {
        await context.close();
      }
    }
  });
});

describe('U-5・U-6: Tab で、すべての操作と、図の点（1 つの止まり場所）に届く', () => {
  it('幅 1280・390px: 週の切り替え・説明のアイコン・「表で見る」・図（折れ線・横棒・点の図）・入力欄・来週の重点のすべてに、Tab だけで届く', { timeout: 120_000 }, async () => {
    for (const width of [1280, 390]) {
      const { context, page } = await open({ width });
      try {
        await openWeek(page);
        const reach = await unreachableByTab(page);
        expect(reach.total, `@${width}`).toBeGreaterThan(30);
        expect(reach.missed, `@${width}`).toEqual([]);
      } finally {
        await context.close();
      }
    }
  });

  it('図の 1 つの止まり場所は、折れ線 12（原因 5・一致率・成績 6）・横棒 1・点の図 1。どれも名前があり、Tab で順に止まる（横スクロールの表は、はみ出すときだけ止まる）', { timeout: 60_000 }, async () => {
    const { context, page } = await open({ width: 1280 });
    try {
      await openWeek(page);
      const groups = await page.evaluate(() =>
        [...document.querySelectorAll<HTMLElement>('[role="group"][tabindex="0"]')].map((el) => el.getAttribute('aria-label')),
      );
      expect(groups.filter((g) => g?.includes('直近8週')).length).toBe(12);
      expect(groups).toContain('差の原因の割合（矢印キーで選ぶ）');
      expect(groups).toContain('結果ごとのずれ（矢印キーで選ぶ）');
      for (const label of groups) expect(label, '名前が無い止まり場所').toBeTruthy();
      // Tab を押し続けて、順に止まる場所の数が、点の数と食い違わない
      await page.getByRole('button', { name: '前の週' }).focus();
      const stops: string[] = [];
      for (let i = 0; i < 60; i += 1) {
        await page.keyboard.press('Tab');
        stops.push(await page.evaluate(() => document.activeElement?.getAttribute('aria-label') ?? document.activeElement?.tagName ?? ''));
      }
      for (const label of groups) expect(stops, label ?? '').toContain(label);
    } finally {
      await context.close();
    }
  });
});

describe('図の約束（dataviz）: 色・線・点・棒・格子（ライト・ダーク）', () => {
  for (const scheme of SCHEMES) {
    it(`${scheme}: 色は 1 色。棒・線は面と背景に 3:1 以上。線は 2px で丸い。点は 8px 以上で面の色の輪つき。棒は 24px 以下で、データの端だけ丸い。格子は実線`, { timeout: 60_000 }, async () => {
      const { context, page } = await open({ scheme });
      try {
        await openWeek(page);
        const r = await page.evaluate(() => {
          const cs = (el: Element) => getComputedStyle(el);
          const root = cs(document.documentElement);
          const parse = (s: string) => (s.match(/[\d.]+/g) ?? []).map(Number);
          const lum = (c: number[]) => {
            const f = (v: number) => {
              const x = v / 255;
              return x <= 0.03928 ? x / 12.92 : Math.pow((x + 0.055) / 1.055, 2.4);
            };
            return 0.2126 * f(c[0] as number) + 0.7152 * f(c[1] as number) + 0.0722 * f(c[2] as number);
          };
          const ratio = (a: number[], b: number[]) => {
            const x = lum(a);
            const y = lum(b);
            return (Math.max(x, y) + 0.05) / (Math.min(x, y) + 0.05);
          };
          const probe = (name: string) => {
            const el = document.createElement('i');
            el.style.backgroundColor = root.getPropertyValue(name);
            document.body.appendChild(el);
            const color = cs(el).backgroundColor;
            el.remove();
            return parse(color);
          };
          const surface = probe('--surface');
          const bg = probe('--bg');
          const bar = probe('--accent-bar');
          const line = probe('--accent');
          const ink = probe('--ink');
          const ln = document.querySelector('.wk-small .lc-svg .ln') as Element;
          const dot = document.querySelector('.wk-small .dot.cur') as HTMLElement;
          const fill = document.querySelector('.wk-fill') as HTMLElement;
          const grid = document.querySelector('.lc-svg .g') as Element;
          const dpDot = document.querySelector('.dp-lane .dot') as HTMLElement;
          return {
            barOnSurface: ratio(bar, surface),
            barOnBg: ratio(bar, bg),
            lineOnBg: ratio(line, bg),
            lineOnSurface: ratio(line, surface),
            inkOnBg: ratio(ink, bg),
            lineWidth: cs(ln).strokeWidth,
            lineJoin: cs(ln).strokeLinejoin,
            lineCap: cs(ln).strokeLinecap,
            dot: dot.getBoundingClientRect().width,
            ring: cs(dot).boxShadow,
            barH: fill.getBoundingClientRect().height,
            radiusEnd: cs(fill).borderTopRightRadius,
            radiusStart: cs(fill).borderTopLeftRadius,
            gridDash: cs(grid).strokeDasharray,
            gridW: cs(grid).strokeWidth,
            dpDot: dpDot.getBoundingClientRect().width,
            // 線・棒の色は、トークン 1 色だけ（原因ごとに色を変えない）
            colors: [...new Set([...document.querySelectorAll('.wk-small .lc-svg .ln')].map((e) => cs(e).stroke))].length,
            fills: [...new Set([...document.querySelectorAll('.wk-bar .wk-fill')].map((e) => cs(e).backgroundColor))].length,
          };
        });
        expect(r.barOnSurface).toBeGreaterThanOrEqual(3);
        expect(r.barOnBg).toBeGreaterThanOrEqual(3);
        expect(r.lineOnBg).toBeGreaterThanOrEqual(3);
        expect(r.lineOnSurface).toBeGreaterThanOrEqual(3);
        expect(r.inkOnBg).toBeGreaterThanOrEqual(3);
        expect(r.lineWidth).toBe('2px');
        expect(r.lineJoin).toBe('round');
        expect(r.lineCap).toBe('round');
        expect(r.dot).toBeGreaterThanOrEqual(8);
        expect(r.ring).toMatch(/0px 0px 0px 2px/);
        expect(r.barH).toBeLessThanOrEqual(24);
        expect(r.radiusEnd).toBe('4px');
        expect(r.radiusStart).toBe('0px');
        expect(['none', '']).toContain(r.gridDash);
        expect(r.gridW).toBe('1px');
        expect(r.dpDot).toBeGreaterThanOrEqual(8);
        expect(r.colors).toBe(1);
        expect(r.fills).toBe(1);
      } finally {
        await context.close();
      }
    });
  }
});

describe('U-46: 迷いだけを記録する設定が入のとき、一致率と結果ごとのずれの区画を出さない（実ブラウザ）', () => {
  it('幅 390・768・1280px（ライト・ダーク）: 「局の評価」の区画・一致率・ずれの図・それぞれの「表で見る」が無い。横スクロールが無く、axe の重大な違反が 0 件。Tab で全部に届く', { timeout: 240_000 }, async () => {
    for (const width of [390, 768, 1280]) {
      for (const scheme of SCHEMES) {
        const { context, page, problems, external } = await open({ width, scheme, doubtOnly: true });
        const where = `@${width} ${scheme}`;
        try {
          await openWeek(page);
          expect(await page.getByRole('heading', { level: 2, name: '局の評価' }).count(), where).toBe(0);
          expect(await page.locator('figure[data-fig="agree"], figure[data-fig="dots"]').count(), where).toBe(0);
          expect(await page.getByRole('button', { name: '一致率とずれの説明' }).count(), where).toBe(0);
          expect(await page.getByRole('button', { name: '表で見る' }).count(), where).toBe(3);
          const f = await page.evaluate(() => ({
            scroll: document.documentElement.scrollWidth,
            client: document.documentElement.clientWidth,
            // 区画の並び（見出し）と、区画どうしの縦の間隔
            heads: [...document.querySelectorAll('.page .wk-sec')].map((s) => (s.querySelector('h2')?.textContent ?? '').trim()),
            gaps: [...document.querySelectorAll('.page .wk-sec')].slice(0, -1).map((s, i, all) => {
              const next = [...document.querySelectorAll('.page .wk-sec')][i + 1] as HTMLElement;
              return Math.round(next.getBoundingClientRect().top - (all[i] as HTMLElement).getBoundingClientRect().bottom);
            }),
          }));
          expect(f.scroll, where).toBeLessThanOrEqual(f.client);
          expect(f.heads.slice(0, 3), where).toEqual(['今週の数', '差の原因', '局面の種類']);
          expect(f.heads, where).not.toContain('局の評価');
          // 今週の数・差の原因・局面の種類・成績の間隔は、そろっている（局の評価が抜けた所だけ、広い・狭いにならない。
          // 成績の下の「取り込んだ半荘から数えた値」は、成績に続く別の表なので、もともと狭い）
          expect(f.heads[3], where).toBe('成績（手入力）');
          expect(new Set(f.gaps.slice(0, 3)).size, `${where} ${JSON.stringify(f.gaps)}`).toBe(1);
          const axe = await runAxe(page);
          expect(seriousViolations(axe), where).toEqual([]);
          const reach = await unreachableByTab(page);
          expect(reach.total, where).toBeGreaterThan(20);
          expect(reach.missed, where).toEqual([]);
          expect(problems, where).toEqual([]);
          expect(external, where).toEqual([]);
        } finally {
          await context.close();
        }
      }
    }
  });

  it('設定を切ると（settings-changed）、その場で「局の評価」の区画が元どおり出る。入れ直すとまた隠れる', { timeout: 60_000 }, async () => {
    const { context, page } = await open({ width: 1280, doubtOnly: true });
    try {
      await openWeek(page);
      const flip = (doubtOnly: boolean) =>
        page.evaluate(async (value) => {
          const w = window as unknown as {
            __TAURI_INTERNALS__: { invoke: (cmd: string) => Promise<Record<string, unknown>> };
            __jrEmit: (event: string, payload: unknown) => void;
          };
          const current = await w.__TAURI_INTERNALS__.invoke('get_settings');
          w.__jrEmit('settings-changed', { ...current, doubt_only: value });
        }, doubtOnly);
      expect(await page.locator('figure[data-fig="agree"]').count()).toBe(0);
      await flip(false);
      await page.locator('figure[data-fig="agree"]').waitFor();
      expect(await text(page, 'figure[data-fig="agree"] .wk-big .v')).toBe('20%');
      expect(await page.getByRole('heading', { level: 2, name: '局の評価' }).count()).toBe(1);
      await flip(true);
      await page.waitForFunction(() => document.querySelector('figure[data-fig="agree"]') === null);
    } finally {
      await context.close();
    }
  });
});

describe('U-30: 吹き出し（マウス・キーボード）。窓の中に収まる', () => {
  for (const width of [1280, 390]) {
    it(`幅 ${width}px: 折れ線を Tab で選ぶと、今週の吹き出し。← で前の週。窓の中に収まる。Esc で消える`, { timeout: 60_000 }, async () => {
      const { context, page } = await open({ width });
      try {
        await openWeek(page);
        const plot = page.getByRole('group', { name: /^受け入れ枚数の割合（直近8週）/ });
        await plot.scrollIntoViewIfNeeded();
        await plot.focus();
        const read = () =>
          page.evaluate(() => {
            const tip = document.querySelector<HTMLElement>('.wk-tip');
            if (tip === null || tip.hidden) return null;
            const rect = tip.getBoundingClientRect();
            return {
              value: tip.querySelector('.wk-tip-v')?.textContent ?? '',
              label: tip.querySelector('.wk-tip-l')?.textContent ?? '',
              inside: rect.left >= 0 && rect.top >= 0 && rect.right <= window.innerWidth && rect.bottom <= window.innerHeight,
              hov: getComputedStyle(document.querySelector('.wk-small .lc[data-hov] .dot.hov') as Element).opacity,
            };
          });
        const first = await read();
        expect(first?.label).toBe('受け入れ枚数・10月5日の週');
        expect(first?.value).toMatch(/^\d+%（\d+局面）$/);
        expect(first?.inside).toBe(true);
        expect(Number(first?.hov)).toBeGreaterThan(0);
        await page.keyboard.press('ArrowLeft');
        const second = await read();
        expect(second?.label).toBe('受け入れ枚数・9月28日の週');
        expect(second?.inside).toBe(true);
        await page.keyboard.press('Home');
        expect((await read())?.label).toBe('受け入れ枚数・8月17日の週');
        await page.keyboard.press('Escape');
        expect(await read()).toBeNull();
      } finally {
        await context.close();
      }
    });
  }

  it('マウスを乗せた横棒・点の図・折れ線にも吹き出しが出る（値が先、名前があと）。離すと消える', { timeout: 60_000 }, async () => {
    const { context, page } = await open({ width: 1280 });
    try {
      await openWeek(page);
      const tip = () =>
        page.evaluate(() => {
          const el = document.querySelector<HTMLElement>('.wk-tip');
          return el === null || el.hidden ? null : { text: (el.textContent ?? '').trim(), first: el.firstElementChild?.className ?? '' };
        });
      await page.locator('.wk-bar').nth(1).locator('.wk-track').hover();
      const bar = await tip();
      expect(bar?.first).toBe('wk-tip-v');
      expect(bar?.text).toMatch(/^\d+%（\d+局面）形の質・10月5日の週$/);
      await page.mouse.move(2, 2);
      expect(await tip()).toBeNull();
      await page.locator('.dp-lane').nth(1).hover();
      expect((await tip())?.text).toMatch(/^平均 −2\.0 段階放銃・2局$/);
      await page.mouse.move(2, 2);
      const plot = page.locator('.wk-small .lc-plot').nth(2);
      await plot.scrollIntoViewIfNeeded();
      const box = (await plot.boundingBox()) as { x: number; y: number; width: number; height: number };
      await page.mouse.move(box.x + (box.width * 6.5) / 8, box.y + box.height / 2);
      expect((await tip())?.text).toContain('打点・9月28日の週');
      await page.mouse.move(2, 2);
      expect(await tip()).toBeNull();
    } finally {
      await context.close();
    }
  });
});

describe('U-30: 週の切り替え（実ブラウザ）', () => {
  it('← → のボタンで週を行き来する。今週では → が使えない。いちばん古い週では ← が使えず、キーボードの位置が → へ移る', { timeout: 60_000 }, async () => {
    const { context, page } = await open({ width: 1280 });
    try {
      await openWeek(page);
      expect(await text(page, '.wk-range')).toBe('10月5日（月）〜10月11日（日）');
      expect(await page.getByRole('button', { name: '次の週' }).isDisabled()).toBe(true);
      await page.getByRole('button', { name: '前の週' }).click();
      expect(await text(page, '.wk-range')).toBe('9月28日（月）〜10月4日（日）');
      expect(await page.getByText('今週', { exact: true }).count()).toBe(0);
      await page.getByRole('button', { name: '次の週' }).click();
      expect(await text(page, '.wk-range')).toBe('10月5日（月）〜10月11日（日）');
      // いちばん古い記録（10 週前の答え）まで
      await page.getByRole('button', { name: '前の週' }).focus();
      for (let i = 0; i < 20; i += 1) {
        if (await page.getByRole('button', { name: '前の週' }).isDisabled()) break;
        await page.keyboard.press('Enter');
      }
      expect(await text(page, '.wk-range')).toBe('8月3日（月）〜8月9日（日）');
      await page.waitForFunction(() => document.activeElement?.getAttribute('aria-label') === '次の週');
    } finally {
      await context.close();
    }
  });
});

describe('U-30: 成績と来週の重点を、本物のキーで入れて保存する', () => {
  it('入れて、欄を離れると保存する（「保存しました」）。サイドバーの別の画面へ移って戻っても残る。範囲の外は理由が出る', { timeout: 90_000 }, async () => {
    const { context, page, problems } = await open({ width: 1280 });
    try {
      await openWeek(page);
      const calls = () =>
        page.evaluate(() =>
          (window as unknown as { __jrCalls: Array<{ cmd: string; args: { record?: unknown } }> }).__jrCalls.filter((c) => c.cmd === 'set_week').map((c) => c.args.record),
        );
      await page.getByRole('textbox', { name: '4位率' }).fill('20.4');
      await page.keyboard.press('Tab');
      await page.getByText('保存しました').first().waitFor();
      await page.getByRole('textbox', { name: '平均順位' }).fill('2.41');
      await page.keyboard.press('Enter');
      await page.getByRole('textbox', { name: '来週の重点（任意。1〜3行）' }).fill('受け入れを数えてから切る。\n鳴く前に打点を確認する。');
      await page.getByRole('textbox', { name: '4位率' }).focus();
      await page.waitForFunction(() => {
        const c = (window as unknown as { __jrCalls: Array<{ cmd: string }> }).__jrCalls;
        return c.filter((x) => x.cmd === 'set_week').length >= 3;
      });
      const last = (await calls()).at(-1);
      expect(last).toEqual({
        week: '2026-10-05',
        stats: { rank4: 20.4, avg: 2.41 },
        focus: '受け入れを数えてから切る。\n鳴く前に打点を確認する。',
      });
      // 範囲の外
      await page.getByRole('textbox', { name: '和了率' }).fill('120');
      await page.keyboard.press('Tab');
      expect(await text(page, '.wk-recc [role="alert"]')).toBe('和了率は、0 から 100 の数で入れてください');
      expect(await page.getByRole('textbox', { name: '和了率' }).getAttribute('aria-invalid')).toBe('true');
      expect((await calls()).length).toBe(3);
      // ログへ移って、週の集計に戻る（今週から）。入れた値が残っている
      await page.getByRole('navigation', { name: 'メイン' }).getByRole('button', { name: 'ログ' }).click();
      await page.getByRole('heading', { level: 1, name: 'ログ' }).waitFor();
      await page.getByRole('navigation', { name: 'メイン' }).getByRole('button', { name: '週の集計' }).click();
      await page.getByRole('textbox', { name: '4位率' }).waitFor();
      expect(await page.getByRole('textbox', { name: '4位率' }).inputValue()).toBe('20.4');
      expect(await page.getByRole('textbox', { name: '平均順位' }).inputValue()).toBe('2.41');
      expect(await page.getByRole('textbox', { name: '来週の重点（任意。1〜3行）' }).inputValue()).toBe('受け入れを数えてから切る。\n鳴く前に打点を確認する。');
      // 先週に書いた重点は、来週の重点の欄の上に出る（先週 = 9/28 の週は、手で入れた重点がある）
      expect(await text(page, '.wk-prev')).toBe('先週に書いた重点押し引きは、リーチの現物から探す。 2向聴は、受け入れを広く取る。');
      expect(problems).toEqual([]);
    } finally {
      await context.close();
    }
  });

  it('幅 390px: サイドバー（引き出し）から週の集計を開ける。成績の入力欄は、キーボードを開く前の幅に収まる', { timeout: 60_000 }, async () => {
    const { context, page } = await open({ width: 390 });
    try {
      await openWeek(page);
      const fits = await page.evaluate(() => {
        const inputs = [...document.querySelectorAll<HTMLElement>('.wk-recc input, #focus, .wk-focus textarea')];
        return inputs.every((el) => el.getBoundingClientRect().right <= document.documentElement.clientWidth);
      });
      expect(fits).toBe(true);
    } finally {
      await context.close();
    }
  });
});

// ---- 取り込んだ半荘から数えた値（U-37。F14、R15-7 の B） ----

const IMPORTED_HEADING = '取り込んだ半荘から数えた値（参考）';

/** 取り込んだ半荘の表が、7 半荘の値で出るまで待つ。 */
async function waitImported(page: Page): Promise<void> {
  await page.getByRole('table', { name: /値ともとの数/ }).waitFor({ timeout: 30_000 });
  await page.getByText('2半荘 / 7半荘').waitFor({ timeout: 30_000 });
}

describe('U-37: 取り込んだ半荘から数えた値（手入力の成績の下の別の表）', () => {
  for (const width of [390, 768, 1280]) {
    for (const scheme of SCHEMES) {
      it(`幅 ${width}px・${scheme}: 手入力のカードの下に表が出て、見本の値が出る。表は横にはみ出さない（はみ出す半荘ごとの表は、名前つきの横スクロールの領域になる）。手入力の欄は空のまま`, { timeout: 120_000 }, async () => {
        const { context, page, problems } = await open({ width, scheme, imported: true });
        try {
          await openWeek(page);
          await waitImported(page);
          const where = `@${width} ${scheme}`;
          const info = await page.evaluate((heading) => {
            const section = (name: string) => [...document.querySelectorAll('section')].find((el) => el.querySelector('h2')?.textContent === name) as HTMLElement;
            const manual = section('成績（手入力）');
            const imported = section(heading);
            const focus = section('来週の重点');
            const r = (el: Element) => el.getBoundingClientRect();
            const wrap = imported.querySelector('.wk-tablewrap') as HTMLElement;
            return {
              order: r(manual).bottom <= r(imported).top + 1 && r(imported).bottom <= r(focus).top + 1,
              gap: Math.round(r(imported).top - r(manual).bottom),
              manualInputs: [...manual.querySelectorAll('input')].map((input) => input.value),
              manualCards: manual.querySelectorAll('.wk-recc').length,
              rows: [...imported.querySelectorAll('tbody tr')].map((tr) => [...tr.children].map((c) => (c.textContent ?? '').replace(/\s+/g, ' ').trim())),
              mainOverflow: wrap.scrollWidth > wrap.clientWidth + 1,
              mainRegion: wrap.getAttribute('role'),
              tableRight: Math.round(r(imported.querySelector('table') as Element).right),
              pageScroll: document.documentElement.scrollWidth - document.documentElement.clientWidth,
            };
          }, IMPORTED_HEADING);
          expect(info.order, `${where} 並び（手入力 → 取り込んだ半荘 → 来週の重点）`).toBe(true);
          expect(info.gap, `${where} 手入力の成績との間`).toBeLessThanOrEqual(40);
          expect(info.manualCards, where).toBe(6);
          expect(info.manualInputs, where).toEqual(['', '', '', '', '', '']);
          expect(info.rows, where).toEqual([
            ['4位率', '28.6%', '2半荘 / 7半荘'],
            ['放銃率', '11.0%', '9局 / 82局'],
            ['平均順位', '2.71位', '順位の合計 19 / 7半荘'],
            ['和了率', '19.5%', '16局 / 82局'],
            ['副露率', '29.3%', '24局 / 82局'],
            ['立直率', '19.5%', '16局 / 82局'],
            ['平均和了点', '6,925点', '和了 16回の点数の合計 110,800'],
          ]);
          // 3 列の表は、細い窓でも「もとの数」が折り返して、横にはみ出さない
          expect(info.mainOverflow, `${where} 表が横にはみ出す`).toBe(false);
          expect(info.mainRegion, where).toBeNull();
          expect(info.tableRight, where).toBeLessThanOrEqual(width);
          expect(info.pageScroll, where).toBeLessThanOrEqual(0);

          // 「半荘ごとに見る」を開く。8 列の表は、はみ出すときだけ、名前つきの領域（キーボードで止まれる）にする
          await page.getByRole('button', { name: '半荘ごとに見る（7半荘）' }).click();
          await page.getByRole('table', { name: '取り込んだ半荘ごとの成績' }).waitFor();
          const games = await page.evaluate((heading) => {
            const imported = [...document.querySelectorAll('section')].find((el) => el.querySelector('h2')?.textContent === heading) as HTMLElement;
            const table = [...imported.querySelectorAll('table')].find((t) => t.querySelector('caption')?.textContent === '取り込んだ半荘ごとの成績') as HTMLElement;
            const wrap = table.closest('.wk-tablewrap') as HTMLElement;
            return {
              rows: table.querySelectorAll('tbody tr').length,
              overflow: wrap.scrollWidth > wrap.clientWidth + 1,
              region: wrap.getAttribute('role'),
              label: wrap.getAttribute('aria-label'),
              tabindex: wrap.getAttribute('tabindex'),
              right: Math.round(wrap.getBoundingClientRect().right),
              pageScroll: document.documentElement.scrollWidth - document.documentElement.clientWidth,
            };
          }, IMPORTED_HEADING);
          expect(games.rows, where).toBe(7);
          expect(games.right, where).toBeLessThanOrEqual(width);
          expect(games.pageScroll, `${where} ページが横にはみ出す`).toBeLessThanOrEqual(0);
          if (games.overflow) {
            expect(games.region, where).toBe('region');
            expect(games.label, where).toBe('半荘ごとの成績（横にスクロールできます）');
            expect(games.tabindex, where).toBe('0');
          } else {
            expect(games.region, where).toBeNull();
          }
          if (width === 390) expect(games.overflow, `${where} 8 列の表は、細い窓では領域の中で動く`).toBe(true);
          expect(problems, where).toEqual([]);
        } finally {
          await context.close();
        }
      });
    }
  }

  it('「半荘ごとに見る」は、本物のキー（Enter・Space）で開閉できる。Tab の順は、成績（手入力）→ 説明のアイコン → 半荘ごとに見る → 来週の重点', { timeout: 120_000 }, async () => {
    const { context, page } = await open({ width: 1280, imported: true });
    try {
      await openWeek(page);
      await waitImported(page);
      const toggle = page.getByRole('button', { name: '半荘ごとに見る（7半荘）' });
      expect(await toggle.getAttribute('aria-expanded')).toBe('false');
      // 立直率の欄から Tab を押していくと、説明のアイコン → 開閉のボタン → 来週の重点の欄の順に止まる
      await page.getByRole('textbox', { name: '立直率' }).focus();
      const stops: string[] = [];
      for (let i = 0; i < 6; i += 1) {
        await page.keyboard.press('Tab');
        stops.push(
          await page.evaluate(() => {
            const el = document.activeElement as HTMLElement | null;
            return el?.getAttribute('aria-label') ?? (el?.tagName === 'TEXTAREA' ? 'TEXTAREA' : (el?.textContent ?? '').trim());
          }),
        );
      }
      const tip = stops.indexOf('取り込んだ半荘からの成績の説明');
      expect(tip, `止まる順 ${JSON.stringify(stops)}`).toBeGreaterThanOrEqual(0);
      expect(stops[tip + 1], `止まる順 ${JSON.stringify(stops)}`).toBe('半荘ごとに見る（7半荘）');
      expect(stops[tip + 2], `止まる順 ${JSON.stringify(stops)}`).toBe('TEXTAREA');
      // Enter で開く → 7 行 → Space で閉じる → もう一度 Space で開く
      await toggle.focus();
      await page.keyboard.press('Enter');
      const games = page.getByRole('table', { name: '取り込んだ半荘ごとの成績' });
      await games.waitFor();
      expect(await toggle.getAttribute('aria-expanded')).toBe('true');
      expect(await games.locator('tbody tr').count()).toBe(7);
      await page.keyboard.press('Space');
      expect(await toggle.getAttribute('aria-expanded')).toBe('false');
      expect(await games.count()).toBe(0);
      await page.keyboard.press('Space');
      expect(await toggle.getAttribute('aria-expanded')).toBe('true');
      expect(await games.locator('tbody tr').count()).toBe(7);
    } finally {
      await context.close();
    }
  });

  it('幅 1280・390px: 半荘ごとの表を開いた状態でも、Tab だけで、すべての操作に届く', { timeout: 120_000 }, async () => {
    for (const width of [1280, 390]) {
      const { context, page } = await open({ width, imported: true });
      try {
        await openWeek(page);
        await waitImported(page);
        await page.getByRole('button', { name: '半荘ごとに見る（7半荘）' }).click();
        await page.getByRole('table', { name: '取り込んだ半荘ごとの成績' }).waitFor();
        const reach = await unreachableByTab(page);
        expect(reach.total, `@${width}`).toBeGreaterThan(30);
        expect(reach.missed, `@${width}`).toEqual([]);
      } finally {
        await context.close();
      }
    }
  });

  it('取り込んだ半荘が無い週は、表を出さず 1 行だけ（先週。幅 390・1280、ライト・ダーク）。手入力のカードはそのまま', { timeout: 120_000 }, async () => {
    for (const width of [390, 1280]) {
      for (const scheme of SCHEMES) {
        const { context, page } = await open({ width, scheme, sparse: true });
        try {
          await openWeek(page);
          await page.getByRole('button', { name: '前の週' }).click();
          await page.getByText('この週に取り込んだ半荘はありません。').waitFor();
          const info = await page.evaluate((heading) => {
            const imported = [...document.querySelectorAll('section')].find((el) => el.querySelector('h2')?.textContent === heading) as HTMLElement;
            return {
              tables: imported.querySelectorAll('table').length,
              buttons: [...imported.querySelectorAll('button')].map((b) => b.getAttribute('aria-label') ?? b.textContent),
              lines: imported.querySelectorAll('.wk-empty').length,
            };
          }, IMPORTED_HEADING);
          expect(info, `@${width} ${scheme}`).toEqual({ tables: 0, buttons: ['取り込んだ半荘からの成績の説明'], lines: 1 });
          expect(await page.getByRole('textbox', { name: '4位率' }).count()).toBe(1);
        } finally {
          await context.close();
        }
      }
    }
  });
});
