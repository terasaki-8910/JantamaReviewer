//! 牌譜の全員の手牌から数える、実際の待ち（F23 の「読みと実際の待ち」、E-55）。
//!
//! 4 人それぞれの手牌（鳴いていない牌だけ）を、牌譜の事象から追いかける:
//! - 局の最初の配牌で置き、ツモで足し、打牌で引く。
//! - チー・ポン・大明槓・暗槓は、副露に使った牌（`consumed`）を引く。加槓は、足した牌（`pai`）を引く。
//!
//! 手牌の枚数が 3 で割って 1 余るとき、待ちは「足すと和了の形になる牌の種類」。和了の形は、
//! 通常の形（4 面子 1 雀頭。副露のぶんは除く）・七対子（対子 7 組。同じ牌を 2 組とは数えない）・国士無双。
//! フリテン・役の有無・場に見えている枚数は問わない（読みと同じく「待っているか」だけ）。
//! 手牌に同じ牌が 4 枚ある種類は、5 枚目になるので待ちに数えない。

use riichi::mjai::Event;

use crate::tiles::{kind_of, KINDS};

/// 国士無双に要る 13 種（么九牌）。
const TERMINAL_AND_HONOR_KINDS: [usize; 13] = [0, 8, 9, 17, 18, 26, 27, 28, 29, 30, 31, 32, 33];

/// 4 人の手牌（鳴いていない牌）の追跡。
#[derive(Debug, Clone)]
pub struct HandTracker {
    counts: [[u8; KINDS]; 4],
    /// 追えなくなった席（見えない牌 `?` や、手牌に無い牌を引く事象があった）。次の局まで、待ちは空にする。
    lost: [bool; 4],
}

impl Default for HandTracker {
    fn default() -> Self {
        Self::new()
    }
}

impl HandTracker {
    pub fn new() -> Self {
        Self {
            counts: [[0; KINDS]; 4],
            lost: [false; 4],
        }
    }

    /// 事象を 1 つ反映する。
    pub fn apply(&mut self, event: &Event) {
        match *event {
            Event::StartKyoku { tehais, .. } => {
                *self = Self::new();
                for (seat, hand) in tehais.iter().enumerate() {
                    for &tile in hand {
                        self.add(seat, kind_of(tile));
                    }
                }
            }
            Event::Tsumo { actor, pai } => self.add(actor as usize, kind_of(pai)),
            Event::Dahai { actor, pai, .. } | Event::Kakan { actor, pai, .. } => {
                self.remove(actor as usize, kind_of(pai));
            }
            Event::Chi {
                actor, consumed, ..
            }
            | Event::Pon {
                actor, consumed, ..
            } => {
                for tile in consumed {
                    self.remove(actor as usize, kind_of(tile));
                }
            }
            Event::Daiminkan {
                actor, consumed, ..
            } => {
                for tile in consumed {
                    self.remove(actor as usize, kind_of(tile));
                }
            }
            Event::Ankan { actor, consumed } => {
                for tile in consumed {
                    self.remove(actor as usize, kind_of(tile));
                }
            }
            _ => {}
        }
    }

    fn add(&mut self, seat: usize, kind: Option<usize>) {
        match kind {
            Some(kind) => self.counts[seat][kind] += 1,
            None => self.lost[seat] = true,
        }
    }

    fn remove(&mut self, seat: usize, kind: Option<usize>) {
        match kind {
            Some(kind) if self.counts[seat][kind] > 0 => self.counts[seat][kind] -= 1,
            _ => self.lost[seat] = true,
        }
    }

    /// その席の今の手牌（種類ごとの枚数）。追えなくなっていれば `None`。
    pub fn hand(&self, seat: usize) -> Option<&[u8; KINDS]> {
        (!self.lost[seat]).then_some(&self.counts[seat])
    }

