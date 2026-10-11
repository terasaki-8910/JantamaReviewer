/**
 * 検索の重ね表示（U-22、R9-9、R10-5）の、画面に依存しない部分: 半荘と問題の行の元になる値の組み立て・検索語の当て方・
 * 絞り込み・4 つの並べ方・「すべて表示」で切る数。純粋な関数だけ。
 *
 * - 半荘: 日付（10/9・10月9日・昨日）・開始時刻・卓・段階・Rating・迷い・メモに、半荘の一覧の検索と同じ当て方で当たる
 *   （`sessionFilter.ts` の検索の口をそのまま使う）。それに加えて、その半荘の局の名前に当たる（東4局 → 東4局を持つ半荘）
 * - 問題: 今日の出題と同じ一覧（大きな不一致 + 迷いを結びつけた判断。消した半荘の問題は、元から入らない）。
 *   局の名前・巡目・種類・シャンテン数・迷い・学んだ原則・解答の状態と、その半荘の日付・開始時刻・卓・メモに当たる
 * - 検索語は空白で区切り、すべてに当たるものだけ（AND）。全角・半角と大文字・小文字は区別しない
 * - 絞り込み: 種類（半荘・問題）・段階（半荘の一覧と同じ）・期間・迷いあり・未解答。問題の段階と期間は、その半荘のもの
 * - 並べ方: 新しい順・古い順・Rating が低い順・AI との差が大きい順。「AI との差」は、AI が実戦の行動に付けた確率が低い順で、
 *   確率は並べ替えにだけ使う。値も順位も、画面には出さない（U-1、U-22）
 */
import { problemId, shantenTag, type Problem } from '@jantama/engine';

import type { AnswerRow } from '../../api/types';
import { formatSessionShort } from '../format';
import {
  containsTerm,
  daysBefore,
  dateField,
  memoField,
  normalize,
  passesStage,
  queryTerms,
  roomField,
  SEARCH_FIELDS,
  timeField,
  type FilterRow,
  type StageId,
} from '../sessionFilter';
import type { ListRow } from '../sessionRows';
import type { SummaryMap, SummaryState } from '../sessionSummaries';
import { KIND_NAME } from '../study/labels';
import { answeredIds } from '../study/studyModel';
import { hitRanges } from './highlight';

// ---- 並べ方・期間 ----

export type SearchSort = 'new' | 'old' | 'rating' | 'diff';

export const SORTS: ReadonlyArray<{ id: SearchSort; label: string }> = [
  { id: 'new', label: '新しい順' },
  { id: 'old', label: '古い順' },
  { id: 'rating', label: 'Rating が低い順' },
  { id: 'diff', label: 'AI との差が大きい順' },
];

export type PeriodId = 'all' | 'today' | 'yesterday' | 'week' | 'month';

/** `maxDays` は、暦の日で数えた、今日から何日前までか（本日 = 0）。 */
export const PERIODS: ReadonlyArray<{ id: PeriodId; label: string; maxDays: number }> = [
  { id: 'all', label: 'すべて', maxDays: Number.POSITIVE_INFINITY },
  { id: 'today', label: '本日', maxDays: 0 },
  { id: 'yesterday', label: '昨日まで', maxDays: 1 },
  { id: 'week', label: '7日以内', maxDays: 6 },
  { id: 'month', label: '30日以内', maxDays: 29 },
];

export function sortLabel(id: SearchSort): string {
  return SORTS.find((sort) => sort.id === id)?.label ?? '';
}

export function periodLabel(id: PeriodId): string {
  return PERIODS.find((period) => period.id === id)?.label ?? '';
}

// ---- 検索の状態 ----

export interface SearchState {
  query: string;
  /** 種類のチップ。どちらも切のときは、半荘も問題も出す（どちらも入のときも同じ）。 */
  games: boolean;
  problems: boolean;
  stage: StageId;
  period: PeriodId;
  /** 迷いあり: 迷いマークのある半荘と、迷いに結びついた問題。 */
  doubt: boolean;
  /** 未解答: まだ答えていない問題と、そういう問題がある半荘。 */
  todo: boolean;
  sort: SearchSort;
}

export const FRESH_SEARCH: SearchState = {
  query: '',
  games: false,
  problems: false,
  stage: 'all',
  period: 'all',
  doubt: false,
  todo: false,
  sort: 'new',
};

/** 検索語のほかに、絞り込みの条件がかかっているか（「条件を解除」を出すか）。 */
export function hasConditions(state: SearchState): boolean {
  return (
    state.games || state.problems || state.stage !== 'all' || state.period !== 'all' || state.doubt || state.todo
  );
}

/** 検索語か絞り込みが、かかっているか。 */
export function hasAnyCondition(state: SearchState): boolean {
  return hasConditions(state) || queryTerms(state.query).length > 0;
}

