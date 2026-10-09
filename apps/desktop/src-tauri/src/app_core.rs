//! アプリ全体の状態（設定 + 記録の担当）。
//!
//! Tauri に依存しないので、設定の変更・保存先の移し替え・記録の操作を単体テストで確かめられる。
//! Tauri のコマンドやフックの担当は、ここを `Mutex` で包んで呼ぶだけの薄い層にする。

use std::path::PathBuf;
use std::sync::Arc;

use serde::Serialize;

use crate::capture::Capturer;
use crate::recorder::{Recorder, RecorderOptions};
use crate::settings::{settings_path, Orientation, Settings, WidgetPosition};
use crate::sound::Sound;
use crate::store::{Rating, SessionRecord, Store};

/// ウィジェットの「記録中」の表示。
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize)]
#[serde(rename_all = "snake_case")]
pub enum Status {
    /// 半荘がまだ始まっていない。最初の記録で自動的に始まる。
    Idle,
    /// 半荘を記録している。
    Recording,
    /// 保存先を開けず、記録できない。
    Error,
}

/// 画面（ウィジェットと検討画面）に渡す、記録の現在の状態。
#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
pub struct AppState {
    pub status: Status,
    pub session_id: Option<String>,
    pub mark_count: usize,
    pub ratings: Vec<Rating>,
    pub next_hand: usize,
    pub can_undo: bool,
    /// 記録できないときの理由。
    pub error: Option<String>,
}

/// 設定を変えたとき、何が変わったか。変わったものだけ、窓やフックに反映する。
#[derive(Debug, Clone, Copy, Default, PartialEq, Eq)]
pub struct SettingsChange {
    pub trigger: bool,
    pub orientation: bool,
    pub data_dir: bool,
    /// 音の入・切（メニューの印を合わせるため）。
    pub sound: bool,
}

pub struct Core {
    config_dir: PathBuf,
    settings: Settings,
    recorder: Result<Recorder, String>,
    capturer: Arc<dyn Capturer>,
    sound: Arc<dyn Sound>,
    /// 起動時に伝えたいこと（壊れた設定ファイルを退避した、など）。
    startup_note: Option<String>,
}

fn recorder_options(settings: &Settings) -> RecorderOptions {
    RecorderOptions {
        capture_keywords: settings.capture_keywords.clone(),
        sound: settings.sound,
    }
}

fn open_recorder(
    settings: &Settings,
    capturer: &Arc<dyn Capturer>,
    sound: &Arc<dyn Sound>,
) -> Result<Recorder, String> {
    let mut store = Store::open(&settings.data_dir).map_err(|e| e.to_string())?;
    // 起動し直しても、最後の記録から 30 分以内で閉じていない半荘には、続けて記録する（W-14）。
    store.resume_recent(crate::clock::now_ms());
    Ok(Recorder::new(
        store,
        capturer.clone(),
        sound.clone(),
        recorder_options(settings),
    ))
}

impl Core {
    /// 設定フォルダの設定を読んで始める。壊れていれば退避して既定値で始める。
    pub fn load(config_dir: PathBuf, capturer: Arc<dyn Capturer>, sound: Arc<dyn Sound>) -> Core {
        let (settings, startup_note) = Settings::load_or_recover(&settings_path(&config_dir));
        let mut core = Core::with_settings(config_dir, settings, capturer, sound);
        core.startup_note = startup_note;
        core
    }

    pub fn with_settings(
        config_dir: PathBuf,
        settings: Settings,
        capturer: Arc<dyn Capturer>,
        sound: Arc<dyn Sound>,
    ) -> Core {
        let settings = settings.normalized();
        let recorder = open_recorder(&settings, &capturer, &sound);
        Core {
            config_dir,
            settings,
            recorder,
            capturer,
            sound,
            startup_note: None,
        }
    }

    pub fn settings(&self) -> &Settings {
        &self.settings
    }

    pub fn startup_note(&self) -> Option<&str> {
        self.startup_note.as_deref()
    }

