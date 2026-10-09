//! フックの結合試験（手動）: 実際にマウスとキーの入力を注入（`SendInput`）して、
//! 本物の WH_MOUSE_LL / WH_KEYBOARD_LL の手続きまで通す。`pnpm test:hook` で動かす。
//!
//! 判定と、Windows のメッセージの読み取り、割り当てを変えたあとの動きは、OS に依存しない部品
//! （`jantama_input::logic::InputCore`）の単体テストが確かめている。ここで確かめるのは、OS との配線だけ:
//! - 低レベルフックの手続きが、本当に呼ばれ、割り当てたボタンを横取りして、ほかのアプリへ届けないこと
//! - 割り当てを変えたあとに、キーボードのフックが入り、外れること
//! - 押された時刻が、記録の担当へ渡ること
//!
//! 通常の `pnpm test` から外している（`#[ignore]`）のは、次の理由による。
//! - 前面の窓が、昇格している（管理者として動いている）と、昇格していないプロセスには、入力が一切届かない
//!   （UIPI。注入した入力は捨てられ、低レベルフックも本物の入力を受け取れない）。雀魂のクライアントは昇格して動くので、
//!   遊んでいる最中は、この試験が動かない。
//! - 試験の間（1〜2 秒）、割り当てたボタン（X1・X2・中ボタン・F13）が、使っている人の操作でも横取りされる。
//!
//! ほかのアプリや、使っている人の入力に触れないための仕組み:
//! - 注入する入力には、目印（`dwExtraInfo`）を付ける。
//! - 試験の「見張り」のフックを、本物のフックより先（= 連鎖の後ろ）に入れる。見張りは、目印の付いた入力だけを記録して止める。
//!   本物のフックが横取りした入力は見張りに届かず、通したものだけが届く。どちらの場合も、入力は誰にも届かない。
//! - 目印の無い入力（使っている人の実際の操作）は、見張りが何もせず次へ渡す。
//! - 最初に、無害なキー（F15）を 1 回だけ注入して、見張りに届くことを確かめる。届かなければ（前面の窓が昇格している、
//!   対話できるデスクトップではない、など）、ほかには何も注入せずに、理由を示して失敗する。
//! - 注入するのは、マウスのボタンと、F13 から F15 のキーだけ。カーソルは動かさない。
//!
//! 1 つのテストの中で、最初から最後まで順に確かめる（フックの設定はプロセスに 1 つだけのため）。

#![cfg(windows)]

use std::mem::size_of;
use std::sync::mpsc::{self, Receiver};
use std::sync::Mutex;
use std::thread;
use std::time::{Duration, Instant};

use jantama_input::hook_win;
use jantama_input::keys::Modifiers;
use jantama_input::logic::{ActiveTrigger, Config, Mode, MouseButton, Report};
use windows::Win32::Foundation::{HINSTANCE, LPARAM, LRESULT, WPARAM};
use windows::Win32::System::LibraryLoader::GetModuleHandleW;
use windows::Win32::System::Threading::GetCurrentThreadId;
use windows::Win32::UI::Input::KeyboardAndMouse::{
    SendInput, INPUT, INPUT_0, INPUT_KEYBOARD, INPUT_MOUSE, KEYBDINPUT, KEYBD_EVENT_FLAGS,
    KEYEVENTF_KEYUP, MOUSEEVENTF_LEFTDOWN, MOUSEEVENTF_LEFTUP, MOUSEEVENTF_MIDDLEDOWN,
    MOUSEEVENTF_MIDDLEUP, MOUSEEVENTF_RIGHTDOWN, MOUSEEVENTF_RIGHTUP, MOUSEEVENTF_XDOWN,
    MOUSEEVENTF_XUP, MOUSEINPUT, MOUSE_EVENT_FLAGS, VIRTUAL_KEY,
};
use windows::Win32::UI::WindowsAndMessaging::{
    CallNextHookEx, GetMessageW, PeekMessageW, PostThreadMessageW, SetWindowsHookExW,
    UnhookWindowsHookEx, HC_ACTION, KBDLLHOOKSTRUCT, MSG, MSLLHOOKSTRUCT, PM_NOREMOVE,
    WH_KEYBOARD_LL, WH_MOUSE_LL, WM_KEYDOWN, WM_KEYUP, WM_LBUTTONDOWN, WM_LBUTTONUP,
    WM_MBUTTONDOWN, WM_MBUTTONUP, WM_QUIT, WM_RBUTTONDOWN, WM_RBUTTONUP, WM_SYSKEYDOWN,
    WM_SYSKEYUP, WM_XBUTTONDOWN, WM_XBUTTONUP,
};

