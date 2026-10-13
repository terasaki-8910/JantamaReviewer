//! 同期用の DB（Turso。F15、D-4）の手元の写しと、通信。
//!
//! 手元の写し（`sync.db`。同期の部品が、横に補助のファイルを置く）に、行を読み書きする。通信するのは、`pull`（ほかの端末の変更を取り込む）と
//! `push`（手元の写しへの変更を送る）の 2 つだけ。どちらも、決めた時間で打ち切る（つながらない宛先では、同期の部品は 10〜21 秒かかってから
//! 失敗する。同期の試しで確かめた）。打ち切ったら、同期の部品の手元の写しへの口を閉じて、次の回に開き直す。
//!
//! 同期用の DB の表（三つ。同期される）:
//! - `sync_meta(k, v)`: 表の作りの版（`schema_version`）と、この DB の名前（`db_id`。作り直すと変わる）。`PRAGMA user_version` は同期されないので、
//!   版は表に持つ。
//! - `sync_records(key, kind, value, updated_at, device, deleted)`: 行。1 行 = 1 件の記録（鍵の形は `rows.rs`）。
//! - `sync_blobs(key, encoding, bytes, body)`: 結果のファイル（圧縮した本体）。
//!
//! 行の書き方: 既にある行は `UPDATE`（変えた列だけが、ほかの端末に届く）、無い行は `INSERT`。`merge::RemoteWrite` の約束
//! （`Put` は消した印の列を書かない）を、ここで守る。

use std::collections::{BTreeMap, BTreeSet};
use std::future::Future;
use std::path::{Path, PathBuf};
use std::time::Duration;

use turso::sync::{Builder, Database};
use turso::{params, Connection, Value};

use super::credentials::{redact, Secret};
use super::endpoint::SyncEndpoint;
use super::error::SyncError;
use super::merge::{RemoteRow, RemoteWrite};
use super::rows::kind_of;

/// 同期用の DB の表の作りの版。
pub const SCHEMA_VERSION: u32 = 1;

/// 通信の待ち時間の上限。
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub struct Timeouts {
    /// 同期用の DB の手元の写しを開く（初めては、全体を取り込む）。
    pub open: Duration,
    /// ほかの端末の変更を取り込む。
    pub pull: Duration,
    /// 手元の変更を送る（初めての同期は、記録の全部と結果のファイルを送るので、長い）。
    pub push: Duration,
}

impl Default for Timeouts {
    fn default() -> Self {
        Timeouts {
            open: Duration::from_secs(90),
            pull: Duration::from_secs(45),
            push: Duration::from_secs(180),
        }
    }
}

/// 同期用の DB の名前と版。
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct RemoteMeta {
    pub db_id: String,
    pub schema_version: u32,
}

/// 結果のファイルの本体の、圧縮の名前。
pub const ENCODING_GZIP: &str = "gzip";

/// 同期用の DB への口。実装は、Turso（`TursoRemote`）と、試験の偽物（`testing::MemRemote`）。
pub trait Remote: Send {
    /// ほかの端末の変更を取り込む（通信）。
    fn pull(&mut self) -> Result<(), SyncError>;
    /// 手元の写しへの変更を送る（通信）。
    fn push(&mut self) -> Result<(), SyncError>;
    /// 表が無ければ作って（`db_id` を新しく付ける）、名前と版を返す。通信しない。
    fn ensure_schema(&mut self, now_ms: i64) -> Result<RemoteMeta, SyncError>;
    /// 全部の行（消した印の行も）。通信しない。
    fn read_rows(&mut self) -> Result<BTreeMap<String, RemoteRow>, SyncError>;
    /// 行を書く（1 つの取引）。`blobs` は、結果のファイルの本体（鍵 → 圧縮したバイト列）。消した印の行の本体は、消す。通信しない。
    fn write_rows(
        &mut self,
        writes: &[RemoteWrite],
        blobs: &BTreeMap<String, Vec<u8>>,
    ) -> Result<(), SyncError>;
    /// 結果のファイルの本体（圧縮したバイト列）。無ければ `None`。通信しない。
    fn read_blob(&mut self, key: &str) -> Result<Option<Vec<u8>>, SyncError>;
    /// 同期用の DB の行を全部消して、新しい名前を付ける（作り直し）。通信しない（push で届く）。
    fn reset(&mut self, new_db_id: &str, now_ms: i64) -> Result<(), SyncError>;
}

