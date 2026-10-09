//! 入力の流れ全体の状態と、その進め方（W-9、W-10、W-11）。Tauri にも OS にも依存しない、純粋な部分。
//!
//! 入力を拾う口は 2 つある。本体の中のフックと、管理者で動く補助プログラム。補助プログラムがつながって
//! フックを入れ終えている間は、本体のフックを外して、二重に数えない（`choose_hook`）。補助プログラムが無い・切れたときは、
//! 本体のフックが戻る（管理者ではない窓の上では動く）。
//!
//! 画面の操作（登録の開始・取り消し、テスト）と、2 つの口から届く入力は、すべて `Input` として 1 本の列に並べて、
//! 1 つのスレッドが `InputState::reduce` に通す。`reduce` は、状態を進めて、外に対してやること（`Effect`）を返すだけ。
//! やることの実行（フックの設定・補助プログラムへの送信・記録・設定の保存）は `Effects` の実装（input_effects.rs）が受け持つ。
//! 順番が 1 つに決まるので、ロックの取り合いも、前後の入れ替わりも起きない。

use std::sync::mpsc::{self, Sender};
use std::sync::{Arc, Mutex, PoisonError};
use std::thread::{self, JoinHandle};
use std::time::Duration;

use jantama_input::logic::{ActiveTrigger, Config, Mode, Report};
use serde::Serialize;

/// 登録の待機が、入力なしで終わるまでの時間（W-10）。
pub const REGISTRATION_TIMEOUT: Duration = Duration::from_secs(30);

/// 割り当てたボタンの押下を、続けて数えない間隔（ミリ秒）。補助プログラムがつながる瞬間に、
/// 本体のフックと補助プログラムの両方が同じ押下を拾っても、1 回に数える。人が 50 ミリ秒以内に 2 回押すことはない。
pub const TRIGGER_DEBOUNCE_MS: i64 = 50;

/// 補助プログラムとのつながり。
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum HelperLink {
    /// つながっていない。
    Absent,
    /// パイプがつながった。まだフックを入れ終えた返事が無い。
    Connected,
    /// 割り当てのフックを入れ終えて、入力を拾っている。
    Active,
}

/// どちらのフックが入力を拾うか。
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum HookChoice {
    /// 補助プログラム（管理者の権限。雀魂の上でも動く）。本体のフックは外す。
    Helper,
    /// 本体の中のフック（補助プログラムが無いとき）。
    InProcess,
}

/// 補助プログラムの状態から、どのフックを使うかを選ぶ（W-9）。
/// 補助プログラムが入力を拾っている間だけ補助プログラム。つながっただけでは、本体のフックを外さない
/// （入れ終えるまでの間、どちらも拾わない時間を作らないため）。
pub fn choose_hook(link: HelperLink) -> HookChoice {
    match link {
        HelperLink::Active => HookChoice::Helper,
        HelperLink::Absent | HelperLink::Connected => HookChoice::InProcess,
    }
}

/// 割り当てを登録する手続きの状態（W-10）。
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum Registration {
    Idle,
    /// 最初の入力を待っている。`attempt` は、何回目の登録か（古い時間切れを見分ける）。
    Waiting {
        attempt: u64,
    },
}

/// 補助プログラムの設定・解除・起動のうち、いま進めているもの。
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize)]
#[serde(rename_all = "snake_case")]
pub enum HelperOp {
    Installing,
    Removing,
    Starting,
}

/// 2 つの口それぞれに、いま渡している設定。`None` は、その口を使わない。
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub struct Plan {
    /// 本体のフック。`None` なら、フックを外す。
    pub in_process: Option<Config>,
    /// 補助プログラム。`None` なら、送る相手が居ない。
    pub helper: Option<Config>,
}

/// 状態を進める入力。
#[derive(Debug, Clone, PartialEq, Eq)]
pub enum Input {
    // ---- 補助プログラムとのつながり ----
    /// パイプがつながり、補助プログラムが挨拶した。
    HelperConnected,
    /// 補助プログラムが、受け取った設定のフックを入れ終えた。
    HelperReady,
    /// 補助プログラムが、受け取った設定のフックを入れられなかった（つながりは続く）。
    HelperFailed(String),
    /// つながりが切れた。
    HelperLost,
    // ---- 拾った入力（どちらの口からも） ----
    /// 割り当てたボタンが押された。
    Trigger {
        t_ms: i64,
    },
    /// 登録の待機中に、候補の入力が押された。
    Captured(ActiveTrigger),
    /// 登録の待機中に Esc が押された。
    CancelKey,
    // ---- 画面の操作 ----
    StartRegistration,
    CancelRegistration,
    /// 登録の待機の時間切れ（古い待機のものは無視する）。
    RegistrationTimeout {
        attempt: u64,
    },
    /// 設定ページのテストの欄を見せているか。
    ProbeWanted(bool),
    /// 検討画面の窓が、操作を受ける状態か。
    WindowFocus(bool),
    // ---- 設定 ----
    /// 設定の割り当てが変わった（登録で変わったときも、設定ページから変わったときも）。
    TriggerChanged(Option<ActiveTrigger>),
    /// 登録で拾った入力を、設定に保存できなかった。
    RegistrationSaveFailed(String),
    // ---- 補助プログラムの設定・解除・起動 ----
    /// 起動の登録（タスク）があるかを、確かめた。
    InstalledKnown(bool),
    HelperOpStarted(HelperOp),
    HelperOpFinished {
        result: Result<(), String>,
    },
    /// 本体のフックのスレッドを起こせたか（起動時に 1 度）。
    InProcessHook(bool),
}

