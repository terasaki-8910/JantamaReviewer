/**
 * 週の集計の元の数（ACCEPTANCE の U-30。D-3）の単体試験: 作った答えと、取り込んだ半荘（FX-4・FX-1）から、週ごとの数が手で数えた値になる。
 * - 消した半荘（一覧に無い半荘）の答えは数えない。結果を読めない半荘の答えも数えない
 * - 評価は、局の表の自分の〇△✕と AI 基準（局の表の旗と同じ帯の規則）から。FX-4 の AI 基準は S+・S-・A・S・S-（A だけが△の帯で、あとは〇の帯）
 */
import {
  RATING_LINK_VERSION,
  fitGradeModel,
  findDecisionByKey,
  keyOfDecision,
  problemId,
  regradeSummary,
  type Decision,
  type ImportedGame,
  type Problem,
} from '@jantama/engine';
import { describe, expect, it } from 'vitest';

import { REPORT_TEXTS, local, seedSession } from '../../../tests/fake-sessions';
import { answerRow, gameOf } from '../../../tests/fake-study';
import { FX4_TEXT, fx4Ocr, fx4Session } from '../../../tests/import-fixtures';
import type { AnswerRow, Links, SessionRecord } from '../../api/types';
import { phasesOf } from '../log/logModel';
import { summarizeReportText, type SummaryMap } from '../sessionSummaries';
import type { GameState } from '../study/gameStore';
import type { Located } from '../study/StudyProvider';
import { loseMean, summarizeWeeks, weeksEndingAt } from './weekModel';
import { buildWeekSource, earliestWeek } from './weekSource';

const FX4_ID = '20261009-190953';
const FX1A_ID = '20261002-171200';
const TRASHED_ID = '20261008-120000';
/** 取り込みが保存するとおりの結びつけ（当てはめ方の版つき。版が古いと、半荘のページを開いたとき、当てはめ直される）。 */
const LINKS: Links = {
  marks: {},
  ratings: { '7': 'k0h0', '8': 'k1h0', '9': 'k1h1', '10': 'k2h0', '11': 'k2h1' },
  ratings_version: RATING_LINK_VERSION,
};

const W = '2026-10-05';
const PREV = '2026-09-28';

const fx4Game = gameOf('fx4');
const fx1aGame = gameOf('fx1a');
const discards = (game: ImportedGame) => game.decisions.filter((d) => d.kind === 'discard');

/** FX-4 の半荘（10/9 19:09 = 今週）。自分の〇△✕は 東1局 △・東2局 ✕・東2局1本場 △・東3局 ✕・東3局1本場 ✕。 */
function fx4(): SessionRecord {
  const base = fx4Session(FX4_ID, local(2026, 10, 9, 19, 9), {
    report_path: `C:\\data\\games\\${FX4_ID}\\report.json`,
    ocr: fx4Ocr(),
    links: LINKS,
  });
  const ratings = ['fair', 'bad', 'fair', 'bad', 'bad'] as const;
  return { ...base, ratings: base.ratings.map((r, i) => ({ ...r, rating: ratings[i] ?? r.rating })) };
}

/** FX-1 の f9da の半荘（10/2 17:12 = 先週）。評価の記録は無い。 */
const fx1a = (): SessionRecord => seedSession(local(2026, 10, 2, 17, 12), { id: FX1A_ID, report: 'fx1a' }).session;

const GAMES: Record<string, ImportedGame> = { [FX4_ID]: fx4Game, [FX1A_ID]: fx1aGame, [TRASHED_ID]: fx1aGame };

interface Setup {
  sessions: SessionRecord[];
  answers: AnswerRow[];
  /** 結果を読めない半荘の名前（まとめ・再生が無い）。 */
  unreadable?: string[];
}

const keyOf = (decision: Decision) => keyOfDecision(decision);

function answerOn(id: number, sessionId: string, decision: Decision, at: number, patch: Partial<AnswerRow> = {}): AnswerRow {
  return answerRow({ id, session_id: sessionId, decision_key: keyOf(decision), answered_at: at, ...patch });
}

