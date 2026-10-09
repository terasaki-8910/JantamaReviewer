//! mjai の窓の移動の決まり（E-10）と、URL 欄に牌譜リンクを入れるスクリプトの組み立て（E-11 の Rust 側）の検査。
//!
//! 窓が読み込んでよいのは、mjai のサイトと Cloudflare の確認の画面だけ。結果のページ
//! （`/killerducky/?data=/report/<ID>.json`）への移動は止めて、結果の ID を返す。ほかは、すべて止める。
//! URL の文字列を書くので、ソースの URL を通信の疑いとして拒む安全の検査（`tests/safety.rs`）の対象
//! （`src/`）の外のここに置く。ここで通信はしない。
//!
//! 実ブラウザで、入れるスクリプトが動くことは、`apps/desktop/tests/browser/mjai-prefill.browser.test.ts` が確かめる。

use jantama_reviewer_lib::import::mjai_nav::{
    decide_navigation, prefill_script, report_id_from_text, start_url, MjaiNavigation,
    PrefillError, NATIVE_SCRIPT, PREFILL_FUNCTION,
};
use jantama_reviewer_lib::import::report_id::ReportId;
use url::Url;

const ID: &str = "f9da87cbcd7af5e9";
const OTHER_ID: &str = "0123456789abcdef";

fn url(text: &str) -> Url {
    Url::parse(text).unwrap_or_else(|e| panic!("{text}: {e}"))
}

fn found(id: &str) -> MjaiNavigation {
    MjaiNavigation::ReportFound(ReportId::parse(id).unwrap())
}

// ---- E-10: 移動の判定 ----

#[test]
fn e10_pages_of_the_mjai_site_are_allowed() {
    for page in [
        "https://mjai.ekyu.moe/",
        "https://mjai.ekyu.moe",
        "https://mjai.ekyu.moe/ja.html",
        "https://mjai.ekyu.moe/?url=x",
        "https://mjai.ekyu.moe/review",
        "https://mjai.ekyu.moe/index.js?d=d29fde14",
        "https://mjai.ekyu.moe/cdn-cgi/challenge-platform/h/b/orchestrate/chl_page/v1",
        "https://MJAI.EKYU.MOE/ja.html",
        "https://mjai.ekyu.moe:443/ja.html",
        "https://mjai.ekyu.moe/report/",
        "https://mjai.ekyu.moe/report/f9da87cbcd7af5e",
        "https://mjai.ekyu.moe/report/f9da87cbcd7af5e9.txt",
        "https://mjai.ekyu.moe/killerducky-docs",
    ] {
        assert_eq!(
            decide_navigation(&url(page)),
            MjaiNavigation::Allow,
            "{page}"
        );
    }
}

#[test]
fn e10_the_cloudflare_challenge_screens_are_allowed() {
    for page in [
        "https://challenges.cloudflare.com/",
        "https://challenges.cloudflare.com/cdn-cgi/challenge-platform/h/g/turnstile/if/ov2/av0/rcv/0x4AAAAAAAAnc33mIX4aonHH/light/fbE/new/normal/auto/",
        "https://challenges.cloudflare.com/turnstile/v0/api.js",
    ] {
        assert_eq!(
            decide_navigation(&url(page)),
            MjaiNavigation::Allow,
            "{page}"
        );
    }
}

#[test]
fn e10_the_result_page_is_stopped_and_gives_the_report_id() {
    for (page, id) in [
        (
            "https://mjai.ekyu.moe/killerducky/?data=/report/f9da87cbcd7af5e9.json",
            ID,
        ),
        (
            "https://mjai.ekyu.moe/killerducky?data=/report/0123456789abcdef.json",
            OTHER_ID,
        ),
        (
            "https://mjai.ekyu.moe/killerducky/index.html?data=/report/f9da87cbcd7af5e9.json",
            ID,
        ),
        // 結果の置き場所が、% で書かれていても、同じ。
        (
            "https://mjai.ekyu.moe/killerducky/?data=%2Freport%2Ff9da87cbcd7af5e9.json",
            ID,
        ),
        // ほかの項目が付いていても、見つける。
        (
            "https://mjai.ekyu.moe/killerducky/?tw=0&data=/report/f9da87cbcd7af5e9.json&x=1#kyoku-3",
            ID,
        ),
        // 結果の JSON そのものへの移動も、画面に出さずに止めて、見つけた扱いにする。
        ("https://mjai.ekyu.moe/report/f9da87cbcd7af5e9.json", ID),
    ] {
        assert_eq!(decide_navigation(&url(page)), found(id), "{page}");
    }
}

