/**
 * 半荘の一覧の行（U-8）。保存先の半荘（`SessionRecord`）と、結果から作ったまとめ（`SummaryMap`）を合わせて、
 * 行を出す・探す・絞り込むのに必要な値にする。
 */
import type { SessionRecord } from '../api/types';
import type { SummaryMap } from './sessionSummaries';
import type { FilterRow } from './sessionFilter';

/**
 * 結果の様子。
 * - none: まだ取り込んでいない（「取り込み前」と出す）
 * - loading: 取り込んである。まとめを読んでいる
 * - ready: 卓・段階・Rating が分かる
 * - unavailable: 取り込んであるが、読めなかった
 */
export type RowStatus = 'none' | 'loading' | 'ready' | 'unavailable';

export interface ListRow extends FilterRow {
  /** 半荘のフォルダの名前。 */
  id: string;
  status: RowStatus;
}

export function buildListRows(sessions: readonly SessionRecord[], summaries: SummaryMap): ListRow[] {
  return sessions.map((session) => {
    const imported = session.report_path !== null;
    const state = imported ? summaries.get(session.id) : undefined;
    const summary = state?.status === 'ready' ? state.summary : null;
    return {
      id: session.id,
      startedMs: session.started_ms,
      markCount: session.mark_count,
      imported,
      room: summary?.room ?? null,
      grade: summary?.grade ?? null,
      ratingText: summary?.ratingText ?? null,
      status: !imported ? 'none' : state === undefined ? 'loading' : state.status,
    };
  });
}

/**
 * 半荘を消したあと、本文に出す半荘。消した半荘の並びの先頭があった位置に、いま来ている半荘（消した半荘の次に古いもの）。
 * その位置が末尾より後ろなら、最後の半荘。1 つも残らなければ null。`orderedIds` は、消す前の、一覧の並び（新しい順）。
 */
export function neighborAfterDelete(orderedIds: readonly string[], deleted: ReadonlySet<string>): string | null {
  const first = orderedIds.findIndex((id) => deleted.has(id));
  const remaining = orderedIds.filter((id) => !deleted.has(id));
  if (remaining.length === 0) return null;
  return remaining[Math.min(Math.max(first, 0), remaining.length - 1)] ?? null;
}
