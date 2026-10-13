//! WebView2 のデータ（画面の保存領域・Cookie・キャッシュ）の置き場所。
//!
//! - 試しに動かすとき（環境変数 `JANTAMA_CONFIG_DIR` があるとき）は、検討画面とウィジェットのデータも、その設定フォルダの
//!   下に置く。設定と記録を一時フォルダにしても、WebView2 のデータだけは本物のアプリの場所（%LOCALAPPDATA% の下）を使っていて、
//!   試しの操作（テーマや、知らせた牌譜リンクの記録）が、ふだん使うアプリに混ざっていたため。ふだんは Tauri の既定の場所。
//! - mjai の窓は、いつもアプリの画面とは別の場所にする。外のサイト（mjai・Cloudflare）の保存領域を、アプリの画面と混ぜず、
//!   ブラウザのプロセスも分けるため。
//!
//! macOS の WKWebView には、データのフォルダを選ぶ設定が無い。代わりに、保存領域を 16 バイトの識別子で分ける
//! （`data_store_identifier`。macOS 14 以降）。同じ分け方（試しに動かすときの検討画面と、いつもの mjai の窓）を、
//! フォルダの代わりに識別子で行う。識別子は、分けたい場所の名前から決まる値（同じ名前なら、いつも同じ識別子。
//! 保存領域が次の起動に残る）。

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

/// 保存領域の識別子（UUID の形の 16 バイト）。`kind`（どの窓か）と `seed`（分けたい場所の名前）が同じなら、いつも同じ値。
/// 暗号の強さは要らない（保存領域を区別するだけ）ので、FNV-1a を 2 回、別の初期値で回して 16 バイトにする。
fn store_id(kind: &str, seed: &str) -> [u8; 16] {
    fn fnv1a(basis: u64, parts: [&str; 2]) -> u64 {
        let mut hash = basis;
        for part in parts {
            for byte in part.bytes().chain(std::iter::once(0)) {
                hash ^= u64::from(byte);
                hash = hash.wrapping_mul(0x0000_0100_0000_01b3);
            }
        }
        hash
    }
    let high = fnv1a(0xcbf2_9ce4_8422_2325, [kind, seed]);
    let low = fnv1a(0x8422_2325_cbf2_9ce4, [kind, seed]);
    let mut id = [0u8; 16];
    id[..8].copy_from_slice(&high.to_be_bytes());
    id[8..].copy_from_slice(&low.to_be_bytes());
    // UUID の版（5）と型の印を付ける（`NSUUID` が受け付ける形にそろえる）。
    id[6] = (id[6] & 0x0f) | 0x50;
    id[8] = (id[8] & 0x3f) | 0x80;
    id
}

/// 検討画面とウィジェットの保存領域の識別子（macOS）。試しに動かすとき（`config_env` が有る）だけ、その設定フォルダの名前から決める。
/// ふだんは `None`（WKWebView の既定の保存領域）。`app_webview_dir` の識別子版。
pub fn app_data_store_id(config_env: Option<OsString>) -> Option<[u8; 16]> {
    config_env
        .filter(|value| !value.is_empty())
        .map(|dir| store_id("app", &dir.to_string_lossy()))
}

/// mjai の窓の保存領域の識別子（macOS）。アプリの画面とは、いつも別。試しに動かすときは、その設定フォルダの名前から決める
/// （本物のアプリの mjai の保存領域には触れない）。`mjai_webview_dir` の識別子版。
pub fn mjai_data_store_id(config_env: Option<OsString>) -> [u8; 16] {
    let seed = config_env
        .filter(|value| !value.is_empty())
        .map(|dir| dir.to_string_lossy().into_owned())
        .unwrap_or_default();
    store_id("mjai", &seed)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn store_ids_are_stable_distinct_and_uuid_shaped() {
        let trial = Some(OsString::from("/Users/u/jantama-trial"));
        // 同じ名前なら、いつも同じ値（次の起動でも同じ保存領域を使う）。
        assert_eq!(
            app_data_store_id(trial.clone()),
            app_data_store_id(trial.clone())
        );
        assert_eq!(
            mjai_data_store_id(None),
            mjai_data_store_id(Some(OsString::new()))
        );
        // ふだんの検討画面は、既定の保存領域のまま。
        assert_eq!(app_data_store_id(None), None);
        assert_eq!(app_data_store_id(Some(OsString::new())), None);
        // mjai の窓は、アプリの画面とも、別の設定フォルダの mjai の窓とも、別の保存領域。
        let app = app_data_store_id(trial.clone()).unwrap();
        let mjai_trial = mjai_data_store_id(trial.clone());
        let mjai_normal = mjai_data_store_id(None);
        assert_ne!(app, mjai_trial);
        assert_ne!(mjai_trial, mjai_normal);
        assert_ne!(
            app,
            app_data_store_id(Some(OsString::from("/Users/u/other"))).unwrap()
        );
        // UUID の版と型の印。
        for id in [app, mjai_trial, mjai_normal] {
            assert_eq!(id[6] >> 4, 5);
            assert_eq!(id[8] >> 6, 0b10);
        }
    }

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
