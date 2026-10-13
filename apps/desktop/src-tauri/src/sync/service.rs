//! 同期の裏の担当（F15）。専用のスレッドが 1 つ、同期を受け持つ。画面や記録の保存を、待たせない。
//!
//! いつ同期するか:
//! - 起動して少しあと（3 秒）、そのあとは 5 分ごと（ほかの端末の変更を取り込むため）。
//! - 手元の記録が変わったとき: 10 秒ごとに、手元のファイルの目印（`local::change_marker`。内容は読まない）を見て、変わっていて、3 秒落ち着いたら。
//! - 設定の「今すぐ同期」・設定を保存したとき。
//!
//! つながらないとき: 手元の突き合わせは、通信と別に済ませる（編集に近い時刻を、手元の写しに残すため）。通信は打ち切り（`remote::Timeouts`）、
//! 状態は「つながりません」にして、30 秒・1 分・2 分・5 分の間隔で、つなぎ直す（手動の「今すぐ同期」は、待たずに試す）。
//! トークンが通らない・大量の消去を止めた・新しい版の同期用の DB のときは、状態を「要確認」にして、利用者の操作まで止める。
//!
//! トークンは、OS の資格情報の保管庫にだけ置く（`credentials`）。状態・ログ・設定のファイルには入れない。

use std::path::{Path, PathBuf};
use std::sync::mpsc::{channel, Receiver, RecvTimeoutError, Sender};
use std::sync::{Arc, Mutex, PoisonError};
use std::thread;
use std::time::{Duration, Instant};

use serde::Serialize;

use super::base::{profile_dir, sync_root, Base, SyncConfig, SYNC_DB_FILE};
use super::credentials::{redact, Secret, TokenStore};
use super::endpoint::SyncEndpoint;
use super::engine::{run_cycle, CycleOptions, CycleReport};
use super::error::SyncError;
use super::local::{FsLocal, Ports};
use super::remote::Remote;
use crate::ids::{new_uid, sha256_hex};

/// 画面に状態の変化を知らせるイベントの名前。
pub const EVENT_SYNC_STATUS: &str = "sync-status";

/// 注意として出す文の数の上限（画面に出しきれないほど出さない）。
const MAX_WARNINGS: usize = 3;

/// 同期の状態。
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize)]
#[serde(rename_all = "snake_case")]
pub enum SyncState {
    /// 使っていない。
    Off,
    /// 待っている（最後の同期は成功）。
    Idle,
    /// 同期している。
    Syncing,
    /// つながらない（つながったときに続きを同期する）。
    Offline,
    /// 利用者の操作が要る（トークンが通らない・大量の消去を止めた・新しい版の同期用の DB）。
    Attention,
    /// 失敗した（手元の記録は、そのまま使える）。
    Error,
}

/// 画面に出す、同期の状態。
#[derive(Debug, Clone, PartialEq, Serialize)]
pub struct SyncStatus {
    pub enabled: bool,
    /// 同期先のホスト名（トークンも URL の細部も含まない。未設定なら空）。
    pub url_host: String,
    /// トークンが、この PC の資格情報の保管庫に入っているか。
    pub has_token: bool,
    pub state: SyncState,
    /// 最後に同期が成功した時刻（ミリ秒）。
    pub last_ok_ms: Option<i64>,
    /// 状態の説明（失敗・つながらない・要確認のとき）。
    pub message: Option<String>,
    /// 注意（入れられなかった記録など）。
    pub warnings: Vec<String>,
    /// 大量の消去を止めているとき、「そのまま同期する」を出す。
    pub can_allow_mass_delete: bool,
    /// この端末の名前（読み物として出す）。
    pub device_id: String,
}

impl SyncStatus {
    fn initial(config: &SyncConfig, has_token: bool, last_ok_ms: Option<i64>) -> SyncStatus {
        SyncStatus {
            enabled: config.enabled,
            url_host: host_of(&config.url),
            has_token,
            state: if config.enabled {
                SyncState::Idle
            } else {
                SyncState::Off
            },
            last_ok_ms,
            message: None,
            warnings: Vec::new(),
            can_allow_mass_delete: false,
            device_id: config.device_id.clone(),
        }
    }
}

fn host_of(url: &str) -> String {
    SyncEndpoint::parse(url)
        .map(|endpoint| endpoint.display())
        .unwrap_or_default()
}

