import { describe, expect, it, vi } from 'vitest';

import { UndoStack } from '../undo/undoStack';
import { resolveCommand } from './resolveEdits';

describe('U-11 解決の入切の取り消し', () => {
  const edit = { sessionId: '20261009-190953', key: 'k1h0e12', before: false, after: true };

  it('実行で解決を入れ、取り消すと切り、やり直すともう一度入れる。そのたびに半荘の一覧を読み直す', async () => {
    const api = { setResolved: vi.fn(async () => undefined) };
    const reload = vi.fn(async () => undefined);
    const stack = new UndoStack();
    await stack.run(resolveCommand(api, reload, edit));
    expect(api.setResolved).toHaveBeenLastCalledWith('20261009-190953', 'k1h0e12', true);
    expect(reload).toHaveBeenCalledTimes(1);
    await stack.undo();
    expect(api.setResolved).toHaveBeenLastCalledWith('20261009-190953', 'k1h0e12', false);
    await stack.redo();
    expect(api.setResolved).toHaveBeenLastCalledWith('20261009-190953', 'k1h0e12', true);
    expect(api.setResolved).toHaveBeenCalledTimes(3);
    expect(reload).toHaveBeenCalledTimes(3);
  });

  it('解決を切る操作は、取り消すと入れ直す（前の形に戻る）', async () => {
    const api = { setResolved: vi.fn(async () => undefined) };
    const stack = new UndoStack();
    await stack.run(resolveCommand(api, async () => undefined, { ...edit, before: true, after: false }));
    expect(api.setResolved).toHaveBeenLastCalledWith('20261009-190953', 'k1h0e12', false);
    await stack.undo();
    expect(api.setResolved).toHaveBeenLastCalledWith('20261009-190953', 'k1h0e12', true);
  });

  it('名前は「解決」。実行のときは通知を出さず、取り消し・やり直しのときだけ出す', () => {
    const on = resolveCommand({ setResolved: vi.fn() }, vi.fn(), edit);
    expect(on.label).toBe('解決');
    expect(on.messages?.run).toBeUndefined();
    expect(on.messages?.undo).toBe('解決を元に戻しました');
    expect(on.messages?.redo).toBe('解決をやり直しました');
    const off = resolveCommand({ setResolved: vi.fn() }, vi.fn(), { ...edit, before: true, after: false });
    expect(off.messages?.undo).toBe('解決の取り消しを元に戻しました');
    expect(off.messages?.redo).toBe('解決の取り消しをやり直しました');
  });

  it('保存に失敗したら、積まない（例外のまま）。一覧も読み直さない', async () => {
    const api = {
      setResolved: vi.fn(async () => {
        throw new Error('保存できません');
      }),
    };
    const reload = vi.fn(async () => undefined);
    const stack = new UndoStack();
    await expect(stack.run(resolveCommand(api, reload, edit))).rejects.toThrow('保存できません');
    expect(stack.canUndo).toBe(false);
    expect(reload).not.toHaveBeenCalled();
  });
});
