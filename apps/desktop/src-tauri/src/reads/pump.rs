//! 読み取りを別の担当（スレッド）に任せる道具。モデルを取るとき（`download.rs`）に、呼ぶ側が、読み取りの待ちの間も、
//! 取り消しと「一定の時間、1 バイトも来ない」という停止に、すぐ応えられるようにする。
//!
//! 読み取り（`Read::read`）は、通信が止まると、いつまでも戻らないことがある。そのまま呼ぶと、取り消しのボタンを押しても、読み取りが
//! 戻るまで止められない。そこで、読み取りだけを別の担当にやらせ、呼ぶ側は、短い間隔で待ちながら、旗（取り消し）を見る。
//! 呼ぶ側が先に降りたとき（`Pump` を捨てたとき）、担当は、いまの読み取りが戻ったところで、自分から終わる。

use std::io::{self, ErrorKind, Read};
use std::sync::mpsc::{self, Receiver, RecvTimeoutError};
use std::thread;
use std::time::Duration;

/// 担当から届く 1 つの知らせ。
enum Piece {
    Data(Vec<u8>),
    End,
    Failed(io::Error),
}

/// 次に分かったこと。
#[derive(Debug)]
pub enum Next {
    /// 読めた分。
    Data(Vec<u8>),
    /// 最後まで読んだ。
    End,
    /// 読み取りが失敗した。
    Failed(io::Error),
    /// 待った間、何も届かなかった（まだ終わっていない）。
    Idle,
}

/// 読み取りの担当と、その知らせの受け口。
pub struct Pump {
    receiver: Receiver<Piece>,
}

/// 担当が溜めてよい塊の数（呼ぶ側が書くのより読むほうが速いときに、メモリが増えないように）。
const QUEUED_CHUNKS: usize = 8;

impl Pump {
    /// `reader` を読む担当を起こす。1 回の読み取りは、最大 `chunk` バイト。
    pub fn spawn(mut reader: Box<dyn Read + Send>, chunk: usize) -> io::Result<Pump> {
        let (sender, receiver) = mpsc::sync_channel::<Piece>(QUEUED_CHUNKS);
        thread::Builder::new()
            .name("reads-model-reader".to_string())
            .spawn(move || {
                let mut buffer = vec![0u8; chunk.max(1)];
                loop {
                    let piece = match reader.read(&mut buffer) {
                        Ok(0) => Piece::End,
                        Ok(read) => Piece::Data(buffer[..read].to_vec()),
                        Err(e) if e.kind() == ErrorKind::Interrupted => continue,
                        Err(e) => Piece::Failed(e),
                    };
                    let last = !matches!(piece, Piece::Data(_));
                    // 受け口が無くなっていたら（呼ぶ側が先に降りた）、ここで終わる
                    if sender.send(piece).is_err() || last {
                        return;
                    }
                }
            })?;
        Ok(Pump { receiver })
    }

    /// 次の知らせを、最大 `wait` だけ待つ。
    pub fn next(&self, wait: Duration) -> Next {
        match self.receiver.recv_timeout(wait) {
            Ok(Piece::Data(bytes)) => Next::Data(bytes),
            Ok(Piece::End) => Next::End,
            Ok(Piece::Failed(e)) => Next::Failed(e),
            Err(RecvTimeoutError::Timeout) => Next::Idle,
            // 終わりも失敗も告げずに、担当が消えた（担当が止まった）
            Err(RecvTimeoutError::Disconnected) => {
                Next::Failed(io::Error::other("読み取りの担当が止まりました"))
            }
        }
    }
}

#[cfg(test)]
mod tests {
    use std::io::Cursor;
    use std::sync::{Arc, Condvar, Mutex};
    use std::time::Instant;

    use super::*;

    const LONG: Duration = Duration::from_secs(5);

    /// 読めた分を、終わりまで集める。
    fn drain(pump: &Pump) -> Result<Vec<u8>, io::Error> {
        let mut all = Vec::new();
        loop {
            match pump.next(LONG) {
                Next::Data(bytes) => all.extend(bytes),
                Next::End => return Ok(all),
                Next::Failed(e) => return Err(e),
                Next::Idle => panic!("待ちすぎた"),
            }
        }
    }

