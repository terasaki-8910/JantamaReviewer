/**
 * 検索の重ね表示の、検索・絞り込み・並べ替え（ACCEPTANCE の U-22）。
 * 半荘と問題は、エンジンの試験の固定データ（FX-1 の 5 半荘と FX-4）を、日付をずらして並べたものから作る。
 */
import { keyOfDecision, listProblems, type ImportedGame } from '@jantama/engine';
import { describe, expect, it } from 'vitest';

import { REPORT_TEXTS, local, seedSession, type ReportKey } from '../../../tests/fake-sessions';
import { answerRow, gameOf } from '../../../tests/fake-study';
import type { AnswerRow } from '../../api/types';
import { DISPLAY_GRADES } from '../GradeBadge';
import { buildListRows } from '../sessionRows';
import { summarizeReportText, type SummaryMap } from '../sessionSummaries';
import {
  FRESH_SEARCH,
  GAME_LIMIT,
  PERIODS,
  PROBLEM_LIMIT,
  SORTS,
  buildSearchModel,
  dateHits,
  hasAnyCondition,
  hasConditions,
  limitResult,
  runSearch,
  type SearchModel,
  type SearchState,
} from './searchModel';
import { queryTerms } from '../sessionFilter';

/** 試験の「いま」: 2026 年 10 月 9 日 22:00。 */
const NOW = local(2026, 10, 9, 22, 0);
const THRESHOLD = 0.05;

interface Seed {
  id: string;
  at: number;
  report?: ReportKey;
  /** 迷いマークの数（一覧の「迷い N」）。 */
  marks?: number;
  /** 迷いに結びつけた判断（半荘の判断の通し番号）。迷いの問題になる。 */
  marked?: number[];
  memo?: string;
}

/** 日付をずらした 7 半荘（新しい順）。g7 は、結果を取り込む前。 */
const SEEDS: Seed[] = [
  { id: 'g1', at: local(2026, 10, 9, 19, 9), report: 'fx4', marks: 3, marked: [3, 20, 40], memo: '放銃を見直す' },
  { id: 'g2', at: local(2026, 10, 9, 17, 12), report: 'fx1a', memo: '3mを切った場面が悪かった' },
  { id: 'g3', at: local(2026, 10, 8, 21, 40), report: 'fx1d' },
  { id: 'g4', at: local(2026, 10, 8, 20, 55), report: 'fx1c', memo: '親番で押しすぎた' },
  { id: 'g5', at: local(2026, 10, 7, 22, 10), report: 'fx1b', marks: 2, marked: [5, 60] },
  { id: 'g6', at: local(2026, 10, 4, 20, 12), report: 'fx1e' },
  { id: 'g7', at: local(2026, 10, 2, 22, 5), marks: 1 },
];

interface Built {
  model: SearchModel;
  games: Map<string, ImportedGame>;
}

function build(options: { answers?: AnswerRow[]; ready?: boolean; seeds?: Seed[] } = {}): Built {
  const seeds = options.seeds ?? SEEDS;
  const sessions = seeds.map((seed) =>
    seedSession(seed.at, { id: seed.id, marks: seed.marks ?? 0, ...(seed.report ? { report: seed.report } : {}) }).session,
  );
  const summaries = new Map(
    seeds.flatMap((seed) => (seed.report ? [[seed.id, summarizeReportText(REPORT_TEXTS[seed.report])] as const] : [])),
  ) as SummaryMap;
  const rows = buildListRows(sessions, summaries).map((row) => {
    const memo = seeds.find((seed) => seed.id === row.id)?.memo;
    return memo === undefined ? row : { ...row, memo };
  });
  const games = new Map<string, ImportedGame>();
  const sources = seeds.flatMap((seed) => {
    if (!seed.report) return [];
    const game = gameOf(seed.report);
    games.set(seed.id, game);
    const markKeys = (seed.marked ?? []).map((index) => keyOfDecision(game.decisions[index] as never));
    return [{ sessionId: seed.id, startedMs: seed.at, game, markKeys }];
  });
  const ready = options.ready ?? true;
  const model = buildSearchModel({
    rows,
    summaries,
    problems: ready ? listProblems(sources, { threshold: THRESHOLD }) : [],
    problemsReady: ready,
    answers: options.answers ?? [],
    threshold: THRESHOLD,
    now: NOW,
  });
  return { model, games };
}

