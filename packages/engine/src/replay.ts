/**
 * 牌譜（mjai の event の列）の再生と、盤面の組み立て（E-2 の土台）。
 *
 * 牌譜には 4 人全員の配牌とツモが入っているので、4 人の手牌をすべて追いかけ、牌譜の矛盾（手牌に無い牌を切るなど）も
 * そのつど見つける。盤面（BoardState）には、見せてよいもの（自分の手牌、4人の河・副露・リーチ、ドラ、点数など）だけを出す。
 */
import { kyokuNumber, seatWindsFor } from './kyoku';
import type { Fuuro, MjaiEvent, Seat, StartKyokuEvent, Wind } from './report-types';
import { type Tile, plainTile, sortTiles, tileKind } from './tiles';

/** リーチの状態。declared は宣言したが成立前（宣言牌が通る前）、accepted は成立。 */
export type RiichiState = 'none' | 'declared' | 'accepted';

/** 河の牌 1 枚。 */
export interface RiverTile {
  readonly tile: Tile;
  /** ツモ切り。 */
  readonly tsumogiri: boolean;
  /** リーチの宣言牌。 */
  readonly riichi: boolean;
  /** 他家に鳴かれた（チー・ポン・大明槓）ときは、鳴いた席。 */
  readonly calledBy: Seat | null;
}

/** ある時点の盤面（レビューした本人の視点）。 */
export interface BoardState {
  /** レビューした本人の席。 */
  readonly playerId: Seat;
  /** 局の通し番号（東1局が 0、南1局が 4、西1局が 8）。 */
  readonly kyokuIndex: number;
  readonly roundWind: Wind;
  /** 場の中の局の番号（1 から 4）。 */
  readonly kyoku: number;
  readonly honba: number;
  /** 供託のリーチ棒の数（成立したものだけ）。 */
  readonly kyotaku: number;
  readonly oya: Seat;
  /** 席ごとの自風。 */
  readonly seatWinds: readonly Wind[];
  /** 席ごとの点数（成立したリーチ棒の分を引いた後）。 */
  readonly scores: readonly number[];
  /** ドラ表示牌（開いた順）。 */
  readonly doraMarkers: readonly Tile[];
  /** 残りのツモ枚数。 */
  readonly tilesLeft: number;
  /** 本人の巡目（本人のツモとチー・ポンで 1 つずつ増える。mjai-reviewer の数え方）。 */
  readonly junme: number;
  /** 本人の閉じた手牌（ツモ牌を除く。並べ替え済みで、赤五は同じ五の前）。 */
  readonly hand: readonly Tile[];
  /** 本人がツモって、まだ切っていない牌。 */
  readonly drawn: Tile | null;
  /** 席ごとの閉じた手牌の枚数（ツモ牌を含む）。 */
  readonly handCounts: readonly number[];
  /**
   * 席ごとの、ツモってまだ切っていない牌があるか（牌は入れない。チー・ポンのあとの打牌の前は false）。
   * 他家の手牌を裏向きで置くとき、ツモ牌を少し離すのに使う（実際の卓でも、ツモった牌が離れて見える）。
   */
  readonly handDrawn: readonly boolean[];
  /** 席ごとの河（切った順）。 */
  readonly rivers: readonly (readonly RiverTile[])[];
  /** 席ごとの副露（鳴いた順）。 */
  readonly melds: readonly (readonly Fuuro[])[];
  /** 席ごとのリーチの状態。 */
  readonly riichi: readonly RiichiState[];
  /** リーチを宣言した席を、宣言した順に（宣言した時点で入る。宣言牌が通る前も含む）。 */
  readonly riichiOrder: readonly Seat[];
  /**
   * 席ごとの、その席のリーチ宣言のあとに、だれかが切って通った牌（赤でない表記。切った順で、同じ種類は 1 つ。リーチしていない席は空）。
   * その席は、これらの牌でロンしていない（ロンできる牌を見逃せば、リーチのフリテンになる）ので、その席に対しては現物（F14 の守備の目安）。
   * その席自身の河は含まない（河は `rivers`）。
   */
  readonly passedAfterRiichi: readonly (readonly Tile[])[];
}

