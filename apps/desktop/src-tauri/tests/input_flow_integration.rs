//! 入力の流れ（`input_flow`）と本物のフックをつないで、押した入力が、記録・テスト・登録に届くことを確かめる（手動の試験）。
//!
//! アプリの中のつなぎ方（本体のフックの知らせ → 入力の流れ → フックの設定を変える）と同じものを、Tauri 抜きで動かす。
//! 注入するのは、F23・F24 のキーだけ（ほとんどのアプリでは何も起こさない）。割り当てた間は、フックが止める。
//! 前面の窓が昇格していると、入力が届かず、理由を示して失敗する（`pnpm test:hook` と同じ）。

#![cfg(windows)]

use std::mem::size_of;
use std::sync::mpsc::Sender;
use std::sync::{Arc, Mutex};
use std::thread;
use std::time::{Duration, Instant};

use jantama_input::hook_win::{self, HookHandle};
use jantama_input::keys::Modifiers;
use jantama_input::logic::{ActiveTrigger, Config, Mode};
use jantama_reviewer_lib::input_flow::{
    spawn_service, Effect, Effects, Input, InputState, REGISTRATION_TIMEOUT,
};
use windows::Win32::UI::Input::KeyboardAndMouse::{
    SendInput, INPUT, INPUT_0, INPUT_KEYBOARD, KEYBDINPUT, KEYBD_EVENT_FLAGS, KEYEVENTF_KEYUP,
    VIRTUAL_KEY,
};

const VK_F23: u32 = 0x86;
const VK_F24: u32 = 0x87;

/// アプリの `TauriEffects` と同じ、フックの設定を変える側（記録や保存は、やることとして覚えるだけ）。
struct HookEffects {
    hook: HookHandle,
    seen: Arc<Mutex<Vec<Effect>>>,
}

impl Effects for HookEffects {
    fn run(&mut self, effect: Effect) {
        if let Effect::ConfigureInProcess(config) = &effect {
            let status = self.hook.apply(config.unwrap_or(Config::OFF));
            assert!(status.error.is_none(), "{status:?}");
        }
        self.seen.lock().unwrap().push(effect);
    }
}

fn press(vk: u32) {
    let key = |flags: KEYBD_EVENT_FLAGS| INPUT {
        r#type: INPUT_KEYBOARD,
        Anonymous: INPUT_0 {
            ki: KEYBDINPUT {
                wVk: VIRTUAL_KEY(vk as u16),
                wScan: 0,
                dwFlags: flags,
                time: 0,
                dwExtraInfo: 0,
            },
        },
    };
    let inputs = [key(KEYBD_EVENT_FLAGS(0)), key(KEYEVENTF_KEYUP)];
    // SAFETY: 初期化済みの配列。
    let sent = unsafe { SendInput(&inputs, size_of::<INPUT>() as i32) };
    assert_eq!(sent as usize, inputs.len(), "入力を注入できない");
}

fn wait_for(what: &str, condition: impl Fn() -> bool) {
    let deadline = Instant::now() + Duration::from_secs(5);
    while Instant::now() < deadline {
        if condition() {
            return;
        }
        thread::sleep(Duration::from_millis(10));
    }
    panic!("{what} が起きない");
}

fn count(seen: &Arc<Mutex<Vec<Effect>>>, matching: impl Fn(&Effect) -> bool) -> usize {
    seen.lock().unwrap().iter().filter(|e| matching(e)).count()
}

#[test]
#[ignore = "実際の入力を注入する手動の試験（F23・F24 だけ）。前面の窓が昇格していると動かない"]
fn w9_w10_w11_a_press_reaches_recording_testing_and_registration_through_the_real_hook() {
    let seen: Arc<Mutex<Vec<Effect>>> = Arc::default();
    let seen_for_effects = Arc::clone(&seen);
    let (service, _worker) = spawn_service(
        InputState::new(Some(ActiveTrigger::key(VK_F24, Modifiers::NONE))),
        move |feedback: Sender<Input>| {
            let sink = feedback.clone();
            let (hook, _) = hook_win::start(Config::OFF, move |report| {
                let _ = sink.send(Input::from(report));
            })
            .expect("フックのスレッドを起こせる");
            let _ = feedback.send(Input::InProcessHook(true));
            HookEffects {
                hook,
                seen: seen_for_effects,
            }
        },
    );

    // 起動: 割り当て（F24）のためのフックが入る。
    wait_for("本体のフックの設定", || {
        count(&seen, |e| {
            matches!(
                e,
                Effect::ConfigureInProcess(Some(Config {
                    mode: Mode::Normal,
                    ..
                }))
            )
        }) == 1
    });

    // 通常: F24 を押すと、迷いマークを記録する合図が 1 回出る。
    press(VK_F24);
    wait_for("迷いマークの記録", || {
        count(&seen, |e| matches!(e, Effect::Record { .. })) == 1
    });

    // テスト: 設定ページを見せていて窓が操作を受けている間は、記録せず、受け取ったことだけを知らせる。
    thread::sleep(Duration::from_millis(100));
    service.send(Input::ProbeWanted(true));
    service.send(Input::WindowFocus(true));
    wait_for("テストへの切り替え", || {
        count(&seen, |e| {
            matches!(
                e,
                Effect::ConfigureInProcess(Some(Config {
                    mode: Mode::Test,
                    ..
                }))
            )
        }) == 1
    });
    press(VK_F24);
    wait_for("テストの受け取り", || {
        service.status().probe_ms.is_some()
    });
    assert_eq!(
        count(&seen, |e| matches!(e, Effect::Record { .. })),
        1,
        "テストの間は、記録が増えない"
    );

    // 登録: 最初に押されたキー（F23）が、割り当てとして保存される合図になる。
    service.send(Input::StartRegistration);
    wait_for("登録の待機", || service.status().registering);
    press(VK_F23);
    wait_for("登録された入力", || {
        count(
            &seen,
            |e| matches!(e, Effect::SaveTrigger(t) if *t == ActiveTrigger::key(VK_F23, Modifiers::NONE)),
        ) == 1
    });
    assert!(!service.status().registering);
    assert!(
        REGISTRATION_TIMEOUT > Duration::from_secs(1),
        "待機は時間切れまで続く"
    );
}