#[test]
fn e10_a_viewer_page_without_a_valid_report_is_blocked_too() {
    // 結果を見せる画面は、結果の置き場所が正しく渡されていなければ、何も見せずに止める。
    for page in [
        "https://mjai.ekyu.moe/killerducky/",
        "https://mjai.ekyu.moe/killerducky",
        "https://mjai.ekyu.moe/killerducky/?data=",
        "https://mjai.ekyu.moe/killerducky/?data=/report/F9DA87CBCD7AF5E9.json",
        "https://mjai.ekyu.moe/killerducky/?data=/report/f9da87cbcd7af5e.json",
        "https://mjai.ekyu.moe/killerducky/?data=/report/f9da87cbcd7af5e9.json.exe",
        "https://mjai.ekyu.moe/killerducky/?data=/other/f9da87cbcd7af5e9.json",
        "https://mjai.ekyu.moe/killerducky/?data=https://mjai.ekyu.moe/report/f9da87cbcd7af5e9.json",
        "https://mjai.ekyu.moe/killerducky/?data=/report/../report/f9da87cbcd7af5e9.json",
        "https://mjai.ekyu.moe/killerducky/?other=/report/f9da87cbcd7af5e9.json",
        // 最初の data が正しくなければ、あとの data は見ない。
        "https://mjai.ekyu.moe/killerducky/?data=x&data=/report/f9da87cbcd7af5e9.json",
        "https://mjai.ekyu.moe/killerducky/sub/page.html",
    ] {
        assert_eq!(
            decide_navigation(&url(page)),
            MjaiNavigation::Block,
            "{page}"
        );
    }
}

#[test]
fn e10_everything_else_is_blocked() {
    for page in [
        // 同じホストでも、https でない・ユーザー名・ポートの指定がある。
        "http://mjai.ekyu.moe/",
        "https://user@mjai.ekyu.moe/",
        "https://user:pass@mjai.ekyu.moe/",
        "https://mjai.ekyu.moe:8443/",
        "https://mjai.ekyu.moe:80/",
        // 似たホスト・別のホスト。
        "https://mjai.ekyu.moe.evil.example/",
        "https://evil.example/mjai.ekyu.moe/",
        "https://evil.example/?u=https://mjai.ekyu.moe/",
        "https://mjai.ekyu.moe@evil.example/",
        "https://xmjai.ekyu.moe/",
        "https://ekyu.moe/",
        "https://www.mjai.ekyu.moe/",
        "https://sub.mjai.ekyu.moe/",
        "https://mjai.ekyu.moe./",
        "https://challenges.cloudflare.com.evil.example/",
        "https://cloudflare.com/",
        "https://www.cloudflare.com/",
        "http://challenges.cloudflare.com/",
        "https://challenges.cloudflare.com:8443/",
        "https://user@challenges.cloudflare.com/",
        // 雀魂・牌譜屋・ほかのサイト・この PC の中。
        "https://tenhou.net/2/?q=123m",
        "https://google.com/",
        "https://127.0.0.1/",
        "https://[::1]/",
        "http://localhost:1420/",
        "http://tauri.localhost/index.html",
        "http://asset.localhost/x.png",
        // https 以外のスキーム。
        "about:blank",
        "file:///C:/Windows/System32/calc.exe",
        "data:text/html,<h1>x</h1>",
        "javascript:alert(1)",
        "blob:https://mjai.ekyu.moe/1234",
        "ftp://mjai.ekyu.moe/",
        "ws://mjai.ekyu.moe/",
        "wss://mjai.ekyu.moe/",
        "mailto:someone@example.com",
        "tauri://localhost/index.html",
    ] {
        assert_eq!(
            decide_navigation(&url(page)),
            MjaiNavigation::Block,
            "{page}"
        );
    }
}

// ---- 貼り付けた文字から結果の ID を探す ----

#[test]
fn a_pasted_result_url_gives_its_report_id() {
    for (text, id) in [
        (
            "https://mjai.ekyu.moe/killerducky/?data=/report/f9da87cbcd7af5e9.json",
            ID,
        ),
        (
            "  https://mjai.ekyu.moe/killerducky/?data=/report/f9da87cbcd7af5e9.json\r\n",
            ID,
        ),
        (
            "結果はこちら https://mjai.ekyu.moe/killerducky/?data=/report/0123456789abcdef.json です",
            OTHER_ID,
        ),
        (
            "<https://mjai.ekyu.moe/killerducky/?data=/report/f9da87cbcd7af5e9.json>",
            ID,
        ),
        (
            "「https://mjai.ekyu.moe/killerducky/?data=/report/f9da87cbcd7af5e9.json」",
            ID,
        ),
        ("https://mjai.ekyu.moe/report/f9da87cbcd7af5e9.json", ID),
        // ID だけでもよい。
        ("f9da87cbcd7af5e9", ID),
        ("  f9da87cbcd7af5e9\n", ID),
    ] {
        assert_eq!(
            report_id_from_text(text),
            Some(ReportId::parse(id).unwrap()),
            "{text:?}"
        );
    }
}

#[test]
fn text_without_a_result_gives_nothing() {
    for text in [
        "",
        "   ",
        "hello",
        "https://mjai.ekyu.moe/",
        "https://tenhou.net/2/?q=123m",
        // 別のホストの、結果の URL に似たもの。
        "https://evil.example/killerducky/?data=/report/f9da87cbcd7af5e9.json",
        "http://mjai.ekyu.moe/killerducky/?data=/report/f9da87cbcd7af5e9.json",
        "https://mjai.ekyu.moe/killerducky/?data=/report/F9DA87CBCD7AF5E9.json",
        "F9DA87CBCD7AF5E9",
        "f9da87cbcd7af5e",
    ] {
        assert_eq!(report_id_from_text(text), None, "{text:?}");
    }
}

