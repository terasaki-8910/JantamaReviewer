import { describe, expect, it } from 'vitest';

import type { Decision } from '../src/decision';
import { importReportText } from '../src/import';
import type { ImportedGame } from '../src/import';
import { coreTenpaiWaits } from '../src/majiang-adapter';
import { type OpenSeat, openHandsAt, openSeatsOf, otherSeats } from '../src/open-hands';
import { KyokuReplayer, tableAt } from '../src/replay';
import { buildReplayTimeline } from '../src/replay-timeline';
import type { MjaiEvent, StartKyokuEvent } from '../src/report-types';
import { parseTenhouNotation } from '../src/tiles';
import { FX1_IDS, FX4_ID, FX5_ID, loadReportText } from './helpers/fixtures';

// F14・E-40・U-35 の土台: 他家の手牌（open-hands.ts）。ある時点の卓（他家の手牌を含む）から、他家 3 人の閉じた手牌・副露・リーチと、
// 聴牌している人の待ち（待ちの形・残り・その人が実際に付けている立直で数えたロンの点）を作る。
// 1. 手で作った局: 待ちの形・残り（全員の手牌を開いたうえで場に見えていない枚数）・立直とダマ・切る前の手（待ちを出さない）・フリテン
// 2. 固定データの全判断・全手: 枚数・副露・リーチが盤面と合い、待ちが majiang-core の待ちと一致する
// 3. 承認済みの見本（15回目の「他家の手牌を開く」）と同じ値になる場面

const IDS = [...FX1_IDS, FX4_ID, FX5_ID];

function load(id: string): ImportedGame {
  const game = importReportText(loadReportText(id));
  if (!game.ok) throw new Error(game.error.message);
  return game.value;
}

function decisionOf(game: ImportedGame, label: string, entryIndex: number): Decision {
  const found = game.decisions.find((d) => d.kyokuLabel === label && d.entryIndex === entryIndex);
  if (found === undefined) throw new Error(`判断が見つかりません: ${label} ${entryIndex}`);
  return found;
}

const tiles = (text: string) => parseTenhouNotation(text);

/** 席 0 が親、本人は席 0。席 1〜3 の配牌を渡す（本人の手牌は、配牌の枚数だけ合っていればよい）。 */
function start(hands: [string, string, string], overrides: Partial<StartKyokuEvent> = {}): StartKyokuEvent {
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
    ...overrides,
  };
}

function run(startEvent: StartKyokuEvent, events: MjaiEvent[]) {
  const log: MjaiEvent[] = [startEvent, ...events];
  return tableAt(log, 0, events.length, 0);
}

describe('F14 他家の手牌: 手で作った局', () => {
  it('聴牌している人は、待ちの形・残り・ダマのロンの点が出る。双碰は「双碰」、七対子は単騎、聴牌していない人は待ちが空', () => {
    // 席 1: 123m 456p 789s 東東 白白（東・白の双碰）。席 2: 聴牌していない。席 3: 七対子（中の単騎）
    const table = run(start(['123m456p789s1155z', '1m3m5m7m9m1p3p5p7p9p1s3s5s', '1122m3344p5566s7z']), []);
    const [one, two, three] = openSeatsOf(table, 0) as [OpenSeat, OpenSeat, OpenSeat];
    expect(otherSeats(0)).toEqual([1, 2, 3]);
    expect(one.seat).toBe(1);
    expect(one.waits.map((w) => w.tile)).toEqual(['E', 'P']);
    expect(one.shape).toBe('双碰');
    expect(one.waits.every((w) => w.shapes.join() === '双碰' && w.stand === 'dama')).toBe(true);
    expect(two.waits).toEqual([]);
    expect(two.shape).toBe('');
    expect(three.waits.map((w) => w.tile)).toEqual(['C']);
    expect(three.waits[0]?.shapes).toEqual(['単騎']);
    expect(three.waits[0]?.ron.fu).toBe(25);
    // 残り: 全員の手牌を開いたうえで、場に見えていない枚数（ドラ表示牌 9s も見えている牌）。
    // 東: 席 1 の手に 2 枚、本人の手に 1 枚 → 残り 1。白: 席 1 の手に 2 枚 → 残り 2。中: 席 3 の手に 1 枚 → 残り 3
    expect(one.waits.map((w) => w.remaining)).toEqual([1, 2]);
    expect(three.waits[0]?.remaining).toBe(3);
  });

  it('リーチを宣言している人は、立直で数えた点が出る（ダマの七対子 2 飜に、立直の 1 飜）', () => {
    // 席 3: 七対子（中の単騎）。8m をツモってリーチを宣言し、ツモ切りして、リーチが成立した
    const events: MjaiEvent[] = [
      { type: 'tsumo', actor: 3, pai: '8m' },
      { type: 'reach', actor: 3 },
      { type: 'dahai', actor: 3, pai: '8m', tsumogiri: true },
      { type: 'reach_accepted', actor: 3 },
    ];
    const hands: [string, string, string] = ['123m456p789s1155z', '1m3m5m7m9m1p3p5p7p9p1s3s5s', '1m1m2m2m3p3p4p4p5s5s6s6s7z'];
    const declared = openSeatsOf(run(start(hands), events.slice(0, 2)), 0)[2] as OpenSeat;
    expect(declared.riichi).toBe('declared');
    expect(declared.pending).toBe(true);
    const accepted = openSeatsOf(run(start(hands), events), 0)[2] as OpenSeat;
    expect(accepted.riichi).toBe('accepted');
    expect(accepted.waits.map((w) => [w.tile, w.stand, w.ron.han, w.ron.fu])).toEqual([['C', 'riichi', 3, 25]]);
  });
});

