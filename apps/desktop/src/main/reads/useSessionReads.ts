/**
 * 半荘の読み（`reads.json`）を、画面に出す前に用意する（F23）。
 *
 * 呼び出しは、「読み」が入で、答えたあとの場面でだけ（`enabled`）。答える前は何も呼ばない（U-1）。
 * 1. `readsApi.readReads`: 計算ずみのものがあれば、それを使う
 * 2. 無ければ `readsApi.getModel`: 読みのモデルが入っていなければ `no-model`（設定の「解析のモデル」へ案内する）
 * 3. 入っていれば `readsApi.computeReads`（進み具合は `onReadsProgress` の、この半荘の分）
 * どこかで失敗したら `error`（理由つき。`retry` でもう一度）。用意できた読みは、この画面が開いている間、半荘ごとに覚える
 * （「読み」を切って入れ直しても、読み直さない。計算は、同じ半荘で同時に 2 つ走らせない）。
 */
import { useCallback, useEffect, useRef, useState } from 'react';

import { readsApi, onReadsProgress, type Reads } from '../../api/reads';
import { errorMessage } from '../../api/tauri';

export type ReadsLoad =
  /** 読まない（「読み」が切、または、答える前）。 */
  | { kind: 'idle' }
  /** 計算ずみのものを探している。 */
  | { kind: 'loading' }
  /** 計算している。`total` は、まだ分からないとき null。 */
  | { kind: 'computing'; done: number; total: number | null }
  /** 読みのモデルが入っていない。 */
  | { kind: 'no-model' }
  | { kind: 'error'; message: string }
  | { kind: 'ready' };

export interface SessionReads {
  load: ReadsLoad;
  /** 用意できた読み（用意できていなければ null）。 */
  reads: Reads | null;
  /** 失敗のあとに、もう一度用意する。 */
  retry: () => void;
}

type Pending = Exclude<ReadsLoad, { kind: 'idle' } | { kind: 'loading' } | { kind: 'ready' }>;

export function useSessionReads(sessionId: string, enabled: boolean): SessionReads {
  const [loaded, setLoaded] = useState<ReadonlyMap<string, Reads>>(() => new Map());
  const [attempt, setAttempt] = useState(0);
  // 用意の途中の様子（どの半荘の何回目の用意かの印つき。印が合わないものは、古いので見ない）
  const [pending, setPending] = useState<{ key: string; load: Pending } | null>(null);
  const alive = useRef(true);
  const running = useRef(new Set<string>());
  const listeners = useRef(new Set<() => void>());

  useEffect(() => {
    alive.current = true;
    const active = listeners.current;
    return () => {
      alive.current = false;
      for (const dispose of active) dispose();
      active.clear();
    };
  }, []);

  const have = loaded.has(sessionId);
  useEffect(() => {
    if (!enabled || have) return;
    const key = `${sessionId}#${attempt}`;
    // 同じ用意を 2 つ走らせない（入れ直したとき・開発時の二重の実行）
    if (running.current.has(key)) return;
    running.current.add(key);
    const report = (load: Pending) => {
      if (alive.current) setPending({ key, load });
    };
    const finish = (reads: Reads) => {
      if (alive.current) setLoaded((previous) => new Map(previous).set(sessionId, reads));
    };
    void (async () => {
      let finished = false;
      let stop: (() => void) | null = null;
      try {
        const existing = await readsApi.readReads(sessionId);
        if (existing !== null) {
          finish(existing);
          return;
        }
        const model = await readsApi.getModel();
        if (!model.installed) {
          report({ kind: 'no-model' });
          return;
        }
        report({ kind: 'computing', done: 0, total: null });
        void Promise.resolve()
          .then(() =>
            onReadsProgress((progress) => {
              if (progress.session_id === sessionId) report({ kind: 'computing', done: progress.done, total: progress.total });
            }),
          )
          .then((dispose) => {
            // 受け手を付け終えたときには、計算が終わっている（この画面を離れている）ことがある
            if (finished || !alive.current) {
              dispose();
              return;
            }
            stop = dispose;
            listeners.current.add(dispose);
          })
          .catch(() => undefined);
        finish(await readsApi.computeReads(sessionId));
      } catch (failure) {
        report({ kind: 'error', message: errorMessage(failure) });
      } finally {
        finished = true;
        running.current.delete(key);
        const dispose = stop as (() => void) | null;
        if (dispose !== null) {
          dispose();
          listeners.current.delete(dispose);
        }
      }
    })();
  }, [enabled, have, sessionId, attempt]);

  const retry = useCallback(() => setAttempt((count) => count + 1), []);

  const reads = loaded.get(sessionId) ?? null;
  const key = `${sessionId}#${attempt}`;
  let load: ReadsLoad;
  if (reads !== null) load = { kind: 'ready' };
  else if (!enabled) load = { kind: 'idle' };
  else if (pending !== null && pending.key === key) load = pending.load;
  else load = { kind: 'loading' };
  return { load, reads, retry };
}
