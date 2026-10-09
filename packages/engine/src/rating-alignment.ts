/**
 * ウィジェットの評価（〇△✕）と、取り込んだ牌譜の局の突き合わせ（E-7、F0・F10）。
 *
 * ウィジェットはゲームを読まないので、どの局の評価かを知らない。押した順に「何局目」として記録するだけなので、
 * 取り込んだ牌譜の局の順に割り当てる。数が合わないときは、その旨を返す（ずれは画面で直す）。
 */

export type RatingAlignmentStatus = 'exact' | 'tooMany' | 'tooFew';

export interface RatingAlignment<T> {
  /** exact: 評価の数と局の数が同じ。tooMany: 評価が多い。tooFew: 評価が足りない。 */
  status: RatingAlignmentStatus;
  /** 局の数。 */
  handCount: number;
  /** 評価の数。 */
  ratingCount: number;
  /** 局ごとに割り当てた評価（局の順）。評価が足りない局は null。 */
  assigned: (T | null)[];
  /** 局の数を超えた分の評価（押した順の最後のほう）。 */
  extra: T[];
  /** 評価が付かなかった局の番号（0 から）。 */
  missingHands: number[];
  /** 利用者に見せてよい説明。 */
  message: string;
}

/**
 * 評価を、押した順に局へ割り当てる。評価の数が局の数より多い・少ないときは status で返し、
 * できる範囲の割り当て（最初の局から順）も一緒に返す。
 */
export function alignRatings<T>(ratings: readonly T[], handCount: number): RatingAlignment<T> {
  if (!Number.isInteger(handCount) || handCount < 0) throw new RangeError(`局の数は 0 以上の整数です: ${handCount}`);
  const ratingCount = ratings.length;
  const assigned: (T | null)[] = Array.from({ length: handCount }, (_, i) => (i < ratingCount ? (ratings[i] as T) : null));
  const extra = ratings.slice(handCount);
  const missingHands = Array.from({ length: Math.max(0, handCount - ratingCount) }, (_, i) => ratingCount + i);

  if (ratingCount > handCount) {
    return {
      status: 'tooMany',
      handCount,
      ratingCount,
      assigned,
      extra,
      missingHands,
      message: `評価が${ratingCount - handCount}件多いです（評価${ratingCount}件、局${handCount}局）`,
    };
  }
  if (ratingCount < handCount) {
    return {
      status: 'tooFew',
      handCount,
      ratingCount,
      assigned,
      extra,
      missingHands,
      message: `評価が${handCount - ratingCount}件足りません（評価${ratingCount}件、局${handCount}局）`,
    };
  }
  return {
    status: 'exact',
    handCount,
    ratingCount,
    assigned,
    extra,
    missingHands,
    message: `評価${ratingCount}件を${handCount}局に割り当てました`,
  };
}
