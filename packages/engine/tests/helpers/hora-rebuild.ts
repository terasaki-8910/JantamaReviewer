import type { ImportedGame } from '../../src/import';
import { type WinFlags, type WinSpec, type WinValue, coreEvaluateWin } from '../../src/majiang-adapter';
import type { EndStatusEvent, Fuuro, HoraEvent, MjaiEvent, Seat, StartKyokuEvent } from '../../src/report-types';
import { type Tile, sortTiles, tileKind } from '../../src/tiles';

// 牌譜（mjai_log）の和了から、和了者の手・状況を組み立てて、majiang-core（majiang-adapter）で計算し直す試験の部品（E-36）。
// 4 人全員の手牌・河・副露・リーチの状態を、1 手ずつ追う（エンジンの KyokuReplayer は、他家の手牌を外に出さない作りなので、ここで別に追う）。
// 本番のコードではない（局の結果の手の画面（F14 の次の段）で、同じことをエンジンの部品にする）。

type RiichiState = 'none' | 'declared' | 'accepted';

interface Table {
  start: StartKyokuEvent;
  /** 閉じた手牌（ツモ牌を含む）。 */
  hands: Tile[][];
  melds: Fuuro[][];
  riichi: RiichiState[];
  doubleRiichi: boolean[];
  ippatsu: boolean[];
  discardCount: number[];
  doraMarkers: Tile[];
  tilesLeft: number;
  /** 局の始めの供託 + その局で成立したリーチ棒。 */
  kyotaku: number;
  anyCall: boolean;
  /** 直前のツモ（席ごと。切ったら null）。 */
  drawn: (Tile | null)[];
  lastDiscard: { seat: Seat; tile: Tile } | null;
  lastEventType: string | null;
  rinshan: boolean[];
  pendingKan: Seat | null;
  pendingRiichi: Seat | null;
}

function newTable(start: StartKyokuEvent): Table {
  return {
    start,
    hands: start.tehais.map((row) => [...row]),
    melds: [[], [], [], []],
    riichi: ['none', 'none', 'none', 'none'],
    doubleRiichi: [false, false, false, false],
    ippatsu: [false, false, false, false],
    discardCount: [0, 0, 0, 0],
    doraMarkers: [start.dora_marker],
    tilesLeft: 70,
    kyotaku: start.kyotaku,
    anyCall: false,
    drawn: [null, null, null, null],
    lastDiscard: null,
    lastEventType: null,
    rinshan: [false, false, false, false],
    pendingKan: null,
    pendingRiichi: null,
  };
}

function removeTile(hand: Tile[], tile: Tile): void {
  const i = hand.indexOf(tile);
  if (i < 0) throw new Error(`手牌に ${tile} がありません`);
  hand.splice(i, 1);
}

function applyEvent(t: Table, event: MjaiEvent): void {
  switch (event.type) {
    case 'tsumo':
      t.hands[event.actor]?.push(event.pai);
      t.drawn[event.actor] = event.pai;
      t.tilesLeft--;
      t.rinshan[event.actor] = t.pendingKan === event.actor;
      t.pendingKan = null;
      break;
    case 'dahai': {
      removeTile(t.hands[event.actor] as Tile[], event.pai);
      t.drawn[event.actor] = null;
      if (t.pendingRiichi === event.actor) t.pendingRiichi = null;
      else t.ippatsu[event.actor] = false;
      t.discardCount[event.actor] = (t.discardCount[event.actor] as number) + 1;
      t.rinshan[event.actor] = false;
      t.lastDiscard = { seat: event.actor, tile: event.pai };
      break;
    }
    case 'chi':
    case 'pon':
    case 'daiminkan':
      for (const c of event.consumed) removeTile(t.hands[event.actor] as Tile[], c);
      (t.melds[event.actor] as Fuuro[]).push({ type: event.type, target: event.target, pai: event.pai, consumed: [...event.consumed] });
      t.drawn[event.actor] = null;
      t.anyCall = true;
      t.ippatsu.fill(false);
      if (event.type === 'daiminkan') t.pendingKan = event.actor;
      break;
    case 'ankan':
      for (const c of event.consumed) removeTile(t.hands[event.actor] as Tile[], c);
      (t.melds[event.actor] as Fuuro[]).push({ type: 'ankan', consumed: [...event.consumed] });
      t.drawn[event.actor] = null;
      t.anyCall = true;
      t.ippatsu.fill(false);
      t.pendingKan = event.actor;
      break;
    case 'kakan': {
      removeTile(t.hands[event.actor] as Tile[], event.pai);
      const melds = t.melds[event.actor] as Fuuro[];
      const kind = tileKind(event.pai);
      const index = melds.findIndex((m) => m.type === 'pon' && tileKind(m.pai) === kind);
      const pon = melds[index];
      if (pon === undefined || pon.type !== 'pon') throw new Error('加槓の元のポンがありません');
      melds[index] = { type: 'kakan', pai: event.pai, previous_pon_target: pon.target, previous_pon_pai: pon.pai, consumed: [...pon.consumed] };
      t.drawn[event.actor] = null;
      t.anyCall = true;
      t.ippatsu.fill(false);
      t.pendingKan = event.actor;
      t.lastDiscard = { seat: event.actor, tile: event.pai };
      break;
    }
    case 'reach':
      t.riichi[event.actor] = 'declared';
      t.pendingRiichi = event.actor;
      t.doubleRiichi[event.actor] = t.discardCount[event.actor] === 0 && !t.anyCall;
      break;
    case 'reach_accepted':
      t.riichi[event.actor] = 'accepted';
      t.kyotaku++;
      t.ippatsu[event.actor] = true;
      break;
    case 'dora':
      t.doraMarkers.push(event.dora_marker);
      break;
    default:
      break;
  }
  t.lastEventType = event.type;
}

