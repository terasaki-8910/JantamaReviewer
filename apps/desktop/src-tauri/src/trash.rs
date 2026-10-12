//! 消した半荘の置き場（`<保存先>/trash/`）と、OS のごみ箱への移し替え（U-9、R8-3）。
//!
//! 半荘を消すと、半荘のフォルダは `games/<名前>` から `trash/<名前>` へ移る（同じボリュームなので一瞬。`store.rs`）。
//! 半荘の一覧（`list_sessions`）と、起動したときの続きの記録（`resume_recent`）は `games/` だけを見るので、trash の中は見えない。
//! 「元に戻す」は、フォルダを `games/` へ戻すだけ。アプリを閉じるとき（落ちたときは、次の起動のとき）に、
//! trash の中身を、すべて OS のごみ箱へ送る。
//!
//! 送る相手は、`<保存先>/trash` の直下の項目だけ。リンク（シンボリックリンク・ジャンクション）は、中身を見ずに触らない。
//! 実体の場所が trash の外を指す項目も触らない。ごみ箱へ送る部分（`Recycler`）は差し替えられる。試験は偽物を使い、
//! 本物のごみ箱には触れない。
//! ごみ箱へ送った半荘は、答えのファイル（`study.sqlite`）の、その半荘の答えと解き直しの予定も消す（`finalize_trash`。D-3）。
//! 置き場にある間は、答えを残す（元に戻せば、答えも戻る）。

use std::fs;
use std::path::{Path, PathBuf};

pub use crate::store::TRASH_DIR;

/// フォルダや項目を、OS のごみ箱へ送る口。実装は OS ごと（Windows は `platform/win/trash.rs`）。
pub trait Recycler: Send + Sync {
    /// `path` の項目（フォルダならその中身ごと）をごみ箱へ送る。送れなかったときは、その理由。
    fn recycle(&self, path: &Path) -> Result<(), String>;
}

/// ごみ箱へ送った結果。
#[derive(Debug, Default, PartialEq, Eq)]
pub struct RecycleReport {
    /// ごみ箱へ送った項目の名前（名前順）。
    pub recycled: Vec<String>,
    /// 触らなかった項目の名前と、理由（リンク・trash の外を指している、など）。
    pub skipped: Vec<(String, String)>,
    /// 送ろうとして、できなかった項目の名前と、理由。
    pub failed: Vec<(String, String)>,
}

impl RecycleReport {
    /// 画面（標準エラー）に出す、1 行ずつの問題。何も無ければ空。
    pub fn problems(&self) -> Vec<String> {
        self.skipped
            .iter()
            .map(|(name, why)| format!("ごみ箱へ送らずに残しました: {name}（{why}）"))
            .chain(
                self.failed
                    .iter()
                    .map(|(name, why)| format!("ごみ箱へ送れませんでした: {name}（{why}）")),
            )
            .collect()
    }
}

/// 保存先の中の、消した半荘の置き場。
pub fn trash_dir(data_dir: &Path) -> PathBuf {
    data_dir.join(TRASH_DIR)
}

/// `path`（実体のパス）が、`trash`（実体のパス）の中の、直下ではないもの以外か。つまり trash の中にあって trash 自身ではない。
fn is_strictly_inside(trash: &Path, path: &Path) -> bool {
    path != trash && path.starts_with(trash)
}

/// trash の直下の項目を、すべてごみ箱へ送る。送る相手は `<保存先>/trash` の中だけ。
///
/// 全部を送れたら、空になった trash のフォルダも片づける（中身が残っていれば、片づけない）。
/// 1 つが失敗しても、残りは続ける。trash が無ければ何もしない。
pub fn recycle_trash(data_dir: &Path, recycler: &dyn Recycler) -> RecycleReport {
    let mut report = RecycleReport::default();
    // 相対パスの保存先でも、ごみ箱へ送る口には、完全なパスを渡す（相対パスだと、ごみ箱を使わず消えることがある）。
    let Ok(data_dir) = std::path::absolute(data_dir) else {
        return report;
    };
    let dir = trash_dir(&data_dir);
    let Ok(entries) = fs::read_dir(&dir) else {
        return report;
    };
    let Ok(canonical_dir) = dir.canonicalize() else {
        return report;
    };

    let mut found: Vec<(String, PathBuf, fs::FileType)> = Vec::new();
    for entry in entries {
        let Ok(entry) = entry else { continue };
        let name = entry.file_name().to_string_lossy().into_owned();
        match entry.file_type() {
            Ok(kind) => found.push((name, entry.path(), kind)),
            Err(e) => report
                .failed
                .push((name, format!("種類を調べられませんでした: {e}"))),
        }
    }
    found.sort_by(|a, b| a.0.cmp(&b.0));

    for (name, path, kind) in found {
        if kind.is_symlink() {
            report
                .skipped
                .push((name, "リンクなので、中を見ずに触りません".to_string()));
            continue;
        }
        let inside = path
            .canonicalize()
            .is_ok_and(|real| is_strictly_inside(&canonical_dir, &real));
        if !inside {
            report
                .skipped
                .push((name, "置き場の外を指しているので触りません".to_string()));
            continue;
        }
        match recycler.recycle(&path) {
            Ok(()) => report.recycled.push(name),
            Err(why) => report.failed.push((name, why)),
        }
    }

    // 空のときだけ消える（`remove_dir` は、中身があれば何もしない）。
    let _ = fs::remove_dir(&dir);
    report
}

