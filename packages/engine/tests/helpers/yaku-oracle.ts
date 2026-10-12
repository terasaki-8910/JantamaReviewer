import type { Wind } from '../../src/report-types';
import { countTiles, parseTenhouNotation } from '../../src/tiles';
import type { YakuId, YakuMeld, YakuShape } from '../../src/yaku';

/**
 * Python の mahjong ライブラリの役の名前 → 役の識別子。場風・自風の役牌は、牌によって名前が分かれるので、まとめる。
 * ここに無い名前（ドラなど）は、テストで失敗にする（見落とさないため）。
 */
export const ORACLE_YAKU_IDS: Readonly<Record<string, YakuId>> = {
  Riichi: 'riichi',
  'Menzen Tsumo': 'tsumo',
  Pinfu: 'pinfu',
  Tanyao: 'tanyao',
  Iipeiko: 'iipeikou',
  Ryanpeikou: 'ryanpeikou',
  'Yakuhai (haku)': 'yakuhai-haku',
  'Yakuhai (hatsu)': 'yakuhai-hatsu',
  'Yakuhai (chun)': 'yakuhai-chun',
  'Yakuhai (seat wind east)': 'yakuhai-seat',
  'Yakuhai (seat wind south)': 'yakuhai-seat',
  'Yakuhai (seat wind west)': 'yakuhai-seat',
  'Yakuhai (seat wind north)': 'yakuhai-seat',
  'Yakuhai (round wind east)': 'yakuhai-round',
  'Yakuhai (round wind south)': 'yakuhai-round',
  'Yakuhai (round wind west)': 'yakuhai-round',
  'Yakuhai (round wind north)': 'yakuhai-round',
  'Sanshoku Doujun': 'sanshoku',
  Ittsu: 'ittsu',
  Chantai: 'chanta',
  Junchan: 'junchan',
  Chiitoitsu: 'chiitoitsu',
  Toitoi: 'toitoi',
  'San Ankou': 'sanankou',
  'Sanshoku Doukou': 'sanshoku-doukou',
  'San Kantsu': 'sankantsu',
  Honroutou: 'honroto',
  'Shou Sangen': 'shosangen',
  Honitsu: 'honitsu',
  Chinitsu: 'chinitsu',
};

/** 正解表の和了の記録 1 件（generate_yaku.py）。 */
export interface OracleWin {
  closed: string;
  melds: [string, number, boolean][];
  win: number;
  tsumo: boolean;
  riichi: boolean;
  seat: Wind;
  round: Wind;
  theme?: string;
  game?: string;
  kyoku?: string;
  actor?: number;
  me?: boolean;
  oracle: { error: string | null; yaku: string[]; han: number; fu?: number; yakuman: boolean };
}

/** 正解表の聴牌の手 1 件。waits のキーは待ちの牌の種類。 */
export interface OracleTenpai {
  closed: string;
  melds: [string, number, boolean][];
  riichi: boolean;
  seat: Wind;
  round: Wind;
  theme?: string;
  yakuman: boolean;
  waits: Record<string, { error: string | null; yaku: string[]; han: number; fu?: number; yakuman: boolean }>;
}

export interface YakuOracleFixture {
  library: string;
  complete: OracleWin[];
  tenpai: OracleTenpai[];
  wins: OracleWin[];
}

export function meldsOf(raw: readonly [string, number, boolean][]): YakuMeld[] {
  return raw.map(([type, first, open]) => ({ type: type as YakuMeld['type'], first, open }));
}

/** 正解表の閉じた手牌（天鳳の牌理の表記）と副露・風から、役の判定の入力にする。 */
export function shapeOf(record: Pick<OracleWin, 'closed' | 'melds' | 'seat' | 'round'>): YakuShape {
  return { counts: countTiles(parseTenhouNotation(record.closed)), melds: meldsOf(record.melds), seatWind: record.seat, roundWind: record.round };
}

/** 正解表の役の名前を識別子の並び（並べ替え済み）にする。知らない名前があれば例外。 */
export function oracleIds(names: readonly string[]): YakuId[] {
  return names
    .map((n) => {
      const id = ORACLE_YAKU_IDS[n];
      if (id === undefined) throw new Error(`知らない役の名前: ${n}`);
      return id;
    })
    .sort();
}
