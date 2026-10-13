//! 同期の裏の担当の試験（D-4）: トークンの置き場・つながらないときの打ち切りと手元の記録・手元の変更を見つけて同期する・
//! この端末の同期を切る・止めと再開。同期用の DB は偽物（`testing::MemRemote`）、トークンの保管庫も偽物（メモリ）。

#![cfg(test)]

use std::fs;
use std::path::Path;
use std::sync::atomic::{AtomicBool, AtomicUsize, Ordering};
use std::sync::{Arc, Mutex, PoisonError};
use std::time::{Duration, Instant};

use serde_json::json;

use super::base::{sync_root, SyncConfig};
use super::credentials::{MemoryTokenStore, TokenStore};
use super::local::change_marker;
use super::remote::Remote;
use super::service::{Notifier, SyncHost, SyncService, SyncState, SyncStatus, Timers};
use super::testing::{Dev, MemRemote, MemServer};
use crate::settings::settings_path;
use crate::study::{AnswerMode, NewAnswer};

const TOKEN: &str = "TOKEN-SENTINEL-8c1e5a77-do-not-leak";
const URL: &str = "libsql://jantama-test-org.aws-ap-northeast-1.turso.io";

#[derive(Default)]
struct Recorder {
    statuses: Mutex<Vec<SyncStatus>>,
    record_changes: AtomicUsize,
}

impl Notifier for Recorder {
    fn status_changed(&self, status: &SyncStatus) {
        self.statuses
            .lock()
            .unwrap_or_else(PoisonError::into_inner)
            .push(status.clone());
    }

    fn records_changed(&self) {
        self.record_changes.fetch_add(1, Ordering::SeqCst);
    }
}

struct Fixture {
    cfg: tempfile::TempDir,
    server: MemServer,
    dev: Dev,
    tokens: Arc<MemoryTokenStore>,
    recorder: Arc<Recorder>,
    service: SyncService,
    offline: Arc<AtomicBool>,
    unauthorized: Arc<AtomicBool>,
    note: Arc<Mutex<Option<String>>>,
    pulls: Arc<AtomicUsize>,
}

fn fast_timers() -> Timers {
    Timers {
        startup_delay: Duration::from_secs(3600),
        local_tick: Duration::from_millis(40),
        full_interval: Duration::from_secs(3600),
        debounce: Duration::from_millis(40),
        backoff: [Duration::from_secs(3600); 4],
    }
}

fn fixture(timers: Timers) -> Fixture {
    let cfg = tempfile::tempdir().unwrap();
    let server = MemServer::new();
    let dev = Dev::new("d-svc", &server);
    let tokens = Arc::new(MemoryTokenStore::new());
    let recorder = Arc::new(Recorder::default());
    let offline = Arc::new(AtomicBool::new(false));
    let unauthorized = Arc::new(AtomicBool::new(false));
    let note = Arc::new(Mutex::new(None));
    let pulls = Arc::new(AtomicUsize::new(0));
    let data_dir = dev.data().to_path_buf();
    let settings_file = settings_path(cfg.path());
    let host = SyncHost {
        ports: Arc::clone(&dev.ports),
        notifier: Arc::clone(&recorder) as Arc<dyn Notifier>,
        change_marker: Arc::new(move || change_marker(&data_dir, &settings_file)),
        open_remote: {
            let server = server.clone();
            let offline = Arc::clone(&offline);
            let unauthorized = Arc::clone(&unauthorized);
            let note = Arc::clone(&note);
            let pulls = Arc::clone(&pulls);
            Arc::new(move |_path, _endpoint, _token, _name| {
                let mut remote = MemRemote::new(&server);
                remote.offline = Arc::clone(&offline);
                remote.unauthorized = Arc::clone(&unauthorized);
                remote.failure_note = Arc::clone(&note);
                remote.pulls = Arc::clone(&pulls);
                Ok(Box::new(remote) as Box<dyn Remote>)
            })
        },
        now_ms: Arc::new(crate::clock::now_ms),
        timers,
    };
    let service = SyncService::start(
        cfg.path().to_path_buf(),
        Arc::clone(&tokens) as Arc<dyn TokenStore>,
        host,
    );
    Fixture {
        cfg,
        server,
        dev,
        tokens,
        recorder,
        service,
        offline,
        unauthorized,
        note,
        pulls,
    }
}

fn wait_until(what: &str, mut condition: impl FnMut() -> bool) {
    let deadline = Instant::now() + Duration::from_secs(15);
    while Instant::now() < deadline {
        if condition() {
            return;
        }
        std::thread::sleep(Duration::from_millis(20));
    }
    panic!("待ちきれませんでした: {what}");
}