/// 画面への知らせの口。
pub trait Notifier: Send + Sync + 'static {
    /// 状態が変わった。
    fn status_changed(&self, status: &SyncStatus);
    /// 同期が手元の記録を書き換えた（画面が、記録を読み直す）。
    fn records_changed(&self);
}

/// 同期用の DB を開く（試験は、偽物に替える）。
pub type OpenRemote = Arc<
    dyn Fn(&Path, &SyncEndpoint, Option<Secret>, &str) -> Result<Box<dyn Remote>, SyncError>
        + Send
        + Sync,
>;

/// 同期の間隔（試験は、短くする）。
#[derive(Debug, Clone, Copy)]
pub struct Timers {
    pub startup_delay: Duration,
    pub local_tick: Duration,
    pub full_interval: Duration,
    pub debounce: Duration,
    /// つながらないとき、つなぎ直す間隔（失敗のたびに次へ。最後のものを使い続ける）。
    pub backoff: [Duration; 4],
}

impl Default for Timers {
    fn default() -> Self {
        Timers {
            startup_delay: Duration::from_secs(3),
            local_tick: Duration::from_secs(10),
            full_interval: Duration::from_secs(300),
            debounce: Duration::from_secs(3),
            backoff: [
                Duration::from_secs(30),
                Duration::from_secs(60),
                Duration::from_secs(120),
                Duration::from_secs(300),
            ],
        }
    }
}

/// 同期の担当が頼る、アプリの側の部品。
pub struct SyncHost<P: Ports> {
    pub ports: P,
    pub notifier: Arc<dyn Notifier>,
    /// 手元の記録の目印（`local::change_marker`）。
    pub change_marker: Arc<dyn Fn() -> String + Send + Sync>,
    pub open_remote: OpenRemote,
    pub now_ms: Arc<dyn Fn() -> i64 + Send + Sync>,
    pub timers: Timers,
}

enum Cmd {
    /// 今すぐ同期（待ち時間・止めを無視して、通信を試す）。
    SyncNow,
    /// 設定が変わった（開き直して、同期する）。
    Reconfigure,
    /// 同期用の DB を作り直して、手元の記録から入れ直す。
    Rebuild,
    /// 大量の消去の止めを、1 回だけ外して同期する。
    AllowMassDelete,
    /// この端末の同期を切る（同期の作業のフォルダを消す）。
    Disconnect,
    Shutdown,
}

struct Shared {
    status: Mutex<SyncStatus>,
    notifier: Arc<dyn Notifier>,
}

impl Shared {
    fn update(&self, change: impl FnOnce(&mut SyncStatus)) {
        let snapshot = {
            let mut status = self.status.lock().unwrap_or_else(PoisonError::into_inner);
            change(&mut status);
            status.clone()
        };
        self.notifier.status_changed(&snapshot);
    }

    fn get(&self) -> SyncStatus {
        self.status
            .lock()
            .unwrap_or_else(PoisonError::into_inner)
            .clone()
    }
}

/// 同期の担当への窓口（アプリの状態に置く）。
pub struct SyncService {
    tx: Mutex<Sender<Cmd>>,
    shared: Arc<Shared>,
    config_dir: PathBuf,
    tokens: Arc<dyn TokenStore>,
}

