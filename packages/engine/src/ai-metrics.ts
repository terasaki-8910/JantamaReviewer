/**
 * AI との比べ: AI 一致率・類似度・悪手率（F18、E-48）。NAGA の解析の一致率・類似度・悪手率に当たる 3 つの数を、
 * Mortal の結果（レビューした本人の判断。`review.kyokus[].entries[]` の 1 件が 1 判断）から数える。
 *
 * - AI 一致率: 実戦の行動が AI の 1 位と同じだった判断 ÷ 判断（結果の `review.total_matches` ÷ `review.total_reviewed` と同じ数）
 * - 類似度: Mortal の Rating と同じ値（rating.ts。判断ごとの点の平均の 2 乗。AI の 1 位なら満点、違えば AI の評価に応じた部分点）
 * - 悪手率: 実戦の行動の AI の確率が基準（悪手の基準。既定 5%）より低い判断 ÷ 判断。数は `listDisagreements` の total と同じ
 *   （設定の「AI の 1 位と違う判断も不一致として出す」で足す判断は、悪手に数えない）
 *
 * 率は 0 から 1（Rating と同じ。文字にするのは `formatRatePercent`・`formatSimilarity`）。判断が 1 つも無いときは、どの値も null（0 ではない）。
 * 半荘をまとめる（週の集計）ときは、半荘ごとのもとの数（判断・一致・悪手・点の合計）を足して、同じ式で出し直す（`totalAiMetrics`。
 * 判断を読み直さない）。一致率・悪手率は数の合計の割合、類似度はまとめた判断すべてでの Rating の式（半荘ごとの値の平均ではない）。
 */
import { DEFAULT_DISAGREEMENT_THRESHOLD, actualProbability } from './disagreement';
import { decisionScore, formatRating } from './rating';
import type { MortalReport, ReportEntry } from './report-types';

/** 数えるのに使う判断の項目（Rating と不一致の一覧が見る項目と同じ）。 */
export type AiMetricsEntry = Pick<ReportEntry, 'is_equal' | 'details' | 'actual_index'>;

/** 数えたもとの数。半荘をまとめるときは、これを足す。 */
export interface AiMetricCounts {
  /** 判断の数。 */
  decisions: number;
  /** 実戦の行動が AI の 1 位と同じだった判断の数。 */
  matches: number;
  /** 実戦の行動の AI の確率が基準より低い判断の数（悪手）。 */
  badMoves: number;
  /** 判断ごとの点（rating.ts の `decisionScore`）の合計。 */
  scoreSum: number;
}

/** もとの数と、そこから出した 3 つの値（率は 0 から 1）。判断が無ければ、値はすべて null。 */
export interface AiMetrics extends AiMetricCounts {
  /** AI 一致率。 */
  matchRate: number | null;
  /** 類似度（Mortal の Rating と同じ式）。 */
  similarity: number | null;
  /** 悪手率。 */
  badMoveRate: number | null;
}

export interface AiMetricsOptions {
  /** この確率より低い行動を悪手とする（既定 0.05。悪手の基準と同じ）。 */
  threshold?: number;
}

/** もとの数から値を出す。 */
function withValues({ decisions, matches, badMoves, scoreSum }: AiMetricCounts): AiMetrics {
  if (decisions === 0) return { decisions, matches, badMoves, scoreSum, matchRate: null, similarity: null, badMoveRate: null };
  const mean = scoreSum / decisions;
  return { decisions, matches, badMoves, scoreSum, matchRate: matches / decisions, similarity: mean * mean, badMoveRate: badMoves / decisions };
}

/** 判断の並びから数える。 */
export function aiMetricsOfEntries(entries: readonly AiMetricsEntry[], options: AiMetricsOptions = {}): AiMetrics {
  const threshold = options.threshold ?? DEFAULT_DISAGREEMENT_THRESHOLD;
  let matches = 0;
  let badMoves = 0;
  let scoreSum = 0;
  for (const entry of entries) {
    if (entry.is_equal) matches += 1;
    if (actualProbability(entry) < threshold) badMoves += 1;
    scoreSum += decisionScore(entry);
  }
  return withValues({ decisions: entries.length, matches, badMoves, scoreSum });
}

/** 半荘 1 つ分（レビューした本人のすべての判断）。 */
export function aiMetricsOf(report: MortalReport, options: AiMetricsOptions = {}): AiMetrics {
  return aiMetricsOfEntries(
    report.review.kyokus.flatMap((kyoku) => kyoku.entries),
    options,
  );
}

/**
 * 半荘ごとのもとの数を足して、まとめた値を出す（週の集計）。足す半荘は、同じ基準（threshold）で数えたものにそろえる。
 * 半荘が 0 なら、数はすべて 0、値はすべて null。
 */
export function totalAiMetrics(list: readonly AiMetricCounts[]): AiMetrics {
  let decisions = 0;
  let matches = 0;
  let badMoves = 0;
  let scoreSum = 0;
  for (const counts of list) {
    decisions += counts.decisions;
    matches += counts.matches;
    badMoves += counts.badMoves;
    scoreSum += counts.scoreSum;
  }
  return withValues({ decisions, matches, badMoves, scoreSum });
}

/** 率（0 から 1）を百分率で、小数第1位までの文字列にする。例: 0.7233 は "72.3%"。 */
export function formatRatePercent(rate: number): string {
  return `${(rate * 100).toFixed(1)}%`;
}

/** 類似度（0 から 1）を、Rating と同じ書き方（100 倍して小数第1位まで）の文字列にする。例: 0.9298 は "93.0"。 */
export function formatSimilarity(similarity: number): string {
  return formatRating(similarity);
}