function sourceOf(setup: Setup, weeks: readonly string[], problems: Problem[] = []) {
  const unreadable = new Set(setup.unreadable ?? []);
  const locate = (sessionId: string, key: string): Located | null => {
    const session = setup.sessions.find((s) => s.id === sessionId);
    const game = GAMES[sessionId];
    if (session === undefined || game === undefined || unreadable.has(sessionId)) return null;
    const decision = findDecisionByKey(game, key);
    return decision === undefined ? null : { session, game, decision };
  };
  const summaries: SummaryMap = new Map(
    setup.sessions
      .filter((s) => s.report_path !== null)
      .map((s) => [s.id, s.id === FX4_ID ? summarizeReportText(FX4_TEXT) : summarizeReportText(REPORT_TEXTS.fx1a)] as const),
  );
  const gameState = (sessionId: string): GameState | undefined => {
    const game = GAMES[sessionId];
    if (game === undefined || unreadable.has(sessionId)) return undefined;
    return { status: 'ready', game };
  };
  const input = {
    sessions: setup.sessions,
    summaries,
    answers: setup.answers,
    locate,
    gameState,
    problems,
    weeks: new Set(weeks),
  };
  return { input, source: buildWeekSource(input), locate };
}

const A = discards(fx4Game)[10] as Decision;
const B = discards(fx4Game)[25] as Decision;
const C = discards(fx1aGame)[12] as Decision;

