import { describe, expect, it } from 'vitest';

import { importReportText } from '../src/import';
import { gameRating, formatRating } from '../src/rating';
import { FX4_ID, loadFx4Ocr, loadReportText } from './helpers/fixtures';

// FX-4: 10月9日にウィジェットで記録した5局の半荘（結果 5b821c8a048ff791）と、迷いマーク6枚の文字認識の写し。
// 結びつけ（E-16〜E-19）のテストが前提にする、固定データそのものの確かめ。
describe('FX-4 の結果 JSON', () => {
  const imported = importReportText(loadReportText(FX4_ID));

  it('取り込める（再生した手牌・副露・実戦の行動が、記録と全判断で一致する）', () => {
    expect(imported.ok).toBe(true);
    if (!imported.ok) return;
    expect(imported.value.kyokus).toHaveLength(5);
    expect(imported.value.decisions).toHaveLength(70);
    expect(imported.value.report.review.total_reviewed).toBe(70);
    expect(imported.value.playerId).toBe(0);
  });

  it('局の名前と、本人の局の始めの点数（ACCEPTANCE の E-17 の前提）', () => {
    if (!imported.ok) throw new Error(imported.error.message);
    const rows = imported.value.report.review.kyokus.map((k, i) => ({
      label: imported.value.kyokus[i]?.label,
      score: k.relative_scores[0],
      decisions: k.entries.length,
    }));
    expect(rows).toEqual([
      { label: '東1局', score: 25000, decisions: 18 },
      { label: '東2局', score: 19000, decisions: 17 },
      { label: '東2局1本場', score: 15100, decisions: 13 },
      { label: '東3局', score: 16400, decisions: 5 },
      { label: '東3局1本場', score: 4400, decisions: 17 },
    ]);
  });

  it('半荘全体の Rating は 93.0（mjai のサイトの値）で、玉の間・南喰赤', () => {
    if (!imported.ok) throw new Error(imported.error.message);
    expect(formatRating(gameRating(imported.value.report) ?? NaN)).toBe('93.0');
    const first = imported.value.report.split_logs[0] as { rule?: { disp?: string } };
    expect(first.rule?.disp).toBe('玉の間南喰赤');
  });
});

describe('FX-4 の文字認識の写し', () => {
  const marks = loadFx4Ocr();

  it('迷いマークは6枚で、番号は1から、押した時刻は押した順に並んでいる', () => {
    expect(marks.map((m) => m.mark)).toEqual([1, 2, 3, 4, 5, 6]);
    const times = marks.map((m) => m.time);
    expect([...times].sort()).toEqual(times);
    expect(times[0]).toBe('2026-10-09T19:09:53.812');
    expect(times[5]).toBe('2026-10-09T19:22:36.593');
  });

  it('lines は text を " | " で分けたものと同じ', () => {
    for (const m of marks) expect(m.text.split(' | '), `迷い${m.mark}`).toEqual(m.lines);
  });
});
