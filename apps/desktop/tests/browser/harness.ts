/**
 * 実ブラウザ（インストール済みの Chrome か Edge）で画面を開いて検査するための道具。
 * Vite の開発サーバーで画面を配り、Tauri の API は「ページの中に入れた偽物」で置き換える。
 * ブラウザは playwright-core で操作する（ブラウザ本体のダウンロードはしない）。
 */
import { mkdtemp, rm } from 'node:fs/promises';
import { createRequire } from 'node:module';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';

import { chromium, type Browser, type Page } from 'playwright-core';
import { createLogger, createServer, type ViteDevServer } from 'vite';

const APP_ROOT = fileURLToPath(new URL('../..', import.meta.url));
const requireFromHere = createRequire(import.meta.url);

export interface PageServer {
  /** 末尾にスラッシュ付きのオリジン（例: http://127.0.0.1:5173/）。 */
  url: string;
  close: () => Promise<void>;
}

/** 2 つの窓の入口のモジュール（index.html と widget.html が読み込む）。 */
const ENTRY_MODULES = ['/src/main/main.tsx', '/src/widget/main.tsx'];

/** Vite が「依存の事前変換をやり直した」と知らせる文。起動したあとに出たら、ページが二重の React を読み込みうる。 */
const REOPTIMIZED = /new dependencies found|re-optimizing dependencies|optimized dependencies changed/i;

/**
 * 入口のモジュールから読み込まれるものを、先にすべて 1 回ずつ読んでおく（依存の事前変換の結果も含む）。
 * 事前変換は最初の要求のあとに始まって数秒かかるので、最初のテストの制限時間の中で待たせないための準備。
 */
async function warmUp(origin: string): Promise<void> {
  const seen = new Set<string>();
  const queue = [...ENTRY_MODULES];
  for (let path = queue.pop(); path !== undefined; path = queue.pop()) {
    if (seen.has(path)) continue;
    seen.add(path);
    const response = await fetch(new URL(path, origin));
    const body = await response.text();
    if (!response.ok) throw new Error(`開発サーバーの応答が ${response.status} でした: ${path}`);
    for (const match of body.matchAll(/(?:from|import)\s*"(\/[^"]+)"/g)) {
      if (match[1] !== undefined) queue.push(match[1]);
    }
  }
}

export async function startPageServer(): Promise<PageServer> {
  // 依存の事前変換のキャッシュは、このサーバーだけの一時フォルダに置く。
  // 既定の node_modules/.vite は、`pnpm dev` や、並行して動くもう 1 つのテストファイルのサーバーと共有になる。
  // キャッシュの鍵には NODE_ENV が入る（テストは test、`pnpm dev` は development）ので、`pnpm dev` を挟むと、
  // 2 つのサーバーが同じフォルダを同時に作り直して、React が二重に読み込まれた（Invalid hook call）。
  // HMR を切ってあるので、読み直しで立ち直ることもできない。
  const cacheDir = await mkdtemp(join(tmpdir(), 'jantama-vite-'));
  const reoptimized: string[] = [];
  const logger = createLogger('error', { allowClearScreen: false });
  let server: ViteDevServer | undefined;

  const close = async () => {
    try {
      await server?.close();
    } finally {
      await rm(cacheDir, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 }).catch(
        () => undefined,
      );
    }
    if (reoptimized.length > 0) throw new Error(reoptimizedMessage(reoptimized));
  };

  try {
    server = await createServer({
      root: APP_ROOT,
      configFile: join(APP_ROOT, 'vite.config.ts'),
      cacheDir,
      customLogger: {
        ...logger,
        info: (message) => {
          // eslint-disable-next-line no-control-regex -- Vite が文の色付けに入れる制御文字を除く
          const plain = message.replace(/\u001b\[[0-9;]*m/g, '');
          if (REOPTIMIZED.test(plain)) reoptimized.push(plain);
        },
      },
      server: { host: '127.0.0.1', port: 0, strictPort: false, hmr: false, watch: null },
      logLevel: 'error',
      clearScreen: false,
    });
    await server.listen();
    const url = server.resolvedUrls?.local[0];
    if (!url) throw new Error('開発サーバーの URL を取得できません');
    await warmUp(url);
    if (reoptimized.length > 0) throw new Error(reoptimizedMessage(reoptimized));
    return { url, close };
  } catch (error) {
    await close().catch(() => undefined);
    throw error;
  }
}

function reoptimizedMessage(messages: string[]): string {
  return `Vite が依存の事前変換をやり直した（ページが React を二重に読み込むおそれがある）: ${messages.join(' / ')}`;
}

/** インストール済みの Chrome、なければ Edge を起動する。どちらも無ければ失敗させる（黙って飛ばさない）。 */
export async function launchBrowser(): Promise<Browser> {
  const problems: string[] = [];
  for (const channel of ['chrome', 'msedge'] as const) {
    try {
      return await chromium.launch({ channel, headless: true });
    } catch (error) {
      problems.push(`${channel}: ${String(error).split('\n')[0]}`);
    }
  }
  throw new Error(`テスト用のブラウザ（Chrome か Edge）を起動できません:\n${problems.join('\n')}`);
}

export interface Scenario {
  label: 'main' | 'widget';
  state: unknown;
  settings: unknown;
  sessions: unknown[];
  /** `convertFileSrc` が返す画像（データ URL）。 */
  thumb: string;
}

/** 1x1 の緑の PNG。サムネイルの代わり（枠の中に引き伸ばして使う）。 */
export const TINY_PNG =
  'data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNkYPhfDwAChwGA60e6kgAAAABJRU5ErkJggg==';

