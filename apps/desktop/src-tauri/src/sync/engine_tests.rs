//! 同期の試験（D-4）: 手元の記録 → 同期用の DB の行 → 別の手元の記録、2 台の模擬、消す・直す・同じ名前の追加、
//! 結果のファイル、同期しないもの。同期用の DB は偽物（`testing::MemRemote`）。実機の同期用サーバーでの試験は `tests/sync_integration.rs`。

#![cfg(test)]

use std::collections::BTreeMap;
use std::fs;
use std::path::PathBuf;

use serde_json::json;

use super::base::BaseState;
use super::error::{MassDeleteSide, SyncError};
use super::local::{LocalAccess, Ports};
use super::remote::Remote;
use super::rows::{make_key, Kind};
use super::testing::{Dev, MemRow, MemServer};
use crate::capture::{CaptureError, CaptureTarget, Screenshot};
use crate::settings::{Orientation, Trigger};
use crate::store::{
    ExtraMemo, Links, MemoPosition, MemoText, Memos, OcrCache, OcrEntry, Rating, SelfRating,
    EVENTS_FILE, LINKS_FILE, MAKA_FILE, MEMOS_FILE, OCR_FILE, REPORT_FILE, RESOLVED_FILE,
    SELF_RATINGS_FILE, SESSION_GAP_MS,
};
use crate::study::{AnswerMode, NewAnswer, ProblemRef, StudyDb, WeekRecord, WeekStats};

const T0: i64 = 1_760_000_000_123;
const REPORT_SENTINEL: &str = "REPORT-SENTINEL-4f2a";
const OCR_SENTINEL: &str = "OCR-SENTINEL-9b1c";
const PNG: [u8; 7] = [0x89, b'P', b'N', b'G', 9, 9, 9];

fn shot() -> Result<Screenshot, CaptureError> {
    Ok(Screenshot {
        png: PNG.to_vec(),
        target: CaptureTarget::Window,
    })
}

fn answer(session: &str, key: &str, mode: AnswerMode, at: i64) -> NewAnswer {
    NewAnswer {
        session_id: session.to_string(),
        decision_key: key.to_string(),
        mode,
        shown_at: at - 40_000,
        answered_at: at,
        choice: json!({"type": "dahai", "tile": "5p"}),
        reason: "孤立を切る".to_string(),
        duration_ms: 40_000,
        reselect_count: 1,
        correct: true,
        causes: Vec::new(),
        principle: String::new(),
        maka_move: None,
        interval_days: 3,
        due_date: "2026-10-15".to_string(),
    }
}

fn report_text(note: &str) -> String {
    // 大きめの、くり返しのある JSON（圧縮の効果も見る）
    let details: Vec<serde_json::Value> = (0..200)
        .map(|i| json!({"i": i, "tile": "5p", "prob": 0.125, "note": note}))
        .collect();
    json!({"review": {"kyokus": details}, "sentinel": REPORT_SENTINEL}).to_string()
}

/// 全種類の記録を入れた端末。半荘 a（迷いマーク 2・評価 1・結果・文字認識の写し・全種類の記録）と、半荘 b（少しの記録・結果）。
fn populate(dev: &Dev) -> (String, String) {
    let mut store = dev.store();
    store.add_mark(T0, shot()).unwrap();
    store.add_mark(T0 + 1_000, shot()).unwrap();
    store.add_rating(T0 + 2_000, Rating::Good, shot()).unwrap();
    let a = store.current_session_id().unwrap().to_string();
    store.close_session(T0 + 3_000).unwrap();
    store.add_mark(T0 + SESSION_GAP_MS * 2, shot()).unwrap();
    let b = store.current_session_id().unwrap().to_string();
    store.close_session(T0 + SESSION_GAP_MS * 2 + 2).unwrap();

    store.save_report(Some(&a), &report_text("a"), T0).unwrap();
    store.save_report(Some(&b), &report_text("b"), T0).unwrap();
    let mut ocr = OcrCache {
        geometry: "center-v3".to_string(),
        ..OcrCache::default()
    };
    ocr.entries.insert(
        "marks/x.png".to_string(),
        OcrEntry {
            lines: vec![OCR_SENTINEL.to_string()],
            ..OcrEntry::default()
        },
    );
    store.save_ocr(&a, &ocr).unwrap();

    let mut links = Links::default();
    links.marks.insert("1".into(), "k0h0e3".into());
    links.marks.insert("2".into(), "manual".into());
    links.ratings.insert("3".into(), "k0h0".into());
    links.ratings_version = Some(3);
    store.replace_links(&a, links).unwrap();
    store.set_self_rating(&a, "k0h0", SelfRating::Bad).unwrap();
    store
        .set_self_rating(&a, "k1h0", SelfRating::Unrated)
        .unwrap();
    store.set_maka_grade(&a, "k0h0", "A-").unwrap();
    store.set_maka_hanchan(&a, "B+").unwrap();
    store.set_resolved(&a, "k0h0e3", true, T0 + 4_000).unwrap();
    store.set_resolved(&a, "k1h0e4", true, T0 + 4_100).unwrap();
    store.set_resolved(&b, "k0h0e2", true, T0 + 4_200).unwrap();
    store.set_memo(&a, 1, "3m・6p", "東を残したい").unwrap();
    let pos = MemoPosition {
        kyoku: 2,
        honba: 0,
        junme: 9,
    };
    store
        .set_extra_memo(&a, "x1", None, Some(pos), "5s・發", "")
        .unwrap();
    store
        .set_extra_memo(&a, "x2", Some("k1h1e7"), Some(pos), "", "速さ")
        .unwrap();
    store.set_mark_link(&b, 1, "k0h0e2").unwrap();
    store.set_memo(&b, 1, "", "理由だけ").unwrap();

    {
        let mut db = dev.ports.study();
        db.record_answer(answer(&a, "k0h0e3", AnswerMode::Quiz, T0 + 10_000))
            .unwrap();
        let mut wrong = answer(&a, "k1h0e4", AnswerMode::Quiz, T0 + 20_000);
        wrong.correct = false;
        wrong.causes = vec!["ukeire".to_string(), "defense".to_string()];
        wrong.principle = "受け入れを数えてから切る".to_string();
        wrong.maka_move = Some("5pr".to_string());
        wrong.choice = json!({"type": "option", "id": "pon"});
        db.record_answer(wrong).unwrap();
        db.record_answer(answer(&a, "k0h0e3", AnswerMode::Review, T0 + 30_000))
            .unwrap();
        db.record_answer(answer(&b, "k0h0e2", AnswerMode::Quiz, T0 + 40_000))
            .unwrap();
        db.save_daily_set(
            "2026-10-12",
            &[
                ProblemRef {
                    session_id: a.clone(),
                    decision_key: "k0h0e3".to_string(),
                },
                ProblemRef {
                    session_id: b.clone(),
                    decision_key: "k0h0e2".to_string(),
                },
            ],
        )
        .unwrap();
        db.set_week(WeekRecord {
            week: "2026-10-05".to_string(),
            stats: WeekStats {
                rank4: Some(20.4),
                deal: Some(11.5),
                avg: Some(2.41),
                win: Some(24.0),
                call: Some(31.2),
                riichi: Some(19.9),
            },
            focus: "受け入れを数えてから切る。\n押し引きを見直す。".to_string(),
        })
        .unwrap();
    }
    {
        let mut s = dev.ports.settings.lock().unwrap();
        s.sound = false;
        // 既定（入）とは違う値にして、設定の行で届くことを確かめる（W-15）
        s.doubt_only = false;
        s.daily_count = 9;
        s.orientation = Orientation::Horizontal;
        s.trigger = Trigger::Key {
            code: "F13".to_string(),
            ctrl: true,
            alt: false,
            shift: false,
            win: false,
        };
        s.capture_keywords = vec!["雀魂".into(), "Majsoul client".into()];
        s.widget_position = Some(crate::settings::WidgetPosition { x: 12, y: 34 });
    }
    (a, b)
}

