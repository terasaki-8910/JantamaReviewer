//! 同期の通信先（F15、S-2）。アプリが同期のために出す通信は、設定に貼った Turso Cloud の DB 1 つだけ。
//!
//! 受け付ける通信先は、次の 2 種類だけ:
//! - Turso Cloud: ホストが `*.turso.io`（DB ごとの名前つき。例: `<DB の名前>-<組織>.aws-ap-northeast-1.turso.io`）。
//!   貼る URL のスキームは `libsql`・`turso`・`https` のどれでもよい。いずれも https の標準のポートに直す。
//! - この PC の中（`localhost`・`127.0.0.1`・`::1`）: 試験用の同期サーバー（`tursodb --sync-server`）に向けるため。
//!   外へは出ない。ポートを指定でき、https でも http でもよい。
//!
//! 通信先の文字列（スキーム・ホスト・ポート）は、部品で持って組み立てる（URL の文字列はソースに書かない。`tests/safety.rs` の S-2）。
//! ユーザー名・パスワード・パス・問い合わせ・断片のある URL は断る。断る理由に、貼った文字列は写さない
//! （トークンを URL に混ぜて貼ってしまっても、画面やログに出ないように）。

use std::fmt;

use url::{Host, Url};

/// Turso Cloud の DB のホストの末尾（ドットつき。小文字で比べる）。
pub const TURSO_HOST_SUFFIX: &str = ".turso.io";

/// 貼ってよいスキーム。`libsql`・`turso` は、Turso の DB の URL の書き方で、通信は https で行う。
const SCHEME_HTTPS: &str = "https";
const SCHEME_HTTP: &str = "http";
const TURSO_SCHEMES: [&str; 2] = ["libsql", "turso"];

/// 通信先を読めなかった理由。画面に出せる日本語の文。
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct EndpointError(pub String);

impl fmt::Display for EndpointError {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        f.write_str(&self.0)
    }
}

impl std::error::Error for EndpointError {}

fn refuse(reason: impl Into<String>) -> EndpointError {
    EndpointError(reason.into())
}

/// 同期の通信先（スキーム・ホスト・ポート）。
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct SyncEndpoint {
    scheme: &'static str,
    host: String,
    port: Option<u16>,
}

impl SyncEndpoint {
    /// 貼った URL を読む。Turso Cloud の DB か、この PC の中の試験用サーバーだけを受け付ける。
    pub fn parse(text: &str) -> Result<SyncEndpoint, EndpointError> {
        let text = text.trim();
        if text.is_empty() {
            return Err(refuse("同期先の DB の URL が空です"));
        }
        if text.chars().any(char::is_whitespace) {
            return Err(refuse("URL に空白が入っています"));
        }
        let url = Url::parse(text).map_err(|_| {
            refuse(
                "URL として読めません。Turso の DB の URL（libsql:// で始まるもの）を貼ってください",
            )
        })?;
        if !url.username().is_empty() || url.password().is_some() {
            return Err(refuse("URL にユーザー名やパスワードは入れません"));
        }
        if url.query().is_some() || url.fragment().is_some() {
            return Err(refuse("URL に問い合わせや断片は入れません"));
        }
        if !matches!(url.path(), "" | "/") {
            return Err(refuse(
                "URL にパスは入れません（DB の名前を含むホスト名だけです）",
            ));
        }
        let scheme = url.scheme();
        let loopback = match url.host() {
            Some(Host::Domain(name)) => name.eq_ignore_ascii_case("localhost"),
            Some(Host::Ipv4(ip)) => ip.is_loopback(),
            Some(Host::Ipv6(ip)) => ip.is_loopback(),
            None => return Err(refuse("URL にホスト名がありません")),
        };
        if loopback {
            let scheme = match scheme {
                s if s == SCHEME_HTTP => SCHEME_HTTP,
                s if s == SCHEME_HTTPS => SCHEME_HTTPS,
                _ => {
                    return Err(refuse(
                        "この PC の中の試験用サーバーは、http か https で指定します",
                    ))
                }
            };
            let host = match url.host() {
                Some(Host::Ipv6(ip)) => format!("[{ip}]"),
                Some(other) => other.to_string().to_ascii_lowercase(),
                None => return Err(refuse("URL にホスト名がありません")),
            };
            return Ok(SyncEndpoint {
                scheme,
                host,
                port: url.port(),
            });
        }
        let scheme_ok = scheme == SCHEME_HTTPS || TURSO_SCHEMES.contains(&scheme);
        let only_turso = "同期先は、Turso Cloud の DB（ホスト名が .turso.io で終わるもの）だけです";
        if !scheme_ok {
            return Err(refuse(
                "URL は libsql:// で始まる Turso の DB の URL にしてください",
            ));
        }
        let Some(Host::Domain(name)) = url.host() else {
            return Err(refuse(only_turso));
        };
        let host = name.to_ascii_lowercase();
        let has_name = host
            .strip_suffix(TURSO_HOST_SUFFIX)
            .is_some_and(|name| !name.is_empty());
        if !has_name {
            return Err(refuse(only_turso));
        }
        if url.port().is_some_and(|p| p != 443) {
            return Err(refuse("Turso Cloud の DB には、ポートを指定しません"));
        }
        Ok(SyncEndpoint {
            scheme: SCHEME_HTTPS,
            host,
            port: None,
        })
    }

    /// 同期の部品に渡す、通信先の URL（パスなし）。スキーム・ホスト・ポートから組み立てる。
    pub fn base_url(&self) -> String {
        match self.port {
            Some(port) => format!("{}://{}:{}", self.scheme, self.host, port),
            None => format!("{}://{}", self.scheme, self.host),
        }
    }

    /// 画面に出す名前（ホストとポート。トークンも URL の細部も含まない）。
    pub fn display(&self) -> String {
        match self.port {
            Some(port) => format!("{}:{}", self.host, port),
            None => self.host.clone(),
        }
    }

    /// この PC の中の通信先か。
    pub fn is_loopback(&self) -> bool {
        !self.host.ends_with(TURSO_HOST_SUFFIX)
    }
}
