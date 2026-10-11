/**
 * サイドバーを出す・しまう・引き出しとして開く（U-32、R11-15）。承認済みの見本は、11回目のシートの rail-a。
 *
 * - 640px 以上: サイドバーは出ている。左上のボタン（サイドバーの中・しまったあとは本文の上の帯）で、しまう・出す。
 *   どちらにしたかは、覚える（`shared/sidebarPref.ts`。起動し直しても残る）。キーボードの位置は、押したボタンの替わり（しまったら
 *   帯のボタン、出したらサイドバーの中のボタン）へ移す
 * - 640px 未満: サイドバーは隠れ、本文は左端（16px）から始まる。左上のボタンで、サイドバーを引き出しとして、幕つきで重ねる。
 *   開いている間は、本文は操作できず（inert）、Tab は引き出しの中（と、その上に出る取り消しの通知）だけを回る。項目を選ぶ・Esc・幕を押す・サイドバーの中のボタンで閉じて、
 *   左上のボタンにキーボードの位置を戻す。窓の幅が変わって 640px の境を越えたら、引き出しは閉じる
 * - 検索の重ね表示・削除の確認・画像の大きな表示が開いている間（`suspended`）や、メニューが開いている間は、Esc と Tab はそちらに任せる
 */
import { useCallback, useEffect, useEffectEvent, useRef, useState, type RefObject } from 'react';

import { readSidebarShown, storeSidebarShown } from '../shared/sidebarPref';
import { useShortcutsBlocked } from './undo/shortcutGuard';
import { useNarrow } from './useNarrow';

/** 窓の幅が、引き出しになる境（styles/app.css の `@media (width < 640px)` と同じ）。 */
const NARROW_QUERY = '(width < 640px)';

export interface SidebarControl {
  /** 窓が細い（640px 未満）か。 */
  narrow: boolean;
  /** 広い窓で、サイドバーを出しているか（覚えている選び）。 */
  shown: boolean;
  /** 細い窓で、引き出しが開いているか。 */
  drawerOpen: boolean;
  /** いま、サイドバーが見えているか（広い窓なら出している間、細い窓なら引き出しが開いている間）。 */
  expanded: boolean;
  /** 左上のボタン。 */
  toggle: () => void;
  /** 引き出しを閉じる（開いていなければ何もしない）。`restoreFocus` なら、左上のボタンへキーボードの位置を戻す。 */
  closeDrawer: (restoreFocus: boolean) => void;
  /** 本文の上の帯（細い窓・しまっているとき）の左上のボタン。 */
  topToggleRef: RefObject<HTMLButtonElement | null>;
  /** サイドバーの中の左上のボタン。 */
  sideToggleRef: RefObject<HTMLButtonElement | null>;
  /** サイドバー（引き出しが開いたとき、キーボードの位置を最初に置く所）。 */
  sideRef: RefObject<HTMLElement | null>;
}

type FocusTarget = 'drawer' | 'top' | 'side';

/** Tab で届く物（見えていて、裏の画面でない物）。 */
function focusablesIn(root: HTMLElement): HTMLElement[] {
  const selector = 'a[href], button:not([disabled]), input:not([disabled]), select, textarea, [tabindex]:not([tabindex="-1"])';
  return [...root.querySelectorAll<HTMLElement>(selector)].filter(
    (element) =>
      element.getClientRects().length > 0 && element.closest('[inert]') === null && getComputedStyle(element).visibility !== 'hidden',
  );
}

