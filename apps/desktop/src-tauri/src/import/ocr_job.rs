//! 取り込みの文字認識（F11、S-3）。
//!
//! 取り込みのときだけ（対局のあと）、半荘の迷いマーク・評価のスクリーンショット（すでにファイルに保存されたもの）を、
//! 画像から画面中央の板（局・残り枚数・点数）の文字として読み、結果を半荘のフォルダの `ocr.json` に残す。
//! 同じ画像は読み直さない。ウィジェット・ボタンを拾う部分・撮影・記録・補助プログラムのコードは、文字認識を使わない
//! （文字認識のクレート `jantama-ocr` を使ってよいソースは、このファイルだけ。`tests/safety.rs` の S-3 が確かめる）。
//!
//! 1 枚の画像は、1 回目の画像（局と残り枚数の水色の文字の位置から、局・残り枚数・自分の点数だけを切り出して拡大したもの。見つからなければ、
//! 画面の大きさに対する割合の箱で切り出したもの。E-32）に加えて、読み直し用の画像（コントラストを上げたもの・1.5 倍に広げたもの。
//! E-20）でも読み、すべて写しに残す。1 回目で局・残り枚数・点数が取れなければ、読み直しの最初に取れたものを使うが、
//! その選びは、行から取り出す側（エンジンの `parseCenterText`）が決める（ここには、同じ取り出しの規則を持たない）。
//!
//! 画像から行を読む部分は `LineReader` という口にして、準備（どの画像を読むか）と実行（読んで写しに入れる）は、
//! 偽の読み取りで単体試験できるようにしてある。製品の読み取り `WindowsReader` は、専用のスレッドで動く
//! Windows の日本語の文字認識で、`spawn_blocking` などの、画面とは別のスレッドから使う。
//!
//! 読み直し（F11、E-27）: 読み取りの作り方（切り出しの決まり。`GEOMETRY_ID`）を変えたあと、前の作り方で読んだ半荘は、
//! 半荘の画面を開いたときに 1 回だけ、保存してあるスクショを新しい作り方で読み直す。これも取り込みの一部で、半荘の画面から呼ぶ
//! （対局中に動く部分には入れない）。前の作り方で読んだ写しか（`needs_reread`）は、写しの決まりの名前で決める。
//! 読み直しは、仕事を決めて（`plan_reread`）、読んで（`run_reread`）、書く（`finish_reread`）の 3 つ。画像を全部読めたときだけ、
//! 新しい写しを、別の名前で書いてから置き換える（書き換えるのは `ocr.json` だけ。結びつけ・評価・MAKA・結果には触らない）。
//! 1 つでも失敗したら、前の写しをそのまま残す。

use std::fmt;
use std::path::{Path, PathBuf};

use jantama_ocr::{OcrError, OcrWorker, GEOMETRY_ID};

use crate::store::{OcrCache, OcrEntry, OcrRetry, Store, StoreError};

/// 画像 1 枚の読み取り: 1 回目の画像の行と、読み直しの画像ごとの行（読んだ順）。
#[derive(Debug, Clone, PartialEq, Eq, Default)]
pub struct ShotReading {
    pub lines: Vec<String>,
    pub retries: Vec<OcrRetry>,
}

/// 画像 1 枚から、行ごとの文字を読む口。
pub trait LineReader {
    fn read(&self, png: &Path) -> Result<ShotReading, OcrError>;
}

/// 製品の読み取り: 専用のスレッドで動く、Windows の日本語の文字認識（局と残り枚数の水色の文字の位置から、局・残り枚数・自分の点数だけを
/// 切り出して、文字の高さをそろえて拡大して読む。見つからなければ、画面の大きさに対する割合の箱で切り出して 3 倍にして読む。
/// 読み直し用に、コントラストを上げた画像と 1.5 倍に広げた画像も読む）。
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
    fn read(&self, png: &Path) -> Result<ShotReading, OcrError> {
        let mut readings = self.worker.read_center_variants(png)?.into_iter();
        // 先頭は、必ず 1 回目の画像（読めなければ、ここまで来ずに失敗している）。
        let first = readings.next().map(|r| r.lines).unwrap_or_default();
        Ok(ShotReading {
            lines: first,
            retries: readings
                .map(|r| OcrRetry {
                    variant: r.variant.name().to_string(),
                    lines: r.lines,
                })
                .collect(),
        })
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
        match reader.read(&shot.absolute) {
            Ok(reading) => {
                job.changed = true;
                job.cache.entries.insert(
                    shot.relative.clone(),
                    OcrEntry {
                        lines: reading.lines,
                        retries: reading.retries,
                        error: None,
                    },
                );
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
                        retries: Vec::new(),
                        error: Some(e.to_string()),
                    },
                );
            }
        }
        on_each();
    }
    Ok(())
}

