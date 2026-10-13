//! 同期（F15、D-4）の結合試験: 本物の同期の部品（turso クレートの同期）を、この PC の中の `tursodb --sync-server` に向けて動かす。
//! `pnpm test` には含めない手動の試験（`pnpm test:sync`。公式の tursodb を一時フォルダに取ってきて、環境変数 JANTAMA_TURSODB で渡す）。
//!
//! 一時フォルダだけを使う。本物のデータ・本物の資格情報・Turso Cloud には触れない。通信は 127.0.0.1 の中だけ。
//! 確かめること（偽物の同期用の DB では確かめられないもの）:
//! - 2 台の端末が、本物の同期の部品を通して、記録を往復できる（結果のファイルを含む）。
//! - 「消した印は直しに勝つ」「新しく直したほうが残る」が、本物の同期の部品の動き（変えた列だけの更新・あとに送ったものが勝つ）でも成り立つ。
//! - サーバーが止まっても、手元の突き合わせは進み、つながったら続きが届く。
//! - 返事をしないサーバーは、決めた時間で打ち切り、そのあとも手元の写しを読める。
//! - 同期用の DB の作り直しを、別の端末が気づく。

use std::collections::BTreeMap;
use std::fs;
use std::net::{TcpListener, TcpStream};
use std::path::{Path, PathBuf};
use std::process::{Child, Command, Stdio};
use std::sync::{Arc, Mutex, MutexGuard, PoisonError};
use std::time::{Duration, Instant};

use jantama_reviewer_lib::capture::{CaptureError, CaptureTarget, Screenshot};
use jantama_reviewer_lib::clock::now_ms;
use jantama_reviewer_lib::settings::Settings;
use jantama_reviewer_lib::store::{
    Links, MemoText, Memos, Rating, SelfRating, Store, MEMOS_FILE, REPORT_FILE,
};
use jantama_reviewer_lib::study::{AnswerMode, NewAnswer, StudyDb};
use jantama_reviewer_lib::sync::base::Base;
use jantama_reviewer_lib::sync::endpoint::SyncEndpoint;
use jantama_reviewer_lib::sync::engine::{run_cycle, CycleOptions, CycleReport};
use jantama_reviewer_lib::sync::error::SyncError;
use jantama_reviewer_lib::sync::local::{FsLocal, Ports};
use jantama_reviewer_lib::sync::remote::{Remote, Timeouts, TursoRemote};
use serde_json::json;

fn tursodb() -> PathBuf {
    let path = std::env::var_os("JANTAMA_TURSODB")
        .map(PathBuf::from)
        .expect("環境変数 JANTAMA_TURSODB（pnpm test:sync が渡す）が無い");
    assert!(path.is_file(), "{}", path.display());
    path
}

/// この PC の中の同期サーバー。
struct Server {
    child: Option<Child>,
    port: u16,
    db: PathBuf,
    _dir: tempfile::TempDir,
}

fn free_port() -> u16 {
    // 空いている番号を OS に決めてもらう（すぐ閉じて、その番号でサーバーを起動する）
    let listener = TcpListener::bind("127.0.0.1:0").unwrap();
    listener.local_addr().unwrap().port()
}

impl Server {
    fn start() -> Server {
        let dir = tempfile::tempdir().unwrap();
        let db = dir.path().join("server.db");
        let mut server = Server {
            child: None,
            port: free_port(),
            db,
            _dir: dir,
        };
        server.spawn();
        server
    }

    fn spawn(&mut self) {
        let child = Command::new(tursodb())
            .arg(&self.db)
            .arg("--sync-server")
            .arg(format!("127.0.0.1:{}", self.port))
            .stdin(Stdio::null())
            .stdout(Stdio::null())
            .stderr(Stdio::null())
            .spawn()
            .expect("tursodb を起動できる");
        self.child = Some(child);
        let deadline = Instant::now() + Duration::from_secs(30);
        while Instant::now() < deadline {
            if TcpStream::connect(("127.0.0.1", self.port)).is_ok() {
                return;
            }
            std::thread::sleep(Duration::from_millis(100));
        }
        panic!("同期サーバーが起動しない");
    }

