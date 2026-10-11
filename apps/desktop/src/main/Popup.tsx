import { useEffect, useEffectEvent, useLayoutEffect, useRef, type ReactNode } from 'react';

import { Icon } from './Icon';
import { useShortcutBlocker } from './undo/shortcutGuard';

/**
 * 小さなメニュー（行の「…」・段階の絞り込み、そして半荘のページの、局面を手で選ぶ・自分の評価・MAKA の段階。最後の 3 つは
 * `MenuSelect` が使う）。WAI-ARIA の menu button の形:
 * 開くと最初の項目（選んである項目があればそれ）にキーボードの位置が移り、↑ ↓ Home End で動き、Esc で閉じて、
 * キーボードの位置を開いたボタンに戻す。Tab でも閉じる（ボタンに戻してから、ふつうの Tab に任せる）。
 * 外を押す・窓の大きさが変わる・どこかがスクロールすると、キーボードの位置は動かさずに閉じる。
 * 開いている間は、アプリのキー操作（Ctrl+Z・Alt+← など）を止める。
 */

export type PopupItem =
  | { kind: 'item'; key: string; label: string; onSelect: () => void }
  | {
      kind: 'radio';
      key: string;
      label: string;
      hint?: string;
      /** 文字の前に置く図（〇△✕の形など）。図だけで意味が伝わるときは、`hideLabel` で文字を読み上げだけにする。 */
      icon?: ReactNode;
      hideLabel?: boolean;
      checked: boolean;
      onSelect: () => void;
    }
  | {
      /** 押しても閉じないチェックの項目（いくつでも選べるメニュー。検討ログの絞り込み）。 */
      kind: 'check';
      key: string;
      label: string;
      hint?: string;
      checked: boolean;
      onSelect: () => void;
    }
  | { kind: 'separator'; key: string };

/**
 * メニューを出す場所。
 * `below`: 開いたボタンの下に、右端をそろえて出す（下に入らなければ上）。ふつうの「…」や、段階のボタン。
 * `start`: 開いたボタンの下に、左端をそろえて出す（下に入らなければ上）。左から並べたボタンの下に出すとき（検討ログの絞り込み）。
 */
export type PopupPlacement = 'below' | 'start';

interface PopupProps {
  /** メニューの名前（読み上げ用）。 */
  label: string;
  items: readonly PopupItem[];
  /** メニューを開いたボタン。この近くに出す。閉じるときの、キーボードの位置の戻り先。画面に出ている物でなければならない。 */
  anchor: HTMLElement;
  /** 既定は `below`。 */
  placement?: PopupPlacement;
  /** 閉じた。項目を選んだときは、先にこれを呼んでから、項目の `onSelect` を呼ぶ。 */
  onClose: () => void;
}

