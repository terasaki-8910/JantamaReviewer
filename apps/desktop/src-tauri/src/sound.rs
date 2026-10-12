//! 迷いマークを記録したときの短く静かな音。
//!
//! 音のデータはファイルを同梱せず、起動時に計算で作る（`tick_wav`）。
//! 鳴らす処理は OS ごとの実装（Windows は `platform/win/sound.rs`。メモリ上の WAV を `PlaySoundW` で非同期に鳴らす）。

/// 音を鳴らす口。テストでは鳴らした回数を数えるだけの偽物に差し替える。
pub trait Sound: Send + Sync {
    fn tick(&self);
}

/// 何も鳴らさない。
#[derive(Debug, Default, Clone, Copy)]
pub struct NullSound;

impl Sound for NullSound {
    fn tick(&self) {}
}

const SAMPLE_RATE: u32 = 22_050;
const DURATION_MS: u32 = 50;
/// 満点に対する最大の振幅。ゲームの音に被っても耳障りにならない小ささにしている。
const PEAK: f64 = 0.16;
const FREQUENCY_HZ: f64 = 1_800.0;

/// 短い「カッ」という音の WAV（16bit・モノラル・22.05kHz・約 50ms）を作る。
/// 立ち上がりは 1ms、そのあと指数的に減衰する。
pub fn tick_wav() -> Vec<u8> {
    let samples = (SAMPLE_RATE * DURATION_MS / 1000) as usize;
    let mut pcm: Vec<u8> = Vec::with_capacity(samples * 2);
    for n in 0..samples {
        let t = n as f64 / SAMPLE_RATE as f64;
        let attack = (t / 0.001).min(1.0);
        let decay = (-t / 0.009).exp();
        let tone = (2.0 * std::f64::consts::PI * FREQUENCY_HZ * t).sin()
            + 0.35 * (2.0 * std::f64::consts::PI * FREQUENCY_HZ * 2.0 * t).sin();
        let value = (PEAK * attack * decay * tone / 1.35 * i16::MAX as f64).round() as i16;
        pcm.extend_from_slice(&value.to_le_bytes());
    }

    let data_len = pcm.len() as u32;
    let mut wav = Vec::with_capacity(44 + pcm.len());
    wav.extend_from_slice(b"RIFF");
    wav.extend_from_slice(&(36 + data_len).to_le_bytes());
    wav.extend_from_slice(b"WAVE");
    wav.extend_from_slice(b"fmt ");
    wav.extend_from_slice(&16u32.to_le_bytes());
    wav.extend_from_slice(&1u16.to_le_bytes()); // PCM
    wav.extend_from_slice(&1u16.to_le_bytes()); // モノラル
    wav.extend_from_slice(&SAMPLE_RATE.to_le_bytes());
    wav.extend_from_slice(&(SAMPLE_RATE * 2).to_le_bytes()); // バイト/秒
    wav.extend_from_slice(&2u16.to_le_bytes()); // ブロックサイズ
    wav.extend_from_slice(&16u16.to_le_bytes()); // ビット数
    wav.extend_from_slice(b"data");
    wav.extend_from_slice(&data_len.to_le_bytes());
    wav.extend_from_slice(&pcm);
    wav
}

#[cfg(test)]
mod tests {
    use super::*;

    fn u16_at(b: &[u8], i: usize) -> u16 {
        u16::from_le_bytes([b[i], b[i + 1]])
    }

    fn u32_at(b: &[u8], i: usize) -> u32 {
        u32::from_le_bytes([b[i], b[i + 1], b[i + 2], b[i + 3]])
    }

    #[test]
    fn tick_wav_is_a_valid_16bit_mono_pcm_riff_file() {
        let wav = tick_wav();
        assert_eq!(&wav[0..4], b"RIFF");
        assert_eq!(&wav[8..12], b"WAVE");
        assert_eq!(&wav[12..16], b"fmt ");
        assert_eq!(u16_at(&wav, 20), 1, "PCM");
        assert_eq!(u16_at(&wav, 22), 1, "モノラル");
        assert_eq!(u32_at(&wav, 24), SAMPLE_RATE);
        assert_eq!(u16_at(&wav, 34), 16, "16bit");
        assert_eq!(&wav[36..40], b"data");
        let data_len = u32_at(&wav, 40) as usize;
        assert_eq!(wav.len(), 44 + data_len);
        assert_eq!(u32_at(&wav, 4) as usize, 36 + data_len);
    }

    #[test]
    fn tick_wav_is_short_and_quiet() {
        let wav = tick_wav();
        let data_len = u32_at(&wav, 40) as usize;
        let ms = data_len as f64 / 2.0 / SAMPLE_RATE as f64 * 1000.0;
        assert!((40.0..=80.0).contains(&ms), "{ms}ms");
        let peak = wav[44..]
            .chunks_exact(2)
            .map(|c| i16::from_le_bytes([c[0], c[1]]).unsigned_abs())
            .max()
            .unwrap();
        assert!(peak > 1_000, "無音ではない: {peak}");
        assert!(
            f64::from(peak) <= 0.2 * f64::from(i16::MAX),
            "満点の 2 割以下: {peak}"
        );
    }

    #[test]
    fn tick_wav_fades_out_so_it_does_not_click_at_the_end() {
        let wav = tick_wav();
        let last = i16::from_le_bytes([wav[wav.len() - 2], wav[wav.len() - 1]]);
        assert!(last.unsigned_abs() < 40, "{last}");
    }

    #[test]
    fn tick_wav_is_deterministic() {
        assert_eq!(tick_wav(), tick_wav());
    }
}