const { model: MODEL } = build();

const search = (patch: Partial<SearchState> = {}, model: SearchModel = MODEL) =>
  runSearch(model, { ...FRESH_SEARCH, ...patch }, NOW);
const gameIds = (patch: Partial<SearchState> = {}, model: SearchModel = MODEL) =>
  search(patch, model).games.map((g) => g.id);
const problemsOf = (patch: Partial<SearchState> = {}, model: SearchModel = MODEL) => search(patch, model).problems;

describe('U-22: 検索の元になる値', () => {
  it('半荘は一覧の行と同じ数、問題は今日の出題と同じ一覧（大きな不一致 + 迷いに結びついた判断）。取り込み前の半荘には、問題が無い', () => {
    expect(MODEL.games.map((g) => g.id)).toEqual(['g1', 'g2', 'g3', 'g4', 'g5', 'g6', 'g7']);
    const perGame = (id: string) => MODEL.problems.filter((p) => p.sessionId === id).length;
    // 取り込み済みの半荘ごとの問題の数: 大きな不一致（FX-1 の件数は ACCEPTANCE の固定データ）と、迷いに結びついた判断の数だけ増える
    expect(perGame('g2')).toBe(19);
    expect(perGame('g3')).toBe(15);
    expect(perGame('g6')).toBe(22);
    expect(perGame('g7')).toBe(0);
    expect(MODEL.problems.every((p) => p.markNumber !== null || p.probability < THRESHOLD)).toBe(true);
    expect(MODEL.games.find((g) => g.id === 'g1')?.problemCount).toBe(perGame('g1'));
    expect(MODEL.games.find((g) => g.id === 'g7')?.problemCount).toBe(0);
  });

  it('半荘の局の名前（東1局・東2局1本場 …）を持つ。取り込み前は空', () => {
    const g2 = MODEL.games.find((g) => g.id === 'g2');
    expect(g2?.kyokus).toContain('東4局');
    expect(g2?.kyokus).toContain('東4局1本場');
    expect(g2?.kyokus).toHaveLength(12);
    expect(MODEL.games.find((g) => g.id === 'g1')?.kyokus).toEqual(['東1局', '東2局', '東2局1本場', '東3局', '東3局1本場']);
    expect(MODEL.games.find((g) => g.id === 'g7')?.kyokus).toEqual([]);
  });

  it('半荘の要約（メモが無いときの 2 行目）と、結果の読み込み前・取り込み前の言い方', () => {
    expect(MODEL.games.find((g) => g.id === 'g1')?.summary).toBe('5局 · 東3局1本場で終了');
    expect(MODEL.games.find((g) => g.id === 'g2')?.summary).toBe('12局 · 西1局で終了');
    expect(MODEL.games.find((g) => g.id === 'g7')?.summary).toBe('取り込み前');
    expect(MODEL.games.find((g) => g.id === 'g1')?.memo).toBe('放銃を見直す');
    expect(MODEL.games.find((g) => g.id === 'g3')?.memo).toBeNull();
  });

  it('問題の行の元: 局と巡目・種類・シャンテン数・どの半荘か。迷いの問題には迷いの番号', () => {
    const first = MODEL.problems.find((p) => p.sessionId === 'g2' && p.title === '東4局 13巡目');
    expect(first).toMatchObject({ kindName: '打牌', shanten: '1シャンテン', where: '10月9日 17:12 の半荘', answered: false });
    expect(first?.markNumber).toBeNull();
    const marked = MODEL.problems.filter((p) => p.sessionId === 'g1' && p.markNumber !== null);
    expect(marked.map((p) => p.markNumber).sort()).toEqual([1, 2, 3]);
  });

  it('答えた問題は「解答済み」。学んだ原則は、いちばん新しい答えのもの', () => {
    const target = MODEL.problems.find((p) => p.sessionId === 'g2' && p.title === '東4局 13巡目');
    const answers = [
      answerRow({ id: 1, session_id: 'g2', decision_key: target?.key ?? '', answered_at: 100, principle: '前の原則' }),
      answerRow({ id: 2, session_id: 'g2', decision_key: target?.key ?? '', answered_at: 200, principle: '受け入れを数えてから切る' }),
    ];
    const { model } = build({ answers });
    const answered = model.problems.find((p) => p.sessionId === 'g2' && p.key === target?.key);
    expect(answered).toMatchObject({ answered: true, principle: '受け入れを数えてから切る' });
    expect(model.games.find((g) => g.id === 'g2')?.unanswered).toBe(18);
    expect(model.games.find((g) => g.id === 'g3')?.unanswered).toBe(15);
  });

  it('問題を読み終えるまでは、問題が空で、半荘の問題の数は null（0 と出さない）', () => {
    const { model } = build({ ready: false });
    expect(model.problems).toEqual([]);
    expect(model.problemsReady).toBe(false);
    expect(model.games.every((g) => g.problemCount === null && g.unanswered === null)).toBe(true);
  });
});

