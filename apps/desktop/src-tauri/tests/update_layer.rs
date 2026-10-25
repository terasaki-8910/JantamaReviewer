//! アプリ内の更新（`update`）の検査（S-2 の「通信先を差し替えられる層の単体テスト」）。
//!
//! 通信先は、この PC の中の試験用サーバー（`TcpListener`）に差し替える。実際の GitHub には、つながない。
//! 署名の鍵の組は、この試験のためだけに作った使い捨てのもの（秘密鍵は、リポジトリにも、アプリにも無い）。
//! 確かめること:
//! - 公開鍵が空でも、更新の部品を登録したアプリが起動する／空のままなら、通信せずに「設定されていません」を返す
//! - 新しい版は見つかり、同じ版・古い版は最新として扱う／失敗は、落ちずに理由つきで返る（前に見つけた更新は残る）
//! - 入れ直す前に、署名を確かめる: 改ざんされた中身・別の版の署名・読めない公開鍵は、断る（インストーラーは動かさず、閉じる前の片づけもしない）
//! - 見つけた更新が無ければ、入れ直せない
//!
//! URL の文字列を書くので、ソースの URL を通信の疑いとして拒む安全の検査（`tests/safety.rs`）の対象（`src/`）の外のここに置く。

use std::io::{Read, Write};
use std::net::{TcpListener, TcpStream};
use std::sync::atomic::{AtomicBool, AtomicUsize, Ordering};
use std::sync::{Arc, Mutex};
use std::thread::{self, JoinHandle};
use std::time::Duration;

use jantama_reviewer_lib::update::{
    check, install, plugin, plugin_config, prepare_config, BeforeExit, PendingUpdate, UpdateCheck,
    UpdateOutcome, UpdateSource, NO_PENDING_MESSAGE,
};
use tauri::test::{mock_builder, mock_context, noop_assets, MockRuntime};
use tauri::AppHandle;

/// 試験のためだけに作った、使い捨ての鍵の組の公開鍵（`tauri signer generate` が作る `.pub` の中身）。
const TEST_PUBLIC_KEY: &str = "dW50cnVzdGVkIGNvbW1lbnQ6IG1pbmlzaWduIHB1YmxpYyBrZXk6IEVEMTdCNDNDNzI1OTU0NzEKUldSeFZGbHlQTFFYN1U3a29KSzlMaURLN2FBdWgyc0dpN3luc1pxM1BrblpMMXA4YklaNExPVDEK";

/// 別の使い捨ての鍵の組の公開鍵（署名した鍵ではない）。
const OTHER_PUBLIC_KEY: &str = "dW50cnVzdGVkIGNvbW1lbnQ6IG1pbmlzaWduIHB1YmxpYyBrZXk6IDhCODYxRDFFOTQ1NTA0RDUKUldUVkJGV1VIaDJHaXpmZWZ2RzZMY1d0ZlpLTzhxZ3VQVEVMZkZPVnliRG8zOVNKRkhubmVKMEcK";

/// `PAYLOAD` に、上の鍵の秘密鍵で、版 0.2.0 を結んで署名したもの（`tauri signer sign --app-version 0.2.0` の `.sig` の中身）。
const PAYLOAD_SIGNATURE: &str = "dW50cnVzdGVkIGNvbW1lbnQ6IHNpZ25hdHVyZSBmcm9tIHRhdXJpIHNlY3JldCBrZXkKUlVSeFZGbHlQTFFYN1VRd0NGVkVIOVRvSklyS09vdlRYMmUrV1B4YUc3L3dab0ZJWmlPQ3hDTXdINk5lV2dRV1JYMWpyK1l1L3Z6MmhYb3JLNW9MTDIrc2VWVno5bHBiT1FvPQp0cnVzdGVkIGNvbW1lbnQ6IHRpbWVzdGFtcDoxNzkyOTIxODAyCWZpbGU6cGF5bG9hZC5iaW4JdmVyc2lvbjowLjIuMApZNTc0ZGlkK3pnbXNzTW9MODlEbHZMYm9xUXV5OTlDUlJxeHZCUE9qSmpjM2lFWnFTRFlyWWtYMVJVaXZtT1pKRkxOdzk1Y1BRMFdqcjBZQ3l5TTBDQT09Cg==";

