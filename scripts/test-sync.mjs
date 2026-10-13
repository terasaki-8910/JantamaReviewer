#!/usr/bin/env node
/**
 * 同期（F15、D-4）の手動の試験: 本物の同期の部品（turso クレート）を、この PC の中の `tursodb --sync-server` に向けて動かす。
 *
 *   pnpm test:sync            # 試験用の同期サーバー（公式の tursodb）を取ってきて、試験を動かす
 *   node scripts/test-sync.mjs --fetch-only   # サーバーを取ってくるだけ
 *
 * - 試験用のサーバーは、公式のリリース（Turso の GitHub。クレートの版とそろえた 0.8.2）の実行ファイル。一時フォルダ
 *   （既定は OS の一時フォルダの `jantama-tursodb-0.8.2`。環境変数 JANTAMA_TURSODB_DIR で変えられる）に取ってきて、
 *   公式の SHA-256 と照らす。リポジトリには入れない。
 * - 試験は、一時フォルダだけを使い、本物のデータ（%USERPROFILE%\JantamaReviewerData）にも、本物の資格情報にも、Turso Cloud にも触れない。
 *   通信は、この PC の中（127.0.0.1）だけ。
 * - OS の資格情報の保管庫の試験（試験用の名前で作り物の文字を入れて、取り出して、消す）も、ここで動かす。
 * - `pnpm test` には含めない（pnpm test:hook と同じ、手動の試験）。
 */
import { spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { existsSync, mkdirSync, readdirSync, statSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const VERSION = '0.8.2';
const RELEASE = `https://github.com/tursodatabase/turso/releases/download/v${VERSION}`;
const root = join(dirname(fileURLToPath(import.meta.url)), '..');

/** この PC の実行ファイルの名前（公式のリリースの名前）。 */
function assetName() {
  const key = `${process.platform}-${process.arch}`;
  const names = {
    'win32-x64': 'turso_cli-x86_64-pc-windows-msvc.zip',
    'darwin-arm64': 'turso_cli-aarch64-apple-darwin.tar.xz',
    'darwin-x64': 'turso_cli-x86_64-apple-darwin.tar.xz',
    'linux-x64': 'turso_cli-x86_64-unknown-linux-gnu.tar.xz',
  };
  const name = names[key];
  if (!name) throw new Error(`この環境（${key}）の同期サーバーの実行ファイルを知りません`);
  return name;
}

function findBinary(dir) {
  const wanted = process.platform === 'win32' ? 'tursodb.exe' : 'tursodb';
  for (const entry of readdirSync(dir)) {
    const path = join(dir, entry);
    if (statSync(path).isDirectory()) {
      const found = findBinary(path);
      if (found) return found;
    } else if (entry === wanted) {
      return path;
    }
  }
  return null;
}

async function download(url) {
  const response = await fetch(url, { redirect: 'follow' });
  if (!response.ok) throw new Error(`${url}: HTTP ${response.status}`);
  return Buffer.from(await response.arrayBuffer());
}

/** 試験用の同期サーバー（tursodb）の場所。無ければ、取ってきて、公式の SHA-256 と照らして、展開する。 */
export async function ensureTursodb() {
  const dir = process.env.JANTAMA_TURSODB_DIR ?? join(tmpdir(), `jantama-tursodb-${VERSION}`);
  mkdirSync(dir, { recursive: true });
  const existing = existsSync(dir) ? findBinary(dir) : null;
  if (existing) return existing;
  const asset = assetName();
  console.log(`同期サーバー（tursodb ${VERSION}）を取ってきます: ${RELEASE}/${asset}`);
  const archive = await download(`${RELEASE}/${asset}`);
  const sums = (await download(`${RELEASE}/${asset}.sha256`)).toString('utf8');
  const expected = sums.trim().split(/\s+/)[0]?.toLowerCase();
  const actual = createHash('sha256').update(archive).digest('hex');
  if (!expected || expected !== actual) {
    throw new Error(`SHA-256 が合いません（公式 ${expected}、取ったもの ${actual}）`);
  }
  const file = join(dir, asset);
  writeFileSync(file, archive);
  // zip は PowerShell で（Git Bash の tar は、C: を遠隔の機械の名前と読んで、失敗するため）。tar.xz は tar で
  const extract = asset.endsWith('.zip')
    ? spawnSync(
        'powershell',
        ['-NoProfile', '-Command', `Expand-Archive -LiteralPath '${file}' -DestinationPath '${dir}' -Force`],
        { stdio: 'inherit' },
      )
    : spawnSync('tar', ['-xJf', file, '-C', dir], { stdio: 'inherit' });
  if (extract.status !== 0) throw new Error('展開できませんでした');
  const binary = findBinary(dir);
  if (!binary) throw new Error('展開したものの中に、tursodb が見つかりません');
  return binary;
}

function run(command, args, env = {}) {
  const result = spawnSync(command, args, {
    cwd: root,
    stdio: 'inherit',
    env: { ...process.env, ...env },
  });
  return result.status ?? 1;
}

const binary = await ensureTursodb();
console.log(`同期サーバー: ${binary}`);
if (process.argv.includes('--fetch-only')) process.exit(0);

const manifest = join(root, 'apps', 'desktop', 'src-tauri', 'Cargo.toml');
const env = { JANTAMA_TURSODB: binary };
let status = run(
  'cargo',
  ['test', '--manifest-path', manifest, '--test', 'sync_integration', '--', '--ignored', '--nocapture', '--test-threads=1'],
  env,
);
if (status === 0) {
  status = run('cargo', [
    'test',
    '--manifest-path',
    manifest,
    '--lib',
    'sync::credentials',
    '--',
    '--ignored',
    '--nocapture',
  ]);
}
process.exit(status);
