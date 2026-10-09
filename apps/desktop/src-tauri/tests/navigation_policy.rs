//! 画面の遷移・新しい窓・ダウンロードの決まり（N-5、N-6）の検査。
//!
//! 窓が読み込んでよいのはアプリ自身の画面だけで、それ以外の遷移は取り消す。外部の Web ページへのリンクのクリックと
//! 新しい窓の要求は、既定のブラウザに回す。ダウンロードは受け付けない。
//! URL の文字列を書くので、ソースの URL を通信の疑いとして拒む安全の検査（`tests/safety.rs`）の対象
//! （`src/`）の外のここに置く。ここで通信はしない。

use std::cell::RefCell;
use std::path::PathBuf;

use jantama_reviewer_lib::external::{download_hook, navigation_hook, new_window_hook};
use jantama_reviewer_lib::navigation::{
    allow_download, decide_navigation, decide_new_window, is_external_web_page, AppOrigins,
    NavigationDecision, NewWindowDecision, Origin, PRODUCTION_HOST,
};
use tauri::webview::DownloadEvent;
use url::Url;

fn url(text: &str) -> Url {
    Url::parse(text).unwrap_or_else(|e| panic!("{text}: {e}"))
}

fn production() -> AppOrigins {
    AppOrigins::production()
}

fn dev() -> AppOrigins {
    AppOrigins::for_run(true, Some(&url("http://localhost:1420/")))
}

// ---- N-5: 読み込んでよいのは、アプリ自身の画面だけ ----

#[test]
fn n5_the_production_pages_of_both_windows_load() {
    for page in [
        "http://tauri.localhost/index.html",
        "http://tauri.localhost/widget.html",
        "http://tauri.localhost/",
        "http://tauri.localhost/widget.html#anything",
        "http://TAURI.localhost:80/index.html",
    ] {
        assert_eq!(
            decide_navigation(&url(page), &production()),
            NavigationDecision::Allow,
            "{page}"
        );
    }
}

#[test]
fn n5_the_vite_dev_server_loads_only_in_dev() {
    let page = url("http://localhost:1420/widget.html");
    assert_eq!(decide_navigation(&page, &dev()), NavigationDecision::Allow);
    // 製品では、開発サーバーの画面は読み込まない（取り消すだけ。localhost はブラウザにも渡さない）。
    assert_eq!(
        decide_navigation(&page, &production()),
        NavigationDecision::Cancel
    );
    // dev でも、設定の devUrl が無ければ製品と同じ。
    assert_eq!(
        decide_navigation(&page, &AppOrigins::for_run(true, None)),
        NavigationDecision::Cancel
    );
    // dev でない動かし方では、devUrl があっても許さない。
    assert_eq!(
        decide_navigation(
            &page,
            &AppOrigins::for_run(false, Some(&url("http://localhost:1420/")))
        ),
        NavigationDecision::Cancel
    );
}

#[test]
fn n5_the_dev_server_is_matched_by_scheme_host_and_port() {
    let origins = dev();
    for other in [
        "http://localhost:1421/",
        "https://localhost:1420/",
        "http://127.0.0.1:1420/",
        "http://localhost.evil.example:1420/",
    ] {
        assert_ne!(
            decide_navigation(&url(other), &origins),
            NavigationDecision::Allow,
            "{other}"
        );
    }
}

#[test]
fn n5_a_look_alike_host_is_not_the_app() {
    for other in [
        "http://tauri.localhost.evil.example/",
        "http://evil.example/tauri.localhost/",
        "http://tauri.localhost@evil.example/",
        "https://tauri.localhost/index.html",
        "http://tauri.localhost:8080/index.html",
    ] {
        assert_ne!(
            decide_navigation(&url(other), &production()),
            NavigationDecision::Allow,
            "{other}"
        );
    }
}

#[test]
fn n5_a_link_to_a_web_page_is_cancelled_and_sent_to_the_default_browser() {
    for page in [
        "https://tenhou.net/2/?q=123m456p789s11222z",
        "https://mjai.ekyu.moe/killerducky/?data=/report/f9da87cbcd7af5e9.json",
        "http://example.com/",
        "https://203.0.113.7/path",
        "https://[2001:db8::1]/",
    ] {
        assert_eq!(
            decide_navigation(&url(page), &production()),
            NavigationDecision::OpenExternal,
            "{page}"
        );
    }
}

