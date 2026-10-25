//! 同期の行（F15、D-4）: 記録を、鍵と値の行に分ける決まり。
//!
//! 手元の記録（`study.sqlite` と、半荘のフォルダの JSON）を、1 件ずつの行にして、同期用の DB に置く。行は `key`（文字）と
//! `value`（JSON の文字。同じ中身なら、いつも同じ文字になるよう、鍵の順をそろえて書く）。1 つの JSON のファイル（メモ・結びつけなど）は、
//! 項目ごとに別の行にするので、2 台で別々の項目を直しても、両方が残る。
//!
//! 鍵の形（`:` で区切る。半荘の名前・番号・局の鍵・uid・日付は、`:` を含まない）:
//!
//! | 鍵 | 中身 |
//! |---|---|
//! | `a:<uid>` | 答え 1 件（解き直しの予定は、答えの間隔と期限） |
//! | `d:<日付>` | その日の今日の出題の組（問題の並び） |
//! | `w:<週の月曜>` | 週の成績と重点 |
//! | `s:<名前>` | 設定の 1 項目（保存先と窓の位置は入れない） |
//! | `lm:<半荘>:<迷いマークの番号>` | 迷いマークの結びつけ（判断の鍵、または `manual`） |
//! | `lr:<半荘>:<評価の番号>` | 評価の結びつけ（局の鍵。空は「どの局にも結びつけない」） |
//! | `lv:<半荘>` | 評価の結びつけの当てはめ方の版 |
//! | `sr:<半荘>:<局の鍵>` | 局の自己評価の付け直し |
//! | `mk:<半荘>:<局の鍵>` | 局の MAKA の評価 |
//! | `mh:<半荘>` | 半荘全体の MAKA の評価 |
//! | `rv:<半荘>:<判断の鍵>` | 局面の解決（解決を入れた時刻。F16） |
//! | `na:<半荘>` | 半荘の NAGA の結果の URL（URL と保存した時刻。F22 段 2） |
//! | `mm:<半荘>:<迷いマークの番号>` | 迷いマークのメモ（候補・理由） |
//! | `xm:<半荘>:<uid>` | 迷いマークの無い迷いのメモ |
//! | `r:<半荘>` | 結果のファイル（report.json）。中身は、圧縮して別の表に置く |
//!
//! 足し算の値（`n = n + 1`）は持たない。答えの回数なども、答えの行を数えて出す。

use serde::{Deserialize, Serialize};
use serde_json::Value;

use crate::store::{ExtraMemo, MemoPosition};

/// 行の種類。
#[derive(Debug, Clone, Copy, PartialEq, Eq, PartialOrd, Ord, Hash)]
pub enum Kind {
    Answer,
    Daily,
    Week,
    Setting,
    MarkLink,
    RatingLink,
    RatingsVersion,
    SelfRating,
    MakaKyoku,
    MakaHanchan,
    Resolved,
    Naga,
    MarkMemo,
    ExtraMemo,
    Report,
}

impl Kind {
    fn prefix(self) -> &'static str {
        match self {
            Kind::Answer => "a",
            Kind::Daily => "d",
            Kind::Week => "w",
            Kind::Setting => "s",
            Kind::MarkLink => "lm",
            Kind::RatingLink => "lr",
            Kind::RatingsVersion => "lv",
            Kind::SelfRating => "sr",
            Kind::MakaKyoku => "mk",
            Kind::MakaHanchan => "mh",
            Kind::Resolved => "rv",
            Kind::Naga => "na",
            Kind::MarkMemo => "mm",
            Kind::ExtraMemo => "xm",
            Kind::Report => "r",
        }
    }

    fn from_prefix(prefix: &str) -> Option<Kind> {
        Some(match prefix {
            "a" => Kind::Answer,
            "d" => Kind::Daily,
            "w" => Kind::Week,
            "s" => Kind::Setting,
            "lm" => Kind::MarkLink,
            "lr" => Kind::RatingLink,
            "lv" => Kind::RatingsVersion,
            "sr" => Kind::SelfRating,
            "mk" => Kind::MakaKyoku,
            "mh" => Kind::MakaHanchan,
            "rv" => Kind::Resolved,
            "na" => Kind::Naga,
            "mm" => Kind::MarkMemo,
            "xm" => Kind::ExtraMemo,
            "r" => Kind::Report,
            _ => return None,
        })
    }

    /// 半荘ごとの記録か（鍵の 2 つ目が半荘の名前）。
    pub fn is_per_session(self) -> bool {
        matches!(
            self,
            Kind::MarkLink
                | Kind::RatingLink
                | Kind::RatingsVersion
                | Kind::SelfRating
                | Kind::MakaKyoku
                | Kind::MakaHanchan
                | Kind::Resolved
                | Kind::Naga
                | Kind::MarkMemo
                | Kind::ExtraMemo
                | Kind::Report
        )
    }
}

