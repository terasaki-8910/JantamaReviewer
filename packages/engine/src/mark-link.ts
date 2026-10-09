/**
 * 迷いマークの結びつけ（E-17、F9・F11）。
 *
 * 迷いマークのスクショの中央から読んだ局・残りの牌の数・自分の点数で、取り込んだ半荘の判断に結びつける。
 * 1. 局: 読んだ局の名前（東2局など）の局のうち、局の始めの点数が読んだ点数に合うもの
 *    （本場は読めないので、点数で区別する。自分が出したリーチ棒の分は差し引いて比べる。`kyokuFits`）
 * 2. 判断: その局の自分の判断のうち、残りの牌の数の差（|判断の tiles_left - 読んだ残りの牌の数|）がいちばん小さいもの
 * 差が同じものが複数あれば、すべてを候補として返す（ユーザーに選んでもらう）。
 * 本場違いで点数が同じ局が続くときは、局が1つに決まらない（`kyokuPositions` が複数になる）ので、
 * それらの局の判断をまとめて、いちばん差が小さいものを選ぶ（同じ差が別の局にもあれば、どちらも候補）。
 * 読めない・合う局が無い・判断が無いときは、「手で選ぶ」（`manual`）。
 *
 * 結びつけた判断は鍵（`DecisionRef.key`）で持つので、ユーザーが選んだものを保存して、あとで同じ結果に当て直せる。
 */
import { type CenterText, type ScreenReading, readingOf } from './center-text';
import { type DecisionRef, decisionRefAt } from './decision-ref';
import { kyokuFactsOf, locateKyokus } from './kyoku-locate';
import type { MortalReport } from './report-types';

/** 結びつけの候補 1 つ。 */
export interface MarkCandidate extends DecisionRef {
  /** |判断の残りの牌の数 - 読んだ残りの牌の数|。 */
  tilesDiff: number;
}

/**
 * - linked: 候補が1つに決まった（自動で結びつけてよい。あとで手で選び直せる）
 * - candidates: 候補が2つ以上ある（ユーザーに選んでもらう）
 * - manual: 候補が無い（手で選ぶ）。理由は `reason`
 */
export type MarkLinkStatus = 'linked' | 'candidates' | 'manual';

/**
 * 手で選ぶ理由。
 * - unreadable: スクショから局・残りの牌の数・点数を読み取れなかった
 * - no-kyoku: 読んだ局・点数に合う局がこの半荘に無い（別の半荘のスクショかもしれない）
 * - no-decision: 合う局はあるが、その局に自分の判断が1つも無い
 */
export type MarkManualReason = 'unreadable' | 'no-kyoku' | 'no-decision';

export interface MarkLink<T extends ScreenReading = ScreenReading> {
  /** 渡した迷いマークの何番目か（0 から）。 */
  index: number;
  /** 渡した迷いマークそのもの。 */
  mark: T;
  status: MarkLinkStatus;
  /** 読み取った中央の文字。読めなかったら null。 */
  center: CenterText | null;
  /** 読んだ局・点数に合った局（review.kyokus の添字）。合わなければ空。 */
  kyokuPositions: number[];
  /** 候補（半荘の順）。linked なら1つ、candidates なら2つ以上、manual なら空。 */
  candidates: MarkCandidate[];
  /** status が manual のときの理由。それ以外は null。 */
  reason: MarkManualReason | null;
}

/**
 * 迷いマークを、取り込んだ半荘の判断に結びつける。結果は渡した順（`index`）。
 * 迷いマークは、読み取り済み（`center`）か文字認識の行（`lines`）を持つ記録なら何でも渡せる。
 */
export function linkMarks<T extends ScreenReading>(report: MortalReport, marks: readonly T[]): MarkLink<T>[] {
  const facts = kyokuFactsOf(report);
  return marks.map((mark, index): MarkLink<T> => {
    const center = readingOf(mark);
    if (center === null) return { index, mark, status: 'manual', center, kyokuPositions: [], candidates: [], reason: 'unreadable' };

    const matched = locateKyokus(facts, center);
    const kyokuPositions = matched.map((f) => f.position);
    if (matched.length === 0) return { index, mark, status: 'manual', center, kyokuPositions, candidates: [], reason: 'no-kyoku' };

    // 合った局（本場違いで点数が同じときは複数）の判断のうち、残りの牌の数の差がいちばん小さいものすべて
    let best = Number.POSITIVE_INFINITY;
    let nearest: { position: number; entryIndex: number }[] = [];
    for (const f of matched) {
      (report.review.kyokus[f.position]?.entries ?? []).forEach((entry, entryIndex) => {
        const diff = Math.abs(entry.tiles_left - center.tilesLeft);
        if (diff < best) {
          best = diff;
          nearest = [{ position: f.position, entryIndex }];
        } else if (diff === best) {
          nearest.push({ position: f.position, entryIndex });
        }
      });
    }
    const candidates: MarkCandidate[] = [];
    for (const { position, entryIndex } of nearest) {
      const ref = decisionRefAt(report, position, entryIndex);
      if (ref) candidates.push({ ...ref, tilesDiff: best });
    }
    if (candidates.length === 0) return { index, mark, status: 'manual', center, kyokuPositions, candidates, reason: 'no-decision' };
    return { index, mark, status: candidates.length === 1 ? 'linked' : 'candidates', center, kyokuPositions, candidates, reason: null };
  });
}