/// 置き場を片づける: `recycler` で、置き場の中身をごみ箱へ送り、送った半荘の答えと解き直しの予定も、答えのファイル
/// （`study.sqlite`）から消す（D-3）。ごみ箱へ送れなかった半荘は、置き場に残るので、答えも残す（元に戻せる間・次の起動で
/// もう一度送るまで、答えを消さない）。答えを消せなかったときは、標準エラーに書く（片づけを止めない）。
pub fn finalize_trash(data_dir: &Path, recycler: &dyn Recycler) -> RecycleReport {
    let report = recycle_trash(data_dir, recycler);
    if let Err(e) = crate::study::forget_sessions(data_dir, &report.recycled) {
        eprintln!("消した半荘の答えを、答えのファイルから消せませんでした: {e}");
    }
    report
}

/// 置き場に残っている「消した半荘」を、本物のごみ箱へ送る（答えと予定も消す）。アプリを閉じるとき・起動したとき（落ちたあと）・
/// 保存先を変えたときに呼ぶ。問題があれば標準エラーに書く（閉じる・起動を止めない）。本物のごみ箱の道具（`platform::recycler`）を作るのは、ここだけ。
pub fn recycle_pending(data_dir: &Path) {
    for line in finalize_trash(data_dir, crate::platform::recycler().as_ref()).problems() {
        eprintln!("{line}");
    }
}

#[cfg(test)]
mod tests {
    use std::path::PathBuf;
    use std::sync::Mutex;

    use super::*;

    /// ごみ箱へ送る代わりに、頼まれたパスを覚えて、フォルダを消す（本物のごみ箱には触れない）。
    struct FakeRecycler {
        asked: Mutex<Vec<PathBuf>>,
        fail_on: Option<&'static str>,
    }

    impl FakeRecycler {
        fn new() -> FakeRecycler {
            FakeRecycler {
                asked: Mutex::new(Vec::new()),
                fail_on: None,
            }
        }

        fn failing_on(name: &'static str) -> FakeRecycler {
            FakeRecycler {
                asked: Mutex::new(Vec::new()),
                fail_on: Some(name),
            }
        }

        fn asked(&self) -> Vec<PathBuf> {
            self.asked.lock().unwrap().clone()
        }
    }

    impl Recycler for FakeRecycler {
        fn recycle(&self, path: &Path) -> Result<(), String> {
            self.asked.lock().unwrap().push(path.to_path_buf());
            if self.fail_on == path.file_name().and_then(|n| n.to_str()) {
                return Err("送れません".to_string());
            }
            // 本物のごみ箱は、項目を trash から取り除く。偽物も、同じように取り除く。
            if path.is_dir() {
                fs::remove_dir_all(path).map_err(|e| e.to_string())
            } else {
                fs::remove_file(path).map_err(|e| e.to_string())
            }
        }
    }

    fn make_session(data: &Path, name: &str) -> PathBuf {
        let dir = trash_dir(data).join(name);
        fs::create_dir_all(dir.join("marks")).unwrap();
        fs::write(dir.join("events.jsonl"), "{}\n").unwrap();
        fs::write(dir.join("marks").join("a.png"), [1u8, 2, 3]).unwrap();
        dir
    }

    #[test]
    fn u9_everything_directly_under_trash_goes_to_the_recycler_and_the_empty_trash_folder_goes_away(
    ) {
        let tmp = tempfile::tempdir().unwrap();
        let data = tmp.path().join("data");
        let a = make_session(&data, "20261009-190953");
        let b = make_session(&data, "20261010-100000");
        fs::write(trash_dir(&data).join("stray.txt"), "x").unwrap();
        // games/ は触らない。
        let games_session = data.join("games").join("20261001-000000");
        fs::create_dir_all(&games_session).unwrap();

        let recycler = FakeRecycler::new();
        let report = recycle_trash(&data, &recycler);

        assert_eq!(
            report.recycled,
            vec!["20261009-190953", "20261010-100000", "stray.txt"]
        );
        assert!(
            report.skipped.is_empty() && report.failed.is_empty(),
            "{report:?}"
        );
        assert!(report.problems().is_empty());
        let asked = recycler.asked();
        assert_eq!(asked, vec![a, b, trash_dir(&data).join("stray.txt")]);
        for path in &asked {
            assert_eq!(path.parent(), Some(trash_dir(&data).as_path()));
        }
        assert!(!trash_dir(&data).exists(), "空になった置き場は片づける");
        assert!(games_session.exists(), "games の中は、ごみ箱へ送らない");
    }

