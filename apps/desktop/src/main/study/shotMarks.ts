/**
 * 迷いのスクショの欄（F12、U-45）の、どの迷いを出すか・前後の手・付け替えたあとの文を決める。画面にも Tauri にも依存しない純粋な関数。
 * 欄は、迷いマークを結びつけた場面（出題・解き直し・通して見る画面）の、答えの欄の上に出る。
 */
import type { DecisionRef } from '@jantama/engine';

import type { ResolvedMark } from '../markCards';

/** この判断に結びついている迷い（迷いの番号の順。推定も、利用者が選んだものも）。 */
export function marksOfDecision(resolved: readonly ResolvedMark[], decisionKey: string): ResolvedMark[] {
  return resolved.filter((item) => item.resolution.kind === 'linked' && item.resolution.ref.key === decisionKey);
}

/** 自分の判断を半荘の順に並べたとき、この判断の前の判断と次の判断。端（最初・最後の判断）は null。 */
export function neighbourDecisions(
  decisions: readonly DecisionRef[],
  decisionKey: string,
): { prev: DecisionRef | null; next: DecisionRef | null } {
  const at = decisions.findIndex((decision) => decision.key === decisionKey);
  if (at < 0) return { prev: null, next: null };
  return { prev: decisions[at - 1] ?? null, next: decisions[at + 1] ?? null };
}

/** 付け替えたあとの、読み上げの文。例: 迷い3を東2局1本場 6巡目 · 打牌の迷いに付け替えました。 */
export function relinkedText(number: number, to: Pick<DecisionRef, 'label'>): string {
  return `迷い${number}を${to.label}に付け替えました`;
}