#[test]
fn n5_anything_else_is_cancelled_without_opening_a_browser() {
    for page in [
        "file:///C:/Windows/System32/calc.exe",
        "data:text/html,<h1>x</h1>",
        "javascript:alert(1)",
        "blob:http://tauri.localhost/1234",
        "about:blank",
        "ftp://example.com/file",
        "ws://example.com/",
        "mailto:someone@example.com",
        "tauri://localhost/index.html",
        // アプリ内部のアドレス（画像・IPC）や、この PC・ローカルのネットワークのホストは、ブラウザに渡さない。
        "http://asset.localhost/C%3A/data/marks/1.png",
        "http://ipc.localhost/get_state",
        "http://localhost:8080/",
        "http://127.0.0.1:1420/",
        "http://192.168.1.10/",
        "http://10.0.0.5/",
        "http://[::1]/",
        "http://intranet/",
    ] {
        assert_eq!(
            decide_navigation(&url(page), &production()),
            NavigationDecision::Cancel,
            "{page}"
        );
        assert!(!is_external_web_page(&url(page)), "{page}");
    }
}

#[test]
fn n5_origins_compare_by_scheme_host_and_effective_port() {
    assert_eq!(
        Origin::new("http", "tauri.localhost", None),
        Origin::of(&url("http://tauri.localhost:80/x")).unwrap()
    );
    assert_ne!(
        Origin::new("http", "tauri.localhost", None),
        Origin::of(&url("https://tauri.localhost/x")).unwrap()
    );
    assert!(Origin::of(&url("data:text/plain,hi")).is_none());
    assert_eq!(PRODUCTION_HOST, "tauri.localhost");
}

// ---- N-5: 新しい窓の要求 ----

#[test]
fn n5_new_window_requests_are_always_denied_and_web_pages_go_to_the_browser() {
    let origins = production();
    assert_eq!(
        decide_new_window(&url("https://tenhou.net/2/?q=1m"), &origins),
        NewWindowDecision::DenyAndOpenExternal
    );
    for page in [
        "http://tauri.localhost/index.html",
        "about:blank",
        "file:///C:/x.txt",
        "javascript:void(0)",
        "http://asset.localhost/x.png",
    ] {
        assert_eq!(
            decide_new_window(&url(page), &origins),
            NewWindowDecision::Deny,
            "{page}"
        );
    }
}

// ---- フックにつないだときの動き（ブラウザを実際に起動せず、呼ばれた URL だけを記録する） ----

#[test]
fn n5_the_navigation_hook_cancels_foreign_pages_and_opens_only_web_links() {
    let opened = RefCell::new(Vec::<String>::new());
    let open = |u: &Url| opened.borrow_mut().push(u.to_string());
    let origins = production();

    assert!(navigation_hook(
        &url("http://tauri.localhost/index.html"),
        &origins,
        &open
    ));
    assert!(!navigation_hook(
        &url("https://tenhou.net/2/?q=1m"),
        &origins,
        &open
    ));
    assert!(!navigation_hook(&url("file:///C:/x.txt"), &origins, &open));
    assert!(!navigation_hook(&url("data:text/html,x"), &origins, &open));
    assert_eq!(
        opened.into_inner(),
        vec!["https://tenhou.net/2/?q=1m".to_string()]
    );
}

#[test]
fn n5_the_new_window_hook_opens_only_web_pages() {
    let opened = RefCell::new(Vec::<String>::new());
    let open = |u: &Url| opened.borrow_mut().push(u.to_string());
    let origins = production();

    for page in [
        "https://tenhou.net/2/?q=1m",
        "http://tauri.localhost/index.html",
        "file:///C:/x.txt",
        "about:blank",
    ] {
        new_window_hook(&url(page), &origins, &open);
    }
    assert_eq!(
        opened.into_inner(),
        vec!["https://tenhou.net/2/?q=1m".to_string()]
    );
}

// ---- N-6: ダウンロード ----

#[test]
fn n6_no_download_is_ever_accepted() {
    for page in [
        "http://tauri.localhost/report.json",
        "https://tenhou.net/file.zip",
        "blob:http://tauri.localhost/1234",
        "data:text/plain,hi",
        "file:///C:/x.txt",
    ] {
        assert!(!allow_download(&url(page)), "{page}");
    }
}

#[test]
fn n6_the_download_hook_refuses_requests_and_ignores_finish_notices() {
    let mut destination = PathBuf::from("C:\\Users\\someone\\Downloads\\x.zip");
    let requested = DownloadEvent::Requested {
        url: url("https://example.com/x.zip"),
        destination: &mut destination,
    };
    assert!(!download_hook(&requested), "始まる前の要求は断る");
    let finished = DownloadEvent::Finished {
        url: url("https://example.com/x.zip"),
        path: None,
        success: false,
    };
    assert!(download_hook(&finished), "終わった知らせには、何もしない");
}
