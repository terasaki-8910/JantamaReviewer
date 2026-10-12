//! マウス・キーボードのフックの Windows 実装（WH_MOUSE_LL / WH_KEYBOARD_LL）。
//! 本体の中のフックと、管理者で動く補助プログラムが、同じものを使う（W-9）。
//!
//! 専用のスレッドでメッセージループを回し、フックの手続きでは判定（`logic::InputCore`）だけを行う。
//! 低レベルフックは手続きが遅いと Windows に外されるので、保存などの重い処理は、本体への知らせ（`sink`）の先で行う。
//! フックは、いまの設定が要る種類だけを入れる（`Config::needs_mouse_hook` / `wants_keyboard_hook`）。
//! 設定が何も要らなければ、フックは 1 つも入れない（補助プログラムがつながっている間の本体のフック）。
//!
//! 割り当てたボタンの押下・離しは横取りして、ほかのアプリに届けない（Chrome 版の雀魂で
//! サイドボタンが「戻る」として働くのを防ぐ）。ほかの入力は何も変えずに次へ渡す。

use std::sync::atomic::{AtomicBool, AtomicU64, AtomicUsize, Ordering};
use std::sync::mpsc::{self, Sender};
use std::sync::{Mutex, OnceLock, PoisonError};
use std::thread;
use std::time::{Duration, Instant};

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
pub use crate::hook::HookStatus;
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

/// キーボードのフックを入れてよいか（`Config::wants_keyboard_hook`）。本体は、自分の窓が前面にある間は `false` にする。
static KEYBOARD_ALLOWED: AtomicBool = AtomicBool::new(true);

/// フックの手続きが受け取った入力の数（原因調べのため。ボタンが効かないとき、フックまで入力が届いているかが分かる）。
static KEY_EVENTS: AtomicU64 = AtomicU64::new(0);
static MOUSE_EVENTS: AtomicU64 = AtomicU64::new(0);

/// フックの手続きが、これまでに受け取った入力の数（キーボード、マウス）。
pub fn event_counts() -> (u64, u64) {
    (
        KEY_EVENTS.load(Ordering::Relaxed),
        MOUSE_EVENTS.load(Ordering::Relaxed),
    )
}

/// フックを起こした時刻（入力の時刻の基準）。
static STARTED: OnceLock<Instant> = OnceLock::new();

/// 直近のキーボードの入力の記録（原因調べのため。仮想キーコード・フラグ・起こしてからの時刻を 1 つの整数に詰める）。
const RING_LEN: usize = 128;
static RING: [AtomicU64; RING_LEN] = [const { AtomicU64::new(0) }; RING_LEN];
static RING_HEAD: AtomicUsize = AtomicUsize::new(0);

/// フックの手続き 1 回にかかった時間の最大（マイクロ秒）。長いと Windows にフックを外される。
static MAX_PROC_US: AtomicU64 = AtomicU64::new(0);

/// キーボードのフックが受け取った入力 1 つ（原因調べ用）。
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub struct KeyNote {
    pub vk: u32,
    /// `KBDLLHOOKSTRUCT.flags`（0x10 は他のプロセスが注入した入力）。
    pub flags: u32,
    /// フックのスレッドを起こしてからの時間（ミリ秒）。
    pub at_ms: u64,
}

fn note_key(vk: u32, flags: u32) {
    let at_ms = STARTED
        .get()
        .map_or(0, |started| started.elapsed().as_millis() as u64);
    let slot = RING_HEAD.fetch_add(1, Ordering::AcqRel);
    let packed = u64::from(vk & 0xFFFF) | (u64::from(flags & 0xFFFF) << 16) | (at_ms << 32);
    RING[slot % RING_LEN].store(packed, Ordering::Release);
}

fn note_duration(entered: Instant) {
    let us = entered.elapsed().as_micros() as u64;
    MAX_PROC_US.fetch_max(us, Ordering::Relaxed);
}

/// `next` から後のキーボードの入力を返し、`next` を進める（原因調べ用。取りこぼしても構わない）。
pub fn recent_keys(next: &mut usize) -> Vec<KeyNote> {
    let head = RING_HEAD.load(Ordering::Acquire);
    let from = (*next).max(head.saturating_sub(RING_LEN));
    let notes = (from..head)
        .map(|slot| {
            let packed = RING[slot % RING_LEN].load(Ordering::Acquire);
            KeyNote {
                vk: (packed & 0xFFFF) as u32,
                flags: ((packed >> 16) & 0xFFFF) as u32,
                at_ms: packed >> 32,
            }
        })
        .collect();
    *next = head;
    notes
}

/// フックの手続き 1 回にかかった時間の最大（マイクロ秒）。
pub fn max_proc_micros() -> u64 {
    MAX_PROC_US.load(Ordering::Relaxed)
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
        self.reconfigure(|| CORE.set_config(config))
    }

    /// キーボードのフックを入れてよいかを変えて、入れ直し終えるのを待つ（最長 3 秒）。
    /// `false` の間は、設定がキーボードのフックを要るときも、入れない（`Config::wants_keyboard_hook`）。
    pub fn set_keyboard_allowed(&self, allowed: bool) -> HookStatus {
        self.reconfigure(|| KEYBOARD_ALLOWED.store(allowed, Ordering::SeqCst))
    }

    fn reconfigure(&self, change: impl FnOnce()) -> HookStatus {
        let _turn = APPLY_LOCK.lock().unwrap_or_else(PoisonError::into_inner);
        let (tx, rx) = mpsc::channel();
        *ACK.lock().unwrap_or_else(PoisonError::into_inner) = Some(tx);
        change();
        // SAFETY: スレッド ID はフックのスレッドのもの。失敗しても設定自体は反映済み（返事が来ずに時間切れになる）。
        unsafe {
            let _ = PostThreadMessageW(self.thread_id, WM_RECONFIGURE, WPARAM(0), LPARAM(0));
        }
        match rx.recv_timeout(APPLY_TIMEOUT) {
            Ok(status) => status,
            Err(_) => {
                *ACK.lock().unwrap_or_else(PoisonError::into_inner) = None;
                HookStatus::none("フックの入れ直しの返事が来ませんでした")
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
    let _ = STARTED.set(Instant::now());
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

    let keyboard_allowed = KEYBOARD_ALLOWED.load(Ordering::SeqCst);
    match (
        config.wants_keyboard_hook(keyboard_allowed),
        hooks.keyboard.is_some(),
    ) {
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
        MOUSE_EVENTS.fetch_add(1, Ordering::Relaxed);
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
        let entered = Instant::now();
        KEY_EVENTS.fetch_add(1, Ordering::Relaxed);
        note_key(info.vkCode, info.flags.0);
        if deliver(CORE.on_keyboard(wparam.0 as u32, info.vkCode, now_ms(), current_modifiers)) {
            note_duration(entered);
            return LRESULT(1);
        }
        // SAFETY: 受け取った値をそのまま次のフックへ渡す。
        let next = unsafe { CallNextHookEx(None, code, wparam, lparam) };
        note_duration(entered);
        return next;
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
