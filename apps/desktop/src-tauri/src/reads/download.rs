//! 読みのモデルを、Hugging Face の決まった版から取る（F24、S-2）。モデルを取る通信は、この 1 つのファイルだけ。
//!
//! 取るのは、ユーザーが設定の「Hugging Face から取る」を押したときだけ。要求は GET の 1 種類（`/<リポジトリ>/resolve/<コミット>/<ファイル>`）。
//! 守ること:
//! - 通信先は、スキーム・ホスト・パスを部品から組み立てる（URL の文字列は書かない）。https だけ。ホストは、配布元（`MODEL_HOST`）と、
//!   その配布の置き場（`.hf.co` で終わるもの）だけ。移動の指示には、1 回ずつ自分で従い（最大 3 回）、移し先が決まりに合わなければ断る。
//!   決まりを通った通信先（`CheckedUrl`）しか、通信の層（`Transport`）には渡せない。
//! - 待ち時間と、受け取る大きさの上限（64 MiB）を決める。取ったものは、いったん `<名前>.part` に書き、SHA-256 が決まった版と合ってから、
//!   本来の名前にする（合わなければ捨てる）。取り消し・失敗のときも、途中のファイルを必ず消す。
//! - 通信は `Transport`（差し替えられる層）の向こう。製品は `UreqTransport` だけを使い、試験は偽物を使う（試験では、本物の通信をしない。U-54）。

use std::fmt;
use std::fs::{self, File};
use std::io::{self, ErrorKind, Read, Write};
use std::path::{Path, PathBuf};
use std::sync::atomic::{AtomicBool, Ordering};
use std::time::{Duration, Instant};

use serde::Serialize;
use sha2::{Digest, Sha256};
use url::Url;

use super::catalog::ModelSpec;
use super::pump::{Next, Pump};
use crate::ids::hex;

/// 通信のスキーム。https だけ。
const SCHEME: &str = "https";
/// モデルの配布元のホスト。
pub const MODEL_HOST: &str = "huggingface.co";
/// 配布元が、実際のファイルを置いている場所のホストの終わり（2026-10-30 は `us.aws.cdn.hf.co`）。
pub const MODEL_HOST_SUFFIX: &str = ".hf.co";

/// 受け取る大きさの上限（バイト）。
pub const MAX_MODEL_BYTES: u64 = 64 * 1024 * 1024;
/// 従ってよい移動の指示の回数。
pub const MAX_REDIRECTS: u32 = 3;
/// 進み具合を知らせる間隔（バイト）。これより細かくは知らせない。
pub const PROGRESS_STEP: u64 = 256 * 1024;
/// 1 バイトも来ないまま待ってよい時間。これを超えたら、取るのをやめる。
pub const STALL_TIMEOUT: Duration = Duration::from_secs(30);

/// 1 回の読み取りの大きさ（バイト）。
const CHUNK: usize = 64 * 1024;
/// 受け取りを待つ間隔。待つたびに、取り消しの旗を見る。
const TICK: Duration = Duration::from_millis(50);
/// つなぐのにかけてよい時間。
const CONNECT_TIMEOUT: Duration = Duration::from_secs(10);
/// 要求を送ってから、返事の頭（状態と見出し）が届くまでにかけてよい時間。
const RESPONSE_TIMEOUT: Duration = Duration::from_secs(30);
/// 1 回の通信（つなぐところから、受け取り終わるまで）にかけてよい時間。
const TOTAL_TIMEOUT: Duration = Duration::from_secs(10 * 60);

/// アプリが名乗る名前（相手のサイトの運営者が、何の通信か分かるように）。
const USER_AGENT: &str = concat!("JantamaReviewer/", env!("CARGO_PKG_VERSION"));

/// 取るときの上限と間隔。製品は `Default`、試験は小さな値に替える。
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub struct DownloadLimits {
    /// 受け取る大きさの上限（バイト）。
    pub max_bytes: u64,
    /// 従ってよい移動の指示の回数。
    pub max_redirects: u32,
    /// 進み具合を知らせる間隔（バイト）。
    pub progress_step: u64,
    /// 1 バイトも来ないまま待ってよい時間。
    pub stall_timeout: Duration,
}

impl Default for DownloadLimits {
    fn default() -> Self {
        DownloadLimits {
            max_bytes: MAX_MODEL_BYTES,
            max_redirects: MAX_REDIRECTS,
            progress_step: PROGRESS_STEP,
            stall_timeout: STALL_TIMEOUT,
        }
    }
}

/// 取っている途中の進み具合（画面の `reads-model-progress` の知らせ。`total` は、配布元が大きさを告げないときは `None`）。
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize)]
pub struct ModelProgress {
    pub done: u64,
    pub total: Option<u64>,
}

/// 取るのに失敗した理由。画面に出せる日本語の文を持つ。
#[derive(Debug, Clone, PartialEq, Eq)]
pub enum DownloadError {
    /// 取り先を組み立てられない・決まった形でない（通信はしていない）。
    BadUrl(String),
    /// https でない所へ移された。中身は、そのスキーム。
    NotHttps(String),
    /// 決まった配布先ではない所へ移された。中身は、そのホスト。
    ForeignHost(String),
    /// 移し先の書き方が正しくない（読めない・認証の情報やポートが付いている）。
    BadLocation(String),
    /// 移動の指示が、従ってよい回数を超えた。
    TooManyRedirects,
    /// 移動の指示なのに、移し先が無い。
    NoLocation,
    /// 200 以外の返事。
    Status(u16),
    /// 受け取る大きさの上限を超えた。
    TooLarge(u64),
    /// 待ち時間を超えた。
    Timeout,
    /// つなげない・途中で切れたなど。
    Network(String),
    /// ファイルを書けない。
    Write(String),
    /// 取ったものの SHA-256 が、決まった版と違う。
    ShaMismatch,
    /// ユーザーが取り消した。
    Cancelled,
}

