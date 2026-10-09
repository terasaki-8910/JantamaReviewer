//! 記録の担当。保存（`Store`）・スクリーンショット（`Capturer`）・音（`Sound`）をつなぐ。
//!
//! ウィジェットの操作（迷いマーク・評価・取り消し・新しい半荘）で起きる処理は、ここを通る。
//! 通信の部品は持たず、できるのはファイルへの保存と記録の追記だけ（S-4）。

use std::sync::Arc;

use serde::Serialize;

use crate::capture::Capturer;
use crate::sound::Sound;
use crate::store::{Rating, SessionRecord, SessionView, Store, StoreError};

/// 半荘の現在の様子（ウィジェットに出す数字）。
#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
pub struct SessionState {
    /// 開いている半荘の名前。無ければ `None`。
    pub session_id: Option<String>,
    /// 取り消されていない迷いマークの数。
    pub mark_count: usize,
    /// 取り消されていない評価（押した順）。
    pub ratings: Vec<Rating>,
    /// 次の評価が入る局の番号（評価の数 + 1）。
    pub next_hand: usize,
    /// 取り消せる記録があるか。
    pub can_undo: bool,
}

impl SessionState {
    fn from_view(session_id: Option<&str>, view: &SessionView) -> SessionState {
        SessionState {
            session_id: session_id.map(str::to_string),
            mark_count: view.mark_count(),
            ratings: view.ratings.iter().map(|r| r.rating).collect(),
            next_hand: view.next_hand(),
            can_undo: view.can_undo(),
        }
    }
}

/// 記録の担当の設定（設定画面で変わる部分）。
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct RecorderOptions {
    /// 雀魂の窓を探す語。
    pub capture_keywords: Vec<String>,
    /// 迷いマークを記録したときに音を鳴らすか。
    pub sound: bool,
}

pub struct Recorder {
    store: Store,
    capturer: Arc<dyn Capturer>,
    sound: Arc<dyn Sound>,
    options: RecorderOptions,
}

impl Recorder {
    pub fn new(
        store: Store,
        capturer: Arc<dyn Capturer>,
        sound: Arc<dyn Sound>,
        options: RecorderOptions,
    ) -> Recorder {
        Recorder {
            store,
            capturer,
            sound,
            options,
        }
    }

    pub fn set_options(&mut self, options: RecorderOptions) {
        self.options = options;
    }

    pub fn state(&self) -> SessionState {
        SessionState::from_view(self.store.current_session_id(), &self.store.view())
    }

    /// 迷いマークを記録する（W-1）。`t_ms` は割り当てたボタンが押された時刻。
    /// 画面は押された直後に撮り、そのあとで半荘のフォルダ・記録・画像を書く。
    pub fn mark(&mut self, t_ms: i64) -> Result<SessionState, StoreError> {
        let shot = self.capturer.capture(&self.options.capture_keywords);
        self.store.add_mark(t_ms, shot)?;
        if self.options.sound {
            self.sound.tick();
        }
        Ok(self.state())
    }

    /// 局の評価（〇△✕）を記録する。画面も迷いマークと同じ方法で撮って保存し、記録にそのパスを入れる（W-13）。
    /// 評価はあとで、画像から「どの局の評価か」を読んで合わせるために使う（F11）。音は鳴らさない。
    pub fn rate(&mut self, t_ms: i64, rating: Rating) -> Result<SessionState, StoreError> {
        let shot = self.capturer.capture(&self.options.capture_keywords);
        self.store.add_rating(t_ms, rating, shot)?;
        Ok(self.state())
    }

    /// 最後の記録を 1 つ取り消す。
    pub fn undo(&mut self, t_ms: i64) -> Result<SessionState, StoreError> {
        self.store.undo(t_ms)?;
        Ok(self.state())
    }

    /// 今の半荘を閉じる（W-14）。フォルダは作らない。次の記録が、新しい半荘を始める。
    /// 「閉じた」記録を書けなかったときもエラーを返すが、半荘は閉じている。
    pub fn new_session(&mut self, t_ms: i64) -> Result<SessionState, StoreError> {
        self.store.close_session(t_ms)?;
        Ok(self.state())
    }

    pub fn list_sessions(&self) -> Result<Vec<SessionRecord>, StoreError> {
        self.store.list_sessions()
    }

    pub fn data_dir(&self) -> &std::path::Path {
        self.store.root()
    }
}

