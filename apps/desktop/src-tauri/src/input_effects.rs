//! 入力の流れ（`input_flow`）が決めた「やること」を、実機で実行する側。
//!
//! 本体の中のフックを設定する、補助プログラムに指示を送る、迷いマークを記録する、登録された入力を設定に保存する、
//! 登録の時間切れを知らせる、画面に状態を知らせる。判断はここでは行わない（`input_flow` の純粋な部分が行う）。

use std::sync::mpsc::Sender;
use std::thread;
use std::time::{Duration, Instant};

use jantama_input::hook_win::{self, HookHandle};
use jantama_input::logic::Config;
use jantama_input::protocol::ToHelper;
use tauri::{AppHandle, Emitter, Manager, Runtime};

use crate::commands::{self, SharedCore};
use crate::helper_link::HelperWriter;
use crate::input_flow::{Effect, Effects, Input, InputStatus, REGISTRATION_TIMEOUT};
use crate::settings::Trigger;

/// 入力の状態が変わったときに全部の窓へ送るイベント。
pub const EVENT_INPUT_STATUS: &str = "input-status-changed";

pub struct TauriEffects<R: Runtime> {
    app: AppHandle<R>,
    /// 本体のフックのスレッド。起こせなかったときは `None`。
    hook: Option<HookHandle>,
    helper: HelperWriter,
    /// 入力の流れに入力を戻す口（時間切れ・保存の失敗の知らせ）。
    feedback: Sender<Input>,
}

impl<R: Runtime> TauriEffects<R> {
    /// 本体のフックのスレッドを起こして、やることを実行する側を作る。
    /// フックは、最初は何も入れない。入れるのは、入力の流れが最初に決める設定のとき（`InProcessHook` を知らせる）。
    /// 割り当てたボタンの押下と登録の候補は、`feedback`（入力の流れの列）へそのまま入る。
    pub fn start(app: AppHandle<R>, helper: HelperWriter, feedback: Sender<Input>) -> Self {
        let sink = feedback.clone();
        let hook = match hook_win::start(Config::OFF, move |report| {
            let _ = sink.send(Input::from(report));
        }) {
            Ok((handle, _)) => Some(handle),
            Err(e) => {
                eprintln!("ボタンのフックを起こせませんでした: {e}");
                None
            }
        };
        let _ = feedback.send(Input::InProcessHook(hook.is_some()));
        if std::env::var_os(crate::input_flow::TRACE_ENV).is_some_and(|v| !v.is_empty()) {
            spawn_hook_trace();
        }
        TauriEffects {
            app,
            hook,
            helper,
            feedback,
        }
    }

    fn save_trigger(&self, candidate: jantama_input::logic::ActiveTrigger) {
        let Some(trigger) = Trigger::from_active(candidate) else {
            let _ = self.feedback.send(Input::RegistrationSaveFailed(
                "このボタンは登録できません".to_string(),
            ));
            return;
        };
        let mut settings = self.app.state::<SharedCore>().lock().settings().clone();
        settings.trigger = trigger;
        if let Err(e) = commands::set_settings_now(&self.app, settings) {
            let _ = self.feedback.send(Input::RegistrationSaveFailed(e));
        }
    }
}

impl<R: Runtime> Effects for TauriEffects<R> {
    fn trace_info(&self) -> String {
        let (keys, mouse) = hook_win::event_counts();
        format!("（フックが見た入力: キー {keys}、マウス {mouse}）")
    }

    fn run(&mut self, effect: Effect) {
        match effect {
            Effect::ConfigureInProcess(config) => {
                if let Some(hook) = &self.hook {
                    let status = hook.apply(config.unwrap_or(Config::OFF));
                    match status.error {
                        Some(problem) => {
                            eprintln!("ボタンのフックを設定できませんでした: {problem}")
                        }
                        None => eprintln!(
                            "[入力] 本体のフックを設定しました: マウス={}、キー={}",
                            status.mouse, status.keyboard
                        ),
                    }
                }
            }
            Effect::InProcessKeyboard(allowed) => {
                if let Some(hook) = &self.hook {
                    let status = hook.set_keyboard_allowed(allowed);
                    match status.error {
                        Some(problem) => {
                            eprintln!("ボタンのフックを設定できませんでした: {problem}")
                        }
                        None => eprintln!(
                            "[入力] 本体のキーボードのフックを{}: マウス={}、キー={}",
                            if allowed {
                                "戻しました"
                            } else {
                                "外しました（検討画面が前面にある間）"
                            },
                            status.mouse,
                            status.keyboard
                        ),
                    }
                }
            }
            Effect::ConfigureHelper(config) => {
                if !self.helper.send(&ToHelper::config(config)) {
                    eprintln!("補助プログラムに設定を送れませんでした");
                }
            }
            Effect::Record { t_ms } => {
                if let Err(e) = commands::mark_now(&self.app, t_ms) {
                    eprintln!("迷いマークを記録できませんでした: {e}");
                }
            }
            Effect::SaveTrigger(candidate) => self.save_trigger(candidate),
            Effect::StartTimeout { attempt } => {
                let feedback = self.feedback.clone();
                let spawned = thread::Builder::new()
                    .name("registration-timeout".to_string())
                    .spawn(move || {
                        thread::sleep(REGISTRATION_TIMEOUT);
                        let _ = feedback.send(Input::RegistrationTimeout { attempt });
                    });
                if let Err(e) = spawned {
                    eprintln!("登録の時間切れの見張りを起こせませんでした: {e}");
                }
            }
            Effect::EmitStatus(status) => emit_status(&self.app, &status),
        }
    }
}

/// 原因調べ（`TRACE_ENV`）のとき、フックが受け取ったキーボードの入力を、標準エラーに 1 つずつ出す。
/// マウスは動かすだけでも大量に来るので、数が変わったときに 1 秒に 1 回だけ出す。
fn spawn_hook_trace() {
    let spawned = thread::Builder::new()
        .name("hook-trace".to_string())
        .spawn(|| {
            let started = Instant::now();
            let mut next = 0usize;
            let mut last_mouse = 0u64;
            let mut last_mouse_print = Instant::now();
            loop {
                thread::sleep(Duration::from_millis(20));
                for note in hook_win::recent_keys(&mut next) {
                    eprintln!(
                        "[フック] キー vk=0x{:02X} flags=0x{:02X}{} 起動から {} ms（記録 {:.3} 秒）",
                        note.vk,
                        note.flags,
                        if note.flags & 0x10 != 0 { "（注入）" } else { "" },
                        note.at_ms,
                        started.elapsed().as_secs_f32()
                    );
                }
                let (_, mouse) = hook_win::event_counts();
                if mouse != last_mouse && last_mouse_print.elapsed() >= Duration::from_secs(1) {
                    eprintln!(
                        "[フック] マウス {mouse}（フックの手続きの最長 {} マイクロ秒）",
                        hook_win::max_proc_micros()
                    );
                    last_mouse = mouse;
                    last_mouse_print = Instant::now();
                }
            }
        });
    if let Err(e) = spawned {
        eprintln!("フックの記録の見張りを起こせませんでした: {e}");
    }
}

/// 入力の状態を、全部の窓に知らせる。
pub fn emit_status<R: Runtime>(app: &AppHandle<R>, status: &InputStatus) {
    let _ = app.emit(EVENT_INPUT_STATUS, status);
}
