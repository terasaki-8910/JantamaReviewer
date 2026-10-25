//! アプリ内の更新（F21、E-50、U-51）の Rust 側。
//!
//! 流れ: 起動のとき（1 回）と、設定の「更新を確かめる」を押したとき、画面が `check_update` を呼ぶ → 新しい版があれば、画面が帯を出す →
//! ユーザーが「今すぐ入れ直す」を押したときだけ、画面が `install_update` を呼ぶ（ダウンロード・署名の確かめ・インストーラーの起動は、
//! この呼び出しのときだけ）。出すか出さないか（飛ばした版・今の版との比べ方）は、画面側が決める（`apps/desktop/src/main/update/`）。
//!
//! - `config`: 取り先（GitHub の Releases の latest.json）と、署名を確かめる公開鍵。公開鍵が空のあいだは、通信も入れ直しもしない。
//! - `updater`: 更新の部品（`tauri-plugin-updater`）の使い方。通信するのは、ここだけ。
//! - `commands`: 画面から呼ぶ命令。呼べるのは検討画面だけ（ウィジェットの窓から呼ばれたら断る）。
//!
//! 作業の途中で勝手に入れ直したり、開き直したりしない: 記録中（ウィジェットが半荘を記録している間）は、入れ直しを断る。

pub mod commands;
mod config;
mod updater;

use serde::Serialize;

pub use config::{UPDATE_ENDPOINT, UPDATE_PUBLIC_KEY};
pub use updater::{
    check, install, plugin, plugin_config, prepare_config, BeforeExit, PendingUpdate,
    ALREADY_INSTALLING_MESSAGE, NO_PENDING_MESSAGE,
};

/// 更新の取り先と、署名を確かめる公開鍵。製品では定数（`production`）。試験では、手元の試験用サーバーと試験用の鍵に替える。
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct UpdateSource {
    /// 署名を確かめる公開鍵。空なら「まだ設定されていません」で、通信しない。
    pub public_key: String,
    /// 更新の情報（latest.json）の置き場所。
    pub endpoint: String,
}

impl UpdateSource {
    /// 製品の取り先と公開鍵（`config.rs` の 2 つの定数）。
    pub fn production() -> UpdateSource {
        UpdateSource {
            public_key: UPDATE_PUBLIC_KEY.to_string(),
            endpoint: UPDATE_ENDPOINT.to_string(),
        }
    }

    /// 更新の仕組みが使える状態か（公開鍵が入っているか）。
    pub fn is_configured(&self) -> bool {
        !self.public_key.trim().is_empty()
    }
}

/// 更新の確かめの結果（画面が読む形。`apps/desktop/src/api/update.ts` の `UpdateCheck` と同じ）。
#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
pub struct UpdateCheck {
    /// このアプリの今の版。
    pub current_version: String,
    #[serde(flatten)]
    pub outcome: UpdateOutcome,
}

impl UpdateCheck {
    pub fn new(current_version: String, outcome: UpdateOutcome) -> UpdateCheck {
        UpdateCheck {
            current_version,
            outcome,
        }
    }
}

/// 確かめた結果。
#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
#[serde(tag = "kind", rename_all = "snake_case")]
pub enum UpdateOutcome {
    /// 更新の仕組みがまだ設定されていない（公開鍵が空）。通信していない。
    NotConfigured,
    /// 新しい版は無い。
    UpToDate,
    /// 新しい版がある（今の版より新しいかの判断と、飛ばした版かの判断は、画面側）。
    Available {
        version: String,
        /// 更新の説明（Releases の本文）。無ければ `None`。
        notes: Option<String>,
        /// 公開した日時（latest.json の `pub_date`）。無ければ `None`。
        date: Option<String>,
    },
    /// 確かめられなかった（通信できない・配布先に情報が無い、など）。理由つき。
    Failed { message: String },
}

/// 今の版と、更新の仕組みが使える状態か（通信しない。設定の「更新」の欄が、最初に読む）。
#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
pub struct UpdateInfo {
    pub current_version: String,
    pub configured: bool,
}

