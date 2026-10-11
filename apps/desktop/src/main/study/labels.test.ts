import { describe, expect, it } from 'vitest';

import { KIND_NAME, formatElapsed, formatMonthDay, formatMonthDayOfMs, relationName } from './labels';
import { kindOrder, tileFile, tileName, tileSrc } from './tiles';

describe('出題の画面の短い言い方', () => {
  it('答えるまでの時間: 0:38・1:05', () => {
    expect(formatElapsed(38)).toBe('0:38');
    expect(formatElapsed(65)).toBe('1:05');
    expect(formatElapsed(0)).toBe('0:00');
    expect(formatElapsed(-3)).toBe('0:00');
    expect(formatElapsed(59.6)).toBe('1:00');
  });

  it('日付: 10月16日（暦の日付・時刻のどちらからでも）', () => {
    expect(formatMonthDay('2026-10-16')).toBe('10月16日');
    expect(formatMonthDay('2026-01-05')).toBe('1月5日');
    expect(formatMonthDayOfMs(new Date(2026, 9, 9, 19, 9).getTime())).toBe('10月9日');
  });

  it('本人から見た呼び名: 自分・下家・対面・上家', () => {
    expect([0, 1, 2, 3].map((seat) => relationName(0, seat as 0 | 1 | 2 | 3))).toEqual(['自分', '下家', '対面', '上家']);
    expect([0, 1, 2, 3].map((seat) => relationName(2, seat as 0 | 1 | 2 | 3))).toEqual(['対面', '上家', '自分', '下家']);
  });

  it('判断の種類の名前', () => {
    expect(KIND_NAME).toEqual({ discard: '打牌', call: '鳴き', riichi: 'リーチ', win: '和了', kan: 'カン' });
  });
});

describe('牌の画像と呼び名', () => {
  it('画像のファイル: 数牌は Man・Pin・Sou、赤五は -Dora、字牌は Ton Nan Shaa Pei Haku Hatsu Chun', () => {
    expect(tileFile('1m')).toBe('Man1');
    expect(tileFile('9p')).toBe('Pin9');
    expect(tileFile('5sr')).toBe('Sou5-Dora');
    expect(['E', 'S', 'W', 'N', 'P', 'F', 'C'].map((tile) => tileFile(tile as never))).toEqual([
      'Ton',
      'Nan',
      'Shaa',
      'Pei',
      'Haku',
      'Hatsu',
      'Chun',
    ]);
    expect(tileSrc('5pr')).toBe('/tiles/Pin5-Dora.svg');
  });

  it('読み上げの名前: 一萬・赤五筒・東', () => {
    expect(tileName('1m')).toBe('一萬');
    expect(tileName('5pr')).toBe('赤五筒');
    expect(tileName('8s')).toBe('八索');
    expect(tileName('E')).toBe('東');
    expect(tileName('F')).toBe('發');
  });

  it('並べ替えの順は種類の順（赤五は五と同じ）', () => {
    expect(kindOrder('5pr')).toBe(kindOrder('5p'));
    expect(kindOrder('1m')).toBeLessThan(kindOrder('1p'));
    expect(kindOrder('9s')).toBeLessThan(kindOrder('E'));
  });
});