/// 注入した入力の目印（`dwExtraInfo`）。
const MAGIC: usize = 0x4A52_4B31;

const XBUTTON1: u32 = 1;
const XBUTTON2: u32 = 2;
const VK_F13: u32 = 0x7C;
const VK_F14: u32 = 0x7D;
const VK_F15: u32 = 0x7E;
const VK_A: u32 = 0x41;
const VK_M: u32 = 0x4D;
const VK_TAB: u32 = 0x09;
const VK_ESCAPE: u32 = 0x1B;
const VK_LSHIFT: u32 = 0xA0;

/// 見張りのフックが見た入力（本物のフックが通したもの）。
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
enum Seen {
    Mouse { button: MouseButton, down: bool },
    Key { vk: u32, down: bool },
}

static SEEN: Mutex<Vec<Seen>> = Mutex::new(Vec::new());

fn seen() -> Vec<Seen> {
    SEEN.lock().unwrap_or_else(|e| e.into_inner()).clone()
}

fn take_seen() -> Vec<Seen> {
    std::mem::take(&mut *SEEN.lock().unwrap_or_else(|e| e.into_inner()))
}

fn record(event: Seen) {
    SEEN.lock().unwrap_or_else(|e| e.into_inner()).push(event);
}

// ---- 見張りのフック ----

/// マウスのメッセージを、本物のフックとは別の書き方で読む（配線の取り違えを見つけるため）。
fn parse_mouse(message: u32, mouse_data: u32) -> Option<Seen> {
    let x_button = |down| match (mouse_data >> 16) & 0xFFFF {
        XBUTTON1 => Some(Seen::Mouse {
            button: MouseButton::X1,
            down,
        }),
        XBUTTON2 => Some(Seen::Mouse {
            button: MouseButton::X2,
            down,
        }),
        _ => None,
    };
    let simple = |button, down| Some(Seen::Mouse { button, down });
    match message {
        WM_LBUTTONDOWN => simple(MouseButton::Left, true),
        WM_LBUTTONUP => simple(MouseButton::Left, false),
        WM_RBUTTONDOWN => simple(MouseButton::Right, true),
        WM_RBUTTONUP => simple(MouseButton::Right, false),
        WM_MBUTTONDOWN => simple(MouseButton::Middle, true),
        WM_MBUTTONUP => simple(MouseButton::Middle, false),
        WM_XBUTTONDOWN => x_button(true),
        WM_XBUTTONUP => x_button(false),
        _ => None,
    }
}

unsafe extern "system" fn witness_mouse(code: i32, wparam: WPARAM, lparam: LPARAM) -> LRESULT {
    if code == HC_ACTION as i32 {
        // SAFETY: WH_MOUSE_LL では lparam は MSLLHOOKSTRUCT へのポインタ。
        let info = unsafe { &*(lparam.0 as *const MSLLHOOKSTRUCT) };
        if info.dwExtraInfo == MAGIC {
            if let Some(event) = parse_mouse(wparam.0 as u32, info.mouseData) {
                record(event);
            }
            // 注入した入力は、ここで止める（ほかのアプリには届けない）。
            return LRESULT(1);
        }
    }
    unsafe { CallNextHookEx(None, code, wparam, lparam) }
}