/// 同じ `PAYLOAD` に、同じ秘密鍵で、版を結ばずに署名したもの（`--app-version` を付けない `tauri signer sign`）。古い署名を、新しい版に
/// 見せかけるのに使える形。
const PAYLOAD_SIGNATURE_WITHOUT_VERSION: &str = "dW50cnVzdGVkIGNvbW1lbnQ6IHNpZ25hdHVyZSBmcm9tIHRhdXJpIHNlY3JldCBrZXkKUlVSeFZGbHlQTFFYN1Z0bExJVmNMU3c3V0poZmhJWG95Rlc3NWsvTzk4dU91bDBoVitZdDBXVEhrNjM5K1E5d0dMbkhFVks1Nmx5dDZxdStzQmJUbFlqNjFyeWpCZ1JyeVFFPQp0cnVzdGVkIGNvbW1lbnQ6IHRpbWVzdGFtcDoxNzkyOTIyMzI5CWZpbGU6cGF5bG9hZDIuYmluCkI1V1hSRjZzTlhwLzBnZElYbkxETFhsci9CT3A0a29EZnd0MmczWmp3WGJmalZ3VmkyOWJxNDZsTEVoc3lnZ1hObVU5Q3grbFBiYUhxNkFYc3FDOURBPT0K";

/// 署名した中身。実行ファイルではない文字なので、署名を確かめたあと、インストーラーとしては動かせない（試験が、インストーラーを動かさないため）。
const PAYLOAD: &[u8] = b"jantama-reviewer updater test payload 0.2.0";

/// 試験用アプリの「今の版」（`tauri::test::mock_context` の版）。
const CURRENT: &str = "0.1.0";

/// 試験用サーバーが返す答え。
enum Reply {
    Body(Vec<u8>),
    /// 少し待ってから返す（入れ直しが進んでいる間を作るため。使う試験は Windows だけ）。
    #[cfg_attr(not(windows), allow(dead_code))]
    Slow(Vec<u8>),
    Status(u16),
}

struct TestServer {
    port: u16,
    request_lines: Arc<Mutex<Vec<String>>>,
    headers: Arc<Mutex<Vec<String>>>,
    connections: Arc<AtomicUsize>,
    stop: Arc<AtomicBool>,
    thread: Option<JoinHandle<()>>,
}

impl TestServer {
    /// `route(ポート, パス)` が、パスごとの答えを返す。
    fn start(route: impl Fn(u16, &str) -> Reply + Send + Sync + 'static) -> TestServer {
        let listener = TcpListener::bind("127.0.0.1:0").unwrap();
        listener.set_nonblocking(true).unwrap();
        let port = listener.local_addr().unwrap().port();
        let request_lines = Arc::new(Mutex::new(Vec::new()));
        let headers = Arc::new(Mutex::new(Vec::new()));
        let connections = Arc::new(AtomicUsize::new(0));
        let stop = Arc::new(AtomicBool::new(false));
        let route = Arc::new(route);
        let thread = {
            let (request_lines, headers, connections, stop) = (
                request_lines.clone(),
                headers.clone(),
                connections.clone(),
                stop.clone(),
            );
            thread::spawn(move || {
                while !stop.load(Ordering::SeqCst) {
                    match listener.accept() {
                        Ok((stream, _)) => {
                            connections.fetch_add(1, Ordering::SeqCst);
                            let (route, request_lines, headers) =
                                (route.clone(), request_lines.clone(), headers.clone());
                            thread::spawn(move || {
                                let _ = serve_one(stream, port, &*route, &request_lines, &headers);
                            });
                        }
                        Err(_) => thread::sleep(Duration::from_millis(2)),
                    }
                }
            })
        };
        TestServer {
            port,
            request_lines,
            headers,
            connections,
            stop,
            thread: Some(thread),
        }
    }

    fn url(&self, path: &str) -> String {
        format!("http://127.0.0.1:{}{path}", self.port)
    }