#[cfg(test)]
pub(crate) mod test_support {
    use std::sync::atomic::{AtomicUsize, Ordering};
    use std::sync::{Arc, Mutex};

    use crate::capture::{CaptureError, CaptureTarget, Capturer, Screenshot};
    use crate::sound::Sound;

    /// 撮る代わりに決まった画像を返し、呼ばれた回数と探す語を覚える。
    pub struct FakeCapturer {
        pub result: Mutex<Result<Screenshot, CaptureError>>,
        pub calls: Mutex<Vec<Vec<String>>>,
    }

    impl FakeCapturer {
        pub fn ok(png: &[u8]) -> Arc<FakeCapturer> {
            Arc::new(FakeCapturer {
                result: Mutex::new(Ok(Screenshot {
                    png: png.to_vec(),
                    target: CaptureTarget::Window,
                })),
                calls: Mutex::new(Vec::new()),
            })
        }

        pub fn failing(message: &str) -> Arc<FakeCapturer> {
            Arc::new(FakeCapturer {
                result: Mutex::new(Err(CaptureError(message.to_string()))),
                calls: Mutex::new(Vec::new()),
            })
        }

        pub fn call_count(&self) -> usize {
            self.calls.lock().unwrap().len()
        }
    }

    impl Capturer for FakeCapturer {
        fn capture(&self, keywords: &[String]) -> Result<Screenshot, CaptureError> {
            self.calls.lock().unwrap().push(keywords.to_vec());
            self.result.lock().unwrap().clone()
        }
    }

    /// 鳴らした回数を数える。
    #[derive(Default)]
    pub struct CountingSound {
        pub ticks: AtomicUsize,
    }

    impl CountingSound {
        pub fn new() -> Arc<CountingSound> {
            Arc::new(CountingSound::default())
        }

        pub fn count(&self) -> usize {
            self.ticks.load(Ordering::SeqCst)
        }
    }

    impl Sound for CountingSound {
        fn tick(&self) {
            self.ticks.fetch_add(1, Ordering::SeqCst);
        }
    }
}

#[cfg(test)]
mod tests {
    use std::fs;
    use std::path::{Path, PathBuf};

    use super::test_support::{CountingSound, FakeCapturer};
    use super::*;
    use crate::store::{Event, EventKind, EVENTS_FILE, GAMES_DIR, MARKS_DIR, RATINGS_DIR};
    use jantama_input::keys::Modifiers;
    use jantama_input::logic::{
        ActiveTrigger, Config, InputCore, InputEvent, Mode, MouseButton, Report,
    };

    const T0: i64 = 1_760_000_000_123;
    const FAKE_PNG: &[u8] = &[0x89, b'P', b'N', b'G', 1, 2, 3];

    struct Fixture {
        _tmp: tempfile::TempDir,
        recorder: Recorder,
        capturer: Arc<FakeCapturer>,
        sound: Arc<CountingSound>,
    }

    fn fixture_with(capturer: Arc<FakeCapturer>, sound_on: bool) -> Fixture {
        let tmp = tempfile::tempdir().unwrap();
        let store = Store::open(tmp.path().join("data")).unwrap();
        let sound = CountingSound::new();
        let recorder = Recorder::new(
            store,
            capturer.clone(),
            sound.clone(),
            RecorderOptions {
                capture_keywords: vec!["雀魂".into(), "Mahjong Soul".into()],
                sound: sound_on,
            },
        );
        Fixture {
            _tmp: tmp,
            recorder,
            capturer,
            sound,
        }
    }

    fn fixture() -> Fixture {
        fixture_with(FakeCapturer::ok(FAKE_PNG), true)
    }

    fn session_dir(f: &Fixture) -> PathBuf {
        let id = f.recorder.state().session_id.unwrap();
        f.recorder.data_dir().join(GAMES_DIR).join(id)
    }

    fn read_events(f: &Fixture) -> Vec<Event> {
        fs::read_to_string(session_dir(f).join(EVENTS_FILE))
            .unwrap()
            .lines()
            .map(|l| serde_json::from_str(l).unwrap())
            .collect()
    }

    fn all_files(dir: &Path, out: &mut Vec<PathBuf>) {
        for entry in fs::read_dir(dir).unwrap() {
            let path = entry.unwrap().path();
            if path.is_dir() {
                all_files(&path, out);
            } else {
                out.push(path);
            }
        }
    }

