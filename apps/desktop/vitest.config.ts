import react from '@vitejs/plugin-react';
import { defineConfig } from 'vitest/config';

// 画面の部品のテストは jsdom で動かす。実ブラウザを使うテスト（tests/browser）は、
// ファイルの先頭の指定で Node 環境に切り替える。
export default defineConfig({
  plugins: [react()],
  test: {
    environment: 'jsdom',
    include: ['src/**/*.test.{ts,tsx}', 'tests/**/*.test.{ts,tsx}'],
    setupFiles: ['tests/setup.ts'],
    css: false,
    testTimeout: 30_000,
    hookTimeout: 60_000,
  },
});
