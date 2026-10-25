// @vitest-environment node
/**
 * 実ブラウザで、アプリ内の更新（F21）の画面を検査する（U-51）。
 *
 * - 更新の帯（検討画面の上）: 幅 390・768・1280px、ライト・ダークで、横スクロールが無く、axe の重大（serious・critical）が 0 件で、
 *   Tab キーだけですべてのボタンに届く。見つけた直後・記録中（入れ直せる）・入れている間・入れ直しに失敗した直後の 4 つの形
 * - 設定の「更新」の欄: 最新・新しい版がある・確かめられなかった（長い理由）・まだ設定されていない、の 4 つの形
 * - 外へ通信しない（更新の層は、ページの中の偽物。本物の通信は、Rust 側が行う）
 */
import type { Browser, BrowserContext, Page } from 'playwright-core';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

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
  type PageServer,
  type Scenario,
} from './harness';

const SCHEMES = ['light', 'dark'] as const;
type Scheme = (typeof SCHEMES)[number];

const CURRENT = '0.2.0';

const idleState = {
  status: 'idle',
  session_id: null,
  mark_count: 0,
  ratings: [],
  next_hand: 1,
  can_undo: false,
  error: null,
};

const settings = {
  trigger: { kind: 'mouse_x1' },
  orientation: 'vertical',
  widget_position: null,
  sound: true,
  doubt_only: false,
  capture_keywords: ['雀魂', 'Mahjong Soul'],
  data_dir: 'C:\\Users\\someone\\JantamaReviewerData',
  skipped_update_version: null,
};

const inputStatus = {
  registering: false,
  probe_ms: null,
  hook: 'in_process',
  helper: { installed: false, running: false, busy: null, error: null },
  message: null,
};

const AVAILABLE = { current_version: CURRENT, kind: 'available', version: '0.2.1', notes: null, date: null };

/** 更新の層（ページの中の Tauri の偽物の、更新の 4 つの命令）の答え。 */
interface UpdateAnswers {
  info?: unknown;
  check?: unknown;
  /** true なら、入れ直しが終わらない（「入れています…」を見るため）。 */
  installHangs?: boolean;
  /** 入れ直しが失敗する理由。 */
  installError?: string;
}

/** 更新の命令だけを、ページの中の偽物に足す（ほかの命令は、harness の偽物に任せる）。harness の偽物のあとに入れる。 */
function updateScript(answers: UpdateAnswers): string {
  return `(function (answers) {
  var original = window.__TAURI_INTERNALS__.invoke;
  window.__TAURI_INTERNALS__.invoke = function (cmd, args) {
    switch (cmd) {
      case 'get_update_info': window.__jrCalls.push({ cmd: cmd, args: args }); return Promise.resolve(answers.info === undefined ? { current_version: '${CURRENT}', configured: true } : answers.info);
      case 'check_update': window.__jrCalls.push({ cmd: cmd, args: args }); return Promise.resolve(answers.check === undefined ? null : answers.check);
      case 'install_update':
        window.__jrCalls.push({ cmd: cmd, args: args });
        if (answers.installHangs) return new Promise(function () {});
        if (answers.installError) return Promise.reject(answers.installError);
        return Promise.resolve(null);
      case 'skip_update_version': window.__jrCalls.push({ cmd: cmd, args: args }); return Promise.resolve(Object.assign({}, ${JSON.stringify(settings)}, { skipped_update_version: args.version }));
      default: return original(cmd, args);
    }
  };
})(${JSON.stringify(answers)});`;
}

