import { describe, expect, it, vi } from 'vitest';

import { answerRow } from '../../../tests/fake-study';
import { UndoStack } from '../undo/undoStack';
import { causesCommand, makaMoveCommand } from './answerEdits';

describe('U-11 差の原因・MAKA の打牌の取り消し', () => {
  const row = answerRow({ id: 7, session_id: 's', decision_key: 'k0h0e1' });

  it('差の原因: 実行で選んだ値を保存し、取り消すと前の選び方に戻す。やり直しでもう一度', async () => {
    const update = vi.fn(async () => row);
    const stack = new UndoStack();
    await stack.run(causesCommand(update, { id: 7, before: ['ukeire'], after: ['ukeire', 'value'] }));
    expect(update).toHaveBeenLastCalledWith(7, { causes: ['ukeire', 'value'] });
    await stack.undo();
    expect(update).toHaveBeenLastCalledWith(7, { causes: ['ukeire'] });
    await stack.redo();
    expect(update).toHaveBeenLastCalledWith(7, { causes: ['ukeire', 'value'] });
    expect(update).toHaveBeenCalledTimes(3);
  });

  it('通知の文は、取り消し・やり直しのときだけ（実行のたびに通知を出さない）。失敗の知らせ用の名前がある', () => {
    const command = causesCommand(vi.fn(), { id: 1, before: [], after: ['shape'] });
    expect(command.label).toBe('差の原因の選択');
    expect(command.messages?.run).toBeUndefined();
    expect(command.messages?.undo).toBe('差の原因の選択を元に戻しました');
    expect(command.messages?.redo).toBe('差の原因の選択をやり直しました');
  });

  it('保存に失敗したら、積まない（例外のまま）', async () => {
    const update = vi.fn(async () => {
      throw new Error('保存できません');
    });
    const stack = new UndoStack();
    await expect(stack.run(causesCommand(update, { id: 7, before: [], after: ['shape'] }))).rejects.toThrow('保存できません');
    expect(stack.canUndo).toBe(false);
  });

  it('MAKA の推した打牌: 入れる・外す。取り消すと前の入力（無し）に戻る', async () => {
    const update = vi.fn(async () => row);
    const stack = new UndoStack();
    await stack.run(makaMoveCommand(update, { id: 7, before: null, after: '7s' }));
    expect(update).toHaveBeenLastCalledWith(7, { maka_move: '7s' });
    await stack.undo();
    expect(update).toHaveBeenLastCalledWith(7, { maka_move: null });
    const command = makaMoveCommand(update, { id: 7, before: '7s', after: null });
    expect(command.label).toBe('MAKA の推した打牌の入力');
    await stack.run(command);
    expect(update).toHaveBeenLastCalledWith(7, { maka_move: null });
  });
});