describe('U-22: 半荘の検索（日付・卓・メモ・局）', () => {
  it('日付: 10/9・10月9日・本日・昨日。数字で始まる語は、別の数字の途中には当たらない', () => {
    expect(gameIds({ query: '10/9', games: true })).toEqual(['g1', 'g2']);
    expect(gameIds({ query: '10月9日', games: true })).toEqual(['g1', 'g2']);
    expect(gameIds({ query: '本日', games: true })).toEqual(['g1', 'g2']);
    expect(gameIds({ query: '昨日', games: true })).toEqual(['g3', 'g4']);
    expect(gameIds({ query: '10/7', games: true })).toEqual(['g5']);
    expect(gameIds({ query: '１０／７', games: true })).toEqual(['g5']);
    expect(gameIds({ query: '0/9', games: true })).toEqual([]);
    expect(gameIds({ query: '2026年10月4日', games: true })).toEqual(['g6']);
  });

  it('開始時刻・段階・Rating・迷いの数にも当たる（半荘の一覧の検索と同じ）', () => {
    expect(gameIds({ query: '19:09', games: true })).toEqual(['g1']);
    expect(gameIds({ query: '迷い3', games: true })).toEqual(['g1']);
    expect(gameIds({ query: '取り込み前', games: true })).toEqual(['g7']);
    expect(gameIds({ query: '93.0', games: true })).toEqual(['g1']);
  });

  it('卓: 玉の間は、取り込み済みの半荘すべて（取り込み前は卓が分からない）', () => {
    expect(gameIds({ query: '玉の間', games: true })).toEqual(['g1', 'g2', 'g3', 'g4', 'g5', 'g6']);
    expect(gameIds({ query: '玉の間 昨日', games: true })).toEqual(['g3', 'g4']);
    expect(gameIds({ query: '金の間', games: true })).toEqual([]);
  });

  it('メモの文字（空白で区切った語は、すべてに当たるものだけ）', () => {
    expect(gameIds({ query: '親番', games: true })).toEqual(['g4']);
    expect(gameIds({ query: '放銃 見直す', games: true })).toEqual(['g1']);
    expect(gameIds({ query: '放銃 親番', games: true })).toEqual([]);
  });

  it('局: 東4局 → 東4局（と東4局1本場）を持つ半荘。東4局を持たない半荘は出ない', () => {
    const ids = gameIds({ query: '東4局', games: true });
    expect(ids).toEqual(['g2', 'g3', 'g4', 'g5', 'g6']);
    expect(ids).not.toContain('g1');
    expect(ids).not.toContain('g7');
    expect(gameIds({ query: '東4局1本場', games: true })).toEqual(['g2', 'g3', 'g4', 'g5', 'g6']);
    expect(gameIds({ query: '東4局3本場', games: true })).toEqual(['g4']);
    expect(gameIds({ query: '東3局1本場 東4局', games: true })).toEqual(['g2', 'g5']);
    expect(gameIds({ query: '東5局', games: true })).toEqual([]);
  });

  it('「半荘」「問題」という言葉は、その種類だけに当たる', () => {
    expect(gameIds({ query: '半荘' })).toHaveLength(7);
    expect(problemsOf({ query: '半荘' })).toEqual([]);
    expect(gameIds({ query: '問題' })).toEqual([]);
    expect(problemsOf({ query: '問題' })).toHaveLength(MODEL.problems.length);
  });
});

