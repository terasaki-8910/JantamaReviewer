//! 本体の中のボタンのフックの Windows 実装（低レベルのマウス・キーボードのフック。`jantama_input::hook_win`）。
//! 補助プログラムが動いていないとき（管理者ではない窓の上）に、本体が使う。

use std::thread;
use std::time::{Duration, Instant};

use jantama_input::hook::HookStatus;
use jantama_input::hook_win::{self, HookHandle};
use jantama_input::logic::{Config, Report};

use crate::platform::InputHook;

struct WindowsHook(HookHandle);

impl InputHook for WindowsHook {
    fn apply(&self, config: Config) -> HookStatus {
        self.0.apply(config)
    }

    fn set_keyboard_allowed(&self, allowed: bool) -> HookStatus {
        self.0.set_keyboard_allowed(allowed)
    }

    fn stop(&self) {
        self.0.stop();
    }

    fn trace_info(&self) -> String {
        let (keys, mouse) = hook_win::event_counts();
        format!("（フックが見た入力: キー {keys}、マウス {mouse}）")
    }

    fn start_trace(&self) {
        spawn_hook_trace();
    }
}

/// フックのスレッドを起こす。最初は何も入れない（入れるのは、入力の流れが最初に決める設定のとき）。
/// 割り当てたボタンの押下と登録の候補は、フックの手続きの中で `sink` に渡される。プロセスにつき 1 度だけ呼べる。
pub fn start_input_hook(
    sink: impl Fn(Report) + Send + Sync + 'static,
) -> Result<Box<dyn InputHook>, String> {
    let (handle, _) = hook_win::start(Config::OFF, sink)?;
    Ok(Box::new(WindowsHook(handle)))
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
