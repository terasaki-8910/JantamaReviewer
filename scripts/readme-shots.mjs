#!/usr/bin/env node
/**
 * README 用の画面の写真を、作った本物の実行ファイル（release）から撮る。
 *
 *   node scripts/readme-shots.mjs <迷いマークの画像のフォルダ> [出力先]
 *
 * - 迷いマークの画像のフォルダ: プレイヤー名をぼかした雀魂の画面 mark-1.jpg ... mark-6.jpg
 *   （FX-4 の半荘の 6 つの迷いマークの画面）。雀魂の画面は、このフォルダの画像だけを使う。
 * - 出力先: 既定は docs/images。
 * - 実行ファイル: 既定は apps/desktop/src-tauri/target/release/jantama-reviewer.exe（環境変数 JANTAMA_EXE で変えられる）。
 *   先に `pnpm --filter @jantama/desktop tauri build --no-bundle` で作っておく。
 *
 * 流れ（アプリは 2 回起動する。同じ一時フォルダを使う）:
 * 1. 取り込みの流れ: 結果を取り込む前の半荘を 1 つと、結果だけの半荘を置いて起動し、画面の操作で取り込む
 *    （文字認識と結びつけは、アプリの本物の処理）。
 * 2. そのほかの画面: 記録中の半荘（ウィジェットが続きを記録する半荘）を足して起動し直し、ウィジェット・半荘の一覧・
 *    半荘の画面・設定を撮る。
 *
 * 安全のために:
 * - 設定フォルダと保存先は、一時フォルダの中だけ。本物のデータ（%USERPROFILE%\JantamaReviewerData）は、読みも書きもしない
 *   （そこを指す場所は、使う前に弾く）。
 * - 起動するのは、この実行で作った実行ファイルの 1 つだけ。終わりは、そのプロセス番号だけを強制終了する
 *   （ほかの jantama-reviewer.exe には触れない）。強制終了にするのは、終了のときの「消した半荘のごみ箱への移し替え」を
 *   走らせないため。
 * - クリップボードは書き換えない。アプリの画面が読む「クリップボードの文字」は、画面の通信の層で偽の牌譜リンクに差し替える
 *   ので、本物のクリップボードは読みもしない。mjai.ekyu.moe の窓は開かず、何も送らず、何も取らない
 *   （結果の JSON は、リポジトリの固定データを、画面の通信の層で渡す）。
 * - 雀魂の画面を撮る迷いマークの記録は、アプリでは行わない。半荘の記録（events.jsonl と画像）は、この道具が書く。
 * - 設定ページの写真だけは、本物の状態ではなく、表示を差し替える（保存先を `C:\Users\user\...` に、補助プログラムを
 *   「動いています」に、ボタンを既定の「戻る」に）。この道具の試験用のアプリは、本物のアプリが開いているパイプを取れず、
 *   保存先は一時フォルダで、ボタンは本物のサイドボタンを奪わないよう F24 にしてあるため。
 */
import { spawn, spawnSync } from 'node:child_process';
import { copyFileSync, existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from 'node:fs';
import net from 'node:net';
import { homedir, tmpdir } from 'node:os';
import { dirname, join, resolve, sep } from 'node:path';
import { fileURLToPath } from 'node:url';
import { deflateSync, inflateSync } from 'node:zlib';

const sleep = (ms) => new Promise((done) => setTimeout(done, ms));
const p2 = (n) => String(n).padStart(2, '0');

// ---- 場所と、本物のデータに触れないための確認 ----

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const REAL_DATA = resolve(homedir(), 'JantamaReviewerData');

const inside = (child, parent) => {
  const c = resolve(child).toLowerCase();
  const p = resolve(parent).toLowerCase();
  return c === p || c.startsWith(p + sep);
};

/** 本物のデータの置き場の中を指す場所は、読むのにも書くのにも使わない。 */
function safe(path) {
  if (inside(path, REAL_DATA)) throw new Error(`本物のデータの置き場には触れません: ${path}`);
  return path;
}

const [marksArg, outArg] = process.argv.slice(2);
if (marksArg === undefined) {
  console.error('使い方: node scripts/readme-shots.mjs <迷いマークの画像のフォルダ（mark-1.jpg ... mark-6.jpg）> [出力先（既定: docs/images）]');
  process.exit(2);
}
const MARKS = safe(resolve(marksArg));
const OUT = safe(resolve(outArg ?? join(ROOT, 'docs', 'images')));
const EXE = safe(resolve(process.env.JANTAMA_EXE ?? join(ROOT, 'apps', 'desktop', 'src-tauri', 'target', 'release', 'jantama-reviewer.exe')));
const REPORTS = join(ROOT, 'packages', 'engine', 'tests', 'fixtures', 'reports');
for (const file of [EXE, ...[1, 2, 3, 4, 5, 6].map((n) => join(MARKS, `mark-${n}.jpg`))]) {
  if (!existsSync(file)) {
    console.error(`見つかりません: ${file}`);
    process.exit(2);
  }
}

const TEMP = safe(mkdtempSync(join(tmpdir(), 'jr-readme-shots-')));
const CONFIG = safe(join(TEMP, 'config'));
const DATA = safe(join(TEMP, 'data'));
mkdirSync(CONFIG, { recursive: true });
mkdirSync(join(DATA, 'games'), { recursive: true });
// ボタンは、本物のサイドボタン（既定の「戻る」）を奪わないよう、押されないキー（F24）にしておく。
writeFileSync(join(CONFIG, 'settings.json'), JSON.stringify({ data_dir: DATA, trigger: { kind: 'key', code: 'F24' } }), 'utf8');

// ---- PNG の再圧縮（画素は変えない） ----

const PNG_SIGNATURE = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);

