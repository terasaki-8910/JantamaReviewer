/**
 * 終局直後のメモの書き換えを、取り消せる命令にする部分（U-11、U-28）の試験。偽の保存の窓口と、本物の取り消しの積み重ねを使う。
 */
import { describe, expect, it, vi } from 'vitest';

import type { ExtraMemoPlace, MemoEntry } from '../api/types';
import { extraMemoCommand, markMemoCommand, type MemoApi } from './memoEdits';
import { UndoStack } from './undo/undoStack';

function fakeApi() {
  const calls: string[] = [];
  const api: MemoApi = {
    setMemo: async (sessionId: string, markId: number, memo: MemoEntry) => void calls.push(`set ${sessionId} ${markId} ${memo.candidates}|${memo.reason}`),
    clearMemo: async (sessionId: string, markId: number) => void calls.push(`clear ${sessionId} ${markId}`),
    // 局面は「判断の鍵」「@局.本場.巡目」の順に、あるものだけ並べる（例: k4h2e5@4.2.9）
    setExtraMemo: async (sessionId: string, id: string, place: ExtraMemoPlace, memo: MemoEntry) => {
      const where = `${place.decision ?? ''}${place.position === undefined ? '' : `@${place.position.kyoku}.${place.position.honba}.${place.position.junme}`}`;
      calls.push(`set-extra ${sessionId} ${id} ${where} ${memo.candidates}|${memo.reason}`);
    },
    clearExtraMemo: async (sessionId: string, id: string) => void calls.push(`clear-extra ${sessionId} ${id}`),
  };
  return { api, calls };
}

describe('U-11・U-28 迷いマークのメモの命令', () => {
  const edit = { sessionId: 's', markId: 4, number: 3 };

  it('実行すると、書いたメモを保存して、一覧を読み直す。取り消すと、元のメモに戻す。やり直すと、もう一度書く', async () => {
    const { api, calls } = fakeApi();
    const reload = vi.fn(async () => undefined);
    const stack = new UndoStack();
    const before = { candidates: '3m', reason: '' };
    const after = { candidates: '3m・6p', reason: '形' };
    await stack.run(markMemoCommand(api, reload, { ...edit, before, after }));
    expect(calls).toEqual(['set s 4 3m・6p|形']);
    expect(reload).toHaveBeenCalledTimes(1);
    await stack.undo();
    expect(calls.at(-1)).toBe('set s 4 3m|');
    await stack.redo();
    expect(calls.at(-1)).toBe('set s 4 3m・6p|形');
    expect(reload).toHaveBeenCalledTimes(3);
  });

  it('元のメモが無かったときは、取り消すと、メモを消す。空にして消したときは、取り消すと、元のメモを書き戻す', async () => {
    const { api, calls } = fakeApi();
    const stack = new UndoStack();
    await stack.run(markMemoCommand(api, async () => undefined, { ...edit, before: undefined, after: { candidates: 'a', reason: '' } }));
    await stack.undo();
    expect(calls).toEqual(['set s 4 a|', 'clear s 4']);
    await stack.run(markMemoCommand(api, async () => undefined, { ...edit, before: { candidates: 'a', reason: 'b' }, after: undefined }));
    expect(calls.at(-1)).toBe('clear s 4');
    await stack.undo();
    expect(calls.at(-1)).toBe('set s 4 a|b');
  });

  it('通知は、取り消し・やり直しのときだけ（書くたびには出さない）。名前に迷いの番号が入る', async () => {
    const { api } = fakeApi();
    const command = markMemoCommand(api, async () => undefined, { ...edit, before: undefined, after: { candidates: 'a', reason: '' } });
    expect(command.messages?.run).toBeUndefined();
    expect(command.messages?.undo).toBe('迷い3のメモを元に戻しました');
    expect(command.messages?.redo).toBe('迷い3のメモをやり直しました');
  });

  it('保存に失敗した命令は、積まない（例外をそのまま返す）', async () => {
    const { api } = fakeApi();
    const failing: MemoApi = { ...api, setMemo: async () => Promise.reject(new Error('保存できません')) };
    const stack = new UndoStack();
    await expect(stack.run(markMemoCommand(failing, async () => undefined, { ...edit, before: undefined, after: { candidates: 'a', reason: '' } }))).rejects.toThrow('保存できません');
    expect(stack.canUndo).toBe(false);
  });
});

