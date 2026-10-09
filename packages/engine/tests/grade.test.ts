import { describe, expect, it } from 'vitest';

import {
  GRADES,
  type GradeRecord,
  evaluateLeaveOneGameOut,
  fitGradeModel,
  gradeIndexOf,
  gradeLabel,
  predictGrade,
  predictGradeIndex,
  predictGradeValue,
  roundGradeIndex,
  summarizeGradeAgreement,
} from '../src/grade';
import { fitIsotonic, predictIsotonic } from '../src/isotonic';
import { loadMakaDataset } from './helpers/csv';
import { loadFixtureJson } from './helpers/fixtures';

interface Fx13Case {
  name: string;
  x: number[];
  y: number[];
  weights: number[] | null;
  xThresholds: number[];
  yThresholds: number[];
  probes: number[];
  expected: number[];
}

interface Fx13 {
  library: string;
  grades: string[];
  summary: { exact: number; withinOne: number; withinTwo: number; mae: number };
  hands: { game: string; idx: number; label: string; grade: string; y: number; score: number; logo: number; logoGrade: number }[];
  fullFit: { xThresholds: number[]; yThresholds: number[]; probes: number[]; expected: number[] };
  cases: Fx13Case[];
}

const fx = loadFixtureJson<Fx13>('maka-fit-logo.json');

/** dataset.csv（analysis/maka-fit）から、当てはめの記録を作る。点数は Rating の 100 倍。 */
function datasetRecords(): GradeRecord[] {
  return loadMakaDataset().map((r) => ({ game: r.game ?? '', score: Number(r.rating) * 100, grade: r.grade ?? '' }) as GradeRecord);
}

describe('E-13 段階（E を含む14段階）', () => {
  it('E-13 段階は S+, S, S-, A+, A, A-, B+, B, B-, C+, C, C-, D, E の14段階で、E が 0、S+ が 13', () => {
    expect([...GRADES].reverse()).toEqual(['S+', 'S', 'S-', 'A+', 'A', 'A-', 'B+', 'B', 'B-', 'C+', 'C', 'C-', 'D', 'E']);
    expect(GRADES).toHaveLength(14);
    expect(GRADES[0]).toBe('E');
    expect(GRADES[13]).toBe('S+');
    expect(fx.grades).toEqual([...GRADES]);
  });

  it('E-13 段階の名前と添字の変換（大文字小文字は区別しない）', () => {
    expect(gradeIndexOf('S+')).toBe(13);
    expect(gradeIndexOf('s+')).toBe(13);
    expect(gradeIndexOf('c-')).toBe(2);
    expect(gradeIndexOf('E')).toBe(0);
    expect(gradeIndexOf('Z')).toBeNull();
    expect(gradeIndexOf('')).toBeNull();
    expect(gradeLabel(0)).toBe('E');
    expect(gradeLabel(13)).toBe('S+');
    expect(() => gradeLabel(14)).toThrow(RangeError);
    expect(() => gradeLabel(-1)).toThrow(RangeError);
    expect(() => gradeLabel(1.5)).toThrow(RangeError);
  });

  it('E-13 当てはめ値は四捨五入（.5 は切り上げ）して 0 から 13 に収める', () => {
    expect(roundGradeIndex(7.5)).toBe(8);
    expect(roundGradeIndex(7.4999999)).toBe(7);
    expect(roundGradeIndex(2.5)).toBe(3);
    expect(roundGradeIndex(-3)).toBe(0);
    expect(roundGradeIndex(-0.4)).toBe(0);
    expect(roundGradeIndex(13.4)).toBe(13);
    expect(roundGradeIndex(20)).toBe(13);
  });
});