/// 端末の記録の、見た目の状態（番号・端末ごとのファイルは除く）。
#[derive(Debug, PartialEq)]
struct Logical {
    /// uid → 答え
    answers: BTreeMap<String, NewAnswer>,
    daily: Vec<crate::study::DailySetRecord>,
    weeks: Vec<WeekRecord>,
    sessions: BTreeMap<String, crate::store::SessionRecords>,
    reports: BTreeMap<String, Vec<u8>>,
    settings: crate::study::records::PortableSettings,
}

fn logical(dev: &Dev) -> Logical {
    let store = dev.store();
    let db = StudyDb::open(dev.data()).unwrap();
    let mut sessions = BTreeMap::new();
    let mut reports = BTreeMap::new();
    for session in store.list_sessions().unwrap() {
        if let Some(path) = &session.report_path {
            reports.insert(session.id.clone(), fs::read(path).unwrap());
        }
        sessions.insert(
            session.id.clone(),
            crate::store::SessionRecords {
                links: session.links,
                self_ratings: session.self_ratings,
                maka: session.maka,
                memos: session.memos,
                resolved: session.resolved,
            },
        );
    }
    Logical {
        answers: db
            .list_answers()
            .unwrap()
            .into_iter()
            .map(|row| (row.uid.unwrap(), row.answer))
            .collect(),
        daily: db.list_daily_sets().unwrap(),
        weeks: db.list_weeks().unwrap(),
        sessions,
        reports,
        settings: crate::study::records::PortableSettings::from_settings(
            &dev.ports.settings.lock().unwrap(),
        ),
    }
}

fn session_dir(dev: &Dev, id: &str) -> PathBuf {
    dev.store().session_folder(id).unwrap()
}

fn read_memos(dev: &Dev, id: &str) -> Memos {
    fs::read_to_string(session_dir(dev, id).join(MEMOS_FILE))
        .ok()
        .and_then(|text| serde_json::from_str(&text).ok())
        .unwrap_or_default()
}

fn write_memos(dev: &Dev, id: &str, memos: &Memos) {
    let path = session_dir(dev, id).join(MEMOS_FILE);
    fs::write(path, serde_json::to_string_pretty(memos).unwrap()).unwrap();
}

fn memo(candidates: &str, reason: &str) -> MemoText {
    MemoText {
        candidates: candidates.to_string(),
        reason: reason.to_string(),
    }
}

fn extra(label: &str, reason: &str) -> ExtraMemo {
    ExtraMemo {
        id: label.to_string(),
        uid: None,
        decision: None,
        position: Some(MemoPosition {
            kyoku: 1,
            honba: 0,
            junme: 4,
        }),
        candidates: String::new(),
        reason: reason.to_string(),
    }
}

/// 2 台を、同じ記録に落ち着かせる（A が作って同期、B が取り込む）。
fn pair() -> (MemServer, Dev, Dev, String, String) {
    let server = MemServer::new();
    let mut a = Dev::new("d-aaaa", &server);
    let mut b = Dev::new("d-bbbb", &server);
    let (sa, sb) = populate(&a);
    a.cycle(1_000_000).unwrap();
    b.cycle(1_100_000).unwrap();
    a.cycle(1_200_000).unwrap();
    (server, a, b, sa, sb)
}

fn settle(a: &mut Dev, b: &mut Dev, mut now: i64) {
    for _ in 0..4 {
        now += 10_000;
        a.cycle(now).unwrap();
        now += 10_000;
        b.cycle(now).unwrap();
    }
}

// ---- 往復 ----

