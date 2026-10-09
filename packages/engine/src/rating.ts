/**
 * Mortal の Rating（E-12）。mjai-reviewer と同じ式。
 *
 * 判断ごとの点は、AI の 1 位と同じ行動なら 1。違えば、選んだ手の評価値（q_value）を、
 * 候補の最低〜最高で 0〜1 に直した値（最高と最低が近すぎるときは分母を 1e-6 にする）。
 * Rating は、点の平均の 2 乗。局ごとにも、半荘全体でも同じ式で出す。
 */
import type { MortalReport, ReportEntry } from './report-types';

/** 分母の下限（mjai-reviewer の `(max - min).max(1e-6)`）。 */
const MIN_RANGE = 1e-6;

/** 判断 1 件の点（0 から 1）。 */
export function decisionScore(entry: Pick<ReportEntry, 'is_equal' | 'details' | 'actual_index'>): number {
  if (entry.is_equal) return 1;
  const actual = entry.details[entry.actual_index];
  if (!actual) throw new RangeError(`actual_index（${entry.actual_index}）が候補の範囲を出ています`);
  let max = Number.NEGATIVE_INFINITY;
  let min = Number.POSITIVE_INFINITY;
  for (const d of entry.details) {
    if (d.q_value > max) max = d.q_value;
    if (d.q_value < min) min = d.q_value;
  }
  return (actual.q_value - min) / Math.max(max - min, MIN_RANGE);
}

/** 判断の並びの Rating（0 から 1。点の平均の 2 乗）。判断が1つも無ければ null。 */
export function ratingOf(entries: readonly ReportEntry[]): number | null {
  if (entries.length === 0) return null;
  let sum = 0;
  for (const e of entries) sum += decisionScore(e);
  const mean = sum / entries.length;
  return mean * mean;
}

/** 局ごとの Rating（review.kyokus の順）。判断が無い局は null。 */
export function handRatings(report: MortalReport): (number | null)[] {
  return report.review.kyokus.map((k) => ratingOf(k.entries));
}

/** 半荘全体の Rating。判断が1つも無ければ null。 */
export function gameRating(report: MortalReport): number | null {
  return ratingOf(report.review.kyokus.flatMap((k) => k.entries));
}

/** Rating（0 から 1）を 100 倍して小数第1位までの文字列にする。例: 0.8670 は "86.7"。 */
export function formatRating(rating: number): string {
  return (rating * 100).toFixed(1);
}
