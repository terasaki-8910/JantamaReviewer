/**
 * 半荘を通して見る画面の設定（キーの割り当て・「AI の1位と違う判断も、不一致として出す」）。
 * 読み込み・ほかの窓での変更（`settings-changed`）の反映・保存を持つ。キーの割り当ては、変えるたびに settings.json へ保存する
 * （Rust 側が検査して、使えないものは断る。次の起動でも残る。U-21）。
 */
import { useCallback, useEffect, useMemo, useRef, useState } from 'react';

import { api, errorMessage, onSettingsChanged } from '../../api/tauri';
import type { ReplayKeys, Settings } from '../../api/types';
import { normalizeReplayKeys } from './keys';

export interface ReplaySettings {
  /** 読み込めたか。読み込み前は、既定の値で動く。 */
  loaded: boolean;
  keys: ReplayKeys;
  showAllMismatches: boolean;
  /** 設定の一部を保存する。保存できなかったときは、その理由の文を返す（保存できたら null）。 */
  update: (patch: Partial<Pick<Settings, 'replay_keys' | 'show_all_mismatches'>>) => Promise<string | null>;
}

export function useReplaySettings(): ReplaySettings {
  const [settings, setSettings] = useState<Settings | null>(null);
  const latest = useRef<Settings | null>(null);

  useEffect(() => {
    latest.current = settings;
  }, [settings]);

  useEffect(() => {
    let alive = true;
    let dispose: (() => void) | null = null;
    void api
      .getSettings()
      .then((value) => {
        if (alive) setSettings(value);
      })
      .catch(() => undefined);
    void onSettingsChanged((value) => {
      if (alive) setSettings(value);
    }).then((fn) => {
      if (alive) dispose = fn;
      else fn();
    });
    return () => {
      alive = false;
      dispose?.();
    };
  }, []);

  const update = useCallback(async (patch: Partial<Pick<Settings, 'replay_keys' | 'show_all_mismatches'>>) => {
    const base = latest.current;
    if (base === null) return '設定を読み込めていないため、保存できません。';
    try {
      const next = await api.setSettings({ ...base, ...patch });
      latest.current = next;
      setSettings(next);
      return null;
    } catch (failure) {
      return errorMessage(failure);
    }
  }, []);

  const keys = useMemo(() => normalizeReplayKeys(settings?.replay_keys), [settings?.replay_keys]);
  return { loaded: settings !== null, keys, showAllMismatches: settings?.show_all_mismatches === true, update };
}