    /// 画面に出す状態。
    pub fn app_state(&self) -> AppState {
        match &self.recorder {
            Ok(recorder) => {
                let s = recorder.state();
                AppState {
                    status: if s.session_id.is_some() {
                        Status::Recording
                    } else {
                        Status::Idle
                    },
                    session_id: s.session_id,
                    mark_count: s.mark_count,
                    ratings: s.ratings,
                    next_hand: s.next_hand,
                    can_undo: s.can_undo,
                    error: None,
                }
            }
            Err(message) => AppState {
                status: Status::Error,
                session_id: None,
                mark_count: 0,
                ratings: Vec::new(),
                next_hand: 1,
                can_undo: false,
                error: Some(message.clone()),
            },
        }
    }

    fn recorder_mut(&mut self) -> Result<&mut Recorder, String> {
        self.recorder.as_mut().map_err(|e| e.clone())
    }

    /// 迷いマークを記録する。`t_ms` は押された時刻。
    pub fn mark(&mut self, t_ms: i64) -> Result<AppState, String> {
        self.recorder_mut()?.mark(t_ms).map_err(|e| e.to_string())?;
        Ok(self.app_state())
    }

    pub fn rate(&mut self, t_ms: i64, rating: Rating) -> Result<AppState, String> {
        self.recorder_mut()?
            .rate(t_ms, rating)
            .map_err(|e| e.to_string())?;
        Ok(self.app_state())
    }

    pub fn undo(&mut self, t_ms: i64) -> Result<AppState, String> {
        self.recorder_mut()?.undo(t_ms).map_err(|e| e.to_string())?;
        Ok(self.app_state())
    }

    /// 今の半荘を閉じる（W-14）。フォルダは作らず、次の記録が新しい半荘を始める。
    pub fn new_session(&mut self, t_ms: i64) -> Result<AppState, String> {
        self.recorder_mut()?
            .new_session(t_ms)
            .map_err(|e| e.to_string())?;
        Ok(self.app_state())
    }

    pub fn list_sessions(&self) -> Result<Vec<SessionRecord>, String> {
        match &self.recorder {
            Ok(recorder) => recorder.list_sessions().map_err(|e| e.to_string()),
            Err(message) => Err(message.clone()),
        }
    }

    /// 設定を変える。使えない値（割り当てられないキー・リポジトリの中の保存先）は、
    /// 何も変えずにエラーを返す（D-1）。通れば保存して、何が変わったかを返す。
    pub fn apply_settings(&mut self, new: Settings) -> Result<SettingsChange, String> {
        let new = new.normalized();
        new.validate().map_err(|e| e.to_string())?;

        let data_dir_changed = new.data_dir != self.settings.data_dir;
        let mut reopened: Option<Recorder> = None;
        if data_dir_changed {
            // 新しい保存先を先に開く。開けなければ、設定ごと変えない。
            reopened = Some(open_recorder(&new, &self.capturer, &self.sound)?);
        } else if self.recorder.is_err() {
            // 保存先を開けずにいた場合は、保存し直すついでにもう一度開いてみる。
            reopened = open_recorder(&new, &self.capturer, &self.sound).ok();
        }

        new.save(&settings_path(&self.config_dir))
            .map_err(|e| format!("設定を保存できませんでした: {e}"))?;

        let change = SettingsChange {
            trigger: new.trigger != self.settings.trigger,
            orientation: new.orientation != self.settings.orientation,
            data_dir: data_dir_changed,
            sound: new.sound != self.settings.sound,
        };
        self.settings = new;
        match reopened {
            Some(recorder) => self.recorder = Ok(recorder),
            None => {
                let options = recorder_options(&self.settings);
                if let Ok(recorder) = &mut self.recorder {
                    recorder.set_options(options);
                }
            }
        }
        Ok(change)
    }

    /// ウィジェットの形だけを変える。
    pub fn set_orientation(&mut self, orientation: Orientation) -> Result<SettingsChange, String> {
        let mut next = self.settings.clone();
        next.orientation = orientation;
        self.apply_settings(next)
    }