/**
 * ある時点の卓の全部。**他家の手牌を含む**ので、答えたあとの画面と、局の終わりの結果の画面（F14）だけが使う
 * （盤面 `BoardState` には、他家の手牌を入れない）。和了の役・点数を計算し直すための、和了の状況も持つ。
 */
export interface TableView {
  /** いまの盤面（本人の視点）。 */
  readonly board: BoardState;
  /** 席ごとの閉じた手牌（ツモ牌を含む。並べ替えない）。 */
  readonly hands: readonly (readonly Tile[])[];
  /** 席ごとの、ツモってまだ切っていない牌。 */
  readonly drawn: readonly (Tile | null)[];
  /** 席ごとの、ダブル立直か（立直を宣言したときの状況）。 */
  readonly doubleRiichi: readonly boolean[];
  /** 席ごとの、一発が残っているか（立直が成立してから、だれも鳴かず、その席が切っていない）。 */
  readonly ippatsu: readonly boolean[];
  /** 席ごとの、河に切った枚数。 */
  readonly discardCount: readonly number[];
  /** 席ごとの、直前のツモが嶺上牌か。 */
  readonly rinshan: readonly boolean[];
  /** 局のどこかで、鳴き・カンがあったか。 */
  readonly anyCall: boolean;
  /** 直前の捨て牌（加槓の牌も入る）。 */
  readonly lastDiscard: { readonly seat: Seat; readonly tile: Tile } | null;
  /** 直前の event の種類（和了・流局は数えない）。 */
  readonly lastEventType: MjaiEvent['type'] | null;
}

/** 牌譜が矛盾していて、再生を進められない。 */
export class ReplayLogError extends Error {
  constructor(
    message: string,
    /** 牌譜（mjai_log）の中の位置。 */
    readonly eventIndex: number,
  ) {
    super(message);
    this.name = 'ReplayLogError';
  }
}

/** 配牌のあとの、ツモの山の枚数（王牌14枚と配牌52枚を除く）。 */
export const INITIAL_TILES_LEFT = 70;

/** 1 局分の牌譜を 1 event ずつ進めて、盤面を持つ。 */
export class KyokuReplayer {
  private readonly hands: Tile[][];
  private readonly drawn: (Tile | null)[] = [null, null, null, null];
  private readonly rivers: RiverTile[][] = [[], [], [], []];
  private readonly melds: Fuuro[][] = [[], [], [], []];
  private readonly riichi: RiichiState[] = ['none', 'none', 'none', 'none'];
  private readonly riichiOrder: Seat[] = [];
  private readonly passed: Tile[][] = [[], [], [], []];
  private readonly scores: number[];
  private readonly doraMarkers: Tile[];
  private kyotaku: number;
  /** リーチを宣言して、まだ宣言牌を切っていない席。 */
  private pendingRiichi: Seat | null = null;
  // ---- 和了の状況（役・点数の計算し直し用。`table()` で外に出す） ----
  private readonly doubleRiichi: boolean[] = [false, false, false, false];
  private readonly ippatsu: boolean[] = [false, false, false, false];
  private readonly discardCount: number[] = [0, 0, 0, 0];
  private readonly rinshan: boolean[] = [false, false, false, false];
  private anyCall = false;
  /** 大明槓・暗槓・加槓をして、まだ嶺上牌をツモっていない席。 */
  private pendingKan: Seat | null = null;
  /** 直前の捨て牌（加槓の牌も入る。槍槓のロンの牌）。 */
  private lastDiscard: { seat: Seat; tile: Tile } | null = null;
  /** 直前の event の種類（和了・流局は数えない。ダブロンの 2 つ目も、和了の前の event を見られるように）。 */
  private lastEventType: MjaiEvent['type'] | null = null;