// ---- 行の元になる値 ----

export interface GameEntry {
  readonly type: 'game';
  /** 半荘のフォルダの名前。 */
  readonly id: string;
  readonly startedMs: number;
  readonly row: ListRow;
  /** 半荘のメモ（まだ書く場所が無いので、いまは無い）。 */
  readonly memo: string | null;
  /** 行の 2 行目に出す、半荘の要約（メモが無いとき）。例: 5局 · 東3局1本場で終了。結果を読めていない半荘は、空。 */
  readonly summary: string;
  /** 半荘の局の名前（東1局・東2局1本場 …）。 */
  readonly kyokus: readonly string[];
  /** Rating（0〜100）。取り込み前などで無ければ null。並べ替えに使う。 */
  readonly ratingValue: number | null;
  /** 問題の数と、まだ答えていない数。問題を読み終えるまでは null。 */
  readonly problemCount: number | null;
  readonly unanswered: number | null;
  /** 大きな不一致（確率が基準未満）の問題の数。並べ替えにだけ使う（画面には出さない）。 */
  readonly mismatchCount: number;
  /** 検索で当てる文字（正規化済み）。 */
  readonly text: string;
}

export interface ProblemEntry {
  readonly type: 'problem';
  readonly sessionId: string;
  /** 判断の鍵（例: k2h1e14）。 */
  readonly key: string;
  readonly game: GameEntry;
  /** 局と巡目。例: 東4局 13巡目。 */
  readonly title: string;
  /** 迷いの問題のとき、何番目の迷いか。 */
  readonly markNumber: number | null;
  readonly kindName: string;
  readonly shanten: string;
  /** 「10月9日 17:12 の半荘」。 */
  readonly where: string;
  readonly answered: boolean;
  /** 学んだ原則（答えたあとに書いたもの。無ければ null）。 */
  readonly principle: string | null;
  /** AI が実戦の行動に付けた確率。並べ替えにだけ使う。値は画面にも DOM にも出さない（U-1、U-22）。 */
  readonly probability: number;
  /** 半荘の中の判断の通し番号。並べ替えの最後の決め手。 */
  readonly order: number;
  /** 検索で当てる文字（正規化済み）。 */
  readonly text: string;
}

export interface SearchModel {
  readonly games: readonly GameEntry[];
  readonly problems: readonly ProblemEntry[];
  /** 問題を読み終えているか（読み込み中は、問題が空で、数も出さない）。 */
  readonly problemsReady: boolean;
}

export interface SearchInput {
  /** すべての半荘（一覧の行。消した半荘は入っていない）。 */
  rows: readonly ListRow[];
  summaries: SummaryMap;
  /** 問題の一覧（今日の出題と同じ）。結果を読み終えるまでは空。 */
  problems: readonly Problem[];
  problemsReady: boolean;
  answers: readonly AnswerRow[];
  /** 大きな不一致の基準（確率）。 */
  threshold: number;
  now: number;
}

/** 問題ごとの、いちばん新しい答えの「学んだ原則」（書いていなければ入れない）。 */
function latestPrinciples(answers: readonly AnswerRow[]): Map<string, string> {
  const latest = new Map<string, AnswerRow>();
  for (const row of answers) {
    const id = problemId({ sessionId: row.session_id, key: row.decision_key });
    const found = latest.get(id);
    if (found === undefined || row.answered_at >= found.answered_at) latest.set(id, row);
  }
  const principles = new Map<string, string>();
  for (const [id, row] of latest) {
    const text = row.principle.trim();
    if (text !== '') principles.set(id, text);
  }
  return principles;
}

/**
 * 半荘の行の 2 行目（メモが無いとき）。結果を読めた半荘だけ。取り込み前・読み込み中・読めない半荘は、行の段階の所に
 * 同じことが書いてあるので、空（2 行目を出さない）。
 */
function summaryLine(state: SummaryState | undefined): string {
  if (state?.status !== 'ready') return '';
  const kyokus = state.summary.kyokus;
  const last = kyokus.at(-1);
  return last === undefined ? `${kyokus.length}局` : `${kyokus.length}局 · ${last.label}で終了`;
}

/** 半荘の局の名前。結果を読めていない半荘は、空。 */
function kyokuLabels(state: SummaryState | undefined): string[] {
  return state?.status === 'ready' ? state.summary.kyokus.map((kyoku) => kyoku.label) : [];
}