describe('F14 他家の手牌: 固定データの全判断・全手で、盤面と合い、待ちが majiang-core の待ちと一致する', () => {
  it('全判断の時点: 3 人の枚数・副露・リーチの状態が盤面と同じで、切る前でない人の待ちは、majiang-core の待ちと同じ（フリテン・残りも妥当）', () => {
    let checked = 0;
    let tenpai = 0;
    let riichi = 0;
    for (const id of IDS) {
      const game = load(id);
      for (const d of game.decisions) {
        const seats = openHandsAt(game, d.kyokuPosition, d.eventIndex);
        expect(seats.map((s) => s.seat), `${id} ${d.kyokuLabel} ${d.entryIndex}`).toEqual(otherSeats(game.playerId));
        for (const s of seats) checkSeat(`${id} ${d.kyokuLabel} #${d.entryIndex}`, s, d.board.handCounts[s.seat] as number, d);
        checked += seats.length;
        tenpai += seats.filter((s) => s.waits.length > 0).length;
        riichi += seats.filter((s) => s.riichi !== 'none').length;
      }
    }
    expect(checked).toBeGreaterThan(2000);
    // 聴牌している人・リーチしている人を含む（含まなければ、待ちの確かめにならない）
    expect(tenpai).toBeGreaterThan(300);
    expect(riichi).toBeGreaterThan(100);
  });

  it('通して見る画面の全手（他家の打牌・鳴き・カン・リーチ・局の終わり）でも、同じ（手の盤面と合う）', () => {
    let steps = 0;
    let pending = 0;
    for (const id of IDS) {
      const game = load(id);
      const timeline = buildReplayTimeline(game);
      for (const step of timeline.steps) {
        const seats = openHandsAt(game, step.kyokuPosition, step.eventIndex);
        for (const s of seats) {
          checkSeat(`${id} 手${step.index}（${step.kind}）`, s, step.board.handCounts[s.seat] as number, null);
          if (s.pending) pending++;
        }
        steps++;
      }
    }
    expect(steps).toBeGreaterThan(5000);
    // 切る前の手（リーチ宣言・チー・ポン・ツモ和了の局の終わり）を含む
    expect(pending).toBeGreaterThan(50);
  });

  it('本人の判断の盤面（BoardState）には、他家の手牌が入らない（手牌は本人の分だけ。他家は枚数だけ）', () => {
    const game = load(FX4_ID);
    for (const d of game.decisions) {
      expect(Object.keys(d.board).filter((key) => /^(hands|openHands|tehais?)$/.test(key))).toEqual([]);
      expect(d.board.handCounts).toHaveLength(4);
    }
  });
});

