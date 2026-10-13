/**
 * 他家の手牌（F14、E-40、U-34・U-35。R15-5「答える場面でない手なら、いつでも」）。
 *
 * 牌譜には 4 人全員の手牌が入っているので、ある時点の卓（`tableAt`。他家の手牌を含む）から、他家 3 人の閉じた手牌・副露・リーチの状態と、
 * 聴牌している人の待ち（待ちの形・残り・その人が実際に付けている立直で数えた、ロンの飜・符・点数）を作る。
 * 盤面 `BoardState` には他家の手牌を入れない（答える前の画面に、手牌が残らないように）。これは、答えたあと・答える場面でない手・局の終わりの
 * 画面が、**開いたときにだけ**呼ぶ。
 *
 * 待ちの点は、`waitTableOf`（待ちと打点。wait-value.ts）に、その人の席から見た盤面を渡して数える。数えないもの（裏ドラ・一発・海底など）も同じ。
 * 「残り」だけは、全員の手牌を開いたうえで、場に見えていない枚数（全員の閉じた手牌・河（鳴かれていない牌）・副露・ドラ表示牌を除いた枚数）。
 * 切る前の手（ツモったあと・鳴いたあとの 3n+2 枚）は、待ちが決まらないので、待ちを出さない（`pending`）。
 */
import type { ImportedGame } from './import';
import { type RiichiState, type TableView, tableAt } from './replay';
import type { Fuuro, Seat, Wind } from './report-types';
import { type Tile, TILE_KIND_COUNT, kindToTile, sortTiles, tileKind } from './tiles';
import { meldTiles } from './ukeire-remaining';
import { type WaitLine, type WaitPlan, type WaitShape, waitTableOf } from './wait-value';

/** 聴牌している人の待ち 1 種類。 */
export interface OpenWait {
  kind: number;
  /** 赤でない牌の表記。 */
  tile: Tile;
  /** 全員の手牌を開いたうえで、場に見えていない枚数。 */
  remaining: number;
  /** 待ちの形（解釈が複数あるときは全部）。 */
  shapes: WaitShape[];
  /** その人の河にある牌、または、リーチのあとに通った牌なので、ロンできない（フリテン）。 */
  furiten: boolean;
  /** 点を、立直（リーチを宣言済みの人）で数えたか、ダマで数えたか。 */
  stand: 'riichi' | 'dama';
  /** ロンの役・飜・符・点数（本場・供託を除く）。役が無ければ `none`。 */
  ron: WaitLine;
}

/** 他家 1 人の、開いた手牌。 */
export interface OpenSeat {
  seat: Seat;
  wind: Wind;
  dealer: boolean;
  riichi: RiichiState;
  /** 閉じた手牌（並べ替え済み。ツモ牌は `drawn` に分ける）。 */
  hand: Tile[];
  /** ツモってまだ切っていない牌。 */
  drawn: Tile | null;
  melds: Fuuro[];
  /** 切る前の手（3n+2 枚。ツモったあと・鳴いたあと）。待ちは出さない。 */
  pending: boolean;
  /** 聴牌しているとき、待ち（牌の順）。聴牌していない・切る前の手は空。 */
  waits: OpenWait[];
  /** 待ちの形の 1 語（両面など。3 種類以上の待ちは「多面張」）。聴牌していないときは空。 */
  shape: string;
}

/** 本人から見て、下家・対面・上家の席（卓の並びの順）。 */
export function otherSeats(me: Seat): Seat[] {
  return [1, 2, 3].map((offset) => ((me + offset) % 4) as Seat);
}

