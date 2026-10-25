/**
 * 検索の重ね表示の試験に使う、半荘と問題の組（試験のデータで、画面の部品ではない）。
 * エンジンの試験の固定データ（FX-1 の 5 半荘と FX-4）を、日付をずらして並べたもの。
 * 半荘の一覧の行・結果のまとめ・問題の一覧（今日の出題と同じ `listProblems`）を、画面を通さずに作る。
 */
import { keyOfDecision, listProblems, type ImportedGame, type Problem } from '@jantama/engine';

import type { SessionRecord } from '../src/api/types';
import { buildListRows, type ListRow } from '../src/main/sessionRows';
import { summarizeReportText, type SummaryMap } from '../src/main/sessionSummaries';
import { REPORT_TEXTS, local, seedSession, type ReportKey } from './fake-sessions';
import { gameOf } from './fake-study';

/** 試験の「いま」: 2026 年 10 月 9 日 22:00。 */
export const SEARCH_NOW = local(2026, 10, 9, 22, 0);
/** 悪手の基準（確率）。 */
export const SEARCH_THRESHOLD = 0.05;

export interface SearchSeed {
  id: string;
  at: number;
  /** 取り込んだ結果。無ければ、取り込み前。 */
  report?: ReportKey;
  /** 迷いマークの数（一覧の「迷い N」）。 */
  marks?: number;
  /** 迷いに結びつけた判断（半荘の判断の通し番号）。迷いの問題になる。 */
  marked?: number[];
  memo?: string;
}

/** 日付をずらした 7 半荘（新しい順）。g7 は、結果を取り込む前。 */
export const SEARCH_SEEDS: readonly SearchSeed[] = [
  { id: 'g1', at: local(2026, 10, 9, 19, 9), report: 'fx4', marks: 3, marked: [3, 20, 40], memo: '放銃を見直す' },
  { id: 'g2', at: local(2026, 10, 9, 17, 12), report: 'fx1a', memo: '3mを切った場面が悪かった' },
  { id: 'g3', at: local(2026, 10, 8, 21, 40), report: 'fx1d' },
  { id: 'g4', at: local(2026, 10, 8, 20, 55), report: 'fx1c', memo: '親番で押しすぎた' },
  { id: 'g5', at: local(2026, 10, 7, 22, 10), report: 'fx1b', marks: 2, marked: [5, 60] },
  { id: 'g6', at: local(2026, 10, 4, 20, 12), report: 'fx1e' },
  { id: 'g7', at: local(2026, 10, 2, 22, 5), marks: 1 },
];

export interface SearchFixture {
  sessions: SessionRecord[];
  rows: ListRow[];
  summaries: SummaryMap;
  /** 問題の一覧（今日の出題と同じ並び）。`ready: false` のときは空。 */
  problems: Problem[];
  games: Map<string, ImportedGame>;
}

export function searchFixture(options: { seeds?: readonly SearchSeed[]; ready?: boolean } = {}): SearchFixture {
  const seeds = options.seeds ?? SEARCH_SEEDS;
  const sessions = seeds.map(
    (seed) => seedSession(seed.at, { id: seed.id, marks: seed.marks ?? 0, ...(seed.report ? { report: seed.report } : {}) }).session,
  );
  const summaries = new Map(
    seeds.flatMap((seed) => (seed.report ? [[seed.id, summarizeReportText(REPORT_TEXTS[seed.report])] as const] : [])),
  );
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
  const problems = options.ready === false ? [] : listProblems(sources, { threshold: SEARCH_THRESHOLD });
  return { sessions, rows, summaries, problems, games };
}


