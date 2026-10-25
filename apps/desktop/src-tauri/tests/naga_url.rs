//! NAGA の結果のページの URL の決まり（E-51、F22 段 2）の検査。
//!
//! 保存できるのは、NAGA のサイト（naga.dmv.nico）の https の URL だけ。ほかは、理由つきで断る。空の文字は、断るのではなく「消す」。
//! URL の文字列を書くので、ソースの URL を通信の疑いとして拒む安全の検査（`tests/safety.rs`）の対象
//! （`src/`）の外のここに置く。ここで通信はしない（アプリは NAGA の URL に通信せず、画面のリンクを、いつものブラウザで開くだけ）。
//!
//! 保存・読み戻し・書き出し・読み込み・同期・ごみ箱での扱いは、`src/store.rs`・`src/study/records.rs`・`src/sync/engine_tests.rs` の試験。

use std::fs;
use std::path::PathBuf;

use jantama_reviewer_lib::capture::{CaptureTarget, Screenshot};
use jantama_reviewer_lib::naga::{
    checked_naga_url, invalid_url_message, MAX_NAGA_URL_CHARS, NAGA_HOST,
};
use jantama_reviewer_lib::store::{Store, StoreError, NAGA_FILE};

const T0: i64 = 1_760_000_000_123;

/// NAGA の結果のページ（実際の形）。
const REPORT_URL: &str = "https://naga.dmv.nico/htmls/report_viewer.html?report_id=abc";

#[test]
fn e51_the_naga_host_is_the_one_constant() {
    assert_eq!(NAGA_HOST, "naga.dmv.nico");
}

#[test]
fn e51_a_https_url_on_the_naga_site_is_accepted() {
    assert_eq!(checked_naga_url(REPORT_URL).as_deref(), Some(REPORT_URL));
    // 前後の空白は除く。スキームとホストの大文字は小文字にそろえる。ホストだけの URL は、末尾の / を足す
    for (given, stored) in [
        (format!("  {REPORT_URL}\n"), REPORT_URL),
        (
            "HTTPS://NAGA.DMV.NICO/htmls/report_viewer.html?report_id=abc".to_string(),
            REPORT_URL,
        ),
        (
            "https://naga.dmv.nico".to_string(),
            "https://naga.dmv.nico/",
        ),
        (
            "https://naga.dmv.nico:443/reports/abc.json?x=1#top".to_string(),
            "https://naga.dmv.nico/reports/abc.json?x=1#top",
        ),
        (
            "https://naga.dmv.nico/a b".to_string(),
            "https://naga.dmv.nico/a%20b",
        ),
    ] {
        assert_eq!(
            checked_naga_url(&given).as_deref(),
            Some(stored),
            "{given:?}"
        );
    }
    // 整えた形は、もう一度通しても変わらない（書き出して読み込んでも、同期して戻っても、同じ）
    for given in [
        REPORT_URL,
        "https://naga.dmv.nico",
        "https://naga.dmv.nico/a b",
    ] {
        let once = checked_naga_url(given).unwrap();
        assert_eq!(checked_naga_url(&once).as_deref(), Some(once.as_str()));
    }
}

#[test]
fn e51_http_another_site_a_look_alike_host_or_a_url_with_credentials_or_a_port_is_refused() {
    let too_long = format!("https://naga.dmv.nico/{}", "a".repeat(MAX_NAGA_URL_CHARS));
    for bad in [
        // http
        "http://naga.dmv.nico/htmls/report_viewer.html?report_id=abc",
        "ftp://naga.dmv.nico/x",
        "ws://naga.dmv.nico/x",
        // 別のサイト
        "https://evil.example/htmls/report_viewer.html?report_id=abc",
        "https://evil.example/https://naga.dmv.nico/htmls/report_viewer.html",
        "https://evil.example/?u=https://naga.dmv.nico/",
        // 似たホスト（サブドメイン・親・別の末尾・末尾のドット）
        "https://naga.dmv.nico.evil.example/htmls/report_viewer.html?report_id=abc",
        "https://www.naga.dmv.nico/x",
        "https://sub.naga.dmv.nico/x",
        "https://xnaga.dmv.nico/x",
        "https://dmv.nico/x",
        "https://nico/x",
        "https://naga.dmv.nico.jp/x",
        "https://naga.dmv.nico./x",
        "https://naga-dmv.nico/x",
        // 文字を紛らわせたホスト（キリル文字の а）
        "https://n\u{0430}ga.dmv.nico/x",
        // ユーザー名・パスワード（本当のホストは @ のあと）
        "https://naga.dmv.nico@evil.example/x",
        "https://naga.dmv.nico:pass@evil.example/x",
        "https://user@naga.dmv.nico/x",
        "https://user:pass@naga.dmv.nico/x",
        // 別のポート
        "https://naga.dmv.nico:8443/x",
        "https://naga.dmv.nico:80/x",
        // IP アドレス
        "https://127.0.0.1/x",
        "https://[::1]/x",
        // URL ではないもの・スキームの無いもの
        "javascript:alert(1)",
        "data:text/html,x",
        "file:///c:/windows/system32/calc.exe",
        "//naga.dmv.nico/x",
        "naga.dmv.nico/x",
        "naga.dmv.nico",
        "/htmls/report_viewer.html?report_id=abc",
        "https://",
        "https:///x",
        "abc",
        // 空・空白だけ（「消す」であって、URL ではない）
        "",
        "   ",
        "\n",
        // 長すぎる
        too_long.as_str(),
    ] {
        assert_eq!(checked_naga_url(bad), None, "{bad:?}");
    }
}