impl fmt::Display for DownloadError {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        match self {
            DownloadError::BadUrl(reason) => write!(f, "取り先を組み立てられません: {reason}"),
            DownloadError::NotHttps(scheme) => write!(
                f,
                "https でない所（{scheme}）へ移されました。受け付けません"
            ),
            DownloadError::ForeignHost(host) => {
                write!(f, "決まった配布先ではない所（{host}）へ移されました")
            }
            DownloadError::BadLocation(location) => {
                write!(f, "移し先の書き方が正しくありません（{location}）")
            }
            DownloadError::TooManyRedirects => {
                write!(f, "移される先が多すぎます（{MAX_REDIRECTS} 回までです）")
            }
            DownloadError::NoLocation => f.write_str("配布先が、移し先を告げませんでした"),
            DownloadError::Status(404) => f.write_str(
                "配布先に、決まった版のファイルがありません（HTTP 404）。自分で取ったファイルを選ぶこともできます",
            ),
            DownloadError::Status(429) => f.write_str(
                "配布先が混み合っています（HTTP 429）。しばらくしてから、もう一度試してください",
            ),
            DownloadError::Status(code) if *code >= 500 => write!(
                f,
                "配布先の側のエラーです（HTTP {code}）。しばらくしてから、もう一度試してください"
            ),
            DownloadError::Status(code) => {
                write!(f, "配布先がファイルを返しませんでした（HTTP {code}）")
            }
            DownloadError::TooLarge(limit) => {
                write!(f, "ファイルが大きすぎます（上限は {}）", size_text(*limit))
            }
            DownloadError::Timeout => f.write_str(
                "配布先の応答が途切れました。しばらくしてから、もう一度試してください",
            ),
            DownloadError::Network(reason) => write!(f, "配布先につながりません: {reason}"),
            DownloadError::Write(reason) => {
                write!(f, "モデルのファイルを書けませんでした: {reason}")
            }
            DownloadError::ShaMismatch => f.write_str(
                "取ったファイルが、決まった版と違います（sha256）。もう一度試してください",
            ),
            DownloadError::Cancelled => f.write_str("取るのを取り消しました"),
        }
    }
}

impl std::error::Error for DownloadError {}

/// 大きさの上限を、画面に出す文にする（1 MiB 以上は MB、それより小さいときはバイト）。
fn size_text(bytes: u64) -> String {
    const MIB: u64 = 1024 * 1024;
    if bytes >= MIB {
        format!("{} MB", bytes / MIB)
    } else {
        format!("{bytes} バイト")
    }
}

fn write_error(error: &io::Error) -> DownloadError {
    DownloadError::Write(error.to_string())
}

/// 読み取りの失敗を、取るのに失敗した理由にする（待ち時間の超過は、そのまま伝える）。
fn read_error(error: &io::Error) -> DownloadError {
    if error.kind() == ErrorKind::TimedOut {
        DownloadError::Timeout
    } else {
        DownloadError::Network(error.to_string())
    }
}

// ---- 通信先の決まり ----

/// 決まりを通った通信先。決まりを通さずには作れない（`Transport` に渡せるのは、これだけ）。
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct CheckedUrl(Url);

impl CheckedUrl {
    pub fn as_str(&self) -> &str {
        self.0.as_str()
    }

    pub fn host(&self) -> &str {
        self.0.host_str().unwrap_or("")
    }
}

/// ホストが、配布元か、その配布の置き場（`.hf.co` で終わる、名前のあるホスト）か。
pub fn is_allowed_host(host: &str) -> bool {
    host == MODEL_HOST
        || (host.len() > MODEL_HOST_SUFFIX.len() && host.ends_with(MODEL_HOST_SUFFIX))
}

/// 通信先の決まり: https・認証の情報なし・標準のポート・ホストが決まったもの。
fn check_url(url: Url) -> Result<CheckedUrl, DownloadError> {
    if url.scheme() != SCHEME {
        return Err(DownloadError::NotHttps(url.scheme().to_string()));
    }
    if !url.username().is_empty() || url.password().is_some() || url.port().is_some() {
        return Err(DownloadError::BadLocation(url.to_string()));
    }
    let host = url.host_str().unwrap_or("");
    if !is_allowed_host(host) {
        return Err(DownloadError::ForeignHost(host.to_string()));
    }
    Ok(CheckedUrl(url))
}

/// 決まった版を取る URL。スキーム・ホスト・パスを部品から組み立て、組み立てたものが部品のとおりかを確かめる。
pub fn model_url(spec: &ModelSpec) -> Result<CheckedUrl, DownloadError> {
    let path = format!("/{}/resolve/{}/{}", spec.repo, spec.revision, spec.file);
    let text = format!("{SCHEME}://{MODEL_HOST}{path}");
    let url = Url::parse(&text).map_err(|e| DownloadError::BadUrl(e.to_string()))?;
    let fixed = url.host_str() == Some(MODEL_HOST)
        && url.path() == path
        && url.query().is_none()
        && url.fragment().is_none();
    if !fixed {
        return Err(DownloadError::BadUrl(format!(
            "組み立てた取り先が、決まった形ではありません: {url}"
        )));
    }
    check_url(url)
}

/// 移動の指示（`Location`。相対でもよい）の移し先。いまの通信先と同じ決まりを通ったものだけ。
fn follow(current: &CheckedUrl, location: &str) -> Result<CheckedUrl, DownloadError> {
    let next = current
        .0
        .join(location)
        .map_err(|_| DownloadError::BadLocation(location.to_string()))?;
    check_url(next)
}

// ---- 通信の層（差し替えられる） ----

/// 返事の本文。`length` は、配布元が大きさを告げたときだけ。
pub struct Body {
    pub length: Option<u64>,
    pub reader: Box<dyn Read + Send>,
}

/// 1 回の GET の返事。
pub enum Reply {
    /// 200。本文を読める。
    Body(Body),
    /// 移動の指示。中身は `Location` の文字（相対でもよい）。
    Redirect(String),
    /// ほかの状態。
    Status(u16),
}

/// 通信の層。GET を 1 回行って、返事を返す。移動の指示には従わない（従うかは、呼ぶ側が決める）。
/// 渡せるのは、決まりを通った通信先（`CheckedUrl`）だけ。
pub trait Transport: Send + Sync {
    fn get(&self, url: &CheckedUrl) -> Result<Reply, DownloadError>;
}