    fn requests(&self) -> Vec<String> {
        self.request_lines.lock().unwrap().clone()
    }

    fn connection_count(&self) -> usize {
        self.connections.load(Ordering::SeqCst)
    }
}

impl Drop for TestServer {
    fn drop(&mut self) {
        self.stop.store(true, Ordering::SeqCst);
        if let Some(thread) = self.thread.take() {
            let _ = thread.join();
        }
    }
}

fn serve_one(
    mut stream: TcpStream,
    port: u16,
    route: &(dyn Fn(u16, &str) -> Reply + Send + Sync),
    request_lines: &Mutex<Vec<String>>,
    headers: &Mutex<Vec<String>>,
) -> std::io::Result<()> {
    stream.set_nonblocking(false)?;
    let mut buffer = Vec::new();
    let mut byte = [0u8; 1];
    while !buffer.ends_with(b"\r\n\r\n") {
        if stream.read(&mut byte)? == 0 || buffer.len() > 16 * 1024 {
            break;
        }
        buffer.push(byte[0]);
    }
    let text = String::from_utf8_lossy(&buffer).into_owned();
    let mut lines = text.split("\r\n");
    let line = lines.next().unwrap_or("").to_string();
    let path = line.split_whitespace().nth(1).unwrap_or("/").to_string();
    headers
        .lock()
        .unwrap()
        .extend(lines.filter(|l| !l.is_empty()).map(str::to_ascii_lowercase));
    request_lines.lock().unwrap().push(line);
    let reply = route(port, &path);
    if matches!(reply, Reply::Slow(_)) {
        thread::sleep(Duration::from_millis(600));
    }
    match reply {
        Reply::Body(body) | Reply::Slow(body) => {
            let head = format!(
                "HTTP/1.1 200 OK\r\nContent-Type: application/octet-stream\r\nContent-Length: {}\r\nConnection: close\r\n\r\n",
                body.len()
            );
            stream.write_all(head.as_bytes())?;
            stream.write_all(&body)?;
        }
        Reply::Status(code) => {
            let head =
                format!("HTTP/1.1 {code} Test\r\nContent-Length: 0\r\nConnection: close\r\n\r\n");
            stream.write_all(head.as_bytes())?;
        }
    }
    stream.flush()
}

/// 配布先の latest.json（Windows 向けに、署名とダウンロード先を書いた形）。
fn manifest(port: u16, version: &str, signature: &str) -> Vec<u8> {
    let target = target_name();
    serde_json::json!({
        "version": version,
        "notes": "直したこと",
        "pub_date": "2026-10-26T09:00:00Z",
        "platforms": {
            target: {
                "signature": signature,
                "url": format!("http://127.0.0.1:{port}/payload.bin"),
            }
        }
    })
    .to_string()
    .into_bytes()
}

/// この PC の、配布先の latest.json での名前（Windows の 64 ビットなら `windows-x86_64`）。
fn target_name() -> String {
    let os = if cfg!(windows) {
        "windows"
    } else if cfg!(target_os = "macos") {
        "darwin"
    } else {
        "linux"
    };
    let arch = if cfg!(target_arch = "aarch64") {
        "aarch64"
    } else {
        "x86_64"
    };
    format!("{os}-{arch}")
}

/// 配布先: 版 `version` の latest.json と、署名した中身（`payload`）。
fn release_server(version: &'static str, signature: &'static str, payload: Vec<u8>) -> TestServer {
    TestServer::start(move |port, path| match path {
        "/latest.json" => Reply::Body(manifest(port, version, signature)),
        "/payload.bin" => Reply::Body(payload.clone()),
        _ => Reply::Status(404),
    })
}

