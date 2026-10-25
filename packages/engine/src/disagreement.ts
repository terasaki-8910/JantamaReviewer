/**
 * 悪手の一覧（E-4、F2）。
 * Mortal が実戦の行動に付けた確率が基準（既定 5%）未満の判断を、確率の低い順（差の大きい順）に並べる。
 */
import type { Decision } from './decision';
import type { ActionEvent, ReportEntry } from './report-types';

/** 不一致とみなす確率の基準の既定値（5%）。 */
export const DEFAULT_DISAGREEMENT_THRESHOLD = 0.05;
/** 1 日に出す数の既定値。 */
export const DEFAULT_DISAGREEMENT_LIMIT = 5;

export interface DisagreementOptions {
  /** この確率より低い行動を不一致とする（既定 0.05）。 */
  threshold?: number;
  /** 先頭に出す数（既定 5）。残りは rest に入れる。 */
  limit?: number;
}

export interface Disagreement {
  decision: Decision;
  /** Mortal が実戦の行動に付けた確率。 */
  prob: number;
  /** 実戦の行動。 */
  actual: ActionEvent;
  /** Mortal の 1 位の行動。 */
  top: ActionEvent;
}

export interface DisagreementList {
  threshold: number;
  limit: number;
  /** 基準を下回った判断の総数。 */
  total: number;
  /** 確率の低い順に、limit 件まで。 */
  items: Disagreement[];
  /** 残り（畳んで表示する分）。 */
  rest: Disagreement[];
}

/** Mortal が実戦の行動に付けた確率。 */
export function actualProbability(entry: Pick<ReportEntry, 'details' | 'actual_index'>): number {
  const detail = entry.details[entry.actual_index];
  if (!detail) throw new RangeError(`actual_index（${entry.actual_index}）が候補の範囲を出ています`);
  return detail.prob;
}

/**
 * 実戦の行動の確率が threshold 未満の判断を、確率の低い順に返す。同じ確率なら半荘の順。
 * 先頭の limit 件が items、残りが rest。total は基準を下回った総数。
 */
export function listDisagreements(decisions: readonly Decision[], options: DisagreementOptions = {}): DisagreementList {
  const threshold = options.threshold ?? DEFAULT_DISAGREEMENT_THRESHOLD;
  const limit = Math.max(0, Math.floor(options.limit ?? DEFAULT_DISAGREEMENT_LIMIT));
  const all: Disagreement[] = [];
  for (const decision of decisions) {
    const prob = actualProbability(decision.entry);
    if (prob < threshold) {
      const top = decision.entry.details[0];
      all.push({ decision, prob, actual: decision.entry.actual, top: (top ? top.action : decision.entry.expected) });
    }
  }
  all.sort((a, b) => a.prob - b.prob || a.decision.index - b.decision.index);
  return { threshold, limit, total: all.length, items: all.slice(0, limit), rest: all.slice(limit) };
}


