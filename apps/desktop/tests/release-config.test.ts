// @vitest-environment node
/**
 * 配る仕組み（F21、U-51）の設定の静的検査。Actions そのものは動かせない（ユーザーが、タグを push して確かめる）ので、
 * 設定ファイルが、決めた形になっていることを、機械で確かめる。
 * - タグ（v*）の push で、Windows の Actions が、署名つきのインストーラーと latest.json を Releases に置く形になっている
 * - 更新の署名のファイルを作る設定（createUpdaterArtifacts）と、補助プログラムを入れる設定（resources）は、Actions だけの設定（tauri.release.conf.json）にあり、
 *   手元の組み立ての設定（tauri.conf.json）には無い（手元の組み立ては、鍵なしで通る）
 * - NSIS は今のユーザー向け（管理者の確認なし）。補助プログラムは、本体と同じフォルダに入る
 * - 版の番号（tauri.conf.json・Cargo.toml・package.json）がそろっている
 * - 公開鍵が、Rust の定数（アプリが署名を確かめる）と、Actions の設定（署名の鍵と照らす）で、同じ値
 */
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';

import { describe, expect, it } from 'vitest';

const ROOT = fileURLToPath(new URL('../../..', import.meta.url));

function read(...parts: string[]): string {
  return readFileSync(join(ROOT, ...parts), 'utf8').replace(/\r\n/g, '\n');
}

function json(...parts: string[]): Record<string, unknown> {
  return JSON.parse(read(...parts)) as Record<string, unknown>;
}

const WORKFLOW = read('.github', 'workflows', 'release.yml');
const LOCAL_CONFIG = json('apps', 'desktop', 'src-tauri', 'tauri.conf.json');
const RELEASE_CONFIG = json('apps', 'desktop', 'src-tauri', 'tauri.release.conf.json');

/** `a.b.c` の形で、入れ子の値を取り出す。 */
function dig(value: unknown, path: string): unknown {
  return path.split('.').reduce<unknown>((current, key) => {
    return typeof current === 'object' && current !== null ? (current as Record<string, unknown>)[key] : undefined;
  }, value);
}

/** 設定の全体に、この名前の項目が、どこかにあるか。 */
function hasKey(value: unknown, key: string): boolean {
  if (typeof value !== 'object' || value === null) return false;
  return Object.entries(value).some(([name, inner]) => name === key || hasKey(inner, key));
}

/** ステップの書かれた順（Actions は、上から順に動かす）。 */
function indexOfStep(text: string): number {
  const at = WORKFLOW.indexOf(text);
  expect(at, `${text} が、workflow に無い`).toBeGreaterThanOrEqual(0);
  return at;
}

