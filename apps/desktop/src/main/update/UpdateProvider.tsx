/**
 * アプリ内の更新（F21、U-51）の状態を、検討画面のシェルの上で 1 つだけ持ち、更新の帯（`UpdateBanner`）と設定の「更新」の欄
 * （`UpdateBlock`）に配る。
 *
 * - 起動のとき、1 回だけ、裏で確かめる（画面を止めない）。更新の仕組みが設定されていないとき・記録中（ウィジェットが半荘を記録している間）は、
 *   確かめない。通信に失敗しても、何も出さない（設定の「更新を確かめる」で確かめたときだけ、失敗を出す）
 * - 帯に出すのは、新しい版があり（`shouldOfferUpdate`）、飛ばした版でなく、「あとで」を押していない版。「あとで」は起動し直すまで（メモリの中だけ）、
 *   「この版は飛ばす」は設定（settings.json）に覚える
 * - 「今すぐ入れ直す」を押したときだけ、入れ直しの命令を呼ぶ。記録中は押せない（Rust 側も断る）
 *
 * シェルの作り直し（記録の読み込み）で「起動のとき」が繰り返されないよう、シェルの外（`App`）に置く。シェルの外（部品だけの試験）では、無い（null）。
 */
import { createContext, useCallback, useContext, useEffect, useMemo, useRef, useState, type ReactNode } from 'react';

import { api, errorMessage, onSettingsChanged, onStateChanged } from '../../api/tauri';
import { updateApi, type UpdateCheck, type UpdateInfo } from '../../api/update';
import { sameVersion, shouldOfferUpdate, viewOfCheck, type CheckSource, type CheckView } from './updateDecision';
import { installFailedText, skipFailedText } from './updateText';

export interface UpdateValue {
  /** 今の版と、更新の仕組みが使える状態か。読み込み前（と、読めなかったとき）は null。 */
  info: UpdateInfo | null;
  /** 最後に確かめた結果（設定の欄に出す）。 */
  view: CheckView;
  /** 見つけた新しい版。飛ばした版・「あとで」の版も含む（設定の欄は、これを出す）。 */
  found: string | null;
  /** 帯に出す版。出さないときは null（飛ばした版・「あとで」を押した版・今の版と同じか古い版）。 */
  offer: string | null;
  skipped: string | null;
  /** 「あとで」を押した版（起動し直すまで）。 */
  later: string | null;
  /** 記録中か（ウィジェットが半荘を記録している間）。記録中は、入れ直せない。 */
  recording: boolean;
  installing: boolean;
  /** 入れ直し・飛ばす設定の保存に失敗した理由。 */
  error: string | null;
  /** 設定の「更新を確かめる」: いま確かめて、結果を出す（失敗も出す）。 */
  checkNow: () => Promise<void>;
  /** 「今すぐ入れ直す」。 */
  install: () => Promise<void>;
  /** 「あとで」。 */
  postpone: () => void;
  /** 「この版は飛ばす」。 */
  skip: () => Promise<void>;
}

const UpdateContext = createContext<UpdateValue | null>(null);

/** 更新の状態を使う。シェルの外では null。 */
export function useUpdate(): UpdateValue | null {
  return useContext(UpdateContext);
}

const CHECK_KINDS: ReadonlySet<string> = new Set(['not_configured', 'up_to_date', 'available', 'failed']);

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null;
}

/** Rust 側の答えが、読める形か（読めない答えは、無かったものとして扱う）。 */
function isUpdateInfo(value: unknown): value is UpdateInfo {
  return isRecord(value) && typeof value.current_version === 'string' && typeof value.configured === 'boolean';
}

function isUpdateCheck(value: unknown): value is UpdateCheck {
  if (!isRecord(value) || typeof value.current_version !== 'string') return false;
  if (typeof value.kind !== 'string' || !CHECK_KINDS.has(value.kind)) return false;
  if (value.kind === 'available') return typeof value.version === 'string';
  if (value.kind === 'failed') return typeof value.message === 'string';
  return true;
}

/** 打ちかけの入力欄（メモなど）を確定させる。入力欄から外れると、欄が保存の命令を出す（MemoFields）。 */
async function settleInputs(): Promise<void> {
  const active = document.activeElement;
  if (active instanceof HTMLElement && active !== document.body) active.blur();
  await new Promise((resolve) => window.setTimeout(resolve, 0));
}

