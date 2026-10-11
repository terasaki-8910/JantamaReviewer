/**
 * 検討ログの、使う人が決めた状態（絞り込みと、「答えを出す」）。
 * ログから問題を開いて戻っても、絞り込みが残るように、画面（`LogPage`）の外（検討画面のシェル）が 1 つだけ持つ。
 *
 * 「答えを出す」は、既定は切。あとで解き直すときに答えが見えてしまわないよう、起動し直したら切に戻す（保存しない）。
 */
import { useCallback, useMemo, useRef, useState, type RefObject } from 'react';

import { FRESH_FILTER, type LogFilter } from './logModel';

export interface LogState {
  filter: LogFilter;
  /** 絞り込みを替える（渡した項目だけ替わる）。 */
  setFilter: (patch: Partial<LogFilter>) => void;
  /** 種類・局面・原因・結果をはずす。期間は、渡した期間にする（既定は、最初の「今週」）。 */
  clearFilter: (period?: LogFilter['period']) => void;
  /** 自分・実戦・AI の1位の欄を出すか。 */
  showAnswers: boolean;
  setShowAnswers: (on: boolean) => void;
  /** ログの縦の位置（ページのスクロール）。問題を開いて戻ったとき、見ていた位置に戻すために、画面が書き込む。 */
  scroll: RefObject<number>;
}

export function useLogState(): LogState {
  const [filter, setFilterState] = useState<LogFilter>(FRESH_FILTER);
  const [showAnswers, setShowAnswers] = useState(false);
  const scroll = useRef(0);
  const setFilter = useCallback((patch: Partial<LogFilter>) => setFilterState((current) => ({ ...current, ...patch })), []);
  const clearFilter = useCallback(
    (period: LogFilter['period'] = FRESH_FILTER.period) => setFilterState({ ...FRESH_FILTER, period }),
    [],
  );
  return useMemo(
    () => ({ filter, setFilter, clearFilter, showAnswers, setShowAnswers, scroll }),
    [filter, setFilter, clearFilter, showAnswers],
  );
}