impl SyncService {
    /// 同期のスレッドを始める。同期を使わない設定なら、何もせずに待つ。
    pub fn start<P: Ports + 'static>(
        config_dir: PathBuf,
        tokens: Arc<dyn TokenStore>,
        host: SyncHost<P>,
    ) -> SyncService {
        let (config, _) = SyncConfig::load(&config_dir);
        let has_token = matches!(tokens.load(), Ok(Some(_)));
        let last_ok = last_ok_of(&config_dir, &host.ports.data_dir(), &config);
        let shared = Arc::new(Shared {
            status: Mutex::new(SyncStatus::initial(&config, has_token, last_ok)),
            notifier: Arc::clone(&host.notifier),
        });
        let (tx, rx) = channel();
        let worker = Worker {
            config_dir: config_dir.clone(),
            tokens: Arc::clone(&tokens),
            local: FsLocal::new(host.ports),
            host_notifier: host.notifier,
            change_marker: host.change_marker,
            open_remote: host.open_remote,
            now_ms: host.now_ms,
            timers: host.timers,
            shared: Arc::clone(&shared),
            rx,
            runner: None,
            last_marker: None,
            dirty_since: None,
            offline_until: None,
            backoff_step: 0,
            paused: false,
        };
        let spawned = thread::Builder::new()
            .name("sync".to_string())
            .spawn(move || worker.run());
        if let Err(e) = spawned {
            eprintln!("同期のスレッドを始められませんでした: {e}");
        }
        SyncService {
            tx: Mutex::new(tx),
            shared,
            config_dir,
            tokens,
        }
    }

    fn send(&self, cmd: Cmd) {
        let _ = self
            .tx
            .lock()
            .unwrap_or_else(PoisonError::into_inner)
            .send(cmd);
    }

    pub fn status(&self) -> SyncStatus {
        self.shared.get()
    }

    /// 同期先の URL と、トークン（貼ったときだけ）を保存する。トークンは、資格情報の保管庫にだけ入れる。
    /// URL を替えたら、前の同期先の手元の写しは捨てる（別の DB の記録に混ざらないように）。同期を使うかは、変えない。
    pub fn save_connection(&self, url: &str, token: Option<&str>) -> Result<SyncStatus, String> {
        let endpoint = SyncEndpoint::parse(url).map_err(|e| e.to_string())?;
        let token = token.map(str::trim).filter(|t| !t.is_empty());
        if let Some(token) = token {
            if token.chars().any(char::is_whitespace) {
                return Err("トークンに空白や改行が入っています。貼り直してください".to_string());
            }
            self.tokens.save(token).map_err(|e| e.to_string())?;
        }
        let (mut config, _) = SyncConfig::load(&self.config_dir);
        let changed = config.url != endpoint.base_url();
        config.url = endpoint.base_url();
        config
            .save(&self.config_dir)
            .map_err(|e| format!("同期の設定を保存できませんでした: {e}"))?;
        let has_token = matches!(self.tokens.load(), Ok(Some(_)));
        self.shared.update(|status| {
            status.url_host = endpoint.display();
            status.has_token = has_token;
            status.device_id = config.device_id.clone();
            if changed {
                status.last_ok_ms = None;
            }
            status.message = None;
        });
        if changed || token.is_some() {
            self.send(Cmd::Reconfigure);
        }
        Ok(self.status())
    }

    /// 同期を使う・使わないを切り替える。使うには、URL とトークン（この PC の保管庫）が要る
    /// （この PC の中の試験用サーバーは、トークンが要らない）。
    pub fn set_enabled(&self, enabled: bool) -> Result<SyncStatus, String> {
        let (mut config, _) = SyncConfig::load(&self.config_dir);
        if enabled {
            let endpoint = SyncEndpoint::parse(&config.url)
                .map_err(|_| "先に、同期先の DB の URL を保存してください".to_string())?;
            let has_token = matches!(self.tokens.load(), Ok(Some(_)));
            if !has_token && !endpoint.is_loopback() {
                return Err("先に、トークンを保存してください".to_string());
            }
        }
        config.enabled = enabled;
        config
            .save(&self.config_dir)
            .map_err(|e| format!("同期の設定を保存できませんでした: {e}"))?;
        self.shared.update(|status| {
            status.enabled = enabled;
            status.message = None;
            status.warnings.clear();
            status.can_allow_mass_delete = false;
            status.state = if enabled {
                SyncState::Idle
            } else {
                SyncState::Off
            };
        });
        self.send(Cmd::Reconfigure);
        Ok(self.status())
    }

    pub fn sync_now(&self) {
        self.send(Cmd::SyncNow);
    }

    pub fn rebuild(&self) {
        self.send(Cmd::Rebuild);
    }

    pub fn allow_mass_delete(&self) {
        self.send(Cmd::AllowMassDelete);
    }

    /// この端末の同期を切る: 同期を使わない設定にし、トークンを保管庫から消し、同期の作業のフォルダ（手元の写し・ベース）を消す。
    /// 手元の記録と、同期用の DB（ほかの端末の分）には、触れない。
    pub fn disconnect(&self) -> Result<SyncStatus, String> {
        let (mut config, _) = SyncConfig::load(&self.config_dir);
        config.enabled = false;
        config
            .save(&self.config_dir)
            .map_err(|e| format!("同期の設定を保存できませんでした: {e}"))?;
        let deleted = self.tokens.delete();
        self.shared.update(|status| {
            status.enabled = false;
            status.state = SyncState::Off;
            status.has_token = false;
            status.message = None;
            status.warnings.clear();
            status.can_allow_mass_delete = false;
            status.last_ok_ms = None;
        });
        self.send(Cmd::Disconnect);
        deleted.map_err(|e| e.to_string())?;
        Ok(self.status())
    }

    /// 同期のスレッドに、終わるよう頼む（アプリを閉じるとき）。
    pub fn shutdown(&self) {
        self.send(Cmd::Shutdown);
    }
}

