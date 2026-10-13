/**
 * 他家が聴牌した巡目（F14、E-43。R16-7 の A）。他家の手の進み方: 1 局を牌譜（mjai の event）で追い、他家 3 人ごとに、
 * 配牌と、その人が切るたびの向聴数（切ったあとの閉じた手牌）、聴牌になった打牌（印を付ける打牌）、そこに至った経路、待ちを返す。
 *
 * - 向聴数は、閉じた手牌（3n+1 枚）の `shantenOfCounts`（E-21・E-41 と同じ数え方。副露のぶん手牌は少なく、枚数から副露の数を決める）。0 は聴牌。
 * - 聴牌になった打牌（`TenpaiMark`）は、向聴数が 0 でなかった手から、その人が切って 0 になった打牌。鳴いて聴牌になったときは、鳴いたあとの打牌。
 *   聴牌を崩して（向聴数が 0 でなくなって）また聴牌になったときは、聴牌の区間ごとに最初の打牌に印を付ける（`again` が true）。
 *   配牌のとき聴牌の人は、最初の打牌が最初の区間の始まりになる（その打牌は、聴牌を保ったままの打牌。「配牌から」とは言わない）。
 *   画面は、印を「いまの手まで」に絞って出す（`eventIndex` が、いまの手の位置以下のもの）。いまの区間は、最後の印。
 * - 経路（`TenpaiRoute`）は、その打牌の直前に、その人がしたこと: ツモ（引いた牌）・チー／ポン／大明槓（鳴いた牌）・カン（暗槓・加槓・大明槓のあとの
 *   嶺上牌）。
 * - 待ちは、聴牌になった打牌のあとの手の待ち（`coreTenpaiWaits`。E-36 の待ちの計算と同じ。4 枚とも自分の手にある牌は待ちに入れない）。
 * 本人の手牌は追わない（本人の向聴数の推移は、局の評価の行のほうで出す）。他家の手牌を含むので、答えたあとの画面と、他家の手牌を開いたときだけ呼ぶ（U-1）。
 */
import type { ImportedGame } from './import';
import { coreTenpaiWaits } from './majiang-adapter';
import { otherSeats } from './open-hands';
import { KyokuReplayer } from './replay';
import type { MjaiEvent, Seat, StartKyokuEvent } from './report-types';
import { shantenOfCounts } from './shanten';
import { type Tile, countTiles, kindToTile } from './tiles';

/** 聴牌になった打牌の直前に、その人がしたこと。 */
export type TenpaiRoute =
  | { kind: 'tsumo'; drew: Tile }
  | { kind: 'call'; call: 'chi' | 'pon' | 'daiminkan'; pai: Tile }
  | { kind: 'kan'; call: 'ankan' | 'kakan' | 'daiminkan'; drew: Tile | null };

/** 向聴数の折れ線の 1 点（その人が `n` 枚目の牌を切ったあと）。 */
export interface TrackPoint {
  /** その人の何枚目の打牌か。0 は配牌（まだ切っていない）。 */
  n: number;
  /** mjai_log の中の位置（打牌の event。配牌は局の始まり）。 */
  eventIndex: number;
  /** 打牌（配牌は null）。 */
  discard: Tile | null;
  tsumogiri: boolean;
  /** 切ったあとの閉じた手牌の向聴数。0 が聴牌。 */
  shanten: number;
}

/** 聴牌になった打牌。 */
export interface TenpaiMark {
  /** その人の何枚目の打牌か（河の左から数えた枚数。河の添字は n - 1）。 */
  n: number;
  /** mjai_log の中の、打牌の event の位置。 */
  eventIndex: number;
  discard: Tile;
  tsumogiri: boolean;
  route: TenpaiRoute;
  /** 待ち（赤でない牌。種類の順）。 */
  waits: Tile[];
  /** 聴牌を崩したあとの、2 つ目以降の聴牌の区間か。 */
  again: boolean;
}

/** 他家 1 人の、1 局の手の進み。 */
export interface SeatTrack {
  seat: Seat;
  /** 配牌（n = 0）と、切るごとの点。 */
  points: TrackPoint[];
  /** 聴牌になった打牌（聴牌の区間ごとに 1 つ。切った順）。 */
  marks: TenpaiMark[];
}

