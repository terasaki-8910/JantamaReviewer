import { describe, expect, it } from 'vitest';

import type { ImportedGame } from '../src/import';
import { importReportText } from '../src/import';
import { type MyKyokuTrack, type MyTrackSceneInput, myTrackOf } from '../src/my-track';
import { keyOfDecision } from '../src/problems';
import { listReplayScenes } from '../src/replay-scenes';
import { buildReplayTimeline } from '../src/replay-timeline';
import { tableAt } from '../src/replay';
import type { MjaiEvent, Seat, StartKyokuEvent } from '../src/report-types';
import { sceneShantenOfTiles } from '../src/scene-shanten';
import { type Tile, parseTenhouNotation } from '../src/tiles';
import { FX1_IDS, FX4_ID, FX5_ID, loadReportText } from './helpers/fixtures';

// F14・E-41（提案 7）: 自分の向聴数の推移（my-track.ts）。1 局を追って、配牌と自分が切るたびの場面の向聴数、聴牌になった打牌、
// その局の迷い・悪手の場面の位置を返す。
// 1. 手で作った局: 点の数え方（チー・ポンは点を作らない・カンは巡目が飛ぶ・リーチ）、聴牌の区間、場面を置く点（打牌・鳴き・和了・切らない局）
// 2. 固定データの 7 半荘: 全部の点が、場面の向聴数（E-21 と同じ数え方。判断の `Decision.shanten`・牌譜から独立に組んだ手）と一致し、
//    全部の迷い・悪手の場面が、その判断の巡目の点に乗る

const tiles = (text: string) => parseTenhouNotation(text);
const tile = (text: string): Tile => tiles(text)[0] as Tile;

/** 席 0 が親で、本人。本人の配牌と、ほかの 3 人の配牌（手牌の中身は、この試験では関係しない）。 */
function start(own: string): StartKyokuEvent {
  const idle = tiles('1m3m5m7m9m1p3p5p7p9p1s3s5s');
  return {
    type: 'start_kyoku',
    bakaze: 'E',
    dora_marker: '9s',
    kyoku: 1,
    honba: 0,
    kyotaku: 0,
    oya: 0,
    scores: [25000, 25000, 25000, 25000],
    tehais: [tiles(own), idle, idle, idle],
  };
}

/** 手で作った 1 局を、`myTrackOf` に渡せる形にする。 */
function gameOf(own: string, events: MjaiEvent[]): Pick<ImportedGame, 'report' | 'playerId' | 'kyokus'> {
  const log: MjaiEvent[] = [start(own), ...events];
  return { report: { mjai_log: log }, playerId: 0 as Seat, kyokus: [{ startIndex: 0, endIndex: log.length - 1 }] } as unknown as Pick<
    ImportedGame,
    'report' | 'playerId' | 'kyokus'
  >;
}

/** 場面。`eventIndex` は、その判断の直前の event の位置（盤面はその event を進めたあと）。 */
function scene(key: string, eventIndex: number, doubts: number[], mismatch: MyTrackSceneInput['mismatch'] = null, kyokuPosition = 0): MyTrackSceneInput {
  return { key, decision: { kyokuPosition, eventIndex }, doubts, mismatch };
}

const OTHER = (type: 'tsumo' | 'dahai', actor: 1 | 2 | 3, pai = '1z'): MjaiEvent =>
  type === 'tsumo' ? { type, actor, pai: tile(pai) } : { type, actor, pai: tile(pai), tsumogiri: true };

const seriesOf = (track: MyKyokuTrack) => track.points.map((p) => [p.n, p.shanten]);

