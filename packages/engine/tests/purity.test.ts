import { readFileSync, readdirSync } from 'node:fs';
import path from 'node:path';

import { describe, expect, it } from 'vitest';

import { FIXTURES_DIR } from './helpers/fixtures';

// エンジンは「画面にも Tauri にも依存しない純粋な TypeScript」で、通信・ファイル・時計・乱数に触れない。
// これを機械で確かめる。また、apps/desktop の安全の検査（S-2）は URL や雀魂のドメインの書き方をソースから
// 外す方針なので、URL を持ってよいエンジンのファイルを 2 つに限り（safety.rs の許可の一覧と同じ）、
// そこから他のファイルに URL が広がらないことも確かめる。

const SRC_DIR = path.resolve(FIXTURES_DIR, '..', '..', 'src');

/** URL の書き方と雀魂のドメインを持ってよいファイル（safety.rs の ALLOWED_NETWORK_FILES と同じ）。 */
const LINK_FILES = ['paipu-link.ts', 'tenhou-url.ts'];

/**
 * 外の部品を読み込んでよいファイルと、読んでよい部品（名前を決めた例外。R14-3、F14）。
 * 待ちと打点の点数の計算は、kobalab の majiang-core（MIT。npm の dependencies に、版 1.4.1 を固定）に頼る。
 * エンジンは、ほかのファイルが外の部品に依存しない決まりなので、majiang-core を読み込む場所を majiang-adapter.ts の 1 つに閉じ込める
 * （牌の表記の対応・供託・ロンの向き・待ちの判定といった、癖のある部分もここだけが持つ）。ほかのファイルは、この受け口の関数だけを使う。
 * majiang-core は、実行時に通信・ファイル・時計・乱数（牌山のシャッフル）を呼ばない部分だけを使う（和了の計算・向聴数・面子の分解）。
 */
const EXTERNAL_IMPORTS: Readonly<Record<string, readonly string[]>> = {
  'majiang-adapter.ts': ['@kobalab/majiang-core'],
};

function sourceFiles(): { name: string; text: string }[] {
  return readdirSync(SRC_DIR)
    .filter((n) => n.endsWith('.ts') && !n.includes('.test.'))
    .sort()
    .map((name) => ({ name, text: readFileSync(path.join(SRC_DIR, name), 'utf-8') }));
}