/// 更新の部品を登録した、試験用のアプリ。本物のアプリと同じ手順（設定を入れてから登録）で作る。
fn app_with_updater() -> tauri::App<MockRuntime> {
    let mut context = mock_context(noop_assets());
    prepare_config(context.config_mut());
    // 試験用サーバーは http（製品は https だけ。試験を --release で動かしても通るように、許す印を試験の設定にだけ足す）
    context
        .config_mut()
        .plugins
        .0
        .get_mut("updater")
        .and_then(|config| config.as_object_mut())
        .expect("更新の部品の設定がある")
        .insert(
            "dangerousInsecureTransportProtocol".to_string(),
            serde_json::Value::Bool(true),
        );
    mock_builder()
        .plugin(plugin())
        .build(context)
        .expect("公開鍵が空でも、更新の部品を登録したアプリが起動する")
}

/// 閉じる前の片づけが呼ばれたかを覚える関数。
fn exit_hook() -> (BeforeExit, Arc<AtomicBool>) {
    let ran = Arc::new(AtomicBool::new(false));
    let hook: BeforeExit = {
        let ran = ran.clone();
        Arc::new(move || ran.store(true, Ordering::SeqCst))
    };
    (hook, ran)
}

fn source(server: &TestServer, public_key: &str) -> UpdateSource {
    UpdateSource {
        public_key: public_key.to_string(),
        endpoint: server.url("/latest.json"),
    }
}

fn run_check(
    app: &AppHandle<MockRuntime>,
    source: &UpdateSource,
    pending: &PendingUpdate,
) -> UpdateCheck {
    let (hook, _) = exit_hook();
    tauri::async_runtime::block_on(check(app, source, pending, &hook))
}

fn run_install(
    app: &AppHandle<MockRuntime>,
    pending: &PendingUpdate,
) -> (Result<(), String>, bool) {
    let (hook, ran) = exit_hook();
    let result = tauri::async_runtime::block_on(install(app, pending, &hook));
    (result, ran.load(Ordering::SeqCst))
}

// ---- 公開鍵が空 ----

#[test]
fn f21_an_app_with_the_updater_registered_starts_and_an_empty_key_means_not_configured_without_any_request(
) {
    let server = release_server("0.2.0", PAYLOAD_SIGNATURE, PAYLOAD.to_vec());
    let app = app_with_updater();
    let pending = PendingUpdate::default();
    for empty in ["", "   ", "\n"] {
        let result = run_check(app.handle(), &source(&server, empty), &pending);
        assert_eq!(
            result,
            UpdateCheck::new(CURRENT.to_string(), UpdateOutcome::NotConfigured)
        );
    }
    // 通信していない（取り先につなぎにも行かない）
    assert_eq!(server.connection_count(), 0);
    assert!(server.requests().is_empty());
    assert_eq!(pending.version(), None);
}

#[test]
fn f21_the_plugin_needs_the_prepared_config_to_start() {
    // 設定を入れずに登録すると、部品は起動できない（`pubkey` の項目が要る）。製品は、起動の前に必ず `prepare_config` を呼ぶ
    let without = mock_builder()
        .plugin(plugin())
        .build(mock_context(noop_assets()));
    assert!(without.is_err());
    // 入れた設定は、公開鍵が空のまま、部品の設定として読める
    let config = plugin_config();
    assert_eq!(config["pubkey"], "");
    let mut context = mock_context(noop_assets());
    prepare_config(context.config_mut());
    assert!(mock_builder().plugin(plugin()).build(context).is_ok());
}

// ---- 確かめる ----

#[test]
fn f21_a_newer_release_is_found_with_one_get_and_kept_for_installing() {
    let server = release_server("0.2.0", PAYLOAD_SIGNATURE, PAYLOAD.to_vec());
    let app = app_with_updater();
    let pending = PendingUpdate::default();
    let result = run_check(app.handle(), &source(&server, TEST_PUBLIC_KEY), &pending);
    assert_eq!(
        result,
        UpdateCheck::new(
            CURRENT.to_string(),
            UpdateOutcome::Available {
                version: "0.2.0".to_string(),
                notes: Some("直したこと".to_string()),
                date: Some("2026-10-26T09:00:00Z".to_string()),
            }
        )
    );
    assert_eq!(pending.version().as_deref(), Some("0.2.0"));
    // 確かめるだけでは、ダウンロードも入れ直しもしない: 要求は latest.json の GET が 1 回だけ
    assert_eq!(server.requests(), vec!["GET /latest.json HTTP/1.1"]);
    assert_eq!(server.connection_count(), 1);
    let headers = server.headers.lock().unwrap().join("\n");
    assert!(headers.contains("accept: application/json"), "{headers}");
    assert!(
        headers.contains("user-agent: tauri-plugin-updater/"),
        "{headers}"
    );
}