    fn stop(&mut self) {
        if let Some(mut child) = self.child.take() {
            let _ = child.kill();
            let _ = child.wait();
        }
    }

    fn restart(&mut self) {
        self.stop();
        std::thread::sleep(Duration::from_millis(300));
        self.spawn();
    }

    fn endpoint(&self) -> SyncEndpoint {
        SyncEndpoint::parse(&format!("http://127.0.0.1:{}", self.port)).unwrap()
    }
}

impl Drop for Server {
    fn drop(&mut self) {
        self.stop();
    }
}

/// 一時フォルダの上の、手元の記録。
struct TestPorts {
    data_dir: PathBuf,
    db: Mutex<StudyDb>,
    settings: Mutex<Settings>,
}

impl TestPorts {
    fn new(data_dir: &Path) -> Arc<TestPorts> {
        let settings = Settings {
            data_dir: data_dir.to_path_buf(),
            ..Settings::default()
        };
        Arc::new(TestPorts {
            data_dir: data_dir.to_path_buf(),
            db: Mutex::new(StudyDb::open(data_dir).unwrap()),
            settings: Mutex::new(settings.normalized()),
        })
    }

    fn study(&self) -> MutexGuard<'_, StudyDb> {
        self.db.lock().unwrap_or_else(PoisonError::into_inner)
    }
}

struct PortsHandle(Arc<TestPorts>);

impl Ports for PortsHandle {
    fn data_dir(&self) -> PathBuf {
        self.0.data_dir.clone()
    }
    fn with_records_lock(&self, f: &mut dyn FnMut()) {
        f();
    }
    fn with_study(
        &self,
        f: &mut dyn FnMut(&mut StudyDb) -> Result<(), String>,
    ) -> Result<(), String> {
        f(&mut self.0.study())
    }
    fn settings(&self) -> Settings {
        self.0.settings.lock().unwrap().clone()
    }
    fn settings_hint_ms(&self) -> Option<i64> {
        None
    }
    fn apply_settings(&self, settings: Settings) -> Result<(), String> {
        *self.0.settings.lock().unwrap() = settings;
        Ok(())
    }
    fn delete_session(&self, id: &str) -> Result<(), String> {
        let mut store = Store::open(&self.0.data_dir).map_err(|e| e.to_string())?;
        store
            .delete_sessions(&[id.to_string()])
            .map_err(|e| e.to_string())
    }
}

/// 端末 1 台: 手元の記録・本物の同期用の DB の手元の写し・前回の記録。
struct Device {
    name: &'static str,
    ports: Arc<TestPorts>,
    local: FsLocal<PortsHandle>,
    remote: TursoRemote,
    base: Base,
    /// 一時フォルダを、端末が使っている間、消さずに持っておく。
    #[allow(dead_code)]
    dir: tempfile::TempDir,
}

/// 試験の時計。全部の端末が同じ時計を使う（呼ぶ順が、時刻の順になる）。呼ぶたびに 10 秒進む。
fn next_time() -> i64 {
    use std::sync::atomic::{AtomicI64, Ordering};
    static CLOCK: AtomicI64 = AtomicI64::new(0);
    let start = now_ms() + 3_600_000;
    let _ = CLOCK.compare_exchange(0, start, Ordering::SeqCst, Ordering::SeqCst);
    CLOCK.fetch_add(10_000, Ordering::SeqCst)
}

