/** 迷いのうち、実戦の行動が AI の1位と違う「細かいミス」（E-46）。 */
import type { Decision } from './decision';
import { actualChoice, sameChoice, topChoice } from './quiz-choice';

/** 実戦の行動が AI の1位と違うか。AI の候補が無ければ false。 */
export function isFineMiss(decision: Pick<Decision, 'kind' | 'entry' | 'board'>): boolean {
  const top = topChoice(decision);
  return top !== null && !sameChoice(actualChoice(decision), top);
}
