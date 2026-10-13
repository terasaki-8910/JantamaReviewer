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

/** 接続が切れたときに、読み直す回数の上限。 */
const FETCH_ATTEMPTS = 4;

/** 接続が切れた・つながらなかったときの失敗か（fetch は TypeError を投げ、理由は cause に入る）。 */
function isDroppedConnection(error: unknown): boolean {
  const cause = (error as { cause?: { code?: unknown } } | null)?.cause;
  return (
    error instanceof TypeError &&
    typeof cause?.code === 'string' &&
    ['ECONNRESET', 'ECONNREFUSED', 'EPIPE', 'UND_ERR_SOCKET'].includes(cause.code)
  );
}

/**
 * 開発サーバーから 1 つ読む。接続が切れたときだけ、少し待って読み直す（読むだけなので、何度読んでも同じ）。
 * 多くのテストファイルが並んでサーバーとブラウザを動かして重いとき、使い回した接続をサーバーが閉じたのと同時に
 * 次の要求を送ると、ECONNRESET で失敗する（2026-10-11 の出題の取り込みの検査で、2 回続けて起きた）。
 */
async function fetchFromServer(url: URL): Promise<Response> {
  for (let attempt = 1; ; attempt += 1) {
    try {
      return await fetch(url);
    } catch (error) {
      if (attempt >= FETCH_ATTEMPTS || !isDroppedConnection(error)) throw error;
      await new Promise((resolve) => setTimeout(resolve, 250 * attempt));
    }
  }
}

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
    const response = await fetchFromServer(new URL(path, origin));
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
  /** true なら、画像の文字認識が終わらない（読み取りの進み具合の画面を見るため）。 */
  ocrHangs?: boolean;
  /** `ocr_sessions` が、すべての半荘について返す文字認識の写し。無ければ、空の写し。 */
  ocr?: unknown;
}

/** 設定の「記録の書き出し」（D-2）の流れに答えるための、偽物の答え。 */
export interface RecordsScenario {
  /** `records_overview` の答え。無ければ、半荘 0・答え 0・2 KB。 */
  overview?: { sessions: number; answers: number; bytes: number };
  /** 保存のダイアログ（`plugin:dialog|save`）が返すパス。無ければ、やめた（null）。 */
  savePath?: string;
  /** ファイルを選ぶダイアログ（`plugin:dialog|open`）が返すパス。無ければ、やめた（null）。 */
  openPath?: string;
  /** `export_records` が失敗する理由。 */
  exportError?: string;
  /** `inspect_records_file` の答え（読み込む前の確認の数）。無ければ、半荘 12・答え 84・取っておく 0。 */
  inspect?: { sessions: number; answers: number; held: number };
  /** `inspect_records_file` が失敗する理由（ファイルが正しくない）。 */
  inspectError?: string;
  /** `import_records` の答え。無ければ、`inspect` と同じ。 */
  imported?: { sessions: number; answers: number; held: number };
  /** `import_records` が失敗する理由。 */
  importError?: string;
}

