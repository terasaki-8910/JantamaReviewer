/**
 * 副露の気配（F14、E-39。R16-6 の B）。答え合わせのタブ「守備」に出す、リーチしていない他家の副露の 1 行。
 *
 * 牌ごとの分類は出さない（リーチした人にだけ出す。danger.ts）。副露した他家には、次の人を対象にして、見出しの 1 行だけを出す。
 *   - 副露（チー・ポン・大明槓・加槓。暗槓は数えない）が 2 つ以上の人
 *   - 染め手の気配のある人: 副露（暗槓も含む全部）が、同じ 1 色の数牌と字牌だけで、その色を含む副露が 1 つ以上（字牌だけの副露では染め手にならない）あり、
 *     副露が 1 つ以上（暗槓だけでは対象にならない）、河にその色の牌が 1 枚以下
 * リーチした人（宣言した人を含む）は、対象にならない。本人も対象にならない。
 * 行は「下家: 2副露・索子の染め手の気配・役牌の刻子（發）」。副露の数は、いつも出す。染め手の色は気配があるときだけ、
 * 役牌の刻子（場風・自風・白發中のポン・カン。暗槓を含む）は、あるときだけ。
 * 数え方の元は承認済みの見本（16回目の analysis/samples16 の `openSignOf` と `lib/open-danger.ts`）。見ていないもの: ドラ・巡目・点数・河の癖。
 */
import type { BoardState, RiverTile } from './replay';
import type { Fuuro, Seat, Wind } from './report-types';
import { isNumberKind, tileKind } from './tiles';
import { meldTiles } from './ukeire-remaining';

/** 染め手の気配の、河にある色の枚数の上限（これ以下で気配あり）。 */
export const SUIT_RIVER_MAX = 1;

/** 副露の数がこれ以上で、対象になる。 */
export const OPEN_MELDS_TRIGGER = 2;

const SUIT_NAME = ['萬子', '筒子', '索子'] as const;
const HONOR_NAMES = ['東', '南', '西', '北', '白', '發', '中'] as const;
const WIND_ORDER: readonly Wind[] = ['E', 'S', 'W', 'N'];
const RELATION = ['自分', '下家', '対面', '上家'] as const;

/** 他家 1 人の副露の読み。 */
export interface OpenSign {
  seat: Seat;
  /** 副露の数。チー・ポン・大明槓・加槓（暗槓は数えない）。 */
  openMelds: number;
  /** 副露（暗槓も含む）がすべて同じ 1 色の数牌と字牌だけなら、その色（0 = 萬子、1 = 筒子、2 = 索子）。色が 2 色以上、または数牌の副露が無ければ null。 */
  suit: 0 | 1 | 2 | null;
  /** 染め手の気配があるか（副露が 1 つ以上、色が決まっていて、河にその色が `SUIT_RIVER_MAX` 枚以下）。 */
  suitSign: boolean;
  /** 副露にある役牌の種類（27..33。場風・自風・白發中。小さい順）。 */
  yakuhai: number[];
}

/** 他家 1 人の副露の読みを、盤面から作る。 */
export function openSignOf(board: Pick<BoardState, 'melds' | 'rivers' | 'seatWinds' | 'roundWind'>, seat: Seat): OpenSign {
  const melds: readonly Fuuro[] = board.melds[seat] ?? [];
  const suits = new Set<number>();
  const honors = new Set<number>();
  for (const meld of melds) {
    for (const tile of meldTiles(meld)) {
      const kind = tileKind(tile);
      if (isNumberKind(kind)) suits.add(Math.floor(kind / 9));
      else honors.add(kind);
    }
  }
  const openMelds = melds.filter((meld) => meld.type !== 'ankan').length;
  const suit = suits.size === 1 ? ([...suits][0] as 0 | 1 | 2) : null;
  const river: readonly RiverTile[] = board.rivers[seat] ?? [];
  const riverInSuit = suit === null ? 0 : river.filter((entry) => {
    const kind = tileKind(entry.tile);
    return isNumberKind(kind) && Math.floor(kind / 9) === suit;
  }).length;
  const roundKind = 27 + WIND_ORDER.indexOf(board.roundWind);
  const seatKind = 27 + WIND_ORDER.indexOf(board.seatWinds[seat] as Wind);
  const yakuhai = [...honors].filter((kind) => kind >= 31 || kind === roundKind || kind === seatKind).sort((a, b) => a - b);
  return { seat, openMelds, suit, suitSign: openMelds >= 1 && suit !== null && riverInSuit <= SUIT_RIVER_MAX, yakuhai };
}

/** 対象になるか（副露が 2 つ以上、または染め手の気配）。リーチしているかは見ない（呼ぶ側が除く）。 */
export function isOpenTarget(sign: OpenSign): boolean {
  return sign.openMelds >= OPEN_MELDS_TRIGGER || sign.suitSign;
}

/** 1 行の本文（席の名前を除く）。例: 2副露・索子の染め手の気配・役牌の刻子（發）。 */
export function openSignText(sign: OpenSign): string {
  const parts: string[] = [`${sign.openMelds}副露`];
  if (sign.suitSign && sign.suit !== null) parts.push(`${SUIT_NAME[sign.suit]}の染め手の気配`);
  if (sign.yakuhai.length > 0) parts.push(`役牌の刻子（${sign.yakuhai.map((kind) => HONOR_NAMES[kind - 27]).join('・')}）`);
  return parts.join('・');
}

/** 「守備」のタブに出す、副露の 1 人分の 1 行。 */
export interface OpenSignLine {
  seat: Seat;
  /** 自分から見た呼び名（下家・対面・上家）。 */
  who: string;
  sign: OpenSign;
  /** 1 行。例: 下家: 2副露・索子の染め手の気配・役牌の刻子（發）。 */
  text: string;
}

/**
 * 盤面の、副露の気配の 1 行を出す他家（リーチしていない対象の人）。下家・対面・上家の順。リーチしている人（宣言した人を含む）と本人は出さない。
 * 判断の盤面 `Decision.board` で呼ぶ（他家の手牌は使わない）。
 */
export function openSignLinesOf(board: BoardState): OpenSignLine[] {
  const me = board.playerId;
  const lines: OpenSignLine[] = [];
  for (const offset of [1, 2, 3]) {
    const seat = ((me + offset) % 4) as Seat;
    if ((board.riichi[seat] ?? 'none') !== 'none') continue;
    const sign = openSignOf(board, seat);
    if (!isOpenTarget(sign)) continue;
    const who = RELATION[offset] as string;
    lines.push({ seat, who, sign, text: `${who}: ${openSignText(sign)}` });
  }
  return lines;
}
