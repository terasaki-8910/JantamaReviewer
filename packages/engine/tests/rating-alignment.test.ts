import { describe, expect, it } from 'vitest';

import type { HandMark } from '../src/outcome';
import { summarizeKyokus } from '../src/outcome';
import { alignRatings } from '../src/rating-alignment';
import { parseReportText } from '../src/report';
import { loadReportText } from './helpers/fixtures';

const marks: HandMark[] = ['good', 'fair', 'bad', 'good', 'fair'];

describe('E-7 評価の突き合わせ（ウィジェットの評価を押した順に局へ割り当てる）', () => {
  it('E-7 評価の数と局の数が同じなら、押した順に局へ割り当てる', () => {
    const result = alignRatings(marks.slice(0, 3), 3);
    expect(result.status).toBe('exact');
    expect(result.assigned).toEqual(['good', 'fair', 'bad']);
    expect(result.extra).toEqual([]);
    expect(result.missingHands).toEqual([]);
    expect(result.handCount).toBe(3);
    expect(result.ratingCount).toBe(3);
  });

  it('E-7 評価が局より多いときは、その旨（tooMany）と、局を超えた分を返す', () => {
    const result = alignRatings(marks, 3);
    expect(result.status).toBe('tooMany');
    expect(result.assigned).toEqual(['good', 'fair', 'bad']);
    expect(result.extra).toEqual(['good', 'fair']);
    expect(result.missingHands).toEqual([]);
    expect(result.message).toContain('2件多い');
    expect(result.message).toContain('評価5件');
    expect(result.message).toContain('局3局');
  });

  it('E-7 評価が局より少ないときは、その旨（tooFew）と、評価の付かなかった局を返す', () => {
    const result = alignRatings(marks.slice(0, 2), 4);
    expect(result.status).toBe('tooFew');
    expect(result.assigned).toEqual(['good', 'fair', null, null]);
    expect(result.extra).toEqual([]);
    expect(result.missingHands).toEqual([2, 3]);
    expect(result.message).toContain('2件足りません');
  });

  it('E-7 評価が1つもない・局が1つもない場合も扱える', () => {
    expect(alignRatings([], 3)).toMatchObject({ status: 'tooFew', assigned: [null, null, null], missingHands: [0, 1, 2] });
    expect(alignRatings(marks, 0)).toMatchObject({ status: 'tooMany', assigned: [], extra: marks });
    expect(alignRatings([], 0)).toMatchObject({ status: 'exact', assigned: [] });
  });

  it('E-7 評価は〇△✕に限らず、押した時刻などを持つ記録そのものでも割り当てられる', () => {
    const entries = [
      { id: 1, t_ms: 1000, rating: 'good' },
      { id: 2, t_ms: 2000, rating: 'bad' },
    ];
    const result = alignRatings(entries, 2);
    expect(result.assigned[0]).toBe(entries[0]);
    expect(result.assigned[1]).toBe(entries[1]);
  });

  it('E-7 局の数が負・小数のときは RangeError', () => {
    expect(() => alignRatings(marks, -1)).toThrow(RangeError);
    expect(() => alignRatings(marks, 2.5)).toThrow(RangeError);
  });

  it('E-7 f9da87cbcd7af5e9（12局）: 評価が12件なら exact、11件なら tooFew、13件なら tooMany', () => {
    const parsed = parseReportText(loadReportText('f9da87cbcd7af5e9'));
    expect(parsed.ok).toBe(true);
    if (!parsed.ok) return;
    const handCount = summarizeKyokus(parsed.value).length;
    expect(handCount).toBe(12);
    const twelve = Array.from({ length: 12 }, (_, i) => marks[i % marks.length] as HandMark);
    expect(alignRatings(twelve, handCount).status).toBe('exact');
    expect(alignRatings(twelve.slice(0, 11), handCount)).toMatchObject({ status: 'tooFew', missingHands: [11] });
    expect(alignRatings([...twelve, 'bad' as HandMark], handCount)).toMatchObject({ status: 'tooMany', extra: ['bad'] });
  });
});
