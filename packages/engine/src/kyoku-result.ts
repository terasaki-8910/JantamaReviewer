/**
 * 局の結果の手（F14、E-40、U-36 の局の結果の手の部分。R15-6 の A「表はいまのまま、行を開くと全部」）。
 *
 * Mortal の結果 JSON には、和了の役・符・点数が入っていない（点数の増減だけ）。そこで、牌譜（mjai_log）から局を 1 手ずつ追い、
 * 和了のたびに、和了者の手牌・副露・和了牌・和了の状況（立直・一発・海底・嶺上・槍槓・天和・地和）・ドラ表示牌・裏ドラ表示牌を組み立て、
 * majiang-core（majiang-adapter.ts）で役・飜・符・点数を計算し直す。計算し直した点の増減（本場・供託を含む）は、牌譜の点の増減と一致する
 * （固定データの和了 69 件で確かめる。E-36・E-40）。他家のツモ・ロンの局も同じ。ダブロンは、和了ごとに 1 つ。
 * 流局は、4 人の手牌と、聴牌・ノーテン（荒牌平局。途中流局は手牌だけ）。
 *
 * 放銃した局の相手の手牌と待ち（和了牌を除いた手の待ち）も、ここで出す（`KyokuWinView.waits`）。
 */
import { type OpenSeat, type OpenWait, openSeatOf, openSeenCounts } from './open-hands';
import { type TableView, KyokuReplayer, ReplayLogError, splitKyokus } from './replay';
import type { EndStatusEvent, Fuuro, HoraEvent, MjaiEvent, MortalReport, Seat, Wind } from './report-types';
import { type WinFlags, type WinSpec, coreEvaluateWin } from './majiang-adapter';
import { type Tile, countTiles, sortTiles, tileKind } from './tiles';
import { type WaitLine, waitLineOf } from './wait-value';
import { type WinInput, yakuMeldOf } from './yaku';

/** 和了 1 つ。 */
export interface KyokuWinView {
  winner: Seat;
  /** ロンなら放銃した席、ツモなら和了者。 */
  target: Seat;
  tsumo: boolean;
  winTile: Tile;
  /** 和了牌を除いた閉じた手牌（並べ替え済み）。 */
  closed: Tile[];
  melds: Fuuro[];
  wind: Wind;
  dealer: boolean;
  /** 立直をかけていたか。 */
  riichi: boolean;
  /** 役（ドラ類を除く）。名前は画面に出す言い方（役牌 白・立直・断幺九 など）。 */
  yaku: Array<{ name: string; han: number }>;
  /** ドラ・赤ドラ・裏ドラの飜。 */
  dora: { dora: number; aka: number; ura: number };
  /** 飜・符・点数（本場・供託を除く）・符の内訳。ツモの支払いは `line.tsumoPay`。 */
  line: WaitLine;
  honba: number;
  /** 和了者が受け取る供託（リーチ棒）の本数。 */
  kyotaku: number;
  /** 牌譜の点の増減（席ごと。本場・供託を含む）。 */
  deltas: number[];
  /** 計算し直した点の増減（席ごと。本場・供託を含む。`deltas` と一致する）。 */
  deltasComputed: number[];
  /** 和了牌を除いた手の待ち（待ちの形・残り。ロンの点は、立直かダマの実際のとおり）。 */
  waits: OpenWait[];
}

/** 局の結果の手。 */
export type KyokuResultView =
  | { kind: 'win'; wins: KyokuWinView[] }
  | {
      kind: 'draw';
      /** 荒牌平局（牌山を取り切った流局）か。途中流局（九種九牌など）は false で、聴牌・ノーテンは分けない。 */
      exhaustive: boolean;
      /** 4 人の手牌（本人、下家、対面、上家の順）。 */
      seats: OpenSeat[];
      /** 牌譜の点の増減（席ごと。聴牌料）。 */
      deltas: number[];
    };

const WINDS: readonly Wind[] = ['E', 'S', 'W', 'N'];

/** 和了の状況の旗。 */
function flagsOf(table: TableView, winner: Seat, tsumo: boolean, dealer: Seat): WinFlags {
  const riichi = table.board.riichi[winner] === 'accepted';
  const chankan = !tsumo && table.lastEventType === 'kakan';
  const tilesLeft = table.board.tilesLeft;
  return {
    riichi,
    doubleRiichi: table.doubleRiichi[winner] === true && riichi,
    ippatsu: riichi && table.ippatsu[winner] === true,
    haitei: tsumo ? (tilesLeft === 0 ? 1 : 0) : tilesLeft === 0 && !chankan ? 2 : 0,
    rinshan: tsumo && table.rinshan[winner] === true,
    chankan,
    tenhou:
      tsumo && !table.anyCall && table.discardCount.every((n) => n === 0)
        ? 1
        : tsumo && !table.anyCall && table.discardCount[winner] === 0 && winner !== dealer
          ? 2
          : 0,
  };
}