describe('U-22: 問題の検索（局・巡目・種類・その半荘の日付・卓・メモ）', () => {
  const titles = (patch: Partial<SearchState>) => problemsOf({ problems: true, ...patch }).map((p) => `${p.sessionId} ${p.title}`);

  it('局の名前: 東4局 → 東4局（と東4局1本場）の問題。ほかの局の問題は出ない', () => {
    const found = problemsOf({ query: '東4局' });
    expect(found.length).toBeGreaterThan(5);
    expect(found.every((p) => p.title.startsWith('東4局'))).toBe(true);
    // 東4局を持たない g1（FX-4）の問題は出ない
    expect(found.some((p) => p.sessionId === 'g1')).toBe(false);
    const exact = problemsOf({ query: '東4局1本場' });
    expect(exact.every((p) => p.title.startsWith('東4局1本場'))).toBe(true);
    expect(exact.length).toBeLessThan(found.length);
  });

  it('局と巡目: 東4局 13巡目 → f9da（g2）の東4局 13巡目 の問題（実戦の打3m。E-4 の 1 件目）', () => {
    expect(titles({ query: '東4局 13巡目' })).toContain('g2 東4局 13巡目');
    expect(problemsOf({ query: '東4局 13巡目' }).every((p) => p.title.includes('13巡目'))).toBe(true);
    // 巡目の数字は、別の数字の途中には当たらない（4巡目に 14巡目は当たらない）
    expect(problemsOf({ query: '4巡目' }).every((p) => /(^|\D)4巡目/.test(p.title))).toBe(true);
  });

  it('種類とシャンテン数', () => {
    expect(problemsOf({ query: '打牌' }).every((p) => p.kindName === '打牌')).toBe(true);
    expect(problemsOf({ query: '2シャンテン' }).every((p) => p.shanten === '2シャンテン')).toBe(true);
    expect(problemsOf({ query: '2シャンテン' }).length).toBeGreaterThan(0);
    expect(problemsOf({ query: 'リーチ' }).length).toBeGreaterThan(0);
    expect(problemsOf({ query: 'リーチ' }).every((p) => p.kindName === 'リーチ')).toBe(true);
  });

  it('その半荘の日付・開始時刻・卓・メモにも当たる（問題が、日付で絞れる）', () => {
    const yesterday = problemsOf({ query: '昨日' });
    expect(new Set(yesterday.map((p) => p.sessionId))).toEqual(new Set(['g3', 'g4']));
    expect(yesterday).toHaveLength(MODEL.problems.filter((p) => p.sessionId === 'g3' || p.sessionId === 'g4').length);
    expect(new Set(problemsOf({ query: '10/9' }).map((p) => p.sessionId))).toEqual(new Set(['g1', 'g2']));
    expect(new Set(problemsOf({ query: '17:12' }).map((p) => p.sessionId))).toEqual(new Set(['g2']));
    expect(new Set(problemsOf({ query: '親番' }).map((p) => p.sessionId))).toEqual(new Set(['g4']));
    expect(problemsOf({ query: '玉の間' })).toHaveLength(MODEL.problems.length);
  });

  it('その半荘の局の名前や Rating には当たらない（問題は、自分の局の名前だけ）', () => {
    // 東3局1本場を持つ g2 の、ほかの局の問題は、東3局1本場では出ない
    const found = problemsOf({ query: '東3局1本場' });
    expect(found.every((p) => p.title.startsWith('東3局1本場'))).toBe(true);
    expect(problemsOf({ query: '93.0' })).toEqual([]);
  });

  it('迷い: 迷いの問題だけに当たる（迷いの番号でも）', () => {
    const found = problemsOf({ query: '迷い' });
    expect(found.length).toBeGreaterThan(0);
    expect(found.every((p) => p.markNumber !== null)).toBe(true);
    expect(problemsOf({ query: '迷い2' }).map((p) => `${p.sessionId}:${p.markNumber}`).sort()).toEqual(['g1:2', 'g5:2']);
  });

  it('解答の状態と、学んだ原則の文字', () => {
    const target = MODEL.problems.find((p) => p.sessionId === 'g2' && p.title === '東4局 13巡目');
    const { model } = build({
      answers: [answerRow({ id: 1, session_id: 'g2', decision_key: target?.key ?? '', principle: '受け入れを数えてから切る' })],
    });
    const answered = runSearch(model, { ...FRESH_SEARCH, query: '解答済み' }, NOW).problems;
    expect(answered.map((p) => `${p.sessionId} ${p.title}`)).toEqual(['g2 東4局 13巡目']);
    expect(runSearch(model, { ...FRESH_SEARCH, query: '未解答' }, NOW).problems).toHaveLength(model.problems.length - 1);
    const byPrinciple = runSearch(model, { ...FRESH_SEARCH, query: '受け入れ 数えて' }, NOW).problems;
    expect(byPrinciple.map((p) => p.title)).toEqual(['東4局 13巡目']);
    expect(byPrinciple[0]?.principle).toBe('受け入れを数えてから切る');
  });

  it('当たる問題が無いとき・語が全部に当たらないとき', () => {
    expect(problemsOf({ query: '東5局' })).toEqual([]);
    expect(problemsOf({ query: '東4局 打牌 99巡目' })).toEqual([]);
  });
});

