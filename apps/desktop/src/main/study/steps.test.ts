import { findDecisionByKey, type Decision } from '@jantama/engine';
import { describe, expect, it } from 'vitest';

import { gameOf } from '../../../tests/fake-study';
import { TURNS_BEFORE, replaySteps, tableExtent } from './steps';

const fx4 = gameOf('fx4');
const fx1e = gameOf('fx1e');

function decisionOf(game: typeof fx4, key: string): Decision {
  const decision = findDecisionByKey(game, key);
  if (decision === undefined) throw new Error(`判断が無い: ${key}`);
  return decision;
}

describe('F3 出題の画面の 2〜3 巡前からの再生', () => {
  it('3 巡前から、本人の巡目が替わった最初の盤面を 1 つずつ。最後は判断の盤面（判断より先は見せない）', () => {
    expect(TURNS_BEFORE).toBe(3);
    const decision = decisionOf(fx4, 'k1h1e9'); // 東2局1本場 8巡目
    expect(decision.junme).toBe(8);
    const steps = replaySteps(fx4, decision);
    expect(steps.map((step) => step.junme)).toEqual([5, 6, 7, 8]);
    expect(steps[steps.length - 1]).toBe(decision.board);
    // どの盤面も、判断の盤面より進んでいない（河の枚数・残りの牌）
    for (const step of steps) {
      step.rivers.forEach((river, seat) => {
        expect(river.length).toBeLessThanOrEqual(decision.board.rivers[seat]?.length ?? 0);
      });
      expect(step.tilesLeft).toBeGreaterThanOrEqual(decision.board.tilesLeft);
    }
    // 前の盤面ほど、河の牌が少ない
    const sizes = steps.map((step) => step.rivers.reduce((sum, river) => sum + river.length, 0));
    expect([...sizes].sort((a, b) => a - b)).toEqual(sizes);
  });

  it('巡目が少なくて遡れないときは、あるところから（1 巡目の判断は、判断の盤面だけ）', () => {
    const first = decisionOf(fx1e, 'k1h1e0'); // 東2局1本場 1巡目
    expect(replaySteps(fx1e, first)).toEqual([first.board]);
    const third = decisionOf(fx1e, 'k1h1e4'); // 東2局1本場 3巡目
    expect(replaySteps(fx1e, third).map((step) => step.junme)).toEqual([1, 2, 3]);
  });

  it('戻る巡目の数を替えられる（0 なら判断の盤面だけ）', () => {
    const decision = decisionOf(fx4, 'k1h1e9');
    expect(replaySteps(fx4, decision, 1).map((step) => step.junme)).toEqual([7, 8]);
    expect(replaySteps(fx4, decision, 0)).toEqual([decision.board]);
  });
});

describe('盤面の大きさをそろえる（巡目を行き来しても、卓が動かない）', () => {
  it('河の段の数は、いちばん長い河を 6 枚で折り返した数（最低 2 段）。リーチ宣言牌があるか', () => {
    const decision = decisionOf(fx4, 'k1h1e9');
    const steps = replaySteps(fx4, decision);
    const extent = tableExtent(steps);
    const longest = Math.max(...steps.flatMap((step) => step.rivers.map((river) => river.length)));
    expect(extent.rows).toBe(Math.max(2, Math.ceil(longest / 6)));
    expect(extent.riichiAny).toBe(steps.some((step) => step.rivers.some((river) => river.some((tile) => tile.riichi))));
  });

  it('河が短い盤面だけなら、2 段。リーチが無ければ false', () => {
    const first = decisionOf(fx1e, 'k1h1e0');
    expect(tableExtent([first.board])).toEqual({ rows: 2, riichiAny: false });
  });
});