describe('U-30 週の元の数（答え・半荘から）', () => {
  const setup: Setup = {
    sessions: [fx4(), fx1a()],
    answers: [
      // 今週（10/5〜）: 出題 2・解き直し 1
      answerOn(1, FX4_ID, A, local(2026, 10, 9, 20, 0), { mode: 'quiz', correct: false, causes: ['defense', 'ukeire'] }),
      answerOn(2, FX4_ID, B, local(2026, 10, 8, 21, 0), { mode: 'quiz', correct: true, causes: ['shape'] }),
      answerOn(3, FX1A_ID, C, local(2026, 10, 7, 20, 0), { mode: 'review', correct: true }),
      // 先週
      answerOn(4, FX1A_ID, C, local(2026, 9, 30, 20, 0), { mode: 'quiz', correct: false, causes: ['value'] }),
      // 消した半荘（一覧に無い）の答え: どの週にも数えない
      answerOn(5, TRASHED_ID, C, local(2026, 10, 8, 22, 0), { mode: 'quiz', correct: false, causes: ['other'] }),
    ],
  };

  it('答えた局面は、答えた週に数える。消した半荘（一覧に無い）の答えは数えない', () => {
    const { source } = sourceOf({ ...setup, sessions: setup.sessions }, [PREV, W]);
    // TRASHED_ID は sessions に無いので locate が null を返す
    expect(source.answers.map((a) => [a.week, a.mode, a.correct])).toEqual([
      [W, 'quiz', false],
      [W, 'quiz', true],
      [W, 'review', true],
      [PREV, 'quiz', false],
    ]);
    const weeks = summarizeWeeks([PREV, W], source);
    expect(weeks.get(W)?.answers).toBe(3);
    expect([weeks.get(W)?.quiz, weeks.get(W)?.review]).toEqual([2, 1]);
    expect(weeks.get(W)?.causeCounts).toEqual({ ukeire: 1, shape: 1, value: 0, defense: 1, other: 0 });
    expect(weeks.get(W)?.causePercents).toEqual({ ukeire: 33, shape: 33, value: 0, defense: 33, other: 0 });
    expect(weeks.get(PREV)?.causeCounts.value).toBe(1);
    expect(weeks.get(W)?.causeCounts.other).toBe(0);
  });

  it('局面の種類は、検討ログと同じ（場面の向聴数と、鳴き・押し引き・序盤のタグ）', () => {
    const { source } = sourceOf(setup, [PREV, W]);
    expect(source.answers[0]?.phases).toEqual(phasesOf(A.shanten, A.tags));
    expect(source.answers[2]?.phases).toEqual(phasesOf(C.shanten, C.tags));
    expect(source.answers[0]?.phases.length).toBeGreaterThan(0);
  });

  it('結果を読めない半荘の答えは、数えない（局面を引けない）', () => {
    const { source } = sourceOf({ ...setup, unreadable: [FX1A_ID] }, [PREV, W]);
    expect(source.answers.map((a) => a.week)).toEqual([W, W]);
    // 取り込んだ半荘の数には入る（取り込んである。評価と答えだけが、読めないので数えられない）
    expect(source.games).toEqual([W, PREV]);
    expect(source.evaluations.every((e) => e.week === W)).toBe(true);
  });

  it('数える週の外の答え・半荘・迷いは、作らない', () => {
    const { source } = sourceOf(setup, [W]);
    expect(source.answers.every((a) => a.week === W)).toBe(true);
    expect(source.games).toEqual([W]);
    expect(source.marks.every((m) => m.week === W)).toBe(true);
    expect(source.evaluations.every((e) => e.week === W)).toBe(true);
  });

  it('取り込んだ半荘は、始めた週で数える。取り込み前の半荘は数えない', () => {
    const notImported = seedSession(local(2026, 10, 6, 10, 0), { marks: 2 }).session;
    const { source } = sourceOf({ sessions: [fx4(), fx1a(), notImported], answers: [] }, [PREV, W]);
    expect([...source.games].sort()).toEqual([PREV, W]);
    // 取り込み前の半荘の迷い（押した時刻の週）は、数える
    expect(source.marks.filter((m) => m.week === W)).toHaveLength(6 + 2);
  });

  it('迷いマークは押した週で数え、「答えたもの」は、その迷いの問題に答えがあるもの', () => {
    const problem = (markNumber: number, decision: Decision): Problem => ({
      sessionId: FX4_ID,
      key: keyOf(decision),
      kind: 'mark',
      markNumber,
      startedMs: 0,
      probability: 0.5,
      fineMiss: false,
      decision,
    });
    // 迷い 1 は A、迷い 2 は B、迷い 3 は答えの無い判断。迷い 1・2 に答えがある
    const other = discards(fx4Game)[40] as Decision;
    const { source } = sourceOf(setup, [PREV, W], [problem(1, A), problem(2, B), problem(3, other)]);
    const week = summarizeWeeks([W], source).get(W);
    expect(week?.marks).toBe(6);
    expect(week?.marksAnswered).toBe(2);
    // 解き直しの答えだけでも、「答えた」
    const withReview = sourceOf(
      { ...setup, answers: [answerOn(9, FX4_ID, other, local(2026, 10, 10, 9, 0), { mode: 'review' })] },
      [W],
      [problem(3, other)],
    ).source;
    expect(summarizeWeeks([W], withReview).get(W)?.marksAnswered).toBe(1);
  });

  it('評価: 自分の〇△✕と AI 基準がそろった局が、結果つきで入る。FX-4 は 5 局（東2局1本場の△と A だけが同じ帯）', () => {
    const { source } = sourceOf(setup, [PREV, W]);
    // 東1局 △（S+）・東2局 ✕（S-）・東2局1本場 △（A）・東3局 ✕（S）・東3局1本場 ✕（S-）。自分 - AI 基準 = -1・-2・0・-2・-2
    // 結果: 他家のツモ・他家のツモ・自分の和了・放銃・放銃
    expect(source.evaluations.map((e) => [e.week, e.result, e.offset])).toEqual([
      [W, 'others', -1],
      [W, 'others', -2],
      [W, 'win', 0],
      [W, 'dealIn', -2],
      [W, 'dealIn', -2],
    ]);
    const week = summarizeWeeks([W], source).get(W);
    expect(week?.evaluated).toBe(5);
    expect(week?.agreed).toBe(1);
    expect(week?.agreePercent).toBe(20);
    expect(week?.results.map((r) => [r.id, r.n, r.mean])).toEqual([
      ['win', 1, 0],
      ['dealIn', 2, -2],
      ['draw', 0, null],
      ['others', 2, -1.5],
    ]);
    expect(loseMean(week as NonNullable<typeof week>)?.mean).toBeCloseTo(-1.75, 10);
  });

  it('表で付け直した自分の〇△✕が、評価に反映される。評価なしにした局は数えない', () => {
    const edited: SessionRecord = {
      ...fx4(),
      self_ratings: { kyokus: { k0h0: 'good', k1h0: 'none', k2h0: 'good' } },
    };
    const { source } = sourceOf({ sessions: [edited, fx1a()], answers: [] }, [W]);
    // 東1局 〇（S+）= 0、東2局 評価なし、東2局1本場 △（A）= 0、東3局 〇（S）= 0、東3局1本場 ✕（S-）= -2
    expect(source.evaluations.map((e) => [e.result, e.offset])).toEqual([
      ['others', 0],
      ['win', 0],
      ['dealIn', 0],
      ['dealIn', -2],
    ]);
    const week = summarizeWeeks([W], source).get(W);
    // 東1局・東2局1本場・東3局 が同じ帯で一致、東3局1本場（✕と S-）だけがずれる
    expect([week?.evaluated, week?.agreed, week?.agreePercent]).toEqual([4, 3, 75]);
  });

  it('AI 基準の段階は、渡したまとめの段階（MAKA の評価から合わせ直した当てはめのもの）から決まる', () => {
    // 点数がどれも C- になる当てはめ（✕の帯）に付け直したまとめ: 自分 ✕ の局は一致（0）、△ の局は +1
    const low = fitGradeModel([{ game: 'x', score: 90, grade: 'C-' }]);
    const state = summarizeReportText(FX4_TEXT);
    if (state.status !== 'ready') throw new Error('読めない');
    const regraded: SummaryMap = new Map([[FX4_ID, { status: 'ready', summary: regradeSummary(state.summary, low) }]]);
    const base = sourceOf({ sessions: [fx4()], answers: [] }, [W]);
    const source = buildWeekSource({ ...base.input, summaries: regraded });
    // 東1局 △・東2局 ✕・東2局1本場 △・東3局 ✕・東3局1本場 ✕。AI 基準はすべて C-（✕の帯）
    expect(source.evaluations.map((e) => [e.result, e.offset])).toEqual([
      ['others', 1],
      ['others', 0],
      ['win', 1],
      ['dealIn', 0],
      ['dealIn', 0],
    ]);
    const week = summarizeWeeks([W], source).get(W);
    expect([week?.agreed, week?.evaluated, week?.agreePercent]).toEqual([3, 5, 60]);
  });

  it('評価の記録が無い半荘は、評価に出ない（自分の〇△✕が無い局は比べない）', () => {
    const { source } = sourceOf(setup, [PREV]);
    expect(source.evaluations).toEqual([]);
  });

  it('日の区切り: 月曜の午前 3 時 59 分の答えは前の週、午前 4 時の答えは今週', () => {
    const answers = [
      answerOn(1, FX4_ID, A, local(2026, 10, 5, 3, 59)),
      answerOn(2, FX4_ID, B, local(2026, 10, 5, 4, 0)),
      answerOn(3, FX4_ID, discards(fx4Game)[11] as Decision, local(2026, 10, 12, 3, 59)),
      answerOn(4, FX4_ID, discards(fx4Game)[12] as Decision, local(2026, 10, 12, 4, 0)),
    ];
    const weeks = ['2026-09-28', '2026-10-05', '2026-10-12'];
    const { source } = sourceOf({ sessions: [fx4()], answers }, weeks);
    expect(source.answers.map((a) => a.week)).toEqual(['2026-09-28', '2026-10-05', '2026-10-05', '2026-10-12']);
    expect(weeks).toEqual(weeksEndingAt('2026-10-12', 3));
  });
});

