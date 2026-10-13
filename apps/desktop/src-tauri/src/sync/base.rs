//! 前回の突き合わせの記録（同期の「ベース」）と、同期の設定のファイル（F15、D-4）。
//!
//! ベースは、行（鍵）ごとに「前回、手元と同期用の DB が合っていた中身の指紋と、そのときの更新時刻・端末」を覚える。
//! これがあるから、手元と同期用の DB が食い違ったとき、どちらが前回から変わったのか（手元で直したのか、ほかの端末が直したのか、
//! 手元で消したのか）を見分けられる。ベースは端末ごとの記録で、同期しない。同期用の DB の作り直し・接続先の変更・保存先の変更のとき、
//! 作り直す（保存先ごとに別のフォルダに置く）。

use std::collections::BTreeMap;
use std::fs;
use std::io;
use std::path::{Path, PathBuf};

use serde::{Deserialize, Serialize};

use crate::ids::{new_device_id, sha256_hex};
use crate::store::write_atomic;

/// 同期の設定のファイルの名前（設定のフォルダの直下）。
pub const CONFIG_FILE: &str = "sync.json";
/// 同期の作業のフォルダの名前（設定のフォルダの下）。
pub const SYNC_DIR: &str = "sync";
/// ベースのファイルの名前（作業のフォルダの中）。
pub const BASE_FILE: &str = "base.json";
/// 同期用の DB の手元のファイルの名前（作業のフォルダの中。同期の部品が、横に補助のファイルを置く）。
pub const SYNC_DB_FILE: &str = "sync.db";

/// ベースの形の版。
pub const BASE_VERSION: u32 = 1;

/// 同期の設定（端末ごと。同期しない）。トークンは入れない（OS の資格情報の保管庫にだけ入れる。`credentials.rs`）。
#[derive(Debug, Clone, Default, PartialEq, Eq, Serialize, Deserialize)]
pub struct SyncConfig {
    /// 同期を使うか。
    #[serde(default)]
    pub enabled: bool,
    /// 同期先の DB の URL（貼ったとおりの文字ではなく、読み直して整えたもの。ホスト名だけで、トークンは含まない）。
    #[serde(default)]
    pub url: String,
    /// この端末の名前（同期の行に「どの端末が直したか」として付く）。
    #[serde(default)]
    pub device_id: String,
}

impl SyncConfig {
    /// 設定のファイルの場所。
    pub fn path(config_dir: &Path) -> PathBuf {
        config_dir.join(CONFIG_FILE)
    }

    /// 読む。無い・壊れているときは、同期を使わない設定で始める（壊れていたことは、`true` で知らせる）。端末の名前が無ければ決める。
    pub fn load(config_dir: &Path) -> (SyncConfig, bool) {
        let (mut config, broken) = match fs::read_to_string(SyncConfig::path(config_dir)) {
            Ok(text) => match serde_json::from_str::<SyncConfig>(&text) {
                Ok(config) => (config, false),
                Err(_) => (SyncConfig::default(), true),
            },
            Err(e) if e.kind() == io::ErrorKind::NotFound => (SyncConfig::default(), false),
            Err(_) => (SyncConfig::default(), true),
        };
        if config.device_id.is_empty() {
            config.device_id = new_device_id();
        }
        (config, broken)
    }

    /// 書く（別の名前で書いてから置き換える）。
    pub fn save(&self, config_dir: &Path) -> io::Result<()> {
        fs::create_dir_all(config_dir)?;
        let text = serde_json::to_string_pretty(self).map_err(io::Error::other)?;
        write_atomic(&SyncConfig::path(config_dir), text.as_bytes())
    }
}

/// 同期の作業のフォルダの親（同期用の DB の手元の写しとベースを、全部ここの下に置く。「この端末の同期を切る」で、まるごと消す）。
pub fn sync_root(config_dir: &Path) -> PathBuf {
    config_dir.join(SYNC_DIR)
}

