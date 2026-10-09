/**
 * 局の結果と、局のAI基準の暫定の〇△✕（E-6、F10）。
 *
 * 結果は、局の終わり（review.kyokus[].end_status）を、レビューした本人から見て分類する。
 * 暫定の〇△✕は、AI の確率が基準（5%）未満の判断の数から決める: 0 なら〇、1 なら△、2 以上なら✕。
 */
import { actualProbability, DEFAULT_DISAGREEMENT_THRESHOLD } from './disagreement';
import { kyokuLabel } from './kyoku';
import { ratingOf } from './rating';
import type { EndStatusEvent, MortalReport, ReportEntry, Seat } from './report-types';

/**
 * 局の結果の分類（本人から見て）。
 * - win: 自分の和了（ツモ・ロン）
 * - dealIn: 放銃（自分が他家に打ち込んだ）
 * - draw: 流局
 * - othersTsumo: 他家のツモ和了
 * - othersRon: 他家どうしのロン（自分は関係しない）
 */
export type HandOutcomeKind = 'win' | 'dealIn' | 'draw' | 'othersTsumo' | 'othersRon';

export interface HandOutcome {
  kind: HandOutcomeKind;
  /** 本人の点数の増減（局の終わりの deltas の本人の分。供託・本場の分を含む）。 */
  delta: number;
}

/** 局の結果を、本人から見て分類する。和了が複数あるとき（ダブロン）は、本人の和了・放銃を優先する。 */
export function classifyHandOutcome(endStatus: readonly EndStatusEvent[], playerId: Seat): HandOutcome {
  const delta = endStatus.reduce((sum, e) => sum + (e.deltas[playerId] ?? 0), 0);
  const horas = endStatus.filter((e): e is EndStatusEvent & { type: 'hora' } => e.type === 'hora');
  if (horas.length === 0) return { kind: 'draw', delta };
  if (horas.some((h) => h.actor === playerId)) return { kind: 'win', delta };
  if (horas.some((h) => h.target === playerId)) return { kind: 'dealIn', delta };
  if (horas.some((h) => h.actor === h.target)) return { kind: 'othersTsumo', delta };
  return { kind: 'othersRon', delta };
}

/** 局の〇△✕（ウィジェットで付ける自己評価と同じ値。〇 = good、△ = fair、✕ = bad）。 */
export type HandMark = 'good' | 'fair' | 'bad';

/** AI の確率が基準未満の判断の数から、暫定の〇△✕を決める。0 なら〇、1 なら△、2 以上なら✕。 */
export function provisionalMark(lowProbCount: number): HandMark {
  if (lowProbCount <= 0) return 'good';
  if (lowProbCount === 1) return 'fair';
  return 'bad';
}

/** 実戦の行動の確率が threshold 未満の判断の数。 */
export function countLowProbDecisions(
  entries: readonly Pick<ReportEntry, 'details' | 'actual_index'>[],
  threshold: number = DEFAULT_DISAGREEMENT_THRESHOLD,
): number {
  let count = 0;
  for (const e of entries) if (actualProbability(e) < threshold) count++;
  return count;
}

/** 1 局分のまとめ（局の評価の比較の画面の行）。 */
export interface KyokuSummary {
  /** 何番目の局か（0 から）。 */
  position: number;
  /** 局の通し番号（東1局が 0）。 */
  kyoku: number;
  honba: number;
  label: string;
  outcome: HandOutcome;
  decisionCount: number;
  /** AI の確率が基準未満の判断の数。 */
  lowProbCount: number;
  /** 暫定のAI基準の〇△✕。 */
  provisionalMark: HandMark;
  /** その局の Mortal の Rating（0 から 1）。判断が無い局は null。 */
  rating: number | null;
}

/** 局ごとのまとめ（review.kyokus の順）。 */
export function summarizeKyokus(report: MortalReport, options: { threshold?: number } = {}): KyokuSummary[] {
  const threshold = options.threshold ?? DEFAULT_DISAGREEMENT_THRESHOLD;
  return report.review.kyokus.map((k, position) => {
    const lowProbCount = countLowProbDecisions(k.entries, threshold);
    return {
      position,
      kyoku: k.kyoku,
      honba: k.honba,
      label: kyokuLabel(k.kyoku, k.honba),
      outcome: classifyHandOutcome(k.end_status, report.player_id),
      decisionCount: k.entries.length,
      lowProbCount,
      provisionalMark: provisionalMark(lowProbCount),
      rating: ratingOf(k.entries),
    };
  });
}