impl Device {
    fn new(name: &'static str, endpoint: &SyncEndpoint, timeouts: Timeouts) -> Device {
        let dir = tempfile::tempdir().unwrap();
        let ports = TestPorts::new(&dir.path().join("data"));
        let remote = TursoRemote::new(
            &dir.path().join("sync").join("sync.db"),
            endpoint,
            None,
            name,
            timeouts,
        )
        .unwrap();
        Device {
            name,
            local: FsLocal::new(PortsHandle(Arc::clone(&ports))),
            ports,
            remote,
            base: Base::default(),
            dir,
        }
    }

    fn data(&self) -> &Path {
        &self.ports.data_dir
    }

    fn store(&self) -> Store {
        Store::open(self.data()).unwrap()
    }

    /// 同期を 1 回分（時計は、呼ぶたびに 10 秒進む）。
    fn cycle(&mut self) -> Result<CycleReport, SyncError> {
        self.run(true)
    }

    fn reconcile(&mut self) -> Result<CycleReport, SyncError> {
        self.run(false)
    }

    fn run(&mut self, network: bool) -> Result<CycleReport, SyncError> {
        let now_ms = next_time();
        run_cycle(
            &mut self.remote,
            &mut self.local,
            &mut self.base,
            &CycleOptions {
                device: self.name,
                now_ms,
                network,
                allow_mass_delete: false,
            },
        )
    }
}

fn settle(a: &mut Device, b: &mut Device) {
    for _ in 0..4 {
        a.cycle().unwrap();
        b.cycle().unwrap();
    }
}

fn shot() -> Result<Screenshot, CaptureError> {
    Ok(Screenshot {
        png: vec![0x89, b'P', b'N', b'G', 1, 2, 3],
        target: CaptureTarget::Window,
    })
}

fn answer(session: &str, key: &str, at: i64) -> NewAnswer {
    NewAnswer {
        session_id: session.to_string(),
        decision_key: key.to_string(),
        mode: AnswerMode::Quiz,
        shown_at: at - 1000,
        answered_at: at,
        choice: json!({"type": "dahai", "tile": "5p"}),
        reason: "孤立を切る".to_string(),
        duration_ms: 1000,
        reselect_count: 0,
        correct: true,
        causes: vec!["ukeire".to_string()],
        principle: "受け入れを数える".to_string(),
        maka_move: Some("5pr".to_string()),
        interval_days: 3,
        due_date: "2026-10-15".to_string(),
    }
}

const REPORT: &str =
    "{\"review\":{\"kyokus\":[{\"note\":\"実機の試験\"}]},\"padding\":\"0123456789\"}";

/// 端末に、半荘 1 つ（迷いマーク・結果・結びつけ・メモ・自己評価）と、答え・今日の出題・設定を入れる。
fn populate(device: &Device) -> String {
    let mut store = device.store();
    store.add_mark(1_760_000_000_000, shot()).unwrap();
    store
        .add_rating(1_760_000_001_000, Rating::Good, shot())
        .unwrap();
    let session = store.current_session_id().unwrap().to_string();
    store.close_session(1_760_000_002_000).unwrap();
    store
        .save_report(Some(&session), REPORT, 1_760_000_000_000)
        .unwrap();
    let mut links = Links::default();
    links.marks.insert("1".into(), "k0h0e3".into());
    store.replace_links(&session, links).unwrap();
    store
        .set_self_rating(&session, "k0h0", SelfRating::Bad)
        .unwrap();
    store
        .set_memo(&session, 1, "3m・6p", "東を残したい")
        .unwrap();
    device
        .ports
        .study()
        .record_answer(answer(&session, "k0h0e3", 1_760_000_010_000))
        .unwrap();
    device.ports.settings.lock().unwrap().daily_count = 9;
    session
}

fn read_memos(device: &Device, session: &str) -> Memos {
    let path = device
        .store()
        .session_folder(session)
        .unwrap()
        .join(MEMOS_FILE);
    fs::read_to_string(path)
        .ok()
        .and_then(|text| serde_json::from_str(&text).ok())
        .unwrap_or_default()
}