describe('Actions の組み立て（.github/workflows/release.yml）', () => {
  it('タグ v* の push で動き、Windows の上で、Releases に置く権限を持つ', () => {
    expect(WORKFLOW).toMatch(/^on:\n {2}push:\n {4}tags:\n {6}- 'v\*'\n/m);
    // タグのほかの push（ブランチ）では動かない
    expect(WORKFLOW).not.toMatch(/branches:/);
    expect(WORKFLOW).toMatch(/runs-on: windows-latest/);
    expect(WORKFLOW).toMatch(/^permissions:\n {2}contents: write$/m);
  });

  it('tauri-action に、署名の秘密鍵と合言葉を Secrets から渡し、latest.json を NSIS に向けて置く', () => {
    expect(WORKFLOW).toMatch(/uses: tauri-apps\/tauri-action@v\d+\n/);
    expect(WORKFLOW).toContain('TAURI_SIGNING_PRIVATE_KEY: ${{ secrets.TAURI_SIGNING_PRIVATE_KEY }}');
    expect(WORKFLOW).toContain(
      'TAURI_SIGNING_PRIVATE_KEY_PASSWORD: ${{ secrets.TAURI_SIGNING_PRIVATE_KEY_PASSWORD }}',
    );
    expect(WORKFLOW).toContain('GITHUB_TOKEN: ${{ secrets.GITHUB_TOKEN }}');
    expect(WORKFLOW).toContain('tagName: ${{ github.ref_name }}');
    expect(WORKFLOW).toContain("releaseName: 'JantamaReviewer v__VERSION__'");
    expect(WORKFLOW).toMatch(/^ {10}releaseDraft: false$/m);
    expect(WORKFLOW).toMatch(/^ {10}includeUpdaterJson: true$/m);
    expect(WORKFLOW).toMatch(/^ {10}updaterJsonPreferNsis: true$/m);
    expect(WORKFLOW).toContain('projectPath: apps/desktop');
    // Actions だけの設定（署名のファイルを作る・補助プログラムを入れる）を渡す
    expect(WORKFLOW).toContain('args: --config src-tauri/tauri.release.conf.json');
  });

  it('鍵そのものは、workflow にもリポジトリにも書かない（Secrets の名前だけ）', () => {
    expect(WORKFLOW).not.toMatch(/untrusted comment|BEGIN [A-Z ]*KEY|RWR[A-Za-z0-9+/]{20,}|dW50cnVzdGVk/);
    for (const line of WORKFLOW.split('\n')) {
      if (/TAURI_SIGNING_PRIVATE_KEY/.test(line) && !line.trim().startsWith('#')) {
        expect(line).toMatch(/: \$\{\{ secrets\.[A-Z_]+ \}\}$/);
      }
    }
  });

  it('使う Actions は、どれも版（メジャー）を固定している。pnpm の版は package.json の packageManager から読む', () => {
    const uses = [...WORKFLOW.matchAll(/^\s*- uses: (\S+)$|^\s*uses: (\S+)$/gm)].map((m) => (m[1] ?? m[2]) as string);
    expect(uses.length).toBeGreaterThanOrEqual(5);
    for (const used of uses) {
      expect(used, used).toMatch(/^[\w.-]+\/[\w.-]+@(v\d+|stable)$/);
    }
    // pnpm/action-setup に version を渡すと、packageManager と食い違いうる（渡さない）
    const setup = WORKFLOW.slice(indexOfStep('uses: pnpm/action-setup@'));
    expect(setup.slice(0, setup.indexOf('\n\n'))).not.toMatch(/version:/);
    expect(JSON.parse(read('package.json')).packageManager).toMatch(/^pnpm@\d+\.\d+\.\d+$/);
  });

  it('依存を frozen で入れ、補助プログラムを release で作ってから、tauri-action を動かす', () => {
    const install = indexOfStep('pnpm install --frozen-lockfile');
    const helper = indexOfStep('cargo build --release --manifest-path apps/desktop/src-tauri/Cargo.toml -p jantama-helper');
    const action = indexOfStep('uses: tauri-apps/tauri-action@');
    expect(install).toBeLessThan(helper);
    expect(helper).toBeLessThan(action);
    // Node と Rust の準備が、先にある
    expect(indexOfStep('uses: actions/setup-node@')).toBeLessThan(install);
    expect(indexOfStep('uses: dtolnay/rust-toolchain@stable')).toBeLessThan(helper);
  });

  it('公開鍵と、タグと版の食い違いは、組み立ての前に止める', () => {
    const guard = indexOfStep('plugins.updater.pubkey');
    expect(guard).toBeLessThan(indexOfStep('uses: tauri-apps/tauri-action@'));
    expect(WORKFLOW).toContain('UPDATE_PUBLIC_KEY');
    expect(WORKFLOW).toContain("'v' + $version -ne $env:TAG");
  });

  it('先行版（「-」の入ったタグ）は、最新の版にしない', () => {
    expect(WORKFLOW).toContain("prerelease: ${{ contains(github.ref_name, '-') }}");
  });

  it('コメントは日本語で書く', () => {
    const comments = WORKFLOW.split('\n').filter((line) => line.trim().startsWith('#'));
    expect(comments.length).toBeGreaterThan(8);
    // 手順のコマンドだけの行を除いて、日本語の説明にする（CLAUDE.md の「コメントは日本語」）
    const japanese = comments.filter((line) => /[぀-ヿ一-鿿]/.test(line));
    expect(japanese.length / comments.length).toBeGreaterThan(0.8);
    expect(comments[0]).toMatch(/[぀-ヿ一-鿿]/);
  });
});