#[test]
fn d4_records_round_trip_through_the_sync_rows_into_another_local_db_identically() {
    let server = MemServer::new();
    let mut a = Dev::new("d-aaaa", &server);
    let mut b = Dev::new("d-bbbb", &server);
    let (sa, sb) = populate(&a);
    let report_a = a.cycle(1_000_000).unwrap();
    assert!(report_a.pushed && report_a.remote_puts > 20, "{report_a:?}");
    let report_b = b.cycle(1_100_000).unwrap();
    assert!(report_b.local_puts > 20, "{report_b:?}");
    a.cycle(1_200_000).unwrap();

    let (la, lb) = (logical(&a), logical(&b));
    assert_eq!(la.answers.len(), 4);
    assert_eq!(la, lb, "元と、別の手元の記録が、同じになる");
    // 結果のファイルも、そのまま届く
    assert_eq!(lb.reports.len(), 2);
    assert!(String::from_utf8_lossy(&lb.reports[&sa]).contains(REPORT_SENTINEL));
    assert_eq!(
        fs::read(session_dir(&a, &sb).join(REPORT_FILE)).unwrap(),
        fs::read(session_dir(&b, &sb).join(REPORT_FILE)).unwrap()
    );
    // 設定: 保存先と窓の位置は、そのまま（B は、A の値を持たない）
    assert_eq!(b.ports.settings().widget_position, None);
    assert_eq!(b.ports.settings().data_dir, b.data());
    assert!(!b.ports.settings().sound);
    assert!(!b.ports.settings().doubt_only, "迷いだけの設定も届く");
    assert_eq!(b.ports.settings().daily_count, 9);
    // 解決した局面（D-6）が、同じ時刻のまま届く
    let resolved = b.store().load_resolved(&sa).unwrap();
    assert_eq!(resolved.decisions.len(), 2);
    assert_eq!(resolved.decisions["k0h0e3"], T0 + 4_000);
    assert_eq!(resolved.decisions["k1h0e4"], T0 + 4_100);
    assert_eq!(
        b.store().load_resolved(&sb).unwrap().decisions["k0h0e2"],
        T0 + 4_200
    );
    // 同期しない: スクショ・ウィジェットの記録・文字認識の写し
    let folder = session_dir(&b, &sa);
    assert!(!folder.join(EVENTS_FILE).exists());
    assert!(!folder.join(OCR_FILE).exists());
    assert!(!folder.join("marks").exists());
    assert!(!folder.join("ratings").exists());
    // 取り込んだ半荘は、一覧に出て、開ける（結果がある半荘として）
    let listed = b.store().list_sessions().unwrap();
    assert_eq!(listed.len(), 2);
    assert!(listed.iter().all(|s| s.report_path.is_some()));

    // 何も変えなければ、何も動かない
    let again_b = b.cycle(1_300_000).unwrap();
    let again_a = a.cycle(1_310_000).unwrap();
    for report in [again_a, again_b] {
        assert_eq!(report.local_puts + report.local_deletes, 0, "{report:?}");
        assert_eq!(
            report.remote_puts + report.remote_tombstones,
            0,
            "{report:?}"
        );
    }
}

#[test]
fn e49_old_removed_setting_rows_are_ignored() {
    let server = MemServer::new();
    let mut source = Dev::new("d-source", &server);
    populate(&source);
    source.cycle(1_000_000).unwrap();

    let legacy = [
        ("disagreement_percent", "10"),
        ("contest_enabled", "true"),
        ("contest_gap_percent", "30"),
        ("contest_by_junme", "false"),
        ("contest_min_junme", "8"),
        ("contest_after_riichi", "false"),
        ("contest_two_calls", "false"),
    ];
    {
        let mut store = server.store();
        for (name, value) in legacy {
            store.rows.insert(
                make_key(Kind::Setting, &[name]),
                MemRow {
                    value: value.to_string(),
                    deleted: false,
                    stamp: (1_100_000, "old-client".to_string()),
                },
            );
        }
    }

    let mut target = Dev::new("d-target", &server);
    let report = target.cycle(1_200_000).unwrap();
    assert!(report.warnings.is_empty(), "{report:?}");
    assert_eq!(target.ports.settings().daily_count, 9);

    let local = target.local.snapshot(&BTreeMap::new()).unwrap();
    for (name, _) in legacy {
        assert!(!local.items.contains_key(&make_key(Kind::Setting, &[name])));
    }
}

#[test]
fn d4_a_record_never_changes_when_it_goes_to_the_sync_db_and_back() {
    // 手元 → 行 → 別の手元で、1 つずつの値が同じ（答えの全部の欄・メモの全部の欄）
    let (_server, a, b, sa, _sb) = pair();
    let ra = a.store().list_sessions().unwrap();
    let rb = b.store().list_sessions().unwrap();
    let find =
        |list: &[crate::store::SessionRecord]| list.iter().find(|s| s.id == sa).cloned().unwrap();
    let (xa, xb) = (find(&ra), find(&rb));
    assert_eq!(xa.links, xb.links);
    assert_eq!(xa.self_ratings, xb.self_ratings);
    assert_eq!(xa.maka, xb.maka);
    assert_eq!(xa.resolved, xb.resolved);
    assert_eq!(xa.memos.marks, xb.memos.marks);
    let strip = |memos: &Memos| -> Vec<(Option<String>, Option<MemoPosition>, String, String)> {
        memos
            .extras
            .iter()
            .map(|e| {
                (
                    e.decision.clone(),
                    e.position,
                    e.candidates.clone(),
                    e.reason.clone(),
                )
            })
            .collect()
    };
    assert_eq!(strip(&xa.memos), strip(&xb.memos));
    let wrong_a = StudyDb::open(a.data()).unwrap().list_answers().unwrap();
    let wrong_b = StudyDb::open(b.data()).unwrap().list_answers().unwrap();
    let by_uid = |rows: Vec<crate::study::AnswerRow>| -> BTreeMap<String, NewAnswer> {
        rows.into_iter()
            .map(|r| (r.uid.unwrap(), r.answer))
            .collect()
    };
    assert_eq!(by_uid(wrong_a), by_uid(wrong_b));
}

#[test]
fn d4_screenshots_widget_records_and_ocr_copies_never_reach_the_sync_db() {
    let (server, a, _b, sa, _sb) = pair();
    // 同期用の DB のどの行・本体にも、同期しないものの中身が無い
    let store = server.store();
    for (key, row) in &store.rows {
        for forbidden in [OCR_SENTINEL, "events", "marks/", "ratings/", "ocr", "png"] {
            assert!(
                !row.value.contains(forbidden) && !key.contains(forbidden),
                "{key}: {forbidden}"
            );
        }
    }
    for (key, gz) in &store.blobs {
        let bytes = super::engine::gunzip(gz).unwrap();
        let text = String::from_utf8_lossy(&bytes);
        assert!(!text.contains(OCR_SENTINEL), "{key}");
        assert!(
            text.contains(REPORT_SENTINEL),
            "結果のファイルは入る: {key}"
        );
    }
    // 鍵は、決めた種類だけ
    for key in store.rows.keys() {
        let kind = super::rows::kind_of(key);
        assert!(kind.is_some(), "{key}");
    }
    // 手元の events.jsonl を読んでいない（開始の行の中身が、行に出ない）
    let events = fs::read_to_string(session_dir(&a, &sa).join(EVENTS_FILE)).unwrap();
    let first_line = events.lines().next().unwrap_or("");
    assert!(!first_line.is_empty());
    for row in store.rows.values() {
        assert!(!row.value.contains(first_line));
    }
}

#[test]
fn d4_the_report_is_stored_compressed_and_comes_back_byte_for_byte() {
    let (server, _a, b, sa, _sb) = pair();
    let key = make_key(Kind::Report, &[&sa]);
    let store = server.store();
    let gz = store.blobs.get(&key).unwrap();
    let raw = report_text("a");
    assert!(gz.len() * 5 < raw.len(), "{} / {}", gz.len(), raw.len());
    drop(store);
    assert_eq!(
        fs::read_to_string(session_dir(&b, &sa).join(REPORT_FILE)).unwrap(),
        raw
    );
}

