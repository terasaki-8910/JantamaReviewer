import { act, render, renderHook, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { describe, expect, it, vi } from 'vitest';

import { UndoProvider, undoActionOfKey, useUndo, useUndoBlocker, useUndoEvents } from './UndoProvider';
import { UndoStack, type UndoCommand, type UndoEvent } from './undoStack';

function counting(name = 'c') {
  const calls = { execute: 0, undo: 0, redo: 0 };
  const cmd: UndoCommand = {
    label: name,
    execute: () => {
      calls.execute += 1;
    },
    undo: () => {
      calls.undo += 1;
    },
    redo: () => {
      calls.redo += 1;
    },
  };
  return { cmd, calls };
}

/** 画面の中に、いろいろな種類の欄を置く。命令は、押したボタンで 1 つ登録する。 */
function Harness({ command, blocked = false }: { command: UndoCommand; blocked?: boolean }) {
  const undo = useUndo();
  useUndoBlocker(blocked);
  return (
    <div>
      <button type="button" onClick={() => void undo.run(command)}>
        登録
      </button>
      <input aria-label="文字" type="text" />
      <input aria-label="検索" type="search" />
      <textarea aria-label="メモ" />
      <select aria-label="選ぶ">
        <option>a</option>
      </select>
      <input aria-label="チェック" type="checkbox" />
      <span>{undo.canUndo ? '取り消せる' : '取り消せない'}</span>
      <span>{undo.canRedo ? 'やり直せる' : 'やり直せない'}</span>
    </div>
  );
}

function setup(blocked = false) {
  const { cmd, calls } = counting();
  const user = userEvent.setup();
  const view = render(
    <UndoProvider>
      <Harness command={cmd} blocked={blocked} />
    </UndoProvider>,
  );
  return { user, view, calls, cmd };
}

const CTRL_Z = '{Control>}z{/Control}';
const CTRL_Y = '{Control>}y{/Control}';
const CTRL_SHIFT_Z = '{Control>}{Shift>}z{/Shift}{/Control}';

describe('U-11: Ctrl+Z・Ctrl+Y（UndoProvider）', () => {
  it('Ctrl+Z で取り消し、Ctrl+Y でやり直す。Ctrl+Shift+Z もやり直し', async () => {
    const { user, calls } = setup();
    await user.click(screen.getByRole('button', { name: '登録' }));
    expect(await screen.findByText('取り消せる')).toBeInTheDocument();
    expect(calls.execute).toBe(1);

    await user.keyboard(CTRL_Z);
    expect(await screen.findByText('取り消せない')).toBeInTheDocument();
    expect(calls.undo).toBe(1);
    expect(screen.getByText('やり直せる')).toBeInTheDocument();

    await user.keyboard(CTRL_Y);
    expect(await screen.findByText('取り消せる')).toBeInTheDocument();
    expect(calls.redo).toBe(1);

    await user.keyboard(CTRL_Z);
    await screen.findByText('取り消せない');
    await user.keyboard(CTRL_SHIFT_Z);
    await screen.findByText('取り消せる');
    expect(calls.redo).toBe(2);
  });

  it('Cmd（meta）でも動く。Alt が付いているときは動かない', async () => {
    const { user, calls } = setup();
    await user.click(screen.getByRole('button', { name: '登録' }));
    await screen.findByText('取り消せる');
    await user.keyboard('{Alt>}{Control>}z{/Control}{/Alt}');
    expect(calls.undo).toBe(0);
    await user.keyboard('{Meta>}z{/Meta}');
    await screen.findByText('取り消せない');
    expect(calls.undo).toBe(1);
  });

  it('文字を打つ欄（input・search・textarea・select）にキーボードの位置があるときは、アプリの取り消しは動かない', async () => {
    const { user, calls } = setup();
    await user.click(screen.getByRole('button', { name: '登録' }));
    await screen.findByText('取り消せる');
    const fields = [
      screen.getByRole('textbox', { name: '文字' }),
      screen.getByRole('searchbox', { name: '検索' }),
      screen.getByRole('textbox', { name: 'メモ' }),
      screen.getByRole('combobox', { name: '選ぶ' }),
    ];
    for (const field of fields) {
      act(() => field.focus());
      await user.keyboard(CTRL_Z);
      await user.keyboard(CTRL_Y);
    }
    expect(calls.undo).toBe(0);
    expect(calls.redo).toBe(0);
    expect(screen.getByText('取り消せる')).toBeInTheDocument();
  });

  it('チェック欄にキーボードの位置があるときは、動く', async () => {
    const { user, calls } = setup();
    await user.click(screen.getByRole('button', { name: '登録' }));
    await screen.findByText('取り消せる');
    act(() => screen.getByRole('checkbox', { name: 'チェック' }).focus());
    await user.keyboard(CTRL_Z);
    await screen.findByText('取り消せない');
    expect(calls.undo).toBe(1);
  });

  it('メニューやダイアログが開いている間（useUndoBlocker）は動かない。閉じると動く', async () => {
    const { user, calls, view, cmd } = setup(true);
    await user.click(screen.getByRole('button', { name: '登録' }));
    await screen.findByText('取り消せる');
    await user.keyboard(CTRL_Z);
    expect(calls.undo).toBe(0);
    view.rerender(
      <UndoProvider>
        <Harness command={cmd} blocked={false} />
      </UndoProvider>,
    );
    await user.keyboard(CTRL_Z);
    await screen.findByText('取り消せない');
    expect(calls.undo).toBe(1);
  });

  it('積み重ねが空のときの Ctrl+Z・Ctrl+Y は、何も起こさない', async () => {
    const { user, calls } = setup();
    await user.keyboard(CTRL_Z);
    await user.keyboard(CTRL_Y);
    expect(calls).toEqual({ execute: 0, undo: 0, redo: 0 });
    expect(screen.getByText('取り消せない')).toBeInTheDocument();
  });

  it('取り消しが失敗しても、握りつぶされた例外にならず、失敗の知らせが届く。積み重ねは変わらない', async () => {
    const events: UndoEvent[] = [];
    const stack = new UndoStack();
    const flaky: UndoCommand = {
      label: 'flaky',
      execute: () => undefined,
      undo: () => {
        throw new Error('戻せません');
      },
    };
    function Probe() {
      useUndoEvents((e) => events.push(e));
      return null;
    }
    const user = userEvent.setup();
    render(
      <UndoProvider stack={stack}>
        <Probe />
        <p>画面</p>
      </UndoProvider>,
    );
    await act(async () => {
      await stack.run(flaky);
    });
    await user.keyboard(CTRL_Z);
    await vi.waitFor(() => expect(events.some((e) => e.type === 'failed')).toBe(true));
    expect(stack.canUndo).toBe(true);
  });

  it('Provider の外で useUndo を使うと、分かりやすい例外になる', () => {
    const quiet = vi.spyOn(console, 'error').mockImplementation(() => undefined);
    try {
      expect(() => renderHook(() => useUndo())).toThrow('UndoProvider の中で使ってください');
    } finally {
      quiet.mockRestore();
    }
  });
});

describe('undoActionOfKey', () => {
  const key = (init: KeyboardEventInit) => new KeyboardEvent('keydown', init);

  it('Ctrl/Cmd + Z = 取り消し、Ctrl/Cmd + Y と Ctrl/Cmd + Shift + Z = やり直し。大文字でも同じ', () => {
    expect(undoActionOfKey(key({ key: 'z', ctrlKey: true }))).toBe('undo');
    expect(undoActionOfKey(key({ key: 'Z', ctrlKey: true }))).toBe('undo');
    expect(undoActionOfKey(key({ key: 'z', metaKey: true }))).toBe('undo');
    expect(undoActionOfKey(key({ key: 'y', ctrlKey: true }))).toBe('redo');
    expect(undoActionOfKey(key({ key: 'Z', ctrlKey: true, shiftKey: true }))).toBe('redo');
  });

  it('修飾キー無し・Alt 付き・Ctrl+Shift+Y・別のキーは、どちらでもない', () => {
    expect(undoActionOfKey(key({ key: 'z' }))).toBeNull();
    expect(undoActionOfKey(key({ key: 'z', ctrlKey: true, altKey: true }))).toBeNull();
    expect(undoActionOfKey(key({ key: 'y', ctrlKey: true, shiftKey: true }))).toBeNull();
    expect(undoActionOfKey(key({ key: 'a', ctrlKey: true }))).toBeNull();
  });
});
