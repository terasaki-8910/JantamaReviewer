import { readFileSync } from 'node:fs';
import path from 'node:path';

import type { GradeRecord } from '../../src/grade';
import { REPO_ROOT } from './fixtures';

/** カンマ区切りで、引用符を使わない CSV（analysis/maka-fit/dataset.csv）を、列名をキーにした行にする。 */
export function parseSimpleCsv(text: string): Record<string, string>[] {
  const lines = text.split(/\r?\n/).filter((l) => l.length > 0);
  const header = (lines[0] ?? '').split(',');
  return lines.slice(1).map((line) => {
    const cells = line.split(',');
    return Object.fromEntries(header.map((name, i) => [name, cells[i] ?? '']));
  });
}

/** analysis/maka-fit/dataset.csv（5半荘・67局の Mortal の特徴量と MAKA の評価）。 */
export function loadMakaDataset(): Record<string, string>[] {
  return parseSimpleCsv(readFileSync(path.join(REPO_ROOT, 'analysis', 'maka-fit', 'dataset.csv'), 'utf-8'));
}

/** dataset.csv から、段階の当てはめの記録（半荘・点数・MAKA の評価）を作る。点数は Rating の 100 倍。 */
export function loadMakaGradeRecords(): GradeRecord[] {
  return loadMakaDataset().map((r) => ({ game: r.game ?? '', score: Number(r.rating) * 100, grade: r.grade ?? '' }) as GradeRecord);
}
