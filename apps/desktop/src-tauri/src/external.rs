//! 外部のブラウザで URL を開く（N-5）。
//!
//! 画面の遷移・新しい窓・ダウンロードの要求（`navigation.rs` の決まり）を、Tauri の窓のフックにつなぐ。
//! 外部の Web ページ（http / https）へのリンクをクリックしたときだけ、既定のブラウザで開く。
//! 開く部品（tauri-plugin-opener）は、プラグインとして登録せずにこのファイルからだけ呼ぶ
//! （画面側からは呼べない。`tests/safety.rs` が、ほかのソースがこの部品を使っていないことを確かめる）。
//! 開くのは `navigation::is_external_web_page` を通った URL だけで、ファイルやアプリの実行は開かない。

use tauri::webview::DownloadEvent;
use url::Url;

use crate::navigation::{
    allow_download, decide_navigation, decide_new_window, is_external_web_page, AppOrigins,
    NavigationDecision, NewWindowDecision,
};

/// 既定のブラウザで開く。窓の処理を止めないよう、別のスレッドで開く。
/// 外部の Web ページでなければ何もしない（呼び出し側の取りこぼしに備えた二重の確認）。
pub fn open_in_default_browser(url: &Url) {
    if !is_external_web_page(url) {
        return;
    }
    let target = url.to_string();
    let spawned = std::thread::Builder::new()
        .name("open-external".to_string())
        .spawn(move || {
            if let Err(e) = tauri_plugin_opener::open_url(&target, None::<&str>) {
                eprintln!("既定のブラウザで開けませんでした: {e}");
            }
        });
    if let Err(e) = spawned {
        eprintln!("ブラウザを開くスレッドを起こせませんでした: {e}");
    }
}

/// 窓の遷移のフック（`on_navigation`）の判定。`true` で読み込み、`false` で取り消す。
/// 外部の Web ページなら、取り消したうえで `open` に渡す。
pub fn navigation_hook(url: &Url, origins: &AppOrigins, open: &dyn Fn(&Url)) -> bool {
    match decide_navigation(url, origins) {
        NavigationDecision::Allow => true,
        NavigationDecision::OpenExternal => {
            open(url);
            false
        }
        NavigationDecision::Cancel => false,
    }
}

/// 新しい窓の要求のフック（`on_new_window`）の動き。窓はどの場合も作らない（呼び出し側が `Deny` を返す）。
/// 外部の Web ページなら、拒んだうえで `open` に渡す。
pub fn new_window_hook(url: &Url, origins: &AppOrigins, open: &dyn Fn(&Url)) {
    if decide_new_window(url, origins) == NewWindowDecision::DenyAndOpenExternal {
        open(url);
    }
}

/// ダウンロードのフック（`on_download`）の判定。始まる前の要求はすべて断る（N-6）。
/// 終わったという知らせには、何もしない（`true`）。
pub fn download_hook(event: &DownloadEvent<'_>) -> bool {
    match event {
        DownloadEvent::Requested { url, .. } => allow_download(url),
        _ => true,
    }
}
