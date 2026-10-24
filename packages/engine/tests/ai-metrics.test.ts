import { describe, expect, it } from 'vitest';

import {
  aiMetricsOf,
  aiMetricsOfEntries,
  formatRatePercent,
  formatSimilarity,
  totalAiMetrics,
  type AiMetrics,
  type AiMetricsEntry,
} from '../src/ai-metrics';
import { listDisagreements } from '../src/disagreement';
import { type ImportedGame, importReportText } from '../src/import';
import { formatRating, gameRating } from '../src/rating';
import { replayMismatches } from '../src/replay-scenes';
import type { MortalReport } from '../src/report-types';
import { FX1_IDS, FX4_ID, FX5_ID, loadReportJson, loadReportText } from './helpers/fixtures';

// E-48 AI 一致率・類似度・悪手率（F18）: 固定データの 7 半荘（FX-1 の 5 半荘、FX-4、FX-5）で、
// 判断の数・一致の数が結果の review.total_reviewed・review.total_matches と同じになり、類似度が半荘の Rating（E-12）と同じになり、
// 悪手の数が基準 0.05 で不一致の一覧（E-4）の件数と同じになる。基準 0.10 の悪手の数は、結果の JSON から数え直した値（コードを通さない）と一致する。
// 半荘をまとめた値は、まとめた判断すべてから出した値と同じ。判断が無い半荘は、どの値も null。

const IDS = [...FX1_IDS, FX4_ID, FX5_ID] as const;

/** 結果の JSON を読んで数え直した値（判断の数・一致の数・基準 0.05 と 0.10 の悪手の数）。 */
const EXPECTED: Record<(typeof IDS)[number], { decisions: number; matches: number; bad5: number; bad10: number }> = {
  f9da87cbcd7af5e9: { decisions: 178, matches: 135, bad5: 19, bad10: 25 },
  f738896995c33fed: { decisions: 197, matches: 158, bad5: 16, bad10: 20 },
  be0a2a523fdd7758: { decisions: 156, matches: 119, bad5: 16, bad10: 17 },
  '002ca97adccc486d': { decisions: 231, matches: 188, bad5: 15, bad10: 22 },
  '3a36dac7c7fc18ce': { decisions: 202, matches: 156, bad5: 22, bad10: 25 },
  [FX4_ID]: { decisions: 70, matches: 62, bad5: 5, bad10: 5 },
  [FX5_ID]: { decisions: 125, matches: 102, bad5: 9, bad10: 9 },
};

function load(id: string): ImportedGame {
  const game = importReportText(loadReportText(id));
  if (!game.ok) throw new Error(`${id}: ${game.error.message}`);
  return game.value;
}

const games = new Map<string, ImportedGame>(IDS.map((id) => [id, load(id)] as const));
const gameOf = (id: string): ImportedGame => {
  const game = games.get(id);
  if (game === undefined) throw new Error(id);
  return game;
};

/** 結果の JSON そのままの判断（エンジンの型も計算も通さない）。 */
interface RawEntry {
  is_equal: boolean;
  actual_index: number;
  details: Array<{ prob: number }>;
}

function rawJson(id: string): { review: { total_reviewed: number; total_matches: number; kyokus: Array<{ entries: RawEntry[] }> } } {
  return loadReportJson(id) as ReturnType<typeof rawJson>;
}

const rawEntries = (id: string): RawEntry[] => rawJson(id).review.kyokus.flatMap((kyoku) => kyoku.entries);

/** JSON の判断のうち、実戦の行動の確率が基準より低いものの数。 */
function rawCountBelow(id: string, threshold: number): number {
  return rawEntries(id).filter((entry) => (entry.details[entry.actual_index]?.prob ?? Number.NaN) < threshold).length;
}

/** 候補の確率だけを持つ判断（確率の境目の確かめ用）。実戦の行動は 1 番目の候補。 */
function entryWithProb(prob: number, isEqual = false): AiMetricsEntry {
  return {
    is_equal: isEqual,
    actual_index: 0,
    details: [
      { action: { type: 'none' }, q_value: 0.5, prob },
      { action: { type: 'none' }, q_value: 0.1, prob: 1 - prob },
    ],
  };
}