describe('U-30 週の ← の行ける範囲の元（記録のあるいちばん古い週）', () => {
  it('答え・半荘・迷い・成績の記録のうち、いちばん古い週の月曜。消した半荘の答えは数えない', () => {
    const sessions = [fx4(), fx1a()];
    const { locate } = sourceOf({ sessions, answers: [] }, [W]);
    const old = answerOn(1, FX4_ID, A, local(2026, 8, 12, 20, 0));
    const trashed = answerOn(2, TRASHED_ID, C, local(2026, 6, 1, 20, 0));
    expect(earliestWeek({ sessions, answers: [old, trashed], locate, recordWeeks: [] })).toBe('2026-08-10');
    // 答えが無ければ、半荘（始めた週）・迷いマーク（押した週）から
    expect(earliestWeek({ sessions, answers: [trashed], locate, recordWeeks: [] })).toBe(PREV);
    // 成績の記録の週も数える
    expect(earliestWeek({ sessions, answers: [], locate, recordWeeks: ['2026-07-27'] })).toBe('2026-07-27');
    expect(earliestWeek({ sessions: [], answers: [trashed], locate, recordWeeks: [] })).toBeNull();
  });

  it('problemId は、半荘の名前と判断の鍵（迷いの答えを探す鍵）', () => {
    expect(problemId({ sessionId: 'a', key: 'k0h0e1' })).toBe('a/k0h0e1');
  });
});
