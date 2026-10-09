import { describe, expect, it } from 'vitest';

import {
  CORRECT_PROBABILITY_THRESHOLD,
  REVIEW_INTERVALS_DAYS,
  addDays,
  isCorrectAnswer,
  isDue,
  nextIntervalDays,
  scheduleReview,
  toLocalDateString,
} from '../src/srs';

describe('E-5 解き直しの予定（間隔 1 → 3 → 7 → 14 → 30 → 60日）', () => {
  it('E-5 間隔は 1, 3, 7, 14, 30, 60日', () => {
    expect([...REVIEW_INTERVALS_DAYS]).toEqual([1, 3, 7, 14, 30, 60]);
  });

  it('E-5 初めての予定は1日。正解が続くと 1 → 3 → 7 → 14 → 30 → 60 と進み、60日からは進まない', () => {
    let interval: number | null = null;
    const seen: number[] = [];
    for (let i = 0; i < 8; i++) {
      interval = nextIntervalDays(interval, true);
      seen.push(interval);
    }
    expect(seen).toEqual([1, 3, 7, 14, 30, 60, 60, 60]);
  });

  it('E-5 間違えると、どの間隔からでも1日に戻る', () => {
    for (const interval of REVIEW_INTERVALS_DAYS) {
      expect(nextIntervalDays(interval, false)).toBe(1);
    }
    expect(nextIntervalDays(null, false)).toBe(1);
  });

  it('E-5 間違えたあとは、また 1 → 3 → 7 と進み直す', () => {
    let interval: number | null = 30;
    interval = nextIntervalDays(interval, false);
    expect(interval).toBe(1);
    interval = nextIntervalDays(interval, true);
    expect(interval).toBe(3);
    interval = nextIntervalDays(interval, true);
    expect(interval).toBe(7);
  });

  it('E-5 間隔の一覧にない値（手で直した値など）からは、いまより長い次の間隔へ進む', () => {
    expect(nextIntervalDays(5, true)).toBe(7);
    expect(nextIntervalDays(0, true)).toBe(1);
    expect(nextIntervalDays(100, true)).toBe(60);
  });

  it('E-5 正解は、AI がその行動に付けた確率が5%以上のとき（ちょうど5%は正解）', () => {
    expect(CORRECT_PROBABILITY_THRESHOLD).toBe(0.05);
    expect(isCorrectAnswer(0.05)).toBe(true);
    expect(isCorrectAnswer(0.0501)).toBe(true);
    expect(isCorrectAnswer(0.9)).toBe(true);
    expect(isCorrectAnswer(0.0499)).toBe(false);
    expect(isCorrectAnswer(0)).toBe(false);
  });

  it('E-5 基準は変えられる', () => {
    expect(isCorrectAnswer(0.07, 0.1)).toBe(false);
    expect(isCorrectAnswer(0.1, 0.1)).toBe(true);
  });
});

describe('E-5 日付は手元の暦の日付（YYYY-MM-DD）', () => {
  it('E-5 次に解き直す日は、答えた日に間隔を足した日', () => {
    expect(scheduleReview(null, true, '2026-10-09')).toEqual({ intervalDays: 1, dueDate: '2026-10-10' });
    expect(scheduleReview(1, true, '2026-10-10')).toEqual({ intervalDays: 3, dueDate: '2026-10-13' });
    expect(scheduleReview(3, true, '2026-10-13')).toEqual({ intervalDays: 7, dueDate: '2026-10-20' });
    expect(scheduleReview(7, true, '2026-10-20')).toEqual({ intervalDays: 14, dueDate: '2026-11-03' });
    expect(scheduleReview(14, true, '2026-11-03')).toEqual({ intervalDays: 30, dueDate: '2026-12-03' });
    expect(scheduleReview(30, true, '2026-12-03')).toEqual({ intervalDays: 60, dueDate: '2027-02-01' });
    expect(scheduleReview(60, true, '2027-02-01')).toEqual({ intervalDays: 60, dueDate: '2027-04-02' });
    expect(scheduleReview(30, false, '2026-12-03')).toEqual({ intervalDays: 1, dueDate: '2026-12-04' });
  });

  it('E-5 月末・年末・うるう年は暦のとおりに数える', () => {
    expect(addDays('2026-01-31', 1)).toBe('2026-02-01');
    expect(addDays('2026-02-28', 1)).toBe('2026-03-01');
    expect(addDays('2028-02-28', 1)).toBe('2028-02-29');
    expect(addDays('2028-02-28', 2)).toBe('2028-03-01');
    expect(addDays('2026-12-31', 1)).toBe('2027-01-01');
    expect(addDays('2026-10-09', 0)).toBe('2026-10-09');
    expect(addDays('2026-03-01', -1)).toBe('2026-02-28');
  });

  it('E-5 時刻から日付にするときは、UTC でなくその地域の暦で数える（日付をまたぐ時刻の近くでも日がずれない）', () => {
    // 地域の時刻で作った日時は、どの時差の地域でも、その暦の日付になる
    expect(toLocalDateString(new Date(2026, 9, 9, 0, 30))).toBe('2026-10-09');
    expect(toLocalDateString(new Date(2026, 9, 9, 23, 30))).toBe('2026-10-09');
    expect(toLocalDateString(new Date(2026, 0, 1, 0, 0, 0))).toBe('2026-01-01');
    expect(toLocalDateString(new Date(2026, 11, 31, 23, 59, 59))).toBe('2026-12-31');
  });

  it('E-5 期限の日か過ぎていれば解き直す対象になる', () => {
    expect(isDue('2026-10-10', '2026-10-09')).toBe(false);
    expect(isDue('2026-10-10', '2026-10-10')).toBe(true);
    expect(isDue('2026-10-10', '2026-10-11')).toBe(true);
    expect(isDue('2026-10-10', '2027-01-01')).toBe(true);
    expect(isDue('2027-01-01', '2026-12-31')).toBe(false);
  });

  it('E-5 実在しない日付や形の違う文字列は RangeError', () => {
    expect(() => addDays('2026-02-30', 1)).toThrow(RangeError);
    expect(() => addDays('2026-13-01', 1)).toThrow(RangeError);
    expect(() => addDays('2026/10/09', 1)).toThrow(RangeError);
    expect(() => addDays('2026-1-9', 1)).toThrow(RangeError);
    expect(() => addDays('2026-10-09', 1.5)).toThrow(RangeError);
    expect(() => isDue('abc', '2026-10-09')).toThrow(RangeError);
  });
});