  /** 残りのツモ枚数。 */
  tilesLeft = INITIAL_TILES_LEFT;
  /** 本人の巡目。 */
  junme = 0;
  /** 直前に動いた席（mjai-reviewer の last_actor）。 */
  lastActor: Seat | null = null;
  /** 直前のツモ牌か捨て牌（mjai-reviewer の tile。本人のツモ・誰かの打牌・加槓の牌）。 */
  lastTile: Tile | null = null;

  readonly kyokuIndex: number;

  constructor(
    readonly start: StartKyokuEvent,
    readonly playerId: Seat,
  ) {
    this.hands = start.tehais.map((row) => [...row]);
    this.scores = [...start.scores];
    this.doraMarkers = [start.dora_marker];
    this.kyotaku = start.kyotaku;
    this.kyokuIndex = kyokuNumber(start.bakaze, start.kyoku);
  }

  /** 本人の閉じた手牌（ツモ牌を含む。並べ替えない）。 */
  ownHand(): Tile[] {
    return [...(this.hands[this.playerId] as Tile[])];
  }

  /** 本人の副露。 */
  ownMelds(): Fuuro[] {
    return [...(this.melds[this.playerId] as Fuuro[])];
  }

  /** 席 `seat` の閉じた手牌（ツモ牌を含む。並べ替えない。他家の手牌を含むので、答えたあとの画面と、局の終わりの画面だけが使う）。 */
  handOf(seat: Seat): Tile[] {
    return [...(this.hands[seat] as Tile[])];
  }

  /** 席 `seat` の副露（鳴いた順）。 */
  meldsOf(seat: Seat): Fuuro[] {
    return [...(this.melds[seat] as Fuuro[])];
  }

  private remove(seat: Seat, tile: Tile, eventIndex: number): void {
    const hand = this.hands[seat] as Tile[];
    const i = hand.indexOf(tile);
    if (i < 0) throw new ReplayLogError(`席${seat}の手牌に ${tile} がありません`, eventIndex);
    hand.splice(i, 1);
  }

  private markCalled(target: Seat, tile: Tile, by: Seat, eventIndex: number): void {
    const river = this.rivers[target] as RiverTile[];
    const last = river[river.length - 1];
    if (!last || last.tile !== tile) {
      throw new ReplayLogError(`席${by}が席${target}の ${tile} を鳴きましたが、席${target}の最後の捨て牌ではありません`, eventIndex);
    }
    river[river.length - 1] = { ...last, calledBy: by };
  }

