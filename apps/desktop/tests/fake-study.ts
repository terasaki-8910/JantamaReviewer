/**
 * 答えの記録（study.sqlite）の偽物（試験の道具）。Rust 側（`study/mod.rs`）と同じ決まりで答える:
 * 答えには番号が付く／差の原因は決まった 5 つだけ／今日の組は、その日に 1 回だけ保存される（あとの保存は、保存済みの組を返す）／
 * 解いた数は、半荘ごとの、答えのある問題の数（出題でも解き直しでも、同じ問題は 1 つ）。
 * 週の成績と重点（weeks 表）も、Rust 側（`StudyDb::set_week`）と同じ決まりで答える: 週は月曜の日付／率は 0〜100・平均順位は 1〜4／
 * 重点は空の行を除いて 3 行まで・1 行 100 文字まで／成績も重点も空なら、記録ごと消して null を返す。
 * 試験のデータで、画面の部品ではない。
 */
import { importReportText, type ImportedGame } from '@jantama/engine';

import type { AnswerNotes, AnswerRow, NewAnswer, StoredProblemRef, WeekRecord, WeekStats } from '../src/api/types';
import { REPORT_TEXTS, type ReportKey } from './fake-sessions';

/** エンジンの試験の固定データを、牌譜を再生した結果にする。 */
export function gameOf(key: ReportKey): ImportedGame {
  const imported = importReportText(REPORT_TEXTS[key]);
  if (!imported.ok) throw new Error(`固定データを読めません: ${key}`);
  return imported.value;
}

const CAUSE_IDS = ['ukeire', 'shape', 'value', 'defense', 'other'];

/** 保存してある答えの 1 行（試験が、期限つきの答えを用意するための形。足りない欄は、無難な値）。 */
export function answerRow(partial: Partial<AnswerRow> & Pick<AnswerRow, 'session_id' | 'decision_key'>): AnswerRow {
  return {
    id: 1,
    mode: 'quiz',
    shown_at: 1_000,
    answered_at: 39_000,
    choice: { type: 'dahai', tile: '1m' },
    reason: '試験の理由',
    duration_ms: 38_000,
    reselect_count: 0,
    correct: false,
    causes: [],
    principle: '',
    maka_move: null,
    interval_days: 1,
    due_date: '2026-10-09',
    ...partial,
  };
}

const STAT_RANGES: Record<keyof WeekStats, [number, number]> = {
  rank4: [0, 100],
  deal: [0, 100],
  avg: [1, 4],
  win: [0, 100],
  call: [0, 100],
  riichi: [0, 100],
};

/** Rust の `check_week` と同じ確かめ。保存する形（重点を整えたもの）を返す。正しくなければ、理由を投げる。 */
function checkWeek(record: WeekRecord): WeekRecord {
  const parts = /^(\d{4})-(\d{2})-(\d{2})$/.exec(record.week);
  const monday = parts !== null && new Date(Number(parts[1]), Number(parts[2]) - 1, Number(parts[3])).getDay() === 1;
  if (!monday) throw `週は、月曜の日付（YYYY-MM-DD）で指定します: ${record.week}`;
  for (const key of Object.keys(record.stats) as Array<keyof WeekStats>) {
    const value = record.stats[key];
    const range = STAT_RANGES[key];
    if (value === undefined) continue;
    if (range === undefined || !Number.isFinite(value) || value < range[0] || value > range[1]) {
      throw `${key}は ${range?.[0]} から ${range?.[1]} の数です: ${value}`;
    }
  }
  const lines = record.focus
    .split(/\r?\n/)
    .map((line) => line.trim())
    .filter((line) => line !== '');
  if (lines.length > 3) throw '重点は 3 行までです';
  if (lines.some((line) => Array.from(line).length > 100)) throw '重点の 1 行は 100 文字までです';
  return { week: record.week, stats: { ...record.stats }, focus: lines.join('\n') };
}

