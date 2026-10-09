import '@testing-library/jest-dom/vitest';

import { cleanup } from '@testing-library/react';
import { afterEach } from 'vitest';

// グローバルの afterEach が無い設定なので、描画の後始末を明示する。
afterEach(() => {
  cleanup();
});