const DDL: &str = "
CREATE TABLE IF NOT EXISTS sync_meta (k TEXT PRIMARY KEY, v TEXT NOT NULL);
CREATE TABLE IF NOT EXISTS sync_records (
  key TEXT PRIMARY KEY,
  kind TEXT NOT NULL,
  value TEXT NOT NULL DEFAULT '',
  updated_at INTEGER NOT NULL,
  device TEXT NOT NULL,
  deleted INTEGER NOT NULL DEFAULT 0
);
CREATE TABLE IF NOT EXISTS sync_blobs (
  key TEXT PRIMARY KEY,
  encoding TEXT NOT NULL,
  bytes INTEGER NOT NULL,
  body BLOB NOT NULL
);";

struct Handle {
    // 接続は、同期の部品の口より先に閉じる（宣言の順に落ちる）
    conn: Connection,
    db: Database,
}

/// Turso の同期（`turso` クレートの同期）による、同期用の DB。
pub struct TursoRemote {
    rt: tokio::runtime::Runtime,
    path: PathBuf,
    base_url: String,
    token: Option<Secret>,
    client_name: String,
    timeouts: Timeouts,
    handle: Option<Handle>,
}

fn reason_of(error: &turso::Error, token: &Option<Secret>) -> String {
    let secrets: Vec<&str> = token.iter().map(Secret::expose).collect();
    redact(&error.to_string(), &secrets)
}

fn classify(error: &turso::Error, token: &Option<Secret>) -> SyncError {
    let reason = reason_of(error, token);
    let lower = reason.to_ascii_lowercase();
    if lower.contains("401") || lower.contains("unauthorized") || lower.contains("403") {
        SyncError::Unauthorized
    } else {
        SyncError::Offline(reason)
    }
}

impl TursoRemote {
    /// 手元の写し（`path`）と、通信先・トークンを決める。開くのは、最初に使うとき。
    pub fn new(
        path: &Path,
        endpoint: &SyncEndpoint,
        token: Option<Secret>,
        client_name: &str,
        timeouts: Timeouts,
    ) -> Result<TursoRemote, SyncError> {
        let rt = tokio::runtime::Builder::new_current_thread()
            .enable_time()
            .build()
            .map_err(|e| SyncError::Local(format!("非同期の実行環境を作れません: {e}")))?;
        if let Some(parent) = path.parent() {
            std::fs::create_dir_all(parent)
                .map_err(|e| SyncError::Local(format!("同期の作業のフォルダを作れません: {e}")))?;
        }
        Ok(TursoRemote {
            rt,
            path: path.to_path_buf(),
            base_url: endpoint.base_url(),
            token,
            client_name: client_name.to_string(),
            timeouts,
            handle: None,
        })
    }

    /// 手元の写しを開く（無ければ、通信して、全体を取り込む）。開けなければ、`Offline` か `Unauthorized`。
    fn ensure_open(&mut self) -> Result<(), SyncError> {
        if self.handle.is_some() {
            return Ok(());
        }
        let path = self.path.to_string_lossy().into_owned();
        let url = self.base_url.clone();
        let name = self.client_name.clone();
        let token = self.token.clone();
        let limit = self.timeouts.open;
        let opened = self.rt.block_on(async {
            let mut builder = Builder::new_remote(&path)
                .with_remote_url(url)
                .with_client_name(name);
            if let Some(token) = &token {
                builder = builder.with_auth_token(token.expose().to_string());
            }
            let build = async {
                let db = builder.build().await?;
                let conn = db.connect().await?;
                Ok::<Handle, turso::Error>(Handle { conn, db })
            };
            match tokio::time::timeout(limit, build).await {
                Ok(Ok(handle)) => Ok(handle),
                Ok(Err(error)) => Err(classify(&error, &token)),
                Err(_) => Err(SyncError::Offline(
                    "手元の写しを開くのに時間がかかりすぎました".to_string(),
                )),
            }
        })?;
        self.handle = Some(opened);
        Ok(())
    }

