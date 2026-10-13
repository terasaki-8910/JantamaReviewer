import { describe, expect, it } from 'vitest';

import type { ImportedGame } from '../src/import';
import { importReportText } from '../src/import';
import { openSeatOf, otherSeats } from '../src/open-hands';
import { type KyokuTracks, type SeatTrack, type TenpaiMark, opponentTracksOf } from '../src/opponent-track';
import { tableAt } from '../src/replay';
import type { MjaiEvent, Seat, StartKyokuEvent } from '../src/report-types';
import { sceneShantenOfTiles } from '../src/scene-shanten';
import { type Tile, parseTenhouNotation, tileKind } from '../src/tiles';
import { FX1_IDS, FX4_ID, FX5_ID, loadReportText } from './helpers/fixtures';

// F14・E-43（R16-7 の A）: 他家が聴牌した巡目（opponent-track.ts）。1 局を追って、他家 3 人ごとに、切るたびの向聴数と、
// 聴牌になった打牌（印）・経路・待ちを返す。
// 1. 手で作った局: 経路（ツモ・チー・カン）・聴牌を崩して、また聴牌になったときの印・配牌が聴牌のとき
// 2. 固定データの 7 半荘: 印が、向聴数が初めて 0 になった打牌（鳴いて聴牌したときは、鳴いたあとの打牌）と一致し、経路が直前の event と合い、
//    待ちが E-36 の待ちの計算（open-hands.ts → wait-value.ts）と一致し、折れ線の点が E-21 と同じ数え方の向聴数と一致する

const tiles = (text: string) => parseTenhouNotation(text);
const tile = (text: string): Tile => tiles(text)[0] as Tile;

/** 席 0 が親で、本人。席 1〜3 の配牌を渡す。 */
function start(hands: [string, string, string]): StartKyokuEvent {
  return {
    type: 'start_kyoku',
    bakaze: 'E',
    dora_marker: '9s',
    kyoku: 1,
    honba: 0,
    kyotaku: 0,
    oya: 0,
    scores: [25000, 25000, 25000, 25000],
    tehais: [tiles('1m4m7m1p4p7p1s4s7s1z2z3z4z'), tiles(hands[0]), tiles(hands[1]), tiles(hands[2])],
  };
}

/** 手で作った 1 局を、`opponentTracksOf` に渡せる形にする。 */
function trackOf(hands: [string, string, string], events: MjaiEvent[]): KyokuTracks {
  const log: MjaiEvent[] = [start(hands), ...events];
  const game = { report: { mjai_log: log }, playerId: 0 as Seat, kyokus: [{ startIndex: 0, endIndex: log.length - 1 }] } as unknown as ImportedGame;
  return opponentTracksOf(game, 0);
}

const seatTrack = (tracks: KyokuTracks, seat: Seat): SeatTrack => tracks.seats.find((s) => s.seat === seat) as SeatTrack;
const shantens = (track: SeatTrack) => track.points.map((p) => p.shanten);
const IDLE = '1m3m5m7m9m1p3p5p7p9p1s3s5s';