/// 同期の作業のフォルダ（保存先と同期先の組ごとに別。保存先や同期先を替えたとき、前のものに混ざらないように）。
pub fn profile_dir(config_dir: &Path, data_dir: &Path, remote_url: &str) -> PathBuf {
    let digest = sha256_hex(
        format!(
            "{}
{remote_url}",
            data_dir.to_string_lossy()
        )
        .as_bytes(),
    );
    sync_root(config_dir).join(&digest[..12])
}

/// ベースの 1 行の状態。
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
pub enum BaseState {
    /// 前回、中身があった。
    #[serde(rename = "p")]
    Present,
    /// 前回、消えていた（消した印）。
    #[serde(rename = "x")]
    Deleted,
}

/// ベースの 1 行。
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct BaseEntry {
    #[serde(rename = "s")]
    pub state: BaseState,
    /// 前回合っていた中身の指紋（SHA-256 の前半の 32 文字）。
    #[serde(rename = "h")]
    pub hash: String,
    /// そのときの同期用の DB の行の更新時刻（ミリ秒）。
    #[serde(rename = "t")]
    pub updated_at: i64,
    /// そのときの行の端末。
    #[serde(rename = "d")]
    pub device: String,
    /// 結果のファイルの、大きさと更新時刻の目印（変わっていなければ、指紋を計算し直さない）。
    #[serde(rename = "f", default, skip_serializing_if = "Option::is_none")]
    pub fp: Option<String>,
}

/// 中身の指紋（SHA-256 の前半の 32 文字）。
pub fn hash_of(value: &str) -> String {
    sha256_hex(value.as_bytes())[..32].to_string()
}

/// 前回の突き合わせの記録。
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct Base {
    #[serde(default)]
    pub version: u32,
    /// 前回つないだ同期用の DB の名前（同期用の DB を作り直すと変わる）。
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub db_id: Option<String>,
    /// 最後に同期が成功した時刻（ミリ秒）。
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub last_ok_ms: Option<i64>,
    /// 前回までに、行を突き合わせたか（初めての同期のとき、設定は「ほかの端末の値を先に取る」ために使う）。
    #[serde(default)]
    pub reconciled_once: bool,
    #[serde(default)]
    pub entries: BTreeMap<String, BaseEntry>,
}

impl Default for Base {
    fn default() -> Self {
        Base {
            version: BASE_VERSION,
            db_id: None,
            last_ok_ms: None,
            reconciled_once: false,
            entries: BTreeMap::new(),
        }
    }
}

impl Base {
    /// ベースのファイルの場所。
    pub fn path(profile: &Path) -> PathBuf {
        profile.join(BASE_FILE)
    }

    /// 読む。無いときは空。壊れているときも空にして、`true` で知らせる
    /// （空のベースは「初めての同期」と同じ動き: 食い違いは更新時刻で決め、消えたものは、ほかの端末が決めた消した印に従う）。
    pub fn load(profile: &Path) -> (Base, bool) {
        match fs::read_to_string(Base::path(profile)) {
            Ok(text) => match serde_json::from_str::<Base>(&text) {
                Ok(base) if base.version <= BASE_VERSION => (base, false),
                _ => (Base::default(), true),
            },
            Err(e) if e.kind() == io::ErrorKind::NotFound => (Base::default(), false),
            Err(_) => (Base::default(), true),
        }
    }

    /// 書く（別の名前で書いてから置き換える）。
    pub fn save(&self, profile: &Path) -> io::Result<()> {
        fs::create_dir_all(profile)?;
        let text = serde_json::to_string(self).map_err(io::Error::other)?;
        write_atomic(&Base::path(profile), text.as_bytes())
    }

    /// 行の記録を全部捨てる（作り直し・別の同期用の DB に替えたとき）。端末の名前や、最後の成功の時刻は変えない。
    pub fn forget_rows(&mut self) {
        self.entries.clear();
        self.reconciled_once = false;
    }

