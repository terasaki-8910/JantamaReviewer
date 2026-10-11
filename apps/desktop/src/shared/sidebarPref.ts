/**
 * 広い窓（640px 以上）で、サイドバーを出しているかどうか（利用者が左上のボタンで決める。U-32、R11-15）。
 * テーマ（theme.ts）と同じく、画面の保存領域（localStorage）に覚える。起動し直しても残る。
 * 保存領域が使えない（読めない・書けない）ときは、覚えられないだけで、いつもどおり出す。
 */

export const SIDEBAR_STORAGE_KEY = 'jr-sidebar';

/** 覚えている選び。無い・読めないときは、出す（true）。 */
export function readSidebarShown(): boolean {
  try {
    return window.localStorage.getItem(SIDEBAR_STORAGE_KEY) !== 'hidden';
  } catch {
    // 保存領域が使えなくても、出して動く。
    return true;
  }
}

export function storeSidebarShown(shown: boolean): void {
  try {
    window.localStorage.setItem(SIDEBAR_STORAGE_KEY, shown ? 'shown' : 'hidden');
  } catch {
    // 覚えられないだけ。
  }
}