unsafe extern "system" fn witness_keyboard(code: i32, wparam: WPARAM, lparam: LPARAM) -> LRESULT {
    if code == HC_ACTION as i32 {
        // SAFETY: WH_KEYBOARD_LL では lparam は KBDLLHOOKSTRUCT へのポインタ。
        let info = unsafe { &*(lparam.0 as *const KBDLLHOOKSTRUCT) };
        if info.dwExtraInfo == MAGIC {
            match wparam.0 as u32 {
                WM_KEYDOWN | WM_SYSKEYDOWN => record(Seen::Key {
                    vk: info.vkCode,
                    down: true,
                }),
                WM_KEYUP | WM_SYSKEYUP => record(Seen::Key {
                    vk: info.vkCode,
                    down: false,
                }),
                _ => {}
            }
            // Shift だけは通す。押している間の修飾キーの状態は、通した入力で OS が更新するため、止めると、
            // 本物のフックが修飾キーを読めない。Shift だけを押して離しても、ほかのアプリには何も起こらない
            // （Ctrl・Alt・Windows は、メニューや開始画面を開くので、注入しない）。
            if info.vkCode == VK_LSHIFT {
                return unsafe { CallNextHookEx(None, code, wparam, lparam) };
            }
            return LRESULT(1);
        }
    }
    unsafe { CallNextHookEx(None, code, wparam, lparam) }
}

/// 見張りのフックを入れたスレッド。落とすと、フックを外してスレッドが終わる。
struct Witness {
    thread_id: u32,
    thread: Option<thread::JoinHandle<()>>,
}

impl Witness {
    fn start() -> Witness {
        let (ready_tx, ready_rx) = mpsc::channel::<Result<u32, String>>();
        let thread = thread::spawn(move || {
            // SAFETY: フックのハンドルはこのスレッドの中だけで扱い、ループを抜けたら必ず外す。
            unsafe {
                let mut msg = MSG::default();
                // メッセージキューを先に作る（ほかのスレッドから PostThreadMessage できるように）。
                let _ = PeekMessageW(&mut msg, None, 0, 0, PM_NOREMOVE);
                let module = match GetModuleHandleW(None) {
                    Ok(m) => HINSTANCE(m.0),
                    Err(e) => {
                        let _ = ready_tx.send(Err(format!("モジュールを取得できません: {e}")));
                        return;
                    }
                };
                let mouse = SetWindowsHookExW(WH_MOUSE_LL, Some(witness_mouse), Some(module), 0);
                let keyboard =
                    SetWindowsHookExW(WH_KEYBOARD_LL, Some(witness_keyboard), Some(module), 0);
                match (&mouse, &keyboard) {
                    (Ok(_), Ok(_)) => {
                        let _ = ready_tx.send(Ok(GetCurrentThreadId()));
                    }
                    _ => {
                        let _ = ready_tx.send(Err(format!(
                            "見張りのフックを入れられません（マウス: {:?}、キー: {:?}）",
                            mouse.as_ref().err(),
                            keyboard.as_ref().err()
                        )));
                    }
                }
                while GetMessageW(&mut msg, None, 0, 0).0 > 0 {}
                if let Ok(h) = mouse {
                    let _ = UnhookWindowsHookEx(h);
                }
                if let Ok(h) = keyboard {
                    let _ = UnhookWindowsHookEx(h);
                }
            }
        });
        let thread_id = ready_rx
            .recv_timeout(Duration::from_secs(5))
            .expect("見張りのスレッドが始まる")
            .expect("見張りのフックを入れられる（対話できるデスクトップが要る）");
        Witness {
            thread_id,
            thread: Some(thread),
        }
    }
}

impl Drop for Witness {
    fn drop(&mut self) {
        // SAFETY: スレッド ID は見張りのスレッドのもの。
        unsafe {
            let _ = PostThreadMessageW(self.thread_id, WM_QUIT, WPARAM(0), LPARAM(0));
        }
        if let Some(thread) = self.thread.take() {
            let _ = thread.join();
        }
    }
}