describe('U-22: 絞り込み（種類・段階・期間・迷いあり・未解答）', () => {
  it('種類: どちらも切なら、半荘と問題の両方。片方だけ入れると、その種類だけ。両方入れると、両方', () => {
    expect(search().games).toHaveLength(7);
    expect(search().problems).toHaveLength(MODEL.problems.length);
    expect(search({ games: true }).problems).toEqual([]);
    expect(search({ games: true }).games).toHaveLength(7);
    expect(search({ problems: true }).games).toEqual([]);
    expect(search({ problems: true }).problems).toHaveLength(MODEL.problems.length);
    expect(search({ games: true, problems: true }).games).toHaveLength(7);
    expect(search({ games: true, problems: true }).problems).toHaveLength(MODEL.problems.length);
  });

  it('段階: 半荘の一覧と同じ選び方（A 以下 = A+ から下。取り込み前は、段階を選ぶと出ない）。問題は、その半荘の段階', () => {
    const grades = new Map(MODEL.games.map((g) => [g.id, g.row.grade] as const));
    expect(grades.get('g1')).toBe('S-');
    expect(grades.get('g5')).toBe('A+');
    expect(grades.get('g2')).toBe('A');
    const below = (from: number) => [...grades].filter(([, g]) => g !== null && DISPLAY_GRADES.indexOf(g) >= from).map(([id]) => id);
    expect(gameIds({ stage: 'A' })).toEqual(below(3));
    expect(gameIds({ stage: 'A' })).toEqual(['g2', 'g4', 'g5', 'g6']);
    expect(gameIds({ stage: 'B' })).toEqual([]);
    expect(gameIds({ stage: 'all' })).toContain('g7');
    expect(gameIds({ stage: 'A' })).not.toContain('g7');
    expect(new Set(problemsOf({ stage: 'A' }).map((p) => p.sessionId))).toEqual(new Set(['g2', 'g4', 'g5', 'g6']));
    expect(problemsOf({ stage: 'B' })).toEqual([]);
  });

  it('期間: すべて・本日・昨日まで・7日以内・30日以内（暦の日で数える）', () => {
    expect(PERIODS.map((p) => p.label)).toEqual(['すべて', '本日', '昨日まで', '7日以内', '30日以内']);
    expect(gameIds({ period: 'all' })).toHaveLength(7);
    expect(gameIds({ period: 'today' })).toEqual(['g1', 'g2']);
    expect(gameIds({ period: 'yesterday' })).toEqual(['g1', 'g2', 'g3', 'g4']);
    expect(gameIds({ period: 'week' })).toEqual(['g1', 'g2', 'g3', 'g4', 'g5', 'g6']);
    expect(gameIds({ period: 'month' })).toHaveLength(7);
    expect(new Set(problemsOf({ period: 'today' }).map((p) => p.sessionId))).toEqual(new Set(['g1', 'g2']));
    expect(new Set(problemsOf({ period: 'week' }).map((p) => p.sessionId))).toEqual(new Set(['g1', 'g2', 'g3', 'g4', 'g5', 'g6']));
  });

  it('期間の境目: 7日前の 0 時ちょうど（10月3日）は 7日以内に入り、8日前（10月2日）は入らない', () => {
    expect(gameIds({ period: 'week' })).not.toContain('g7');
    const edge = build({
      seeds: [
        { id: 'a', at: local(2026, 10, 3, 0, 0), report: 'fx1a' },
        { id: 'b', at: local(2026, 10, 2, 23, 59), report: 'fx1b' },
      ],
    }).model;
    expect(gameIds({ period: 'week' }, edge)).toEqual(['a']);
  });

  it('迷いあり: 迷いマークのある半荘と、迷いに結びついた問題', () => {
    expect(gameIds({ doubt: true })).toEqual(['g1', 'g5', 'g7']);
    const found = problemsOf({ doubt: true });
    expect(found.length).toBe(5);
    expect(found.every((p) => p.markNumber !== null)).toBe(true);
    expect(new Set(found.map((p) => p.sessionId))).toEqual(new Set(['g1', 'g5']));
  });

  it('未解答: まだ答えていない問題と、そういう問題がある半荘（全部答えた半荘は出ない）', () => {
    expect(gameIds({ todo: true })).toEqual(['g1', 'g2', 'g3', 'g4', 'g5', 'g6']);
    const all = MODEL.problems.filter((p) => p.sessionId === 'g3');
    const answers = all.map((p, i) => answerRow({ id: i + 1, session_id: 'g3', decision_key: p.key }));
    const { model } = build({ answers });
    expect(gameIds({ todo: true }, model)).toEqual(['g1', 'g2', 'g4', 'g5', 'g6']);
    expect(problemsOf({ todo: true }, model).some((p) => p.sessionId === 'g3')).toBe(false);
    expect(problemsOf({ todo: true }, model)).toHaveLength(model.problems.length - all.length);
  });

  it('組み合わせられる（検索語・種類・期間・迷いあり）。条件を解除する関数は、検索語を含めない', () => {
    expect(gameIds({ query: '玉の間', period: 'today', doubt: true })).toEqual(['g1']);
    expect(problemsOf({ query: '東', period: 'today', doubt: true, problems: true }).every((p) => p.sessionId === 'g1')).toBe(true);
    expect(hasConditions(FRESH_SEARCH)).toBe(false);
    expect(hasConditions({ ...FRESH_SEARCH, query: '東4局' })).toBe(false);
    expect(hasAnyCondition({ ...FRESH_SEARCH, query: '東4局' })).toBe(true);
    expect(hasAnyCondition({ ...FRESH_SEARCH, query: '   ' })).toBe(false);
    for (const patch of [{ games: true }, { problems: true }, { stage: 'A' }, { period: 'today' }, { doubt: true }, { todo: true }] as const) {
      expect(hasConditions({ ...FRESH_SEARCH, ...patch })).toBe(true);
    }
  });
});