/** 更新の状態と操作。シェルの外（`App`）で 1 度だけ作る。 */
export function useUpdateController(): UpdateValue {
  const [info, setInfo] = useState<UpdateInfo | null>(null);
  const [view, setView] = useState<CheckView>({ kind: 'none' });
  const [found, setFound] = useState<string | null>(null);
  const [skipped, setSkipped] = useState<string | null>(null);
  const [later, setLater] = useState<string | null>(null);
  const [recording, setRecording] = useState(false);
  const [installing, setInstalling] = useState(false);
  const [error, setError] = useState<string | null>(null);
  // 起動のときの確かめを始めたか（開発のときの二重の実行や、再描画で、繰り返さない）
  const launched = useRef(false);

  const applyCheck = useCallback((check: UpdateCheck, source: CheckSource) => {
    const next = viewOfCheck(check, source);
    if (next.kind === 'available') setFound(next.version);
    else if (next.kind === 'up_to_date' || next.kind === 'not_configured') setFound(null);
    // 失敗では、前に見つけた版を残す（つながらなかっただけで、更新が無くなったわけではない）
    setView(next);
  }, []);

  // 飛ばした版（設定）。設定が変わったら（飛ばす設定の保存・ほかの窓）、すぐに替わる
  useEffect(() => {
    let alive = true;
    let dispose: (() => void) | null = null;
    void api
      .getSettings()
      .then((settings) => {
        if (alive && isRecord(settings)) setSkipped(typeof settings.skipped_update_version === 'string' ? settings.skipped_update_version : null);
      })
      .catch(() => undefined);
    void onSettingsChanged((settings) => {
      if (isRecord(settings)) setSkipped(typeof settings.skipped_update_version === 'string' ? settings.skipped_update_version : null);
    }).then((fn) => {
      if (alive) dispose = fn;
      else fn();
    });
    return () => {
      alive = false;
      dispose?.();
    };
  }, []);

  // 記録中か。ウィジェットが半荘を記録している間は、入れ直せない
  useEffect(() => {
    let alive = true;
    let dispose: (() => void) | null = null;
    const apply = (state: unknown) => {
      if (isRecord(state) && typeof state.status === 'string') setRecording(state.status === 'recording');
    };
    void api
      .getState()
      .then((state) => {
        if (alive) apply(state);
      })
      .catch(() => undefined);
    void onStateChanged(apply).then((fn) => {
      if (alive) dispose = fn;
      else fn();
    });
    return () => {
      alive = false;
      dispose?.();
    };
  }, []);

  // 起動のとき、1 回だけ、裏で確かめる。設定されていなければ通信しない。記録中は確かめない。失敗は、黙っている
  useEffect(() => {
    if (launched.current) return;
    launched.current = true;
    void (async () => {
      const loaded = await updateApi.getUpdateInfo().catch(() => null);
      if (!isUpdateInfo(loaded)) return;
      setInfo(loaded);
      if (!loaded.configured) {
        setView({ kind: 'not_configured' });
        return;
      }
      const state = await api.getState().catch(() => null);
      if (isRecord(state) && state.status === 'recording') return;
      const check = await updateApi.checkUpdate().catch(() => null);
      if (isUpdateCheck(check)) applyCheck(check, 'launch');
    })();
  }, [applyCheck]);

  const checkNow = useCallback(async () => {
    setView({ kind: 'checking' });
    try {
      const check = await updateApi.checkUpdate();
      if (isUpdateCheck(check)) applyCheck(check, 'manual');
      else setView({ kind: 'failed', message: '更新の確かめの答えを読めませんでした' });
    } catch (failure) {
      setView({ kind: 'failed', message: errorMessage(failure) });
    }
  }, [applyCheck]);

  const install = useCallback(async () => {
    if (installing || recording) return;
    setInstalling(true);
    setError(null);
    try {
      // 書きかけのメモなどを、先に保存させてから、入れ直す
      await settleInputs();
      // Windows では、インストーラーが動いて、アプリが終わるので、戻ってこない
      await updateApi.installUpdate();
    } catch (failure) {
      setInstalling(false);
      setError(installFailedText(errorMessage(failure)));
    }
  }, [installing, recording]);

  const postpone = useCallback(() => setLater(found), [found]);

  const skip = useCallback(async () => {
    if (found === null) return;
    setError(null);
    try {
      await updateApi.skipUpdateVersion(found);
      setSkipped(found);
    } catch (failure) {
      setError(skipFailedText(errorMessage(failure)));
    }
  }, [found]);

  const current = info?.current_version ?? null;
  const offer =
    current !== null &&
    found !== null &&
    shouldOfferUpdate(current, found, skipped) &&
    (later === null || !sameVersion(later, found))
      ? found
      : null;

  return useMemo(
    () => ({ info, view, found, offer, skipped, later, recording, installing, error, checkNow, install, postpone, skip }),
    [info, view, found, offer, skipped, later, recording, installing, error, checkNow, install, postpone, skip],
  );
}

/** 更新の状態を、配下の画面に配る。 */
export function UpdateProvider({ children }: { children: ReactNode }) {
  const value = useUpdateController();
  return <UpdateContext.Provider value={value}>{children}</UpdateContext.Provider>;
}
