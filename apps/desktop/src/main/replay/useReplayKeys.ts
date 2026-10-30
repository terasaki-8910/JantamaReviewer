/**
 * 半荘を通して見る画面のキー操作（U-21）。押したキーを、割り当て（`keys`）の操作にして、画面の動きを呼ぶ。
 *
 * 何もしない場面（その場の操作に任せる）:
 * - 文字を打つ欄・メニュー・ダイアログ・小窓にキーボードの位置があるとき、メニューや確認のダイアログが開いている間（`useShortcutBlocker`）
 * - 日本語の入力の途中
 * - 手牌の牌・答えのボタンが先に受けたキー（手牌の ← → は牌の移動、答えのボタンの矢印は選択肢の移動。`defaultPrevented`）
 * Alt+← → は画面の戻る・進む、Ctrl+K は検索、Ctrl+Z・Ctrl+Y は取り消しに使うので、割り当てても拾わない（割り当て自体が断られる）。
 */
import { useEffect, useEffectEvent } from 'react';

import type { ReplayKeys } from '../../api/types';
import { useShortcutsBlocked } from '../undo/shortcutGuard';
import { actionOfChord, chordOfEvent, type ReplayAction } from './keys';

export type ReplayHandlers = Record<ReplayAction, () => void>;

/** キーの操作に任せる場所（文字を打つ欄・メニュー・ダイアログ・小窓）にキーボードの位置があるか。 */
export function ownsKeys(target: EventTarget | null): boolean {
  if (!(target instanceof Element)) return false;
  return (
    target.closest('input:not([type="checkbox"]):not([type="radio"]):not([type="button"]), textarea, select, [contenteditable="true"], [role="menu"], [role="dialog"], [role="listbox"]') !==
    null
  );
}

export function useReplayKeys(keys: ReplayKeys, handlers: ReplayHandlers): void {
  const blocked = useShortcutsBlocked();
  const onKeyDown = useEffectEvent((event: KeyboardEvent) => {
    if (event.defaultPrevented || event.isComposing || blocked() || ownsKeys(event.target)) return;
    const chord = chordOfEvent(event);
    if (chord === null) return;
    const action = actionOfChord(keys, chord);
    if (action === null) return;
    // 割り当てたキーは、行き先が無くても、窓のスクロールなどの既定の動きを起こさない
    event.preventDefault();
    // 読みの入切は、押しっぱなしの繰り返しでは働かない（入と切が交互に出てしまう）。移動のキーは、繰り返しで動き続ける
    if (action === 'toggle_reads' && event.repeat) return;
    handlers[action]();
  });
  useEffect(() => {
    const listener = (event: KeyboardEvent) => onKeyDown(event);
    document.addEventListener('keydown', listener);
    return () => document.removeEventListener('keydown', listener);
  }, []);
}