/// 製品の通信の層（`ureq`）。https だけ・移動の指示には従わない・待ち時間つき。TLS は OS のもの（同梱の証明書の一覧を持たない）。
pub struct UreqTransport {
    agent: ureq::Agent,
}

impl UreqTransport {
    pub fn new() -> UreqTransport {
        let tls = ureq::tls::TlsConfig::builder()
            .provider(ureq::tls::TlsProvider::NativeTls)
            .root_certs(ureq::tls::RootCerts::PlatformVerifier)
            .build();
        let config = ureq::Agent::config_builder()
            .tls_config(tls)
            .https_only(true)
            .max_redirects(0)
            .timeout_global(Some(TOTAL_TIMEOUT))
            .timeout_connect(Some(CONNECT_TIMEOUT))
            .timeout_recv_response(Some(RESPONSE_TIMEOUT))
            .user_agent(USER_AGENT)
            .build();
        UreqTransport {
            agent: config.into(),
        }
    }
}

impl Default for UreqTransport {
    fn default() -> Self {
        UreqTransport::new()
    }
}

impl Transport for UreqTransport {
    fn get(&self, url: &CheckedUrl) -> Result<Reply, DownloadError> {
        let response = self
            .agent
            .get(url.as_str())
            .header("Accept", "application/octet-stream")
            .call()
            .map_err(map_transport_error)?;
        Ok(reply_of(response, MAX_MODEL_BYTES))
    }
}

fn map_transport_error(error: ureq::Error) -> DownloadError {
    match error {
        ureq::Error::Timeout(_) => DownloadError::Timeout,
        ureq::Error::BodyExceedsLimit(_) => DownloadError::TooLarge(MAX_MODEL_BYTES),
        ureq::Error::StatusCode(code) => DownloadError::Status(code),
        other => DownloadError::Network(other.to_string()),
    }
}

/// `ureq` の返事を、通信の層の返事にする。本文は、`max_bytes` を超えたところで、読み取りが失敗する
/// （ureq の上限は、ちょうどの長さに達した時点で断るので、1 バイト多く読ませて、超えたことを呼ぶ側が数える）。
fn reply_of(response: ureq::http::Response<ureq::Body>, max_bytes: u64) -> Reply {
    let status = response.status().as_u16();
    match status {
        200 => {
            let length = response.body().content_length();
            let reader = response
                .into_body()
                .into_with_config()
                .limit(max_bytes.saturating_add(1))
                .reader();
            Reply::Body(Body {
                length,
                reader: Box::new(reader),
            })
        }
        301 | 302 | 303 | 307 | 308 => {
            match response
                .headers()
                .get("location")
                .and_then(|value| value.to_str().ok())
            {
                Some(location) => Reply::Redirect(location.to_string()),
                None => Reply::Status(status),
            }
        }
        other => Reply::Status(other),
    }
}

// ---- 取る ----

/// 途中のファイル。作った側が降りるとき（成功で本来の名前にしたあとを除く）、必ず消す。
struct PartFile {
    path: PathBuf,
    keep: bool,
}

impl Drop for PartFile {
    fn drop(&mut self) {
        if !self.keep {
            let _ = fs::remove_file(&self.path);
        }
    }
}

/// 決まった版 `spec` を取って、`models_dir` に、本来の名前で置く。
///
/// 進み具合は `progress` に知らせる（最初に 0 を 1 回、あとは `limits.progress_step` 進むごとに 1 回、最後に 1 回）。
/// `cancel` が立つと、待っている間も、すぐ止めて、途中のファイルを消す。失敗・取り消しのときは、本来の名前のファイルに触れない。
pub fn download_model(
    spec: &ModelSpec,
    transport: &dyn Transport,
    models_dir: &Path,
    limits: &DownloadLimits,
    cancel: &AtomicBool,
    progress: &mut dyn FnMut(ModelProgress),
) -> Result<(), DownloadError> {
    fs::create_dir_all(models_dir).map_err(|e| write_error(&e))?;
    let target = spec.target_in(models_dir);
    let mut part = PartFile {
        path: spec.part_in(models_dir),
        keep: false,
    };

    // 取り先から、本文が返るところまで、移動の指示に従って進む
    let mut url = model_url(spec)?;
    let mut followed = 0u32;
    let body = loop {
        if cancel.load(Ordering::SeqCst) {
            return Err(DownloadError::Cancelled);
        }
        match transport.get(&url)? {
            Reply::Body(body) => break body,
            Reply::Redirect(location) => {
                if followed >= limits.max_redirects {
                    return Err(DownloadError::TooManyRedirects);
                }
                followed += 1;
                url = follow(&url, &location)?;
            }
            Reply::Status(code) if (300..400).contains(&code) => {
                return Err(DownloadError::NoLocation)
            }
            Reply::Status(code) => return Err(DownloadError::Status(code)),
        }
    };
    let total = body.length;
    if total.is_some_and(|length| length > limits.max_bytes) {
        return Err(DownloadError::TooLarge(limits.max_bytes));
    }

    let digest = stream_to_file(body, &part.path, limits, cancel, progress)?;
    if digest != spec.sha256 {
        return Err(DownloadError::ShaMismatch);
    }
    fs::rename(&part.path, &target).map_err(|e| write_error(&e))?;
    part.keep = true;
    Ok(())
}

