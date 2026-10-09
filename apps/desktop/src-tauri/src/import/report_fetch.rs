//! 結果 JSON の取得（F1、S-2）。アプリが外へ出す通信は、ここの 1 種類だけ:
//!
//! `GET <mjai のサイト>/report/<16 桁の小文字の 16 進数>.json`
//!
//! HTTP のクライアント（ureq）を使ってよいのは、このファイルだけ（`tests/safety.rs` の S-2 が確かめる）。
//! 雀魂のサーバー・牌譜屋には触れない。結果は、ユーザー自身が mjai のサイトで Submit したものを、1 回だけ取る。
//! 守ること:
//! - ID は 16 桁の小文字の 16 進数だけ（`ReportId`）。通信先は、スキーム・ホスト・ポート・パスを固定して組み立て、
//!   組み立てた URL をもう一度読み直して、固定の形のままか確かめる。
//! - 移動の指示（リダイレクト）には従わない。待ち時間と、受け取る大きさの上限（32 MB）を決める。
//! - 受け取ったものが UTF-8 の JSON でなければ、断る（HTML のエラーページなどを保存しない）。
//!
//! 通信先は差し替えられる（`ReportEndpoint`）。製品のコードは `ReportEndpoint::production()` だけを使い、
//! 試験は、この PC の中の試験用サーバー（`tests/report_fetch.rs`）に向ける。

use std::fmt;
use std::time::Duration;

use serde::de::IgnoredAny;
use url::Url;

use super::report_id::ReportId;

/// 受け取る大きさの上限（バイト）。
pub const MAX_REPORT_BYTES: u64 = 32 * 1024 * 1024;
/// 1 回の取得にかけてよい時間（つなぐところから、受け取り終わるまで）。
pub const FETCH_TIMEOUT: Duration = Duration::from_secs(30);
/// つなぐのにかけてよい時間。
pub const CONNECT_TIMEOUT: Duration = Duration::from_secs(10);

/// 製品の通信先: スキーム、ホスト、パス（URL の文字列は書かず、部品で持つ。`tests/safety.rs` の S-2）。
const PRODUCTION_SCHEME: &str = "https";
pub const REPORT_HOST: &str = "mjai.ekyu.moe";
const REPORT_PATH_PREFIX: &str = "/report/";
const REPORT_PATH_SUFFIX: &str = ".json";

/// アプリが名乗る名前（相手のサイトの運営者が、何の通信か分かるように）。
const USER_AGENT: &str = concat!("JantamaReviewer/", env!("CARGO_PKG_VERSION"));

/// 結果の通信先（スキーム・ホスト・ポート）。パスは、いつも `/report/<ID>.json`。
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct ReportEndpoint {
    scheme: String,
    host: String,
    port: Option<u16>,
}

impl ReportEndpoint {
    /// 製品の通信先（mjai のサイト。https の標準のポート）。
    pub fn production() -> ReportEndpoint {
        ReportEndpoint {
            scheme: PRODUCTION_SCHEME.to_string(),
            host: REPORT_HOST.to_string(),
            port: None,
        }
    }

    /// 試験用: この PC の試験用サーバーなどに、通信先を差し替える。
    /// 製品のコードでは使わない（`tests/safety.rs` が、`src` の中でこの関数を呼ぶ所が無いことを確かめる）。
    pub fn for_test(scheme: &str, host: &str, port: u16) -> ReportEndpoint {
        ReportEndpoint {
            scheme: scheme.to_string(),
            host: host.to_string(),
            port: Some(port),
        }
    }

    /// この通信先で、結果 `id` を取る URL。スキーム・ホスト・ポート・パスが固定の形のままであることを確かめる。
    pub fn report_url(&self, id: &ReportId) -> Result<Url, FetchError> {
        let authority = match self.port {
            Some(port) => format!("{}:{}", self.host, port),
            None => self.host.clone(),
        };
        let path = format!("{REPORT_PATH_PREFIX}{id}{REPORT_PATH_SUFFIX}");
        let text = format!("{}://{}{}", self.scheme, authority, path);
        let url = Url::parse(&text).map_err(|e| FetchError::BadEndpoint(e.to_string()))?;
        let fixed = url.scheme() == self.scheme
            && url.host_str() == Some(self.host.as_str())
            && url.port() == self.port
            && url.path() == path
            && url.query().is_none()
            && url.fragment().is_none()
            && url.username().is_empty()
            && url.password().is_none();
        if fixed {
            Ok(url)
        } else {
            Err(FetchError::BadEndpoint(format!(
                "組み立てた通信先が固定の形ではありません: {url}"
            )))
        }
    }

    fn is_secure(&self) -> bool {
        self.scheme == PRODUCTION_SCHEME
    }
}

