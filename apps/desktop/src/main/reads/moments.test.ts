import { buildReplayTimeline } from '@jantama/engine';
import { describe, expect, it } from 'vitest';

import { gameOf } from '../../../tests/fake-study';
import { fx4Reads, moment, syntheticReads } from '../../../tests/reads-fixtures';
import type { Reads } from '../../api/reads';
import { momentAtDecision, momentAtStep, momentFor } from './moments';

/** 局 0 に場面 3 つ（event 10・18・26）、局 1 に場面 1 つ（event 40）。 */
const reads: Reads = {
  format: 'jantama-reads/1',
  model: { file: 'tenpai.onnx', sha256: '0'.repeat(64) },
  player_id: 0,
  moments: [moment(0, 10), moment(0, 18), moment(0, 26), moment(1, 40)],
};

describe('F23 場面の引き当て: momentFor', () => {
  it('自分のツモ・チー・ポンの手は、event_index が同じ場面（局も合うもの）', () => {
    expect(momentFor(reads, { kyokuPosition: 0, eventIndex: 18, eventType: 'tsumo' })?.event_index).toBe(18);
    expect(momentFor(reads, { kyokuPosition: 0, eventIndex: 26, eventType: 'pon' })?.event_index).toBe(26);
    expect(momentFor(reads, { kyokuPosition: 1, eventIndex: 40, eventType: 'chi' })?.event_index).toBe(40);
    // 同じ event_index でも、局が違えば別の場面（局が合わなければ、探さない）
    expect(momentFor(reads, { kyokuPosition: 0, eventIndex: 40, eventType: 'tsumo' })).toBeNull();
  });

  it('自分のリーチのあとの打牌は、同じ局の、それより前の最後の場面', () => {
    expect(momentFor(reads, { kyokuPosition: 0, eventIndex: 27, eventType: 'reach' })?.event_index).toBe(26);
    expect(momentFor(reads, { kyokuPosition: 0, eventIndex: 20, eventType: 'reach' })?.event_index).toBe(18);
    // 局をまたがない（局 1 の 41 の前の場面は 40。局 0 の 26 ではない）
    expect(momentFor(reads, { kyokuPosition: 1, eventIndex: 41, eventType: 'reach' })?.event_index).toBe(40);
    // その局に前の場面が無ければ、null
    expect(momentFor(reads, { kyokuPosition: 1, eventIndex: 30, eventType: 'reach' })).toBeNull();
    expect(momentFor(reads, { kyokuPosition: 0, eventIndex: 5, eventType: 'reach' })).toBeNull();
  });

  it('他家の打牌への鳴きの判断・盤面を見ているだけの手は、読みが無い（前の場面は使わない）', () => {
    expect(momentFor(reads, { kyokuPosition: 0, eventIndex: 19, eventType: 'dahai' })).toBeNull();
    expect(momentFor(reads, { kyokuPosition: 0, eventIndex: 19, eventType: 'ankan' })).toBeNull();
    expect(momentFor(reads, { kyokuPosition: 0, eventIndex: 19, eventType: 'reach-by-other' })).toBeNull();
    expect(momentFor({ ...reads, moments: [] }, { kyokuPosition: 0, eventIndex: 18, eventType: 'tsumo' })).toBeNull();
  });

  it('場面が event_index の順に並んでいなくても、同じ答え', () => {
    const shuffled: Reads = { ...reads, moments: [reads.moments[2]!, reads.moments[0]!, reads.moments[3]!, reads.moments[1]!] };
    expect(momentFor(shuffled, { kyokuPosition: 0, eventIndex: 27, eventType: 'reach' })?.event_index).toBe(26);
    expect(momentFor(shuffled, { kyokuPosition: 0, eventIndex: 18, eventType: 'tsumo' })?.event_index).toBe(18);
  });
});

