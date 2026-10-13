//! 同期の試験の道具（試験だけ）: 同期用の DB の偽物（サーバーと、各端末の手元の写し）と、一時フォルダの上の「端末」。
//!
//! 偽物の同期用の DB は、Turso の同期の動き（実機の試験用サーバーで確かめる）を、行の単位で真似る:
//! - 各端末は、手元の写し（`view`）と、未送信の更新（`pending`。変えた列だけの更新）を持つ。
//! - `push` は、未送信の更新を、サーバーの行に重ねる（あとに届いた更新が、その列を上書きする）。
//! - `pull` は、サーバーの行を取り込んだうえで、未送信の更新を重ね直す。
//! - つながらない状態（`offline`）では、`pull`・`push` が `Offline` で失敗する。手元の写しへの読み書きは、できる。

#![cfg(test)]

use std::collections::BTreeMap;
use std::path::{Path, PathBuf};
use std::sync::atomic::{AtomicBool, AtomicUsize, Ordering};
use std::sync::{Arc, Mutex, MutexGuard, PoisonError};

use super::base::Base;
use super::engine::{run_cycle, CycleOptions, CycleReport};
use super::error::SyncError;
use super::local::{FsLocal, Ports};
use super::merge::{RemoteRow, RemoteWrite};
use super::remote::{Remote, RemoteMeta, SCHEMA_VERSION};
use crate::settings::Settings;
use crate::store::{Store, TRASH_DIR};
use crate::study::StudyDb;

#[derive(Clone, Debug, Default)]
pub struct MemRow {
    pub value: String,
    pub deleted: bool,
    pub stamp: (i64, String),
}

#[derive(Clone, Debug, Default)]
pub struct MemStore {
    pub rows: BTreeMap<String, MemRow>,
    pub blobs: BTreeMap<String, Vec<u8>>,
    pub meta: BTreeMap<String, String>,
}

#[derive(Clone, Debug)]
enum MemOp {
    Put {
        key: String,
        value: String,
        stamp: (i64, String),
        revive: bool,
    },
    Tomb {
        key: String,
        stamp: (i64, String),
    },
    Blob {
        key: String,
        bytes: Vec<u8>,
    },
    DropBlob {
        key: String,
    },
    Meta {
        k: String,
        v: String,
    },
    Reset,
}

impl MemStore {
    fn apply(&mut self, op: &MemOp) {
        match op {
            MemOp::Put {
                key,
                value,
                stamp,
                revive,
            } => {
                let row = self.rows.entry(key.clone()).or_insert_with(|| MemRow {
                    value: String::new(),
                    deleted: false,
                    stamp: stamp.clone(),
                });
                row.value = value.clone();
                row.stamp = stamp.clone();
                if *revive {
                    row.deleted = false;
                }
            }
            MemOp::Tomb { key, stamp } => {
                let row = self.rows.entry(key.clone()).or_insert_with(|| MemRow {
                    value: String::new(),
                    deleted: false,
                    stamp: stamp.clone(),
                });
                row.deleted = true;
                row.stamp = stamp.clone();
            }
            MemOp::Blob { key, bytes } => {
                self.blobs.insert(key.clone(), bytes.clone());
            }
            MemOp::DropBlob { key } => {
                self.blobs.remove(key);
            }
            MemOp::Meta { k, v } => {
                self.meta.insert(k.clone(), v.clone());
            }
            MemOp::Reset => {
                self.rows.clear();
                self.blobs.clear();
                self.meta.clear();
            }
        }
    }
}

/// 全部の端末が共有する、サーバー。
#[derive(Clone, Default)]
pub struct MemServer(Arc<Mutex<MemStore>>);

impl MemServer {
    pub fn new() -> MemServer {
        MemServer::default()
    }

    pub fn store(&self) -> MutexGuard<'_, MemStore> {
        self.0.lock().unwrap_or_else(PoisonError::into_inner)
    }

    /// サーバーの行（消した印の行は `None`）。
    pub fn value(&self, key: &str) -> Option<String> {
        self.store()
            .rows
            .get(key)
            .filter(|row| !row.deleted)
            .map(|row| row.value.clone())
    }

    pub fn is_tombstone(&self, key: &str) -> bool {
        self.store().rows.get(key).is_some_and(|row| row.deleted)
    }

    pub fn keys(&self) -> Vec<String> {
        self.store().rows.keys().cloned().collect()
    }
}

/// 端末ごとの、同期用の DB の手元の写し。
pub struct MemRemote {
    server: MemServer,
    view: MemStore,
    pending: Vec<MemOp>,
    /// true の間、`pull`・`push` が失敗する（つながらない）。
    pub offline: Arc<AtomicBool>,
    /// `pull`・`push` を呼んだ回数。
    pub pulls: Arc<AtomicUsize>,
    pub pushes: Arc<AtomicUsize>,
    /// `pull`・`push` の失敗の文に混ぜる文字（トークンの漏れの試験）。
    pub failure_note: Arc<Mutex<Option<String>>>,
    /// true の間、`pull`・`push` が「トークンが通らない」で失敗する。
    pub unauthorized: Arc<AtomicBool>,
    /// `ensure_schema` を呼んだときに新しく付ける名前。
    pub fresh_db_id: String,
}