/// 前の作り方で読んだ写しか（読み直しが要るか）。写しの切り出しの決まりの名前が、いまの決まり（`GEOMETRY_ID`）と違う、
/// または名前が無い（空）ときに true。写しが無い（まだ読んでいない）ときは false: それは読み直しではなく、取り込みの読み取りの仕事。
pub fn needs_reread(existing: Option<&OcrCache>) -> bool {
    existing.is_some_and(|cache| cache.geometry != GEOMETRY_ID)
}

/// 読み直しに失敗した理由。失敗したときは、前の写し（`ocr.json`）は、そのまま残る。
#[derive(Debug)]
pub enum RereadError {
    /// 半荘のフォルダ・記録・写しを扱えなかった（半荘が消えた、など）。
    Store(StoreError),
    /// 日本語の文字認識が使えない・担当が止まった。
    Ocr(OcrError),
    /// 画像 1 枚を読めなかった（開けない・壊れているなど）。1 枚でも読めなければ、新しい作り方で読んだ写しに、前の作り方で
    /// 読んだ分を混ぜないよう、全体を失敗にする（次に半荘の画面を開いたとき、アプリを起動し直したあとに、もう一度試す）。
    Image { relative: String, reason: String },
}

impl fmt::Display for RereadError {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        match self {
            RereadError::Store(e) => write!(f, "{e}"),
            RereadError::Ocr(e) => write!(f, "{e}"),
            RereadError::Image { relative, reason } => {
                write!(f, "画像 {relative} を読み直せませんでした（{reason}）")
            }
        }
    }
}

impl std::error::Error for RereadError {}

impl From<StoreError> for RereadError {
    fn from(error: StoreError) -> Self {
        RereadError::Store(error)
    }
}

impl From<OcrError> for RereadError {
    fn from(error: OcrError) -> Self {
        RereadError::Ocr(error)
    }
}

/// 半荘 1 つの読み直しの仕事を決める。読み直しが要らない（写しが無い・いまの作り方で読んだ写し）ときは `None`。
/// 読む画像は、半荘の迷いマーク・評価の画像すべて（前の写しは使わない）。記録の錠を持っている間に呼ぶ（読むのは、まだ先）。
pub fn plan_reread(store: &Store, session_id: &str) -> Result<Option<SessionJob>, RereadError> {
    let existing = store.load_ocr(session_id)?;
    if !needs_reread(existing.as_ref()) {
        return Ok(None);
    }
    let shots = store
        .screenshots_of(session_id)?
        .into_iter()
        .map(|(relative, absolute)| Shot { relative, absolute })
        .collect();
    Ok(Some(plan_session(session_id, shots, existing)))
}

/// 読み直しの仕事を進める（記録の錠は要らない）。読む画像があるときだけ、読み取り（`start_reader`）を起こす
/// （日本語の文字認識が使えなければ、ここで失敗する。画像が 1 枚も無い半荘では、起こさない）。
/// 続けられない失敗と、画像が 1 枚でも読めなかったことは、失敗にする（取り込みの読み取りは、読めなかった画像を理由つきで写しに残して
/// 続けるが、読み直しは、前の写しを残すほうを選ぶ）。
pub fn run_reread(
    mut job: SessionJob,
    start_reader: impl FnOnce() -> Result<Box<dyn LineReader>, OcrError>,
) -> Result<SessionJob, RereadError> {
    if !job.todo.is_empty() {
        let reader = start_reader()?;
        run_job(reader.as_ref(), &mut job, &mut || {})?;
    }
    if let Some((relative, entry)) = job
        .cache
        .entries
        .iter()
        .find(|(_, entry)| entry.error.is_some())
    {
        return Err(RereadError::Image {
            relative: relative.clone(),
            reason: entry.error.clone().unwrap_or_default(),
        });
    }
    Ok(job)
}

