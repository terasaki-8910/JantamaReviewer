// @vitest-environment node
/**
 * リポジトリ全体の決まりを機械で確かめる。
 * - L-2: ソースと画面の文言に絵文字を入れない（eslint が見ない Rust・CSS・HTML・JSON も含む）
 * - L-1: HTML に色の値を直接書かない（CSS は stylelint、TSX は eslint が見る）
 * - docs/recipes/tauri-desktop-app.md の注意点（アプリのフォルダのロックファイルと packageManager、
 *   bundle.icon の明示）
 * - 画面の CSP が外部の通信を許していないこと（S-2 の補強）
 * - .gitignore がビルド成果物を除外していること
 */
import { existsSync, readFileSync, readdirSync, statSync } from 'node:fs';
import { join, relative, sep } from 'node:path';
import { fileURLToPath } from 'node:url';

import { describe, expect, it } from 'vitest';

const ROOT = fileURLToPath(new URL('../../..', import.meta.url));
const SKIP_DIRS = new Set(['node_modules', 'target', 'dist', 'gen', '.git', 'coverage']);
const TEXT_EXT = new Set(['.ts', '.tsx', '.js', '.mjs', '.cjs', '.rs', '.css', '.html', '.json', '.toml', '.yaml', '.yml']);

function walk(dir: string, out: string[] = []): string[] {
  for (const name of readdirSync(dir)) {
    if (SKIP_DIRS.has(name)) continue;
    const path = join(dir, name);
    if (statSync(path).isDirectory()) walk(path, out);
    else out.push(path);
  }
  return out;
}

/** 製品とテストのソース（docs・既存のパイプラインのスクリプト・ロックファイルは対象外）。 */
function sourceFiles(): string[] {
  const roots = ['apps', 'packages', 'eslint-rules'].map((d) => join(ROOT, d));
  const files = roots.flatMap((r) => (existsSync(r) ? walk(r) : []));
  for (const name of readdirSync(ROOT)) {
    if (/^(eslint|stylelint|tsconfig).*\.(js|json)$/.test(name) || name === 'package.json') {
      files.push(join(ROOT, name));
    }
  }
  return files.filter((f) => {
    const ext = f.slice(f.lastIndexOf('.'));
    const base = f.slice(f.lastIndexOf(sep) + 1);
    return TEXT_EXT.has(ext) && base !== 'pnpm-lock.yaml' && base !== 'Cargo.lock';
  });
}

const EMOJI = /\p{Extended_Pictographic}|[\u{1F1E6}-\u{1F1FF}]/gu;
const EMOJI_ALLOWED = new Set(['©', '®', '™']);
const COLOR_LITERAL = /#[0-9a-fA-F]{3,8}\b|\b(?:rgba?|hsla?|hwb|lab|lch|oklab|oklch|color-mix)\s*\(/g;

describe('L-2: 絵文字を入れない', () => {
  it('走査の対象が見つかる', () => {
    expect(sourceFiles().length).toBeGreaterThan(30);
  });

  it('どのソースにも絵文字が無い', () => {
    const found: string[] = [];
    for (const file of sourceFiles()) {
      const text = readFileSync(file, 'utf8');
      for (const match of text.matchAll(EMOJI)) {
        if (EMOJI_ALLOWED.has(match[0])) continue;
        const line = text.slice(0, match.index).split('\n').length;
        found.push(`${relative(ROOT, file)}:${line} U+${match[0].codePointAt(0)?.toString(16).toUpperCase()}`);
      }
    }
    expect(found).toEqual([]);
  });

  it('検出の正規表現が、絵文字を実際に見つける（空振りしていない）', () => {
    expect('a\u{1F600}b'.match(EMOJI)).toHaveLength(1);
    expect('a\u{1F1EF}\u{1F1F5}b'.match(EMOJI)).not.toBeNull();
    expect('〇△✕×'.match(EMOJI)).toBeNull();
  });
});

describe('L-1: HTML に色を直接書かない', () => {
  it('apps/desktop の HTML に色の値が無い', () => {
    const dir = join(ROOT, 'apps', 'desktop');
    const htmls = readdirSync(dir).filter((n) => n.endsWith('.html'));
    expect(htmls.sort()).toEqual(['index.html', 'widget.html']);
    for (const name of htmls) {
      expect(readFileSync(join(dir, name), 'utf8').match(COLOR_LITERAL), name).toBeNull();
    }
  });
});

describe('Tauri の注意点（docs/recipes/tauri-desktop-app.md）', () => {
  const desktop = join(ROOT, 'apps', 'desktop');
  const conf = JSON.parse(readFileSync(join(desktop, 'src-tauri', 'tauri.conf.json'), 'utf8')) as {
    bundle: { icon: string[] };
    app: { security: { csp: string; devCsp?: string } };
  };

  it('注意点 3: アプリのフォルダにロックファイルの置き物があり、packageManager を書いている', () => {
    expect(existsSync(join(desktop, 'pnpm-lock.yaml'))).toBe(true);
    const pkg = JSON.parse(readFileSync(join(desktop, 'package.json'), 'utf8')) as { packageManager?: string };
    expect(pkg.packageManager).toMatch(/^pnpm@\d+\.\d+\.\d+$/);
  });

  it('注意点 4: bundle.icon に標準の 5 つを明示し、ファイルが実在する', () => {
    expect(conf.bundle.icon).toEqual([
      'icons/32x32.png',
      'icons/128x128.png',
      'icons/128x128@2x.png',
      'icons/icon.icns',
      'icons/icon.ico',
    ]);
    for (const icon of conf.bundle.icon) {
      expect(existsSync(join(desktop, 'src-tauri', icon)), icon).toBe(true);
    }
  });

  it('画面の CSP は、外部のサイトへの通信と eval を許さない（S-2）', () => {
    const csp = conf.app.security.csp;
    expect(csp).not.toMatch(/unsafe-eval/);
    // asset と ipc のローカルな出入口以外の http(s) / ws(s) を許していない。
    const remote = [...csp.matchAll(/(?:https?|wss?):\/\/[^\s;]+/g)].map((m) => m[0]);
    expect(remote.sort()).toEqual(['http://asset.localhost', 'http://ipc.localhost']);
    expect(csp).not.toMatch(/\*/);
  });
});

describe('.gitignore', () => {
  it('ビルド成果物を除外している', () => {
    const lines = readFileSync(join(ROOT, '.gitignore'), 'utf8')
      .split('\n')
      .map((l) => l.trim());
    for (const entry of ['target/', 'apps/desktop/dist/', 'apps/desktop/src-tauri/target/', 'node_modules/']) {
      expect(lines, entry).toContain(entry);
    }
  });
});