describe('U-22: 並べ方（新しい順・古い順・Rating が低い順・AI との差が大きい順）', () => {
  it('並べ方の名前と順序', () => {
    expect(SORTS.map((s) => s.label)).toEqual(['新しい順', '古い順', 'Rating が低い順', 'AI との差が大きい順']);
  });

  it('新しい順（既定）と古い順: 半荘は開始時刻、問題はその半荘の新しい順（同じ半荘の中は、確率の低い順）', () => {
    expect(gameIds({ sort: 'new' })).toEqual(['g1', 'g2', 'g3', 'g4', 'g5', 'g6', 'g7']);
    expect(gameIds({ sort: 'old' })).toEqual(['g7', 'g6', 'g5', 'g4', 'g3', 'g2', 'g1']);
    const sessions = (sort: SearchState['sort']) => [...new Set(problemsOf({ sort }).map((p) => p.sessionId))];
    expect(sessions('new')).toEqual(['g1', 'g2', 'g3', 'g4', 'g5', 'g6']);
    expect(sessions('old')).toEqual(['g6', 'g5', 'g4', 'g3', 'g2', 'g1']);
    const inside = problemsOf({ sort: 'new' }).filter((p) => p.sessionId === 'g2');
    expect(inside.map((p) => p.probability)).toEqual([...inside.map((p) => p.probability)].sort((a, b) => a - b));
  });

  it('Rating が低い順: Rating の低い半荘から。Rating の無い（取り込み前の）半荘は最後。同じ Rating なら新しい順', () => {
    const ratings = (ids: string[]) => ids.map((id) => MODEL.games.find((g) => g.id === id)?.ratingValue ?? null);
    const ids = gameIds({ sort: 'rating' });
    expect(ids.at(-1)).toBe('g7');
    expect(ratings(ids.slice(0, -1))).toEqual([...ratings(ids.slice(0, -1))].sort((a, b) => (a ?? 0) - (b ?? 0)));
    expect(ids).toEqual(['g4', 'g2', 'g6', 'g5', 'g3', 'g1', 'g7']);
    const sessions = [...new Set(problemsOf({ sort: 'rating' }).map((p) => p.sessionId))];
    expect(sessions).toEqual(['g4', 'g2', 'g6', 'g5', 'g3', 'g1']);
  });

  it('AI との差が大きい順: 問題は、AI が実戦の行動に付けた確率の低い順（同じ確率なら、新しい半荘・半荘の中の順）', () => {
    const found = problemsOf({ sort: 'diff' });
    const expected = [...MODEL.problems].sort(
      (a, b) =>
        a.probability - b.probability || b.game.startedMs - a.game.startedMs || a.order - b.order,
    );
    expect(found.map((p) => `${p.sessionId}/${p.key}`)).toEqual(expected.map((p) => `${p.sessionId}/${p.key}`));
    // 先頭は、全体でいちばん確率の低い問題
    const lowest = Math.min(...MODEL.problems.map((p) => p.probability));
    expect(found[0]?.probability).toBe(lowest);
    for (let i = 1; i < found.length; i += 1) {
      expect((found[i - 1] as { probability: number }).probability).toBeLessThanOrEqual((found[i] as { probability: number }).probability);
    }
  });

  it('AI との差が大きい順: 半荘は、大きな不一致の問題が多い順（同じ数なら新しい順）', () => {
    const counts = new Map(MODEL.games.map((g) => [g.id, g.mismatchCount] as const));
    const ids = gameIds({ sort: 'diff' });
    for (let i = 1; i < ids.length; i += 1) {
      expect(counts.get(ids[i - 1] as string) as number).toBeGreaterThanOrEqual(counts.get(ids[i] as string) as number);
    }
    // 取り込み前の半荘（問題なし）は最後
    expect(ids.at(-1)).toBe('g7');
    expect(ids[0]).toBe('g6');
  });

  it('迷いの問題は、確率が基準以上でも、確率の順に並ぶ（迷いだから先、とはしない）', () => {
    const found = problemsOf({ sort: 'diff', doubt: true });
    for (let i = 1; i < found.length; i += 1) {
      expect((found[i - 1] as { probability: number }).probability).toBeLessThanOrEqual((found[i] as { probability: number }).probability);
    }
  });

  it('並べ替えても、条件に当たる行の集まりは変わらない', () => {
    const idsOf = (sort: SearchState['sort']) =>
      search({ sort, query: '東4局' }).problems.map((p) => `${p.sessionId}/${p.key}`).sort();
    expect(idsOf('old')).toEqual(idsOf('new'));
    expect(idsOf('rating')).toEqual(idsOf('new'));
    expect(idsOf('diff')).toEqual(idsOf('new'));
  });
});