/// 鍵を組み立てる。部品に `:` を含むものは、行にしない（呼ぶ側が、形を確かめたものだけを渡す）。
pub fn make_key(kind: Kind, parts: &[&str]) -> String {
    let mut key = kind.prefix().to_string();
    for part in parts {
        key.push(':');
        key.push_str(part);
    }
    key
}

/// 読んだ鍵: 種類・半荘の名前（半荘ごとの記録のとき）・残りの部品。
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct ParsedKey<'a> {
    pub kind: Kind,
    pub session: Option<&'a str>,
    /// 半荘の名前の次の部品（無ければ空）。
    pub rest: &'a str,
}

/// 鍵を読む。知らない種類・部品の数が合わない鍵は `None`（新しい版のアプリが足した種類は、読み飛ばす）。
pub fn parse_key(key: &str) -> Option<ParsedKey<'_>> {
    let (prefix, tail) = key.split_once(':')?;
    let kind = Kind::from_prefix(prefix)?;
    if tail.is_empty() {
        return None;
    }
    if kind.is_per_session() {
        let (session, rest) = match tail.split_once(':') {
            Some((session, rest)) => (session, rest),
            None => (tail, ""),
        };
        let needs_rest = !matches!(
            kind,
            Kind::RatingsVersion | Kind::MakaHanchan | Kind::Naga | Kind::Report
        );
        if session.is_empty()
            || (needs_rest && rest.is_empty())
            || (!needs_rest && !rest.is_empty())
        {
            return None;
        }
        Some(ParsedKey {
            kind,
            session: Some(session),
            rest,
        })
    } else {
        Some(ParsedKey {
            kind,
            session: None,
            rest: tail,
        })
    }
}

/// 鍵の半荘の名前（半荘ごとの記録でなければ `None`）。
pub fn session_of(key: &str) -> Option<&str> {
    parse_key(key).and_then(|parsed| parsed.session)
}

/// 鍵の種類。
pub fn kind_of(key: &str) -> Option<Kind> {
    parse_key(key).map(|parsed| parsed.kind)
}

/// 値を、決まった書き方の文字にする（鍵の順をそろえる。同じ中身なら、いつも同じ文字）。
pub fn canon<T: Serialize>(value: &T) -> String {
    match serde_json::to_value(value) {
        // `Value` の中の対応表は、鍵の順に並ぶ
        Ok(value) => value.to_string(),
        Err(_) => "null".to_string(),
    }
}

/// 値の文字を読み直して、書き方をそろえる（別の端末・別の版が書いた文字でも、同じ中身なら同じ文字になる）。
pub fn recanon(text: &str) -> Option<String> {
    serde_json::from_str::<Value>(text)
        .ok()
        .map(|value| value.to_string())
}

/// 迷いマークの無い迷いのメモの値（呼び名 `id` は端末ごとの名前なので、行には入れない。半荘の中の並びは、uid の並びで決める）。
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct ExtraValue {
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub decision: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub position: Option<MemoPosition>,
    #[serde(default)]
    pub candidates: String,
    #[serde(default)]
    pub reason: String,
}

