/**
 * 週の集計の元になる数（`WeekSource`）を、保存した答え・取り込んだ半荘から組み立てる（U-30）。
 *
 * - 答え: 保存した答え 1 件 = 答えた局面 1 つ。消した半荘（一覧に無い）・結果を読めない半荘の答えは、数えない（D-3。検討ログと同じ）。
 *   局面の種類は、検討ログの絞り込みと同じ（`phasesOf`）
 * - 評価: 取り込んだ半荘の局の表（`buildHandTable`。局の表の旗と同じ自分の〇△✕・AI 基準の段階）のうち、自分の〇△✕と AI 基準が
 *   そろった局。結果（和了・放銃・流局・他家の和了）は、半荘のまとめの局の結果。AI 基準の段階は、MAKA の評価から合わせ直した当てはめのもの
 * - 迷いマーク: 押した週ごとに数える。「答えたもの」は、その迷いの問題に答えが 1 つでもあるもの
 * - 半荘: 結果を取り込んだ半荘を、半荘を始めた週ごとに数える
 * 数える週（`weeks`）の外のものは、作らない（局の表の組み立ては、局の評価の結びつけを当てはめ直すので、少し重い）。
 * 局の表の組み立ては、半荘・まとめ・再生した結果が同じものである間は、覚えておく。
 */
import { markOffsetFromGrade, problemId, type HanchanSummary, type Problem } from '@jantama/engine';

import type { AnswerRow, SessionRecord } from '../../api/types';
import { buildHandTable } from '../handRows';
import { phasesOf } from '../log/logModel';
import type { SummaryMap } from '../sessionSummaries';
import type { GameState } from '../study/gameStore';
import type { Located } from '../study/StudyProvider';
import { resultOf, weekOfInstant, type WeekEvaluation, type WeekSource } from './weekModel';

export interface WeekSourceInput {
  /** 消していない半荘（一覧に出ているもの）。 */
  sessions: readonly SessionRecord[];
  summaries: SummaryMap;
  answers: readonly AnswerRow[];
  /** 半荘の名前と判断の鍵から、半荘・再生した結果・判断を引く。無ければ null。 */
  locate: (sessionId: string, key: string) => Located | null;
  gameState: (sessionId: string) => GameState | undefined;
  /** 問題の一覧（迷いの問題を、迷いの番号から引く）。 */
  problems: readonly Problem[];
  /** 数える週の月曜。 */
  weeks: ReadonlySet<string>;
}

interface CachedEvaluations {
  summary: HanchanSummary;
  game: object;
  rows: ReadonlyArray<{ result: WeekEvaluation['result']; offset: number }>;
}

/** 半荘ごとの、評価のある局の一覧。半荘（保存した値）・まとめ・再生した結果が同じなら、組み立て直さない。 */
const evaluationCache = new WeakMap<SessionRecord, CachedEvaluations>();

function evaluationsOf(session: SessionRecord, summary: HanchanSummary, game: Extract<GameState, { status: 'ready' }>['game']) {
  const cached = evaluationCache.get(session);
  if (cached !== undefined && cached.summary === summary && cached.game === game) return cached.rows;
  const table = buildHandTable({ report: game.report, summary, session });
  const rows: Array<{ result: WeekEvaluation['result']; offset: number }> = [];
  for (const row of table.rows) {
    const offset = markOffsetFromGrade(row.self, row.grade);
    const kyoku = summary.kyokus[row.position];
    if (offset === null || kyoku === undefined) continue;
    rows.push({ result: resultOf(kyoku.outcome.kind), offset });
  }
  evaluationCache.set(session, { summary, game, rows });
  return rows;
}

export function buildWeekSource(input: WeekSourceInput): WeekSource {
  const { sessions, summaries, answers, locate, gameState, problems, weeks } = input;

  const located = new Set<string>();
  const weekAnswers: WeekSource['answers'][number][] = [];
  for (const answer of answers) {
    const found = locate(answer.session_id, answer.decision_key);
    if (found === null) continue;
    const id = problemId({ sessionId: answer.session_id, key: answer.decision_key });
    located.add(id);
    const week = weekOfInstant(answer.answered_at);
    if (!weeks.has(week)) continue;
    weekAnswers.push({
      week,
      mode: answer.mode,
      correct: answer.correct,
      causes: answer.causes,
      phases: phasesOf(found.decision.shanten, found.decision.tags),
    });
  }

  const markProblems = new Map<string, Problem>();
  for (const problem of problems) {
    if (problem.markNumber !== null) markProblems.set(`${problem.sessionId}#${problem.markNumber}`, problem);
  }

  const marks: WeekSource['marks'][number][] = [];
  const games: string[] = [];
  const evaluations: WeekEvaluation[] = [];
  for (const session of sessions) {
    session.marks.forEach((mark, index) => {
      const week = weekOfInstant(mark.t_ms);
      if (!weeks.has(week)) return;
      const problem = markProblems.get(`${session.id}#${index + 1}`);
      marks.push({ week, answered: problem !== undefined && located.has(problemId(problem)) });
    });
    if (session.report_path === null) continue;
    const week = weekOfInstant(session.started_ms);
    if (!weeks.has(week)) continue;
    games.push(week);
    const summary = summaries.get(session.id);
    const game = gameState(session.id);
    if (summary?.status !== 'ready' || game?.status !== 'ready') continue;
    for (const row of evaluationsOf(session, summary.summary, game.game)) evaluations.push({ week, ...row });
  }
  return { answers: weekAnswers, evaluations, marks, games };
}

/**
 * 記録のあるいちばん古い週の月曜（答え・半荘・迷いマーク・成績の記録のどれでも）。何も無ければ null。
 * 答えは、消した半荘のものを数えない（`locate`）。
 */
export function earliestWeek(input: {
  sessions: readonly SessionRecord[];
  answers: readonly AnswerRow[];
  locate: WeekSourceInput['locate'];
  recordWeeks: readonly string[];
}): string | null {
  let earliest: string | null = null;
  const see = (week: string) => {
    if (earliest === null || week < earliest) earliest = week;
  };
  for (const answer of input.answers) {
    if (input.locate(answer.session_id, answer.decision_key) !== null) see(weekOfInstant(answer.answered_at));
  }
  for (const session of input.sessions) {
    see(weekOfInstant(session.started_ms));
    for (const mark of session.marks) see(weekOfInstant(mark.t_ms));
  }
  for (const week of input.recordWeeks) see(week);
  return earliest;
}
