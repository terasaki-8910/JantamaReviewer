/**
 * 迷いマークの結びつけ（E-17、F9・F11）。
 *
 * 迷いマークのスクショの中央から読んだ局・残りの牌の数・自分の点数で、取り込んだ半荘の判断に結びつける。
 * 1. 局: 読んだ局の名前（東2局など）の局のうち、局の始めの点数が読んだ点数に合うもの
 *    （本場は読めないので、点数で区別する。自分が出したリーチ棒の分は差し引いて比べる。`kyokuFits`）
 * 2. 判断: その局の自分の判断すべてに点を付け、点の小さい順（1位が「推定」）に並べる。
 *    点 = |判断の tiles_left - 読んだ残りの牌の数|（残りの牌の数の差）に、次を足す。
 *    - スルー（鳴かない判断。何もしなかったもの）は +1.5、和了の判断は +3（どちらも、迷って押すことが少ない判断）
 *    - 読んだ時点より後の判断（tiles_left が読んだ数より小さい）は +0.25
 *      （押したのは判断の最中か、打ったあとが多く、判断のまえに押すことは少ない。FX-4 の正解の迷い5つのうち、判断が後なのは1つだけ）
 *    同じ点なら、結果の中で先の判断を上にする（鳴いた判断は、そのあとの同じ残り枚数の打牌より先）。
 * 読めた迷いはどれも、1位を推定として結びつける（`estimate`）。1位との点の差が 0.75 以下の判断は、点の順に最大 4 つまで
 * 「ほかの候補」（`alternatives`）として返す（どの判断にも、あとから選び直せる）。
 * 本場違いで点数が同じ局が続くときは、局が1つに決まらない（`kyokuPositions` が複数になる）ので、それらの局の判断をまとめて並べる。
 * 読めない・合う局が無い・判断が無いときは、「手で選ぶ」（`manual`）。
 * 保存したユーザーの選び（links.json）は、ここでは扱わない。呼び出す側が、推定より先に使う（選んだものに「推定」の印は付けない）。
 * ユーザーが選んだ判断が、推定にもほかの候補にも入らず、読んだ局と違う局か、読んだ残りの牌の数との差が推定より大きいときは、
 * スクショの値から「離れている」（`isFarFromReading`。E-27）。
 *
 * 結びつけた判断は鍵（`DecisionRef.key`）で持つので、ユーザーが選んだものを保存して、あとで同じ結果に当て直せる。
 */
import { type CenterText, type ScreenReading, readingOf } from './center-text';
import { classifyDecisionKind } from './decision';
import { type DecisionRef, decisionRefAt, findDecisionRef } from './decision-ref';
import { kyokuFactsOf, locateKyokus } from './kyoku-locate';
import type { MortalReport, ReportEntry } from './report-types';

/** スルー（鳴かない判断）の点に足す数。 */
export const PASS_PENALTY = 1.5;
/** 和了の判断の点に足す数。 */
export const WIN_PENALTY = 3;
/** 読んだ時点より後の判断の点に足す数。 */
export const AFTER_PENALTY = 0.25;
/** 1位との点の差がこれ以下の判断を、「ほかの候補」にする。 */
export const ALTERNATIVE_MARGIN = 0.75;
/** 「ほかの候補」の最大の数。 */
export const MAX_ALTERNATIVES = 4;

/** 結びつけの候補 1 つ（1位の推定も、ほかの候補も同じ形）。 */
export interface MarkCandidate extends DecisionRef {
  /** |判断の残りの牌の数 - 読んだ残りの牌の数|。 */
  tilesDiff: number;
  /** 順位づけの点（小さいほど上。`markScore`）。 */
  score: number;
}

/**
 * - estimated: 読めた。1位の判断を推定として結びつけた（`estimate`）。近い判断は `alternatives`。あとから手で選び直せる
 * - manual: 候補が無い（手で選ぶ）。理由は `reason`
 */
export type MarkLinkStatus = 'estimated' | 'manual';

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
  /** 1位の判断（推定）。manual なら null。 */
  estimate: MarkCandidate | null;
  /** ほかの候補（点の順。1位は含まない。最大 4 つ）。 */
  alternatives: MarkCandidate[];
  /** status が manual のときの理由。それ以外は null。 */
  reason: MarkManualReason | null;
}

/**
 * 判断 1 つの順位づけの点（小さいほど上）。`tilesLeft` は、読んだ残りの牌の数。
 * 残りの牌の数の差に、スルー +1.5・和了 +3（どちらか 1 つ）と、読んだ時点より後の判断 +0.25 を足す。
 */
