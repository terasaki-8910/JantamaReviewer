//! 同期の通信先（`sync::endpoint`。S-2）の試験: 受け付けるのは Turso Cloud の DB（`*.turso.io`）と、この PC の中だけ。
//! URL の文字列を書く試験なので、ソースの走査（`tests/safety.rs` の S-2）の対象にならない、この結合試験のファイルに置く。

use jantama_reviewer_lib::sync::endpoint::SyncEndpoint;

fn ok(text: &str) -> SyncEndpoint {
    SyncEndpoint::parse(text).unwrap_or_else(|e| panic!("{text}: {e}"))
}

fn refused(text: &str) -> String {
    SyncEndpoint::parse(text).expect_err(text).to_string()
}

#[test]
fn a_turso_cloud_url_in_any_of_its_spellings_becomes_the_https_host() {
    let host = "jantama-spike-masa669a.aws-ap-northeast-1.turso.io";
    for text in [
        format!("libsql://{host}"),
        format!("turso://{host}"),
        format!("https://{host}"),
        format!("  libsql://{host}/  "),
        format!("libsql://{}", host.to_uppercase()),
    ] {
        let endpoint = ok(&text);
        assert_eq!(endpoint.base_url(), format!("https://{host}"), "{text}");
        assert_eq!(endpoint.display(), host);
        assert!(!endpoint.is_loopback());
    }
    assert_eq!(
        ok(&format!("https://{host}:443")).base_url(),
        format!("https://{host}")
    );
}

#[test]
fn only_turso_cloud_and_this_pc_are_accepted() {
    for text in [
        "libsql://example.com",
        "https://example.com",
        "https://turso.io",
        "https://.turso.io",
        "https://evil.com/.turso.io",
        "https://a.turso.io.evil.com",
        "https://mjai.ekyu.moe",
        "libsql://192.168.1.10",
        "libsql://10.255.255.1",
        "https://100.122.25.26:8081",
        "http://db.turso.io",
        "ftp://db.turso.io",
        "file:///C:/x",
    ] {
        assert!(SyncEndpoint::parse(text).is_err(), "{text}");
    }
}

#[test]
fn a_url_with_credentials_a_path_a_query_or_a_port_is_refused() {
    for text in [
        "libsql://user:pw@db-org.turso.io",
        "libsql://user@db-org.turso.io",
        "libsql://db-org.turso.io/v2/pipeline",
        "libsql://db-org.turso.io?authToken=abc",
        "libsql://db-org.turso.io#x",
        "libsql://db-org.turso.io:8080",
        "libsql://db org.turso.io",
        "",
        "   ",
        "not a url",
    ] {
        assert!(SyncEndpoint::parse(text).is_err(), "{text}");
    }
}

#[test]
fn this_pc_is_accepted_over_http_with_a_port_for_the_test_server() {
    let endpoint = ok("http://127.0.0.1:18080");
    assert_eq!(endpoint.base_url(), "http://127.0.0.1:18080");
    assert_eq!(endpoint.display(), "127.0.0.1:18080");
    assert!(endpoint.is_loopback());
    assert_eq!(ok("http://localhost:9").base_url(), "http://localhost:9");
    assert_eq!(ok("http://[::1]:7000").base_url(), "http://[::1]:7000");
    assert!(SyncEndpoint::parse("libsql://127.0.0.1:18080").is_err());
}

#[test]
fn the_reason_never_echoes_the_pasted_text() {
    // 貼った文字列にトークンが混ざっていても、理由の文にそのまま出さない
    let reason = refused("libsql://user:SECRET-TOKEN-123@db-org.turso.io");
    assert!(!reason.contains("SECRET-TOKEN-123"), "{reason}");
    let reason = refused("eyJhbGciOiJFZERTQSJ9.SECRET.SIG");
    assert!(!reason.contains("SECRET"), "{reason}");
}
