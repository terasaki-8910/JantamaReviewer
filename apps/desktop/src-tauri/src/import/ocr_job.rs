//! 取り込みの文字認識（F11、S-3）。
//!
//! 取り込みのときだけ（対局のあと）、半荘の迷いマーク・評価のスクリーンショット（すでにファイルに保存されたもの）を、
//! 画像から画面中央の板（局・残り枚数・点数）の文字として読み、結果を半荘のフォルダの `ocr.json` に残す。
//! 同じ画像は読み直さない。ウィジェット・ボタンを拾う部分・撮影・記録・補助プログラムのコードは、文字認識を使わない
//! （文字認識のクレート `jantama-ocr` を使ってよいソースは、このファイルだけ。`tests/safety.rs` の S-3 が確かめる）。
//!
//! 画像から行を読む部分は `LineReader` という口にして、準備（どの画像を読むか）と実行（読んで写しに入れる）は、
//! 偽の読み取りで単体試験できるようにしてある。製品の読み取り `WindowsReader` は、専用のスレッドで動く
//! Windows の日本語の文字認識で、`spawn_blocking` などの、画面とは別のスレッドから使う。

use std::path::{Path, PathBuf};

use jantama_ocr::{OcrError, OcrWorker, GEOMETRY_ID};

use crate::store::{OcrCache, OcrEntry};

/// 画像 1 枚から、行ごとの文字を読む口。
pub trait LineReader {
    fn read_lines(&self, png: &Path) -> Result<Vec<String>, OcrError>;
}

/// 製品の読み取り: 専用のスレッドで動く、Windows の日本語の文字認識（画面中央の板を切り出して、3 倍にして読む）。
pub struct WindowsReader {
    worker: OcrWorker,
}

impl WindowsReader {
    /// 担当を起こす。日本語の文字認識が使えなければ、`OcrError::JapaneseEngineMissing`。待つので、画面のスレッドからは呼ばない。
    pub fn start() -> Result<WindowsReader, OcrError> {
        Ok(WindowsReader {
            worker: OcrWorker::start()?,
        })
    }
}

impl LineReader for WindowsReader {
    fn read_lines(&self, png: &Path) -> Result<Vec<String>, OcrError> {
        self.worker.read_center_lines(png)
    }
}

/// 読む画像 1 枚。
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct Shot {
    /// 半荘のフォルダからの相対パス（写しの鍵）。
    pub relative: String,
    pub absolute: PathBuf,
}

/// 半荘 1 つ分の仕事。`cache` は、これまでの写し（切り出しの決まりが同じなものだけ）に、読んだ結果を足していく。
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct SessionJob {
    pub session_id: String,
    pub cache: OcrCache,
    /// まだ読んでいない（または、前は読めなかった）画像。
    pub todo: Vec<Shot>,
    /// 写しが、ファイルにある内容から変わったか（変わっていなければ、書き直さない）。
    pub changed: bool,
}

/// 進み具合。
#[derive(Debug, Clone, Copy, PartialEq, Eq, serde::Serialize)]
pub struct Progress {
    pub done: usize,
    pub total: usize,
}

/// 半荘 1 つ分の仕事を決める。
/// - これまでの写しの切り出しの決まりが、いまの決まりと違えば、写しは捨てて、全部を読み直す。
/// - 同じなら、写しにある画像のうち、読めていたものは読み直さない（読めなかった記録のあるものと、写しにないものを読む）。
/// - 写しにあって、いまの画像の一覧に無いもの（取り消された記録の画像など）は、写しに残さない。
pub fn plan_session(session_id: &str, shots: Vec<Shot>, existing: Option<OcrCache>) -> SessionJob {
    let usable = existing
        .as_ref()
        .filter(|cache| cache.geometry == GEOMETRY_ID);
    let mut cache = OcrCache {
        geometry: GEOMETRY_ID.to_string(),
        entries: Default::default(),
    };
    let mut todo = Vec::new();
    for shot in shots {
        let known = usable
            .as_ref()
            .and_then(|old| old.entries.get(&shot.relative))
            .filter(|entry| entry.error.is_none());
        match known {
            Some(entry) => {
                cache.entries.insert(shot.relative.clone(), entry.clone());
            }
            None => todo.push(shot),
        }
    }
    let changed = match &existing {
        Some(old) => old != &cache,
        None => !cache.entries.is_empty(),
    };
    SessionJob {
        session_id: session_id.to_string(),
        cache,
        todo,
        changed,
    }
}

/// 続けられない失敗か（日本語の文字認識が使えない・担当が止まった。どの画像でも同じ失敗になる）。
fn is_fatal(error: &OcrError) -> bool {
    matches!(error, OcrError::JapaneseEngineMissing | OcrError::Worker(_))
}