export function markScore(entry: Pick<ReportEntry, 'tiles_left' | 'actual' | 'details'>, tilesLeft: number): number {
  let score = Math.abs(entry.tiles_left - tilesLeft);
  if (classifyDecisionKind(entry.details) === 'win') score += WIN_PENALTY;
  else if (entry.actual.type === 'none') score += PASS_PENALTY;
  if (entry.tiles_left < tilesLeft) score += AFTER_PENALTY;
  return score;
}

/**
 * ユーザーが選んだ判断（`links.json` の値。判断の鍵）が、スクショの値から離れているか（E-27、F9）。
 * 結びつけの結果（`linkMarks` の 1 つ）の推定にも、ほかの候補にも入らない判断を選んでいて、さらに次のどちらかのときだけ true:
 * - 選んだ判断が、読んだ局・点数に合う局（`kyokuPositions`）に無い
 * - 選んだ判断の残りの牌の数と、読んだ残りの牌の数の差が、推定の差より大きい
 *   （スルーや和了の点・候補の数の上限で候補から外れただけで、推定と同じくらい読んだ値に近い判断は、離れているとしない。
 *   カードの「スクショの値（残り38）と離れています。選んだ局面は残り38です。」のような食い違いを出さないため）
 * 次のときは false（離れているとは言えない）:
 * - 推定が無い（読めない・合う局が無い・その局に判断が無い）: 比べる相手が無い
 * - 選んだ値が判断の鍵ではない（`"manual"`＝局面を手で選ぶ、など）か、この結果に無い判断: 判断を選んでいない
 */
export function isFarFromReading(
  report: MortalReport,
  link: Pick<MarkLink, 'center' | 'kyokuPositions' | 'estimate' | 'alternatives'>,
  chosenKey: string,
): boolean {
  if (link.estimate === null || link.center === null) return false;
  if (link.estimate.key === chosenKey || link.alternatives.some((candidate) => candidate.key === chosenKey)) return false;
  const chosen = findDecisionRef(report, chosenKey);
  if (chosen === null) return false;
  if (!link.kyokuPositions.includes(chosen.kyokuPosition)) return true;
  return Math.abs(chosen.tilesLeft - link.center.tilesLeft) > link.estimate.tilesDiff;
}

/** 順位づけの対象 1 つ（局の位置と、局の中の判断の番号）。 */
interface Ranked {
  position: number;
  entryIndex: number;
  diff: number;
  score: number;
}

/**
 * 迷いマークを、取り込んだ半荘の判断に結びつける。結果は渡した順（`index`）。
 * 迷いマークは、読み取り済み（`center`）か文字認識の行（`lines`。`retries` の読み直しも）を持つ記録なら何でも渡せる。
 */
export function linkMarks<T extends ScreenReading>(report: MortalReport, marks: readonly T[]): MarkLink<T>[] {
  const facts = kyokuFactsOf(report);
  return marks.map((mark, index): MarkLink<T> => {
    const manual = (center: CenterText | null, kyokuPositions: number[], reason: MarkManualReason): MarkLink<T> => ({
      index,
      mark,
      status: 'manual',
      center,
      kyokuPositions,
      estimate: null,
      alternatives: [],
      reason,
    });

    const center = readingOf(mark);
    if (center === null) return manual(center, [], 'unreadable');

    const matched = locateKyokus(facts, center);
    const kyokuPositions = matched.map((f) => f.position);
    if (matched.length === 0) return manual(center, kyokuPositions, 'no-kyoku');

    // 合った局（本場違いで点数が同じときは複数）の判断すべてに点を付けて、点の順（同じなら、結果の中で先のもの）に並べる。
    const ranked: Ranked[] = [];
    for (const f of matched) {
      (report.review.kyokus[f.position]?.entries ?? []).forEach((entry, entryIndex) => {
        ranked.push({
          position: f.position,
          entryIndex,
          diff: Math.abs(entry.tiles_left - center.tilesLeft),
          score: markScore(entry, center.tilesLeft),
        });
      });
    }
    ranked.sort((a, b) => a.score - b.score || a.position - b.position || a.entryIndex - b.entryIndex);

    const candidates: MarkCandidate[] = [];
    const best = ranked[0]?.score ?? Number.POSITIVE_INFINITY;
    for (const r of ranked.slice(0, 1 + MAX_ALTERNATIVES)) {
      if (candidates.length > 0 && r.score > best + ALTERNATIVE_MARGIN) break;
      const ref = decisionRefAt(report, r.position, r.entryIndex);
      if (ref) candidates.push({ ...ref, tilesDiff: r.diff, score: r.score });
    }
    const [estimate, ...alternatives] = candidates;
    if (estimate === undefined) return manual(center, kyokuPositions, 'no-decision');
    return { index, mark, status: 'estimated', center, kyokuPositions, estimate, alternatives, reason: null };
  });
}