impl From<Report> for Input {
    fn from(report: Report) -> Input {
        match report {
            Report::Trigger { t_ms } => Input::Trigger { t_ms },
            Report::Captured(trigger) => Input::Captured(trigger),
            Report::Cancel => Input::CancelKey,
        }
    }
}

/// 外に対してやること。
#[derive(Debug, Clone, PartialEq, Eq)]
pub enum Effect {
    /// 本体のフックの設定を変える。`None` は、フックを外す。
    ConfigureInProcess(Option<Config>),
    /// 補助プログラムに設定を送る。
    ConfigureHelper(Config),
    /// 迷いマークを記録する（W-1）。
    Record { t_ms: i64 },
    /// 登録で拾った入力を、設定に保存する（W-10）。
    SaveTrigger(ActiveTrigger),
    /// 登録の待機の時間切れを、`REGISTRATION_TIMEOUT` のあとに知らせる。
    StartTimeout { attempt: u64 },
    /// 画面に、新しい状態を知らせる。
    EmitStatus(InputStatus),
}

/// どのフックが入力を拾っているか（画面に出す）。
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize)]
#[serde(rename_all = "snake_case")]
pub enum HookSource {
    Helper,
    InProcess,
    /// 拾う口が無い（本体のフックを入れられず、補助プログラムも動いていない）。
    None,
}

/// 補助プログラムの状態（画面に出す）。
#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
pub struct HelperStatus {
    /// 起動の登録（タスク）があるか。まだ確かめていなければ `None`。
    pub installed: Option<bool>,
    /// 動いている（つながって、入力を拾っている）。
    pub running: bool,
    /// 設定・解除・起動の途中なら、そのこと。
    pub busy: Option<HelperOp>,
    /// 直前の設定・解除・起動、またはフックの設定の失敗の理由。
    pub error: Option<String>,
}

/// 画面（設定ページ）に出す、入力の状態。
#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
pub struct InputStatus {
    /// ボタンの登録の待機中か。
    pub registering: bool,
    /// テストの欄に出す、最後に受け取った時刻（ミリ秒）。まだ受け取っていなければ `None`。
    pub probe_ms: Option<i64>,
    pub hook: HookSource,
    pub helper: HelperStatus,
    /// 登録の開始・保存の失敗など、画面に伝えたいこと。
    pub message: Option<String>,
}

/// 入力の流れの状態。
#[derive(Debug)]
pub struct InputState {
    link: HelperLink,
    helper_error: Option<String>,
    in_process_available: bool,
    trigger: Option<ActiveTrigger>,
    registration: Registration,
    attempts: u64,
    probe_wanted: bool,
    window_focused: bool,
    probe_ms: Option<i64>,
    last_trigger_ms: Option<i64>,
    installed: Option<bool>,
    op: Option<HelperOp>,
    op_error: Option<String>,
    message: Option<String>,
    applied: Plan,
    emitted: Option<InputStatus>,
}

impl InputState {
    /// 起動時の状態。`trigger` は、設定にある割り当て。
    pub fn new(trigger: Option<ActiveTrigger>) -> InputState {
        InputState {
            link: HelperLink::Absent,
            helper_error: None,
            in_process_available: false,
            trigger,
            registration: Registration::Idle,
            attempts: 0,
            probe_wanted: false,
            window_focused: false,
            probe_ms: None,
            last_trigger_ms: None,
            installed: None,
            op: None,
            op_error: None,
            message: None,
            applied: Plan {
                in_process: None,
                helper: None,
            },
            emitted: None,
        }
    }

    pub fn link(&self) -> HelperLink {
        self.link
    }

    pub fn registration(&self) -> Registration {
        self.registration
    }

    /// いまの扱い方。登録の待機中は登録、テストの欄を見ている間はテスト、そうでなければ通常（W-10、W-11）。
    /// テストの欄は、検討画面の窓が操作を受けているときだけ（見ていない間、雀魂を打ちながら迷いマークが
    /// 記録されなくなるのを防ぐ。窓を開いたままにしていても、雀魂に切り替えれば通常に戻る）。
    pub fn mode(&self) -> Mode {
        match self.registration {
            Registration::Waiting { .. } => Mode::Register,
            Registration::Idle if self.probe_wanted && self.window_focused => Mode::Test,
            Registration::Idle => Mode::Normal,
        }
    }

    /// 2 つの口それぞれに渡す設定。
    pub fn plan(&self) -> Plan {
        let config = Config {
            trigger: self.trigger,
            mode: self.mode(),
        };
        Plan {
            in_process: (self.in_process_available
                && choose_hook(self.link) == HookChoice::InProcess)
                .then_some(config),
            helper: (self.link != HelperLink::Absent).then_some(config),
        }
    }

    /// 割り当てを登録するための、入力を拾う口があるか。
    fn can_capture(&self) -> bool {
        self.link == HelperLink::Active || self.in_process_available
    }