/// 取得の待ち時間と大きさの上限。
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub struct FetchLimits {
    pub timeout: Duration,
    pub connect_timeout: Duration,
    pub max_bytes: u64,
}

impl Default for FetchLimits {
    fn default() -> Self {
        FetchLimits {
            timeout: FETCH_TIMEOUT,
            connect_timeout: CONNECT_TIMEOUT,
            max_bytes: MAX_REPORT_BYTES,
        }
    }
}

/// 取得の失敗。画面に出せる日本語の文を持つ。
#[derive(Debug, Clone, PartialEq, Eq)]
pub enum FetchError {
    /// 結果の ID の形が違う（通信はしていない）。
    InvalidId,
    /// 通信先を組み立てられない・固定の形でない（通信はしていない）。
    BadEndpoint(String),
    /// 200 以外の応答。
    Status(u16),
    /// 受け取る大きさの上限を超えた。
    TooLarge(u64),
    /// 待ち時間を超えた。
    Timeout,
    /// つなげない・途中で切れたなど。
    Network(String),
    /// UTF-8 の文字ではなかった。
    NotUtf8,
    /// JSON ではなかった。
    NotJson,
}

impl fmt::Display for FetchError {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        match self {
            FetchError::InvalidId => f.write_str(
                "結果の ID が正しくありません（16 桁の、小文字の英数字（a〜f と 0〜9）のはずです）。",
            ),
            FetchError::BadEndpoint(reason) => {
                write!(f, "結果の取得先を組み立てられません: {reason}")
            }
            FetchError::Status(404) => f.write_str(
                "mjai のサイトに、この結果がありません（期限が切れて消えた可能性があります）。もう一度、mjai で検討してください。",
            ),
            FetchError::Status(429) => f.write_str(
                "mjai のサイトが混み合っています（HTTP 429）。しばらくしてから、もう一度試してください。",
            ),
            FetchError::Status(code) if (300..400).contains(code) => write!(
                f,
                "mjai のサイトが別の場所への移動（HTTP {code}）を求めましたが、受け付けません。"
            ),
            FetchError::Status(code) if *code >= 500 => write!(
                f,
                "mjai のサイトの側のエラーです（HTTP {code}）。しばらくしてから、もう一度試してください。"
            ),
            FetchError::Status(code) => {
                write!(f, "mjai のサイトが結果を返しませんでした（HTTP {code}）。")
            }
            FetchError::TooLarge(limit) => write!(
                f,
                "結果が大きすぎます（上限は {} MB）。",
                limit / (1024 * 1024)
            ),
            FetchError::Timeout => f.write_str(
                "mjai のサイトの応答が遅すぎます。しばらくしてから、もう一度試してください。",
            ),
            FetchError::Network(reason) => write!(f, "mjai のサイトにつながりません: {reason}"),
            FetchError::NotUtf8 => f.write_str("取得した内容を文字として読めませんでした。"),
            FetchError::NotJson => f.write_str(
                "取得した内容が、結果の JSON ではありませんでした。サイトの作りが変わった可能性があります。",
            ),
        }
    }
}

impl std::error::Error for FetchError {}

fn map_transport_error(error: ureq::Error, limits: &FetchLimits) -> FetchError {
    match error {
        ureq::Error::Timeout(_) => FetchError::Timeout,
        ureq::Error::BodyExceedsLimit(_) => FetchError::TooLarge(limits.max_bytes),
        ureq::Error::StatusCode(code) => FetchError::Status(code),
        other => FetchError::Network(other.to_string()),
    }
}

/// 結果 `id` を、既定の待ち時間と上限で取る（製品はこれを使う）。待つので、画面のスレッドからは呼ばない。
pub fn fetch_report(endpoint: &ReportEndpoint, id: &ReportId) -> Result<String, FetchError> {
    fetch_report_with(endpoint, id, &FetchLimits::default())
}

/// 結果の ID の文字列（形を確かめる）から取る。形が違えば、通信せずに断る。
pub fn fetch_report_by_text(endpoint: &ReportEndpoint, id: &str) -> Result<String, FetchError> {
    let id = ReportId::parse(id).ok_or(FetchError::InvalidId)?;
    fetch_report(endpoint, &id)
}

