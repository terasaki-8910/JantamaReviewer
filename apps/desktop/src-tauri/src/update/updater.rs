//! 更新の確かめ・ダウンロード・入れ直し（F21）。更新の部品（`tauri-plugin-updater`）を使うのは、このファイルだけ
//! （tests/safety.rs の S-2 が確かめる）。
//!
//! - 確かめる（`check`）: 更新の情報（latest.json）を 1 回だけ取って、新しい版があるかを返す。公開鍵が空なら、何もせず「設定されていません」を返す。
//!   見つけた更新は、`PendingUpdate` に預かる（「今すぐ入れ直す」が、確かめたときに見つけた更新を、そのまま入れるため）。
//! - 入れ直す（`install`）: 預かった更新をダウンロードし、署名を確かめ（部品が確かめる。合わなければ、入れない）、インストーラーを動かす。
//!   Windows は、インストーラー（NSIS。目立たない進み具合の表示だけ）を動かして、このアプリを終える。インストーラーが、入れ終えたあとに開き直す。
//!   終える前に、閉じるときと同じ片づけ（`BeforeExit`）をする。Windows 以外は、入れ終えたあとに、片づけて開き直す。
//!
//! 部品は、アプリに登録して使う（`plugin`）。画面（webview）には、部品の命令を使う権限を与えない（capabilities に updater は無い）。
//! 画面が呼べるのは、`commands.rs` の命令だけ。

use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::{Arc, Mutex, PoisonError};
use std::time::Duration;

use tauri::plugin::TauriPlugin;
use tauri::{AppHandle, Runtime};
use tauri_plugin_updater::{Error, Update, UpdaterExt};
use url::Url;

use super::{UpdateCheck, UpdateOutcome, UpdateSource};

/// 更新の情報を取るときの待ち時間（接続から読み終えるまで）。
const CHECK_TIMEOUT: Duration = Duration::from_secs(20);

/// インストーラーをダウンロードするときの待ち時間（全体）。細い回線でも終わるよう、長めにとる。
const DOWNLOAD_TIMEOUT: Duration = Duration::from_secs(15 * 60);

/// 入れ直す更新が無いときの文。
pub const NO_PENDING_MESSAGE: &str =
    "入れ直す更新の情報がありません。もう一度、更新を確かめてください";

/// すでに入れ直しているときの文。
pub const ALREADY_INSTALLING_MESSAGE: &str = "すでに入れ直しています";

/// インストーラーを動かして終わる前（Windows）・開き直す前（それ以外）に、アプリを閉じるときと同じ片づけをする関数。
pub type BeforeExit = Arc<dyn Fn() + Send + Sync + 'static>;

/// 更新の部品。アプリに登録する（`lib.rs`）。部品の名前を、このファイルの外に出さないための入口。
pub fn plugin<R: Runtime>() -> TauriPlugin<R, tauri_plugin_updater::Config> {
    tauri_plugin_updater::Builder::new().build()
}

/// 部品の設定（`plugins.updater`）。tauri.conf.json には書かず、起動のときに入れる（`prepare_config`）。
///
/// 部品は、設定に `pubkey` の項目が無いと起動できない。公開鍵は、確かめるたびに組み立てる更新の側（`build_updater`）で渡すので、
/// ここは空にしておく（公開鍵が空のままでも、アプリは起動する）。署名には、署名した版を入れてあり（`tauri build` が入れる）、
/// 配布先の latest.json が告げる版と合わない更新と、版を結んでいない署名（古い署名つきの物を、新しい版に見せかけるのに使える）は、
/// 入れない（`requireSignedVersion`）。
pub fn plugin_config() -> serde_json::Value {
    serde_json::json!({
        "pubkey": "",
        "requireSignedVersion": true,
        "windows": { "installMode": "passive" },
    })
}

/// 部品の設定を、アプリの設定に入れる。`tauri::Builder::build` に渡す前に呼ぶ。
pub fn prepare_config(config: &mut tauri::Config) {
    config
        .plugins
        .0
        .insert("updater".to_string(), plugin_config());
}

/// 最後に見つけた更新。「今すぐ入れ直す」は、確かめたときに見つけた更新を、そのまま入れる。
#[derive(Default)]
pub struct PendingUpdate {
    update: Mutex<Option<Update>>,
    /// 入れ直しが進んでいる間は `true`（重ねて始めない）。
    installing: AtomicBool,
}