    /// ベースに出てくる半荘の名前。
    pub fn known_sessions(&self) -> std::collections::BTreeSet<String> {
        self.entries
            .keys()
            .filter_map(|key| super::rows::session_of(key).map(str::to_string))
            .collect()
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn config_round_trips_and_a_missing_or_broken_file_means_sync_off() {
        let tmp = tempfile::tempdir().unwrap();
        let (fresh, broken) = SyncConfig::load(tmp.path());
        assert!(!broken && !fresh.enabled && fresh.url.is_empty());
        assert!(fresh.device_id.starts_with("d-"));
        let saved = SyncConfig {
            enabled: true,
            url: "db-org.aws-ap-northeast-1.turso.io".to_string(),
            device_id: "d-0123abcd".to_string(),
        };
        saved.save(tmp.path()).unwrap();
        assert_eq!(SyncConfig::load(tmp.path()), (saved.clone(), false));
        fs::write(SyncConfig::path(tmp.path()), "{ broken").unwrap();
        let (after, broken) = SyncConfig::load(tmp.path());
        assert!(broken && !after.enabled);
        // 項目が足りないファイルは、足りない項目を既定で補う
        fs::write(SyncConfig::path(tmp.path()), r#"{"enabled":true}"#).unwrap();
        let (partial, broken) = SyncConfig::load(tmp.path());
        assert!(!broken && partial.enabled && partial.url.is_empty());
    }

    #[test]
    fn the_work_folder_depends_on_the_data_dir_and_the_sync_target() {
        let config = Path::new(r"C:\cfg");
        let url = "db-org.turso.io";
        let a = profile_dir(config, Path::new(r"C:\data-a"), url);
        let b = profile_dir(config, Path::new(r"C:\data-b"), url);
        let c = profile_dir(config, Path::new(r"C:\data-a"), "other-org.turso.io");
        assert_ne!(a, b);
        assert_ne!(a, c);
        assert!(a.starts_with(sync_root(config)));
        assert_eq!(a, profile_dir(config, Path::new(r"C:\data-a"), url));
    }

    #[test]
    fn base_round_trips_and_a_broken_file_becomes_an_empty_base() {
        let tmp = tempfile::tempdir().unwrap();
        let (empty, broken) = Base::load(tmp.path());
        assert!(!broken && empty.entries.is_empty());
        let mut base = Base {
            db_id: Some("db-1".into()),
            last_ok_ms: Some(1_760_000_000_000),
            reconciled_once: true,
            ..Base::default()
        };
        base.entries.insert(
            "mm:20261009-190953:3".into(),
            BaseEntry {
                state: BaseState::Present,
                hash: hash_of("{}"),
                updated_at: 5,
                device: "d-1".into(),
                fp: None,
            },
        );
        base.entries.insert(
            "r:20261009-190953".into(),
            BaseEntry {
                state: BaseState::Deleted,
                hash: hash_of("x"),
                updated_at: 6,
                device: "d-2".into(),
                fp: Some("123:456".into()),
            },
        );
        base.save(tmp.path()).unwrap();
        let (read, broken) = Base::load(tmp.path());
        assert!(!broken);
        assert_eq!(read, base);
        assert_eq!(
            read.known_sessions().into_iter().collect::<Vec<_>>(),
            vec!["20261009-190953".to_string()]
        );
        fs::write(Base::path(tmp.path()), "garbage").unwrap();
        let (after, broken) = Base::load(tmp.path());
        assert!(broken && after.entries.is_empty());
        // 新しい版のベースは、読まずに空にする
        fs::write(Base::path(tmp.path()), r#"{"version":99,"entries":{}}"#).unwrap();
        assert!(Base::load(tmp.path()).1);
    }

    #[test]
    fn hashes_are_32_hex_chars_and_depend_on_the_content() {
        assert_eq!(hash_of("a").len(), 32);
        assert_ne!(hash_of("a"), hash_of("b"));
        assert_eq!(hash_of("a"), hash_of("a"));
    }
}