const CRC_TABLE = (() => {
  const table = new Uint32Array(256);
  for (let n = 0; n < 256; n += 1) {
    let c = n;
    for (let k = 0; k < 8; k += 1) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
    table[n] = c >>> 0;
  }
  return table;
})();

function crc32(...buffers) {
  let c = 0xffffffff;
  for (const buffer of buffers) for (const byte of buffer) c = CRC_TABLE[(c ^ byte) & 0xff] ^ (c >>> 8);
  return (c ^ 0xffffffff) >>> 0;
}

function pngChunk(type, data) {
  const head = Buffer.alloc(8);
  head.writeUInt32BE(data.length, 0);
  head.write(type, 4, 'latin1');
  const tail = Buffer.alloc(4);
  tail.writeUInt32BE(crc32(head.subarray(4), data), 0);
  return Buffer.concat([head, data, tail]);
}

function readPng(buffer) {
  if (buffer.length < 33 || !buffer.subarray(0, 8).equals(PNG_SIGNATURE)) return null;
  let offset = 8;
  let header = null;
  const parts = [];
  const others = [];
  while (offset + 12 <= buffer.length) {
    const length = buffer.readUInt32BE(offset);
    const type = buffer.toString('latin1', offset + 4, offset + 8);
    const data = buffer.subarray(offset + 8, offset + 8 + length);
    if (type === 'IHDR') {
      header = { width: data.readUInt32BE(0), height: data.readUInt32BE(4), depth: data[8], colorType: data[9], interlace: data[12] };
    } else if (type === 'IDAT') {
      parts.push(data);
    } else if (type === 'IEND') {
      break;
    } else if (parts.length === 0) {
      others.push(pngChunk(type, data));
    }
    offset += 12 + length;
  }
  return header === null ? null : { ...header, idat: Buffer.concat(parts), others };
}

const paeth = (a, b, c) => {
  const p = a + b - c;
  const pa = Math.abs(p - a);
  const pb = Math.abs(p - b);
  const pc = Math.abs(p - c);
  return pa <= pb && pa <= pc ? a : pb <= pc ? b : c;
};

function unfilter(raw, width, height, bpp) {
  const stride = width * bpp;
  const out = Buffer.alloc(stride * height);
  for (let y = 0; y < height; y += 1) {
    const filter = raw[y * (stride + 1)];
    const src = y * (stride + 1) + 1;
    const dst = y * stride;
    for (let x = 0; x < stride; x += 1) {
      const a = x >= bpp ? out[dst + x - bpp] : 0;
      const b = y > 0 ? out[dst - stride + x] : 0;
      const c = x >= bpp && y > 0 ? out[dst - stride + x - bpp] : 0;
      let v = raw[src + x];
      if (filter === 1) v += a;
      else if (filter === 2) v += b;
      else if (filter === 3) v += (a + b) >> 1;
      else if (filter === 4) v += paeth(a, b, c);
      out[dst + x] = v & 255;
    }
  }
  return out;
}

/** 行ごとに、5 種類のフィルタのうち、差の絶対値の合計がいちばん小さいものを選ぶ。 */
function refilter(pixels, width, height, bpp) {
  const stride = width * bpp;
  const out = Buffer.alloc((stride + 1) * height);
  const candidates = [0, 1, 2, 3, 4].map(() => Buffer.alloc(stride));
  for (let y = 0; y < height; y += 1) {
    const row = pixels.subarray(y * stride, (y + 1) * stride);
    const prev = y > 0 ? pixels.subarray((y - 1) * stride, y * stride) : null;
    let best = 0;
    let bestScore = Infinity;
    for (let f = 0; f < 5; f += 1) {
      const dst = candidates[f];
      let score = 0;
      for (let x = 0; x < stride; x += 1) {
        const a = x >= bpp ? row[x - bpp] : 0;
        const b = prev === null ? 0 : prev[x];
        const c = prev === null || x < bpp ? 0 : prev[x - bpp];
        let predicted = 0;
        if (f === 1) predicted = a;
        else if (f === 2) predicted = b;
        else if (f === 3) predicted = (a + b) >> 1;
        else if (f === 4) predicted = paeth(a, b, c);
        const v = (row[x] - predicted) & 255;
        dst[x] = v;
        score += v < 128 ? v : 256 - v;
      }
      if (score < bestScore) {
        bestScore = score;
        best = f;
      }
    }
    out[y * (stride + 1)] = best;
    candidates[best].copy(out, y * (stride + 1) + 1);
  }
  return out;
}