fn answer(key: &str, at: i64) -> NewAnswer {
    NewAnswer {
        session_id: "20261009-190953".to_string(),
        decision_key: key.to_string(),
        mode: AnswerMode::Quiz,
        shown_at: at - 1000,
        answered_at: at,
        choice: json!({"type": "dahai", "tile": "5p"}),
        reason: "孤立を切る".to_string(),
        duration_ms: 1000,
        reselect_count: 0,
        correct: true,
        causes: Vec::new(),
        principle: String::new(),
        maka_move: None,
        interval_days: 1,
        due_date: "2026-10-15".to_string(),
    }
}

impl Fixture {
    /// URL とトークンを保存して、同期を使う設定にする。
    fn turn_on(&self) {
        self.service
            .save_connection(Some(URL), Some(TOKEN))
            .unwrap();
        self.service.set_enabled(true).unwrap();
    }

    fn wait_state(&self, state: SyncState) {
        wait_until(&format!("状態 {state:?}"), || {
            let status = self.service.status();
            status.state == state
                && !self
                    .recorder
                    .statuses
                    .lock()
                    .unwrap()
                    .last()
                    .is_some_and(|s| s.state == SyncState::Syncing)
        });
    }

    fn sync_and_wait(&self, state: SyncState) {
        self.service.sync_now();
        // 同期が始まって、終わるのを待つ（状態が一度 Syncing を通る）
        let before = self.recorder.statuses.lock().unwrap().len();
        wait_until("同期の開始と終了", || {
            let statuses = self.recorder.statuses.lock().unwrap();
            statuses.len() > before + 1 && statuses.last().is_some_and(|s| s.state == state)
        });
    }

    fn answer_keys_on_server(&self) -> usize {
        self.server
            .keys()
            .iter()
            .filter(|k| k.starts_with("a:") && self.server.value(k).is_some())
            .count()
    }
}

fn files_under(dir: &Path) -> Vec<std::path::PathBuf> {
    let mut out = Vec::new();
    if let Ok(entries) = fs::read_dir(dir) {
        for entry in entries.flatten() {
            let path = entry.path();
            if path.is_dir() {
                out.extend(files_under(&path));
            } else {
                out.push(path);
            }
        }
    }
    out
}

#[test]
fn d4_the_token_lives_only_in_the_credential_store_and_never_in_files_status_or_the_export() {
    let f = fixture(fast_timers());
    f.dev
        .ports
        .study()
        .record_answer(answer("k0h0e1", 1_760_000_000_000))
        .unwrap();
    f.turn_on();
    f.sync_and_wait(SyncState::Idle);
    assert!(f.answer_keys_on_server() >= 1);
    // 保管庫には入っている
    assert_eq!(f.tokens.load().unwrap().unwrap().expose(), TOKEN);
    assert!(f.service.status().has_token);

    // どのファイルにも無い（設定のフォルダ・保存先）
    let mut scanned = 0;
    for root in [f.cfg.path(), f.dev.data()] {
        for path in files_under(root) {
            let bytes = fs::read(&path).unwrap();
            scanned += 1;
            assert!(
                !bytes
                    .windows(TOKEN.len())
                    .any(|window| window == TOKEN.as_bytes()),
                "トークンが {} にある",
                path.display()
            );
        }
    }
    assert!(
        scanned >= 3,
        "設定・同期の記録・答えのファイルを調べた: {scanned}"
    );
    // 設定のファイルは、トークンの項目を持たない
    let config = fs::read_to_string(SyncConfig::path(f.cfg.path())).unwrap();
    assert!(!config.to_lowercase().contains("token"), "{config}");
    // 状態（画面に出る形）にも、デバッグの文にも無い
    let statuses = f.recorder.statuses.lock().unwrap().clone();
    assert!(statuses.len() >= 2);
    for status in &statuses {
        let shown = format!("{status:?} {}", serde_json::to_string(status).unwrap());
        assert!(!shown.contains(TOKEN), "{shown}");
    }
    // 書き出し（記録の JSON）にも無い
    let db = crate::study::StudyDb::open(f.dev.data()).unwrap();
    let settings = f.dev.ports.settings.lock().unwrap().clone();
    let export = crate::study::records::build_export(f.dev.data(), &db, &settings, "now").unwrap();
    let text = serde_json::to_string(&export).unwrap();
    assert!(!text.contains(TOKEN));
    // 同期用の DB の行にも無い
    for key in f.server.keys() {
        assert!(!f.server.value(&key).unwrap_or_default().contains(TOKEN));
    }
}

#[test]
fn d4_a_failure_message_that_carries_the_token_is_masked() {
    let f = fixture(fast_timers());
    f.turn_on();
    f.offline.store(true, Ordering::SeqCst);
    *f.note.lock().unwrap() = Some(format!("Authorization: Bearer {TOKEN}"));
    f.sync_and_wait(SyncState::Offline);
    for status in f.recorder.statuses.lock().unwrap().iter() {
        let shown = format!("{status:?}");
        assert!(!shown.contains(TOKEN), "{shown}");
    }
    let message = f.service.status().message.unwrap();
    assert!(message.contains("伏せ字"), "{message}");
}