    /// ウィジェットの窓の位置を覚える。
    pub fn set_widget_position(&mut self, position: WidgetPosition) -> Result<(), String> {
        if self.settings.widget_position == Some(position) {
            return Ok(());
        }
        let mut next = self.settings.clone();
        next.widget_position = Some(position);
        next.save(&settings_path(&self.config_dir))
            .map_err(|e| format!("設定を保存できませんでした: {e}"))?;
        self.settings = next;
        Ok(())
    }
}

#[cfg(test)]
mod tests {
    use std::fs;

    use super::*;
    use crate::recorder::test_support::{CountingSound, FakeCapturer};
    use crate::settings::Trigger;

    const T0: i64 = 1_760_000_000_123;

    struct Fixture {
        tmp: tempfile::TempDir,
        core: Core,
        sound: Arc<CountingSound>,
    }

    impl Fixture {
        fn config_dir(&self) -> PathBuf {
            self.tmp.path().join("config")
        }

        fn data_dir(&self) -> PathBuf {
            self.tmp.path().join("data")
        }
    }

    fn fixture() -> Fixture {
        let tmp = tempfile::tempdir().unwrap();
        let sound = CountingSound::new();
        let settings = Settings {
            data_dir: tmp.path().join("data"),
            ..Settings::default()
        };
        let core = Core::with_settings(
            tmp.path().join("config"),
            settings,
            FakeCapturer::ok(&[1, 2, 3]),
            sound.clone(),
        );
        Fixture { tmp, core, sound }
    }

    /// 起動の前に、保存先へ迷いマーク 1 件の半荘を書いておく（`ago_ms` だけ前の記録）。半荘の名前を返す。
    fn seed_session(data: &std::path::Path, ago_ms: i64) -> String {
        use crate::capture::{CaptureTarget, Screenshot};
        let mut store = Store::open(data).unwrap();
        let shot = Ok(Screenshot {
            png: vec![0x89, b'P', b'N', b'G'],
            target: CaptureTarget::Window,
        });
        store
            .add_mark(crate::clock::now_ms() - ago_ms, shot)
            .unwrap();
        store.current_session_id().unwrap().to_string()
    }

    fn start_core(tmp: &tempfile::TempDir) -> Core {
        let settings = Settings {
            data_dir: tmp.path().join("data"),
            ..Settings::default()
        };
        Core::with_settings(
            tmp.path().join("config"),
            settings,
            FakeCapturer::ok(&[1, 2, 3]),
            CountingSound::new(),
        )
    }

    #[test]
    fn w14_starting_the_app_again_within_30_minutes_continues_the_last_session() {
        let tmp = tempfile::tempdir().unwrap();
        let id = seed_session(&tmp.path().join("data"), 5 * 60 * 1000);
        let s = start_core(&tmp).app_state();
        assert_eq!(s.session_id.as_deref(), Some(id.as_str()));
        assert_eq!(s.mark_count, 1, "ウィジェットの数字も続きから");
    }

    #[test]
    fn w14_starting_the_app_more_than_30_minutes_later_does_not_continue_the_last_session() {
        let tmp = tempfile::tempdir().unwrap();
        seed_session(&tmp.path().join("data"), 31 * 60 * 1000);
        let s = start_core(&tmp).app_state();
        assert_eq!(s.session_id, None);
        assert_eq!(s.mark_count, 0);
    }

    #[test]
    fn starts_idle_and_the_first_mark_starts_a_session() {
        let mut f = fixture();
        let s = f.core.app_state();
        assert_eq!(s.status, Status::Idle);
        assert_eq!(s.session_id, None);
        assert_eq!(s.next_hand, 1);
        assert_eq!(s.error, None);

        let s = f.core.mark(T0).unwrap();
        assert_eq!(s.status, Status::Recording);
        assert_eq!(s.mark_count, 1);
        assert!(s.session_id.is_some());
    }

