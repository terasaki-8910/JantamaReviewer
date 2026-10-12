/**
 * 半荘の一覧を、サイドバーと本文が一緒に使うための部品（U-8）。
 * - `useSessions`: 保存先の半荘（新しい順）を読む。ウィジェットで記録するたび・取り込み・削除のたびに（`state-changed`）、検討画面が前面に戻ったときにも読み直す
 * - `useSessionSummaries`: 結果を取り込んだ半荘の、卓・段階・Rating（`sessionSummaries.ts`）。段階は、MAKA の評価から合わせ直した当てはめで決める。
 *   `useSummariesAndFit` は、同じものと、当てはめの状態（MAKA の評価の局数・見込み。U-31）を一緒に返す
 * - `useToday`: 「本日」「昨日」の見出しの基準。日付が変わったら更新する
 */
import { useCallback, useEffect, useRef, useState, useSyncExternalStore } from 'react';

import { api, errorMessage, onMainWindowFocused, onStateChanged } from '../api/tauri';
import type { SessionRecord } from '../api/types';
import type { MakaFitState } from './makaFit';
import { SummaryStore, type SummaryMap } from './sessionSummaries';

/** 新しい順（開始が同じなら、名前の大きい順）。保存先も同じ並びで返すが、画面は並びに頼らず、ここでそろえる。 */
export function sortSessions(list: readonly SessionRecord[]): SessionRecord[] {
  return [...list].sort(
    (a, b) => b.started_ms - a.started_ms || (a.id < b.id ? 1 : a.id > b.id ? -1 : 0),
  );
}

export interface SessionsApi {
  /** 読み込み前は null。 */
  sessions: SessionRecord[] | null;
  /** 一覧を読めなかった理由（読めたら null）。 */
  error: string | null;
  /** 読み直す。失敗しても例外にはせず、`error` に入れる。 */
  reload: () => Promise<void>;
}

/**
 * 半荘の一覧。`onLoaded` は、読めるたびに（新しい一覧で）呼ぶ。見ている半荘が無くなったときの行き先の決め直しに使う。
 */
export function useSessions(onLoaded?: (sessions: SessionRecord[]) => void): SessionsApi {
  const [sessions, setSessions] = useState<SessionRecord[] | null>(null);
  const [error, setError] = useState<string | null>(null);
  // 読み込みの世代。あとから始めた読み込みの答えだけを使う（遅れて着いた古い答えで、新しい一覧を戻さない）。
  const generation = useRef(0);
  const loaded = useRef(onLoaded);
  useEffect(() => {
    loaded.current = onLoaded;
  });

  const reload = useCallback((): Promise<void> => {
    generation.current += 1;
    const mine = generation.current;
    return api.listSessions().then(
      (list) => {
        if (mine !== generation.current) return;
        const sorted = sortSessions(list);
        setSessions(sorted);
        setError(null);
        loaded.current?.(sorted);
      },
      (failure: unknown) => {
        if (mine === generation.current) setError(errorMessage(failure));
      },
    );
  }, []);

  useEffect(() => {
    let alive = true;
    const disposers: Array<() => void> = [];
    const track = (listening: Promise<() => void>) => {
      void listening.then((fn) => {
        if (alive) disposers.push(fn);
        else fn();
      });
    };
    void reload();
    track(onStateChanged(() => void reload()));
    // 検討画面が前面に戻ったときも読み直す。半荘のフォルダを写して戻ってきたとき、その半荘が一覧に出て、
    // 読み込んだ記録のうち取っておいた分（D-2）が付く（付けるのは、保存先を読むとき）
    track(onMainWindowFocused(() => void reload()));
    return () => {
      alive = false;
      disposers.forEach((fn) => fn());
    };
  }, [reload]);

  return { sessions, error, reload };
}

/**
 * 結果を取り込んだ半荘の、卓・段階・Rating と、段階の当てはめの状態。一覧が変わるたびに、足りない分だけ読む。
 * MAKA の評価を入れると、当てはめを合わせ直して、すべての半荘の段階を付け直す（`fit.revision` が増える）。
 */
export function useSummariesAndFit(sessions: readonly SessionRecord[] | null): { summaries: SummaryMap; fit: MakaFitState } {
  const [store] = useState(() => new SummaryStore((id) => api.readReport(id)));
  useEffect(() => {
    if (sessions !== null) store.sync(sessions);
  }, [store, sessions]);
  const summaries = useSyncExternalStore(store.subscribe, store.getSnapshot);
  const fit = useSyncExternalStore(store.subscribe, store.getFit);
  return { summaries, fit };
}

/** 結果を取り込んだ半荘の、卓・段階・Rating。一覧が変わるたびに、足りない分だけ読む。 */
export function useSessionSummaries(sessions: readonly SessionRecord[] | null): SummaryMap {
  return useSummariesAndFit(sessions).summaries;
}

/** 次の 0 時（ローカル時刻）までの、ミリ秒。 */
function msUntilMidnight(now: number): number {
  const d = new Date(now);
  return new Date(d.getFullYear(), d.getMonth(), d.getDate() + 1).getTime() - now;
}

/** 日付の見出し（本日・昨日）の基準になる「いま」。日付が変わったら、更新する。 */
export function useToday(): number {
  const [now, setNow] = useState(() => Date.now());
  useEffect(() => {
    const timer = window.setTimeout(() => setNow(Date.now()), msUntilMidnight(now) + 1000);
    return () => window.clearTimeout(timer);
  }, [now]);
  return now;
}
