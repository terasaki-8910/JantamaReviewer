/**
 * 通して見る画面の迷いの段の「細かいミスだけ」の切り替え（F17、U-42）。入れると、前・次の迷いと迷いの数が、細かいミス
 * （迷いのうち、実戦が AI の1位と違うもの）だけになる。答える前から分かるので、AI の情報は要らない。
 * 画面の保存領域（localStorage の `jantama.fineMissOnly`）に覚えて、起動し直しても残す。保存領域が使えないときは、覚えられないだけで動く。
 */
import { usePersistedFlag } from '../usePersistedFlag';

export const FINE_MISS_ONLY_KEY = 'jantama.fineMissOnly';

/** 既定は切。 */
export function useFineMissOnly(): [boolean, (on: boolean) => void] {
  return usePersistedFlag(FINE_MISS_ONLY_KEY, false);
}