    /// 画面に出す状態。
    pub fn status(&self) -> InputStatus {
        let hook = match choose_hook(self.link) {
            HookChoice::Helper => HookSource::Helper,
            HookChoice::InProcess if self.in_process_available => HookSource::InProcess,
            HookChoice::InProcess => HookSource::None,
        };
        InputStatus {
            registering: matches!(self.registration, Registration::Waiting { .. }),
            probe_ms: self.probe_ms,
            hook,
            helper: HelperStatus {
                installed: self.installed,
                running: self.link == HelperLink::Active,
                busy: self.op,
                error: self.op_error.clone().or_else(|| self.helper_error.clone()),
            },
            message: self.message.clone(),
        }
    }

    /// 入力 1 つで状態を進め、外に対してやることを返す。
    pub fn reduce(&mut self, input: Input) -> Vec<Effect> {
        let mut effects = Vec::new();
        match input {
            Input::HelperConnected => {
                self.link = HelperLink::Connected;
                self.helper_error = None;
            }
            Input::HelperReady => {
                if self.link != HelperLink::Absent {
                    self.link = HelperLink::Active;
                    self.helper_error = None;
                }
            }
            Input::HelperFailed(reason) => {
                if self.link != HelperLink::Absent {
                    // 入力を拾えていないので、本体のフックを戻す。
                    self.link = HelperLink::Connected;
                    self.helper_error = Some(reason);
                }
            }
            Input::HelperLost => {
                self.link = HelperLink::Absent;
            }
            Input::Trigger { t_ms } => {
                let repeated = self
                    .last_trigger_ms
                    .is_some_and(|prev| (0..TRIGGER_DEBOUNCE_MS).contains(&(t_ms - prev)));
                if !repeated {
                    self.last_trigger_ms = Some(t_ms);
                    match self.mode() {
                        Mode::Normal => effects.push(Effect::Record { t_ms }),
                        // テストの間は、記録しない。受け取ったことだけを画面に知らせる（W-11）。
                        Mode::Test => self.probe_ms = Some(t_ms),
                        Mode::Register => {}
                    }
                }
            }
            Input::Captured(candidate) => {
                if matches!(self.registration, Registration::Waiting { .. })
                    && candidate.registrable()
                {
                    self.registration = Registration::Idle;
                    self.probe_ms = None;
                    self.message = None;
                    effects.push(Effect::SaveTrigger(candidate));
                }
            }
            Input::CancelKey | Input::CancelRegistration => {
                self.registration = Registration::Idle;
            }
            Input::StartRegistration => {
                if self.can_capture() {
                    self.attempts += 1;
                    self.registration = Registration::Waiting {
                        attempt: self.attempts,
                    };
                    self.probe_ms = None;
                    self.message = None;
                    effects.push(Effect::StartTimeout {
                        attempt: self.attempts,
                    });
                } else {
                    self.message = Some(
                        "ボタンを拾う仕組みが動いていません。補助プログラムを設定するか、アプリを開き直してください"
                            .to_string(),
                    );
                }
            }
            Input::RegistrationTimeout { attempt } => {
                if self.registration == (Registration::Waiting { attempt }) {
                    self.registration = Registration::Idle;
                }
            }
            Input::ProbeWanted(wanted) => {
                self.probe_wanted = wanted;
                if !wanted {
                    self.probe_ms = None;
                }
            }
            Input::WindowFocus(focused) => {
                self.window_focused = focused;
                if !focused {
                    self.probe_ms = None;
                }
            }
            Input::TriggerChanged(trigger) => {
                self.trigger = trigger;
            }
            Input::RegistrationSaveFailed(reason) => {
                self.message = Some(reason);
            }
            Input::InstalledKnown(installed) => {
                self.installed = Some(installed);
            }
            Input::HelperOpStarted(op) => {
                self.op = Some(op);
                self.op_error = None;
            }
            Input::HelperOpFinished { result } => {
                self.op = None;
                self.op_error = result.err();
            }
            Input::InProcessHook(available) => {
                self.in_process_available = available;
            }
        }
        self.settle(&mut effects);
        effects
    }

    /// 入力を処理したあとに、2 つの口の設定を合わせ、画面に知らせる状態が変わっていれば知らせる。
    fn settle(&mut self, effects: &mut Vec<Effect>) {
        let plan = self.plan();
        if plan.in_process != self.applied.in_process {
            effects.push(Effect::ConfigureInProcess(plan.in_process));
        }
        if plan.helper != self.applied.helper {
            if let Some(config) = plan.helper {
                effects.push(Effect::ConfigureHelper(config));
            }
        }
        self.applied = plan;
        let status = self.status();
        if self.emitted.as_ref() != Some(&status) {
            self.emitted = Some(status.clone());
            effects.push(Effect::EmitStatus(status));
        }
    }
}

/// `Effect` を実行する側。実機では Tauri・フック・パイプにつなぎ、試験では記録するだけの偽物を入れる。
pub trait Effects: Send + 'static {
    fn run(&mut self, effect: Effect);
}

/// 入力の流れの窓口。どのスレッドからでも `send` で入力を渡せる（すぐ返る）。
#[derive(Clone)]
pub struct InputService {
    tx: Sender<Input>,
    state: Arc<Mutex<InputState>>,
}

impl InputService {
    /// 入力を列に入れる。処理は、専用のスレッドが順番に行う。
    pub fn send(&self, input: Input) {
        let _ = self.tx.send(input);
    }