describe('U-22: 「すべて表示（あと N件）」', () => {
  it('半荘 5・問題 6 まで出し、残りの数を数える。すべて出すと、「上位だけ表示」に切り替えられる', () => {
    const result = search();
    const cut = limitResult(result, false);
    expect(cut.games).toHaveLength(GAME_LIMIT);
    expect(cut.problems).toHaveLength(PROBLEM_LIMIT);
    expect(cut.hidden).toBe(7 - GAME_LIMIT + (MODEL.problems.length - PROBLEM_LIMIT));
    expect(cut.collapsible).toBe(false);
    const all = limitResult(result, true);
    expect(all.games).toHaveLength(7);
    expect(all.problems).toHaveLength(MODEL.problems.length);
    expect(all.hidden).toBe(0);
    expect(all.collapsible).toBe(true);
  });

  it('当たりが少なければ、切らない（「すべて表示」を出さない）', () => {
    const result = search({ query: '東4局 13巡目' });
    const cut = limitResult(result, false);
    expect(cut.hidden).toBe(0);
    expect(limitResult(result, true).collapsible).toBe(false);
  });

  it('東4局で、半荘 1・問題 N: 半荘は 1 つ残らず出して、問題だけ切る（あと N - 6 件）', () => {
    const one = build({ seeds: SEEDS.filter((seed) => seed.id === 'g2') }).model;
    const result = runSearch(one, { ...FRESH_SEARCH, query: '東4局' }, NOW);
    expect(result.games).toHaveLength(1);
    const cut = limitResult(result, false);
    expect(cut.games).toHaveLength(1);
    expect(cut.problems).toHaveLength(PROBLEM_LIMIT);
    expect(cut.hidden).toBe(result.problems.length - PROBLEM_LIMIT);
  });
});