function cloneTable(t: Table): Table {
  return {
    ...t,
    hands: t.hands.map((h) => [...h]),
    melds: t.melds.map((m) => m.map((x) => ({ ...x, consumed: [...x.consumed] }) as Fuuro)),
    riichi: [...t.riichi],
    doubleRiichi: [...t.doubleRiichi],
    ippatsu: [...t.ippatsu],
    discardCount: [...t.discardCount],
    doraMarkers: [...t.doraMarkers],
    drawn: [...t.drawn],
    lastDiscard: t.lastDiscard === null ? null : { ...t.lastDiscard },
    rinshan: [...t.rinshan],
  };
}

/** 牌譜の和了 1 件を組み立てて計算し直した結果。 */
export interface HoraCase {
  id: string;
  game: string;
  winner: Seat;
  target: Seat;
  tsumo: boolean;
  winTile: Tile;
  spec: WinSpec;
  value: WinValue;
  /** 計算した点数の増減（絶対席。本場・供託込み）。 */
  deltasCore: number[];
  /** 牌譜（end_status）の点数の増減。 */
  deltasLog: number[];
}

/** 1 局の和了（end_status の順）を全部、組み立てて計算し直す。 */
export function horaCasesOf(game: ImportedGame, gameId: string, position: number): HoraCase[] {
  const kyoku = game.kyokus[position];
  const report = game.report.review.kyokus[position];
  if (kyoku === undefined || report === undefined) return [];
  const end = report.end_status.filter((e): e is EndStatusEvent & HoraEvent => e.type === 'hora');
  const out: HoraCase[] = [];
  const log = game.report.mjai_log;
  const t = newTable(log[kyoku.startIndex] as StartKyokuEvent);
  let k = 0;
  for (let index = kyoku.startIndex + 1; index <= kyoku.endIndex; index++) {
    const event = log[index] as MjaiEvent;
    if (event.type === 'hora') {
      const before = cloneTable(t);
      const logged = end[k];
      k++;
      const winner = event.actor;
      const target = event.target;
      const tsumo = winner === target;
      const hand = [...(before.hands[winner] as Tile[])];
      let winTile: Tile;
      if (tsumo) {
        winTile = before.drawn[winner] as Tile;
        hand.splice(hand.indexOf(winTile), 1);
      } else {
        winTile = (before.lastDiscard as { tile: Tile }).tile;
      }
      const dealer = before.start.oya;
      const chankan = !tsumo && before.lastEventType === 'kakan';
      const riichi = before.riichi[winner] === 'accepted';
      const flags: WinFlags = {
        riichi,
        doubleRiichi: before.doubleRiichi[winner] === true && riichi,
        ippatsu: riichi && before.ippatsu[winner] === true,
        haitei: tsumo ? (before.tilesLeft === 0 ? 1 : 0) : before.tilesLeft === 0 && !chankan ? 2 : 0,
        rinshan: tsumo && before.rinshan[winner] === true,
        chankan,
        tenhou:
          tsumo && !before.anyCall && before.discardCount.every((n) => n === 0)
            ? 1
            : tsumo && !before.anyCall && before.discardCount[winner] === 0 && winner !== dealer
              ? 2
              : 0,
      };
      const spec: WinSpec = {
        closed: sortTiles(hand),
        melds: [...(before.melds[winner] as Fuuro[])],
        winTile,
        tsumo,
        flags,
        seatIndex: (winner - dealer + 4) % 4,
        roundWind: before.start.bakaze,
        doraMarkers: [...before.doraMarkers],
        uraMarkers: riichi ? [...(event.ura_markers ?? [])] : [],
        honba: before.start.honba,
        kyotaku: before.kyotaku,
        actor: winner,
        target,
      };
      const value = coreEvaluateWin(spec);
      const core = [0, 0, 0, 0];
      value.fenpei.forEach((v, l) => {
        core[(dealer + l) % 4] = v;
      });
      out.push({ id: `${gameId}-k${position}-e${index}`, game: gameId, winner, target, tsumo, winTile, spec, value, deltasCore: core, deltasLog: logged?.deltas ?? [] });
    }
    applyEvent(t, event);
  }
  return out;
}
