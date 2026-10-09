/**
 * ライト・ダークのテーマ。
 * 既定は OS の設定（prefers-color-scheme）に従う。検討画面のボタンで切り替えると
 * localStorage に覚え、同じアプリの別の窓（ウィジェット）にも反映する。
 */

import { reportBackground } from './windowReady';

export const THEME_STORAGE_KEY = 'jr-theme';

export type ThemeChoice = 'light' | 'dark';

/** 覚えているテーマ。無い・読めないときは null（OS に従う）。 */
export function readStoredTheme(): ThemeChoice | null {
  try {
    const value = window.localStorage.getItem(THEME_STORAGE_KEY);
    return value === 'light' || value === 'dark' ? value : null;
  } catch {
    // ストレージが使えなくても、OS の設定で動く。
    return null;
  }
}

export function storeTheme(choice: ThemeChoice): void {
  try {
    window.localStorage.setItem(THEME_STORAGE_KEY, choice);
  } catch {
    // 覚えられないだけ。
  }
}

/** `data-theme` を付ける（null なら外して OS に従う）。 */
export function applyTheme(choice: ThemeChoice | null): void {
  const root = document.documentElement;
  if (choice) {
    root.setAttribute('data-theme', choice);
  } else {
    root.removeAttribute('data-theme');
  }
}

/** いま見えているテーマ。 */
export function effectiveTheme(): ThemeChoice {
  const attr = document.documentElement.getAttribute('data-theme');
  if (attr === 'light' || attr === 'dark') return attr;
  return window.matchMedia('(prefers-color-scheme: dark)').matches ? 'dark' : 'light';
}

/**
 * 起動時に呼ぶ。覚えているテーマを適用し、ほかの窓での切り替え（storage イベント）と、
 * OS の設定の変化に追従する。テーマが変わったら、窓の背景色も画面の色にそろえさせる（N-7）。
 * 戻り値は後始末の関数。
 */
export function initTheme(): () => void {
  applyTheme(readStoredTheme());
  const onStorage = (event: StorageEvent) => {
    if (event.key === THEME_STORAGE_KEY || event.key === null) {
      applyTheme(readStoredTheme());
      void reportBackground();
    }
  };
  const query = window.matchMedia('(prefers-color-scheme: dark)');
  const onSystemChange = () => void reportBackground();
  window.addEventListener('storage', onStorage);
  query.addEventListener('change', onSystemChange);
  return () => {
    window.removeEventListener('storage', onStorage);
    query.removeEventListener('change', onSystemChange);
  };
}
