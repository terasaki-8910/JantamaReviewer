//! 牌の名前（mjai の書き方）と、34 種の番号の変換。
//!
//! 番号は libriichi と同じ（1m..9m が 0..8、1p..9p が 9..17、1s..9s が 18..26、E S W N P F C が 27..33）。
//! 赤牌は元の種類にそろえる（5mr は 5m）。reads.json の牌は、いつもこの 34 種の名前で書く。

use riichi::tile::Tile;

/// 牌の種類の数。
pub const KINDS: usize = 34;

/// 34 種の名前（番号の順）。
pub const KIND_NAMES: [&str; KINDS] = [
    "1m", "2m", "3m", "4m", "5m", "6m", "7m", "8m", "9m", //
    "1p", "2p", "3p", "4p", "5p", "6p", "7p", "8p", "9p", //
    "1s", "2s", "3s", "4s", "5s", "6s", "7s", "8s", "9s", //
    "E", "S", "W", "N", "P", "F", "C",
];

/// 字牌の最初の番号（E）。字牌は 27..=33。
pub const HONOR_START: usize = 27;

/// 牌の 34 種の番号。赤牌は元の種類にそろえる。`?`（見えない牌）は `None`。
pub fn kind_of(tile: Tile) -> Option<usize> {
    let kind = tile.deaka().as_usize();
    (kind < KINDS).then_some(kind)
}

/// 34 種の番号から、牌の名前を引く。
pub fn kind_name(kind: usize) -> &'static str {
    KIND_NAMES[kind]
}

/// 34 種の番号から、牌（赤でない）を作る。
pub fn kind_tile(kind: usize) -> Tile {
    Tile::try_from(kind).expect("34 種の番号は牌になる")
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn names_match_libriichi_display() {
        for (kind, name) in KIND_NAMES.iter().enumerate() {
            assert_eq!(kind_tile(kind).to_string(), *name);
            assert_eq!(kind_of(kind_tile(kind)), Some(kind));
        }
    }

    #[test]
    fn red_fives_map_to_plain_kinds_and_unknown_to_none() {
        let red: Tile = "5pr".parse().unwrap();
        assert_eq!(kind_of(red), Some(13));
        assert_eq!(kind_name(13), "5p");
        let unknown: Tile = "?".parse().unwrap();
        assert_eq!(kind_of(unknown), None);
    }
}
