/**
 * 読み（F23）の場面の引き当て（画面にも Tauri にも依存しない純粋な関数）。
 *
 * `reads.json` の場面（`ReadsMoment`）は、自分のツモの直後と、自分のチー・ポンの直後にある。画面が見せたい手
 * （出題・解き直しの判断、通して見る画面の手）から、どの場面の読みを使うかを決める:
 * - 自分のツモ・チー・ポンの手（その判断）: `event_index` が同じ場面
 * - 自分のリーチのあとの打牌（判断の直前の event が自分のリーチ宣言）: 同じ局の、それより前の最後の場面（宣言の前に切る牌を選んだ手と同じ手牌）
 * - それ以外（他家の打牌への鳴きの判断・盤面を見ているだけの手）: 読みは無い（null）
 */
import type { Decision, ImportedGame, Seat, TimelineStep } from '@jantama/engine';

import type { Reads, ReadsMoment } from '../../api/reads';

/** 読みを探す手の位置。 */
export interface MomentAt {
  /** 何局目か（0 から。`Decision.kyokuPosition`・`TimelineStep.kyokuPosition`）。 */
  kyokuPosition: number;
  /** その手の event の位置（`mjai_log` の添字。`Decision.eventIndex`・`TimelineStep.eventIndex`）。 */
  eventIndex: number;
  /** その event の種類。自分のリーチ宣言（`reach`）のときだけ、前の場面を探す（他家のリーチは `reach` にしない）。 */
  eventType: string;
}

/** `at` の手で見せる読みの場面。無ければ null。 */
export function momentFor(reads: Reads, at: MomentAt): ReadsMoment | null {
  let before: ReadsMoment | null = null;
  for (const moment of reads.moments) {
    if (moment.kyoku_index !== at.kyokuPosition) continue;
    if (moment.event_index === at.eventIndex) return moment;
    if (moment.event_index < at.eventIndex && (before === null || moment.event_index > before.event_index)) before = moment;
  }
  return at.eventType === 'reach' ? before : null;
}

/** 通して見る画面の手の位置。リーチの手は、自分のリーチのときだけ `reach` にする。 */
export function momentAtStep(step: Pick<TimelineStep, 'kyokuPosition' | 'eventIndex' | 'event' | 'actor'>, me: Seat): MomentAt {
  const type = step.event.type;
  return {
    kyokuPosition: step.kyokuPosition,
    eventIndex: step.eventIndex,
    eventType: type === 'reach' && step.actor !== me ? 'reach-by-other' : type,
  };
}

/** 出題・解き直しの判断の位置。判断の直前の event が自分のリーチなら `reach`。 */
export function momentAtDecision(game: Pick<ImportedGame, 'report' | 'playerId'>, decision: Pick<Decision, 'kyokuPosition' | 'eventIndex'>): MomentAt {
  const event = game.report.mjai_log[decision.eventIndex];
  const type = event === undefined ? 'unknown' : event.type;
  const other = event !== undefined && event.type === 'reach' && event.actor !== game.playerId;
  return { kyokuPosition: decision.kyokuPosition, eventIndex: decision.eventIndex, eventType: other ? 'reach-by-other' : type };
}