describe('手元の組み立ての設定と、Actions だけの設定', () => {
  it('手元の設定（tauri.conf.json）には、更新の署名のファイルを作る設定も、補助プログラムの resources も、更新の部品の設定も無い', () => {
    // あると、手元の組み立て（release・debug）が、秘密鍵を要る・補助プログラムの有無で落ちる
    expect(hasKey(LOCAL_CONFIG, 'createUpdaterArtifacts')).toBe(false);
    expect(dig(LOCAL_CONFIG, 'bundle.resources')).toBeUndefined();
    expect(dig(LOCAL_CONFIG, 'plugins')).toBeUndefined();
    expect(hasKey(LOCAL_CONFIG, 'pubkey')).toBe(false);
  });

  it('Actions だけの設定（tauri.release.conf.json）が、署名のファイルを作り、補助プログラムを本体と同じフォルダに入れる', () => {
    expect(dig(RELEASE_CONFIG, 'bundle.createUpdaterArtifacts')).toBe(true);
    // 補助プログラムを、インストールするフォルダの直下（本体と同じ場所）に置く。本体は、本体の隣から補助プログラムを探す
    expect(dig(RELEASE_CONFIG, 'bundle.resources')).toEqual({
      'target/release/jantama-helper.exe': 'jantama-helper.exe',
    });
    expect(typeof dig(RELEASE_CONFIG, 'plugins.updater.pubkey')).toBe('string');
    // 入れ込む補助プログラムは、Cargo の作業場所の release の出力（workflow が先に作る）
    expect(read('apps', 'desktop', 'src-tauri', 'helper', 'Cargo.toml')).toMatch(/\[\[bin\]\]\nname = "jantama-helper"/);
    expect(read('apps', 'desktop', 'src-tauri', 'input', 'src', 'setup.rs')).toContain(
      'pub const HELPER_EXE_NAME: &str = "jantama-helper.exe";',
    );
  });

  it('手元の組み立ての命令（pnpm のスクリプト）は、Actions だけの設定を使わない', () => {
    const scripts = JSON.parse(read('package.json')).scripts as Record<string, string>;
    for (const [name, command] of Object.entries(scripts)) {
      expect(command, name).not.toContain('tauri.release.conf.json');
    }
    const desktop = JSON.parse(read('apps', 'desktop', 'package.json')).scripts as Record<string, string>;
    for (const [name, command] of Object.entries(desktop)) {
      expect(command, name).not.toContain('tauri.release.conf.json');
    }
  });

  it('インストーラーは NSIS で、今のユーザー向け（管理者の確認なし）。日本語の画面', () => {
    expect(dig(LOCAL_CONFIG, 'bundle.targets')).toEqual(['nsis']);
    expect(dig(LOCAL_CONFIG, 'bundle.windows.nsis.installMode')).toBe('currentUser');
    expect(dig(LOCAL_CONFIG, 'bundle.windows.nsis.languages')).toEqual(['Japanese']);
  });

  it('公開鍵は、アプリの定数（署名を確かめる）と、Actions の設定（署名の鍵と照らす）で、同じ値', () => {
    const rust = read('apps', 'desktop', 'src-tauri', 'src', 'update', 'config.rs');
    const match = /UPDATE_PUBLIC_KEY: &str =\s*"([^"]*)";/.exec(rust);
    expect(match, 'config.rs に UPDATE_PUBLIC_KEY の定数がある').not.toBeNull();
    const constant = (match as RegExpExecArray)[1] as string;
    const configured = dig(RELEASE_CONFIG, 'plugins.updater.pubkey');
    expect(configured).toBe(constant);
    // 入れたなら、署名の鍵の組の公開鍵（.pub の中身）の形
    if (constant !== '') expect(constant).toMatch(/^dW50cnVzdGVkIGNvbW1lbnQ6[A-Za-z0-9+/=]{80,}$/);
  });
});

describe('版の番号', () => {
  /** Cargo.toml の `[package]` の version。 */
  function cargoVersion(): string {
    const toml = read('apps', 'desktop', 'src-tauri', 'Cargo.toml');
    const section = toml.split('\n[')[0] as string;
    const match = /^version = "([^"]+)"$/m.exec(section);
    expect(match).not.toBeNull();
    return (match as RegExpExecArray)[1] as string;
  }

  it('tauri.conf.json・Cargo.toml（本体）・package.json（検討画面）が、同じ版で、semver の形', () => {
    const tauri = LOCAL_CONFIG.version as string;
    const pkg = JSON.parse(read('apps', 'desktop', 'package.json')).version as string;
    expect(tauri).toMatch(/^\d+\.\d+\.\d+$/);
    expect(cargoVersion()).toBe(tauri);
    expect(pkg).toBe(tauri);
    // Cargo.lock の本体の版も同じ（lock を直し忘れて、ビルドで書き換わるのを防ぐ）
    const lock = read('apps', 'desktop', 'src-tauri', 'Cargo.lock');
    expect(lock).toContain(`name = "jantama-reviewer"\nversion = "${tauri}"`);
  });
});
