import { describe, expect, it } from 'vitest';

import { listDisagreements } from '../src/disagreement';
import { type ImportedGame, importReportText } from '../src/import';
import { findDecisionByKey, keyOfDecision } from '../src/problems';
import { discardOptions, shanten } from '../src/shanten';
import { parseTenhouNotation, tileKind } from '../src/tiles';
import { followAfterTwoShanten } from '../src/two-shanten-follow';
import { FX4_ID, loadFixtureJson, loadReportText } from './helpers/fixtures';

interface FollowFixture {
  library: string;
  positions: Array<{
    report: string;
    key: string;
    label: string;
    options: Array<{
      discard: string;
      follow: {
        total: number;
        kinds: number;
        weighted: number;
        average: number;
        max: number;
        rows: Array<[string, number, string, number]>;
      };
    }>;
  }>;
}

const fixture = loadFixtureJson<FollowFixture>('follow.json');

function load(id: string): ImportedGame {
  const r = importReportText(loadReportText(id));
  if (!r.ok) throw new Error(`${id}: ${r.error.message}`);
  return r.value;
}

/** 判断の手牌（ツモ牌を含む）から、種類 kind の牌を 1 枚切ったあとの 13 枚。 */
function afterDiscard(game: ImportedGame, key: string, discard: string): string[] {
  const decision = findDecisionByKey(game, key);
  if (!decision) throw new Error(`判断が無い: ${key}`);
  const tiles = [...decision.board.hand, ...(decision.board.drawn === null ? [] : [decision.board.drawn])];
  const at = tiles.findIndex((t) => tileKind(t) === tileKind(discard));
  if (at < 0) throw new Error(`手牌に ${discard} が無い`);
  return tiles.filter((_, i) => i !== at);
}

describe('E-23 2向聴からの先: 1向聴に進む牌ごとに、そのあと受け入れが最大になる打牌と枚数', () => {
  const f9da = load('f9da87cbcd7af5e9');
  const fx4 = load(FX4_ID);

  it('E-23 f9da87cbcd7af5e9 の東4局13巡目 打3m: 1向聴に進む牌 48枚（14種類）・平均 19.3・最大 33', () => {
    const worst = listDisagreements(f9da.decisions).items[0]?.decision;
    expect(worst?.kyokuLabel).toBe('東4局');
    expect(worst?.junme).toBe(13);
    if (!worst) return;
    const follow = followAfterTwoShanten(afterDiscard(f9da, keyOfDecision(worst), '3m'));
    expect(follow).not.toBeNull();
    if (!follow) return;
    expect(follow.total).toBe(48);
    expect(follow.kinds).toBe(14);
    expect(follow.average.toFixed(1)).toBe('19.3');
    expect(follow.max).toBe(33);
  });

  it('E-23 FX-4 の東2局1本場 8巡目 打6m: 50枚（15種類）・平均 12.9・最大 43', () => {
    const follow = followAfterTwoShanten(afterDiscard(fx4, 'k1h1e9', '6m'));
    expect(follow).not.toBeNull();
    if (!follow) return;
    expect(follow.total).toBe(50);
    expect(follow.kinds).toBe(15);
    expect(follow.average.toFixed(1)).toBe('12.9');
    expect(follow.max).toBe(43);
  });

  it('E-23 正解表は Python の mahjong ライブラリで素朴に数えたもの。2 つの場面の 2 向聴の打牌すべてで、行（引く牌・枚数・切る牌・受け入れ）・平均・最大が一致する', () => {
    expect(fixture.library).toMatch(/^mahjong /);
    expect(fixture.positions).toHaveLength(2);
    let options = 0;
    for (const position of fixture.positions) {
      const game = position.report === FX4_ID ? fx4 : f9da;
      const decision = findDecisionByKey(game, position.key);
      expect(decision?.junme, position.label).toBeDefined();
      for (const option of position.options) {
        options++;
        const follow = followAfterTwoShanten(afterDiscard(game, position.key, option.discard));
        expect(follow, `${position.label} 打${option.discard}`).not.toBeNull();
        if (!follow) continue;
        expect(follow.total).toBe(option.follow.total);
        expect(follow.kinds).toBe(option.follow.kinds);
        expect(follow.max).toBe(option.follow.max);
        expect(follow.average).toBeCloseTo(option.follow.average, 9);
        expect(follow.rows.map((r) => [r.tile, r.count, r.discard, r.ukeire])).toEqual(option.follow.rows);
      }
    }
    expect(options).toBeGreaterThanOrEqual(15);
  });

  it('E-23 場面の打牌のうち、2 向聴になるものだけが正解表にあり、1 向聴以下・3 向聴以上の打牌には返さない', () => {
    for (const position of fixture.positions) {
      const game = position.report === FX4_ID ? fx4 : f9da;
      const decision = findDecisionByKey(game, position.key);
      if (!decision) throw new Error(position.key);
      const tiles = [...decision.board.hand, ...(decision.board.drawn === null ? [] : [decision.board.drawn])];
      const twoShanten = discardOptions(tiles)
        .filter((o) => o.shanten === 2)
        .map((o) => o.tile);
      expect(position.options.map((o) => o.discard)).toEqual(twoShanten);
      for (const option of discardOptions(tiles)) {
        const rest = afterDiscard(game, position.key, option.tile);
        const follow = followAfterTwoShanten(rest);
        if (option.shanten === 2) expect(follow).not.toBeNull();
        else expect(follow, `打${option.tile}（${option.shanten}向聴）`).toBeNull();
      }
    }
  });

  it('E-23 作った手で: 引く牌の枚数の合計は、2 向聴の手の受け入れ枚数と同じ。平均は、枚数で重みを付けたもの', () => {
    const tiles = parseTenhouNotation('123456m1357p139s');
    expect(shanten(tiles)).toBe(2);
    const follow = followAfterTwoShanten(tiles);
    expect(follow).not.toBeNull();
    if (!follow) return;
    expect(follow.rows.reduce((sum, r) => sum + r.count, 0)).toBe(follow.total);
    expect(follow.rows.reduce((sum, r) => sum + r.count * r.ukeire, 0) / follow.total).toBeCloseTo(follow.average, 12);
    expect(follow.max).toBe(Math.max(...follow.rows.map((r) => r.ukeire)));
    expect(follow.kinds).toBe(follow.rows.length);
    // 1 向聴と 3 向聴の手には返さない
    expect(followAfterTwoShanten(parseTenhouNotation('123456789m13p57s'))).toBeNull();
    expect(followAfterTwoShanten(parseTenhouNotation('1357m1357p1357s1z'))).toBeNull();
  });
});