  /** event を 1 つ進める。牌譜が矛盾していれば ReplayLogError。eventIndex はエラーに付ける位置。 */
  apply(event: MjaiEvent, eventIndex: number): void {
    switch (event.type) {
      case 'tsumo': {
        (this.hands[event.actor] as Tile[]).push(event.pai);
        this.drawn[event.actor] = event.pai;
        this.tilesLeft--;
        this.rinshan[event.actor] = this.pendingKan === event.actor;
        this.pendingKan = null;
        this.lastEventType = event.type;
        this.lastActor = event.actor;
        if (event.actor === this.playerId) {
          this.junme++;
          this.lastTile = event.pai;
        }
        return;
      }
      case 'dahai': {
        this.remove(event.actor, event.pai, eventIndex);
        this.drawn[event.actor] = null;
        const declaring = this.pendingRiichi === event.actor;
        if (declaring) this.pendingRiichi = null;
        else this.ippatsu[event.actor] = false;
        this.discardCount[event.actor] = (this.discardCount[event.actor] as number) + 1;
        this.rinshan[event.actor] = false;
        this.lastDiscard = { seat: event.actor, tile: event.pai };
        this.lastEventType = event.type;
        (this.rivers[event.actor] as RiverTile[]).push({
          tile: event.pai,
          tsumogiri: event.tsumogiri,
          riichi: declaring,
          calledBy: null,
        });
        // リーチを宣言している他家に対して、この牌は通った（宣言牌を切る席自身は数えない）
        for (const seat of this.riichiOrder) {
          const list = this.passed[seat] as Tile[];
          if (seat !== event.actor && !list.some((t) => tileKind(t) === tileKind(event.pai))) list.push(plainTile(event.pai));
        }
        this.lastActor = event.actor;
        this.lastTile = event.pai;
        return;
      }
      case 'chi':
      case 'pon':
      case 'daiminkan': {
        for (const t of event.consumed) this.remove(event.actor, t, eventIndex);
        this.markCalled(event.target, event.pai, event.actor, eventIndex);
        (this.melds[event.actor] as Fuuro[]).push({
          type: event.type,
          target: event.target,
          pai: event.pai,
          consumed: [...event.consumed],
        });
        this.drawn[event.actor] = null;
        this.anyCall = true;
        this.ippatsu.fill(false);
        if (event.type === 'daiminkan') this.pendingKan = event.actor;
        this.lastEventType = event.type;
        this.lastActor = event.actor;
        // 巡目はチー・ポンだけ増える（大明槓のあとのツモで増える）
        if (event.actor === this.playerId && event.type !== 'daiminkan') this.junme++;
        return;
      }
      case 'ankan': {
        for (const t of event.consumed) this.remove(event.actor, t, eventIndex);
        (this.melds[event.actor] as Fuuro[]).push({ type: 'ankan', consumed: [...event.consumed] });
        this.drawn[event.actor] = null;
        this.anyCall = true;
        this.ippatsu.fill(false);
        this.pendingKan = event.actor;
        this.lastEventType = event.type;
        this.lastActor = event.actor;
        return;
      }
      case 'kakan': {
        this.remove(event.actor, event.pai, eventIndex);
        const melds = this.melds[event.actor] as Fuuro[];
        const kind = tileKind(event.pai);
        const index = melds.findIndex((m) => m.type === 'pon' && tileKind(m.pai) === kind);
        const pon = melds[index];
        if (!pon || pon.type !== 'pon') {
          throw new ReplayLogError(`席${event.actor}が ${event.pai} を加槓しましたが、対応するポンがありません`, eventIndex);
        }
        melds[index] = {
          type: 'kakan',
          pai: event.pai,
          previous_pon_target: pon.target,
          previous_pon_pai: pon.pai,
          consumed: [...pon.consumed],
        };
        this.drawn[event.actor] = null;
        this.anyCall = true;
        this.ippatsu.fill(false);
        this.pendingKan = event.actor;
        this.lastDiscard = { seat: event.actor, tile: event.pai };
        this.lastEventType = event.type;
        this.lastActor = event.actor;
        this.lastTile = event.pai;
        return;
      }
      case 'reach': {
        this.riichi[event.actor] = 'declared';
        if (!this.riichiOrder.includes(event.actor)) this.riichiOrder.push(event.actor);
        this.pendingRiichi = event.actor;
        this.doubleRiichi[event.actor] = this.discardCount[event.actor] === 0 && !this.anyCall;
        this.lastEventType = event.type;
        this.lastActor = event.actor;
        return;
      }
      case 'reach_accepted': {
        this.riichi[event.actor] = 'accepted';
        this.scores[event.actor] = (this.scores[event.actor] as number) - 1000;
        this.kyotaku++;
        this.ippatsu[event.actor] = true;
        this.lastEventType = event.type;
        this.lastActor = event.actor;
        return;
      }
      case 'dora': {
        this.doraMarkers.push(event.dora_marker);
        this.lastEventType = event.type;
        return;
      }
      case 'hora': {
        this.lastActor = event.actor;
        return;
      }
      default:
        return;
    }
  }

  /** いまの盤面。以後の event を進めても変わらないコピー。 */
  snapshot(): BoardState {
    const me = this.playerId;
    const hand = [...(this.hands[me] as Tile[])];
    const drawn = this.drawn[me] ?? null;
    if (drawn !== null) {
      const i = hand.indexOf(drawn);
      if (i >= 0) hand.splice(i, 1);
    }
    return {
      playerId: me,
      kyokuIndex: this.kyokuIndex,
      roundWind: this.start.bakaze,
      kyoku: this.start.kyoku,
      honba: this.start.honba,
      kyotaku: this.kyotaku,
      oya: this.start.oya,
      seatWinds: seatWindsFor(this.start.oya),
      scores: [...this.scores],
      doraMarkers: [...this.doraMarkers],
      tilesLeft: this.tilesLeft,
      junme: this.junme,
      hand: sortTiles(hand),
      drawn,
      handCounts: this.hands.map((h) => h.length),
      handDrawn: this.drawn.map((tile) => tile !== null),
      rivers: this.rivers.map((r) => r.slice()),
      melds: this.melds.map((m) => m.slice()),
      riichi: [...this.riichi],
      riichiOrder: [...this.riichiOrder],
      passedAfterRiichi: this.passed.map((list) => [...list]),
    };
  }