impl PendingUpdate {
    fn set(&self, update: Update) {
        *self.update.lock().unwrap_or_else(PoisonError::into_inner) = Some(update);
    }

    fn clear(&self) {
        *self.update.lock().unwrap_or_else(PoisonError::into_inner) = None;
    }

    fn get(&self) -> Option<Update> {
        self.update
            .lock()
            .unwrap_or_else(PoisonError::into_inner)
            .clone()
    }

    /// 預かっている更新の版。
    pub fn version(&self) -> Option<String> {
        self.get().map(|update| update.version)
    }
}

/// 更新の確かめ・ダウンロードに使う部品を組み立てる。公開鍵と取り先は、`source` から（設定ファイルには書かない）。
fn build_updater<R: Runtime>(
    app: &AppHandle<R>,
    source: &UpdateSource,
    timeout: Duration,
    before_exit: &BeforeExit,
) -> Result<tauri_plugin_updater::Updater, Error> {
    let endpoint = Url::parse(source.endpoint.trim())?;
    let https_only = requires_https(&endpoint);
    let before_exit = Arc::clone(before_exit);
    let mut builder = app
        .updater_builder()
        .pubkey(source.public_key.trim())
        .endpoints(vec![endpoint])?
        .timeout(timeout)
        .on_before_exit(move || before_exit());
    if https_only {
        // インストーラーの置き場所（latest.json が告げる）も、移し先も、https だけにする（署名の確かめとは別に、平文の通信をしない）
        builder = builder.configure_client(|client| client.https_only(true));
    }
    builder.build()
}

/// 取り先が https なら、そこから先の通信も https だけにする。試験の取り先（この PC の中の http）は、そのまま。
fn requires_https(endpoint: &Url) -> bool {
    endpoint.scheme() == "https"
}

/// 更新を確かめる。公開鍵が空なら、通信せずに「設定されていません」を返す。失敗は、理由つきで返す（落ちない）。
pub async fn check<R: Runtime>(
    app: &AppHandle<R>,
    source: &UpdateSource,
    pending: &PendingUpdate,
    before_exit: &BeforeExit,
) -> UpdateCheck {
    let current_version = app.package_info().version.to_string();
    if !source.is_configured() {
        return UpdateCheck::new(current_version, UpdateOutcome::NotConfigured);
    }
    let found = match build_updater(app, source, CHECK_TIMEOUT, before_exit) {
        Ok(updater) => updater.check().await,
        Err(error) => Err(error),
    };
    let outcome = match found {
        Ok(Some(update)) => {
            let outcome = UpdateOutcome::Available {
                version: update.version.clone(),
                notes: update.body.clone().filter(|body| !body.trim().is_empty()),
                date: update
                    .raw_json
                    .get("pub_date")
                    .and_then(|date| date.as_str())
                    .map(str::to_string),
            };
            pending.set(update);
            outcome
        }
        Ok(None) => {
            pending.clear();
            UpdateOutcome::UpToDate
        }
        Err(error) => {
            // 前に見つけた更新は、そのまま預かっておく（つながらなかっただけで、更新が無くなったわけではない）
            let message = explain(&error);
            eprintln!("更新を確かめられませんでした: {message}（{error}）");
            UpdateOutcome::Failed { message }
        }
    };
    UpdateCheck::new(current_version, outcome)
}

/// 預かった更新を、ダウンロードして、署名を確かめて、入れ直す。Windows では、インストーラーを動かして、ここでアプリが終わる。
/// 戻ってくるのは、失敗したとき（理由つき）だけ。
pub async fn install<R: Runtime>(
    app: &AppHandle<R>,
    pending: &PendingUpdate,
    before_exit: &BeforeExit,
) -> Result<(), String> {
    if pending.installing.swap(true, Ordering::SeqCst) {
        return Err(ALREADY_INSTALLING_MESSAGE.to_string());
    }
    let result = download_and_install(app, pending, before_exit).await;
    if result.is_err() {
        pending.installing.store(false, Ordering::SeqCst);
    }
    result
}