/// 本文を、読み取りの担当に読ませながら、`path` に書く。書いた中身の SHA-256 を返す。
fn stream_to_file(
    body: Body,
    path: &Path,
    limits: &DownloadLimits,
    cancel: &AtomicBool,
    progress: &mut dyn FnMut(ModelProgress),
) -> Result<String, DownloadError> {
    let total = body.length;
    let pump = Pump::spawn(body.reader, CHUNK)
        .map_err(|e| DownloadError::Network(format!("読み取りの担当を起こせませんでした: {e}")))?;
    let mut file = File::create(path).map_err(|e| write_error(&e))?;
    let mut hasher = Sha256::new();
    let mut done = 0u64;
    let mut reported = 0u64;
    let mut last_data = Instant::now();
    progress(ModelProgress { done, total });
    loop {
        if cancel.load(Ordering::SeqCst) {
            return Err(DownloadError::Cancelled);
        }
        match pump.next(TICK) {
            Next::Data(bytes) => {
                last_data = Instant::now();
                let size = bytes.len() as u64;
                if done.saturating_add(size) > limits.max_bytes {
                    return Err(DownloadError::TooLarge(limits.max_bytes));
                }
                file.write_all(&bytes).map_err(|e| write_error(&e))?;
                hasher.update(&bytes);
                done += size;
                if done - reported >= limits.progress_step {
                    progress(ModelProgress { done, total });
                    reported = done;
                }
            }
            Next::End => break,
            Next::Failed(e) => return Err(read_error(&e)),
            Next::Idle => {
                if last_data.elapsed() >= limits.stall_timeout {
                    return Err(DownloadError::Timeout);
                }
            }
        }
    }
    file.flush().map_err(|e| write_error(&e))?;
    file.sync_all().map_err(|e| write_error(&e))?;
    if done != reported {
        progress(ModelProgress { done, total });
    }
    Ok(hex(&hasher.finalize()))
}

#[cfg(test)]
mod tests {
    use std::collections::VecDeque;
    use std::io::Cursor;
    use std::sync::{Arc, Condvar, Mutex};
    use std::thread;

    use super::*;
    use crate::ids::sha256_hex;
    use crate::reads::catalog::{MODEL_FILE, MODEL_REPO, MODEL_REVISION, READS_MODEL};

    /// 試験用の、小さな偽の版。中身 `content` の大きさと SHA-256 を、版に持たせる。
    fn spec_for(content: &[u8]) -> ModelSpec {
        ModelSpec {
            sha256: Box::leak(sha256_hex(content).into_boxed_str()),
            bytes: content.len() as u64,
            ..READS_MODEL
        }
    }

    /// 試験用の通信先の文字（スキームを替えられる）。
    fn address(scheme: &str, host: &str, path: &str) -> String {
        format!("{scheme}://{host}{path}")
    }

    fn secure(host: &str, path: &str) -> String {
        address(SCHEME, host, path)
    }

    /// 決まった順に答える、偽の通信の層。呼ばれた通信先を、すべて覚える。
    struct Script {
        replies: Mutex<VecDeque<Result<Reply, DownloadError>>>,
        seen: Mutex<Vec<String>>,
    }

    impl Script {
        fn new(replies: Vec<Result<Reply, DownloadError>>) -> Script {
            Script {
                replies: Mutex::new(replies.into()),
                seen: Mutex::new(Vec::new()),
            }
        }

        fn seen(&self) -> Vec<String> {
            self.seen.lock().unwrap().clone()
        }
    }

    impl Transport for Script {
        fn get(&self, url: &CheckedUrl) -> Result<Reply, DownloadError> {
            self.seen.lock().unwrap().push(url.as_str().to_string());
            self.replies
                .lock()
                .unwrap()
                .pop_front()
                .expect("偽の通信の層に、残りの答えが無い")
        }
    }

    fn body_of(bytes: &[u8], length: Option<u64>) -> Result<Reply, DownloadError> {
        Ok(Reply::Body(Body {
            length,
            reader: Box::new(Cursor::new(bytes.to_vec())),
        }))
    }

    fn redirect(location: &str) -> Result<Reply, DownloadError> {
        Ok(Reply::Redirect(location.to_string()))
    }

    /// 呼ぶたびに、決まった塊を 1 つ返す読み取り。`on_chunk` は、塊を返す前に、何番目かを知らせて呼ばれる。
    struct Chunks {
        chunks: VecDeque<Vec<u8>>,
        given: usize,
        on_chunk: Box<dyn FnMut(usize) + Send>,
    }

    impl Read for Chunks {
        fn read(&mut self, buffer: &mut [u8]) -> io::Result<usize> {
            let Some(chunk) = self.chunks.pop_front() else {
                return Ok(0);
            };
            self.given += 1;
            (self.on_chunk)(self.given);
            buffer[..chunk.len()].copy_from_slice(&chunk);
            Ok(chunk.len())
        }
    }

    fn chunked_body(
        pieces: Vec<Vec<u8>>,
        length: Option<u64>,
        on_chunk: impl FnMut(usize) + Send + 'static,
    ) -> Result<Reply, DownloadError> {
        Ok(Reply::Body(Body {
            length,
            reader: Box::new(Chunks {
                chunks: pieces.into(),
                given: 0,
                on_chunk: Box::new(on_chunk),
            }),
        }))
    }

    struct Fixture {
        dir: tempfile::TempDir,
    }

    impl Fixture {
        fn new() -> Fixture {
            Fixture {
                dir: tempfile::tempdir().unwrap(),
            }
        }

        fn models(&self) -> PathBuf {
            self.dir.path().join("models")
        }

        fn names(&self) -> Vec<String> {
            let mut names: Vec<String> = match fs::read_dir(self.models()) {
                Ok(entries) => entries
                    .flatten()
                    .map(|e| e.file_name().to_string_lossy().into_owned())
                    .collect(),
                Err(_) => Vec::new(),
            };
            names.sort();
            names
        }

        /// 取る。進み具合の知らせも返す。
        fn run(
            &self,
            spec: &ModelSpec,
            transport: &dyn Transport,
            limits: &DownloadLimits,
            cancel: &AtomicBool,
        ) -> (Result<(), DownloadError>, Vec<ModelProgress>) {
            let mut events = Vec::new();
            let result =
                download_model(spec, transport, &self.models(), limits, cancel, &mut |p| {
                    events.push(p)
                });
            (result, events)
        }
    }

    fn small_limits() -> DownloadLimits {
        DownloadLimits {
            max_bytes: 1024 * 1024,
            max_redirects: MAX_REDIRECTS,
            progress_step: 4,
            stall_timeout: Duration::from_secs(5),
        }
    }

    // ---- 通信先の決まり ----