/** 席 1 人の確かめ。`handCount` は盤面の閉じた手牌の枚数（ツモ牌を含む）。 */
function checkSeat(name: string, s: OpenSeat, handCount: number, decision: Decision | null): void {
  expect(s.hand.length + (s.drawn === null ? 0 : 1), name).toBe(handCount);
  expect(s.pending, name).toBe(handCount % 3 === 2);
  expect(s.dealer, name).toBe(decision === null ? s.dealer : decision.board.oya === s.seat);
  if (decision !== null) {
    expect(s.melds, name).toEqual(decision.board.melds[s.seat]);
    expect(s.riichi, name).toBe(decision.board.riichi[s.seat]);
    expect(s.wind, name).toBe(decision.board.seatWinds[s.seat]);
  }
  if (s.pending) {
    expect(s.waits, name).toEqual([]);
    return;
  }
  const kinds = coreTenpaiWaits(s.hand, s.melds, s.seat);
  expect(s.waits.map((w) => w.kind), name).toEqual(kinds);
  for (const w of s.waits) {
    expect(w.remaining, name).toBeGreaterThanOrEqual(0);
    expect(w.remaining, name).toBeLessThanOrEqual(4);
    expect(w.shapes.length, name).toBeGreaterThan(0);
    // リーチを宣言している人は、立直で数える。副露している人は、ダマ（リーチできない）
    expect(w.stand, name).toBe(s.riichi !== 'none' ? 'riichi' : 'dama');
    if (!w.ron.none) {
      expect(w.ron.han + w.ron.yakuman, name).toBeGreaterThan(0);
      expect(w.ron.base, name).toBeGreaterThan(0);
    }
  }
}

describe('F14 他家の手牌: 承認済みの見本（15回目「他家の手牌を開く」）と同じ値', () => {
  it('FX-4 東3局 5巡目: 親（対面）は 4s・7s 待ちの聴牌（ダマ）。4s は残り 1・4飜 50符 12,000、7s は残り 4・役なし。ほかの 2 人は聴牌していない', () => {
    const game = load(FX4_ID);
    const d = decisionOf(game, '東3局', 4);
    const [down, across, up] = openHandsAt(game, d.kyokuPosition, d.eventIndex) as [OpenSeat, OpenSeat, OpenSeat];
    expect(down.waits).toEqual([]);
    expect(up.waits).toEqual([]);
    expect(across.dealer).toBe(true);
    expect(across.wind).toBe('E');
    expect(across.riichi).toBe('none');
    const [s4, s7] = across.waits;
    expect([s4?.tile, s4?.shapes, s4?.remaining, s4?.stand, s4?.ron.han, s4?.ron.fu, s4?.ron.base]).toEqual(['4s', ['両面'], 1, 'dama', 4, 50, 12000]);
    expect([s7?.tile, s7?.shapes, s7?.remaining, s7?.ron.none]).toEqual(['7s', ['両面'], 4, true]);
  });

  it('FX-4 東1局 13巡目: 上家はリーチして、發（中の隣の字牌）の単騎待ち（七対子）。残り 2・立直で 4飜 25符 6,400', () => {
    const game = load(FX4_ID);
    const d = decisionOf(game, '東1局', 13);
    const [down, across, up] = openHandsAt(game, d.kyokuPosition, d.eventIndex) as [OpenSeat, OpenSeat, OpenSeat];
    expect(down.waits).toEqual([]);
    expect(across.waits).toEqual([]);
    expect(up.riichi).toBe('accepted');
    const [wait] = up.waits;
    expect([wait?.tile, wait?.shapes, wait?.remaining, wait?.stand, wait?.ron.han, wait?.ron.fu, wait?.ron.base]).toEqual(['F', ['単騎'], 2, 'riichi', 4, 25, 6400]);
  });

  it('FX-5 東4局 8巡目: 下家がリーチ（1m・4m 待ち）。1m は残り 2・3飜 30符 3,900、4m は両面／嵌張で残り 2・4飜 30符 7,700。親は聴牌していない', () => {
    const game = load(FX5_ID);
    const d = decisionOf(game, '東4局', 8);
    const [down, across, up] = openHandsAt(game, d.kyokuPosition, d.eventIndex) as [OpenSeat, OpenSeat, OpenSeat];
    expect(down.riichi).toBe('accepted');
    expect(across.waits).toEqual([]);
    expect(up.dealer).toBe(true);
    expect(up.waits).toEqual([]);
    const [m1, m4] = down.waits;
    expect([m1?.tile, m1?.shapes, m1?.remaining, m1?.ron.han, m1?.ron.fu, m1?.ron.base]).toEqual(['1m', ['両面'], 2, 3, 30, 3900]);
    expect([m4?.tile, m4?.shapes, m4?.remaining, m4?.ron.han, m4?.ron.fu, m4?.ron.base]).toEqual(['4m', ['両面', '嵌張'], 2, 4, 30, 7700]);
  });
});