/** 和了 1 つ（`table` は、その和了の直前の卓）。 */
function winViewOf(table: TableView, event: HoraEvent, logged: EndStatusEvent | undefined, first: boolean): KyokuWinView {
  const { board } = table;
  const winner = event.actor;
  const target = event.target;
  const tsumo = winner === target;
  const closedAll = [...(table.hands[winner] ?? [])];
  let winTile: Tile;
  if (tsumo) {
    winTile = table.drawn[winner] as Tile;
    closedAll.splice(closedAll.indexOf(winTile), 1);
  } else {
    winTile = (table.lastDiscard as { tile: Tile }).tile;
  }
  const dealer = board.oya;
  const flags = flagsOf(table, winner, tsumo, dealer);
  const melds = [...(board.melds[winner] ?? [])];
  const closed = sortTiles(closedAll);
  const seatIndex = (winner - dealer + 4) % 4;
  const spec: WinSpec = {
    closed,
    melds,
    winTile,
    tsumo,
    flags,
    seatIndex,
    roundWind: board.roundWind,
    doraMarkers: [...board.doraMarkers],
    uraMarkers: flags.riichi ? [...(event.ura_markers ?? [])] : [],
    honba: board.honba,
    // 供託は、最初の和了（放銃した席から近い順。牌譜の和了の順）だけが受け取る（ダブロンの 2 つ目は受け取らない）
    kyotaku: first ? board.kyotaku : 0,
    actor: winner,
    target,
  };
  const value = coreEvaluateWin(spec);
  const computed = [0, 0, 0, 0];
  value.fenpei.forEach((v, l) => {
    computed[(dealer + l) % 4] = v;
  });
  const closedHand = melds.every((m) => m.type === 'ankan');
  const input: WinInput = {
    counts: countTiles([...closed, winTile]),
    melds: melds.map(yakuMeldOf),
    seatWind: WINDS[seatIndex] as Wind,
    roundWind: board.roundWind,
    winKind: tileKind(winTile),
    tsumo,
    riichi: flags.riichi && closedHand,
  };
  return {
    winner,
    target,
    tsumo,
    winTile,
    closed,
    melds,
    wind: board.seatWinds[winner] as Wind,
    dealer: winner === dealer,
    riichi: flags.riichi,
    yaku: value.yaku,
    dora: value.dora,
    line: waitLineOf(value, input),
    honba: board.honba,
    kyotaku: spec.kyotaku,
    deltas: logged?.deltas ?? [],
    deltasComputed: computed,
    waits: openSeatOf(table, winner, closed).waits,
  };
}

/**
 * 局 `position`（0 から）の結果の手。牌譜が矛盾していて再生できないとき、局が無いときは null。
 * 和了のある局は、和了ごとの `KyokuWinView`（end_status の順）。流局は 4 人の手牌。
 */
export function kyokuResultOf(report: MortalReport, position: number): KyokuResultView | null {
  const log = report.mjai_log;
  const kyoku = splitKyokus(log)[position];
  const reported = report.review.kyokus[position];
  if (kyoku === undefined || reported === undefined) return null;
  const me = report.player_id;
  const replayer = new KyokuReplayer(kyoku.start, me);
  const end = reported.end_status.filter((e): e is EndStatusEvent & HoraEvent => e.type === 'hora');
  const wins: KyokuWinView[] = [];
  try {
    for (let i = 1; i < kyoku.events.length; i++) {
      const event = kyoku.events[i] as MjaiEvent;
      if (event.type === 'hora') {
        wins.push(winViewOf(replayer.table(), event, end[wins.length], wins.length === 0));
      } else if (event.type === 'ryukyoku') {
        const table = replayer.table();
        const seen = openSeenCounts(table);
        const seats = [0, 1, 2, 3].map((offset) => openSeatOf(table, ((me + offset) % 4) as Seat, undefined, seen));
        return { kind: 'draw', exhaustive: table.board.tilesLeft === 0, seats, deltas: reported.end_status[0]?.deltas ?? [0, 0, 0, 0] };
      }
      replayer.apply(event, kyoku.startIndex + i);
    }
  } catch (error) {
    if (error instanceof ReplayLogError) return null;
    throw error;
  }
  return wins.length === 0 ? null : { kind: 'win', wins };
}