export class FakeStudyStore {
  readonly rows: AnswerRow[];
  readonly daily = new Map<string, StoredProblemRef[]>();
  /** 週の成績と重点（週の月曜 → 記録）。 */
  readonly weeks = new Map<string, WeekRecord>();
  /** `set_week` の呼び出しの記録（渡された記録）。 */
  readonly weekCalls: WeekRecord[] = [];
  /** 次の週の保存を失敗させたいときの理由（1 回だけ）。 */
  failNextWeek: string | null = null;
  /** 次の答えの保存を失敗させたいときの理由。 */
  failNextRecord: string | null = null;
  failNextNotes: string | null = null;
  private nextId: number;

  constructor(initial: AnswerRow[] = [], daily: Record<string, StoredProblemRef[]> = {}) {
    this.rows = initial.map((row) => ({ ...row }));
    this.nextId = this.rows.reduce((max, row) => Math.max(max, row.id), 0) + 1;
    for (const [date, items] of Object.entries(daily)) this.daily.set(date, items);
  }

  /** `installTauriMock({ handlers: { ...sessions.handlers, ...study.handlers } })` に渡す。 */
  get handlers(): Record<string, (args: unknown) => unknown> {
    return {
      list_answers: () => this.rows.map((row) => ({ ...row })),
      record_answer: (args) => {
        if (this.failNextRecord !== null) {
          const reason = this.failNextRecord;
          this.failNextRecord = null;
          throw reason;
        }
        const answer = (args as { answer: NewAnswer }).answer;
        if (answer.reason.trim() === '') throw '理由は 1 文字以上で入れてください';
        const row: AnswerRow = {
          ...answer,
          id: this.nextId++,
          causes: answer.causes ?? [],
          principle: answer.principle ?? '',
          maka_move: answer.maka_move ?? null,
        };
        this.rows.push(row);
        return { ...row };
      },
      update_answer_notes: (args) => {
        if (this.failNextNotes !== null) {
          const reason = this.failNextNotes;
          this.failNextNotes = null;
          throw reason;
        }
        const { id, notes } = args as { id: number; notes: AnswerNotes };
        const row = this.rows.find((candidate) => candidate.id === id);
        if (row === undefined) throw `答えが見つかりません: ${id}`;
        for (const cause of notes.causes) if (!CAUSE_IDS.includes(cause)) throw `知らない原因です: ${cause}`;
        row.causes = [...notes.causes];
        row.principle = notes.principle;
        row.maka_move = notes.maka_move;
        return { ...row };
      },
      get_daily_set: (args) => {
        const items = this.daily.get((args as { date: string }).date);
        return items === undefined ? null : items.map((item) => ({ ...item }));
      },
      save_daily_set: (args) => {
        const { date, items } = args as { date: string; items: StoredProblemRef[] };
        if (!this.daily.has(date)) this.daily.set(date, items);
        return (this.daily.get(date) ?? []).map((item) => ({ ...item }));
      },
      list_weeks: () =>
        [...this.weeks.values()].sort((a, b) => (a.week < b.week ? -1 : 1)).map((w) => structuredClone(w)),
      set_week: (args) => {
        const record = (args as { record: WeekRecord }).record;
        this.weekCalls.push(structuredClone(record));
        if (this.failNextWeek !== null) {
          const reason = this.failNextWeek;
          this.failNextWeek = null;
          throw reason;
        }
        const checked = checkWeek(record);
        if (Object.keys(checked.stats).length === 0 && checked.focus === '') {
          this.weeks.delete(checked.week);
          return null;
        }
        this.weeks.set(checked.week, checked);
        return structuredClone(checked);
      },
      count_solved: (args) =>
        (args as { sessionIds: string[] }).sessionIds.map((id) => ({
          session_id: id,
          solved: new Set(this.rows.filter((row) => row.session_id === id).map((row) => row.decision_key)).size,
        })),
    };
  }
}
