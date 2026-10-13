/**
 * 取り込んだ半荘から数えた成績（F14 の提案 6、E-42、U-37。R14-4・R15-7）。
 *
 * 雀魂の成績の画面は読まない。取り込んだ半荘の牌譜（mjai_log）と結果だけから、レビューした本人について数える。
 * 数え方は、承認済みの見本（majiang-ui の stat.js と同じ）:
 * - 4位率: 4 位の半荘 ÷ 半荘。平均順位: 順位の合計 ÷ 半荘。順位は最後の局の点数から決める（同点は、起家に近い席が上）
 * - 放銃率: 他家が自分の打牌でロンした局 ÷ 局。ダブロンでも、1 局は 1 回
 * - 和了率: 自分が和了した局 ÷ 局。ダブロンの 2 人目も、それぞれ自分の和了に数える
 * - 副露率: チー・ポン・大明槓をした局 ÷ 局。暗槓だけの局は数えない（加槓は、ポンのあとなので、ポンで数える）
 * - 立直率: 立直を宣言した局 ÷ 局（宣言牌がロンされて、棒が成立しなかった局も数える）
 * - 平均和了点: 自分の和了の点数（本場・供託を除く。ツモは全員の支払いの合計）の合計 ÷ 和了の回数
 * 和了と放銃は、局の結果の手（kyoku-result.ts。E-40）が牌譜から組み立てた和了を使う。牌譜が矛盾して局を再生できない半荘は、数えられない（null）。
 */
import { kyokuResultOf } from './kyoku-result';
import { splitKyokus } from './replay';
import type { MortalReport, Seat } from './report-types';

/** 半荘 1 つの成績（本人について）。 */
export interface HanchanStat {
  /** 順位（1 から 4）。 */
  rank: 1 | 2 | 3 | 4;
  /** 局の数（本場も 1 局ずつ）。 */
  kyokuCount: number;
  /** 自分が和了した局の数。 */
  winCount: number;
  /** 自分の打牌で他家がロンした局の数。 */
  dealInCount: number;
  /** 立直を宣言した局の数。 */
  riichiCount: number;
  /** チー・ポン・大明槓をした局の数。 */
  fulouCount: number;
  /** 自分の和了の点数の合計（本場・供託を除く）。 */
  winPointsSum: number;
}

/**
 * 最後の局が終わったあとの、席ごとの点数。最後の局の始めの点数に、局の終わりの点の増減を足し、成立した立直の棒（1000 点）を引く
 * （牌譜の点の増減には、和了者が受け取る供託は入っているが、立直の棒を出した分は入っていない）。
 */
function finalScoresOf(report: MortalReport): number[] | null {
  const kyokus = splitKyokus(report.mjai_log);
  const last = kyokus[kyokus.length - 1];
  const reported = report.review.kyokus[report.review.kyokus.length - 1];
  if (last === undefined || reported === undefined) return null;
  const scores = [...last.start.scores];
  for (const status of reported.end_status) status.deltas.forEach((delta, seat) => (scores[seat] = (scores[seat] ?? 0) + delta));
  for (const event of last.events) {
    if (event.type === 'reach_accepted') scores[event.actor] = (scores[event.actor] ?? 0) - 1000;
  }
  return scores;
}

/** 順位。同点は、席の番号が小さい（起家に近い）ほうが上。 */
function rankOf(scores: readonly number[], me: Seat): 1 | 2 | 3 | 4 {
  const mine = scores[me] ?? 0;
  const above = scores.filter((score, seat) => score > mine || (score === mine && seat < me)).length;
  return (1 + above) as 1 | 2 | 3 | 4;
}

