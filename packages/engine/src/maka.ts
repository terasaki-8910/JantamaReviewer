/**
 * MAKA が推した打牌の記録（E-14、F3）。
 *
 * 答え合わせで、MAKA が推した打牌を任意で入れられる。入れると、Mortal の 1 位の行動と同じかどうかが記録され、
 * ログで数えられる。入れなくても答え合わせは進められる。MAKA は自分の答えを出したあとに見る前提。
 */
import type { ActionEvent, ReportEntry } from './report-types';
import { type Tile, isTile, plainTile } from './tiles';

/** MAKA の打牌の記録。 */
export interface MakaRecord {
  /** 入れた MAKA の打牌。入れていなければ null。 */
  move: Tile | null;
  /**
   * Mortal の 1 位と同じか。MAKA の打牌を入れていないときと、Mortal の 1 位が打牌でない（リーチ・鳴き・和了・カン・スルー）
   * ので打牌と比べられないときは null。
   */
  equalsMortalTop: boolean | null;
}

/** Mortal の 1 位の行動（候補の先頭。q_value が最大のもの）。 */
export function mortalTopAction(entry: Pick<ReportEntry, 'details'>): ActionEvent {
  const top = entry.details[0];
  if (!top) throw new RangeError('候補がありません');
  return top.action;
}

/**
 * 判断（entry）と、入れた MAKA の打牌から、記録を作る。
 * 打牌は、赤五と普通の五を同じ牌として比べる（MAKA の表示は赤かどうかで推薦を分けないため）。
 * 牌の表記として正しくない move は RangeError。
 */
export function recordMakaMove(entry: Pick<ReportEntry, 'details'>, move?: Tile | null): MakaRecord {
  if (move === undefined || move === null) return { move: null, equalsMortalTop: null };
  if (!isTile(move)) throw new RangeError(`牌の表記として正しくありません: ${JSON.stringify(move)}`);
  const top = mortalTopAction(entry);
  if (top.type !== 'dahai') return { move, equalsMortalTop: null };
  return { move, equalsMortalTop: plainTile(top.pai) === plainTile(move) };
}

export interface MakaInput {
  entry: Pick<ReportEntry, 'details'>;
  /** 入れた MAKA の打牌（入れていなければ省く）。 */
  makaMove?: Tile | null;
}

/** MAKA の記録の件数。 */
export interface MakaCount {
  /** 判断の数。 */
  total: number;
  /** MAKA の打牌を入れた判断の数。 */
  entered: number;
  /** MAKA の打牌を入れていない判断の数。 */
  notEntered: number;
  /** Mortal の 1 位と同じだった数。 */
  equal: number;
  /** Mortal の 1 位と食い違った数。 */
  different: number;
  /** 入れたが、Mortal の 1 位が打牌でないので比べられなかった数。 */
  notComparable: number;
}

/** 記録の一覧を数える。 */
export function countMakaRecords(records: readonly MakaRecord[]): MakaCount {
  const count: MakaCount = { total: records.length, entered: 0, notEntered: 0, equal: 0, different: 0, notComparable: 0 };
  for (const r of records) {
    if (r.move === null) {
      count.notEntered++;
      continue;
    }
    count.entered++;
    if (r.equalsMortalTop === null) count.notComparable++;
    else if (r.equalsMortalTop) count.equal++;
    else count.different++;
  }
  return count;
}

/** 判断の一覧（と、それぞれに入れた MAKA の打牌）を数える。 */
export function countMakaMoves(items: readonly MakaInput[]): MakaCount {
  return countMakaRecords(items.map((i) => recordMakaMove(i.entry, i.makaMove)));
}
