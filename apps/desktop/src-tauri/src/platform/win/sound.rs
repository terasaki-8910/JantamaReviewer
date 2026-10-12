//! 迷いマークの音の Windows 実装。メモリ上の WAV（`sound::tick_wav`）を `PlaySoundW` で非同期に鳴らす。

use std::sync::OnceLock;

use windows::core::PCWSTR;
use windows::Win32::Media::Audio::{PlaySoundW, SND_ASYNC, SND_MEMORY, SND_NODEFAULT};

use crate::sound::{tick_wav, Sound};

/// `PlaySoundW` は非同期再生の間、メモリを読み続けるので、プロセスの終わりまで生かす。
static TICK: OnceLock<Vec<u8>> = OnceLock::new();

/// Windows で鳴らす。
#[derive(Debug, Default, Clone, Copy)]
pub struct WindowsSound;

impl Sound for WindowsSound {
    fn tick(&self) {
        let wav = TICK.get_or_init(tick_wav);
        // 鳴らせなくても記録には影響しないので、結果は見ない。
        // SAFETY: wav は 'static で、SND_MEMORY の間ずっと有効。
        unsafe {
            let _ = PlaySoundW(
                PCWSTR(wav.as_ptr().cast()),
                None,
                SND_MEMORY | SND_ASYNC | SND_NODEFAULT,
            );
        }
    }
}
