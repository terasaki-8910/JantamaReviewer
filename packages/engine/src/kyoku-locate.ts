/**
 * スクショから読んだ局・点数を、取り込んだ半荘のどの局に当たるかに結びつける土台（E-17・E-18・E-19、F11）。
 *
 * 画面の中央から読めるのは、局（東2局など）・残りの牌の数・自分の点数で、本場は読めない。
 * 同じ局の名前の局が本場違いで何度もあるので、局の始めの点数との照合で区別する。
 * 局の途中で変わる点数は、自分が出したリーチ棒（1000点）だけなので、
 * 「局の始めの点数」か「そこから、自分のリーチ棒が出たあとの分を引いた点数」に当たれば、その局とみなす。
 */
import { kyokuLabel, kyokuNumber } from './kyoku';
import type { MortalReport } from './report-types';
import { INITIAL_TILES_LEFT, splitKyokus } from './replay';

/** リーチ棒 1 本の点数。 */
const RIICHI_STICK = 1000;

/** スクショ 1 枚から読んだ、局・点数（と、分かれば残りの牌の数）。`CenterText` は、そのまま渡せる。 */
export interface CenterReading {
  wind: 'E' | 'S' | 'W';
  number: number;
  /** 自分の点数。 */
  score: number;
  /** 残りの牌の数。分からなければ省く（リーチ棒の分を引くかどうかを、局のどこかで出したかで決める）。 */
  tilesLeft?: number;
}

/** 取り込んだ半荘の 1 局について、スクショとの照合に使うこと。 */
export interface KyokuFacts {
  /** 何番目の局か（review.kyokus の添字）。 */
  position: number;
  /** 局の通し番号（東1局が 0）。 */
  kyoku: number;
  honba: number;
  /** 局の名前。例: 東2局1本場。 */
  label: string;
  /** 本人の、局の始めの点数。 */
  startScore: number;
  /**
   * 本人のリーチ棒が成立した（宣言牌が通った）ときの残りのツモ枚数。成立した順。
   * 牌譜（mjai_log）から数える。この局の牌譜が見つからなければ空。
   */
  riichiTilesLeft: readonly number[];
}

/** 結果 JSON から、局ごとの照合に使うことを作る（review.kyokus の順）。 */
export function kyokuFactsOf(report: MortalReport): KyokuFacts[] {
  const logs = new Map(
    splitKyokus(report.mjai_log).map((log) => [`${kyokuNumber(log.start.bakaze, log.start.kyoku)}:${log.start.honba}`, log] as const),
  );
  return report.review.kyokus.map((k, position) => {
    const riichiTilesLeft: number[] = [];
    const log = logs.get(`${k.kyoku}:${k.honba}`);
    if (log) {
      let tilesLeft = INITIAL_TILES_LEFT;
      for (const event of log.events) {
        if (event.type === 'tsumo') tilesLeft--;
        else if (event.type === 'reach_accepted' && event.actor === report.player_id) riichiTilesLeft.push(tilesLeft);
      }
    }
    return {
      position,
      kyoku: k.kyoku,
      honba: k.honba,
      label: kyokuLabel(k.kyoku, k.honba),
      startScore: k.relative_scores[0] ?? 0,
      riichiTilesLeft,
    };
  });
}

/**
 * 読んだ局・点数が、この局に当たるか。
 * - 局の名前（場風と局の番号）が同じ
 * - 点数が、局の始めの点数と同じか、そこから自分のリーチ棒の分（1000点ずつ）を引いた点数
 *   リーチ棒の分を引けるのは、読んだ時点（残りの牌の数）で、自分のリーチ棒がもう出ていたとき。
 *   残りの牌の数が無ければ、局のどこかで出していれば引ける。
 */
export function kyokuFits(facts: KyokuFacts, reading: CenterReading): boolean {
  if (facts.kyoku !== kyokuNumber(reading.wind, reading.number)) return false;
  const diff = facts.startScore - reading.score;
  if (diff < 0 || diff % RIICHI_STICK !== 0) return false;
  if (diff === 0) return true;
  const { tilesLeft } = reading;
  const sticksOut =
    tilesLeft === undefined ? facts.riichiTilesLeft.length : facts.riichiTilesLeft.filter((left) => left >= tilesLeft).length;
  return diff / RIICHI_STICK <= sticksOut;
}

/** 読んだ局・点数に当たる局（半荘の順）。無ければ空、本場違いで点数が同じ局が続くときは複数。 */
export function locateKyokus(facts: readonly KyokuFacts[], reading: CenterReading): KyokuFacts[] {
  return facts.filter((f) => kyokuFits(f, reading));
}
