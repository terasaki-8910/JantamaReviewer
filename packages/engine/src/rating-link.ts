/**
 * 局の評価（〇△✕）の結びつけ（E-29、F10・F11）。
 *
 * ウィジェットの評価は、押した時刻と、押したときのスクショしか持たない（ゲームを読まないため、どの局かを知らない）。
 * 対局後に、迷いと評価を押した時刻の順に 1 本に並べて、スクショから読めたもの（崩れて読めた部分も）と、ユーザーが選んだ迷いの結びつけに合わせて、
 * どの局の評価かを決める（`linkTimeline`。決まりと費用は timeline-link.ts に書いてある）。押し忘れた局は、空欄のまま残す。
 *
 * 決め方の要点（E-29）:
 * - 評価のあとに押した迷い・評価は、その評価の局より後の局。迷いのあとに押したものは、その迷いの局か、それより後の局
 * - 局が読めて、残りの牌の数が局の始め（66 枚以上）: 次の局が始まったところで、終わった局を評価したので、読んだ局の「前の局」の評価
 * - 局が読めて、局の途中: 読んだ局の評価。局の名前が崩れていても、点数などで局が決まるものは、その局
 * - 読めない評価は、前後の評価・迷いの間の、早い局に当てはめる。読み取りと食い違う局に当てはめるより、当てはめないほうを選ぶ。
 *   同じ局に 2 つ当たるときは、あとに押したほうを残す（押し直し）
 * 数が合わないとき（評価が局より多い・少ない）は、`alignRatings`（E-7）と同じ形で返す。
 */
import type { RatingLinkInput, RatingLinking } from './rating-placement';
import type { MortalReport } from './report-types';
import { type TimelineMarkInput, linkTimeline } from './timeline-link';

export {
  HAND_START_TILES_LEFT,
  type RatingLinkInput,
  type RatingLinking,
  type RatingPlacement,
  type RatingPlacementHow,
  type RatingUnplacedReason,
} from './rating-placement';

/**
 * 評価を、取り込んだ半荘の局に結びつける。評価は押した順（`t_ms`。同じ時刻は渡した順）に扱う。
 * `marks` は、同じ半荘の迷い（読み取りと押した時刻、あればユーザーが選んだ結びつけ）。迷いの局は、評価の当てはめの手がかりになる
 * （評価のあとの迷いは、評価より後の局）。迷いが無ければ、評価だけで当てはめる。
 * `assigned` は局ごとの評価（局の順。付いていない局は null）、`extra` は当てはめられなかった評価（押した順）。
 */
export function linkRatings<T extends RatingLinkInput>(
  report: MortalReport,
  ratings: readonly T[],
  marks: readonly TimelineMarkInput[] = [],
): RatingLinking<T> {
  return linkTimeline(report, { marks, ratings }).ratings;
}
