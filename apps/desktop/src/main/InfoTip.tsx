/**
 * 説明のアイコン（U-25、R11-1）。操作の説明の文（「行を押すと…」「場面を押すと…」）を、本文に出さずに、
 * 欄の見出しのそばの (i) のアイコンにして、マウスを乗せるかキーボードで選ぶと、重ねて出す。
 *
 * - アイコンは、名前（`label`）のあるボタン。説明の文は、アイコンの読み上げの説明（aria-describedby）にもなる。
 *   `id` を渡せば、ほかの物（説明したい行など）も、同じ文を読み上げの説明にできる
 * - マウスを乗せると出て（離すと、少し待って閉じる。重なりの中へマウスが渡れる）、キーボードで選ぶと出る（外れると閉じる）。
 *   押す（Enter・Space）と出したままにする（もう一度押すと閉じる。タッチでも、これで開く）。Esc で閉じる
 * - 重なりは、説明している物にかからないように、アイコンの上に出す。上に入らないときだけ下に出す。窓の中に収める（幅 390px でも）。
 *   スクロールと窓の大きさの変化では、置き場所がずれるので、閉じる
 * - 重なりは、body の下に描く（欄の中に置くと、`container-type` の入った本文の中では、窓ではなく本文が位置の基準になるため）
 *
 * 色は、トークンだけ（styles/app.css の `.infotip-*`）。
 */
import { useCallback, useEffect, useId, useLayoutEffect, useRef, useState, type ReactNode } from 'react';
import { createPortal } from 'react-dom';

import { Icon } from './Icon';

interface InfoTipProps {
  /** アイコンの名前（読み上げ用）。例: 「受け入れ枚数の操作の説明」。 */
  label: string;
  /** 説明の文。 */
  children: ReactNode;
  /** 説明の文の id。ほかの物の aria-describedby から指すとき。無ければ、自動。 */
  id?: string;
}

type Mode = 'closed' | 'peek' | 'pinned';

/** マウスを離してから閉じるまでの、猶予（ミリ秒）。アイコンと重なりの間を、マウスが渡れるように。 */
const LEAVE_MS = 220;
/** アイコンと重なりの間（px）。 */
const GAP = 6;
/** 窓の端からあける余白（px）。 */
const EDGE = 8;

/** キーボードの操作で位置が来たか（マウスで押して位置が来たのではないか）。判定できない環境では、来たものとして出す。 */
function focusVisible(element: HTMLElement): boolean {
  try {
    return element.matches(':focus-visible');
  } catch {
    return true;
  }
}

