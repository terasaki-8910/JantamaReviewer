//! 結果 JSON の取得（`import::report_fetch`）の検査（S-2 の「通信先を差し替えられる層の単体テスト」）。
//!
//! 通信先は、この PC の中の試験用サーバー（`TcpListener`）に差し替える。実際の mjai のサイトには、つながない。
//! 確かめること: 通信は GET の 1 回だけで、パスは `/report/<ID>.json` に固定／形の悪い ID では、つなぎにも行かない／
//! 移動の指示には従わない／待ち時間と大きさの上限を守る／JSON でないものは断る。
//! URL の文字列を書くので、ソースの URL を通信の疑いとして拒む安全の検査（`tests/safety.rs`）の対象
//! （`src/`）の外のここに置く。

use std::collections::HashMap;
use std::io::{Read, Write};
use std::net::{SocketAddr, TcpListener, TcpStream};
use std::sync::atomic::{AtomicBool, AtomicUsize, Ordering};
use std::sync::{Arc, Mutex};
use std::thread::{self, JoinHandle};
use std::time::{Duration, Instant};

use jantama_reviewer_lib::import::report_fetch::{
    fetch_report, fetch_report_by_text, fetch_report_with, FetchError, FetchLimits, ReportEndpoint,
    MAX_REPORT_BYTES,
};
use jantama_reviewer_lib::import::report_id::ReportId;

const ID: &str = "f9da87cbcd7af5e9";
const REPORT: &str = r#"{"review":{"kyokus":[]},"mjai_log":[],"note":"見本"}"#;

/// 試験用サーバーの、1 つの要求。
struct Request {
    line: String,
    headers: HashMap<String, String>,
}

/// 返す答え。
enum Reply {
    /// 200 と、Content-Length つきの本文。
    Body(Vec<u8>),
    /// 本文なしの、この状態コード。
    Status(u16),
    /// 302 と、移動先。
    Redirect(String),
    /// 200 で、Content-Length なしに、`total` バイトを流して閉じる（上限を超える流れの確認）。
    Stream { total: usize },
    /// 要求を受けたまま、何も返さない（待ち時間の確認）。
    Hang,
}

struct TestServer {
    addr: SocketAddr,
    requests: Arc<Mutex<Vec<Request>>>,
    connections: Arc<AtomicUsize>,
    stop: Arc<AtomicBool>,
    thread: Option<JoinHandle<()>>,
}

impl TestServer {
    fn start(handler: impl Fn(&Request) -> Reply + Send + Sync + 'static) -> TestServer {
        let listener = TcpListener::bind("127.0.0.1:0").unwrap();
        listener.set_nonblocking(true).unwrap();
        let addr = listener.local_addr().unwrap();
        let requests = Arc::new(Mutex::new(Vec::new()));
        let connections = Arc::new(AtomicUsize::new(0));
        let stop = Arc::new(AtomicBool::new(false));
        let handler = Arc::new(handler);
        let thread = {
            let (requests, connections, stop) =
                (requests.clone(), connections.clone(), stop.clone());
            thread::spawn(move || {
                while !stop.load(Ordering::SeqCst) {
                    match listener.accept() {
                        Ok((stream, _)) => {
                            connections.fetch_add(1, Ordering::SeqCst);
                            let (requests, handler, stop) =
                                (requests.clone(), handler.clone(), stop.clone());
                            thread::spawn(move || {
                                let _ = serve_one(stream, &*handler, &requests, &stop);
                            });
                        }
                        Err(_) => thread::sleep(Duration::from_millis(2)),
                    }
                }
            })
        };
        TestServer {
            addr,
            requests,
            connections,
            stop,
            thread: Some(thread),
        }
    }

    fn endpoint(&self) -> ReportEndpoint {
        ReportEndpoint::for_test("http", "127.0.0.1", self.addr.port())
    }

