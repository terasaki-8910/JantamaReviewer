/**
 * 画面の保存領域（localStorage）に覚えておく入・切（真偽）の状態。起動し直しても残す、画面ごとの便利のための記憶。
 * 覚える値は '1'（入）と '0'（切）。保存領域が使えないとき（読めない・書けない）は、覚えられないだけで、その場の入・切は動く。
 */
import { useCallback, useState } from 'react';

/** 覚えている入・切。無い・'1' でも '0' でもない・読めないときは `initial`。 */
function readFlag(key: string, initial: boolean): boolean {
  try {
    const stored = window.localStorage.getItem(key);
    if (stored === '1') return true;
    if (stored === '0') return false;
    return initial;
  } catch {
    return initial;
  }
}

function writeFlag(key: string, on: boolean): void {
  try {
    window.localStorage.setItem(key, on ? '1' : '0');
  } catch {
    // 覚えられないだけ。
  }
}

/** `key` に覚える入・切。最初の値は、覚えていればそれ、無ければ `initial`。変えると、その場で変わり、覚え直す。 */
export function usePersistedFlag(key: string, initial: boolean): [boolean, (on: boolean) => void] {
  const [on, setOn] = useState(() => readFlag(key, initial));
  const update = useCallback(
    (next: boolean) => {
      setOn(next);
      writeFlag(key, next);
    },
    [key],
  );
  return [on, update];
}