fn write_memos(device: &Device, session: &str, memos: &Memos) {
    let path = device
        .store()
        .session_folder(session)
        .unwrap()
        .join(MEMOS_FILE);
    fs::write(path, serde_json::to_string_pretty(memos).unwrap()).unwrap();
}

fn memo(reason: &str) -> MemoText {
    MemoText {
        candidates: "3m".to_string(),
        reason: reason.to_string(),
    }
}

fn answers_by_uid(device: &Device) -> BTreeMap<String, NewAnswer> {
    StudyDb::open(device.data())
        .unwrap()
        .list_answers()
        .unwrap()
        .into_iter()
        .map(|row| (row.uid.unwrap(), row.answer))
        .collect()
}

fn timeouts() -> Timeouts {
    Timeouts {
        open: Duration::from_secs(30),
        pull: Duration::from_secs(20),
        push: Duration::from_secs(60),
    }
}

#[test]
#[ignore = "手動（pnpm test:sync）: 同期サーバー tursodb を起動する"]
fn real_two_devices_round_trip_records_and_the_report() {
    let server = Server::start();
    let mut a = Device::new("d-aaaa", &server.endpoint(), timeouts());
    let mut b = Device::new("d-bbbb", &server.endpoint(), timeouts());
    let session = populate(&a);
    let first = a.cycle().unwrap();
    assert!(first.pushed && first.network_error.is_none(), "{first:?}");
    let second = b.cycle().unwrap();
    assert!(second.pulled && second.local_puts > 5, "{second:?}");
    a.cycle().unwrap();

    // 記録が、別の端末の手元に届く
    assert_eq!(answers_by_uid(&a), answers_by_uid(&b));
    assert_eq!(answers_by_uid(&b).len(), 1);
    assert_eq!(read_memos(&b, &session).marks["1"].reason, "東を残したい");
    // 結果のファイルが、そのまま届く（圧縮して送り、展開して置く）
    let report = b
        .store()
        .session_folder(&session)
        .unwrap()
        .join(REPORT_FILE);
    assert_eq!(fs::read_to_string(report).unwrap(), REPORT);
    assert_eq!(b.ports.settings.lock().unwrap().daily_count, 9);
    // 同期しないものは、届かない
    let folder = b.store().session_folder(&session).unwrap();
    assert!(!folder.join("events.jsonl").exists());
    assert!(!folder.join("marks").exists());
    // 何も変えなければ、何も動かない
    let quiet = b.cycle().unwrap();
    assert_eq!(quiet.local_puts + quiet.local_deletes, 0, "{quiet:?}");
    assert_eq!(quiet.remote_puts + quiet.remote_tombstones, 0, "{quiet:?}");
}