// ---- 2 台の模擬 ----

#[test]
fn d4_edits_to_different_memo_items_on_two_devices_both_survive() {
    let (_server, mut a, mut b, sa, _sb) = pair();
    let mut ma = read_memos(&a, &sa);
    ma.marks
        .insert("1".into(), memo("3m・6p", "A が直した理由"));
    write_memos(&a, &sa, &ma);
    a.reconcile(2_000_000).unwrap();
    let mut mb = read_memos(&b, &sa);
    mb.marks.insert("2".into(), memo("白", "B が足したメモ"));
    write_memos(&b, &sa, &mb);
    b.reconcile(2_100_000).unwrap();
    settle(&mut a, &mut b, 3_000_000);
    for dev in [&a, &b] {
        let m = read_memos(dev, &sa);
        assert_eq!(m.marks["1"].reason, "A が直した理由");
        assert_eq!(m.marks["2"].reason, "B が足したメモ");
    }
    assert_eq!(logical(&a), logical(&b));
}

#[test]
fn d6_resolving_and_unresolving_on_one_device_reaches_the_other_and_an_empty_file_goes() {
    let (_server, mut a, mut b, sa, _sb) = pair();
    let file = |dev: &Dev| session_dir(dev, &sa).join(RESOLVED_FILE);
    assert!(file(&b).is_file());
    // A が 1 つ切る: B にも、1 つだけが残る
    a.store().set_resolved(&sa, "k0h0e3", false, 1).unwrap();
    a.reconcile(2_000_000).unwrap();
    settle(&mut a, &mut b, 3_000_000);
    for dev in [&a, &b] {
        let resolved = dev.store().load_resolved(&sa).unwrap();
        assert_eq!(resolved.decisions.keys().collect::<Vec<_>>(), ["k1h0e4"]);
    }
    // B が新しく入れる: A にも届く（時刻は B が入れたとき）
    b.store()
        .set_resolved(&sa, "k5h0e9", true, T0 + 50_000)
        .unwrap();
    b.reconcile(4_000_000).unwrap();
    settle(&mut a, &mut b, 5_000_000);
    for dev in [&a, &b] {
        let resolved = dev.store().load_resolved(&sa).unwrap();
        assert_eq!(resolved.decisions.len(), 2);
        assert_eq!(resolved.decisions["k5h0e9"], T0 + 50_000);
    }
    // 全部切ると、どちらの端末でも、ファイルが消える
    for key in ["k1h0e4", "k5h0e9"] {
        a.store().set_resolved(&sa, key, false, 1).unwrap();
    }
    a.reconcile(6_000_000).unwrap();
    settle(&mut a, &mut b, 7_000_000);
    assert!(!file(&a).exists() && !file(&b).exists());
    assert_eq!(logical(&a), logical(&b));
}

#[test]
fn d6_different_decisions_resolved_on_two_devices_both_survive() {
    let (_server, mut a, mut b, sa, _sb) = pair();
    a.store()
        .set_resolved(&sa, "k2h0e1", true, T0 + 60_000)
        .unwrap();
    a.reconcile(2_000_000).unwrap();
    b.store()
        .set_resolved(&sa, "k3h0e2", true, T0 + 61_000)
        .unwrap();
    b.reconcile(2_100_000).unwrap();
    settle(&mut a, &mut b, 3_000_000);
    for dev in [&a, &b] {
        let resolved = dev.store().load_resolved(&sa).unwrap();
        assert_eq!(
            resolved.decisions.len(),
            4,
            "元の 2 つと、それぞれが足した 1 つずつ"
        );
        assert!(
            resolved.decisions.contains_key("k2h0e1") && resolved.decisions.contains_key("k3h0e2")
        );
    }
    assert_eq!(logical(&a), logical(&b));
}

#[test]
fn d6_a_decision_unresolved_on_one_device_stays_unresolved_when_the_other_syncs_later() {
    let (_server, mut a, mut b, sa, _sb) = pair();
    // A が切ったあと、B は何もしないまま同期する: 切ったままになり、B が入れ直したりしない
    a.store().set_resolved(&sa, "k1h0e4", false, 1).unwrap();
    a.reconcile(2_000_000).unwrap();
    b.cycle(3_000_000).unwrap();
    settle(&mut a, &mut b, 4_000_000);
    for dev in [&a, &b] {
        assert!(!dev
            .store()
            .load_resolved(&sa)
            .unwrap()
            .decisions
            .contains_key("k1h0e4"));
    }
}

#[test]
fn d4_the_same_memo_edited_on_both_sides_keeps_the_newer_edit() {
    for b_pushes_first in [false, true] {
        let (_server, mut a, mut b, sa, _sb) = pair();
        let mut ma = read_memos(&a, &sa);
        ma.marks.insert("1".into(), memo("3m", "A の直し"));
        write_memos(&a, &sa, &ma);
        a.reconcile(2_000_000).unwrap();
        let mut mb = read_memos(&b, &sa);
        mb.marks.insert("1".into(), memo("6p", "B の直し（あと）"));
        write_memos(&b, &sa, &mb);
        b.reconcile(2_500_000).unwrap();
        if b_pushes_first {
            b.cycle(3_000_000).unwrap();
            a.cycle(3_010_000).unwrap();
        } else {
            a.cycle(3_000_000).unwrap();
            b.cycle(3_010_000).unwrap();
        }
        settle(&mut a, &mut b, 4_000_000);
        for dev in [&a, &b] {
            assert_eq!(
                read_memos(dev, &sa).marks["1"].reason,
                "B の直し（あと）",
                "b_pushes_first={b_pushes_first}"
            );
        }
    }
}

#[test]
fn d4_deleting_beats_editing_whichever_device_syncs_first() {
    for a_first in [true, false] {
        let (_server, mut a, mut b, sa, _sb) = pair();
        // A がメモを消し、B が同じメモを直す
        let mut ma = read_memos(&a, &sa);
        ma.marks.remove("1");
        write_memos(&a, &sa, &ma);
        a.reconcile(2_000_000).unwrap();
        let mut mb = read_memos(&b, &sa);
        mb.marks.insert("1".into(), memo("白", "B が直した"));
        write_memos(&b, &sa, &mb);
        b.reconcile(2_500_000).unwrap();
        if a_first {
            a.cycle(3_000_000).unwrap();
            b.cycle(3_010_000).unwrap();
        } else {
            b.cycle(3_000_000).unwrap();
            a.cycle(3_010_000).unwrap();
        }
        settle(&mut a, &mut b, 4_000_000);
        for dev in [&a, &b] {
            assert!(
                !read_memos(dev, &sa).marks.contains_key("1"),
                "a_first={a_first}: 消えたまま"
            );
        }
        assert_eq!(logical(&a), logical(&b));
    }
}

