/**
 * README 用の画面の写真（readme-shots.mjs）と GIF（readme-gifs.mjs）を撮る 2 つの道具が共有する部品。
 *
 * 作った本物の実行ファイル（release）を、一時フォルダの設定と保存先で起動し、WebView2 の遠隔デバッグ（CDP）で、
 * アプリ自身の画面（検討画面・ウィジェット）だけを操作・撮影する。
 *
 * 安全のために（2 つの道具に共通）:
 * - 設定フォルダと保存先は、一時フォルダの中だけ。本物のデータ（%USERPROFILE%\JantamaReviewerData）は、読みも書きもしない
 *   （そこを指す場所は、使う前に弾く）。
 * - 起動するのは、この実行で作った実行ファイルの 1 つだけ。終わりは、そのプロセス番号だけを強制終了する
 *   （ほかの jantama-reviewer.exe・node.exe には触れない。名前や窓の題では止めない）。強制終了にするのは、終了のときの
 *   「消した半荘のごみ箱への移し替え」を走らせないため。
 * - 設定は、ウィジェットを画面の左下の隅に置き、音を切り、ボタンは押されないキー（F23）にする。本物のサイドボタンを奪わず、
 *   遊んでいる雀魂の邪魔もしない。検討画面は隠したまま起動し（--show-main は付けない）、画面の通信の層を差し替えてから、
 *   遠隔デバッグで操作する。
 * - 迷いマーク・評価の記録（add_mark・add_rating）は、押すと雀魂の窓（無ければ画面全体）のスクリーンショットを撮る。
 *   本物の画面を撮らないよう、画面の通信の層（Tauri の IPC は http://ipc.localhost への fetch）で、この 4 つの命令
 *   （add_mark・add_rating・undo・new_session）を、どの画面でも、本体に通さずに受け止める。差し替えの答えを決めていないときは、
 *   失敗の答えを返すだけ（本体には何も届かない）。
 * - クリップボードは書き換えない。アプリの画面が読む「クリップボードの文字」も、通信の層で偽の牌譜リンクに差し替えるので、
 *   本物のクリップボードは読みもしない。mjai.ekyu.moe の窓は開かず、何も送らず、何も取らない（結果の JSON は、
 *   リポジトリの固定データを、通信の層で渡す）。
 * - 雀魂の画面は、迷いマークの画像のフォルダ（プレイヤー名をぼかした mark-1.jpg ... mark-6.jpg）のものだけを使う。
 *   半荘の記録（events.jsonl と画像）は、アプリでは行わず、この道具が書く。
 * - 設定ページの写真だけは、本物の状態ではなく、表示を差し替える（保存先を `C:\Users\user\...` に、補助プログラムを
 *   「動いています」に、ボタンを既定の「戻る」に）。
 */