    #[test]
    fn the_pump_hands_over_everything_in_order_in_chunks_no_larger_than_asked() {
        let bytes: Vec<u8> = (0..=255u8).cycle().take(10_000).collect();
        let pump = Pump::spawn(Box::new(Cursor::new(bytes.clone())), 1_000).unwrap();
        let mut chunks = Vec::new();
        loop {
            match pump.next(LONG) {
                Next::Data(data) => chunks.push(data),
                Next::End => break,
                other => panic!("{other:?}"),
            }
        }
        assert!(chunks
            .iter()
            .all(|chunk| !chunk.is_empty() && chunk.len() <= 1_000));
        assert_eq!(chunks.concat(), bytes);
        // 終わったあとに待っても、担当は消えているだけ（知らせは増えない）
        assert!(matches!(
            pump.next(Duration::from_millis(10)),
            Next::Failed(_)
        ));
    }

    #[test]
    fn an_empty_reader_ends_at_once() {
        let pump = Pump::spawn(Box::new(Cursor::new(Vec::new())), 16).unwrap();
        assert_eq!(drain(&pump).unwrap(), Vec::<u8>::new());
    }

    /// 少し読めてから、失敗する読み取り。
    struct FailsAfter {
        first: Option<Vec<u8>>,
    }

    impl Read for FailsAfter {
        fn read(&mut self, buffer: &mut [u8]) -> io::Result<usize> {
            match self.first.take() {
                Some(bytes) => {
                    buffer[..bytes.len()].copy_from_slice(&bytes);
                    Ok(bytes.len())
                }
                None => Err(io::Error::new(ErrorKind::ConnectionReset, "切れました")),
            }
        }
    }

    #[test]
    fn a_failed_read_is_reported_after_the_bytes_that_were_read() {
        let pump = Pump::spawn(
            Box::new(FailsAfter {
                first: Some(b"abc".to_vec()),
            }),
            16,
        )
        .unwrap();
        assert!(matches!(pump.next(LONG), Next::Data(data) if data == b"abc"));
        match pump.next(LONG) {
            Next::Failed(e) => assert_eq!(e.kind(), ErrorKind::ConnectionReset),
            other => panic!("{other:?}"),
        }
    }

    /// 開けてもらうまで、読み取りが戻らない（通信が止まった）読み取り。
    struct Stalled {
        gate: Arc<(Mutex<bool>, Condvar)>,
    }

    impl Read for Stalled {
        fn read(&mut self, _buffer: &mut [u8]) -> io::Result<usize> {
            let (open, signal) = &*self.gate;
            let mut open = open.lock().unwrap();
            while !*open {
                open = signal.wait(open).unwrap();
            }
            Ok(0)
        }
    }

    #[test]
    fn a_stalled_read_does_not_block_the_caller_which_can_give_up() {
        let gate = Arc::new((Mutex::new(false), Condvar::new()));
        let pump = Pump::spawn(
            Box::new(Stalled {
                gate: Arc::clone(&gate),
            }),
            16,
        )
        .unwrap();
        // 読み取りが戻らなくても、呼ぶ側は、決めた時間で戻ってくる
        let started = Instant::now();
        for _ in 0..3 {
            assert!(matches!(pump.next(Duration::from_millis(30)), Next::Idle));
        }
        assert!(started.elapsed() < Duration::from_secs(2));
        // 呼ぶ側が降りても、担当は、読み取りが戻ったところで終わる（開けて、確かめる）
        drop(pump);
        let (open, signal) = &*gate;
        *open.lock().unwrap() = true;
        signal.notify_all();
    }

    #[test]
    fn a_pump_that_lost_its_reader_thread_reports_a_failure_not_an_end() {
        struct Panics;
        impl Read for Panics {
            fn read(&mut self, _buffer: &mut [u8]) -> io::Result<usize> {
                panic!("試験のための panic");
            }
        }
        let pump = Pump::spawn(Box::new(Panics), 16).unwrap();
        match pump.next(LONG) {
            Next::Failed(e) => assert!(e.to_string().contains("止まりました"), "{e}"),
            other => panic!("{other:?}"),
        }
    }
}