export function InfoTip({ label, children, id }: InfoTipProps) {
  const autoId = useId();
  const tipId = id ?? autoId;
  const [mode, setMode] = useState<Mode>('closed');
  const buttonRef = useRef<HTMLButtonElement>(null);
  const tipRef = useRef<HTMLSpanElement>(null);
  const leaveTimer = useRef<number | null>(null);
  const open = mode !== 'closed';

  const clearLeaveTimer = useCallback(() => {
    if (leaveTimer.current !== null) {
      window.clearTimeout(leaveTimer.current);
      leaveTimer.current = null;
    }
  }, []);

  useEffect(() => clearLeaveTimer, [clearLeaveTimer]);

  const close = useCallback(() => {
    clearLeaveTimer();
    setMode('closed');
  }, [clearLeaveTimer]);

  // アイコンの上に置く。上に入らなければ下。窓の中に収める（描く前に決める）
  useLayoutEffect(() => {
    const tip = tipRef.current;
    const button = buttonRef.current;
    if (!open || tip === null || button === null) return;
    const rect = button.getBoundingClientRect();
    const viewWidth = document.documentElement.clientWidth;
    const viewHeight = document.documentElement.clientHeight;
    const width = tip.offsetWidth;
    const height = tip.offsetHeight;
    const left = Math.max(EDGE, Math.min(rect.left + rect.width / 2 - width / 2, viewWidth - width - EDGE));
    let top = rect.top - height - GAP;
    let side: 'above' | 'below' = 'above';
    if (top < EDGE) {
      top = Math.min(rect.bottom + GAP, Math.max(EDGE, viewHeight - height - EDGE));
      side = 'below';
    }
    tip.style.left = `${left}px`;
    tip.style.top = `${top}px`;
    tip.dataset.side = side;
  }, [open]);

  // Esc で閉じる。出ている間のスクロールと窓の大きさの変化でも閉じる（位置がずれるため）
  useEffect(() => {
    if (!open) return undefined;
    const onKeyDown = (event: KeyboardEvent) => {
      if (event.key !== 'Escape' || event.isComposing) return;
      event.preventDefault();
      event.stopPropagation();
      close();
    };
    const onScroll = (event: Event) => {
      if (event.target instanceof Node && tipRef.current?.contains(event.target)) return;
      close();
    };
    document.addEventListener('keydown', onKeyDown, true);
    document.addEventListener('scroll', onScroll, true);
    window.addEventListener('resize', close);
    return () => {
      document.removeEventListener('keydown', onKeyDown, true);
      document.removeEventListener('scroll', onScroll, true);
      window.removeEventListener('resize', close);
    };
  }, [open, close]);

  // 押して出したものは、アイコンの外を押すと閉じる
  useEffect(() => {
    if (mode !== 'pinned') return undefined;
    const onPointerDown = (event: globalThis.PointerEvent) => {
      const target = event.target;
      if (target instanceof Node && (buttonRef.current?.contains(target) || tipRef.current?.contains(target))) return;
      close();
    };
    document.addEventListener('pointerdown', onPointerDown, true);
    return () => document.removeEventListener('pointerdown', onPointerDown, true);
  }, [mode, close]);

  const onEnter = useCallback(
    (event: { pointerType: string }) => {
      if (event.pointerType === 'touch') return;
      clearLeaveTimer();
      setMode((current) => (current === 'closed' ? 'peek' : current));
    },
    [clearLeaveTimer],
  );

  // マウスを離したら閉じる（押して出したものは、そのまま）
  const onLeave = useCallback(
    (event: { pointerType: string }) => {
      if (event.pointerType === 'touch') return;
      clearLeaveTimer();
      leaveTimer.current = window.setTimeout(() => {
        leaveTimer.current = null;
        setMode((current) => (current === 'peek' ? 'closed' : current));
      }, LEAVE_MS);
    },
    [clearLeaveTimer],
  );

  // 重なりの上のマウスの動き。重なりは、説明の文を持つだけの要素（操作の部品ではない）なので、JSX の属性ではなく、ここで付ける。
  // 重なりを押しても、位置がアイコンから外れて閉じることがないように、押した位置合わせ（mousedown の既定の動き）は止める。
  useEffect(() => {
    const tip = tipRef.current;
    if (tip === null) return undefined;
    const keepFocus = (event: MouseEvent) => event.preventDefault();
    tip.addEventListener('pointerenter', onEnter);
    tip.addEventListener('pointerleave', onLeave);
    tip.addEventListener('mousedown', keepFocus);
    return () => {
      tip.removeEventListener('pointerenter', onEnter);
      tip.removeEventListener('pointerleave', onLeave);
      tip.removeEventListener('mousedown', keepFocus);
    };
  }, [onEnter, onLeave]);

  return (
    <span className="infotip">
      <button
        type="button"
        className="infotip-btn"
        ref={buttonRef}
        aria-label={label}
        aria-describedby={tipId}
        data-open={open ? '1' : undefined}
        onPointerEnter={onEnter}
        onPointerLeave={onLeave}
        onFocus={(event) => {
          // キーボードで選んだとき（マウスで押したときの位置合わせではなく）出す
          if (focusVisible(event.currentTarget)) setMode((current) => (current === 'closed' ? 'peek' : current));
        }}
        onBlur={close}
        onClick={() => {
          clearLeaveTimer();
          setMode((current) => (current === 'pinned' ? 'closed' : 'pinned'));
        }}
      >
        <Icon name="info" />
      </button>
      {createPortal(
        <span
          className="infotip-pop"
          id={tipId}
          ref={tipRef}
          role="tooltip"
          hidden={!open}
        >
          {children}
        </span>,
        document.body,
      )}
    </span>
  );
}
