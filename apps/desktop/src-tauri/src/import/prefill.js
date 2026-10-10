// mjai のサイトの「牌譜の URL」欄に、牌譜リンクを入れるだけのスクリプト（E-11）。
//
// 入れる欄は input[name="log-url"]。値を書いて、input と change のイベントを出す（サイトの change の処理が、
// 値の前の余計な文字を取り除く）。送信（Submit）のボタンは押さない。フォームの送信もしない。
// Submit は、ユーザー自身が押す（Cloudflare の確認もユーザーが通す。SPEC 2 章）。
//
// 欄がまだ無いとき（Cloudflare の確認の画面や、描き終わる前）は、一定の時間だけ、欄が現れるのを見張る。
// 呼び出し方は、Rust 側が `(この関数)(牌譜リンクの文字列)` の形で評価する。実ブラウザの試験は、
// 手書きの写しのフォームの上で、同じ関数を評価する（tests/browser/mjai-prefill.browser.test.ts）。
// 通信・送信・移動・新しい窓には、一切触れない（tests/safety.rs が、使ってよい語を限っている）。
(function (link) {
  'use strict';

  var SELECTOR = 'input[name="log-url"]';
  var WATCH_MS = 15000;

  function fill() {
    var input = document.querySelector(SELECTOR);
    if (!input) {
      return false;
    }
    // 入力欄の値の本来の書き込み口を使う（ページが value を差し替えていても、確実に書ける）。
    var descriptor = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value');
    if (descriptor && descriptor.set) {
      descriptor.set.call(input, link);
    } else {
      input.value = link;
    }
    input.dispatchEvent(new Event('input', { bubbles: true }));
    input.dispatchEvent(new Event('change', { bubbles: true }));
    return true;
  }

  if (fill()) {
    return 'filled';
  }
  if (typeof MutationObserver === 'function' && document.documentElement) {
    var observer = new MutationObserver(function () {
      if (fill()) {
        observer.disconnect();
      }
    });
    observer.observe(document.documentElement, { childList: true, subtree: true });
    window.setTimeout(function () {
      observer.disconnect();
    }, WATCH_MS);
  }
  return 'waiting';
})
