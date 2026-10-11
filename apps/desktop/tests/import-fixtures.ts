/**
 * 取り込みの試験に使う固定データ（FX-4）と、半荘の見本の作り方。
 *
 * FX-4: 10 月 9 日にウィジェットで記録した 5 局の半荘（結果 5b821c8a048ff791。玉の間・南喰赤。判断 70）と、
 * その迷いマーク 6 枚の画面中央の文字認識の写し。ファイルは、エンジンの試験の固定データ（packages/engine/tests/fixtures）をそのまま読む。
 * 試験のデータで、画面の部品ではない（Node 側で動く試験からだけ読む）。
 */
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';

import type { OcrCache, SessionRecord } from '../src/api/types';

// jsdom の環境では `import.meta.url` が http の URL になるので、ファイルの場所は dirname から求める。
const FIXTURES = resolve(import.meta.dirname, '../../../packages/engine/tests/fixtures');

export const FX4_ID = '5b821c8a048ff791';
export const FX4_TEXT = readFileSync(resolve(FIXTURES, 'reports', `${FX4_ID}.json`), 'utf8');

export interface Fx4OcrMark {
  mark: number;
  /** 押した時刻（ローカル時刻）。 */
  time: string;
  lines: string[];
  /** 1 回目で読めなかったときの読み直し（迷い 6 だけ。E-20）。 */
  retries?: Array<{ variant: string; lines: string[] }>;
}

export const FX4_OCR: Fx4OcrMark[] = (
  JSON.parse(readFileSync(resolve(FIXTURES, 'fx4-ocr.json'), 'utf8')) as { marks: Fx4OcrMark[] }
).marks;

/** 切り出しの決まりの名前（Rust 側の `jantama_ocr::GEOMETRY_ID`）。 */
export const OCR_GEOMETRY = 'center-v3-cyan-tight';

/** FX-4 の迷いマーク 6 枚（id は 1〜6）と、評価 5 件（id は 7〜11。スクショは読み取れていない）を持つ半荘。 */
export function fx4Session(
  id: string,
  startedMs: number,
  overrides: Partial<SessionRecord> = {},
): SessionRecord {
  const marks = FX4_OCR.map((m, i) => ({
    id: i + 1,
    t_ms: new Date(m.time).getTime(),
    screenshot: `marks/m${i + 1}.png`,
    capture: 'window' as const,
    capture_error: null,
    screenshot_path: `C:\\data\\games\\${id}\\marks\\m${i + 1}.png`,
  }));
  const ratings = (['good', 'fair', 'good', 'bad', 'fair'] as const).map((rating, i) => ({
    id: 7 + i,
    t_ms: new Date(2026, 9, 9, 19, 12 + i * 3).getTime(),
    rating,
    hand: i + 1,
    screenshot: `ratings/r${i + 1}.png`,
    screenshot_path: `C:\\data\\games\\${id}\\ratings\\r${i + 1}.png`,
  }));
  return {
    id,
    started_ms: startedMs,
    mark_count: marks.length,
    rating_count: ratings.length,
    marks,
    ratings,
    events: [],
    report_path: null,
    ocr: null,
    links: { marks: {}, ratings: {} },
    self_ratings: { kyokus: {} },
    maka: { kyokus: {} },
    ...overrides,
  };
}

/**
 * FX-4 の迷いマークの画像の読み取りの写し（評価の画像は、読み取れなかった）。
 * 既定は 1 回目の読み取りだけ（迷い 6 は読めない）。`retries: true` なら、1 回目で読めなかった迷い 6 の読み直しの行も入る（E-20。
 * 迷い 6 は、東3局・残り38枚・4400点と読める）。
 */
export function fx4Ocr(options: { retries?: boolean } = {}): OcrCache {
  return {
    geometry: OCR_GEOMETRY,
    entries: Object.fromEntries(
      FX4_OCR.map((m, i) => {
        const retries = options.retries === true && m.retries !== undefined ? { retries: m.retries } : {};
        return [`marks/m${i + 1}.png`, { lines: m.lines, ...retries }] as const;
      }),
    ),
  };
}

/** 雀魂からコピーしたままの牌譜リンク（アカウントの番号は、試験用の偽の値）。 */
export const COPIED_LINK =
  '雀魂牌譜:https://game.mahjongsoul.com/?paipu=261009-7c1e9b2a-4f3d-4e11-8a55-0123456789ab_a12345';

/** 上のリンクの、牌譜の ID（アカウントの番号を含まない）。 */
export const COPIED_PAIPU_ID = '261009-7c1e9b2a-4f3d-4e11-8a55-0123456789ab';

/** 取り込みの流れを通す Tauri の偽物の答え（半荘の一覧・文字認識・保存）。 */
export function importHandlers(sessions: SessionRecord[], extra: Record<string, (args: unknown) => unknown> = {}) {
  return {
    read_clipboard_text: () => COPIED_LINK,
    list_sessions: () => sessions,
    fetch_report: () => FX4_TEXT,
    read_report_file_text: () => FX4_TEXT,
    report_id_from_text: (args: unknown) =>
      /[0-9a-f]{16}/.exec((args as { text: string }).text)?.[0] ?? null,
    ocr_sessions: (args: unknown) =>
      (args as { sessionIds: string[] }).sessionIds.map((id) => ({ session_id: id, ocr: fx4Ocr() })),
    save_report: (args: unknown) => (args as { sessionId: string | null }).sessionId ?? '20261010-120000',
    replace_links: () => undefined,
    open_mjai_window: () => undefined,
    close_mjai_window: () => undefined,
    ...extra,
  };
}
