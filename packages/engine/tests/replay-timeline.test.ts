import { describe, expect, it } from 'vitest';

import { type ImportedGame, importReportText } from '../src/import';
import { summarizeKyokus } from '../src/outcome';
import { replayFrames, splitKyokus } from '../src/replay';
import type { EndStatusEvent, Seat } from '../src/report-types';
import {
  buildReplayTimeline,
  countAfter,
  decisionSteps,
  kyokuEndOf,
  nextKyokuStep,
  nextStepIn,
  nextTurnStep,
  prevKyokuStep,
  prevStepIn,
  prevTurnStep,
} from '../src/replay-timeline';
import { FX4_ID, loadReportText } from './helpers/fixtures';

function load(id: string): ImportedGame {
  const r = importReportText(loadReportText(id));
  if (!r.ok) throw new Error(`${id}: ${r.error.message}`);
  return r.value;
}

const fx4 = load(FX4_ID);
const f9da = load('f9da87cbcd7af5e9');

describe('U-21 半荘を通して見る（計算の側）: 時間軸の手と、手のあとの盤面', () => {
  for (const [name, game] of [
    ['FX-4', fx4],
    ['f9da87cbcd7af5e9', f9da],
  ] as const) {
    it(`U-21 ${name}: すべての手の盤面が、牌譜の再生（E-2）の盤面と一致する`, () => {
      const timeline = buildReplayTimeline(game);
      const logs = splitKyokus(game.report.mjai_log);
      expect(timeline.kyokus).toHaveLength(logs.length);
      for (const kyoku of timeline.kyokus) {
        const frames = replayFrames(logs[kyoku.position]!, game.playerId);
        const byEvent = new Map(frames.map((frame) => [frame.eventIndex, frame]));
        expect(kyoku.steps.length).toBeGreaterThan(10);
        for (const step of kyoku.steps) {
          const frame = byEvent.get(step.eventIndex);
          expect(frame, `${kyoku.label} 手${step.position + 1}`).toBeDefined();
          expect(step.board).toEqual(frame!.board);
          expect(step.event).toEqual(frame!.event);
          expect(step.junme).toBe(step.board.junme);
        }
      }
    });

    it(`U-21 ${name}: 自分の判断は、ちょうど 1 つの手に属し、その手の盤面は判断の盤面と一致する`, () => {
      const timeline = buildReplayTimeline(game);
      const withDecision = timeline.steps.filter((step) => step.decision !== null);
      expect(withDecision).toHaveLength(game.decisions.length);
      expect(new Set(withDecision.map((step) => step.decision!.index)).size).toBe(game.decisions.length);
      for (const step of withDecision) {
        const decision = step.decision!;
        expect(step.eventIndex).toBe(decision.eventIndex);
        expect(step.board).toEqual(decision.board);
        expect(timeline.stepOfDecision.get(decision.index)).toBe(step.index);
        expect(step.kyokuPosition).toBe(decision.kyokuPosition);
      }
    });
  }

  it('U-21 FX-4: 5 局・289 手（局ごとに 80・74・48・26・61）。ほかの人のツモは手にならず、自分のツモは手になる', () => {
    const timeline = buildReplayTimeline(fx4);
    expect(timeline.kyokus.map((kyoku) => kyoku.steps.length)).toEqual([80, 74, 48, 26, 61]);
    expect(timeline.steps).toHaveLength(289);
    const count = (kind: string) => timeline.steps.filter((step) => step.kind === kind).length;
    // 配牌 5・自分のツモ 52・打牌 219（自分 55 + ほか 164）・鳴き 7（ポン 6 + チー 1）・リーチ 1・局の終わり 5
    expect([count('start'), count('tsumo'), count('dahai'), count('call'), count('kan'), count('reach'), count('end')]).toEqual([
      5, 52, 219, 7, 0, 1, 5,
    ]);
    expect(timeline.steps.filter((step) => step.kind === 'tsumo').every((step) => step.actor === timeline.playerId)).toBe(true);
  });

  it('U-21 局の最初の手は配牌（巡目 0・残り 70 枚）、最後の手は局の終わり。手の番号は、局の中でも半荘の中でも 1 つずつ進む', () => {
    for (const game of [fx4, f9da]) {
      const timeline = buildReplayTimeline(game);
      timeline.steps.forEach((step, index) => expect(step.index).toBe(index));
      let expectedFirst = 0;
      for (const kyoku of timeline.kyokus) {
        expect(kyoku.first).toBe(expectedFirst);
        expectedFirst = kyoku.last + 1;
        const head = kyoku.steps[0]!;
        const tail = kyoku.steps.at(-1)!;
        expect(head).toMatchObject({ kind: 'start', junme: 0, actor: null, position: 0 });
        expect(head.board.tilesLeft).toBe(70);
        expect(head.board.drawn).toBeNull();
        expect(tail.kind).toBe('end');
        expect(kyoku.steps.filter((step) => step.kind === 'end')).toHaveLength(1);
        kyoku.steps.forEach((step, position) => {
          expect(step.position).toBe(position);
          expect(step.kyokuPosition).toBe(kyoku.position);
        });
        const events = kyoku.steps.map((step) => step.eventIndex);
        expect(events).toEqual([...events].sort((a, b) => a - b));
        // 巡目は減らない
        const junmes = kyoku.steps.map((step) => step.junme);
        expect(junmes).toEqual([...junmes].sort((a, b) => a - b));
      }
    }
  });

  it('U-21 局の名前は取り込んだ局の名前と同じ', () => {
    const timeline = buildReplayTimeline(fx4);
    expect(timeline.kyokus.map((kyoku) => kyoku.label)).toEqual(['東1局', '東2局', '東2局1本場', '東3局', '東3局1本場']);
  });

  it('U-21 リーチの宣言・自分のチーとポンのあとの打牌の判断（at_self_riichi・at_self_chi_pon）も、その手に属する', () => {
    const timeline = buildReplayTimeline(f9da);
    const afterOwnCall = f9da.decisions.filter((decision) => decision.entry.at_self_chi_pon || decision.entry.at_self_riichi);
    expect(afterOwnCall.length).toBeGreaterThan(0);
    for (const decision of afterOwnCall) {
      const step = timeline.steps[timeline.stepOfDecision.get(decision.index)!]!;
      expect(step.kind).toBe(decision.entry.at_self_riichi ? 'reach' : 'call');
      expect(step.actor).toBe(timeline.playerId);
    }
    // 他家の打牌への判断（鳴き・ロン）は、その打牌の手に属する
    const atOthersDiscard = f9da.decisions.filter((decision) => decision.kind === 'call');
    expect(atOthersDiscard.length).toBeGreaterThan(0);
    for (const decision of atOthersDiscard) {
      const step = timeline.steps[timeline.stepOfDecision.get(decision.index)!]!;
      expect(['dahai', 'kan']).toContain(step.kind);
      expect(step.actor).not.toBe(timeline.playerId);
    }
  });
});