/** 半荘 1 つの成績。牌譜が矛盾していて局を再生できない半荘と、局の無い半荘は null。 */
export function hanchanStatOf(report: MortalReport): HanchanStat | null {
  const me = report.player_id;
  const kyokus = splitKyokus(report.mjai_log);
  if (kyokus.length === 0 || kyokus.length !== report.review.kyokus.length) return null;
  let winCount = 0;
  let dealInCount = 0;
  let riichiCount = 0;
  let fulouCount = 0;
  let winPointsSum = 0;
  for (const [position, kyoku] of kyokus.entries()) {
    const result = kyokuResultOf(report, position);
    if (result === null) return null;
    if (result.kind === 'win') {
      for (const win of result.wins) {
        if (win.winner === me) {
          winCount += 1;
          winPointsSum += win.line.base;
        }
      }
      if (result.wins.some((win) => win.winner !== me && win.target === me)) dealInCount += 1;
    }
    if (kyoku.events.some((event) => event.type === 'reach' && event.actor === me)) riichiCount += 1;
    if (kyoku.events.some((event) => (event.type === 'chi' || event.type === 'pon' || event.type === 'daiminkan') && event.actor === me)) {
      fulouCount += 1;
    }
  }
  const scores = finalScoresOf(report);
  if (scores === null) return null;
  return { rank: rankOf(scores, me), kyokuCount: kyokus.length, winCount, dealInCount, riichiCount, fulouCount, winPointsSum };
}

/** 半荘をまとめた成績。もとの数（`...Count`・`...Sum`）と、そこから出した値（率は 0 から 100 の %、四捨五入しない）。割る数が 0 の値は null。 */
export interface HanchanStatTotals {
  /** 数えた半荘の数。 */
  hanchanCount: number;
  kyokuCount: number;
  /** 4 位だった半荘の数。 */
  fourthCount: number;
  /** 順位の合計。 */
  rankSum: number;
  winCount: number;
  dealInCount: number;
  fulouCount: number;
  riichiCount: number;
  /** 自分の和了の点数の合計（本場・供託を除く）。 */
  winPointsSum: number;
  /** 4位率（%）。 */
  fourthRate: number | null;
  /** 放銃率（%）。 */
  dealInRate: number | null;
  /** 平均順位（1 から 4）。 */
  averageRank: number | null;
  /** 和了率（%）。 */
  winRate: number | null;
  /** 副露率（%）。 */
  fulouRate: number | null;
  /** 立直率（%）。 */
  riichiRate: number | null;
  /** 平均和了点。和了が 1 回も無ければ null。 */
  averageWinPoints: number | null;
}

const ratio = (part: number, whole: number): number | null => (whole === 0 ? null : part / whole);
const percent = (part: number, whole: number): number | null => (whole === 0 ? null : (part / whole) * 100);

/** 半荘ごとの成績を足して、もとの数と値を出す。半荘が 0 なら、数はすべて 0、値はすべて null。 */
export function totalStats(stats: readonly HanchanStat[]): HanchanStatTotals {
  const sum = (pick: (stat: HanchanStat) => number) => stats.reduce((total, stat) => total + pick(stat), 0);
  const hanchanCount = stats.length;
  const kyokuCount = sum((s) => s.kyokuCount);
  const rankSum = sum((s) => s.rank);
  const winCount = sum((s) => s.winCount);
  const dealInCount = sum((s) => s.dealInCount);
  const fulouCount = sum((s) => s.fulouCount);
  const riichiCount = sum((s) => s.riichiCount);
  const winPointsSum = sum((s) => s.winPointsSum);
  const fourthCount = stats.filter((s) => s.rank === 4).length;
  return {
    hanchanCount,
    kyokuCount,
    fourthCount,
    rankSum,
    winCount,
    dealInCount,
    fulouCount,
    riichiCount,
    winPointsSum,
    fourthRate: percent(fourthCount, hanchanCount),
    dealInRate: percent(dealInCount, kyokuCount),
    averageRank: ratio(rankSum, hanchanCount),
    winRate: percent(winCount, kyokuCount),
    fulouRate: percent(fulouCount, kyokuCount),
    riichiRate: percent(riichiCount, kyokuCount),
    averageWinPoints: ratio(winPointsSum, winCount),
  };
}