/// 最後に同期が成功した時刻（前回の起動のもの）を、ベースから読む。
fn last_ok_of(config_dir: &Path, data_dir: &Path, config: &SyncConfig) -> Option<i64> {
    if config.url.is_empty() {
        return None;
    }
    Base::load(&profile_dir(config_dir, data_dir, &config.url))
        .0
        .last_ok_ms
}

/// 開いている同期用の DB と、前回の記録。
struct Runner {
    remote: Box<dyn Remote>,
    base: Base,
    profile: PathBuf,
    /// どの設定で開いたか（これが変わったら、開き直す）。
    key: String,
    device: String,
    /// トークンの文字（エラーの文に混ざったものを伏せるため）。
    secret: Option<Secret>,
}

struct Worker<P: Ports> {
    config_dir: PathBuf,
    tokens: Arc<dyn TokenStore>,
    local: FsLocal<P>,
    host_notifier: Arc<dyn Notifier>,
    change_marker: Arc<dyn Fn() -> String + Send + Sync>,
    open_remote: OpenRemote,
    now_ms: Arc<dyn Fn() -> i64 + Send + Sync>,
    timers: Timers,
    shared: Arc<Shared>,
    rx: Receiver<Cmd>,
    runner: Option<Runner>,
    last_marker: Option<String>,
    dirty_since: Option<Instant>,
    offline_until: Option<Instant>,
    backoff_step: usize,
    /// 利用者の操作を待つ（トークンが通らない・大量の消去を止めた・新しい版）。
    paused: bool,
}

impl<P: Ports> Worker<P> {
    fn run(mut self) {
        let mut next_full = Instant::now() + self.timers.startup_delay;
        let mut next_check = Instant::now() + self.timers.local_tick;
        loop {
            let now = Instant::now();
            let wake = next_full.min(next_check);
            let wait = wake.saturating_duration_since(now);
            match self.rx.recv_timeout(wait) {
                Ok(Cmd::Shutdown) | Err(RecvTimeoutError::Disconnected) => break,
                Ok(cmd) => {
                    self.handle(cmd);
                    let now = Instant::now();
                    next_full = now + self.timers.full_interval;
                    next_check = now + self.timers.local_tick;
                }
                Err(RecvTimeoutError::Timeout) => {
                    let now = Instant::now();
                    if now >= next_full {
                        self.cycle(false, false);
                        next_full = Instant::now() + self.timers.full_interval;
                        next_check = Instant::now() + self.timers.local_tick;
                    } else if now >= next_check {
                        self.check_local_changes();
                        next_check = Instant::now() + self.timers.local_tick;
                    }
                }
            }
        }
    }

    fn handle(&mut self, cmd: Cmd) {
        match cmd {
            Cmd::SyncNow => {
                self.paused = false;
                self.cycle(true, false);
            }
            Cmd::Reconfigure => {
                self.runner = None;
                self.paused = false;
                self.offline_until = None;
                self.backoff_step = 0;
                self.cycle(true, false);
            }
            Cmd::Rebuild => self.rebuild(),
            Cmd::AllowMassDelete => {
                self.paused = false;
                self.cycle(true, true);
            }
            Cmd::Disconnect => self.disconnect(),
            Cmd::Shutdown => {}
        }
    }

    /// 手元の記録の目印が変わって、少し落ち着いたら、同期する。
    fn check_local_changes(&mut self) {
        let marker = (self.change_marker)();
        let Some(last) = self.last_marker.clone() else {
            self.last_marker = Some(marker);
            return;
        };
        if marker == last {
            self.dirty_since = None;
            return;
        }
        let since = *self.dirty_since.get_or_insert_with(Instant::now);
        if since.elapsed() >= self.timers.debounce {
            self.dirty_since = None;
            self.cycle(false, false);
        }
    }