#[test]
fn d4_answers_recorded_on_both_devices_both_survive_and_local_ids_never_clash() {
    let (_server, mut a, mut b, sa, _sb) = pair();
    // 両方の端末が、同期の前に、答えを 1 つずつ足す。手元の番号は、どちらも同じ（5）になる
    let (ra, rb) = {
        let mut da = a.ports.study();
        let mut db = b.ports.study();
        (
            da.record_answer(answer(&sa, "k2h0e1", AnswerMode::Quiz, T0 + 50_000))
                .unwrap(),
            db.record_answer(answer(&sa, "k3h0e2", AnswerMode::Quiz, T0 + 60_000))
                .unwrap(),
        )
    };
    assert_eq!(ra.id, rb.id, "手元の番号は重なる");
    assert_ne!(ra.uid, rb.uid, "uid は重ならない");
    a.reconcile(2_000_000).unwrap();
    b.reconcile(2_000_100).unwrap();
    settle(&mut a, &mut b, 3_000_000);
    let (la, lb) = (logical(&a), logical(&b));
    assert_eq!(la.answers.len(), 6);
    assert_eq!(la, lb);
    let keys: Vec<&str> = la
        .answers
        .values()
        .map(|a| a.decision_key.as_str())
        .collect();
    assert!(keys.contains(&"k2h0e1") && keys.contains(&"k3h0e2"));
}

#[test]
fn d4_extra_memos_added_with_the_same_name_on_both_devices_both_survive() {
    let (_server, mut a, mut b, sa, _sb) = pair();
    // どちらも、同期の前に、呼び名 x9 のメモを足す（中身は別）
    for (dev, reason) in [(&a, "A の x9"), (&b, "B の x9")] {
        let mut m = read_memos(dev, &sa);
        m.extras.push(extra("x9", reason));
        write_memos(dev, &sa, &m);
    }
    a.reconcile(2_000_000).unwrap();
    b.reconcile(2_000_100).unwrap();
    settle(&mut a, &mut b, 3_000_000);
    for dev in [&a, &b] {
        let m = read_memos(dev, &sa);
        let reasons: Vec<&str> = m.extras.iter().map(|e| e.reason.as_str()).collect();
        assert!(
            reasons.contains(&"A の x9") && reasons.contains(&"B の x9"),
            "{reasons:?}"
        );
        let labels: std::collections::BTreeSet<&str> =
            m.extras.iter().map(|e| e.id.as_str()).collect();
        assert_eq!(
            labels.len(),
            m.extras.len(),
            "呼び名は重ならない: {labels:?}"
        );
        assert!(m.extras.iter().all(|e| e.uid.is_some()));
    }
    let strip = |dev: &Dev| -> Vec<String> {
        let mut r: Vec<String> = read_memos(dev, &sa)
            .extras
            .iter()
            .map(|e| e.reason.clone())
            .collect();
        r.sort();
        r
    };
    assert_eq!(strip(&a), strip(&b));
}

#[test]
fn d4_old_extra_memos_without_ids_get_the_same_ids_on_two_copies_of_the_same_folder() {
    let server = MemServer::new();
    let mut a = Dev::new("d-aaaa", &server);
    let mut b = Dev::new("d-bbbb", &server);
    let (sa, _) = populate(&a);
    // B は、A と同じ半荘のフォルダを、写して持っている（同期を入れる前に、保存先を写した）
    let src = session_dir(&a, &sa);
    let dst = b.data().join("games").join(&sa);
    fs::create_dir_all(&dst).unwrap();
    for entry in fs::read_dir(&src).unwrap().flatten() {
        if entry.file_type().unwrap().is_file() {
            fs::copy(entry.path(), dst.join(entry.file_name())).unwrap();
        }
    }
    a.cycle(1_000_000).unwrap();
    b.cycle(1_100_000).unwrap();
    a.cycle(1_200_000).unwrap();
    // 同じ uid が付いたので、メモは 2 倍にならない
    for dev in [&a, &b] {
        assert_eq!(read_memos(dev, &sa).extras.len(), 2, "{}", dev.name);
    }
    let uids = |dev: &Dev| -> Vec<Option<String>> {
        read_memos(dev, &sa)
            .extras
            .iter()
            .map(|e| e.uid.clone())
            .collect()
    };
    assert_eq!(uids(&a), uids(&b));
    assert!(uids(&a)[0].as_deref().unwrap().starts_with('l'));
}

#[test]
fn d4_answers_deleted_on_one_device_stay_deleted_on_the_other() {
    let (server, mut a, mut b, sa, _sb) = pair();
    // A が、半荘 a の答えを消す（半荘をごみ箱へ送ったあとの片づけと同じ）
    a.ports
        .study()
        .forget_sessions(std::slice::from_ref(&sa))
        .unwrap();
    a.cycle(2_000_000).unwrap();
    b.cycle(2_100_000).unwrap();
    settle(&mut a, &mut b, 3_000_000);
    let answers_of = |dev: &Dev, s: &str| -> usize {
        StudyDb::open(dev.data())
            .unwrap()
            .list_answers()
            .unwrap()
            .iter()
            .filter(|r| r.answer.session_id == s)
            .count()
    };
    assert_eq!(answers_of(&a, &sa), 0);
    assert_eq!(answers_of(&b, &sa), 0, "もう一方の端末でも消える");
    assert!(
        server.keys().iter().any(|k| server.is_tombstone(k)),
        "消した印が残る"
    );
    // 消えたものは、同期をくり返しても、戻らない
    settle(&mut a, &mut b, 5_000_000);
    assert_eq!(answers_of(&a, &sa), 0);
    assert_eq!(answers_of(&b, &sa), 0);
}