#[test]
#[ignore = "手動（pnpm test:sync）: 同期サーバー tursodb を起動する"]
fn real_deleting_beats_editing_and_the_newer_edit_wins_with_the_real_sync_engine() {
    let server = Server::start();
    let mut a = Device::new("d-aaaa", &server.endpoint(), timeouts());
    let mut b = Device::new("d-bbbb", &server.endpoint(), timeouts());
    let session = populate(&a);
    a.cycle().unwrap();
    b.cycle().unwrap();
    a.cycle().unwrap();

    // 消す対直す: A がメモを消し、B が同じメモを直す。同期の前に、手元の写しに書く。どちらが先に送っても、消えたまま
    for a_first in [true, false] {
        let mut ma = read_memos(&a, &session);
        ma.marks.insert("1".into(), memo("もとのメモ"));
        write_memos(&a, &session, &ma);
        settle(&mut a, &mut b);
        let mut ma = read_memos(&a, &session);
        ma.marks.remove("1");
        write_memos(&a, &session, &ma);
        a.reconcile().unwrap();
        let mut mb = read_memos(&b, &session);
        mb.marks.insert("1".into(), memo("B が直した"));
        write_memos(&b, &session, &mb);
        b.reconcile().unwrap();
        if a_first {
            a.cycle().unwrap();
            b.cycle().unwrap();
        } else {
            b.cycle().unwrap();
            a.cycle().unwrap();
        }
        settle(&mut a, &mut b);
        for device in [&a, &b] {
            assert!(
                !read_memos(device, &session).marks.contains_key("1"),
                "a_first={a_first}: {}",
                device.name
            );
        }
    }

    // 同じ行を両方が直す: 新しい（手元の写しに書いた時刻が遅い）ほうが残る
    let mut ma = read_memos(&a, &session);
    ma.marks.insert("1".into(), memo("A の直し"));
    write_memos(&a, &session, &ma);
    a.reconcile().unwrap();
    let mut mb = read_memos(&b, &session);
    mb.marks.insert("1".into(), memo("B の直し（あと）"));
    write_memos(&b, &session, &mb);
    b.reconcile().unwrap();
    a.cycle().unwrap();
    b.cycle().unwrap();
    settle(&mut a, &mut b);
    for device in [&a, &b] {
        assert_eq!(
            read_memos(device, &session).marks["1"].reason,
            "B の直し（あと）",
            "{}",
            device.name
        );
    }

    // 別々の項目の直しは、両方が残る
    let mut ma = read_memos(&a, &session);
    ma.marks.insert("2".into(), memo("A が足した"));
    write_memos(&a, &session, &ma);
    a.reconcile().unwrap();
    let mut mb = read_memos(&b, &session);
    mb.marks.insert("3".into(), memo("B が足した"));
    write_memos(&b, &session, &mb);
    b.reconcile().unwrap();
    settle(&mut a, &mut b);
    for device in [&a, &b] {
        let memos = read_memos(device, &session);
        assert_eq!(memos.marks["2"].reason, "A が足した", "{}", device.name);
        assert_eq!(memos.marks["3"].reason, "B が足した", "{}", device.name);
    }

    // 答えを両方が足す: 手元の番号は同じでも、両方が残る
    let (ra, rb) = {
        let mut da = a.ports.study();
        let mut db = b.ports.study();
        (
            da.record_answer(answer(&session, "k1h0e1", 1_760_000_020_000))
                .unwrap(),
            db.record_answer(answer(&session, "k2h0e1", 1_760_000_030_000))
                .unwrap(),
        )
    };
    assert_eq!(ra.id, rb.id);
    settle(&mut a, &mut b);
    assert_eq!(answers_by_uid(&a).len(), 3);
    assert_eq!(answers_by_uid(&a), answers_by_uid(&b));
}

#[test]
#[ignore = "手動（pnpm test:sync）: 同期サーバー tursodb を起動する"]
fn real_an_older_edit_pushed_last_is_repaired_by_the_newer_device() {
    let server = Server::start();
    let mut a = Device::new("d-aaaa", &server.endpoint(), timeouts());
    let mut b = Device::new("d-bbbb", &server.endpoint(), timeouts());
    let session = populate(&a);
    a.cycle().unwrap();
    b.cycle().unwrap();
    a.cycle().unwrap();
    // A は、先に（古い時刻で）直して、まだ送らない。B は、あとから直して、先に送る
    let mut ma = read_memos(&a, &session);
    ma.marks.insert("1".into(), memo("A の古い直し"));
    write_memos(&a, &session, &ma);
    a.reconcile().unwrap();
    let mut mb = read_memos(&b, &session);
    mb.marks.insert("1".into(), memo("B の新しい直し"));
    write_memos(&b, &session, &mb);
    b.cycle().unwrap();
    // A が送る（古い直しが、いったんサーバーの行を上書きしうる）
    a.cycle().unwrap();
    settle(&mut a, &mut b);
    for device in [&a, &b] {
        assert_eq!(
            read_memos(device, &session).marks["1"].reason,
            "B の新しい直し",
            "{}",
            device.name
        );
    }
}