/** 半荘と問題の、検索の元になる値を作る。 */
export function buildSearchModel(input: SearchInput): SearchModel {
  const { rows, summaries, problems, problemsReady, answers, threshold, now } = input;
  const answered = answeredIds(answers);
  const principles = latestPrinciples(answers);

  const bySession = new Map<string, Problem[]>();
  for (const problem of problems) {
    const list = bySession.get(problem.sessionId);
    if (list === undefined) bySession.set(problem.sessionId, [problem]);
    else list.push(problem);
  }

  const games = rows.map((row): GameEntry => {
    const state = summaries.get(row.id);
    const own = bySession.get(row.id) ?? [];
    const kyokus = kyokuLabels(state);
    const ratingValue = row.ratingText === null ? null : Number(row.ratingText);
    const text = normalize(
      [...SEARCH_FIELDS.flatMap((field) => field(row, { now })), ...kyokus, '半荘'].join(' '),
    );
    return {
      type: 'game',
      id: row.id,
      startedMs: row.startedMs,
      row,
      memo: row.memo === undefined || row.memo === '' ? null : row.memo,
      summary: summaryLine(state),
      kyokus,
      ratingValue: ratingValue === null || Number.isNaN(ratingValue) ? null : ratingValue,
      problemCount: problemsReady ? own.length : null,
      unanswered: problemsReady ? own.filter((p) => !answered.has(problemId(p))).length : null,
      mismatchCount: own.filter((p) => p.probability < threshold).length,
      text,
    };
  });
  const gameById = new Map(games.map((game) => [game.id, game] as const));

  const entries: ProblemEntry[] = [];
  for (const problem of problems) {
    const game = gameById.get(problem.sessionId);
    if (game === undefined) continue;
    const { decision } = problem;
    const id = problemId(problem);
    const isAnswered = answered.has(id);
    const principle = principles.get(id) ?? null;
    const shanten = shantenTag(decision.shanten);
    const kindName = KIND_NAME[decision.kind];
    const title = `${decision.kyokuLabel} ${decision.junme}巡目`;
    // その半荘の日付・開始時刻・卓・メモにも当たる（成績や迷いの数には当たらない）
    const shared = [dateField, timeField, roomField, memoField].flatMap((field) => field(game.row, { now }));
    const text = normalize(
      [
        title,
        kindName,
        shanten,
        ...(problem.markNumber === null ? [] : ['迷い', `迷い${problem.markNumber}`]),
        ...(principle === null ? [] : [principle]),
        isAnswered ? '解答済み' : '未解答',
        '問題',
        ...shared,
      ].join(' '),
    );
    entries.push({
      type: 'problem',
      sessionId: problem.sessionId,
      key: problem.key,
      game,
      title,
      markNumber: problem.markNumber,
      kindName,
      shanten,
      where: `${formatSessionShort(problem.startedMs, now)} の半荘`,
      answered: isAnswered,
      principle,
      probability: problem.probability,
      order: decision.index,
      text,
    });
  }
  return { games, problems: entries, problemsReady };
}

// ---- 検索・絞り込み・並べ替え ----

export interface SearchResult {
  games: GameEntry[];
  problems: ProblemEntry[];
  /** 検索語（正規化したもの）。当たった文字の印に使う。 */
  terms: string[];
}

const newest = (a: { startedMs: number }, b: { startedMs: number }) => b.startedMs - a.startedMs;
const compareText = (a: string, b: string) => (a < b ? -1 : a > b ? 1 : 0);
/** Rating の低い順（Rating の無い半荘は最後）。 */
function lowestRating(a: GameEntry, b: GameEntry): number {
  if (a.ratingValue === b.ratingValue) return 0;
  if (a.ratingValue === null) return 1;
  if (b.ratingValue === null) return -1;
  return a.ratingValue - b.ratingValue;
}

/** 同じ開始時刻なら、名前の大きい順（半荘の一覧と同じ）。 */
const newestGame = (a: GameEntry, b: GameEntry) => newest(a, b) || compareText(b.id, a.id);
const oldestGame = (a: GameEntry, b: GameEntry) => -newest(a, b) || compareText(a.id, b.id);
/** 確率の低い順（同じなら、半荘の中の順）。 */
const lowestProbability = (a: ProblemEntry, b: ProblemEntry) => a.probability - b.probability || a.order - b.order;

function gameComparator(sort: SearchSort): (a: GameEntry, b: GameEntry) => number {
  switch (sort) {
    case 'new':
      return newestGame;
    case 'old':
      return oldestGame;
    case 'rating':
      return (a, b) => lowestRating(a, b) || newestGame(a, b);
    case 'diff':
      return (a, b) => b.mismatchCount - a.mismatchCount || newestGame(a, b);
  }
}

function problemComparator(sort: SearchSort): (a: ProblemEntry, b: ProblemEntry) => number {
  switch (sort) {
    case 'new':
      return (a, b) => newestGame(a.game, b.game) || lowestProbability(a, b);
    case 'old':
      return (a, b) => oldestGame(a.game, b.game) || lowestProbability(a, b);
    case 'rating':
      return (a, b) => lowestRating(a.game, b.game) || newestGame(a.game, b.game) || lowestProbability(a, b);
    case 'diff':
      return (a, b) => a.probability - b.probability || newestGame(a.game, b.game) || a.order - b.order;
  }
}