    #[test]
    fn w1_a_trigger_makes_one_record_with_a_millisecond_time_and_one_png() {
        let mut f = fixture();
        let state = f.recorder.mark(T0).unwrap();
        assert_eq!(state.mark_count, 1);

        let marks: Vec<Event> = read_events(&f)
            .into_iter()
            .filter(|e| matches!(e.kind, EventKind::Mark { .. }))
            .collect();
        assert_eq!(marks.len(), 1, "記録は 1 件");
        assert_eq!(marks[0].t_ms, T0, "ミリ秒まで入る");

        let pngs: Vec<_> = fs::read_dir(session_dir(&f).join(MARKS_DIR))
            .unwrap()
            .map(|e| e.unwrap().path())
            .collect();
        assert_eq!(pngs.len(), 1, "画像は 1 枚");
        assert_eq!(fs::read(&pngs[0]).unwrap(), FAKE_PNG);
        assert_eq!(f.capturer.call_count(), 1, "撮るのは 1 回");
    }

    #[test]
    fn w1_every_trigger_adds_exactly_one_record_and_one_png() {
        let mut f = fixture();
        for i in 0..5 {
            f.recorder.mark(T0 + i * 1_000).unwrap();
        }
        let marks = read_events(&f)
            .into_iter()
            .filter(|e| matches!(e.kind, EventKind::Mark { .. }))
            .count();
        assert_eq!(marks, 5);
        let pngs = fs::read_dir(session_dir(&f).join(MARKS_DIR))
            .unwrap()
            .count();
        assert_eq!(pngs, 5);
        assert_eq!(f.capturer.call_count(), 5);
    }

    #[test]
    fn w1_the_capture_uses_the_configured_keywords() {
        let mut f = fixture();
        f.recorder.mark(T0).unwrap();
        assert_eq!(
            f.capturer.calls.lock().unwrap()[0],
            vec!["雀魂".to_string(), "Mahjong Soul".to_string()]
        );
        f.recorder.set_options(RecorderOptions {
            capture_keywords: vec!["別の語".into()],
            sound: true,
        });
        f.recorder.mark(T0 + 1).unwrap();
        assert_eq!(
            f.capturer.calls.lock().unwrap()[1],
            vec!["別の語".to_string()]
        );
    }

    #[test]
    fn w1_a_failing_capture_still_records_the_mark() {
        let mut f = fixture_with(FakeCapturer::failing("撮れません"), true);
        let state = f.recorder.mark(T0).unwrap();
        assert_eq!(state.mark_count, 1);
        let events = read_events(&f);
        let EventKind::Mark {
            screenshot,
            capture_error,
            ..
        } = &events.last().unwrap().kind
        else {
            panic!("最後はマークのはず");
        };
        assert_eq!(*screenshot, None);
        assert_eq!(capture_error.as_deref(), Some("撮れません"));
    }

    #[test]
    fn w1_w2_the_hook_pipeline_records_one_mark_per_assigned_button_press_only() {
        // フックの判定（InputCore）が返した合図だけを記録に回す、実機と同じつなぎ方。
        let mut f = fixture();
        let core = InputCore::new();
        core.set_config(Config {
            trigger: Some(ActiveTrigger::Mouse(MouseButton::X1)),
            mode: Mode::Normal,
        });
        let inputs = [
            (InputEvent::MouseDown(MouseButton::Left), 1_000),
            (InputEvent::MouseUp(MouseButton::Left), 1_050),
            (InputEvent::MouseDown(MouseButton::X1), 2_000),
            (InputEvent::MouseUp(MouseButton::X1), 2_080),
            (InputEvent::MouseDown(MouseButton::X2), 3_000),
            (InputEvent::MouseDown(MouseButton::X1), 4_000),
            (InputEvent::MouseUp(MouseButton::X1), 4_090),
            (InputEvent::KeyDown(0x41), 5_000),
        ];
        let mut swallowed = Vec::new();
        for (event, offset) in inputs {
            let outcome = core.process(event, || Modifiers::NONE, T0 + offset);
            swallowed.push(outcome.swallow);
            if let Some(Report::Trigger { t_ms }) = outcome.report {
                f.recorder.mark(t_ms).unwrap();
            }
        }
        assert_eq!(
            swallowed,
            vec![false, false, true, true, false, true, true, false]
        );
        let times: Vec<i64> = read_events(&f)
            .into_iter()
            .filter(|e| matches!(e.kind, EventKind::Mark { .. }))
            .map(|e| e.t_ms)
            .collect();
        assert_eq!(times, vec![T0 + 2_000, T0 + 4_000]);
    }

