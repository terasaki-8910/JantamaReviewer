/**
 * 検索の重ね表示を、開く・閉じる状態と、Ctrl+K（U-22）。
 *
 * - 開く: 検索のアイコンを押す（`show(アイコン)`）か、Ctrl+K。メニューや確認のダイアログが開いている間の Ctrl+K は、何もしない
 * - 閉じる: Esc・背景の押下・「Esc」の印・Ctrl+K（もう一度）。開いたときにキーボードの位置があった所へ戻す。
 *   位置が無かった（何も選んでいなかった）ときや、その物が消えていたときは、検索のアイコンへ戻す
 * - 結果を開いて閉じたとき（`hide(true)`）は、元の位置へ戻さない: 開いた画面が、自分で位置を決める（出題は手牌へ）。
 *   どこにも位置が無ければ、その画面の見出しへ、見出しに位置を置けない画面は、開いた所へ戻す
 */
import { useCallback, useEffect, useEffectEvent, useRef, useState } from 'react';

import { useShortcutsBlocked } from '../undo/shortcutGuard';

/** 検索のアイコン（サイドバーの見出しか、本文の上の帯）。戻し先が無いときに、いま見えている（操作できる）ほうを探す。 */
function visibleSearchButton(): HTMLElement | null {
  return [...document.querySelectorAll<HTMLElement>('.search-btn')].find((button) => button.closest('[inert]') === null) ?? null;
}

export interface SearchOverlayControl {
  open: boolean;
  /** 開く。`opener` は、閉じたときにキーボードの位置を戻す先（無ければ、検索のアイコン）。 */
  show: (opener?: HTMLElement | null) => void;
  /** 閉じる。`opened` は、結果を開いて閉じたとき。 */
  hide: (opened: boolean) => void;
}

export function useSearchOverlay(): SearchOverlayControl {
  const [open, setOpen] = useState(false);
  const opener = useRef<HTMLElement | null>(null);
  const afterClose = useRef<'opener' | 'content' | null>(null);
  const blocked = useShortcutsBlocked();

  const show = useCallback((from?: HTMLElement | null) => {
    opener.current = from ?? null;
    setOpen(true);
  }, []);

  const hide = useCallback((opened: boolean) => {
    afterClose.current = opened ? 'content' : 'opener';
    setOpen(false);
  }, []);

  // 閉じて、裏の画面が操作できるようになってから、キーボードの位置を戻す。
  useEffect(() => {
    const mode = afterClose.current;
    if (open || mode === null) return;
    afterClose.current = null;
    const back =
      opener.current !== null && opener.current.isConnected
        ? opener.current
        : visibleSearchButton();
    if (mode === 'opener') {
      back?.focus();
      return;
    }
    const active = document.activeElement;
    if (active !== null && active !== document.body) return;
    (document.querySelector<HTMLElement>('main h1[tabindex="-1"]') ?? back)?.focus();
  }, [open]);

  const onKeyDown = useEffectEvent((event: KeyboardEvent) => {
    if (!(event.ctrlKey || event.metaKey) || event.altKey || event.shiftKey) return;
    if (event.key.toLowerCase() !== 'k' || event.isComposing) return;
    if (open) {
      event.preventDefault();
      hide(false);
      return;
    }
    if (blocked()) return;
    event.preventDefault();
    const active = document.activeElement;
    show(active instanceof HTMLElement && active !== document.body ? active : null);
  });
  useEffect(() => {
    const handler = (event: KeyboardEvent) => onKeyDown(event);
    document.addEventListener('keydown', handler);
    return () => document.removeEventListener('keydown', handler);
  }, []);

  return { open, show, hide };
}