describe('U-22: 日付の当たりの印', () => {
  const g = (id: string) => (MODEL.games.find((game) => game.id === id) as { startedMs: number }).startedMs;

  it('10/9・10月9日は、数字の日付に当たる。本日・今日・昨日は、言葉の日付に当たる。ほかの語は当たらない', () => {
    expect(dateHits(g('g1'), NOW, queryTerms('10/9'))).toEqual({ monthDay: true, relative: false });
    expect(dateHits(g('g1'), NOW, queryTerms('10月9日'))).toEqual({ monthDay: true, relative: false });
    expect(dateHits(g('g1'), NOW, queryTerms('本日'))).toEqual({ monthDay: false, relative: true });
    expect(dateHits(g('g1'), NOW, queryTerms('今日'))).toEqual({ monthDay: false, relative: true });
    expect(dateHits(g('g3'), NOW, queryTerms('昨日'))).toEqual({ monthDay: false, relative: true });
    expect(dateHits(g('g3'), NOW, queryTerms('本日'))).toEqual({ monthDay: false, relative: false });
    expect(dateHits(g('g1'), NOW, queryTerms('玉の間'))).toEqual({ monthDay: false, relative: false });
    expect(dateHits(g('g1'), NOW, [])).toEqual({ monthDay: false, relative: false });
    expect(dateHits(g('g5'), NOW, queryTerms('10/7'))).toEqual({ monthDay: true, relative: false });
  });
});
