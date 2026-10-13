/**
 * 取り込んだ半荘から数えた成績（ACCEPTANCE の E-42・U-37）の、週ごとの組み立ての単体試験。
 * 数え方そのもの（4位率・放銃率・平均順位・和了率・副露率・立直率・平均和了点）は、エンジンの hanchan-stats.test.ts が、牌譜から数え直した値と照らす。
 * ここでは、どの半荘が、どの週に、数に入るか:
 * - 週は月曜から日曜、日の区切りは午前 4 時（月曜の午前 3 時 59 分に始めた半荘は、前の週）
 * - 消した半荘（一覧に無い半荘）・結果を取り込んでいない半荘は、数えない
 * - 読み込み中の半荘・牌譜が読めない半荘は、数に入れず、その数を持つ
 */
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

function stats(week: string, seeds: readonly Seed[], games: ReadonlyMap<string, GameState> = gamesOf(seeds), sessions = seeds.map(sessionOf)) {
  return buildImportedStats({ sessions, summaries: noSummaries, gameState: (id) => games.get(id), week });
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
    const result = buildImportedStats({ sessions: [notImported], summaries: noSummaries, gameState: () => undefined, week: THIS_WEEK });
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
    const result = buildImportedStats({ sessions: [sessionOf(seed)], summaries: withRoom, gameState: (id) => gamesOf([seed]).get(id), week: THIS_WEEK });
    expect(result.rows[0]?.room).toBe('玉の間・南');
    expect(stats(THIS_WEEK, [seed]).rows[0]?.room).toBeNull();
  });
});
