/**
 * 打牌の判断の受け入れ枚数の比較（F6）。
 * 自分の答え・実戦・AI の 1 位・最大の受け入れ枚数を並べる。枚数は、自分の手牌だけで数えた数（天鳳牌理と同じ）と、
 * 場に見えている牌も除いた「残り」（`details`。E-22）を並べて返す。
 */
import type { Decision } from './decision';
import { type DiscardOption, bestDiscardOptions, discardOptions, findDiscardOption } from './shanten';
import { tenhouPairiUrl } from './tenhou-url';
import type { Tile } from './tiles';
import { type DiscardDetail, discardDetails } from './ukeire-remaining';

export interface DiscardComparison {
  /** 切る牌の種類ごとの、切った後のシャンテン数と受け入れ枚数（手牌の牌の順）。 */
  options: DiscardOption[];
  /** `options` と同じ並びで、受け入れ牌ごとの手牌だけの枚数と、場に見えている牌も除いた残り（E-22）。 */
  details: DiscardDetail[];
  /** 自分の答え（打牌）の結果。答えを渡していないとき、または手牌に無い牌のときは undefined。 */
  answer?: DiscardOption;
  /** 実戦の打牌の結果。実戦が打牌でない（リーチ・鳴きなど）ときは undefined。 */
  actual?: DiscardOption;
  /** AI の 1 位の打牌の結果。1 位が打牌でないときは undefined。 */
  top?: DiscardOption;
  /** 切った後のシャンテン数が最小で、その中で受け入れ枚数が最大のもの（複数あれば全部）。 */
  best: DiscardOption[];
  /** 天鳳牌理の URL（ツモ牌を含む手牌）。 */
  pairiUrl: string;
}

/**
 * 判断の手牌（ツモ牌を含む 3n+2 枚）から、切る牌ごとの受け入れ枚数を比べる。
 * 手牌が 3n+2 枚でない判断（他家の打牌への鳴きなど）では null。
 * answer は自分の答えの打牌（赤五と普通の五は同じ種類として見る）。
 */
export function compareDiscardUkeire(decision: Pick<Decision, 'board' | 'entry'>, answer?: Tile): DiscardComparison | null {
  const { board, entry } = decision;
  const tiles = board.drawn === null ? [...board.hand] : [...board.hand, board.drawn];
  if (tiles.length % 3 !== 2) return null;
  const options = discardOptions(tiles);
  const top = entry.details[0]?.action;
  const result: DiscardComparison = {
    options,
    details: discardDetails(board, options),
    best: bestDiscardOptions(options),
    pairiUrl: tenhouPairiUrl(tiles),
  };
  if (answer !== undefined) {
    const found = findDiscardOption(options, answer);
    if (found) result.answer = found;
  }
  if (entry.actual.type === 'dahai') {
    const found = findDiscardOption(options, entry.actual.pai);
    if (found) result.actual = found;
  }
  if (top && top.type === 'dahai') {
    const found = findDiscardOption(options, top.pai);
    if (found) result.top = found;
  }
  return result;
}
