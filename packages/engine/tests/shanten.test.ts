import { describe, expect, it } from 'vitest';

import { bestDiscardOptions, discardOptions, findDiscardOption, shanten, ukeire } from '../src/shanten';
import { tenhouPairiUrl } from '../src/tenhou-url';
import { parseTenhouNotation, toTenhouNotation } from '../src/tiles';
import { loadFixtureJson } from './helpers/fixtures';

interface Fx3Discard {
  discard: string;
  shanten: number;
  ukeire: number;
  accepts: Record<string, number>;
}

interface Fx3Hand {
  style: string;
  tiles: string;
  count: number;
  shanten: number;
  ukeire?: number;
  accepts?: Record<string, number>;
  discards?: Fx3Discard[];
}

interface Fx3 {
  library: string;
  seed: number;
  hands: Fx3Hand[];
}

const fx3 = loadFixtureJson<Fx3>('fx3-shanten-ukeire.json');

function acceptsOf(list: { tile: string; remaining: number }[]): Record<string, number> {
  return Object.fromEntries(list.map((a) => [a.tile, a.remaining]));
}

describe('E-3 FX-3 の正解表（Python の mahjong ライブラリで作成）', () => {
  it('E-3 正解表は200手以上あり、13枚と14枚の手牌を含む', () => {
    expect(fx3.hands.length).toBeGreaterThanOrEqual(200);
    expect(fx3.hands.some((h) => h.count === 13)).toBe(true);
    expect(fx3.hands.some((h) => h.count === 14)).toBe(true);
    expect(fx3.library).toMatch(/^mahjong /);
  });

  it('E-3 全件で、シャンテン数が正解表と一致する', () => {
    const mismatches = fx3.hands
      .map((h) => ({ h, actual: shanten(parseTenhouNotation(h.tiles)) }))
      .filter(({ h, actual }) => actual !== h.shanten)
      .map(({ h, actual }) => `${h.tiles}: 実装 ${actual} / 正解 ${h.shanten}`);
    expect(mismatches).toEqual([]);
  });

  it('E-3 3n+1 枚の手牌は、受け入れ枚数と受け入れの牌（残り枚数つき）が正解表と一致する', () => {
    const hands = fx3.hands.filter((h) => h.count % 3 === 1);
    expect(hands.length).toBeGreaterThan(80);
    for (const h of hands) {
      const result = ukeire(parseTenhouNotation(h.tiles));
      expect({ tiles: h.tiles, shanten: result.shanten, total: result.total, accepts: acceptsOf(result.accepted) }).toEqual({
        tiles: h.tiles,
        shanten: h.shanten,
        total: h.ukeire,
        accepts: h.accepts,
      });
    }
  });

  it('E-3 3n+2 枚の手牌は、切る牌ごとのシャンテン数・受け入れ枚数・受け入れの牌が正解表と一致する', () => {
    const hands = fx3.hands.filter((h) => h.count % 3 === 2);
    expect(hands.length).toBeGreaterThan(100);
    let checkedDiscards = 0;
    for (const h of hands) {
      const options = discardOptions(parseTenhouNotation(h.tiles));
      const actual = options.map((o) => ({
        discard: o.tile,
        shanten: o.shanten,
        ukeire: o.ukeire,
        accepts: acceptsOf(o.accepted),
      }));
      expect({ tiles: h.tiles, discards: actual }).toEqual({ tiles: h.tiles, discards: h.discards });
      checkedDiscards += actual.length;
    }
    expect(checkedDiscards).toBeGreaterThan(1000);
  });

  it('E-3 受け入れ基準の例: 56m46688p1145888s は 打4p 38枚、打5m・6m・4s・5s 34枚、打6p・8p 28枚、打1s 24枚、打8s 15枚（いずれも2シャンテン）', () => {
    const options = discardOptions(parseTenhouNotation('56m46688p1145888s'));
    const byTile = Object.fromEntries(options.map((o) => [o.tile, o]));
    const expected: Record<string, number> = {
      '4p': 38,
      '5m': 34,
      '6m': 34,
      '4s': 34,
      '5s': 34,
      '6p': 28,
      '8p': 28,
      '1s': 24,
      '8s': 15,
    };
    expect(Object.keys(byTile).sort()).toEqual(Object.keys(expected).sort());
    for (const [tile, total] of Object.entries(expected)) {
      expect(byTile[tile]?.ukeire, `打${tile}`).toBe(total);
      expect(byTile[tile]?.shanten, `打${tile}`).toBe(2);
    }
    expect(shanten(parseTenhouNotation('56m46688p1145888s'))).toBe(2);
    expect(bestDiscardOptions(options).map((o) => o.tile)).toEqual(['4p']);
    expect(findDiscardOption(options, '4p')?.ukeire).toBe(38);
  });
});

