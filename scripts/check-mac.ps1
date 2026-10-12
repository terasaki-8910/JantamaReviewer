# Windows の機械で、macOS 向けの型検査と clippy（-D warnings）を動かす。リンクと実行はしない。
# 既定の動き（pnpm check:mac。pnpm lint にも入っている）: 製品の全クレートを、試験の分も含めて clippy にかける。
#
# 使い方（リポジトリのルートで）:
#   pnpm check:mac                                                   # 全クレートの clippy（-D warnings）
#   powershell -NoProfile -File scripts/check-mac.ps1 -Tool check     # 型検査だけ（速い）
#   powershell -NoProfile -File scripts/check-mac.ps1 -Package jantama-input   # 1 クレートだけ
#
# 要るもの（1 回だけ）:
#   winget install zig.zig                      （0.16 で確かめた。C で書かれた依存を組む C コンパイラの代わり）
#   rustup target add aarch64-apple-darwin      （標準ライブラリだけが入る。macOS の SDK は要らない）
# C で書かれた依存（rusqlite の SQLite、objc2 の小さな C ファイル）を zig cc で組む。型検査だけなので、
# フレームワークへのリンクは起きない（リンクと実行は、Mac でしか確かめられない）。
# 成果物は apps/desktop/src-tauri/target/aarch64-apple-darwin に置く（Windows 向けの成果物とは別）。
# 初めては依存を組むので 2 分ほど、2 回目からは 10 秒ほど。
param(
    [string]$Package = '',
    [ValidateSet('check', 'clippy')][string]$Tool = 'clippy',
    [string]$Target = 'aarch64-apple-darwin',
    [string]$TargetDir = ''
)

function Stop-WithMessage([string]$Message) {
    [Console]::Error.WriteLine($Message)
    exit 1
}

if (-not (Get-Command zig -ErrorAction SilentlyContinue)) {
    Stop-WithMessage 'zig が見つかりません。macOS 向けの検査には zig が要ります: winget install zig.zig（入れたら、ターミナルを開き直す）'
}
if (Get-Command rustup -ErrorAction SilentlyContinue) {
    $installed = @(& rustup target list --installed)
    if ($installed -notcontains $Target) {
        Stop-WithMessage "Rust のターゲット $Target が入っていません: rustup target add $Target"
    }
}

$here = Split-Path -Parent $MyInvocation.MyCommand.Path
$root = Resolve-Path (Join-Path $here '..')
$manifest = Join-Path $root 'apps\desktop\src-tauri\Cargo.toml'
$wrappers = Join-Path $here 'check-mac'

$triple = $Target.Replace('-', '_')
Set-Item -Path "Env:CC_$triple" -Value (Join-Path $wrappers 'zigcc.cmd')
Set-Item -Path "Env:AR_$triple" -Value (Join-Path $wrappers 'zigar.cmd')
$env:CRATE_CC_NO_DEFAULTS = '1'
if ($TargetDir -ne '') { $env:CARGO_TARGET_DIR = $TargetDir }

$cargoArgs = @($Tool, '--manifest-path', $manifest, '--target', $Target, '--all-targets')
if ($Package -ne '') { $cargoArgs += @('-p', $Package) } else { $cargoArgs += '--workspace' }
if ($Tool -eq 'clippy') { $cargoArgs += @('--', '-D', 'warnings') }

Write-Host "cargo $($cargoArgs -join ' ')"
& cargo @cargoArgs
exit $LASTEXITCODE