/// 半荘 1 つ分の仕事を進める。画像 1 枚ごとに `on_each` に知らせる。
/// 1 枚が読めなかったとき（開けない・壊れているなど）は、理由を写しに入れて続ける。
/// 続けられない失敗（`is_fatal`）のときは、そこで止めてエラーを返す（`job.cache` には、そこまでの分が入っている）。
pub fn run_job(
    reader: &dyn LineReader,
    job: &mut SessionJob,
    on_each: &mut dyn FnMut(),
) -> Result<(), OcrError> {
    let todo = std::mem::take(&mut job.todo);
    for (index, shot) in todo.iter().enumerate() {
        match reader.read_lines(&shot.absolute) {
            Ok(lines) => {
                job.changed = true;
                job.cache
                    .entries
                    .insert(shot.relative.clone(), OcrEntry { lines, error: None });
            }
            Err(e) if is_fatal(&e) => {
                job.todo = todo[index..].to_vec();
                return Err(e);
            }
            Err(e) => {
                job.changed = true;
                job.cache.entries.insert(
                    shot.relative.clone(),
                    OcrEntry {
                        lines: Vec::new(),
                        error: Some(e.to_string()),
                    },
                );
            }
        }
        on_each();
    }
    Ok(())
}

#[cfg(test)]
mod tests {
    use std::cell::RefCell;
    use std::collections::BTreeMap;

    use super::*;

    fn shot(name: &str) -> Shot {
        Shot {
            relative: format!("marks/{name}.png"),
            absolute: PathBuf::from(format!("C:\\data\\games\\s\\marks\\{name}.png")),
        }
    }

    fn entry(lines: &[&str]) -> OcrEntry {
        OcrEntry {
            lines: lines.iter().map(|l| l.to_string()).collect(),
            error: None,
        }
    }

    fn cache(geometry: &str, entries: &[(&str, OcrEntry)]) -> OcrCache {
        OcrCache {
            geometry: geometry.to_string(),
            entries: entries
                .iter()
                .map(|(name, e)| (format!("marks/{name}.png"), e.clone()))
                .collect::<BTreeMap<_, _>>(),
        }
    }

    /// 画像の名前から、失敗させるならその失敗を返す関数。
    type FailRule = Box<dyn Fn(&str) -> Option<OcrError>>;

    /// 決まった結果を返し、読んだ画像を覚える偽の読み取り。
    struct FakeReader {
        read: RefCell<Vec<String>>,
        fail: FailRule,
    }

    impl FakeReader {
        fn ok() -> FakeReader {
            FakeReader {
                read: RefCell::new(Vec::new()),
                fail: Box::new(|_| None),
            }
        }

        fn failing(fail: impl Fn(&str) -> Option<OcrError> + 'static) -> FakeReader {
            FakeReader {
                read: RefCell::new(Vec::new()),
                fail: Box::new(fail),
            }
        }

        fn names(&self) -> Vec<String> {
            self.read.borrow().clone()
        }
    }

    impl LineReader for FakeReader {
        fn read_lines(&self, png: &Path) -> Result<Vec<String>, OcrError> {
            let name = png.file_stem().unwrap().to_string_lossy().into_owned();
            self.read.borrow_mut().push(name.clone());
            match (self.fail)(&name) {
                Some(e) => Err(e),
                None => Ok(vec![format!("lines of {name}")]),
            }
        }
    }

    #[test]
    fn a_fresh_session_reads_every_image() {
        let job = plan_session("s", vec![shot("a"), shot("b")], None);
        assert_eq!(job.todo.len(), 2);
        assert_eq!(job.cache.geometry, GEOMETRY_ID);
        assert!(job.cache.entries.is_empty());
    }

    #[test]
    fn images_already_read_with_the_same_geometry_are_not_read_again() {
        let old = cache(GEOMETRY_ID, &[("a", entry(&["東 1 局"]))]);
        let mut job = plan_session("s", vec![shot("a"), shot("b")], Some(old));
        assert_eq!(job.todo, vec![shot("b")]);
        assert_eq!(job.cache.entries.len(), 1, "読めていた a は引き継ぐ");

        let reader = FakeReader::ok();
        let mut count = 0;
        run_job(&reader, &mut job, &mut || count += 1).unwrap();
        assert_eq!(reader.names(), vec!["b"], "a は読み直さない");
        assert_eq!(count, 1);
        assert_eq!(job.cache.entries.len(), 2);
        assert_eq!(job.cache.entries["marks/a.png"], entry(&["東 1 局"]));
        assert_eq!(job.cache.entries["marks/b.png"], entry(&["lines of b"]));
        assert!(job.todo.is_empty());
    }