  /** いまの卓の全部（他家の手牌を含む。以後の event を進めても変わらないコピー）。 */
  table(): TableView {
    return {
      board: this.snapshot(),
      hands: this.hands.map((hand) => [...hand]),
      drawn: [...this.drawn],
      doubleRiichi: [...this.doubleRiichi],
      ippatsu: [...this.ippatsu],
      discardCount: [...this.discardCount],
      rinshan: [...this.rinshan],
      anyCall: this.anyCall,
      lastDiscard: this.lastDiscard === null ? null : { ...this.lastDiscard },
      lastEventType: this.lastEventType,
    };
  }
}

/** 牌譜の中の 1 局分（start_kyoku から end_kyoku まで）。 */
export interface KyokuLog {
  start: StartKyokuEvent;
  /** mjai_log の中での start_kyoku の位置。 */
  startIndex: number;
  /** start_kyoku から始まる event の列（先頭が start_kyoku）。 */
  events: MjaiEvent[];
}

/** 牌譜を局ごとに分ける（start_kyoku で区切る）。 */
export function splitKyokus(log: readonly MjaiEvent[]): KyokuLog[] {
  const kyokus: KyokuLog[] = [];
  let current: KyokuLog | undefined;
  for (const [index, event] of log.entries()) {
    if (event.type === 'start_kyoku') {
      current = { start: event, startIndex: index, events: [event] };
      kyokus.push(current);
    } else if (current && event.type !== 'end_game' && event.type !== 'start_game') {
      current.events.push(event);
    }
  }
  return kyokus;
}

/** 1 局分の盤面を、event ごとに作る。frames[i] は kyoku.events[i] を進めた後の盤面（frames[0] は配牌の直後）。 */
export interface ReplayFrame {
  /** mjai_log の中の event の位置。 */
  eventIndex: number;
  event: MjaiEvent;
  board: BoardState;
}

export function replayFrames(kyoku: KyokuLog, playerId: Seat): ReplayFrame[] {
  const replayer = new KyokuReplayer(kyoku.start, playerId);
  const frames: ReplayFrame[] = [{ eventIndex: kyoku.startIndex, event: kyoku.start, board: replayer.snapshot() }];
  for (let i = 1; i < kyoku.events.length; i++) {
    const event = kyoku.events[i] as MjaiEvent;
    replayer.apply(event, kyoku.startIndex + i);
    frames.push({ eventIndex: kyoku.startIndex + i, event, board: replayer.snapshot() });
  }
  return frames;
}

/**
 * 局の最初の event（`startIndex` の start_kyoku）から、`eventIndex` の event まで進めたときの、卓の全部（他家の手牌を含む）。
 * `eventIndex` が局の始まり（`startIndex`）なら、配牌の直後。牌譜が矛盾していれば ReplayLogError。
 */
export function tableAt(log: readonly MjaiEvent[], startIndex: number, eventIndex: number, playerId: Seat): TableView {
  const start = log[startIndex];
  if (start === undefined || start.type !== 'start_kyoku') {
    throw new ReplayLogError('局の始まり（start_kyoku）ではありません', startIndex);
  }
  const replayer = new KyokuReplayer(start, playerId);
  for (let index = startIndex + 1; index <= eventIndex; index++) {
    const event = log[index];
    if (event === undefined) throw new ReplayLogError('牌譜の終わりを越えました', index);
    replayer.apply(event, index);
  }
  return replayer.table();
}