    #[test]
    fn operations_update_the_state() {
        let mut f = fixture();
        f.core.rate(T0, Rating::Good).unwrap();
        f.core.mark(T0 + 1).unwrap();
        let s = f.core.rate(T0 + 2, Rating::Fair).unwrap();
        assert_eq!(s.ratings, vec![Rating::Good, Rating::Fair]);
        assert_eq!(s.next_hand, 3);
        assert!(s.can_undo);
        let s = f.core.undo(T0 + 3).unwrap();
        assert_eq!(s.next_hand, 2);
        let before = s.session_id.unwrap();
        let s = f.core.new_session(T0 + 4).unwrap();
        assert_eq!(s.session_id, None, "閉じるだけで、空の半荘は作らない");
        assert_eq!(s.status, Status::Idle);
        assert_eq!(s.mark_count, 0);
        assert_eq!(s.next_hand, 1);
        assert_eq!(f.core.list_sessions().unwrap().len(), 1);
        let s = f.core.mark(T0 + 20_000).unwrap();
        assert_ne!(s.session_id.unwrap(), before);
        assert_eq!(f.core.list_sessions().unwrap().len(), 2);
    }

    #[test]
    fn undo_with_nothing_to_undo_reports_a_message() {
        let mut f = fixture();
        let err = f.core.undo(T0).unwrap_err();
        assert!(err.contains("取り消せる記録がありません"), "{err}");
    }

    #[test]
    fn d1_a_data_dir_inside_a_repository_at_startup_gives_an_error_status() {
        let tmp = tempfile::tempdir().unwrap();
        fs::create_dir_all(tmp.path().join("repo").join(".git")).unwrap();
        let settings = Settings {
            data_dir: tmp.path().join("repo").join("data"),
            ..Settings::default()
        };
        let mut core = Core::with_settings(
            tmp.path().join("config"),
            settings,
            FakeCapturer::ok(&[1]),
            CountingSound::new(),
        );
        let s = core.app_state();
        assert_eq!(s.status, Status::Error);
        assert!(s.error.unwrap().contains("リポジトリの中"));
        assert!(core.mark(T0).is_err());
        assert!(core.rate(T0, Rating::Good).is_err());
        assert!(!tmp.path().join("repo").join("data").exists());
    }

    #[test]
    fn d1_changing_the_data_dir_to_a_repository_is_refused_and_nothing_changes() {
        let mut f = fixture();
        f.core.rate(T0, Rating::Good).unwrap();
        let repo = f.tmp.path().join("repo");
        fs::create_dir_all(repo.join(".git")).unwrap();

        let mut next = f.core.settings().clone();
        next.data_dir = repo.join("data");
        next.sound = false;
        let err = f.core.apply_settings(next).unwrap_err();
        assert!(err.contains("リポジトリの中"), "{err}");

        // 設定も記録も、元のまま。
        assert_eq!(f.core.settings().data_dir, f.data_dir());
        assert!(f.core.settings().sound);
        assert_eq!(f.core.app_state().ratings, vec![Rating::Good]);
        assert!(!repo.join("data").exists());
        assert!(!f.config_dir().join("settings.json").exists());
    }

    #[test]
    fn changing_the_data_dir_moves_recording_there_and_starts_without_a_session() {
        let mut f = fixture();
        f.core.mark(T0).unwrap();
        let other = f.tmp.path().join("other");
        let mut next = f.core.settings().clone();
        next.data_dir = other.clone();
        let change = f.core.apply_settings(next).unwrap();
        assert!(change.data_dir);
        assert_eq!(f.core.app_state().status, Status::Idle);
        f.core.mark(T0 + 1).unwrap();
        assert_eq!(fs::read_dir(other.join("games")).unwrap().count(), 1);
        assert_eq!(fs::read_dir(f.data_dir().join("games")).unwrap().count(), 1);
    }

