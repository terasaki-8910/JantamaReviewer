/**
 * 半荘の読みの用意（F23）の試験。読みのコマンドの偽物の上で、用意の順（保存してあるもの → モデルの有無 → 計算）・
 * 画面が開いている間の覚え方・同じ半荘の計算を 2 つ走らせないこと・失敗とやり直し・離れたあとの終わり方を確かめる。
 */
import { listen } from '@tauri-apps/api/event';
import { act, renderHook, waitFor } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';

import { readsBackend } from '../../../tests/reads-backend';
import { fx4Reads } from '../../../tests/reads-fixtures';
import { installTauriMock } from '../../../tests/tauri-mock';
import { useSessionReads } from './useSessionReads';

vi.mock('@tauri-apps/api/core', () => ({ invoke: vi.fn() }));
vi.mock('@tauri-apps/api/event', () => ({ listen: vi.fn() }));

afterEach(() => {
  vi.restoreAllMocks();
});

const real = fx4Reads();

function setup(options: Parameters<typeof readsBackend>[0] = {}) {
  const backend = readsBackend({ stored: real, ...options });
  const mock = installTauriMock({ handlers: backend.handlers });
  return { backend, mock };
}

describe('F23 読みの用意', () => {
  it('使わないあいだ（切・答える前）は、何も呼ばない', () => {
    const { mock } = setup();
    const { result } = renderHook(() => useSessionReads('s1', false));
    expect(result.current.load).toEqual({ kind: 'idle' });
    expect(result.current.reads).toBeNull();
    expect(mock.calls()).toEqual([]);
  });

  it('保存してある読みがあれば、それを使う（モデルは調べない・計算しない）', async () => {
    const { mock } = setup();
    const { result } = renderHook(() => useSessionReads('s1', true));
    expect(result.current.load).toEqual({ kind: 'loading' });
    await waitFor(() => expect(result.current.load).toEqual({ kind: 'ready' }));
    expect(result.current.reads?.moments).toHaveLength(55);
    expect(mock.calls().map((call) => call.cmd)).toEqual(['read_reads']);
  });

  it('保存してある読みが無く、モデルが入っていなければ、「モデルが無い」。計算しない', async () => {
    const { mock } = setup({ stored: null, installed: false });
    const { result } = renderHook(() => useSessionReads('s1', true));
    await waitFor(() => expect(result.current.load).toEqual({ kind: 'no-model' }));
    expect(mock.calls().map((call) => call.cmd)).toEqual(['read_reads', 'get_reads_model']);
  });

  it('モデルが入っていれば、計算する。進み具合は、この半荘の分だけ。終わると読みを返す', async () => {
    const { backend, mock } = setup({ stored: null });
    const { result } = renderHook(() => useSessionReads('s1', true));
    await waitFor(() => expect(result.current.load).toEqual({ kind: 'computing', done: 0, total: null }));
    await waitFor(() => expect(mock.count('compute_reads')).toBe(1));
    // 受け手が付くまで待つ
    await waitFor(() => expect(vi.mocked(listen)).toHaveBeenCalled());
    act(() => mock.emit('reads-progress', { session_id: 's1', done: 3, total: 9 }));
    expect(result.current.load).toEqual({ kind: 'computing', done: 3, total: 9 });
    act(() => mock.emit('reads-progress', { session_id: 'other', done: 8, total: 9 }));
    expect(result.current.load).toEqual({ kind: 'computing', done: 3, total: 9 });
    act(() => backend.state.release?.());
    await waitFor(() => expect(result.current.load).toEqual({ kind: 'ready' }));
    expect(result.current.reads?.player_id).toBe(0);
  });

  it('用意できた読みは、切って入れ直しても、読み直さない。計算の途中で切って入れ直しても、計算は 1 つ', async () => {
    const { backend, mock } = setup({ stored: null });
    const { result, rerender } = renderHook(({ on }) => useSessionReads('s1', on), { initialProps: { on: true } });
    await waitFor(() => expect(mock.count('compute_reads')).toBe(1));
    rerender({ on: false });
    expect(result.current.load).toEqual({ kind: 'idle' });
    rerender({ on: true });
    expect(result.current.load.kind).toBe('computing');
    act(() => backend.state.release?.());
    await waitFor(() => expect(result.current.load).toEqual({ kind: 'ready' }));
    rerender({ on: false });
    rerender({ on: true });
    expect(result.current.load).toEqual({ kind: 'ready' });
    expect(mock.count('compute_reads')).toBe(1);
    expect(mock.count('read_reads')).toBe(1);
  });

  it('半荘ごとに覚える（別の半荘に替えると、その半荘の分を用意する）', async () => {
    const { mock } = setup();
    const { result, rerender } = renderHook(({ id }) => useSessionReads(id, true), { initialProps: { id: 's1' } });
    await waitFor(() => expect(result.current.load).toEqual({ kind: 'ready' }));
    rerender({ id: 's2' });
    expect(result.current.reads).toBeNull();
    await waitFor(() => expect(result.current.load).toEqual({ kind: 'ready' }));
    expect(mock.calls().filter((call) => call.cmd === 'read_reads').map((call) => call.args)).toEqual([{ sessionId: 's1' }, { sessionId: 's2' }]);
    rerender({ id: 's1' });
    expect(result.current.load).toEqual({ kind: 'ready' });
    expect(mock.count('read_reads')).toBe(2);
  });

  it('失敗したら理由を持ち、やり直すと、もう一度用意する（古い失敗は見ない）', async () => {
    const { backend } = setup({ stored: null });
    const { result } = renderHook(() => useSessionReads('s1', true));
    await waitFor(() => expect(backend.state.computeCalls).toBe(1));
    act(() => backend.state.fail?.('止まりました'));
    await waitFor(() => expect(result.current.load).toEqual({ kind: 'error', message: '止まりました' }));
    act(() => result.current.retry());
    expect(result.current.load).toEqual({ kind: 'loading' });
    await waitFor(() => expect(backend.state.computeCalls).toBe(2));
    act(() => backend.state.release?.());
    await waitFor(() => expect(result.current.load).toEqual({ kind: 'ready' }));
  });

  it('画面を離れたあとに計算が終わっても、落ちない（離れたあとは、状態を替えない）', async () => {
    const { backend } = setup({ stored: null });
    const { result, unmount } = renderHook(() => useSessionReads('s1', true));
    await waitFor(() => expect(backend.state.computeCalls).toBe(1));
    unmount();
    act(() => backend.state.release?.());
    await Promise.resolve();
    expect(result.current.load.kind).toBe('computing');
  });

  it('Error の失敗も文にする（Tauri のコマンドは文字を投げるが、Error でも理由を持つ）', async () => {
    const { backend } = setup({ stored: null });
    backend.handlers.get_reads_model = () => {
      throw new Error('モデルの状態を読めません');
    };
    const { result } = renderHook(() => useSessionReads('s1', true));
    await waitFor(() => expect(result.current.load).toEqual({ kind: 'error', message: 'モデルの状態を読めません' }));
  });
});
