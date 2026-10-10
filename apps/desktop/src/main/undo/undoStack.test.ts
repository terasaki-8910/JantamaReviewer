import { describe, expect, it, vi } from 'vitest';

import { UndoStack, type UndoCommand, type UndoEvent } from './undoStack';

/** 呼ばれた順を `log` に残す命令。 */
function command(name: string, log: string[], extra: Partial<UndoCommand> = {}): UndoCommand {
  return {
    label: name,
    execute: () => {
      log.push(`${name}:execute`);
    },
    undo: () => {
      log.push(`${name}:undo`);
    },
    ...extra,
  };
}

const later = (ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms));

describe('U-11: 取り消しの積み重ね（UndoStack）', () => {
  it('実行すると積まれて、取り消せるようになる。やり直しはまだできない', async () => {
    const log: string[] = [];
    const stack = new UndoStack();
    expect(stack.canUndo).toBe(false);
    await stack.run(command('a', log));
    expect(log).toEqual(['a:execute']);
    expect(stack.canUndo).toBe(true);
    expect(stack.canRedo).toBe(false);
    expect(stack.undoLabel).toBe('a');
  });

  it('取り消しは新しい順。取り消すと、やり直しの積み重ねに移る。やり直すと、取り消しの積み重ねに戻る', async () => {
    const log: string[] = [];
    const stack = new UndoStack();
    await stack.run(command('a', log));
    await stack.run(command('b', log));
    expect((await stack.undo())?.label).toBe('b');
    expect((await stack.undo())?.label).toBe('a');
    expect(stack.canUndo).toBe(false);
    expect(stack.canRedo).toBe(true);
    expect(stack.redoLabel).toBe('a');
    expect((await stack.redo())?.label).toBe('a');
    expect((await stack.redo())?.label).toBe('b');
    expect(stack.canRedo).toBe(false);
    expect(log).toEqual(['a:execute', 'b:execute', 'b:undo', 'a:undo', 'a:execute', 'b:execute']);
  });

  it('やり直しは、redo があればそれを呼び、無ければ execute をもう一度呼ぶ', async () => {
    const log: string[] = [];
    const stack = new UndoStack();
    await stack.run(command('plain', log));
    await stack.run(command('custom', log, { redo: () => void log.push('custom:redo') }));
    await stack.undo();
    await stack.undo();
    await stack.redo();
    await stack.redo();
    expect(log.filter((l) => l.endsWith(':redo') || l === 'plain:execute')).toEqual([
      'plain:execute',
      'plain:execute',
      'custom:redo',
    ]);
  });

  it('取り消したあとに新しい命令を実行すると、やり直しの積み重ねは捨てられる', async () => {
    const log: string[] = [];
    const stack = new UndoStack();
    await stack.run(command('a', log));
    await stack.undo();
    expect(stack.canRedo).toBe(true);
    await stack.run(command('b', log));
    expect(stack.canRedo).toBe(false);
    expect(await stack.redo()).toBeNull();
    expect(stack.undoLabel).toBe('b');
  });

  it('取り消せるものが無いとき、undo と redo は何もせず null を返し、知らせも出さない', async () => {
    const stack = new UndoStack();
    const events: UndoEvent[] = [];
    stack.onEvent((e) => events.push(e));
    expect(await stack.undo()).toBeNull();
    expect(await stack.redo()).toBeNull();
    expect(events).toEqual([]);
  });

  it('非同期の命令でも、実行・取り消し・やり直しは 1 つずつ順番に動く（連打しても、同じ命令を 2 回取り消さない）', async () => {
    const log: string[] = [];
    const slow = (name: string): UndoCommand => ({
      label: name,
      execute: async () => {
        log.push(`${name}:execute:start`);
        await later(15);
        log.push(`${name}:execute:end`);
      },
      undo: async () => {
        log.push(`${name}:undo:start`);
        await later(15);
        log.push(`${name}:undo:end`);
      },
    });
    const stack = new UndoStack();
    // 実行の完了を待たずに、すぐ取り消しを 3 回重ねる。
    const runs = Promise.all([stack.run(slow('a')), stack.run(slow('b'))]);
    const first = stack.undo();
    const second = stack.undo();
    const third = stack.undo();
    await runs;
    expect((await first)?.label).toBe('b');
    expect((await second)?.label).toBe('a');
    expect(await third).toBeNull();
    expect(log).toEqual([
      'a:execute:start',
      'a:execute:end',
      'b:execute:start',
      'b:execute:end',
      'b:undo:start',
      'b:undo:end',
      'a:undo:start',
      'a:undo:end',
    ]);
  });

  it('実行が失敗したら、積まずに、例外をそのまま投げる。失敗の知らせが出る。次の仕事は動く', async () => {
    const stack = new UndoStack();
    const events: UndoEvent[] = [];
    stack.onEvent((e) => events.push(e));
    const boom = new Error('保存できません');
    const broken: UndoCommand = {
      label: 'broken',
      execute: () => {
        throw boom;
      },
      undo: vi.fn(),
    };
    await expect(stack.run(broken)).rejects.toBe(boom);
    expect(stack.canUndo).toBe(false);
    expect(events).toEqual([{ type: 'failed', action: 'run', command: broken, error: boom }]);
    const log: string[] = [];
    await stack.run(command('ok', log));
    expect(stack.canUndo).toBe(true);
  });

  it('取り消しが失敗したら、積み重ねは変わらない（まだ取り消せる）。やり直しも同じ', async () => {
    const stack = new UndoStack();
    const events: UndoEvent[] = [];
    stack.onEvent((e) => events.push(e));
    let failUndo = true;
    let failRedo = true;
    const flaky: UndoCommand = {
      label: 'flaky',
      execute: () => undefined,
      undo: () => {
        if (failUndo) throw new Error('戻せません');
      },
      redo: () => {
        if (failRedo) throw new Error('やり直せません');
      },
    };
    await stack.run(flaky);
    await expect(stack.undo()).rejects.toThrow('戻せません');
    expect(stack.canUndo).toBe(true);
    expect(stack.canRedo).toBe(false);
    failUndo = false;
    await stack.undo();
    expect(stack.canUndo).toBe(false);
    expect(stack.canRedo).toBe(true);
    await expect(stack.redo()).rejects.toThrow('やり直せません');
    expect(stack.canRedo).toBe(true);
    expect(stack.canUndo).toBe(false);
    failRedo = false;
    await stack.redo();
    expect(stack.canUndo).toBe(true);
    const failures = events.flatMap((e) => (e.type === 'failed' ? [e.action] : []));
    expect(failures).toEqual(['undo', 'redo']);
  });

  it('数の上限を超えたら、いちばん古い命令から忘れる', async () => {
    const log: string[] = [];
    const stack = new UndoStack(3);
    for (const name of ['a', 'b', 'c', 'd', 'e']) await stack.run(command(name, log));
    const undone: string[] = [];
    for (let next = await stack.undo(); next !== null; next = await stack.undo()) undone.push(next.label);
    expect(undone).toEqual(['e', 'd', 'c']);
  });

  it('実行・取り消し・やり直しの知らせと、積み重ねの変化の知らせが出る。外すと止まる', async () => {
    const stack = new UndoStack();
    const events: string[] = [];
    const off = stack.onEvent((e) => events.push(`${e.type}:${e.command.label}`));
    let changes = 0;
    const offChanges = stack.subscribe(() => {
      changes += 1;
    });
    const before = stack.getSnapshot();
    await stack.run(command('a', []));
    await stack.undo();
    await stack.redo();
    expect(events).toEqual(['run:a', 'undo:a', 'redo:a']);
    expect(changes).toBe(3);
    expect(stack.getSnapshot()).toBe(before + 3);
    off();
    offChanges();
    await stack.undo();
    expect(events).toHaveLength(3);
    expect(changes).toBe(3);
  });

  it('clear で、取り消しもやり直しも忘れる', async () => {
    const stack = new UndoStack();
    await stack.run(command('a', []));
    await stack.run(command('b', []));
    await stack.undo();
    stack.clear();
    expect(stack.canUndo).toBe(false);
    expect(stack.canRedo).toBe(false);
  });

  it('命令に通知の文を持たせられる（実行・取り消し・やり直しのあとに出す文）', async () => {
    const stack = new UndoStack();
    const withMessages = command('delete', [], {
      messages: { run: '消しました', undo: '戻しました', redo: 'もう一度消しました' },
    });
    const seen: Array<string | undefined> = [];
    stack.onEvent((e) => {
      if (e.type !== 'failed') seen.push(e.command.messages?.[e.type]);
    });
    await stack.run(withMessages);
    await stack.undo();
    await stack.redo();
    expect(seen).toEqual(['消しました', '戻しました', 'もう一度消しました']);
  });
});
