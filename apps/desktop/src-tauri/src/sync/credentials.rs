//! 同期のトークン（Turso の DB 用トークン）の置き場（F15、D-4）。
//!
//! トークンは、OS の資格情報の保管庫（Windows の資格情報マネージャー、Mac のキーチェーン）にだけ入れる。設定ファイル・同期の状態の
//! ファイル・書き出し・ログ・画面の状態・パニックの文には、書かない（`Secret` の中身は `Debug` で伏せる。エラーの文に混ざったものは
//! `redact` で伏せる）。端末ごとに 1 回、設定に貼る。端末ごとに別の項目にする（設定のフォルダの場所から決めた名前）ので、
//! 試しに別の設定フォルダで動かしても、本物の項目には触れない。

use std::fmt;
use std::path::Path;
use std::sync::Mutex;

use crate::ids::sha256_hex;

/// 資格情報の保管庫の、アプリの名前。
pub const KEYRING_SERVICE: &str = "JantamaReviewer";

/// 伏せ字。
pub const MASK: &str = "<伏せ字>";

/// トークンの文字列。`Debug` に出しても、中身は伏せる。
#[derive(Clone, PartialEq, Eq)]
pub struct Secret(String);

impl Secret {
    pub fn new(text: impl Into<String>) -> Secret {
        Secret(text.into())
    }

    /// 通信に使うとき、中身を取り出す（ほかには、取り出さない）。
    pub fn expose(&self) -> &str {
        &self.0
    }
}

impl fmt::Debug for Secret {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        write!(f, "Secret({MASK})")
    }
}

/// 保管庫の操作の失敗。画面に出せる日本語の文（トークンは含まない）。
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct CredentialError(pub String);

impl fmt::Display for CredentialError {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        f.write_str(&self.0)
    }
}

impl std::error::Error for CredentialError {}

/// トークンを入れる・取り出す・消す口。実装は OS の保管庫と、試験の偽物。
pub trait TokenStore: Send + Sync {
    /// 入っているトークン。入っていなければ `None`。
    fn load(&self) -> Result<Option<Secret>, CredentialError>;
    /// トークンを入れる（あれば置き換える）。
    fn save(&self, token: &str) -> Result<(), CredentialError>;
    /// トークンを消す（無くてもエラーにしない）。
    fn delete(&self) -> Result<(), CredentialError>;
}

/// OS の資格情報の保管庫。
pub struct OsTokenStore {
    service: String,
    account: String,
}

impl OsTokenStore {
    /// 設定のフォルダに結びつけた項目。
    pub fn for_config_dir(config_dir: &Path) -> OsTokenStore {
        OsTokenStore::named(KEYRING_SERVICE, &account_for(config_dir))
    }

    /// 名前を決めて作る（試験で、本物の項目と別の名前にするため）。
    pub fn named(service: &str, account: &str) -> OsTokenStore {
        OsTokenStore {
            service: service.to_string(),
            account: account.to_string(),
        }
    }

    fn entry(&self) -> Result<keyring::Entry, CredentialError> {
        keyring::Entry::new(&self.service, &self.account).map_err(map_error)
    }
}

/// 設定のフォルダの場所から決める、保管庫の項目の名前。
pub fn account_for(config_dir: &Path) -> String {
    let digest = sha256_hex(config_dir.to_string_lossy().as_bytes());
    format!("turso-sync-token-{}", &digest[..12])
}

fn map_error(error: keyring::Error) -> CredentialError {
    use keyring::Error;
    let reason = match error {
        Error::NoStorageAccess(_) | Error::NoDefaultStore => {
            "OS の資格情報の保管庫を使えません".to_string()
        }
        Error::TooLong(_, _) => "トークンが長すぎて、資格情報の保管庫に入りません".to_string(),
        Error::BadEncoding(_) | Error::Invalid(_, _) => {
            "トークンを資格情報の保管庫に入れられません（文字の形が正しくありません）".to_string()
        }
        other => format!("資格情報の保管庫の操作に失敗しました（{other}）"),
    };
    CredentialError(reason)
}

impl TokenStore for OsTokenStore {
    fn load(&self) -> Result<Option<Secret>, CredentialError> {
        match self.entry()?.get_password() {
            Ok(token) if token.is_empty() => Ok(None),
            Ok(token) => Ok(Some(Secret::new(token))),
            Err(keyring::Error::NoEntry) => Ok(None),
            Err(other) => Err(map_error(other)),
        }
    }

    fn save(&self, token: &str) -> Result<(), CredentialError> {
        self.entry()?.set_password(token).map_err(map_error)
    }

    fn delete(&self) -> Result<(), CredentialError> {
        match self.entry()?.delete_credential() {
            Ok(()) | Err(keyring::Error::NoEntry) => Ok(()),
            Err(other) => Err(map_error(other)),
        }
    }
}

/// 試験用の保管庫（メモリの中だけ。OS の保管庫に触れない）。
#[derive(Default)]
pub struct MemoryTokenStore {
    token: Mutex<Option<String>>,
}

impl MemoryTokenStore {
    pub fn new() -> MemoryTokenStore {
        MemoryTokenStore::default()
    }

    pub fn with_token(token: &str) -> MemoryTokenStore {
        MemoryTokenStore {
            token: Mutex::new(Some(token.to_string())),
        }
    }
}

