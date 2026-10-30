// @vitest-environment node
/**
 * 実ブラウザで、設定の「解析のモデル」の欄（F24、U-54）を検査する。
 *
 * - 幅 390・768・1280px、ライト・ダークで、欄の 6 つの形（入っていない・入っている・取っている最中・取り消している最中・取るのに失敗・
 *   選んだファイルが違う）に、横スクロールが無く、axe の重大（serious・critical）が 0 件で、Tab キーだけですべての操作に届く
 * - 説明のアイコン: キーボードで選ぶと出て、窓の中に収まる
 * - 外へ通信しない（取る・選ぶ・消すは、ページの中の偽物。本物の通信とファイルの確かめは、Rust 側が行う）
 * 各形の画面写真を、`zz-reads-settings-shots/`（git に入れない）に残す。見て確かめるための写真で、試験の合否には使わない。
 * jsdom の試験（ReadsModelBlock.test.tsx）と同じふるまいを、実際の描画・キー・時計で確かめる。
 */
import { mkdir } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';

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
} from './harness';

const SCHEMES = ['light', 'dark'] as const;
type Scheme = (typeof SCHEMES)[number];

const SHOTS_DIR = fileURLToPath(new URL('./zz-reads-settings-shots/', import.meta.url));

const MODEL_BYTES = 4_013_332;
const GROUP = '解析のモデル';
const SHA_ERROR = '取ったファイルが、決まった版と違います（sha256）。もう一度試してください';
const NOT_THE_MODEL = 'このファイルは決まった読みのモデルではありません（sha256 が違います）';

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
};

const inputStatus = {
  registering: false,
  probe_ms: null,
  hook: 'in_process',
  helper: { installed: false, running: false, busy: null, error: null },
  message: null,
};

/** `get_reads_model` が返す、モデルの状態（`src/api/reads.ts` の `ReadsModelStatus` と同じ形）。 */
interface ModelStatus {
  installed: boolean;
  bytes: number | null;
  sha256: string | null;
  downloading: boolean;
  repo: string;
  revision: string;
  file: string;
  license: string;
  origin: string;
}

const NOT_INSTALLED: ModelStatus = {
  installed: false,
  bytes: null,
  sha256: null,
  downloading: false,
  repo: 'hhim8826/mortal3-b40c192',
  revision: '7784a9deddf63df03f023474116f715850d3c7a0',
  file: 'tenpai.onnx',
  license: 'AGPL-3.0',
  origin: '天鳳の鳳凰卓 160 万局で学習',
};

const INSTALLED: ModelStatus = {
  ...NOT_INSTALLED,
  installed: true,
  bytes: MODEL_BYTES,
  sha256: '50893ddca230bd90c678086bc8e3b9fe229492b5c9f15fe8145149464b8c1cea',
};

/** 本体の、モデルの命令（ページの中の Tauri の偽物に足す）の答え。 */
interface ModelAnswers {
  /** `get_reads_model` の答え。 */
  status: ModelStatus;
  /** true なら、取るのが終わらない（「取っています…」を見るため）。 */
  downloadHangs?: boolean;
  /** 取るのが失敗する理由。 */
  downloadError?: string;
  /** ファイルを選ぶダイアログが返すパス。 */
  pickedPath?: string;
  /** 選んだファイルを置くのが失敗する理由。 */
  chooseError?: string;
}

