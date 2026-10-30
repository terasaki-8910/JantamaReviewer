//! 牌譜を頭から再生して、読みを出す「場面」（moment）を集める。
//!
//! 場面は、見ている席（`player_id`）が決めるところ:
//! - 自分のツモの直後（嶺上牌を含む）。
//! - 自分のチー・ポンの直後（打牌が要るとき。ツモは無い）。
//!
//! 場面ごとに、そのときの `PlayerState` の写し（観測の組み立てに使う）、手牌の種類、他家のリーチと実際の待ちを持つ。
//! 事象は、見ている席の `PlayerState` に、牌譜の順に 1 つずつ渡す。libriichi が断る牌譜は、ここでエラーになる。

use anyhow::{Context, Result};
use riichi::mjai::Event;
use riichi::state::PlayerState;
use riichi::tile::Tile;

use crate::report::Report;
use crate::waits::HandTracker;

/// 読みを出す 1 つの場面。
#[derive(Clone)]
pub struct Moment {
    /// 場面の事象（ツモ・チー・ポン）の、`mjai_log` での番号。
    pub event_index: usize,
    /// 何局目か（0 から。`start_kyoku` の数）。
    pub kyoku_index: usize,
    /// この局の `start_kyoku` の、`mjai_log` での番号。
    pub kyoku_start: usize,
    /// 場風（`E` など）。
    pub bakaze: Tile,
    /// 局（mjai の数え方で 1 から）。
    pub kyoku: u8,
    /// 本場。
    pub honba: u8,
    /// この局の、自分のツモの回数（この場面のツモを含む。チー・ポンの場面では増えない）。
    pub junme: usize,
    /// 場面の事象を反映した直後の状態。
    pub state: PlayerState,
    /// 自分の手牌（鳴いていない牌）の種類の番号。小さい順で、重ならない。
    pub hand: Vec<usize>,
    /// 他家（下家・対面・上家の順）が、リーチを受け付けられているか。
    pub riichi: [bool; 3],
    /// 他家（下家・対面・上家の順）の、実際の待ち（種類の番号）。
    pub actual_waits: [Vec<usize>; 3],
}

/// 他家の席。`step` は 1（下家）・2（対面）・3（上家）。
pub fn opponent_seat(player: u8, step: usize) -> u8 {
    ((usize::from(player) + step) % 4) as u8
}

/// 牌譜から場面を集める。牌譜を libriichi が断ったら、どの事象かを添えたエラーにする。
pub fn collect_moments(report: &Report) -> Result<Vec<Moment>> {
    let player = report.player_id;
    let mut state = PlayerState::new(player);
    let mut tracker = HandTracker::new();
    let mut moments = Vec::new();

    let mut kyoku_count = 0usize;
    let mut kyoku_start = 0usize;
    let mut round = (Tile::default(), 0u8, 0u8);
    let mut draws = 0usize;
    let mut riichi_seats = [false; 4];

    for (index, event) in report.events.iter().enumerate() {
        let cans = state
            .update(event)
            .with_context(|| format!("牌譜の mjai_log[{index}] を処理できません"))?;
        tracker.apply(event);

        match *event {
            Event::StartKyoku {
                bakaze,
                kyoku,
                honba,
                ..
            } => {
                kyoku_count += 1;
                kyoku_start = index;
                round = (bakaze, kyoku, honba);
                draws = 0;
                riichi_seats = [false; 4];
            }
            Event::ReachAccepted { actor } => riichi_seats[usize::from(actor)] = true,
            _ => {}
        }

        let is_moment = match *event {
            Event::Tsumo { actor, .. } if actor == player => {
                draws += 1;
                true
            }
            Event::Chi { actor, .. } | Event::Pon { actor, .. } => {
                actor == player && cans.can_discard
            }
            _ => false,
        };
        if !is_moment {
            continue;
        }

        let hand = state
            .tehai()
            .iter()
            .enumerate()
            .filter(|(_, &count)| count > 0)
            .map(|(kind, _)| kind)
            .collect();
        let mut riichi = [false; 3];
        let mut actual_waits: [Vec<usize>; 3] = Default::default();
        for step in 1..=3 {
            let seat = usize::from(opponent_seat(player, step));
            riichi[step - 1] = riichi_seats[seat];
            actual_waits[step - 1] = tracker.waits(seat);
        }
        moments.push(Moment {
            event_index: index,
            kyoku_index: kyoku_count.saturating_sub(1),
            kyoku_start,
            bakaze: round.0,
            kyoku: round.1,
            honba: round.2,
            junme: draws,
            state: state.clone(),
            hand,
            riichi,
            actual_waits,
        });
    }
    Ok(moments)
}
