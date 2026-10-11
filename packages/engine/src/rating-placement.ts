/**
 * 局の評価（〇△✕）の当てはめの結果の型と、結果のまとめ方（E-29、F10・F11）。
 *
 * 評価を局に当てはめる計算そのものは、迷いと評価を押した時刻の順に 1 本に並べて行う `linkTimeline`（timeline-link.ts）。
 * `linkRatings`（rating-link.ts）は、そのうち評価の結果だけを取り出す入口。ここは、その結果の形と、
 * 1 件ずつの当てはめ（`RatingPlacement`）から、局ごとの評価・当てはめられなかった評価・空欄の局・説明をまとめる部分だけを持つ
 * （当てはめの計算と、結果の型を分けて、互いに読み込み合わないようにするため）。
 */
import type { CenterText, PartialCenterText, ScreenReading } from './center-text';
import type { RatingAlignment, RatingAlignmentStatus } from './rating-alignment';

/**
 * 局の始めとみなす、残りの牌の数の下限。これ以上なら、最初の一巡（全員が最初のツモをするまで）で、
 * 次の局が始まったところの画面とみなす（評価は終わった局に付けるので、前の局の評価）。
 */
export const HAND_START_TILES_LEFT = 66;

/** 評価 1 件の入力。読み取り（`center` か `lines`）と、押した時刻を持つ記録なら何でも渡せる。 */
export interface RatingLinkInput extends ScreenReading {
  /** 押した時刻（ミリ秒）。押した順に並べるのに使う。 */
  t_ms: number;
}

/**
 * どう当てはめたか。
 * - ocr: スクショの読み取り（崩れた部分だけのものも含む）に合う局（局の途中）に当てはめた
 * - ocr-start: スクショが局の始め（66 枚以上）だったので、読み取りに合う局の前の局に当てはめた
 * - order: 読み取りが決め手にならない（読めない・合う局が無い）ので、前後の評価・迷いの時刻の並びから当てはめた
 */
export type RatingPlacementHow = 'ocr' | 'ocr-start' | 'order';

/**
 * 当てはめられなかった理由。
 * - before-first: 最初の局が始まったところのスクショ。前の局が無い
 * - duplicate: 同じ局に、あとからもう1つ評価が付いた（押し直し。あとのものを残した）
 * - no-room: 当てはめられる局が無い（前後の評価・迷いの間に空きが無い、読み取りに合う局が無い）。
 *   読み取りと食い違う局に当てはめるより、当てはめないほうを選んだもの
 */
export type RatingUnplacedReason = 'before-first' | 'duplicate' | 'no-room';

/** 評価 1 件の当てはめ結果（押した順）。 */
export interface RatingPlacement<T> {
  rating: T;
  /** 押した順（0 から）。 */
  order: number;
  /** スクショから、局・残りの牌の数・点数がすべて読めたときの中央の文字。そうでなければ null。 */
  center: CenterText | null;
  /** スクショから読めた部分（崩れた部分だけのものも含む）。点数も読めなければ null。 */
  reading: PartialCenterText | null;
  /** 当てはめた局（review.kyokus の添字）。当てはめられなければ null。 */
  position: number | null;
  how: RatingPlacementHow | null;
  unplaced: RatingUnplacedReason | null;
}

/** 評価の結びつけの結果。`RatingAlignment`（E-7）と同じ形に、当てはめ方の記録を足したもの。 */
export interface RatingLinking<T> extends RatingAlignment<T> {
  /** 評価ごとの当てはめ方（押した順）。 */
  placements: RatingPlacement<T>[];
}

function statusOf(ratingCount: number, handCount: number): RatingAlignmentStatus {
  if (ratingCount > handCount) return 'tooMany';
  if (ratingCount < handCount) return 'tooFew';
  return 'exact';
}

function messageOf(status: RatingAlignmentStatus, ratingCount: number, handCount: number, unplaced: number, missing: number): string {
  const counts = `評価${ratingCount}件、局${handCount}局`;
  const detail = unplaced > 0 ? `。うち${unplaced}件は、当てはめられませんでした` : '';
  if (status === 'tooMany') return `評価が${ratingCount - handCount}件多いです（${counts}）${detail}`;
  if (status === 'tooFew') return `評価が${handCount - ratingCount}件足りません（${counts}）${detail}`;
  if (unplaced === 0 && missing === 0) return `評価${ratingCount}件を${handCount}局に割り当てました`;
  return `評価と局は同数です（${counts}）が、${unplaced}件を当てはめられず、${missing}局が空欄です`;
}

/**
 * 1 件ずつの当てはめ（押した順）から、評価の結びつけの結果をまとめる。
 * `assigned` は局ごとの評価（局の順。付いていない局は null）、`extra` は当てはめられなかった評価（押した順）、
 * `missingHands` は評価の付かなかった局。数が合わないとき（評価が局より多い・少ない）は、`alignRatings`（E-7）と同じ形で知らせる。
 */
export function assembleRatingLinking<T>(handCount: number, placements: readonly RatingPlacement<T>[]): RatingLinking<T> {
  const assigned: (T | null)[] = Array.from({ length: handCount }, () => null);
  for (const placement of placements) {
    if (placement.position !== null) assigned[placement.position] = placement.rating;
  }
  const extra = placements.filter((placement) => placement.unplaced !== null).map((placement) => placement.rating);
  const missingHands = assigned.flatMap((a, position) => (a === null ? [position] : []));
  const ratingCount = placements.length;
  const status = statusOf(ratingCount, handCount);
  return {
    status,
    handCount,
    ratingCount,
    assigned,
    extra,
    missingHands,
    message: messageOf(status, ratingCount, handCount, extra.length, missingHands.length),
    placements: [...placements],
  };
}