    /// いまの状態（画面に出すもの）。
    pub fn status(&self) -> InputStatus {
        self.state
            .lock()
            .unwrap_or_else(PoisonError::into_inner)
            .status()
    }

    /// 入力を渡す口だけを取り出す（フックの手続きや、パイプを読むスレッドに持たせる）。
    pub fn sender(&self) -> Sender<Input> {
        self.tx.clone()
    }
}

/// 入力を順番に処理するスレッドを起こす。`make_effects` には、入力を渡す口が渡される
/// （フックの手続きや、時間切れの知らせが、そこへ入力を送る）。
/// `InputService` が（`sender` の分も含めて）すべて無くなると、スレッドは終わる。
pub fn spawn_service<E: Effects>(
    initial: InputState,
    make_effects: impl FnOnce(Sender<Input>) -> E,
) -> (InputService, JoinHandle<()>) {
    let (tx, rx) = mpsc::channel::<Input>();
    let mut effects = make_effects(tx.clone());
    let state = Arc::new(Mutex::new(initial));
    let worker_state = Arc::clone(&state);
    let handle = thread::Builder::new()
        .name("input-flow".to_string())
        .spawn(move || {
            for input in rx {
                let produced = worker_state
                    .lock()
                    .unwrap_or_else(PoisonError::into_inner)
                    .reduce(input);
                for effect in produced {
                    effects.run(effect);
                }
            }
        })
        .expect("入力の流れのスレッドを起こせる");
    (InputService { tx, state }, handle)
}

#[cfg(test)]
mod tests {
    use jantama_input::keys::Modifiers;
    use jantama_input::logic::MouseButton;

    use super::*;

    const X1: ActiveTrigger = ActiveTrigger::Mouse(MouseButton::X1);
    const X2: ActiveTrigger = ActiveTrigger::Mouse(MouseButton::X2);
    const T0: i64 = 1_760_000_000_000;

    fn f13() -> ActiveTrigger {
        ActiveTrigger::key(0x7C, Modifiers::NONE)
    }

    fn ctrl_alt_m() -> ActiveTrigger {
        ActiveTrigger::key(0x4D, Modifiers::new(true, true, false, false))
    }

    /// 起動して、本体のフックを入れた状態（割り当ては X1）。
    fn started() -> InputState {
        let mut state = InputState::new(Some(X1));
        state.reduce(Input::InProcessHook(true));
        state
    }

    fn cfg(trigger: Option<ActiveTrigger>, mode: Mode) -> Config {
        Config { trigger, mode }
    }

    fn without_status(effects: Vec<Effect>) -> Vec<Effect> {
        effects
            .into_iter()
            .filter(|e| !matches!(e, Effect::EmitStatus(_)))
            .collect()
    }

    // ---- W-9: どちらのフックを使うか ----

    #[test]
    fn w9_the_helper_is_chosen_only_while_it_is_actively_catching_input() {
        assert_eq!(choose_hook(HelperLink::Absent), HookChoice::InProcess);
        assert_eq!(choose_hook(HelperLink::Connected), HookChoice::InProcess);
        assert_eq!(choose_hook(HelperLink::Active), HookChoice::Helper);
    }

    #[test]
    fn w9_without_a_helper_the_in_process_hook_catches_input() {
        let state = started();
        let plan = state.plan();
        assert_eq!(plan.in_process, Some(cfg(Some(X1), Mode::Normal)));
        assert_eq!(plan.helper, None);
        assert_eq!(state.status().hook, HookSource::InProcess);
        assert!(!state.status().helper.running);
    }

    #[test]
    fn w9_startup_installs_the_in_process_hook() {
        let mut state = InputState::new(Some(X1));
        let effects = state.reduce(Input::InProcessHook(true));
        assert!(effects.contains(&Effect::ConfigureInProcess(Some(cfg(
            Some(X1),
            Mode::Normal
        )))));
        // 起こせなかったときは、何も入れず、拾う口が無いと画面に出す。
        let mut broken = InputState::new(Some(X1));
        let effects = broken.reduce(Input::InProcessHook(false));
        assert!(!effects
            .iter()
            .any(|e| matches!(e, Effect::ConfigureInProcess(_))));
        assert_eq!(broken.status().hook, HookSource::None);
    }

    #[test]
    fn w9_when_the_helper_connects_it_gets_the_configuration_and_the_in_process_hook_stays_until_it_is_ready(
    ) {
        let mut state = started();
        let effects = state.reduce(Input::HelperConnected);
        assert_eq!(
            without_status(effects),
            vec![Effect::ConfigureHelper(cfg(Some(X1), Mode::Normal))]
        );
        // まだ入れ終えた返事が無いので、本体のフックはそのまま（どちらも拾わない時間を作らない）。
        assert_eq!(state.plan().in_process, Some(cfg(Some(X1), Mode::Normal)));
        assert_eq!(state.link(), HelperLink::Connected);
    }

    #[test]
    fn w9_while_the_helper_is_active_the_in_process_hook_is_removed_so_nothing_is_counted_twice() {
        let mut state = started();
        state.reduce(Input::HelperConnected);
        let effects = state.reduce(Input::HelperReady);
        assert_eq!(
            without_status(effects),
            vec![Effect::ConfigureInProcess(None)]
        );
        let plan = state.plan();
        assert_eq!(plan.in_process, None);
        assert_eq!(plan.helper, Some(cfg(Some(X1), Mode::Normal)));
        let status = state.status();
        assert_eq!(status.hook, HookSource::Helper);
        assert!(status.helper.running);
    }

