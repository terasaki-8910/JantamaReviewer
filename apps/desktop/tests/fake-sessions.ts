/**
 * 半荘の一覧・削除・元に戻す・結果の読み出しに答える、Tauri の偽物（試験の道具）。
 * Rust 側と同じ決まり: 消した半荘は一覧に出ず（`list_sessions`）、元に戻すと元の位置（新しい順）に出る。
 * 試験のデータで、画面の部品ではない。
 */
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';

import type { SessionRecord } from '../src/api/types';

const REPORTS_DIR = resolve(import.meta.dirname, '../../../packages/engine/tests/fixtures/reports');

/** エンジンの試験の固定データ（FX-1 の 5 半荘と FX-4）の、結果の JSON の文字。 */
export const REPORT_TEXTS = {
  fx4: readFileSync(resolve(REPORTS_DIR, '5b821c8a048ff791.json'), 'utf8'),
  fx1a: readFileSync(resolve(REPORTS_DIR, 'f9da87cbcd7af5e9.json'), 'utf8'),
  fx1b: readFileSync(resolve(REPORTS_DIR, 'f738896995c33fed.json'), 'utf8'),
  fx1c: readFileSync(resolve(REPORTS_DIR, 'be0a2a523fdd7758.json'), 'utf8'),
  fx1d: readFileSync(resolve(REPORTS_DIR, '002ca97adccc486d.json'), 'utf8'),
  fx1e: readFileSync(resolve(REPORTS_DIR, '3a36dac7c7fc18ce.json'), 'utf8'),
} as const;

export type ReportKey = keyof typeof REPORT_TEXTS;

export const local = (y: number, mo: number, d: number, h = 0, mi = 0, s = 0) =>
  new Date(y, mo - 1, d, h, mi, s).getTime();

/** 半荘のフォルダの名前（ローカル時刻の YYYYMMDD-HHMMSS）。 */
export function folderName(startedMs: number): string {
  const d = new Date(startedMs);
  const p = (n: number, w = 2) => String(n).padStart(w, '0');
  return `${d.getFullYear()}${p(d.getMonth() + 1)}${p(d.getDate())}-${p(d.getHours())}${p(d.getMinutes())}${p(d.getSeconds())}`;
}

interface SeedOptions {
  /** 迷いマークの数（画像は付けない）。 */
  marks?: number;
  ratings?: number;
  /** 取り込んだ結果（上の固定データの名前）。無ければ、取り込み前。 */
  report?: ReportKey;
  id?: string;
}

/** 試験用の半荘 1 つ。 */
export function seedSession(startedMs: number, options: SeedOptions = {}): { session: SessionRecord; report?: ReportKey } {
  const id = options.id ?? folderName(startedMs);
  const marks = Array.from({ length: options.marks ?? 0 }, (_, i) => ({
    id: i + 1,
    t_ms: startedMs + (i + 1) * 60_000,
    screenshot: null,
    capture: null,
    capture_error: '試験の画像なし',
    screenshot_path: null,
  }));
  const ratings = Array.from({ length: options.ratings ?? 0 }, (_, i) => ({
    id: 100 + i,
    t_ms: startedMs + (i + 1) * 120_000,
    rating: 'good' as const,
    hand: i + 1,
  }));
  const session: SessionRecord = {
    id,
    started_ms: startedMs,
    mark_count: marks.length,
    rating_count: ratings.length,
    marks,
    ratings,
    events: [],
    report_path: options.report ? `C:\\data\\games\\${id}\\report.json` : null,
    ocr: null,
    links: { marks: {}, ratings: {} },
  };
  return options.report ? { session, report: options.report } : { session };
}

/**
 * 保存先の偽物。`handlers` を `installTauriMock({ handlers })` に渡す。
 * `list_sessions` は、消していない半荘を新しい順に返す。`delete_sessions` で置き場へ移し、`restore_sessions` で戻す。
 */
export class FakeSessionStore {
  private active: SessionRecord[];
  private trash: SessionRecord[] = [];
  private readonly reports = new Map<string, string>();
  /** 呼ばれた順の記録（'delete:a,b'・'restore:a'）。 */
  readonly log: string[] = [];
  /** 次の削除・元に戻すを失敗させたいときの理由。 */
  failNextDelete: string | null = null;
  failNextRestore: string | null = null;

  constructor(seeds: Array<{ session: SessionRecord; report?: ReportKey }>) {
    this.active = seeds.map((s) => s.session);
    for (const seed of seeds) {
      if (seed.report) this.reports.set(seed.session.id, REPORT_TEXTS[seed.report]);
    }
  }

  get ids(): string[] {
    return this.sorted().map((s) => s.id);
  }

  get trashedIds(): string[] {
    return this.trash.map((s) => s.id);
  }

  private sorted(): SessionRecord[] {
    return [...this.active].sort((a, b) => b.started_ms - a.started_ms || (a.id < b.id ? 1 : -1));
  }

  add(seed: { session: SessionRecord; report?: ReportKey }): void {
    this.active.push(seed.session);
    if (seed.report) this.reports.set(seed.session.id, REPORT_TEXTS[seed.report]);
  }

  readonly handlers: Record<string, (args: unknown) => unknown> = {
    list_sessions: () => this.sorted(),
    read_report: (args) => this.reports.get((args as { sessionId: string }).sessionId) ?? null,
    delete_sessions: (args) => {
      const ids = (args as { ids: string[] }).ids;
      this.log.push(`delete:${ids.join(',')}`);
      if (this.failNextDelete !== null) {
        const reason = this.failNextDelete;
        this.failNextDelete = null;
        throw reason;
      }
      for (const id of ids) {
        const found = this.active.find((s) => s.id === id);
        if (!found) throw `半荘が見つかりません: ${id}`;
      }
      for (const id of ids) {
        const found = this.active.find((s) => s.id === id) as SessionRecord;
        this.active = this.active.filter((s) => s.id !== id);
        this.trash.push(found);
      }
      return undefined;
    },
    restore_sessions: (args) => {
      const ids = (args as { ids: string[] }).ids;
      this.log.push(`restore:${ids.join(',')}`);
      if (this.failNextRestore !== null) {
        const reason = this.failNextRestore;
        this.failNextRestore = null;
        throw reason;
      }
      for (const id of ids) {
        const found = this.trash.find((s) => s.id === id);
        if (!found) throw `消した半荘の中に見つからないため、戻せません: ${id}`;
        this.trash = this.trash.filter((s) => s.id !== id);
        this.active.push(found);
      }
      return undefined;
    },
  };
}