    #[test]
    fn s2_the_model_url_is_built_from_its_parts_and_points_at_the_pinned_commit() {
        let url = model_url(&READS_MODEL).unwrap();
        assert_eq!(
            url.as_str(),
            secure(
                MODEL_HOST,
                &format!("/{MODEL_REPO}/resolve/{MODEL_REVISION}/{MODEL_FILE}")
            )
        );
        assert_eq!(url.host(), "huggingface.co");
        // 動く名前（main など）ではなく、コミットで固定している
        assert!(url
            .as_str()
            .contains("/resolve/7784a9deddf63df03f023474116f715850d3c7a0/"));
        assert!(url.as_str().ends_with("/tenpai.onnx"));
        // 部品が URL の区切りを含むと、組み立てた形が変わるので、断る
        let evil = ModelSpec {
            file: "x?y=1#z",
            ..READS_MODEL
        };
        assert!(matches!(model_url(&evil), Err(DownloadError::BadUrl(_))));
    }

    #[test]
    fn s2_only_the_distribution_host_and_hosts_ending_in_dot_hf_dot_co_are_allowed() {
        for allowed in [
            "huggingface.co",
            "us.aws.cdn.hf.co",
            "cdn-lfs.hf.co",
            "a.b.hf.co",
        ] {
            assert!(is_allowed_host(allowed), "{allowed}");
        }
        for denied in [
            "",
            "hf.co",
            ".hf.co",
            "evilhf.co",
            "hf.co.evil.example",
            "huggingface.com",
            "huggingface.co.evil.example",
            "xhuggingface.co",
            "huggingface.co.",
            "us.aws.cdn.hf.co.evil.example",
            "evil.example",
            "127.0.0.1",
            "[::1]",
            "mjai.ekyu.moe",
        ] {
            assert!(!is_allowed_host(denied), "{denied}");
        }
    }

    #[test]
    fn s2_a_destination_must_be_https_without_credentials_or_a_port_on_an_allowed_host() {
        let ok = |text: &str| check_url(Url::parse(text).unwrap());
        assert!(ok(&secure("us.aws.cdn.hf.co", "/repos/x?token=1")).is_ok());
        assert_eq!(
            ok(&address("http", "huggingface.co", "/x")),
            Err(DownloadError::NotHttps("http".to_string()))
        );
        assert!(matches!(
            ok(&address("ftp", "huggingface.co", "/x")),
            Err(DownloadError::NotHttps(_))
        ));
        assert_eq!(
            ok(&secure("evil.example", "/x")),
            Err(DownloadError::ForeignHost("evil.example".to_string()))
        );
        for bad in [
            secure("user:pass@huggingface.co", "/x"),
            secure("user@huggingface.co", "/x"),
            secure("huggingface.co:8443", "/x"),
        ] {
            assert!(
                matches!(ok(&bad), Err(DownloadError::BadLocation(_))),
                "{bad}"
            );
        }
    }

    // ---- 取る: 正常 ----

    #[test]
    fn it_downloads_follows_an_allowed_redirect_and_places_the_file_only_after_the_sha256_matches()
    {
        let content = b"the pinned model bytes".to_vec();
        let spec = spec_for(&content);
        let cdn = secure(
            "us.aws.cdn.hf.co",
            "/repos/ab/cd/tenpai.onnx?X-Amz-Signature=abc",
        );
        let transport = Script::new(vec![
            redirect(&cdn),
            body_of(&content, Some(content.len() as u64)),
        ]);
        let fx = Fixture::new();
        let (result, events) = fx.run(&spec, &transport, &small_limits(), &AtomicBool::new(false));
        assert_eq!(result, Ok(()));
        // 最初は配布元の決まった版の URL、次は移し先（署名つきの問い合わせも、そのまま）
        assert_eq!(
            transport.seen(),
            vec![model_url(&spec).unwrap().as_str().to_string(), cdn]
        );
        assert_eq!(fs::read(spec.target_in(&fx.models())).unwrap(), content);
        // 途中のファイルは残らない
        assert_eq!(fx.names(), vec!["tenpai.onnx".to_string()]);
        // 進み具合: 最初に 0、最後に全部
        let total = Some(content.len() as u64);
        assert_eq!(events.first(), Some(&ModelProgress { done: 0, total }));
        assert_eq!(
            events.last(),
            Some(&ModelProgress {
                done: content.len() as u64,
                total
            })
        );
        assert!(events.windows(2).all(|w| w[0].done < w[1].done));
    }

    #[test]
    fn it_follows_a_relative_redirect_on_the_same_host_and_up_to_three_redirects() {
        let content = b"abc".to_vec();
        let spec = spec_for(&content);
        let transport = Script::new(vec![
            redirect("/api/resolve-cache/models/x"),
            redirect(&secure("cdn-lfs.hf.co", "/a")),
            redirect(&secure("us.aws.cdn.hf.co", "/b")),
            body_of(&content, None),
        ]);
        let fx = Fixture::new();
        let (result, events) = fx.run(&spec, &transport, &small_limits(), &AtomicBool::new(false));
        assert_eq!(result, Ok(()));
        let seen = transport.seen();
        assert_eq!(seen.len(), 4);
        assert_eq!(
            seen[1],
            secure("huggingface.co", "/api/resolve-cache/models/x")
        );
        assert_eq!(seen[2], secure("cdn-lfs.hf.co", "/a"));
        assert_eq!(seen[3], secure("us.aws.cdn.hf.co", "/b"));
        // 配布元が大きさを告げないときは、全体は null
        assert!(events.iter().all(|p| p.total.is_none()));
    }

    #[test]
    fn it_replaces_an_existing_file_of_the_same_name() {
        let content = b"new bytes".to_vec();
        let spec = spec_for(&content);
        let fx = Fixture::new();
        fs::create_dir_all(fx.models()).unwrap();
        fs::write(spec.target_in(&fx.models()), b"old").unwrap();
        let transport = Script::new(vec![body_of(&content, None)]);
        let (result, _) = fx.run(&spec, &transport, &small_limits(), &AtomicBool::new(false));
        assert_eq!(result, Ok(()));
        assert_eq!(fs::read(spec.target_in(&fx.models())).unwrap(), content);
    }

