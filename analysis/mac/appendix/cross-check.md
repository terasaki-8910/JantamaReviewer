# Windows の機械で macOS 向けの型検査をする（2026-10-12 に試した結果）

Mac は無いので、`cargo check --target aarch64-apple-darwin` をこの機械（Windows 11）で動かせるかを試した。
道具は最初 `cross-check/` に置いた（`zigcc.cmd`・`zigar.cmd`・`check-mac.ps1`）。段階 1（R14-5）で `scripts/check-mac.ps1` と `scripts/check-mac/`（`pnpm check:mac`。`pnpm lint` にも入っている）へ移した。この文書の結果は、試した時点（段階 1 の前）のもの。

## 環境

- rustc 1.96.0、`rustup target add aarch64-apple-darwin` は成功した（標準ライブラリだけが入る。SDK は入らない）。
- zig 0.16.0（winget で入っているもの）。C のコンパイラの代わりに使う。
- 依存の版（Cargo.lock のまま）: tauri 2.12.2、tao 0.37.1、wry 0.57.0、objc2 0.6.5、core-graphics 0.25.0。

## 結果

| 対象 | 結果 | 意味 |
| --- | --- | --- |
| `-p jantama-input` | 通る | 判定・キー表・連絡の決まり・補助プログラムの設定の文字列作りは、そのまま macOS 向けに型が合う |
| `-p jantama-ocr` | 通る | 通るのは Windows 以外の枝（切り出し・拡大の純粋な計算。`winrt` は `cfg(windows)` で外れる） |
| `-p jantama-helper` | 通る | 「Windows 専用です」と出して終わる枝だけが組まれる |
| `-p jantama-reviewer`（C コンパイラ無し） | 失敗 | 依存の build.rs（`objc2-exception-helper`・`libsqlite3-sys`）が C のコンパイラを要する |
| `-p jantama-reviewer`（`zig cc` を C コンパイラにする） | 依存はすべて通り、本体で 21 件のエラー | tauri・tao・wry・objc2・rusqlite（同梱の SQLite の C）まで、macOS 向けに型検査できた |
| 確かめ用の雛形（`proto/`）の `check` と `clippy` | 通る | CGEventTap・窓の一覧・ScreenCaptureKit の 1 枚撮り・Vision の日本語認識の呼び方が、いまの束縛の型に合う |

`zig cc` を使う理由: `objc2-exception-helper` の C ファイルはヘッダを読まない作りで、`libsqlite3-sys` の C は標準の C だけで足りる。
どちらも macOS の SDK 無しで組める。`CRATE_CC_NO_DEFAULTS=1` を付けて、cc クレートが足す clang 用の旗を止めている。

## 本体の 21 件（macOS に寄せる前の状態）

1 件目は意図した `compile_error!("JantamaReviewer は Windows 専用です。")`（`src/lib.rs`）。残り 20 件は、Windows の部品を外さずに使っている場所:

```
src/helper_setup.rs  67,74   std::os::windows（CommandExt::creation_flags）
src/trash.rs         142-147,173   WindowsRecycler（SHFileOperationW、encode_wide）
src/import/ocr_job.rs 27     jantama_ocr::OcrWorker（Windows のときだけ公開）
src/lib.rs           60,62   WindowsSound、apply_native_style
src/commands.rs      647-712 helper_setup::{install, uninstall, query_installed, run_task}（Windows のときだけ）
src/import/commands.rs 42    clipboard::read_text（Windows のときだけ）
```

`compile_error!` を外して試すと 24 件になり、`capture_win`・`helper_link`・`input_effects` の 3 つの Windows 専用モジュールが
`lib.rs` から無条件に読まれていることも出る。つまり macOS に寄せる作業の入り口は「約 10 か所・8 ファイル」で、数えやすい。

## これで分かること・分からないこと

分かる: cfg の付け忘れ、型の不一致、束縛（objc2・core-graphics）の関数名と引数の取り違え、`clippy -D warnings`、`--all-targets` による試験の型検査。
分からない: リンク（フレームワーク）、実行、許可（TCC）、窓の挙動、Objective-C の例外、スレッドと実行ループ、実行時の OS の版による API の有無
（たとえば、後から足された `captureImageInRect`。版は macOS 15.2 以降のはずだが、Apple の文書では確かめていない）。`cargo test` はリンクが要るので、この機械では動かせない。

## 使い方

```
pnpm check:mac                                                            # 全クレートの clippy（-D warnings。pnpm lint にも入っている）
powershell -NoProfile -File scripts/check-mac.ps1 -Tool check             # 型検査だけ
powershell -NoProfile -File scripts/check-mac.ps1 -Package jantama-input
```

`-TargetDir` で成果物の置き場を変えられる（既定は `apps/desktop/src-tauri/target`、git の対象外）。段階 1 で、
このスクリプトを `scripts/` に移して `pnpm lint` に足し、機械の関門にした。
