/**
 * 「読み」（F23）の画面側のまとまり。入切の設定・半荘の読みの用意・キーの割り当てを 1 つにして、出題・解き直し・通して見る画面が使う。
 *
 * `active` は、読みを出してよい場面か（答え合わせのあと、または、盤面を見ているだけの手）。`active` でない間は、設定も読みも呼ばない
 * （答える前は、読みの切り替えも数も DOM に無く、読みのコマンドも呼ばない。U-1）。
 */
import { useCallback, useEffect, useEffectEvent } from 'react';

import type { Reads } from '../../api/reads';
import { useShortcutsBlocked } from '../undo/shortcutGuard';
import { chordOfEvent } from '../replay/keys';
import { ownsKeys } from '../replay/useReplayKeys';
import { useReadsSettings } from './useReadsSettings';
import { useSessionReads, type ReadsLoad } from './useSessionReads';

export interface ReadsFeature {
  /** 読みを出してよい場面か。 */
  active: boolean;
  /** 設定（入切の保存した値とキーの割り当て）を読めたか。読めるまでは、切り替えを出さない（入なのに、一瞬切に見えないように）。 */
  loaded: boolean;
  /** 「読み」が入か（`active` でなければ、いつも false）。 */
  visible: boolean;
  /** 入切を替えて保存する。 */
  toggle: () => void;
  /** 「読みの入切」に割り当てたキー（無ければ null）。 */
  keyChord: string | null;
  load: ReadsLoad;
  /** 用意できた読み（この半荘のすべての場面）。 */
  reads: Reads | null;
  retry: () => void;
  /** 入切を保存できなかった理由。 */
  saveError: string | null;
}

export function useReadsFeature(sessionId: string, active: boolean): ReadsFeature {
  const settings = useReadsSettings(active);
  const session = useSessionReads(sessionId, active && settings.visible);
  const { visible, setVisible } = settings;
  const toggle = useCallback(() => setVisible(!visible), [setVisible, visible]);
  return {
    active,
    loaded: settings.loaded,
    visible,
    toggle,
    keyChord: settings.keyChord,
    load: session.load,
    reads: session.reads,
    retry: session.retry,
    saveError: settings.saveError,
  };
}

/**
 * 出題・解き直しの、答え合わせのあとの「読みの入切」のキー（通して見る画面は、ほかの操作と同じ仕組み `useReplayKeys` で受ける）。
 * 文字を打つ欄・メニュー・ダイアログ・小窓にキーボードの位置があるとき、日本語の入力の途中、押しっぱなしの繰り返しでは、働かない。
 */
export function useReadsKey(chord: string | null, active: boolean, toggle: () => void): void {
  const blocked = useShortcutsBlocked();
  const onKeyDown = useEffectEvent((event: KeyboardEvent) => {
    if (!active || chord === null) return;
    if (event.defaultPrevented || event.isComposing || event.repeat || blocked() || ownsKeys(event.target)) return;
    if (chordOfEvent(event) !== chord) return;
    event.preventDefault();
    toggle();
  });
  useEffect(() => {
    const listener = (event: KeyboardEvent) => onKeyDown(event);
    document.addEventListener('keydown', listener);
    return () => document.removeEventListener('keydown', listener);
  }, []);
}
