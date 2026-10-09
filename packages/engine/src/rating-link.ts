/**
 * 局の評価（〇△✕）の結びつけ（E-18、F10・F11）。
 *
 * ウィジェットの評価は、押した時刻と、押したときのスクショしか持たない（ゲームを読まないため、どの局かを知らない）。
 * 対局後に、スクショの中央から読んだ局で、どの局の評価かを決める。押し忘れた局は、空欄のまま残す。
 *
 * 決め方（決定済み）:
 * - 局が読めて、残りの牌の数が局の始め（66 枚以上）: 次の局が始まったところで、終わった局を評価したので、
 *   読んだ局の「前の局」の評価
 * - 局が読めて、局の途中: 読んだ局の評価
 * - 読めない評価: 読めた評価を基準にして、その前後の間にある、評価の付いていない局へ、押した順に当てはめる
 *   （基準になる評価が無い側は、最初・最後の局から）。入りきらない分は「当てはめられなかった評価」にする
 * 局は、読んだ局の名前と点数で決める（`locateKyokus`）。本場違いで点数も同じで局が1つに決まらないものと、
 * この半荘に合う局が無いものは、読めない評価と同じに扱う。
 *
 * 評価は押した順（`t_ms`）に並べて扱う。次のとおり、順序のおかしいものは基準にしない:
 * - 同じ局に読めた評価が2つ以上ある: あとに押したほうを残す（押し直し）。前のものは当てはめられなかった評価
 * - 読めた局の順が、押した順と食い違う: 最も多く両立する組を基準にし（最長の増加列）、残りは読めない評価と同じに扱う
 * 数が合わないとき（評価が局より多い・少ない）は、`alignRatings`（E-7）と同じ形で返す。
 */
import { type CenterText, type ScreenReading, readingOf } from './center-text';
import { kyokuFactsOf, locateKyokus } from './kyoku-locate';
import type { RatingAlignment, RatingAlignmentStatus } from './rating-alignment';
import type { MortalReport } from './report-types';

/**
 * 局の始めとみなす、残りの牌の数の下限。これ以上なら、最初の一巡（全員が最初のツモをするまで）で、
 * 次の局が始まったところの画面とみなす。
 */
export const HAND_START_TILES_LEFT = 66;

/** 評価 1 件の入力。読み取り（`center` か `lines`）と、押した時刻を持つ記録なら何でも渡せる。 */
export interface RatingLinkInput extends ScreenReading {
  /** 押した時刻（ミリ秒）。押した順に並べるのに使う。 */
  t_ms: number;
}

/**
 * どう当てはめたか。
 * - ocr: スクショで読んだ局（局の途中）の評価
 * - ocr-start: スクショが局の始め（66 枚以上）だったので、読んだ局の前の局の評価
 * - order: 読めない（局が決まらない・順序が合わない）ので、前後の評価と押した順で当てはめた
 */
export type RatingPlacementHow = 'ocr' | 'ocr-start' | 'order';

/**
 * 当てはめられなかった理由。
 * - before-first: 最初の局が始まったところのスクショ。前の局が無い
 * - duplicate: 同じ局に、あとからもう1つ評価が付いた（あとのものを残した）
 * - no-room: 前後の評価の間に、評価の付いていない局が足りない
 */
export type RatingUnplacedReason = 'before-first' | 'duplicate' | 'no-room';

