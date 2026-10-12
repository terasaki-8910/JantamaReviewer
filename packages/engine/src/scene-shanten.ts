/**
 * 場面の向聴数（E-21、SPEC F3）。
 *
 * 局面の種類（「2向聴」など）に使う数は、その場面の手で数える（天鳳牌理と同じ数え方）:
 * - 打牌の判断（打牌・リーチ・自分の手番のカン・ツモ和了。手牌が 3n+2 枚）: ツモったあとの手から、切る牌ごとの
 *   向聴数の最小（いちばん進む打牌のあとの数）。結果 JSON の `shanten` は、ツモる前の手のものなので、
 *   ツモで進む場面（2 → 1 など）では、ここで数えた値のほうが 1 小さい
 * - 鳴きの判断（チー・ポン・大明槓・ロンと、そのスルー。手牌が 3n+1 枚）: 鳴く前の手（そのまま）の数
 *
 * 判断の種類ではなく手牌の枚数で分けるのは、同じことを言い換えたもの（鳴きの判断は他家の打牌に対するので、いつも 3n+1 枚）で、
 * チー・ポンのあとの打牌（ツモ牌が無く、手牌が 3n+2 枚）も、打牌の判断として数えられるため。
 */
import type { BoardState } from './replay';
import { shantenOfCounts } from './shanten';
import { type Tile, TILE_KIND_COUNT, countTiles } from './tiles';

/** 手牌が 3n+2 枚のときの、切る牌ごとの向聴数の最小。種類ごとの枚数（長さ 34）を渡す。 */
function minDiscardShantenOfCounts(counts: number[]): number {
  let best = Number.POSITIVE_INFINITY;
  for (let kind = 0; kind < TILE_KIND_COUNT; kind++) {
    const have = counts[kind] as number;
    if (have === 0) continue;
    counts[kind] = have - 1;
    best = Math.min(best, shantenOfCounts(counts));
    counts[kind] = have;
  }
  return best;
}

/**
 * 手牌（ツモ牌を含む）から、場面の向聴数を求める。3n+2 枚なら切る牌ごとの最小、3n+1 枚ならそのままの数。
 * 0 は聴牌。枚数が 3n+1・3n+2 枚（1〜14枚）でなければ RangeError。
 */
export function sceneShantenOfTiles(tiles: readonly Tile[]): number {
  const counts = countTiles(tiles);
  const total = counts.reduce((a, b) => a + b, 0);
  if (total % 3 === 2) return minDiscardShantenOfCounts(counts);
  return shantenOfCounts(counts);
}

/** 盤面（判断の時点）の場面の向聴数。ツモ牌があれば手牌に含めて数える。 */
export function sceneShanten(board: Pick<BoardState, 'hand' | 'drawn'>): number {
  const tiles = board.drawn === null ? board.hand : [...board.hand, board.drawn];
  return sceneShantenOfTiles(tiles);
}