#[test]
fn d4_a_session_deleted_on_one_device_goes_to_the_trash_of_the_other() {
    let (_server, mut a, mut b, sa, sb) = pair();
    // A が半荘 b を消す（置き場に移し、閉じるときにごみ箱へ送って、答えも消す）
    let mut store = a.store();
    store.delete_sessions(std::slice::from_ref(&sb)).unwrap();
    // 置き場にある間は、消したことにしない（元に戻せる）
    a.cycle(2_000_000).unwrap();
    b.cycle(2_100_000).unwrap();
    assert!(
        session_dir(&b, &sb).is_dir(),
        "置き場にある間は、ほかの端末は消さない"
    );
    // 閉じるときの片づけ（ごみ箱へ送る代わりに、置き場を空にして、答えを消す）
    fs::remove_dir_all(a.trash_dir()).unwrap();
    a.ports
        .study()
        .forget_sessions(std::slice::from_ref(&sb))
        .unwrap();
    a.cycle(3_000_000).unwrap();
    b.cycle(3_100_000).unwrap();
    assert!(
        !session_dir(&b, &sb).is_dir(),
        "B でも、半荘のフォルダが置き場へ移る"
    );
    assert!(b.trash_dir().join(&sb).is_dir());
    assert!(b.ports.deleted.lock().unwrap().contains(&sb));
    // 残った半荘は、そのまま
    assert!(session_dir(&b, &sa).join(REPORT_FILE).is_file());
    settle(&mut a, &mut b, 5_000_000);
    assert_eq!(logical(&a).sessions.keys().collect::<Vec<_>>(), [&sa]);
    assert_eq!(logical(&a), logical(&b));
}

#[test]
fn d4_a_session_in_the_trash_is_not_treated_as_deleted_until_it_is_gone() {
    let (server, mut a, _b, _sa, sb) = pair();
    let before = server.keys().len();
    let mut store = a.store();
    store.delete_sessions(std::slice::from_ref(&sb)).unwrap();
    let report = a.cycle(2_000_000).unwrap();
    assert_eq!(report.remote_tombstones, 0, "{report:?}");
    assert!(!server.is_tombstone(&make_key(Kind::Report, &[&sb])));
    assert_eq!(server.keys().len(), before);
    // 元に戻すと、そのまま続く
    let store = a.store();
    store.restore_sessions(std::slice::from_ref(&sb)).unwrap();
    let report = a.cycle(2_100_000).unwrap();
    assert_eq!(report.remote_tombstones, 0);
}

#[test]
fn d4_a_session_whose_report_arrives_gets_a_folder_and_its_records_in_the_same_cycle() {
    let server = MemServer::new();
    let mut a = Dev::new("d-aaaa", &server);
    let mut b = Dev::new("d-bbbb", &server);
    let (sa, _sb) = populate(&a);
    a.cycle(1_000_000).unwrap();
    assert!(!b.data().join("games").join(&sa).exists());
    let report = b.cycle(1_100_000).unwrap();
    assert!(report.local_puts > 10);
    let dir = session_dir(&b, &sa);
    assert!(dir.join(REPORT_FILE).is_file());
    assert!(dir.join(MEMOS_FILE).is_file());
    assert!(dir.join(LINKS_FILE).is_file());
    assert!(dir.join(SELF_RATINGS_FILE).is_file());
    assert!(dir.join(MAKA_FILE).is_file());
    // 迷いマークが無い半荘でも、一覧に出て、結果から開ける
    let listed = b.store().list_sessions().unwrap();
    let session = listed.iter().find(|s| s.id == sa).unwrap();
    assert_eq!(session.mark_count, 0);
    assert!(session.report_path.is_some());
    assert_eq!(session.memos.marks["1"].reason, "東を残したい");
}

#[test]
fn d4_records_of_a_session_without_a_folder_or_report_wait_without_being_deleted() {
    // 答え・メモだけが先に届いた半荘（結果はまだ）: 手元に半荘のフォルダが無くても、消した印を作らない
    let server = MemServer::new();
    let mut a = Dev::new("d-aaaa", &server);
    let mut b = Dev::new("d-bbbb", &server);
    let (sa, _sb) = populate(&a);
    // A の半荘 a から結果を消す（結果だけ無い）
    fs::remove_file(session_dir(&a, &sa).join(REPORT_FILE)).unwrap();
    a.cycle(1_000_000).unwrap();
    let report = b.cycle(1_100_000).unwrap();
    assert!(
        !b.data().join("games").join(&sa).exists(),
        "結果が無いので、フォルダは作らない"
    );
    assert_eq!(report.remote_tombstones, 0);
    // 答えは届く
    assert!(!StudyDb::open(b.data())
        .unwrap()
        .list_answers()
        .unwrap()
        .is_empty());
    // 何度回しても、A の記録は消えない
    settle(&mut a, &mut b, 2_000_000);
    assert_eq!(read_memos(&a, &sa).marks["1"].reason, "東を残したい");
}

#[test]
fn d4_a_record_file_that_cannot_be_read_is_never_taken_for_a_deletion() {
    let (server, mut a, mut b, sa, _sb) = pair();
    // A の memos.json が壊れた
    fs::write(session_dir(&a, &sa).join(MEMOS_FILE), "{ broken").unwrap();
    let report = a.cycle(2_000_000).unwrap();
    assert_eq!(report.remote_tombstones, 0, "{report:?}");
    assert!(
        server
            .value(&make_key(Kind::MarkMemo, &[&sa, "1"]))
            .is_some(),
        "同期用の DB のメモは、そのまま"
    );
    assert!(
        report.warnings.iter().any(|w| w.contains("読めない")),
        "{report:?}"
    );
    // B には、メモが残る
    b.cycle(2_100_000).unwrap();
    assert_eq!(read_memos(&b, &sa).marks["1"].reason, "東を残したい");
}

#[test]
fn d4_changes_made_offline_are_kept_and_sent_when_the_connection_returns() {
    let (server, mut a, mut b, sa, _sb) = pair();
    a.remote.set_offline(true);
    let mut ma = read_memos(&a, &sa);
    ma.marks
        .insert("1".into(), memo("3m", "オフラインで直した"));
    write_memos(&a, &sa, &ma);
    a.ports
        .study()
        .record_answer(answer(&sa, "k5h0e1", AnswerMode::Quiz, T0 + 70_000))
        .unwrap();
    let report = a.cycle(2_000_000).unwrap();
    assert!(
        report
            .network_error
            .as_ref()
            .is_some_and(SyncError::is_offline),
        "{report:?}"
    );
    assert!(!report.pulled && !report.pushed);
    assert!(
        a.remote.pending_len() >= 2,
        "手元の写しには書いてある（未送信）"
    );
    // サーバーは、まだ古い
    assert!(server
        .value(&make_key(Kind::MarkMemo, &[&sa, "1"]))
        .unwrap()
        .contains("東を残したい"));
    // オフラインのまま、何度回しても、手元の記録は壊れない
    a.cycle(2_100_000).unwrap();
    assert_eq!(read_memos(&a, &sa).marks["1"].reason, "オフラインで直した");
    // つながる
    a.remote.set_offline(false);
    let report = a.cycle(3_000_000).unwrap();
    assert!(
        report.pushed && report.network_error.is_none(),
        "{report:?}"
    );
    b.cycle(3_100_000).unwrap();
    assert_eq!(read_memos(&b, &sa).marks["1"].reason, "オフラインで直した");
    assert_eq!(logical(&b).answers.len(), 5);
    assert_eq!(a.remote.pending_len(), 0);
}