describe('E-48 AI 一致率・類似度・悪手率: 半荘 1 つ', () => {
  for (const id of IDS) {
    const expected = EXPECTED[id];

    it(`E-48 ${id}: 判断の数と一致の数が、結果の review.total_reviewed・review.total_matches と同じ（${expected.decisions}・${expected.matches}）`, () => {
      const report = gameOf(id).report;
      const metrics = aiMetricsOf(report);
      expect(metrics.decisions).toBe(report.review.total_reviewed);
      expect(metrics.matches).toBe(report.review.total_matches);
      // 結果の JSON を読んだだけの値とも、固定の値とも合う
      expect(rawJson(id).review.total_reviewed).toBe(expected.decisions);
      expect(rawJson(id).review.total_matches).toBe(expected.matches);
      expect(metrics.decisions).toBe(expected.decisions);
      expect(metrics.matches).toBe(expected.matches);
    });

    it(`E-48 ${id}: 類似度が、半荘の Rating（gameRating）と同じ値。文字も同じ`, () => {
      const report = gameOf(id).report;
      const rating = gameRating(report);
      const metrics = aiMetricsOf(report);
      expect(rating).not.toBeNull();
      expect(metrics.similarity).toBe(rating);
      expect(formatSimilarity(metrics.similarity ?? Number.NaN)).toBe(formatRating(rating ?? Number.NaN));
    });

    it(`E-48 ${id}: 基準 0.05 の悪手の数が、不一致の一覧（E-4）の件数と同じ（${expected.bad5}）。既定の基準も 0.05`, () => {
      const report = gameOf(id).report;
      const total = listDisagreements(gameOf(id).decisions, { limit: 1000 }).total;
      expect(total).toBe(expected.bad5);
      expect(aiMetricsOf(report).badMoves).toBe(total);
      expect(aiMetricsOf(report, { threshold: 0.05 }).badMoves).toBe(total);
    });

    it(`E-48 ${id}: 基準を 0.10 にすると、悪手の数が、確率が 0.10 より低い判断の数（結果の JSON から数え直した ${expected.bad10}）になる`, () => {
      const report = gameOf(id).report;
      expect(rawCountBelow(id, 0.1)).toBe(expected.bad10);
      expect(aiMetricsOf(report, { threshold: 0.1 }).badMoves).toBe(expected.bad10);
      expect(listDisagreements(gameOf(id).decisions, { threshold: 0.1, limit: 1000 }).total).toBe(expected.bad10);
      // 基準を変えても、判断の数・一致の数・類似度は変わらない
      expect(aiMetricsOf(report, { threshold: 0.1 })).toMatchObject({ decisions: expected.decisions, matches: expected.matches });
      expect(aiMetricsOf(report, { threshold: 0.1 }).similarity).toBe(aiMetricsOf(report).similarity);
    });

    it(`E-48 ${id}: 一致率は一致 ÷ 判断、悪手率は悪手 ÷ 判断。もとの数に点の合計（scoreSum）がある`, () => {
      const metrics = aiMetricsOf(gameOf(id).report);
      expect(metrics.matchRate).toBe(expected.matches / expected.decisions);
      expect(metrics.badMoveRate).toBe(expected.bad5 / expected.decisions);
      const mean = metrics.scoreSum / metrics.decisions;
      expect(metrics.similarity).toBe(mean * mean);
      // 点は 0 から 1。一致した判断は 1 点なので、合計は一致の数以上、判断の数以下
      expect(metrics.scoreSum).toBeGreaterThanOrEqual(expected.matches);
      expect(metrics.scoreSum).toBeLessThanOrEqual(expected.decisions);
    });
  }

  it('E-48 FX-4（10月9日の 5 局）: 判断 70・一致 62・悪手 5。AI 一致率 88.6%・類似度 93.0・悪手率 7.1%', () => {
    const metrics = aiMetricsOf(gameOf(FX4_ID).report);
    expect([metrics.decisions, metrics.matches, metrics.badMoves]).toEqual([70, 62, 5]);
    expect(formatRatePercent(metrics.matchRate ?? Number.NaN)).toBe('88.6%');
    expect(formatSimilarity(metrics.similarity ?? Number.NaN)).toBe('93.0');
    expect(formatRatePercent(metrics.badMoveRate ?? Number.NaN)).toBe('7.1%');
  });

  it('E-48 悪手に数えるのは、実戦の行動の確率が基準より低い判断だけ（基準ちょうどは数えない）', () => {
    const entries = [entryWithProb(0.049), entryWithProb(0.05), entryWithProb(0.051), entryWithProb(0.0001), entryWithProb(0.9, true)];
    expect(aiMetricsOfEntries(entries).badMoves).toBe(2);
    expect(aiMetricsOfEntries(entries, { threshold: 0.05 }).badMoves).toBe(2);
    expect(aiMetricsOfEntries(entries, { threshold: 0.0501 }).badMoves).toBe(3);
    expect(aiMetricsOfEntries(entries, { threshold: 0 }).badMoves).toBe(0);
    expect(aiMetricsOfEntries(entries, { threshold: 1 }).badMoves).toBe(5);
    expect(aiMetricsOfEntries(entries).matches).toBe(1);
  });

  it('E-48 「AI の1位と違う判断も不一致として出す」で足される判断は、悪手に数えない（大きな不一致の数と同じ）', () => {
    for (const id of IDS) {
      const decisions = gameOf(id).decisions;
      const all = replayMismatches(decisions, { includeAll: true });
      const big = all.filter((mismatch) => mismatch.kind === 'big');
      const other = all.filter((mismatch) => mismatch.kind === 'other');
      // 足された判断（AI の1位と違うが、確率は基準以上）がある半荘で確かめる
      expect(other.length, id).toBeGreaterThan(0);
      expect(aiMetricsOf(gameOf(id).report).badMoves, id).toBe(big.length);
      expect(aiMetricsOf(gameOf(id).report).badMoves, id).toBeLessThan(all.length);
      // 基準を替えたときも同じ
      expect(aiMetricsOf(gameOf(id).report, { threshold: 0.1 }).badMoves, id).toBe(replayMismatches(decisions, { threshold: 0.1, includeAll: true }).filter((m) => m.kind === 'big').length);
    }
  });

  it('E-48 判断が無い半荘（entries が空・局が無い）は、数は 0、値はどれも null（0 でも NaN でもない）', () => {
    const base = gameOf(FX4_ID).report;
    const withoutEntries: MortalReport = {
      ...base,
      review: { ...base.review, total_reviewed: 0, total_matches: 0, kyokus: base.review.kyokus.map((kyoku) => ({ ...kyoku, entries: [] })) },
    };
    const withoutKyokus: MortalReport = { ...base, review: { ...base.review, total_reviewed: 0, total_matches: 0, kyokus: [] } };
    for (const report of [withoutEntries, withoutKyokus]) {
      const metrics = aiMetricsOf(report);
      expect(metrics).toEqual({ decisions: 0, matches: 0, badMoves: 0, scoreSum: 0, matchRate: null, similarity: null, badMoveRate: null });
      expect(aiMetricsOf(report, { threshold: 0.1 }).similarity).toBeNull();
    }
    expect(aiMetricsOfEntries([]).matchRate).toBeNull();
    // Rating（gameRating）も、判断が無ければ null
    expect(gameRating(withoutEntries)).toBeNull();
  });
});

