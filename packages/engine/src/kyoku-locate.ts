/**
 * スクショから読んだ局・点数を、取り込んだ半荘のどの局に当たるかに結びつける土台（E-17・E-18・E-19、F11）。
 *
 * 画面の中央から読めるのは、局（東2局など）・残りの牌の数・自分の点数で、本場は読めない。
 * 同じ局の名前の局が本場違いで何度もあるので、局の始めの点数との照合で区別する。
 * 局の途中で変わる点数は、自分が出したリーチ棒（1000点）だけなので、
 * 「局の始めの点数」か「そこから、自分のリーチ棒が出たあとの分を引いた点数」に当たれば、その局とみなす。
 *
 * 局の名前が崩れて、風か番号が読めなかったとき（E-28）は、読めた部分だけで局を探す（`locatePartialKyokus`）。
 * 読めた風・番号は局の名前と同じで、点数は同じ決まりで合うもの。読めた部分が少ないほど、当たる局は多くなる。
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
 * 読んだ点数が、この局の始めの点数に当たるか。
 * 点数が、局の始めの点数と同じか、そこから自分のリーチ棒の分（1000点ずつ）を引いた点数。
 * リーチ棒の分を引けるのは、読んだ時点（残りの牌の数）で、自分のリーチ棒がもう出ていたとき。
 * 残りの牌の数が無ければ、局のどこかで出していれば引ける。
 */
function scoreFits(facts: KyokuFacts, score: number, tilesLeft: number | undefined): boolean {
  const diff = facts.startScore - score;
  if (diff < 0 || diff % RIICHI_STICK !== 0) return false;
  if (diff === 0) return true;
  const sticksOut =
    tilesLeft === undefined ? facts.riichiTilesLeft.length : facts.riichiTilesLeft.filter((left) => left >= tilesLeft).length;
  return diff / RIICHI_STICK <= sticksOut;
}

/**
 * 読んだ局・点数が、この局に当たるか。
 * - 局の名前（場風と局の番号）が同じ
 * - 点数が、局の始めの点数と同じか、そこから自分のリーチ棒の分（1000点ずつ）を引いた点数
 *   リーチ棒の分を引けるのは、読んだ時点（残りの牌の数）で、自分のリーチ棒がもう出ていたとき。
 *   残りの牌の数が無ければ、局のどこかで出していれば引ける。
 */
export function kyokuFits(facts: KyokuFacts, reading: CenterReading): boolean {
  if (!Number.isInteger(reading.number) || reading.number < 1 || reading.number > 4) return false;
  if (facts.kyoku !== kyokuNumber(reading.wind, reading.number)) return false;
  return scoreFits(facts, reading.score, reading.tilesLeft);
}

/** 読んだ局・点数に当たる局（半荘の順）。無ければ空、本場違いで点数が同じ局が続くときは複数。 */
export function locateKyokus(facts: readonly KyokuFacts[], reading: CenterReading): KyokuFacts[] {
  return facts.filter((f) => kyokuFits(f, reading));
}

/**
 * 崩れていても読めた部分だけの読み取り（E-28。`PartialCenterText` は、そのまま渡せる）。風・番号・残りの牌の数は、読めたものだけ
 * （読めなければ null か省く）。点数は要る。
 */
export interface PartialCenterReading {
  wind: 'E' | 'S' | 'W' | null;
  number: number | null;
  /** 自分の点数。 */
  score: number;
  /** 残りの牌の数。分からなければ null か省く（リーチ棒の分を引くかどうかを、局のどこかで出したかで決める）。 */
  tilesLeft?: number | null;
}

/** 風（東・南・西）が、局の通し番号（東1局が 0）の何番目の風に当たるか（東 0・南 1・西 2）。 */
function windIndexOf(wind: 'E' | 'S' | 'W'): number {
  return Math.floor(kyokuNumber(wind, 1) / 4);
}

/**
 * 読めた部分が、この局に当たるか（E-28）。読めた風・番号は、局の名前と同じでなければならない（読めなかった部分は問わない）。
 * 点数は、`kyokuFits` と同じ決まり（局の始めの点数と同じか、自分のリーチ棒の分を引いた点数）。
 */
export function kyokuFitsPartial(facts: KyokuFacts, reading: PartialCenterReading): boolean {
  const { wind, number } = reading;
  if (number !== null && (!Number.isInteger(number) || number < 1 || number > 4)) return false;
  if (wind !== null && number !== null) {
    if (facts.kyoku !== kyokuNumber(wind, number)) return false;
  } else if (wind !== null) {
    if (Math.floor(facts.kyoku / 4) !== windIndexOf(wind)) return false;
  } else if (number !== null) {
    if (facts.kyoku % 4 !== number - 1) return false;
  }
  return scoreFits(facts, reading.score, reading.tilesLeft ?? undefined);
}

/** 読めた部分に当たる局（半荘の順）。無ければ空。読めた部分が少ないほど、当たる局は多くなる（点数だけなら、始めの点数が合う局すべて）。 */
export function locatePartialKyokus(facts: readonly KyokuFacts[], reading: PartialCenterReading): KyokuFacts[] {
  return facts.filter((f) => kyokuFitsPartial(f, reading));
}
