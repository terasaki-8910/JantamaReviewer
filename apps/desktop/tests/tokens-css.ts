/**
 * tokens.css を読んで、テーマごとのトークンの値を取り出す（試験の道具）。
 * ライト（:root）・OS の設定に従うダーク（media の中）・手で選んだダーク（data-theme="dark"）の 3 通り。
 * ダークの塊は、書き換えるものだけを持つ。書いていないトークンは、ライトの値のまま（CSS のカスケードと同じ）。
 */
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';

export type TokenMap = Map<string, string>;

export type ThemeName = 'light' | 'dark' | 'darkViaMedia';

// jsdom の環境では `import.meta.url` が http の URL になるので、ファイルの場所は dirname から求める。
const TOKENS_PATH = resolve(import.meta.dirname, '../src/styles/tokens.css');

/** `selector { ... }` の中身（波括弧の対応を見て取り出す）。 */
function blockAfter(css: string, selector: string): string {
  const start = css.indexOf(selector);
  if (start < 0) throw new Error(`セレクタが見つからない: ${selector}`);
  const open = css.indexOf('{', start);
  let depth = 0;
  for (let i = open; i < css.length; i += 1) {
    if (css[i] === '{') depth += 1;
    if (css[i] === '}') {
      depth -= 1;
      if (depth === 0) return css.slice(open + 1, i);
    }
  }
  throw new Error(`波括弧が閉じていない: ${selector}`);
}

function declarations(block: string): TokenMap {
  const map: TokenMap = new Map();
  // コメントの中の例（`--x: y;`）を拾わない。
  const code = block.replace(/\/\*[\s\S]*?\*\//g, '');
  for (const match of code.matchAll(/(--[a-z0-9-]+)\s*:\s*([^;]+);/g)) {
    const name = match[1];
    const value = match[2];
    if (name && value) map.set(name, value.trim());
  }
  return map;
}

export interface TokenThemes {
  light: TokenMap;
  dark: TokenMap;
  darkViaMedia: TokenMap;
}

export function readTokenThemes(): TokenThemes {
  const css = readFileSync(TOKENS_PATH, 'utf8');
  return {
    light: declarations(blockAfter(css, ':root {')),
    dark: declarations(blockAfter(css, ':root[data-theme="dark"]')),
    darkViaMedia: declarations(blockAfter(css, ':root:not([data-theme="light"])')),
  };
}

/**
 * トークンの値を、そのテーマで見える値にする。`var(--別のトークン)` はたどる。
 * そのテーマに無いトークンは、ライトの値（:root）を使う。
 */
export function resolveToken(themes: TokenThemes, theme: ThemeName, name: string, depth = 0): string {
  if (depth > 8) throw new Error(`トークンの参照が終わらない: ${name}`);
  const value = themes[theme].get(name) ?? themes.light.get(name);
  if (value === undefined) throw new Error(`トークンが無い: ${theme} ${name}`);
  const ref = /^var\((--[a-z0-9-]+)\)$/.exec(value);
  return ref?.[1] ? resolveToken(themes, theme, ref[1], depth + 1) : value;
}