describe('E-41 手で作った局: 点の数え方', () => {
  // 本人: 123m 456p 789s 東 南 白白（1 向聴）。東をツモって南を切ると、東東・白白の双碰で聴牌
  const OWN = '123m456p789s1z2z5z5z';

  it('配牌は n = 0。切るたびに、切る直前の手（ツモ牌を含む）の場面の向聴数。ツモだけの event は点にしない', () => {
    const track = myTrackOf(
      gameOf(OWN, [
        { type: 'tsumo', actor: 0, pai: tile('1z') },
        { type: 'dahai', actor: 0, pai: tile('2z'), tsumogiri: false },
        OTHER('tsumo', 1),
        OTHER('dahai', 1),
      ]),
      0,
      [],
    );
    // 配牌（13 枚）は 1 向聴。1 巡目は、東をツモったあとの 14 枚から、いちばん進む打牌（南）のあとの 0（聴牌）
    expect(seriesOf(track)).toEqual([
      [0, 1],
      [1, 0],
    ]);
    expect(track.points[0]).toMatchObject({ eventIndex: 0, discard: null });
    expect(track.points[1]).toMatchObject({ eventIndex: 2, discard: tile('2z'), tsumogiri: false });
    expect(track.tenpai).toEqual([{ n: 1, again: false }]);
  });

  it('場面の向聴数は、実際に切った牌ではなく、いちばん進む打牌のあとの数（切った牌が最善でなくても、値は同じ）', () => {
    const track = myTrackOf(
      gameOf(OWN, [
        { type: 'tsumo', actor: 0, pai: tile('1z') },
        // 最善は南切り（聴牌）だが、実際は 1m を切る
        { type: 'dahai', actor: 0, pai: tile('1m'), tsumogiri: false },
      ]),
      0,
      [],
    );
    expect(track.points[1]).toMatchObject({ n: 1, discard: tile('1m'), shanten: 0 });
    expect(track.points[1]?.shanten).toBe(sceneShantenOfTiles(tiles('123m456p789s1z2z5z5z1z')));
  });

  it('チー・ポンは点を作らない。鳴いたあとの打牌が、その巡目の点になる（巡目は、ツモとチー・ポンで 1 つずつ増える）。他家の event は点にしない', () => {
    // 本人: 23m 456p 789s 234s 白 中（1 向聴）。席 1 の 1m をチーして、中を切る
    const track = myTrackOf(
      gameOf('23m456p789s234s5z7z', [
        OTHER('tsumo', 1),
        { type: 'dahai', actor: 1, pai: tile('1m'), tsumogiri: false },
        { type: 'chi', actor: 0, target: 1, pai: tile('1m'), consumed: [tile('2m'), tile('3m')] },
        { type: 'dahai', actor: 0, pai: tile('7z'), tsumogiri: false },
        OTHER('tsumo', 1),
        { type: 'dahai', actor: 1, pai: tile('3m'), tsumogiri: false },
        { type: 'tsumo', actor: 0, pai: tile('9m') },
        { type: 'dahai', actor: 0, pai: tile('9m'), tsumogiri: true },
      ]),
      0,
      [],
    );
    // 点は、打牌の数（2 つ）に配牌。チーの event 自体の点は無い。1 巡目はチー、2 巡目はツモ（巡目は連続）
    expect(track.points.map((p) => p.n)).toEqual([0, 1, 2]);
    expect(track.points.map((p) => p.eventIndex)).toEqual([0, 4, 8]);
    expect(track.points[1]).toMatchObject({ discard: tile('7z'), tsumogiri: false });
    // 鳴いたあとの手は 11 枚（3n+2）。向聴数は、中を切ったあとの聴牌（白の単騎）
    expect(seriesOf(track)).toEqual([
      [0, 1],
      [1, 0],
      [2, 0],
    ]);
  });

  it('カン（暗槓）は、嶺上牌のツモで巡目が 1 つ増えるが、点は打牌ごとに 1 つ。カンのあとの打牌は、巡目が 1 つ飛ぶ', () => {
    // 本人: 1111m 456p 789s 白白 發。東をツモって、1m を暗槓し、嶺上牌の發をツモって、東を切る
    const track = myTrackOf(
      gameOf('1111m456p789s5z5z6z', [
        { type: 'tsumo', actor: 0, pai: tile('1z') },
        { type: 'ankan', actor: 0, consumed: [tile('1m'), tile('1m'), tile('1m'), tile('1m')] },
        { type: 'tsumo', actor: 0, pai: tile('6z') },
        { type: 'dahai', actor: 0, pai: tile('1z'), tsumogiri: false },
        OTHER('tsumo', 1),
        OTHER('dahai', 1),
        { type: 'tsumo', actor: 0, pai: tile('9p') },
        { type: 'dahai', actor: 0, pai: tile('9p'), tsumogiri: true },
      ]),
      0,
      [],
    );
    expect(track.points.map((p) => p.n)).toEqual([0, 2, 3]);
    expect(track.points.map((p) => p.eventIndex)).toEqual([0, 4, 8]);
  });

  it('聴牌の区間ごとに、最初の打牌に印（2 つ目以降は again）。聴牌が続く間は増やさない。最善でない打牌で聴牌を崩し、ツモで戻らなければ、向聴数が上がる。配牌が聴牌なら、最初の打牌が最初の区間の始まり', () => {
    const track = myTrackOf(
      gameOf(OWN, [
        // 1 巡目: 南を切って聴牌（東東・白白）。2 巡目: 9m のツモ切りでも聴牌のまま（印は増えない）
        { type: 'tsumo', actor: 0, pai: tile('1z') },
        { type: 'dahai', actor: 0, pai: tile('2z'), tsumogiri: false },
        { type: 'tsumo', actor: 0, pai: tile('9m') },
        { type: 'dahai', actor: 0, pai: tile('9m'), tsumogiri: true },
        // 3 巡目: 場面は聴牌（9p を切れば聴牌のまま）だが、実際は東を切って、聴牌を崩す
        { type: 'tsumo', actor: 0, pai: tile('9p') },
        { type: 'dahai', actor: 0, pai: tile('1z'), tsumogiri: false },
        // 4 巡目: 5m をツモっても、聴牌に戻れない（1 向聴）
        { type: 'tsumo', actor: 0, pai: tile('5m') },
        { type: 'dahai', actor: 0, pai: tile('5m'), tsumogiri: true },
        // 5 巡目: 東をツモって 9p を切ると、また聴牌（2 つ目の区間）
        { type: 'tsumo', actor: 0, pai: tile('1z') },
        { type: 'dahai', actor: 0, pai: tile('9p'), tsumogiri: false },
      ]),
      0,
      [],
    );
    expect(seriesOf(track)).toEqual([
      [0, 1],
      [1, 0],
      [2, 0],
      [3, 0],
      [4, 1],
      [5, 0],
    ]);
    expect(track.tenpai).toEqual([
      { n: 1, again: false },
      { n: 5, again: true },
    ]);

    // 配牌が聴牌のとき: 配牌の点は 0（聴牌）。最初の打牌が、最初の区間の始まり
    const dealt = myTrackOf(
      gameOf('123m456p789s1155z', [
        { type: 'tsumo', actor: 0, pai: tile('9m') },
        { type: 'dahai', actor: 0, pai: tile('9m'), tsumogiri: true },
      ]),
      0,
      [],
    );
    expect(seriesOf(dealt)).toEqual([
      [0, 0],
      [1, 0],
    ]);
    expect(dealt.tenpai).toEqual([{ n: 1, again: false }]);
  });

});