// ---- E-11: URL 欄に入れるスクリプトの組み立て ----

#[test]
fn e11_the_script_calls_the_prefill_function_with_the_link_as_a_json_string() {
    let link = "https://game.example/?paipu=261009-abc";
    let script = prefill_script(link).unwrap();
    assert!(script.starts_with("(("), "{script}");
    assert!(script.ends_with(");"), "{script}");
    // 最後の引数が、リンクの JSON の文字列。
    assert_eq!(embedded_link(&script), link);
}

#[test]
fn e11_a_link_cannot_break_out_of_its_string() {
    // 引用符・バックスラッシュ・スクリプトの終わり・区切りの文字があっても、1 つの文字列の中に収まる。
    for link in [
        "https://example.test/?q=\"x\\y\"</script><script>alert(1)</script>",
        "https://example.test/?a=');alert(1);//",
        // JavaScript の古い規格では行の終わり扱いの文字（前後に置くと、前後の空白として弾かれるので、途中に置く）。
        "https://example.test/?\u{2028}x\u{2029}y",
        "https://example.test/#${alert(1)}`",
    ] {
        let script = prefill_script(link).unwrap();
        // 書き出した文字列を読み戻すと、元のリンクと同じ（途中で切れていない。文字列の外に、リンクの一部が出ていない）。
        assert_eq!(embedded_link(&script), link, "{script}");
    }
}

#[test]
fn e11_bad_links_do_not_make_a_script() {
    assert_eq!(prefill_script(""), Err(PrefillError::BadLink));
    assert_eq!(
        prefill_script(" https://example.test/"),
        Err(PrefillError::BadLink)
    );
    assert_eq!(
        prefill_script("https://example.test/\n"),
        Err(PrefillError::BadLink)
    );
    assert_eq!(
        prefill_script("https://exa mple.test/"),
        Err(PrefillError::BadLink)
    );
    assert_eq!(prefill_script("not a url"), Err(PrefillError::BadLink));
    assert_eq!(
        prefill_script("http://example.test/"),
        Err(PrefillError::NotHttps)
    );
    assert_eq!(
        prefill_script("javascript:alert(1)"),
        Err(PrefillError::NotHttps)
    );
    assert_eq!(
        prefill_script(&format!("https://example.test/{}", "a".repeat(2100))),
        Err(PrefillError::BadLink)
    );
}

#[test]
fn e11_the_prefill_function_only_fills_the_log_url_field_and_never_submits() {
    let code = strip_comments(PREFILL_FUNCTION);
    // 入れる欄と、出すイベント。
    assert!(code.contains("input[name=\"log-url\"]"));
    assert!(code.contains("dispatchEvent"));
    assert!(code.contains("new Event('input'"));
    assert!(code.contains("new Event('change'"));
    // 送信・移動・通信・新しい窓には触れない。
    for forbidden in [
        ".click(",
        ".submit(",
        "requestSubmit",
        "submitBtn",
        "type=\"submit\"",
        "fetch(",
        "XMLHttpRequest",
        "sendBeacon",
        "WebSocket",
        "EventSource",
        "window.open",
        "location",
        "document.forms",
        "innerHTML",
        "eval(",
        "Function(",
        "import(",
        "localStorage",
        "cookie",
    ] {
        assert!(!code.contains(forbidden), "{forbidden} を使っている");
    }
}

#[test]
fn the_native_script_does_not_reach_out_either() {
    let code = strip_comments(NATIVE_SCRIPT);
    for forbidden in [
        "fetch(",
        "XMLHttpRequest",
        "sendBeacon",
        "WebSocket",
        "window.open",
        "location",
        ".click(",
        ".submit(",
        "eval(",
        "cookie",
    ] {
        assert!(!code.contains(forbidden), "{forbidden} を使っている");
    }
}

#[test]
fn the_window_starts_at_the_site_entrance() {
    let start = start_url();
    assert_eq!(start.as_str(), "https://mjai.ekyu.moe/");
}

/// スクリプトの最後の引数（リンクの JSON の文字列）を読み戻す。
/// 関数の部分にも `"` があるので、左から順に、「そこから文の終わり `);` の手前までが、ちょうど 1 つの JSON の文字列」に
/// なる最初の場所を探す。
fn embedded_link(script: &str) -> String {
    let body = script.strip_suffix(");").expect("文の終わり");
    body.match_indices('"')
        .find_map(|(at, _)| serde_json::from_str::<String>(&body[at..]).ok())
        .expect("最後の引数は JSON の文字列")
}

/// `//` で始まる行のコメントを除く（説明の文に、禁止の語が出てきても数えない）。
fn strip_comments(source: &str) -> String {
    source
        .lines()
        .filter(|line| !line.trim_start().starts_with("//"))
        .collect::<Vec<_>>()
        .join("\n")
}
