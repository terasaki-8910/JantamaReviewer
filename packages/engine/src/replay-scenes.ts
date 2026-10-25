/**
 * 半荘を通して見る画面（F12）の「場面」: 迷いと悪手の場面（E-26、R10-4）。
 *
 * - 不一致の場面: 既定は、実戦の行動の確率が基準（設定の「悪手の基準」。既定 5%）未満の判断（`big`。F2 の悪手と同じ）。
 *   設定「AI の1位と違う判断も、不一致として出す」を入れると、AI の1位と違う判断（結果の `is_equal` が偽のもの）もすべて出す（`other`）。
 *   出題（F2・E-24）の問題の選び方は、この設定では変わらない（`listProblems` はここを使わない）
 * - 迷いの場面: 迷いマークを結びつけた判断（結びつけは、半荘のページと同じ。推定でも、ユーザーが選んだものでもよい）
 * 場面は、半荘の順に並べる（確率の順には並べない。答える前に、AI の情報を画面に出さないため）。
 */
import type { Decision } from './decision';
import { actualProbability, DEFAULT_DISAGREEMENT_THRESHOLD } from './disagreement';
import { isFineMiss } from './fine-miss';
import { keyOfDecision } from './problems';
import type { ReplayTimeline } from './replay-timeline';

/** 不一致の種類。big = 確率が基準未満（悪手）、other = それ以外の、AI の1位と違う判断。 */
export type MismatchKind = 'big' | 'other';

export interface ReplayMismatchOptions {
  /** AI の1位と違う判断も、悪手の段の飛び先に入れる（設定。既定は切）。 */
  includeAll?: boolean;
}

/** 判断が不一致の場面なら、その種類。そうでなければ null。 */
export function mismatchKindOf(decision: Pick<Decision, 'entry'>, options: ReplayMismatchOptions = {}): MismatchKind | null {
  if (actualProbability(decision.entry) < DEFAULT_DISAGREEMENT_THRESHOLD) return 'big';
  if (options.includeAll === true && !decision.entry.is_equal) return 'other';
  return null;
}

export interface ReplayMismatch {
  decision: Decision;
  kind: MismatchKind;
}

/** 不一致の場面になる判断（半荘の順）。FX-4 は 5 と 8、f9da87cbcd7af5e9 は 19 と 43（既定と、AI の1位と違う判断も出すとき）。 */
export function replayMismatches(decisions: readonly Decision[], options: ReplayMismatchOptions = {}): ReplayMismatch[] {
  const found: ReplayMismatch[] = [];
  for (const decision of decisions) {
    const kind = mismatchKindOf(decision, options);
    if (kind !== null) found.push({ decision, kind });
  }
  return found;
}

/** 場面 1 つ（迷いか不一致か、その両方の判断）。 */
export interface ReplayScene {
  /** 判断の鍵（例: k1h0e12）。 */
  key: string;
  decision: Decision;
  /** 時間軸の中の手の通し番号。 */
  step: number;
  /** この判断に結びついた迷いの番号（小さい順。迷いでなければ空）。 */
  doubts: number[];
  /** 不一致の種類。不一致でなければ null。 */
  mismatch: MismatchKind | null;
  /** 迷いの場面で、実戦の行動が AI の1位と違うか。 */
  fineMiss: boolean;
  /** このセッションで解決済みか。 */
  resolved: boolean;
}

export interface ReplaySceneOptions extends ReplayMismatchOptions {
  /**
   * 迷いマークごとに、結びつけた判断の鍵（`ProblemSource.markKeys` と同じ。迷いの番号は、並びの位置 + 1）。
   * 結びつけが決まっていないものは null。
   */
  markKeys: ReadonlyArray<string | null>;
  /** このセッションで解決済みの判断の鍵。 */
  resolvedKeys?: ReadonlySet<string>;
}

/** 場面の一覧（時間軸の順）。 */
export function listReplayScenes(timeline: ReplayTimeline, decisions: readonly Decision[], options: ReplaySceneOptions): ReplayScene[] {
  const doubtsOf = new Map<string, number[]>();
  options.markKeys.forEach((key, index) => {
    if (key === null) return;
    const list = doubtsOf.get(key) ?? [];
    list.push(index + 1);
    doubtsOf.set(key, list);
  });
  const scenes: ReplayScene[] = [];
  for (const decision of decisions) {
    const key = keyOfDecision(decision);
    const doubts = doubtsOf.get(key) ?? [];
    const mismatch = mismatchKindOf(decision, options);
    if (doubts.length === 0 && mismatch === null) continue;
    const step = timeline.stepOfDecision.get(decision.index);
    if (step === undefined) continue;
    scenes.push({
      key,
      decision,
      step,
      doubts,
      mismatch,
      fineMiss: doubts.length > 0 && isFineMiss(decision),
      resolved: options.resolvedKeys?.has(key) ?? false,
    });
  }
  return scenes.sort((a, b) => a.step - b.step);
}