export function Popup({ label, items, anchor, placement = 'below', onClose }: PopupProps) {
  const popRef = useRef<HTMLDivElement>(null);
  useShortcutBlocker(true);

  // 開いたボタンのそばに置く。窓の中に収める。描く前に決める。
  useLayoutEffect(() => {
    const pop = popRef.current;
    if (pop === null) return;
    const rect = anchor.getBoundingClientRect();
    const width = pop.offsetWidth;
    const height = pop.offsetHeight;
    const viewWidth = document.documentElement.clientWidth;
    const viewHeight = document.documentElement.clientHeight;
    // 開いたボタンの下に、右端（`start` なら左端）をそろえて出す（下に入らなければ上）
    const left = Math.max(8, Math.min(placement === 'start' ? rect.left : rect.right - width, viewWidth - width - 8));
    let top = rect.bottom + 4;
    if (top + height > viewHeight - 8) top = Math.max(8, rect.top - height - 4);
    pop.style.left = `${left}px`;
    pop.style.top = `${top}px`;
  }, [anchor, placement]);

  // 最初の項目（選んである項目があれば、それ）に、キーボードの位置を移す。
  useEffect(() => {
    const buttons = Array.from(popRef.current?.querySelectorAll<HTMLButtonElement>('.pi') ?? []);
    const first = buttons.find((b) => b.getAttribute('aria-checked') === 'true') ?? buttons[0];
    first?.focus({ preventScroll: true });
  }, []);

  // 閉じる。`returnFocus` なら、キーボードの位置を開いたボタンに戻してから閉じる（Tab のとき、ボタンの次へ進めるため）。
  const close = useEffectEvent((returnFocus: boolean) => {
    if (returnFocus && anchor.isConnected) anchor.focus();
    onClose();
  });

  useEffect(() => {
    const onMouseDown = (event: MouseEvent) => {
      const target = event.target;
      if (!(target instanceof Node)) return;
      if (popRef.current?.contains(target) || anchor.contains(target)) return;
      close(false);
    };
    const onKeyDown = (event: KeyboardEvent) => {
      const buttons = Array.from(popRef.current?.querySelectorAll<HTMLButtonElement>('.pi') ?? []);
      const at = buttons.indexOf(document.activeElement as HTMLButtonElement);
      const move = (to: number) => {
        event.preventDefault();
        buttons[(to + buttons.length) % buttons.length]?.focus({ preventScroll: true });
      };
      if (event.key === 'Escape') {
        event.preventDefault();
        event.stopPropagation();
        close(true);
      } else if (event.key === 'ArrowDown') move(at + 1);
      else if (event.key === 'ArrowUp') move(at < 0 ? -1 : at - 1);
      else if (event.key === 'Home') move(0);
      else if (event.key === 'End') move(buttons.length - 1);
      else if (event.key === 'Tab') close(true);
    };
    const onScrollOrResize = (event: Event) => {
      // メニューの中のスクロールでは閉じない。
      if (event.target instanceof Node && popRef.current?.contains(event.target)) return;
      close(false);
    };
    document.addEventListener('mousedown', onMouseDown, true);
    document.addEventListener('keydown', onKeyDown, true);
    document.addEventListener('scroll', onScrollOrResize, true);
    window.addEventListener('resize', onScrollOrResize);
    return () => {
      document.removeEventListener('mousedown', onMouseDown, true);
      document.removeEventListener('keydown', onKeyDown, true);
      document.removeEventListener('scroll', onScrollOrResize, true);
      window.removeEventListener('resize', onScrollOrResize);
    };
  }, [anchor]);

  return (
    <div className="pop" role="menu" aria-label={label} ref={popRef}>
      {items.map((item) => {
        if (item.kind === 'separator') return <div key={item.key} className="psep" role="separator" />;
        const select = () => {
          onClose();
          item.onSelect();
        };
        if (item.kind === 'check') {
          // 押しても閉じない（続けて選べる）。選んだ印は、呼ぶ側が描き直した項目の `checked` で変わる
          return (
            <button
              key={item.key}
              type="button"
              className="pi"
              role="menuitemcheckbox"
              aria-checked={item.checked}
              tabIndex={-1}
              onClick={item.onSelect}
            >
              <span className="tick">
                <Icon name="check" />
              </span>
              <span>{item.label}</span>
              {item.hint !== undefined && <span className="pi-r">{item.hint}</span>}
            </button>
          );
        }
        return item.kind === 'radio' ? (
          <button
            key={item.key}
            type="button"
            className="pi"
            role="menuitemradio"
            aria-checked={item.checked}
            tabIndex={-1}
            onClick={select}
          >
            <span className="tick">
              <Icon name="check" />
            </span>
            {item.icon !== undefined && (
              <span className="pi-icon" aria-hidden="true">
                {item.icon}
              </span>
            )}
            <span className={item.hideLabel ? 'sr-only' : undefined}>{item.label}</span>
            {item.hint !== undefined && <span className="pi-r">{item.hint}</span>}
          </button>
        ) : (
          <button
            key={item.key}
            type="button"
            className="pi plain"
            role="menuitem"
            tabIndex={-1}
            onClick={select}
          >
            {item.label}
          </button>
        );
      })}
    </div>
  );
}
