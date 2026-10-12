//! 全体のボタンの拾い方（CGEventTap）の雛形。型検査だけ通した。実機では動かしていない。
//!
//! Windows の `input/src/hook_win.rs`（WH_MOUSE_LL / WH_KEYBOARD_LL）の置き換えにあたる。
//! - 専用のスレッドで CFRunLoop を回し、コールバックでは判定（`logic::InputCore` にあたる部分）だけを行う。
//! - 割り当てたボタンの押下・離しは `CallbackResult::Drop` で横取りする（アクティブなタップ。アクセシビリティの許可が要る）。
//! - タップが時間切れ・ユーザー入力で止められたら、コールバックの中ですぐ有効に戻す。
//! - 許可が無いとタップを作れない（`Err`）。画面に理由を出す。

use std::sync::atomic::{AtomicUsize, Ordering};
use std::sync::mpsc::Sender;
use std::thread;

use core_foundation::base::TCFType;
use core_foundation::runloop::{kCFRunLoopCommonModes, CFRunLoop};
use core_graphics::event::{
    CGEvent, CGEventFlags, CGEventTap, CGEventTapLocation, CGEventTapOptions, CGEventTapPlacement,
    CGEventType, CallbackResult, EventField,
};

/// マウスのボタン。`jantama_input::logic::MouseButton` にあたる。
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum Button {
    Middle,
    /// 「戻る」。CGEvent のボタン番号は 3。
    X1,
    /// 「進む」。同じく 4。
    X2,
    Other(i64),
}

impl Button {
    /// CGEvent のボタン番号（0 左・1 右・2 中・3 戻る・4 進む。ドライバが変えることがある）。
    pub fn number(self) -> i64 {
        match self {
            Button::Middle => 2,
            Button::X1 => 3,
            Button::X2 => 4,
            Button::Other(n) => n,
        }
    }
}

/// 本体への知らせ。`logic::Report` にあたる。
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum Heard {
    MouseDown(Button),
    MouseUp(Button),
    /// macOS の仮想キーコード（kVK_*）と修飾キー。
    KeyDown {
        keycode: u16,
        command: bool,
        option: bool,
        control: bool,
        shift: bool,
    },
    KeyUp {
        keycode: u16,
    },
}

/// タップの機構（CFMachPort）の生ポインタ。コールバックの中から有効に戻すのに使う。
static TAP_PORT: AtomicUsize = AtomicUsize::new(0);

#[link(name = "ApplicationServices", kind = "framework")]
extern "C" {
    // アクセシビリティの許可（アクティブなタップを作れるか）。聞くだけ。
    fn AXIsProcessTrusted() -> bool;
}

extern "C" {
    fn CGEventTapEnable(tap: *const std::ffi::c_void, enable: bool);
    // 入力の監視（Input Monitoring）の許可。聞くだけ・求めるだけ。
    fn CGPreflightListenEventAccess() -> bool;
    fn CGRequestListenEventAccess() -> bool;
}

/// アクセシビリティの許可があるか（ダイアログは出さない）。アクティブなタップ（横取りできるタップ）に要る。
pub fn accessibility_granted() -> bool {
    // SAFETY: 引数の無い読み出しだけ。
    unsafe { AXIsProcessTrusted() }
}

/// 入力の監視の許可があるか（ダイアログは出さない）。
pub fn listen_access_granted() -> bool {
    // SAFETY: 引数の無い読み出しだけ。
    unsafe { CGPreflightListenEventAccess() }
}

/// 許可を求める（初回だけ、システムの確認が出る）。確かめ用のプログラムでは使っていない。
#[allow(dead_code)]
pub fn request_listen_access() -> bool {
    // SAFETY: 同上。
    unsafe { CGRequestListenEventAccess() }
}

fn button_of(event: &CGEvent) -> Button {
    match event.get_integer_value_field(EventField::MOUSE_EVENT_BUTTON_NUMBER) {
        2 => Button::Middle,
        3 => Button::X1,
        4 => Button::X2,
        n => Button::Other(n),
    }
}

