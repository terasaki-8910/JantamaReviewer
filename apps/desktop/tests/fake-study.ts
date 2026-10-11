/**
 * 答えの記録（study.sqlite）の偽物（試験の道具）。Rust 側（`study/mod.rs`）と同じ決まりで答える:
 * 答えには番号が付く／差の原因は決まった 5 つだけ／今日の組は、その日に 1 回だけ保存される（あとの保存は、保存済みの組を返す）／
 * 解いた数は、半荘ごとの、答えのある問題の数（出題でも解き直しでも、同じ問題は 1 つ）。
 * 試験のデータで、画面の部品ではない。
 */
import { importReportText, type ImportedGame } from '@jantama/engine';

import type { AnswerNotes, AnswerRow, NewAnswer, StoredProblemRef } from '../src/api/types';
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

export class FakeStudyStore {
  readonly rows: AnswerRow[];
  readonly daily = new Map<string, StoredProblemRef[]>();
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
      count_solved: (args) =>
        (args as { sessionIds: string[] }).sessionIds.map((id) => ({
          session_id: id,
          solved: new Set(this.rows.filter((row) => row.session_id === id).map((row) => row.decision_key)).size,
        })),
    };
  }
}
