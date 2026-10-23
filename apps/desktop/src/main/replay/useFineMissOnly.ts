/**
 * 通して見る画面の迷いの段の「細かいミスだけ」の切り替え（F17、U-42）。入れると、前・次の迷いと迷いの数が、細かいミス
 * （迷いのうち、実戦が AI の1位と違うもの）だけになる。答える前から分かるので、AI の情報は要らない。
 * 画面の保存領域（localStorage の `jantama.fineMissOnly`）に覚えて、起動し直しても残す。保存領域が使えないときは、覚えられないだけで動く。
 */
import { useCallback, useState } from 'react';

export const FINE_MISS_ONLY_KEY = 'jantama.fineMissOnly';

/** 覚えている選び。無い・読めないときは、切（false）。 */
export function readFineMissOnly(): boolean {
  try {
    return window.localStorage.getItem(FINE_MISS_ONLY_KEY) === '1';
  } catch {
    return false;
  }
}

function storeFineMissOnly(on: boolean): void {
  try {
    window.localStorage.setItem(FINE_MISS_ONLY_KEY, on ? '1' : '0');
  } catch {
    // 覚えられないだけ。
  }
}

export function useFineMissOnly(): [boolean, (on: boolean) => void] {
  const [on, setOn] = useState(readFineMissOnly);
  const update = useCallback((next: boolean) => {
    setOn(next);
    storeFineMissOnly(next);
  }, []);
  return [on, update];
}