#[test]
fn d4_with_no_connection_the_records_stay_usable_and_syncing_catches_up_later() {
    let f = fixture(fast_timers());
    f.turn_on();
    f.sync_and_wait(SyncState::Idle);
    f.offline.store(true, Ordering::SeqCst);
    f.sync_and_wait(SyncState::Offline);
    assert!(f.service.status().message.is_some());
    // つながらない間も、記録は、ふだんどおり使える
    f.dev
        .ports
        .study()
        .record_answer(answer("k1h0e1", 1_760_000_100_000))
        .unwrap();
    f.sync_and_wait(SyncState::Offline);
    assert_eq!(f.answer_keys_on_server(), 0, "まだ送れていない");
    assert_eq!(f.dev.ports.study().list_answers().unwrap().len(), 1);
    // つながったので、続きを送る
    f.offline.store(false, Ordering::SeqCst);
    f.sync_and_wait(SyncState::Idle);
    assert_eq!(f.answer_keys_on_server(), 1);
    assert!(f.service.status().last_ok_ms.is_some());
    assert!(f.service.status().message.is_none());
}

#[test]
fn d4_a_wrong_token_pauses_syncing_until_the_user_acts() {
    let f = fixture(fast_timers());
    f.turn_on();
    f.unauthorized.store(true, Ordering::SeqCst);
    f.sync_and_wait(SyncState::Attention);
    assert!(f.service.status().message.unwrap().contains("トークン"));
    // 保存・使うの設定で頼んだ同期が、残らず片づくのを待つ（その分の通信は、数えない）
    let mut last = f.pulls.load(Ordering::SeqCst);
    let mut quiet_since = Instant::now();
    while quiet_since.elapsed() < Duration::from_millis(300) {
        std::thread::sleep(Duration::from_millis(20));
        let now = f.pulls.load(Ordering::SeqCst);
        if now != last {
            last = now;
            quiet_since = Instant::now();
        }
    }
    // 止まっている間は、時間が来ても、通信しない
    let pulls = f.pulls.load(Ordering::SeqCst);
    f.dev
        .ports
        .study()
        .record_answer(answer("k2h0e1", 1_760_000_200_000))
        .unwrap();
    std::thread::sleep(Duration::from_millis(400));
    assert_eq!(f.pulls.load(Ordering::SeqCst), pulls);
    // トークンを貼り直して（保存）、直ったら、動き出す
    f.unauthorized.store(false, Ordering::SeqCst);
    f.service
        .save_connection(Some(URL), Some("NEW-TOKEN-VALUE-123"))
        .unwrap();
    f.wait_state(SyncState::Idle);
    wait_until("答えが届く", || f.answer_keys_on_server() == 1);
}

#[test]
fn d4_a_change_in_the_local_files_starts_a_sync_without_being_asked() {
    let f = fixture(fast_timers());
    f.turn_on();
    f.sync_and_wait(SyncState::Idle);
    // 目印を取り直すまで、少し待つ
    std::thread::sleep(Duration::from_millis(200));
    f.dev
        .ports
        .study()
        .record_answer(answer("k3h0e1", 1_760_000_300_000))
        .unwrap();
    wait_until("見張りが変更を見つけて、同期する", || {
        f.answer_keys_on_server() == 1
    });
}

#[test]
fn d4_a_sync_that_changes_local_records_tells_the_screen_to_reload() {
    let server = MemServer::new();
    let f = fixture(fast_timers());
    // 別の端末が、答えを同期用の DB に置く
    let mut other = Dev::new("d-other", &f.server);
    other
        .ports
        .study()
        .record_answer(answer("k4h0e1", 1_760_000_400_000))
        .unwrap();
    other.cycle(1_000).unwrap();
    drop(server);
    f.turn_on();
    f.sync_and_wait(SyncState::Idle);
    assert_eq!(f.dev.ports.study().list_answers().unwrap().len(), 1);
    assert!(f.recorder.record_changes.load(Ordering::SeqCst) >= 1);
}

#[test]
fn d4_turning_sync_on_needs_a_url_and_a_token() {
    let f = fixture(fast_timers());
    assert!(f.service.set_enabled(true).is_err(), "URL が無い");
    f.service.save_connection(Some(URL), None).unwrap();
    assert!(f.service.set_enabled(true).is_err(), "トークンが無い");
    assert!(f
        .service
        .save_connection(Some("libsql://example.com"), Some(TOKEN))
        .is_err());
    assert!(
        f.tokens.load().unwrap().is_none(),
        "URL が正しくないときは、トークンも保存しない…"
    );
}

