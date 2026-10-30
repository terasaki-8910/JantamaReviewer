// @vitest-environment node
/**
 * 配る仕組み（F21、U-51）の設定の静的検査。Actions そのものは動かせない（ユーザーが、タグを push して確かめる）ので、
 * 設定ファイルが、決めた形になっていることを、機械で確かめる。
 * - タグ（v*）の push で、Windows と Mac の Actions が、署名つきのインストーラー（Windows は NSIS、Mac は .dmg と更新用の .app.tar.gz）と
 *   latest.json を Releases に置く形になっている。手で動かしたとき（workflow_dispatch）は、Releases に置かず、Artifacts に置く
 * - 更新の署名のファイルを作る設定（createUpdaterArtifacts）は Actions だけの設定（tauri.release.conf.json）に、補助プログラムを入れる設定（resources）は
 *   Windows の Actions だけの設定（tauri.release.windows.conf.json）に、Mac の ad-hoc の署名は Mac の Actions だけの設定（tauri.release.macos.conf.json）にあり、
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
const RELEASE_WINDOWS_CONFIG = json('apps', 'desktop', 'src-tauri', 'tauri.release.windows.conf.json');
const RELEASE_MACOS_CONFIG = json('apps', 'desktop', 'src-tauri', 'tauri.release.macos.conf.json');
const LOCAL_MACOS_CONFIG = json('apps', 'desktop', 'src-tauri', 'tauri.macos.conf.json');

/** matrix の、この OS の行（`- platform:` の行から、次のコメント・次の OS・matrix の外の手前まで）。 */
function matrixEntry(platform: string): string {
  const start = WORKFLOW.indexOf(`- platform: ${platform}\n`);
  expect(start, `matrix に ${platform} が無い`).toBeGreaterThanOrEqual(0);
  const rest = WORKFLOW.slice(start + 1);
  const next = rest.search(/\n\s*(- platform:|#)|\n {4}\S/);
  return next < 0 ? rest : rest.slice(0, next);
}

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
  it('タグ v* の push と、手で動かしたときに動き、Windows と Mac の上で、Releases に置く権限を持つ', () => {
    expect(WORKFLOW).toMatch(/^on:\n {2}push:\n {4}tags:\n {6}- 'v\*'\n {2}workflow_dispatch:\n/m);
    // タグのほかの push（ブランチ）では動かない
    expect(WORKFLOW).not.toMatch(/branches:/);
    expect(WORKFLOW).toContain('runs-on: ${{ matrix.platform }}');
    expect(matrixEntry('windows-latest')).toBeTruthy();
    // Mac は Apple Silicon のランナー（macos-latest）で作る
    expect(matrixEntry('macos-latest')).toBeTruthy();
    // 片方の OS が落ちても、もう片方は置く
    expect(WORKFLOW).toMatch(/^ {6}fail-fast: false$/m);
    expect(WORKFLOW).toMatch(/^permissions:\n {2}contents: write$/m);
  });

  it('OS ごとに、Actions だけの設定を渡す（Windows は補助プログラム、Mac は ad-hoc の署名と .dmg）', () => {
    const windows = matrixEntry('windows-latest');
    expect(windows).toContain(
      'args: --config src-tauri/tauri.release.conf.json --config src-tauri/tauri.release.windows.conf.json',
    );
    expect(windows).not.toContain('macos');
    const mac = matrixEntry('macos-latest');
    expect(mac).toContain(
      'args: --config src-tauri/tauri.release.conf.json --config src-tauri/tauri.release.macos.conf.json --bundles app,dmg',
    );
    expect(mac).not.toContain('windows');
    expect(WORKFLOW).toMatch(/^ {10}args: \$\{\{ matrix\.args \}\}$/m);
  });

  it('手で動かしたとき（タグが無い）は、Releases に置かず、できた物を Artifacts に置く', () => {
    expect(WORKFLOW).toContain("tagName: ${{ github.ref_type == 'tag' && github.ref_name || '' }}");
    const at = indexOfStep('uses: actions/upload-artifact@');
    const step = WORKFLOW.slice(WORKFLOW.lastIndexOf('- name:', at));
    expect(step).toMatch(/^- name: [^\n]+\n {8}if: github\.ref_type != 'tag'\n/);
    expect(step).toContain('bundle/nsis/*-setup.exe');
    expect(step).toContain('bundle/dmg/*.dmg');
    expect(step).toContain('bundle/macos/*.app.tar.gz');
    expect(step).toContain('if-no-files-found: error');
    // tauri-action のあと（作り終えてから置く）
    expect(indexOfStep('uses: tauri-apps/tauri-action@')).toBeLessThan(at);
  });

  it('tauri-action に、署名の秘密鍵と合言葉を Secrets から渡し、latest.json を NSIS に向けて置く', () => {
    expect(WORKFLOW).toMatch(/uses: tauri-apps\/tauri-action@v\d+\n/);
    expect(WORKFLOW).toContain('TAURI_SIGNING_PRIVATE_KEY: ${{ secrets.TAURI_SIGNING_PRIVATE_KEY }}');
    expect(WORKFLOW).toContain(
      'TAURI_SIGNING_PRIVATE_KEY_PASSWORD: ${{ secrets.TAURI_SIGNING_PRIVATE_KEY_PASSWORD }}',
    );
    expect(WORKFLOW).toContain('GITHUB_TOKEN: ${{ secrets.GITHUB_TOKEN }}');
    expect(WORKFLOW).toContain("releaseName: 'JantamaReviewer v__VERSION__'");
    expect(WORKFLOW).toMatch(/^ {10}releaseDraft: false$/m);
    expect(WORKFLOW).toMatch(/^ {10}includeUpdaterJson: true$/m);
    expect(WORKFLOW).toMatch(/^ {10}updaterJsonPreferNsis: true$/m);
    expect(WORKFLOW).toContain('projectPath: apps/desktop');
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

  it('依存を frozen で入れ、補助プログラムを release で作ってから（Windows だけ）、tauri-action を動かす', () => {
    const install = indexOfStep('pnpm install --frozen-lockfile');
    const helper = indexOfStep('cargo build --release --manifest-path apps/desktop/src-tauri/Cargo.toml -p jantama-helper');
    const action = indexOfStep('uses: tauri-apps/tauri-action@');
    expect(install).toBeLessThan(helper);
    expect(helper).toBeLessThan(action);
    // 補助プログラムは Windows のものなので、Mac のジョブでは作らない
    const helperStep = WORKFLOW.slice(WORKFLOW.lastIndexOf('- name:', helper), helper);
    expect(helperStep).toContain("if: runner.os == 'Windows'");
    // Node と Rust の準備が、先にある
    expect(indexOfStep('uses: actions/setup-node@')).toBeLessThan(install);
    expect(indexOfStep('uses: dtolnay/rust-toolchain@stable')).toBeLessThan(helper);
  });

  it('公開鍵と、タグと版の食い違いは、組み立ての前に止める', () => {
    const guard = indexOfStep('plugins.updater.pubkey');
    expect(guard).toBeLessThan(indexOfStep('uses: tauri-apps/tauri-action@'));
    expect(WORKFLOW).toContain('UPDATE_PUBLIC_KEY');
    // タグと版を比べるのは、タグの push のときだけ（手で動かしたときは、タグが無い）
    expect(WORKFLOW).toContain("if ($env:REF_TYPE -eq 'tag' -and ('v' + $version -ne $env:TAG)) {");
    expect(WORKFLOW).toContain('REF_TYPE: ${{ github.ref_type }}');
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

  it('Actions だけの設定（tauri.release.conf.json）が署名のファイルを作り、Windows の設定が補助プログラムを本体と同じフォルダに入れる', () => {
    expect(dig(RELEASE_CONFIG, 'bundle.createUpdaterArtifacts')).toBe(true);
    // 共通の設定には、OS ごとのものを入れない（Mac の組み立てに、Windows の補助プログラムを探させない）
    expect(dig(RELEASE_CONFIG, 'bundle.resources')).toBeUndefined();
    expect(dig(RELEASE_CONFIG, 'bundle.macOS')).toBeUndefined();
    // 補助プログラムを、インストールするフォルダの直下（本体と同じ場所）に置く。本体は、本体の隣から補助プログラムを探す
    expect(RELEASE_WINDOWS_CONFIG).toEqual({
      $schema: 'https://schema.tauri.app/config/2',
      bundle: { resources: { 'target/release/jantama-helper.exe': 'jantama-helper.exe' } },
    });
    expect(typeof dig(RELEASE_CONFIG, 'plugins.updater.pubkey')).toBe('string');
    // 入れ込む補助プログラムは、Cargo の作業場所の release の出力（workflow が先に作る）
    expect(read('apps', 'desktop', 'src-tauri', 'helper', 'Cargo.toml')).toMatch(/\[\[bin\]\]\nname = "jantama-helper"/);
    expect(read('apps', 'desktop', 'src-tauri', 'input', 'src', 'setup.rs')).toContain(
      'pub const HELPER_EXE_NAME: &str = "jantama-helper.exe";',
    );
  });

  it('補助プログラムは、同じソースから同じ中身になるよう作る（/Brepro）。そうでないと、配るたびに「新しい補助プログラムがあります」が出る', () => {
    // 設定済みの写しとの比べは、中身（SHA-256）で行う（実行ファイルは、版の情報を持たない）。リンクの時刻が入ると、同じソースでも、毎回違う中身になる
    expect(read('apps', 'desktop', 'src-tauri', 'helper', 'build.rs')).toContain('cargo:rustc-link-arg-bins=/Brepro');
    expect(read('apps', 'desktop', 'src-tauri', 'src', 'platform', 'win', 'helper_setup.rs')).toContain('Sha256');
  });

  it('Mac の Actions だけの設定は、ad-hoc の署名だけ。手元の Mac の設定（自分の証明書で署名する）には入れない', () => {
    // ad-hoc（「-」）は、証明書なしで .app 全体に署名する。署名が無いと、Apple Silicon では「壊れている」と出て開けない
    expect(RELEASE_MACOS_CONFIG).toEqual({
      $schema: 'https://schema.tauri.app/config/2',
      bundle: { macOS: { signingIdentity: '-' } },
    });
    // 手元の Mac での組み立て（pnpm build:mac）は、APPLE_SIGNING_IDENTITY の自分の証明書で署名する（analysis/mac の A-4）
    expect(hasKey(LOCAL_MACOS_CONFIG, 'signingIdentity')).toBe(false);
    expect(dig(LOCAL_MACOS_CONFIG, 'bundle.macOS.minimumSystemVersion')).toBe('14.0');
  });

  it('手元の組み立ての命令（pnpm のスクリプト）は、Actions だけの設定を使わない', () => {
    const scripts = JSON.parse(read('package.json')).scripts as Record<string, string>;
    for (const [name, command] of Object.entries(scripts)) {
      expect(command, name).not.toContain('tauri.release.');
    }
    const desktop = JSON.parse(read('apps', 'desktop', 'package.json')).scripts as Record<string, string>;
    for (const [name, command] of Object.entries(desktop)) {
      expect(command, name).not.toContain('tauri.release.');
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