describe('U-21 局の結果（和了・放銃・流局と点の増減）', () => {
  it('U-21 FX-4: 5 局の結果と点の増減（他家のツモ 2・自分の和了（対面から）・放銃 2）', () => {
    const timeline = buildReplayTimeline(fx4);
    expect(timeline.kyokus.map((kyoku) => kyoku.end)).toEqual([
      { kind: 'othersTsumo', delta: -6000, deltas: [-6000, -3000, -3000, 13000], winners: [3], ronFrom: null },
      { kind: 'othersTsumo', delta: -3900, deltas: [-3900, 11700, -3900, -3900], winners: [1], ronFrom: null },
      { kind: 'win', delta: 1300, deltas: [1300, 0, -1300, 0], winners: [0], ronFrom: 2 },
      { kind: 'dealIn', delta: -12000, deltas: [-12000, 0, 12000, 0], winners: [2], ronFrom: 0 },
      { kind: 'dealIn', delta: -8300, deltas: [-8300, 0, 0, 8300], winners: [3], ronFrom: 0 },
    ]);
  });

  it('U-21 f9da87cbcd7af5e9: 12 局すべてで、局の結果の種類と点の増減が、局のまとめ（E-6）と一致する。流局は和了者が無い', () => {
    const timeline = buildReplayTimeline(f9da);
    const summaries = summarizeKyokus(f9da.report);
    expect(timeline.kyokus).toHaveLength(12);
    timeline.kyokus.forEach((kyoku, index) => {
      expect(kyoku.end.kind).toBe(summaries[index]!.outcome.kind);
      expect(kyoku.end.delta).toBe(summaries[index]!.outcome.delta);
      expect(kyoku.end.deltas[f9da.playerId]).toBe(kyoku.end.delta);
    });
    const draws = timeline.kyokus.filter((kyoku) => kyoku.end.kind === 'draw');
    expect(draws).toHaveLength(2);
    for (const kyoku of draws) {
      expect(kyoku.end.winners).toEqual([]);
      expect(kyoku.end.ronFrom).toBeNull();
      expect(kyoku.steps.at(-1)!.event.type).toBe('ryukyoku');
    }
  });

  it('U-21 ダブロン: 和了した席をすべて並べ、増減は合計。放銃した席を返す。流局は和了者なし', () => {
    const hora = (actor: Seat, target: Seat, deltas: number[]): EndStatusEvent => ({ type: 'hora', actor, target, deltas });
    const double = [hora(1, 0, [-3900, 3900, 0, 0]), hora(2, 0, [-2000, 0, 2000, 0])];
    expect(kyokuEndOf(double, 0)).toEqual({ kind: 'dealIn', delta: -5900, deltas: [-5900, 3900, 2000, 0], winners: [1, 2], ronFrom: 0 });
    expect(kyokuEndOf(double, 3)).toMatchObject({ kind: 'othersRon', delta: 0, winners: [1, 2], ronFrom: 0 });
    expect(kyokuEndOf([{ type: 'ryukyoku', deltas: [1000, -3000, 1000, 1000] }], 1)).toEqual({
      kind: 'draw',
      delta: -3000,
      deltas: [1000, -3000, 1000, 1000],
      winners: [],
      ronFrom: null,
    });
  });
});