describe('E-43 手で作った局: 向聴数の折れ線と、聴牌になった打牌', () => {
  it('他家 3 人（下家・対面・上家の順）だけを追う。配牌は n = 0、切るたびに n が 1 ずつ増え、向聴数は切ったあとの手', () => {
    // 席 1: 123m 456p 789s 東 南 白白（1 向聴）。東をツモって南を切ると、東東・白白の双碰で聴牌
    const tracks = trackOf(['123m456p789s1z2z5z5z', IDLE, IDLE], [
      { type: 'tsumo', actor: 1, pai: tile('1z') },
      { type: 'dahai', actor: 1, pai: tile('2z'), tsumogiri: false },
    ]);
    expect(tracks.seats.map((s) => s.seat)).toEqual(otherSeats(0));
    const one = seatTrack(tracks, 1);
    expect(one.points.map((p) => p.n)).toEqual([0, 1]);
    expect(shantens(one)).toEqual([1, 0]);
    expect(one.points[0]).toMatchObject({ eventIndex: 0, discard: null });
    expect(one.points[1]).toMatchObject({ eventIndex: 2, discard: tile('2z'), tsumogiri: false });
    // 切っていない人は、配牌の点だけ
    expect(seatTrack(tracks, 2).points).toHaveLength(1);
    expect(seatTrack(tracks, 2).marks).toEqual([]);
  });

  it('ツモで聴牌: 印は、向聴数が 0 になった打牌。経路はツモ（引いた牌）。待ちは、切ったあとの手の待ち（種類の順）', () => {
    const tracks = trackOf(['123m456p789s1z2z5z5z', IDLE, IDLE], [
      { type: 'tsumo', actor: 1, pai: tile('1z') },
      { type: 'dahai', actor: 1, pai: tile('2z'), tsumogiri: false },
    ]);
    const marks = seatTrack(tracks, 1).marks;
    expect(marks).toEqual([
      { n: 1, eventIndex: 2, discard: tile('2z'), tsumogiri: false, route: { kind: 'tsumo', drew: tile('1z') }, waits: [tile('1z'), tile('5z')], again: false },
    ]);
  });

  it('鳴いて聴牌: 印は、鳴いたあとの打牌。経路はチー（鳴いた牌）。ツモ切りかどうかも持つ', () => {
    // 席 1: 23m 456p 789s 234s 白 中（1 向聴）。席 0（上家）の 1m をチーして、中を切ると、白の単騎で聴牌
    const tracks = trackOf(['23m456p789s234s5z7z', IDLE, IDLE], [
      { type: 'dahai', actor: 0, pai: tile('1m'), tsumogiri: false },
      { type: 'chi', actor: 1, target: 0, pai: tile('1m'), consumed: [tile('2m'), tile('3m')] },
      { type: 'dahai', actor: 1, pai: tile('7z'), tsumogiri: false },
    ]);
    const one = seatTrack(tracks, 1);
    expect(shantens(one)).toEqual([1, 0]);
    expect(one.marks).toEqual([
      { n: 1, eventIndex: 3, discard: tile('7z'), tsumogiri: false, route: { kind: 'call', call: 'chi', pai: tile('1m') }, waits: [tile('5z')], again: false },
    ]);
  });

  it('ポンも、経路は「鳴いた牌」。鳴く前に聴牌でなかった手が、ポンのあとの打牌で聴牌になる', () => {
    // 席 2: 11m 456p 789s 234s 白 中（1 向聴）。席 0 の 1m をポンして（11m を出す）、中を切ると、白の単騎で聴牌
    const tracks = trackOf([IDLE, '11m456p789s234s5z7z', IDLE], [
      { type: 'dahai', actor: 0, pai: tile('1m'), tsumogiri: false },
      { type: 'pon', actor: 2, target: 0, pai: tile('1m'), consumed: [tile('1m'), tile('1m')] },
      { type: 'dahai', actor: 2, pai: tile('7z'), tsumogiri: false },
    ]);
    const two = seatTrack(tracks, 2);
    expect(two.marks.map((m) => [m.n, m.route, m.waits])).toEqual([[1, { kind: 'call', call: 'pon', pai: tile('1m') }, [tile('5z')]]]);
  });

  it('カンのあとの嶺上牌からの打牌で聴牌: 経路は暗槓（嶺上牌）。暗槓は副露で、手牌は 3 枚ずつ減る', () => {
    // 席 3: 1111m 456p 789s 白白 發。東をツモって 1m を暗槓し、嶺上牌の發をツモって、東を切ると、白・發の双碰で聴牌
    const tracks = trackOf([IDLE, IDLE, '1111m456p789s5z5z6z'], [
      { type: 'tsumo', actor: 3, pai: tile('1z') },
      { type: 'ankan', actor: 3, consumed: [tile('1m'), tile('1m'), tile('1m'), tile('1m')] },
      { type: 'tsumo', actor: 3, pai: tile('6z') },
      { type: 'dahai', actor: 3, pai: tile('1z'), tsumogiri: false },
    ]);
    const three = seatTrack(tracks, 3);
    expect(shantens(three)).toEqual([1, 0]);
    expect(three.marks).toEqual([
      { n: 1, eventIndex: 4, discard: tile('1z'), tsumogiri: false, route: { kind: 'kan', call: 'ankan', drew: tile('6z') }, waits: [tile('5z'), tile('6z')], again: false },
    ]);
  });

  it('聴牌を崩して、また聴牌になったら、聴牌の区間ごとに最初の打牌に印を付ける（2 つ目は again）。聴牌が続く間は、印を増やさない', () => {
    const tracks = trackOf(['123m456p789s1z2z5z5z', IDLE, IDLE], [
      // 1 つ目の区間: 南を切って聴牌（東東・白白）。9m をツモ切りしても聴牌のまま（印は増えない）
      { type: 'tsumo', actor: 1, pai: tile('1z') },
      { type: 'dahai', actor: 1, pai: tile('2z'), tsumogiri: false },
      { type: 'tsumo', actor: 1, pai: tile('9m') },
      { type: 'dahai', actor: 1, pai: tile('9m'), tsumogiri: true },
      // 東を切って、聴牌を崩す（1 向聴）
      { type: 'tsumo', actor: 1, pai: tile('9p') },
      { type: 'dahai', actor: 1, pai: tile('1z'), tsumogiri: false },
      // 東をツモって 9p を切ると、また聴牌（2 つ目の区間）
      { type: 'tsumo', actor: 1, pai: tile('1z') },
      { type: 'dahai', actor: 1, pai: tile('9p'), tsumogiri: false },
    ]);
    const one = seatTrack(tracks, 1);
    expect(shantens(one)).toEqual([1, 0, 0, 1, 0]);
    expect(one.marks.map((m) => [m.n, m.again, m.tsumogiri])).toEqual([
      [1, false, false],
      [4, true, false],
    ]);
    expect(one.marks.map((m) => m.eventIndex)).toEqual([2, 8]);
  });

  it('配牌が聴牌の人は、最初の打牌（聴牌のまま）が、最初の区間の始まり。折れ線の配牌の点は 0（聴牌）', () => {
    const tracks = trackOf(['123m456p789s1155z', IDLE, IDLE], [
      { type: 'tsumo', actor: 1, pai: tile('9m') },
      { type: 'dahai', actor: 1, pai: tile('9m'), tsumogiri: true },
    ]);
    const one = seatTrack(tracks, 1);
    expect(shantens(one)).toEqual([0, 0]);
    expect(one.marks.map((m) => [m.n, m.tsumogiri, m.again, m.waits])).toEqual([[1, true, false, [tile('1z'), tile('5z')]]]);
  });

  it('局が無ければ空。本人の席は追わない', () => {
    const none = opponentTracksOf({ report: { mjai_log: [] }, playerId: 0, kyokus: [] } as unknown as ImportedGame, 3);
    expect(none.seats).toEqual([]);
  });
});

