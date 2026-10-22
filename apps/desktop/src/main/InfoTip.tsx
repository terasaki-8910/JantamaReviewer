/**
 * 説明のアイコン（U-25、R11-1）。操作の説明の文（「行を押すと…」「場面を押すと…」）を、本文に出さずに、
 * 欄の見出しのそばの (i) のアイコンにして、マウスを乗せるかキーボードで選ぶと、重ねて出す。
 *
 * - アイコンは、名前（`label`）のあるボタン。説明の文は、アイコンの読み上げの説明（aria-describedby）にもなる。
 *   `id` を渡せば、ほかの物（説明したい行など）も、同じ文を読み上げの説明にできる
 * - マウスを乗せると出て（離すと、少し待って閉じる。重なりの中へマウスが渡れる）、キーボードで選ぶと出る（外れると閉じる）。
 *   押す（Enter・Space）と出したままにする（もう一度押すと閉じる。タッチでも、これで開く）。Esc で閉じる
 * - 重なりは、説明している物にかからないように、アイコンの上に出す。上に入らないときだけ下に出す。窓の中に収める（幅 390px でも）。
 *   スクロールと窓の大きさの変化では、置き直す（アイコンが窓の外へ出たら閉じる）
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
  /** 重なりに足す class（中身が文でなく、並べた部品のとき。例: 盤面の見方）。 */
  popClassName?: string;
}

/**
 * 重なりを出す部品の土台（アイコンの `InfoTip` と、符の数の `FuTip` が使う）。出し方・置き方・閉じ方は、上に書いたとおりで、
 * 出す元（ボタン）の見た目と中身だけが違う。
 */
export interface TipProps {
  /** 重なりの中身。 */
  children: ReactNode;
  /** 重なりの id。ほかの物の aria-describedby から指すとき。無ければ、自動。 */
  id?: string;
  /** 出す元のボタンの class。 */
  triggerClassName: string;
  /** 出す元のボタンの名前（aria-label）。ボタンの中の文字が名前になるなら、渡さない。 */
  triggerLabel?: string;
  /** 出す元のボタンの中身。 */
  triggerContent: ReactNode;
  /** ボタンを包む要素の class。 */
  wrapperClassName?: string;
  /** 重なりに足す class。 */
  popClassName?: string;
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

export function InfoTip({ label, children, id, popClassName }: InfoTipProps) {
  return (
    <Tip
      id={id}
      wrapperClassName="infotip"
      triggerClassName="infotip-btn"
      triggerLabel={label}
      triggerContent={<Icon name="info" />}
      popClassName={popClassName}
    >
      {children}
    </Tip>
  );
}

export function Tip({ children, id, triggerClassName, triggerLabel, triggerContent, wrapperClassName, popClassName }: TipProps) {
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

  // アイコンの上に置く。上に入らなければ下。窓の中に収める。アイコンが窓の外へ出ていれば、置かずに false を返す
  const place = useCallback((): boolean => {
    const tip = tipRef.current;
    const button = buttonRef.current;
    if (tip === null || button === null) return false;
    const rect = button.getBoundingClientRect();
    if (rect.bottom < 0 || rect.top > window.innerHeight || rect.right < 0 || rect.left > window.innerWidth) return false;
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
    return true;
  }, []);

  // 開いたとき、描く前に置く
  useLayoutEffect(() => {
    if (open) place();
  }, [open, place]);

  // Esc で閉じる。出ている間のスクロールと窓の大きさの変化では、置き直す（アイコンが窓の外へ出たら閉じる）。
  // キーボードで選んだとき、ブラウザがアイコンを見える所へ動かすスクロールが、開いたあとに起きる。そこで閉じてはいけない
  useEffect(() => {
    if (!open) return undefined;
    const onKeyDown = (event: KeyboardEvent) => {
      if (event.key !== 'Escape' || event.isComposing) return;
      event.preventDefault();
      event.stopPropagation();
      close();
    };
    const follow = (event?: Event) => {
      if (event?.target instanceof Node && tipRef.current?.contains(event.target)) return;
      if (!place()) close();
    };
    document.addEventListener('keydown', onKeyDown, true);
    document.addEventListener('scroll', follow, true);
    window.addEventListener('resize', follow);
    return () => {
      document.removeEventListener('keydown', onKeyDown, true);
      document.removeEventListener('scroll', follow, true);
      window.removeEventListener('resize', follow);
    };
  }, [open, close, place]);

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
    <span className={wrapperClassName}>
      <button
        type="button"
        className={triggerClassName}
        ref={buttonRef}
        aria-label={triggerLabel}
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
        {triggerContent}
      </button>
      {createPortal(
        <span
          className={popClassName === undefined ? 'infotip-pop' : `infotip-pop ${popClassName}`}
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