/**
 * ページの読み込み前に入れる、Tauri の偽物（文字列で渡す。関数にすると変換の補助関数が混ざって動かないため）。
 * 記録のコマンドは、与えた状態・設定・半荘の一覧をそのまま返す。
 */
export function tauriMockScript(scenario: Scenario): string {
  return `(function (scenario) {
  var nextCallback = 1;
  var nextEvent = 1;
  var callbacks = {};
  function reply(cmd, args) {
    switch (cmd) {
      case 'plugin:event|listen': return nextEvent++;
      case 'plugin:event|unlisten': return null;
      case 'get_state': case 'add_mark': case 'add_rating': case 'undo': case 'new_session': return scenario.state;
      case 'get_settings': return scenario.settings;
      case 'set_settings': return args.settings;
      case 'set_orientation': return Object.assign({}, scenario.settings, { orientation: args.orientation });
      case 'list_sessions': return scenario.sessions;
      case 'get_startup_note': return null;
      default: return null;
    }
  }
  window.__TAURI_INTERNALS__ = {
    metadata: {
      currentWindow: { label: scenario.label },
      currentWebview: { windowLabel: scenario.label, label: scenario.label }
    },
    transformCallback: function (cb) { var id = nextCallback++; callbacks[id] = cb; return id; },
    unregisterCallback: function (id) { delete callbacks[id]; },
    convertFileSrc: function () { return scenario.thumb; },
    invoke: function (cmd, args) {
      try { return Promise.resolve(reply(cmd, args || {})); } catch (e) { return Promise.reject(e); }
    }
  };
  window.__TAURI_EVENT_PLUGIN_INTERNALS__ = { unregisterListener: function () {} };
})(${JSON.stringify(scenario)});`;
}

export interface AxeViolation {
  id: string;
  impact: string | null;
  help: string;
  nodes: string[];
}

export interface AxeSummary {
  violations: AxeViolation[];
  /** 検査を通った規則の id と、対象の要素の数。 */
  passes: Array<{ id: string; nodes: number }>;
}

/** axe-core をページに入れて実行する（色のコントラストの規則を含む全規則）。 */
export async function runAxe(page: Page): Promise<AxeSummary> {
  await page.addScriptTag({ path: requireFromHere.resolve('axe-core/axe.min.js') });
  return page.evaluate(async () => {
    interface AxeNode {
      target: unknown[];
    }
    interface AxeRule {
      id: string;
      impact?: string | null;
      help: string;
      nodes: AxeNode[];
    }
    interface AxeRun {
      violations: AxeRule[];
      passes: AxeRule[];
    }
    const axe = (window as unknown as { axe: { run: (c: Document) => Promise<AxeRun> } }).axe;
    const result = await axe.run(document);
    return {
      violations: result.violations.map((v) => ({
        id: v.id,
        impact: v.impact ?? null,
        help: v.help,
        nodes: v.nodes.map((n) => n.target.join(' ')),
      })),
      passes: result.passes.map((p) => ({ id: p.id, nodes: p.nodes.length })),
    };
  });
}

/** 重大（serious・critical）な違反だけを、読みやすい文にして返す。 */
export function seriousViolations(summary: AxeSummary): string[] {
  return summary.violations
    .filter((v) => v.impact === 'serious' || v.impact === 'critical')
    .map((v) => `${v.id} (${v.impact}): ${v.help} -> ${v.nodes.join(' | ')}`);
}

const FOCUSABLE =
  'a[href], button:not([disabled]), input:not([disabled]), select:not([disabled]), textarea:not([disabled]), [tabindex]:not([tabindex="-1"])';

/**
 * Tab キーだけで、すべての操作に届くか。届かなかった要素の説明を返す。
 * ラジオボタンは、1 つの組につき 1 か所に止まれば良い（組の中は矢印キーで動く）。
 */
export async function unreachableByTab(page: Page): Promise<{ total: number; missed: string[] }> {
  const targets = await page.evaluate((selector) => {
    const visible = (el: HTMLElement) => {
      const rect = el.getBoundingClientRect();
      const style = getComputedStyle(el);
      return rect.width > 0 && rect.height > 0 && style.visibility !== 'hidden' && style.display !== 'none';
    };
    const elements = Array.from(document.querySelectorAll<HTMLElement>(selector)).filter(visible);
    elements.forEach((el, index) => el.setAttribute('data-reach-id', String(index)));
    (document.activeElement as HTMLElement | null)?.blur();
    return elements.map((el, index) => ({
      id: String(index),
      group: el instanceof HTMLInputElement && el.type === 'radio' ? el.name : null,
      label: (el.getAttribute('aria-label') ?? el.textContent ?? el.tagName).trim().slice(0, 30),
    }));
  }, FOCUSABLE);

  const seen = new Set<string>();
  for (let i = 0; i < targets.length + 4; i += 1) {
    await page.keyboard.press('Tab');
    const id = await page.evaluate(() => document.activeElement?.getAttribute('data-reach-id') ?? null);
    if (id) seen.add(id);
  }

  const missed: string[] = [];
  const groupsSeen = new Set(targets.filter((t) => t.group && seen.has(t.id)).map((t) => t.group));
  for (const target of targets) {
    if (target.group) {
      if (!groupsSeen.has(target.group)) missed.push(`ラジオの組 ${target.group}`);
    } else if (!seen.has(target.id)) {
      missed.push(target.label);
    }
  }
  return { total: targets.length, missed: [...new Set(missed)] };
}
