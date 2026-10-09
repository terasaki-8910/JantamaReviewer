import { invoke } from '@tauri-apps/api/core';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import {
  hardenElement,
  INPUT_ATTRIBUTES,
  installBrowserGuards,
  installDomHardening,
  installNativeBehavior,
  isEditableTarget,
} from './nativeBehavior';

vi.mock('@tauri-apps/api/core', () => ({ invoke: vi.fn(async () => undefined), convertFileSrc: (p: string) => p }));

/** イベントを送り、既定の動作が止められなかったか（止められていなければ true）を返す。 */
function fire(target: EventTarget, type: string, init: MouseEventInit = {}): boolean {
  return target.dispatchEvent(new MouseEvent(type, { bubbles: true, cancelable: true, ...init }));
}

function element<K extends keyof HTMLElementTagNameMap>(tag: K): HTMLElementTagNameMap[K] {
  const el = document.createElement(tag);
  document.body.appendChild(el);
  return el;
}

function input(type: string): HTMLInputElement {
  const el = element('input');
  el.type = type;
  return el;
}

/** MutationObserver の通知（マイクロタスク）を待つ。 */
async function settled(): Promise<void> {
  await new Promise<void>((resolve) => queueMicrotask(resolve));
  await new Promise<void>((resolve) => setTimeout(resolve, 0));
}

let dispose: (() => void) | null = null;

beforeEach(() => {
  document.body.innerHTML = '';
  vi.mocked(invoke).mockClear();
});

afterEach(() => {
  dispose?.();
  dispose = null;
  document.body.innerHTML = '';
});

describe('N-3: ブラウザの右クリックのメニュー', () => {
  it('入力欄の上のほかでは、メニューを出さない（既定の動作を止める）', () => {
    dispose = installBrowserGuards();
    const targets: HTMLElement[] = [
      element('div'),
      element('p'),
      element('button'),
      element('img'),
      element('a'),
      input('radio'),
      input('checkbox'),
      input('button'),
      input('range'),
      document.body,
    ];
    for (const target of targets) {
      expect(fire(target, 'contextmenu', { button: 2 }), target.tagName).toBe(false);
    }
  });

  it('文字を打ち込む欄の上では、メニューを残す（切り取り・コピー・貼り付け・すべて選択のため）', () => {
    dispose = installBrowserGuards();
    for (const type of ['text', 'search', 'url', 'tel', 'email', 'password', 'number']) {
      expect(fire(input(type), 'contextmenu', { button: 2 }), type).toBe(true);
    }
    expect(fire(element('textarea'), 'contextmenu', { button: 2 })).toBe(true);
  });

  it('isEditableTarget: 文字を打ち込む欄だけが true', () => {
    expect(isEditableTarget(input('text'))).toBe(true);
    expect(isEditableTarget(element('textarea'))).toBe(true);
    expect(isEditableTarget(input('radio'))).toBe(false);
    expect(isEditableTarget(input('checkbox'))).toBe(false);
    expect(isEditableTarget(element('button'))).toBe(false);
    expect(isEditableTarget(element('div'))).toBe(false);
    expect(isEditableTarget(null)).toBe(false);
    expect(isEditableTarget(window)).toBe(false);
  });

  it('外すと、止めなくなる', () => {
    const remove = installBrowserGuards();
    const div = element('div');
    expect(fire(div, 'contextmenu', { button: 2 })).toBe(false);
    remove();
    expect(fire(div, 'contextmenu', { button: 2 })).toBe(true);
  });

  it('ほかのハンドラが後から自分のメニューを出せる（既定の動作を止めるだけで、伝わりは止めない）', () => {
    dispose = installBrowserGuards();
    const div = element('div');
    let reached = 0;
    const count = () => {
      reached += 1;
    };
    document.addEventListener('contextmenu', count);
    fire(div, 'contextmenu', { button: 2 });
    document.removeEventListener('contextmenu', count);
    expect(reached).toBe(1);
  });
});