// ---- 入力の注入 ----

fn mouse_input(flags: MOUSE_EVENT_FLAGS, data: u32) -> INPUT {
    INPUT {
        r#type: INPUT_MOUSE,
        Anonymous: INPUT_0 {
            mi: MOUSEINPUT {
                dx: 0,
                dy: 0,
                mouseData: data,
                dwFlags: flags,
                time: 0,
                dwExtraInfo: MAGIC,
            },
        },
    }
}

fn key_input(vk: u32, flags: KEYBD_EVENT_FLAGS) -> INPUT {
    INPUT {
        r#type: INPUT_KEYBOARD,
        Anonymous: INPUT_0 {
            ki: KEYBDINPUT {
                wVk: VIRTUAL_KEY(vk as u16),
                wScan: 0,
                dwFlags: flags,
                time: 0,
                dwExtraInfo: MAGIC,
            },
        },
    }
}

fn send(inputs: &[INPUT]) {
    // SAFETY: inputs は初期化済みの配列で、大きさを正しく渡している。
    let sent = unsafe { SendInput(inputs, size_of::<INPUT>() as i32) };
    assert_eq!(
        sent as usize,
        inputs.len(),
        "入力を注入できませんでした（対話できるデスクトップが要る）"
    );
}

/// マウスのボタンを押して離す。`times` 回、続けて。
fn click(button: MouseButton, times: usize) {
    let (down, up, data) = match button {
        MouseButton::Left => (MOUSEEVENTF_LEFTDOWN, MOUSEEVENTF_LEFTUP, 0),
        MouseButton::Right => (MOUSEEVENTF_RIGHTDOWN, MOUSEEVENTF_RIGHTUP, 0),
        MouseButton::Middle => (MOUSEEVENTF_MIDDLEDOWN, MOUSEEVENTF_MIDDLEUP, 0),
        MouseButton::X1 => (MOUSEEVENTF_XDOWN, MOUSEEVENTF_XUP, XBUTTON1),
        MouseButton::X2 => (MOUSEEVENTF_XDOWN, MOUSEEVENTF_XUP, XBUTTON2),
    };
    for _ in 0..times {
        send(&[mouse_input(down, data), mouse_input(up, data)]);
    }
}

fn press_key(vk: u32) {
    send(&[
        key_input(vk, KEYBD_EVENT_FLAGS(0)),
        key_input(vk, KEYEVENTF_KEYUP),
    ]);
}

/// 続けて押したまま（自動リピート）の押下を `repeats` 回送り、最後に離す。
fn hold_key(vk: u32, repeats: usize) {
    for _ in 0..repeats {
        send(&[key_input(vk, KEYBD_EVENT_FLAGS(0))]);
    }
    send(&[key_input(vk, KEYEVENTF_KEYUP)]);
}

// ---- 結果の読み取り ----

/// 見張りが、目印の入力 `last` を見るまで待つ。入力は届いた順に処理されるので、
/// これを見たときには、その前に注入した入力は、本物のフックが止めたか、見張りに届いたかのどちらかが済んでいる。
fn wait_for(last: Seen) {
    let deadline = Instant::now() + Duration::from_secs(3);
    while Instant::now() < deadline {
        if seen().contains(&last) {
            return;
        }
        thread::sleep(Duration::from_millis(5));
    }
    panic!(
        "{last:?} が見張りに届かない（フックが外れたか、入力が届いていない）。見えた入力: {:?}",
        seen()
    );
}

/// 目印の入力（右ボタンのクリック）を注入して、見張りに届くまで待つ。割り当ての中にない（常に通る）ボタンを使う。
fn flush_mouse() {
    click(MouseButton::Right, 1);
    wait_for(Seen::Mouse {
        button: MouseButton::Right,
        down: false,
    });
}

/// キー版の目印（F15）。割り当ての中にない（常に通る）キーを使う。
fn flush_keys() {
    press_key(VK_F15);
    wait_for(Seen::Key {
        vk: VK_F15,
        down: false,
    });
}

