/**
 * 出題（今日の出題・解き直し）の、画面に出すもの。取り込んだ半荘・答えの記録・設定・その日の組から、純粋に組み立てる。
 *
 * - 問題: 大きな不一致（基準は設定）と、迷いマークを結びつけた判断（結びつけは、半荘のページと同じ `resolveMarks`）
 * - 今日の出題: その日の組（保存してあるもの。まだ無ければ、これから作る組 `plannedSet`）と、「残り」
 * - 解き直し: 問題ごとの最後の答えの期限が、今日までのもの（期限の古い順）
 * 消した半荘（一覧に無い半荘）の問題は、どこにも出ない（答えの記録は、置き場にある間、残してある）。
 */
import {
  actualProbability,
  buildDailySet,
  dueAnswers,
  findDecisionByKey,
  latestAnswers,
  listProblems,
  problemId,
  restOfProblems,
  type AnswerLike,
  type Decision,
  type ImportedGame,
  type Problem,
  type ProblemRef,
  type ProblemSource,
} from '@jantama/engine';

import type { AnswerRow, SessionRecord, StoredProblemRef } from '../../api/types';
import { resolveMarks } from '../markCards';
import type { GameMap } from './gameStore';

/** 今日の組の 1 問。`answer` は、その問題の出題での最後の答え（まだ答えていなければ null）。 */
export interface TodayItem {
  problem: Problem;
  answer: AnswerRow | null;
}

/** 解き直しに出る 1 問。`answer` は、その問題の最後の答え（期限と間隔を持つ）。 */
export interface DueEntry {
  sessionId: string;
  key: string;
  decision: Decision;
  game: ImportedGame;
  session: SessionRecord;
  answer: AnswerRow;
  /** いまも問題の一覧にあるときは、その問題（迷いの番号を持つ）。 */
  problem: Problem | null;
}

export interface TodayModel {
  items: TodayItem[];
  /** 組の中の、答えた問題の数。 */
  answered: number;
  /** 組の中の、まだ答えていない問題の数。 */
  unanswered: number;
  /** 組に入っていない、まだ答えていない問題（「残り」）。 */
  rest: Problem[];
  /** 結びつけが決まっていない迷いの数（結果を取り込んだ半荘の、局面を手で選ぶ迷い）。 */
  undecidedMarks: number;
  /** 組の問題が属する半荘の数。 */
  sessionCount: number;
}

export interface StudyModel {
  problems: Problem[];
  today: TodayModel;
  due: DueEntry[];
}

export interface StudyInput {
  sessions: readonly SessionRecord[];
  games: GameMap;
  answers: readonly AnswerRow[];
  /** 大きな不一致の基準（確率。0.05 など）。 */
  threshold: number;
  /** その日の保存してある組。まだ作っていなければ null。 */
  daily: readonly StoredProblemRef[] | null;
  /** 今日（午前 4 時までは前の日。YYYY-MM-DD）。 */
  today: string;
}

const refOf = (item: StoredProblemRef): ProblemRef => ({ sessionId: item.session_id, key: item.decision_key });

/** 答えの記録（snake_case）を、エンジンの答えの形にする。 */
export function toAnswerLike(row: AnswerRow): AnswerLike & { row: AnswerRow } {
  return {
    sessionId: row.session_id,
    key: row.decision_key,
    answeredAt: row.answered_at,
    intervalDays: row.interval_days,
    dueDate: row.due_date,
    row,
  };
}

/** 結果を読み終えた半荘（問題を数える相手）と、迷いマークごとの結びつけ。 */
function sourcesOf(sessions: readonly SessionRecord[], games: GameMap): { sources: ProblemSource[]; undecided: number } {
  const sources: ProblemSource[] = [];
  let undecided = 0;
  for (const session of sessions) {
    const state = games.get(session.id);
    if (state === undefined || state.status !== 'ready') continue;
    const resolved = resolveMarks(state.game.report, session);
    for (const mark of resolved) if (mark.resolution.kind === 'manual') undecided++;
    sources.push({
      sessionId: session.id,
      startedMs: session.started_ms,
      game: state.game,
      markKeys: resolved.map((mark) => (mark.resolution.kind === 'linked' ? mark.resolution.ref.key : null)),
    });
  }
  return { sources, undecided };
}

/** 問題の一覧に無い判断（基準を変えた・結びつけを変えたあとの、その日の組の問題）を、問題として作る。 */
function problemOf(session: SessionRecord, game: ImportedGame, key: string): Problem | null {
  const decision = findDecisionByKey(game, key);
  if (decision === undefined) return null;
  return {
    sessionId: session.id,
    key,
    kind: 'disagreement',
    markNumber: null,
    startedMs: session.started_ms,
    probability: actualProbability(decision.entry),
    decision,
  };
}

