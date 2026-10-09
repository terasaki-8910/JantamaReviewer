import '@testing-library/jest-dom/vitest';

import { cleanup } from '@testing-library/react';
import { afterEach, vi } from 'vitest';

// jsdom には matchMedia が無い。テーマの判定が使うので、ライトの OS として振る舞う偽物を入れる。
// （Node 環境のテストでは window が無いので、何もしない。）
if (typeof window !== 'undefined' && typeof window.matchMedia !== 'function') {
  Object.defineProperty(window, 'matchMedia', {
    writable: true,
    value: (query: string) => ({
      matches: false,
      media: query,
      onchange: null,
      addEventListener: vi.fn(),
      removeEventListener: vi.fn(),
      addListener: vi.fn(),
      removeListener: vi.fn(),
      dispatchEvent: vi.fn(),
    }),
  });
}

// グローバルの afterEach が無い設定なので、描画の後始末を明示する。
afterEach(() => {
  if (typeof document !== 'undefined') {
    cleanup();
    document.documentElement.removeAttribute('data-theme');
    try {
      window.localStorage.clear();
    } catch {
      // 使えない環境では何もしない。
    }
  }
});