/// 目印の分（右ボタンの押下と、離す）を取り除いた、見張りに届いた入力。
fn passed_mouse() -> Vec<Seen> {
    take_seen()
        .into_iter()
        .filter(|s| {
            !matches!(
                s,
                Seen::Mouse {
                    button: MouseButton::Right,
                    ..
                }
            )
        })
        .collect()
}

fn passed_keys() -> Vec<Seen> {
    take_seen()
        .into_iter()
        .filter(|s| !matches!(s, Seen::Key { vk: VK_F15, .. }))
        .collect()
}

fn mouse(button: MouseButton, down: bool) -> Seen {
    Seen::Mouse { button, down }
}

fn key(vk: u32, down: bool) -> Seen {
    Seen::Key { vk, down }
}

/// フックが知らせた「割り当てたボタンが押された」時刻（ミリ秒）。ほかの知らせは捨てる。
fn triggers(rx: &Receiver<Report>) -> Vec<i64> {
    rx.try_iter()
        .filter_map(|report| match report {
            Report::Trigger { t_ms } => Some(t_ms),
            _ => None,
        })
        .collect()
}

/// フックが知らせたことのすべて（押下・登録の候補・取り消し）。
fn reports(rx: &Receiver<Report>) -> Vec<Report> {
    rx.try_iter().collect()
}

/// 修飾キーを押したまま、キーを 1 回押す。1 回の注入にまとめる（途中で止まって、修飾キーが押されたままにならない）。
fn chord(modifiers: &[u32], vk: u32) {
    let mut inputs: Vec<INPUT> = modifiers
        .iter()
        .map(|m| key_input(*m, KEYBD_EVENT_FLAGS(0)))
        .collect();
    inputs.push(key_input(vk, KEYBD_EVENT_FLAGS(0)));
    inputs.push(key_input(vk, KEYEVENTF_KEYUP));
    inputs.extend(
        modifiers
            .iter()
            .rev()
            .map(|m| key_input(*m, KEYEVENTF_KEYUP)),
    );
    send(&inputs);
}

/// 登録の待機中の、キー版の目印（A）。待機中は、F キーなども候補として止まるので、文字のキーを使う。
fn flush_keys_registering() {
    press_key(VK_A);
    wait_for(Seen::Key {
        vk: VK_A,
        down: false,
    });
}

fn passed_keys_registering() -> Vec<Seen> {
    take_seen()
        .into_iter()
        .filter(|s| !matches!(s, Seen::Key { vk: VK_A, .. }))
        .collect()
}

/// 割り当てを変える（通常の動き）。
fn assign(trigger: Option<ActiveTrigger>) -> Config {
    Config {
        trigger,
        mode: Mode::Normal,
    }
}

fn now_ms() -> i64 {
    std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .map(|d| d.as_millis() as i64)
        .unwrap_or(0)
}