    #[test]
    fn marks_play_the_tick_only_when_sound_is_on() {
        let mut on = fixture_with(FakeCapturer::ok(FAKE_PNG), true);
        on.recorder.mark(T0).unwrap();
        on.recorder.mark(T0 + 1).unwrap();
        assert_eq!(on.sound.count(), 2);

        let mut off = fixture_with(FakeCapturer::ok(FAKE_PNG), false);
        off.recorder.mark(T0).unwrap();
        assert_eq!(off.sound.count(), 0);
    }

    #[test]
    fn ratings_play_no_tick_and_undo_and_new_session_do_not_capture_the_screen() {
        let mut f = fixture();
        f.recorder.rate(T0, Rating::Good).unwrap();
        assert_eq!(f.capturer.call_count(), 1, "評価は画面を 1 回撮る（W-13）");
        f.recorder.undo(T0 + 1).unwrap();
        f.recorder.new_session(T0 + 2).unwrap();
        assert_eq!(
            f.sound.count(),
            0,
            "評価・取り消し・新しい半荘では音を鳴らさない"
        );
        assert_eq!(f.capturer.call_count(), 1, "取り消しと新しい半荘は撮らない");
    }

    #[test]
    fn w13_a_rating_also_saves_a_screenshot_with_the_same_capture_path_as_a_mark() {
        let mut f = fixture();
        f.recorder.rate(T0, Rating::Fair).unwrap();
        f.recorder.mark(T0 + 1).unwrap();
        // 撮るのは、迷いマークと同じ取得元・同じ窓を探す語。
        let calls = f.capturer.calls.lock().unwrap().clone();
        assert_eq!(calls.len(), 2);
        assert_eq!(calls[0], calls[1]);
        assert_eq!(
            calls[0],
            vec!["雀魂".to_string(), "Mahjong Soul".to_string()]
        );

        let events = read_events(&f);
        let rating = events
            .iter()
            .find_map(|e| match &e.kind {
                EventKind::Rating {
                    screenshot,
                    capture,
                    capture_error,
                    ..
                } => Some((screenshot.clone(), *capture, capture_error.clone(), e.t_ms)),
                _ => None,
            })
            .expect("評価の記録がある");
        let (screenshot, capture, capture_error, t_ms) = rating;
        assert_eq!(t_ms, T0);
        assert_eq!(capture_error, None);
        assert!(capture.is_some());
        let relative = screenshot.expect("評価の記録に画像のパスが入る");
        assert!(
            relative.starts_with("ratings/") && relative.ends_with(".png"),
            "{relative}"
        );
        assert_eq!(fs::read(session_dir(&f).join(&relative)).unwrap(), FAKE_PNG);
    }

    #[test]
    fn w13_a_rating_is_kept_even_when_the_screen_cannot_be_captured() {
        let mut f = fixture_with(FakeCapturer::failing("撮れません"), true);
        let state = f.recorder.rate(T0, Rating::Bad).unwrap();
        assert_eq!(state.ratings, vec![Rating::Bad]);
        let events = read_events(&f);
        let EventKind::Rating {
            screenshot,
            capture_error,
            ..
        } = &events.last().unwrap().kind
        else {
            panic!("最後は評価のはず");
        };
        assert_eq!(*screenshot, None);
        assert_eq!(capture_error.as_deref(), Some("撮れません"));
    }

    #[test]
    fn w3_w8_state_follows_ratings_marks_and_undo() {
        let mut f = fixture();
        assert_eq!(f.recorder.state().next_hand, 1);
        assert!(!f.recorder.state().can_undo);
        f.recorder.rate(T0, Rating::Good).unwrap();
        f.recorder.mark(T0 + 1).unwrap();
        let state = f.recorder.rate(T0 + 2, Rating::Bad).unwrap();
        assert_eq!(state.mark_count, 1);
        assert_eq!(state.ratings, vec![Rating::Good, Rating::Bad]);
        assert_eq!(state.next_hand, 3);
        assert!(state.can_undo);
        let state = f.recorder.undo(T0 + 3).unwrap();
        assert_eq!(state.ratings, vec![Rating::Good]);
        assert_eq!(state.next_hand, 2);
        assert_eq!(state.mark_count, 1);
    }

