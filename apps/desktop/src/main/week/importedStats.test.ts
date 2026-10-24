/**
 * 取り込んだ半荘から数えた成績（ACCEPTANCE の E-42・U-37）の、週ごとの組み立ての単体試験。
 * 数え方そのもの（4位率・放銃率・平均順位・和了率・副露率・立直率・平均和了点）は、エンジンの hanchan-stats.test.ts が、牌譜から数え直した値と照らす。
 * ここでは、どの半荘が、どの週に、数に入るか:
 * - 週は月曜から日曜、日の区切りは午前 4 時（月曜の午前 3 時 59 分に始めた半荘は、前の週）
 * - 消した半荘（一覧に無い半荘）・結果を取り込んでいない半荘は、数えない
 * - 読み込み中の半荘・牌譜が読めない半荘は、数に入れず、その数を持つ
 */
import { aiMetricsOf, parseReportText } from '@jantama/engine';
import { describe, expect, it } from 'vitest';

import { REPORT_TEXTS, local, seedSession, type ReportKey } from '../../../tests/fake-sessions';
import type { SessionRecord } from '../../api/types';
import type { SummaryMap } from '../sessionSummaries';
import { gameFromReportText, type GameState } from '../study/gameStore';
import { buildImportedStats } from './importedStats';

const THIS_WEEK = '2026-10-05';
const LAST_WEEK = '2026-09-28';

interface Seed {
  key: ReportKey;
  at: number;
  id: string;
}

/** 固定データの 7 半荘を、今週（10/5 から 10/11）に置く。 */
const WEEK_SEEDS: Seed[] = [
  { key: 'fx1a', at: local(2026, 10, 5, 10, 0), id: 'g-fx1a' },
  { key: 'fx1b', at: local(2026, 10, 6, 11, 0), id: 'g-fx1b' },
  { key: 'fx1c', at: local(2026, 10, 6, 12, 0), id: 'g-fx1c' },
  { key: 'fx1d', at: local(2026, 10, 7, 13, 0), id: 'g-fx1d' },
  { key: 'fx1e', at: local(2026, 10, 7, 14, 0), id: 'g-fx1e' },
  { key: 'fx5', at: local(2026, 10, 8, 15, 35), id: 'g-fx5' },
  { key: 'fx4', at: local(2026, 10, 9, 19, 9), id: 'g-fx4' },
];

const sessionOf = (seed: Seed): SessionRecord => seedSession(seed.at, { id: seed.id, report: seed.key }).session;
const gamesOf = (seeds: readonly Seed[]) => new Map(seeds.map((seed) => [seed.id, gameFromReportText(REPORT_TEXTS[seed.key])] as const));
const noSummaries: SummaryMap = new Map();

/** 悪手の基準（設定の「大きな不一致の基準」の既定 5%）。 */
const THRESHOLD = 0.05;

function stats(
  week: string,
  seeds: readonly Seed[],
  games: ReadonlyMap<string, GameState> = gamesOf(seeds),
  sessions = seeds.map(sessionOf),
  threshold = THRESHOLD,
) {
  return buildImportedStats({ sessions, summaries: noSummaries, gameState: (id) => games.get(id), week, threshold });
}