#[test]
#[ignore = "手動（pnpm test:sync）: 同期サーバー tursodb を起動する"]
fn real_a_stopped_server_does_not_stop_local_work_and_the_catch_up_arrives_later() {
    let mut server = Server::start();
    let mut a = Device::new("d-aaaa", &server.endpoint(), timeouts());
    let mut b = Device::new("d-bbbb", &server.endpoint(), timeouts());
    let session = populate(&a);
    a.cycle().unwrap();
    b.cycle().unwrap();

    server.stop();
    let mut ma = read_memos(&a, &session);
    ma.marks
        .insert("1".into(), memo("サーバーが止まっている間の直し"));
    write_memos(&a, &session, &ma);
    a.device_answer("k7h0e1");
    let started = Instant::now();
    let report = a.cycle().unwrap();
    assert!(
        report
            .network_error
            .as_ref()
            .is_some_and(SyncError::is_offline),
        "{report:?}"
    );
    assert!(
        started.elapsed() < Duration::from_secs(25),
        "{:?}",
        started.elapsed()
    );
    assert!(!report.pushed);
    // 手元の記録は、使える
    assert_eq!(
        read_memos(&a, &session).marks["1"].reason,
        "サーバーが止まっている間の直し"
    );
    assert_eq!(answers_by_uid(&a).len(), 2);

    server.restart();
    let report = a.cycle().unwrap();
    assert!(
        report.pushed && report.network_error.is_none(),
        "{report:?}"
    );
    b.cycle().unwrap();
    assert_eq!(
        read_memos(&b, &session).marks["1"].reason,
        "サーバーが止まっている間の直し"
    );
    assert_eq!(answers_by_uid(&b).len(), 2);
}

impl Device {
    fn device_answer(&self, key: &str) {
        let session = self
            .store()
            .list_sessions()
            .unwrap()
            .first()
            .map(|s| s.id.clone())
            .unwrap();
        self.ports
            .study()
            .record_answer(answer(&session, key, 1_760_000_040_000))
            .unwrap();
    }
}

#[test]
#[ignore = "手動（pnpm test:sync）: 同期サーバー tursodb を起動する"]
fn real_a_server_that_never_answers_is_given_up_on_at_the_time_limit_and_the_local_copy_stays_readable(
) {
    let server = Server::start();
    let mut a = Device::new("d-aaaa", &server.endpoint(), timeouts());
    populate(&a);
    a.cycle().unwrap();
    let rows_before = a.remote.read_rows().unwrap().len();
    assert!(rows_before > 5);
    let path = a.remote.path().to_path_buf();
    a.remote.close();

    // 返事をしないサーバー（つなぐところまでは受け付けるが、何も返さない）
    let listener = TcpListener::bind("127.0.0.1:0").unwrap();
    let port = listener.local_addr().unwrap().port();
    let held: Arc<Mutex<Vec<TcpStream>>> = Arc::new(Mutex::new(Vec::new()));
    {
        let held = Arc::clone(&held);
        std::thread::spawn(move || {
            for stream in listener.incoming().flatten() {
                held.lock().unwrap().push(stream);
            }
        });
    }
    let endpoint = SyncEndpoint::parse(&format!("http://127.0.0.1:{port}")).unwrap();
    let short = Timeouts {
        open: Duration::from_secs(2),
        pull: Duration::from_secs(2),
        push: Duration::from_secs(2),
    };
    let mut hanging = TursoRemote::new(&path, &endpoint, None, "hang", short).unwrap();
    // 手元の写しは、返事をしないサーバーが相手でも、開いて、読める
    let started = Instant::now();
    let rows = hanging.read_rows().unwrap();
    assert_eq!(rows.len(), rows_before);
    // 取り込みと送信は、決めた時間（2 秒）で打ち切る
    let started_pull = Instant::now();
    let error = hanging.pull().unwrap_err();
    assert!(error.is_offline(), "{error:?}");
    let pull_took = started_pull.elapsed();
    assert!(
        pull_took >= Duration::from_secs(1) && pull_took < Duration::from_secs(8),
        "{pull_took:?}"
    );
    let started_push = Instant::now();
    // 打ち切ったあとも、手元の写しは、読み書きできる
    let rows_again = hanging.read_rows().unwrap();
    assert_eq!(rows_again.len(), rows_before);
    hanging
        .write_rows(
            &[jantama_reviewer_lib::sync::merge::RemoteWrite::Put {
                key: "s:daily_count".to_string(),
                value: "11".to_string(),
                updated_at: now_ms(),
                device: "hang".to_string(),
                revive: false,
            }],
            &BTreeMap::new(),
        )
        .unwrap();
    let error = hanging.push().unwrap_err();
    assert!(error.is_offline(), "{error:?}");
    let push_took = started_push.elapsed();
    assert!(push_took < Duration::from_secs(10), "{push_took:?}");
    assert!(started.elapsed() < Duration::from_secs(20));
}

