/**
 * Web ページらしい挙動を、画面（webview）の中で止める（N-3、N-8、N-9、N-10）。
 * どちらの窓の入口（main.tsx）も、起動時に `installNativeBehavior()` を呼ぶ。
 *
 * - 右クリックのメニュー: 入力欄の上のほかでは出さない（入力欄は、切り取り・コピー・貼り付け・すべて選択のために残す。
 *   メニューの中身の絞り込みは Rust 側、`webview_policy.rs`）。ウィジェットの右クリックは、別のハンドラが
 *   アプリのネイティブのメニューを出す。
 * - 中ボタンの自動スクロール（mousedown のボタン 1）、マウスの「戻る」「進む」（ボタン 3・4）を止める。
 * - ドラッグ: 画像やリンクの引きずり・ファイルのドロップで、ページが開かれたり動いたりしないようにする。
 *   OS からのファイルのドロップは Tauri が受けるので、ここまで届かない。
 * - 入力欄: スペルチェック・自動入力・自動補正・自動大文字化を切る。画像は引きずれなくする。
 */

/** 切り取り・コピー・貼り付けが意味を持つ入力欄の種類。 */
const TEXT_INPUT_TYPES: ReadonlySet<string> = new Set([
  '',
  'text',
  'search',
  'url',
  'tel',
  'email',
  'password',
  'number',
]);

/** 文字を打ち込む（切り取り・貼り付けのメニューが意味を持つ）要素か。 */
export function isEditableTarget(target: EventTarget | null): boolean {
  if (target instanceof HTMLInputElement) return TEXT_INPUT_TYPES.has(target.type);
  if (target instanceof HTMLTextAreaElement) return true;
  return target instanceof HTMLElement && target.isContentEditable === true;
}

/** 止めるマウスのボタン: 中ボタン（自動スクロール）と、戻る・進む（ボタン 3・4）。 */
const BLOCKED_BUTTONS: ReadonlySet<number> = new Set([1, 3, 4]);

/**
 * 既定の動作を止めるマウスのイベント。ポインターのイベント（pointerdown など）は止めない:
 * 止めると、続く mousedown が発生しなくなり、中ボタンの自動スクロールを止める mousedown のハンドラが働かない。
 */
const MOUSE_EVENTS = ['mousedown', 'mouseup', 'auxclick'] as const;

/**
 * ページの挙動を止めるハンドラを入れる。戻り値は、外す関数。
 * キャプチャ段階で登録するので、ほかのハンドラより先に、既定の動作を止める。
 */
export function installBrowserGuards(doc: Document = document): () => void {
  const registered: Array<[string, EventListener]> = [];
  const on = (type: string, listener: (event: Event) => void) => {
    doc.addEventListener(type, listener, true);
    registered.push([type, listener]);
  };

  // N-3: 入力欄の上のほかでは、ブラウザのメニューを出さない。
  on('contextmenu', (event) => {
    if (!isEditableTarget(event.target)) event.preventDefault();
  });

  // N-9: 中ボタンの自動スクロール、マウスの戻る・進む。
  for (const type of MOUSE_EVENTS) {
    on(type, (event) => {
      if (event instanceof MouseEvent && BLOCKED_BUTTONS.has(event.button)) {
        event.preventDefault();
      }
    });
  }

  // N-8: 引きずって、ページが開かれたり動いたりしない。入力欄の中の文字の引きずりと、そこへのドロップは残す。
  on('dragstart', (event) => {
    if (!isEditableTarget(event.target)) event.preventDefault();
  });
  on('dragover', (event) => {
    if (!isEditableTarget(event.target)) event.preventDefault();
  });
  on('drop', (event) => {
    if (!isEditableTarget(event.target)) event.preventDefault();
  });

  return () => {
    for (const [type, listener] of registered) doc.removeEventListener(type, listener, true);
  };
}

/** 入力欄に付ける属性（N-10）。 */
export const INPUT_ATTRIBUTES: Readonly<Record<string, string>> = {
  spellcheck: 'false',
  autocomplete: 'off',
  autocorrect: 'off',
  autocapitalize: 'off',
};

/** 1 つの要素に、入力欄・画像の属性を付ける（入力欄と画像以外は何もしない）。 */
export function hardenElement(element: Element): void {
  if (element instanceof HTMLInputElement || element instanceof HTMLTextAreaElement) {
    for (const [name, value] of Object.entries(INPUT_ATTRIBUTES)) {
      if (element.getAttribute(name) !== value) element.setAttribute(name, value);
    }
  } else if (element instanceof HTMLImageElement) {
    // 画像は引きずれない（N-8）。
    if (element.getAttribute('draggable') !== 'false') element.setAttribute('draggable', 'false');
  }
}

function hardenTree(node: Element | Document): void {
  if (node instanceof Element) hardenElement(node);
  node.querySelectorAll('input, textarea, img').forEach(hardenElement);
}

/**
 * いまある入力欄と画像に属性を付け、あとから描かれるものにも付ける（MutationObserver）。
 * どの画面の部品が入力欄や画像を作っても、付け忘れない。戻り値は、止める関数。
 */
export function installDomHardening(doc: Document = document): () => void {
  hardenTree(doc);
  const observer = new MutationObserver((records) => {
    for (const record of records) {
      record.addedNodes.forEach((node) => {
        if (node instanceof Element) hardenTree(node);
      });
    }
  });
  observer.observe(doc.documentElement, { childList: true, subtree: true });
  return () => observer.disconnect();
}

/** どちらの窓も、起動時に呼ぶ。戻り値は、すべてを外す関数（テスト用）。 */
export function installNativeBehavior(doc: Document = document): () => void {
  const removeGuards = installBrowserGuards(doc);
  const stopHardening = installDomHardening(doc);
  return () => {
    removeGuards();
    stopHardening();
  };
}
