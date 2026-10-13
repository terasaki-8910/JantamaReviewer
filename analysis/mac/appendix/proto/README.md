# 確かめ用の雛形（macOS）

macOS 版の調べ（`../../README.md`）で書いた、小さな Rust のプログラム。**製品のコードではなく、リポジトリの製品の一部でもない**
（`[workspace]` を空で持ち、`apps/desktop/src-tauri` の Cargo ワークスペースとは別）。

状態: **型検査だけ通した。実機では動かしていない。** `cargo check` と `cargo clippy` が `aarch64-apple-darwin` で警告なしに通る
（Windows の機械で zig cc を使って確かめた。手順は `../cross-check.md`）。動かしたときの挙動（許可の出方、窓の見つかり方、
撮影の遅れ、文字認識の読み間違い）は分かっていない。Mac で動かして確かめるためのもの（手順は `../mac-steps.md` の B）。

| ファイル | 中身 | Windows の何にあたるか |
| --- | --- | --- |
| `src/hook_mac.rs`（199 行） | CGEventTap。専用スレッドの実行ループ、割り当てたボタンの横取り（`Drop`）、止められたタップの再有効化、許可の状態 | `input/src/hook_win.rs`（390 行） |
| `src/capture_mac.rs`（152 行） | 窓の一覧（`CGWindowListCopyWindowInfo`）、画面の長方形の 1 枚撮り（`SCScreenshotManager::captureImageInRect`）、画素の取り出し | `src/capture_win.rs`（305 行） |
| `src/ocr_mac.rs`（55 行） | Vision の日本語の文字認識。行を上から順に並べる | `ocr/src/winrt.rs` の認識の部分 |
| `src/main.rs`（192 行） | 確かめ用の入り口（`perm`・`windows`・`tap`・`shot`・`ocr`） | なし |

製品にするときの差: 設定の変更（フックの入れ替え）、判定（`jantama_input::logic`）との接続、`Capturer` の trait への差し込み、
`captureImageInRect` が使えない版（15.2 より前のはず。未確認）向けの撮影、切り出し・拡大・コントラスト（既存の純粋な計算）との接続は、まだ無い。