    #[test]
    fn w9_when_the_helper_disconnects_the_in_process_hook_comes_back() {
        let mut state = started();
        state.reduce(Input::HelperConnected);
        state.reduce(Input::HelperReady);
        let effects = state.reduce(Input::HelperLost);
        assert_eq!(
            without_status(effects),
            vec![Effect::ConfigureInProcess(Some(cfg(
                Some(X1),
                Mode::Normal
            )))]
        );
        assert_eq!(state.status().hook, HookSource::InProcess);
        assert!(!state.status().helper.running);
        // もう一度つながったら、設定をもう一度送る（前のつながりの設定は、相手と一緒に無くなっている）。
        let effects = state.reduce(Input::HelperConnected);
        assert!(effects.contains(&Effect::ConfigureHelper(cfg(Some(X1), Mode::Normal))));
    }

    #[test]
    fn w9_if_the_helper_cannot_install_its_hooks_the_in_process_hook_is_kept_or_restored() {
        let mut state = started();
        state.reduce(Input::HelperConnected);
        let effects = state.reduce(Input::HelperFailed("フックを入れられません".into()));
        assert_eq!(state.link(), HelperLink::Connected);
        assert!(effects
            .iter()
            .all(|e| !matches!(e, Effect::ConfigureInProcess(None))));
        assert_eq!(state.plan().in_process, Some(cfg(Some(X1), Mode::Normal)));
        assert_eq!(
            state.status().helper.error.as_deref(),
            Some("フックを入れられません")
        );
        // 後の設定で入れられたら、補助プログラムに戻る。
        state.reduce(Input::HelperReady);
        assert_eq!(state.link(), HelperLink::Active);
        assert_eq!(state.status().helper.error, None);
        // 動いている最中に、あとの設定で失敗したら、本体のフックを戻す。
        let effects = state.reduce(Input::HelperFailed("あとの設定で失敗".into()));
        assert!(effects.contains(&Effect::ConfigureInProcess(Some(cfg(
            Some(X1),
            Mode::Normal
        )))));
    }

    #[test]
    fn w9_a_stray_ready_or_failure_without_a_connection_is_ignored() {
        let mut state = started();
        state.reduce(Input::HelperReady);
        assert_eq!(state.link(), HelperLink::Absent);
        state.reduce(Input::HelperFailed("x".into()));
        assert_eq!(state.link(), HelperLink::Absent);
        assert_eq!(state.status().helper.error, None);
    }

    #[test]
    fn w9_changes_of_the_assignment_reach_whichever_side_is_in_charge() {
        let mut state = started();
        let effects = state.reduce(Input::TriggerChanged(Some(X2)));
        assert_eq!(
            without_status(effects),
            vec![Effect::ConfigureInProcess(Some(cfg(
                Some(X2),
                Mode::Normal
            )))]
        );
        state.reduce(Input::HelperConnected);
        state.reduce(Input::HelperReady);
        let effects = state.reduce(Input::TriggerChanged(Some(f13())));
        assert_eq!(
            without_status(effects),
            vec![Effect::ConfigureHelper(cfg(Some(f13()), Mode::Normal))]
        );
    }

    #[test]
    fn w9_nothing_is_resent_when_the_plan_did_not_change() {
        let mut state = started();
        assert!(without_status(state.reduce(Input::TriggerChanged(Some(X1)))).is_empty());
        state.reduce(Input::HelperConnected);
        state.reduce(Input::HelperReady);
        assert!(without_status(state.reduce(Input::HelperReady)).is_empty());
        assert!(without_status(state.reduce(Input::ProbeWanted(false))).is_empty());
    }

    #[test]
    fn w9_a_press_counted_by_both_sides_while_the_helper_takes_over_is_recorded_once() {
        let mut state = started();
        let first = state.reduce(Input::Trigger { t_ms: T0 });
        assert!(first.contains(&Effect::Record { t_ms: T0 }));
        // 同じ押下を、もう一方の口も拾って、数ミリ秒あとに届いた。
        let second = state.reduce(Input::Trigger { t_ms: T0 + 3 });
        assert!(!second.iter().any(|e| matches!(e, Effect::Record { .. })));
        // 別の押下（50 ミリ秒以上あとの）は、記録する。
        let third = state.reduce(Input::Trigger { t_ms: T0 + 400 });
        assert!(third.contains(&Effect::Record { t_ms: T0 + 400 }));
    }

    // ---- W-11: テスト ----

    #[test]
    fn w11_in_normal_mode_a_press_is_recorded() {
        let mut state = started();
        let effects = state.reduce(Input::Trigger { t_ms: T0 });
        assert_eq!(state.mode(), Mode::Normal);
        assert_eq!(without_status(effects), vec![Effect::Record { t_ms: T0 }]);
    }

    #[test]
    fn w11_while_testing_a_press_records_nothing_and_only_tells_the_screen() {
        let mut state = started();
        state.reduce(Input::ProbeWanted(true));
        state.reduce(Input::WindowFocus(true));
        assert_eq!(state.mode(), Mode::Test);
        let effects = state.reduce(Input::Trigger { t_ms: T0 });
        assert!(
            !effects.iter().any(|e| matches!(e, Effect::Record { .. })),
            "記録は増えない"
        );
        assert_eq!(state.status().probe_ms, Some(T0));
        assert!(effects
            .iter()
            .any(|e| matches!(e, Effect::EmitStatus(s) if s.probe_ms == Some(T0))));
    }