#[test]
fn f21_the_same_or_an_older_release_is_up_to_date() {
    let app = app_with_updater();
    for version in [CURRENT, "0.0.9"] {
        let server = release_server(version, PAYLOAD_SIGNATURE, PAYLOAD.to_vec());
        let pending = PendingUpdate::default();
        let result = run_check(app.handle(), &source(&server, TEST_PUBLIC_KEY), &pending);
        assert_eq!(
            result,
            UpdateCheck::new(CURRENT.to_string(), UpdateOutcome::UpToDate),
            "{version}"
        );
        assert_eq!(pending.version(), None);
    }
}

#[test]
fn f21_a_release_that_is_gone_clears_the_kept_update_but_a_failure_keeps_it() {
    let app = app_with_updater();
    let pending = PendingUpdate::default();
    let newer = release_server("0.2.0", PAYLOAD_SIGNATURE, PAYLOAD.to_vec());
    run_check(app.handle(), &source(&newer, TEST_PUBLIC_KEY), &pending);
    assert_eq!(pending.version().as_deref(), Some("0.2.0"));
    // つながらなかっただけでは、見つけた更新を忘れない
    let missing = TestServer::start(|_, _| Reply::Status(404));
    let failed = run_check(app.handle(), &source(&missing, TEST_PUBLIC_KEY), &pending);
    assert!(
        matches!(failed.outcome, UpdateOutcome::Failed { .. }),
        "{failed:?}"
    );
    assert_eq!(pending.version().as_deref(), Some("0.2.0"));
    // 最新と分かったら、忘れる
    let current = release_server(CURRENT, PAYLOAD_SIGNATURE, PAYLOAD.to_vec());
    run_check(app.handle(), &source(&current, TEST_PUBLIC_KEY), &pending);
    assert_eq!(pending.version(), None);
}

#[test]
fn f21_failures_come_back_with_a_reason_and_never_panic() {
    let app = app_with_updater();
    let pending = PendingUpdate::default();
    let reason = |server: &TestServer| match run_check(
        app.handle(),
        &source(server, TEST_PUBLIC_KEY),
        &pending,
    )
    .outcome
    {
        UpdateOutcome::Failed { message } => message,
        other => panic!("失敗のはずが: {other:?}"),
    };
    // 配布先に latest.json が無い（まだ公開していない）
    let not_found = TestServer::start(|_, _| Reply::Status(404));
    assert!(
        reason(&not_found).contains("latest.json"),
        "{}",
        reason(&not_found)
    );
    // JSON でない・形の合わない答え
    let garbage = TestServer::start(|_, _| Reply::Body(b"not json".to_vec()));
    assert!(!reason(&garbage).is_empty());
    let wrong_shape = TestServer::start(|_, _| Reply::Body(b"{\"version\":\"0.2.0\"}".to_vec()));
    assert!(!reason(&wrong_shape).is_empty());
    // この PC 向けの更新が無い
    let other_target = TestServer::start(|port, _| {
        Reply::Body(
            serde_json::json!({
                "version": "0.2.0",
                "platforms": { "plan9-riscv": { "signature": "x", "url": format!("http://127.0.0.1:{port}/payload.bin") } }
            })
            .to_string()
            .into_bytes(),
        )
    });
    assert!(
        reason(&other_target).contains("この PC"),
        "{}",
        reason(&other_target)
    );
    // つなげない（待ち受けていない）
    let closed = {
        let listener = TcpListener::bind("127.0.0.1:0").unwrap();
        let port = listener.local_addr().unwrap().port();
        drop(listener);
        UpdateSource {
            public_key: TEST_PUBLIC_KEY.to_string(),
            endpoint: format!("http://127.0.0.1:{port}/latest.json"),
        }
    };
    match run_check(app.handle(), &closed, &pending).outcome {
        UpdateOutcome::Failed { message } => {
            assert!(message.contains("通信できませんでした"), "{message}")
        }
        other => panic!("{other:?}"),
    }
    // 取り先の URL が読めない
    let bad_url = UpdateSource {
        public_key: TEST_PUBLIC_KEY.to_string(),
        endpoint: "latest.json".to_string(),
    };
    assert!(matches!(
        run_check(app.handle(), &bad_url, &pending).outcome,
        UpdateOutcome::Failed { .. }
    ));
    assert_eq!(pending.version(), None);
}

