/**
 * 取り込んだ結果を結びつける半荘を決める（E-19、F1・F11）。
 *
 * 結果（mjai の JSON）には、どのウィジェットの記録かが書いていない。結果がまだ無い半荘（記録した半荘）のうち、
 * スクショから読んだ局と点数が、結果と合うものに結びつける。
 * - 半荘が「合う」: 読めたスクショが1枚以上あり、読めたスクショのすべてが結果と合う
 *   （合う = 読んだ局が結果にあり、点数が局の始めの点数に合う。自分のリーチ棒の分は引いて比べる。`kyokuFits`）
 * - 合う半荘がちょうど1つ: その半荘に結びつける（`match`）
 * - 合うものが無いか2つ以上あるが、結果の無い半荘がある: 一覧から選んでもらう（`choose`。新しい順）
 * - 結果の無い半荘が1つも無い（記録の無い半荘の結果）: 新しい半荘として取り込む（`new`）
 */
import { firstReadable } from './center-text';
import { type CenterReading, kyokuFactsOf, locateKyokus } from './kyoku-locate';
import type { MortalReport } from './report-types';

/**
 * スクショ 1 枚の読み取り。読み取り済みなら `center`（読めなかったら null）、文字認識の行のままなら `lines`
 * （1 回目で読めないときは、`retries` の読み直しの行も試す。E-20）。
 * 照合には局・点数だけを使うので、`center` は残りの牌の数（`tilesLeft`）を省いてもよい。
 */
export interface SessionMark {
  center?: CenterReading | null;
  lines?: readonly string[];
  retries?: readonly (readonly string[])[];
}

/** 結果がまだ無い半荘（ウィジェットが記録した半荘）。 */
export interface SessionCandidate {
  /** 半荘の名前（記録のフォルダの名前など）。結果にそのまま返す。 */
  id: string;
  /** 最初の記録の時刻（ミリ秒）。新しい順に並べるのに使う。無ければ名前の降順（名前が日時順のとき新しい順）。 */
  started_ms?: number | null;
  /** スクショから読んだ中央の文字。迷いマークのスクショでも、評価のスクショでもよい。 */
  marks: readonly SessionMark[];
}

/**
 * - match: 合う半荘が1つだけ。`sessionId` に結びつける
 * - choose: 一覧から選んでもらう。`sessionIds` が出す一覧（新しい順）。合う半荘が2つ以上あるときは、合う半荘だけ。
 *   合うものが無いときは、結果の無い半荘すべて。`matchingIds` は合う半荘（新しい順。無ければ空）
 * - new: 結果の無い半荘が無い。新しい半荘として取り込む
 */
export type SessionMatch =
  | { kind: 'match'; sessionId: string }
  | { kind: 'choose'; sessionIds: string[]; matchingIds: string[] }
  | { kind: 'new' };

function readingOfMark(mark: SessionMark): CenterReading | null {
  if (mark.center !== undefined) return mark.center;
  return mark.lines === undefined ? null : firstReadable(mark.lines, mark.retries);
}

/** 新しい順。時刻が分からないものは、時刻の分かるものより後ろ。同じなら名前の降順。 */
function newestFirst(a: SessionCandidate, b: SessionCandidate): number {
  const ta = a.started_ms ?? Number.NEGATIVE_INFINITY;
  const tb = b.started_ms ?? Number.NEGATIVE_INFINITY;
  if (ta !== tb) return tb > ta ? 1 : -1;
  return a.id < b.id ? 1 : a.id > b.id ? -1 : 0;
}

/** 結果と合わなかったスクショ 1 枚。`index` は、渡した並びの何番目か（0 から）。 */
export interface ShotMismatch<T extends SessionMark = SessionMark> {
  index: number;
  mark: T;
  /** 読み取った局・点数（残りの牌の数が読めていれば、それも）。 */
  center: CenterReading;
}

/** 結びつけ先の半荘が決まっているときの、スクショと結果の照合（`checkShotsAgainstReport`）。 */
export interface ShotCheck<T extends SessionMark = SessionMark> {
  /** 読めたスクショの数。 */
  readable: number;
  /** そのうち、結果と合ったものの数。 */
  fitting: number;
  /** 結果と合わなかったスクショ（渡した順）。 */
  mismatches: ShotMismatch<T>[];
}

/**
 * 結びつけ先の半荘が決まっているとき（取り込み前の半荘のページから、その半荘に取り込むとき。U-14）の、スクショと結果の照合。
 * 結びつけ先の照合（`matchSessionForReport`）はせず、読めたスクショのうち、結果と合わないものを返す。
 * 合わない = 読んだ局が結果に無い、または点数が局の始めの点数に合わない（自分のリーチ棒の分は引いて比べる。`kyokuFits`）。
 * 読めなかったスクショは数えない。合わないものが1枚でもあれば、画面から読んだ局・点数が、この結果と食い違っている。
 */
export function checkShotsAgainstReport<T extends SessionMark>(report: MortalReport, marks: readonly T[]): ShotCheck<T> {
  const facts = kyokuFactsOf(report);
  const result: ShotCheck<T> = { readable: 0, fitting: 0, mismatches: [] };
  marks.forEach((mark, index) => {
    const center = readingOfMark(mark);
    if (center === null) return;
    result.readable++;
    if (locateKyokus(facts, center).length > 0) result.fitting++;
    else result.mismatches.push({ index, mark, center });
  });
  return result;
}

/**
 * 結果を結びつける半荘を決める。`sessions` は結果がまだ無い半荘。
 * 例: 合う半荘が1つなら `{ kind: 'match', sessionId }`、結果の無い半荘が無ければ `{ kind: 'new' }`。
 */
export function matchSessionForReport(report: MortalReport, sessions: readonly SessionCandidate[]): SessionMatch {
  if (sessions.length === 0) return { kind: 'new' };
  const facts = kyokuFactsOf(report);
  const newest = [...sessions].sort(newestFirst);

  const matching = newest.filter((session) => {
    let readable = 0;
    for (const mark of session.marks) {
      const reading = readingOfMark(mark);
      if (reading === null) continue;
      readable++;
      if (locateKyokus(facts, reading).length === 0) return false;
    }
    return readable >= 1;
  });

  const only = matching.length === 1 ? matching[0] : undefined;
  if (only) return { kind: 'match', sessionId: only.id };
  return {
    kind: 'choose',
    sessionIds: (matching.length >= 2 ? matching : newest).map((s) => s.id),
    matchingIds: matching.map((s) => s.id),
  };
}