    #[test]
    fn w11_the_test_is_only_on_while_the_settings_page_is_shown_and_the_window_has_focus() {
        let mut state = started();
        // 設定ページを見せているだけでは、窓が操作を受けていない間は、通常（雀魂を打ちながら開いたままでも記録される）。
        state.reduce(Input::ProbeWanted(true));
        assert_eq!(state.mode(), Mode::Normal);
        let effects = state.reduce(Input::Trigger { t_ms: T0 });
        assert!(effects.contains(&Effect::Record { t_ms: T0 }));
        // 窓が操作を受けたら、テスト。
        state.reduce(Input::WindowFocus(true));
        assert_eq!(state.mode(), Mode::Test);
        // 雀魂に切り替えて、窓が操作を受けなくなったら、通常に戻る。
        state.reduce(Input::WindowFocus(false));
        assert_eq!(state.mode(), Mode::Normal);
        // ページを離れたら、窓が操作を受けていても、通常。
        state.reduce(Input::WindowFocus(true));
        state.reduce(Input::ProbeWanted(false));
        assert_eq!(state.mode(), Mode::Normal);
    }

    #[test]
    fn w11_the_mode_is_sent_to_whoever_is_catching_input() {
        let mut state = started();
        state.reduce(Input::HelperConnected);
        state.reduce(Input::HelperReady);
        state.reduce(Input::ProbeWanted(true));
        let effects = state.reduce(Input::WindowFocus(true));
        assert_eq!(
            without_status(effects),
            vec![Effect::ConfigureHelper(cfg(Some(X1), Mode::Test))]
        );
        let effects = state.reduce(Input::WindowFocus(false));
        assert_eq!(
            without_status(effects),
            vec![Effect::ConfigureHelper(cfg(Some(X1), Mode::Normal))]
        );
    }

    #[test]
    fn w11_the_received_time_is_forgotten_when_the_test_stops_being_shown() {
        let mut state = started();
        state.reduce(Input::ProbeWanted(true));
        state.reduce(Input::WindowFocus(true));
        state.reduce(Input::Trigger { t_ms: T0 });
        assert_eq!(state.status().probe_ms, Some(T0));
        state.reduce(Input::WindowFocus(false));
        assert_eq!(state.status().probe_ms, None);
        state.reduce(Input::WindowFocus(true));
        state.reduce(Input::Trigger { t_ms: T0 + 1000 });
        state.reduce(Input::ProbeWanted(false));
        assert_eq!(state.status().probe_ms, None);
    }

    // ---- W-10: 登録 ----

    #[test]
    fn w10_registration_waits_for_the_first_input_and_saves_it_as_the_assignment() {
        let mut state = started();
        let effects = state.reduce(Input::StartRegistration);
        assert_eq!(state.mode(), Mode::Register);
        assert!(state.status().registering);
        assert!(effects.contains(&Effect::StartTimeout { attempt: 1 }));
        assert!(effects.contains(&Effect::ConfigureInProcess(Some(cfg(
            Some(X1),
            Mode::Register
        )))));

        let effects = state.reduce(Input::Captured(ctrl_alt_m()));
        assert!(effects.contains(&Effect::SaveTrigger(ctrl_alt_m())));
        assert_eq!(state.mode(), Mode::Normal);
        assert!(!state.status().registering);
        // 通常の動きに戻す（割り当ては、保存が終わって届くまで古いまま）。
        assert!(effects.contains(&Effect::ConfigureInProcess(Some(cfg(
            Some(X1),
            Mode::Normal
        )))));
        state.reduce(Input::TriggerChanged(Some(ctrl_alt_m())));
        assert_eq!(
            state.plan().in_process,
            Some(cfg(Some(ctrl_alt_m()), Mode::Normal))
        );
    }

    #[test]
    fn w10_only_the_first_input_counts_later_ones_are_not_saved() {
        let mut state = started();
        state.reduce(Input::StartRegistration);
        assert!(state
            .reduce(Input::Captured(X2))
            .contains(&Effect::SaveTrigger(X2)));
        let second = state.reduce(Input::Captured(f13()));
        assert!(!second.iter().any(|e| matches!(e, Effect::SaveTrigger(_))));
    }

    #[test]
    fn w10_an_input_that_arrives_when_no_registration_is_waiting_is_ignored() {
        let mut state = started();
        let effects = state.reduce(Input::Captured(X2));
        assert!(!effects.iter().any(|e| matches!(e, Effect::SaveTrigger(_))));
    }

    #[test]
    fn w10_candidates_that_cannot_be_assignments_are_not_saved_even_if_a_peer_sends_them() {
        let mut state = started();
        state.reduce(Input::StartRegistration);
        for bad in [
            ActiveTrigger::Mouse(MouseButton::Left),
            ActiveTrigger::Mouse(MouseButton::Right),
            ActiveTrigger::key(0x4D, Modifiers::NONE),
            ActiveTrigger::key(0x1B, Modifiers::NONE),
        ] {
            let effects = state.reduce(Input::Captured(bad));
            assert!(
                !effects.iter().any(|e| matches!(e, Effect::SaveTrigger(_))),
                "{bad:?}"
            );
            assert!(state.status().registering, "待機は続く");
        }
    }

