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
 * 流れ（アプリは、同じ一時フォルダを使って、段ごとに起動し直す。1 回の起動は 2 分以内）:
 * 1. 取り込み: 結果を取り込む前の半荘を 1 つ置いて起動し、画面の操作で取り込む（文字認識と結びつけは、アプリの本物の処理）。
 *    今日の出題の組は、このとき、取り込んだ半荘の迷いを先にして作られる。
 * 2. 半荘の画面: 結果だけの半荘と、記録中の半荘（ウィジェットが続きを記録する半荘）を足して起動し直し、ウィジェット・半荘の一覧・
 *    半荘の画面（終局直後のメモ・迷いマークの無い迷い・局の評価の表・MAKA の当てはめの見込み）を撮る。ダークと細い窓も。
 * 3. 出題: 今日の出題・出題（答える前・答え合わせのあと・受け入れ枚数の小窓・2 向聴からの先）。画面の操作で答える。
 * 4. 履歴: 画面の操作で、昔の問題にも答える。答えの日付と解き直しの期限は、保存先の study.sqlite（一時フォルダの中）を、
 *    アプリを止めたあとに書き換えて、数週間ぶんの履歴にする（問題は、半荘より前の日には答えない）。
 * 5. 履歴の画面: 解き直し・検討ログ・週の集計・検索・半荘を通して見る画面（鳴きの場面に答えて、欄「役」と、タブ「待ちと打点」の符の内訳も撮る）・設定。
 *
 * 安全のための決まりは、readme-lib.mjs の説明を参照（本物のデータに触れない・自分で起動したプロセスだけを止める・
 * 記録の命令は本体に通さない・クリップボードは触らない）。設定ページの写真だけは、本物の状態ではなく、表示を差し替える。
 */
import { existsSync, readdirSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { writeFileSync } from 'node:fs';

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
  listRows,
  sleep,
} from './readme-lib.mjs';

const [marksArg, outArg] = process.argv.slice(2);
if (marksArg === undefined) {
  console.error('使い方: node scripts/readme-shots.mjs <迷いマークの画像のフォルダ（mark-1.jpg ... mark-6.jpg）> [出力先（既定: docs/images）]');
  process.exit(2);
}

let h;
try {
  h = createHarness({ marksArg, outArg, prefix: 'jr-readme-shots' });
} catch (error) {
  console.error(error instanceof Error ? error.message : error);
  process.exit(2);
}

// ---- 共通の部品 ----

const sideWidth = () => h.main.evalJs(`Math.round(document.querySelector('.side').getBoundingClientRect().width)`);

/** 写真を撮る（画像と文字の読み込みを待ってから）。 */
async function shot(name, rect) {
  await h.main.settle();
  h.writePng(name, await captureOf(h.main, rect));
}

/** サイドバーを除いた本文の範囲で撮る（高さは窓の高さに合わせてから）。 */
async function shotMain(name, { trim = 0, height } = {}) {
  const side = await sideWidth();
  await h.main.fit(1280, 800);
  const total = await h.main.evalJs('Math.ceil(document.documentElement.scrollHeight)');
  await shot(name, { x: side, y: 0, width: 1280 - side, height: Math.min(height ?? total, total) - trim });
}

/** アプリを起動して、一覧が出そろうまで待つ。 */
async function boot(rows, rated) {
  await h.startApp({ width: 1280, height: 800 });
  await h.main.waitFor(`${listRows}.length === ${rows}`, `一覧の ${rows} 行`);
  await h.main.waitFor(`document.querySelectorAll('.session-scroll .s-rate').length === ${rated}`, '結果の段階の読み込み', 60000);
  await h.main.waitFor(`document.querySelector('.nav-item .count')`, 'サイドバーの数', 60000);
  await h.setTheme(false);
  await h.main.fit(1280, 800);
}

const flowBottom = async () => {
  const box = await h.main.rectOf(`document.querySelector('.import-flow')`);
  return Math.ceil(box.y + box.height + 40);
};

// ---- 1. 取り込み ----

