#!/usr/bin/env node
/**
 * macOS 向けの型検査と clippy（-D warnings）を、Windows の機械で動かす（`pnpm check:mac`。`pnpm lint` にも入っている）。
 *
 *   node scripts/check-mac.mjs [check-mac.ps1 に渡す引数 -Tool check など]
 *
 * 中身は scripts/check-mac.ps1（zig を C コンパイラにして、cargo clippy --target aarch64-apple-darwin を動かす）。
 * 要るもの: `winget install zig.zig` と `rustup target add aarch64-apple-darwin`（ps1 の先頭に書いてある）。
 * Windows 以外の機械（Mac を含む）では、その機械の `cargo clippy`（`pnpm lint:clippy`）が macOS 向けの検査そのものなので、何もしない。
 */
import { spawnSync } from 'node:child_process';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

if (process.platform !== 'win32') {
  console.log('check:mac: Windows 以外の機械では、lint:clippy が macOS 向けの検査を兼ねるので、何もしません。');
  process.exit(0);
}

const script = join(dirname(fileURLToPath(import.meta.url)), 'check-mac.ps1');
const result = spawnSync(
  'powershell',
  ['-NoProfile', '-File', script, ...process.argv.slice(2)],
  { stdio: 'inherit' },
);
if (result.error) {
  console.error(`check:mac: powershell を動かせませんでした: ${result.error.message}`);
  process.exit(1);
}
process.exit(result.status ?? 1);