impl ExtraValue {
    pub fn of(extra: &ExtraMemo) -> ExtraValue {
        ExtraValue {
            decision: extra.decision.clone(),
            position: extra.position,
            candidates: extra.candidates.clone(),
            reason: extra.reason.clone(),
        }
    }
}

/// 結果のファイルの行の値。本体は、圧縮して別の表（`sync_blobs`）に置く。
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct ReportMeta {
    /// 圧縮する前の大きさ（バイト）。
    pub bytes: u64,
    /// 圧縮する前の SHA-256（小文字の 16 進数）。取り出したあと、これと合うか確かめる。
    pub sha256: String,
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn keys_round_trip_through_make_and_parse() {
        let cases: Vec<(String, Kind, Option<&str>, &str)> = vec![
            (
                make_key(Kind::Answer, &["n019f-0123"]),
                Kind::Answer,
                None,
                "n019f-0123",
            ),
            (
                make_key(Kind::Daily, &["2026-10-12"]),
                Kind::Daily,
                None,
                "2026-10-12",
            ),
            (
                make_key(Kind::Setting, &["sound"]),
                Kind::Setting,
                None,
                "sound",
            ),
            (
                make_key(Kind::MarkMemo, &["20261009-190953", "3"]),
                Kind::MarkMemo,
                Some("20261009-190953"),
                "3",
            ),
            (
                make_key(Kind::SelfRating, &["20261009-190953", "k0h0"]),
                Kind::SelfRating,
                Some("20261009-190953"),
                "k0h0",
            ),
            (
                make_key(Kind::Report, &["20261009-190953"]),
                Kind::Report,
                Some("20261009-190953"),
                "",
            ),
            (
                make_key(Kind::MakaHanchan, &["20261009-190953"]),
                Kind::MakaHanchan,
                Some("20261009-190953"),
                "",
            ),
            (
                make_key(Kind::Resolved, &["20261009-190953", "k2h1e14"]),
                Kind::Resolved,
                Some("20261009-190953"),
                "k2h1e14",
            ),
            (
                make_key(Kind::Naga, &["20261009-190953"]),
                Kind::Naga,
                Some("20261009-190953"),
                "",
            ),
        ];
        for (key, kind, session, rest) in cases {
            let parsed = parse_key(&key).unwrap_or_else(|| panic!("{key}"));
            assert_eq!(parsed.kind, kind, "{key}");
            assert_eq!(parsed.session, session, "{key}");
            assert_eq!(parsed.rest, rest, "{key}");
            assert_eq!(session_of(&key), session);
        }
    }

    #[test]
    fn malformed_or_unknown_keys_are_not_read() {
        for key in [
            "",
            "a",
            "a:",
            "zz:1",
            "mm:onlysession",
            "mm::3",
            "r:S:extra",
            "lv:S:extra",
            "mh:S:extra",
            "rv:S",
            "rv:S:",
            "na:S:extra",
            "na:",
            "lm:S:",
        ] {
            assert_eq!(parse_key(key), None, "{key}");
        }
    }

    #[test]
    fn canonical_text_ignores_the_order_of_keys() {
        let a = recanon(r#"{"b":1,"a":{"y":2,"x":1}}"#).unwrap();
        let b = recanon(r#"{"a":{"x":1,"y":2},"b":1}"#).unwrap();
        assert_eq!(a, b);
        assert_eq!(recanon("not json"), None);
        assert_eq!(canon(&"good"), "\"good\"");
    }

    #[test]
    fn the_extra_value_leaves_out_the_local_name_and_empty_places() {
        let extra = ExtraMemo {
            id: "x3".into(),
            uid: Some("n1".into()),
            decision: None,
            position: Some(MemoPosition {
                kyoku: 1,
                honba: 0,
                junme: 5,
            }),
            candidates: "3m".into(),
            reason: String::new(),
        };
        let text = canon(&ExtraValue::of(&extra));
        assert!(!text.contains("x3") && !text.contains("n1"), "{text}");
        assert!(!text.contains("decision"));
        assert!(text.contains("\"position\""));
    }
}
