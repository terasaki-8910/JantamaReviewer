/**
 * 受け入れの「残り」（E-22、R10-6）。
 *
 * 受け入れ枚数（E-3）は、自分の手牌だけで数える（天鳳牌理と同じ）。ここでは、それに並べて、場に見えている牌も除いた
 * 「残り」を数える。受け入れ牌 1 種類ごとに:
 *
 *   残り = 4 − （切ったあとの自分の手牌の中の枚数）− （場に見えている枚数） （0 未満にしない）
 *
 * 場に見えている牌は、次のものを 1 枚ずつ数える（同じ牌を 2 度数えない）:
 * - 全員の河。ただし、他家に鳴かれた牌は、河では数えず、鳴いた副露の中で数える
 * - 全員の副露（チー・ポン・大明槓は、鳴いた牌も含めて、暗槓は 4 枚、加槓は加えた牌も含めて）
 * - ドラ表示牌
 * - 評価する打牌で切る牌（まだ河に出ていないが、切れば見える牌なので、見えているものとして数える）
 * 赤五は、普通の五と同じ種類として数える。自分の手牌（閉じた手）の中の牌は、「切ったあとの自分の手牌」で数えるので、ここには含めない。
 */
import type { BoardState } from './replay';
import type { Fuuro } from './report-types';
import { type DiscardOption, discardOptions } from './shanten';
import { type Tile, TILE_KIND_COUNT, countTiles, tileKind } from './tiles';

/** 副露 1 つを作っている牌（鳴いた牌も含む）。 */
export function meldTiles(meld: Fuuro): Tile[] {
  switch (meld.type) {
    case 'chi':
    case 'pon':
    case 'daiminkan':
      return [meld.pai, ...meld.consumed];
    case 'kakan':
      // ポンの 3 枚（鳴いた牌 + 手牌から出した牌）と、加えた 1 枚
      return [meld.previous_pon_pai, ...meld.consumed, meld.pai];
    case 'ankan':
      return [...meld.consumed];
  }
}

/** 場に見えている牌の種類ごとの枚数（長さ 34）。自分の閉じた手牌と、評価する打牌は含まない。 */
export function visibleTileCounts(board: Pick<BoardState, 'rivers' | 'melds' | 'doraMarkers'>): number[] {
  const counts = new Array<number>(TILE_KIND_COUNT).fill(0);
  const add = (tile: Tile) => {
    const kind = tileKind(tile);
    counts[kind] = (counts[kind] as number) + 1;
  };
  for (const river of board.rivers) {
    // 鳴かれた牌は、副露の側で数える
    for (const entry of river) if (entry.calledBy === null) add(entry.tile);
  }
  for (const melds of board.melds) for (const meld of melds) meldTiles(meld).forEach(add);
  board.doraMarkers.forEach(add);
  return counts;
}

/** 受け入れ牌 1 種類の枚数。 */
export interface AcceptedDetail {
  /** 赤でない牌の表記。 */
  tile: Tile;
  /** 牌の種類（0..33）。 */
  kind: number;
  /** 手牌だけで数えた枚数（E-3。天鳳牌理と同じ）。 */
  count: number;
  /** 場に見えている牌も除いた残り（0 未満にしない）。 */
  remaining: number;
}

/** 切る牌 1 種類の、切ったあとの結果。受け入れの枚数（手牌だけ）と残り（場も除く）を並べる。 */
export interface DiscardDetail {
  /** 切る牌（赤でない表記。手牌に同じ種類が複数あっても 1 つ）。 */
  tile: Tile;
  kind: number;
  /** 切ったあとのシャンテン数。 */
  shanten: number;
  /** 受け入れ枚数の合計（手牌だけで数える）。 */
  ukeire: number;
  /** 残りの合計（場に見えている牌も除く）。 */
  remaining: number;
  accepted: AcceptedDetail[];
}

/**
 * 判断の盤面（ツモ牌を含む 3n+2 枚の手牌）で、切る牌の種類ごとの、切ったあとのシャンテン数・受け入れ枚数・残りを返す。
 * 並びは手牌の牌の順（萬子・筒子・索子・字牌）。手牌が 3n+2 枚でない判断（他家の打牌への鳴きなど）では空。
 * `options` は、同じ手牌で数えた `discardOptions` の結果（渡せば、数え直さない）。
 */
export function discardDetails(
  board: Pick<BoardState, 'hand' | 'drawn' | 'rivers' | 'melds' | 'doraMarkers'>,
  options?: readonly DiscardOption[],
): DiscardDetail[] {
  const tiles = board.drawn === null ? [...board.hand] : [...board.hand, board.drawn];
  if (tiles.length % 3 !== 2) return [];
  const own = countTiles(tiles);
  const visible = visibleTileCounts(board);
  return (options ?? discardOptions(tiles)).map((option) => {
    const accepted = option.accepted.map((a): AcceptedDetail => {
      const discarded = a.kind === option.kind ? 1 : 0;
      const have = (own[a.kind] as number) - discarded;
      const seen = (visible[a.kind] as number) + discarded;
      return { tile: a.tile, kind: a.kind, count: a.remaining, remaining: Math.max(0, 4 - have - seen) };
    });
    return {
      tile: option.tile,
      kind: option.kind,
      shanten: option.shanten,
      ukeire: option.ukeire,
      remaining: accepted.reduce((sum, a) => sum + a.remaining, 0),
      accepted,
    };
  });
}

/** 切る牌（赤でも普通でも同じ種類として）に対応する結果。無ければ undefined。 */
export function findDiscardDetail(details: readonly DiscardDetail[], tile: Tile): DiscardDetail | undefined {
  const kind = tileKind(tile);
  return details.find((d) => d.kind === kind);
}