#[test]
fn e51_the_reason_shown_to_the_user_names_the_naga_site() {
    assert_eq!(
        invalid_url_message(),
        "NAGA の結果のページの URL（https://naga.dmv.nico/ で始まるもの）を貼ってください"
    );
}

fn store_with_a_session() -> (tempfile::TempDir, Store, String) {
    let dir = tempfile::tempdir().unwrap();
    let mut store = Store::open(dir.path().join("data")).unwrap();
    store
        .add_mark(
            T0,
            Ok(Screenshot {
                png: vec![0x89, b'P', b'N', b'G'],
                target: CaptureTarget::Window,
            }),
        )
        .unwrap();
    let id = store.current_session_id().unwrap().to_string();
    (dir, store, id)
}

fn naga_file(store: &Store, id: &str) -> PathBuf {
    store.session_folder(id).unwrap().join(NAGA_FILE)
}

#[test]
fn e51_saving_through_the_store_accepts_only_naga_urls_and_an_empty_text_removes_it() {
    let (_tmp, store, id) = store_with_a_session();
    let path = naga_file(&store, &id);

    // 受け付ける URL は、整えて保存する
    store
        .set_naga_url(&id, Some(&format!("  {REPORT_URL}  ")), T0)
        .unwrap();
    let saved = store.load_naga(&id).unwrap().unwrap();
    assert_eq!((saved.url.as_str(), saved.saved_ms), (REPORT_URL, T0));
    let written: serde_json::Value =
        serde_json::from_str(&fs::read_to_string(&path).unwrap()).unwrap();
    assert_eq!(
        written,
        serde_json::json!({"url": REPORT_URL, "saved_ms": T0})
    );

    // 断る URL は、理由つきで断り、保存してある URL を変えない
    for bad in [
        "http://naga.dmv.nico/htmls/report_viewer.html?report_id=abc",
        "https://evil.example/htmls/report_viewer.html?report_id=abc",
        "https://naga.dmv.nico.evil.example/htmls/report_viewer.html?report_id=abc",
    ] {
        match store.set_naga_url(&id, Some(bad), T0 + 1) {
            Err(StoreError::InvalidNaga(reason)) => assert_eq!(reason, invalid_url_message()),
            other => panic!("{bad:?}: {other:?}"),
        }
        assert_eq!(
            store.load_naga(&id).unwrap().unwrap().url,
            REPORT_URL,
            "{bad:?}"
        );
    }

    // 空の文字（前後の空白を除いて空）は、断らずに「消す」
    store.set_naga_url(&id, Some("   "), T0 + 2).unwrap();
    assert!(!path.exists());
    assert_eq!(store.load_naga(&id).unwrap(), None);
    // 無いものを消しても、エラーにならない
    store.set_naga_url(&id, Some(""), T0 + 3).unwrap();
    store.set_naga_url(&id, None, T0 + 4).unwrap();
    assert!(!path.exists());
}

/// 画面の見本の文字（`src/main/naga.ts` の `NAGA_HOST`）は、ここの定数と同じ。直し忘れを防ぐ。
#[test]
fn e51_the_screen_shows_the_same_host_as_the_one_the_rust_side_accepts() {
    let source = fs::read_to_string(
        PathBuf::from(env!("CARGO_MANIFEST_DIR"))
            .join("..")
            .join("src")
            .join("main")
            .join("naga.ts"),
    )
    .expect("画面側の文言のファイルを読める");
    let line = source
        .lines()
        .find(|line| line.starts_with("export const NAGA_HOST"))
        .expect("NAGA_HOST がある");
    assert!(
        line.contains(&format!("'{NAGA_HOST}'")),
        "画面の NAGA_HOST が、Rust 側の {NAGA_HOST} と違う: {line}"
    );
}