export function useSidebar({ suspended }: { suspended: boolean }): SidebarControl {
  const narrow = useNarrow();
  const [shown, setShown] = useState(readSidebarShown);
  const [drawer, setDrawer] = useState(false);
  const blocked = useShortcutsBlocked();
  const topToggleRef = useRef<HTMLButtonElement>(null);
  const sideToggleRef = useRef<HTMLButtonElement>(null);
  const sideRef = useRef<HTMLElement>(null);
  const pendingFocus = useRef<FocusTarget | null>(null);
  const drawerOpen = narrow && drawer;
  const expanded = narrow ? drawerOpen : shown;

  // 窓の幅が境を越えたら、引き出しは閉じる（広がって出ているサイドバーと、開いた引き出しが、混ざらないように）
  useEffect(() => {
    const query = window.matchMedia(NARROW_QUERY);
    const onChange = () => setDrawer(false);
    query.addEventListener('change', onChange);
    return () => query.removeEventListener('change', onChange);
  }, []);

  // 状態が変わって描き直したあとに、キーボードの位置を移す（ボタンが現れる・裏の画面が操作できるようになるのは、描き直しのあと）
  useEffect(() => {
    const target = pendingFocus.current;
    if (target === null) return;
    pendingFocus.current = null;
    const element = target === 'drawer' ? sideRef.current : target === 'top' ? topToggleRef.current : sideToggleRef.current;
    element?.focus({ preventScroll: true });
  }, [shown, drawer, narrow]);

  const toggle = useCallback(() => {
    if (narrow) {
      pendingFocus.current = drawer ? 'top' : 'drawer';
      setDrawer(!drawer);
      return;
    }
    const next = !shown;
    storeSidebarShown(next);
    pendingFocus.current = next ? 'side' : 'top';
    setShown(next);
  }, [narrow, drawer, shown]);

  const closeDrawer = useCallback(
    (restoreFocus: boolean) => {
      if (!(narrow && drawer)) return;
      pendingFocus.current = restoreFocus ? 'top' : null;
      setDrawer(false);
    },
    [narrow, drawer],
  );

  // 引き出しが開いている間、ページはスクロールしない
  useEffect(() => {
    if (!drawerOpen) return undefined;
    const before = document.body.style.overflow;
    document.body.style.overflow = 'hidden';
    return () => {
      document.body.style.overflow = before;
    };
  }, [drawerOpen]);

  // Esc で閉じる。メニュー・ダイアログ・検索の重ね表示が先に受けたもの（defaultPrevented）や、それらが開いている間は、触らない
  const onEscape = useEffectEvent((event: KeyboardEvent) => {
    if (!drawerOpen || suspended || blocked()) return;
    if (event.key !== 'Escape' || event.defaultPrevented || event.isComposing) return;
    event.preventDefault();
    closeDrawer(true);
  });

  // Tab は、引き出しの中だけを回る（引き出しの上に出る取り消しの通知は、いっしょに回る。消したあとの「元に戻す」に届くように）。
  // 引き出しの外（検索の重ね表示など）にキーボードの位置があるときは、そちらに任せる
  const onTab = useEffectEvent((event: KeyboardEvent) => {
    const side = sideRef.current;
    if (!drawerOpen || suspended || blocked() || event.key !== 'Tab' || side === null) return;
    const toast = document.querySelector<HTMLElement>('.toast');
    const active = document.activeElement;
    const inScope = (element: Element) => side.contains(element) || (toast !== null && toast.contains(element));
    const outside = active !== null && active !== document.body && !inScope(active);
    if (outside) return;
    const items = [...focusablesIn(side), ...(toast === null ? [] : focusablesIn(toast))];
    const first = items[0];
    const last = items[items.length - 1];
    if (first === undefined || last === undefined) {
      event.preventDefault();
      return;
    }
    const at = active instanceof HTMLElement ? items.indexOf(active) : -1;
    if (at < 0) {
      event.preventDefault();
      (event.shiftKey ? last : first).focus();
    } else if (event.shiftKey && at === 0) {
      event.preventDefault();
      last.focus();
    } else if (!event.shiftKey && at === items.length - 1) {
      event.preventDefault();
      first.focus();
    }
  });

  useEffect(() => {
    const escape = (event: KeyboardEvent) => onEscape(event);
    const tab = (event: KeyboardEvent) => onTab(event);
    document.addEventListener('keydown', escape);
    document.addEventListener('keydown', tab, true);
    return () => {
      document.removeEventListener('keydown', escape);
      document.removeEventListener('keydown', tab, true);
    };
  }, []);

  return { narrow, shown, drawerOpen, expanded, toggle, closeDrawer, topToggleRef, sideToggleRef, sideRef };
}
