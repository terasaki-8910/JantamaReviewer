import { describe, expect, it } from 'vitest';

import { queryTerms } from '../sessionFilter';
import { hitRanges, splitHits } from './highlight';

const hits = (text: string, query: string) =>
  splitHits(text, queryTerms(query))
    .filter((s) => s.hit)
    .map((s) => s.text);

describe('U-22: 当たった文字の印', () => {
  it('当たった部分と、それ以外に区切る。つなぐと、もとの文字列になる', () => {
    const segments = splitHits('東4局の3mを切った場面', queryTerms('東4局'));
    expect(segments).toEqual([
      { text: '東4局', hit: true },
      { text: 'の3mを切った場面', hit: false },
    ]);
    expect(segments.map((s) => s.text).join('')).toBe('東4局の3mを切った場面');
  });

  it('語が無い・当たりが無いときは、区切らない（1 つだけ）', () => {
    expect(splitHits('東4局 13巡目', [])).toEqual([{ text: '東4局 13巡目', hit: false }]);
    expect(splitHits('東4局 13巡目', queryTerms('南'))).toEqual([{ text: '東4局 13巡目', hit: false }]);
    expect(splitHits('', queryTerms('東'))).toEqual([{ text: '', hit: false }]);
  });

  it('語は、画面の文字のどこにあっても印が付く（複数の語・複数の箇所）', () => {
    expect(hits('東4局1本場 3巡目', '東4局 3巡目')).toEqual(['東4局', '3巡目']);
    expect(hits('東2局の東2局', '東2局')).toEqual(['東2局', '東2局']);
  });

  it('重なる・隣り合う当たりは、1 つにまとめる', () => {
    expect(hitRanges('東4局1本場', queryTerms('東4局 4局1本'))).toEqual([[0, 5]]);
    expect(hitRanges('abcabc', queryTerms('abc'))).toEqual([[0, 6]]);
    expect(hits('玉の間・南', '玉の 間・')).toEqual(['玉の間・']);
  });

  it('全角・半角と大文字・小文字は区別しない（印は、画面に出している文字の位置に付く）', () => {
    expect(hits('10月9日（本日）', '１０月')).toEqual(['10月']);
    expect(hits('10月9日（本日）', '（本日）')).toEqual(['（本日）']);
    expect(hits('Rating が低い順', 'RATING')).toEqual(['Rating']);
    expect(hits('ＡＢＣ', 'abc')).toEqual(['ＡＢＣ']);
  });

  it('数字で始まる語は、別の数字の途中には当てない（「1月9日」は「11月9日」に印を付けない）', () => {
    expect(hits('11月9日', '1月9日')).toEqual([]);
    expect(hits('10月9日 19:09', '9:09')).toEqual([]);
    expect(hits('1月9日', '1月9日')).toEqual(['1月9日']);
    expect(hits('東4局 14巡目', '4巡目')).toEqual([]);
  });

  it('サロゲートペアの文字（𠮷など）を含んでも、位置がずれない', () => {
    const segments = splitHits('𠮷野家の東4局', queryTerms('東4局'));
    expect(segments).toEqual([
      { text: '𠮷野家の', hit: false },
      { text: '東4局', hit: true },
    ]);
  });
});
