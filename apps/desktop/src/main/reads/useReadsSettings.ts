/**
 * 「読み」の入切の設定（F23）。この PC だけの値（同期にも書き出しにも入れない）で、設定の `reads_visible`（無ければ切）に覚える。
 * 切り替えるたびに `readsApi.setReadsVisible` で保存し、保存できなかったときは元に戻して、理由を返す（`saveError`）。
 * 設定は、画面を開いたときに読む（入切の好みとキーの割り当てだけ。AI の情報ではない）。読みそのものは、答えたあとにだけ読む（U-1。`useSessionReads`）。
 * 好みが入のとき、手牌の下の数の帯を、答える前から取っておく（答え合わせで卓が動かない。reads.css）。
 * キーの割り当て（`replay_keys` の `toggle_reads`）も、同じ設定から読む。
 */
import { useCallback, useEffect, useMemo, useRef, useState } from 'react';

import { api, errorMessage, onSettingsChanged } from '../../api/tauri';
import { readsApi } from '../../api/reads';
import type { ReplayKeys, Settings } from '../../api/types';
import { normalizeReplayKeys } from '../replay/keys';

export interface ReadsSettings {
  /** 設定を読めたか。 */
  loaded: boolean;
  /** 「読み」の入切の好み（保存した値。読み込み前は切）。出してよい場面かどうかは見ない。 */
  preferred: boolean;
  /** 入切を変えて保存する。 */
  setVisible: (next: boolean) => void;
  /** 「読みの入切」に割り当てたキー（割り当て無しは null）。 */
  keyChord: string | null;
  /** キーの割り当て（ほかの操作も含む）。 */
  keys: ReplayKeys;
  /** 入切を保存できなかったときの理由。次に切り替えると消える。 */
  saveError: string | null;
}

export function useReadsSettings(): ReadsSettings {
  const [settings, setSettings] = useState<Settings | null>(null);
  const [saveError, setSaveError] = useState<string | null>(null);
  // 保存の途中の値（保存が済むまでは、これを見せる）
  const [pending, setPending] = useState<boolean | null>(null);
  const alive = useRef(true);

  useEffect(() => {
    alive.current = true;
    return () => {
      alive.current = false;
    };
  }, []);

  useEffect(() => {
    let cancelled = false;
    let dispose: (() => void) | null = null;
    // コマンドが返事を返さない環境（部品だけの試験）でも、落ちない
    void Promise.resolve()
      .then(() => api.getSettings())
      .then((value) => {
        if (!cancelled && value !== null && typeof value === 'object') setSettings(value);
      })
      .catch(() => undefined);
    void Promise.resolve()
      .then(() =>
        onSettingsChanged((value) => {
          if (!cancelled) setSettings(value);
        }),
      )
      .then((fn) => {
        if (cancelled) fn();
        else dispose = fn;
      })
      .catch(() => undefined);
    return () => {
      cancelled = true;
      dispose?.();
    };
  }, []);

  const setVisible = useCallback((next: boolean) => {
    setSaveError(null);
    setPending(next);
    readsApi.setReadsVisible(next).then(
      (saved) => {
        if (!alive.current) return;
        // 保存した設定が返らなかったときも、いま保存した値は覚えておく
        setSettings((previous) => (saved !== null && typeof saved === 'object' ? saved : previous === null ? previous : { ...previous, reads_visible: next }));
        setPending(null);
      },
      (failure: unknown) => {
        if (!alive.current) return;
        setPending(null);
        setSaveError(`「読み」の入切を保存できませんでした: ${errorMessage(failure)}`);
      },
    );
  }, []);

  const keys = useMemo(() => normalizeReplayKeys(settings?.replay_keys), [settings?.replay_keys]);
  const stored = settings?.reads_visible === true;
  return {
    loaded: settings !== null,
    preferred: pending ?? stored,
    setVisible,
    keyChord: keys.toggle_reads ?? null,
    keys,
    saveError,
  };
}