describe('E-42・U-37 週ごとの、取り込んだ半荘から数えた成績', () => {
  it('今週の 7 半荘: もとの数と値が、固定データの 7 半荘の値と一致する。半荘ごとの行は始めた順（古い順）', () => {
    const result = stats(THIS_WEEK, WEEK_SEEDS);
    expect(result.imported).toBe(7);
    expect(result.loading).toBe(0);
    expect(result.unreadable).toBe(0);
    expect(result.totals).toMatchObject({ hanchanCount: 7, kyokuCount: 82, fourthCount: 2, rankSum: 19, dealInCount: 9, winCount: 16, fulouCount: 24, riichiCount: 16, winPointsSum: 110_800 });
    expect(result.rows.map((row) => row.id)).toEqual(['g-fx1a', 'g-fx1b', 'g-fx1c', 'g-fx1d', 'g-fx1e', 'g-fx5', 'g-fx4']);
    // 半荘ごとの値（FX-4: 4 位・5 局・和了 1（1000 点）・放銃 2・立直 0・副露 2）
    const fx4 = result.rows.find((row) => row.id === 'g-fx4');
    expect(fx4?.stat).toEqual({ rank: 4, kyokuCount: 5, winCount: 1, dealInCount: 2, riichiCount: 0, fulouCount: 2, winPointsSum: 1000 });
    expect(fx4?.averageWinPoints).toBe(1000);
    // 半荘ごとの値の合計が、まとめの値になる
    expect(result.rows.reduce((sum, row) => sum + row.stat.kyokuCount, 0)).toBe(result.totals.kyokuCount);
  });

  it('週の外の半荘は数えない。月曜の午前 3 時 59 分に始めた半荘は前の週、午前 4 時ちょうどは今週', () => {
    const early: Seed = { key: 'fx1c', at: local(2026, 10, 5, 3, 59), id: 'g-early' };
    const edge: Seed = { key: 'fx1d', at: local(2026, 10, 5, 4, 0), id: 'g-edge' };
    const lastSunday: Seed = { key: 'fx1e', at: local(2026, 10, 4, 22, 0), id: 'g-sun' };
    const seeds = [early, edge, lastSunday];
    expect(stats(THIS_WEEK, seeds).rows.map((row) => row.id)).toEqual(['g-edge']);
    expect(stats(LAST_WEEK, seeds).rows.map((row) => row.id)).toEqual(['g-sun', 'g-early']);
    // 次の週の月曜の午前 3 時 59 分は、今週の最後
    const lastMoment: Seed = { key: 'fx5', at: local(2026, 10, 12, 3, 59), id: 'g-last' };
    expect(stats(THIS_WEEK, [lastMoment]).rows.map((row) => row.id)).toEqual(['g-last']);
    expect(stats('2026-10-12', [lastMoment]).imported).toBe(0);
  });

  it('消した半荘（一覧に無い半荘）は数えない', () => {
    const games = gamesOf(WEEK_SEEDS);
    const all = stats(THIS_WEEK, WEEK_SEEDS, games);
    // FX-4 を消した一覧（結果の再生は、まだ覚えていても数えない）
    const sessions = WEEK_SEEDS.filter((seed) => seed.id !== 'g-fx4').map(sessionOf);
    const without = stats(THIS_WEEK, WEEK_SEEDS, games, sessions);
    expect(all.totals.hanchanCount).toBe(7);
    expect(without.totals.hanchanCount).toBe(6);
    expect(without.imported).toBe(6);
    expect(without.rows.map((row) => row.id)).not.toContain('g-fx4');
    // FX-4 の 5 局・4 位・和了 1（1000 点）が外れる
    expect(without.totals).toMatchObject({ kyokuCount: 77, fourthCount: 1, rankSum: 15, winCount: 15, winPointsSum: 109_800, dealInCount: 7 });
  });

  it('結果を取り込んでいない半荘（迷いマークだけ）は数えない。取り込んだ半荘が無い週は、半荘 0・値はすべて null', () => {
    const notImported = seedSession(local(2026, 10, 6, 20, 0), { id: 'g-none', marks: 3 }).session;
    const result = buildImportedStats({ sessions: [notImported], summaries: noSummaries, gameState: () => undefined, week: THIS_WEEK, threshold: THRESHOLD });
    expect(result.imported).toBe(0);
    expect(result.rows).toEqual([]);
    expect(result.totals.hanchanCount).toBe(0);
    expect(result.totals.fourthRate).toBeNull();
    expect(result.totals.averageWinPoints).toBeNull();
    expect(stats(LAST_WEEK, WEEK_SEEDS).imported).toBe(0);
  });

  it('読み込み中の半荘と、牌譜を読めない半荘は、数に入れず、数だけ持つ', () => {
    const seeds = WEEK_SEEDS.slice(0, 3);
    const games = new Map<string, GameState>(gamesOf(seeds));
    games.set('g-fx1b', { status: 'loading' });
    games.set('g-fx1c', { status: 'unavailable', reason: '読めません' });
    const result = stats(THIS_WEEK, seeds, games);
    expect(result.imported).toBe(3);
    expect(result.loading).toBe(1);
    expect(result.unreadable).toBe(1);
    expect(result.rows.map((row) => row.id)).toEqual(['g-fx1a']);
    expect(result.totals.hanchanCount).toBe(1);
    // まだ読み込みを始めていない半荘（覚えが無い）も、読み込み中
    expect(stats(THIS_WEEK, seeds, new Map()).loading).toBe(3);
  });

  it('卓の呼び名は、まとめが読めている半荘だけに付く', () => {
    const seed = WEEK_SEEDS[0] as Seed;
    const withRoom: SummaryMap = new Map([[seed.id, { status: 'ready', summary: { room: '玉の間・南' } as never }]]);
    const result = buildImportedStats({ sessions: [sessionOf(seed)], summaries: withRoom, gameState: (id) => gamesOf([seed]).get(id), week: THIS_WEEK, threshold: THRESHOLD });
    expect(result.rows[0]?.room).toBe('玉の間・南');
    expect(stats(THIS_WEEK, [seed]).rows[0]?.room).toBeNull();
  });
});

