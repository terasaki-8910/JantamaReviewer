/**
 * 半荘の一覧・削除・元に戻す・結果の読み出しに答える、Tauri の偽物（試験の道具）。
 * Rust 側と同じ決まり: 消した半荘は一覧に出ず（`list_sessions`）、元に戻すと元の位置（新しい順）に出る。
 * 試験のデータで、画面の部品ではない。
 */
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';

import type { Links, OcrCache, SelfRatingValue, SessionRecord } from '../src/api/types';

const REPORTS_DIR = resolve(import.meta.dirname, '../../../packages/engine/tests/fixtures/reports');

/** エンジンの試験の固定データ（FX-1 の 5 半荘と FX-4・FX-5）の、結果の JSON の文字。 */
export const REPORT_TEXTS = {
  fx4: readFileSync(resolve(REPORTS_DIR, '5b821c8a048ff791.json'), 'utf8'),
  fx5: readFileSync(resolve(REPORTS_DIR, '20261011-153540.json'), 'utf8'),
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
    self_ratings: { kyokus: {} },
    maka: { kyokus: {} },
    memos: { marks: {}, extras: [] },
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
  /** メモの保存の呼び出しの記録（'set:1:3m・6p|理由'・'clear:1'・'set-extra:x1:k0h0e3:候補|理由'・'clear-extra:x1'）。 */
  readonly memoCalls: string[] = [];
  /** 次のメモの保存を失敗させたいときの理由（1 回だけ）。 */
  failNextMemo: string | null = null;

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

  /** 半荘 1 つを、書き換えた新しい値に置き換える（画面が、新しい値で描き直せるように、元の値は変えない）。 */
  private update(id: string, change: (session: SessionRecord) => SessionRecord): void {
    const at = this.active.findIndex((s) => s.id === id);
    if (at < 0) throw `半荘が見つかりません: ${id}`;
    this.active[at] = change(this.active[at] as SessionRecord);
  }

  /** `failNextMemo` が入っていれば、その理由で失敗させる（1 回だけ）。 */
  private failMemoWith(): void {
    if (this.failNextMemo === null) return;
    const reason = this.failNextMemo;
    this.failNextMemo = null;
    throw reason;
  }

  /** 半荘の読み取りの写しを置き換える（試験から。Rust 側が読み直して、`ocr.json` を書き直したときと同じ）。 */
  setOcr(id: string, ocr: OcrCache): void {
    this.update(id, (s) => ({ ...s, ocr }));
  }

  /** 半荘の今の中身（試験の確かめ用）。 */
  session(id: string): SessionRecord {
    const found = this.active.find((s) => s.id === id);
    if (!found) throw new Error(`半荘が無い: ${id}`);
    return found;
  }

  /** 保存の命令（結びつけ・自己評価・MAKA）。Rust 側と同じく、値を保存して、一覧に反映する。 */
  private readonly saving: Record<string, (args: unknown) => unknown> = {
    set_mark_link: (args) => {
      const { sessionId, markId, decision } = args as { sessionId: string; markId: number; decision: string };
      this.update(sessionId, (s) => ({
        ...s,
        links: { ...s.links, marks: { ...s.links.marks, [String(markId)]: decision } },
      }));
      return undefined;
    },
    clear_mark_link: (args) => {
      const { sessionId, markId } = args as { sessionId: string; markId: number };
      this.update(sessionId, (s) => {
        const marks = { ...s.links.marks };
        delete marks[String(markId)];
        return { ...s, links: { ...s.links, marks } };
      });
      return undefined;
    },
    // 評価の結びつけと版だけを置き換える（E-31）。迷いの結びつけ・自己評価・MAKA には触らない
    replace_rating_links: (args) => {
      const { sessionId, ratings, version } = args as { sessionId: string; ratings: Record<string, string>; version: number };
      this.log.push(`ratings:${sessionId}`);
      this.update(sessionId, (s) => ({ ...s, links: { ...s.links, ratings, ratings_version: version } }));
      return undefined;
    },
    set_self_rating: (args) => {
      const { sessionId, kyoku, rating } = args as { sessionId: string; kyoku: string; rating: SelfRatingValue };
      this.update(sessionId, (s) => ({ ...s, self_ratings: { kyokus: { ...s.self_ratings.kyokus, [kyoku]: rating } } }));
      return undefined;
    },
    clear_self_rating: (args) => {
      const { sessionId, kyoku } = args as { sessionId: string; kyoku: string };
      this.update(sessionId, (s) => {
        const kyokus = { ...s.self_ratings.kyokus };
        delete kyokus[kyoku];
        return { ...s, self_ratings: { kyokus } };
      });
      return undefined;
    },
    set_maka_grade: (args) => {
      const { sessionId, kyoku, grade } = args as { sessionId: string; kyoku: string; grade: string };
      this.update(sessionId, (s) => ({ ...s, maka: { ...s.maka, kyokus: { ...s.maka.kyokus, [kyoku]: grade } } }));
      return undefined;
    },
    clear_maka_grade: (args) => {
      const { sessionId, kyoku } = args as { sessionId: string; kyoku: string };
      this.update(sessionId, (s) => {
        const kyokus = { ...s.maka.kyokus };
        delete kyokus[kyoku];
        return { ...s, maka: { ...s.maka, kyokus } };
      });
      return undefined;
    },
    set_maka_hanchan: (args) => {
      const { sessionId, grade } = args as { sessionId: string; grade: string };
      this.update(sessionId, (s) => ({ ...s, maka: { ...s.maka, hanchan: grade } }));
      return undefined;
    },
    clear_maka_hanchan: (args) => {
      const { sessionId } = args as { sessionId: string };
      this.update(sessionId, (s) => ({ ...s, maka: { kyokus: s.maka.kyokus } }));
      return undefined;
    },
    // 終局直後のメモ（F4、U-28）。Rust 側と同じく、前後の空白を除き、「候補」も「理由」も空なら消す。迷いマークの無い迷いのメモは、名前ごとに置き換える
    set_memo: (args) => {
      const { sessionId, markId, candidates, reason } = args as { sessionId: string; markId: number; candidates: string; reason: string };
      this.memoCalls.push(`set:${markId}:${candidates}|${reason}`);
      this.failMemoWith();
      const memo = { candidates: candidates.trim(), reason: reason.trim() };
      this.update(sessionId, (s) => {
        const marks = { ...s.memos.marks };
        if (memo.candidates === '' && memo.reason === '') delete marks[String(markId)];
        else marks[String(markId)] = memo;
        return { ...s, memos: { ...s.memos, marks } };
      });
      return undefined;
    },
    clear_memo: (args) => {
      const { sessionId, markId } = args as { sessionId: string; markId: number };
      this.memoCalls.push(`clear:${markId}`);
      this.failMemoWith();
      this.update(sessionId, (s) => {
        const marks = { ...s.memos.marks };
        delete marks[String(markId)];
        return { ...s, memos: { ...s.memos, marks } };
      });
      return undefined;
    },
    set_extra_memo: (args) => {
      const { sessionId, id, decision, candidates, reason } = args as {
        sessionId: string;
        id: string;
        decision: string;
        candidates: string;
        reason: string;
      };
      this.memoCalls.push(`set-extra:${id}:${decision}:${candidates}|${reason}`);
      this.failMemoWith();
      const extra = { id, decision, candidates: candidates.trim(), reason: reason.trim() };
      this.update(sessionId, (s) => {
        const extras = s.memos.extras.some((e) => e.id === id) ? s.memos.extras.map((e) => (e.id === id ? extra : e)) : [...s.memos.extras, extra];
        return { ...s, memos: { ...s.memos, extras } };
      });
      return undefined;
    },
    clear_extra_memo: (args) => {
      const { sessionId, id } = args as { sessionId: string; id: string };
      this.memoCalls.push(`clear-extra:${id}`);
      this.failMemoWith();
      this.update(sessionId, (s) => ({ ...s, memos: { ...s.memos, extras: s.memos.extras.filter((e) => e.id !== id) } }));
      return undefined;
    },
  };

  /**
   * 取り込みの保存の偽物（`handlers` には入れない。取り込みの試験が、必要なときに足す）。Rust 側と同じく、結果の保存は、
   * 半荘に結果の場所を入れて、一覧に反映する。文字認識は、与えた写しを返して、半荘に入れる。
   * 呼ばれた順の記録は `log`（'ocr:a,b'・'save:id'・'links:id'）。
   */
  importHandlers(ocr: OcrCache | ((id: string) => OcrCache)): Record<string, (args: unknown) => unknown> {
    return {
      ocr_sessions: (args) => {
        const ids = (args as { sessionIds: string[] }).sessionIds;
        this.log.push(`ocr:${ids.join(',')}`);
        return ids.map((id) => {
          const cache = typeof ocr === 'function' ? ocr(id) : ocr;
          this.update(id, (s) => ({ ...s, ocr: cache }));
          return { session_id: id, ocr: cache };
        });
      },
      save_report: (args) => {
        const { sessionId, text } = args as { sessionId: string | null; text: string };
        this.log.push(`save:${sessionId}`);
        if (sessionId === null) throw '記録の無い半荘としての取り込みは、この偽物では扱わない';
        if (this.reports.has(sessionId)) throw `この半荘には、すでに結果が取り込まれています: ${sessionId}`;
        this.reports.set(sessionId, text);
        this.update(sessionId, (s) => ({ ...s, report_path: `C:\\data\\games\\${sessionId}\\report.json` }));
        return sessionId;
      },
      replace_links: (args) => {
        const { sessionId, links } = args as { sessionId: string; links: Links };
        this.log.push(`links:${sessionId}`);
        this.update(sessionId, (s) => ({ ...s, links }));
        return undefined;
      },
    };
  }

  /**
   * 前の作り方で読んだ半荘の読み直し（F11、E-27）の偽物（`handlers` には入れない。読み直しの試験が、必要なときに足す）。
   * Rust 側と同じ決まり: 写しの決まりの名前が `currentGeometry` と違う半荘だけ「読み直しが要る」（写しが無ければ、要らない）。
   * 読み直しは、写しを `fresh` に置き換えて true を返す（結びつけ・評価・MAKA には触らない）。
   * `hold` を渡すと、それが済むまで読み直しは終わらない。`failWith` を渡すと、読み直しは、その理由で失敗する（写しは、そのまま）。
   * 呼ばれた順の記録は `log`（'needs:id'・'reread:id'）。
   */
  rereadHandlers(options: {
    currentGeometry: string;
    fresh: OcrCache;
    hold?: Promise<unknown>;
    failWith?: string;
  }): Record<string, (args: unknown) => unknown> {
    return {
      needs_ocr_reread: (args) => {
        const { sessionId } = args as { sessionId: string };
        this.log.push(`needs:${sessionId}`);
        const ocr = this.session(sessionId).ocr;
        return ocr !== null && ocr.geometry !== options.currentGeometry;
      },
      reread_ocr: async (args) => {
        const { sessionId } = args as { sessionId: string };
        this.log.push(`reread:${sessionId}`);
        await options.hold;
        if (options.failWith !== undefined) throw options.failWith;
        this.setOcr(sessionId, options.fresh);
        return true;
      },
    };
  }

  readonly handlers: Record<string, (args: unknown) => unknown> = {
    ...this.saving,
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