describe('E-48 AI 一致率・類似度・悪手率: 半荘をまとめる（週の集計）', () => {
  const metricsOf = (ids: readonly string[], threshold?: number): AiMetrics[] =>
    ids.map((id) => aiMetricsOf(gameOf(id).report, threshold === undefined ? {} : { threshold }));

  /** 判断をつなげた並びから、まとめて数えた値（半荘ごとのもとの数を使わない）。 */
  const merged = (ids: readonly string[], threshold?: number): AiMetrics =>
    aiMetricsOfEntries(
      ids.flatMap((id) => gameOf(id).report.review.kyokus.flatMap((kyoku) => kyoku.entries)),
      threshold === undefined ? {} : { threshold },
    );

  function expectSame(actual: AiMetrics, expected: AiMetrics): void {
    // 数は足すだけなので、どんな順でも同じ。点の合計と、そこから出す値は、足す順で最後の桁がずれうる
    expect([actual.decisions, actual.matches, actual.badMoves]).toEqual([expected.decisions, expected.matches, expected.badMoves]);
    expect(actual.scoreSum).toBeCloseTo(expected.scoreSum, 9);
    expect(actual.matchRate).toBe(expected.matchRate);
    expect(actual.badMoveRate).toBe(expected.badMoveRate);
    expect(actual.similarity).toBeCloseTo(expected.similarity ?? Number.NaN, 12);
  }

  it('E-48 2 つの半荘: 数の合計と、まとめた判断すべてから出した値が同じ', () => {
    for (const [a, b] of [
      [FX4_ID, FX5_ID],
      [FX1_IDS[0], FX1_IDS[3]],
      [FX1_IDS[4], FX4_ID],
    ] as const) {
      expectSame(totalAiMetrics(metricsOf([a, b])), merged([a, b]));
      expectSame(totalAiMetrics(metricsOf([a, b], 0.1)), merged([a, b], 0.1));
    }
  });

  it('E-48 7 つの半荘すべて: 判断の数の合計 1159・一致 920・悪手 102（基準 0.05）。まとめた判断すべてから出した値と同じ', () => {
    const total = totalAiMetrics(metricsOf(IDS));
    const sum = (pick: (id: (typeof IDS)[number]) => number) => IDS.reduce((n, id) => n + pick(id), 0);
    expect(total.decisions).toBe(sum((id) => EXPECTED[id].decisions));
    expect(total.matches).toBe(sum((id) => EXPECTED[id].matches));
    expect(total.badMoves).toBe(sum((id) => EXPECTED[id].bad5));
    expect([total.decisions, total.matches, total.badMoves]).toEqual([1159, 920, 102]);
    expectSame(total, merged(IDS));
    expect(totalAiMetrics(metricsOf(IDS, 0.1)).badMoves).toBe(IDS.reduce((n, id) => n + EXPECTED[id].bad10, 0));
  });

  it('E-48 一致率・悪手率は数の合計の割合、類似度はまとめた判断すべてでの Rating の式（半荘ごとの値の平均ではない）', () => {
    const each = metricsOf([FX4_ID, FX1_IDS[0]]);
    const total = totalAiMetrics(each);
    const [small, large] = each as [AiMetrics, AiMetrics];
    expect(total.matchRate).toBe((small.matches + large.matches) / (small.decisions + large.decisions));
    expect(total.badMoveRate).toBe((small.badMoves + large.badMoves) / (small.decisions + large.decisions));
    const mean = (small.scoreSum + large.scoreSum) / (small.decisions + large.decisions);
    expect(total.similarity).toBe(mean * mean);
    // 判断の数が違う半荘（70 と 178）では、値の平均とは違う
    const averageOfRates = ((small.matchRate ?? 0) + (large.matchRate ?? 0)) / 2;
    const averageOfSimilarities = ((small.similarity ?? 0) + (large.similarity ?? 0)) / 2;
    expect(Math.abs((total.matchRate ?? 0) - averageOfRates)).toBeGreaterThan(1e-3);
    expect(Math.abs((total.similarity ?? 0) - averageOfSimilarities)).toBeGreaterThan(1e-4);
  });

  it('E-48 1 つだけ足すと、その半荘の値そのまま（判断を読み直さない: もとの数だけで足せる）', () => {
    const single = aiMetricsOf(gameOf(FX5_ID).report);
    expect(totalAiMetrics([single])).toEqual(single);
    const countsOnly = { decisions: single.decisions, matches: single.matches, badMoves: single.badMoves, scoreSum: single.scoreSum };
    expect(totalAiMetrics([countsOnly])).toEqual(single);
  });

  it('E-48 半荘が 0、または判断が無い半荘だけなら、数は 0、値は null。判断が無い半荘を足しても、ほかの値は変わらない', () => {
    expect(totalAiMetrics([])).toEqual({ decisions: 0, matches: 0, badMoves: 0, scoreSum: 0, matchRate: null, similarity: null, badMoveRate: null });
    const empty = aiMetricsOfEntries([]);
    expect(totalAiMetrics([empty, empty]).similarity).toBeNull();
    const single = aiMetricsOf(gameOf(FX4_ID).report);
    expect(totalAiMetrics([empty, single, empty])).toEqual(single);
  });
});

describe('E-48 文字にする', () => {
  it('E-48 率は百分率で小数第1位まで（0.7233 は 72.3%）。類似度は Rating と同じ書き方（0.9298 は 93.0）', () => {
    expect(formatRatePercent(0.7233)).toBe('72.3%');
    expect(formatRatePercent(0)).toBe('0.0%');
    expect(formatRatePercent(1)).toBe('100.0%');
    expect(formatRatePercent(0.0625)).toBe('6.3%');
    expect(formatSimilarity(0.9298)).toBe('93.0');
    expect(formatSimilarity(1)).toBe('100.0');
    expect(formatSimilarity(0.867082033107309)).toBe(formatRating(0.867082033107309));
  });
});