impl MemRemote {
    /// 端末が、同期用の DB を初めて開く（サーバーの全体を取り込む）。
    pub fn new(server: &MemServer) -> MemRemote {
        MemRemote {
            server: server.clone(),
            view: server.store().clone(),
            pending: Vec::new(),
            offline: Arc::new(AtomicBool::new(false)),
            pulls: Arc::new(AtomicUsize::new(0)),
            pushes: Arc::new(AtomicUsize::new(0)),
            failure_note: Arc::new(Mutex::new(None)),
            unauthorized: Arc::new(AtomicBool::new(false)),
            fresh_db_id: "db-test-1".to_string(),
        }
    }

    pub fn pending_len(&self) -> usize {
        self.pending.len()
    }

    fn push_op(&mut self, op: MemOp) {
        self.view.apply(&op);
        self.pending.push(op);
    }

    pub fn set_offline(&self, offline: bool) {
        self.offline.store(offline, Ordering::SeqCst);
    }

    fn failure(&self, what: &str) -> Option<SyncError> {
        if self.unauthorized.load(Ordering::SeqCst) {
            return Some(SyncError::Unauthorized);
        }
        if self.offline.load(Ordering::SeqCst) {
            let note = self
                .failure_note
                .lock()
                .unwrap_or_else(PoisonError::into_inner)
                .clone()
                .unwrap_or_default();
            return Some(SyncError::Offline(format!("{what}に失敗しました {note}")));
        }
        None
    }
}

impl Remote for MemRemote {
    fn pull(&mut self) -> Result<(), SyncError> {
        self.pulls.fetch_add(1, Ordering::SeqCst);
        if let Some(error) = self.failure("取り込み") {
            return Err(error);
        }
        let mut view = self.server.store().clone();
        for op in &self.pending {
            view.apply(op);
        }
        self.view = view;
        Ok(())
    }

    fn push(&mut self) -> Result<(), SyncError> {
        self.pushes.fetch_add(1, Ordering::SeqCst);
        if let Some(error) = self.failure("送信") {
            return Err(error);
        }
        let mut server = self.server.store();
        for op in self.pending.drain(..) {
            server.apply(&op);
        }
        Ok(())
    }

    fn ensure_schema(&mut self, now_ms: i64) -> Result<RemoteMeta, SyncError> {
        if !self.view.meta.contains_key("db_id") {
            let db_id = self.fresh_db_id.clone();
            self.push_op(MemOp::Meta {
                k: "db_id".into(),
                v: db_id,
            });
        }
        if !self.view.meta.contains_key("schema_version") {
            self.push_op(MemOp::Meta {
                k: "schema_version".into(),
                v: SCHEMA_VERSION.to_string(),
            });
            self.push_op(MemOp::Meta {
                k: "created_at".into(),
                v: now_ms.to_string(),
            });
        }
        Ok(RemoteMeta {
            db_id: self.view.meta.get("db_id").cloned().unwrap_or_default(),
            schema_version: self
                .view
                .meta
                .get("schema_version")
                .and_then(|v| v.parse().ok())
                .unwrap_or(SCHEMA_VERSION),
        })
    }

    fn read_rows(&mut self) -> Result<BTreeMap<String, RemoteRow>, SyncError> {
        Ok(self
            .view
            .rows
            .iter()
            .map(|(key, row)| {
                (
                    key.clone(),
                    RemoteRow {
                        value: (!row.deleted).then(|| row.value.clone()),
                        updated_at: row.stamp.0,
                        device: row.stamp.1.clone(),
                    },
                )
            })
            .collect())
    }

    fn write_rows(
        &mut self,
        writes: &[RemoteWrite],
        blobs: &BTreeMap<String, Vec<u8>>,
    ) -> Result<(), SyncError> {
        for write in writes {
            match write {
                RemoteWrite::Put {
                    key,
                    value,
                    updated_at,
                    device,
                    revive,
                } => self.push_op(MemOp::Put {
                    key: key.clone(),
                    value: value.clone(),
                    stamp: (*updated_at, device.clone()),
                    revive: *revive,
                }),
                RemoteWrite::Tombstone {
                    key,
                    updated_at,
                    device,
                } => {
                    self.push_op(MemOp::Tomb {
                        key: key.clone(),
                        stamp: (*updated_at, device.clone()),
                    });
                    if self.view.blobs.contains_key(key) {
                        self.push_op(MemOp::DropBlob { key: key.clone() });
                    }
                }
            }
        }
        for (key, bytes) in blobs {
            self.push_op(MemOp::Blob {
                key: key.clone(),
                bytes: bytes.clone(),
            });
        }
        Ok(())
    }

    fn read_blob(&mut self, key: &str) -> Result<Option<Vec<u8>>, SyncError> {
        Ok(self.view.blobs.get(key).cloned())
    }

