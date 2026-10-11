/**
 * 取り込みの試験に使う固定データ（FX-4・FX-5）と、半荘の見本の作り方。
 *
 * FX-4: 10 月 9 日にウィジェットで記録した 5 局の半荘（結果 5b821c8a048ff791。玉の間・南喰赤。判断 70）と、
 * その迷いマーク 6 枚の画面中央の文字認識の写し、ウィジェットの記録（迷い 6・評価 5 の押した時刻と評価の値）。
 * FX-5: 10 月 11 日 15:35 の 10 局の半荘（迷い 13・評価 9。判断 125）と、迷いと評価の文字認識の写し、ウィジェットの記録。
 * ファイルは、エンジンの試験の固定データ（packages/engine/tests/fixtures）をそのまま読む。
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
export const OCR_GEOMETRY = 'center-v2-lanczos3x-variants';

/** ウィジェットの記録 1 件（fx4-widget.json・fx5-widget.json）。`time` は押した時刻（ローカル時刻）。 */
interface WidgetEventFixture {
  id: number;
  type: 'mark' | 'rating';
  time: string;
  rating?: 'good' | 'fair' | 'bad';
  screenshot?: string;
}

const readJson = <T>(name: string): T => JSON.parse(readFileSync(resolve(FIXTURES, name), 'utf8')) as T;

/** FX-4 の評価 5 件（押した順）。評価の番号は 7〜11（迷いの 1〜6 に続く）、押した時刻と値は本物の記録のとおり。 */
const FX4_RATINGS = readJson<{ events: WidgetEventFixture[] }>('fx4-widget.json').events.filter((e) => e.type === 'rating');

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
  const ratings = FX4_RATINGS.map((event, i) => ({
    id: 7 + i,
    t_ms: new Date(event.time).getTime(),
    rating: event.rating ?? ('fair' as const),
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

// ---- FX-5（10 月 11 日の半荘）----

export const FX5_ID = '20261011-153540';
export const FX5_TEXT = readFileSync(resolve(FIXTURES, 'reports', `${FX5_ID}.json`), 'utf8');

const FX5_EVENTS = readJson<{ events: WidgetEventFixture[] }>('fx5-widget.json').events;
const FX5_OCR = readJson<{ geometry: string; entries: Record<string, { lines: string[]; retries?: Array<{ variant: string; lines: string[] }> }> }>(
  'fx5-ocr.json',
);

/** FX-5 の半荘の最初の記録の時刻（半荘の名前 20261011-153540 と同じ）。 */
export const FX5_STARTED = new Date(2026, 9, 11, 15, 35, 40).getTime();

/**
 * ユーザーが本物のアプリで選んだ、FX-5 の迷い 7 つの結びつけ（迷いの id → 判断の鍵。ACCEPTANCE の FX-5）。
 * 15:37:02 東2局5巡目の打6s、15:38:10 東2局8巡目の打9m、15:40:03 東3局1本場2巡目の打1m、15:42:37 東4局5巡目の打2s、
 * 15:42:52 東4局6巡目の打4p、15:50:36 南1局2本場3巡目の打1s、16:03:19 南4局6巡目のリーチ（打2p）。
 */
export const FX5_USER_CHOICES: Readonly<Record<string, string>> = {
  '2': 'k1h0e5',
  '4': 'k1h0e8',
  '6': 'k2h1e1',
  '8': 'k3h0e4',
  '9': 'k3h0e6',
  '13': 'k4h2e2',
  '21': 'k7h0e6',
};

/** FX-5 の迷い 13 と評価 9（id は半荘の記録のとおり 1〜22）を持つ半荘。画像のファイル名は本物と同じ（画像は無い）。 */
export function fx5Session(id: string = FX5_ID, startedMs: number = FX5_STARTED, overrides: Partial<SessionRecord> = {}): SessionRecord {
  const pathOf = (relative: string) => `C:\\data\\games\\${id}\\${relative.replace('/', '\\')}`;
  const marks = FX5_EVENTS.filter((e) => e.type === 'mark').map((e) => ({
    id: e.id,
    t_ms: new Date(e.time).getTime(),
    screenshot: e.screenshot ?? null,
    capture: 'window' as const,
    capture_error: null,
    screenshot_path: e.screenshot ? pathOf(e.screenshot) : null,
  }));
  const ratings = FX5_EVENTS.filter((e) => e.type === 'rating').map((e, i) => ({
    id: e.id,
    t_ms: new Date(e.time).getTime(),
    rating: e.rating ?? ('fair' as const),
    hand: i + 1,
    screenshot: e.screenshot ?? null,
    screenshot_path: e.screenshot ? pathOf(e.screenshot) : null,
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

/** FX-5 の迷いと評価の画像の、読み取りの写し（1 回目と読み直し 2 つの行）。 */
export function fx5Ocr(): OcrCache {
  return {
    geometry: FX5_OCR.geometry,
    entries: Object.fromEntries(
      Object.entries(FX5_OCR.entries).map(([name, entry]) => [
        name,
        { lines: entry.lines, ...(entry.retries === undefined ? {} : { retries: entry.retries }) },
      ]),
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