describe('E-13 単調な当てはめ（scikit-learn の IsotonicRegression と同じ）', () => {
  it('E-13 手で作った32通りのデータで、しきい値と予測値が scikit-learn と 1e-9 以内で一致する', () => {
    expect(fx.cases.length).toBeGreaterThanOrEqual(30);
    for (const c of fx.cases) {
      const model = fitIsotonic(c.x, c.y, c.weights ?? undefined);
      expect(model.xThresholds.length, c.name).toBe(c.xThresholds.length);
      model.xThresholds.forEach((v, i) => expect(Math.abs(v - (c.xThresholds[i] ?? NaN)), `${c.name} x[${i}]`).toBeLessThan(1e-9));
      model.yThresholds.forEach((v, i) => expect(Math.abs(v - (c.yThresholds[i] ?? NaN)), `${c.name} y[${i}]`).toBeLessThan(1e-9));
      c.probes.forEach((t, i) => {
        const actual = predictIsotonic(model, t);
        expect(Math.abs(actual - (c.expected[i] ?? NaN)), `${c.name} t=${t}`).toBeLessThan(1e-9);
      });
    }
  });

  it('E-13 同じ点数の点は重みつきで平均する（重み 0 の点は無いものとする）', () => {
    // x=1 に y=2 と y=4（重み 1 と 3）→ 平均 (2 + 12) / 4 = 3.5。x=2 は y=9
    const m = fitIsotonic([1, 1, 2], [2, 4, 9], [1, 3, 1]);
    expect(m.xThresholds).toEqual([1, 2]);
    expect(m.yThresholds[0]).toBeCloseTo(3.5, 12);
    expect(m.yThresholds[1]).toBeCloseTo(9, 12);
    // 重み 0 の点は除く
    const z = fitIsotonic([1, 2, 3], [5, 0, 9], [1, 0, 1]);
    expect(z.xThresholds).toEqual([1, 3]);
  });

  it('E-13 順序が逆転している点は、まとめて平均する（pool adjacent violators）', () => {
    // y が 8, 2, 5 で単調でないので、全部まとめて平均 5
    const m = fitIsotonic([1, 2, 3], [8, 2, 5]);
    expect(m.yThresholds).toEqual([5, 5]);
    expect(predictIsotonic(m, 1.5)).toBeCloseTo(5, 12);
    // 一部だけが逆転: 2, 6, 4, 9 は 6 と 4 がまとまって 5
    const p = fitIsotonic([1, 2, 3, 4], [2, 6, 4, 9]);
    expect(p.xThresholds).toEqual([1, 2, 3, 4]);
    expect(p.yThresholds).toEqual([2, 5, 5, 9]);
  });

  it('E-13 前後と同じ値の点（両端以外）はしきい値から除く', () => {
    const m = fitIsotonic([1, 2, 3, 4, 5], [2, 5, 5, 5, 9]);
    expect(m.xThresholds).toEqual([1, 2, 4, 5]);
    expect(m.yThresholds).toEqual([2, 5, 5, 9]);
  });

  it('E-13 しきい値の間は直線で補間し、範囲の外は端の値に収める（clip）', () => {
    const m = fitIsotonic([10, 20, 30], [0, 6, 12]);
    expect(predictIsotonic(m, 10)).toBe(0);
    expect(predictIsotonic(m, 15)).toBeCloseTo(3, 12);
    expect(predictIsotonic(m, 25)).toBeCloseTo(9, 12);
    expect(predictIsotonic(m, 30)).toBe(12);
    expect(predictIsotonic(m, -100)).toBe(0);
    expect(predictIsotonic(m, 1000)).toBe(12);
  });

  it('E-13 点が1つ（または点数がすべて同じ）なら、どの点数でも同じ値を返す', () => {
    expect(predictIsotonic(fitIsotonic([50], [7]), 0)).toBe(7);
    const same = fitIsotonic([10, 10, 10], [3, 5, 4]);
    expect(predictIsotonic(same, 0)).toBe(4);
    expect(predictIsotonic(same, 99)).toBe(4);
  });

  it('E-13 データが空・長さが違う・重みがすべて 0 のときは RangeError', () => {
    expect(() => fitIsotonic([], [])).toThrow(RangeError);
    expect(() => fitIsotonic([1, 2], [1])).toThrow(RangeError);
    expect(() => fitIsotonic([1], [1], [0])).toThrow(RangeError);
    expect(() => fitGradeModel([])).toThrow(RangeError);
  });

  it('E-13 点数が上がって段階が下がることはない（単調）。dataset.csv の当てはめで、点数を細かく動かして確かめる', () => {
    const model = fitGradeModel(datasetRecords());
    let prevValue = -Infinity;
    let prevGrade = -1;
    for (let score = -20; score <= 120; score += 0.05) {
      const value = predictGradeValue(model, score);
      const grade = predictGradeIndex(model, score);
      expect(value).toBeGreaterThanOrEqual(prevValue);
      expect(grade).toBeGreaterThanOrEqual(prevGrade);
      prevValue = value;
      prevGrade = grade;
    }
  });

  it('E-13 乱数のデータでも、当てはめは単調に増える', () => {
    let seed = 12345;
    const rand = () => {
      seed = (seed * 1664525 + 1013904223) % 4294967296;
      return seed / 4294967296;
    };
    for (let trial = 0; trial < 50; trial++) {
      const n = 2 + Math.floor(rand() * 40);
      const xs = Array.from({ length: n }, () => Math.round(rand() * 200) / 2);
      const ys = Array.from({ length: n }, () => Math.floor(rand() * 14));
      const model = fitIsotonic(xs, ys);
      const thresholds = [...model.yThresholds];
      expect(thresholds).toEqual([...thresholds].sort((a, b) => a - b));
      let prev = -Infinity;
      for (let t = -5; t <= 105; t += 0.37) {
        const v = predictIsotonic(model, t);
        expect(v).toBeGreaterThanOrEqual(prev);
        prev = v;
      }
    }
  });
});

