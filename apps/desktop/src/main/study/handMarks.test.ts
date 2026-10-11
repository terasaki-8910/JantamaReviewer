import type { Tile } from '@jantama/engine';
import { describe, expect, it } from 'vitest';

import { buildHandItems, handMarks, usedIndices } from './handMarks';

const hand = (tiles: Tile[], drawn: Tile | null = null) => ({ hand: tiles, drawn });

describe('出題の手牌の組み立て', () => {
  it('左から、手牌・ツモ牌・（鳴きの判断で）鳴く牌。通し番号は左から', () => {
    const items = buildHandItems(hand(['3m', '3m', '4m'], '1s'), 'E');
    expect(items.map((item) => [item.tile, item.index, item.draw, item.called])).toEqual([
      ['3m', 0, false, false],
      ['3m', 1, false, false],
      ['4m', 2, false, false],
      ['1s', 3, true, false],
      ['E', 4, false, true],
    ]);
  });

  it('ツモ牌が無い判断（鳴き）は、手牌と鳴く牌だけ。鳴く牌が無い判断は、鳴く牌の項目を足さない', () => {
    expect(buildHandItems(hand(['3m'], null), null).map((item) => item.tile)).toEqual(['3m']);
    const items = buildHandItems(hand(['3m'], null), 'E');
    expect(items.map((item) => [item.tile, item.called])).toEqual([
      ['3m', false],
      ['E', true],
    ]);
  });
});

describe('鳴きの選択肢が手牌から出す牌（持ち上げる牌）', () => {
  it('同じ牌があればそれ。無ければ、同じ種類の牌（赤五と普通の五を同じ牌として）', () => {
    const items = buildHandItems(hand(['4p', '5pr', '6p', '6p', '7p'], null), null);
    // 5p を使う選択肢（赤の区別が無い）は、手牌の赤五を持ち上げる
    expect([...usedIndices(items, ['4p', '6p'])].sort()).toEqual([0, 2]);
    expect([...usedIndices(items, ['5p', '6p'])].sort()).toEqual([1, 2]);
    // 同じ牌を 2 枚使うとき、同じ牌を 2 度は数えない
    expect([...usedIndices(items, ['6p', '6p'])].sort()).toEqual([2, 3]);
  });

  it('鳴く牌の項目は、持ち上げの対象にならない', () => {
    const items = buildHandItems(hand(['E', 'E'], null), 'E');
    expect([...usedIndices(items, ['E', 'E'])].sort()).toEqual([0, 1]);
  });
});

describe('答え合わせのあとの印（自分・実戦・AI）', () => {
  it('同じ種類の牌が何枚かあるとき、印は全部に付き、文字はいちばん左の 1 枚だけ', () => {
    const items = buildHandItems(hand(['3m', '3m', '4m', '7s', '7s'], '1s'), null);
    const marks = handMarks(items, { you: '1s', act: '3m', top: '7s', actTsumogiri: false });
    expect(marks.get(0)).toEqual({ kinds: ['act'], labeled: ['act'] });
    expect(marks.get(1)).toEqual({ kinds: ['act'], labeled: [] });
    expect(marks.get(3)).toEqual({ kinds: ['top'], labeled: ['top'] });
    expect(marks.get(4)).toEqual({ kinds: ['top'], labeled: [] });
    expect(marks.get(5)).toEqual({ kinds: ['you'], labeled: ['you'] });
    expect(marks.has(2)).toBe(false);
  });

  it('自分・実戦・AI が同じ牌なら、1 枚の牌に 3 つの印（自分・実戦・AI の順）', () => {
    const items = buildHandItems(hand(['3m', '4m'], null), null);
    expect(handMarks(items, { you: '3m', act: '3m', top: '3m', actTsumogiri: false }).get(0)).toEqual({
      kinds: ['you', 'act', 'top'],
      labeled: ['you', 'act', 'top'],
    });
  });

  it('赤五と普通の五は、同じ種類として印を付ける', () => {
    const items = buildHandItems(hand(['5pr', '5p'], null), null);
    const marks = handMarks(items, { you: '5p', act: null, top: null, actTsumogiri: false });
    expect(marks.get(0)?.kinds).toEqual(['you']);
    expect(marks.get(1)?.kinds).toEqual(['you']);
    expect(marks.get(0)?.labeled).toEqual(['you']);
    expect(marks.get(1)?.labeled).toEqual([]);
  });

  it('実戦がツモ切りなら、「実戦」の文字はツモ牌に出す（手牌に同じ種類があっても）', () => {
    const items = buildHandItems(hand(['3m', '3m', '4m'], '3m'), null);
    const marks = handMarks(items, { you: null, act: '3m', top: null, actTsumogiri: true });
    expect(marks.get(0)?.labeled).toEqual([]);
    expect(marks.get(1)?.labeled).toEqual([]);
    expect(marks.get(3)).toEqual({ kinds: ['act'], labeled: ['act'] });
    // ツモ切りでなければ、いちばん左
    const plain = handMarks(items, { you: null, act: '3m', top: null, actTsumogiri: false });
    expect(plain.get(0)?.labeled).toEqual(['act']);
    expect(plain.get(3)?.labeled).toEqual([]);
  });

  it('鳴く牌（手牌でない項目）には、印を付けない', () => {
    const items = buildHandItems(hand(['E'], null), 'E');
    const marks = handMarks(items, { you: 'E', act: null, top: null, actTsumogiri: false });
    expect([...marks.keys()]).toEqual([0]);
  });
});