    fn open_runner(&mut self) -> Result<(), String> {
        let (config, _) = SyncConfig::load(&self.config_dir);
        let endpoint = SyncEndpoint::parse(&config.url).map_err(|e| e.to_string())?;
        let token = match self.tokens.load() {
            Ok(token) => token,
            Err(e) => return Err(e.to_string()),
        };
        if token.is_none() && !endpoint.is_loopback() {
            return Err("トークンが、この PC の資格情報の保管庫に入っていません".to_string());
        }
        let data_dir = self.local.ports().data_dir();
        let key = sha256_hex(
            format!(
                "{}\n{}\n{}\n{}",
                data_dir.to_string_lossy(),
                endpoint.base_url(),
                token
                    .as_ref()
                    .map(|t| sha256_hex(t.expose().as_bytes()))
                    .unwrap_or_default(),
                config.device_id
            )
            .as_bytes(),
        );
        if self.runner.as_ref().is_some_and(|r| r.key == key) {
            return Ok(());
        }
        self.runner = None;
        let profile = profile_dir(&self.config_dir, &data_dir, &endpoint.base_url());
        let remote = (self.open_remote)(
            &profile.join(SYNC_DB_FILE),
            &endpoint,
            token.clone(),
            &format!("jantama-reviewer-{}", config.device_id),
        )
        .map_err(|e| e.to_string())?;
        let (base, broken) = Base::load(&profile);
        if broken {
            eprintln!("同期の前回の記録を読めなかったので、作り直します");
        }
        self.runner = Some(Runner {
            remote,
            base,
            profile,
            key,
            device: config.device_id,
            secret: token,
        });
        Ok(())
    }

    /// 同期を 1 回分行う。`manual` は、利用者の操作（待ち時間・止めを無視して、通信を試す）。
    fn cycle(&mut self, manual: bool, allow_mass_delete: bool) {
        let (config, _) = SyncConfig::load(&self.config_dir);
        if !config.enabled {
            self.shared.update(|status| {
                status.enabled = false;
                status.state = SyncState::Off;
            });
            return;
        }
        if self.paused && !manual {
            return;
        }
        let now = Instant::now();
        let network = manual || self.offline_until.is_none_or(|until| now >= until);
        if let Err(reason) = self.open_runner() {
            let has_token = matches!(self.tokens.load(), Ok(Some(_)));
            self.shared.update(|status| {
                status.enabled = true;
                status.has_token = has_token;
                status.state = SyncState::Error;
                status.message = Some(reason);
            });
            self.runner = None;
            return;
        }
        self.shared.update(|status| {
            status.enabled = true;
            status.has_token = true;
            status.state = SyncState::Syncing;
            status.message = None;
            status.can_allow_mass_delete = false;
        });
        let now_ms = (self.now_ms)();
        let Some(runner) = self.runner.as_mut() else {
            return;
        };
        let options = CycleOptions {
            device: &runner.device,
            now_ms,
            network,
            allow_mass_delete,
        };
        let outcome = run_cycle(
            runner.remote.as_mut(),
            &mut self.local,
            &mut runner.base,
            &options,
        );
        if let Err(e) = runner.base.save(&runner.profile) {
            eprintln!("同期の記録を保存できませんでした: {e}");
        }
        let secrets: Vec<String> = runner
            .secret
            .iter()
            .map(|s| s.expose().to_string())
            .collect();
        let secrets: Vec<&str> = secrets.iter().map(String::as_str).collect();
        let last_ok = runner.base.last_ok_ms;
        self.finish(outcome, &secrets, last_ok);
        self.last_marker = Some((self.change_marker)());
        self.dirty_since = None;
    }