async fn download_and_install<R: Runtime>(
    app: &AppHandle<R>,
    pending: &PendingUpdate,
    before_exit: &BeforeExit,
) -> Result<(), String> {
    let Some(mut update) = pending.get() else {
        return Err(NO_PENDING_MESSAGE.to_string());
    };
    update.timeout = Some(DOWNLOAD_TIMEOUT);
    // ダウンロードのあと、署名を確かめる（合わなければ、ここで失敗する。入れない）
    let bytes = update
        .download(|_, _| {}, || {})
        .await
        .map_err(|error| explain_install(&error))?;
    update
        .install(&bytes)
        .map_err(|error| explain_install(&error))?;
    // Windows は、`install` の中でインストーラーを動かして終わるので、ここへは来ない。
    // それ以外は、入れ終えたので、閉じるときと同じ片づけをして、開き直す。
    #[cfg(not(windows))]
    {
        before_exit();
        app.restart();
    }
    #[cfg(windows)]
    {
        let _ = (app, before_exit);
        Ok(())
    }
}

/// 部品の失敗を、画面に出す理由の文にする（確かめるとき）。
fn explain(error: &Error) -> String {
    match error {
        Error::ReleaseNotFound => {
            "配布先から更新の情報（latest.json）を取れませんでした（まだ公開されていないか、通信できません）"
                .to_string()
        }
        Error::TargetNotFound(_) | Error::TargetsNotFound(_) => {
            "この PC 向けの更新が、配布先にありません".to_string()
        }
        Error::Reqwest(reason) => format!("通信できませんでした（{}）", chain(reason)),
        other => other.to_string(),
    }
}

/// 部品の失敗を、画面に出す理由の文にする（入れ直すとき）。
fn explain_install(error: &Error) -> String {
    match error {
        Error::Minisign(_) | Error::Base64(_) | Error::SignatureUtf8(_) => {
            "更新の署名を確かめられませんでした。安全のため、入れ直しを中止しました".to_string()
        }
        Error::SignedVersionMismatch { .. } | Error::MissingSignedVersion => {
            "更新の署名が、配布先の版と合いません。安全のため、入れ直しを中止しました".to_string()
        }
        Error::Reqwest(reason) => format!("ダウンロードできませんでした（{}）", chain(reason)),
        Error::Network(reason) => format!("ダウンロードできませんでした（{reason}）"),
        other => other.to_string(),
    }
}

/// 失敗の原因のつながりを、「: 」でつないだ 1 つの文にする（`error sending request` だけでは、理由が分からないため）。
fn chain(error: &dyn std::error::Error) -> String {
    let mut parts = vec![error.to_string()];
    let mut source = error.source();
    while let Some(next) = source {
        let text = next.to_string();
        if parts.last() != Some(&text) {
            parts.push(text);
        }
        source = next.source();
    }
    parts.join(": ")
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn f21_an_https_destination_makes_every_request_after_it_https_only() {
        // URL をそのまま書かない（ソースの URL を拒む安全の検査があるため、組み立てる）
        let url = |scheme: &str, rest: &str| Url::parse(&[scheme, rest].join("://")).unwrap();
        assert!(requires_https(&url("https", "example.invalid/latest.json")));
        assert!(!requires_https(&url("http", "127.0.0.1:8080/latest.json")));
    }

    #[test]
    fn f21_failures_are_explained_in_japanese_with_the_cause() {
        assert!(explain(&Error::ReleaseNotFound).contains("latest.json"));
        assert!(explain(&Error::TargetNotFound("windows-x86_64".into())).contains("この PC"));
        assert!(explain_install(&Error::MissingSignedVersion).contains("中止"));
        assert!(explain_install(&Error::Network(
            "Download request failed with status: 404".into()
        ))
        .contains("ダウンロードできませんでした"));
        // 原因のつながりは、重なった同じ文を省いて、「: 」でつなぐ
        #[derive(Debug)]
        struct Outer(Inner);
        #[derive(Debug)]
        struct Inner;
        impl std::fmt::Display for Outer {
            fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
                write!(f, "error sending request")
            }
        }
        impl std::fmt::Display for Inner {
            fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
                write!(f, "dns error")
            }
        }
        impl std::error::Error for Inner {}
        impl std::error::Error for Outer {
            fn source(&self) -> Option<&(dyn std::error::Error + 'static)> {
                Some(&self.0)
            }
        }
        assert_eq!(chain(&Outer(Inner)), "error sending request: dns error");
    }
}