function scenario(overrides: Partial<Scenario> = {}): Scenario {
  return {
    label: 'main',
    state: idleState,
    settings,
    inputStatus,
    sessions: [],
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

async function open(
  viewport: { width: number; height: number },
  scheme: Scheme,
  answers: UpdateAnswers,
  overrides: Partial<Scenario> = {},
): Promise<Opened> {
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
  await page.addInitScript(tauriMockScript(scenario(overrides)));
  await page.addInitScript(updateScript(answers));
  await page.goto(new URL('index.html', server.url).toString());
  return { context, page, problems, external };
}

async function horizontalScroll(page: Page): Promise<{ scroll: number; client: number; body: number }> {
  return page.evaluate(() => ({
    scroll: document.documentElement.scrollWidth,
    client: document.documentElement.clientWidth,
    body: document.body.scrollWidth,
  }));
}

/** 横スクロール・axe の重大・Tab での到達を、まとめて確かめる。 */
async function expectClean(page: Page, problems: string[], external: string[]): Promise<void> {
  const m = await horizontalScroll(page);
  expect(m.scroll, `scrollWidth ${m.scroll} > clientWidth ${m.client}`).toBeLessThanOrEqual(m.client);
  expect(m.body).toBeLessThanOrEqual(m.client);
  expect(seriousViolations(await runAxe(page))).toEqual([]);
  const reach = await unreachableByTab(page);
  expect(reach.total).toBeGreaterThan(1);
  expect(reach.missed).toEqual([]);
  expect(problems).toEqual([]);
  expect(external).toEqual([]);
}

const REGION = 'アプリの更新';

describe('更新の帯（U-51）', () => {
  const BANNER_VARIANTS = ['見つけた直後', '記録中（入れ直せる）', '入れている間', '入れ直しに失敗した直後'] as const;
  for (const scheme of SCHEMES) {
    for (const width of [390, 768, 1280] as const) {
      for (const variant of BANNER_VARIANTS) {
        it(`${variant} 幅${width}px ${scheme}: 横スクロールが無く、重大な a11y 違反が無く、Tab で全部に届き、外へ通信しない`, async () => {
          const answers: UpdateAnswers = {
            check: AVAILABLE,
            installHangs: variant === '入れている間',
            installError:
              variant === '入れ直しに失敗した直後'
                ? '更新の署名を確かめられませんでした。安全のため、入れ直しを中止しました'
                : undefined,
          };
          const state =
            variant === '記録中（入れ直せる）'
              ? { ...idleState, status: 'recording', session_id: '20261009-161200' }
              : idleState;
          const { context, page, problems, external } = await open({ width, height: 800 }, scheme, answers, { state });
          try {
            await waitForMainReady(page);
            const region = page.getByRole('region', { name: REGION });
            await region.waitFor();
            await region.getByText('新しい版 0.2.1 があります').waitFor();
            const install = region.getByRole('button', { name: '今すぐ入れ直す' });
            expect(await install.isEnabled()).toBe(true);

            if (variant === '記録中（入れ直せる）') {
              const checks = await page.evaluate(
                () =>
                  (window as unknown as { __jrCalls: Array<{ cmd: string }> }).__jrCalls.filter(
                    (call) => call.cmd === 'check_update',
                  ).length,
              );
              expect(checks).toBe(1);
              await install.click();
              const installs = await page.evaluate(
                () =>
                  (window as unknown as { __jrCalls: Array<{ cmd: string }> }).__jrCalls.filter(
                    (call) => call.cmd === 'install_update',
                  ).length,
              );
              expect(installs).toBe(1);
            }
            if (variant === '入れている間') {
              await install.click();
              await region.getByText('新しい版を入れています…').waitFor();
              expect(await region.getByRole('button', { name: 'あとで' }).isDisabled()).toBe(true);
            }
            if (variant === '入れ直しに失敗した直後') {
              await install.click();
              await region.getByRole('alert').waitFor();
              expect(await install.isEnabled()).toBe(true);
            }

            // 帯は、本文の上（見出しより前）にある
            const order = await page.evaluate(() => {
              const banner = document.querySelector('section[aria-label="アプリの更新"]');
              const heading = document.querySelector('main h1');
              return banner !== null && heading !== null
                ? Boolean(banner.compareDocumentPosition(heading) & Node.DOCUMENT_POSITION_FOLLOWING)
                : null;
            });
            expect(order).toBe(true);

            await expectClean(page, problems, external);
          } finally {
            await context.close();
          }
        });
      }
    }
  }

  it('Tab と Enter だけで、「あとで」まで操作でき、帯が消える。起動し直すまで戻らない', async () => {
    const { context, page, problems } = await open({ width: 1280, height: 800 }, 'light', { check: AVAILABLE });
    try {
      await waitForMainReady(page);
      const region = page.getByRole('region', { name: REGION });
      await region.waitFor();
      await region.getByRole('button', { name: '今すぐ入れ直す' }).focus();
      await page.keyboard.press('Tab');
      expect(await page.evaluate(() => document.activeElement?.textContent)).toBe('あとで');
      await page.keyboard.press('Enter');
      await region.waitFor({ state: 'detached' });
      expect(problems).toEqual([]);
    } finally {
      await context.close();
    }
  });
});

describe('設定の「更新」の欄（U-51）', () => {
  interface SettingsVariant {
    name: string;
    answers: UpdateAnswers;
    /** 欄を開いたあとに、「更新を確かめる」を押すか。 */
    press: boolean;
    expected: string;
  }
  const VARIANTS: SettingsVariant[] = [
    { name: '最新です', answers: { check: { current_version: CURRENT, kind: 'up_to_date' } }, press: true, expected: '最新です' },
    { name: '新しい版がある', answers: { check: AVAILABLE }, press: true, expected: '新しい版 0.2.1 があります' },
    {
      name: '確かめられなかった（長い理由）',
      answers: {
        check: {
          current_version: CURRENT,
          kind: 'failed',
          message:
            '通信できませんでした（error sending request for url (https://example.invalid/releases/latest/download/latest.json): client error (Connect): dns error: no such host is known）',
        },
      },
      press: true,
      expected: '確かめられませんでした',
    },
    {
      name: 'まだ設定されていない',
      answers: {
        info: { current_version: CURRENT, configured: false },
        check: { current_version: CURRENT, kind: 'not_configured' },
      },
      press: false,
      expected: '更新の仕組みがまだ設定されていません',
    },
  ];

  for (const scheme of SCHEMES) {
    for (const width of [390, 768, 1280] as const) {
      for (const variant of VARIANTS) {
        it(`${variant.name} 幅${width}px ${scheme}: 横スクロールが無く、重大な a11y 違反が無く、Tab で全部に届く`, async () => {
          const { context, page, problems, external } = await open({ width, height: 900 }, scheme, variant.answers);
          try {
            await waitForMainReady(page);
            await ensureSidebar(page);
            await page.getByRole('button', { name: '設定' }).click();
            await page.getByRole('heading', { level: 1, name: '設定' }).waitFor();
            const group = page.getByRole('group', { name: '更新' });
            await group.waitFor();
            await group.scrollIntoViewIfNeeded();
            expect(await group.getByText(CURRENT, { exact: true }).isVisible()).toBe(true);
            if (variant.press) {
              await group.getByRole('button', { name: '更新を確かめる' }).click();
            }
            await group.getByText(variant.expected, { exact: false }).first().waitFor();
            if (variant.name === '新しい版がある') {
              for (const name of ['今すぐ入れ直す', 'あとで', 'この版は飛ばす']) {
                await group.getByRole('button', { name }).waitFor();
              }
            }
            // 設定のページには、帯を出さない
            expect(await page.getByRole('region', { name: REGION }).count()).toBe(0);
            await expectClean(page, problems, external);
          } finally {
            await context.close();
          }
        });
      }
    }
  }
});