    fn finish(
        &mut self,
        outcome: Result<CycleReport, SyncError>,
        secrets: &[&str],
        last_ok: Option<i64>,
    ) {
        match outcome {
            Ok(report) => {
                if report.local_puts + report.local_deletes > 0 {
                    self.host_notifier.records_changed();
                }
                let warnings: Vec<String> = report
                    .warnings
                    .iter()
                    .take(MAX_WARNINGS)
                    .map(|w| redact(w, secrets))
                    .collect();
                match &report.network_error {
                    None => {
                        self.offline_until = None;
                        self.backoff_step = 0;
                        let synced_with_network = report.pulled && report.pushed;
                        self.shared.update(|status| {
                            status.state = SyncState::Idle;
                            status.warnings = warnings;
                            if synced_with_network {
                                status.last_ok_ms = last_ok;
                            }
                            status.message = None;
                        });
                    }
                    Some(error) => {
                        self.note_offline();
                        let message = redact(&error.to_string(), secrets);
                        self.shared.update(|status| {
                            status.state = SyncState::Offline;
                            status.message = Some(message);
                            status.warnings = warnings;
                        });
                    }
                }
            }
            Err(error) => {
                let message = redact(&error.to_string(), secrets);
                match error {
                    SyncError::Offline(_) => {
                        self.note_offline();
                        self.shared.update(|status| {
                            status.state = SyncState::Offline;
                            status.message = Some(message);
                        });
                    }
                    SyncError::MassDelete { .. } => {
                        self.paused = true;
                        self.shared.update(|status| {
                            status.state = SyncState::Attention;
                            status.message = Some(message);
                            status.can_allow_mass_delete = true;
                        });
                    }
                    SyncError::Unauthorized | SyncError::NewerSchema { .. } => {
                        self.paused = true;
                        self.shared.update(|status| {
                            status.state = SyncState::Attention;
                            status.message = Some(message);
                        });
                    }
                    SyncError::Remote(_) | SyncError::Local(_) | SyncError::NotConfigured(_) => {
                        self.note_offline();
                        self.shared.update(|status| {
                            status.state = SyncState::Error;
                            status.message = Some(message);
                        });
                    }
                }
            }
        }
    }

    /// つながらなかった。次につなぎ直すまでの待ちを決める。
    fn note_offline(&mut self) {
        let step = self.backoff_step.min(self.timers.backoff.len() - 1);
        self.offline_until = Some(Instant::now() + self.timers.backoff[step]);
        self.backoff_step = (self.backoff_step + 1).min(self.timers.backoff.len() - 1);
    }

    /// 同期用の DB を作り直して、手元の記録から入れ直す。つながっているときだけ（つながらないまま作り直すと、
    /// ほかの端末が追加した分を、取り込む前に消してしまうため）。
    fn rebuild(&mut self) {
        let (config, _) = SyncConfig::load(&self.config_dir);
        if !config.enabled {
            return;
        }
        if let Err(reason) = self.open_runner() {
            self.shared.update(|status| {
                status.state = SyncState::Error;
                status.message = Some(reason);
            });
            return;
        }
        self.shared.update(|status| {
            status.state = SyncState::Syncing;
            status.message = None;
            status.can_allow_mass_delete = false;
        });
        let now_ms = (self.now_ms)();
        let Some(runner) = self.runner.as_mut() else {
            return;
        };
        let secrets: Vec<String> = runner
            .secret
            .iter()
            .map(|s| s.expose().to_string())
            .collect();
        let secrets: Vec<&str> = secrets.iter().map(String::as_str).collect();
        // 先に取り込む（通信できなければ、何も変えずに、やめる）
        if let Err(error) = runner.remote.pull() {
            let message = format!(
                "つながっていないので、同期用の DB は作り直していません。つながってから、もう一度押してください（{})",
                redact(&error.to_string(), &secrets)
            );
            self.shared.update(|status| {
                status.state = SyncState::Offline;
                status.message = Some(message);
            });
            return;
        }
        let new_id = format!("db-{}", new_uid());
        if let Err(error) = runner.remote.reset(&new_id, now_ms) {
            let message = redact(&error.to_string(), &secrets);
            self.shared.update(|status| {
                status.state = SyncState::Error;
                status.message = Some(message);
            });
            return;
        }
        runner.base.forget_rows();
        runner.base.db_id = None;
        if let Err(e) = runner.base.save(&runner.profile) {
            eprintln!("同期の記録を保存できませんでした: {e}");
        }
        self.paused = false;
        self.cycle(true, false);
    }

    fn disconnect(&mut self) {
        self.runner = None;
        self.paused = false;
        self.offline_until = None;
        self.backoff_step = 0;
        let root = sync_root(&self.config_dir);
        // 同期の部品が、ファイルを閉じるまで、少し待つ
        for attempt in 0..10 {
            match std::fs::remove_dir_all(&root) {
                Ok(()) => return,
                Err(e) if e.kind() == std::io::ErrorKind::NotFound => return,
                Err(e) => {
                    if attempt == 9 {
                        eprintln!("同期の作業のフォルダを消せませんでした: {e}");
                    } else {
                        thread::sleep(Duration::from_millis(200));
                    }
                }
            }
        }
    }
}