/// 読み直した写しを、半荘のフォルダの `ocr.json` に書く（別の名前で書いてから置き換える。記録の錠を持っている間に呼ぶ）。
/// 結びつけ（`links.json`）・局の自己評価・MAKA の評価・結果には触らない。
pub fn finish_reread(store: &Store, job: &SessionJob) -> Result<(), RereadError> {
    store.save_ocr(&job.session_id, &job.cache)?;
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
            retries: Vec::new(),
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
        fn read(&self, png: &Path) -> Result<ShotReading, OcrError> {
            let name = png.file_stem().unwrap().to_string_lossy().into_owned();
            self.read.borrow_mut().push(name.clone());
            match (self.fail)(&name) {
                Some(e) => Err(e),
                None => Ok(ShotReading {
                    lines: vec![format!("lines of {name}")],
                    retries: vec![OcrRetry {
                        variant: "contrast1.8".into(),
                        lines: vec![format!("retry of {name}")],
                    }],
                }),
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
        assert_eq!(
            job.cache.entries["marks/b.png"].lines,
            vec!["lines of b".to_string()]
        );
        assert!(job.todo.is_empty());
    }

    #[test]
    fn the_first_reading_and_every_retry_are_kept_in_the_cache_in_reading_order() {
        let mut job = plan_session("s", vec![shot("a")], None);
        run_job(&FakeReader::ok(), &mut job, &mut || {}).unwrap();
        let a = &job.cache.entries["marks/a.png"];
        assert_eq!(a.lines, vec!["lines of a".to_string()]);
        assert_eq!(
            a.retries,
            vec![OcrRetry {
                variant: "contrast1.8".into(),
                lines: vec!["retry of a".into()],
            }]
        );
        assert!(a.error.is_none());
    }

    #[test]
    fn a_cache_from_the_first_geometry_is_read_again_so_that_the_retries_are_filled_in() {
        // v1 の写し（読み直しが無い）は、決まりの名前が違うので捨てて、全部を読み直す。
        let old = cache("center-v1-lanczos3x", &[("a", entry(&["崩れた行"]))]);
        let mut job = plan_session("s", vec![shot("a")], Some(old));
        assert_eq!(job.todo, vec![shot("a")]);
        run_job(&FakeReader::ok(), &mut job, &mut || {}).unwrap();
        assert_eq!(job.cache.geometry, GEOMETRY_ID);
        assert_eq!(job.cache.entries["marks/a.png"].retries.len(), 1);
    }

    #[test]
    fn a_cache_from_the_second_geometry_is_read_again_with_the_tight_cutout() {
        // v2（割合の箱で切り出して、読み直しの画像も読んだ写し）の半荘は、決まりの名前が違うので、水色の文字の位置から切り出す
        // v3 で全部を読み直す（E-32、E-27）。読み直しは 1 回だけ（v3 で読んだ写しは、もう読み直さない）。
        let v2 = cache(
            "center-v2-lanczos3x-variants",
            &[("a", entry(&["第 2 局", "个 5 0", "25000"]))],
        );
        assert!(needs_reread(Some(&v2)));
        let mut job = plan_session("s", vec![shot("a")], Some(v2));
        assert_eq!(job.todo, vec![shot("a")]);
        assert!(job.cache.entries.is_empty(), "前の読み取りは写しに残さない");
        run_job(&FakeReader::ok(), &mut job, &mut || {}).unwrap();
        assert_eq!(job.cache.geometry, "center-v3-cyan-tight");
        assert_eq!(job.cache.geometry, GEOMETRY_ID);
        assert!(!needs_reread(Some(&job.cache)));
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

    // ---- 読み直し（F11、E-27）。本物の文字認識は使わず、偽の読み取りと、一時フォルダの保存先で確かめる ----

    use std::cell::Cell;
    use std::fs;
    use std::rc::Rc;

    use crate::capture::{CaptureError, CaptureTarget, Screenshot};
    use crate::store::{Rating, SelfRating};

    const T0: i64 = 1_760_000_000_123;
    const REPORT_TEXT: &str = r#"{"review":{"kyokus":[]},"note":"結果の見本"}"#;
    /// 前の作り方の決まりの名前（v1）。
    const OLD_GEOMETRY: &str = "center-v1-lanczos3x";

    fn png() -> Result<Screenshot, CaptureError> {
        Ok(Screenshot {
            png: vec![0x89, b'P', b'N', b'G'],
            target: CaptureTarget::Window,
        })
    }

    /// 偽の読み取りを、読み取りの口として渡せる形にする（あとで、何を読んだかを調べられるように、持ち主は呼ぶ側に残す）。
    struct Shared(Rc<FakeReader>);

    impl LineReader for Shared {
        fn read(&self, png: &Path) -> Result<ShotReading, OcrError> {
            self.0.read(png)
        }
    }

    fn starter(reader: &Rc<FakeReader>) -> impl FnOnce() -> Result<Box<dyn LineReader>, OcrError> {
        let reader = Rc::clone(reader);
        move || Ok(Box::new(Shared(reader)) as Box<dyn LineReader>)
    }

    /// 呼ばれたら失敗させる読み取りの起こし方（読み取りを起こしてはいけない場面で渡す）。
    fn never_started() -> Result<Box<dyn LineReader>, OcrError> {
        panic!("文字認識の担当を起こしてはいけない場面で、起こそうとした")
    }

    /// 仕事を決める → 読む → 書く、を続けて行う（製品は、読む間だけ記録の錠を放して、同じ 3 つを呼ぶ）。書いたら true、要らなければ false。
    fn reread_session(
        store: &Store,
        session_id: &str,
        start_reader: impl FnOnce() -> Result<Box<dyn LineReader>, OcrError>,
    ) -> Result<bool, RereadError> {
        let Some(job) = plan_reread(store, session_id)? else {
            return Ok(false);
        };
        let job = run_reread(job, start_reader)?;
        finish_reread(store, &job)?;
        Ok(true)
    }

    /// 結果を取り込んだ半荘（迷いマーク 2・評価 1。どれも画像つき）。結びつけ・自己評価・MAKA の評価も入れて、半荘の名前を返す。
    fn imported_session(store: &mut Store) -> String {
        store.add_mark(T0, png()).unwrap(); // id 1
        store.add_mark(T0 + 1, png()).unwrap(); // id 2
        store.add_rating(T0 + 2, Rating::Good, png()).unwrap(); // id 3
        let id = store.current_session_id().unwrap().to_string();
        store.save_report(Some(&id), REPORT_TEXT, T0 + 3).unwrap();
        store.set_mark_link(&id, 2, "k2h1e14").unwrap();
        store.set_rating_link(&id, 3, "k0h0").unwrap();
        store
            .set_self_rating(&id, "k0h0", SelfRating::Fair)
            .unwrap();
        store.set_maka_grade(&id, "k0h0", "A").unwrap();
        id
    }

    fn open_store() -> (tempfile::TempDir, Store) {
        let dir = tempfile::tempdir().unwrap();
        let store = Store::open(dir.path().join("data")).unwrap();
        (dir, store)
    }

    fn session_dir(store: &Store, id: &str) -> PathBuf {
        store.root().join(crate::store::GAMES_DIR).join(id)
    }

    /// 画像ごとに、前の作り方で読んだ写しを置く。
    fn old_ocr(store: &Store, id: &str, geometry: &str) -> OcrCache {
        let cache = OcrCache {
            geometry: geometry.to_string(),
            entries: store
                .screenshots_of(id)
                .unwrap()
                .into_iter()
                .map(|(relative, _)| (relative, entry(&["前の作り方で読んだ行"])))
                .collect(),
        };
        store.save_ocr(id, &cache).unwrap();
        cache
    }

    /// 半荘のフォルダの、`ocr.json` 以外のすべてのファイルの中身（フォルダからの相対パス → バイト）。
    fn snapshot_except_ocr(dir: &Path) -> BTreeMap<String, Vec<u8>> {
        fn walk(root: &Path, dir: &Path, out: &mut BTreeMap<String, Vec<u8>>) {
            for item in fs::read_dir(dir).unwrap() {
                let path = item.unwrap().path();
                if path.is_dir() {
                    walk(root, &path, out);
                } else {
                    let relative = path
                        .strip_prefix(root)
                        .unwrap()
                        .to_string_lossy()
                        .replace('\\', "/");
                    if relative != "ocr.json" && relative != "ocr.json.tmp" {
                        out.insert(relative, fs::read(&path).unwrap());
                    }
                }
            }
        }
        let mut out = BTreeMap::new();
        walk(dir, dir, &mut out);
        out
    }

    #[test]
    fn a_cache_needs_a_reread_only_when_its_geometry_name_differs_from_the_current_one() {
        // 写しが無い（まだ読んでいない）のは、読み直しではない。
        assert!(!needs_reread(None));
        // いまの決まりで読んだ写しは、読み直さない（空の写しでも）。
        assert!(!needs_reread(Some(&cache(
            GEOMETRY_ID,
            &[("a", entry(&["x"]))]
        ))));
        assert!(!needs_reread(Some(&cache(GEOMETRY_ID, &[]))));
        // 前の決まり（v1）・ほかの名前は、読み直す。
        assert!(needs_reread(Some(&cache(
            OLD_GEOMETRY,
            &[("a", entry(&["x"]))]
        ))));
        assert!(needs_reread(Some(&cache("center-v0", &[]))));
        assert!(needs_reread(Some(&cache("", &[]))));
        // 決まりの名前が無い写し（昔の形）は、名前が空として読めて、読み直す。
        let nameless: OcrCache =
            serde_json::from_str(r#"{"entries":{"marks/a.png":{"lines":["x"]}}}"#).unwrap();
        assert!(needs_reread(Some(&nameless)));
        // 名前の大文字小文字や、前後の空白の違いも、違う名前。
        assert!(needs_reread(Some(&cache(&GEOMETRY_ID.to_uppercase(), &[]))));
        assert!(needs_reread(Some(&cache(&format!("{GEOMETRY_ID} "), &[]))));
    }

    #[test]
    fn a_reread_writes_a_new_ocr_json_with_the_current_marker_and_leaves_everything_else_byte_identical(
    ) {
        let (_tmp, mut store) = open_store();
        let id = imported_session(&mut store);
        let before = old_ocr(&store, &id, OLD_GEOMETRY);
        let dir = session_dir(&store, &id);
        let others = snapshot_except_ocr(&dir);
        for name in [
            "links.json",
            "self-ratings.json",
            "maka.json",
            "report.json",
            "events.jsonl",
        ] {
            assert!(others.contains_key(name), "{name} が試験の前にある");
        }

        let reader = Rc::new(FakeReader::ok());
        let wrote = reread_session(&store, &id, starter(&reader)).unwrap();

        assert!(wrote);
        assert_eq!(
            reader.names().len(),
            3,
            "迷い 2 枚と評価 1 枚の、すべての画像を読み直す"
        );
        let after = store.load_ocr(&id).unwrap().unwrap();
        assert_eq!(after.geometry, GEOMETRY_ID, "いまの決まりの名前");
        assert_ne!(after, before);
        assert_eq!(
            after.entries.keys().collect::<Vec<_>>(),
            before.entries.keys().collect::<Vec<_>>(),
            "画像ごとに 1 つ"
        );
        let folders: Vec<&str> = after
            .entries
            .keys()
            .map(|r| r.split('/').next().unwrap())
            .collect();
        assert_eq!(folders.iter().filter(|f| **f == "marks").count(), 2);
        assert_eq!(folders.iter().filter(|f| **f == "ratings").count(), 1);
        for (relative, entry) in &after.entries {
            let stem = Path::new(relative).file_stem().unwrap().to_string_lossy();
            assert_eq!(
                entry.lines,
                vec![format!("lines of {stem}")],
                "{relative}: 1 回目の行"
            );
            assert_eq!(entry.retries.len(), 1, "{relative}: 読み直しの行");
            assert!(entry.error.is_none());
        }

        // ocr.json のほかは、1 バイトも変わらない（結びつけ・自己評価・MAKA・結果・記録・画像）。一時ファイルも残らない。
        assert_eq!(snapshot_except_ocr(&dir), others);
        assert_eq!(
            fs::read(dir.join("links.json")).unwrap(),
            others["links.json"]
        );
        assert!(!dir.join("ocr.json.tmp").exists());
        // 書いたあとは、読み直しが要らない。
        assert!(!needs_reread(store.load_ocr(&id).unwrap().as_ref()));
        assert!(plan_reread(&store, &id).unwrap().is_none());
    }

    #[test]
    fn a_reread_that_is_not_needed_touches_nothing_and_does_not_start_the_reader() {
        let (_tmp, mut store) = open_store();
        let id = imported_session(&mut store);
        let dir = session_dir(&store, &id);

        // 写しが無い半荘: 読み直しではない。
        assert!(plan_reread(&store, &id).unwrap().is_none());
        assert!(!reread_session(&store, &id, never_started).unwrap());
        assert!(!dir.join("ocr.json").exists(), "写しを作らない");

        // いまの決まりで読んだ写し: そのまま。
        let current = old_ocr(&store, &id, GEOMETRY_ID);
        let bytes = fs::read(dir.join("ocr.json")).unwrap();
        assert!(!reread_session(&store, &id, never_started).unwrap());
        assert_eq!(fs::read(dir.join("ocr.json")).unwrap(), bytes);
        assert_eq!(store.load_ocr(&id).unwrap(), Some(current));
    }

    #[test]
    fn a_failed_reread_keeps_the_old_ocr_json_byte_for_byte() {
        let (_tmp, mut store) = open_store();
        let id = imported_session(&mut store);
        old_ocr(&store, &id, OLD_GEOMETRY);
        let dir = session_dir(&store, &id);
        let old_bytes = fs::read(dir.join("ocr.json")).unwrap();
        let others = snapshot_except_ocr(&dir);
        let unchanged = |what: &str| {
            assert_eq!(
                fs::read(dir.join("ocr.json")).unwrap(),
                old_bytes,
                "{what}: 前の写し"
            );
            assert!(!dir.join("ocr.json.tmp").exists(), "{what}: 一時ファイル");
            assert_eq!(snapshot_except_ocr(&dir), others, "{what}: ほかのファイル");
            assert!(
                needs_reread(store.load_ocr(&id).unwrap().as_ref()),
                "{what}: まだ前の作り方"
            );
        };

        // 日本語の文字認識が使えない（読み取りを起こせない）。
        let error = reread_session(&store, &id, || {
            Err::<Box<dyn LineReader>, _>(OcrError::JapaneseEngineMissing)
        })
        .unwrap_err();
        assert!(
            matches!(error, RereadError::Ocr(OcrError::JapaneseEngineMissing)),
            "{error}"
        );
        assert!(error.to_string().contains("日本語"), "{error}");
        unchanged("文字認識が使えない");

        // 途中で担当が止まった（1 枚読めたあとで失敗）。読めた分も、書かない。
        let calls = Rc::new(Cell::new(0));
        let flaky = {
            let calls = Rc::clone(&calls);
            Rc::new(FakeReader::failing(move |_| {
                calls.set(calls.get() + 1);
                (calls.get() == 2).then(|| OcrError::Worker("止まっていた".into()))
            }))
        };
        let error = reread_session(&store, &id, starter(&flaky)).unwrap_err();
        assert!(
            matches!(error, RereadError::Ocr(OcrError::Worker(_))),
            "{error}"
        );
        assert_eq!(
            flaky.names().len(),
            2,
            "止まったところで、次の画像は読まない"
        );
        unchanged("途中で担当が止まった");

        // 画像 1 枚が読めない（壊れている）。理由に、その画像の名前を添える。ほかの画像が読めても、混ぜて書かない。
        let shots = store.screenshots_of(&id).unwrap();
        let (bad_relative, bad_absolute) = shots[1].clone();
        let bad_stem = bad_absolute
            .file_stem()
            .unwrap()
            .to_string_lossy()
            .into_owned();
        let broken = Rc::new(FakeReader::failing(move |name| {
            (name == bad_stem).then(|| OcrError::Decode {
                path: format!("{name}.png"),
                reason: "壊れている".into(),
            })
        }));
        let error = reread_session(&store, &id, starter(&broken)).unwrap_err();
        match &error {
            RereadError::Image { relative, reason } => {
                assert_eq!(relative, &bad_relative);
                assert!(reason.contains("壊れている"), "{reason}");
            }
            other => panic!("{other}"),
        }
        assert!(
            error.to_string().contains(&bad_relative)
                && error.to_string().contains("を読み直せませんでした"),
            "{error}"
        );
        unchanged("画像が 1 枚読めない");
        assert_eq!(
            broken.names().len(),
            3,
            "ほかの画像も読む（理由は、読めなかった画像の名前）"
        );
    }

    #[test]
    fn a_failed_reread_leaves_the_marker_old_so_that_it_is_tried_again_next_time() {
        let (_tmp, mut store) = open_store();
        let id = imported_session(&mut store);
        old_ocr(&store, &id, OLD_GEOMETRY);
        let broken = Rc::new(FakeReader::failing(|_| {
            Some(OcrError::Open {
                path: "x.png".into(),
                reason: "ほかのアプリが使っている".into(),
            })
        }));
        assert!(reread_session(&store, &id, starter(&broken)).is_err());
        // 失敗は、写しの決まりの名前を変えない。次は、読めれば、読み直せる。
        assert!(plan_reread(&store, &id).unwrap().is_some());
        let reader = Rc::new(FakeReader::ok());
        assert!(reread_session(&store, &id, starter(&reader)).unwrap());
        assert_eq!(store.load_ocr(&id).unwrap().unwrap().geometry, GEOMETRY_ID);
    }

    #[test]
    fn images_that_are_gone_from_the_records_are_dropped_and_a_session_without_images_needs_no_reader(
    ) {
        let (_tmp, mut store) = open_store();
        store.add_mark(T0, png()).unwrap();
        store
            .add_mark(T0 + 1, Err(CaptureError("撮れなかった".into())))
            .unwrap(); // 画像なし
        let id = store.current_session_id().unwrap().to_string();
        store.save_report(Some(&id), REPORT_TEXT, T0 + 2).unwrap();
        store.undo(T0 + 3).unwrap(); // 最後の（画像なしの）迷いを取り消す
        store.undo(T0 + 4).unwrap(); // 画像のある迷いも取り消す
        let stale = OcrCache {
            geometry: OLD_GEOMETRY.to_string(),
            entries: BTreeMap::from([(
                "marks/gone.png".to_string(),
                entry(&["取り消された記録の画像"]),
            )]),
        };
        store.save_ocr(&id, &stale).unwrap();
        assert!(store.screenshots_of(&id).unwrap().is_empty());

        // 読む画像が無いので、読み取りを起こさない。前の写しの、いまは無い画像の行は、新しい写しに残らない。
        assert!(reread_session(&store, &id, never_started).unwrap());
        let after = store.load_ocr(&id).unwrap().unwrap();
        assert_eq!(after.geometry, GEOMETRY_ID);
        assert!(after.entries.is_empty());
    }

    #[test]
    fn a_session_that_was_deleted_while_reading_fails_without_writing_anything() {
        let (_tmp, mut store) = open_store();
        let id = imported_session(&mut store);
        old_ocr(&store, &id, OLD_GEOMETRY);
        let job = plan_reread(&store, &id).unwrap().unwrap();
        let reader = Rc::new(FakeReader::ok());
        let job = run_reread(job, starter(&reader)).unwrap();
        // 読んでいる間に、半荘が消えた（フォルダが無い）。
        store.delete_sessions(std::slice::from_ref(&id)).unwrap();
        let error = finish_reread(&store, &job).unwrap_err();
        assert!(
            matches!(error, RereadError::Store(StoreError::UnknownSession(_))),
            "{error}"
        );
        assert!(!store
            .root()
            .join(crate::store::GAMES_DIR)
            .join(&id)
            .exists());
    }
}