    /// 同期の部品の口を閉じる（打ち切ったあと・作り直すとき）。手元の写しのファイルは、そのまま残る。
    pub fn close(&mut self) {
        self.handle = None;
    }

    /// 手元の写しのファイルの場所。
    pub fn path(&self) -> &Path {
        &self.path
    }

    fn local<T>(
        &mut self,
        work: impl for<'a> FnOnce(
            &'a Connection,
        ) -> std::pin::Pin<
            Box<dyn Future<Output = Result<T, turso::Error>> + 'a>,
        >,
    ) -> Result<T, SyncError> {
        self.ensure_open()?;
        let token = self.token.clone();
        let Some(handle) = self.handle.as_ref() else {
            return Err(SyncError::Local("同期用の DB を開けていません".to_string()));
        };
        self.rt
            .block_on(work(&handle.conn))
            .map_err(|e| SyncError::Remote(reason_of(&e, &token)))
    }
}

fn text_of(value: Value) -> String {
    match value {
        Value::Text(text) => text,
        _ => String::new(),
    }
}

fn int_of(value: Value) -> i64 {
    match value {
        Value::Integer(n) => n,
        _ => 0,
    }
}

impl Remote for TursoRemote {
    fn pull(&mut self) -> Result<(), SyncError> {
        self.ensure_open()?;
        let limit = self.timeouts.pull;
        let token = self.token.clone();
        let outcome = match self.handle.as_ref() {
            Some(handle) => self.rt.block_on(async {
                match tokio::time::timeout(limit, handle.db.pull()).await {
                    Ok(Ok(_)) => Ok(()),
                    Ok(Err(error)) => Err(classify(&error, &token)),
                    Err(_) => Err(SyncError::Offline(
                        "取り込みに時間がかかりすぎました".to_string(),
                    )),
                }
            }),
            None => Err(SyncError::Local("同期用の DB を開けていません".to_string())),
        };
        if outcome.is_err() {
            self.close();
        }
        outcome
    }

    fn push(&mut self) -> Result<(), SyncError> {
        self.ensure_open()?;
        let limit = self.timeouts.push;
        let token = self.token.clone();
        let outcome = match self.handle.as_ref() {
            Some(handle) => self.rt.block_on(async {
                match tokio::time::timeout(limit, handle.db.push()).await {
                    Ok(Ok(())) => Ok(()),
                    Ok(Err(error)) => Err(classify(&error, &token)),
                    Err(_) => Err(SyncError::Offline(
                        "送信に時間がかかりすぎました".to_string(),
                    )),
                }
            }),
            None => Err(SyncError::Local("同期用の DB を開けていません".to_string())),
        };
        if outcome.is_err() {
            self.close();
        }
        outcome
    }

    fn ensure_schema(&mut self, now_ms: i64) -> Result<RemoteMeta, SyncError> {
        let fresh_id = crate::ids::new_uid();
        self.local(move |conn| {
            Box::pin(async move {
                conn.execute_batch(DDL).await?;
                let mut meta: BTreeMap<String, String> = BTreeMap::new();
                {
                    let mut rows = conn.query("SELECT k, v FROM sync_meta", ()).await?;
                    while let Some(row) = rows.next().await? {
                        meta.insert(text_of(row.get_value(0)?), text_of(row.get_value(1)?));
                    }
                }
                if !meta.contains_key("db_id") {
                    conn.execute(
                        "INSERT INTO sync_meta (k, v) VALUES ('db_id', ?1)",
                        params![fresh_id.clone()],
                    )
                    .await?;
                    meta.insert("db_id".to_string(), fresh_id);
                }
                if !meta.contains_key("schema_version") {
                    conn.execute(
                        "INSERT INTO sync_meta (k, v) VALUES ('schema_version', ?1)",
                        params![SCHEMA_VERSION.to_string()],
                    )
                    .await?;
                    conn.execute(
                        "INSERT OR IGNORE INTO sync_meta (k, v) VALUES ('created_at', ?1)",
                        params![now_ms.to_string()],
                    )
                    .await?;
                    meta.insert("schema_version".to_string(), SCHEMA_VERSION.to_string());
                }
                Ok(RemoteMeta {
                    db_id: meta.get("db_id").cloned().unwrap_or_default(),
                    schema_version: meta
                        .get("schema_version")
                        .and_then(|v| v.parse().ok())
                        .unwrap_or(SCHEMA_VERSION),
                })
            })
        })
    }

