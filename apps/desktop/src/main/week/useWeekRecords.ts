/**
 * 週の成績（手入力）と来週の重点の、読み込みと保存（U-30）。保存先は study.sqlite の weeks 表（Rust 側）。
 *
 * - 開いたとき、すべての週の記録を 1 回読む（週の古い順で返る。数は多くない）
 * - 保存は、1 つずつ順番に行い、そのときの最新の記録から新しい記録を作る（成績の欄と重点の欄が続けて保存されても、片方が
 *   もう片方を古い値で上書きしない）。成績も重点も空の週は、Rust 側が記録ごと消す
 * - 保存に失敗したら、理由の文を返す（画面の値は、保存してある値のまま）
 */
import { useCallback, useEffect, useRef, useState } from 'react';

import { api, errorMessage } from '../../api/tauri';
import type { WeekRecord } from '../../api/types';

export interface WeekRecordsApi {
  /** 読み終えたか。 */
  loaded: boolean;
  /** 読めなかった理由（読めたら null）。 */
  error: string | null;
  /** 週の月曜 → 記録。 */
  records: ReadonlyMap<string, WeekRecord>;
  /**
   * 1 週ぶんを保存する。`change` は、いま保存してある記録（無ければ undefined）から、新しい記録を作る。
   * 保存できたら null、できなければ理由の文。
   */
  save: (week: string, change: (current: WeekRecord | undefined) => WeekRecord) => Promise<string | null>;
}

export function useWeekRecords(): WeekRecordsApi {
  const [records, setRecords] = useState<ReadonlyMap<string, WeekRecord>>(new Map());
  const [loaded, setLoaded] = useState(false);
  const [error, setError] = useState<string | null>(null);
  // 保存の順番待ち（前の保存が終わってから、次の保存を始める）と、いまの記録（保存のたびに、最新を見る）
  const queue = useRef<Promise<unknown>>(Promise.resolve());
  const latest = useRef<ReadonlyMap<string, WeekRecord>>(new Map());

  const replace = useCallback((next: ReadonlyMap<string, WeekRecord>) => {
    latest.current = next;
    setRecords(next);
  }, []);

  useEffect(() => {
    let alive = true;
    api.listWeeks().then(
      (rows) => {
        if (!alive) return;
        replace(new Map((rows ?? []).map((row) => [row.week, row] as const)));
        setLoaded(true);
      },
      (failure: unknown) => {
        if (!alive) return;
        setError(errorMessage(failure));
        setLoaded(true);
      },
    );
    return () => {
      alive = false;
    };
  }, [replace]);

  const save = useCallback(
    (week: string, change: (current: WeekRecord | undefined) => WeekRecord): Promise<string | null> => {
      const run = async (): Promise<string | null> => {
        const next = change(latest.current.get(week));
        try {
          const saved = await api.setWeek(next);
          const map = new Map(latest.current);
          if (saved === null || saved === undefined) map.delete(week);
          else map.set(week, saved);
          replace(map);
          return null;
        } catch (failure) {
          return errorMessage(failure);
        }
      };
      const result = queue.current.then(run, run);
      queue.current = result;
      return result;
    },
    [replace],
  );

  return { loaded, error, records, save };
}