describe('N-9: 中ボタンの自動スクロールと、マウスの戻る・進む', () => {
  it('中ボタンの mousedown は止める（自動スクロールを始めさせない）。auxclick も', () => {
    dispose = installBrowserGuards();
    const div = element('div');
    expect(fire(div, 'mousedown', { button: 1 })).toBe(false);
    expect(fire(div, 'mouseup', { button: 1 })).toBe(false);
    expect(fire(div, 'auxclick', { button: 1 })).toBe(false);
  });

  it('戻る・進む（ボタン 3・4）の mouseup は止める（ページを戻らせない）。そのほかの押し下げも', () => {
    dispose = installBrowserGuards();
    const div = element('div');
    for (const button of [3, 4]) {
      expect(fire(div, 'mouseup', { button }), `mouseup ${button}`).toBe(false);
      expect(fire(div, 'mousedown', { button }), `mousedown ${button}`).toBe(false);
      expect(fire(div, 'auxclick', { button }), `auxclick ${button}`).toBe(false);
    }
  });

  it('左・右のボタンは止めない（ふつうの操作を邪魔しない）', () => {
    dispose = installBrowserGuards();
    const button = element('button');
    for (const type of ['mousedown', 'mouseup']) {
      expect(fire(button, type, { button: 0 }), `${type} 左`).toBe(true);
      expect(fire(button, type, { button: 2 }), `${type} 右`).toBe(true);
    }
    expect(fire(button, 'click', { button: 0 })).toBe(true);
  });

  it('ポインターのイベントは止めない（止めると、続く mousedown が来なくなり、上の止め方が働かない）', () => {
    dispose = installBrowserGuards();
    const div = element('div');
    for (const button of [0, 1, 2, 3, 4]) {
      for (const type of ['pointerdown', 'pointerup']) {
        expect(fire(div, type, { button }), `${type} ${button}`).toBe(true);
      }
    }
  });
});

describe('N-8: 引きずり', () => {
  it('引きずり（dragstart）と、ドロップの受け入れ（dragover・drop）を止める。ファイルを開かない', () => {
    dispose = installBrowserGuards();
    for (const target of [element('img'), element('div'), element('a'), document.body]) {
      for (const type of ['dragstart', 'dragover', 'drop']) {
        expect(fire(target, type), `${target.tagName} ${type}`).toBe(false);
      }
    }
  });

  it('入力欄の中の文字の引きずりと、そこへのドロップは、止めない', () => {
    dispose = installBrowserGuards();
    for (const field of [element('textarea'), input('text')]) {
      for (const type of ['dragstart', 'dragover', 'drop']) {
        expect(fire(field, type), `${field.tagName} ${type}`).toBe(true);
      }
    }
  });
});

describe('N-10: 入力欄の属性と、N-8: 画像の属性', () => {
  it('属性の一覧: スペルチェック・自動入力・自動補正・自動大文字化を切る', () => {
    expect(INPUT_ATTRIBUTES).toEqual({
      spellcheck: 'false',
      autocomplete: 'off',
      autocorrect: 'off',
      autocapitalize: 'off',
    });
  });

  it('いまある入力欄（input・textarea。種類を問わない）と画像に、属性が付く', () => {
    const fields = [input('text'), input('radio'), input('checkbox'), element('textarea')];
    const image = element('img');
    dispose = installDomHardening();
    for (const field of fields) {
      for (const [name, value] of Object.entries(INPUT_ATTRIBUTES)) {
        expect(field.getAttribute(name), `${field.tagName} ${name}`).toBe(value);
      }
    }
    expect(image.getAttribute('draggable')).toBe('false');
  });

  it('あとから描かれた入力欄・画像にも付く（入れ子の中でも）', async () => {
    dispose = installDomHardening();
    const wrapper = document.createElement('section');
    wrapper.innerHTML = '<div><label><input type="text"></label><textarea></textarea><img alt="x"></div>';
    document.body.appendChild(wrapper);
    await settled();
    for (const field of wrapper.querySelectorAll('input, textarea')) {
      for (const [name, value] of Object.entries(INPUT_ATTRIBUTES)) {
        expect(field.getAttribute(name), `${field.tagName} ${name}`).toBe(value);
      }
    }
    expect(wrapper.querySelector('img')?.getAttribute('draggable')).toBe('false');

    // 入力欄そのものを足した場合も。
    const late = input('search');
    await settled();
    expect(late.getAttribute('autocomplete')).toBe('off');
    expect(late.getAttribute('spellcheck')).toBe('false');
  });

  it('止めると、あとから足したものには付かない', async () => {
    const stop = installDomHardening();
    stop();
    const late = input('text');
    await settled();
    expect(late.hasAttribute('autocomplete')).toBe(false);
  });

  it('hardenElement: 入力欄・画像以外には何もしない', () => {
    const div = element('div');
    hardenElement(div);
    expect(div.attributes).toHaveLength(0);
    const button = element('button');
    hardenElement(button);
    expect(button.hasAttribute('draggable')).toBe(false);
  });
});