    #[test]
    fn w5_orientation_change_is_saved_and_reported_and_survives_a_restart() {
        let mut f = fixture();
        assert_eq!(f.core.settings().orientation, Orientation::Vertical);
        let change = f.core.set_orientation(Orientation::Horizontal).unwrap();
        assert_eq!(
            change,
            SettingsChange {
                orientation: true,
                ..SettingsChange::default()
            }
        );
        // 同じ設定フォルダから読み直す（= 次の起動）。
        let reloaded = Core::load(f.config_dir(), FakeCapturer::ok(&[1]), CountingSound::new());
        assert_eq!(reloaded.settings().orientation, Orientation::Horizontal);
    }

    #[test]
    fn w5_widget_position_is_saved_and_loaded_on_the_next_start() {
        let mut f = fixture();
        f.core
            .set_widget_position(WidgetPosition { x: 2400, y: 100 })
            .unwrap();
        let reloaded = Core::load(f.config_dir(), FakeCapturer::ok(&[1]), CountingSound::new());
        assert_eq!(
            reloaded.settings().widget_position,
            Some(WidgetPosition { x: 2400, y: 100 })
        );
    }

    #[test]
    fn changing_the_trigger_is_reported_and_an_unsupported_key_is_refused() {
        let mut f = fixture();
        let mut next = f.core.settings().clone();
        next.trigger = Trigger::MouseX2;
        let change = f.core.apply_settings(next).unwrap();
        assert!(change.trigger && !change.orientation && !change.data_dir);

        let mut bad = f.core.settings().clone();
        bad.trigger = Trigger::key("Enter");
        assert!(f.core.apply_settings(bad).is_err());
        assert_eq!(f.core.settings().trigger, Trigger::MouseX2);
    }

    #[test]
    fn saving_the_same_settings_reports_no_change() {
        let mut f = fixture();
        let same = f.core.settings().clone();
        assert_eq!(
            f.core.apply_settings(same).unwrap(),
            SettingsChange::default()
        );
    }

    #[test]
    fn the_sound_setting_takes_effect_without_a_restart() {
        let mut f = fixture();
        f.core.mark(T0).unwrap();
        assert_eq!(f.sound.count(), 1);
        let mut next = f.core.settings().clone();
        next.sound = false;
        f.core.apply_settings(next).unwrap();
        f.core.mark(T0 + 1).unwrap();
        assert_eq!(f.sound.count(), 1, "音を切ったあとは鳴らない");
    }

    #[test]
    fn keywords_are_normalized_when_applied() {
        let mut f = fixture();
        let mut next = f.core.settings().clone();
        next.capture_keywords = vec!["  雀魂 ".into(), "".into()];
        f.core.apply_settings(next).unwrap();
        assert_eq!(f.core.settings().capture_keywords, vec!["雀魂"]);
    }

    #[test]
    fn w12_flipping_the_sound_setting_is_reported_saved_and_kept_after_a_restart() {
        let mut f = fixture();
        assert!(f.core.settings().sound);
        let mut next = f.core.settings().clone();
        next.sound = !next.sound;
        let change = f.core.apply_settings(next).unwrap();
        assert_eq!(
            change,
            SettingsChange {
                sound: true,
                ..SettingsChange::default()
            }
        );
        assert!(!f.core.settings().sound);
        // 同じ設定フォルダから読み直す（= 次の起動）。
        let reloaded = Core::load(f.config_dir(), FakeCapturer::ok(&[1]), CountingSound::new());
        assert!(!reloaded.settings().sound);
        // もう一度切り替えると、入に戻って、それも残る。
        let mut back = f.core.settings().clone();
        back.sound = !back.sound;
        assert!(f.core.apply_settings(back).unwrap().sound);
        let reloaded = Core::load(f.config_dir(), FakeCapturer::ok(&[1]), CountingSound::new());
        assert!(reloaded.settings().sound);
    }

    #[test]
    fn w12_other_settings_changes_do_not_report_a_sound_change() {
        let mut f = fixture();
        let mut next = f.core.settings().clone();
        next.orientation = Orientation::Horizontal;
        let change = f.core.apply_settings(next).unwrap();
        assert!(change.orientation && !change.sound);
    }
}
