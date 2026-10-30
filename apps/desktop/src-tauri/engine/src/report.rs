//! 入力の report.json を読む。
//!
//! 使うのは `mjai_log`（mjai の事象の配列）と `player_id`（見る席）だけ。ほかの欄（review など）は読み飛ばす。
//! 事象の読み方は libriichi の `Event`（serde）そのもの。`meta` などの知らない欄は無視される。

use std::path::Path;

use anyhow::{anyhow, bail, Context, Result};
use riichi::mjai::Event;
use serde::Deserialize;

/// 読み終えた入力。
#[derive(Debug, Clone)]
pub struct Report {
    /// 牌譜の事象（`mjai_log` の順）。
    pub events: Vec<Event>,
    /// 見る席（0..=3）。
    pub player_id: u8,
}

#[derive(Deserialize)]
struct RawReport {
    mjai_log: Option<Vec<serde_json::Value>>,
    player_id: Option<serde_json::Value>,
}

/// ファイルから読む。`player_override` は `--player`（あれば、`player_id` より優先する）。
pub fn load_report(path: &Path, player_override: Option<u8>) -> Result<Report> {
    let bytes = std::fs::read(path)
        .with_context(|| format!("牌譜のファイルを読めません: {}", path.display()))?;
    let text = std::str::from_utf8(&bytes)
        .map_err(|_| anyhow!("牌譜のファイルが UTF-8 ではありません: {}", path.display()))?;
    parse_report(text, player_override)
        .with_context(|| format!("牌譜のファイルを処理できません: {}", path.display()))
}

/// JSON の文字列から読む。
pub fn parse_report(text: &str, player_override: Option<u8>) -> Result<Report> {
    let raw: RawReport =
        serde_json::from_str(text).map_err(|e| anyhow!("JSON として読めません（{e}）"))?;
    let values = raw
        .mjai_log
        .ok_or_else(|| anyhow!("mjai_log がありません"))?;

    let player_id = match (player_override, raw.player_id) {
        (Some(player), _) => player,
        (None, Some(value)) => value
            .as_u64()
            .filter(|player| *player < 4)
            .map(|player| player as u8)
            .ok_or_else(|| anyhow!("player_id は 0 から 3 の数のはずです: {value}"))?,
        (None, None) => bail!("player_id がありません（--player で指定できます）"),
    };

    let mut events = Vec::with_capacity(values.len());
    for (index, value) in values.iter().enumerate() {
        let event = Event::deserialize(value)
            .map_err(|e| anyhow!("mjai_log[{index}] を mjai の事象として読めません（{e}）"))?;
        events.push(event);
    }
    Ok(Report { events, player_id })
}

#[cfg(test)]
mod tests {
    use super::*;

    const START: &str = r#"{"type":"start_game","names":["a","b","c","d"],"seed":[1,2]}"#;

    #[test]
    fn reads_events_and_ignores_unknown_fields() {
        let text = format!(
            r#"{{"player_id":1,"review":{{"x":1}},"mjai_log":[{START},{{"type":"end_game","meta":{{"q":1}}}}]}}"#
        );
        let report = parse_report(&text, None).unwrap();
        assert_eq!(report.player_id, 1);
        assert_eq!(report.events.len(), 2);
    }

    #[test]
    fn player_option_wins_over_player_id() {
        let text = format!(r#"{{"player_id":1,"mjai_log":[{START}]}}"#);
        assert_eq!(parse_report(&text, Some(3)).unwrap().player_id, 3);
    }

    #[test]
    fn rejects_broken_inputs_with_a_reason() {
        let cases = [
            ("[1,2", None, "JSON"),
            (r#"{"player_id":0}"#, None, "mjai_log"),
            (r#"{"mjai_log":[]}"#, None, "player_id"),
            (r#"{"player_id":4,"mjai_log":[]}"#, None, "player_id"),
            (r#"{"player_id":"0","mjai_log":[]}"#, None, "player_id"),
            (
                r#"{"player_id":0,"mjai_log":[{"type":"nope"}]}"#,
                None,
                "mjai_log[0]",
            ),
        ];
        for (text, player, needle) in cases {
            let error = parse_report(text, player).expect_err(text);
            assert!(format!("{error:#}").contains(needle), "{text}: {error:#}");
        }
    }
}