/** 透明な画素が 1 つも無い RGBA は、RGB にする。 */
function dropOpaqueAlpha(rgba) {
  const rgb = Buffer.alloc((rgba.length / 4) * 3);
  for (let i = 0, j = 0; i < rgba.length; i += 4, j += 3) {
    if (rgba[i + 3] !== 255) return null;
    rgb[j] = rgba[i];
    rgb[j + 1] = rgba[i + 1];
    rgb[j + 2] = rgba[i + 2];
  }
  return rgb;
}

function optimizePng(original) {
  const png = readPng(original);
  if (png === null || png.depth !== 8 || png.interlace !== 0 || (png.colorType !== 6 && png.colorType !== 2)) return original;
  const bpp = png.colorType === 6 ? 4 : 3;
  const pixels = unfilter(inflateSync(png.idat), png.width, png.height, bpp);
  let body = pixels;
  let colorType = png.colorType;
  let channels = bpp;
  if (colorType === 6) {
    const rgb = dropOpaqueAlpha(pixels);
    if (rgb !== null) {
      body = rgb;
      colorType = 2;
      channels = 3;
    }
  }
  const header = Buffer.alloc(13);
  header.writeUInt32BE(png.width, 0);
  header.writeUInt32BE(png.height, 4);
  header[8] = 8;
  header[9] = colorType;
  const out = Buffer.concat([
    PNG_SIGNATURE,
    pngChunk('IHDR', header),
    ...png.others,
    pngChunk('IDAT', deflateSync(refilter(body, png.width, png.height, channels), { level: 9, memLevel: 9 })),
    pngChunk('IEND', Buffer.alloc(0)),
  ]);
  const back = readPng(out);
  if (back === null || !unfilter(inflateSync(back.idat), png.width, png.height, channels).equals(body)) {
    throw new Error('PNG の再圧縮で、画素が変わりました');
  }
  return out.length < original.length ? out : original;
}

function writePng(name, buffer) {
  const optimized = optimizePng(buffer);
  const path = safe(join(OUT, name));
  mkdirSync(dirname(path), { recursive: true });
  writeFileSync(path, optimized);
  const png = readPng(optimized);
  console.log(`  ${name}: ${png.width}x${png.height}, ${Math.round(optimized.length / 1024)} KB（再圧縮の前 ${Math.round(buffer.length / 1024)} KB）`);
}

// ---- 保存先に置く半荘（events.jsonl・画像・結果） ----

const NOW = Date.now();
/** 今日から dayOffset 日ずれた日の、ローカル時刻 hh:mm:ss（ミリ秒）。 */
const at = (dayOffset, hh, mm, ss = 0) => {
  const d = new Date(NOW);
  d.setDate(d.getDate() + dayOffset);
  d.setHours(hh, mm, ss, 0);
  return d.getTime();
};
const stamp = (ms) => {
  const d = new Date(ms);
  return `${d.getFullYear()}${p2(d.getMonth() + 1)}${p2(d.getDate())}-${p2(d.getHours())}${p2(d.getMinutes())}${p2(d.getSeconds())}`;
};
const stem = (ms) => `${stamp(ms)}-${String(ms % 1000).padStart(3, '0')}`;

/**
 * 半荘のフォルダを書く。`items` は迷いマーク（`mark`: 画像の番号）と評価（`rating`）。
 * 画像は JPEG のまま、アプリが付けるのと同じ名前（.png）で置く（読む側は、中身で形式を見分ける）。
 */
function writeSession({ start, items = [], report = null }) {
  const id = stamp(start);
  const dir = safe(join(DATA, 'games', id));
  mkdirSync(dir, { recursive: true });
  const events = [{ id: 0, t_ms: start, type: 'session_start' }];
  for (const item of [...items].sort((a, b) => a.t - b.t)) {
    if (item.mark !== undefined) {
      const relative = `marks/${stem(item.t)}.png`;
      mkdirSync(join(dir, 'marks'), { recursive: true });
      copyFileSync(join(MARKS, `mark-${item.mark}.jpg`), join(dir, relative));
      events.push({ id: events.length, t_ms: item.t, type: 'mark', screenshot: relative, capture: 'window' });
    } else {
      events.push({ id: events.length, t_ms: item.t, type: 'rating', rating: item.rating });
    }
  }
  writeFileSync(join(dir, 'events.jsonl'), `${events.map((e) => JSON.stringify(e)).join('\n')}\n`, 'utf8');
  if (report !== null) copyFileSync(join(REPORTS, `${report}.json`), join(dir, 'report.json'));
  return id;
}

