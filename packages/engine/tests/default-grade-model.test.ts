import { readFileSync, writeFileSync } from 'node:fs';
import path from 'node:path';

import { describe, expect, it } from 'vitest';

import { DEFAULT_GRADE_MODEL } from '../src/default-grade-model';
import { type GradeModel, evaluateLeaveOneGameOut, fitGradeModel, predictGrade, predictGradeIndex, predictGradeValue } from '../src/grade';
import { loadMakaGradeRecords } from './helpers/csv';
import { FIXTURES_DIR } from './helpers/fixtures';

/** 既定の段階の当てはめ（src/default-grade-model.ts）。この試験が書き直す。 */
const MODEL_PATH = path.resolve(FIXTURES_DIR, '..', '..', 'src', 'default-grade-model.ts');

const HEADER = `/**
 * 既定の段階の当てはめ（点数 → 段階。E-13、F10）。自動生成のファイル。手で直さない。
 *
 * analysis/maka-fit/dataset.csv（5半荘・67局の Mortal の Rating と MAKA の評価）を、\`fitGradeModel\` で当てはめた結果。
 * 点数は Rating の 100 倍。MAKA の評価が入力されるまでの、局ごとと半荘全体の段階に使う。
 *
 * dataset.csv か当てはめの手順を変えたら、環境変数 UPDATE_DEFAULT_GRADE_MODEL=1 を付けて
 * tests/default-grade-model.test.ts だけを動かすと、このファイルを書き直す。
 * 試験は、dataset.csv を当てはめ直した結果と、この値が完全に一致することを確かめる。
 */`;

/** 当てはめた結果を、src/default-grade-model.ts の中身にする。数は、読み戻すと同じ値になる最短の書き方。 */
function render(model: GradeModel): string {
  const list = (xs: readonly number[]): string => xs.map((x) => `      ${x},`).join('\n');
  return [
    HEADER,
    "import type { GradeModel } from './grade';",
    '',
    'export const DEFAULT_GRADE_MODEL: GradeModel = {',
    '  isotonic: {',
    '    xThresholds: [',
    list(model.isotonic.xThresholds),
    '    ],',
    '    yThresholds: [',
    list(model.isotonic.yThresholds),
    '    ],',
    `    xMin: ${model.isotonic.xMin},`,
    `    xMax: ${model.isotonic.xMax},`,
    '  },',
    `  recordCount: ${model.recordCount},`,
    '};',
    '',
  ].join('\n');
}

describe('E-13 既定の段階の当てはめ（dataset.csv から作った定数）', () => {
  const records = loadMakaGradeRecords();
  const refit = fitGradeModel(records);

  if (process.env.UPDATE_DEFAULT_GRADE_MODEL === '1') {
    it('書き直し（UPDATE_DEFAULT_GRADE_MODEL=1 のときだけ）', () => {
      writeFileSync(MODEL_PATH, render(refit), 'utf-8');
    });
    return;
  }

  it('E-13 既定の当てはめは、dataset.csv（67局）を fitGradeModel で当てはめ直した結果と、完全に一致する', () => {
    expect(records).toHaveLength(67);
    expect(DEFAULT_GRADE_MODEL.recordCount).toBe(67);
    expect(DEFAULT_GRADE_MODEL).toEqual(refit);
    // 値が 1 つも違わない（浮動小数点の最後の桁まで）
    expect(DEFAULT_GRADE_MODEL.isotonic.xThresholds).toEqual(refit.isotonic.xThresholds);
    expect(DEFAULT_GRADE_MODEL.isotonic.yThresholds).toEqual(refit.isotonic.yThresholds);
    expect(DEFAULT_GRADE_MODEL.isotonic.xMin).toBe(refit.isotonic.xMin);
    expect(DEFAULT_GRADE_MODEL.isotonic.xMax).toBe(refit.isotonic.xMax);
  });

  it('E-13 ファイルの中身は、当てはめ直した結果から作った文字列と同じ（手で直していない）', () => {
    expect(readFileSync(MODEL_PATH, 'utf-8')).toBe(render(refit));
  });

  it('E-13 既定の当てはめで、点数が上がって段階が下がることはない', () => {
    let prevValue = -Infinity;
    let prevGrade = -1;
    for (let score = -20; score <= 120; score += 0.05) {
      const value = predictGradeValue(DEFAULT_GRADE_MODEL, score);
      const grade = predictGradeIndex(DEFAULT_GRADE_MODEL, score);
      expect(value).toBeGreaterThanOrEqual(prevValue);
      expect(grade).toBeGreaterThanOrEqual(prevGrade);
      prevValue = value;
      prevGrade = grade;
    }
  });

  it('E-13 既定の当てはめは、14段階の両端まで届く（最低の点数は低い段階、最高の点数は高い段階）', () => {
    expect(predictGradeIndex(DEFAULT_GRADE_MODEL, 0)).toBeLessThanOrEqual(2);
    expect(predictGradeIndex(DEFAULT_GRADE_MODEL, 100)).toBeGreaterThanOrEqual(12);
    expect(predictGrade(DEFAULT_GRADE_MODEL, 100)).toMatch(/^S/);
  });

  it('E-13 半荘を1つずつ外した検証の値（ぴったり 34%・±1段階以内 66%）は、この当てはめと同じ手順での値', () => {
    const loo = evaluateLeaveOneGameOut(records);
    expect(Math.round((loo?.agreement.exact ?? NaN) * 100)).toBe(34);
    expect(Math.round((loo?.agreement.withinOne ?? NaN) * 100)).toBe(66);
  });
});