    fn reset(&mut self, new_db_id: &str, now_ms: i64) -> Result<(), SyncError> {
        self.push_op(MemOp::Reset);
        for (k, v) in [
            ("db_id", new_db_id.to_string()),
            ("schema_version", SCHEMA_VERSION.to_string()),
            ("created_at", now_ms.to_string()),
        ] {
            self.push_op(MemOp::Meta { k: k.into(), v });
        }
        Ok(())
    }
}

/// 一時フォルダの上の、手元の記録（保存先・答えの接続・設定）。
pub struct TestPorts {
    pub data_dir: PathBuf,
    db: Mutex<StudyDb>,
    pub settings: Mutex<Settings>,
    pub settings_hint: Mutex<Option<i64>>,
    pub deleted: Mutex<Vec<String>>,
    /// 設定を替えた回数。
    pub settings_applied: Mutex<usize>,
}

impl TestPorts {
    pub fn new(data_dir: &Path) -> Arc<TestPorts> {
        let settings = Settings {
            data_dir: data_dir.to_path_buf(),
            ..Settings::default()
        };
        Arc::new(TestPorts {
            data_dir: data_dir.to_path_buf(),
            db: Mutex::new(StudyDb::open(data_dir).expect("答えのファイルを開ける")),
            settings: Mutex::new(settings.normalized()),
            settings_hint: Mutex::new(None),
            deleted: Mutex::new(Vec::new()),
            settings_applied: Mutex::new(0),
        })
    }

    pub fn study(&self) -> MutexGuard<'_, StudyDb> {
        self.db.lock().unwrap_or_else(PoisonError::into_inner)
    }
}

impl Ports for Arc<TestPorts> {
    fn data_dir(&self) -> PathBuf {
        self.data_dir.clone()
    }

    fn with_records_lock(&self, f: &mut dyn FnMut()) {
        f();
    }

    fn with_study(
        &self,
        f: &mut dyn FnMut(&mut StudyDb) -> Result<(), String>,
    ) -> Result<(), String> {
        f(&mut self.study())
    }

    fn settings(&self) -> Settings {
        self.settings
            .lock()
            .unwrap_or_else(PoisonError::into_inner)
            .clone()
    }

    fn settings_hint_ms(&self) -> Option<i64> {
        *self
            .settings_hint
            .lock()
            .unwrap_or_else(PoisonError::into_inner)
    }

    fn apply_settings(&self, settings: Settings) -> Result<(), String> {
        *self.settings.lock().unwrap_or_else(PoisonError::into_inner) = settings;
        *self
            .settings_applied
            .lock()
            .unwrap_or_else(PoisonError::into_inner) += 1;
        Ok(())
    }

    fn delete_session(&self, id: &str) -> Result<(), String> {
        let mut store = Store::open(&self.data_dir).map_err(|e| e.to_string())?;
        store
            .delete_sessions(&[id.to_string()])
            .map_err(|e| e.to_string())?;
        self.deleted
            .lock()
            .unwrap_or_else(PoisonError::into_inner)
            .push(id.to_string());
        Ok(())
    }
}

/// 試験の時計の原点（ミリ秒）。ファイルの更新時刻（本物の時計）より、いつも後になる遠い未来にして、
/// 試験の中の時刻（0 からの小さな数）と、ファイルの更新時刻が、前後しないようにする。
pub const CLOCK_BASE: i64 = 4_000_000_000_000;

/// 試験の端末 1 台。
pub struct Dev {
    pub name: &'static str,
    pub ports: Arc<TestPorts>,
    pub local: FsLocal<Arc<TestPorts>>,
    pub base: Base,
    pub remote: MemRemote,
    /// 一時フォルダを、端末が使っている間、消さずに持っておく。
    #[allow(dead_code)]
    pub tmp: tempfile::TempDir,
}

impl Dev {
    pub fn new(name: &'static str, server: &MemServer) -> Dev {
        let tmp = tempfile::tempdir().expect("一時フォルダ");
        let data = tmp.path().join("data");
        let ports = TestPorts::new(&data);
        Dev {
            name,
            local: FsLocal::new(Arc::clone(&ports)),
            ports,
            base: Base::default(),
            remote: MemRemote::new(server),
            tmp,
        }
    }

    pub fn data(&self) -> &Path {
        &self.ports.data_dir
    }

    pub fn store(&self) -> Store {
        Store::open(self.data()).expect("保存先を開ける")
    }

    pub fn trash_dir(&self) -> PathBuf {
        self.data().join(TRASH_DIR)
    }

    /// 同期を 1 回分行う（通信ありで）。
    pub fn cycle(&mut self, now_ms: i64) -> Result<CycleReport, SyncError> {
        self.run(now_ms, true, false)
    }

    /// 手元だけの突き合わせ（通信なし）。
    pub fn reconcile(&mut self, now_ms: i64) -> Result<CycleReport, SyncError> {
        self.run(now_ms, false, false)
    }

    pub fn run(
        &mut self,
        now_ms: i64,
        network: bool,
        allow_mass_delete: bool,
    ) -> Result<CycleReport, SyncError> {
        run_cycle(
            &mut self.remote,
            &mut self.local,
            &mut self.base,
            &CycleOptions {
                device: self.name,
                now_ms: CLOCK_BASE + now_ms,
                network,
                allow_mass_delete,
            },
        )
    }
}