#[test]
fn d4_an_edit_made_offline_earlier_than_another_devices_edit_loses_to_it() {
    let (server, mut a, mut b, sa, _sb) = pair();
    // A は、オフラインで、メモを直す（時刻 2,000,000）
    a.remote.set_offline(true);
    let mut ma = read_memos(&a, &sa);
    ma.marks.insert("1".into(), memo("3m", "A の古い直し"));
    write_memos(&a, &sa, &ma);
    a.cycle(2_000_000).unwrap();
    // B は、あとから（時刻 2,500,000）直して、すぐ同期する
    let mut mb = read_memos(&b, &sa);
    mb.marks.insert("1".into(), memo("6p", "B の新しい直し"));
    write_memos(&b, &sa, &mb);
    b.cycle(2_500_000).unwrap();
    // A がやっとつながる。A の古い直しが、いったんサーバーの行を上書きする
    a.remote.set_offline(false);
    a.cycle(3_000_000).unwrap();
    // B と A が、くり返し同期すると、新しい B の直しに落ち着く
    settle(&mut a, &mut b, 4_000_000);
    for dev in [&a, &b] {
        assert_eq!(
            read_memos(dev, &sa).marks["1"].reason,
            "B の新しい直し",
            "{}",
            dev.name
        );
    }
    let _ = server;
}

#[test]
fn d4_a_mass_deletion_is_stopped_on_both_sides_until_it_is_allowed() {
    let server = MemServer::new();
    let mut a = Dev::new("d-aaaa", &server);
    let mut b = Dev::new("d-bbbb", &server);
    // 答えを 60 件作って同期する
    {
        let mut db = a.ports.study();
        for i in 0..60 {
            db.record_answer(answer(
                "20261009-190953",
                &format!("k{i}h0e1"),
                AnswerMode::Quiz,
                T0 + i,
            ))
            .unwrap();
        }
    }
    a.cycle(1_000_000).unwrap();
    b.cycle(1_100_000).unwrap();
    // A の記録が、ほとんど無くなった（保存先を空にした、など）
    a.ports
        .study()
        .replace_all(&[], &[], &[], || Ok::<(), String>(()))
        .unwrap();
    let error = a.cycle(2_000_000).unwrap_err();
    assert!(
        matches!(
            error,
            SyncError::MassDelete {
                side: MassDeleteSide::Local,
                count: 60,
                ..
            }
        ),
        "{error:?}"
    );
    // 同期用の DB は、そのまま（消した印は、書かれていない）
    assert!(!server.keys().iter().any(|k| server.is_tombstone(k)));
    b.cycle(2_100_000).unwrap();
    assert_eq!(logical(&b).answers.len(), 60);
    // 許すと、1 回だけ通る
    a.run(3_000_000, true, true).unwrap();
    let report_b = b.run(3_100_000, true, false);
    // B は、ほかの端末が 60 件を消したので、止まる
    assert!(
        matches!(
            report_b,
            Err(SyncError::MassDelete {
                side: MassDeleteSide::Remote,
                ..
            })
        ),
        "{report_b:?}"
    );
    b.run(3_200_000, true, true).unwrap();
    assert_eq!(logical(&b).answers.len(), 0);
}

// ---- 設定 ----

#[test]
fn d4_a_new_device_takes_the_existing_settings_and_never_overwrites_them_with_its_defaults() {
    let server = MemServer::new();
    let mut a = Dev::new("d-aaaa", &server);
    let mut b = Dev::new("d-bbbb", &server);
    populate(&a);
    a.cycle(1_000_000).unwrap();
    // B は、設定のファイルが新しい（インストール直後に書かれた）が、既定値のまま
    *b.ports.settings_hint.lock().unwrap() = Some(9_999_999_999);
    b.cycle(1_100_000).unwrap();
    let s = b.ports.settings();
    assert!(!s.sound && s.daily_count == 9 && s.orientation == Orientation::Horizontal);
    assert!(!s.doubt_only, "既定（入）の B が、A の切を上書きしない");
    assert!(matches!(s.trigger, Trigger::Key { .. }));
    // A に、B の既定値が戻ってこない
    a.cycle(1_200_000).unwrap();
    let sa = a.ports.settings();
    assert!(!sa.sound && sa.daily_count == 9 && !sa.doubt_only);
    // 保存先と窓の位置は、同期しない
    assert_eq!(
        sa.widget_position,
        Some(crate::settings::WidgetPosition { x: 12, y: 34 })
    );
    assert_eq!(b.ports.settings().widget_position, None);
    assert_eq!(b.ports.settings().data_dir, b.data());
}

#[test]
fn d4_a_setting_changed_later_on_one_device_reaches_the_other() {
    let (_server, mut a, mut b, _sa, _sb) = pair();
    b.ports.settings.lock().unwrap().daily_count = 12;
    b.cycle(2_000_000).unwrap();
    a.cycle(2_100_000).unwrap();
    assert_eq!(a.ports.settings().daily_count, 12);
    assert_eq!(
        *a.ports.settings_applied.lock().unwrap(),
        1,
        "この変更だけ（A は、最初の設定の出どころ）"
    );
}

// ---- 同期用の DB の作り直し・版 ----

