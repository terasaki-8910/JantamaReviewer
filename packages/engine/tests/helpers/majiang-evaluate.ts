import Majiang from '@kobalab/majiang-core';

import type { Wind } from '../../src/report-types';
import { type WinEvaluation, type WinInput, type YakuHit, type YakuId, type YakuMeld, type YakumanId } from '../../src/yaku';

// 役の調査: @kobalab/majiang-core（MIT。Copyright (c) 2021 Satoshi Kobayashi）の hule で、和了形の役を数える受け口。
// エンジンの牌の持ち方（種類ごとの枚数・副露・風）から majiang-core の手牌の文字列に直し、返ってきた役を、エンジンの役の識別子にする。
// 本番のコードではない（エンジンの src は外の部品に依存しない決まりなので、試験の部品として置く）。

const SUIT_LETTERS = ['m', 'p', 's'] as const;
const WIND_INDEX: Record<Wind, number> = { E: 0, S: 1, W: 2, N: 3 };

/** 牌の種類 → majiang-core の牌（m1・z1 など。字牌は z1 = 東 ... z7 = 中）。 */
export function majiangTile(kind: number): string {
  return kind >= 27 ? `z${kind - 26}` : `${SUIT_LETTERS[Math.floor(kind / 9)]}${(kind % 9) + 1}`;
}

/** 種類ごとの枚数（長さ 34）を、手牌の文字列にする。last を渡すと、その牌を末尾（ツモ牌）に置く。 */
function handText(counts: readonly number[], last: number | null): string {
  const c = [...counts];
  if (last !== null) c[last] = (c[last] as number) - 1;
  let text = '';
  for (let suit = 0; suit < 4; suit++) {
    let seg = '';
    const n = suit < 3 ? 9 : 7;
    for (let i = 0; i < n; i++) seg += String(i + 1).repeat(c[suit * 9 + i] as number);
    if (seg !== '') text += `${suit < 3 ? SUIT_LETTERS[suit] : 'z'}${seg}`;
  }
  return last !== null ? text + majiangTile(last) : text;
}

/** 副露 1 つを majiang-core の面子の文字列にする（鳴いた牌の向きは、役に関わらないので、順子は上家、刻子・槓子は下家で固定）。 */
export function majiangMeld(m: YakuMeld): string {
  const suit = m.first >= 27 ? 'z' : SUIT_LETTERS[Math.floor(m.first / 9)];
  const n = m.first >= 27 ? m.first - 26 : (m.first % 9) + 1;
  if (m.type === 'seq') return `${suit}${n}-${n + 1}${n + 2}`;
  if (m.type === 'tri') return `${suit}${n}${n}${n}+`;
  return m.open ? `${suit}${n}${n}${n}${n}+` : `${suit}${n}${n}${n}${n}`;
}

/** 手牌の文字列（副露つき）。 */
export function majiangHand(counts: readonly number[], melds: readonly YakuMeld[], last: number | null): string {
  return handText(counts, last) + (melds.length > 0 ? `,${melds.map(majiangMeld).join(',')}` : '');
}

const YAKU_BY_NAME: Readonly<Record<string, YakuId>> = {
  立直: 'riichi',
  門前清自摸和: 'tsumo',
  平和: 'pinfu',
  断幺九: 'tanyao',
  一盃口: 'iipeikou',
  二盃口: 'ryanpeikou',
  '翻牌 白': 'yakuhai-haku',
  '翻牌 發': 'yakuhai-hatsu',
  '翻牌 中': 'yakuhai-chun',
  三色同順: 'sanshoku',
  一気通貫: 'ittsu',
  混全帯幺九: 'chanta',
  純全帯幺九: 'junchan',
  七対子: 'chiitoitsu',
  対々和: 'toitoi',
  三暗刻: 'sanankou',
  三色同刻: 'sanshoku-doukou',
  三槓子: 'sankantsu',
  混老頭: 'honroto',
  小三元: 'shosangen',
  混一色: 'honitsu',
  清一色: 'chinitsu',
};

const YAKUMAN_BY_NAME: Readonly<Record<string, YakumanId>> = {
  国士無双: 'kokushi',
  国士無双十三面: 'kokushi',
  四暗刻: 'suuankou',
  四暗刻単騎: 'suuankou',
  大三元: 'daisangen',
  大四喜: 'daisuushi',
  小四喜: 'shosuushi',
  字一色: 'tsuisou',
  緑一色: 'ryuisou',
  清老頭: 'chinroto',
  四槓子: 'suukantsu',
  九蓮宝燈: 'chuuren',
  純正九蓮宝燈: 'chuuren',
};

/** majiang-core の役の名前 → エンジンの役の識別子。ドラ・裏ドラ・赤ドラは役ではないので null。知らない名前は例外。 */
export function yakuIdOfMajiang(name: string): YakuId | null {
  if (name === 'ドラ' || name === '赤ドラ' || name === '裏ドラ') return null;
  if (name.startsWith('場風')) return 'yakuhai-round';
  if (name.startsWith('自風')) return 'yakuhai-seat';
  const id = YAKU_BY_NAME[name];
  if (id === undefined) throw new Error(`知らない役の名前: ${name}`);
  return id;
}

/** majiang-core の hule で、和了を評価する（`evaluateWin` と同じ入出力）。 */
export function majiangEvaluate(input: WinInput): WinEvaluation {
  const closed = input.melds.every((m) => !m.open);
  const param = Majiang.Util.hule_param({
    zhuangfeng: WIND_INDEX[input.roundWind],
    menfeng: WIND_INDEX[input.seatWind],
    lizhi: input.riichi && closed ? 1 : 0,
  });
  let shoupai;
  let rongpai: string | undefined;
  if (input.tsumo) {
    shoupai = Majiang.Shoupai.fromString(majiangHand(input.counts, input.melds, input.winKind));
  } else {
    const counts = [...input.counts];
    counts[input.winKind] = (counts[input.winKind] as number) - 1;
    shoupai = Majiang.Shoupai.fromString(majiangHand(counts, input.melds, null));
    rongpai = `${majiangTile(input.winKind)}=`;
  }
  const result = Majiang.Util.hule(shoupai, rongpai, param);
  if (result === undefined) return { kind: 'none', yakuman: [], hits: [], han: 0, fu: 0, ties: 0 };
  if (result.damanguan !== undefined && result.hupai !== undefined) {
    const yakuman = [...new Set(result.hupai.map((h) => YAKUMAN_BY_NAME[h.name]).filter((y): y is YakumanId => y !== undefined))];
    return { kind: 'regular', yakuman, hits: [], han: 13 * (result.damanguan ?? 1), fu: 0, ties: 1 };
  }
  const hits: YakuHit[] = [];
  for (const h of result.hupai ?? []) {
    const id = yakuIdOfMajiang(h.name);
    if (id !== null) hits.push({ id, han: Number(h.fanshu) });
  }
  return { kind: 'regular', yakuman: [], hits, han: hits.reduce((a, h) => a + h.han, 0), fu: result.fu ?? 0, ties: 1 };
}

/** majiang-core の tingpai（待ち）を、種類の番号にする。手牌（副露を除く）に 4 枚あるものは、majiang-core が数えない。 */
export function majiangWaits(counts: readonly number[], melds: readonly YakuMeld[]): number[] {
  const waits = Majiang.Util.tingpai(Majiang.Shoupai.fromString(majiangHand(counts, melds, null))) ?? [];
  return waits.map((p) => (p.startsWith('z') ? 26 + Number(p[1]) : SUIT_LETTERS.indexOf(p[0] as 'm') * 9 + Number(p[1]) - 1)).sort((a, b) => a - b);
}
