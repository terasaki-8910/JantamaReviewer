import { readFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

/** packages/engine/tests/fixtures の絶対パス。 */
export const FIXTURES_DIR = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', 'fixtures');

/** リポジトリのルート（analysis/ などを読むため）。 */
export const REPO_ROOT = path.resolve(FIXTURES_DIR, '..', '..', '..', '..');

/** FX-1: mjai.ekyu.moe の結果 JSON 5半荘。先頭が 10 月 9 日の半荘。 */
export const FX1_IDS = [
  'f9da87cbcd7af5e9',
  'f738896995c33fed',
  'be0a2a523fdd7758',
  '002ca97adccc486d',
  '3a36dac7c7fc18ce',
] as const;

/** FX-1 の判断の数（review.total_reviewed）。E-1 の期待値。 */
export const FX1_DECISION_COUNTS: Record<(typeof FX1_IDS)[number], number> = {
  f9da87cbcd7af5e9: 178,
  f738896995c33fed: 197,
  be0a2a523fdd7758: 156,
  '002ca97adccc486d': 231,
  '3a36dac7c7fc18ce': 202,
};

export function reportPath(id: string): string {
  return path.join(FIXTURES_DIR, 'reports', `${id}.json`);
}

export function loadReportText(id: string): string {
  return readFileSync(reportPath(id), 'utf-8');
}

export function loadReportJson(id: string): unknown {
  return JSON.parse(loadReportText(id));
}

export function loadFixtureJson<T = unknown>(name: string): T {
  return JSON.parse(readFileSync(path.join(FIXTURES_DIR, name), 'utf-8')) as T;
}

/**
 * 壊れた入力を作るテストで、結果 JSON の任意の場所を書き換えるための型。
 * 型を付けると書き換えの記述が膨らむだけなので、ここだけ any にする。
 */
// eslint-disable-next-line @typescript-eslint/no-explicit-any -- 外から来る JSON の任意の場所を書き換えるため
export type LooseJson = any;

/** 結果 JSON を、書き換えてよい複製として読み込む。 */
export function loadMutableReport(id: string = FX1_IDS[0]): LooseJson {
  return structuredClone(loadReportJson(id));
}
