import type { Tile } from '@jantama/engine';
import { describe, expect, it } from 'vitest';

import { doraKinds, doraOfMarker, isDoraTile } from './dora';

describe('U-19 ドラを目立たせる: どの牌に付けるか', () => {
  it('ドラ表示牌が指す牌: 数牌は次の数（9 の次は 1）、風は 東→南→西→北→東、三元牌は 白→發→中→白', () => {
    expect(doraOfMarker('1m')).toBe('2m');
    expect(doraOfMarker('9p')).toBe('1p');
    expect(doraOfMarker('4s')).toBe('5s');
    expect(['E', 'S', 'W', 'N'].map((tile) => doraOfMarker(tile as Tile))).toEqual(['S', 'W', 'N', 'E']);
    expect(['P', 'F', 'C'].map((tile) => doraOfMarker(tile as Tile))).toEqual(['F', 'C', 'P']);
  });

  it('表示牌が赤五でも、指す牌は 6（赤でない表記）', () => {
    expect(doraOfMarker('5pr')).toBe('6p');
  });

  it('中央の箱の王牌の表示牌からドラへの変換（U-44）: 4m→5m、9m→1m、北→東、中→白、赤5m→6m', () => {
    expect(doraOfMarker('4m')).toBe('5m');
    expect(doraOfMarker('9m')).toBe('1m');
    expect(doraOfMarker('N')).toBe('E');
    expect(doraOfMarker('C')).toBe('P');
    expect(doraOfMarker('5mr')).toBe('6m');
  });

  it('設定が切（null）のときは、どの牌にも付けない', () => {
    expect(isDoraTile('3p', null)).toBe(false);
    expect(isDoraTile('5pr', null)).toBe(false);
  });

  it('入のときは、ドラ表示牌が指す種類の牌に付ける（牌譜の表記の違いは種類で見る）', () => {
    const kinds = doraKinds(['7p']);
    expect(isDoraTile('8p', kinds)).toBe(true);
    expect(isDoraTile('7p', kinds)).toBe(false);
    expect(isDoraTile('8s', kinds)).toBe(false);
  });

  it('赤五は、指される五（ドラ表示牌が 4 の牌）でもあるときだけ付く。ダブドラ以外では付けない（R10-7）', () => {
    expect(isDoraTile('5pr', doraKinds(['4p']))).toBe(true);
    expect(isDoraTile('5p', doraKinds(['4p']))).toBe(true);
    // 赤五が手牌にあっても、ドラ表示牌が別の牌なら付けない
    expect(isDoraTile('5pr', doraKinds(['7p']))).toBe(false);
    expect(isDoraTile('5sr', doraKinds(['4p']))).toBe(false);
  });

  it('ドラ表示牌が複数（カンドラ）なら、どれが指す牌にも付ける', () => {
    const kinds = doraKinds(['1m', 'E']);
    expect(isDoraTile('2m', kinds)).toBe(true);
    expect(isDoraTile('S', kinds)).toBe(true);
    expect(isDoraTile('E', kinds)).toBe(false);
    expect(kinds.size).toBe(2);
  });
});
