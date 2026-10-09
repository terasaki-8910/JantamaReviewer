//! マウス・キーボードのフックの Windows 実装（WH_MOUSE_LL / WH_KEYBOARD_LL）。
//! 本体の中のフックと、管理者で動く補助プログラムが、同じものを使う（W-9）。
//!
//! 専用のスレッドでメッセージループを回し、フックの手続きでは判定（`logic::InputCore`）だけを行う。
//! 低レベルフックは手続きが遅いと Windows に外されるので、保存などの重い処理は、本体への知らせ（`sink`）の先で行う。
//! フックは、いまの設定が要る種類だけを入れる（`Config::needs_mouse_hook` / `needs_keyboard_hook`）。
//! 設定が何も要らなければ、フックは 1 つも入れない（補助プログラムがつながっている間の本体のフック）。
//!
//! 割り当てたボタンの押下・離しは横取りして、ほかのアプリに届けない（Chrome 版の雀魂で
//! サイドボタンが「戻る」として働くのを防ぐ）。ほかの入力は何も変えずに次へ渡す。

use std::sync::mpsc::{self, Sender};
use std::sync::{Mutex, OnceLock, PoisonError};
use std::thread;
use std::time::Duration;

use windows::Win32::Foundation::{HINSTANCE, LPARAM, LRESULT, WPARAM};
use windows::Win32::System::LibraryLoader::GetModuleHandleW;
use windows::Win32::System::Threading::GetCurrentThreadId;
use windows::Win32::UI::Input::KeyboardAndMouse::GetAsyncKeyState;
use windows::Win32::UI::WindowsAndMessaging::{
    CallNextHookEx, GetMessageW, PeekMessageW, PostThreadMessageW, SetWindowsHookExW,
    UnhookWindowsHookEx, HC_ACTION, HHOOK, KBDLLHOOKSTRUCT, MSG, MSLLHOOKSTRUCT, PM_NOREMOVE,
    WH_KEYBOARD_LL, WH_MOUSE_LL, WM_APP, WM_QUIT,
};

use crate::clock::now_ms;
use crate::keys::Modifiers;
use crate::logic::{Config, InputCore, Outcome, Report};

/// 設定が変わったことをフックのスレッドに知らせる（フックを入れる・外す）。
const WM_RECONFIGURE: u32 = WM_APP + 1;

/// 設定を反映したあと、フックのスレッドが返事を待つ側に伝えるまでの最長の時間。
const APPLY_TIMEOUT: Duration = Duration::from_secs(3);

/// フックの手続きの中身（設定と判定）。フックの手続きがロックを取らずに読む。
static CORE: InputCore = InputCore::new();

type Sink = Box<dyn Fn(Report) + Send + Sync>;

/// 本体への知らせの出口。フックの手続きの中で呼ばれるので、すぐ返る処理（チャネルへの送信など）にすること。
static SINK: OnceLock<Sink> = OnceLock::new();

/// 設定の反映の返事を待っている呼び出し。
static ACK: Mutex<Option<Sender<HookStatus>>> = Mutex::new(None);

/// 設定を変える呼び出しを、1 つずつにする。
static APPLY_LOCK: Mutex<()> = Mutex::new(());

/// いまのフックの状態。
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct HookStatus {
    /// マウスのフックが入っている。
    pub mouse: bool,
    /// キーボードのフックが入っている。
    pub keyboard: bool,
    /// 要るフックを入れられなかったときの理由。
    pub error: Option<String>,
}

/// フックのスレッドへの窓口。
#[derive(Debug, Clone, Copy)]
pub struct HookHandle {
    thread_id: u32,
}

impl HookHandle {
    /// 設定を変えて、フックのスレッドが入れ直し終えるのを待つ（最長 3 秒）。
    /// 返事が来なければ、フックを入れていない状態を返す。
    pub fn apply(&self, config: Config) -> HookStatus {
        let _turn = APPLY_LOCK.lock().unwrap_or_else(PoisonError::into_inner);
        let (tx, rx) = mpsc::channel();
        *ACK.lock().unwrap_or_else(PoisonError::into_inner) = Some(tx);
        CORE.set_config(config);
        // SAFETY: スレッド ID はフックのスレッドのもの。失敗しても設定自体は反映済み（返事が来ずに時間切れになる）。
        unsafe {
            let _ = PostThreadMessageW(self.thread_id, WM_RECONFIGURE, WPARAM(0), LPARAM(0));
        }
        match rx.recv_timeout(APPLY_TIMEOUT) {
            Ok(status) => status,
            Err(_) => {
                *ACK.lock().unwrap_or_else(PoisonError::into_inner) = None;
                HookStatus {
                    mouse: false,
                    keyboard: false,
                    error: Some("フックの入れ直しの返事が来ませんでした".to_string()),
                }
            }
        }
    }

