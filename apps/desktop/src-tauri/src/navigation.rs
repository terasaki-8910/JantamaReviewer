//! 画面の遷移の決まり（N-5、N-6）。
//!
//! 窓が読み込んでよいのは、アプリ自身の画面だけ（製品では Tauri が配るオリジン、`tauri dev` ではそれに加えて
//! Vite の開発サーバー）。それ以外への遷移は取り消す。ふつうの Web ページ（http / https）へのリンクをクリックしたときだけ、
//! 取り消したうえで既定のブラウザで開く（`external.rs`）。新しい窓の要求（target=_blank・window.open）は必ず拒み、
//! 外部の Web ページなら同じく既定のブラウザに回す。ダウンロードは受け付けない。
//!
//! ここは URL の文字列を判定するだけの純粋な部品で、通信はしない。
//! URL の文字列をソースに書かないのは、`tests/safety.rs` がソース中の URL を通信の疑いとして拒むため
//! （スキーム・ホスト・ポートの部品で持つ）。テストは `tests/navigation_policy.rs`。

use url::{Host, Url};

/// 画面を読み込んでよいオリジン（スキーム・ホスト・ポート）。
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct Origin {
    scheme: String,
    host: String,
    /// 実際に使うポート。省略されたときは、スキームの既定のポート。
    port: Option<u16>,
}

fn default_port(scheme: &str) -> Option<u16> {
    match scheme {
        "http" | "ws" => Some(80),
        "https" | "wss" => Some(443),
        "ftp" => Some(21),
        _ => None,
    }
}

impl Origin {
    pub fn new(scheme: &str, host: &str, port: Option<u16>) -> Origin {
        let scheme = scheme.to_ascii_lowercase();
        let port = port.or_else(|| default_port(&scheme));
        Origin {
            scheme,
            host: host.to_ascii_lowercase(),
            port,
        }
    }

    /// URL のオリジン。ホストの無い URL（data: や about: など）は `None`。
    pub fn of(url: &Url) -> Option<Origin> {
        Some(Origin::new(
            url.scheme(),
            url.host_str()?,
            url.port_or_known_default(),
        ))
    }
}

/// Tauri が Windows で製品の画面を配るオリジンのホスト名。
pub const PRODUCTION_HOST: &str = "tauri.localhost";

/// 窓が読み込んでよいオリジンの一覧。
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct AppOrigins {
    allowed: Vec<Origin>,
}

impl AppOrigins {
    /// 製品: Tauri が配る画面のオリジンだけ（`use_https_scheme` は使わないので http）。
    pub fn production() -> AppOrigins {
        AppOrigins {
            allowed: vec![Origin::new("http", PRODUCTION_HOST, None)],
        }
    }

    /// 開発（`tauri dev`）: Vite の開発サーバーのオリジンも許す。
    pub fn with_dev_server(mut self, dev_url: &Url) -> AppOrigins {
        if let Some(origin) = Origin::of(dev_url) {
            if !self.allowed.contains(&origin) {
                self.allowed.push(origin);
            }
        }
        self
    }

    /// 動かし方に応じた一覧。開発サーバーを許すのは `dev`（`tauri dev`）のときだけ。
    pub fn for_run(dev: bool, dev_url: Option<&Url>) -> AppOrigins {
        let origins = AppOrigins::production();
        match (dev, dev_url) {
            (true, Some(url)) => origins.with_dev_server(url),
            _ => origins,
        }
    }

    /// この URL は、アプリ自身の画面か。
    pub fn allows(&self, url: &Url) -> bool {
        Origin::of(url).is_some_and(|origin| self.allowed.contains(&origin))
    }
}

/// 窓が移ろうとしたときの扱い。
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum NavigationDecision {
    /// そのまま読み込む（アプリ自身の画面）。
    Allow,
    /// 取り消して、既定のブラウザで開く（外部の Web ページへのリンク）。
    OpenExternal,
    /// 取り消すだけ（file:・data:・javascript:・アプリ内部のアドレスなど）。
    Cancel,
}

/// 外部の Web ページか。http / https で、ホストがこの PC やローカルのネットワークの中
/// （localhost・ドットの無い名前・ループバック・私設アドレス）ではないもの。
/// `asset.localhost` のようなアプリ内部のアドレスをブラウザに渡さないために、これらは含めない。
pub fn is_external_web_page(url: &Url) -> bool {
    if !matches!(url.scheme(), "http" | "https") {
        return false;
    }
    match url.host() {
        Some(Host::Domain(domain)) => !is_local_domain(domain),
        Some(Host::Ipv4(ip)) => {
            !(ip.is_loopback()
                || ip.is_private()
                || ip.is_link_local()
                || ip.is_unspecified()
                || ip.is_broadcast())
        }
        Some(Host::Ipv6(ip)) => {
            !(ip.is_loopback()
                || ip.is_unspecified()
                || ip.is_unique_local()
                || ip.is_unicast_link_local())
        }
        None => false,
    }
}

fn is_local_domain(domain: &str) -> bool {
    let domain = domain.trim_end_matches('.').to_ascii_lowercase();
    domain == "localhost" || domain.ends_with(".localhost") || !domain.contains('.')
}

/// 窓の遷移をどうするか（N-5）。
pub fn decide_navigation(url: &Url, origins: &AppOrigins) -> NavigationDecision {
    if origins.allows(url) {
        NavigationDecision::Allow
    } else if is_external_web_page(url) {
        NavigationDecision::OpenExternal
    } else {
        NavigationDecision::Cancel
    }
}

/// 新しい窓の要求の扱い。窓はどちらも作らない。
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum NewWindowDecision {
    /// 拒むだけ。
    Deny,
    /// 拒んで、既定のブラウザで開く。
    DenyAndOpenExternal,
}

/// 新しい窓の要求（target=_blank・window.open）をどうするか（N-5）。
/// アプリ自身の画面の新しい窓も作らない。
pub fn decide_new_window(url: &Url, origins: &AppOrigins) -> NewWindowDecision {
    if !origins.allows(url) && is_external_web_page(url) {
        NewWindowDecision::DenyAndOpenExternal
    } else {
        NewWindowDecision::Deny
    }
}

/// ダウンロードの要求を受け付けるか（N-6）。どの URL でも受け付けない。
/// 受け付けると、ダウンロードの吹き出しや保存の窓など、ブラウザの名残が出る。
pub fn allow_download(_url: &Url) -> bool {
    false
}
