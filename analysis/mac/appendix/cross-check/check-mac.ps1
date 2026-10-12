# Windows の機械で、macOS 向けの型検査（cargo check / clippy）を動かす。リンクと実行はしない。
#
# 使い方（リポジトリのルートで）:
#   powershell -File analysis/mac/appendix/cross-check/check-mac.ps1                          # 製品の全クレート
#   powershell -File analysis/mac/appendix/cross-check/check-mac.ps1 -Package jantama-input   # 1 クレートだけ
#   powershell -File analysis/mac/appendix/cross-check/check-mac.ps1 -Tool clippy
#
# 要るもの: rustup target add aarch64-apple-darwin、zig（winget install zig.zig。0.16 で確かめた）。
# C で書かれた依存（rusqlite の SQLite、objc2 の小さな C ファイル）を zig cc で組む。macOS の SDK は要らない
# （型検査だけなので、フレームワークへのリンクは起きない）。
param(
    [string]$Package = '',
    [ValidateSet('check', 'clippy')][string]$Tool = 'check',
    [string]$Target = 'aarch64-apple-darwin',
    [string]$TargetDir = ''
)

$here = Split-Path -Parent $MyInvocation.MyCommand.Path
$root = Resolve-Path (Join-Path $here '..\..\..\..')
$manifest = Join-Path $root 'apps\desktop\src-tauri\Cargo.toml'

$triple = $Target.Replace('-', '_')
Set-Item -Path "Env:CC_$triple" -Value (Join-Path $here 'zigcc.cmd')
Set-Item -Path "Env:AR_$triple" -Value (Join-Path $here 'zigar.cmd')
$env:CRATE_CC_NO_DEFAULTS = '1'
if ($TargetDir -ne '') { $env:CARGO_TARGET_DIR = $TargetDir }

$cargoArgs = @($Tool, '--manifest-path', $manifest, '--target', $Target, '--all-targets')
if ($Package -ne '') { $cargoArgs += @('-p', $Package) } else { $cargoArgs += '--workspace' }
if ($Tool -eq 'clippy') { $cargoArgs += @('--', '-D', 'warnings') }

Write-Host "cargo $($cargoArgs -join ' ')"
& cargo @cargoArgs
exit $LASTEXITCODE