/// タップを起こして、専用のスレッドで回す。`decide` が `true` を返した入力は横取りする。
/// 許可が無くてタップを作れなかったときは `Err`。
pub fn start(
    sink: Sender<Heard>,
    decide: impl Fn(&Heard) -> bool + Send + 'static,
) -> Result<thread::JoinHandle<()>, String> {
    let (ready_tx, ready_rx) = std::sync::mpsc::channel::<Result<(), String>>();
    let handle = thread::Builder::new()
        .name("input-tap".to_string())
        .spawn(move || {
            let events = vec![
                CGEventType::OtherMouseDown,
                CGEventType::OtherMouseUp,
                CGEventType::KeyDown,
                CGEventType::KeyUp,
            ];
            let callback = move |_proxy, kind: CGEventType, event: &CGEvent| {
                match kind {
                    // 時間がかかりすぎた・ユーザーの入力で止められた: すぐ有効に戻す（戻さないと以後の入力が届かない）。
                    CGEventType::TapDisabledByTimeout | CGEventType::TapDisabledByUserInput => {
                        let port = TAP_PORT.load(Ordering::SeqCst);
                        if port != 0 {
                            // SAFETY: 作ったタップのポート。スレッドが生きている間は有効。
                            unsafe { CGEventTapEnable(port as *const _, true) };
                        }
                        return CallbackResult::Keep;
                    }
                    _ => {}
                }
                let heard = match kind {
                    CGEventType::OtherMouseDown => Heard::MouseDown(button_of(event)),
                    CGEventType::OtherMouseUp => Heard::MouseUp(button_of(event)),
                    CGEventType::KeyDown => {
                        let flags = event.get_flags();
                        Heard::KeyDown {
                            keycode: event
                                .get_integer_value_field(EventField::KEYBOARD_EVENT_KEYCODE)
                                as u16,
                            command: flags.contains(CGEventFlags::CGEventFlagCommand),
                            option: flags.contains(CGEventFlags::CGEventFlagAlternate),
                            control: flags.contains(CGEventFlags::CGEventFlagControl),
                            shift: flags.contains(CGEventFlags::CGEventFlagShift),
                        }
                    }
                    CGEventType::KeyUp => Heard::KeyUp {
                        keycode: event.get_integer_value_field(EventField::KEYBOARD_EVENT_KEYCODE)
                            as u16,
                    },
                    _ => return CallbackResult::Keep,
                };
                // 本体への知らせはチャネルに入れるだけ（コールバックを遅らせない）。
                let swallow = decide(&heard);
                let _ = sink.send(heard);
                if swallow {
                    CallbackResult::Drop
                } else {
                    CallbackResult::Keep
                }
            };
            let tap = match CGEventTap::new(
                CGEventTapLocation::Session,
                CGEventTapPlacement::HeadInsertEventTap,
                CGEventTapOptions::Default,
                events,
                callback,
            ) {
                Ok(tap) => tap,
                Err(()) => {
                    let _ = ready_tx.send(Err(
                        "入力のタップを作れません（アクセシビリティの許可が要ります）".to_string(),
                    ));
                    return;
                }
            };
            TAP_PORT.store(
                tap.mach_port().as_concrete_TypeRef() as usize,
                Ordering::SeqCst,
            );
            let Ok(source) = tap.mach_port().create_runloop_source(0) else {
                let _ = ready_tx.send(Err("実行ループの入り口を作れません".to_string()));
                return;
            };
            // SAFETY: 定数の読み出しだけ。
            CFRunLoop::get_current().add_source(&source, unsafe { kCFRunLoopCommonModes });
            tap.enable();
            let _ = ready_tx.send(Ok(()));
            CFRunLoop::run_current();
            TAP_PORT.store(0, Ordering::SeqCst);
        })
        .map_err(|e| format!("スレッドを起こせません: {e}"))?;
    ready_rx
        .recv()
        .map_err(|_| "タップのスレッドが始まる前に終わりました".to_string())??;
    Ok(handle)
}