// ---- 入れ直す前の署名の確かめ ----

#[test]
fn f21_without_a_found_update_there_is_nothing_to_install() {
    let app = app_with_updater();
    let pending = PendingUpdate::default();
    let (result, ran) = run_install(app.handle(), &pending);
    assert_eq!(result, Err(NO_PENDING_MESSAGE.to_string()));
    assert!(!ran);
    // 失敗のあとも、もう一度押せる
    assert_eq!(
        run_install(app.handle(), &pending).0,
        Err(NO_PENDING_MESSAGE.to_string())
    );
}

/// 署名が合う中身は、ダウンロードして署名を確かめるところまで進み、実行ファイルでないので、インストーラーとしては動かせない
/// （試験は、インストーラーを動かさない）。動かす前の片づけも、していない。
#[cfg(windows)]
#[test]
fn f21_a_correctly_signed_download_passes_the_check_and_stops_at_the_installer_format() {
    let server = release_server("0.2.0", PAYLOAD_SIGNATURE, PAYLOAD.to_vec());
    let app = app_with_updater();
    let pending = PendingUpdate::default();
    run_check(app.handle(), &source(&server, TEST_PUBLIC_KEY), &pending);
    assert_eq!(server.requests(), vec!["GET /latest.json HTTP/1.1"]);
    let (result, ran) = run_install(app.handle(), &pending);
    // 署名の確かめは通った（署名の失敗の文ではない）。中身が実行ファイルでないので、そこで止まる
    let message = result.expect_err("実行ファイルでない中身は、動かせない");
    assert!(!message.contains("署名"), "{message}");
    assert!(
        message.contains("invalid updater binary format"),
        "{message}"
    );
    assert!(
        !ran,
        "インストーラーを動かしていないので、閉じる前の片づけもしない"
    );
    // ダウンロードは、入れ直すと決めたあとの 1 回だけ
    assert_eq!(
        server.requests(),
        vec!["GET /latest.json HTTP/1.1", "GET /payload.bin HTTP/1.1"]
    );
    // 失敗したあとも、見つけた更新は残り、もう一度押せる
    assert_eq!(pending.version().as_deref(), Some("0.2.0"));
    assert!(run_install(app.handle(), &pending).0.is_err());
}

#[test]
fn f21_a_tampered_download_is_refused_before_anything_runs() {
    let mut tampered = PAYLOAD.to_vec();
    tampered[0] ^= 0xFF;
    let server = release_server("0.2.0", PAYLOAD_SIGNATURE, tampered);
    let app = app_with_updater();
    let pending = PendingUpdate::default();
    run_check(app.handle(), &source(&server, TEST_PUBLIC_KEY), &pending);
    let (result, ran) = run_install(app.handle(), &pending);
    let message = result.expect_err("改ざんされた中身は入れない");
    assert!(
        message.contains("署名を確かめられませんでした"),
        "{message}"
    );
    assert!(message.contains("中止"), "{message}");
    assert!(!ran);
}

#[test]
fn f21_a_signature_made_for_another_version_is_refused() {
    // 配布先が 0.3.0 と告げるが、署名は 0.2.0 のもの（古い署名つきの物を、新しい版に見せかける）
    let server = release_server("0.3.0", PAYLOAD_SIGNATURE, PAYLOAD.to_vec());
    let app = app_with_updater();
    let pending = PendingUpdate::default();
    let found = run_check(app.handle(), &source(&server, TEST_PUBLIC_KEY), &pending);
    assert!(
        matches!(found.outcome, UpdateOutcome::Available { .. }),
        "{found:?}"
    );
    let (result, ran) = run_install(app.handle(), &pending);
    let message = result.expect_err("別の版の署名は入れない");
    assert!(
        message.contains("署名が、配布先の版と合いません"),
        "{message}"
    );
    assert!(!ran);
}