/** 通信・ブラウザ・Node・時計・乱数の使い方。 */
const FORBIDDEN: { label: string; pattern: RegExp }[] = [
  { label: '通信 fetch', pattern: /\bfetch\s*\(/ },
  { label: '通信 XMLHttpRequest', pattern: /\bXMLHttpRequest\b/ },
  { label: '通信 WebSocket', pattern: /\bWebSocket\b/ },
  { label: '通信 EventSource', pattern: /\bEventSource\b/ },
  { label: '通信 sendBeacon', pattern: /\bsendBeacon\b/ },
  { label: '通信 axios', pattern: /\baxios\b/ },
  { label: 'ブラウザ window', pattern: /\bwindow\./ },
  { label: 'ブラウザ document', pattern: /\bdocument\./ },
  { label: 'ブラウザ navigator', pattern: /\bnavigator\b/ },
  { label: '保存 localStorage', pattern: /\b(?:localStorage|sessionStorage|indexedDB)\b/ },
  { label: 'Node process', pattern: /\bprocess\./ },
  { label: 'Node require', pattern: /\brequire\s*\(/ },
  { label: 'Node の部品（node:）', pattern: /['"]node:/ },
  { label: 'Tauri', pattern: /@tauri-apps/ },
  { label: '時計 Date.now', pattern: /\bDate\.now\s*\(/ },
  { label: '時計 new Date()', pattern: /\bnew Date\s*\(\s*\)/ },
  { label: '時計 performance.now', pattern: /\bperformance\.now\b/ },
  { label: '乱数 Math.random', pattern: /\bMath\.random\b/ },
  { label: '動的な読み込み import()', pattern: /\bimport\s*\(/ },
];

const URL_PATTERN = /\b(?:https?|wss?):\/\//i;
const GAME_DOMAIN_PATTERN = /mahjongsoul\.|maj-soul\.|majsoul\.|yo-star\.|yostar\./i;

describe('エンジンの純粋さ（画面・Tauri・通信・ファイル・時計に依存しない）', () => {
  it('src のどのファイルも、通信・ブラウザ・Node・Tauri・時計・乱数を使っていない', () => {
    const files = sourceFiles();
    expect(files.length).toBeGreaterThan(15);
    const found: string[] = [];
    for (const { name, text } of files) {
      for (const { label, pattern } of FORBIDDEN) {
        const m = pattern.exec(text);
        if (m) found.push(`${name}: ${label}（${m[0]}）`);
      }
    }
    expect(found).toEqual([]);
  });

  it('src の読み込みは、同じフォルダのファイル（./）だけで、外の部品に依存しない（例外は、majiang-adapter.ts が majiang-core を読み込む 1 つだけ）', () => {
    const found: string[] = [];
    for (const { name, text } of sourceFiles()) {
      for (const m of text.matchAll(/(?:^|\n)\s*(?:import|export)\b[^;]*?from\s+['"]([^'"]+)['"]/g)) {
        const spec = m[1] ?? '';
        if (!spec.startsWith('./') && !(EXTERNAL_IMPORTS[name] ?? []).includes(spec)) found.push(`${name}: ${spec}`);
      }
    }
    expect(found).toEqual([]);
  });

  it('majiang-core を読み込む src のファイルは、例外の表に書いた majiang-adapter.ts だけ。型の宣言は majiang-core.d.ts だけ', () => {
    const importers = sourceFiles()
      .filter(({ text }) => /from\s+['"]@kobalab\//.test(text))
      .map(({ name }) => name);
    // 例外の表に書いたファイルが、実際に読み込んでいる（表だけが残って、読み込みが無くなっていない）
    expect(importers).toEqual(Object.keys(EXTERNAL_IMPORTS));
    // 型の宣言（majiang-core.d.ts）は、読み込みではない
    const declares = sourceFiles()
      .filter(({ text }) => /declare module ['"]@kobalab\//.test(text))
      .map(({ name }) => name);
    expect(declares).toEqual(['majiang-core.d.ts']);
  });

  it('URL の書き方と雀魂のドメインを持つのは、牌譜リンクと天鳳牌理の 2 ファイルだけ', () => {
    const withUrl = sourceFiles()
      .filter(({ text }) => URL_PATTERN.test(text) || GAME_DOMAIN_PATTERN.test(text))
      .map(({ name }) => name);
    expect(withUrl).toEqual(LINK_FILES);
  });

  it('許可した 2 ファイルが雀魂のドメインを持つのは牌譜リンクだけ（天鳳牌理は雀魂と無関係）', () => {
    const domainFiles = sourceFiles()
      .filter(({ text }) => GAME_DOMAIN_PATTERN.test(text))
      .map(({ name }) => name);
    expect(domainFiles).toEqual(['paipu-link.ts']);
  });

  it('検査の道具が、禁止の使い方を実際に見つける（空振りしていない）', () => {
    const samples = [
      "const r = await fetch('x');",
      'const x = new XMLHttpRequest();',
      'new WebSocket(url);',
      'window.open();',
      'document.title;',
      'localStorage.getItem(k);',
      'process.env.X;',
      "const fs = require('fs');",
      "import fs from 'node:fs';",
      "import { invoke } from '@tauri-apps/api/core';",
      'Date.now();',
      'new Date();',
      'Math.random();',
      "await import('./x');",
    ];
    for (const sample of samples) {
      expect(
        FORBIDDEN.some(({ pattern }) => pattern.test(sample)),
        sample,
      ).toBe(true);
    }
    expect(URL_PATTERN.test('const u = "https://example.com";')).toBe(true);
    expect(GAME_DOMAIN_PATTERN.test('game.MahjongSoul.com')).toBe(true);
    // 引数のある Date は、決まった入力から暦の日付を作るので使ってよい
    expect(FORBIDDEN.some(({ pattern }) => pattern.test('new Date(2026, 9, 9)'))).toBe(false);
  });
});
