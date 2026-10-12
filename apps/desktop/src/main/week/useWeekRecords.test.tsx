/**
 * 週の成績・重点の読み込みと保存（U-30。D-2「週の数」の元）の試験。保存は 1 つずつ順番に行い、そのときの最新の記録から作る
 * （成績の欄と重点の欄が続けて保存されても、片方がもう片方を古い値で上書きしない）。
 */
import { act, renderHook, waitFor } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';

import { installTauriMock } from '../../../tests/tauri-mock';
import type { WeekRecord } from '../../api/types';
import { useWeekRecords } from './useWeekRecords';
import { withFocus, withStat } from './weekRecords';

vi.mock('@tauri-apps/api/core', () => ({ invoke: vi.fn(), convertFileSrc: (path: string) => path }));
vi.mock('@tauri-apps/api/event', () => ({ listen: vi.fn() }));

const W = '2026-10-05';

afterEach(() => vi.restoreAllMocks());

/** 保存の終わりを、試験が決める偽物。渡された記録の順番を覚える。 */
function slowStore(initial: WeekRecord[] = []) {
  const stored = new Map(initial.map((r) => [r.week, r] as const));
  const calls: WeekRecord[] = [];
  const gates: Array<() => void> = [];
  installTauriMock({
    handlers: {
      list_weeks: () => [...stored.values()],
      set_week: (args) =>
        new Promise((resolve) => {
          const record = (args as { record: WeekRecord }).record;
          calls.push(structuredClone(record));
          gates.push(() => {
            stored.set(record.week, record);
            resolve(record);
          });
        }),
    },
  });
  return { stored, calls, release: () => gates.shift()?.() };
}

describe('U-30 週の成績・重点の読み込みと保存', () => {
  it('開いたとき、すべての週の記録を読む（読み終えるまでは loaded が false）', async () => {
    slowStore([{ week: W, stats: { rank4: 20.4 }, focus: '重点' }]);
    const { result } = renderHook(() => useWeekRecords());
    expect(result.current.loaded).toBe(false);
    await waitFor(() => expect(result.current.loaded).toBe(true));
    expect(result.current.error).toBeNull();
    expect(result.current.records.get(W)).toEqual({ week: W, stats: { rank4: 20.4 }, focus: '重点' });
  });

  it('続けて 2 つ保存すると、1 つずつ順番に書く。あとの保存は、前の保存が済んだあとの最新の記録から作る（成績と重点が、互いを上書きしない）', async () => {
    const store = slowStore();
    const { result } = renderHook(() => useWeekRecords());
    await waitFor(() => expect(result.current.loaded).toBe(true));
    let first: Promise<string | null> = Promise.resolve(null);
    let second: Promise<string | null> = Promise.resolve(null);
    act(() => {
      first = result.current.save(W, (current) => withStat(current, W, 'rank4', 20.4));
      second = result.current.save(W, (current) => withFocus(current, W, '受け入れを数える。'));
    });
    // まだ、1 つ目の保存の終わりを待っている: 書き込みの呼び出しは 1 つだけ
    await waitFor(() => expect(store.calls).toHaveLength(1));
    expect(store.calls[0]).toEqual({ week: W, stats: { rank4: 20.4 }, focus: '' });
    await act(async () => {
      store.release();
      await first;
    });
    await waitFor(() => expect(store.calls).toHaveLength(2));
    // 2 つ目は、1 つ目が済んだあとの記録（成績あり）に、重点を足したもの
    expect(store.calls[1]).toEqual({ week: W, stats: { rank4: 20.4 }, focus: '受け入れを数える。' });
    await act(async () => {
      store.release();
      expect(await second).toBeNull();
    });
    expect(result.current.records.get(W)).toEqual({ week: W, stats: { rank4: 20.4 }, focus: '受け入れを数える。' });
    expect(store.stored.get(W)?.focus).toBe('受け入れを数える。');
  });

  it('保存できなかったときは、理由の文を返す。画面の記録は、保存してある値のまま。次の保存は続けられる', async () => {
    let fail = true;
    installTauriMock({
      handlers: {
        list_weeks: () => [],
        set_week: (args) => {
          if (fail) {
            fail = false;
            throw '保存先がいっぱいです';
          }
          return (args as { record: WeekRecord }).record;
        },
      },
    });
    const { result } = renderHook(() => useWeekRecords());
    await waitFor(() => expect(result.current.loaded).toBe(true));
    let message: string | null = null;
    await act(async () => {
      message = await result.current.save(W, (current) => withStat(current, W, 'rank4', 20));
    });
    expect(message).toBe('保存先がいっぱいです');
    expect(result.current.records.size).toBe(0);
    await act(async () => {
      message = await result.current.save(W, (current) => withStat(current, W, 'rank4', 21));
    });
    expect(message).toBeNull();
    expect(result.current.records.get(W)?.stats.rank4).toBe(21);
  });

  it('空にして保存すると、記録が消える（保存先が null を返す）', async () => {
    installTauriMock({
      handlers: {
        list_weeks: () => [{ week: W, stats: { rank4: 20 }, focus: '' }],
        set_week: () => null,
      },
    });
    const { result } = renderHook(() => useWeekRecords());
    await waitFor(() => expect(result.current.records.size).toBe(1));
    await act(async () => {
      await result.current.save(W, (current) => withStat(current, W, 'rank4', null));
    });
    expect(result.current.records.size).toBe(0);
  });

  it('読めなかったとき（保存先を開けない）は、理由を持つ。読み終えた印は付く', async () => {
    installTauriMock({
      handlers: {
        list_weeks: () => {
          throw 'ファイルを開けません';
        },
      },
    });
    const { result } = renderHook(() => useWeekRecords());
    await waitFor(() => expect(result.current.loaded).toBe(true));
    expect(result.current.error).toBe('ファイルを開けません');
    expect(result.current.records.size).toBe(0);
  });
});
