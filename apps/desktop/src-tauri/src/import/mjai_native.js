// mjai の窓に、ブラウザの名残を出さないための、ページ側の設定（SPEC 3a 節の N-9・N-10）。
// 窓を作るときに、最初に評価させる（主フレームだけ）。ショートカット・拡大・右クリックのメニュー・URL の表示などは、
// WebView2 の設定（webview_policy.rs）で切っているので、ここはページの中でしか止められないものだけ。
//
// - N-9: マウスの戻る・進むボタンの既定の動作（履歴の移動）と、中ボタンの自動スクロール。
// - N-10: 入力欄の入力候補と、つづりの確認の赤い波線。
(function () {
  'use strict';

  // 3 = 戻る、4 = 進む、1 = 中ボタン。押した時（mousedown）に止めると、自動スクロールも履歴の移動も始まらない。
  function isBlocked(button) {
    return button === 1 || button === 3 || button === 4;
  }

  function block(event) {
    if (isBlocked(event.button)) {
      event.preventDefault();
    }
  }

  ['mousedown', 'mouseup', 'auxclick'].forEach(function (type) {
    window.addEventListener(type, block, true);
  });

  function quiet(root) {
    var fields = root.querySelectorAll ? root.querySelectorAll('input, textarea') : [];
    for (var i = 0; i < fields.length; i++) {
      fields[i].setAttribute('autocomplete', 'off');
      fields[i].setAttribute('spellcheck', 'false');
    }
  }

  function start() {
    quiet(document);
    if (typeof MutationObserver === 'function') {
      new MutationObserver(function () {
        quiet(document);
      }).observe(document.documentElement, { childList: true, subtree: true });
    }
  }

  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', start);
  } else {
    start();
  }
})();