describe('E-41 手で作った局: 場面を置く点', () => {
  const OWN = '123m456p789s1z2z5z5z';
  // event: 0 配牌, 1 本人ツモ, 2 本人打牌（1 巡目）, 3 席 1 ツモ, 4 席 1 打牌, 5 本人ツモ, 6 本人打牌（2 巡目）, 7 席 1 打牌, 8 本人ツモ, 9 本人打牌（3 巡目）
  const game = gameOf(OWN, [
    { type: 'tsumo', actor: 0, pai: tile('1z') },
    { type: 'dahai', actor: 0, pai: tile('2z'), tsumogiri: false },
    OTHER('tsumo', 1),
    OTHER('dahai', 1),
    { type: 'tsumo', actor: 0, pai: tile('9m') },
    { type: 'dahai', actor: 0, pai: tile('9m'), tsumogiri: true },
    OTHER('dahai', 1, '3m'),
    { type: 'tsumo', actor: 0, pai: tile('9p') },
    { type: 'dahai', actor: 0, pai: tile('9p'), tsumogiri: true },
  ]);

  it('打牌の判断（ツモの event の直後）は、そのあとの打牌の点。迷いの丸と悪手の菱形は、同じ判断なら両方', () => {
    const track = myTrackOf(game, 0, [scene('a', 1, [3], 'big'), scene('b', 5, [1]), scene('c', 8, [], 'big')]);
    expect(track.scenes.map((s) => [s.scene.key, s.n, s.doubt, s.big])).toEqual([
      ['a', 1, true, true],
      ['b', 2, true, false],
      ['c', 3, false, true],
    ]);
  });

  it('鳴きの判断（他家の打牌の直後）は、次の自分の打牌の点。切る打牌がもう無い判断（最後の打牌のあと）は、最後の点', () => {
    const track = myTrackOf(game, 0, [scene('call', 4, [2]), scene('late', 9, [], 'big')]);
    expect(track.scenes.map((s) => [s.scene.key, s.n])).toEqual([
      ['call', 2],
      ['late', 3],
    ]);
    // 配牌の直後（本人の最初の打牌の前。他家の打牌への判断）は 1 巡目
    expect(myTrackOf(game, 0, [scene('first', 0, [1])]).scenes.map((s) => s.n)).toEqual([1]);
  });

  it('悪手でない不一致（other）と、迷いでも不一致でもない場面と、ほかの局の場面は、置かない。同じ点の場面は判断の順', () => {
    const track = myTrackOf(game, 0, [
      scene('other', 1, [], 'other'),
      scene('none', 1, []),
      scene('elsewhere', 1, [1], 'big', 1),
      scene('second', 5, [], 'big'),
      scene('first', 4, [1]),
    ]);
    expect(track.scenes.map((s) => [s.scene.key, s.n])).toEqual([
      ['first', 2],
      ['second', 2],
    ]);
  });

  it('切った打牌が 1 つも無い局（和了・流局が先）は、配牌の点だけ。場面は、配牌の点に置く。局が無ければ空', () => {
    const none = myTrackOf(gameOf(OWN, [OTHER('tsumo', 1), OTHER('dahai', 1)]), 0, [scene('x', 2, [1])]);
    expect(seriesOf(none)).toEqual([[0, 1]]);
    expect(none.tenpai).toEqual([]);
    expect(none.scenes.map((s) => s.n)).toEqual([0]);
    const empty = myTrackOf({ report: { mjai_log: [] }, playerId: 0, kyokus: [] } as unknown as ImportedGame, 3, []);
    expect(empty).toEqual({ kyokuPosition: 3, points: [], tenpai: [], scenes: [] });
  });
});

