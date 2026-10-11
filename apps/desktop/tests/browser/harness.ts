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

/** 取り込みの流れ（クリップボード・結果の取得・文字認識）に答えるための、偽物の答え。 */
export interface ImportScenario {
  /** `read_clipboard_text` の答え。無ければ null（クリップボードが空）。 */
  clipboard?: string | null;
  /** `fetch_report`・`read_report_file_text` の答え（結果の JSON の文字）。 */
  reportText?: string;
  /** true なら、結果の取得が終わらない（「取り込んでいます」の画面を見るため）。 */
  fetchHangs?: boolean;
  /** `ocr_sessions` が、すべての半荘について返す文字認識の写し。無ければ、空の写し。 */
  ocr?: unknown;
}

export interface Scenario {
  label: 'main' | 'widget';
  state: unknown;
  settings: unknown;
  /** `get_input_status` が返す、ボタンの登録・テスト・補助プログラムの状態。無ければ null。 */
  inputStatus?: unknown;
  /** 半荘の一覧。`delete_sessions`・`restore_sessions` で、消す・戻すと、`list_sessions` の答えが変わる（Rust 側と同じ決まり）。 */
  sessions: unknown[];
  /** 取り込んだ結果（半荘の名前 → 結果の JSON の文字）。`read_report` が返す。無い半荘は null。 */
  reports?: Record<string, string>;
  /** 次の `delete_sessions`・`restore_sessions` を失敗させる理由（失敗の通知を見るため）。 */
  failDelete?: string;
  failRestore?: string;
  /** `convertFileSrc` が返す画像（データ URL）。 */
  thumb: string;
  /** 画像のパスに、このキーの文字が含まれていれば、`thumb` の代わりに、この画像（データ URL）を返す（画像ごとに違う絵にしたいとき）。 */
  thumbBy?: Record<string, string>;
  /** 取り込みの流れへの答え。無ければ、クリップボードは空。 */
  importing?: ImportScenario;
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
  var listeners = {};
  var importing = scenario.importing || {};
  var sessions = scenario.sessions.slice();
  var trash = [];
  var reports = scenario.reports || {};
  var failDelete = scenario.failDelete || null;
  var failRestore = scenario.failRestore || null;
  window.__jrCalls = [];
  function sortedSessions() {
    return sessions.slice().sort(function (a, b) {
      return b.started_ms - a.started_ms || (a.id < b.id ? 1 : a.id > b.id ? -1 : 0);
    });
  }
  function announceChange() {
    setTimeout(function () { window.__jrEmit('state-changed', {}); }, 0);
  }
  // 結びつけ・自己評価・MAKA の保存（Rust 側と同じく、半荘に値を入れて、一覧に反映する）。
  function mutate(id, change) {
    var at = sessions.findIndex(function (s) { return s.id === id; });
    if (at < 0) throw '半荘が見つかりません: ' + id;
    var copy = JSON.parse(JSON.stringify(sessions[at]));
    change(copy);
    sessions[at] = copy;
    announceChange();
  }
  function reply(cmd, args) {
    window.__jrCalls.push({ cmd: cmd, args: args });
    switch (cmd) {
      case 'delete_sessions': {
        if (failDelete) { var why = failDelete; failDelete = null; throw why; }
        args.ids.forEach(function (id) {
          if (!sessions.some(function (s) { return s.id === id; })) throw '半荘が見つかりません: ' + id;
        });
        args.ids.forEach(function (id) {
          var found = sessions.filter(function (s) { return s.id === id; })[0];
          sessions = sessions.filter(function (s) { return s.id !== id; });
          trash.push(found);
        });
        announceChange();
        return null;
      }
      case 'restore_sessions': {
        if (failRestore) { var reason = failRestore; failRestore = null; throw reason; }
        args.ids.forEach(function (id) {
          var found = trash.filter(function (s) { return s.id === id; })[0];
          if (!found) throw '消した半荘の中に見つからないため、戻せません: ' + id;
          trash = trash.filter(function (s) { return s.id !== id; });
          sessions.push(found);
        });
        announceChange();
        return null;
      }
      case 'set_mark_link': mutate(args.sessionId, function (s) { s.links.marks[String(args.markId)] = args.decision; }); return null;
      case 'clear_mark_link': mutate(args.sessionId, function (s) { delete s.links.marks[String(args.markId)]; }); return null;
      case 'set_self_rating': mutate(args.sessionId, function (s) { s.self_ratings.kyokus[args.kyoku] = args.rating; }); return null;
      case 'clear_self_rating': mutate(args.sessionId, function (s) { delete s.self_ratings.kyokus[args.kyoku]; }); return null;
      case 'set_maka_grade': mutate(args.sessionId, function (s) { s.maka.kyokus[args.kyoku] = args.grade; }); return null;
      case 'clear_maka_grade': mutate(args.sessionId, function (s) { delete s.maka.kyokus[args.kyoku]; }); return null;
      case 'set_maka_hanchan': mutate(args.sessionId, function (s) { s.maka.hanchan = args.grade; }); return null;
      case 'clear_maka_hanchan': mutate(args.sessionId, function (s) { delete s.maka.hanchan; }); return null;
      case 'read_report': return reports[args.sessionId] === undefined ? null : reports[args.sessionId];
      case 'plugin:event|listen':
        (listeners[args.event] = listeners[args.event] || []).push(args.handler);
        return nextEvent++;
      case 'plugin:event|unlisten': return null;
      case 'read_clipboard_text': return importing.clipboard === undefined ? null : importing.clipboard;
      case 'open_mjai_window': case 'close_mjai_window': case 'replace_links': return null;
      case 'report_id_from_text': { var m = /[0-9a-f]{16}/.exec(args.text); return m ? m[0] : null; }
      case 'fetch_report': case 'read_report_file_text':
        return importing.fetchHangs ? new Promise(function () {}) : importing.reportText;
      case 'ocr_sessions':
        return args.sessionIds.map(function (id) {
          return { session_id: id, ocr: importing.ocr || { geometry: 'center-v2-lanczos3x-variants', entries: {} } };
        });
      case 'save_report': return args.sessionId === null ? '20261010-120000' : args.sessionId;
      case 'get_state': case 'add_mark': case 'add_rating': case 'undo': case 'new_session': return scenario.state;
      case 'get_settings': return scenario.settings;
      case 'set_settings': return args.settings;
      case 'set_orientation': return Object.assign({}, scenario.settings, { orientation: args.orientation });
      case 'get_input_status': return scenario.inputStatus === undefined ? null : scenario.inputStatus;
      case 'list_sessions': return sortedSessions();
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
    convertFileSrc: function (path) {
      var by = scenario.thumbBy || {};
      for (var key in by) { if (String(path).indexOf(key) >= 0) return by[key]; }
      return scenario.thumb;
    },
    invoke: function (cmd, args) {
      try { return Promise.resolve(reply(cmd, args || {})); } catch (e) { return Promise.reject(e); }
    }
  };
  window.__TAURI_EVENT_PLUGIN_INTERNALS__ = { unregisterListener: function () {} };
  // 試験から、Rust 側のイベント（mjai の窓の知らせなど）を、登録された受け手に送る。
  window.__jrEmit = function (event, payload) {
    (listeners[event] || []).forEach(function (handler) {
      var callback = callbacks[handler];
      if (callback) callback({ event: event, id: 0, payload: payload });
    });
  };
})(${JSON.stringify(scenario)});`;
}

/** 検討画面が最初の絵を描き終えるまで待つ（サイドバーの半荘の一覧と、本文の見出し）。 */
export async function waitForMainReady(page: Page): Promise<void> {
  await page.getByRole('navigation', { name: '半荘の一覧' }).waitFor();
  await page.getByRole('heading', { level: 1 }).first().waitFor();
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