describe('N-12: 開発者ツールは、開発（tauri dev）のときだけ F12 と Ctrl+Shift+I で開く', () => {
  function press(target: EventTarget, init: KeyboardEventInit): boolean {
    return target.dispatchEvent(new KeyboardEvent('keydown', { bubbles: true, cancelable: true, ...init }));
  }

  it('devtools が有効なとき: F12 でも Ctrl+Shift+I でも open_devtools を呼び、ブラウザの既定の動作は止める', () => {
    dispose = installBrowserGuards(document, { devtools: true });
    expect(press(document.body, { key: 'F12', code: 'F12' })).toBe(false);
    expect(press(document.body, { key: 'I', code: 'KeyI', ctrlKey: true, shiftKey: true })).toBe(false);
    const calls = vi.mocked(invoke).mock.calls.filter(([cmd]) => cmd === 'open_devtools');
    expect(calls).toHaveLength(2);
  });

  it('devtools が有効でも、ほかのキーでは呼ばない（Ctrl+I・Shift+I・F11 など）', () => {
    dispose = installBrowserGuards(document, { devtools: true });
    expect(press(document.body, { key: 'i', code: 'KeyI', ctrlKey: true })).toBe(true);
    expect(press(document.body, { key: 'I', code: 'KeyI', shiftKey: true })).toBe(true);
    expect(press(document.body, { key: 'F11', code: 'F11' })).toBe(true);
    expect(vi.mocked(invoke)).not.toHaveBeenCalled();
  });

  it('devtools が無効なとき（製品）: 何もしない（呼ばず、止めもしない）', () => {
    dispose = installBrowserGuards(document, { devtools: false });
    expect(press(document.body, { key: 'F12', code: 'F12' })).toBe(true);
    expect(press(document.body, { key: 'I', code: 'KeyI', ctrlKey: true, shiftKey: true })).toBe(true);
    expect(vi.mocked(invoke)).not.toHaveBeenCalled();
  });

  it('既定は、開発のとき（Vite の開発サーバー）だけ有効: import.meta.env.DEV に従う', () => {
    dispose = installBrowserGuards(document);
    press(document.body, { key: 'F12', code: 'F12' });
    const called = vi.mocked(invoke).mock.calls.some(([cmd]) => cmd === 'open_devtools');
    expect(called).toBe(import.meta.env.DEV);
  });
});

describe('installNativeBehavior', () => {
  it('ハンドラと属性の付与の両方を入れ、戻り値で両方を外す', async () => {
    const remove = installNativeBehavior();
    const field = input('text');
    const div = element('div');
    await settled();
    expect(field.getAttribute('spellcheck')).toBe('false');
    expect(fire(div, 'contextmenu', { button: 2 })).toBe(false);

    remove();
    const lateField = input('text');
    await settled();
    expect(lateField.hasAttribute('spellcheck')).toBe(false);
    expect(fire(div, 'contextmenu', { button: 2 })).toBe(true);
  });
});