    fn read_rows(&mut self) -> Result<BTreeMap<String, RemoteRow>, SyncError> {
        self.local(|conn| {
            Box::pin(async move {
                let mut out = BTreeMap::new();
                let mut rows = conn
                    .query(
                        "SELECT key, value, updated_at, device, deleted FROM sync_records",
                        (),
                    )
                    .await?;
                while let Some(row) = rows.next().await? {
                    let key = text_of(row.get_value(0)?);
                    let value = text_of(row.get_value(1)?);
                    let updated_at = int_of(row.get_value(2)?);
                    let device = text_of(row.get_value(3)?);
                    let deleted = int_of(row.get_value(4)?) != 0;
                    out.insert(
                        key,
                        RemoteRow {
                            value: if deleted { None } else { Some(value) },
                            updated_at,
                            device,
                        },
                    );
                }
                Ok(out)
            })
        })
    }

    fn write_rows(
        &mut self,
        writes: &[RemoteWrite],
        blobs: &BTreeMap<String, Vec<u8>>,
    ) -> Result<(), SyncError> {
        if writes.is_empty() && blobs.is_empty() {
            return Ok(());
        }
        let writes = writes.to_vec();
        let blobs = blobs.clone();
        self.local(move |conn| {
            Box::pin(async move {
                let mut existing: BTreeSet<String> = BTreeSet::new();
                {
                    let mut rows = conn.query("SELECT key FROM sync_records", ()).await?;
                    while let Some(row) = rows.next().await? {
                        existing.insert(text_of(row.get_value(0)?));
                    }
                }
                let mut existing_blobs: BTreeSet<String> = BTreeSet::new();
                {
                    let mut rows = conn.query("SELECT key FROM sync_blobs", ()).await?;
                    while let Some(row) = rows.next().await? {
                        existing_blobs.insert(text_of(row.get_value(0)?));
                    }
                }
                conn.execute("BEGIN", ()).await?;
                let run = async {
                    for write in &writes {
                        match write {
                            RemoteWrite::Put {
                                key,
                                value,
                                updated_at,
                                device,
                                revive,
                            } => {
                                if existing.contains(key) {
                                    let sql = if *revive {
                                        "UPDATE sync_records SET value = ?2, updated_at = ?3, device = ?4, deleted = 0 WHERE key = ?1"
                                    } else {
                                        "UPDATE sync_records SET value = ?2, updated_at = ?3, device = ?4 WHERE key = ?1"
                                    };
                                    conn.execute(
                                        sql,
                                        params![
                                            key.clone(),
                                            value.clone(),
                                            *updated_at,
                                            device.clone()
                                        ],
                                    )
                                    .await?;
                                } else {
                                    let kind = kind_label(key);
                                    conn.execute(
                                        "INSERT INTO sync_records (key, kind, value, updated_at, device, deleted) VALUES (?1, ?2, ?3, ?4, ?5, 0)",
                                        params![
                                            key.clone(),
                                            kind,
                                            value.clone(),
                                            *updated_at,
                                            device.clone()
                                        ],
                                    )
                                    .await?;
                                    existing.insert(key.clone());
                                }
                            }
                            RemoteWrite::Tombstone {
                                key,
                                updated_at,
                                device,
                            } => {
                                if existing.contains(key) {
                                    conn.execute(
                                        "UPDATE sync_records SET deleted = 1, updated_at = ?2, device = ?3 WHERE key = ?1",
                                        params![key.clone(), *updated_at, device.clone()],
                                    )
                                    .await?;
                                } else {
                                    let kind = kind_label(key);
                                    conn.execute(
                                        "INSERT INTO sync_records (key, kind, value, updated_at, device, deleted) VALUES (?1, ?2, '', ?3, ?4, 1)",
                                        params![key.clone(), kind, *updated_at, device.clone()],
                                    )
                                    .await?;
                                    existing.insert(key.clone());
                                }
                                if existing_blobs.remove(key) {
                                    conn.execute(
                                        "DELETE FROM sync_blobs WHERE key = ?1",
                                        params![key.clone()],
                                    )
                                    .await?;
                                }
                            }
                        }
                    }
                    for (key, body) in &blobs {
                        let size = i64::try_from(body.len()).unwrap_or(i64::MAX);
                        if existing_blobs.contains(key) {
                            conn.execute(
                                "UPDATE sync_blobs SET encoding = ?2, bytes = ?3, body = ?4 WHERE key = ?1",
                                params![
                                    key.clone(),
                                    ENCODING_GZIP,
                                    size,
                                    Value::Blob(body.clone())
                                ],
                            )
                            .await?;
                        } else {
                            conn.execute(
                                "INSERT INTO sync_blobs (key, encoding, bytes, body) VALUES (?1, ?2, ?3, ?4)",
                                params![
                                    key.clone(),
                                    ENCODING_GZIP,
                                    size,
                                    Value::Blob(body.clone())
                                ],
                            )
                            .await?;
                            existing_blobs.insert(key.clone());
                        }
                    }
                    Ok::<(), turso::Error>(())
                };
                match run.await {
                    Ok(()) => {
                        conn.execute("COMMIT", ()).await?;
                        Ok(())
                    }
                    Err(error) => {
                        let _ = conn.execute("ROLLBACK", ()).await;
                        Err(error)
                    }
                }
            })
        })
    }

