#!/usr/bin/env node
/**
 * README 用の動きの GIF を、作った本物の実行ファイル（release）から録る。
 *
 *   node scripts/readme-gifs.mjs <迷いマークの画像のフォルダ> [出力先]
 *
 * - 迷いマークの画像のフォルダ・出力先・実行ファイルは、readme-shots.mjs と同じ（出力先の既定は docs/images）。
 * - ffmpeg が PATH に要る（palettegen / paletteuse で GIF にする）。
 *
 * 録るもの（アプリは段ごとに起動し直す。同じ一時フォルダを使い、1 回の起動は 2 分以内）:
 * 1. import-flow.gif: 牌譜リンクの案内 → 取り込む → mjai の結果の URL を貼る → 取り込み完了。
 *    続けて quiz-answer.gif: 今日の出題の 1 問に、牌を選び・理由を書き・答え合わせをして・差の原因を付ける。
 * 2. 録らずに、履歴の元になる答えを付ける: 結果だけの半荘を足して起動し直し、画面の操作で昔の問題に答える。アプリを止めたあとに、
 *    一時フォルダの study.sqlite の答えの日付と解き直しの期限を書き換えて、数週間ぶんの履歴にする。
 * 3. replay-keys.gif: 半荘を通して見る画面を、キーボードで進める。week-page.gif: 週の集計（週を替える・ツールチップ・表で見る）。
 * 4. widget-record.gif: ウィジェットで、迷いと〇△✕を記録する・取り消す（ウィジェットの窓だけ）。記録中の半荘は、取り込みの
 *    相手が 2 つになってしまうので、いちばん最後に置く。
 *
 * 画面の録り方: アプリ自身の窓（検討画面・ウィジェット）を、CDP の Page.captureScreenshot で一定の間隔（既定 12 枚/秒）に
 * 撮って、撮った時刻の差をそのまま、1 枚ごとの表示の長さにする（録っていない間の待ちは、数えない）。CDP で送ったマウスの動きは
 * 画面に写らないので、窓の中だけに、マウスの位置を示す輪を足す（色はアプリの色のトークン。アプリの側には何も足さない）。
 *
 * 安全のための決まりは、readme-lib.mjs の説明を参照。とくに:
 * - 本物の画面は撮らない。撮るのは、アプリ自身の窓の中身だけ（CDP）。画面全体・ほかのアプリの窓は撮らない。
 * - ウィジェットの迷い・〇△✕・取り消し（add_mark・add_rating・undo）は、押しても本体に届かない。窓の通信の層で受け止めて、
 *   窓の中だけの偽の状態で答える（本物の記録・スクリーンショットは起きない。録り終えたあと、受け止めた命令の数を表示する）。
 * - 雀魂の画面は、迷いマークの画像のフォルダの、プレイヤー名をぼかしたものだけ。設定ページは出さない（保存先の道が写らない）。
 */