#[test]
#[ignore = "実際の入力を注入する手動の試験（pnpm test:hook）。前面の窓が昇格していると動かない"]
fn w2_injected_input_reaches_the_real_hooks_and_only_the_assigned_button_is_swallowed() {
    let _witness = Witness::start();

    // 最初に、無害なキー（F15）を 1 回だけ注入して、見張りに届くことを確かめる。
    // 届かなければ、ほかには何も注入しない。
    press_key(VK_F15);
    let probe = Seen::Key {
        vk: VK_F15,
        down: false,
    };
    let probe_deadline = Instant::now() + Duration::from_secs(2);
    while Instant::now() < probe_deadline && !seen().contains(&probe) {
        thread::sleep(Duration::from_millis(5));
    }
    assert!(
        seen().contains(&probe),
        "{} 見えた入力: {:?}",
        concat!(
            "注入した入力が、見張りのフックに届きません。前面の窓が昇格している（管理者として動いている）と、",
            "昇格していないこの試験には入力が届きません（雀魂のクライアントが前面にあるとき、など）。",
            "前面を普通の窓（昇格していないメモ帳など）にして、もう一度動かしてください。"
        ),
        seen()
    );
    let _ = take_seen();

    let (tx, rx) = mpsc::channel::<Report>();
    let (hook, status) = hook_win::start(
        assign(Some(ActiveTrigger::Mouse(MouseButton::X1))),
        move |report| {
            let _ = tx.send(report);
        },
    )
    .expect("フックを入れられる（対話できるデスクトップが要る）");
    assert!(
        status.mouse && !status.keyboard && status.error.is_none(),
        "マウスの割り当てでは、マウスのフックだけが入る: {status:?}"
    );

    // ---- 既定の割り当て（サイドボタンの「戻る」= X1）----
    let before = now_ms();
    click(MouseButton::X1, 1);
    flush_mouse();
    assert_eq!(
        passed_mouse(),
        vec![],
        "X1 の押下と、離すのは、ほかのアプリに届かない（横取りされる）"
    );
    let events = triggers(&rx);
    assert_eq!(events.len(), 1, "押下の 1 回だけが記録の担当に渡る");
    assert!(
        (before..=now_ms()).contains(&events[0]),
        "押された時刻が渡る: {} （{before} から {}）",
        events[0],
        now_ms()
    );

    // ほかのボタンは通る。X2（「進む」）・左・中・（右は目印）。記録の担当には何も渡らない。
    click(MouseButton::X2, 1);
    click(MouseButton::Left, 1);
    click(MouseButton::Middle, 1);
    flush_mouse();
    assert_eq!(
        passed_mouse(),
        vec![
            mouse(MouseButton::X2, true),
            mouse(MouseButton::X2, false),
            mouse(MouseButton::Left, true),
            mouse(MouseButton::Left, false),
            mouse(MouseButton::Middle, true),
            mouse(MouseButton::Middle, false),
        ],
        "割り当てていないボタンは、押下も離すのもそのまま通る"
    );
    assert_eq!(triggers(&rx).len(), 0);

    // 続けて 3 回押せば、3 回記録される。
    click(MouseButton::X1, 3);
    flush_mouse();
    assert_eq!(passed_mouse(), vec![]);
    assert_eq!(triggers(&rx).len(), 3);

    // ---- 割り当てを X2 に変える（実行中に反映される）----
    hook.apply(assign(Some(ActiveTrigger::Mouse(MouseButton::X2))));
    click(MouseButton::X2, 1);
    click(MouseButton::X1, 1);
    flush_mouse();
    assert_eq!(
        passed_mouse(),
        vec![mouse(MouseButton::X1, true), mouse(MouseButton::X1, false)],
        "X2 を割り当てたあとは、X2 が止まり、X1 が通る（戻る / 進むを見分けている）"
    );
    assert_eq!(triggers(&rx).len(), 1);

    // ---- 割り当てを中ボタンに変える ----
    hook.apply(assign(Some(ActiveTrigger::Mouse(MouseButton::Middle))));
    click(MouseButton::Middle, 1);
    click(MouseButton::X1, 1);
    click(MouseButton::X2, 1);
    click(MouseButton::Left, 1);
    flush_mouse();
    assert_eq!(
        passed_mouse(),
        vec![
            mouse(MouseButton::X1, true),
            mouse(MouseButton::X1, false),
            mouse(MouseButton::X2, true),
            mouse(MouseButton::X2, false),
            mouse(MouseButton::Left, true),
            mouse(MouseButton::Left, false),
        ]
    );
    assert_eq!(triggers(&rx).len(), 1);

    // ---- 割り当てをキー（F13）に変える。キーボードのフックは、このときに入る ----
    let status = hook.apply(assign(Some(ActiveTrigger::key(VK_F13, Modifiers::NONE))));
    assert!(
        !status.mouse && status.keyboard,
        "キーの割り当てでは、キーボードのフックだけが入る: {status:?}"
    );
    // フックの入れ直しは終わっている（apply は待つ）が、念のため少し待ってから確かめる。
    thread::sleep(Duration::from_millis(50));
    let mut installed = false;
    for _ in 0..40 {
        press_key(VK_F13);
        flush_keys();
        let passed = passed_keys();
        let got = triggers(&rx);
        assert!(got.len() <= 1, "{got:?} {passed:?}");
        if got.len() == 1 {
            assert!(
                !passed.contains(&key(VK_F13, true)),
                "記録された押下は通らない: {passed:?}"
            );
            installed = true;
            break;
        }
        // まだ入っていない: F13 が通って（見張りに届いて）、記録の担当には何も渡っていない。
        assert_eq!(
            passed,
            vec![key(VK_F13, true), key(VK_F13, false)],
            "フックが入る前は、F13 は通る"
        );
        thread::sleep(Duration::from_millis(25));
    }
    assert!(installed, "キーを割り当てたあと、キーボードのフックが入る");

    // F13 は止まり、F14 は通る。マウスのボタンも通る。
    press_key(VK_F13);
    press_key(VK_F14);
    click(MouseButton::X1, 1);
    click(MouseButton::Middle, 1);
    flush_keys();
    flush_mouse();
    let passed = take_seen();
    let passed_key_events: Vec<Seen> = passed
        .iter()
        .copied()
        .filter(|s| matches!(s, Seen::Key { vk, .. } if *vk != VK_F15))
        .collect();
    assert_eq!(
        passed_key_events,
        vec![key(VK_F14, true), key(VK_F14, false)],
        "割り当てたキーだけが止まる"
    );
    let passed_mouse_events: Vec<Seen> = passed
        .iter()
        .copied()
        .filter(|s| matches!(s, Seen::Mouse { button, .. } if *button != MouseButton::Right))
        .collect();
    assert_eq!(
        passed_mouse_events,
        vec![
            mouse(MouseButton::X1, true),
            mouse(MouseButton::X1, false),
            mouse(MouseButton::Middle, true),
            mouse(MouseButton::Middle, false),
        ],
        "キーを割り当てているときは、マウスのボタンは止めない"
    );
    assert_eq!(triggers(&rx).len(), 1);

    // 押し続け（自動リピート）の間は、記録は 1 回だけ。離したあとの次の押下は、また記録される。
    hold_key(VK_F13, 5);
    flush_keys();
    assert_eq!(passed_keys(), vec![]);
    assert_eq!(triggers(&rx).len(), 1, "押し続けても 1 回だけ記録する");
    press_key(VK_F13);
    flush_keys();
    assert_eq!(
        triggers(&rx).len(),
        1,
        "離したあとの次の押下は、また記録する"
    );
    let _ = take_seen();

    // ---- 割り当てなし: すべて通る ----
    let status = hook.apply(Config::OFF);
    assert!(
        !status.mouse && !status.keyboard,
        "割り当てが無ければ、フックは 1 つも入れない: {status:?}"
    );
    click(MouseButton::X1, 1);
    click(MouseButton::X2, 1);
    flush_mouse();
    assert_eq!(
        passed_mouse(),
        vec![
            mouse(MouseButton::X1, true),
            mouse(MouseButton::X1, false),
            mouse(MouseButton::X2, true),
            mouse(MouseButton::X2, false),
        ]
    );
    // キーのフックが外れる（別のスレッドが外す）のを待って、F13 が通ることを確かめる。
    let mut released = false;
    for _ in 0..40 {
        press_key(VK_F13);
        flush_keys();
        let passed = passed_keys();
        let got = triggers(&rx);
        assert_eq!(got.len(), 0, "割り当てが無いので、記録は渡らない");
        if passed == vec![key(VK_F13, true), key(VK_F13, false)] {
            released = true;
            break;
        }
        thread::sleep(Duration::from_millis(25));
    }
    assert!(released, "割り当てを外すと、F13 も通る");

    // ---- 修飾キー付きのキー（Shift+F13。W-10）----
    let shift = Modifiers::new(false, false, true, false);
    hook.apply(assign(Some(ActiveTrigger::key(VK_F13, shift))));
    thread::sleep(Duration::from_millis(50));
    let _ = (take_seen(), reports(&rx));
    // Shift が無ければ当たらない（F13 は通る。記録されない）。
    press_key(VK_F13);
    flush_keys();
    assert_eq!(
        passed_keys(),
        vec![key(VK_F13, true), key(VK_F13, false)],
        "修飾キーが違えば、F13 は通る"
    );
    assert_eq!(reports(&rx), vec![], "修飾キーが違えば、記録されない");
    // Shift+F13: F13 は止まり、1 回だけ記録される。Shift は、そのまま通る。
    chord(&[VK_LSHIFT], VK_F13);
    flush_keys();
    let passed = passed_keys();
    assert!(
        !passed.contains(&key(VK_F13, true)) && !passed.contains(&key(VK_F13, false)),
        "割り当てた組み合わせの F13 は止まる: {passed:?}"
    );
    assert!(
        passed.contains(&key(VK_LSHIFT, true)),
        "修飾キー自体は通る: {passed:?}"
    );
    let got = reports(&rx);
    assert!(
        matches!(got.as_slice(), [Report::Trigger { .. }]),
        "1 回だけ記録される: {got:?}"
    );

    // ---- 登録の待機（W-10）----
    hook.apply(Config {
        trigger: None,
        mode: Mode::Register,
    });
    let _ = (take_seen(), reports(&rx));
    // 左右のボタンは通る（「キャンセル」を押せる）。拾わない。
    click(MouseButton::Left, 1);
    flush_mouse();
    assert_eq!(
        passed_mouse(),
        vec![
            mouse(MouseButton::Left, true),
            mouse(MouseButton::Left, false)
        ]
    );
    assert_eq!(reports(&rx), vec![]);
    // 「進む」ボタン: 止まって、候補として知らせる（押すのも離すのも）。
    click(MouseButton::X2, 1);
    flush_mouse();
    assert_eq!(passed_mouse(), vec![], "候補にしたボタンは止まる");
    assert_eq!(
        reports(&rx),
        vec![Report::Captured(ActiveTrigger::Mouse(MouseButton::X2))]
    );
    // F13: 候補（止まる）。
    press_key(VK_F13);
    flush_keys_registering();
    assert_eq!(passed_keys_registering(), vec![]);
    assert_eq!(
        reports(&rx),
        vec![Report::Captured(ActiveTrigger::key(
            VK_F13,
            Modifiers::NONE
        ))]
    );
    // 文字のキー（M）は、そのままでは候補にならない（通る）。
    press_key(VK_M);
    flush_keys_registering();
    assert_eq!(
        passed_keys_registering(),
        vec![key(VK_M, true), key(VK_M, false)]
    );
    assert_eq!(reports(&rx), vec![]);
    // Shift+F13 は、修飾キーつきの候補（F13 は止まる）。
    chord(&[VK_LSHIFT], VK_F13);
    flush_keys_registering();
    let passed = passed_keys_registering();
    assert!(!passed.contains(&key(VK_F13, true)), "{passed:?}");
    assert_eq!(
        reports(&rx),
        vec![Report::Captured(ActiveTrigger::key(VK_F13, shift))]
    );
    // Tab は通る（拾わない）。Esc は通したうえで、やめる合図を知らせる。
    press_key(VK_TAB);
    press_key(VK_ESCAPE);
    flush_keys_registering();
    let passed = passed_keys_registering();
    assert!(
        passed.contains(&key(VK_TAB, true)) && passed.contains(&key(VK_ESCAPE, true)),
        "{passed:?}"
    );
    assert_eq!(reports(&rx), vec![Report::Cancel]);
    hook.apply(Config::OFF);
    let _ = (take_seen(), reports(&rx));

    // ---- 終わり ----
    hook.stop();
}
