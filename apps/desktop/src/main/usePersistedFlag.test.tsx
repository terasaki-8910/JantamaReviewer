/**
 * 画面の保存領域に覚える入・切（`usePersistedFlag`）の試験。覚える値の形（'1'・'0'）は、すでに保存してある値を読み続けるために変えない。
 * 保存領域が使えない（読めない・書けない）ときは、覚えられないだけで、その場の入・切は動く。
 */
import { act, renderHook } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';

import { usePersistedFlag } from './usePersistedFlag';

const KEY = 'jantama.testFlag';

afterEach(() => {
  vi.restoreAllMocks();
});

describe('usePersistedFlag', () => {
  it('覚えていなければ最初の値。覚えている "1" は入、"0" は切（最初の値より優先する）', () => {
    expect(renderHook(() => usePersistedFlag(KEY, false)).result.current[0]).toBe(false);
    expect(renderHook(() => usePersistedFlag(KEY, true)).result.current[0]).toBe(true);
    window.localStorage.setItem(KEY, '1');
    expect(renderHook(() => usePersistedFlag(KEY, false)).result.current[0]).toBe(true);
    window.localStorage.setItem(KEY, '0');
    expect(renderHook(() => usePersistedFlag(KEY, true)).result.current[0]).toBe(false);
  });

  it('"1" でも "0" でもない値は、覚えていないものとして、最初の値にする', () => {
    window.localStorage.setItem(KEY, 'true');
    expect(renderHook(() => usePersistedFlag(KEY, false)).result.current[0]).toBe(false);
    expect(renderHook(() => usePersistedFlag(KEY, true)).result.current[0]).toBe(true);
  });

  it('変えると、その場で変わり、"1"（入）・"0"（切）で覚え直す。作り直しても、覚えた値から始まる', () => {
    const first = renderHook(() => usePersistedFlag(KEY, false));
    expect(window.localStorage.getItem(KEY)).toBeNull();
    act(() => first.result.current[1](true));
    expect(first.result.current[0]).toBe(true);
    expect(window.localStorage.getItem(KEY)).toBe('1');
    act(() => first.result.current[1](false));
    expect(first.result.current[0]).toBe(false);
    expect(window.localStorage.getItem(KEY)).toBe('0');
    act(() => first.result.current[1](true));
    first.unmount();
    expect(renderHook(() => usePersistedFlag(KEY, false)).result.current[0]).toBe(true);
  });

  it('名前（key）ごとに別々に覚える', () => {
    const a = renderHook(() => usePersistedFlag('jantama.testFlagA', false));
    const b = renderHook(() => usePersistedFlag('jantama.testFlagB', false));
    act(() => a.result.current[1](true));
    expect(a.result.current[0]).toBe(true);
    expect(b.result.current[0]).toBe(false);
    expect(window.localStorage.getItem('jantama.testFlagB')).toBeNull();
  });

  it('保存領域が使えなくても、例外にしない。最初の値で始まり、その場では変えられる', () => {
    vi.spyOn(Storage.prototype, 'getItem').mockImplementation(() => {
      throw new Error('使えません');
    });
    const setItem = vi.spyOn(Storage.prototype, 'setItem').mockImplementation(() => {
      throw new Error('使えません');
    });
    const { result } = renderHook(() => usePersistedFlag(KEY, true));
    expect(result.current[0]).toBe(true);
    act(() => result.current[1](false));
    expect(result.current[0]).toBe(false);
    expect(setItem).toHaveBeenCalledWith(KEY, '0');
  });
});