describe('U-11・U-28 迷いマークの無い迷いのメモの命令', () => {
  const memo = { id: 'x1', decision: 'k4h2e5', candidates: '5s・發', reason: '押すか引くか' };

  it('足す: 実行すると、判断の鍵と一緒に保存する。取り消すと、メモを消す。やり直すと、足し直す（通知つき）', async () => {
    const { api, calls } = fakeApi();
    const stack = new UndoStack();
    const command = extraMemoCommand(api, async () => undefined, { sessionId: 's', id: 'x1', before: undefined, after: memo });
    expect(command.messages?.run).toBe('迷いマークの無い迷いのメモを足しました');
    await stack.run(command);
    expect(calls).toEqual(['set-extra s x1 k4h2e5 5s・發|押すか引くか']);
    await stack.undo();
    expect(calls.at(-1)).toBe('clear-extra s x1');
    await stack.redo();
    expect(calls.at(-1)).toBe('set-extra s x1 k4h2e5 5s・發|押すか引くか');
  });

  it('消す: 実行すると消す。取り消すと、判断の鍵も文も元のまま戻す', async () => {
    const { api, calls } = fakeApi();
    const stack = new UndoStack();
    await stack.run(extraMemoCommand(api, async () => undefined, { sessionId: 's', id: 'x1', before: memo, after: undefined }));
    expect(calls).toEqual(['clear-extra s x1']);
    await stack.undo();
    expect(calls.at(-1)).toBe('set-extra s x1 k4h2e5 5s・發|押すか引くか');
  });

  it('書き直す: 取り消すと、前の文に戻す（通知は取り消し・やり直しのときだけ）', async () => {
    const { api, calls } = fakeApi();
    const stack = new UndoStack();
    const edited = { ...memo, candidates: '1m' };
    const command = extraMemoCommand(api, async () => undefined, { sessionId: 's', id: 'x1', before: memo, after: edited });
    expect(command.messages?.run).toBeUndefined();
    await stack.run(command);
    expect(calls).toEqual(['set-extra s x1 k4h2e5 1m|押すか引くか']);
    await stack.undo();
    expect(calls.at(-1)).toBe('set-extra s x1 k4h2e5 5s・發|押すか引くか');
  });

  it('位置だけのメモ（取り込む前）を足す: 判断の鍵を付けずに、位置を保存する。取り消すと消す', async () => {
    const { api, calls } = fakeApi();
    const stack = new UndoStack();
    const position = { kyoku: 2, honba: 0, junme: 9 };
    const placed = { id: 'x1', position, candidates: '5s・發', reason: '' };
    await stack.run(extraMemoCommand(api, async () => undefined, { sessionId: 's', id: 'x1', before: undefined, after: placed }));
    expect(calls).toEqual(['set-extra s x1 @2.0.9 5s・發|']);
    await stack.undo();
    expect(calls.at(-1)).toBe('clear-extra s x1');
    await stack.redo();
    expect(calls.at(-1)).toBe('set-extra s x1 @2.0.9 5s・發|');
  });

  it('局面を選んで結びつける: 位置は残したまま判断の鍵を足す。取り消すと位置だけに戻す。通知の文に、選んだ局面が入る', async () => {
    const { api, calls } = fakeApi();
    const reload = vi.fn(async () => undefined);
    const stack = new UndoStack();
    const position = { kyoku: 2, honba: 0, junme: 9 };
    const before = { id: 'x1', position, candidates: '5s', reason: '押す' };
    const command = extraMemoCommand(api, reload, {
      sessionId: 's',
      id: 'x1',
      before,
      after: { ...before, decision: 'k2h0e11' },
      link: '東3局 9巡目',
    });
    expect(command.label).toBe('追加のメモの局面を選ぶ');
    expect(command.messages).toEqual({
      run: '追加のメモを東3局 9巡目の局面に結びつけました',
      undo: '追加のメモの結びつけを元に戻しました',
      redo: '追加のメモを東3局 9巡目の局面に結びつけました',
    });
    await stack.run(command);
    expect(calls).toEqual(['set-extra s x1 k2h0e11@2.0.9 5s|押す']);
    await stack.undo();
    expect(calls.at(-1)).toBe('set-extra s x1 @2.0.9 5s|押す');
    await stack.redo();
    expect(calls.at(-1)).toBe('set-extra s x1 k2h0e11@2.0.9 5s|押す');
    expect(reload).toHaveBeenCalledTimes(3);
  });
});