// ---- 固定データ ----

const IDS = [...FX1_IDS, FX4_ID, FX5_ID] as const;

function load(id: string): ImportedGame {
  const game = importReportText(loadReportText(id));
  if (!game.ok) throw new Error(game.error.message);
  return game.value;
}

/** 迷いの結びつけの代わり: FX-4 は結びつけた判断の鍵、それ以外は、判断の種類ごとに最初の判断（鳴き・リーチ・カン・和了を含む）。 */
const FX4_MARKS = ['k0h0e4', 'k1h0e12', 'k1h1e7', 'k1h1e10', 'k2h1e6', 'k2h1e14'];

function marksOf(game: ImportedGame, id: string): string[] {
  if (id === FX4_ID) return FX4_MARKS;
  const keys: string[] = [];
  const seen = new Set<string>();
  for (const decision of game.decisions) {
    // 局ごとに、種類ごとの最初の判断（局の数 × 種類で、場面が十分な数になる）
    const tag = `${decision.kyokuPosition}:${decision.kind}`;
    if (seen.has(tag)) continue;
    seen.add(tag);
    keys.push(keyOfDecision(decision));
  }
  return keys;
}

/** 牌譜から独立に求める: 局の中の、自分の打牌の event の位置。 */
function myDiscardsOf(game: ImportedGame, startIndex: number, endIndex: number): number[] {
  const log = game.report.mjai_log;
  const out: number[] = [];
  for (let i = startIndex + 1; i <= endIndex; i++) {
    const event = log[i] as MjaiEvent;
    if (event.type === 'dahai' && event.actor === game.playerId) out.push(i);
  }
  return out;
}