    #[test]
    fn u28_the_memos_file_goes_to_the_recycler_with_its_session_folder_and_not_on_its_own() {
        // 半荘を確定して消すとき（アプリを閉じるとき）、メモ（memos.json）は半荘のフォルダごとごみ箱へ送られる。
        // メモだけを別に送ることも、残すこともない（置き場の直下にあるのは、半荘のフォルダだけ）。
        let tmp = tempfile::tempdir().unwrap();
        let data = tmp.path().join("data");
        let session = make_session(&data, "20261009-190953");
        fs::write(session.join("memos.json"), r#"{"marks":{},"extras":[]}"#).unwrap();

        let recycler = FakeRecycler::new();
        let report = recycle_trash(&data, &recycler);

        assert_eq!(report.recycled, vec!["20261009-190953"]);
        assert_eq!(recycler.asked(), vec![session.clone()]);
        assert!(!session.exists(), "メモのファイルごと、置き場から無くなる");
        assert!(!trash_dir(&data).exists());
    }

    #[test]
    fn u9_without_a_trash_folder_nothing_happens() {
        let tmp = tempfile::tempdir().unwrap();
        let recycler = FakeRecycler::new();
        let report = recycle_trash(&tmp.path().join("data"), &recycler);
        assert_eq!(report, RecycleReport::default());
        assert!(recycler.asked().is_empty());
        std::fs::create_dir_all(tmp.path().join("data")).unwrap();
        let report = recycle_trash(&tmp.path().join("data"), &recycler);
        assert_eq!(report, RecycleReport::default());
    }

    #[test]
    fn u9_one_failure_does_not_stop_the_others_and_keeps_the_trash_folder() {
        let tmp = tempfile::tempdir().unwrap();
        let data = tmp.path().join("data");
        make_session(&data, "20261009-190953");
        let stuck = make_session(&data, "20261010-100000");
        make_session(&data, "20261011-100000");

        let recycler = FakeRecycler::failing_on("20261010-100000");
        let report = recycle_trash(&data, &recycler);

        assert_eq!(report.recycled, vec!["20261009-190953", "20261011-100000"]);
        assert_eq!(
            report.failed,
            vec![("20261010-100000".to_string(), "送れません".to_string())]
        );
        assert!(report.problems()[0].contains("20261010-100000"));
        assert!(stuck.exists(), "送れなかったものは、そのまま残る");
        assert!(
            trash_dir(&data).exists(),
            "中身が残っているので、置き場は片づけない"
        );
    }

    /// 答えの行を 1 件書く（試験用）。
    fn record(db: &mut crate::study::StudyDb, session: &str, key: &str) {
        let answer: crate::study::NewAnswer = serde_json::from_value(serde_json::json!({
            "session_id": session,
            "decision_key": key,
            "mode": "quiz",
            "shown_at": 1,
            "answered_at": 2,
            "choice": {"type": "dahai", "tile": "5p"},
            "reason": "理由",
            "duration_ms": 1,
            "reselect_count": 0,
            "correct": true,
            "interval_days": 1,
            "due_date": "2026-10-10",
        }))
        .unwrap();
        db.record_answer(answer).unwrap();
    }

    #[test]
    fn d3_finalizing_the_trash_forgets_the_answers_of_the_sessions_sent_to_the_recycle_bin_only() {
        use crate::study::{ProblemRef, StudyDb};
        let tmp = tempfile::tempdir().unwrap();
        let data = tmp.path().join("data");
        make_session(&data, "20261009-190953");
        make_session(&data, "20261010-100000");
        let kept = data.join("games").join("20261001-000000");
        fs::create_dir_all(&kept).unwrap();
        let mut db = StudyDb::open(&data).unwrap();
        for session in ["20261009-190953", "20261010-100000", "20261001-000000"] {
            record(&mut db, session, "k0h0e4");
        }
        db.save_daily_set(
            "2026-10-09",
            &[
                ProblemRef {
                    session_id: "20261009-190953".to_string(),
                    decision_key: "k0h0e4".to_string(),
                },
                ProblemRef {
                    session_id: "20261001-000000".to_string(),
                    decision_key: "k0h0e4".to_string(),
                },
            ],
        )
        .unwrap();
        drop(db);

        // 2 つ目は、ごみ箱へ送れない（置き場に残る）。
        let recycler = FakeRecycler::failing_on("20261010-100000");
        let report = finalize_trash(&data, &recycler);
        assert_eq!(report.recycled, vec!["20261009-190953"]);

        let db = StudyDb::open(&data).unwrap();
        let mut left: Vec<String> = db
            .list_answers()
            .unwrap()
            .into_iter()
            .map(|a| a.answer.session_id)
            .collect();
        left.sort();
        // 送った半荘の答えは消え、置き場に残った半荘と、消していない半荘の答えは残る
        assert_eq!(left, vec!["20261001-000000", "20261010-100000"]);
        let set = db.daily_set("2026-10-09").unwrap().unwrap();
        assert_eq!(set.len(), 1);
        assert_eq!(set[0].session_id, "20261001-000000");
    }

    #[test]
    fn d3_while_a_session_is_in_the_trash_its_answers_stay_so_that_restoring_brings_them_back() {
        use crate::store::Store;
        use crate::study::StudyDb;
        let tmp = tempfile::tempdir().unwrap();
        let data = tmp.path().join("data");
        let mut store = Store::open(&data).unwrap();
        let id = {
            use crate::capture::{CaptureTarget, Screenshot};
            store
                .add_mark(
                    crate::clock::now_ms(),
                    Ok(Screenshot {
                        png: vec![0x89, b'P', b'N', b'G'],
                        target: CaptureTarget::Window,
                    }),
                )
                .unwrap();
            store.current_session_id().unwrap().to_string()
        };
        let mut db = StudyDb::open(&data).unwrap();
        record(&mut db, &id, "k0h0e4");
        store.delete_sessions(std::slice::from_ref(&id)).unwrap();
        // 置き場にある間は、答えは消えていない
        assert_eq!(db.list_answers().unwrap().len(), 1);
        store.restore_sessions(std::slice::from_ref(&id)).unwrap();
        assert_eq!(db.list_answers().unwrap().len(), 1);
        // 消して、置き場を片づけると、答えも消える
        store.delete_sessions(std::slice::from_ref(&id)).unwrap();
        let report = finalize_trash(&data, &FakeRecycler::new());
        assert_eq!(report.recycled, vec![id]);
        assert_eq!(db.list_answers().unwrap().len(), 0);
    }

    #[test]
    fn u9_the_inside_check_accepts_only_things_strictly_under_the_trash_folder() {
        let trash = Path::new(r"C:\data\trash");
        assert!(is_strictly_inside(trash, Path::new(r"C:\data\trash\a")));
        assert!(is_strictly_inside(trash, Path::new(r"C:\data\trash\a\b")));
        assert!(!is_strictly_inside(trash, Path::new(r"C:\data\trash")));
        assert!(!is_strictly_inside(trash, Path::new(r"C:\data\games\a")));
        assert!(!is_strictly_inside(trash, Path::new(r"C:\data\trash2\a")));
        assert!(!is_strictly_inside(trash, Path::new(r"C:\data")));
    }

    #[test]
    fn u9_a_junction_inside_trash_that_points_outside_is_never_recycled() {
        let tmp = tempfile::tempdir().unwrap();
        let data = tmp.path().join("data");
        make_session(&data, "20261009-190953");
        let outside = tmp.path().join("outside");
        fs::create_dir_all(&outside).unwrap();
        fs::write(outside.join("precious.txt"), "do not touch").unwrap();
        let link = trash_dir(&data).join("link");
        // ジャンクションは、管理者の権限が無くても作れる。
        let made = std::process::Command::new("cmd")
            .args(["/C", "mklink", "/J"])
            .arg(&link)
            .arg(&outside)
            .output()
            .expect("cmd を動かせる");
        assert!(
            made.status.success(),
            "ジャンクションを作れなかった: {}",
            String::from_utf8_lossy(&made.stdout)
        );

        let recycler = FakeRecycler::new();
        let report = recycle_trash(&data, &recycler);

        assert_eq!(report.recycled, vec!["20261009-190953"]);
        assert_eq!(report.skipped.len(), 1, "{report:?}");
        assert_eq!(report.skipped[0].0, "link");
        assert!(
            recycler
                .asked()
                .iter()
                .all(|p| p.file_name().unwrap() != "link"),
            "リンクをごみ箱へ送る口に渡さない"
        );
        assert!(outside.join("precious.txt").exists(), "リンクの先は無傷");
        assert!(
            trash_dir(&data).exists(),
            "リンクが残るので、置き場は片づけない"
        );
        // 後片づけ: ジャンクションそのものを外す（中身は消えない）。
        fs::remove_dir(&link).unwrap();
    }
}
