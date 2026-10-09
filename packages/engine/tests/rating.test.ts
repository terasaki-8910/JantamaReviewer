import { describe, expect, it } from 'vitest';

import { decisionScore, formatRating, gameRating, handRatings, ratingOf } from '../src/rating';
import { parseReportText } from '../src/report';
import type { MortalReport, ReportEntry } from '../src/report-types';
import { loadMakaDataset } from './helpers/csv';
import { FX1_IDS, loadReportText } from './helpers/fixtures';

function load(id: string): MortalReport {
  const r = parseReportText(loadReportText(id));
  if (!r.ok) throw new Error(r.error.message);
  return r.value;
}

function entryOf(isEqual: boolean, qValues: number[], actualIndex: number): Pick<ReportEntry, 'is_equal' | 'details' | 'actual_index'> {
  return {
    is_equal: isEqual,
    actual_index: actualIndex,
    details: qValues.map((q) => ({ action: { type: 'none' as const }, q_value: q, prob: 0 })),
  };
}

describe('E-12 Mortal の Rating（mjai-reviewer の式）', () => {
  it('E-12 判断の点: AI と同じなら 1、違えば (選んだ手 - 最低) / (最高 - 最低)', () => {
    expect(decisionScore(entryOf(true, [0.5, 0.1, -0.3], 2))).toBe(1);
    expect(decisionScore(entryOf(false, [0.5, 0.1, -0.3], 1))).toBeCloseTo((0.1 - -0.3) / (0.5 - -0.3), 12);
    expect(decisionScore(entryOf(false, [0.5, 0.1, -0.3], 2))).toBe(0);
    expect(decisionScore(entryOf(false, [0.5, 0.1, -0.3], 0))).toBe(1);
  });

  it('E-12 最高と最低が近すぎるときは、分母を 1e-6 にする', () => {
    // 差が 1e-9 のとき、(actual - min) / 1e-6 = 1e-9 / 1e-6 = 1e-3
    const score = decisionScore(entryOf(false, [0.000000001, 0], 0));
    expect(score).toBeCloseTo(1e-3, 12);
  });

  it('E-12 候補の並びが q_value の降順でなくても、最高と最低は全候補から取る', () => {
    expect(decisionScore(entryOf(false, [0.1, 0.5, -0.3], 0))).toBeCloseTo((0.1 - -0.3) / (0.5 - -0.3), 12);
  });

  it('E-12 Rating は点の平均の 2 乗。判断が無ければ null', () => {
    const entries = [entryOf(true, [1, 0], 0), entryOf(false, [1, 0], 1), entryOf(false, [1, 0.5, 0], 1)] as ReportEntry[];
    // 点は 1, 0, 0.5。平均 0.5、2 乗 0.25
    expect(ratingOf(entries)).toBeCloseTo(0.25, 12);
    expect(ratingOf([])).toBeNull();
  });

  it('E-12 100 倍して小数第1位まで: 0.8670 は 86.7', () => {
    expect(formatRating(0.867082033107309)).toBe('86.7');
    expect(formatRating(1)).toBe('100.0');
    expect(formatRating(0)).toBe('0.0');
  });

  it('E-12 f9da87cbcd7af5e9 の半荘全体の Rating は 86.7', () => {
    const rating = gameRating(load('f9da87cbcd7af5e9'));
    expect(rating).not.toBeNull();
    expect(formatRating(rating ?? NaN)).toBe('86.7');
  });

  for (const id of FX1_IDS) {
    it(`E-12 ${id}: 半荘全体の Rating が、結果 JSON の review.rating と一致する`, () => {
      const report = load(id);
      const rating = gameRating(report);
      expect(rating).not.toBeNull();
      // JSON の q_value は f32 の短い表記なので、f64 のまま計算した mjai-reviewer の値とは 1e-7 ほどずれうる
      expect(Math.abs((rating ?? NaN) - report.review.rating)).toBeLessThan(1e-6);
      expect(formatRating(rating ?? NaN)).toBe(formatRating(report.review.rating));
    });
  }

  it('E-12 analysis/maka-fit/dataset.csv の67局すべてで、局ごとの Rating が小数第1位まで一致する', () => {
    const dataset = loadMakaDataset();
    expect(dataset).toHaveLength(67);
    let checked = 0;
    for (const id of FX1_IDS) {
      const ratings = handRatings(load(id));
      const rows = dataset.filter((r) => r.game === id);
      expect(ratings).toHaveLength(rows.length);
      rows.forEach((row, i) => {
        expect(Number(row.idx)).toBe(i);
        const expected = Number(row.rating) * 100;
        const actual = (ratings[i] ?? NaN) * 100;
        expect(formatRating(ratings[i] ?? NaN), `${id} ${row.label}`).toBe(expected.toFixed(1));
        expect(Math.abs(actual - expected), `${id} ${row.label}`).toBeLessThan(1e-9);
        checked++;
      });
    }
    expect(checked).toBe(67);
  });
});