    /// その席の実際の待ち（種類の番号。小さい順）。手牌が 3n+1 枚でないとき、追えないときは空。
    pub fn waits(&self, seat: usize) -> Vec<usize> {
        self.hand(seat).map(winning_kinds).unwrap_or_default()
    }
}

/// 手牌（3n+1 枚）に足すと和了の形になる牌の種類を、小さい順に返す。3n+1 枚でなければ空。
pub fn winning_kinds(hand: &[u8; KINDS]) -> Vec<usize> {
    let total: usize = hand.iter().map(|&n| usize::from(n)).sum();
    if total % 3 != 1 {
        return Vec::new();
    }
    let mut counts = *hand;
    let mut waits = Vec::new();
    for kind in 0..KINDS {
        if counts[kind] >= 4 {
            continue;
        }
        counts[kind] += 1;
        if is_complete(&counts) {
            waits.push(kind);
        }
        counts[kind] -= 1;
    }
    waits
}

/// 3n+2 枚の手牌が、和了の形か。
fn is_complete(counts: &[u8; KINDS]) -> bool {
    let total: usize = counts.iter().map(|&n| usize::from(n)).sum();
    if total % 3 != 2 {
        return false;
    }
    if total == 14 {
        // 七対子: 対子がちょうど 7 組（同じ牌 4 枚は 2 組と数えない）。
        if counts.iter().filter(|&&n| n == 2).count() == 7 {
            return true;
        }
        // 国士無双: 么九牌 13 種がそろい、14 枚すべてが么九牌。
        let terminals: usize = TERMINAL_AND_HONOR_KINDS
            .iter()
            .map(|&kind| usize::from(counts[kind]))
            .sum();
        if TERMINAL_AND_HONOR_KINDS
            .iter()
            .all(|&kind| counts[kind] >= 1)
            && terminals == 14
        {
            return true;
        }
    }
    // 通常の形: 雀頭を 1 組取り、残りが面子だけ（副露のぶんは手牌に無い）。
    (0..KINDS).any(|pair| {
        if counts[pair] < 2 {
            return false;
        }
        let mut rest = *counts;
        rest[pair] -= 2;
        only_sets(&mut rest)
    })
}