import { spawn, spawnSync } from 'node:child_process';
import { copyFileSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import net from 'node:net';
import { homedir, tmpdir } from 'node:os';
import { dirname, join, resolve, sep } from 'node:path';
import { fileURLToPath } from 'node:url';
import { DatabaseSync } from 'node:sqlite';
import { deflateSync, inflateSync } from 'node:zlib';

export const sleep = (ms) => new Promise((done) => setTimeout(done, ms));
export const p2 = (n) => String(n).padStart(2, '0');

export const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const REAL_DATA = resolve(homedir(), 'JantamaReviewerData');

const inside = (child, parent) => {
  const c = resolve(child).toLowerCase();
  const p = resolve(parent).toLowerCase();
  return c === p || c.startsWith(p + sep);
};

/** 本物のデータの置き場の中を指す場所は、読むのにも書くのにも使わない。 */
export function safe(path) {
  if (inside(path, REAL_DATA)) throw new Error(`本物のデータの置き場には触れません: ${path}`);
  return path;
}

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

export function readPng(buffer) {
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

export function optimizePng(original) {
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

// ---- 検索の部品 ----

export const byText = (selector, text) =>
  `Array.from(document.querySelectorAll(${JSON.stringify(selector)})).find((el) => el.textContent.replace(/\\s+/g, ' ').trim() === ${JSON.stringify(text)})`;
export const byTextIncludes = (selector, text) =>
  `Array.from(document.querySelectorAll(${JSON.stringify(selector)})).find((el) => el.textContent.replace(/\\s+/g, ' ').includes(${JSON.stringify(text)}))`;

// ---- Chrome DevTools Protocol（WebView2 の遠隔デバッグ） ----

const freePort = () =>
  new Promise((done, fail) => {
    const server = net.createServer();
    server.once('error', fail);
    server.listen(0, '127.0.0.1', () => {
      const { port: found } = server.address();
      server.close(() => done(found));
    });
  });

export function connect(wsUrl) {
  return new Promise((done, fail) => {
    const ws = new WebSocket(wsUrl);
    let id = 0;
    const pending = new Map();
    const listeners = new Map();
    ws.onmessage = (event) => {
      const msg = JSON.parse(event.data);
      if (msg.id !== undefined && pending.has(msg.id)) {
        const { resolve: ok, reject } = pending.get(msg.id);
        pending.delete(msg.id);
        if (msg.error) reject(new Error(JSON.stringify(msg.error)));
        else ok(msg.result);
      } else if (msg.method !== undefined) {
        for (const fn of listeners.get(msg.method) ?? []) fn(msg.params);
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
        on: (method, fn) => {
          listeners.set(method, [...(listeners.get(method) ?? []), fn]);
        },
        close: () => ws.close(),
      });
  });
}

/**
 * 画面の通信の層（Tauri の IPC は、http://ipc.localhost への fetch）で、いくつかの命令の答えを差し替える。
 * 記録の 4 つの命令（add_mark・add_rating・undo・new_session）は、どの画面でも、本体に通さない（ファイルの上の説明を参照）。
 * `stub.record` を `initRecord()` で用意したときだけ、画面の中だけの偽の記録の状態で答える。
 */
const STUB_SOURCE = String.raw`(() => {
  if (window.__jrStub) return;
  const stub = { clipboard: null, report: null, settings: false, record: null, blocked: [] };
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
  const bodyOf = async (input, init) => {
    try {
      const raw = init && init.body !== undefined ? init.body : input instanceof Request ? await input.clone().text() : '{}';
      return JSON.parse(typeof raw === 'string' ? raw : '{}');
    } catch {
      return {};
    }
  };
  // 偽の記録の状態を、本体の get_state（読むだけの命令）の答えから作る。
  stub.initRecord = async () => {
    stub.record = { state: await window.__TAURI_INTERNALS__.invoke('get_state'), history: [] };
  };
  window.fetch = async (input, init) => {
    const url = typeof input === 'string' ? input : input instanceof URL ? input.href : input.url;
    const m = /^https?:\/\/ipc\.localhost\/([^/?#]+)/.exec(url);
    if (m === null) return realFetch(input, init);
    switch (decodeURIComponent(m[1])) {
      case 'add_mark':
      case 'add_rating':
      case 'undo':
      case 'new_session': {
        const name = decodeURIComponent(m[1]);
        stub.blocked.push(name);
        if (stub.record === null) return fail('撮影を伴う記録の命令は、この道具では本体に通しません');
        const record = stub.record;
        const state = record.state;
        if (name === 'add_mark') {
          record.history.push(JSON.stringify(state));
          record.state = { ...state, mark_count: state.mark_count + 1, can_undo: true };
        } else if (name === 'add_rating') {
          const { rating } = await bodyOf(input, init);
          record.history.push(JSON.stringify(state));
          record.state = { ...state, ratings: [...state.ratings, rating], next_hand: state.next_hand + 1, can_undo: true };
        } else if (name === 'undo') {
          const before = record.history.pop();
          if (before !== undefined) record.state = { ...JSON.parse(before), can_undo: record.history.length > 0 };
        }
        return reply(record.state);
      }
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
export function makePage(cdp, options = {}) {
  // マウスを動かしてから押すまでの間（ミリ秒）。GIF では、見せるための印（installCursor）が動く時間を取る。
  const glide = options.glide ?? 0;
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
  const clickAt = async (x, y, settle = 250) => {
    await mouse('mouseMoved', x, y, { button: 'none', clickCount: 0 });
    if (glide > 0) await sleep(glide);
    await mouse('mousePressed', x, y);
    await mouse('mouseReleased', x, y);
    if (settle > 0) await sleep(settle);
  };
  const center = (finder, scroll = true) =>
    evalJs(`(() => { const el = (${finder}); if (!el) return null; ${scroll ? "el.scrollIntoView({ block: 'center' });" : ''} const r = el.getBoundingClientRect(); return { x: r.left + r.width / 2, y: r.top + r.height / 2 }; })()`);
  const click = async (finder, label = finder, options = {}) => {
    const scroll = options.scroll ?? true;
    if ((await center(finder, scroll)) === null) throw new Error(`見つからない: ${label}`);
    await sleep(options.pause ?? 250);
    const c = await center(finder, scroll);
    await clickAt(c.x, c.y, options.settle ?? 250);
  };
  /** 押さずに、その上へマウスを動かす（ホバー・ツールチップ）。 */
  const hover = async (finder, label = finder, options = {}) => {
    const c = await center(finder, options.scroll ?? true);
    if (c === null) throw new Error(`見つからない: ${label}`);
    await mouse('mouseMoved', c.x, c.y, { button: 'none', clickCount: 0 });
    await sleep((options.settle ?? 250) + glide);
  };
  /** マウスの輪（ホイール）を、少しずつ回して、なめらかに動かす。 */
  const wheel = async (dy, { x = 700, y = 400, steps = 10, gap = 28 } = {}) => {
    for (let i = 0; i < steps; i += 1) {
      await cdp.send('Input.dispatchMouseEvent', { type: 'mouseWheel', x, y, deltaX: 0, deltaY: dy / steps });
      await sleep(gap);
    }
    await sleep(120);
  };
  const type = async (finder, text, options = {}) => {
    await evalJs(`(${finder}).focus()`);
    if (options.perChar === undefined) {
      await cdp.send('Input.insertText', { text });
    } else {
      for (const ch of text) {
        await cdp.send('Input.insertText', { text: ch });
        await sleep(options.perChar);
      }
    }
    await sleep(options.settle ?? 250);
  };
  const KEY_CODES = {
    Escape: 27,
    Enter: 13,
    Tab: 9,
    ArrowLeft: 37,
    ArrowUp: 38,
    ArrowRight: 39,
    ArrowDown: 40,
    Home: 36,
    End: 35,
    ' ': 32,
  };
  const pressKey = async (key, options = {}) => {
    const code = options.code ?? (key.length === 1 ? (/[a-z]/i.test(key) ? `Key${key.toUpperCase()}` : key === ' ' ? 'Space' : key) : key);
    const vk = KEY_CODES[key] ?? (key.length === 1 ? key.toUpperCase().charCodeAt(0) : 0);
    const base = { key, code, windowsVirtualKeyCode: vk, modifiers: options.modifiers ?? 0 };
    await cdp.send('Input.dispatchKeyEvent', { type: 'keyDown', ...base });
    await cdp.send('Input.dispatchKeyEvent', { type: 'keyUp', ...base });
    await sleep(options.settle ?? 250);
  };
  const pressEscape = () => pressKey('Escape');
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
  /** 画面の表示（スクロールを除く）での位置。 */
  const viewRectOf = (finder) =>
    evalJs(`(() => { const el = (${finder}); if (!el) return null; const r = el.getBoundingClientRect(); return { x: r.left, y: r.top, width: r.width, height: r.height }; })()`);
  const settle = async () => {
    await evalJs(`Array.from(document.images).forEach((img) => { img.loading = 'eager'; })`);
    await evalJs(`if (document.activeElement instanceof HTMLElement) document.activeElement.blur()`);
    const width = await evalJs('window.innerWidth');
    await mouse('mouseMoved', Math.max(0, width - 2), 1, { button: 'none', clickCount: 0 });
    await waitFor(`Array.from(document.images).every((img) => img.complete && img.naturalWidth > 0)`, '画像の読み込み');
    await waitFor(`document.fonts.status === 'loaded'`, '文字の読み込み', 10000);
    await sleep(350);
  };
  return { cdp, evalJs, waitFor, click, clickAt, hover, wheel, type, pressKey, pressEscape, mouse, viewport, fit, rectOf, viewRectOf, settle, center };
}

/**
 * 画面に、マウスの位置を示す輪を足す（GIF 用。CDP で送ったマウスの動きは、撮影に写らないため）。
 * 色は、アプリの色のトークン（--ink・--accent）だけを使う。アプリの側には何も足さず、撮る窓の中だけに入れる。
 */
export async function installCursor(page) {
  await page.evalJs(`(() => {
    if (document.getElementById('__jrCursor')) return;
    const style = document.createElement('style');
    style.id = '__jrCursorStyle';
    style.textContent = '#__jrCursor{position:fixed;left:-40px;top:-40px;width:24px;height:24px;margin:-12px 0 0 -12px;border-radius:50%;border:2px solid var(--ink);background:color-mix(in srgb, var(--ink) 16%, transparent);pointer-events:none;z-index:2147483647;transition:left 170ms ease-out,top 170ms ease-out,transform 90ms ease-out,background-color 90ms}#__jrCursor.down{transform:scale(.72);background:color-mix(in srgb, var(--accent) 50%, transparent)}';
    document.head.appendChild(style);
    const dot = document.createElement('div');
    dot.id = '__jrCursor';
    document.documentElement.appendChild(dot);
    const move = (e) => { dot.style.left = e.clientX + 'px'; dot.style.top = e.clientY + 'px'; };
    document.addEventListener('mousemove', move, true);
    document.addEventListener('mousedown', (e) => { move(e); dot.classList.add('down'); }, true);
    document.addEventListener('mouseup', () => dot.classList.remove('down'), true);
  })()`);
}

/** 窓の写真（PNG）を、CDP で撮る。 */
export async function captureOf(page, rect, options = {}) {
  const params = { format: options.format ?? 'png', fromSurface: true, captureBeyondViewport: options.beyond ?? false };
  if (options.quality !== undefined) params.quality = options.quality;
  if (rect) params.clip = { x: rect.x, y: rect.y, width: rect.width, height: rect.height, scale: 1 };
  const r = await page.cdp.send('Page.captureScreenshot', params);
  return Buffer.from(r.data, 'base64');
}

/**
 * 実行 1 回分の道具一式（一時フォルダ・設定・半荘の置き場・アプリの起動と停止）を作る。
 *
 * @param {{ marksArg: string, outArg?: string, prefix: string }} options
 */
export function createHarness({ marksArg, outArg, prefix }) {
  const MARKS = safe(resolve(marksArg));
  const OUT = safe(resolve(outArg ?? join(ROOT, 'docs', 'images')));
  const EXE = safe(resolve(process.env.JANTAMA_EXE ?? join(ROOT, 'apps', 'desktop', 'src-tauri', 'target', 'release', 'jantama-reviewer.exe')));
  const REPORTS = join(ROOT, 'packages', 'engine', 'tests', 'fixtures', 'reports');
  for (const file of [EXE, ...[1, 2, 3, 4, 5, 6].map((n) => join(MARKS, `mark-${n}.jpg`))]) {
    if (!existsSync(file)) throw new Error(`見つかりません: ${file}`);
  }

  const TEMP = safe(mkdtempSync(join(tmpdir(), `${prefix}-`)));
  const CONFIG = safe(join(TEMP, 'config'));
  const DATA = safe(join(TEMP, 'data'));
  mkdirSync(CONFIG, { recursive: true });
  mkdirSync(join(DATA, 'games'), { recursive: true });
  // 設定（UTF-8、BOM なし）。ウィジェットは画面の左下の隅（画面の外を指すと、いちばん近いモニターの内側に引き戻される）、音は切、
  // ボタンは押されないキー（F23）。本物のサイドボタン（既定の「戻る」）を奪わない。
  writeFileSync(
    join(CONFIG, 'settings.json'),
    JSON.stringify({ data_dir: DATA, trigger: { kind: 'key', code: 'F23' }, sound: false, widget_position: { x: 0, y: 100000 } }),
    'utf8',
  );

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
    { report: 'f738896995c33fed', start: at(-12, 21, 30, 2) },
    { report: 'f9da87cbcd7af5e9', start: at(-20, 20, 48, 51) },
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

  // ---- アプリの起動と停止 ----

  let child = null;
  let port = 0;
  let stderr = '';
  let mainPage = null;
  let widgetPage = null;

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

  /** アプリを起動する。検討画面は隠したまま起動し、画面の通信の層を差し替えてから見せる（本物のクリップボードを読まないため）。 */
  async function startApp({ width = 1280, height = 800, pageOptions = {} } = {}) {
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
    mainPage = makePage(await connect(target.webSocketDebuggerUrl), pageOptions);
    await mainPage.cdp.send('Runtime.enable');
    await mainPage.cdp.send('Page.enable');
    await mainPage.cdp.send('Page.addScriptToEvaluateOnNewDocument', { source: STUB_SOURCE });
    await mainPage.evalJs(STUB_SOURCE);
    await mainPage.waitFor(`document.querySelector('.app')`, '検討画面の描画');
    await mainPage.evalJs(`window.__TAURI_INTERNALS__.invoke('open_main_window')`);
    await mainPage.waitFor(`document.visibilityState === 'visible'`, '検討画面が見える');
    await mainPage.fit(width, height);
  }

  /** ウィジェットの窓につなぐ。記録の命令を本体に通さない差し替えを、つなぐ前に入れる。 */
  async function attachWidget(pageOptions = {}) {
    const target = await waitTarget((t) => t.type === 'page' && t.url.includes('widget'), 'ウィジェット');
    widgetPage = makePage(await connect(target.webSocketDebuggerUrl), pageOptions);
    await widgetPage.cdp.send('Runtime.enable');
    await widgetPage.cdp.send('Page.enable');
    await widgetPage.cdp.send('Page.addScriptToEvaluateOnNewDocument', { source: STUB_SOURCE });
    await widgetPage.evalJs(STUB_SOURCE);
    return widgetPage;
  }

  function stopApp() {
    if (child === null) return;
    // この実行で起動したプロセスだけを、番号を指して止める（名前では止めない）。
    spawnSync('taskkill', ['/F', '/T', '/PID', String(child.pid)], { stdio: 'ignore' });
    child = null;
    mainPage = null;
    widgetPage = null;
  }

  async function setTheme(dark) {
    const m = mainPage;
    const label = await m.evalJs(`document.querySelector('.side-foot .icon-btn').getAttribute('aria-label')`);
    // ボタンの名前は、押したら変わる先（「ダークテーマに切り替え」なら、いまはライト）。
    const nowDark = label.startsWith('ライト');
    if (nowDark !== dark) await m.click(`document.querySelector('.side-foot .icon-btn')`);
    await sleep(400);
  }

  async function cleanup() {
    stopApp();
    await sleep(500);
    try {
      rmSync(TEMP, { recursive: true, force: true, maxRetries: 5, retryDelay: 400 });
    } catch {
      console.error(`一時フォルダを消せませんでした（手で消してください）: ${TEMP}`);
    }
  }

  return {
    ROOT,
    MARKS,
    OUT,
    EXE,
    REPORTS,
    TEMP,
    CONFIG,
    DATA,
    NOW,
    at,
    stamp,
    stem,
    writePng,
    writeSession,
    writeRecordingSession,
    FX4,
    A_START,
    A_ITEMS,
    RESULT_ONLY,
    FAKE_LINK,
    FAKE_RESULT_URL,
    startApp,
    attachWidget,
    stopApp,
    setTheme,
    cleanup,
    waitTarget,
    get main() {
      return mainPage;
    },
    get widget() {
      return widgetPage;
    },
    get stderr() {
      return stderr;
    },
    get pid() {
      return child === null ? null : child.pid;
    },
    get port() {
      return port;
    },
  };
}

// ---- アプリの画面の操作（写真の道具と GIF の道具が共有する） ----

export const listRows = `document.querySelectorAll('.session-scroll [data-open]')`;
export const panelText = `(document.querySelector('.panel h2') || { textContent: '' }).textContent`;

/**
 * 検討画面（`page`）の操作の部品。選ぶ場所は、アプリの画面の DOM（クラス名・名前）から探す。
 * `pace` は、操作の間（ミリ秒）の倍率。GIF では、見る人が追えるよう、1 より大きくする。
 */
export function appActions(page, { pace = 1 } = {}) {
  const wait = (ms) => sleep(Math.round(ms * pace));
  /** ポップアップのメニューから、文字が合う項目を選ぶ（exact なら、完全に同じ文字）。 */
  const pickMenu = async (text, { exact = false } = {}) => {
    const finder = exact
      ? `Array.from(document.querySelectorAll('.pop [role^=menuitem]')).find((e) => e.textContent.replace(/\\s+/g, ' ').trim() === ${JSON.stringify(text)})`
      : `Array.from(document.querySelectorAll('.pop [role^=menuitem]')).find((e) => e.textContent.replace(/\\s+/g, ' ').includes(${JSON.stringify(text)}))`;
    await page.click(finder, `メニューの項目 ${text}`);
    await wait(300);
  };
  /** サイドバーの項目（今日の出題・解き直し・ログ・週の集計・設定）を押す。 */
  const openNav = async (label) => {
    await page.click(byTextIncludes('.nav-item', label), `サイドバーの ${label}`);
    await wait(700);
  };
  const openSession = async (time) => {
    await page.click(byTextIncludes('.session-scroll [data-open]', time), `一覧の行 ${time}`);
    await page.waitFor(`document.querySelector('table.tbl')`, '半荘の画面');
    await wait(500);
  };
  /** 迷いのカードのメモ（候補・理由）を書く。Enter で確定する。 */
  const writeMemo = async (n, candidates, reason) => {
    const group = `document.querySelector('[role=group][aria-label="迷い${n}のメモ"]')`;
    await page.type(`${group}.querySelectorAll('input')[0]`, candidates, { settle: 100 });
    await page.pressKey('Enter', { settle: 150 });
    await page.type(`${group}.querySelectorAll('input')[1]`, reason, { settle: 100 });
    await page.pressKey('Enter', { settle: 300 });
  };
  /** 「迷いマークの無い迷いを足す」。局と判断（巡目の語で選ぶ）を選び、メモを書いて足す。`submit` が false なら、足さずに残す。 */
  const addExtraMemo = async ({ kyoku, turn, candidates, reason, submit = true }) => {
    await page.click(byText('button', '迷いマークの無い迷いを足す'), '迷いマークの無い迷いを足す');
    await page.waitFor(`document.querySelector('[aria-label="追加するメモの局と巡目"]')`, '追加の欄');
    const where = `document.querySelectorAll('[aria-label="追加するメモの局と巡目"] button')`;
    await page.click(`${where}[0]`, '局の選び');
    await pickMenu(kyoku);
    await page.click(`${where}[1]`, '判断の選び');
    await pickMenu(turn);
    const group = `document.querySelector('[aria-label="追加するメモ"]')`;
    await page.type(`${group}.querySelectorAll('input')[0]`, candidates, { settle: 100 });
    await page.type(`${group}.querySelectorAll('input')[1]`, reason, { settle: 300 });
    if (submit) {
      await page.click(byText('button', '足す'), '足す');
      await page.waitFor(`document.querySelector('.extras .mcard, ul.extras .mcard')`, '追加のメモのカード');
    }
  };
  /** 局の評価の表で、MAKA の段階を入れる。 */
  const setMaka = async (label, grade) => {
    await page.click(`document.querySelector('button[aria-label="${label}の MAKA を入力"]')`, `${label} の MAKA`);
    await wait(250);
    await pickMenu(grade, { exact: true });
    await wait(500);
  };
  /**
   * 出題 1 問に答える。打牌は手牌の `pick` 番目（負の数は後ろから。-1 がツモ牌）、鳴きの判断は `pick` 番目のボタン。
   * 理由を書いて答え合わせまで進める。`causes`（差の原因の名前）と `principle` があれば、答え合わせのあとに足す。
   * `typeDelay` を渡すと、1 文字ずつ打つ（GIF 用）。
   */
  const answerQuiz = async ({ pick = -1, reason, causes = [], principle = null, typeDelay, beforeSubmit, afterReveal } = {}) => {
    await page.waitFor(`document.querySelector('.qz[data-state="answering"]')`, '出題の画面');
    await wait(500);
    const tiles = await page.evalJs(`document.querySelectorAll('.hand .tile-btn').length`);
    if (tiles > 0) {
      const index = pick < 0 ? tiles + pick : pick;
      await page.click(`document.querySelectorAll('.hand .tile-btn')[${index}]`, `手牌の ${index} 番目`, { scroll: false });
    } else {
      const index = pick < 0 ? 0 : pick;
      await page.click(`document.querySelectorAll('.q-choices [role=radio]')[${index}]`, `選択肢の ${index} 番目`, { scroll: false });
    }
    await wait(300);
    await page.type(`document.querySelector('#answer-form input.input, #answer-form textarea')`, reason, { perChar: typeDelay, settle: 300 });
    if (beforeSubmit) await beforeSubmit();
    await page.click(byText('button', '答え合わせ'), '答え合わせ', { scroll: false });
    await page.waitFor(`document.querySelector('.qz[data-state="revealed"]')`, '答え合わせのあとの画面');
    await wait(600);
    if (afterReveal) await afterReveal();
    for (const cause of causes) {
      await page.click(byText('label.pill', cause), `差の原因 ${cause}`);
      await wait(200);
    }
    if (principle !== null) {
      await page.type(`document.querySelector('form.learn input.input, form.learn textarea')`, principle, { perChar: typeDelay, settle: 200 });
      await page.pressKey('Tab', { settle: 200 });
    }
  };
  return { pickMenu, openNav, openSession, writeMemo, addExtraMemo, setMaka, answerQuiz, wait };
}

/**
 * 取り込みの流れ: 牌譜リンクの案内 → 取り込みのページ → mjai の窓の待ち → 結果の URL を貼る → 取り込みの完了。
 * 結果の JSON は固定データを通信の層で渡す（文字認識と結びつけは本物の処理）。段ごとの `hooks`（onLink・onWaiting・onDone）で、
 * 写真や GIF の撮影を差し込む。
 */
export async function importFlow(h, hooks = {}, { typeDelay, pace = 1 } = {}) {
  const page = h.main;
  const wait = (ms) => sleep(Math.round(ms * pace));
  await page.evalJs(`window.__jrStub.clipboard = ${JSON.stringify(h.FAKE_LINK)}`);
  await page.evalJs(`window.dispatchEvent(new Event('focus'))`);
  await page.waitFor(`document.querySelector('.offer')`, '牌譜リンクの案内');
  await hooks.onOffer?.(page);
  await wait(500);
  await page.click(byText('.offer button', '取り込む'));
  await page.waitFor(`${panelText}.includes('牌譜リンクを見つけました')`, '見つけた表示');
  await hooks.onLink?.(page);
  await wait(500);
  await page.click(byText('.panel button', 'mjai で検討する'));
  await page.waitFor(`${panelText}.includes('Submit を押してください')`, 'mjai の窓の待ち');
  await hooks.onWaiting?.(page);
  await page.evalJs(`window.__jrStub.report = ${JSON.stringify(readFileSync(join(h.REPORTS, `${h.FX4}.json`), 'utf8'))}`);
  await page.type(`document.querySelector('#pasted-url')`, h.FAKE_RESULT_URL, { perChar: typeDelay });
  await hooks.onTyped?.(page);
  await page.click(byText('.fallback button', 'この URL で取り込む'));
  await page.waitFor(`${panelText}.includes('取り込みました')`, '取り込みの完了', 120000);
  await hooks.onDone?.(page);
}

// ---- 答えの履歴（一時フォルダの study.sqlite を、アプリを止めたあとに書き換える） ----

/**
 * 画面の操作で付けた答えを、数週間ぶんの履歴にする。`plan` の各項目は、答えの順（0 から）・何日前か・次の解き直しの間隔（日）。
 * 答えの日付（answered_at・shown_at）は、半荘が終わったあと（開始の 90 分後より前には答えない）で、いまより先にしない。
 * 次の解き直しの期限（due_date）は、日付と間隔から決める。アプリが止まっていること（呼ぶ側が止める）。
 * 本物のデータには触れない（保存先は、この実行の一時フォルダ）。
 */
export function backdateAnswers(h, plan) {
  const db = new DatabaseSync(safe(join(h.DATA, 'study.sqlite')));
  try {
    const rows = db.prepare('SELECT id, session_id, answered_at, shown_at FROM answers ORDER BY id').all();
    const DAY = 86400000;
    const dateText = (ms) => {
      const d = new Date(ms);
      return `${d.getFullYear()}-${p2(d.getMonth() + 1)}-${p2(d.getDate())}`;
    };
    const update = db.prepare('UPDATE answers SET answered_at = ?, shown_at = ?, interval_days = ?, due_date = ?, mode = ? WHERE id = ?');
    for (const item of plan) {
      const row = rows[item.index];
      if (row === undefined) throw new Error(`答えが足りません: ${item.index}`);
      const m = /^(\d{4})(\d{2})(\d{2})-(\d{2})(\d{2})(\d{2})$/.exec(row.session_id);
      const started = new Date(+m[1], +m[2] - 1, +m[3], +m[4], +m[5], +m[6]).getTime();
      const wanted = new Date(h.NOW - item.daysAgo * DAY);
      wanted.setHours(item.hour ?? 21, item.minute ?? 30, 0, 0);
      const answered = Math.min(Math.max(wanted.getTime(), started + 90 * 60000), h.NOW - 3600000);
      const due = dateText(answered + item.interval * DAY);
      const seconds = Math.max(5, Math.round((row.answered_at - row.shown_at) / 1000));
      update.run(answered, answered - seconds * 1000, item.interval, due, item.mode ?? 'quiz', row.id);
    }
    return rows.length;
  } finally {
    db.close();
  }
}

/**
 * 「今日の出題」の残りの問題から、半荘ごとに 1〜2 問ずつ選んで、画面の操作で答える（履歴の元になる答え）。
 * 日付の違う半荘に散らす。答えた問題の数を返す。
 */
export async function answerRest(h, A, count) {
  const main = h.main;
  await A.openNav('今日の出題');
  await main.click(byTextIncludes('summary', '残り'));
  await sleep(300);
  const label = `(r) => r.querySelector('.main-l').textContent.replace(/\\s+/g, ' ').trim()`;
  const rows = await main.evalJs(`Array.from(document.querySelectorAll('.qrest .qrow')).map((r) => ({ text: (${label})(r), where: (r.querySelector('.nw') || { textContent: '' }).textContent }))`);
  const byWhere = new Map();
  for (const row of rows) {
    if (!byWhere.has(row.where)) byWhere.set(row.where, []);
    byWhere.get(row.where).push(row);
  }
  const chosen = [];
  for (const [where, list] of byWhere) {
    if (where.trim() === '' || chosen.length >= count) continue;
    chosen.push(list[0]);
    if (list[3] !== undefined && chosen.length < count) chosen.push(list[3]);
  }
  const reasons = ['孤立牌から切って、受け入れを残した', '安全度を優先した', '打点を見て形を崩さなかった', '早い巡目なので広く構えた'];
  const causeSets = [['受け入れ枚数'], ['形の質', '受け入れ枚数'], ['守備'], ['打点'], ['形の質'], ['受け入れ枚数', '打点'], ['その他'], ['守備', '形の質'], ['受け入れ枚数']];
  for (const [n, row] of chosen.entries()) {
    await A.openNav('今日の出題');
    const open = await main.evalJs(`!!document.querySelector('.qrest[open]')`);
    if (!open) await main.click(byTextIncludes('summary', '残り'));
    await main.click(`Array.from(document.querySelectorAll('.qrest .qrow')).find((r) => (${label})(r) === ${JSON.stringify(row.text)})`, `残りの ${row.text}`);
    await main.waitFor(`document.querySelector('.qz')`, '出題の画面');
    await A.answerQuiz({ pick: [0, -1, 4, 2][n % 4], reason: reasons[n % reasons.length], causes: causeSets[n % causeSets.length] });
  }
  return chosen.length;
}

/** 答えの履歴の計画（answerRest で答えた k 番目が、答えの順で firstIndex + k 番目のとき）。 */
export function historyPlan(count, firstIndex) {
  const daysAgoList = [1, 2, 3, 4, 5, 8, 10, 12, 17, 20];
  const intervals = [3, 3, 1, 3, 7, 3, 1, 7, 3, 3];
  return Array.from({ length: count }, (_, k) => ({
    index: firstIndex + k,
    daysAgo: daysAgoList[k % daysAgoList.length],
    interval: intervals[k % intervals.length],
    hour: 20 + (k % 3),
    minute: 10 + k * 4,
  }));
}