/** モデルの命令だけを、ページの中の偽物に足す（ほかの命令は、harness の偽物に任せる）。harness の偽物のあとに入れる。 */
function modelScript(answers: ModelAnswers): string {
  return `(function (answers) {
  var original = window.__TAURI_INTERNALS__.invoke;
  window.__TAURI_INTERNALS__.invoke = function (cmd, args) {
    switch (cmd) {
      case 'get_reads_model': window.__jrCalls.push({ cmd: cmd, args: args }); return Promise.resolve(Object.assign({}, answers.status));
      case 'download_reads_model':
        window.__jrCalls.push({ cmd: cmd, args: args });
        if (answers.downloadHangs) return new Promise(function () {});
        if (answers.downloadError) return Promise.reject(answers.downloadError);
        return Promise.resolve(Object.assign({}, answers.status));
      case 'cancel_reads_model_download': window.__jrCalls.push({ cmd: cmd, args: args }); return Promise.resolve(null);
      case 'choose_reads_model_file':
        window.__jrCalls.push({ cmd: cmd, args: args });
        if (answers.chooseError) return Promise.reject(answers.chooseError);
        return Promise.resolve(Object.assign({}, answers.status));
      case 'delete_reads_model': window.__jrCalls.push({ cmd: cmd, args: args }); return Promise.resolve(Object.assign({}, answers.status));
      case 'plugin:dialog|open': return Promise.resolve(answers.pickedPath === undefined ? null : answers.pickedPath);
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
  await mkdir(SHOTS_DIR, { recursive: true });
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

/** 設定のページを開いて、「解析のモデル」の欄まで進む（細い窓では、引き出しを開いてから「設定」を押す）。 */
async function open(
  viewport: { width: number; height: number },
  scheme: Scheme,
  answers: ModelAnswers,
): Promise<Opened & { group: ReturnType<Page['getByRole']> }> {
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
  await page.addInitScript(tauriMockScript(scenario()));
  await page.addInitScript(modelScript(answers));
  await page.goto(new URL('index.html', server.url).toString());
  await waitForMainReady(page);
  await ensureSidebar(page);
  await page.getByRole('button', { name: '設定' }).click();
  await page.getByRole('heading', { level: 1, name: '設定' }).waitFor();
  const group = page.getByRole('group', { name: GROUP });
  await group.waitFor();
  await group.scrollIntoViewIfNeeded();
  return { context, page, problems, external, group };
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

/** 欄とその周り（上下 12px）の画面写真を残す。見て確かめるためで、合否には使わない。 */
async function shoot(page: Page, name: string): Promise<void> {
  const group = page.getByRole('group', { name: GROUP });
  await group.scrollIntoViewIfNeeded();
  const box = await group.boundingBox();
  if (box === null) return;
  const viewport = page.viewportSize();
  const width = viewport?.width ?? 1280;
  const top = Math.max(0, box.y - 12);
  const height = Math.min((viewport?.height ?? 800) - top, box.height + 24);
  await page.screenshot({
    path: `${SHOTS_DIR}${name}.png`,
    clip: { x: 0, y: top, width, height },
  });
}

interface Variant {
  name: string;
  /** 画面写真の名前に使う、ファイル名向きの名前。 */
  slug: string;
  answers: ModelAnswers;
  /** 欄を開いたあとの操作。 */
  act: (page: Page, group: ReturnType<Page['getByRole']>) => Promise<void>;
  /** 操作のあとに、欄に出ているはずの文。 */
  expected: string[];
}

const VARIANTS: Variant[] = [
  {
    name: '入っていない',
    slug: 'not-installed',
    answers: { status: NOT_INSTALLED },
    act: async (_page, group) => {
      await group.getByRole('button', { name: 'Hugging Face から取る' }).waitFor();
      await group.getByRole('button', { name: 'ファイルを選ぶ…' }).waitFor();
    },
    expected: ['入っていません', 'hhim8826/mortal3-b40c192 · AGPL-3.0 · 天鳳の鳳凰卓 160 万局で学習'],
  },
  {
    name: '入っている',
    slug: 'installed',
    answers: { status: INSTALLED },
    act: async (_page, group) => {
      await group.getByRole('button', { name: '消す' }).waitFor();
    },
    expected: ['入っています（4.0 MB）', 'hhim8826/mortal3-b40c192 · AGPL-3.0 · 天鳳の鳳凰卓 160 万局で学習'],
  },
  {
    name: '取っている最中',
    slug: 'downloading',
    answers: { status: NOT_INSTALLED, downloadHangs: true },
    act: async (page, group) => {
      await group.getByRole('button', { name: 'Hugging Face から取る' }).click();
      await group.getByRole('button', { name: '取り消す' }).waitFor();
      await page.evaluate(
        (payload) => (window as unknown as { __jrEmit: (e: string, p: unknown) => void }).__jrEmit('reads-model-progress', payload),
        { done: 1_200_000, total: MODEL_BYTES },
      );
    },
    expected: ['取っています… 1.2 / 4.0 MB'],
  },
  {
    name: '取り消している最中',
    slug: 'cancelling',
    answers: { status: NOT_INSTALLED, downloadHangs: true },
    act: async (_page, group) => {
      await group.getByRole('button', { name: 'Hugging Face から取る' }).click();
      await group.getByRole('button', { name: '取り消す' }).click();
    },
    expected: ['取り消しています…'],
  },
  {
    name: '取るのに失敗（sha256 が違う）',
    slug: 'download-error',
    answers: { status: NOT_INSTALLED, downloadError: SHA_ERROR },
    act: async (_page, group) => {
      await group.getByRole('button', { name: 'Hugging Face から取る' }).click();
      await group.getByRole('alert').waitFor();
    },
    expected: [SHA_ERROR, '入っていません'],
  },
  {
    name: '選んだファイルが違う',
    slug: 'choose-error',
    answers: {
      status: NOT_INSTALLED,
      pickedPath: 'C:\\Users\\someone\\Downloads\\some-other-model-that-has-a-rather-long-file-name.onnx',
      chooseError: NOT_THE_MODEL,
    },
    act: async (_page, group) => {
      await group.getByRole('button', { name: 'ファイルを選ぶ…' }).click();
      await group.getByRole('alert').waitFor();
    },
    expected: [NOT_THE_MODEL, '入っていません'],
  },
];

describe('設定の「解析のモデル」の欄（U-54）', () => {
  for (const scheme of SCHEMES) {
    for (const width of [390, 768, 1280] as const) {
      for (const variant of VARIANTS) {
        it(`${variant.name} 幅${width}px ${scheme}: 横スクロールが無く、重大な a11y 違反が無く、Tab で全部に届き、外へ通信しない`, async () => {
          const { context, page, problems, external, group } = await open({ width, height: 900 }, scheme, variant.answers);
          try {
            await variant.act(page, group);
            for (const text of variant.expected) {
              await group.getByText(text, { exact: false }).first().waitFor();
            }
            expect(await group.isVisible()).toBe(true);
            await shoot(page, `${variant.slug}-${width}-${scheme}`);
            await expectClean(page, problems, external);
          } finally {
            await context.close();
          }
        });
      }

      it(`説明のアイコン 幅${width}px ${scheme}: キーボードで選ぶと出て、窓の中に収まり、欄の文字にかからない`, async () => {
        const { context, page, problems, external, group } = await open({ width, height: 900 }, scheme, { status: NOT_INSTALLED });
        try {
          await group.getByRole('button', { name: '読みのモデルの説明' }).focus();
          await page.keyboard.press('Shift+Tab');
          await page.keyboard.press('Tab');
          const measure = await measureInfoTip(page, '#reads-model-name');
          expect(measure).not.toBeNull();
          if (measure === null) return;
          expect(measure.text).toContain('他家の聴牌と待ちを読むモデルです（F23）');
          expect(measure.tip.left).toBeGreaterThanOrEqual(0);
          expect(measure.tip.right).toBeLessThanOrEqual(measure.innerWidth);
          expect(measure.tip.top).toBeGreaterThanOrEqual(0);
          expect(measure.tip.bottom).toBeLessThanOrEqual(measure.innerHeight);
          await shoot(page, `info-tip-${width}-${scheme}`);
          await expectClean(page, problems, external);
        } finally {
          await context.close();
        }
      });
    }
  }

  it('Tab と Enter だけで、取り始め、取り消せる（取り消すと、「取る」に戻る）', async () => {
    const { context, page, problems, group } = await open({ width: 1280, height: 900 }, 'light', {
      status: NOT_INSTALLED,
      downloadHangs: true,
    });
    try {
      await group.getByRole('button', { name: 'Hugging Face から取る' }).focus();
      await page.keyboard.press('Enter');
      const cancel = group.getByRole('button', { name: '取り消す' });
      await cancel.waitFor();
      await cancel.focus();
      await page.keyboard.press('Enter');
      await group.getByText('取り消しています…').waitFor();
      const calls = await page.evaluate(
        () => (window as unknown as { __jrCalls: Array<{ cmd: string }> }).__jrCalls.map((call) => call.cmd),
      );
      expect(calls.filter((cmd) => cmd === 'download_reads_model')).toHaveLength(1);
      expect(calls.filter((cmd) => cmd === 'cancel_reads_model_download')).toHaveLength(1);
      expect(problems).toEqual([]);
    } finally {
      await context.close();
    }
  });
});