    fn read_blob(&mut self, key: &str) -> Result<Option<Vec<u8>>, SyncError> {
        let key = key.to_string();
        self.local(move |conn| {
            Box::pin(async move {
                let mut rows = conn
                    .query("SELECT body FROM sync_blobs WHERE key = ?1", params![key])
                    .await?;
                match rows.next().await? {
                    Some(row) => match row.get_value(0)? {
                        Value::Blob(bytes) => Ok(Some(bytes)),
                        _ => Ok(None),
                    },
                    None => Ok(None),
                }
            })
        })
    }

    fn reset(&mut self, new_db_id: &str, now_ms: i64) -> Result<(), SyncError> {
        let new_db_id = new_db_id.to_string();
        self.local(move |conn| {
            Box::pin(async move {
                conn.execute_batch(DDL).await?;
                conn.execute("BEGIN", ()).await?;
                let run = async {
                    conn.execute("DELETE FROM sync_records", ()).await?;
                    conn.execute("DELETE FROM sync_blobs", ()).await?;
                    conn.execute("DELETE FROM sync_meta", ()).await?;
                    conn.execute(
                        "INSERT INTO sync_meta (k, v) VALUES ('db_id', ?1)",
                        params![new_db_id],
                    )
                    .await?;
                    conn.execute(
                        "INSERT INTO sync_meta (k, v) VALUES ('schema_version', ?1)",
                        params![SCHEMA_VERSION.to_string()],
                    )
                    .await?;
                    conn.execute(
                        "INSERT INTO sync_meta (k, v) VALUES ('created_at', ?1)",
                        params![now_ms.to_string()],
                    )
                    .await?;
                    Ok::<(), turso::Error>(())
                };
                match run.await {
                    Ok(()) => {
                        conn.execute("COMMIT", ()).await?;
                        Ok(())
                    }
                    Err(error) => {
                        let _ = conn.execute("ROLLBACK", ()).await;
                        Err(error)
                    }
                }
            })
        })
    }
}

/// 行の種類の名前（`sync_records.kind`。鍵の先頭の部分。読み物として残すだけで、突き合わせには使わない）。
fn kind_label(key: &str) -> String {
    match kind_of(key) {
        Some(_) => key.split(':').next().unwrap_or("").to_string(),
        None => String::new(),
    }
}
