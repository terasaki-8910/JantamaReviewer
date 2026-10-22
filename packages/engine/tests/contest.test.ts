import { describe, expect, it } from 'vitest';

import { DEFAULT_CONTEST_OPTIONS, type ContestOptions, contestOf } from '../src/contest';
import type { Decision } from '../src/decision';
import { type ImportedGame, importReportText } from '../src/import';
import type { Fuuro } from '../src/report-types';
import { FX4_ID, loadReportText } from './helpers/fixtures';

function load(): ImportedGame {
  const result = importReportText(loadReportText(FX4_ID));
  if (!result.ok) throw new Error(result.error.message);
  return result.value;
}

const base = load().decisions[0] as Decision;

function decision(junme: number, gap: number, setup: { riichi?: boolean; calls?: boolean; ankan?: boolean; single?: boolean } = {}): Decision {
  const first = base.entry.details[0]!;
  const second = base.entry.details[1] ?? first;
  const pon: Fuuro = { type: 'pon', target: 0, pai: '1m', consumed: ['1m', '1m'] };
  const secondMeld: Fuuro = setup.ankan
    ? { type: 'ankan', consumed: ['2p', '2p', '2p', '2p'] }
    : { type: 'chi', target: 0, pai: '3m', consumed: ['1m', '2m'] };
  return {
    ...base,
    junme,
    entry: {
      ...base.entry,
      details: setup.single
        ? [{ ...first, prob: 0.6 }]
        : [
            { ...first, prob: 0.5 + gap / 2 },
            { ...second, prob: 0.5 - gap / 2 },
          ],
    },
    board: {
      ...base.board,
      riichi: ['none', setup.riichi ? 'declared' : 'none', 'none', 'none'],
      melds: [[], setup.calls ? [pon, secondMeld] : [], [], []],
    },
  };
}

const options = (changes: Partial<ContestOptions> = {}): ContestOptions => ({ ...DEFAULT_CONTEST_OPTIONS, ...changes });

describe('E-47 拮抗', () => {
  it('上位2候補の差と巡目の境界で判定する', () => {
    expect(contestOf(decision(12, 0.1), options())?.gap).toBeCloseTo(0.1);
    expect(contestOf(decision(12, 0.3), options())).toBeNull();
    expect(contestOf(decision(11, 0.1), options())).toBeNull();
    expect(contestOf(decision(11, 0.1), options({ minJunme: 11 }))?.gap).toBeCloseTo(0.1);
    expect(contestOf(decision(11, 0.1), options({ minJunme: 12 }))).toBeNull();
    expect(contestOf(decision(12, 0.1), options({ minJunme: null }))).toBeNull();
  });

  it('他家のリーチ後と、暗槓を除く他家2副露を終盤条件にする', () => {
    expect(contestOf(decision(11, 0.1, { riichi: true }), options())).not.toBeNull();
    expect(contestOf(decision(11, 0.1, { riichi: true }), options({ afterRiichi: false }))).toBeNull();
    expect(contestOf(decision(11, 0.1, { calls: true }), options())).not.toBeNull();
    expect(contestOf(decision(11, 0.1, { calls: true }), options({ twoCalls: false }))).toBeNull();
    expect(contestOf(decision(11, 0.1, { calls: true, ankan: true }), options())).toBeNull();
  });

  it('候補が1つ、または設定が切なら拮抗にしない', () => {
    expect(contestOf(decision(12, 0.1, { single: true }), options())).toBeNull();
    expect(contestOf(decision(12, 0.1), options({ enabled: false }))).toBeNull();
  });
});