// 週の AI 一致率・類似度・悪手率（F18、E-48、U-48）: 数え方はエンジンの ai-metrics.test.ts。ここでは、数える半荘が既存の値と同じ絞り込みであることと、
// 基準が届くこと、半荘ごとの行とまとめの値が、同じ結果をエンジンの関数で数えた値と一致することを確かめる。
describe('E-48・U-48 週ごとの、AI 一致率・類似度・悪手率', () => {
  const reportOf = (key: ReportKey) => {
    const parsed = parseReportText(REPORT_TEXTS[key]);
    if (!parsed.ok) throw new Error(parsed.error.message);
    return parsed.value;
  };
  /** 半荘ごとの (判断・一致・悪手)。基準 5%。始めた順（古い順）。 */
  const EXPECTED_ROWS: Array<[string, number, number, number]> = [
    ['g-fx1a', 178, 135, 19],
    ['g-fx1b', 197, 158, 16],
    ['g-fx1c', 156, 119, 16],
    ['g-fx1d', 231, 188, 15],
    ['g-fx1e', 202, 156, 22],
    ['g-fx5', 125, 102, 9],
    ['g-fx4', 70, 62, 5],
  ];

  it('今週の 7 半荘: 半荘ごとの行の判断・一致・悪手が、固定データの値と一致する。値は、同じ結果をエンジンの関数で数えた値と同じ', () => {
    const result = stats(THIS_WEEK, WEEK_SEEDS);
    expect(result.rows.map((row) => [row.id, row.ai.decisions, row.ai.matches, row.ai.badMoves])).toEqual(EXPECTED_ROWS);
    for (const seed of WEEK_SEEDS) {
      const row = result.rows.find((r) => r.id === seed.id);
      expect(row?.ai, seed.id).toEqual(aiMetricsOf(reportOf(seed.key), { threshold: THRESHOLD }));
    }
    expect(result.threshold).toBe(THRESHOLD);
  });

  it('まとめ: 判断 1159・一致 920・悪手 102。一致率・悪手率は数の合計の割合、類似度は週の判断すべてでの Rating の式', () => {
    const result = stats(THIS_WEEK, WEEK_SEEDS);
    const { ai } = result;
    expect([ai.decisions, ai.matches, ai.badMoves]).toEqual([1159, 920, 102]);
    expect(ai.matchRate).toBe(920 / 1159);
    expect(ai.badMoveRate).toBe(102 / 1159);
    const scoreSum = WEEK_SEEDS.reduce((sum, seed) => sum + aiMetricsOf(reportOf(seed.key)).scoreSum, 0);
    const mean = scoreSum / 1159;
    expect(ai.similarity).toBeCloseTo(mean * mean, 12);
    // 半荘ごとの値の平均とは違う（判断の数が半荘ごとに違うので、まとめて数える）
    const rates = result.rows.map((row) => row.ai.matchRate ?? 0);
    const average = rates.reduce((sum, rate) => sum + rate, 0) / rates.length;
    expect(Math.abs((ai.matchRate ?? 0) - average)).toBeGreaterThan(1e-3);
  });

  it('基準を 10% にすると、悪手の数が基準 10% の値（25・20・17・22・25・9・5。合計 123）になり、判断・一致・類似度は変わらない', () => {
    const result = stats(THIS_WEEK, WEEK_SEEDS, undefined, undefined, 0.1);
    expect(result.threshold).toBe(0.1);
    expect(result.rows.map((row) => row.ai.badMoves)).toEqual([25, 20, 17, 22, 25, 9, 5]);
    expect(result.ai.badMoves).toBe(123);
    const base = stats(THIS_WEEK, WEEK_SEEDS).ai;
    expect([result.ai.decisions, result.ai.matches, result.ai.similarity]).toEqual([base.decisions, base.matches, base.similarity]);
    expect(result.ai.badMoveRate).toBe(123 / 1159);
  });

  it('数える半荘は、既存の値と同じ絞り込み: 週の外・消した半荘・結果の無い半荘・読み込み中・牌譜が読めない半荘は数えない', () => {
    const games = gamesOf(WEEK_SEEDS);
    // FX-4 を消した一覧
    const without = stats(THIS_WEEK, WEEK_SEEDS, games, WEEK_SEEDS.filter((seed) => seed.id !== 'g-fx4').map(sessionOf));
    expect(without.rows).toHaveLength(6);
    expect([without.ai.decisions, without.ai.matches, without.ai.badMoves]).toEqual([1159 - 70, 920 - 62, 102 - 5]);
    // 週の外は数えない（先週は f9da だけ）
    const lastWeek: Seed = { key: 'fx1a', at: local(2026, 10, 2, 17, 12), id: 'g-last' };
    const both = stats(THIS_WEEK, [...WEEK_SEEDS, lastWeek]);
    expect(both.ai.decisions).toBe(1159);
    const previous = stats(LAST_WEEK, [...WEEK_SEEDS, lastWeek]);
    expect([previous.ai.decisions, previous.ai.matches, previous.ai.badMoves]).toEqual([178, 135, 19]);
    // 読み込み中・読めない半荘は、行にも数にも入らない（既存の値の「半荘」の数と、AI の判断の数が、同じ半荘の分）
    const three = WEEK_SEEDS.slice(0, 3);
    const some = new Map<string, GameState>(gamesOf(three));
    some.set('g-fx1b', { status: 'loading' });
    some.set('g-fx1c', { status: 'unavailable', reason: '読めません' });
    const partial = stats(THIS_WEEK, three, some);
    expect(partial.rows.map((row) => row.id)).toEqual(['g-fx1a']);
    expect(partial.totals.hanchanCount).toBe(1);
    expect([partial.ai.decisions, partial.ai.matches, partial.ai.badMoves]).toEqual([178, 135, 19]);
    // 結果を取り込んでいない半荘だけの週
    const notImported = seedSession(local(2026, 10, 6, 20, 0), { id: 'g-none', marks: 3 }).session;
    const none = buildImportedStats({ sessions: [notImported], summaries: noSummaries, gameState: () => undefined, week: THIS_WEEK, threshold: THRESHOLD });
    expect(none.ai).toEqual({ decisions: 0, matches: 0, badMoves: 0, scoreSum: 0, matchRate: null, similarity: null, badMoveRate: null });
  });
});
