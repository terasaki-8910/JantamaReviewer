import { describe, expect, it } from 'vitest';

import { layoutPins, stepAtPoint } from './stripLayout';

describe('U-21 位置の帯の印の置き方', () => {
  it('U-21 離れている印は、手の位置のまま置く', () => {
    expect(layoutPins([0.25, 0.5, 0.75], 400)).toEqual([100, 200, 300]);
  });

  it('U-21 近すぎる印は、押せる大きさ（24px）が重ならないよう、右へずらす', () => {
    const xs = layoutPins([0.5, 0.505, 0.51], 400);
    expect(xs[0]).toBe(200);
    expect(xs[1]! - xs[0]!).toBeGreaterThanOrEqual(24);
    expect(xs[2]! - xs[1]!).toBeGreaterThanOrEqual(24);
  });

  it('U-21 右の端からはみ出すときは、左へ詰める。どの印も、帯の中（端から半分の大きさ）に収まる', () => {
    const xs = layoutPins([0.97, 0.98, 1], 400);
    expect(xs.at(-1)).toBeLessThanOrEqual(400 - 12);
    for (let i = 1; i < xs.length; i++) expect(xs[i]! - xs[i - 1]!).toBeGreaterThanOrEqual(24);
    // 左の端
    const left = layoutPins([0, 0.001], 400);
    expect(left[0]).toBe(12);
    expect(left[1]! - left[0]!).toBeGreaterThanOrEqual(24);
  });

  it('U-21 並びきらないほど多いときは、等間隔に広げて、並びの順は変えない', () => {
    const ratios = Array.from({ length: 30 }, (_, i) => i / 100);
    const xs = layoutPins(ratios, 300);
    expect(xs).toHaveLength(30);
    expect([...xs].sort((a, b) => a - b)).toEqual(xs);
    expect(xs[0]).toBeGreaterThanOrEqual(12);
    expect(xs.at(-1)).toBeLessThanOrEqual(300 - 12 + 1e-9);
  });

  it('U-21 印が無い・幅が 0 のときは壊れない', () => {
    expect(layoutPins([], 400)).toEqual([]);
    expect(layoutPins([0.5, 0.6], 0)).toEqual([12, 12]);
  });

  it('U-21 帯を押した位置を、手の通し番号にする（両端に丸める）', () => {
    expect(stepAtPoint(100, 100, 400, 289)).toBe(0);
    expect(stepAtPoint(500, 100, 400, 289)).toBe(288);
    expect(stepAtPoint(300, 100, 400, 289)).toBe(144);
    expect(stepAtPoint(0, 100, 400, 289)).toBe(0);
    expect(stepAtPoint(900, 100, 400, 289)).toBe(288);
    expect(stepAtPoint(10, 0, 0, 289)).toBe(0);
  });
});
