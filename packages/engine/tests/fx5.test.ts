import { describe, expect, it } from 'vitest';

import { importReportText } from '../src/import';
import { formatRating, gameRating } from '../src/rating';
import { FX5_ID, loadFx4Ocr, loadFx4Widget, loadFx5Ocr, loadFx5Widget, loadReportText } from './helpers/fixtures';

// FX-5: 10月11日 15:35 にウィジェットで記録した10局の半荘（迷い13・評価9）。
// 結びつけ（E-28〜E-31）のテストが前提にする、固定データそのものの確かめ。
describe('FX-5 の結果 JSON', () => {
  const imported = importReportText(loadReportText(FX5_ID));

  it('取り込める（再生した手牌・副露・実戦の行動が、記録と全判断で一致する）', () => {
    expect(imported.ok).toBe(true);
    if (!imported.ok) return;
    expect(imported.value.kyokus).toHaveLength(10);
    expect(imported.value.decisions).toHaveLength(125);
    expect(imported.value.report.review.total_reviewed).toBe(125);
    expect(imported.value.playerId).toBe(0);
  });

  it('局の名前・本人の局の始めの点数・判断の数（東3局は、自分の番が来る前に終わった局で、判断が無い）', () => {
    if (!imported.ok) throw new Error(imported.error.message);
    const rows = imported.value.report.review.kyokus.map((k, i) => ({
      label: imported.value.kyokus[i]?.label,
      score: k.relative_scores[0],
      decisions: k.entries.length,
    }));
    expect(rows).toEqual([
      { label: '東1局', score: 25000, decisions: 13 },
      { label: '東2局', score: 25000, decisions: 15 },
      { label: '東3局', score: 23700, decisions: 0 },
      { label: '東3局1本場', score: 23700, decisions: 10 },
      { label: '東4局', score: 31700, decisions: 16 },
      { label: '東4局1本場', score: 31700, decisions: 5 },
      { label: '南1局2本場', score: 33700, decisions: 11 },
      { label: '南2局', score: 32500, decisions: 20 },
      { label: '南3局', score: 20500, decisions: 23 },
      { label: '南4局', score: 28500, decisions: 12 },
    ]);
  });

  it('玉の間・南喰赤で、半荘全体の Rating はサイトの値（92.1）', () => {
    if (!imported.ok) throw new Error(imported.error.message);
    expect(formatRating(gameRating(imported.value.report) ?? NaN)).toBe('92.1');
    const first = imported.value.report.split_logs[0] as { rule?: { disp?: string } };
    expect(first.rule?.disp).toBe('玉の間南喰赤');
  });
});

describe('FX-5 のウィジェットの記録', () => {
  const events = loadFx5Widget();
  const times = events.map((e) => e.time);

  it('迷い13・評価9で、id は 1 から 22 の押した順（取り消しは無い）、時刻は昇順', () => {
    expect(events).toHaveLength(22);
    expect(events.map((e) => e.id)).toEqual(Array.from({ length: 22 }, (_, i) => i + 1));
    expect([...times].sort()).toEqual(times);
    expect(events.filter((e) => e.type === 'mark').map((e) => e.id)).toEqual([2, 3, 4, 6, 8, 9, 10, 13, 14, 16, 17, 19, 21]);
    expect(events.filter((e) => e.type === 'rating').map((e) => e.id)).toEqual([1, 5, 7, 11, 12, 15, 18, 20, 22]);
  });

  it('評価の値は 〇△✕ の順に、△・△・〇・✕・〇・△・✕・〇・✕', () => {
    expect(events.filter((e) => e.type === 'rating').map((e) => e.rating)).toEqual([
      'fair',
      'fair',
      'good',
      'bad',
      'good',
      'fair',
      'bad',
      'good',
      'bad',
    ]);
    expect(events.filter((e) => e.type === 'mark').every((e) => e.rating === undefined)).toBe(true);
  });

  it('時刻はミリ秒まであり、画像のファイル名（marks/・ratings/ の 時刻.png）と同じ時刻', () => {
    for (const event of events) {
      expect(event.time).toMatch(/^2026-10-11T\d{2}:\d{2}:\d{2}\.\d{3}$/);
      const stem = event.time.replace(/[-:]/g, '').replace('T', '-').replace('.', '-');
      expect(event.screenshot).toBe(`${event.type === 'mark' ? 'marks' : 'ratings'}/${stem}.png`);
    }
    expect(times[0]).toBe('2026-10-11T15:35:40.873');
    expect(times[21]).toBe('2026-10-11T16:04:51.526');
  });
});

describe('FX-5 の文字認識の写し', () => {
  const ocr = loadFx5Ocr();

  it('迷いと評価の22枚すべてに、1回目と読み直し2つ（コントラスト ×1.8・1.5 倍の順）の行がある', () => {
    expect(ocr.geometry).toBe('center-v2-lanczos3x-variants');
    expect(Object.keys(ocr.entries).sort()).toEqual(
      loadFx5Widget()
        .map((e) => e.screenshot)
        .sort(),
    );
    for (const [name, entry] of Object.entries(ocr.entries)) {
      expect(Array.isArray(entry.lines), name).toBe(true);
      expect(entry.retries?.map((r) => r.variant), name).toEqual(['contrast1.8', 'upscale1.5']);
    }
  });
});

describe('FX-4 のウィジェットの記録（10月9日。迷い6・評価5）', () => {
  const events = loadFx4Widget();

  it('迷い6・評価5で、id は 1 から 11 の押した順、時刻は昇順。迷いの時刻は fx4-ocr.json と同じ', () => {
    expect(events.map((e) => e.id)).toEqual(Array.from({ length: 11 }, (_, i) => i + 1));
    expect([...events.map((e) => e.time)].sort()).toEqual(events.map((e) => e.time));
    const marks = events.filter((e) => e.type === 'mark');
    expect(marks.map((e) => e.id)).toEqual([1, 3, 5, 6, 8, 9]);
    expect(marks.map((e) => e.time)).toEqual(loadFx4Ocr().map((m) => m.time));
    expect(marks.map((e) => e.mark)).toEqual([1, 2, 3, 4, 5, 6]);
  });

  it('評価は 19:12:50 △・19:16:39 ✕・19:19:11 △・19:22:41 ✕・19:23:54 ✕（秒まで）', () => {
    const ratings = events.filter((e) => e.type === 'rating');
    expect(ratings.map((e) => [e.id, e.time.slice(11, 19), e.rating])).toEqual([
      [2, '19:12:50', 'fair'],
      [4, '19:16:39', 'bad'],
      [7, '19:19:11', 'fair'],
      [10, '19:22:41', 'bad'],
      [11, '19:23:54', 'bad'],
    ]);
  });
});
