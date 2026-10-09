import js from '@eslint/js';
import tseslint from 'typescript-eslint';
import jsxA11y from 'eslint-plugin-jsx-a11y';
import reactHooks from 'eslint-plugin-react-hooks';
import globals from 'globals';

import local from './eslint-rules/index.js';

/** 意図的な未使用は `_` 接頭辞で示す。この規約はテスト側でも守る。 */
const unusedVars = [
  'error',
  {
    args: 'after-used',
    argsIgnorePattern: '^_',
    varsIgnorePattern: '^_',
    caughtErrors: 'all',
    caughtErrorsIgnorePattern: '^_',
    destructuredArrayIgnorePattern: '^_',
  },
];

export default tseslint.config(
  {
    // ビルド生成物・外部のコードは lint しない。
    ignores: [
      '**/node_modules/**',
      '**/dist/**',
      '**/target/**',
      'apps/desktop/src-tauri/**',
      'docs/**',
      'state/**',
      'coverage/**',
      'playwright-report/**',
      'test-results/**',
      '.claude/**',
    ],
  },

  js.configs.recommended,
  ...tseslint.configs.recommended,

  {
    languageOptions: {
      ecmaVersion: 2023,
      sourceType: 'module',
      globals: { ...globals.node },
    },
    plugins: { local },
    rules: {
      'no-unused-vars': 'off',
      '@typescript-eslint/no-unused-vars': unusedVars,
      // L-2: 絵文字禁止。ソース全般（画面の文言・コメント・テストを含む）に掛ける。
      'local/no-emoji': 'error',
    },
  },

  // ---- React / UI レイヤ ----
  {
    files: ['apps/desktop/src/**/*.{ts,tsx}'],
    languageOptions: {
      globals: { ...globals.browser },
      parserOptions: { ecmaFeatures: { jsx: true } },
    },
    plugins: { 'jsx-a11y': jsxA11y, 'react-hooks': reactHooks },
    rules: {
      // L-3: jsx-a11y の recommended をエラー 0 で通す。
      ...jsxA11y.flatConfigs.recommended.rules,
      ...reactHooks.configs.recommended.rules,
      // L-1: 色はデザイントークン経由のみ。TS/TSX では色リテラルを一切書かない。
      'local/no-literal-color': 'error',
      // S-2 / S-4: 画面側（webview）からは通信しない。通信が要る処理は Rust 側が受け持つ。
      'no-restricted-globals': [
        'error',
        { name: 'fetch', message: 'webview からは通信しない。Rust のコマンドを呼ぶ（SPEC 2章）。' },
        { name: 'XMLHttpRequest', message: 'webview からは通信しない（SPEC 2章）。' },
        { name: 'WebSocket', message: 'webview からは通信しない（SPEC 2章）。' },
        { name: 'EventSource', message: 'webview からは通信しない（SPEC 2章）。' },
      ],
      'no-restricted-properties': [
        'error',
        { object: 'navigator', property: 'sendBeacon', message: 'webview からは通信しない（SPEC 2章）。' },
      ],
    },
  },

  // テストは画面側のコードではないので、通信の禁止は掛けない（ブラウザ駆動のテストは Node 側で動く）。
  {
    files: ['apps/desktop/src/**/*.test.{ts,tsx}', 'apps/desktop/tests/**/*.{ts,tsx}'],
    rules: {
      'no-restricted-globals': 'off',
      'no-restricted-properties': 'off',
    },
  },
);