describe('E-3 七対子と国士無双と手牌の形', () => {
  it('E-3 七対子: 6対子+単騎は聴牌、4対子+3枚の孤立牌は2シャンテン', () => {
    expect(shanten(parseTenhouNotation('1122m3344p5566s7z'))).toBe(0);
    expect(ukeire(parseTenhouNotation('1122m3344p5566s7z')).total).toBe(3);
    expect(shanten(parseTenhouNotation('1122m3344p579s123z'))).toBe(2);
  });

  it('E-3 七対子は同じ牌4枚を2対子に数えない（4枚は1対子で、種類が足りない分は加える）', () => {
    // 1111m 3355p 7799s 1z: 対子は5つ、種類は6つなので 6 - 5 + 1 = 2（4枚を2対子に数えると1になってしまう）。一般形も2
    expect(shanten(parseTenhouNotation('1111m3355p7799s1z'))).toBe(2);
  });

  it('E-3 国士無双: 13面待ちは聴牌で受け入れは13種×3枚、1枚が対子なら13面でなく単騎', () => {
    const thirteen = parseTenhouNotation('19m19p19s1234567z');
    expect(shanten(thirteen)).toBe(0);
    const result = ukeire(thirteen);
    expect(result.accepted).toHaveLength(13);
    expect(result.total).toBe(13 * 3);
    // 12種類 + 1枚が対子（1m が2枚）で、足りない種類 7z（中）を待つ聴牌
    const single = parseTenhouNotation('119m19p19s123456z');
    expect(shanten(single)).toBe(0);
    expect(ukeire(single).accepted.map((a) => a.tile)).toEqual(['C']);
    expect(ukeire(single).total).toBe(4);
  });

  it('E-3 和了形は -1、14枚の副露なし手牌は切る牌ごとの結果が出る', () => {
    expect(shanten(parseTenhouNotation('123m456p789s11z234m'))).toBe(-1);
    expect(shanten(parseTenhouNotation('11m22p33s44z55z66z77z'))).toBe(-1);
    expect(shanten(parseTenhouNotation('19m19p19s12345677z'))).toBe(-1);
  });

  it('E-3 副露のある手（閉じた牌が少ない）は、枚数から副露の数を決めて数える', () => {
    // 面子2つを副露した手の閉じた8枚（2面子 + 雀頭）は和了形
    expect(shanten(parseTenhouNotation('123m456p11z'))).toBe(-1);
    expect(shanten(parseTenhouNotation('123m456p1z'))).toBe(0);
    // 4つ副露して単騎待ち（1枚）は聴牌、2枚の対子は和了形
    expect(shanten(parseTenhouNotation('1z'))).toBe(0);
    expect(shanten(parseTenhouNotation('11z'))).toBe(-1);
    // 1つ副露した手の閉じた10枚: 123m 123m + 44m 55m（雀頭と搭子）で聴牌
    expect(shanten(parseTenhouNotation('1122334455m'))).toBe(0);
  });

  it('E-3 3の倍数の枚数・5枚以上・15枚は RangeError', () => {
    expect(() => shanten(parseTenhouNotation('123m'))).toThrow(RangeError);
    expect(() => shanten(parseTenhouNotation('11111m'))).toThrow(RangeError);
    expect(() => shanten(parseTenhouNotation('123456789m123456p'))).toThrow(RangeError);
  });
});

describe('E-3 天鳳牌理の URL と牌理の表記', () => {
  it('E-3 手牌から https://tenhou.net/2/?q=<表記> を作る', () => {
    expect(tenhouPairiUrl(parseTenhouNotation('56m46688p1145888s'))).toBe('https://tenhou.net/2/?q=56m46688p1145888s');
  });

  it('E-3 並びが順不同でも、萬子・筒子・索子・字牌の順に昇順で書く。字牌は 1z から 7z', () => {
    const tiles = ['C', '9s', 'E', '1m', '5pr', '1s', 'S', '1m', 'F', 'P', 'N', 'W'];
    expect(toTenhouNotation(tiles)).toBe('11m5p19s1234567z');
    expect(tenhouPairiUrl(tiles)).toBe('https://tenhou.net/2/?q=11m5p19s1234567z');
  });

  it('E-3 赤五は普通の五として書き、0m 0p 0s は赤五として読む', () => {
    expect(toTenhouNotation(['5mr', '5p', '5sr'])).toBe('5m5p5s');
    expect(parseTenhouNotation('0m5p0s')).toEqual(['5mr', '5p', '5sr']);
  });

  it('E-3 不正な表記は RangeError', () => {
    expect(() => parseTenhouNotation('12')).toThrow(RangeError);
    expect(() => parseTenhouNotation('1x')).toThrow(RangeError);
    expect(() => parseTenhouNotation('8z')).toThrow(RangeError);
  });
});
