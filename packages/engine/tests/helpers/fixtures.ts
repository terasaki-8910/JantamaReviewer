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

/** FX-4: 10月9日にウィジェットで記録した5局の半荘の結果 JSON（迷いマーク6・評価5）。玉の間・南喰赤。 */
export const FX4_ID = '5b821c8a048ff791';

/** FX-4 の迷いマーク 1 枚分の、画面中央の文字認識の結果の写し（fixtures/fx4-ocr.json）。 */
export interface Fx4OcrMark {
  /** 迷いマークの番号（1 から。押した順）。 */
  mark: number;
  /** 押した時刻（ローカル時刻。例: 2026-10-09T19:09:53.812）。 */
  time: string;
  /** 認識した行を ` | ` で区切った文字列。 */
  text: string;
  /** text を ` | ` で分けた行。 */
  lines: string[];
  /** 1 回目で読めなかったときの、読み直し（コントラストを上げた画像・1.5 倍に広げた画像）の結果。迷い 6 だけにある（E-20）。 */
  retries?: Array<{ variant: string; text: string; lines: string[] }>;
}

/**
 * FX-5: 10月11日 15:35 にウィジェットで記録した10局の半荘の結果 JSON（迷い13・評価9）。玉の間・南喰赤。
 * ID は、半荘のフォルダの名前（結果の ID は、保存先に残っていない）。
 */
export const FX5_ID = '20261011-153540';

/** ウィジェットの記録 1 件（fixtures/fx4-widget.json・fx5-widget.json）。押した時刻は、ローカル時刻の文字列（ミリ秒まで）。 */
export interface WidgetEventFixture {
  /** 半荘の中の通し番号（半荘の始まりが 0。取り消しは無い）。 */
  id: number;
  type: 'mark' | 'rating';
  /** 押した時刻（ローカル時刻。例: 2026-10-11T15:37:02.516）。 */
  time: string;
  /** 評価の値（good = 〇、fair = △、bad = ✕）。評価だけ。 */
  rating?: 'good' | 'fair' | 'bad';
  /** 画像のファイル名（半荘のフォルダからの相対パス。画像そのものは入れない）。FX-5 だけ。 */
  screenshot?: string;
  /** FX-4 の迷いの番号（fx4-ocr.json の `mark`）。FX-4 の迷いだけ。 */
  mark?: number;
}

/** 文字認識の結果の写し 1 枚分（fx5-ocr.json。アプリの ocr.json と同じ形）。 */
export interface OcrShotFixture {
  lines: string[];
  retries?: Array<{ variant: string; lines: string[] }>;
}

/** FX-4 のウィジェットの記録（10月9日。迷い6・評価5。押した順）。 */
export function loadFx4Widget(): WidgetEventFixture[] {
  return loadFixtureJson<{ events: WidgetEventFixture[] }>('fx4-widget.json').events;
}

/** FX-5 のウィジェットの記録（10月11日。迷い13・評価9。押した順）。 */
export function loadFx5Widget(): WidgetEventFixture[] {
  return loadFixtureJson<{ events: WidgetEventFixture[] }>('fx5-widget.json').events;
}

/** FX-5 の迷いと評価の画像の、文字認識の結果の写し。キーは画像のファイル名（半荘のフォルダからの相対パス）。 */
export function loadFx5Ocr(): { geometry: string; entries: Record<string, OcrShotFixture> } {
  return loadFixtureJson<{ geometry: string; entries: Record<string, OcrShotFixture> }>('fx5-ocr.json');
}

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

/** FX-4 の迷いマーク6枚の文字認識の結果（押した順）。 */
export function loadFx4Ocr(): Fx4OcrMark[] {
  return loadFixtureJson<{ marks: Fx4OcrMark[] }>('fx4-ocr.json').marks;
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