/** 評価 1 件の当てはめ結果（押した順）。 */
export interface RatingPlacement<T> {
  rating: T;
  /** 押した順（0 から）。 */
  order: number;
  /** スクショから読んだ中央の文字。読めなければ null。 */
  center: CenterText | null;
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

interface Item<T> {
  rating: T;
  order: number;
  center: CenterText | null;
  /** スクショで決まった局（添字）。決まらなければ null。基準になる評価だけが持つ。 */
  target: number | null;
  start: boolean;
  position: number | null;
  how: RatingPlacementHow | null;
  unplaced: RatingUnplacedReason | null;
}

/** 値が狭義に増える最長の列の添字（同じ長さが複数あるときは、値の小さいほうを残す）。 */
function longestIncreasing(values: readonly number[]): number[] {
  const tails: number[] = [];
  const prev: number[] = new Array<number>(values.length).fill(-1);
  for (let i = 0; i < values.length; i++) {
    const v = values[i] as number;
    let lo = 0;
    let hi = tails.length;
    while (lo < hi) {
      const mid = (lo + hi) >> 1;
      if ((values[tails[mid] as number] as number) < v) lo = mid + 1;
      else hi = mid;
    }
    if (lo > 0) prev[i] = tails[lo - 1] as number;
    tails[lo] = i;
  }
  const out: number[] = [];
  for (let k = tails.length > 0 ? (tails[tails.length - 1] as number) : -1; k >= 0; k = prev[k] as number) out.push(k);
  return out.reverse();
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
 * 評価を、取り込んだ半荘の局に結びつける。評価は押した順（`t_ms`。同じ時刻は渡した順）に扱う。
 * `assigned` は局ごとの評価（局の順。付いていない局は null）、`extra` は当てはめられなかった評価（押した順）。
 */
export function linkRatings<T extends RatingLinkInput>(report: MortalReport, ratings: readonly T[]): RatingLinking<T> {
  const facts = kyokuFactsOf(report);
  const handCount = facts.length;

  const items: Item<T>[] = ratings
    .map((rating, inputIndex) => ({ rating, inputIndex }))
    .sort((a, b) => a.rating.t_ms - b.rating.t_ms || a.inputIndex - b.inputIndex)
    .map(({ rating }, order) => ({
      rating,
      order,
      center: readingOf(rating),
      target: null,
      start: false,
      position: null,
      how: null,
      unplaced: null,
    }));

  // 1. スクショで局が1つに決まるものは、基準の候補にする（局の始めなら前の局）
  for (const item of items) {
    if (item.center === null) continue;
    const matched = locateKyokus(facts, item.center);
    if (matched.length !== 1) continue;
    const position = (matched[0] as { position: number }).position;
    const start = item.center.tilesLeft >= HAND_START_TILES_LEFT;
    if (start && position === 0) item.unplaced = 'before-first';
    else {
      item.target = start ? position - 1 : position;
      item.start = start;
    }
  }

  // 2. 同じ局に基準の候補が2つ以上あれば、あとに押したものを残す
  const lastOfTarget = new Map<number, Item<T>>();
  for (const item of items) if (item.target !== null) lastOfTarget.set(item.target, item);
  for (const item of items) {
    if (item.target !== null && lastOfTarget.get(item.target) !== item) {
      item.target = null;
      item.unplaced = 'duplicate';
    }
  }

  // 3. 押した順と局の順が食い違うものは、最も多く両立する組だけを基準にし、残りは基準にしない
  const anchors = items.filter((item) => item.target !== null);
  const keep = new Set(longestIncreasing(anchors.map((item) => item.target as number)).map((i) => anchors[i]));
  for (const item of anchors) {
    if (!keep.has(item)) {
      item.target = null;
      item.start = false;
    }
  }

  // 4. 基準の評価を置き、読めない評価は、基準の間の空いた局へ押した順に入れる
  const assigned: (T | null)[] = Array.from({ length: handCount }, () => null);
  const place = (item: Item<T>, position: number, how: RatingPlacementHow): void => {
    assigned[position] = item.rating;
    item.position = position;
    item.how = how;
  };
  let nextFree = 0;
  let pending: Item<T>[] = [];
  const flush = (limit: number): void => {
    for (const item of pending) {
      if (nextFree < limit) place(item, nextFree++, 'order');
      else item.unplaced = 'no-room';
    }
    pending = [];
  };
  for (const item of items) {
    if (item.unplaced !== null) continue;
    if (item.target === null) {
      pending.push(item);
      continue;
    }
    flush(item.target);
    place(item, item.target, item.start ? 'ocr-start' : 'ocr');
    nextFree = item.target + 1;
  }
  flush(handCount);

  const extra = items.filter((item) => item.unplaced !== null).map((item) => item.rating);
  const missingHands = assigned.flatMap((a, position) => (a === null ? [position] : []));
  const ratingCount = ratings.length;
  const status = statusOf(ratingCount, handCount);
  return {
    status,
    handCount,
    ratingCount,
    assigned,
    extra,
    missingHands,
    message: messageOf(status, ratingCount, handCount, extra.length, missingHands.length),
    placements: items.map((item) => ({
      rating: item.rating,
      order: item.order,
      center: item.center,
      position: item.position,
      how: item.how,
      unplaced: item.unplaced,
    })),
  };
}