const FX4 = '5b821c8a048ff791';
/** 昨日の夜の半荘（FX-4 の結果を、画面の操作で取り込む）。迷いは 6 つ、評価は 5 局分。 */
const A_START = at(-1, 21, 3, 12);
const A_ITEMS = [
  { t: at(-1, 21, 5, 10), mark: 1 },
  { t: at(-1, 21, 7, 5), rating: 'good' },
  { t: at(-1, 21, 10, 30), mark: 2 },
  { t: at(-1, 21, 11, 40), rating: 'fair' },
  { t: at(-1, 21, 13, 10), mark: 3 },
  { t: at(-1, 21, 14, 45), mark: 4 },
  { t: at(-1, 21, 16, 0), rating: 'good' },
  { t: at(-1, 21, 19, 20), rating: 'bad' },
  { t: at(-1, 21, 21, 40), mark: 5 },
  { t: at(-1, 21, 23, 15), mark: 6 },
  { t: at(-1, 21, 24, 30), rating: 'fair' },
];
/** 結果だけの半荘（記録の無いまま取り込んだもの）。一覧に段階の印を並べるため。 */
const RESULT_ONLY = [
  { report: '002ca97adccc486d', start: at(-1, 19, 20, 8) },
  { report: '3a36dac7c7fc18ce', start: at(-2, 22, 41, 30) },
  { report: 'be0a2a523fdd7758', start: at(-2, 20, 5, 44) },
  { report: 'f738896995c33fed', start: at(-5, 21, 30, 2) },
  { report: 'f9da87cbcd7af5e9', start: at(-8, 20, 48, 51) },
];

/** 今まさに記録している半荘（ウィジェットが、起動し直したあとも続きを記録する）。迷い 4・評価 3。 */
function writeRecordingSession() {
  const n = Date.now();
  const minutesAgo = (min, sec = 0) => n - (min * 60 + sec) * 1000;
  const midnight = new Date(n).setHours(0, 0, 0, 0);
  if (minutesAgo(28) < midnight) throw new Error('日付が変わった直後は、日付の並びが崩れるので、時間をおいてから実行してください');
  return writeSession({
    start: minutesAgo(28),
    items: [
      { t: minutesAgo(24), mark: 2 },
      { t: minutesAgo(21, 20), rating: 'good' },
      { t: minutesAgo(17, 30), mark: 3 },
      { t: minutesAgo(14), rating: 'fair' },
      { t: minutesAgo(10, 45), mark: 5 },
      { t: minutesAgo(7, 30), rating: 'bad' },
      { t: minutesAgo(4, 10), mark: 6 },
    ],
  });
}

// 雀魂の画面で、コピーした牌譜リンクの代わりに使う、偽の牌譜リンク（本物の牌譜の番号ではない）。日付は A の半荘の日。
const paipuDate = (() => {
  const d = new Date(A_START);
  return `${p2(d.getFullYear() % 100)}${p2(d.getMonth() + 1)}${p2(d.getDate())}`;
})();
const FAKE_PAIPU = `${paipuDate}-5f2c1a9e-3b7d-4e21-9c60-a41d8e7b2f03`;
const FAKE_LINK = `雀魂牌譜:https://game.mahjongsoul.com/?paipu=${FAKE_PAIPU}`;
const FAKE_RESULT_URL = `https://mjai.ekyu.moe/killerducky/?data=/report/${FX4}.json`;

// ---- アプリの起動と、Chrome DevTools Protocol（WebView2 の遠隔デバッグ） ----

let child = null;
let port = 0;
let stderr = '';

const freePort = () =>
  new Promise((done, fail) => {
    const server = net.createServer();
    server.once('error', fail);
    server.listen(0, '127.0.0.1', () => {
      const { port: found } = server.address();
      server.close(() => done(found));
    });
  });

async function targets() {
  const res = await fetch(`http://127.0.0.1:${port}/json`);
  return res.json();
}

async function waitTarget(match, label) {
  const end = Date.now() + 60000;
  for (;;) {
    if (child.exitCode !== null) throw new Error(`アプリが終わってしまった（終了コード ${child.exitCode}）: ${stderr.trim()}`);
    try {
      const found = (await targets()).find(match);
      if (found) return found;
    } catch {
      // まだ起動の途中
    }
    if (Date.now() > end) throw new Error(`見つからない: ${label}`);
    await sleep(200);
  }
}

function connect(wsUrl) {
  return new Promise((done, fail) => {
    const ws = new WebSocket(wsUrl);
    let id = 0;
    const pending = new Map();
    ws.onmessage = (event) => {
      const msg = JSON.parse(event.data);
      if (msg.id !== undefined && pending.has(msg.id)) {
        const { resolve: ok, reject } = pending.get(msg.id);
        pending.delete(msg.id);
        if (msg.error) reject(new Error(JSON.stringify(msg.error)));
        else ok(msg.result);
      }
    };
    ws.onerror = () => fail(new Error('WebSocket につながりません'));
    ws.onopen = () =>
      done({
        send: (method, params = {}) =>
          new Promise((ok, reject) => {
            id += 1;
            pending.set(id, { resolve: ok, reject });
            ws.send(JSON.stringify({ id, method, params }));
          }),
        close: () => ws.close(),
      });
  });
}