// ---- 固定データ ----

const IDS = [...FX1_IDS, FX4_ID, FX5_ID] as const;

function load(id: string): ImportedGame {
  const game = importReportText(loadReportText(id));
  if (!game.ok) throw new Error(game.error.message);
  return game.value;
}

/** 牌譜の、event `index` の直前までの、その席の経路を決める event（その席の最後のツモ・鳴き・カン）。 */
function lastActionBefore(log: readonly MjaiEvent[], from: number, index: number, seat: Seat): MjaiEvent | null {
  for (let i = index - 1; i > from; i--) {
    const event = log[i] as MjaiEvent;
    if ('actor' in event && event.actor === seat && ['tsumo', 'chi', 'pon', 'daiminkan', 'ankan', 'kakan'].includes(event.type)) return event;
  }
  return null;
}

describe('E-43 固定データの 7 半荘: 印・経路・待ち・折れ線の点', () => {
  const stats = { points: 0, marks: 0, again: 0, tsumo: 0, chi: 0, pon: 0, kan: 0, emptyWaits: 0, tsumogiri: 0, riichiLike: 0 };

  it('折れ線の点は、その人が切るたびの、切ったあとの手の向聴数（E-21 と同じ数え方）で、河の枚数と合う。配牌は n = 0', () => {
    for (const id of IDS) {
      const game = load(id);
      const log = game.report.mjai_log;
      for (const kyoku of game.kyokus) {
        const tracks = opponentTracksOf(game, kyoku.position);
        expect(tracks.seats.map((s) => s.seat)).toEqual(otherSeats(game.playerId));
        const end = tableAt(log, kyoku.startIndex, kyoku.endIndex, game.playerId);
        for (const track of tracks.seats) {
          const where = `${id} ${kyoku.label} 席${track.seat}`;
          expect(track.points.map((p) => p.n), where).toEqual(track.points.map((_, i) => i));
          // 切った枚数が、局の終わりの河と同じ
          expect(track.points.length - 1, where).toBe(end.board.rivers[track.seat]?.length);
          expect(track.points[0], where).toMatchObject({ n: 0, eventIndex: kyoku.startIndex, discard: null });
          // 配牌の向聴数
          const deal = tableAt(log, kyoku.startIndex, kyoku.startIndex, game.playerId);
          expect(track.points[0]?.shanten, where).toBe(sceneShantenOfTiles(deal.hands[track.seat] as Tile[]));
          for (const point of track.points.slice(1)) {
            const table = tableAt(log, kyoku.startIndex, point.eventIndex, game.playerId);
            const event = log[point.eventIndex] as MjaiEvent;
            expect(event, where).toMatchObject({ type: 'dahai', actor: track.seat, pai: point.discard, tsumogiri: point.tsumogiri });
            expect(point.shanten, `${where} n=${point.n}`).toBe(sceneShantenOfTiles(table.hands[track.seat] as Tile[]));
            expect(table.board.rivers[track.seat]?.length, where).toBe(point.n);
            stats.points++;
          }
        }
      }
    }
    expect(stats.points).toBeGreaterThan(2000);
  });

  it('印を付ける打牌は、向聴数が初めて 0 になった打牌（聴牌を崩したあとは、また初めて 0 になった打牌）。鳴いて聴牌したときは、鳴いたあとの打牌。待ちは E-36 の計算と同じ', () => {
    for (const id of IDS) {
      const game = load(id);
      const log = game.report.mjai_log;
      for (const kyoku of game.kyokus) {
        const tracks = opponentTracksOf(game, kyoku.position);
        for (const track of tracks.seats) {
          const where = `${id} ${kyoku.label} 席${track.seat}`;
          // 折れ線から、印の位置を独立に求める（向聴数が 0 でない手から、0 になった打牌。最初の打牌は、配牌が聴牌でも区間の始まり）
          const expected: number[] = [];
          let inStretch = false;
          for (const point of track.points.slice(1)) {
            if (point.shanten === 0 && !inStretch) expected.push(point.n);
            inStretch = point.shanten === 0;
          }
          expect(track.marks.map((m) => m.n), where).toEqual(expected);
          // 最初の印は、向聴数が初めて 0 になった打牌
          const firstZero = track.points.slice(1).find((p) => p.shanten === 0);
          expect(track.marks[0]?.n, where).toBe(firstZero?.n);
          track.marks.forEach((mark: TenpaiMark, order) => {
            const point = track.points[mark.n] as (typeof track.points)[number];
            expect(mark.eventIndex, where).toBe(point.eventIndex);
            expect(mark.discard, where).toBe(point.discard);
            expect(mark.tsumogiri, where).toBe(point.tsumogiri);
            expect(mark.again, where).toBe(order > 0);
            // 経路: 直前の、その人のツモ・鳴き・カン
            const before = lastActionBefore(log, kyoku.startIndex, mark.eventIndex, track.seat);
            expect(before, where).not.toBeNull();
            switch (mark.route.kind) {
              case 'tsumo':
                expect(before, where).toMatchObject({ type: 'tsumo', pai: mark.route.drew });
                stats.tsumo++;
                break;
              case 'call':
                expect(before, where).toMatchObject({ type: mark.route.call, pai: mark.route.pai });
                stats[mark.route.call === 'chi' ? 'chi' : mark.route.call === 'pon' ? 'pon' : 'kan']++;
                break;
              case 'kan': {
                // 嶺上牌をツモった打牌（ankan・kakan・daiminkan のあと）。嶺上牌は、直前のツモ
                expect(before, where).toMatchObject({ type: 'tsumo', pai: mark.route.drew });
                const kanIndex = log.findLastIndex((e, i) => i < mark.eventIndex && i > kyoku.startIndex && 'actor' in e && e.actor === track.seat && ['ankan', 'kakan', 'daiminkan'].includes(e.type));
                expect((log[kanIndex] as MjaiEvent).type, where).toBe(mark.route.call);
                stats.kan++;
                break;
              }
            }
            // 待ち: 聴牌になった打牌のあとの手の、E-36 の待ちの計算（open-hands.ts の openSeatOf → wait-value.ts）と同じ
            const table = tableAt(log, kyoku.startIndex, mark.eventIndex, game.playerId);
            const seat = openSeatOf(table, track.seat);
            expect(seat.pending, where).toBe(false);
            expect(mark.waits, where).toEqual(seat.waits.map((w) => w.tile));
            expect(mark.waits.map(tileKind), where).toEqual([...mark.waits.map(tileKind)].sort((a, b) => a - b));
            if (mark.waits.length === 0) stats.emptyWaits++;
            if (mark.tsumogiri) stats.tsumogiri++;
            if (mark.again) stats.again++;
            stats.marks++;
          });
        }
      }
    }
    // 印が十分にあり、ツモ・チー・ポン・カンの経路と、聴牌の崩れ直しを含む（7 半荘で、印 110・ツモ 72・チー 26・ポン 11・カン 1・崩れ直し 1）。
    // ツモ切りの打牌では聴牌にならない（手が変わらない）ので、印の打牌は、いつも手出し
    expect(stats.marks).toBeGreaterThanOrEqual(100);
    expect(stats.tsumo).toBeGreaterThan(50);
    expect(stats.chi).toBeGreaterThan(10);
    expect(stats.pon).toBeGreaterThan(5);
    expect(stats.kan).toBeGreaterThanOrEqual(1);
    expect(stats.again).toBeGreaterThanOrEqual(1);
    expect(stats.tsumogiri).toBe(0);
    // 向聴数が 0 の手の待ちは、いつも 1 種類以上ある（4 枚とも自分の手にある空聴も、この 7 半荘には無い）
    expect(stats.emptyWaits).toBe(0);
  });
});
