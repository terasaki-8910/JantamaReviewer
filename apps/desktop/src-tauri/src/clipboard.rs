//! クリップボードの文字を読む（F1、E-15）。
//!
//! 雀魂で「牌譜を共有」→ コピーしてアプリに戻ったとき、画面（検討画面）が前面に来た時点で、クリップボードの文字を読み、
//! 牌譜リンクがあれば「この半荘を取り込みますか」と出す。牌譜リンクを探すのは画面側（エンジンの `detectPaipuLink`）で、
//! ここは文字を渡すだけ。
//!
//! 読むのは文字だけ（画像・ファイル・そのほかの形式は読まない）。書き込みはしない。
//! 牌譜リンクより明らかに長い文字（文書の丸ごとなど）は、画面に渡さない。
//!
//! 読む処理は、アプリの中で 1 つずつにする（`exclusive`）。クリップボードを「開いている」状態は、スレッドごとではなく
//! プロセス全体のもので、2 つのスレッドが同時に開ける。片方が `GetClipboardData` を呼んだり閉じたりすると、もう片方が
//! 読んでいる最中のデータの取っ手が解放され、`GlobalSize` が解放済みのメモリを触って、ヒープが壊れて落ちた
//! （実機で、起動の直後に 0xc0000374。非同期のコマンドが 2 つ重なったとき。8 本のスレッドで読み続ける試験では、鍵なしで毎回落ち、
//! 鍵ありでは 4 万回読んでも落ちなかった）。

use std::sync::{Mutex, PoisonError};

/// 画面に渡す文字の長さの上限（文字数）。牌譜リンクは数十文字で、前後の文があっても、この長さに収まる。
pub const MAX_CHARS: usize = 16 * 1024;

/// クリップボードを読む処理の鍵（プロセス全体で 1 つ）。
static READ_LOCK: Mutex<()> = Mutex::new(());

/// 同時に 2 つ入らないようにして `work` を動かす。鍵を持ったまま panic しても、次の読み取りは止めない。
fn exclusive<T>(work: impl FnOnce() -> T) -> T {
    let _guard = READ_LOCK.lock().unwrap_or_else(PoisonError::into_inner);
    work()
}

/// 読んだ文字を、画面に渡してよい形にする。空・空白だけ・長すぎるものは `None`。NUL 以降は捨てる。
pub fn normalize(text: String) -> Option<String> {
    let text = match text.find('\0') {
        Some(end) => text[..end].to_string(),
        None => text,
    };
    if text.trim().is_empty() || text.chars().count() > MAX_CHARS {
        return None;
    }
    Some(text)
}

/// クリップボードの文字を読む。文字が無い（画像だけ・空など）ときは `Ok(None)`。
/// 別のアプリがクリップボードを使っていて開けないときは、短く何度か試してから、エラーにする。
#[cfg(windows)]
pub fn read_text() -> Result<Option<String>, String> {
    use clipboard_win::{formats, is_format_avail};

    exclusive(|| {
        if !is_format_avail(formats::CF_UNICODETEXT) {
            return Ok(None);
        }
        let text = clipboard_win::get_clipboard_string()
            .map_err(|e| format!("クリップボードを読めませんでした: {e}"))?;
        Ok(normalize(text))
    })
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::sync::atomic::{AtomicUsize, Ordering};
    use std::thread;
    use std::time::Duration;

    #[test]
    fn reads_never_overlap_even_when_many_threads_ask_at_once() {
        // 実機の落ち方（0xc0000374）の原因は、読む処理が重なったこと。重ならないことを確かめる。
        let inside = AtomicUsize::new(0);
        let most = AtomicUsize::new(0);
        thread::scope(|scope| {
            for _ in 0..16 {
                scope.spawn(|| {
                    for _ in 0..20 {
                        exclusive(|| {
                            let now = inside.fetch_add(1, Ordering::SeqCst) + 1;
                            most.fetch_max(now, Ordering::SeqCst);
                            thread::sleep(Duration::from_micros(200));
                            inside.fetch_sub(1, Ordering::SeqCst);
                        });
                    }
                });
            }
        });
        assert_eq!(most.load(Ordering::SeqCst), 1);
        assert_eq!(inside.load(Ordering::SeqCst), 0);
    }

    #[test]
    fn a_panic_inside_a_read_does_not_stop_the_next_one() {
        let result = thread::spawn(|| exclusive(|| panic!("読み取りの途中の失敗"))).join();
        assert!(result.is_err());
        assert_eq!(exclusive(|| 7), 7);
    }

    #[test]
    fn normal_text_passes_through_unchanged() {
        assert_eq!(normalize("abc 牌譜".into()), Some("abc 牌譜".to_string()));
        // 前後の空白や改行も、そのまま（牌譜リンクの検出が、前後の空白を無視する）。
        assert_eq!(normalize("  x\r\n".into()), Some("  x\r\n".to_string()));
    }

    #[test]
    fn empty_or_blank_text_is_nothing() {
        assert_eq!(normalize(String::new()), None);
        assert_eq!(normalize("  \r\n\t".into()), None);
        assert_eq!(normalize("\0abc".into()), None);
    }

    #[test]
    fn text_after_a_nul_is_dropped() {
        assert_eq!(normalize("abc\0def".into()), Some("abc".to_string()));
    }

    #[test]
    fn text_longer_than_the_limit_is_not_passed_on() {
        assert!(normalize("あ".repeat(MAX_CHARS)).is_some());
        assert_eq!(normalize("あ".repeat(MAX_CHARS + 1)), None);
    }
}