#[test]
#[ignore = "手動（pnpm test:sync）: 同期サーバー tursodb を起動する"]
fn real_a_rebuilt_sync_db_is_noticed_by_the_other_device_and_nothing_is_lost() {
    let server = Server::start();
    let mut a = Device::new("d-aaaa", &server.endpoint(), timeouts());
    let mut b = Device::new("d-bbbb", &server.endpoint(), timeouts());
    let session = populate(&a);
    a.cycle().unwrap();
    b.cycle().unwrap();
    a.cycle().unwrap();
    let before = answers_by_uid(&a);

    // A が、同期用の DB を作り直す（先に取り込んで、全部消して、新しい名前を付けて、手元の記録から入れ直す）
    a.remote.pull().unwrap();
    a.remote.reset("db-rebuilt-1", now_ms()).unwrap();
    a.base.forget_rows();
    a.base.db_id = None;
    a.cycle().unwrap();
    let report = b.cycle().unwrap();
    assert!(report.base_reset, "{report:?}");
    settle(&mut a, &mut b);
    assert_eq!(answers_by_uid(&a), before);
    assert_eq!(answers_by_uid(&b), before);
    assert_eq!(read_memos(&b, &session).marks["1"].reason, "東を残したい");
}

#[test]
#[ignore = "手動（pnpm test:sync）: 同期サーバー tursodb を起動する"]
fn real_the_first_open_of_an_unreachable_address_fails_at_the_time_limit() {
    // 一度も開いたことのない手元の写しは、通信して全体を取り込む。返事をしない相手でも、決めた時間で諦める
    let listener = TcpListener::bind("127.0.0.1:0").unwrap();
    let port = listener.local_addr().unwrap().port();
    let held: Arc<Mutex<Vec<TcpStream>>> = Arc::new(Mutex::new(Vec::new()));
    {
        let held = Arc::clone(&held);
        std::thread::spawn(move || {
            for stream in listener.incoming().flatten() {
                held.lock().unwrap().push(stream);
            }
        });
    }
    let endpoint = SyncEndpoint::parse(&format!("http://127.0.0.1:{port}")).unwrap();
    let dir = tempfile::tempdir().unwrap();
    let mut remote = TursoRemote::new(
        &dir.path().join("sync.db"),
        &endpoint,
        None,
        "hang",
        Timeouts {
            open: Duration::from_secs(2),
            pull: Duration::from_secs(2),
            push: Duration::from_secs(2),
        },
    )
    .unwrap();
    let started = Instant::now();
    let error = remote.ensure_schema(now_ms()).unwrap_err();
    assert!(error.is_offline(), "{error:?}");
    assert!(
        started.elapsed() < Duration::from_secs(10),
        "{:?}",
        started.elapsed()
    );
}