/** 画面の通信の層（Tauri の IPC は、http://ipc.localhost への fetch）で、いくつかの命令の答えを差し替える。 */
const STUB_SOURCE = String.raw`(() => {
  if (window.__jrStub) return;
  const stub = { clipboard: null, report: null, settings: false };
  window.__jrStub = stub;
  const realFetch = window.fetch.bind(window);
  const headers = (ok) => (ok ? { 'Tauri-Response': 'ok', 'content-type': 'application/json' } : { 'content-type': 'application/json' });
  const reply = (value) => new Response(JSON.stringify(value), { status: 200, headers: headers(true) });
  const fail = (message) => new Response(JSON.stringify(message), { status: 200, headers: headers(false) });
  const patchStatus = (value) => ({
    ...value,
    registering: false,
    probe_ms: null,
    hook: 'helper',
    message: null,
    helper: { installed: true, running: true, busy: null, error: null },
  });
  window.fetch = async (input, init) => {
    const url = typeof input === 'string' ? input : input instanceof URL ? input.href : input.url;
    const m = /^https?:\/\/ipc\.localhost\/([^/?#]+)/.exec(url);
    if (m === null) return realFetch(input, init);
    switch (decodeURIComponent(m[1])) {
      case 'read_clipboard_text':
        return reply(stub.clipboard);
      case 'open_mjai_window':
      case 'close_mjai_window':
        return reply(null);
      case 'fetch_report':
        return stub.report === null ? fail('試験用の結果が未設定') : reply(stub.report);
      case 'set_probe_wanted':
        return stub.settings ? reply(null) : realFetch(input, init);
      case 'get_settings': {
        const response = await realFetch(input, init);
        if (!stub.settings) return response;
        const value = await response.json();
        return reply({ ...value, trigger: { kind: 'mouse_x1' }, data_dir: 'C:\\Users\\user\\JantamaReviewerData' });
      }
      case 'get_input_status': {
        const response = await realFetch(input, init);
        if (!stub.settings) return response;
        return reply(patchStatus(await response.json()));
      }
      case 'plugin:event|listen': {
        // 設定ページの表示を差し替えている間は、本体からの「入力の状態」の知らせも、同じ表示に差し替える。
        try {
          const { event, handler } = JSON.parse(typeof init?.body === 'string' ? init.body : '{}');
          const callbacks = window.__TAURI_INTERNALS__.callbacks;
          const original = event === 'input-status-changed' ? callbacks.get(handler) : undefined;
          if (original) callbacks.set(handler, (data) => original(stub.settings ? { ...data, payload: patchStatus(data.payload) } : data));
        } catch {
          // 差し替えられなくても、ほかの動きは変えない
        }
        return realFetch(input, init);
      }
      default:
        return realFetch(input, init);
    }
  };
})();`;

/** 画面（1 つの窓）を、CDP で操作・撮影する道具。 */
function makePage(cdp) {
  const evalJs = async (expression) => {
    const r = await cdp.send('Runtime.evaluate', { expression, returnByValue: true, awaitPromise: true });
    if (r.exceptionDetails) throw new Error(`画面の式が失敗: ${JSON.stringify(r.exceptionDetails.exception ?? r.exceptionDetails).slice(0, 400)}`);
    return r.result.value;
  };
  const waitFor = async (expression, label, timeout = 30000) => {
    const end = Date.now() + timeout;
    for (;;) {
      try {
        if (await evalJs(`!!(${expression})`)) return;
      } catch {
        // 画面が変わる間は、もう一度
      }
      if (Date.now() > end) throw new Error(`待ちきれなかった: ${label}`);
      await sleep(100);
    }
  };
  const mouse = (type, x, y, extra = {}) => cdp.send('Input.dispatchMouseEvent', { type, x, y, button: 'left', clickCount: 1, ...extra });
  const clickAt = async (x, y) => {
    await mouse('mouseMoved', x, y, { button: 'none', clickCount: 0 });
    await mouse('mousePressed', x, y);
    await mouse('mouseReleased', x, y);
    await sleep(250);
  };
  const center = (finder) =>
    evalJs(`(() => { const el = (${finder}); if (!el) return null; el.scrollIntoView({ block: 'center' }); const r = el.getBoundingClientRect(); return { x: r.left + r.width / 2, y: r.top + r.height / 2 }; })()`);
  const click = async (finder, label = finder) => {
    if ((await center(finder)) === null) throw new Error(`見つからない: ${label}`);
    await sleep(250);
    const c = await center(finder);
    await clickAt(c.x, c.y);
  };
  const type = async (finder, text) => {
    await evalJs(`(${finder}).focus()`);
    await cdp.send('Input.insertText', { text });
    await sleep(250);
  };
  const pressEscape = async () => {
    await cdp.send('Input.dispatchKeyEvent', { type: 'keyDown', key: 'Escape', code: 'Escape', windowsVirtualKeyCode: 27 });
    await cdp.send('Input.dispatchKeyEvent', { type: 'keyUp', key: 'Escape', code: 'Escape', windowsVirtualKeyCode: 27 });
    await sleep(250);
  };
  const viewport = (width, height, scale = 1) =>
    cdp.send('Emulation.setDeviceMetricsOverride', { width, height, deviceScaleFactor: scale, mobile: false });
  /** 窓の高さを、中身の高さに合わせる（サイドバーが下まで伸びて、写真に切れ目が出ない）。 */
  const fit = async (width = 1280, minHeight = 800, scale = 1) => {
    await viewport(width, minHeight, scale);
    for (let i = 0; i < 3; i += 1) {
      await sleep(250);
      const h = Math.max(minHeight, await evalJs('Math.ceil(document.documentElement.scrollHeight)'));
      await viewport(width, h, scale);
    }
    await sleep(250);
  };
  const rectOf = (finder) =>
    evalJs(`(() => { const el = (${finder}); if (!el) return null; const r = el.getBoundingClientRect(); return { x: r.left + scrollX, y: r.top + scrollY, width: r.width, height: r.height }; })()`);
  const settle = async () => {
    await evalJs(`Array.from(document.images).forEach((img) => { img.loading = 'eager'; })`);
    await evalJs(`if (document.activeElement instanceof HTMLElement) document.activeElement.blur()`);
    const width = await evalJs('window.innerWidth');
    await mouse('mouseMoved', Math.max(0, width - 2), 1, { button: 'none', clickCount: 0 });
    await waitFor(`Array.from(document.images).every((img) => img.complete && img.naturalWidth > 0)`, '画像の読み込み');
    await waitFor(`document.fonts.status === 'loaded'`, '文字の読み込み', 10000);
    await sleep(350);
  };
  const capture = async (name, rect) => {
    const params = { format: 'png', fromSurface: true, captureBeyondViewport: false };
    if (rect) params.clip = { x: rect.x, y: rect.y, width: rect.width, height: rect.height, scale: 1 };
    const r = await cdp.send('Page.captureScreenshot', params);
    writePng(name, Buffer.from(r.data, 'base64'));
  };
  const shot = async (name, rect) => {
    await settle();
    await capture(name, rect);
  };
  return { cdp, evalJs, waitFor, click, type, pressEscape, viewport, fit, rectOf, settle, capture, shot };
}