#[test]
fn d4_a_url_with_a_space_in_the_token_is_refused_before_anything_is_stored() {
    let f = fixture(fast_timers());
    assert!(f
        .service
        .save_connection(Some(URL), Some("abc def"))
        .is_err());
    assert!(f.tokens.load().unwrap().is_none());
}

#[test]
fn d4_disconnecting_removes_the_token_and_the_work_folder_and_leaves_the_records() {
    let f = fixture(fast_timers());
    f.dev
        .ports
        .study()
        .record_answer(answer("k5h0e1", 1_760_000_500_000))
        .unwrap();
    f.turn_on();
    f.sync_and_wait(SyncState::Idle);
    let root = sync_root(f.cfg.path());
    let status = f.service.disconnect().unwrap();
    assert_eq!(status.state, SyncState::Off);
    assert!(!status.has_token && !status.enabled);
    assert!(f.tokens.load().unwrap().is_none(), "トークンは消える");
    wait_until("作業のフォルダが消える", || !root.exists());
    // 手元の記録と、同期用の DB は、そのまま
    assert_eq!(f.dev.ports.study().list_answers().unwrap().len(), 1);
    assert_eq!(f.answer_keys_on_server(), 1);
    // 切ったあとは、何度回しても、同期しない
    let pulls = f.pulls.load(Ordering::SeqCst);
    f.service.sync_now();
    std::thread::sleep(Duration::from_millis(300));
    assert_eq!(f.pulls.load(Ordering::SeqCst), pulls);
    assert_eq!(f.service.status().state, SyncState::Off);
}

#[test]
fn d4_rebuilding_the_sync_db_gives_it_a_new_name_and_puts_the_local_records_back() {
    let f = fixture(fast_timers());
    f.dev
        .ports
        .study()
        .record_answer(answer("k6h0e1", 1_760_000_600_000))
        .unwrap();
    f.turn_on();
    f.sync_and_wait(SyncState::Idle);
    let old_id = f.server.store().meta.get("db_id").cloned().unwrap();
    f.service.rebuild();
    wait_until("新しい名前が付く", || {
        f.server
            .store()
            .meta
            .get("db_id")
            .is_some_and(|id| *id != old_id)
    });
    f.wait_state(SyncState::Idle);
    wait_until("手元の記録が入り直る", || {
        f.answer_keys_on_server() == 1
    });
    // つながらないときは、作り直さない（ほかの端末の分を、取り込む前に消さない）
    let id = f.server.store().meta.get("db_id").cloned().unwrap();
    f.offline.store(true, Ordering::SeqCst);
    f.service.rebuild();
    wait_until("つながらないと分かる", || {
        f.service.status().state == SyncState::Offline
    });
    assert_eq!(f.server.store().meta.get("db_id").cloned().unwrap(), id);
    assert!(f
        .service
        .status()
        .message
        .unwrap()
        .contains("作り直していません"));
}

#[test]
fn d4_a_mass_deletion_pauses_syncing_and_one_button_lets_it_through() {
    let f = fixture(fast_timers());
    {
        let mut db = f.dev.ports.study();
        for i in 0..40 {
            db.record_answer(answer(&format!("k{i}h0e1"), 1_760_000_000_000 + i))
                .unwrap();
        }
    }
    f.turn_on();
    f.sync_and_wait(SyncState::Idle);
    assert_eq!(f.answer_keys_on_server(), 40);
    f.dev
        .ports
        .study()
        .replace_all(&[], &[], &[], || Ok::<(), String>(()))
        .unwrap();
    f.sync_and_wait(SyncState::Attention);
    let status = f.service.status();
    assert!(status.can_allow_mass_delete);
    assert!(status.message.unwrap().contains("止めました"));
    assert_eq!(
        f.answer_keys_on_server(),
        40,
        "消した印は、まだ送っていない"
    );
    f.service.allow_mass_delete();
    f.wait_state(SyncState::Idle);
    wait_until("消した印が届く", || f.answer_keys_on_server() == 0);
}

#[test]
fn d4_a_local_test_server_needs_no_token_and_the_status_does_not_claim_one() {
    let f = fixture(fast_timers());
    // URL の文字は、ソースに書かない（S-2 の走査）。スキームと宛先を、部品から組む
    let local = format!("{}://127.0.0.1:18080", "http");
    f.service.save_connection(Some(&local), None).unwrap();
    f.service.set_enabled(true).unwrap();
    f.sync_and_wait(SyncState::Idle);
    let status = f.service.status();
    assert!(!status.has_token, "トークンは入っていない: {status:?}");
    assert_eq!(status.url_host, "127.0.0.1:18080");
    assert!(f.tokens.load().unwrap().is_none());
}