describe('F14 他家の手牌: 切る前の手・副露・フリテン', () => {
  it('他家がポンしたあと（切る前の 3n+2 枚）は、待ちを出さない（pending）。切ったあとは待ちが出る', () => {
    const startEvent = start(['1m1m2m3m4p5p6p7s8s9s3z3z4z', '2m3m4m5p5p6p7p3s4s5s6s6s9s', '1m1m1p1p2p2p3p3p4p4p5p5p6p']);
    const base: MjaiEvent[] = [
      { type: 'tsumo', actor: 0, pai: 'W' },
      { type: 'dahai', actor: 0, pai: 'W', tsumogiri: true },
      { type: 'pon', actor: 1, target: 0, pai: 'W', consumed: ['W', 'W'] },
    ];
    const afterPon = openSeatsOf(run(startEvent, base), 0);
    expect(afterPon[0]?.pending).toBe(true);
    expect(afterPon[0]?.waits).toEqual([]);
    expect(afterPon[0]?.melds).toHaveLength(1);
    expect(afterPon[0]?.hand).toHaveLength(11);
    const afterDiscard = openSeatsOf(run(startEvent, [...base, { type: 'dahai', actor: 1, pai: 'N', tsumogiri: false }]), 0);
    expect(afterDiscard[0]?.pending).toBe(false);
    expect(afterDiscard[0]?.hand).toHaveLength(10);
  });

  it('ツモってまだ切っていない牌は drawn に分ける（手牌は並べ替え済みで、ツモ牌を含まない）', () => {
    const startEvent = start(['1m1m2m3m4p5p6p7s8s9s3z3z4z', '2m3m4m5p5p6p7p3s4s5s6s6s9s', '1m1m1p1p2p2p3p3p4p4p5p5p6p']);
    const table = run(startEvent, [
      { type: 'tsumo', actor: 0, pai: 'E' },
      { type: 'dahai', actor: 0, pai: 'E', tsumogiri: true },
      { type: 'tsumo', actor: 1, pai: '1m' },
    ]);
    const seat = openSeatsOf(table, 0)[0] as OpenSeat;
    expect(seat.drawn).toBe('1m');
    expect(seat.hand).toEqual(tiles('1m1m2m3m4p5p6p7s8s9s3z3z4z'));
    expect(seat.pending).toBe(true);
    expect(seat.hand).toHaveLength(13);
  });

  it('その人の河にある牌と、リーチのあとに通った牌が待ちなら、フリテン', () => {
    // 席 1: 123m 456p 789s 東東 白白（東・白の双碰）。東を 1 枚ツモ切りしたので、河に東がある
    const startEvent = start(['1m2m3m4p5p6p7s8s9s1z1z5z5z', '2m3m4m5p5p6p7p3s4s5s6s6s9s', '1m1m1p1p2p2p3p3p4p4p5p5p6p']);
    const replayer = new KyokuReplayer(startEvent, 0);
    const events: MjaiEvent[] = [
      { type: 'tsumo', actor: 1, pai: 'E' },
      { type: 'dahai', actor: 1, pai: 'E', tsumogiri: true },
    ];
    events.forEach((e, i) => replayer.apply(e, i + 1));
    const table = replayer.table();
    const seat = openSeatsOf(table, 0)[0] as OpenSeat;
    expect(seat.hand.length + (seat.drawn === null ? 0 : 1)).toBe(13);
    // 待ちは東・白。東は河にあるのでフリテン
    expect(seat.waits.map((w) => [w.tile, w.furiten])).toEqual([
      ['E', true],
      ['P', false],
    ]);
  });
});