describe('F23 本物の牌譜（FX-4）と本物の読みで、手と場面が合う', () => {
  const game = gameOf('fx4');
  const timeline = buildReplayTimeline(game);
  const real = fx4Reads();

  it('読みの場面は、自分のツモ・チー・ポンの event と 1 つずつ合う（55 場面）', () => {
    expect(real.moments).toHaveLength(55);
    const own = timeline.steps.filter((step) => step.actor === game.playerId && (step.kind === 'tsumo' || step.event.type === 'chi' || step.event.type === 'pon'));
    expect(own).toHaveLength(55);
    for (const step of own) {
      const found = momentFor(real, momentAtStep(step, game.playerId));
      expect(found?.event_index, `event ${step.eventIndex}`).toBe(step.eventIndex);
      expect(found?.kyoku_index).toBe(step.kyokuPosition);
    }
  });

  it('通して見る画面: 自分のツモ・チー・ポン以外の手（他家の打牌・自分の打牌・局の頭と終わり）には、場面が無い', () => {
    const own = new Set(real.moments.map((item) => item.event_index));
    const others = timeline.steps.filter((step) => !own.has(step.eventIndex));
    expect(others.length).toBeGreaterThan(100);
    for (const step of others) expect(momentFor(real, momentAtStep(step, game.playerId)), `event ${step.eventIndex}`).toBeNull();
  });

  it('出題・解き直し: 自分のツモ・チー・ポンの直後の判断には場面があり、他家の打牌への鳴きの判断には無い', () => {
    const own = new Set(real.moments.map((item) => item.event_index));
    const mine = game.decisions.filter((decision) => own.has(decision.eventIndex));
    const calls = game.decisions.filter((decision) => decision.kind === 'call' && !own.has(decision.eventIndex));
    expect(mine.length).toBeGreaterThan(30);
    expect(calls.length).toBeGreaterThan(0);
    for (const decision of mine) {
      expect(momentFor(real, momentAtDecision(game, decision))?.event_index, `event ${decision.eventIndex}`).toBe(decision.eventIndex);
    }
    for (const decision of calls) expect(momentFor(real, momentAtDecision(game, decision)), `event ${decision.eventIndex}`).toBeNull();
  });

  it('他家のリーチ中に自分が打つ場面（FX-4 の局 0 の 5 場面）が、読みにある', () => {
    const riichi = real.moments.filter((item) => item.opponents.some((opponent) => opponent.riichi));
    expect(riichi.map((item) => item.event_index)).toEqual([88, 96, 104, 112, 120]);
    expect(riichi.every((item) => item.kyoku_index === 0)).toBe(true);
  });
});

describe('F23 自分のリーチのあとの打牌（FX-1 d の、牌譜の位置で）', () => {
  const game = gameOf('fx1d');
  const synthetic = syntheticReads(game);

  it('判断の直前の event が自分のリーチの判断は、リーチの直前の、自分のツモの場面を使う', () => {
    const afterReach = game.decisions.filter((decision) => {
      const event = game.report.mjai_log[decision.eventIndex];
      return event !== undefined && event.type === 'reach' && event.actor === game.playerId;
    });
    expect(afterReach.length).toBeGreaterThan(0);
    for (const decision of afterReach) {
      const at = momentAtDecision(game, decision);
      expect(at.eventType).toBe('reach');
      const found = momentFor(synthetic, at);
      // リーチの直前に、自分がツモった event（mjai では tsumo → reach → dahai）
      const before = game.report.mjai_log[decision.eventIndex - 1];
      expect(before?.type).toBe('tsumo');
      expect(found?.event_index).toBe(decision.eventIndex - 1);
      expect(found?.kyoku_index).toBe(decision.kyokuPosition);
    }
  });

  it('通して見る画面でも、自分のリーチの手だけが前の場面を使い、他家のリーチの手は使わない', () => {
    const timeline = buildReplayTimeline(game);
    const reaches = timeline.steps.filter((step) => step.event.type === 'reach');
    expect(reaches.some((step) => step.actor === game.playerId)).toBe(true);
    expect(reaches.some((step) => step.actor !== game.playerId)).toBe(true);
    for (const step of reaches) {
      const found = momentFor(synthetic, momentAtStep(step, game.playerId));
      if (step.actor === game.playerId) expect(found?.event_index, `event ${step.eventIndex}`).toBe(step.eventIndex - 1);
      else expect(found, `event ${step.eventIndex}`).toBeNull();
    }
  });
});
