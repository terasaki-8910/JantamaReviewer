import { describe, expect, it } from 'vitest';

import { formatClock, formatKeyCode, formatSessionTitle } from './format';

const local = (y: number, mo: number, d: number, h = 0, mi = 0, s = 0) =>
  new Date(y, mo - 1, d, h, mi, s).getTime();

describe('formatSessionTitle', () => {
  it('今年の日付は、月日・曜日・時分', () => {
    const now = local(2026, 10, 10);
    expect(formatSessionTitle(local(2026, 10, 9, 16, 12, 34), now)).toBe('10月9日(金) 16:12');
    expect(formatSessionTitle(local(2026, 1, 3, 9, 5), now)).toBe('1月3日(土) 09:05');
  });

  it('今年でなければ年も付ける', () => {
    expect(formatSessionTitle(local(2025, 12, 31, 23, 10), local(2026, 1, 2))).toBe(
      '2025年12月31日(水) 23:10',
    );
  });
});

describe('formatClock', () => {
  it('時:分:秒を 2 桁で出す', () => {
    expect(formatClock(local(2026, 10, 9, 16, 14, 32))).toBe('16:14:32');
    expect(formatClock(local(2026, 10, 9, 1, 2, 3))).toBe('01:02:03');
  });
});

describe('formatKeyCode', () => {
  it('キーの名前を短い表記にする', () => {
    expect(formatKeyCode('KeyM')).toBe('M');
    expect(formatKeyCode('Digit5')).toBe('5');
    expect(formatKeyCode('F8')).toBe('F8');
    expect(formatKeyCode('Numpad3')).toBe('テンキー 3');
    expect(formatKeyCode('NumpadAdd')).toBe('テンキー +');
    expect(formatKeyCode('Insert')).toBe('Insert');
  });
});