/** 出題で答えた問題の最後の答え（問題ごと）。 */
function latestQuizAnswers(answers: readonly AnswerRow[]): Map<string, AnswerRow> {
  const latest = new Map<string, AnswerRow>();
  for (const row of answers) {
    if (row.mode !== 'quiz') continue;
    const id = problemId({ sessionId: row.session_id, key: row.decision_key });
    const found = latest.get(id);
    if (found === undefined || row.answered_at >= found.answered_at) latest.set(id, row);
  }
  return latest;
}

/** 答えた問題（出題でも解き直しでも、答えがある問題）の識別の集まり。 */
export function answeredIds(answers: readonly AnswerRow[]): Set<string> {
  return new Set(answers.map((row) => problemId({ sessionId: row.session_id, key: row.decision_key })));
}

/**
 * これから保存する、今日の組（まだ組を作っていないとき）。まだ答えていない問題の先頭から、1 日に出す数まで。
 * 半荘の結果を、すべて読み終えたあとに作る（読み込み中に作ると、一部の半荘だけの組になる）。
 */
export function plannedSet(problems: readonly Problem[], answers: readonly AnswerRow[], count: number): StoredProblemRef[] {
  return buildDailySet(problems, answeredIds(answers), count).map((p) => ({ session_id: p.sessionId, decision_key: p.key }));
}

/** 問題の一覧と、結びつけが決まっていない迷いの数。 */
export interface CollectedProblems {
  problems: Problem[];
  undecided: number;
}

/** 結果を読み終えた半荘から、問題を集める（並びは、今日の出題の並び）。 */
export function collectProblems(
  sessions: readonly SessionRecord[],
  games: GameMap,
  threshold: number,
): CollectedProblems {
  const { sources, undecided } = sourcesOf(sessions, games);
  return { problems: listProblems(sources, { threshold }), undecided };
}

export function buildStudyModel(input: StudyInput, collected?: CollectedProblems): StudyModel {
  const { sessions, games, answers, threshold, daily, today } = input;
  const { problems, undecided } = collected ?? collectProblems(sessions, games, threshold);
  const byId = new Map(problems.map((p) => [problemId(p), p] as const));
  const sessionById = new Map(sessions.map((s) => [s.id, s] as const));
  const quiz = latestQuizAnswers(answers);

  // 今日の組: 保存してあるものを、そのまま（順番も）使う。消した半荘・見つからない判断は、出さない
  const items: TodayItem[] = [];
  for (const stored of daily ?? []) {
    const ref = refOf(stored);
    const id = problemId(ref);
    let problem = byId.get(id) ?? null;
    if (problem === null) {
      const session = sessionById.get(ref.sessionId);
      const state = games.get(ref.sessionId);
      if (session !== undefined && state !== undefined && state.status === 'ready') {
        problem = problemOf(session, state.game, ref.key);
      }
    }
    if (problem !== null) items.push({ problem, answer: quiz.get(id) ?? null });
  }
  const answered = items.filter((item) => item.answer !== null).length;
  const rest = restOfProblems(
    problems,
    answeredIds(answers),
    items.map((item) => ({ sessionId: item.problem.sessionId, key: item.problem.key })),
  );

  // 解き直し: 問題ごとの最後の答えの期限が今日までのもの（結果が読めない・消した半荘の問題は出さない）
  const due: DueEntry[] = [];
  const present = answers.filter((row) => {
    const state = games.get(row.session_id);
    return sessionById.has(row.session_id) && state !== undefined && state.status === 'ready';
  });
  for (const entry of dueAnswers(latestAnswers(present.map(toAnswerLike)), today)) {
    const session = sessionById.get(entry.sessionId);
    const state = games.get(entry.sessionId);
    if (session === undefined || state === undefined || state.status !== 'ready') continue;
    const decision = findDecisionByKey(state.game, entry.key);
    if (decision === undefined) continue;
    due.push({
      sessionId: entry.sessionId,
      key: entry.key,
      decision,
      game: state.game,
      session,
      answer: entry.row,
      problem: byId.get(problemId(entry)) ?? null,
    });
  }

  return {
    problems,
    today: {
      items,
      answered,
      unanswered: items.length - answered,
      rest,
      undecidedMarks: undecided,
      sessionCount: new Set(items.map((item) => item.problem.sessionId)).size,
    },
    due,
  };
}