describe('E-41 固定データの 7 半荘: 折れ線の点と印', () => {
  const stats = { points: 0, decisionChecks: 0, calls: 0, kyokusWithCall: 0, kyokusWithKan: 0, tenpaiMarks: 0, again: 0, junmeJumps: 0 };

  it('折れ線の各点の向聴数は、その場面の向聴数（E-21 と同じ数え方）と一致する。点は、自分の打牌ごとに 1 つ（鳴いても増えない）で、配牌は n = 0', () => {
    for (const id of IDS) {
      const game = load(id);
      const log = game.report.mjai_log;
      const me = game.playerId;
      for (const kyoku of game.kyokus) {
        const where = `${id} ${kyoku.label}`;
        const track = myTrackOf(game, kyoku.position, []);
        const discards = myDiscardsOf(game, kyoku.startIndex, kyoku.endIndex);
        // 点 = 配牌 + 自分の打牌の数。n は増える一方（鳴いても、ツモ牌の数え違いで増減しない）
        expect(track.points.length - 1, where).toBe(discards.length);
        expect(track.points.map((p) => p.eventIndex).slice(1), where).toEqual(discards);
        expect(track.points.map((p) => p.n), where).toEqual([...track.points.map((p) => p.n)].sort((a, b) => a - b));
        expect(new Set(track.points.map((p) => p.n)).size, where).toBe(track.points.length);
        // 配牌
        const deal = tableAt(log, kyoku.startIndex, kyoku.startIndex, me);
        expect(track.points[0], where).toMatchObject({ n: 0, eventIndex: kyoku.startIndex, discard: null });
        expect(track.points[0]?.shanten, where).toBe(sceneShantenOfTiles(deal.hands[me] as Tile[]));
        let jumps = 0;
        for (const point of track.points.slice(1)) {
          // 切る直前の卓から、独立に数える（ツモ牌・鳴いたあとの手を含む 3n+2 枚）
          const before = tableAt(log, kyoku.startIndex, point.eventIndex - 1, me);
          const hand = before.hands[me] as Tile[];
          expect(hand.length % 3, `${where} n=${point.n}`).toBe(2);
          expect(point.shanten, `${where} n=${point.n}`).toBe(sceneShantenOfTiles(hand));
          expect(point.n, `${where} n=${point.n}`).toBe(before.board.junme);
          expect(log[point.eventIndex], where).toMatchObject({ type: 'dahai', actor: me, pai: point.discard, tsumogiri: point.tsumogiri });
          stats.points++;
        }
        // カンのあとは、巡目が 1 つ飛ぶ（点の数は打牌の数のまま）
        for (let i = 1; i < track.points.length; i++) {
          const gap = (track.points[i] as { n: number }).n - (track.points[i - 1] as { n: number }).n;
          if (i > 1 && gap > 1) jumps++;
        }
        const kanned = log.slice(kyoku.startIndex, kyoku.endIndex + 1).some((e) => (e.type === 'ankan' || e.type === 'kakan' || e.type === 'daiminkan') && e.actor === me);
        if (kanned) stats.kyokusWithKan++;
        else expect(jumps, `${where}: カンの無い局は、巡目が飛ばない`).toBe(0);
        stats.junmeJumps += jumps;
        const called = log.slice(kyoku.startIndex, kyoku.endIndex + 1).filter((e) => (e.type === 'chi' || e.type === 'pon') && e.actor === me).length;
        if (called > 0) stats.kyokusWithCall++;
        stats.calls += called;
      }
    }
    // 鳴いた局・カンをした局を含む（7 半荘で、自分の打牌 969・チー・ポンのある局・カンのある局がある）
    expect(stats.points).toBeGreaterThan(900);
    expect(stats.kyokusWithCall).toBeGreaterThan(10);
    expect(stats.calls).toBeGreaterThan(20);
    expect(stats.kyokusWithKan).toBeGreaterThanOrEqual(1);
    expect(stats.junmeJumps).toBeGreaterThanOrEqual(1);
  });

  it('打牌・リーチの判断の向聴数（Decision.shanten。E-21）は、その判断の巡目の点の向聴数と一致する。巡目は判断の巡目（記録のまま）と同じ', () => {
    for (const id of IDS) {
      const game = load(id);
      for (const kyoku of game.kyokus) {
        const track = myTrackOf(game, kyoku.position, []);
        for (const decision of kyoku.decisions) {
          // 3n+2 枚の手で、そのあとに自分が切る打牌の判断（カン・和了の判断は、切る手が別の手になるので、対象にしない）
          const discarding = decision.kind === 'discard' || decision.kind === 'riichi' || (decision.kind === 'kan' && decision.entry.actual.type === 'dahai');
          if (!discarding) continue;
          const point = track.points.slice(1).find((p) => p.eventIndex > decision.eventIndex);
          const where = `${id} ${decision.kyokuLabel} ${decision.junme}巡目 ${decision.kind}`;
          expect(point, where).toBeDefined();
          expect(point?.shanten, where).toBe(decision.shanten);
          expect(point?.n, where).toBe(decision.junme);
          stats.decisionChecks++;
        }
      }
    }
    expect(stats.decisionChecks).toBeGreaterThan(700);
  });

  it('聴牌になった打牌は、場面の向聴数が 0 でない点から 0 になった点（聴牌の区間ごとに最初の 1 つ。最初の打牌は、配牌が聴牌でも区間の始まり）', () => {
    for (const id of IDS) {
      const game = load(id);
      for (const kyoku of game.kyokus) {
        const where = `${id} ${kyoku.label}`;
        const track = myTrackOf(game, kyoku.position, []);
        const expected: number[] = [];
        let inStretch = false;
        for (const point of track.points.slice(1)) {
          if (point.shanten === 0 && !inStretch) expected.push(point.n);
          inStretch = point.shanten === 0;
        }
        expect(track.tenpai.map((m) => m.n), where).toEqual(expected);
        expect(track.tenpai.map((m) => m.again), where).toEqual(expected.map((_, i) => i > 0));
        // 最初の印は、初めて 0 になった点
        expect(track.tenpai[0]?.n, where).toBe(track.points.slice(1).find((p) => p.shanten === 0)?.n);
        stats.tenpaiMarks += track.tenpai.length;
        stats.again += track.tenpai.filter((m) => m.again).length;
      }
    }
    expect(stats.tenpaiMarks).toBeGreaterThan(15);
  });
});