    #[test]
    fn w6_new_session_resets_the_counters() {
        let mut f = fixture();
        f.recorder.rate(T0, Rating::Good).unwrap();
        f.recorder.mark(T0 + 1).unwrap();
        let state = f.recorder.new_session(T0 + 2).unwrap();
        assert_eq!(
            state.session_id, None,
            "閉じたあとは、次の記録まで半荘が無い"
        );
        assert_eq!(state.mark_count, 0);
        assert_eq!(state.next_hand, 1);
        assert!(!state.can_undo);
        // 次の記録が、新しい半荘を始める。
        let before = f.recorder.state();
        assert_eq!(before.session_id, None);
        let state = f.recorder.mark(T0 + 5_000).unwrap();
        assert_eq!(state.mark_count, 1);
        assert!(state.session_id.is_some());
    }

    #[test]
    fn w14_a_new_session_creates_no_folder_until_something_is_recorded() {
        let mut f = fixture();
        let games = f.recorder.data_dir().join(GAMES_DIR);
        f.recorder.new_session(T0).unwrap();
        f.recorder.new_session(T0).unwrap();
        assert_eq!(fs::read_dir(&games).unwrap().count(), 0);
        f.recorder.rate(T0, Rating::Good).unwrap();
        assert_eq!(fs::read_dir(&games).unwrap().count(), 1);
        f.recorder.new_session(T0 + 1).unwrap();
        f.recorder.new_session(T0 + 1).unwrap();
        assert_eq!(
            fs::read_dir(&games).unwrap().count(),
            1,
            "空の半荘は残らない"
        );
        assert_eq!(f.recorder.list_sessions().unwrap().len(), 1);
    }

    #[test]
    fn w14_a_record_more_than_30_minutes_after_the_previous_one_goes_to_a_new_session() {
        let mut f = fixture();
        f.recorder.mark(T0).unwrap();
        let first = f.recorder.state().session_id.unwrap();
        let within = f.recorder.mark(T0 + 29 * 60 * 1000).unwrap();
        assert_eq!(within.session_id.as_deref(), Some(first.as_str()));
        let after = f
            .recorder
            .rate(T0 + 29 * 60 * 1000 + 30 * 60 * 1000 + 1, Rating::Good)
            .unwrap();
        assert_ne!(after.session_id.unwrap(), first);
        assert_eq!(after.mark_count, 0, "新しい半荘の数字は 0 から");
        assert_eq!(after.ratings, vec![Rating::Good]);
        let sessions = f.recorder.list_sessions().unwrap();
        assert_eq!(sessions.len(), 2);
    }

    #[test]
    fn s4_widget_operations_only_write_the_log_and_images_inside_the_data_dir() {
        let mut f = fixture();
        f.recorder.mark(T0).unwrap();
        f.recorder.rate(T0 + 1, Rating::Fair).unwrap();
        f.recorder.undo(T0 + 2).unwrap();
        f.recorder.new_session(T0 + 3).unwrap();
        f.recorder.mark(T0 + 3_001).unwrap();

        let root = f.recorder.data_dir().to_path_buf();
        let mut files = Vec::new();
        all_files(&root, &mut files);
        assert!(!files.is_empty());
        for file in files {
            let rel = file.strip_prefix(&root).unwrap();
            let parts: Vec<_> = rel
                .components()
                .map(|c| c.as_os_str().to_string_lossy().into_owned())
                .collect();
            let is_log = parts.len() == 3 && parts[0] == GAMES_DIR && parts[2] == EVENTS_FILE;
            let is_image = parts.len() == 4
                && parts[0] == GAMES_DIR
                && (parts[2] == MARKS_DIR || parts[2] == RATINGS_DIR)
                && parts[3].ends_with(".png");
            assert!(is_log || is_image, "想定外のファイル: {}", rel.display());
        }
        // 保存先の直下には games しか無い。
        let top: Vec<_> = fs::read_dir(&root)
            .unwrap()
            .map(|e| e.unwrap().file_name().to_string_lossy().into_owned())
            .collect();
        assert_eq!(top, vec![GAMES_DIR.to_string()]);
    }
}