    #[test]
    fn w10_escape_or_the_cancel_button_ends_the_wait_without_changing_the_assignment() {
        for cancel in [Input::CancelKey, Input::CancelRegistration] {
            let mut state = started();
            state.reduce(Input::StartRegistration);
            let effects = state.reduce(cancel);
            assert_eq!(state.mode(), Mode::Normal);
            assert!(!state.status().registering);
            assert!(!effects.iter().any(|e| matches!(e, Effect::SaveTrigger(_))));
            assert_eq!(state.plan().in_process, Some(cfg(Some(X1), Mode::Normal)));
        }
    }

    #[test]
    fn w10_cancelling_when_nothing_is_waiting_changes_nothing() {
        let mut state = started();
        let effects = state.reduce(Input::CancelKey);
        assert!(effects.is_empty());
    }

    #[test]
    fn w10_a_wait_with_no_input_times_out_but_a_stale_timeout_is_ignored() {
        let mut state = started();
        state.reduce(Input::StartRegistration); // 1 回目
        state.reduce(Input::CancelRegistration);
        state.reduce(Input::StartRegistration); // 2 回目
                                                // 1 回目の時間切れが、いまごろ届いても、2 回目の待機は終わらない。
        state.reduce(Input::RegistrationTimeout { attempt: 1 });
        assert!(state.status().registering);
        state.reduce(Input::RegistrationTimeout { attempt: 2 });
        assert!(!state.status().registering);
        assert_eq!(state.mode(), Mode::Normal);
    }

    #[test]
    fn w10_the_registration_timeout_is_30_seconds() {
        assert_eq!(REGISTRATION_TIMEOUT, Duration::from_secs(30));
    }

    #[test]
    fn w10_while_registering_a_press_of_the_current_button_is_not_recorded() {
        let mut state = started();
        state.reduce(Input::StartRegistration);
        let effects = state.reduce(Input::Trigger { t_ms: T0 });
        assert!(!effects.iter().any(|e| matches!(e, Effect::Record { .. })));
    }

    #[test]
    fn w10_registration_works_through_the_helper_when_it_is_active() {
        let mut state = started();
        state.reduce(Input::HelperConnected);
        state.reduce(Input::HelperReady);
        let effects = state.reduce(Input::StartRegistration);
        assert!(effects.contains(&Effect::ConfigureHelper(cfg(Some(X1), Mode::Register))));
        assert!(!effects
            .iter()
            .any(|e| matches!(e, Effect::ConfigureInProcess(_))));
        let effects = state.reduce(Input::Captured(f13()));
        assert!(effects.contains(&Effect::SaveTrigger(f13())));
        assert!(effects.contains(&Effect::ConfigureHelper(cfg(Some(X1), Mode::Normal))));
    }

    #[test]
    fn w10_registration_falls_back_to_the_in_process_hook_when_the_helper_goes_away_mid_wait() {
        let mut state = started();
        state.reduce(Input::HelperConnected);
        state.reduce(Input::HelperReady);
        state.reduce(Input::StartRegistration);
        let effects = state.reduce(Input::HelperLost);
        assert!(effects.contains(&Effect::ConfigureInProcess(Some(cfg(
            Some(X1),
            Mode::Register
        )))));
        assert!(state.status().registering, "待機は続く");
    }

    #[test]
    fn w10_registration_cannot_start_when_nothing_can_catch_input() {
        let mut state = InputState::new(Some(X1));
        state.reduce(Input::InProcessHook(false));
        let effects = state.reduce(Input::StartRegistration);
        assert!(!state.status().registering);
        assert!(!effects
            .iter()
            .any(|e| matches!(e, Effect::StartTimeout { .. })));
        assert!(state.status().message.is_some());
        // 補助プログラムが拾えるようになれば、始められる。メッセージは消える。
        state.reduce(Input::HelperConnected);
        state.reduce(Input::HelperReady);
        state.reduce(Input::StartRegistration);
        assert!(state.status().registering);
        assert_eq!(state.status().message, None);
    }

    #[test]
    fn w10_starting_a_registration_forgets_the_last_test_result() {
        let mut state = started();
        state.reduce(Input::ProbeWanted(true));
        state.reduce(Input::WindowFocus(true));
        state.reduce(Input::Trigger { t_ms: T0 });
        assert!(state.status().probe_ms.is_some());
        state.reduce(Input::StartRegistration);
        assert_eq!(state.status().probe_ms, None);
    }

    #[test]
    fn w10_a_failure_to_save_the_registered_input_is_shown() {
        let mut state = started();
        state.reduce(Input::StartRegistration);
        state.reduce(Input::Captured(f13()));
        state.reduce(Input::RegistrationSaveFailed(
            "設定を保存できませんでした".into(),
        ));
        assert_eq!(
            state.status().message.as_deref(),
            Some("設定を保存できませんでした")
        );
        // 次の登録を始めると、消える。
        state.reduce(Input::StartRegistration);
        assert_eq!(state.status().message, None);
    }

    // ---- 補助プログラムの設定・解除・起動 ----

