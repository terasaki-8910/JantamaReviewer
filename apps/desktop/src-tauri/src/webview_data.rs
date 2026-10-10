//! WebView2 のデータ（画面の保存領域・Cookie・キャッシュ）の置き場所。
//!
//! - 試しに動かすとき（環境変数 `JANTAMA_CONFIG_DIR` があるとき）は、検討画面とウィジェットのデータも、その設定フォルダの
//!   下に置く。設定と記録を一時フォルダにしても、WebView2 のデータだけは本物のアプリの場所（%LOCALAPPDATA% の下）を使っていて、
//!   試しの操作（テーマや、知らせた牌譜リンクの記録）が、ふだん使うアプリに混ざっていたため。ふだんは Tauri の既定の場所。
//! - mjai の窓は、いつもアプリの画面とは別の場所にする。外のサイト（mjai・Cloudflare）の保存領域を、アプリの画面と混ぜず、
//!   ブラウザのプロセスも分けるため。

use std::ffi::OsString;
use std::path::{Path, PathBuf};

/// 試しに動かすときの、検討画面とウィジェットの WebView2 のデータのフォルダ名（設定フォルダの下）。
pub const APP_WEBVIEW_DIR: &str = "webview";
/// mjai の窓の WebView2 のデータのフォルダ名（設定フォルダか、アプリのローカルのデータフォルダの下）。
pub const MJAI_WEBVIEW_DIR: &str = "webview-mjai";

/// 環境変数 `JANTAMA_CONFIG_DIR` の値（空なら無いのと同じ）。
pub fn config_env() -> Option<OsString> {
    std::env::var_os(crate::CONFIG_DIR_ENV).filter(|value| !value.is_empty())
}

/// 検討画面とウィジェットのデータの場所。試しに動かすとき（`config_env` が有る）だけ、その下。ふだんは `None`（Tauri の既定）。
pub fn app_webview_dir(config_env: Option<OsString>) -> Option<PathBuf> {
    config_env
        .filter(|value| !value.is_empty())
        .map(|dir| PathBuf::from(dir).join(APP_WEBVIEW_DIR))
}

/// mjai の窓のデータの場所。試しに動かすときは設定フォルダの下、ふだんはアプリのローカルのデータフォルダの下。
/// どちらも分からなければ `None`（そのときは窓を作る側が、アプリの画面と同じ既定の場所を使う）。
pub fn mjai_webview_dir(
    config_env: Option<OsString>,
    app_local_data: Option<&Path>,
) -> Option<PathBuf> {
    match config_env.filter(|value| !value.is_empty()) {
        Some(dir) => Some(PathBuf::from(dir).join(MJAI_WEBVIEW_DIR)),
        None => app_local_data.map(|dir| dir.join(MJAI_WEBVIEW_DIR)),
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn trial_runs_keep_the_app_webview_data_under_the_trial_config_folder() {
        assert_eq!(
            app_webview_dir(Some(OsString::from(r"C:\tmp\jr"))),
            Some(PathBuf::from(r"C:\tmp\jr").join(APP_WEBVIEW_DIR))
        );
        // ふだん（環境変数が無い・空）は、Tauri の既定の場所のまま。
        assert_eq!(app_webview_dir(None), None);
        assert_eq!(app_webview_dir(Some(OsString::new())), None);
    }

    #[test]
    fn the_mjai_window_always_gets_its_own_webview_data_folder() {
        let local = PathBuf::from(r"C:\Users\u\AppData\Local\app");
        // ふだんは、アプリのローカルのデータフォルダの下の、画面とは別のフォルダ。
        assert_eq!(
            mjai_webview_dir(None, Some(&local)),
            Some(local.join(MJAI_WEBVIEW_DIR))
        );
        // 試しに動かすときは、設定フォルダの下（本物のアプリの場所には触れない）。
        assert_eq!(
            mjai_webview_dir(Some(OsString::from(r"C:\tmp\jr")), Some(&local)),
            Some(PathBuf::from(r"C:\tmp\jr").join(MJAI_WEBVIEW_DIR))
        );
        assert_eq!(mjai_webview_dir(None, None), None);
        // アプリの画面のデータとは、どちらの場合も違う場所。
        assert_ne!(
            mjai_webview_dir(Some(OsString::from(r"C:\tmp\jr")), None),
            app_webview_dir(Some(OsString::from(r"C:\tmp\jr")))
        );
    }
}