    #[test]
    fn progress_is_reported_at_most_once_per_step_and_once_more_at_the_end() {
        // 100 バイトの塊が 10 個。250 バイトごと（小さくした間隔）に知らせる
        let pieces: Vec<Vec<u8>> = (0..10u8).map(|i| vec![i; 100]).collect();
        let content = pieces.concat();
        let spec = spec_for(&content);
        let transport = Script::new(vec![chunked_body(pieces, Some(1000), |_| {})]);
        let fx = Fixture::new();
        let limits = DownloadLimits {
            progress_step: 250,
            ..small_limits()
        };
        let (result, events) = fx.run(&spec, &transport, &limits, &AtomicBool::new(false));
        assert_eq!(result, Ok(()));
        let done: Vec<u64> = events.iter().map(|p| p.done).collect();
        assert_eq!(done, vec![0, 300, 600, 900, 1000]);
        assert!(events.iter().all(|p| p.total == Some(1000)));
        // 最後の 1 回を除いて、知らせの間は、間隔より小さくならない
        let body = &done[..done.len() - 1];
        assert!(body.windows(2).all(|w| w[1] - w[0] >= 250), "{done:?}");
    }

    // ---- 取る: 決まりに合わない ----

    #[test]
    fn a_redirect_to_a_host_that_is_not_the_distribution_is_refused_before_any_request_to_it() {
        let spec = spec_for(b"x");
        let transport = Script::new(vec![redirect(&secure("evil.example", "/tenpai.onnx"))]);
        let fx = Fixture::new();
        let (result, events) = fx.run(&spec, &transport, &small_limits(), &AtomicBool::new(false));
        let error = result.unwrap_err();
        assert_eq!(
            error,
            DownloadError::ForeignHost("evil.example".to_string())
        );
        assert_eq!(
            error.to_string(),
            "決まった配布先ではない所（evil.example）へ移されました"
        );
        // 移し先には、要求を出していない。ファイルも作っていない
        assert_eq!(transport.seen().len(), 1);
        assert!(events.is_empty());
        assert!(fx.names().is_empty());
    }

    #[test]
    fn a_redirect_that_is_not_https_or_hides_a_foreign_host_is_refused() {
        let spec = spec_for(b"x");
        for (location, expected) in [
            (
                address("http", "huggingface.co", "/x"),
                DownloadError::NotHttps("http".to_string()),
            ),
            (
                address("http", "us.aws.cdn.hf.co", "/x"),
                DownloadError::NotHttps("http".to_string()),
            ),
            // スキームの無い書き方（//ホスト/パス）でも、移し先のホストを見る
            (
                "//evil.example/x".to_string(),
                DownloadError::ForeignHost("evil.example".to_string()),
            ),
            // 配布元の名前を頭に付けただけのホスト
            (
                secure("huggingface.co.evil.example", "/x"),
                DownloadError::ForeignHost("huggingface.co.evil.example".to_string()),
            ),
            (
                secure("user:pw@huggingface.co", "/x"),
                DownloadError::BadLocation(secure("user:pw@huggingface.co", "/x")),
            ),
        ] {
            let transport = Script::new(vec![redirect(&location)]);
            let fx = Fixture::new();
            let (result, _) = fx.run(&spec, &transport, &small_limits(), &AtomicBool::new(false));
            assert_eq!(result.unwrap_err(), expected, "{location}");
            assert_eq!(transport.seen().len(), 1, "{location}");
            assert!(fx.names().is_empty(), "{location}");
        }
    }

    #[test]
    fn more_than_three_redirects_are_refused() {
        let spec = spec_for(b"x");
        let hop = |n: u32| redirect(&secure("cdn-lfs.hf.co", &format!("/{n}")));
        let transport = Script::new(vec![hop(1), hop(2), hop(3), hop(4), body_of(b"x", None)]);
        let fx = Fixture::new();
        let (result, _) = fx.run(&spec, &transport, &small_limits(), &AtomicBool::new(false));
        assert_eq!(result, Err(DownloadError::TooManyRedirects));
        // 3 回までは従い、4 つ目の指示で断る（5 つ目の答えは使わない）
        assert_eq!(transport.seen().len(), 4);
        assert!(fx.names().is_empty());
    }

    #[test]
    fn a_status_other_than_200_and_a_failing_transport_are_reported_with_a_reason() {
        let spec = spec_for(b"x");
        for (reply, text) in [
            (Ok(Reply::Status(404)), "HTTP 404"),
            (Ok(Reply::Status(429)), "HTTP 429"),
            (Ok(Reply::Status(503)), "HTTP 503"),
            (Ok(Reply::Status(418)), "HTTP 418"),
            (
                Err(DownloadError::Network("dns error".to_string())),
                "dns error",
            ),
        ] {
            let transport = Script::new(vec![reply]);
            let fx = Fixture::new();
            let (result, _) = fx.run(&spec, &transport, &small_limits(), &AtomicBool::new(false));
            let message = result.unwrap_err().to_string();
            assert!(message.contains(text), "{message}");
            assert!(fx.names().is_empty());
        }
        // 移動の指示の状態なのに、移し先が無い
        let transport = Script::new(vec![Ok(Reply::Status(302))]);
        let (result, _) =
            Fixture::new().run(&spec, &transport, &small_limits(), &AtomicBool::new(false));
        assert_eq!(result, Err(DownloadError::NoLocation));
    }

    // ---- 取る: 中身 ----

    #[test]
    fn a_wrong_sha256_discards_the_part_file_and_leaves_an_existing_model_alone() {
        let spec = spec_for(b"the right bytes");
        let fx = Fixture::new();
        fs::create_dir_all(fx.models()).unwrap();
        fs::write(spec.target_in(&fx.models()), b"existing").unwrap();
        // 同じ大きさで中身が違う
        let transport = Script::new(vec![body_of(b"the wrong bytes", None)]);
        let (result, _) = fx.run(&spec, &transport, &small_limits(), &AtomicBool::new(false));
        let error = result.unwrap_err();
        assert_eq!(error, DownloadError::ShaMismatch);
        assert_eq!(
            error.to_string(),
            "取ったファイルが、決まった版と違います（sha256）。もう一度試してください"
        );
        assert_eq!(
            fx.names(),
            vec!["tenpai.onnx".to_string()],
            "途中のファイルを消す"
        );
        assert_eq!(fs::read(spec.target_in(&fx.models())).unwrap(), b"existing");
    }

