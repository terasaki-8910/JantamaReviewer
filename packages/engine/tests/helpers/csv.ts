import { readFileSync } from 'node:fs';
import path from 'node:path';

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