#[test]
fn d4_a_rebuilt_sync_db_is_noticed_and_every_device_reseeds_it_without_loss() {
    let (server, mut a, mut b, sa, _sb) = pair();
    let before = logical(&a);
    // A が、同期用の DB を作り直す（全部消して、新しい名前を付ける）
    a.remote.reset("db-rebuilt", 5_000_000).unwrap();
    a.base.forget_rows();
    a.base.db_id = None;
    a.cycle(5_000_100).unwrap();
    assert_eq!(
        server.store().meta.get("db_id").map(String::as_str),
        Some("db-rebuilt")
    );
    // B は、名前が変わったことに気づいて、前回の記録を捨てて、突き合わせ直す
    let report = b.cycle(5_100_000).unwrap();
    assert!(report.base_reset, "{report:?}");
    settle(&mut a, &mut b, 6_000_000);
    assert_eq!(logical(&a), before);
    assert_eq!(logical(&b), before);
    assert_eq!(read_memos(&b, &sa).marks["1"].reason, "東を残したい");
}

#[test]
fn d4_a_sync_db_made_by_a_newer_version_is_left_alone() {
    let server = MemServer::new();
    server
        .store()
        .meta
        .insert("schema_version".into(), "99".into());
    server.store().meta.insert("db_id".into(), "db-x".into());
    let mut a = Dev::new("d-aaaa", &server);
    populate(&a);
    let error = a.cycle(1_000_000).unwrap_err();
    assert!(
        matches!(error, SyncError::NewerSchema { found: 99, .. }),
        "{error:?}"
    );
    assert!(server.keys().is_empty(), "何も書かない");
}

#[test]
fn d4_syncing_never_touches_local_files_it_does_not_own() {
    let (_server, mut a, mut b, sa, _sb) = pair();
    // 手元だけにある、events.jsonl・ocr.json・スクショは、同期でも書き換わらない
    let dir = session_dir(&a, &sa);
    let snapshot = |d: &PathBuf| -> BTreeMap<String, Vec<u8>> {
        let mut out = BTreeMap::new();
        for name in [EVENTS_FILE, OCR_FILE] {
            out.insert(name.to_string(), fs::read(d.join(name)).unwrap());
        }
        for entry in fs::read_dir(d.join("marks")).unwrap().flatten() {
            out.insert(
                format!("marks/{}", entry.file_name().to_string_lossy()),
                fs::read(entry.path()).unwrap(),
            );
        }
        out
    };
    let before = snapshot(&dir);
    let mut ma = read_memos(&b, &sa);
    ma.marks.insert("2".into(), memo("白", "B から"));
    write_memos(&b, &sa, &ma);
    b.reconcile(2_000_000).unwrap();
    settle(&mut a, &mut b, 3_000_000);
    assert_eq!(snapshot(&dir), before);
}

#[test]
fn d4_an_unchanged_local_snapshot_is_cheap_the_reports_are_not_read_again() {
    // 大きさと更新時刻が前回と同じなら、結果のファイルの中身を読み直さない（指紋を使い回す）
    let (_server, mut a, _b, sa, _sb) = pair();
    let key = make_key(Kind::Report, &[&sa]);
    let fp = a.base.entries[&key].fp.clone().expect("目印が残っている");
    let fingerprints: BTreeMap<String, String> = [(key.clone(), fp.clone())].into_iter().collect();
    // 偽の指紋（SHA の部分だけ違う）を渡して、使い回されることを見る（読み直したら、本物の指紋になる）
    let prefix = fp.rsplit_once(':').unwrap().0;
    let fake = format!("{prefix}:{}", "0".repeat(64));
    let fake_map: BTreeMap<String, String> = [(key.clone(), fake.clone())].into_iter().collect();
    let reused = a.local.snapshot(&fake_map).unwrap();
    assert_eq!(reused.fingerprints[&key], fake, "前回の目印をそのまま使う");
    let fresh = a.local.snapshot(&BTreeMap::new()).unwrap();
    assert_eq!(fresh.fingerprints[&key], fp, "目印が無ければ、読んで求める");
    let _ = fingerprints;
    assert_eq!(a.base.entries[&key].state, BaseState::Present);
}

/// 手動の目安（`cargo test --lib perf_ -- --ignored --nocapture`）: 1 年ぶん（答え 7300・半荘 300・結果のファイル 200 KB ずつ）の
/// 1 回分の時間。偽物の同期用の DB なので、手元の読み書き・突き合わせ・圧縮の時間だけ（通信は含まない）。
#[test]
#[ignore = "時間の目安を見るだけの手動の試験"]
fn perf_a_year_of_records_seeds_and_then_stays_cheap() {
    use std::time::Instant;
    let server = MemServer::new();
    let mut a = Dev::new("d-aaaa", &server);
    let mut b = Dev::new("d-bbbb", &server);
    let store_dir = a.data().join("games");
    let big = format!(
        "{{\"review\":{{\"kyokus\":[{}]}}}}",
        (0..2500)
            .map(|i| format!("{{\"i\":{i},\"tile\":\"5p\",\"prob\":0.12{}}}", i % 97))
            .collect::<Vec<_>>()
            .join(",")
    );
    for n in 0..300 {
        let id = format!("2026{:02}{:02}-{:02}0000", 1 + n / 28, 1 + n % 28, n % 24);
        let dir = store_dir.join(&id);
        fs::create_dir_all(&dir).unwrap();
        fs::write(dir.join(REPORT_FILE), &big).unwrap();
        fs::write(
            dir.join(MEMOS_FILE),
            serde_json::to_string(
                &json!({"marks": {"1": {"candidates": "3m", "reason": "理由"}}, "extras": []}),
            )
            .unwrap(),
        )
        .unwrap();
    }
    {
        let mut db = a.ports.study();
        for i in 0..7300 {
            db.record_answer(answer(
                "20260101-000000",
                &format!("k{}h0e{}", i % 80, i / 80),
                AnswerMode::Quiz,
                T0 + i,
            ))
            .unwrap();
        }
    }
    let t = Instant::now();
    let seed = a.cycle(1_000_000).unwrap();
    eprintln!("A: 最初の同期 {:?} {seed:?}", t.elapsed());
    let t = Instant::now();
    let join = b.cycle(2_000_000).unwrap();
    eprintln!(
        "B: 新しい端末の取り込み {:?} (local_puts {})",
        t.elapsed(),
        join.local_puts
    );
    let t = Instant::now();
    let quiet = a.cycle(3_000_000).unwrap();
    eprintln!("A: 何も変わらない回 {:?} {quiet:?}", t.elapsed());
    let t = Instant::now();
    b.cycle(4_000_000).unwrap();
    eprintln!("B: 何も変わらない回 {:?}", t.elapsed());
    let marker = Instant::now();
    let _ = super::local::change_marker(a.data(), std::path::Path::new("none"));
    eprintln!("手元の目印 {:?}", marker.elapsed());
}