impl UpdateInfo {
    pub fn new(source: &UpdateSource, current_version: String) -> UpdateInfo {
        UpdateInfo {
            current_version,
            configured: source.is_configured(),
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn json(value: &impl Serialize) -> String {
        serde_json::to_string(value).unwrap()
    }

    #[test]
    fn f21_without_a_public_key_the_updater_is_not_configured() {
        let none = UpdateSource {
            public_key: String::new(),
            endpoint: UPDATE_ENDPOINT.to_string(),
        };
        assert!(!none.is_configured());
        let blank = UpdateSource {
            public_key: " \n\t".to_string(),
            endpoint: UPDATE_ENDPOINT.to_string(),
        };
        assert!(!blank.is_configured());
        let keyed = UpdateSource {
            public_key: "dW50cnVzdGVkIGNvbW1lbnQ6".to_string(),
            endpoint: UPDATE_ENDPOINT.to_string(),
        };
        assert!(keyed.is_configured());
        // 製品の取り先は、定数のとおり。鍵が空のあいだは、設定されていない状態で始まる
        let production = UpdateSource::production();
        assert_eq!(production.public_key, UPDATE_PUBLIC_KEY);
        assert_eq!(production.endpoint, UPDATE_ENDPOINT);
        assert_eq!(production.is_configured(), !UPDATE_PUBLIC_KEY.is_empty());
        let info = UpdateInfo::new(&none, "0.2.0".to_string());
        assert_eq!(
            json(&info),
            r#"{"current_version":"0.2.0","configured":false}"#
        );
    }

    #[test]
    fn f21_the_production_endpoint_is_the_releases_manifest_over_https() {
        let url = url::Url::parse(UPDATE_ENDPOINT).expect("取り先は URL");
        assert_eq!(url.scheme(), "https");
        assert!(url.host_str().is_some_and(|host| !host.is_empty()));
        assert_eq!(
            url.path(),
            "/terasaki-8910/JantamaReviewer/releases/latest/download/latest.json"
        );
        assert_eq!(url.query(), None);
        assert_eq!(url.username(), "");
    }

    #[test]
    fn f21_the_check_result_has_the_shape_the_screen_reads() {
        // 画面（`src/api/update.ts` の `UpdateCheck`）が読む形。名前を変えるときは、画面と一緒に変える。
        let check = |outcome| UpdateCheck::new("0.2.0".to_string(), outcome);
        assert_eq!(
            json(&check(UpdateOutcome::NotConfigured)),
            r#"{"current_version":"0.2.0","kind":"not_configured"}"#
        );
        assert_eq!(
            json(&check(UpdateOutcome::UpToDate)),
            r#"{"current_version":"0.2.0","kind":"up_to_date"}"#
        );
        assert_eq!(
            json(&check(UpdateOutcome::Available {
                version: "0.2.1".to_string(),
                notes: Some("直したこと".to_string()),
                date: Some("2026-10-26T09:00:00Z".to_string()),
            })),
            r#"{"current_version":"0.2.0","kind":"available","version":"0.2.1","notes":"直したこと","date":"2026-10-26T09:00:00Z"}"#
        );
        assert_eq!(
            json(&check(UpdateOutcome::Available {
                version: "0.2.1".to_string(),
                notes: None,
                date: None,
            })),
            r#"{"current_version":"0.2.0","kind":"available","version":"0.2.1","notes":null,"date":null}"#
        );
        assert_eq!(
            json(&check(UpdateOutcome::Failed {
                message: "通信できませんでした".to_string()
            })),
            r#"{"current_version":"0.2.0","kind":"failed","message":"通信できませんでした"}"#
        );
    }

    #[test]
    fn f21_the_plugin_config_starts_the_plugin_without_a_public_key() {
        // 部品は、設定に `pubkey` の項目が無いと起動できない。空でよい（鍵は、確かめるたびに渡す）
        let config = plugin_config();
        assert_eq!(config["pubkey"], "");
        // 署名した版と、配布先が告げる版が合わない更新は入れない・Windows は目立たない入れ直し
        assert_eq!(config["requireSignedVersion"], true);
        assert_eq!(config["windows"]["installMode"], "passive");
        // 部品の設定には、取り先も、危ない印（https でない通信・証明書の無視）も入れない
        let object = config.as_object().unwrap();
        for key in object.keys() {
            assert!(
                ["pubkey", "requireSignedVersion", "windows"].contains(&key.as_str()),
                "{key}"
            );
        }
        let mut app_config = tauri::Config::default();
        prepare_config(&mut app_config);
        assert_eq!(app_config.plugins.0["updater"], config);
    }

    #[test]
    fn f21_the_skipped_version_is_not_synced_and_not_exported() {
        use crate::settings::Settings;
        use crate::study::records::PortableSettings;
        use crate::sync::local::SETTING_NAMES;

        // 同期する設定の名前に無い（データの保存先・窓の位置と同じ。この PC だけの値）
        assert!(!SETTING_NAMES.contains(&"skipped_update_version"));
        assert!(!SETTING_NAMES.contains(&"data_dir"));
        // 書き出す設定の形に無い
        let settings = Settings {
            skipped_update_version: Some("0.2.1".to_string()),
            ..Settings::default()
        };
        let exported = serde_json::to_string(&PortableSettings::from_settings(&settings)).unwrap();
        assert!(!exported.contains("skipped_update_version"), "{exported}");
        assert!(!exported.contains("0.2.1"), "{exported}");
        // 読み込むと、いまの飛ばした版のまま（書き出したファイルの値で消えない）
        let applied = PortableSettings::from_settings(&Settings::default()).applied_to(&settings);
        assert_eq!(applied.skipped_update_version.as_deref(), Some("0.2.1"));
    }
}