describe('E-13 analysis/maka-fit/dataset.csv（5半荘・67局）での当てはめと、半荘を1つずつ外す検証', () => {
  const records = datasetRecords();

  it('E-13 dataset.csv は67局・5半荘で、評価は14段階の名前', () => {
    expect(records).toHaveLength(67);
    expect(new Set(records.map((r) => r.game)).size).toBe(5);
    for (const r of records) expect(gradeIndexOf(String(r.grade)), String(r.grade)).not.toBeNull();
    expect(fx.hands).toHaveLength(67);
  });

  it('E-13 全体で当てはめたしきい値と予測値が、scikit-learn と 1e-9 以内で一致する', () => {
    const model = fitGradeModel(records);
    const { isotonic } = model;
    expect(isotonic.xThresholds).toHaveLength(fx.fullFit.xThresholds.length);
    isotonic.xThresholds.forEach((v, i) => expect(Math.abs(v - (fx.fullFit.xThresholds[i] ?? NaN))).toBeLessThan(1e-9));
    isotonic.yThresholds.forEach((v, i) => expect(Math.abs(v - (fx.fullFit.yThresholds[i] ?? NaN))).toBeLessThan(1e-9));
    fx.fullFit.probes.forEach((t, i) => {
      expect(Math.abs(predictGradeValue(model, t) - (fx.fullFit.expected[i] ?? NaN)), `t=${t}`).toBeLessThan(1e-9);
    });
  });

  it('E-13 半荘を1つずつ外した予測が、67局すべてで scikit-learn と 1e-9 以内で一致し、段階も同じ', () => {
    const result = evaluateLeaveOneGameOut(records);
    expect(result).not.toBeNull();
    if (!result) return;
    expect(result.predictions).toHaveLength(67);
    fx.hands.forEach((h, i) => {
      const record = records[i];
      expect(record?.game).toBe(h.game);
      expect(record?.score).toBe(h.score);
      expect(Math.abs((result.predictions[i] ?? NaN) - h.logo), `${h.game} ${h.label}`).toBeLessThan(1e-9);
      expect(result.grades[i], `${h.game} ${h.label}`).toBe(h.logoGrade);
    });
  });

  it('E-13 半荘を1つずつ外した予測は、scikit-learn と bit 単位まで同じ（四捨五入の境目で段階が変わらない）', () => {
    const result = evaluateLeaveOneGameOut(records);
    expect(result?.predictions).toEqual(fx.hands.map((h) => h.logo));
  });

  it('E-13 半荘を1つずつ外して検証すると、ぴったり 0.343・±1段階以内 0.657（小数第3位まで）', () => {
    const result = evaluateLeaveOneGameOut(records);
    expect(result).not.toBeNull();
    if (!result) return;
    expect(result.agreement.count).toBe(67);
    expect(result.agreement.exact.toFixed(3)).toBe('0.343');
    expect(result.agreement.withinOne.toFixed(3)).toBe('0.657');
    expect(result.agreement.exact.toFixed(3)).toBe(fx.summary.exact.toFixed(3));
    expect(result.agreement.withinOne.toFixed(3)).toBe(fx.summary.withinOne.toFixed(3));
    expect(result.agreement.withinTwo.toFixed(3)).toBe(fx.summary.withinTwo.toFixed(3));
    expect(result.agreement.meanAbsoluteError.toFixed(2)).toBe(fx.summary.mae.toFixed(2));
    // 34%・66%（分析の README と同じ表記）
    expect(Math.round(result.agreement.exact * 100)).toBe(34);
    expect(Math.round(result.agreement.withinOne * 100)).toBe(66);
  });

  it('E-13 外す半荘の記録だけで当てはめた値は使わない（外した半荘の評価を変えても、その半荘の予測は変わらない）', () => {
    const base = evaluateLeaveOneGameOut(records);
    const changed: GradeRecord[] = records.map((r) => (r.game === records[0]?.game ? { ...r, grade: 'E' as const } : r));
    const after = evaluateLeaveOneGameOut(changed);
    const firstGame = records[0]?.game;
    records.forEach((r, i) => {
      if (r.game === firstGame) expect(after?.predictions[i]).toBe(base?.predictions[i]);
    });
  });
});