    fn request_lines(&self) -> Vec<String> {
        self.requests
            .lock()
            .unwrap()
            .iter()
            .map(|r| r.line.clone())
            .collect()
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

fn read_request(stream: &mut TcpStream) -> std::io::Result<Request> {
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
    let headers = lines
        .filter_map(|l| l.split_once(':'))
        .map(|(k, v)| (k.trim().to_ascii_lowercase(), v.trim().to_string()))
        .collect();
    Ok(Request { line, headers })
}

fn serve_one(
    mut stream: TcpStream,
    handler: &(dyn Fn(&Request) -> Reply + Send + Sync),
    requests: &Mutex<Vec<Request>>,
    stop: &AtomicBool,
) -> std::io::Result<()> {
    stream.set_nonblocking(false)?;
    let request = read_request(&mut stream)?;
    let reply = handler(&request);
    requests.lock().unwrap().push(request);
    match reply {
        Reply::Body(body) => {
            let head = format!(
                "HTTP/1.1 200 OK\r\nContent-Type: application/json\r\nContent-Length: {}\r\nConnection: close\r\n\r\n",
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
        Reply::Redirect(location) => {
            let head = format!(
                "HTTP/1.1 302 Found\r\nLocation: {location}\r\nContent-Length: 0\r\nConnection: close\r\n\r\n"
            );
            stream.write_all(head.as_bytes())?;
        }
        Reply::Stream { total } => {
            stream.write_all(
                b"HTTP/1.1 200 OK\r\nContent-Type: application/json\r\nConnection: close\r\n\r\n",
            )?;
            let chunk = vec![b' '; 16 * 1024];
            let mut sent = 0;
            while sent < total {
                let n = chunk.len().min(total - sent);
                if stream.write_all(&chunk[..n]).is_err() {
                    break;
                }
                sent += n;
            }
        }
        Reply::Hang => {
            let deadline = Instant::now() + Duration::from_secs(10);
            while Instant::now() < deadline && !stop.load(Ordering::SeqCst) {
                thread::sleep(Duration::from_millis(10));
            }
        }
    }
    let _ = stream.flush();
    Ok(())
}

fn id(text: &str) -> ReportId {
    ReportId::parse(text).unwrap()
}

fn fast_limits(max_bytes: u64) -> FetchLimits {
    FetchLimits {
        timeout: Duration::from_secs(5),
        connect_timeout: Duration::from_secs(2),
        max_bytes,
    }
}

// ---- 通信は GET の 1 回だけで、パスは固定 ----

#[test]
fn s2_the_report_is_fetched_with_one_get_to_the_fixed_report_path() {
    let server = TestServer::start(|_| Reply::Body(REPORT.as_bytes().to_vec()));
    let text = fetch_report(&server.endpoint(), &id(ID)).unwrap();
    assert_eq!(text, REPORT);
    // 要求は 1 回の GET で、パスは /report/<ID>.json（検索の文字も無い）。
    assert_eq!(
        server.request_lines(),
        vec![format!("GET /report/{ID}.json HTTP/1.1")]
    );
    assert_eq!(server.connection_count(), 1);
    let requests = server.requests.lock().unwrap();
    let headers = &requests[0].headers;
    assert_eq!(
        headers.get("host").map(String::as_str),
        Some(format!("127.0.0.1:{}", server.addr.port()).as_str())
    );
    assert!(headers
        .get("accept")
        .is_some_and(|v| v.contains("application/json")));
    assert!(
        headers
            .get("user-agent")
            .is_some_and(|v| v.starts_with("JantamaReviewer/")),
        "名乗る名前: {headers:?}"
    );
    assert!(!headers.contains_key("cookie") && !headers.contains_key("authorization"));
}

#[test]
fn s2_a_bad_id_never_opens_a_connection() {
    let server = TestServer::start(|_| Reply::Body(REPORT.as_bytes().to_vec()));
    for bad in [
        "",
        "F9DA87CBCD7AF5E9",
        "f9da87cbcd7af5e",
        "f9da87cbcd7af5e90",
        "../report/f9da87cbcd7af5e9",
        "f9da87cbcd7af5e9.json",
        "f9da87cbcd7af5e9?x=1",
        "f9da87cbcd7af5e9/../x",
        "f9da87cbcd7af5e9 ",
        "ｆ9da87cbcd7af5e9",
    ] {
        assert_eq!(
            fetch_report_by_text(&server.endpoint(), bad),
            Err(FetchError::InvalidId),
            "{bad:?}"
        );
    }
    // 少し待っても、つなぎに来ない。
    thread::sleep(Duration::from_millis(100));
    assert_eq!(server.connection_count(), 0);
    assert!(server.request_lines().is_empty());
}

#[test]
fn s2_the_production_endpoint_is_https_to_the_mjai_site_at_the_fixed_path() {
    let url = ReportEndpoint::production().report_url(&id(ID)).unwrap();
    assert_eq!(
        url.as_str(),
        format!("https://mjai.ekyu.moe/report/{ID}.json")
    );
}

// ---- 応答の扱い ----

#[test]
fn error_statuses_become_status_errors_with_a_helpful_message() {
    for code in [403u16, 404, 429, 500, 503] {
        let server = TestServer::start(move |_| Reply::Status(code));
        let error = fetch_report(&server.endpoint(), &id(ID)).unwrap_err();
        assert_eq!(error, FetchError::Status(code));
        assert_eq!(
            server.connection_count(),
            1,
            "{code}: 1 回だけ（やり直さない）"
        );
    }
    assert!(FetchError::Status(404).to_string().contains("期限"));
    assert!(FetchError::Status(429).to_string().contains("混み合って"));
}

#[test]
fn a_redirect_is_not_followed() {
    let other = TestServer::start(|_| Reply::Body(REPORT.as_bytes().to_vec()));
    let target = format!("http://127.0.0.1:{}/elsewhere", other.addr.port());
    let server = TestServer::start(move |_| Reply::Redirect(target.clone()));
    let error = fetch_report(&server.endpoint(), &id(ID)).unwrap_err();
    assert_eq!(error, FetchError::Status(302));
    thread::sleep(Duration::from_millis(100));
    assert_eq!(other.connection_count(), 0, "移動先には、つながない");
    assert_eq!(server.connection_count(), 1);
}

#[test]
fn a_body_larger_than_the_limit_is_refused_whether_or_not_its_length_is_announced() {
    // 長さを知らせてくる。
    let server = TestServer::start(|_| Reply::Body(vec![b' '; 4096]));
    assert_eq!(
        fetch_report_with(&server.endpoint(), &id(ID), &fast_limits(1024)),
        Err(FetchError::TooLarge(1024))
    );
    // 長さを知らせず、流し続ける。
    let server = TestServer::start(|_| Reply::Stream { total: 256 * 1024 });
    assert_eq!(
        fetch_report_with(&server.endpoint(), &id(ID), &fast_limits(1024)),
        Err(FetchError::TooLarge(1024))
    );
}

#[test]
fn a_body_exactly_at_the_limit_is_accepted() {
    let mut body = String::from(r#"{"a":""#);
    body.push_str(&"x".repeat(1024 - body.len() - 2));
    body.push_str("\"}");
    assert_eq!(body.len(), 1024);
    let expected = body.clone();
    let server = TestServer::start(move |_| Reply::Body(body.clone().into_bytes()));
    assert_eq!(
        fetch_report_with(&server.endpoint(), &id(ID), &fast_limits(1024)),
        Ok(expected)
    );
}

#[test]
fn the_default_limit_is_32_megabytes() {
    assert_eq!(MAX_REPORT_BYTES, 32 * 1024 * 1024);
    assert_eq!(FetchLimits::default().max_bytes, MAX_REPORT_BYTES);
}

#[test]
fn a_server_that_never_answers_times_out() {
    let server = TestServer::start(|_| Reply::Hang);
    let limits = FetchLimits {
        timeout: Duration::from_millis(400),
        connect_timeout: Duration::from_millis(400),
        max_bytes: MAX_REPORT_BYTES,
    };
    let started = Instant::now();
    let error = fetch_report_with(&server.endpoint(), &id(ID), &limits).unwrap_err();
    assert_eq!(error, FetchError::Timeout);
    assert!(
        started.elapsed() < Duration::from_secs(5),
        "{:?}",
        started.elapsed()
    );
}

#[test]
fn something_that_is_not_a_json_report_is_refused() {
    for (body, expected) in [
        (
            b"<html><body>error</body></html>".to_vec(),
            FetchError::NotJson,
        ),
        (b"".to_vec(), FetchError::NotJson),
        (b"{\"a\":".to_vec(), FetchError::NotJson),
        (vec![0xff, 0xfe, 0x00, 0x01], FetchError::NotUtf8),
    ] {
        let server = TestServer::start(move |_| Reply::Body(body.clone()));
        assert_eq!(fetch_report(&server.endpoint(), &id(ID)), Err(expected));
    }
}

#[test]
fn a_leading_byte_order_mark_is_dropped() {
    let server = TestServer::start(|_| Reply::Body(format!("\u{feff}{REPORT}").into_bytes()));
    assert_eq!(fetch_report(&server.endpoint(), &id(ID)).unwrap(), REPORT);
}

#[test]
fn a_closed_port_fails_in_bounded_time_instead_of_hanging() {
    // 空いているポートを取って、すぐ閉じる。Windows は、閉じたポートへの接続の拒否を知らせるまでに 2 秒ほどかかることがあり、
    // つなぐ待ち時間（ここでは 1 秒）が先に来れば Timeout になる。どちらでも、失敗として、時間内に返ればよい。
    let port = TcpListener::bind("127.0.0.1:0")
        .unwrap()
        .local_addr()
        .unwrap()
        .port();
    let endpoint = ReportEndpoint::for_test("http", "127.0.0.1", port);
    let limits = FetchLimits {
        timeout: Duration::from_secs(5),
        connect_timeout: Duration::from_secs(1),
        max_bytes: 1024,
    };
    let started = Instant::now();
    let error = fetch_report_with(&endpoint, &id(ID), &limits).unwrap_err();
    assert!(
        matches!(error, FetchError::Network(_) | FetchError::Timeout),
        "{error:?}"
    );
    assert!(
        started.elapsed() < Duration::from_secs(5),
        "{:?}",
        started.elapsed()
    );
}
