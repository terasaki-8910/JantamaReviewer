/**
 * 答え合わせのあとに直す欄（差の原因・MAKA の推した打牌）を、取り消せる命令（U-11）にする。
 * 画面にも Tauri にも依存しない（保存の窓口 `UpdateNotes` を渡す。試験では偽物を渡せる）。
 * 学んだ原則は文字を打つ欄なので、欄そのものの取り消しに任せる（アプリの取り消しの対象にしない）。
 */
import type { AnswerNotes, AnswerRow } from '../../api/types';
import type { UndoCommand } from '../undo/undoStack';

/** 答えのメモを保存する。渡した欄だけを替える。 */
export type UpdateNotes = (id: number, patch: Partial<AnswerNotes>) => Promise<AnswerRow>;

export interface CausesEdit {
  /** 答えの番号。 */
  id: number;
  before: readonly string[];
  after: readonly string[];
}

/** 差の原因の選び直し。取り消すと、前の選び方に戻る。 */
export function causesCommand(update: UpdateNotes, edit: CausesEdit): UndoCommand {
  const apply = async (causes: readonly string[]): Promise<void> => {
    await update(edit.id, { causes: [...causes] });
  };
  return {
    label: '差の原因の選択',
    messages: { undo: '差の原因の選択を元に戻しました', redo: '差の原因の選択をやり直しました' },
    execute: () => apply(edit.after),
    undo: () => apply(edit.before),
  };
}

export interface MakaMoveEdit {
  id: number;
  before: string | null;
  after: string | null;
}

/** MAKA の推した打牌を入れる・外す。取り消すと、前の入力に戻る。 */
export function makaMoveCommand(update: UpdateNotes, edit: MakaMoveEdit): UndoCommand {
  const apply = async (move: string | null): Promise<void> => {
    await update(edit.id, { maka_move: move });
  };
  return {
    label: 'MAKA の推した打牌の入力',
    messages: { undo: 'MAKA の推した打牌を元に戻しました', redo: 'MAKA の推した打牌をやり直しました' },
    execute: () => apply(edit.after),
    undo: () => apply(edit.before),
  };
}