/** 1 局の、他家 3 人（下家・対面・上家の順）の手の進み。 */
export interface KyokuTracks {
  kyokuPosition: number;
  seats: SeatTrack[];
}

type KanKind = 'ankan' | 'kakan' | 'daiminkan';

/** 局 `kyokuPosition` の、他家 3 人の手の進みを作る。 */
export function opponentTracksOf(game: Pick<ImportedGame, 'report' | 'playerId' | 'kyokus'>, kyokuPosition: number): KyokuTracks {
  const kyoku = game.kyokus[kyokuPosition];
  if (kyoku === undefined) return { kyokuPosition, seats: [] };
  const log = game.report.mjai_log;
  const me = game.playerId;
  const start = log[kyoku.startIndex] as StartKyokuEvent;
  const replayer = new KyokuReplayer(start, me);
  const seats = otherSeats(me);
  const tracks = new Map<Seat, SeatTrack>();
  // 直前にその人がしたこと（打牌のあとは未定）と、嶺上牌を待っているカンの種類
  const route = new Map<Seat, TenpaiRoute | null>();
  const pendingKan = new Map<Seat, KanKind | null>();
  const inStretch = new Map<Seat, boolean>();
  const shantenOf = (seat: Seat): number => shantenOfCounts(countTiles(replayer.handOf(seat)));
  for (const seat of seats) {
    tracks.set(seat, {
      seat,
      points: [{ n: 0, eventIndex: kyoku.startIndex, discard: null, tsumogiri: false, shanten: shantenOf(seat) }],
      marks: [],
    });
    route.set(seat, null);
    pendingKan.set(seat, null);
    // 配牌が聴牌でも、最初の打牌から区間が始まる（上の説明）
    inStretch.set(seat, false);
  }
  const isOther = (seat: Seat): boolean => tracks.has(seat);
  for (let index = kyoku.startIndex + 1; index <= kyoku.endIndex; index++) {
    const event = log[index] as MjaiEvent;
    // 打牌の前の、経路の記録（event を進める前の、その人の手のままで決める）
    switch (event.type) {
      case 'tsumo': {
        if (!isOther(event.actor)) break;
        const kan = pendingKan.get(event.actor) ?? null;
        route.set(event.actor, kan === null ? { kind: 'tsumo', drew: event.pai } : { kind: 'kan', call: kan, drew: event.pai });
        pendingKan.set(event.actor, null);
        break;
      }
      case 'chi':
      case 'pon':
      case 'daiminkan':
        if (!isOther(event.actor)) break;
        route.set(event.actor, { kind: 'call', call: event.type, pai: event.pai });
        // 大明槓のあとは、嶺上牌をツモってから切る
        pendingKan.set(event.actor, event.type === 'daiminkan' ? 'daiminkan' : null);
        break;
      case 'ankan':
      case 'kakan':
        if (!isOther(event.actor)) break;
        route.set(event.actor, { kind: 'kan', call: event.type, drew: null });
        pendingKan.set(event.actor, event.type);
        break;
      default:
        break;
    }
    replayer.apply(event, index);
    if (event.type !== 'dahai' || !isOther(event.actor)) continue;
    const seat = event.actor;
    const track = tracks.get(seat) as SeatTrack;
    const previous = track.points[track.points.length - 1] as TrackPoint;
    const point: TrackPoint = {
      n: previous.n + 1,
      eventIndex: index,
      discard: event.pai,
      tsumogiri: event.tsumogiri,
      shanten: shantenOf(seat),
    };
    track.points.push(point);
    if (point.shanten === 0) {
      if (inStretch.get(seat) !== true) {
        const how = route.get(seat) ?? { kind: 'tsumo', drew: event.pai };
        track.marks.push({
          n: point.n,
          eventIndex: index,
          discard: event.pai,
          tsumogiri: event.tsumogiri,
          route: how,
          waits: coreTenpaiWaits(replayer.handOf(seat), replayer.meldsOf(seat), seat).map(kindToTile),
          again: track.marks.length > 0,
        });
      }
      inStretch.set(seat, true);
    } else {
      inStretch.set(seat, false);
    }
    route.set(seat, null);
  }
  return { kyokuPosition, seats: seats.map((seat) => tracks.get(seat) as SeatTrack) };
}