describe('E-41 固定データの 7 半荘: 迷い・悪手の印は、その場面の巡目に乗る', () => {
  it('全部の迷い・悪手の場面が、置いた点に 1 つずつ乗る。その点は、判断のあとに自分が最初に切る打牌（打牌・リーチの判断は、判断の巡目と同じ）', () => {
    const counts = { doubts: 0, bigs: 0, both: 0, calls: 0, discards: 0, clamped: 0, kinds: new Set<string>() };
    for (const id of IDS) {
      const game = load(id);
      const timeline = buildReplayTimeline(game);
      const scenes = listReplayScenes(timeline, game.decisions, { markKeys: marksOf(game, id) });
      const wanted = scenes.filter((s) => s.doubts.length > 0 || s.mismatch === 'big');
      const placed = new Set<string>();
      for (const kyoku of game.kyokus) {
        const track = myTrackOf(game, kyoku.position, scenes);
        const discards = myDiscardsOf(game, kyoku.startIndex, kyoku.endIndex);
        for (const item of track.scenes) {
          const { decision } = item.scene;
          const where = `${id} ${decision.kyokuLabel} ${decision.junme}巡目 ${decision.kind}`;
          expect(decision.kyokuPosition, where).toBe(kyoku.position);
          expect(item.doubt, where).toBe(item.scene.doubts.length > 0);
          expect(item.big, where).toBe(item.scene.mismatch === 'big');
          // 牌譜から独立に: その判断のあとに自分が最初に切る打牌（無ければ最後の打牌、それも無ければ配牌）
          const next = discards.find((index) => index > decision.eventIndex);
          const expected = next ?? discards[discards.length - 1];
          const expectedN = expected === undefined ? 0 : (track.points.find((p) => p.eventIndex === expected) as { n: number }).n;
          expect(item.n, where).toBe(expectedN);
          if (next === undefined) counts.clamped++;
          // 打牌・リーチの判断は、判断の巡目（記録のまま）と同じ点
          if (decision.kind === 'discard' || decision.kind === 'riichi') {
            expect(item.n, where).toBe(decision.junme);
            counts.discards++;
          }
          if (decision.kind === 'call') counts.calls++;
          counts.kinds.add(decision.kind);
          if (item.doubt) counts.doubts++;
          if (item.big) counts.bigs++;
          if (item.doubt && item.big) counts.both++;
          placed.add(item.scene.key);
        }
      }
      // 置かれなかった場面は無い（迷い・悪手の場面は、全部どこかの局に乗る）
      expect([...placed].sort(), id).toEqual(wanted.map((s) => s.key).sort());
      // 点は 1 つの局の中だけ。ほかの局の場面を混ぜない
      for (const kyoku of game.kyokus) {
        for (const item of myTrackOf(game, kyoku.position, scenes).scenes) expect(item.scene.decision.kyokuPosition).toBe(kyoku.position);
      }
    }
    // 迷い・悪手・両方・鳴きの判断・打牌の判断を含み、判断の種類も複数
    expect(counts.doubts).toBeGreaterThan(30);
    expect(counts.bigs).toBeGreaterThan(30);
    expect(counts.both).toBeGreaterThanOrEqual(1);
    expect(counts.calls).toBeGreaterThanOrEqual(3);
    expect(counts.discards).toBeGreaterThan(30);
    expect(counts.kinds.size).toBeGreaterThanOrEqual(3);
  });
});


