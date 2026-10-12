import { readFileSync, writeFileSync } from 'node:fs';
import path from 'node:path';

import { describe, expect, it } from 'vitest';

import { GRADES, gradeIndexOf } from '../src/grade';
import { MAKA_BASE_RECORDS, type MakaBaseRecord } from '../src/maka-fit-base';
import { loadMakaDataset } from './helpers/csv';
import { FIXTURES_DIR } from './helpers/fixtures';

/** 基礎の記録（src/maka-fit-base.ts）。この試験が書き直す。 */
const BASE_PATH = path.resolve(FIXTURES_DIR, '..', '..', 'src', 'maka-fit-base.ts');

const HEADER = `/**
 * MAKA の評価への当てはめの、基礎の記録（E-13、F10、U-31）。自動生成のファイル。手で直さない。
 *
 * analysis/maka-fit/dataset.csv（5半荘・67局の Mortal の Rating と MAKA の評価）から、使う列だけを写した定数。
 * \`game\` は mjai の結果の ID、\`idx\` は半荘の中の局の順、\`label\` は局の名前（\`kyokuLabel\`）、\`grade\` は MAKA の評価、
 * \`rating\` は局の Rating（0 から 1。点数はこの 100 倍）。
 *
 * dataset.csv を変えたら、環境変数 UPDATE_MAKA_FIT_BASE=1 を付けて tests/maka-fit-base.test.ts だけを動かすと、このファイルを書き直す。
 * 試験は、dataset.csv を読み直した値と、この定数が完全に一致することを確かめる。
 */`;

/** dataset.csv の行から、基礎の記録を作る。 */
function fromCsv(): MakaBaseRecord[] {
  return loadMakaDataset().map((row) => {
    const grade = row.grade ?? '';
    const index = gradeIndexOf(grade);
    if (index === null) throw new Error(`dataset.csv の段階が読めません: ${grade}`);
    return {
      game: row.game ?? '',
      idx: Number(row.idx),
      label: row.label ?? '',
      grade: GRADES[index] as MakaBaseRecord['grade'],
      rating: Number(row.rating),
    };
  });
}

/** 基礎の記録を、src/maka-fit-base.ts の中身にする。数は、読み戻すと同じ値になる最短の書き方。 */
function render(records: readonly MakaBaseRecord[]): string {
  const lines = records.map(
    (r) =>
      `  { game: '${r.game}', idx: ${r.idx}, label: '${r.label}', grade: '${r.grade}', rating: ${r.rating} },`,
  );
  return [
    HEADER,
    "import type { Grade } from './grade';",
    '',
    '/** 基礎の記録 1 局分。 */',
    'export interface MakaBaseRecord {',
    '  /** mjai の結果の ID（半荘）。 */',
    '  game: string;',
    '  /** 半荘の中の局の順（0 から）。 */',
    '  idx: number;',
    '  /** 局の名前。例: 東2局1本場。 */',
    '  label: string;',
    '  /** MAKA の評価。 */',
    '  grade: Grade;',
    '  /** 局の Rating（0 から 1）。 */',
    '  rating: number;',
    '}',
    '',
    'export const MAKA_BASE_RECORDS: readonly MakaBaseRecord[] = [',
    ...lines,
    '];',
    '',
  ].join('\n');
}

describe('U-31 MAKA の当てはめの基礎の記録（dataset.csv から作った定数）', () => {
  const csv = fromCsv();

  if (process.env.UPDATE_MAKA_FIT_BASE === '1') {
    it('書き直し（UPDATE_MAKA_FIT_BASE=1 のときだけ）', () => {
      writeFileSync(BASE_PATH, render(csv), 'utf-8');
    });
    return;
  }

  it('E-13 基礎の記録は、dataset.csv の 67 局と、1 局ずつ完全に一致する（半荘・順・局の名前・段階・Rating）', () => {
    expect(csv).toHaveLength(67);
    expect(MAKA_BASE_RECORDS).toHaveLength(67);
    expect(MAKA_BASE_RECORDS).toEqual(csv);
    MAKA_BASE_RECORDS.forEach((record, i) => expect(record.rating, `${i}`).toBe(csv[i]?.rating));
  });

  it('基礎の記録は 5 半荘で、半荘の中の順は 0 から続く', () => {
    const games = [...new Set(MAKA_BASE_RECORDS.map((r) => r.game))];
    expect(games).toHaveLength(5);
    for (const game of games) {
      const idx = MAKA_BASE_RECORDS.filter((r) => r.game === game).map((r) => r.idx);
      expect(idx).toEqual(idx.map((_, i) => i));
    }
  });

  it('ファイルの中身は、dataset.csv から作った文字列と同じ（手で直していない）', () => {
    expect(readFileSync(BASE_PATH, 'utf-8')).toBe(render(csv));
  });
});
