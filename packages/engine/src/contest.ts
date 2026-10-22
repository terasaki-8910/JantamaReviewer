/** AI の上位2候補が拮抗した、終盤の判断（E-47）。 */
import type { Decision } from './decision';

export interface ContestOptions {
  enabled: boolean;
  maxGap: number;
  minJunme: number | null;
  afterRiichi: boolean;
  twoCalls: boolean;
}

export const DEFAULT_CONTEST_OPTIONS: Readonly<ContestOptions> = {
  enabled: true,
  maxGap: 0.2,
  minJunme: 12,
  afterRiichi: true,
  twoCalls: true,
};

/** 拮抗した判断なら上位2候補の確率差、そうでなければ null。 */
export function contestOf(decision: Pick<Decision, 'entry' | 'junme' | 'board'>, options: ContestOptions): { gap: number } | null {
  if (!options.enabled || decision.entry.details.length < 2) return null;
  const probabilities = decision.entry.details.map((detail) => detail.prob).sort((a, b) => b - a);
  const gap = (probabilities[0] as number) - (probabilities[1] as number);
  if (gap > options.maxGap) return null;
  const { board } = decision;
  const lateByJunme = options.minJunme !== null && decision.junme >= options.minJunme;
  const lateByRiichi = options.afterRiichi && board.riichi.some((state, seat) => seat !== board.playerId && state !== 'none');
  const lateByCalls =
    options.twoCalls &&
    board.melds.some((melds, seat) => seat !== board.playerId && melds.filter((meld) => meld.type !== 'ankan').length >= 2);
  return lateByJunme || lateByRiichi || lateByCalls ? { gap } : null;
}