/** 全員の手牌を開いたときの、場に見えている枚数（種類ごと。全員の閉じた手牌・河（鳴かれていない牌）・副露・ドラ表示牌）。 */
export function openSeenCounts(table: TableView): number[] {
  const counts = new Array<number>(TILE_KIND_COUNT).fill(0);
  const add = (tile: Tile) => {
    const kind = tileKind(tile);
    counts[kind] = (counts[kind] as number) + 1;
  };
  for (const hand of table.hands) hand.forEach(add);
  for (const river of table.board.rivers) for (const entry of river) if (entry.calledBy === null) add(entry.tile);
  for (const melds of table.board.melds) for (const meld of melds) meldTiles(meld).forEach(add);
  table.board.doraMarkers.forEach(add);
  return counts;
}

/** 手牌から牌を 1 枚抜く（その牌そのもの）。無ければそのまま。 */
function withoutOne(tiles: readonly Tile[], tile: Tile): Tile[] {
  const out = [...tiles];
  const at = out.indexOf(tile);
  if (at >= 0) out.splice(at, 1);
  return out;
}

/**
 * 席 1 人の、開いた手牌。`closed` を渡すと、その閉じた手牌（3n+1 枚）の待ちを調べる（局の結果の手で、和了牌を除いた手の待ちを出すため）。
 * 渡さなければ、卓の手牌（ツモ牌を含む）。
 */
export function openSeatOf(table: TableView, seat: Seat, closed?: readonly Tile[], seen: readonly number[] = openSeenCounts(table)): OpenSeat {
  const { board } = table;
  const melds = [...(board.melds[seat] ?? [])];
  const drawn = closed === undefined ? (table.drawn[seat] ?? null) : null;
  const all = closed === undefined ? [...(table.hands[seat] ?? [])] : [...closed];
  const pending = all.length % 3 === 2;
  const hand = sortTiles(drawn === null ? all : withoutOne(all, drawn));
  const riichi = board.riichi[seat] ?? 'none';
  const base: OpenSeat = {
    seat,
    wind: board.seatWinds[seat] as Wind,
    dealer: board.oya === seat,
    riichi,
    hand,
    drawn,
    melds,
    pending,
    waits: [],
    shape: '',
  };
  if (pending) return base;
  const plan: WaitPlan = { key: `open:${seat}`, tags: [], discard: null, option: null, hand: sortTiles(all), melds, extraSeen: new Array<number>(TILE_KIND_COUNT).fill(0) };
  const waitTable = waitTableOf({ board: { ...board, playerId: seat } }, plan);
  if (waitTable === null) return base;
  const passed = new Set((board.passedAfterRiichi[seat] ?? []).map(tileKind));
  base.waits = waitTable.waits.map((row): OpenWait => {
    const stand = riichi !== 'none' && row.riichi !== null ? 'riichi' : 'dama';
    return {
      kind: row.kind,
      tile: kindToTile(row.kind),
      remaining: Math.max(0, 4 - (seen[row.kind] as number)),
      shapes: row.shapes,
      furiten: row.furiten || passed.has(row.kind),
      stand,
      ron: (stand === 'riichi' && row.riichi !== null ? row.riichi : row.dama).ron,
    };
  });
  base.shape = waitTable.shape;
  return base;
}

/** 卓の、本人以外の 3 人の開いた手牌（下家・対面・上家の順）。 */
export function openSeatsOf(table: TableView, me: Seat): OpenSeat[] {
  const seen = openSeenCounts(table);
  return otherSeats(me).map((seat) => openSeatOf(table, seat, undefined, seen));
}

/**
 * 局 `kyokuPosition` の、牌譜の `eventIndex` の event まで進めたときの、他家 3 人の開いた手牌。
 * 判断の盤面は `Decision.eventIndex`、通して見る画面の手は `TimelineStep.eventIndex` が、その位置。
 */
export function openHandsAt(game: Pick<ImportedGame, 'report' | 'playerId' | 'kyokus'>, kyokuPosition: number, eventIndex: number): OpenSeat[] {
  const kyoku = game.kyokus[kyokuPosition];
  if (kyoku === undefined) return [];
  return openSeatsOf(tableAt(game.report.mjai_log, kyoku.startIndex, eventIndex, game.playerId), game.playerId);
}
