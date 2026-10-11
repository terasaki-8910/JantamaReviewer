/**
 * 副露の並べ方（雀魂と同じ）。鳴いた牌は横向きで、鳴いた相手の方向（上家・対面・下家）の位置に置く。
 * 加槓は、横向きの牌の上に加えた牌を重ねる。暗槓は、両端を裏向きにする。
 */
import type { Fuuro, Seat, Tile } from '@jantama/engine';

export type MeldKind = 'chi' | 'pon' | 'kan' | 'kakan' | 'ankan';

export interface MeldLayout {
  kind: MeldKind;
  /** 並べる牌（左から）。 */
  tiles: Tile[];
  /** 横向きにする牌の位置（0 から）。暗槓は -1（横向きの牌が無い）。 */
  side: number;
  /** 加槓で、横向きの牌の上に重ねる牌。 */
  added?: Tile;
}

/** 副露した席から見た、鳴いた相手の方向: L = 上家（左）、M = 対面（真ん中）、R = 下家（右）。 */
function directionOf(seat: Seat, target: Seat): 'L' | 'M' | 'R' {
  const relative = (target - seat + 4) % 4;
  return relative === 3 ? 'L' : relative === 2 ? 'M' : 'R';
}

/** 鳴いた牌を、鳴いた相手の方向に合わせて、残りの牌の間に入れる。 */
function place(called: Tile, rest: readonly Tile[], direction: 'L' | 'M' | 'R') {
  const at = direction === 'L' ? 0 : direction === 'M' ? 1 : rest.length;
  return { tiles: [...rest.slice(0, at), called, ...rest.slice(at)], side: at };
}

export function layoutMeld(meld: Fuuro, seat: Seat): MeldLayout {
  switch (meld.type) {
    case 'chi':
      return { kind: 'chi', tiles: [meld.pai, ...meld.consumed], side: 0 };
    case 'pon':
      return { kind: 'pon', ...place(meld.pai, meld.consumed, directionOf(seat, meld.target)) };
    case 'daiminkan':
      return { kind: 'kan', ...place(meld.pai, meld.consumed, directionOf(seat, meld.target)) };
    case 'kakan':
      return {
        kind: 'kakan',
        ...place(meld.previous_pon_pai, meld.consumed, directionOf(seat, meld.previous_pon_target)),
        added: meld.pai,
      };
    case 'ankan':
      return { kind: 'ankan', tiles: [...meld.consumed], side: -1 };
  }
}

/** 副露の名前（読み上げ用）。 */
export const MELD_NAME: Readonly<Record<MeldKind, string>> = {
  chi: 'チー',
  pon: 'ポン',
  kan: '大明槓',
  kakan: '加槓',
  ankan: '暗槓',
};