describe('E-13 ユーザーが記録を足すたびに当てはめ直せる', () => {
  it('E-13 任意の記録の一覧から当てはめ直せる。記録が増えると予測が変わる', () => {
    const records = datasetRecords();
    const before = fitGradeModel(records);
    const extra: GradeRecord[] = [
      { game: 'new-game', score: 40, grade: 'S+' },
      { game: 'new-game', score: 41, grade: 'S+' },
    ];
    const after = fitGradeModel([...records, ...extra]);
    expect(after.recordCount).toBe(69);
    expect(predictGradeIndex(before, 40)).toBeLessThan(13);
    expect(predictGrade(after, 41)).not.toBe(predictGrade(before, 41));
    // 点数が高いほど下がらない形は保たれる
    let prev = -1;
    for (let s = 0; s <= 100; s += 0.5) {
      const g = predictGradeIndex(after, s);
      expect(g).toBeGreaterThanOrEqual(prev);
      prev = g;
    }
  });

  it('E-13 段階は名前でも添字でも渡せ、知らない名前は RangeError', () => {
    const byName = fitGradeModel([
      { game: 'a', score: 10, grade: 'C' },
      { game: 'a', score: 90, grade: 'S' },
    ]);
    const byIndex = fitGradeModel([
      { game: 'a', score: 10, grade: 3 },
      { game: 'a', score: 90, grade: 12 },
    ]);
    expect(byName.isotonic).toEqual(byIndex.isotonic);
    expect(predictGrade(byName, 90)).toBe('S');
    expect(() => fitGradeModel([{ game: 'a', score: 1, grade: 'X' as never }])).toThrow(RangeError);
    expect(() => fitGradeModel([{ game: 'a', score: 1, grade: 14 }])).toThrow(RangeError);
  });

  it('E-13 半荘が1つしかないときは、半荘を外す検証ができないので null', () => {
    expect(evaluateLeaveOneGameOut([{ game: 'a', score: 1, grade: 'C' }])).toBeNull();
    expect(evaluateLeaveOneGameOut([])).toBeNull();
  });

  it('E-13 予測と評価の一致の度合い: ぴったり・±1・±2・平均のずれ', () => {
    const r = summarizeGradeAgreement([3.2, 5.5, 9, 0, 13], [3, 5, 7, 2, 13]);
    // 丸めると 3, 6, 9, 0, 13。ずれは 0, 1, 2, 2, 0
    expect(r.count).toBe(5);
    expect(r.exact).toBeCloseTo(2 / 5, 12);
    expect(r.withinOne).toBeCloseTo(3 / 5, 12);
    expect(r.withinTwo).toBeCloseTo(1, 12);
    expect(r.meanAbsoluteError).toBeCloseTo(1, 12);
    expect(() => summarizeGradeAgreement([1], [1, 2])).toThrow(RangeError);
  });
});
