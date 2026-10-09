import { defineConfig } from 'vitest/config';

// エンジンは画面にも Tauri にも依存しない純粋な TypeScript なので、Node 環境で動かす。
export default defineConfig({
  test: {
    environment: 'node',
    include: ['src/**/*.test.ts'],
  },
});