    #[test]
    fn w9_the_helper_status_follows_the_installation_and_the_connection() {
        let mut state = started();
        assert_eq!(state.status().helper.installed, None);
        state.reduce(Input::InstalledKnown(true));
        assert_eq!(state.status().helper.installed, Some(true));
        state.reduce(Input::HelperOpStarted(HelperOp::Starting));
        assert_eq!(state.status().helper.busy, Some(HelperOp::Starting));
        state.reduce(Input::HelperOpFinished { result: Ok(()) });
        assert_eq!(state.status().helper.busy, None);
        assert_eq!(state.status().helper.error, None);
        state.reduce(Input::HelperOpStarted(HelperOp::Installing));
        state.reduce(Input::HelperOpFinished {
            result: Err("Windows の確認が取り消されました".into()),
        });
        assert_eq!(
            state.status().helper.error.as_deref(),
            Some("Windows の確認が取り消されました")
        );
        // 次の操作を始めると、前の失敗は消える。
        state.reduce(Input::HelperOpStarted(HelperOp::Installing));
        assert_eq!(state.status().helper.error, None);
    }

    // ---- 画面に知らせる状態 ----

    #[test]
    fn the_status_is_emitted_only_when_it_changes() {
        let mut state = InputState::new(Some(X1));
        let first = state.reduce(Input::InProcessHook(true));
        assert_eq!(
            first
                .iter()
                .filter(|e| matches!(e, Effect::EmitStatus(_)))
                .count(),
            1
        );
        // 画面に出る内容が変わらない入力では、知らせない。
        let same = state.reduce(Input::TriggerChanged(Some(X1)));
        assert!(!same.iter().any(|e| matches!(e, Effect::EmitStatus(_))));
        let changed = state.reduce(Input::InstalledKnown(false));
        assert_eq!(
            changed
                .iter()
                .filter(|e| matches!(e, Effect::EmitStatus(_)))
                .count(),
            1
        );
    }

    #[test]
    fn the_status_json_shape_is_stable() {
        let mut state = started();
        state.reduce(Input::InstalledKnown(true));
        state.reduce(Input::HelperConnected);
        state.reduce(Input::HelperReady);
        let json = serde_json::to_string(&state.status()).unwrap();
        assert_eq!(
            json,
            r#"{"registering":false,"probe_ms":null,"hook":"helper","helper":{"installed":true,"running":true,"busy":null,"error":null},"message":null}"#
        );
        state.reduce(Input::HelperOpStarted(HelperOp::Installing));
        assert!(serde_json::to_string(&state.status())
            .unwrap()
            .contains(r#""busy":"installing""#));
    }

    #[test]
    fn reports_from_the_hooks_become_inputs() {
        assert_eq!(
            Input::from(Report::Trigger { t_ms: 5 }),
            Input::Trigger { t_ms: 5 }
        );
        assert_eq!(Input::from(Report::Captured(X2)), Input::Captured(X2));
        assert_eq!(Input::from(Report::Cancel), Input::CancelKey);
    }

    // ---- 入力の列を順番に処理するスレッド ----

    #[derive(Clone, Default)]
    struct Recorded(Arc<Mutex<Vec<Effect>>>);

    impl Effects for Recorded {
        fn run(&mut self, effect: Effect) {
            self.0.lock().unwrap().push(effect);
        }
    }

    #[test]
    fn the_worker_runs_every_input_in_order_and_finishes_when_the_senders_are_gone() {
        let recorded = Recorded::default();
        let (service, worker) = spawn_service(InputState::new(Some(X1)), |_| recorded.clone());
        let hook_sender = service.sender();
        service.send(Input::InProcessHook(true));
        hook_sender.send(Input::Trigger { t_ms: T0 }).unwrap();
        service.send(Input::StartRegistration);
        hook_sender.send(Input::Captured(f13())).unwrap();
        service.send(Input::TriggerChanged(Some(f13())));
        // 窓口がすべて無くなると、ワーカーは、列に残っている入力を処理してから終わる。
        drop(hook_sender);
        drop(service);
        worker.join().unwrap();

        let effects = recorded.0.lock().unwrap().clone();
        let important: Vec<&Effect> = effects
            .iter()
            .filter(|e| {
                matches!(
                    e,
                    Effect::Record { .. } | Effect::SaveTrigger(_) | Effect::StartTimeout { .. }
                )
            })
            .collect();
        assert_eq!(
            important,
            vec![
                &Effect::Record { t_ms: T0 },
                &Effect::StartTimeout { attempt: 1 },
                &Effect::SaveTrigger(f13()),
            ]
        );
    }

    #[test]
    fn the_service_reports_the_current_status() {
        let (service, worker) = spawn_service(InputState::new(Some(X1)), |_| Recorded::default());
        service.send(Input::InstalledKnown(true));
        service.send(Input::InProcessHook(true));
        let reader = service.clone();
        drop(service);
        // ワーカーは、窓口がすべて無くなるまで動く。読み取り用の窓口を持ったまま、処理が済むのを待つ。
        let deadline = std::time::Instant::now() + Duration::from_secs(5);
        while reader.status().helper.installed != Some(true) && std::time::Instant::now() < deadline
        {
            thread::sleep(Duration::from_millis(5));
        }
        assert_eq!(reader.status().helper.installed, Some(true));
        assert_eq!(reader.status().hook, HookSource::InProcess);
        drop(reader);
        worker.join().unwrap();
    }
}