async function importPhase() {
  console.log('1. 取り込み');
  h.writeSession({ start: h.A_START, items: h.A_ITEMS });
  await h.startApp({ width: 1280, height: 800 });
  await h.main.waitFor(`${listRows}.length === 1`, '一覧の 1 行');
  await h.setTheme(false);
  await h.main.fit(1280, 800);
  await importFlow(h, {
    onLink: async () => shot('import-link.png', { x: 0, y: 0, width: 1280, height: await flowBottom() }),
    onDone: async () => shot('import-done.png', { x: 0, y: 0, width: 1280, height: await flowBottom() }),
  });
  const imported = readdirSync(join(h.DATA, 'games')).filter((id) => existsSync(join(h.DATA, 'games', id, 'links.json')));
  console.log(`  取り込んだ半荘: ${imported.join(', ')}（links.json あり）`);
  if (imported.length !== 1) throw new Error('結びつけの保存が 1 つの半荘に付いていません');
  await h.main.waitFor(`document.querySelector('.nav-item .count')`, '今日の出題の数');
  h.stopApp();
  await sleep(1500);
}

// ---- 2. 半荘の画面 ----

async function hanchanPhase() {
  console.log('2. 半荘の画面');
  for (const { report, start } of h.RESULT_ONLY) h.writeSession({ start, report });
  h.writeRecordingSession();
  await boot(7, 6);
  const A = appActions(h.main);
  const main = h.main;
  await main.fit(1280, 900);

  // ウィジェット（縦長・横長）。記録中の半荘は、迷い 4・評価 3（次は 4 局目）。記録の命令は、本体に通さない。
  const widget = await h.attachWidget();
  await widget.waitFor(`document.querySelector('.widget.v') && document.querySelector('.doubt .num') && document.querySelector('.doubt .num').textContent === '4'`, '縦長のウィジェット');
  const widgetShot = async (name) => {
    const size = await widget.evalJs(`({ w: window.innerWidth, h: window.innerHeight })`);
    await widget.viewport(size.w, size.h, 2);
    await widget.settle();
    h.writePng(name, await captureOf(widget, { x: 0, y: 0, width: size.w, height: size.h }));
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
  await A.openSession('21:03');
  await main.waitFor(`document.querySelectorAll('.mcard .mread').length === 6`, '半荘の画面');
  await main.viewport(1280, 900, 2);
  await sleep(300);
  const side = await sideWidth();
  const listTop = await main.rectOf(`document.querySelector('.list-head')`);
  const lastRow = await main.evalJs(`(() => { const items = document.querySelectorAll('.session-scroll .s-item'); return items[items.length - 1].getBoundingClientRect().bottom + scrollY; })()`);
  await shot('sessions-list.png', { x: 0, y: Math.floor(listTop.y - 8), width: side, height: Math.ceil(lastRow + 16 - (listTop.y - 8)) });
  await main.viewport(1280, 900, 1);

  // 終局直後のメモ（迷いのカードの「候補」「理由」）
  await A.writeMemo(1, '5p・2m', '孤立した5pと2mのどちらを切るか');
  await A.writeMemo(2, '8p・9m', '先に受け入れを広げたかった');
  await A.writeMemo(3, '南・1s', '安全牌を残すか、形を取るか');
  await A.writeMemo(4, 'ポン・スルー', '役牌だが、手が重くなるのが気になった');
  await sleep(1000);
  await main.fit(1280, 900);
  const row1 = await main.evalJs(`(() => { const cards = document.querySelectorAll('ul.marks:not(.extras) .mcard'); const r = cards[2].getBoundingClientRect(); return Math.ceil(r.bottom + scrollY + 28); })()`);
  await shot('hanchan-cards.png', { x: 0, y: 0, width: 1280, height: row1 });

  // 迷いマークの無い迷い（画像が無いので、局と巡目は手で選ぶ）。足す前の欄と、足したあとのカード。
  await A.addExtraMemo({ kyoku: '東3局', turn: '5巡目', candidates: '4s・發', reason: 'リーチに押すか迷った', submit: false });
  const panel = await main.rectOf(`document.querySelector('.memo-add')`);
  await shot('memo-extra-add.png', { x: panel.x - 16, y: panel.y - 16, width: panel.width + 32, height: panel.height + 32 });
  await main.click(byText('button', '足す'), '足す');
  await main.waitFor(`document.querySelector('ul.extras .mcard')`, '追加のメモのカード');
  await closeToast();
  await main.fit(1280, 900);
  const card = await main.rectOf(`document.querySelector('ul.extras .mcard')`);
  await shot('memo-extra-card.png', { x: card.x - 16, y: card.y - 16, width: card.width + 32, height: card.height + 32 });

  // 局の評価の表（迷いの列・MAKA の入力・当てはめの見込み）
  await A.setMaka('東1局', 'S');
  await A.setMaka('東2局', 'A+');
  await A.setMaka('東2局1本場', 'A');
  await A.setMaka('東3局', 'B+');
  await A.setMaka('東3局1本場', 'A');
  await main.waitFor(`document.querySelector('.fit-done')`, '合わせ直しました', 15000);
  await closeToast();
  await main.fit(1280, 900);
  const table = await main.rectOf(byText('h2.sec-title', '局の評価') + `.closest('section')`);
  await shot('hanchan-table.png', { x: side, y: Math.floor(table.y - 12), width: 1280 - side, height: Math.ceil(table.height + 28) });

  // ダークテーマ
  await h.setTheme(true);
  await main.fit(1280, 900);
  const row1Dark = await main.evalJs(`(() => { const cards = document.querySelectorAll('ul.marks:not(.extras) .mcard'); const r = cards[2].getBoundingClientRect(); return Math.ceil(r.bottom + scrollY + 28); })()`);
  await shot('hanchan-dark.png', { x: 0, y: 0, width: 1280, height: row1Dark });
  await h.setTheme(false);

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
  await shot('sessions-delete.png', { x: 0, y: deleteTop, width: Math.ceil(dialog.x + dialog.width + 24), height: deleteBottom - deleteTop });
  await main.click(byText('.dlg .btn', '削除'));
  await main.waitFor(`document.querySelector('.toast')`, '元に戻すの通知');
  await main.waitFor(`${listRows}.length === 5`, '消した半荘が一覧から消える');
  await main.click(byText('.toast .btn', '元に戻す'));
  await main.waitFor(`${listRows}.length === 7`, '半荘が戻る');
  await sleep(500);
  await closeToast();

  // 細い窓（幅 390px）: 半荘の画面と、サイドバーの引き出し
  await A.openSession('21:03');
  await main.viewport(390, 760, 1);
  await sleep(500);
  await main.evalJs('window.scrollTo(0, 0)');
  await sleep(500);
  await shot('narrow-hanchan.png', { x: 0, y: 0, width: 390, height: 760 });
  await main.click(`document.querySelector('.topbar .sb-toggle')`);
  await sleep(700);
  await shot('narrow-drawer.png', { x: 0, y: 0, width: 390, height: 760 });
  const left = existsSync(join(h.DATA, 'trash')) ? readdirSync(join(h.DATA, 'trash')) : [];
  console.log(`  trash に残ったもの: ${left.length} 個`);
  if (left.length !== 0) throw new Error('消した半荘を戻しきれていません');
  h.stopApp();
  await sleep(1500);
}

/** 通知（元に戻す）を閉じる。写真に写さないため。 */
async function closeToast() {
  const toasts = await h.main.evalJs(`document.querySelectorAll('.toast').length`);
  if (toasts === 0) return;
  await h.main.click(`document.querySelector('.toast .toast-x')`, '通知を閉じる').catch(() => undefined);
  await h.main.waitFor(`!document.querySelector('.toast')`, '通知が消える', 15000);
}

// ---- 3. 出題 ----

/** 今日の出題の一覧の n 行目（1 から）を開く。 */
const openToday = async (A, n) => {
  await A.openNav('今日の出題');
  await h.main.click(`document.querySelectorAll('.qlist:not([aria-label="残りの出題"]) .qrow')[${n - 1}]`, `今日の ${n} 問目`);
  await h.main.waitFor(`document.querySelector('.qz')`, '出題の画面');
};

async function studyPhase() {
  console.log('3. 出題');
  await boot(7, 6);
  const A = appActions(h.main);
  const main = h.main;
  const side = await sideWidth();
  const rowTexts = await (async () => {
    await A.openNav('今日の出題');
    await main.waitFor(`document.querySelector('.qlist .qrow')`, '今日の出題の行');
    return main.evalJs(`Array.from(document.querySelectorAll('.qlist:not([aria-label="残りの出題"]) .qrow')).map((r) => r.textContent.replace(/\\s+/g, ' ').trim())`);
  })();
  console.log(`  今日の出題: ${JSON.stringify(rowTexts)}`);

  // 1 問目: 答える前（牌を選び、理由を書いたところ）→ 答え合わせのあと → 受け入れ枚数の小窓
  await openToday(A, 1);
  await answerShots(A, 'quiz', side, { pick: -1, reason: '受け入れの広い形を残したい', causes: ['受け入れ枚数'], principle: '先に受け入れを数えてから切る' });

  // 2 問目以降（2 向聴の問題があれば、「2向聴からの先」の写真も撮る）
  const twoIndex = rowTexts.findIndex((t, i) => i > 0 && t.includes('2向聴'));
  for (let n = 2; n <= 3; n += 1) {
    await openToday(A, n);
    const isTwo = n - 1 === twoIndex;
    await A.answerQuiz({ pick: n === 2 ? 0 : -1, reason: '押し引きを考えて、安全な牌を選んだ', causes: ['守備'] });
    if (isTwo) await followShot();
    await main.fit(1280, 800);
  }
  if (twoIndex > 2) {
    await openToday(A, twoIndex + 1);
    await A.answerQuiz({ pick: 0, reason: '形を見て、ターツを残した' });
    await followShot();
  }

  // 今日の出題の一覧（解いた問題に「解答済み」が付く）
  await A.openNav('今日の出題');
  await main.waitFor(`document.querySelector('.qlist')`, '一覧');
  await shotMain('today-list.png', { height: 700 });
  h.stopApp();
  await sleep(1500);
}

/** 出題 1 問の写真: 牌を選んで理由を書いたところ → 答え合わせのあと → 受け入れ枚数の小窓。 */
async function answerShots(A, name, side, options) {
  const main = h.main;
  await A.answerQuiz({
    ...options,
    beforeSubmit: async () => {
      await main.fit(1280, 800);
      await shot('quiz-question.png', { x: side, y: 0, width: 1280 - side, height: 800 });
    },
    causes: [],
    principle: null,
  });
  await main.fit(1280, 800);
  const total = await main.evalJs('Math.ceil(document.documentElement.scrollHeight)');
  await shot('quiz-reveal.png', { x: side, y: 0, width: 1280 - side, height: total });
  // 受け入れ枚数の小窓
  await main.click(`document.querySelector('.uk-open')`, '受け入れ枚数の行');
  await main.waitFor(`document.querySelector('#ukpop')`, '小窓');
  await sleep(500);
  await shotPopup('quiz-ukeire.png');
  await main.pressEscape();
  // 差の原因・学んだ原則を付けて、保存する
  for (const cause of ['受け入れ枚数']) await main.click(byText('label.pill', cause), `差の原因 ${cause}`);
  await main.type(`document.querySelector('form.learn input.input, form.learn textarea')`, '先に受け入れを数えてから切る');
  await main.pressKey('Tab');
  void name;
}

/** 受け入れ枚数の小窓だけを撮る（まわりに少し余白を付ける）。 */
async function shotPopup(name) {
  const main = h.main;
  const pop = await main.viewRectOf(`document.querySelector('#ukpop')`);
  const scrollY = await main.evalJs('window.scrollY');
  await shot(name, { x: Math.max(0, Math.floor(pop.x - 16)), y: Math.max(0, Math.floor(pop.y + scrollY - 16)), width: Math.ceil(pop.width + 32), height: Math.ceil(pop.height + 32) });
}

/** 2 向聴の問題: 受け入れ枚数の小窓の「2向聴からの先」の欄。 */
async function followShot() {
  const main = h.main;
  const tab = await main.evalJs(`!!Array.from(document.querySelectorAll('.uk-open')).length`);
  if (!tab) return;
  await main.click(`document.querySelector('.uk-open')`, '受け入れ枚数の行');
  await main.waitFor(`document.querySelector('#ukpop')`, '小窓');
  const hasFollow = await main.evalJs(`!!Array.from(document.querySelectorAll('#ukpop [role=tab]')).find((t) => t.textContent.includes('2向聴からの先'))`);
  if (!hasFollow) {
    await main.pressEscape();
    return;
  }
  await main.click(`Array.from(document.querySelectorAll('#ukpop [role=tab]')).find((t) => t.textContent.includes('2向聴からの先'))`, '2向聴からの先');
  await sleep(500);
  await shotPopup('quiz-follow.png');
  await main.pressEscape();
}

// ---- 4. 履歴（画面の操作で昔の問題に答える） ----

const HISTORY_ANSWERS = 9;

async function historyPhase() {
  console.log('4. 履歴（昔の問題に答える）');
  await boot(7, 6);
  const A = appActions(h.main);
  const count = await answerRest(h, A, HISTORY_ANSWERS);
  console.log(`  答えた問題: ${count}`);
  await sleep(500);
  h.stopApp();
  await sleep(1500);
  // 画面の操作で付けた答えの順: 0〜2 は今日の出題（今日のまま）、3 以降が履歴
  const total = backdateAnswers(h, historyPlan(count, 3));
  console.log(`  答えの日付を履歴にした（答えは全部で ${total} 件）`);
}

// ---- 5. 履歴の画面 ----

async function screensPhase() {
  console.log('5. 履歴の画面');
  await boot(7, 6);
  const A = appActions(h.main);
  const main = h.main;
  const side = await sideWidth();

  // 解き直し（答える前。今日が期限の問題）
  await A.openNav('解き直し');
  await main.waitFor(`document.querySelector('.qz')`, '解き直しの画面');
  await shotMain('review.png', { height: 800 });

  // 検討ログ
  await A.openNav('ログ');
  await main.waitFor(`document.querySelector('.log, .log-list, main')`, 'ログ');
  await main.click(byTextIncludes('button.lf', '期間'), '期間の絞り込み');
  await A.pickMenu('すべて', { exact: false });
  await sleep(600);
  await shotMain('log.png', { height: 760 });

  // 週の集計: 先週。成績（手入力）と来週の重点も書く
  await A.openNav('週の集計');
  await main.waitFor(`document.querySelector('.wk-tiles')`, '週の集計');
  await main.click(`document.querySelector('button[aria-label="前の週"]')`, '前の週');
  await sleep(700);
  const stat = (label, value) => main.type(`Array.from(document.querySelectorAll('li.wk-recc')).find((li) => li.querySelector('label').textContent === ${JSON.stringify(label)}).querySelector('input')`, value, { settle: 100 }).then(() => main.pressKey('Enter', { settle: 250 }));
  await stat('4位率', '18.0');
  await stat('放銃率', '12.5');
  await stat('平均順位', '2.35');
  await stat('和了率', '23.0');
  await main.click(`document.querySelector('button[aria-label="前の週"]')`, '前の週');
  await sleep(500);
  await stat('4位率', '22.0');
  await stat('放銃率', '14.0');
  await stat('平均順位', '2.52');
  await main.click(`document.querySelector('button[aria-label="次の週"]')`, '次の週');
  await sleep(500);
  await main.type(`document.querySelector('.wk-focus textarea')`, '受け入れを数えてから切る\n押されたら、まず安全度を見る', { settle: 200 });
  await main.pressKey('Tab', { settle: 500 });
  await main.fit(1280, 800);
  const wkTotal = await main.evalJs('Math.ceil(document.documentElement.scrollHeight)');
  const sectionTop = (title) => main.evalJs(`(() => { const s = Array.from(document.querySelectorAll('.wk-sec')).find((el) => el.textContent.includes(${JSON.stringify(title)})); return Math.floor(s.getBoundingClientRect().top + scrollY); })()`);
  const typesTop = await sectionTop('局面の種類');
  // 上の半分（今週の数・差の原因・推移）。差の原因の棒に、マウスを乗せて、ツールチップも出す
  await main.settle();
  // 直近の週の点（図の右の端）にマウスを乗せる
  const plot = await main.viewRectOf(`document.querySelector('.lc-plot')`);
  await main.mouse('mouseMoved', plot.x + plot.width - 18, plot.y + plot.height / 2, { button: 'none', clickCount: 0 });
  await sleep(500);
  const top = Math.min(typesTop - 8, wkTotal);
  h.writePng('week-top.png', await captureOf(main, { x: side, y: 0, width: 1280 - side, height: top }));
  await main.mouse('mouseMoved', 1270, 1, { button: 'none', clickCount: 0 });
  await sleep(300);
  const bottomTop = typesTop - 8;
  const evalTop = await sectionTop('成績（手入力）');
  h.writePng('week-bottom.png', await captureOf(main, { x: side, y: bottomTop, width: 1280 - side, height: Math.min(evalTop - bottomTop + 8, wkTotal - bottomTop) }));

  // 検索の重ね表示
  await main.click(`document.querySelector('.search-btn')`, '検索');
  await main.waitFor(`document.querySelector('.sx input')`, '検索の欄');
  await main.type(`document.querySelector('.sx input')`, '1向聴 迷い', { settle: 900 });
  await main.waitFor(`document.querySelectorAll('.sx [role=option], .sx li').length > 0`, '検索の結果');
  await main.fit(1280, 800);
  const sx = await main.rectOf(`document.querySelector('.sx')`);
  await shot('search.png', { x: Math.max(0, Math.floor(sx.x - 24)), y: Math.max(0, Math.floor(sx.y - 24)), width: Math.ceil(sx.width + 48), height: Math.ceil(sx.height + 48) });
  await main.pressEscape();

  // 半荘を通して見る画面（自分の迷いへ飛ぶ）
  await A.openSession('21:03');
  await main.click(byTextIncludes('button', 'この半荘を通して見る'), '通して見る');
  await main.waitFor(`document.querySelector('.rp-strip, .strip, [aria-label*="位置の帯"]') || document.querySelector('.now, .now-panel')`, '通して見る画面');
  await sleep(500);
  // 5 つ目の迷いの場面（まだ答えていない場面。終局直後のメモを書ける）
  for (let i = 0; i < 5; i += 1) {
    await main.click(byTextIncludes('button', '次の迷いへ'), '次の迷いへ');
    await sleep(500);
  }
  await sleep(500);
  await shotMain('replay.png', {});

  // 役の欄（F13）: 鳴きの場面（ポン・スルーのボタンがある迷い）に戻って答え、答え合わせのあとの欄「役」だけを撮る（panel の幅、2 倍の細かさ）
  for (let i = 0; i < 5; i += 1) {
    if (await main.evalJs(`!!document.querySelector('.q-choices [role=radio]')`)) break;
    await main.click(`document.querySelector('#j-doubt-prev')`, '前の迷いへ');
    await sleep(500);
  }
  await A.answerQuiz({ pick: 0, reason: '役牌なので、鳴いて手を進める' });
  await main.fit(1280, 900, 2);
  await sleep(300);
  const yakuBox = await main.rectOf(`document.querySelector('[data-ai="yaku-box"]')`);
  const answerPanel = await main.rectOf(`document.querySelector('.answer')`);
  await shot('quiz-yaku.png', { x: answerPanel.x, y: Math.max(0, Math.floor(yakuBox.y - 16)), width: answerPanel.width, height: Math.ceil(yakuBox.height + 32) });

  // 待ちと打点（F14）: 同じ場面（東をポンしたあとは聴牌）の、タブ「待ちと打点」。符の数にマウスを乗せて、内訳を出した形を撮る
  // （重なりは、マウスを離すと閉じるので、整える（settle）のは乗せる前に済ませ、撮るときは整えない）
  await main.click(`Array.from(document.querySelectorAll('[role=tab]')).find((t) => t.textContent === '待ちと打点')`, 'タブ「待ちと打点」');
  await main.waitFor(`document.querySelector('[data-ai="waits-box"]')`, '待ちと打点の欄');
  await main.fit(1280, 900, 2);
  await main.settle();
  // 最後の待ちの行のロンの符に乗せる（重なりは符の上に出るので、1 つ目の待ちの形と役の札が隠れない）
  const lastFu = `Array.from(document.querySelectorAll('.wt-tbl tbody tr')).pop().querySelector('td.dama .wt-fu')`;
  const fuBox = await main.viewRectOf(lastFu);
  await main.mouse('mouseMoved', fuBox.x + fuBox.width / 2, fuBox.y + fuBox.height / 2, { button: 'none', clickCount: 0 });
  await main.waitFor(`document.querySelector('.wt-fu-pop:not([hidden])')`, '符の内訳の重なり');
  await sleep(400);
  const tabsBox = await main.rectOf(`document.querySelector('.rv-tabs')`);
  const panelBox = await main.rectOf(`document.querySelector('.wt-panel')`);
  const tipBox = await main.rectOf(`document.querySelector('.wt-fu-pop:not([hidden])')`);
  const waitsTop = Math.max(0, Math.floor(Math.min(tabsBox.y, tipBox.y) - 16));
  const waitsBottom = Math.ceil(panelBox.y + panelBox.height + 16);
  h.writePng('quiz-waits.png', await captureOf(main, { x: answerPanel.x, y: waitsTop, width: answerPanel.width, height: waitsBottom - waitsTop }));
  await main.mouse('mouseMoved', 1270, 1, { button: 'none', clickCount: 0 });
  await main.viewport(1280, 900, 1);

  // 設定（表示だけ差し替える。ファイルの上の説明を参照）
  await main.evalJs(`window.__jrStub.settings = true`);
  await A.openNav('設定');
  await main.waitFor(`document.querySelector('.settings') && document.querySelector('.helper-state') && document.querySelector('.helper-state').textContent.includes('動いています')`, '設定ページ');
  await main.fit(1280, 900, 1);
  await sleep(1500);
  await main.waitFor(`document.querySelector('.helper-state').textContent.includes('動いています')`, '補助プログラムの表示が保たれる');
  await main.waitFor(`!document.querySelector('.toast')`, '通知が消える', 15000);
  await shot('settings.png', { x: 0, y: 0, width: 1280, height: await main.evalJs('window.innerHeight') });
  // 記録の書き出し（設定ページの 1 つの欄）
  const exportBlock = await main.rectOf(`document.querySelector('[aria-labelledby="export-lbl"]')`);
  await shot('records-export.png', { x: Math.max(0, exportBlock.x - 16), y: Math.max(0, exportBlock.y - 16), width: exportBlock.width + 32, height: exportBlock.height + 32 });
  h.stopApp();
}

// ---- 実行 ----

let failed = false;
try {
  await importPhase();
  await hanchanPhase();
  await studyPhase();
  await historyPhase();
  await screensPhase();
  console.log('できました');
} catch (error) {
  failed = true;
  console.error('失敗:', error instanceof Error ? error.message : error);
  console.error('アプリの標準エラー:', h.stderr.trim() || '(なし)');
  for (const [label, page] of [['main', h.main], ['widget', h.widget]]) {
    if (page === null) continue;
    try {
      const r = await page.cdp.send('Page.captureScreenshot', { format: 'png' });
      const path = join(tmpdir(), `jr-readme-shots-error-${label}.png`);
      writeFileSync(path, Buffer.from(r.data, 'base64'));
      console.error(`失敗した時点の画面: ${path}`);
    } catch {
      // 撮れなければ、そのまま
    }
  }
} finally {
  await h.cleanup();
}
process.exit(failed ? 1 : 0);