function maxDaysOf(period: PeriodId): number {
  return PERIODS.find((p) => p.id === period)?.maxDays ?? Number.POSITIVE_INFINITY;
}

/** 検索語・絞り込みをかけて、並べ替える。 */
export function runSearch(model: SearchModel, state: SearchState, now: number): SearchResult {
  const terms = queryTerms(state.query);
  const hit = (text: string) => terms.every((term) => containsTerm(text, term));
  const maxDays = maxDaysOf(state.period);
  const withinPeriod = (startedMs: number) => daysBefore(now, startedMs) <= maxDays;
  const wantGames = state.games || !state.problems;
  const wantProblems = state.problems || !state.games;

  const games = wantGames
    ? model.games.filter(
        (game) =>
          passesStage(game.row.grade, state.stage) &&
          withinPeriod(game.startedMs) &&
          (!state.doubt || game.row.markCount > 0) &&
          (!state.todo || (game.unanswered ?? 0) > 0) &&
          hit(game.text),
      )
    : [];
  const problems = wantProblems
    ? model.problems.filter(
        (problem) =>
          passesStage(problem.game.row.grade, state.stage) &&
          withinPeriod(problem.game.startedMs) &&
          (!state.doubt || problem.markNumber !== null) &&
          (!state.todo || !problem.answered) &&
          hit(problem.text),
      )
    : [];
  games.sort(gameComparator(state.sort));
  problems.sort(problemComparator(state.sort));
  return { games, problems, terms };
}

// ---- 「すべて表示」 ----

/** 切って出す数（半荘・問題）。残りは「すべて表示（あと N件）」で出す。 */
export const GAME_LIMIT = 5;
export const PROBLEM_LIMIT = 6;

export interface ShownResult {
  games: GameEntry[];
  problems: ProblemEntry[];
  /** 切って出していない数。 */
  hidden: number;
  /** すべて出しているが、切れば短くなる（「上位だけ表示」を出す）。 */
  collapsible: boolean;
}

export function limitResult(result: SearchResult, showAll: boolean): ShownResult {
  const games = showAll ? result.games : result.games.slice(0, GAME_LIMIT);
  const problems = showAll ? result.problems : result.problems.slice(0, PROBLEM_LIMIT);
  return {
    games,
    problems,
    hidden: result.games.length - games.length + (result.problems.length - problems.length),
    collapsible: showAll && (result.games.length > GAME_LIMIT || result.problems.length > PROBLEM_LIMIT),
  };
}

// ---- 当たりの印（局・日付） ----

/** 半荘の局の名前のうち、検索語に当たるもの（行の 2 行目に出す。局の名前で当たった理由を見せるため）。 */
export function matchedKyokus(game: Pick<GameEntry, 'kyokus'>, terms: readonly string[]): string[] {
  if (terms.length === 0) return [];
  return game.kyokus.filter((label) => hitRanges(label, terms).length > 0);
}

/** 半荘の日付の文字: 10月9日（今年でなければ 2025年1月1日）と、本日・昨日（それ以外は null）。 */
export function dateParts(ms: number, now: number): { monthDay: string; relative: '本日' | '昨日' | null } {
  const d = new Date(ms);
  const year = d.getFullYear() === new Date(now).getFullYear() ? '' : `${d.getFullYear()}年`;
  const diff = daysBefore(now, ms);
  return {
    monthDay: `${year}${d.getMonth() + 1}月${d.getDate()}日`,
    relative: diff === 0 ? '本日' : diff === 1 ? '昨日' : null,
  };
}

const RELATIVE_DAYS: ReadonlySet<string> = new Set(['本日', '今日', '昨日']);

/**
 * 半荘の日付の言い方（本日・昨日・10月9日・10/9 など）のうち、検索語が当たるもの。
 * 「10/9」のように、画面に出している文字（10月9日）にそのまま入っていない語でも、日付に当たったことを印にするため。
 * `monthDay` は、数字の日付に当たった語があるか。`relative` は、本日・昨日に当たった語があるか。
 */
export function dateHits(
  startedMs: number,
  now: number,
  terms: readonly string[],
): { monthDay: boolean; relative: boolean } {
  const row: FilterRow = { startedMs, markCount: 0, imported: true, room: null, grade: null, ratingText: null };
  const alternatives = dateField(row, { now }).map(normalize);
  const relative = alternatives.filter((text) => RELATIVE_DAYS.has(text));
  const numeric = alternatives.filter((text) => !RELATIVE_DAYS.has(text));
  const matches = (list: readonly string[]) => terms.some((term) => list.some((text) => containsTerm(text, term)));
  return { monthDay: matches(numeric), relative: matches(relative) };
}
