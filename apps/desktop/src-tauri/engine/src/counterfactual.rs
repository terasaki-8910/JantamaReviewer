//! 効いた捨て牌（F23、E-54）: 他家の捨て牌を 1 枚ずつ別の牌に替えて、読みを取り直すための準備。
//!
//! 替える相手の牌（filler）と、替える捨て牌の一覧（plan）を決め、替えた牌譜で状態を作り直す。
//! 決め方は固定データの作り方（`tests/fixtures/fx-e/tools/make_fixture.py`）と同じ:
//! - filler は、見えている枚数のいちばん少ない字牌。同じ枚数なら E S W N P F C の順で先のもの。
//!   見えている枚数は、見ている席の配牌と、局の最初から場面までの事象に出る牌（`pai`・`consumed`・`dora_marker`）を
//!   1 枚ずつ数える（他家のツモは見えないので数えない）。鳴いた牌は、捨て牌と副露の両方で数える大まかな数え方のまま。
//! - 替える捨て牌は、その他家の、この局の場面までの打牌。ただし、次の事象がチー・ポン・大明槓（鳴かれた捨て牌）の
//!   ものと、filler と同じ牌のものは替えない。`turn` は、その他家の打牌の数（鳴かれたものも数え、1 から）。
//! - 替えるのは `pai` だけ（`tsumogiri` はそのまま）。局の最初から場面まで、見ている席の状態を作り直す。

use anyhow::{bail, Result};
use riichi::mjai::Event;
use riichi::state::PlayerState;
use riichi::tile::Tile;

use crate::tiles::{kind_of, kind_tile, HONOR_START, KINDS};

/// 替える捨て牌 1 つ。
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct Swap {
    /// その他家の、この局の何枚目の打牌か（1 から）。
    pub turn: usize,
    /// 打牌の事象の、`mjai_log` での番号。
    pub event_index: usize,
    /// 元の牌（赤牌の印も残す）。
    pub pai: Tile,
}

/// 1 つの場面・1 人の他家についての、読み直しの計画。
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct Plan {
    /// 捨て牌と取り替える字牌。
    pub filler: Tile,
    /// 替える捨て牌（局の中の順）。
    pub swaps: Vec<Swap>,
}

/// 場面の事象より前で、いちばん近い `start_kyoku` の番号。
pub fn kyoku_start(events: &[Event], stop: usize) -> Option<usize> {
    (0..=stop)
        .rev()
        .find(|&index| matches!(events[index], Event::StartKyoku { .. }))
}

/// 見えている牌を種類ごとに数える（`start` の `start_kyoku` から `stop` まで）。数え方は、上の説明のとおり。
pub fn count_visible(events: &[Event], player: u8, start: usize, stop: usize) -> [usize; KINDS] {
    let mut visible = [0usize; KINDS];
    let mut count = |tile: Tile| {
        if let Some(kind) = kind_of(tile) {
            visible[kind] += 1;
        }
    };
    if let Event::StartKyoku { tehais, .. } = &events[start] {
        for &tile in &tehais[usize::from(player)] {
            count(tile);
        }
    }
    for event in &events[start..=stop] {
        match event {
            Event::StartKyoku { dora_marker, .. } | Event::Dora { dora_marker } => {
                count(*dora_marker);
            }
            // 他家のツモは見えない。
            Event::Tsumo { actor, pai } if actor == &player => count(*pai),
            Event::Dahai { pai, .. } => count(*pai),
            Event::Chi { pai, consumed, .. } | Event::Pon { pai, consumed, .. } => {
                count(*pai);
                consumed.iter().for_each(|&tile| count(tile));
            }
            Event::Daiminkan { pai, consumed, .. } | Event::Kakan { pai, consumed, .. } => {
                count(*pai);
                consumed.iter().for_each(|&tile| count(tile));
            }
            Event::Ankan { consumed, .. } => consumed.iter().for_each(|&tile| count(tile)),
            _ => {}
        }
    }
    visible
}

/// 見えている枚数のいちばん少ない字牌（同じ枚数なら E S W N P F C の順で先）。
pub fn choose_filler(visible: &[usize; KINDS]) -> Tile {
    let kind = (HONOR_START..KINDS)
        .min_by_key(|&kind| (visible[kind], kind))
        .expect("字牌は 7 種ある");
    kind_tile(kind)
}

/// 読み直しの計画を作る。`stop` は場面の事象の番号、`target` は読み直す他家の席。
pub fn plan(events: &[Event], player: u8, start: usize, stop: usize, target: u8) -> Plan {
    let filler = choose_filler(&count_visible(events, player, start, stop));
    let mut swaps = Vec::new();
    let mut turn = 0;
    for (index, event) in events.iter().enumerate().take(stop + 1).skip(start) {
        let Event::Dahai { actor, pai, .. } = *event else {
            continue;
        };
        if actor != target {
            continue;
        }
        turn += 1;
        let called = matches!(
            events.get(index + 1),
            Some(Event::Chi { .. } | Event::Pon { .. } | Event::Daiminkan { .. })
        );
        if called || pai == filler {
            continue;
        }
        swaps.push(Swap {
            turn,
            event_index: index,
            pai,
        });
    }
    Plan { filler, swaps }
}

/// 打牌 1 つを `filler` に替えた牌譜で、局の最初から場面（`stop`）までを再生した状態を作る。
pub fn swapped_state(
    events: &[Event],
    player: u8,
    start: usize,
    stop: usize,
    swap: &Swap,
    filler: Tile,
) -> Result<PlayerState> {
    let mut state = PlayerState::new(player);
    for (index, event) in events.iter().enumerate().take(stop + 1).skip(start) {
        if index == swap.event_index {
            let Event::Dahai {
                actor, tsumogiri, ..
            } = *event
            else {
                bail!("mjai_log[{index}] は打牌ではありません");
            };
            state.update(&Event::Dahai {
                actor,
                pai: filler,
                tsumogiri,
            })?;
        } else {
            state.update(event)?;
        }
    }
    Ok(state)
}

#[cfg(test)]
mod tests {
    use super::*;

    fn t(name: &str) -> Tile {
        name.parse().unwrap()
    }

    #[test]
    fn filler_is_the_least_visible_honor_with_ties_in_east_first_order() {
        let mut visible = [0usize; KINDS];
        assert_eq!(choose_filler(&visible), t("E"));
        visible[27] = 1; // E
        visible[28] = 1; // S
        assert_eq!(choose_filler(&visible), t("W"));
        visible[29..34].fill(2);
        visible[31] = 1; // P
        assert_eq!(
            choose_filler(&visible),
            t("E"),
            "E と S と P が 1 枚で、E が先"
        );
        visible[27] = 3;
        assert_eq!(choose_filler(&visible), t("S"));
    }
}