describe('U-21 行き先の決め方（前・次の自分の判断、巡目、局）', () => {
  const timeline = buildReplayTimeline(fx4);

  it('U-21 前・次の自分の判断は、判断のある手から手へ進む（鳴きも含む）。両端では行き先が無い', () => {
    const stops = decisionSteps(timeline);
    expect(stops).toHaveLength(fx4.decisions.length);
    expect(stops).toEqual([...stops].sort((a, b) => a - b));
    expect(prevStepIn(stops, stops[0]!)).toBeNull();
    expect(nextStepIn(stops, stops.at(-1)!)).toBeNull();
    expect(nextStepIn(stops, stops[0]!)).toBe(stops[1]);
    expect(prevStepIn(stops, stops[3]!)).toBe(stops[2]);
    // 判断の無い手からも進める（いまの手より後ろの最初の判断）
    const between = stops[0]! + 1;
    expect(stops).not.toContain(between);
    expect(nextStepIn(stops, between)).toBe(stops[1]);
    expect(prevStepIn(stops, between)).toBe(stops[0]);
    expect(countAfter(stops, stops[0]!)).toBe(stops.length - 1);
    expect(countAfter(stops, stops.at(-1)!)).toBe(0);
    // FX-4 には、鳴きの判断が含まれる（東2局1本場 8巡目の東のポン）
    const callStops = stops.filter((index) => timeline.steps[index]!.decision!.kind === 'call');
    expect(callStops.length).toBeGreaterThan(0);
  });

  it('U-21 次の巡目は、この局の次の巡目の最初の手。最後の巡目からは、次の局の頭。半荘の終わりは行き先なし', () => {
    const kyoku = timeline.kyokus[2]!;
    // 配牌（巡目 0）から: 巡目 1 の最初の手（自分のツモ）
    const start = kyoku.first;
    const turn1 = nextTurnStep(timeline, start)!;
    expect(timeline.steps[turn1]!.junme).toBe(1);
    expect(timeline.steps[turn1]!.kind).toBe('tsumo');
    expect(timeline.steps[turn1 - 1]!.junme).toBe(0);
    // 巡目の途中から: 次の巡目の最初の手
    const middle = turn1 + 1;
    expect(timeline.steps[middle]!.junme).toBe(1);
    const turn2 = nextTurnStep(timeline, middle)!;
    expect(timeline.steps[turn2]!.junme).toBe(2);
    expect(timeline.steps[turn2 - 1]!.junme).toBe(1);
    // 局の最後の手から: 次の局の頭
    expect(nextTurnStep(timeline, kyoku.last)).toBe(timeline.kyokus[3]!.first);
    expect(nextTurnStep(timeline, timeline.steps.length - 1)).toBeNull();
  });

  it('U-21 前の巡目は、巡目の途中ならその巡目の最初の手、最初の手からはひとつ前の巡目。局の頭からは前の局の最後の巡目。半荘の頭は行き先なし', () => {
    const kyoku = timeline.kyokus[2]!;
    const turn3 = kyoku.turnFirst.get(3)!;
    expect(prevTurnStep(timeline, turn3 + 2)).toBe(turn3);
    expect(prevTurnStep(timeline, turn3)).toBe(kyoku.turnFirst.get(2));
    expect(prevTurnStep(timeline, kyoku.turnFirst.get(1)!)).toBe(kyoku.first);
    const before = timeline.kyokus[1]!;
    const lastTurn = Math.max(...before.turnFirst.keys());
    expect(prevTurnStep(timeline, kyoku.first)).toBe(before.turnFirst.get(lastTurn));
    expect(prevTurnStep(timeline, 0)).toBeNull();
    // 巡目を進めて戻すと、もとの巡目の最初の手に戻る
    const forward = nextTurnStep(timeline, kyoku.first + 5)!;
    expect(prevTurnStep(timeline, forward)).toBe(kyoku.turnFirst.get(timeline.steps[forward - 1]!.junme));
  });

  it('U-21 前・次の局は、前・次の局の頭。端では行き先なし', () => {
    const [k0, k1, , , k4] = timeline.kyokus;
    expect(nextKyokuStep(timeline, k0!.first + 10)).toBe(k1!.first);
    expect(prevKyokuStep(timeline, k1!.last)).toBe(k0!.first);
    expect(prevKyokuStep(timeline, k0!.first)).toBeNull();
    expect(nextKyokuStep(timeline, k4!.last)).toBeNull();
  });

  it('U-21 巡目ごとの最初の手の表は、巡目 0 から最後の巡目まで切れ目なく、局の頭から始まる', () => {
    for (const kyoku of timeline.kyokus) {
      const turns = [...kyoku.turnFirst.keys()].sort((a, b) => a - b);
      expect(turns[0]).toBe(0);
      expect(turns).toEqual(Array.from({ length: turns.length }, (_, i) => i));
      expect(kyoku.turnFirst.get(0)).toBe(kyoku.first);
      for (const turn of turns) expect(timeline.steps[kyoku.turnFirst.get(turn)!]!.junme).toBe(turn);
    }
  });
});
