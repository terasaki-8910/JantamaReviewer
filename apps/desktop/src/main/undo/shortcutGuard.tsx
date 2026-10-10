/**
 * アプリ全体のキー操作（Ctrl+Z・Ctrl+Y・Alt+← / Alt+→ など）を、一時的に止める仕組み。
 * メニューや確認のダイアログが開いている間は、そこに任せて、画面の裏の操作を動かさない。
 *
 * 止めたい部品は `useShortcutBlocker(true)` を呼ぶ。キーを受ける側は、押されたときに `useShortcutsBlocked()` が返す関数で、
 * 止まっていないかを確かめる。
 */
import { createContext, useCallback, useContext, useEffect, useRef, type ReactNode, type RefObject } from 'react';

const GuardContext = createContext<RefObject<number> | null>(null);

export function ShortcutGuardProvider({ children }: { children: ReactNode }) {
  const countRef = useRef(0);
  return <GuardContext.Provider value={countRef}>{children}</GuardContext.Provider>;
}

function useCountRef(): RefObject<number> {
  const countRef = useContext(GuardContext);
  if (countRef === null) throw new Error('ShortcutGuardProvider（UndoProvider）の中で使ってください');
  return countRef;
}

/** `active` の間、アプリのキー操作を止める。 */
export function useShortcutBlocker(active: boolean): void {
  const countRef = useCountRef();
  useEffect(() => {
    if (!active) return undefined;
    countRef.current += 1;
    return () => {
      countRef.current -= 1;
    };
  }, [active, countRef]);
}

/** いまキー操作が止まっているかを答える関数（キーが押されたときに呼ぶ）。 */
export function useShortcutsBlocked(): () => boolean {
  const countRef = useCountRef();
  return useCallback(() => countRef.current > 0, [countRef]);
}
