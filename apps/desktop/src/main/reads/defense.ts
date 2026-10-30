/**
 * 吹き出しの「守備の目安」（読み F23。答え合わせのタブ「守備」と同じ分類）。
 * 他家 1 人 × 手牌の牌 1 種類の分類（現物・字牌・壁・スジ・無スジ）は、エンジンの `classifyAgainst` が決める。
 * ここは、見せている盤面から、リーチした他家ごとの入力（河・リーチ後に通った牌・見えていない枚数）を組み立てて渡すだけ。
 * 分類は、リーチした他家に対してだけ定義されている（`dangerBoxOf` と同じ。副露した他家には牌ごとの分類を出さない）。
 */
import {
  TILE_KIND_COUNT,
  classifyAgainst,
  countTiles,
  seatRelation,
  tileKind,
  visibleTileCounts,
  type BoardState,
  type DangerCell,
  type RiichiOpponent,
  type Seat,
} from '@jantama/engine';

/** 見えていない枚数（種類ごと。自分の手牌・全員の河・副露・ドラ表示牌を除いた残り）。 */
function unseenCounts(board: BoardState): number[] {
  const own = countTiles(board.drawn === null ? [...board.hand] : [...board.hand, board.drawn]);
  const visible = visibleTileCounts(board);
  return Array.from({ length: TILE_KIND_COUNT }, (_, kind) => Math.max(0, 4 - (own[kind] ?? 0) - (visible[kind] ?? 0)));
}

/** リーチを宣言している他家（宣言した順）。 */
export function riichiOpponentSeats(board: BoardState): Seat[] {
  return board.riichiOrder.filter((seat) => seat !== board.playerId && board.riichi[seat] !== 'none');
}

/**
 * 牌の種類 `kind` を切ったときの、リーチした他家ごとの守備の目安。リーチしていない他家は入らない。
 * 盤面は、読みの場面の手牌を持つ盤面（自分のツモ・チー・ポンの直後）を渡す。
 */
export function defenseAgainst(board: BoardState, kind: number): ReadonlyMap<Seat, DangerCell> {
  const me = board.playerId;
  const view = { unseen: unseenCounts(board) };
  const out = new Map<Seat, DangerCell>();
  for (const seat of riichiOpponentSeats(board)) {
    const opponent: RiichiOpponent = {
      kind: 'riichi',
      seat,
      who: seatRelation(me, seat),
      river: new Set((board.rivers[seat] ?? []).map((river) => tileKind(river.tile))),
      passed: new Set((board.passedAfterRiichi[seat] ?? []).map(tileKind)),
    };
    out.set(seat, classifyAgainst(opponent, kind, view));
  }
  return out;
}