/// 残りの牌がすべて面子（刻子・順子）に分けられるか。小さい番号の牌から、刻子を優先して取る。
fn only_sets(counts: &mut [u8; KINDS]) -> bool {
    for kind in 0..KINDS {
        while counts[kind] > 0 {
            if counts[kind] >= 3 {
                counts[kind] -= 3;
            } else if kind < 27 && kind % 9 <= 6 && counts[kind + 1] > 0 && counts[kind + 2] > 0 {
                counts[kind] -= 1;
                counts[kind + 1] -= 1;
                counts[kind + 2] -= 1;
            } else {
                return false;
            }
        }
    }
    true
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::tiles::KIND_NAMES;

    fn hand(text: &str) -> [u8; KINDS] {
        // "123m 45p 66z" ではなく mjai の名前をスペースで並べる: "1m 2m E E"
        let mut counts = [0; KINDS];
        for name in text.split_whitespace() {
            let kind = KIND_NAMES.iter().position(|n| *n == name).expect(name);
            counts[kind] += 1;
        }
        counts
    }

    fn names(kinds: &[usize]) -> Vec<&'static str> {
        kinds.iter().map(|&kind| KIND_NAMES[kind]).collect()
    }

    #[test]
    fn two_sided_wait() {
        let waits = winning_kinds(&hand("2m 3m 4m 5p 6p 7p 1s 2s 3s 9s 9s 4p 5p"));
        assert_eq!(names(&waits), ["3p", "6p"]);
    }

    #[test]
    fn single_wait_on_a_pair() {
        let waits = winning_kinds(&hand("1m 2m 3m 4p 5p 6p 7s 8s 9s E E E S"));
        assert_eq!(names(&waits), ["S"]);
    }

    #[test]
    fn seven_pairs_counts_only_distinct_pairs() {
        let waits = winning_kinds(&hand("1m 1m 3m 3m 5p 5p 7p 7p 9s 9s E E S"));
        assert_eq!(names(&waits), ["S"]);
        // 同じ牌 4 枚は 2 組と数えない: 1m が 4 枚だと七対子にならない。
        let four = winning_kinds(&hand("1m 1m 1m 1m 5p 5p 7p 7p 9s 9s E E S"));
        assert!(!names(&four).contains(&"S"));
    }

    #[test]
    fn thirteen_orphans_waits() {
        let waits = winning_kinds(&hand("1m 9m 1p 9p 1s 9s E S W N P F C"));
        assert_eq!(waits.len(), 13);
        let single = winning_kinds(&hand("1m 1m 9m 1p 9p 1s 9s E S W N P F"));
        assert_eq!(names(&single), ["C"]);
    }

    #[test]
    fn a_fourth_copy_in_hand_is_not_a_wait() {
        // 1m を 4 枚持っている 1m 4 枚 + 2m 3m は、1m 待ちを数えない（5 枚目になる）。
        let waits = winning_kinds(&hand("1m 1m 1m 1m 2m 3m 4p 5p 6p 7s 8s 9s E"));
        assert_eq!(names(&waits), ["E"]);
    }

    #[test]
    fn not_three_n_plus_one_gives_nothing() {
        assert!(winning_kinds(&hand("1m 2m 3m 4m 5m 6m 7m 8m 9m 1p 2p 3p 4p 5p")).is_empty());
        assert!(winning_kinds(&hand("1m 2m")).is_empty());
    }

    #[test]
    fn open_hands_with_fewer_tiles_use_the_standard_shape() {
        // 副露が 2 組ある 7 枚の手牌: 2m 3m + 4p 5p 6p + 白 白 の形。
        let waits = winning_kinds(&hand("2m 3m 4p 5p 6p P P"));
        assert_eq!(names(&waits), ["1m", "4m"]);
    }

    #[test]
    fn tracker_follows_draws_discards_and_melds() {
        use riichi::tile::Tile;
        let t = |s: &str| s.parse::<Tile>().unwrap();
        let mut hand13 = [t("1m"); 13];
        for (i, name) in [
            "2m", "3m", "4p", "5p", "6p", "7s", "8s", "9s", "E", "E", "E", "S",
        ]
        .iter()
        .enumerate()
        {
            hand13[i + 1] = t(name);
        }
        let start = Event::StartKyoku {
            bakaze: t("E"),
            dora_marker: t("1p"),
            kyoku: 1,
            honba: 0,
            kyotaku: 0,
            oya: 0,
            scores: [25000; 4],
            tehais: [hand13; 4],
        };
        let mut tracker = HandTracker::new();
        tracker.apply(&start);
        assert_eq!(names(&tracker.waits(0)), ["S"]);

        tracker.apply(&Event::Tsumo {
            actor: 0,
            pai: t("C"),
        });
        assert!(tracker.waits(0).is_empty(), "14 枚のときは待ちが無い");
        tracker.apply(&Event::Dahai {
            actor: 0,
            pai: t("C"),
            tsumogiri: true,
        });
        assert_eq!(names(&tracker.waits(0)), ["S"]);

        // ポン: 手牌の E 2 枚を使い、10 枚になる。
        tracker.apply(&Event::Pon {
            actor: 0,
            target: 1,
            pai: t("E"),
            consumed: [t("E"), t("E")],
        });
        assert_eq!(
            tracker
                .hand(0)
                .unwrap()
                .iter()
                .map(|&n| n as usize)
                .sum::<usize>(),
            11
        );
        // 見えない牌を引いた席は、追えなくなる。
        tracker.apply(&Event::Tsumo {
            actor: 2,
            pai: t("?"),
        });
        assert!(tracker.hand(2).is_none());
        assert!(tracker.waits(2).is_empty());
    }
}