    #[test]
    fn a_body_larger_than_the_limit_is_refused_by_its_announced_size_or_while_streaming() {
        let content = vec![7u8; 100];
        let spec = spec_for(&content);
        let limits = DownloadLimits {
            max_bytes: 64,
            ..small_limits()
        };
        // 大きさを告げられたとき: 1 バイトも書かずに断る
        let fx = Fixture::new();
        let transport = Script::new(vec![body_of(&content, Some(100))]);
        let (result, events) = fx.run(&spec, &transport, &limits, &AtomicBool::new(false));
        assert_eq!(result, Err(DownloadError::TooLarge(64)));
        assert!(events.is_empty());
        assert!(fx.names().is_empty());
        // 大きさを告げられず、流れてきたとき: 上限を超えたところで断って、途中のファイルを消す
        let fx = Fixture::new();
        let transport = Script::new(vec![chunked_body(
            vec![vec![7u8; 40], vec![7u8; 40], vec![7u8; 20]],
            None,
            |_| {},
        )]);
        let (result, _) = fx.run(&spec, &transport, &limits, &AtomicBool::new(false));
        assert_eq!(result, Err(DownloadError::TooLarge(64)));
        assert!(fx.names().is_empty());
        // 上限ちょうどは受け取る
        let exact = DownloadLimits {
            max_bytes: 100,
            ..limits
        };
        let fx = Fixture::new();
        let transport = Script::new(vec![body_of(&content, Some(100))]);
        let (result, _) = fx.run(&spec, &transport, &exact, &AtomicBool::new(false));
        assert_eq!(result, Ok(()));
    }

    #[test]
    fn the_default_limit_is_64_mib_and_the_message_says_so() {
        let limits = DownloadLimits::default();
        assert_eq!(limits.max_bytes, 64 * 1024 * 1024);
        assert_eq!(limits.max_redirects, 3);
        assert_eq!(limits.progress_step, 256 * 1024);
        assert!(DownloadError::TooLarge(limits.max_bytes)
            .to_string()
            .contains("64 MB"));
        assert!(DownloadError::TooLarge(10)
            .to_string()
            .contains("10 バイト"));
    }

    // ---- 取る: 取り消し・失敗 ----

    #[test]
    fn cancelling_while_streaming_stops_and_removes_the_part_file() {
        let pieces: Vec<Vec<u8>> = (0..6u8).map(|i| vec![i; 10]).collect();
        let content = pieces.concat();
        let spec = spec_for(&content);
        let cancel = Arc::new(AtomicBool::new(false));
        let flag = Arc::clone(&cancel);
        // 3 つ目の塊を読んだところで、取り消す
        let transport = Script::new(vec![chunked_body(pieces, Some(60), move |n| {
            if n == 3 {
                flag.store(true, Ordering::SeqCst);
            }
        })]);
        let fx = Fixture::new();
        let (result, events) = fx.run(&spec, &transport, &small_limits(), &cancel);
        assert_eq!(result, Err(DownloadError::Cancelled));
        assert!(events.last().is_some_and(|p| p.done < 60), "{events:?}");
        assert!(
            fx.names().is_empty(),
            "途中のファイルを消す: {:?}",
            fx.names()
        );
    }

    #[test]
    fn cancelling_before_the_request_does_not_touch_the_network() {
        let spec = spec_for(b"x");
        let transport = Script::new(vec![]);
        let fx = Fixture::new();
        let (result, _) = fx.run(&spec, &transport, &small_limits(), &AtomicBool::new(true));
        assert_eq!(result, Err(DownloadError::Cancelled));
        assert!(transport.seen().is_empty());
        assert!(fx.names().is_empty());
    }

    /// 開けてもらうまで、読み取りが戻らない（通信が止まった）読み取り。
    struct Stalled {
        gate: Arc<(Mutex<bool>, Condvar)>,
    }

    impl Read for Stalled {
        fn read(&mut self, _buffer: &mut [u8]) -> io::Result<usize> {
            let (open, signal) = &*self.gate;
            let mut open = open.lock().unwrap();
            while !*open {
                open = signal.wait(open).unwrap();
            }
            Ok(0)
        }
    }

    fn stalled_body(gate: &Arc<(Mutex<bool>, Condvar)>) -> Result<Reply, DownloadError> {
        Ok(Reply::Body(Body {
            length: None,
            reader: Box::new(Stalled {
                gate: Arc::clone(gate),
            }),
        }))
    }

    fn open_gate(gate: &Arc<(Mutex<bool>, Condvar)>) {
        let (open, signal) = &**gate;
        *open.lock().unwrap() = true;
        signal.notify_all();
    }

    #[test]
    fn cancelling_stops_at_once_even_when_the_connection_is_stalled() {
        let spec = spec_for(b"x");
        let gate = Arc::new((Mutex::new(false), Condvar::new()));
        let transport = Script::new(vec![stalled_body(&gate)]);
        let cancel = Arc::new(AtomicBool::new(false));
        let flag = Arc::clone(&cancel);
        let canceller = thread::spawn(move || {
            thread::sleep(Duration::from_millis(150));
            flag.store(true, Ordering::SeqCst);
        });
        let fx = Fixture::new();
        let started = Instant::now();
        let (result, _) = fx.run(&spec, &transport, &small_limits(), &cancel);
        canceller.join().unwrap();
        assert_eq!(result, Err(DownloadError::Cancelled));
        assert!(
            started.elapsed() < Duration::from_secs(3),
            "{:?}",
            started.elapsed()
        );
        assert!(fx.names().is_empty());
        open_gate(&gate);
    }