    /// フックを外してスレッドを終える。
    pub fn stop(&self) {
        // SAFETY: 同上。
        unsafe {
            let _ = PostThreadMessageW(self.thread_id, WM_QUIT, WPARAM(0), LPARAM(0));
        }
    }
}

/// フックのスレッドを起こす。`initial` に合わせてフックを入れてから返す。
/// 割り当てた入力の知らせ（`Report`）は、フックの手続きの中で `sink` に渡される。プロセスにつき 1 度だけ呼べる。
pub fn start(
    initial: Config,
    sink: impl Fn(Report) + Send + Sync + 'static,
) -> Result<(HookHandle, HookStatus), String> {
    SINK.set(Box::new(sink))
        .map_err(|_| "フックはすでに開始しています".to_string())?;
    CORE.set_config(initial);

    let (ready_tx, ready_rx) = mpsc::channel::<Result<(u32, HookStatus), String>>();
    thread::Builder::new()
        .name("input-hook".to_string())
        .spawn(move || run_hook_thread(ready_tx))
        .map_err(|e| format!("フックのスレッドを起こせません: {e}"))?;
    let (thread_id, status) = ready_rx
        .recv()
        .map_err(|_| "フックのスレッドが始まる前に終わりました".to_string())??;
    Ok((HookHandle { thread_id }, status))
}

struct Hooks {
    module: HINSTANCE,
    mouse: Option<HHOOK>,
    keyboard: Option<HHOOK>,
}

fn run_hook_thread(ready: Sender<Result<(u32, HookStatus), String>>) {
    // SAFETY: フックのハンドルはこのスレッドの中だけで扱い、ループを抜けたら必ず外す。
    unsafe {
        // メッセージキューを先に作っておく（別のスレッドから PostThreadMessage できるように）。
        let mut msg = MSG::default();
        let _ = PeekMessageW(&mut msg, None, 0, 0, PM_NOREMOVE);

        let module = match GetModuleHandleW(None) {
            Ok(m) => HINSTANCE(m.0),
            Err(e) => {
                let _ = ready.send(Err(format!("モジュールを取得できません: {e}")));
                return;
            }
        };
        let mut hooks = Hooks {
            module,
            mouse: None,
            keyboard: None,
        };
        let status = sync_hooks(&mut hooks);
        let _ = ready.send(Ok((GetCurrentThreadId(), status)));

        // 低レベルフックの手続きは、このループが GetMessage で待っている間に呼ばれる。
        loop {
            let got = GetMessageW(&mut msg, None, 0, 0).0;
            if got <= 0 {
                break;
            }
            if msg.message == WM_RECONFIGURE {
                let status = sync_hooks(&mut hooks);
                let waiting = ACK.lock().unwrap_or_else(PoisonError::into_inner).take();
                if let Some(tx) = waiting {
                    let _ = tx.send(status);
                }
            }
        }

        if let Some(h) = hooks.mouse.take() {
            let _ = UnhookWindowsHookEx(h);
        }
        if let Some(h) = hooks.keyboard.take() {
            let _ = UnhookWindowsHookEx(h);
        }
        CORE.reset();
    }
}