const byText = (selector, text) =>
  `Array.from(document.querySelectorAll(${JSON.stringify(selector)})).find((el) => el.textContent.replace(/\\s+/g, ' ').trim() === ${JSON.stringify(text)})`;
const byTextIncludes = (selector, text) =>
  `Array.from(document.querySelectorAll(${JSON.stringify(selector)})).find((el) => el.textContent.replace(/\\s+/g, ' ').includes(${JSON.stringify(text)}))`;

let main = null;
let widget = null;

/** アプリを起動する。検討画面は隠したまま起動し、画面の通信の層を差し替えてから見せる（本物のクリップボードを読まないため）。 */
async function startApp() {
  port = await freePort();
  stderr = '';
  child = spawn(EXE, [], {
    env: {
      ...process.env,
      JANTAMA_CONFIG_DIR: CONFIG,
      WEBVIEW2_ADDITIONAL_BROWSER_ARGUMENTS: `--remote-debugging-port=${port}`,
    },
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  child.stderr.on('data', (d) => {
    stderr += d;
  });
  child.stdout.on('data', () => undefined);
  const isMain = (t) => t.type === 'page' && /tauri\.localhost/.test(t.url) && !t.url.includes('widget') && !t.url.includes('mjai');
  const target = await waitTarget(isMain, '検討画面');
  main = makePage(await connect(target.webSocketDebuggerUrl));
  await main.cdp.send('Runtime.enable');
  await main.cdp.send('Page.enable');
  await main.cdp.send('Page.addScriptToEvaluateOnNewDocument', { source: STUB_SOURCE });
  await main.evalJs(STUB_SOURCE);
  await main.waitFor(`document.querySelector('.app')`, '検討画面の描画');
  await main.evalJs(`window.__TAURI_INTERNALS__.invoke('open_main_window')`);
  await main.waitFor(`document.visibilityState === 'visible'`, '検討画面が見える');
  await main.fit(1280, 800);
}

function stopApp() {
  if (child === null) return;
  // この実行で起動したプロセスだけを、番号を指して止める（名前では止めない）。
  spawnSync('taskkill', ['/F', '/T', '/PID', String(child.pid)], { stdio: 'ignore' });
  child = null;
  main = null;
  widget = null;
}

async function setTheme(dark) {
  const label = await main.evalJs(`document.querySelector('.side-foot .icon-btn').getAttribute('aria-label')`);
  // ボタンの名前は、押したら変わる先（「ダークテーマに切り替え」なら、いまはライト）。
  const nowDark = label.startsWith('ライト');
  if (nowDark !== dark) await main.click(`document.querySelector('.side-foot .icon-btn')`);
  await sleep(400);
}

const listRows = `document.querySelectorAll('.session-scroll [data-open]')`;
const openRow = (time) => main.click(byTextIncludes('.session-scroll [data-open]', time), `一覧の行 ${time}`);
const sideWidth = () => main.evalJs(`Math.round(document.querySelector('.side').getBoundingClientRect().width)`);
const panelText = `(document.querySelector('.panel h2') || { textContent: '' }).textContent`;

// ---- 1. 取り込みの流れ ----

async function importFlow() {
  console.log('1. 取り込みの流れ');
  writeSession({ start: A_START, items: A_ITEMS });
  for (const { report, start } of RESULT_ONLY) writeSession({ start, report });

  await startApp();
  await main.waitFor(`${listRows}.length === 6`, '一覧の 6 行');
  await main.waitFor(`document.querySelectorAll('.session-scroll .s-rate').length === 5`, '結果の段階の読み込み', 60000);
  await setTheme(false);
  await main.fit(1280, 800);

  // 牌譜リンクの案内（クリップボードの代わりに、偽の牌譜リンクを渡す）→ 取り込みのページ → mjai の窓の待ち
  await main.evalJs(`window.__jrStub.clipboard = ${JSON.stringify(FAKE_LINK)}`);
  await main.evalJs(`window.dispatchEvent(new Event('focus'))`);
  await main.waitFor(`document.querySelector('.offer')`, '牌譜リンクの案内');
  await main.click(byText('.offer button', '取り込む'));
  await main.waitFor(`${panelText}.includes('牌譜リンクを見つけました')`, '見つけた表示');
  const flowBottom = async () => {
    const box = await main.rectOf(`document.querySelector('.import-flow')`);
    return Math.ceil(box.y + box.height + 40);
  };
  await main.shot('import-link.png', { x: 0, y: 0, width: 1280, height: await flowBottom() });
  await main.click(byText('.panel button', 'mjai で検討する'));
  await main.waitFor(`${panelText}.includes('Submit を押してください')`, 'mjai の窓の待ち');

  // 窓の代わりに、結果の URL を貼って取り込む（結果の JSON は固定データを渡す。文字認識と結びつけは本物の処理）。
  await main.evalJs(`window.__jrStub.report = ${JSON.stringify(readFileSync(join(REPORTS, `${FX4}.json`), 'utf8'))}`);
  await main.type(`document.querySelector('#pasted-url')`, FAKE_RESULT_URL);
  await main.click(byText('.fallback button', 'この URL で取り込む'));
  await main.waitFor(`${panelText}.includes('取り込みました')`, '取り込みの完了', 120000);
  await main.shot('import-done.png', { x: 0, y: 0, width: 1280, height: await flowBottom() });

  const imported = readdirSync(join(DATA, 'games')).filter((id) => existsSync(join(DATA, 'games', id, 'links.json')));
  console.log(`  取り込んだ半荘: ${imported.join(', ')}（links.json あり）`);
  if (imported.length !== 1) throw new Error('結びつけの保存が 1 つの半荘に付いていません');
  stopApp();
  await sleep(1500);
}

// ---- 2. そのほかの画面 ----

async function screens() {
  console.log('2. そのほかの画面');
  writeRecordingSession();
  await startApp();
  await main.waitFor(`${listRows}.length === 7`, '一覧の 7 行');
  await main.waitFor(`document.querySelectorAll('.session-scroll .s-rate').length === 6`, '結果の段階の読み込み', 60000);
  await setTheme(false);
  await main.fit(1280, 900);

  // ウィジェット（縦長・横長）。記録中の半荘は、迷い 4・評価 3（次は 4 局目）。
  const widgetTarget = await waitTarget((t) => t.type === 'page' && t.url.includes('widget'), 'ウィジェット');
  widget = makePage(await connect(widgetTarget.webSocketDebuggerUrl));
  await widget.cdp.send('Runtime.enable');
  await widget.cdp.send('Page.enable');
  await widget.waitFor(`document.querySelector('.widget.v') && document.querySelector('.doubt .num') && document.querySelector('.doubt .num').textContent === '4'`, '縦長のウィジェット');
  const widgetShot = async (name) => {
    const size = await widget.evalJs(`({ w: window.innerWidth, h: window.innerHeight })`);
    await widget.viewport(size.w, size.h, 2);
    await widget.shot(name, { x: 0, y: 0, width: size.w, height: size.h });
    // 窓の大きさは、アプリの側（縦長・横長の切り替え）が決める。倍率の指定は外しておく。
    await widget.cdp.send('Emulation.clearDeviceMetricsOverride');
    await sleep(400);
  };
  await widgetShot('widget-vertical.png');
  await main.evalJs(`window.__TAURI_INTERNALS__.invoke('set_orientation', { orientation: 'horizontal' })`);
  await widget.waitFor(`document.querySelector('.widget.h') && window.innerWidth > 200`, '横長のウィジェット');
  await sleep(500);
  await widgetShot('widget-horizontal.png');
  await main.evalJs(`window.__TAURI_INTERNALS__.invoke('set_orientation', { orientation: 'vertical' })`);

  // 半荘の一覧（段階の印・検索欄・段階の絞り込み・取り込み前の半荘）。見出し「半荘」から、いちばん下の行まで。
  await openRow('21:03');
  await main.waitFor(`document.querySelector('table.tbl') && document.querySelectorAll('.mcard .mread').length === 6`, '半荘の画面');
  await main.viewport(1280, 900, 2);
  await sleep(300);
  const side = await sideWidth();
  const listTop = await main.rectOf(`document.querySelector('.list-head')`);
  const lastRow = await main.evalJs(`(() => { const items = document.querySelectorAll('.session-scroll .s-item'); return items[items.length - 1].getBoundingClientRect().bottom + scrollY; })()`);
  await main.shot('sessions-list.png', { x: 0, y: Math.floor(listTop.y - 8), width: side, height: Math.ceil(lastRow + 16 - (listTop.y - 8)) });

  // 半荘の画面（迷いのカード・局の評価）
  await main.fit(1280, 900, 1);
  const marks = await main.rectOf(`document.querySelector('ul.marks')`);
  const cardsBottom = Math.ceil(marks.y + marks.height + 28);
  await main.shot('hanchan-cards.png', { x: 0, y: 0, width: 1280, height: cardsBottom });
  const hands = await main.rectOf(byText('h2.sec-title', '局の評価') + `.closest('section')`);
  await main.shot('hanchan-table.png', { x: side, y: Math.floor(hands.y - 12), width: 1280 - side, height: Math.ceil(hands.height + 28) });
  await setTheme(true);
  await main.fit(1280, 900, 1);
  await main.shot('hanchan-dark.png', { x: 0, y: 0, width: 1280, height: cardsBottom });
  await setTheme(false);

  // 半荘の削除（選択 → 確認 → 通知の「元に戻す」）。確認の画面を撮って、元に戻して終える。
  await main.viewport(1280, 900, 1);
  await sleep(300);
  await main.click(byText('.list-head .link-btn', '選択'));
  await main.waitFor(`document.querySelector('.selbar')`, '選択の欄');
  const checks = `document.querySelectorAll('.session-scroll .s-cb')`;
  await main.click(`${checks}[3]`);
  await main.click(`${checks}[4]`);
  await main.waitFor(`document.querySelector('.selbar-n') && document.querySelector('.selbar-n').textContent.includes('2件')`, '2 件を選択');
  await main.click(byText('.selbar .btn', '削除'));
  await main.waitFor(`document.querySelector('.dlg')`, '削除の確認');
  const selbar = await main.rectOf(`document.querySelector('.selbar')`);
  const dialog = await main.rectOf(`document.querySelector('.dlg')`);
  const checkedBottom = await main.evalJs(`(() => { const boxes = Array.from(document.querySelectorAll('.session-scroll .s-cb:checked')); return Math.max(...boxes.map((box) => box.closest('.s-item').getBoundingClientRect().bottom)) + scrollY; })()`);
  const deleteTop = Math.floor(selbar.y - 16);
  const deleteBottom = Math.ceil(Math.max(dialog.y + dialog.height, checkedBottom) + 24);
  await main.shot('sessions-delete.png', { x: 0, y: deleteTop, width: Math.ceil(dialog.x + dialog.width + 24), height: deleteBottom - deleteTop });
  await main.click(byText('.dlg .btn', '削除'));
  await main.waitFor(`document.querySelector('.toast')`, '元に戻すの通知');
  await main.waitFor(`${listRows}.length === 5`, '消した半荘が一覧から消える');
  await main.click(byText('.toast .btn', '元に戻す'));
  await main.waitFor(`${listRows}.length === 7`, '半荘が戻る');
  await sleep(500);

  // 設定（表示だけ差し替える。ファイルの上のコメントを参照）
  await main.evalJs(`window.__jrStub.settings = true`);
  await main.click(byText('.side-foot .nav-item', '設定'));
  await main.waitFor(`document.querySelector('.settings') && document.querySelector('.helper-state') && document.querySelector('.helper-state').textContent.includes('動いています')`, '設定ページ');
  await main.fit(1280, 900, 1);
  await sleep(1500);
  await main.waitFor(`document.querySelector('.helper-state').textContent.includes('動いています')`, '補助プログラムの表示が保たれる');
  await main.waitFor(`!document.querySelector('.toast')`, '通知が消える', 15000);
  await main.shot('settings.png', { x: 0, y: 0, width: 1280, height: await main.evalJs('window.innerHeight') });

  const left = existsSync(join(DATA, 'trash')) ? readdirSync(join(DATA, 'trash')) : [];
  console.log(`  trash に残ったもの: ${left.length} 個`);
  if (left.length !== 0) throw new Error('消した半荘を戻しきれていません');
  stopApp();
}

// ---- 実行 ----

let failed = false;
try {
  mkdirSync(OUT, { recursive: true });
  await importFlow();
  await screens();
  console.log('できました');
} catch (error) {
  failed = true;
  console.error('失敗:', error instanceof Error ? error.message : error);
  console.error('アプリの標準エラー:', stderr.trim() || '(なし)');
  for (const page of [main, widget]) {
    if (page === null) continue;
    try {
      const r = await page.cdp.send('Page.captureScreenshot', { format: 'png' });
      const path = join(tmpdir(), `jr-readme-shots-error-${page === main ? 'main' : 'widget'}.png`);
      writeFileSync(path, Buffer.from(r.data, 'base64'));
      console.error(`失敗した時点の画面: ${path}`);
    } catch {
      // 撮れなければ、そのまま
    }
  }
} finally {
  stopApp();
  await sleep(500);
  try {
    rmSync(TEMP, { recursive: true, force: true, maxRetries: 5, retryDelay: 400 });
  } catch {
    console.error(`一時フォルダを消せませんでした（手で消してください）: ${TEMP}`);
  }
}
process.exit(failed ? 1 : 0);
