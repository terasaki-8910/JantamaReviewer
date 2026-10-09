import { fileURLToPath } from 'node:url';

import react from '@vitejs/plugin-react';
import { defineConfig } from 'vite';

// 2 つの窓（ウィジェットと検討画面）は、同じアプリの別のページとして作る。
// ウィジェットのページには検討画面の部品を読み込ませない。
export default defineConfig({
  plugins: [react()],
  // Tauri のログを隠さない。
  clearScreen: false,
  server: {
    port: 1420,
    strictPort: true,
  },
  build: {
    outDir: 'dist',
    // WebView2（Chromium）で動く。古いブラウザ向けの変換はしない。
    target: 'chrome120',
    sourcemap: false,
    rollupOptions: {
      input: {
        main: fileURLToPath(new URL('./index.html', import.meta.url)),
        widget: fileURLToPath(new URL('./widget.html', import.meta.url)),
      },
    },
  },
});