#[test]
fn f21_a_signature_that_binds_no_version_is_refused() {
    // 版を結ばない署名は、古い署名を新しい版に見せかけるのに使える。更新の部品の設定（requireSignedVersion）が、断る
    let server = release_server("0.2.0", PAYLOAD_SIGNATURE_WITHOUT_VERSION, PAYLOAD.to_vec());
    let app = app_with_updater();
    let pending = PendingUpdate::default();
    run_check(app.handle(), &source(&server, TEST_PUBLIC_KEY), &pending);
    let (result, ran) = run_install(app.handle(), &pending);
    let message = result.expect_err("版を結ばない署名は入れない");
    assert!(
        message.contains("署名が、配布先の版と合いません"),
        "{message}"
    );
    assert!(!ran);
}

#[test]
fn f21_an_unreadable_or_different_public_key_refuses_every_download() {
    let app = app_with_updater();
    // 読めない鍵・形は公開鍵でも、署名した鍵ではない鍵
    for key in ["this-is-not-a-key", OTHER_PUBLIC_KEY] {
        let server = release_server("0.2.0", PAYLOAD_SIGNATURE, PAYLOAD.to_vec());
        let pending = PendingUpdate::default();
        run_check(app.handle(), &source(&server, key), &pending);
        let (result, ran) = run_install(app.handle(), &pending);
        let message = result.expect_err("確かめられない署名は入れない");
        assert!(
            message.contains("署名を確かめられませんでした"),
            "{key}: {message}"
        );
        assert!(!ran);
    }
}

/// 署名が合う中身まで進むので、Windows だけ（実行ファイルでない中身は、Windows のインストーラーとして動かせず、そこで止まる）。
#[cfg(windows)]
#[test]
fn f21_a_second_install_while_one_is_running_is_refused_and_a_failed_one_can_be_tried_again() {
    use jantama_reviewer_lib::update::ALREADY_INSTALLING_MESSAGE;

    // ダウンロードが終わるまでに時間がかかる配布先
    let server = TestServer::start(|port, path| match path {
        "/latest.json" => Reply::Body(manifest(port, "0.2.0", PAYLOAD_SIGNATURE)),
        "/payload.bin" => Reply::Slow(PAYLOAD.to_vec()),
        _ => Reply::Status(404),
    });
    let app = app_with_updater();
    let pending = Arc::new(PendingUpdate::default());
    run_check(app.handle(), &source(&server, TEST_PUBLIC_KEY), &pending);
    let first = {
        let (handle, pending) = (app.handle().clone(), pending.clone());
        thread::spawn(move || run_install(&handle, &pending).0)
    };
    // 1 回目が進んでいる間の 2 回目は、始めずに断る（ダウンロードも 1 回だけ）
    thread::sleep(Duration::from_millis(200));
    assert_eq!(
        run_install(app.handle(), &pending).0,
        Err(ALREADY_INSTALLING_MESSAGE.to_string())
    );
    // 1 回目は、実行ファイルでない中身なので、失敗して戻る。そのあとは、もう一度押せる
    let message = first
        .join()
        .unwrap()
        .expect_err("実行ファイルでない中身は、動かせない");
    assert!(
        message.contains("invalid updater binary format"),
        "{message}"
    );
    let again = run_install(app.handle(), &pending)
        .0
        .expect_err("もう一度、始められる");
    assert_ne!(again, ALREADY_INSTALLING_MESSAGE);
    let downloads = server
        .requests()
        .iter()
        .filter(|line| line.starts_with("GET /payload.bin"))
        .count();
    assert_eq!(
        downloads, 2,
        "ダウンロードは、始めた 2 回だけ（断った 1 回は、つなぎに行かない）"
    );
}