/// いまの設定が要るフックだけを入れ、要らなくなったフックを外す。
unsafe fn sync_hooks(hooks: &mut Hooks) -> HookStatus {
    let config = CORE.config();
    let mut problems: Vec<String> = Vec::new();

    match (config.needs_mouse_hook(), hooks.mouse.is_some()) {
        (true, false) => {
            match unsafe { SetWindowsHookExW(WH_MOUSE_LL, Some(mouse_proc), Some(hooks.module), 0) }
            {
                Ok(h) => hooks.mouse = Some(h),
                Err(e) => problems.push(format!("マウスのフックを入れられません: {e}")),
            }
        }
        (false, true) => {
            if let Some(h) = hooks.mouse.take() {
                let _ = unsafe { UnhookWindowsHookEx(h) };
            }
            // 外したあとは離す知らせが届かないので、押下中の状態を捨てる。
            CORE.reset_mouse();
        }
        _ => {}
    }

    match (config.needs_keyboard_hook(), hooks.keyboard.is_some()) {
        (true, false) => {
            match unsafe {
                SetWindowsHookExW(WH_KEYBOARD_LL, Some(keyboard_proc), Some(hooks.module), 0)
            } {
                Ok(h) => hooks.keyboard = Some(h),
                Err(e) => problems.push(format!("キーボードのフックを入れられません: {e}")),
            }
        }
        (false, true) => {
            if let Some(h) = hooks.keyboard.take() {
                let _ = unsafe { UnhookWindowsHookEx(h) };
            }
            CORE.reset_keys();
        }
        _ => {}
    }

    HookStatus {
        mouse: hooks.mouse.is_some(),
        keyboard: hooks.keyboard.is_some(),
        error: if problems.is_empty() {
            None
        } else {
            Some(problems.join(" / "))
        },
    }
}

/// 判定の結果を受けて、本体に知らせ、横取りするなら `true` を返す。
fn deliver(outcome: Outcome) -> bool {
    if let Some(report) = outcome.report {
        if let Some(sink) = SINK.get() {
            sink(report);
        }
    }
    outcome.swallow
}

/// いま押されている修飾キー。キーを押した瞬間の状態を OS に尋ねる。
fn current_modifiers() -> Modifiers {
    let down = |vk: i32| {
        // SAFETY: 値を読むだけ。
        (unsafe { GetAsyncKeyState(vk) } as u16) & 0x8000 != 0
    };
    Modifiers::new(down(0x11), down(0x12), down(0x10), down(0x5B) || down(0x5C))
}

unsafe extern "system" fn mouse_proc(code: i32, wparam: WPARAM, lparam: LPARAM) -> LRESULT {
    if code == HC_ACTION as i32 {
        // SAFETY: WH_MOUSE_LL では lparam は MSLLHOOKSTRUCT へのポインタ。
        let info = unsafe { &*(lparam.0 as *const MSLLHOOKSTRUCT) };
        if deliver(CORE.on_mouse(wparam.0 as u32, info.mouseData, now_ms())) {
            return LRESULT(1);
        }
    }
    unsafe { CallNextHookEx(None, code, wparam, lparam) }
}

unsafe extern "system" fn keyboard_proc(code: i32, wparam: WPARAM, lparam: LPARAM) -> LRESULT {
    if code == HC_ACTION as i32 {
        // SAFETY: WH_KEYBOARD_LL では lparam は KBDLLHOOKSTRUCT へのポインタ。
        let info = unsafe { &*(lparam.0 as *const KBDLLHOOKSTRUCT) };
        if deliver(CORE.on_keyboard(wparam.0 as u32, info.vkCode, now_ms(), current_modifiers)) {
            return LRESULT(1);
        }
    }
    unsafe { CallNextHookEx(None, code, wparam, lparam) }
}

#[cfg(test)]
mod tests {
    use windows::Win32::UI::WindowsAndMessaging as w;

    use crate::logic::wm;

    #[test]
    fn message_numbers_match_windows() {
        assert_eq!(wm::KEYDOWN, w::WM_KEYDOWN);
        assert_eq!(wm::KEYUP, w::WM_KEYUP);
        assert_eq!(wm::SYSKEYDOWN, w::WM_SYSKEYDOWN);
        assert_eq!(wm::SYSKEYUP, w::WM_SYSKEYUP);
        assert_eq!(wm::LBUTTONDOWN, w::WM_LBUTTONDOWN);
        assert_eq!(wm::LBUTTONUP, w::WM_LBUTTONUP);
        assert_eq!(wm::RBUTTONDOWN, w::WM_RBUTTONDOWN);
        assert_eq!(wm::RBUTTONUP, w::WM_RBUTTONUP);
        assert_eq!(wm::MBUTTONDOWN, w::WM_MBUTTONDOWN);
        assert_eq!(wm::MBUTTONUP, w::WM_MBUTTONUP);
        assert_eq!(wm::XBUTTONDOWN, w::WM_XBUTTONDOWN);
        assert_eq!(wm::XBUTTONUP, w::WM_XBUTTONUP);
        assert_eq!(wm::XBUTTON1, u32::from(w::XBUTTON1));
        assert_eq!(wm::XBUTTON2, u32::from(w::XBUTTON2));
    }
}