    #[test]
    fn a_cache_from_another_geometry_is_thrown_away() {
        let old = cache("center-v0", &[("a", entry(&["古い読み取り"]))]);
        let job = plan_session("s", vec![shot("a")], Some(old));
        assert_eq!(job.todo, vec![shot("a")]);
        assert!(job.cache.entries.is_empty());
        assert_eq!(job.cache.geometry, GEOMETRY_ID);
    }

    #[test]
    fn images_that_failed_before_are_tried_again_and_dropped_images_are_forgotten() {
        let mut failed = entry(&[]);
        failed.error = Some("画像を開けませんでした".into());
        let old = cache(
            GEOMETRY_ID,
            &[("a", failed), ("gone", entry(&["取り消された記録の画像"]))],
        );
        let job = plan_session("s", vec![shot("a")], Some(old));
        assert_eq!(job.todo, vec![shot("a")], "前に失敗したものは読み直す");
        assert!(
            job.cache.entries.is_empty(),
            "取り消された記録の画像は写しに残さない"
        );
    }

    #[test]
    fn an_image_that_cannot_be_read_is_recorded_with_its_reason_and_the_rest_go_on() {
        let reader = FakeReader::failing(|name| {
            (name == "b").then(|| OcrError::Decode {
                path: "b.png".into(),
                reason: "壊れている".into(),
            })
        });
        let mut job = plan_session("s", vec![shot("a"), shot("b"), shot("c")], None);
        let mut count = 0;
        run_job(&reader, &mut job, &mut || count += 1).unwrap();
        assert_eq!(reader.names(), vec!["a", "b", "c"]);
        assert_eq!(count, 3, "失敗した 1 枚も、進み具合には数える");
        let b = &job.cache.entries["marks/b.png"];
        assert!(b.lines.is_empty());
        assert!(b.error.as_deref().unwrap().contains("壊れている"));
        assert!(job.cache.entries["marks/a.png"].error.is_none());
        assert!(job.cache.entries["marks/c.png"].error.is_none());
    }

    #[test]
    fn a_missing_japanese_engine_stops_the_job_at_once() {
        let reader = FakeReader::failing(|_| Some(OcrError::JapaneseEngineMissing));
        let mut job = plan_session("s", vec![shot("a"), shot("b")], None);
        let error = run_job(&reader, &mut job, &mut || {}).unwrap_err();
        assert_eq!(error, OcrError::JapaneseEngineMissing);
        assert_eq!(
            reader.names(),
            vec!["a"],
            "続けても同じなので、次の画像は読まない"
        );
        assert_eq!(job.todo.len(), 2, "読めなかった分は、まだ残っている");
        assert!(job.cache.entries.is_empty(), "失敗を写しに残さない");
    }

    #[test]
    fn a_stopped_worker_stops_the_job_and_keeps_what_was_read() {
        let reader = FakeReader::failing(|name| {
            (name == "b").then(|| OcrError::Worker("止まっていた".into()))
        });
        let mut job = plan_session("s", vec![shot("a"), shot("b"), shot("c")], None);
        let error = run_job(&reader, &mut job, &mut || {}).unwrap_err();
        assert!(matches!(error, OcrError::Worker(_)));
        assert_eq!(job.cache.entries.len(), 1, "止まるまでに読めた a は残る");
        assert_eq!(job.todo, vec![shot("b"), shot("c")]);
    }

    #[test]
    fn a_session_with_nothing_to_read_does_not_touch_the_reader_or_rewrite_the_file() {
        let old = cache(GEOMETRY_ID, &[("a", entry(&["x"]))]);
        let mut job = plan_session("s", vec![shot("a")], Some(old));
        assert!(job.todo.is_empty());
        assert!(!job.changed, "写しは、そのまま");
        let reader = FakeReader::ok();
        run_job(&reader, &mut job, &mut || {}).unwrap();
        assert!(reader.names().is_empty());
        assert!(!job.changed);
    }

    #[test]
    fn the_cache_is_marked_changed_only_when_something_new_is_in_it() {
        // 画像が無い半荘は、空の写しを書かない。
        assert!(!plan_session("s", vec![], None).changed);
        // 読んだら、変わる。
        let mut job = plan_session("s", vec![shot("a")], None);
        assert!(!job.changed, "まだ読んでいない");
        run_job(&FakeReader::ok(), &mut job, &mut || {}).unwrap();
        assert!(job.changed);
        // 取り消された記録の画像が写しから消えるだけでも、変わった。
        let old = cache(
            GEOMETRY_ID,
            &[("a", entry(&["x"])), ("gone", entry(&["y"]))],
        );
        assert!(plan_session("s", vec![shot("a")], Some(old)).changed);
        // 切り出しの決まりが違う写しは、捨てるので、変わった（読み直す）。
        let old = cache("center-v0", &[("a", entry(&["x"]))]);
        assert!(plan_session("s", vec![shot("a")], Some(old)).changed);
    }
}