/// 待ち時間と上限を指定して、結果を取る。
pub fn fetch_report_with(
    endpoint: &ReportEndpoint,
    id: &ReportId,
    limits: &FetchLimits,
) -> Result<String, FetchError> {
    let url = endpoint.report_url(id)?;
    let tls = ureq::tls::TlsConfig::builder()
        .provider(ureq::tls::TlsProvider::NativeTls)
        .root_certs(ureq::tls::RootCerts::PlatformVerifier)
        .build();
    let config = ureq::Agent::config_builder()
        .tls_config(tls)
        .https_only(endpoint.is_secure())
        .max_redirects(0)
        .timeout_global(Some(limits.timeout))
        .timeout_connect(Some(limits.connect_timeout))
        .user_agent(USER_AGENT)
        .build();
    let agent: ureq::Agent = config.into();

    let mut response = agent
        .get(url.as_str())
        .header("Accept", "application/json")
        .call()
        .map_err(|e| map_transport_error(e, limits))?;
    let status = response.status().as_u16();
    if status != 200 {
        return Err(FetchError::Status(status));
    }
    // ureq の上限は「ちょうど上限の長さに達した時点で、続きがあるか確かめずに断る」ので、1 バイト多く読ませて、
    // 上限の長さちょうどまでは受け取り、超えたら断る。
    let bytes = response
        .body_mut()
        .with_config()
        .limit(limits.max_bytes.saturating_add(1))
        .read_to_vec()
        .map_err(|e| map_transport_error(e, limits))?;
    if bytes.len() as u64 > limits.max_bytes {
        return Err(FetchError::TooLarge(limits.max_bytes));
    }
    let text = String::from_utf8(bytes).map_err(|_| FetchError::NotUtf8)?;
    let text = text.strip_prefix('\u{feff}').unwrap_or(&text).to_string();
    serde_json::from_str::<IgnoredAny>(&text).map_err(|_| FetchError::NotJson)?;
    Ok(text)
}

#[cfg(test)]
mod tests {
    use super::*;

    fn id(text: &str) -> ReportId {
        ReportId::parse(text).unwrap()
    }

    #[test]
    fn every_error_has_a_japanese_message() {
        let errors = [
            FetchError::InvalidId,
            FetchError::BadEndpoint("x".into()),
            FetchError::Status(404),
            FetchError::Status(429),
            FetchError::Status(302),
            FetchError::Status(503),
            FetchError::Status(418),
            FetchError::TooLarge(MAX_REPORT_BYTES),
            FetchError::Timeout,
            FetchError::Network("x".into()),
            FetchError::NotUtf8,
            FetchError::NotJson,
        ];
        for error in errors {
            let text = error.to_string();
            assert!(
                text.chars().any(|c| ('\u{3040}'..='\u{30FF}').contains(&c)
                    || ('\u{4E00}'..='\u{9FFF}').contains(&c)),
                "{text}"
            );
        }
        assert!(FetchError::TooLarge(MAX_REPORT_BYTES)
            .to_string()
            .contains("32 MB"));
    }

    #[test]
    fn the_limits_are_the_documented_ones() {
        let limits = FetchLimits::default();
        assert_eq!(limits.max_bytes, 32 * 1024 * 1024);
        assert!(
            limits.timeout >= Duration::from_secs(10) && limits.timeout <= Duration::from_secs(60)
        );
        assert!(limits.connect_timeout <= limits.timeout);
    }

    #[test]
    fn the_production_endpoint_builds_the_fixed_report_path() {
        let url = ReportEndpoint::production()
            .report_url(&id("f9da87cbcd7af5e9"))
            .unwrap();
        assert_eq!(url.scheme(), "https");
        assert_eq!(url.host_str(), Some(REPORT_HOST));
        assert_eq!(url.port(), None);
        assert_eq!(url.path(), "/report/f9da87cbcd7af5e9.json");
        assert_eq!(url.query(), None);
    }

    #[test]
    fn an_endpoint_that_does_not_keep_its_fixed_form_is_refused() {
        // ホストに URL の区切りが混ざっていると、組み立てた URL のホストが元と変わるので、断る。
        let endpoint = ReportEndpoint::for_test("http", "127.0.0.1/evil?", 9);
        assert!(matches!(
            endpoint.report_url(&id("f9da87cbcd7af5e9")),
            Err(FetchError::BadEndpoint(_))
        ));
        let endpoint = ReportEndpoint::for_test("http", "user@host", 9);
        assert!(matches!(
            endpoint.report_url(&id("f9da87cbcd7af5e9")),
            Err(FetchError::BadEndpoint(_))
        ));
    }

    #[test]
    fn a_bad_id_text_is_refused_before_any_connection() {
        // 通信先が存在しないポートでも、ID が悪ければ、つなぎに行かずに InvalidId になる。
        let endpoint = ReportEndpoint::for_test("http", "127.0.0.1", 1);
        for bad in [
            "",
            "F9DA87CBCD7AF5E9",
            "short",
            "../../x",
            "f9da87cbcd7af5e9.json",
        ] {
            assert_eq!(
                fetch_report_by_text(&endpoint, bad),
                Err(FetchError::InvalidId),
                "{bad:?}"
            );
        }
    }
}