impl TokenStore for MemoryTokenStore {
    fn load(&self) -> Result<Option<Secret>, CredentialError> {
        Ok(self
            .token
            .lock()
            .unwrap_or_else(std::sync::PoisonError::into_inner)
            .clone()
            .map(Secret::new))
    }

    fn save(&self, token: &str) -> Result<(), CredentialError> {
        *self
            .token
            .lock()
            .unwrap_or_else(std::sync::PoisonError::into_inner) = Some(token.to_string());
        Ok(())
    }

    fn delete(&self) -> Result<(), CredentialError> {
        *self
            .token
            .lock()
            .unwrap_or_else(std::sync::PoisonError::into_inner) = None;
        Ok(())
    }
}

/// 文章の中のトークンを伏せる。次の 2 つを伏せる:
/// - `secrets`（いま使っているトークン）と同じ文字の並び（6 文字以上のもの）
/// - トークンの形をした文字の並び（`eyJ` で始まり、英数字・`-`・`_`・`.` が 20 文字以上続くもの。JWT）
///
/// 通信の失敗の文などを、画面・ログ・状態の記録に出す前に、必ず通す。
pub fn redact(text: &str, secrets: &[&str]) -> String {
    let mut out = text.to_string();
    for secret in secrets {
        if secret.chars().count() >= 6 {
            out = out.replace(secret, MASK);
        }
    }
    mask_jwt_like(&out)
}

fn mask_jwt_like(text: &str) -> String {
    let is_token_char = |c: char| c.is_ascii_alphanumeric() || matches!(c, '-' | '_' | '.');
    let chars: Vec<char> = text.chars().collect();
    let mut out = String::with_capacity(text.len());
    let mut i = 0;
    while i < chars.len() {
        let starts_here = chars[i] == 'e'
            && chars.get(i + 1) == Some(&'y')
            && chars.get(i + 2) == Some(&'J')
            && (i == 0 || !is_token_char(chars[i - 1]));
        if starts_here {
            let mut end = i;
            while end < chars.len() && is_token_char(chars[end]) {
                end += 1;
            }
            if end - i >= 20 {
                out.push_str(MASK);
                i = end;
                continue;
            }
        }
        out.push(chars[i]);
        i += 1;
    }
    out
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn a_secret_never_shows_its_content_in_debug_output() {
        let secret = Secret::new("super-secret-token-value");
        let shown = format!("{secret:?} {:?}", Some(&secret));
        assert!(!shown.contains("super-secret"), "{shown}");
        assert!(shown.contains(MASK));
        assert_eq!(secret.expose(), "super-secret-token-value");
    }

    #[test]
    fn redact_hides_the_token_and_anything_shaped_like_one() {
        let token = "abcDEF123456-secretvalue";
        let text = format!("request failed: Authorization Bearer {token} at host");
        let hidden = redact(&text, &[token]);
        assert!(!hidden.contains("secretvalue"), "{hidden}");
        assert!(hidden.contains("request failed"));
        // 渡していないトークンでも、JWT の形なら伏せる
        let jwt = "eyJhbGciOiJFZERTQSIsInR5cCI6IkpXVCJ9.eyJhIjoicnciLCJpYXQiOjE3MDAwMDAwMDB9.c2lnbmF0dXJl";
        let hidden = redact(&format!("bad token {jwt}!"), &[]);
        assert!(!hidden.contains("eyJhbGci"), "{hidden}");
        assert!(hidden.starts_with("bad token "));
        assert!(hidden.ends_with("!"));
        // 短い語や、ふつうの文は、そのまま
        assert_eq!(redact("eyJ だけ", &[]), "eyJ だけ");
        assert_eq!(redact("つながりません", &["abc"]), "つながりません");
    }

    #[test]
    fn the_account_name_depends_on_the_config_dir_and_has_no_path_in_it() {
        let a = account_for(Path::new("C:\\Users\\x\\AppData\\Roaming\\app"));
        let b = account_for(Path::new("C:\\Temp\\trial"));
        assert_ne!(a, b);
        assert!(
            a.starts_with("turso-sync-token-") && a.len() == 17 + 12,
            "{a}"
        );
        assert!(!a.contains("Users"));
    }

    #[test]
    fn the_memory_store_saves_loads_and_deletes() {
        let store = MemoryTokenStore::new();
        assert_eq!(store.load().unwrap(), None);
        store.save("t0ken-value-1").unwrap();
        assert_eq!(store.load().unwrap().unwrap().expose(), "t0ken-value-1");
        store.delete().unwrap();
        store.delete().unwrap();
        assert_eq!(store.load().unwrap(), None);
    }

    /// 手動（`pnpm test:sync`）: 本物の OS の保管庫に、試験用の名前で入れて、取り出して、消す。
    /// 試験用の名前は、本物の項目と別。入れるのは作り物の文字で、終わったら必ず消す。
    #[test]
    #[ignore = "OS の資格情報の保管庫に触れるので、手動（pnpm test:sync）で動かす"]
    fn the_os_store_round_trips_a_dummy_secret_under_a_test_name() {
        let account = format!("test-{}", crate::ids::new_uid());
        let store = OsTokenStore::named("JantamaReviewerTest", &account);
        let dummy = "dummy-token-for-the-test-only";
        store.save(dummy).unwrap();
        let loaded = store.load().unwrap();
        store.delete().unwrap();
        assert_eq!(loaded.unwrap().expose(), dummy);
        assert_eq!(store.load().unwrap(), None);
    }
}