/** 設定の「同期」（F15、D-4）の流れに答えるための、偽物の答え。 */
export interface SyncScenario {
  /** `get_sync_status` の答え（足りない項目は、使っていない・未設定の値で補う）。 */
  status?: Partial<{
    enabled: boolean;
    url_host: string;
    has_token: boolean;
    state: 'off' | 'idle' | 'syncing' | 'offline' | 'attention' | 'error';
    last_ok_ms: number | null;
    message: string | null;
    warnings: string[];
    can_allow_mass_delete: boolean;
    device_id: string;
  }>;
  /** `save_sync_connection` が失敗する理由。 */
  saveError?: string;
  /** `set_sync_enabled` が失敗する理由。 */
  enableError?: string;
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
  /** 保存してある答え（`list_answers` が返す。`record_answer` で増える。答えの記録 study.sqlite の偽物）。 */
  answers?: unknown[];
  /** 保存してある週の成績と重点（`list_weeks` が返す。`set_week` で替わる。study.sqlite の weeks 表の偽物。U-30）。 */
  weeks?: unknown[];
  /** 日付（YYYY-MM-DD）→ 保存してある今日の組（`get_daily_set`。`save_daily_set` は、その日の組が無いときだけ保存する）。 */
  dailySets?: Record<string, unknown[]>;
  /** 記録の書き出し・読み込み（D-2）への答え。無ければ、ダイアログはやめた扱い。 */
  records?: RecordsScenario;
  /** 同期（F15）への答え。無ければ、同期は未設定。 */
  sync?: SyncScenario;
  /**
   * 前の作り方で読んだ半荘の読み直し（F11、E-27）への答え。無ければ、読み直しは要らない（`needs_ocr_reread` は false）。
   * 写しの決まりの名前が `currentGeometry` と違う半荘だけ、要る。読み直しは、写しを `fresh` に置き換えて true を返す
   * （`hang` なら、終わらない。状態の 1 行を見るため）。
   */
  reread?: { currentGeometry: string; fresh: unknown; hang?: boolean };
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
  var records = scenario.records || {};
  // 同期（F15）の偽物。Rust 側と同じ決まり: URL を貼ると同期先のホスト名が付き、トークンを貼ると保管庫に入った扱いになる
  // （トークンの文字は、状態に出ない）。「今すぐ同期」は、同期中の知らせのあと、待機の知らせを出す
  var syncScenario = scenario.sync || {};
  var syncStatus = Object.assign(
    { enabled: false, url_host: '', has_token: false, state: 'off', last_ok_ms: null, message: null, warnings: [], can_allow_mass_delete: false, device_id: 'd-0123abcd' },
    JSON.parse(JSON.stringify(syncScenario.status || {}))
  );
  function syncEmit() {
    var copy = JSON.parse(JSON.stringify(syncStatus));
    setTimeout(function () { window.__jrEmit('sync-status', copy); }, 0);
    return copy;
  }
  function syncSettle() {
    syncStatus.state = 'syncing';
    syncEmit();
    setTimeout(function () {
      syncStatus.state = 'idle';
      syncStatus.last_ok_ms = Date.now();
      syncStatus.message = null;
      syncStatus.can_allow_mass_delete = false;
      syncEmit();
    }, 120);
  }
  // 答えの記録（study.sqlite）の偽物。Rust 側と同じ決まり: 答えには番号が付き、今日の組は、その日に 1 回だけ保存される
  var answers = JSON.parse(JSON.stringify(scenario.answers || []));
  var nextAnswerId = answers.reduce(function (max, a) { return Math.max(max, a.id); }, 0) + 1;
  var dailySets = JSON.parse(JSON.stringify(scenario.dailySets || {}));
  // 週の成績と重点（weeks 表）の偽物。Rust 側と同じ決まり: 重点は空の行を除く。成績も重点も空なら、記録ごと消して null
  var weeks = JSON.parse(JSON.stringify(scenario.weeks || []));
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
      case 'set_memo': mutate(args.sessionId, function (s) {
        var text = { candidates: args.candidates.trim(), reason: args.reason.trim() };
        if (text.candidates === '' && text.reason === '') delete s.memos.marks[String(args.markId)];
        else s.memos.marks[String(args.markId)] = text;
      }); return null;
      case 'clear_memo': mutate(args.sessionId, function (s) { delete s.memos.marks[String(args.markId)]; }); return null;
      case 'set_extra_memo': mutate(args.sessionId, function (s) {
        var extra = { id: args.id, candidates: args.candidates.trim(), reason: args.reason.trim() };
        if (args.decision !== null && args.decision !== undefined) extra.decision = args.decision;
        if (args.position !== null && args.position !== undefined) extra.position = args.position;
        var at = s.memos.extras.findIndex(function (e) { return e.id === args.id; });
        if (at < 0) s.memos.extras.push(extra); else s.memos.extras[at] = extra;
      }); return null;
      case 'clear_extra_memo': mutate(args.sessionId, function (s) { s.memos.extras = s.memos.extras.filter(function (e) { return e.id !== args.id; }); }); return null;
      case 'read_report': return reports[args.sessionId] === undefined ? null : reports[args.sessionId];
      case 'list_answers': return JSON.parse(JSON.stringify(answers));
      case 'record_answer': {
        var made = Object.assign({ causes: [], principle: '', maka_move: null }, args.answer, { id: nextAnswerId++ });
        answers.push(made);
        return JSON.parse(JSON.stringify(made));
      }
      case 'update_answer_notes': {
        var target = answers.filter(function (a) { return a.id === args.id; })[0];
        if (!target) throw '答えが見つかりません: ' + args.id;
        target.causes = args.notes.causes;
        target.principle = args.notes.principle;
        target.maka_move = args.notes.maka_move;
        return JSON.parse(JSON.stringify(target));
      }
      case 'get_daily_set': return dailySets[args.date] === undefined ? null : JSON.parse(JSON.stringify(dailySets[args.date]));
      case 'save_daily_set':
        if (dailySets[args.date] === undefined) dailySets[args.date] = args.items;
        return JSON.parse(JSON.stringify(dailySets[args.date]));
      case 'list_weeks':
        return JSON.parse(JSON.stringify(weeks.slice().sort(function (a, b) { return a.week < b.week ? -1 : 1; })));
      case 'set_week': {
        var rec = JSON.parse(JSON.stringify(args.record));
        // 改行の文字は、この文字列（テンプレート）の中では書けないので、文字コードで作る。trim が、行末の CR を取る
        rec.focus = String(rec.focus || '').split(String.fromCharCode(10)).map(function (l) { return l.trim(); }).filter(function (l) { return l !== ''; }).join(String.fromCharCode(10));
        weeks = weeks.filter(function (w) { return w.week !== rec.week; });
        if (Object.keys(rec.stats || {}).length === 0 && rec.focus === '') return null;
        weeks.push(rec);
        return JSON.parse(JSON.stringify(rec));
      }
      case 'count_solved':
        return args.sessionIds.map(function (id) {
          var keys = {};
          answers.forEach(function (a) { if (a.session_id === id) keys[a.decision_key] = true; });
          return { session_id: id, solved: Object.keys(keys).length };
        });
      case 'plugin:dialog|save': return records.savePath === undefined ? null : records.savePath;
      case 'plugin:dialog|open': return records.openPath === undefined ? null : records.openPath;
      case 'records_overview': return records.overview || { sessions: 0, answers: 0, bytes: 2048 };
      case 'export_records': {
        if (records.exportError) throw records.exportError;
        var shown = records.overview || { sessions: 0, answers: 0, bytes: 2048 };
        return { path: args.path, sessions: shown.sessions, answers: shown.answers, bytes: shown.bytes };
      }
      case 'inspect_records_file': {
        if (records.inspectError) throw records.inspectError;
        return records.inspect || { sessions: 12, answers: 84, held: 0 };
      }
      case 'import_records': {
        if (records.importError) throw records.importError;
        return records.imported || records.inspect || { sessions: 12, answers: 84, held: 0 };
      }
      case 'get_sync_status': return JSON.parse(JSON.stringify(syncStatus));
      case 'save_sync_connection': {
        if (syncScenario.saveError) throw syncScenario.saveError;
        if (args.url) syncStatus.url_host = String(args.url).replace(/^[a-z]+:[/][/]/, '').replace(/[/]+$/, '');
        if (args.token) syncStatus.has_token = true;
        if (!syncStatus.url_host) throw '同期先の DB の URL を貼ってください';
        return JSON.parse(JSON.stringify(syncStatus));
      }
      case 'set_sync_enabled': {
        if (syncScenario.enableError) throw syncScenario.enableError;
        syncStatus.enabled = !!args.enabled;
        syncStatus.state = args.enabled ? 'idle' : 'off';
        return JSON.parse(JSON.stringify(syncStatus));
      }
      case 'sync_now': case 'rebuild_sync_db': case 'allow_sync_mass_delete': syncSettle(); return null;
      case 'disconnect_sync':
        syncStatus.enabled = false; syncStatus.state = 'off'; syncStatus.has_token = false; syncStatus.message = null;
        return JSON.parse(JSON.stringify(syncStatus));
      case 'needs_ocr_reread': {
        if (!scenario.reread) return false;
        var stale = sessions.filter(function (s) { return s.id === args.sessionId; })[0];
        return !!(stale && stale.ocr && stale.ocr.geometry !== scenario.reread.currentGeometry);
      }
      case 'reread_ocr':
        if (!scenario.reread) return false;
        if (scenario.reread.hang) return new Promise(function () {});
        mutate(args.sessionId, function (s) { s.ocr = scenario.reread.fresh; });
        return true;
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
        if (importing.ocrHangs) return new Promise(function () {});
        return args.sessionIds.map(function (id) {
          return { session_id: id, ocr: importing.ocr || { geometry: 'center-v3-cyan-tight', entries: {} } };
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

/**
 * 検討画面が最初の絵を描き終えるまで待つ（サイドバーの半荘の一覧と、本文の見出し）。
 * 窓が細い（640px 未満）と、サイドバーは隠れている（引き出し）ので、一覧は「見える」ではなく「ある」まで待つ。
 */
export async function waitForMainReady(page: Page): Promise<void> {
  // getByRole は、見えていない物（引き出しの中）に当たらないので、属性で探す
  await page.locator('nav[aria-label="半荘の一覧"]').waitFor({ state: 'attached' });
  await page.getByRole('heading', { level: 1 }).first().waitFor();
}

/** サイドバーの「数」（今日の出題・解き直し）が出るまで待つ（出題のデータを読み終えた印）。引き出しが閉じていても待てる。 */
export async function waitForSidebarCounts(page: Page, timeout = 20_000): Promise<void> {
  await page.locator('nav[aria-label="メイン"] .count').first().waitFor({ state: 'attached', timeout });
}

/**
 * サイドバーの物を操作できるようにする。窓が細い（640px 未満）と、サイドバーは隠れているので、左上のボタンで引き出しを開く
 * （開いたあと、項目を選ぶと自動で閉じる）。広い窓で出ているときは、何もしない。
 */
export async function ensureSidebar(page: Page): Promise<void> {
  const hidden = await page.evaluate(() => document.getElementById('sidebar')?.hasAttribute('inert') ?? true);
  if (!hidden) return;
  await page.getByRole('button', { name: 'サイドバーを開く' }).click();
  await page.waitForFunction(() => document.getElementById('sidebar')?.hasAttribute('inert') === false);
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
 * `roving` は、矢印キーで動く組（手牌・答えのボタン・タブ）の要素の選び方。その中の `tabindex="-1"` の要素は、止まり場所でないので、
 * 数えない（止まり場所になる 1 つ — `tabindex="0"` の要素 — は、数える）。
 */
export async function unreachableByTab(
  page: Page,
  options: { roving?: string } = {},
): Promise<{ total: number; missed: string[] }> {
  const targets = await page.evaluate(
    ({ selector, roving }) => {
      const visible = (el: HTMLElement) => {
        const rect = el.getBoundingClientRect();
        const style = getComputedStyle(el);
        // 閉じた <details> の中など（content-visibility で描かれない所）は、見えていないものとして数える
        // inert（確認のダイアログの裏・開いた引き出しの裏・閉じた引き出しの中）は、Tab で届かないのが正しいので、数えない
        return (
          rect.width > 0 &&
          rect.height > 0 &&
          style.visibility !== 'hidden' &&
          style.display !== 'none' &&
          el.checkVisibility() &&
          el.closest('[inert]') === null &&
          el.closest('[aria-hidden="true"]') === null
        );
      };
      const skipped = (el: HTMLElement) =>
        (el as HTMLButtonElement).disabled === true ||
        (roving !== undefined && el.matches(roving) && el.getAttribute('tabindex') === '-1');
      const elements = Array.from(document.querySelectorAll<HTMLElement>(selector)).filter(
        (el) => visible(el) && !skipped(el),
      );
      elements.forEach((el, index) => el.setAttribute('data-reach-id', String(index)));
      (document.activeElement as HTMLElement | null)?.blur();
      return elements.map((el, index) => ({
        id: String(index),
        group: el instanceof HTMLInputElement && el.type === 'radio' ? el.name : null,
        label: (el.getAttribute('aria-label') ?? el.textContent ?? el.tagName).trim().slice(0, 30),
      }));
    },
    { selector: FOCUSABLE, roving: options.roving },
  );

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

export interface BoxRect {
  left: number;
  right: number;
  top: number;
  bottom: number;
}

export interface InfoTipMeasure {
  tip: BoxRect;
  icon: BoxRect;
  /** 説明している物（行の一覧など）。 */
  explained: BoxRect | null;
  innerWidth: number;
  innerHeight: number;
  /** 重なりを出した側（above = アイコンの上、below = 下）。 */
  side: string | undefined;
  text: string;
}

/** 開いている説明の重なり（InfoTip。U-25）の置き場所を測る。開いていなければ null。 */
export async function measureInfoTip(page: Page, explained: string): Promise<InfoTipMeasure | null> {
  return page.evaluate((selector) => {
    const tip = document.querySelector<HTMLElement>('.infotip-pop:not([hidden])');
    const icon = document.querySelector<HTMLElement>('.infotip-btn[data-open="1"]');
    if (tip === null || icon === null) return null;
    const box = (el: Element): BoxRect => {
      const r = el.getBoundingClientRect();
      return { left: r.left, right: r.right, top: r.top, bottom: r.bottom };
    };
    const target = document.querySelector(selector);
    return {
      tip: box(tip),
      icon: box(icon),
      explained: target === null ? null : box(target),
      innerWidth: window.innerWidth,
      innerHeight: window.innerHeight,
      side: tip.dataset.side,
      text: tip.textContent ?? '',
    };
  }, explained);
}

/** 2 つの箱が重なっているか（辺が接するだけなら、重なっていない）。 */
export function boxesOverlap(a: BoxRect, b: BoxRect): boolean {
  return a.left < b.right && b.left < a.right && a.top < b.bottom && b.top < a.bottom;
}
