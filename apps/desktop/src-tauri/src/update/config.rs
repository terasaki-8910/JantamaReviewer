//! 更新の取り先と、更新の署名を確かめる公開鍵（F21）。更新の設定は、ここの 2 つの定数だけ。
//!
//! tests/safety.rs の S-2 が、この 2 つの定数の形（取り先は https の github.com だけ、鍵は空か minisign の公開鍵）と、
//! URL をソースに書いてよい場所がこのファイルだけであることを確かめる。

/// 更新の情報（latest.json）の置き場所。GitHub の Releases の「最新の版」に付いた latest.json。
///
/// 版のタグ（`v0.2.0` の形）を push すると、GitHub Actions（`.github/workflows/release.yml`）が、署名つきのインストーラーと
/// latest.json を作って Releases に置く。latest.json の中の、インストーラーの置き場所（github.com から、Releases のファイルを置く
/// `*.githubusercontent.com` へ移される）も、署名を確かめられたものだけを入れ直す。リポジトリが非公開のあいだは、ここから取れない。
pub const UPDATE_ENDPOINT: &str =
    "https://github.com/terasaki-8910/JantamaReviewer/releases/latest/download/latest.json";

/// 更新の署名を確かめる公開鍵。`pnpm --filter @jantama/desktop tauri signer generate -w <秘密鍵のファイル>` が作る組の、
/// 公開鍵のファイル（`.pub`）の中身を、1 行のまま、そのまま入れる（`dW50cnVzdGVkIGNvbW1lbnQ6` で始まる文字）。
///
/// 空のあいだは、更新の仕組みが「まだ設定されていません」の状態で、通信も入れ直しもしない（アプリは、そのまま動く）。
/// 入れたら、`apps/desktop/src-tauri/tauri.release.conf.json` の `plugins.updater.pubkey` にも、同じ値を入れる
/// （Actions の組み立てが、署名に使う秘密鍵と照らす。2 つが同じ値であることは、apps/desktop/tests/release-config.test.ts が確かめる）。
/// 秘密鍵とその合言葉は、リポジトリに入れない（GitHub の Secrets の `TAURI_SIGNING_PRIVATE_KEY`・`TAURI_SIGNING_PRIVATE_KEY_PASSWORD` だけ）。
pub const UPDATE_PUBLIC_KEY: &str =
    "dW50cnVzdGVkIGNvbW1lbnQ6IG1pbmlzaWduIHB1YmxpYyBrZXk6IEZCMTIzN0ZBRkZFOTVDREMKUldUY1hPbi8ramNTK3pzYzBKU1dKajdPNTJGYUZld1p4RGJ1T3FmcmVJb3dnNWFTOEVGdUd4aisK";
