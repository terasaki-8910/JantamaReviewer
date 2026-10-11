/**
 * 2シャンテンからの先（E-23、R9-6・R10-6）。
 *
 * 打牌のあとが 2 シャンテンの手（13枚）について、引くと 1 シャンテンに進む牌ごとに、そのあと受け入れ枚数が最大になる打牌と、
 * その受け入れ枚数（どちらも手牌だけで数える。E-3）を返し、引く牌の枚数で重みを付けた平均と最大を出す。
 *
 * - 「1シャンテンに進む牌」は、2 シャンテンの手の受け入れ牌（引くと 1 シャンテンになる牌）。枚数は、手牌だけで数えた枚数（E-3）
 * - その牌を引いた 14 枚から、切って 1 シャンテンのままになる打牌のうち、そのあとの受け入れ枚数がいちばん多いものを選ぶ
 *   （同じ枚数なら、牌の並び（萬子・筒子・索子・字牌）の先のもの）
 * - 平均は、引く牌の枚数で重みを付けた、そのあとの受け入れ枚数の平均（枚数の合計は、2 シャンテンの手の受け入れ枚数と同じ）
 * - 打点・形の良さ・守備・鳴きは見ない。場に見えている牌（残り）も見ない（手牌だけ）
 * - 1 シャンテン以下と 3 シャンテン以上の手には返さない（null）
 */
import { discardOptions, ukeire } from './shanten';
import { type Tile, tileKind } from './tiles';

/** 引く牌 1 種類の行。 */
export interface FollowRow {
  /** 引く牌（赤でない表記）。 */
  tile: Tile;
  /** 引く牌の枚数（手牌だけで数える）。 */
  count: number;
  /** そのあとに切る牌（受け入れ枚数が最大になるもの）。 */
  discard: Tile;
  /** 切ったあとの（1 シャンテンの）受け入れ枚数。 */
  ukeire: number;
}

export interface TwoShantenFollow {
  /** 1 シャンテンに進む牌の枚数の合計（その手の受け入れ枚数）。 */
  total: number;
  /** 1 シャンテンに進む牌の種類の数。 */
  kinds: number;
  /** 引く牌の枚数で重みを付けた、そのあとの受け入れ枚数の平均。 */
  average: number;
  /** そのあとの受け入れ枚数の最大。 */
  max: number;
  rows: FollowRow[];
}

/**
 * 打牌のあとの手（13枚。副露があれば閉じた手の部分）から、2 シャンテンからの先を求める。2 シャンテンでなければ null。
 * 手牌が 3n+1 枚でなければ RangeError。
 */
export function followAfterTwoShanten(tiles13: readonly Tile[]): TwoShantenFollow | null {
  const base = ukeire(tiles13);
  if (base.shanten !== 2) return null;
  const rows: FollowRow[] = [];
  let weight = 0;
  let weighted = 0;
  let max = 0;
  for (const accepted of base.accepted) {
    const after = [...tiles13, accepted.tile];
    // 引いたあとに切って 1 シャンテンになる打牌（2 シャンテンの手に受け入れ牌を足したので、必ずある）
    const options = discardOptions(after).filter((o) => o.shanten === base.shanten - 1);
    let found = options[0];
    for (const option of options) if (found === undefined || option.ukeire > found.ukeire) found = option;
    if (found === undefined) throw new Error(`受け入れ牌 ${accepted.tile} を引いたあとの打牌が見つかりません`);
    const best = found;
    // 検算: 切ったあとの手が 1 シャンテンで、受け入れ枚数が一致する
    const rest = [...after];
    rest.splice(
      rest.findIndex((t) => tileKind(t) === best.kind),
      1,
    );
    const check = ukeire(rest);
    if (check.shanten !== base.shanten - 1 || check.total !== best.ukeire) {
      throw new Error(`2シャンテンからの先の検算が合いません: ${accepted.tile} を引いて ${best.tile} を切る`);
    }
    rows.push({ tile: accepted.tile, count: accepted.remaining, discard: best.tile, ukeire: best.ukeire });
    weight += accepted.remaining;
    weighted += accepted.remaining * best.ukeire;
    max = Math.max(max, best.ukeire);
  }
  if (weight !== base.total) throw new Error('2シャンテンからの先: 枚数の合計が受け入れ枚数と合いません');
  return { total: base.total, kinds: rows.length, average: weighted / weight, max, rows };
}
