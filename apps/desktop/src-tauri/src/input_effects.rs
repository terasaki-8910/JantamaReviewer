//! 入力の流れ（`input_flow`）が決めた「やること」を、実機で実行する側。
//!
//! 本体の中のフックを設定する、補助プログラムに指示を送る、迷いマークを記録する、登録された入力を設定に保存する、
//! 登録の時間切れを知らせる、画面に状態を知らせる。判断はここでは行わない（`input_flow` の純粋な部分が行う）。

use std::sync::mpsc::Sender;
use std::sync::Arc;
use std::thread;

use jantama_input::logic::Config;
use jantama_input::protocol::ToHelper;
use tauri::{AppHandle, Emitter, Manager, Runtime};

use crate::commands::{self, SharedCore};
use crate::input_flow::{Effect, Effects, Input, InputStatus, REGISTRATION_TIMEOUT};
use crate::platform::{self, HelperHost, InputHook};
use crate::settings::Trigger;

/// 入力の状態が変わったときに全部の窓へ送るイベント。
pub const EVENT_INPUT_STATUS: &str = "input-status-changed";

pub struct TauriEffects<R: Runtime> {
    app: AppHandle<R>,
    /// 本体のフックのスレッド。起こせなかったときは `None`（この OS にフックが無いときも）。
    hook: Option<Box<dyn InputHook>>,
    helper: Arc<dyn HelperHost>,
    /// 入力の流れに入力を戻す口（時間切れ・保存の失敗の知らせ）。
    feedback: Sender<Input>,
}

impl<R: Runtime> TauriEffects<R> {
    /// 本体のフックのスレッドを起こして、やることを実行する側を作る。
    /// フックは、最初は何も入れない。入れるのは、入力の流れが最初に決める設定のとき（`InProcessHook` を知らせる）。
    /// 割り当てたボタンの押下と登録の候補は、`feedback`（入力の流れの列）へそのまま入る。
    pub fn start(app: AppHandle<R>, helper: Arc<dyn HelperHost>, feedback: Sender<Input>) -> Self {
        let sink = feedback.clone();
        let hook = match platform::start_input_hook(move |report| {
            let _ = sink.send(Input::from(report));
        }) {
            Ok(hook) => Some(hook),
            Err(e) => {
                eprintln!("ボタンのフックを起こせませんでした: {e}");
                None
            }
        };
        let _ = feedback.send(Input::InProcessHook(hook.is_some()));
        if std::env::var_os(crate::input_flow::TRACE_ENV).is_some_and(|v| !v.is_empty()) {
            if let Some(hook) = &hook {
                hook.start_trace();
            }
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
        self.hook
            .as_ref()
            .map(|hook| hook.trace_info())
            .unwrap_or_default()
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

/// 入力の状態を、全部の窓に知らせる。
pub fn emit_status<R: Runtime>(app: &AppHandle<R>, status: &InputStatus) {
    let _ = app.emit(EVENT_INPUT_STATUS, status);
}
