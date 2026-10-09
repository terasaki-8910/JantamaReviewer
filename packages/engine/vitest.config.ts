import { defineConfig } from 'vitest/config';

// エンジンは画面にも Tauri にも依存しない純粋な TypeScript なので、Node 環境で動かす。
// テストは src の隣（単体）と tests（固定データを使う受け入れ項目のテスト）の両方に置く。
export default defineConfig({
  test: {
    environment: 'node',
    include: ['src/**/*.test.ts', 'tests/**/*.test.ts'],
  },
});