import { spawnSync } from 'node:child_process';
import { existsSync, mkdirSync, readdirSync, statSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import {
  answerRest,
  appActions,
  backdateAnswers,
  byText,
  byTextIncludes,
  captureOf,
  createHarness,
  historyPlan,
  importFlow,
  installCursor,
  listRows,
  safe,
  sleep,
} from './readme-lib.mjs';

const [marksArg, outArg] = process.argv.slice(2);
if (marksArg === undefined) {
  console.error('使い方: node scripts/readme-gifs.mjs <迷いマークの画像のフォルダ（mark-1.jpg ... mark-6.jpg）> [出力先（既定: docs/images）]');
  process.exit(2);
}
if (spawnSync('ffmpeg', ['-version'], { stdio: 'ignore' }).status !== 0) {
  console.error('ffmpeg が見つかりません（PATH に要ります）');
  process.exit(2);
}

let h;
try {
  h = createHarness({ marksArg, outArg, prefix: 'jr-readme-gifs' });
} catch (error) {
  console.error(error instanceof Error ? error.message : error);
  process.exit(2);
}

const FPS = 12;
const MAX_BYTES = 3 * 1024 * 1024;

// ---- 録画 ----

/** 1 つの窓を、一定の間隔で撮り続ける。`pause` の間は撮らず、その間の時間は、表示の長さに数えない。 */
class Recorder {
  constructor(page, name, clip) {
    this.page = page;
    this.name = name;
    this.clip = clip;
    this.dir = safe(join(h.TEMP, `gif-${name}`));
    mkdirSync(this.dir, { recursive: true });
    this.frames = [];
    this.running = false;
    this.paused = false;
    this.pausedMs = 0;
    this.pausedAt = 0;
    this.loop = null;
  }

  async capture() {
    const t = Date.now() - this.pausedMs;
    const buffer = await captureOf(this.page, this.clip);
    const file = `f${String(this.frames.length + 1).padStart(5, '0')}.png`;
    writeFileSync(join(this.dir, file), buffer);
    this.frames.push({ file, t });
  }

  start() {
    this.running = true;
    this.loop = (async () => {
      const interval = 1000 / FPS;
      while (this.running) {
        const began = Date.now();
        if (!this.paused) await this.capture();
        const rest = interval - (Date.now() - began);
        if (rest > 0) await sleep(rest);
      }
    })();
  }

  pause() {
    if (this.paused) return;
    this.paused = true;
    this.pausedAt = Date.now();
  }

  resume() {
    if (!this.paused) return;
    this.pausedMs += Date.now() - this.pausedAt;
    this.paused = false;
  }

  /** 録りながら、ミリ秒だけ待つ（画面を見せる間）。 */
  hold(ms) {
    return sleep(ms);
  }

  async stop(lastHoldMs = 1600) {
    this.running = false;
    await this.loop;
    this.lastHoldMs = lastHoldMs;
    return this;
  }

  /** ffmpeg で GIF にする。3 MB を超えたら、間隔・色数・幅を落として作り直す。 */
  encode(width = 960) {
    const list = this.frames
      .map((frame, i) => {
        const next = this.frames[i + 1];
        const duration = next === undefined ? this.lastHoldMs / 1000 : Math.max(0.02, (next.t - frame.t) / 1000);
        return `file '${frame.file}'\nduration ${duration.toFixed(3)}`;
      })
      .join('\n');
    writeFileSync(join(this.dir, 'list.txt'), `${list}\nfile '${this.frames[this.frames.length - 1].file}'\n`, 'utf8');
    const out = safe(join(h.OUT, `${this.name}.gif`));
    mkdirSync(h.OUT, { recursive: true });
    const attempts = [
      { fps: 12, colors: 128, width },
      { fps: 10, colors: 96, width: Math.min(width, 900) },
      { fps: 10, colors: 64, width: Math.min(width, 800) },
      { fps: 8, colors: 64, width: Math.min(width, 720) },
    ];
    for (const attempt of attempts) {
      const scale = Math.min(attempt.width, this.clip.width * (this.clip.scale ?? 1));
      const filter = `fps=${attempt.fps},scale=${Math.round(scale)}:-1:flags=lanczos,split[a][b];[a]palettegen=max_colors=${attempt.colors}:stats_mode=diff[p];[b][p]paletteuse=dither=bayer:bayer_scale=5:diff_mode=rectangle`;
      const result = spawnSync('ffmpeg', ['-y', '-loglevel', 'error', '-f', 'concat', '-safe', '0', '-i', 'list.txt', '-vf', filter, '-loop', '0', out], { cwd: this.dir, encoding: 'utf8' });
      if (result.status !== 0) throw new Error(`ffmpeg が失敗しました: ${result.stderr}`);
      const size = statSync(out).size;
      console.log(`  ${this.name}.gif: ${Math.round(scale)}px 幅・${attempt.fps} 枚/秒・${attempt.colors} 色・${this.frames.length} 枚・${(size / 1024).toFixed(0)} KB`);
      if (size <= MAX_BYTES) return size;
    }
    console.error(`  ${this.name}.gif が 3 MB を超えています`);
    return statSync(out).size;
  }
}

const sizes = {};

/** 本文（サイドバーを除く）の範囲。 */
async function mainClip(page, height = 760) {
  const side = await page.evalJs(`Math.round(document.querySelector('.side').getBoundingClientRect().width)`);
  return { x: side, y: 0, width: 1280 - side, height, scale: 1 };
}

// ---- 3. ウィジェット（記録中の半荘を置いて起動する） ----

async function widgetGif() {
  console.log('4. ウィジェット');
  h.writeRecordingSession();
  await h.startApp({ width: 1280, height: 800 });
  const widget = await h.attachWidget({ glide: 220 });
  await widget.waitFor(`document.querySelector('.widget.v') && document.querySelector('.doubt .num') && document.querySelector('.doubt .num').textContent === '4'`, '縦長のウィジェット');
  // 記録の命令は、窓の中の偽の状態で答える（本体には届かない）
  await widget.evalJs(`window.__jrStub.initRecord()`);
  await installCursor(widget);
  const size = await widget.evalJs(`({ w: window.innerWidth, h: window.innerHeight })`);
  await widget.viewport(size.w, size.h, 2);
  await sleep(500);
  const rec = new Recorder(widget, 'widget-record', { x: 0, y: 0, width: size.w, height: size.h, scale: 2 });
  const press = async (finder, label) => {
    await widget.click(finder, label, { scroll: false, pause: 100, settle: 750 });
  };
  rec.start();
  await rec.hold(1000);
  await press(`document.querySelector('.doubt')`, '迷い');
  await press(`document.querySelector('.doubt')`, '迷い');
  await press(`document.querySelectorAll('.rate-btn')[0]`, '〇');
  await rec.hold(500);
  await press(`document.querySelectorAll('.rate-btn')[1]`, '△');
  await rec.hold(500);
  await press(`document.querySelector('.undo')`, '取り消し');
  await rec.hold(700);
  await rec.stop(1400);
  const blocked = await widget.evalJs(`window.__jrStub.blocked.join(',')`);
  console.log(`  本体に通さずに受け止めた命令: ${blocked}`);
  sizes['widget-record'] = rec.encode(size.w * 2);
  h.stopApp();
  await sleep(1500);
}

// ---- 1. 取り込み・出題 ----

async function importQuizGifs() {
  console.log('1. 取り込み・出題');
  h.writeSession({ start: h.A_START, items: h.A_ITEMS });
  await h.startApp({ width: 1280, height: 800, pageOptions: { glide: 200 } });
  const main = h.main;
  await main.waitFor(`${listRows}.length === 1`, '一覧の 1 行');
  await h.setTheme(false);
  await installCursor(main);
  await main.viewport(1280, 560, 1);
  await sleep(500);
  const A = appActions(main, { pace: 1.3 });

  // 取り込み
  const importRec = new Recorder(main, 'import-flow', { x: 0, y: 0, width: 1280, height: 560, scale: 1 });
  importRec.start();
  await importRec.hold(900);
  await importFlow(
    h,
    {
      onOffer: () => importRec.hold(1100),
      onLink: () => importRec.hold(1300),
      onWaiting: () => importRec.hold(1100),
      onTyped: () => importRec.hold(700),
      onDone: () => importRec.hold(1800),
    },
    { typeDelay: 14 },
  );
  await importRec.stop(1800);
  sizes['import-flow'] = importRec.encode(960);

  // 出題の 1 問
  await main.viewport(1280, 800, 1);
  await main.waitFor(`document.querySelector('.nav-item .count')`, 'サイドバーの数', 60000);
  await sleep(1200);
  // 終局直後のメモを、本体の命令で入れておく（答え合わせのあとに、自分の答えの下へ出る）
  const sessionId = h.stamp(h.A_START);
  await main.evalJs(`window.__TAURI_INTERNALS__.invoke('set_memo', { sessionId: ${JSON.stringify(sessionId)}, markId: 1, candidates: '5p・2m', reason: '孤立した5pと2mのどちらを切るか' })`);
  await sleep(500);
  await A.openNav('今日の出題');
  await main.waitFor(`document.querySelector('.qlist .qrow')`, '今日の出題の行');
  const clip = await mainClip(main, 800);
  const quizRec = new Recorder(main, 'quiz-answer', clip);
  quizRec.start();
  await quizRec.hold(1000);
  await main.click(`document.querySelector('.qlist:not([aria-label="残りの出題"]) .qrow')`, '1 問目', { pause: 150 });
  await main.waitFor(`document.querySelector('.qz[data-state="answering"]')`, '出題の画面');
  await quizRec.hold(1200);
  await A.answerQuiz({
    pick: QUIZ_PICK,
    reason: '受け入れの広い形を残したい',
    typeDelay: 55,
    beforeSubmit: () => quizRec.hold(700),
    afterReveal: async () => {
      await quizRec.hold(1200);
      await main.wheel(380, { x: 1000, y: 400, steps: 12 });
      await quizRec.hold(1400);
      await main.wheel(380, { x: 1000, y: 400, steps: 12 });
      await quizRec.hold(1000);
    },
    causes: ['受け入れ枚数'],
    principle: '先に受け入れを数えてから切る',
  });
  await quizRec.hold(1400);
  await quizRec.stop(1600);
  sizes['quiz-answer'] = quizRec.encode(960);

  h.stopApp();
  await sleep(1500);
}

/** 履歴の元になる答え（録らない）。結果だけの半荘を足して起動し、画面の操作で答え、止めたあとに日付を書き換える。 */
async function historyAnswers() {
  console.log('2. 履歴の元になる答え（録らない）');
  for (const { report, start } of h.RESULT_ONLY) h.writeSession({ start, report });
  await h.startApp({ width: 1280, height: 800 });
  const main = h.main;
  await main.waitFor(`${listRows}.length === 6`, '一覧の 6 行');
  await main.waitFor(`document.querySelectorAll('.session-scroll .s-rate').length === 6`, '結果の段階の読み込み', 60000);
  await main.waitFor(`document.querySelector('.nav-item .count')`, 'サイドバーの数', 60000);
  await h.setTheme(false);
  const count = await answerRest(h, appActions(main), 9);
  console.log(`  履歴の元に答えた問題: ${count}`);
  await sleep(500);
  h.stopApp();
  await sleep(1500);
  // 答えの順: 0 は録った出題の 1 問目（今日のまま）、1 以降が履歴
  const rows = backdateAnswers(h, historyPlan(count, 1));
  console.log(`  答えの日付を書き換えた（答えは全部で ${rows} 件）`);
}

/** 1 問目の答えの牌（手牌の何番目か。-1 はツモ牌）。AI の1位の牌に合わせる（正解の見本にするため）。 */
const QUIZ_PICK = Number(process.env.README_QUIZ_PICK ?? 7);

// ---- 2. 半荘を通して見る・週の集計 ----

async function replayWeekGifs() {
  console.log('3. 半荘を通して見る・週の集計');
  await h.startApp({ width: 1280, height: 800, pageOptions: { glide: 200 } });
  const main = h.main;
  await main.waitFor(`${listRows}.length === 6`, '一覧の 6 行');
  await main.waitFor(`document.querySelectorAll('.session-scroll .s-rate').length === 6`, '結果の段階の読み込み', 60000);
  await main.waitFor(`document.querySelector('.nav-item .count')`, 'サイドバーの数', 60000);
  await h.setTheme(false);
  await installCursor(main);
  await main.viewport(1280, 850, 1);
  await sleep(500);
  const A = appActions(main, { pace: 1.2 });

  // 半荘を通して見る（キーボード）
  await A.openSession('21:03');
  await main.click(byTextIncludes('button', 'この半荘を通して見る'), '通して見る');
  await main.waitFor(`document.querySelector('.now, .now-panel, [aria-label*="位置の帯"]')`, '通して見る画面');
  await sleep(1000);
  const replayRec = new Recorder(main, 'replay-keys', await mainClip(main, 850));
  const key = async (name, options = {}) => {
    await main.pressKey(name, { settle: options.settle ?? 520, ...options });
  };
  replayRec.start();
  await replayRec.hold(1200);
  for (let i = 0; i < 5; i += 1) await key('.', { code: 'Period', settle: 380 });
  await replayRec.hold(500);
  await key('ArrowDown', { modifiers: 8, settle: 1500 }); // Shift+↓: 次の迷い
  await key('ArrowDown', { modifiers: 8, settle: 1500 });
  await key('ArrowDown', { settle: 1500 }); // ↓: 次の不一致
  await key('ArrowRight', { settle: 1400 }); // →: 次の自分の判断
  await key('ArrowRight', { modifiers: 8, settle: 1500 }); // Shift+→: 次の局
  await replayRec.hold(500);
  await replayRec.stop(1600);
  sizes['replay-keys'] = replayRec.encode(960);

  // 週の集計
  await A.openNav('週の集計');
  await main.waitFor(`document.querySelector('.wk-tiles')`, '週の集計');
  await main.wheel(-2000, { steps: 2 });
  await sleep(500);
  const weekRec = new Recorder(main, 'week-page', await mainClip(main, 760));
  weekRec.start();
  await weekRec.hold(1300);
  await main.click(`document.querySelector('button[aria-label="前の週"]')`, '前の週', { pause: 150 });
  await weekRec.hold(1600);
  await main.click(`document.querySelector('button[aria-label="前の週"]')`, '前の週', { pause: 150 });
  await weekRec.hold(1000);
  await main.click(`document.querySelector('button[aria-label="次の週"]')`, '次の週', { pause: 150 });
  await weekRec.hold(900);
  await main.wheel(300, { x: 900, y: 400, steps: 8 });
  // 直近の週の点（図の右の端）にマウスを乗せる
  for (const index of [0, 1]) {
    const plot = await main.viewRectOf(`document.querySelectorAll('.lc-plot')[${index}]`);
    await main.mouse('mouseMoved', plot.x + plot.width - 18, plot.y + plot.height / 2, { button: 'none', clickCount: 0 });
    await weekRec.hold(1500);
  }
  await main.click(`document.querySelector('.wk-tv')`, '表で見る', { scroll: false, pause: 150 });
  await weekRec.hold(1800);
  await main.click(`document.querySelector('.wk-tv')`, '図で見る', { scroll: false, pause: 150 });
  await weekRec.hold(700);
  await weekRec.stop(1500);
  sizes['week-page'] = weekRec.encode(960);
  h.stopApp();
}

// ---- 実行 ----

let failed = false;
try {
  // 記録中の半荘（ウィジェット用）は、取り込みの相手が 2 つになってしまうので、いちばん最後に置く
  await importQuizGifs();
  await historyAnswers();
  await replayWeekGifs();
  await widgetGif();
  for (const [name, size] of Object.entries(sizes)) console.log(`${name}.gif: ${(size / 1024 / 1024).toFixed(2)} MB`);
  console.log('できました');
} catch (error) {
  failed = true;
  console.error('失敗:', error instanceof Error ? error.message : error);
  console.error('アプリの標準エラー:', h.stderr.trim() || '(なし)');
  for (const [label, page] of [['main', h.main], ['widget', h.widget]]) {
    if (page === null) continue;
    try {
      const r = await page.cdp.send('Page.captureScreenshot', { format: 'png' });
      const path = join(tmpdir(), `jr-readme-gifs-error-${label}.png`);
      writeFileSync(path, Buffer.from(r.data, 'base64'));
      console.error(`失敗した時点の画面: ${path}`);
    } catch {
      // 撮れなければ、そのまま
    }
  }
} finally {
  await h.cleanup();
}
void existsSync;
void readdirSync;
void byText;
process.exit(failed ? 1 : 0);
