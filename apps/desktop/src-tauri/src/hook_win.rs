//! マウス・キーボードのフックの Windows 実装（WH_MOUSE_LL / WH_KEYBOARD_LL）。
//!
//! 専用のスレッドでメッセージループを回し、フックの手続きでは判定（`hook::HookCore`）だけを行う。
//! 低レベルフックは手続きが遅いと Windows に外されるので、スクリーンショットや保存などの重い処理は
//! チャネルで別のスレッドに渡す。
//!
//! 割り当てたボタンの押下・離しは横取りして、ほかのアプリに届けない（Chrome 版の雀魂で
//! サイドボタンが「戻る」として働くのを防ぐ）。ほかの入力は何も変えずに次へ渡す。
//! キーボードのフックは、割り当てがキーのときだけ入れる。

use std::sync::mpsc::{self, Sender};
use std::sync::OnceLock;
use std::thread;

use windows::Win32::Foundation::{HINSTANCE, LPARAM, LRESULT, WPARAM};
use windows::Win32::System::LibraryLoader::GetModuleHandleW;
use windows::Win32::System::Threading::GetCurrentThreadId;
use windows::Win32::UI::WindowsAndMessaging::{
    CallNextHookEx, GetMessageW, PeekMessageW, PostThreadMessageW, SetWindowsHookExW,
    UnhookWindowsHookEx, HC_ACTION, HHOOK, KBDLLHOOKSTRUCT, MSG, MSLLHOOKSTRUCT, PM_NOREMOVE,
    WH_KEYBOARD_LL, WH_MOUSE_LL, WM_APP, WM_QUIT,
};

use crate::clock::now_ms;
use crate::hook::{ActiveTrigger, HookCore, TriggerEvent};

/// 割り当てが変わったことをフックのスレッドに知らせる（キーボードのフックを入れる・外す）。
const WM_RECONFIGURE: u32 = WM_APP + 1;

/// フックの手続きの中身（割り当てと判定）。フックの手続きがロックを取らずに読む。
static CORE: HookCore = HookCore::new();
static SENDER: OnceLock<Sender<TriggerEvent>> = OnceLock::new();

/// フックのスレッドへの窓口。
#[derive(Debug, Clone, Copy)]
pub struct HookHandle {
    thread_id: u32,
}

impl HookHandle {
    /// 割り当てを変える。
    pub fn set_trigger(&self, trigger: Option<ActiveTrigger>) {
        CORE.set_trigger(trigger);
        // SAFETY: スレッド ID はフックのスレッドのもの。失敗しても割り当て自体は反映済み。
        unsafe {
            let _ = PostThreadMessageW(self.thread_id, WM_RECONFIGURE, WPARAM(0), LPARAM(0));
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

/// フックのスレッドを起こす。割り当てた入力があると、押された時刻を `tx` に送る。
pub fn start(
    initial: Option<ActiveTrigger>,
    tx: Sender<TriggerEvent>,
) -> Result<HookHandle, String> {
    SENDER
        .set(tx)
        .map_err(|_| "フックはすでに開始しています".to_string())?;
    CORE.set_trigger(initial);

    let (ready_tx, ready_rx) = mpsc::channel::<Result<u32, String>>();
    thread::Builder::new()
        .name("input-hook".to_string())
        .spawn(move || run_hook_thread(ready_tx))
        .map_err(|e| format!("フックのスレッドを起こせません: {e}"))?;
    let thread_id = ready_rx
        .recv()
        .map_err(|_| "フックのスレッドが始まる前に終わりました".to_string())??;
    Ok(HookHandle { thread_id })
}

fn run_hook_thread(ready: Sender<Result<u32, String>>) {
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
        let mouse = match SetWindowsHookExW(WH_MOUSE_LL, Some(mouse_proc), Some(module), 0) {
            Ok(h) => h,
            Err(e) => {
                let _ = ready.send(Err(format!("マウスのフックを入れられません: {e}")));
                return;
            }
        };
        let mut keyboard: Option<HHOOK> = None;
        sync_keyboard_hook(&mut keyboard, module);
        let _ = ready.send(Ok(GetCurrentThreadId()));

        // 低レベルフックの手続きは、このループが GetMessage で待っている間に呼ばれる。
        loop {
            let got = GetMessageW(&mut msg, None, 0, 0).0;
            if got <= 0 {
                break;
            }
            if msg.message == WM_RECONFIGURE {
                sync_keyboard_hook(&mut keyboard, module);
            }
        }

        let _ = UnhookWindowsHookEx(mouse);
        if let Some(h) = keyboard.take() {
            let _ = UnhookWindowsHookEx(h);
        }
    }
}

/// 割り当てがキーのときだけキーボードのフックを入れ、そうでなければ外す。
unsafe fn sync_keyboard_hook(slot: &mut Option<HHOOK>, module: HINSTANCE) {
    let wanted = CORE
        .trigger()
        .is_some_and(ActiveTrigger::needs_keyboard_hook);
    match (wanted, slot.is_some()) {
        (true, false) => {
            *slot =
                unsafe { SetWindowsHookExW(WH_KEYBOARD_LL, Some(keyboard_proc), Some(module), 0) }
                    .ok();
        }
        (false, true) => {
            if let Some(h) = slot.take() {
                let _ = unsafe { UnhookWindowsHookEx(h) };
            }
        }
        _ => {}
    }
}

/// 判定の結果を受けて、記録の担当に合図を渡し、横取りするなら `true` を返す。
fn deliver((swallow, signal): (bool, Option<TriggerEvent>)) -> bool {
    if let Some(signal) = signal {
        if let Some(tx) = SENDER.get() {
            // 受け手が居なくなっていても、入力の処理は止めない。
            let _ = tx.send(signal);
        }
    }
    swallow
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
        if deliver(CORE.on_keyboard(wparam.0 as u32, info.vkCode, now_ms())) {
            return LRESULT(1);
        }
    }
    unsafe { CallNextHookEx(None, code, wparam, lparam) }
}