    #[test]
    fn a_connection_that_sends_nothing_for_the_stall_time_is_given_up() {
        let spec = spec_for(b"x");
        let gate = Arc::new((Mutex::new(false), Condvar::new()));
        let transport = Script::new(vec![stalled_body(&gate)]);
        let limits = DownloadLimits {
            stall_timeout: Duration::from_millis(200),
            ..small_limits()
        };
        let fx = Fixture::new();
        let started = Instant::now();
        let (result, _) = fx.run(&spec, &transport, &limits, &AtomicBool::new(false));
        assert_eq!(result, Err(DownloadError::Timeout));
        assert!(started.elapsed() < Duration::from_secs(3));
        assert!(fx.names().is_empty());
        open_gate(&gate);
    }

    /// 少し読めてから、失敗する読み取り。
    struct FailsAfterOneChunk {
        done: bool,
    }

    impl Read for FailsAfterOneChunk {
        fn read(&mut self, buffer: &mut [u8]) -> io::Result<usize> {
            if self.done {
                return Err(io::Error::new(ErrorKind::ConnectionReset, "切れました"));
            }
            self.done = true;
            buffer[..3].copy_from_slice(b"abc");
            Ok(3)
        }
    }

    #[test]
    fn a_connection_that_drops_midway_is_reported_and_leaves_no_part_file() {
        let spec = spec_for(b"abcdef");
        let transport = Script::new(vec![Ok(Reply::Body(Body {
            length: Some(6),
            reader: Box::new(FailsAfterOneChunk { done: false }),
        }))]);
        let fx = Fixture::new();
        let (result, _) = fx.run(&spec, &transport, &small_limits(), &AtomicBool::new(false));
        match result {
            Err(DownloadError::Network(reason)) => {
                assert!(reason.contains("切れました"), "{reason}")
            }
            other => panic!("{other:?}"),
        }
        assert!(fx.names().is_empty());
    }

    #[test]
    fn an_unwritable_models_folder_is_reported() {
        let spec = spec_for(b"x");
        let fx = Fixture::new();
        // models が、フォルダではなくファイル
        fs::write(fx.models(), b"not a folder").unwrap();
        let transport = Script::new(vec![body_of(b"x", None)]);
        let (result, _) = fx.run(&spec, &transport, &small_limits(), &AtomicBool::new(false));
        assert!(matches!(result, Err(DownloadError::Write(_))), "{result:?}");
        assert!(transport.seen().is_empty());
    }

    #[test]
    fn every_error_has_a_japanese_message() {
        let errors = [
            DownloadError::BadUrl("x".into()),
            DownloadError::NotHttps("http".into()),
            DownloadError::ForeignHost("evil.example".into()),
            DownloadError::BadLocation("x".into()),
            DownloadError::TooManyRedirects,
            DownloadError::NoLocation,
            DownloadError::Status(404),
            DownloadError::Status(429),
            DownloadError::Status(500),
            DownloadError::Status(418),
            DownloadError::TooLarge(MAX_MODEL_BYTES),
            DownloadError::Timeout,
            DownloadError::Network("x".into()),
            DownloadError::Write("x".into()),
            DownloadError::ShaMismatch,
            DownloadError::Cancelled,
        ];
        for error in errors {
            let text = error.to_string();
            assert!(
                text.chars().any(|c| ('\u{3040}'..='\u{30FF}').contains(&c)
                    || ('\u{4E00}'..='\u{9FFF}').contains(&c)),
                "{text}"
            );
        }
    }

    // ---- 製品の通信の層の、返事の読み替え（通信はしない） ----

    fn response(
        status: u16,
        headers: &[(&str, &str)],
        body: &[u8],
    ) -> ureq::http::Response<ureq::Body> {
        let mut builder = ureq::http::Response::builder().status(status);
        for (name, value) in headers {
            builder = builder.header(*name, *value);
        }
        builder
            .body(ureq::Body::builder().data(body.to_vec()))
            .unwrap()
    }

    #[test]
    fn the_real_transport_turns_a_200_into_a_body_that_stops_after_the_size_limit() {
        match reply_of(response(200, &[], b"hello"), 100) {
            Reply::Body(mut body) => {
                assert_eq!(body.length, Some(5));
                let mut text = String::new();
                body.reader.read_to_string(&mut text).unwrap();
                assert_eq!(text, "hello");
            }
            _ => panic!("本文のはず"),
        }
        // 上限より 1 バイト多く読ませる（呼ぶ側が、上限を超えたことを数えるため）。それを超えると、読み取りが失敗する
        match reply_of(response(200, &[], b"0123456789"), 4) {
            Reply::Body(mut body) => {
                let mut bytes = Vec::new();
                assert!(body.reader.read_to_end(&mut bytes).is_err());
                assert!(bytes.len() <= 5, "{}", bytes.len());
            }
            _ => panic!("本文のはず"),
        }
    }

    #[test]
    fn the_real_transport_turns_redirects_and_other_statuses_into_replies_without_reading_the_body()
    {
        for status in [301u16, 302, 303, 307, 308] {
            let reply = reply_of(
                response(status, &[("location", "/somewhere?x=1")], b""),
                100,
            );
            assert!(
                matches!(&reply, Reply::Redirect(location) if location == "/somewhere?x=1"),
                "{status}"
            );
        }
        // 移し先の見出しが無い移動の指示は、状態として返す（呼ぶ側が、移し先が無いと断る）
        assert!(matches!(
            reply_of(response(302, &[], b""), 100),
            Reply::Status(302)
        ));
        assert!(matches!(
            reply_of(response(304, &[], b""), 100),
            Reply::Status(304)
        ));
        assert!(matches!(
            reply_of(response(206, &[], b"x"), 100),
            Reply::Status(206)
        ));
    }

    #[test]
    fn the_real_transport_maps_errors_to_the_reasons_the_screen_shows() {
        assert_eq!(
            map_transport_error(ureq::Error::StatusCode(404)),
            DownloadError::Status(404)
        );
        assert_eq!(
            map_transport_error(ureq::Error::Timeout(ureq::Timeout::Global)),
            DownloadError::Timeout
        );
        assert!(matches!(
            map_transport_error(ureq::Error::HostNotFound),
            DownloadError::Network(_)
        ));
        // 作るだけでは、通信しない
        let _ = UreqTransport::new();
    }
}
