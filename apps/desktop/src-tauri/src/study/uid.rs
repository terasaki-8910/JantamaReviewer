//! 答え・迷いマークの無い迷いのメモの、端末をまたいで一意の id（`uid`。F15 同期）。
//!
//! - 新しい記録: 作った時刻 + 乱数（`crate::ids::new_uid`）。端末が違えば、重ならない。
//! - 昔の記録（版 3 に上げるときの答え・同期を入れる前に書いたメモ）: 内容から決める（`l` で始まる）。同じ記録を写した 2 つの端末で、
//!   同じ id になるので、同期したとき、重なって 2 つに増えない。答えは、記録の中身（半荘・判断の鍵・種類・時刻）から、
//!   メモは、半荘と呼び名と並びの番号から決める。

use super::NewAnswer;
use crate::ids::sha256_hex;

/// 昔の答えの id。同じ中身の答えが 2 つあるときだけ、`dup`（何番目の重なりか）で区別する。
pub fn legacy_answer_uid(answer: &NewAnswer, dup: usize) -> String {
    let text = format!(
        "{}\n{}\n{}\n{}\n{}\n{}",
        answer.session_id,
        answer.decision_key,
        answer.mode.as_str(),
        answer.shown_at,
        answer.answered_at,
        dup
    );
    format!("l{}", &sha256_hex(text.as_bytes())[..24])
}

/// 昔の迷いマークの無い迷いのメモの id。並びの番号を先に置くので、id の並びが、メモの並び（足した順）になる。
pub fn legacy_extra_uid(session_id: &str, label: &str, index: usize) -> String {
    let text = format!("{session_id}\n{label}");
    format!("l{index:05}-{}", &sha256_hex(text.as_bytes())[..16])
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::study::AnswerMode;
    use serde_json::json;

    fn answer() -> NewAnswer {
        NewAnswer {
            session_id: "20261009-190953".to_string(),
            decision_key: "k2h1e14".to_string(),
            mode: AnswerMode::Quiz,
            shown_at: 1,
            answered_at: 2,
            choice: json!({"type": "dahai", "tile": "1s"}),
            reason: "理由".to_string(),
            duration_ms: 1,
            reselect_count: 0,
            correct: true,
            causes: Vec::new(),
            principle: String::new(),
            maka_move: None,
            interval_days: 1,
            due_date: "2026-10-10".to_string(),
        }
    }

    #[test]
    fn legacy_uids_depend_only_on_the_identity_of_the_record() {
        let a = answer();
        let mut edited = answer();
        edited.principle = "あとから書いた原則".to_string();
        edited.causes = vec!["shape".to_string()];
        assert_eq!(legacy_answer_uid(&a, 0), legacy_answer_uid(&edited, 0));
        assert_ne!(legacy_answer_uid(&a, 0), legacy_answer_uid(&a, 1));
        let mut other = answer();
        other.answered_at = 3;
        assert_ne!(legacy_answer_uid(&a, 0), legacy_answer_uid(&other, 0));
    }

    #[test]
    fn legacy_extra_uids_follow_the_order_of_the_memos() {
        let first = legacy_extra_uid("20261009-190953", "x2", 0);
        let second = legacy_extra_uid("20261009-190953", "x1", 1);
        assert!(first < second);
        assert_eq!(first, legacy_extra_uid("20261009-190953", "x2", 0));
    }
}
