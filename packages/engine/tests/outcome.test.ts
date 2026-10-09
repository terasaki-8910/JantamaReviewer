import { describe, expect, it } from 'vitest';

import { classifyHandOutcome, countLowProbDecisions, provisionalMark, summarizeKyokus } from '../src/outcome';
import { parseReportText } from '../src/report';
import type { EndStatusEvent, MortalReport, Seat } from '../src/report-types';
import { FX1_IDS, loadReportText } from './helpers/fixtures';

function load(id: string): MortalReport {
  const r = parseReportText(loadReportText(id));
  if (!r.ok) throw new Error(r.error.message);
  return r.value;
}

const ron = (actor: Seat, target: Seat, deltas: number[]): EndStatusEvent => ({ type: 'hora', actor, target, deltas });
const draw = (deltas: number[]): EndStatusEvent => ({ type: 'ryukyoku', deltas });

describe('E-6 局の結果の分類（本人から見て）', () => {
  it('E-6 自分の和了（ツモ）は win で、点の増減は本人の分', () => {
    expect(classifyHandOutcome([ron(1, 1, [-2600, 8800, -2600, -2600])], 1)).toEqual({ kind: 'win', delta: 8800 });
  });

  it('E-6 自分の和了（ロン）も win', () => {
    expect(classifyHandOutcome([ron(1, 3, [0, 5500, 0, -5500])], 1)).toEqual({ kind: 'win', delta: 5500 });
  });

  it('E-6 自分が打ち込んだロンは dealIn', () => {
    expect(classifyHandOutcome([ron(2, 1, [0, -2900, 2900, 0])], 1)).toEqual({ kind: 'dealIn', delta: -2900 });
  });

  it('E-6 他家のツモは othersTsumo', () => {
    expect(classifyHandOutcome([ron(0, 0, [9200, -4000, -2100, -2100])], 1)).toEqual({ kind: 'othersTsumo', delta: -4000 });
  });

  it('E-6 他家どうしのロン（自分は関係しない）は othersRon で点の増減は 0', () => {
    expect(classifyHandOutcome([ron(2, 0, [-2000, 0, 2000, 0])], 1)).toEqual({ kind: 'othersRon', delta: 0 });
  });

  it('E-6 流局は draw で、ノーテン罰符などの増減が入る', () => {
    expect(classifyHandOutcome([draw([1000, -3000, 1000, 1000])], 1)).toEqual({ kind: 'draw', delta: -3000 });
  });

  it('E-6 ダブロン: 自分が和了した側なら win、自分が打ち込んだ側なら dealIn、増減は合計', () => {
    const winner = [ron(1, 0, [-3900, 3900, 0, 0]), ron(2, 0, [-2000, 0, 2000, 0])];
    expect(classifyHandOutcome(winner, 1)).toEqual({ kind: 'win', delta: 3900 });
    const loser = [ron(1, 0, [-3900, 3900, 0, 0]), ron(2, 0, [-2000, 0, 2000, 0])];
    expect(classifyHandOutcome(loser, 0)).toEqual({ kind: 'dealIn', delta: -5900 });
    expect(classifyHandOutcome(loser, 3)).toEqual({ kind: 'othersRon', delta: 0 });
  });
});

describe('E-6 暫定の〇△✕（AI の確率が5%未満の判断の数）', () => {
  it('E-6 0 なら〇（good）、1 なら△（fair）、2 以上なら✕（bad）', () => {
    expect(provisionalMark(0)).toBe('good');
    expect(provisionalMark(1)).toBe('fair');
    expect(provisionalMark(2)).toBe('bad');
    expect(provisionalMark(7)).toBe('bad');
  });

  it('E-6 数える基準は確率が 5% 未満（ちょうど 5% は数えない）で、基準は変えられる', () => {
    const entry = (prob: number) => ({
      actual_index: 1,
      details: [
        { action: { type: 'none' as const }, q_value: 0, prob: 1 - prob },
        { action: { type: 'none' as const }, q_value: 0, prob },
      ],
    });
    const entries = [entry(0.049), entry(0.05), entry(0.2), entry(0.001)];
    expect(countLowProbDecisions(entries)).toBe(2);
    expect(countLowProbDecisions(entries, 0.1)).toBe(3);
    expect(countLowProbDecisions(entries, 0.25)).toBe(4);
    expect(countLowProbDecisions(entries, 0)).toBe(0);
  });
});

describe('E-6 f9da87cbcd7af5e9 の局ごとのまとめ（ACCEPTANCE の期待値）', () => {
  const summaries = summarizeKyokus(load('f9da87cbcd7af5e9'));

  const EXPECTED = [
    { label: '東1局', kind: 'othersRon', delta: 0, low: 3, mark: 'bad' },
    { label: '東2局', kind: 'win', delta: 8800, low: 0, mark: 'good' },
    { label: '東2局1本場', kind: 'othersTsumo', delta: -4000, low: 1, mark: 'fair' },
    { label: '東3局', kind: 'dealIn', delta: -2900, low: 1, mark: 'fair' },
    { label: '東3局1本場', kind: 'othersTsumo', delta: -1400, low: 1, mark: 'fair' },
    { label: '東4局', kind: 'draw', delta: -3000, low: 7, mark: 'bad' },
    { label: '東4局1本場', kind: 'win', delta: 5500, low: 1, mark: 'fair' },
    { label: '南1局', kind: 'draw', delta: -1000, low: 1, mark: 'fair' },
    { label: '南2局1本場', kind: 'othersTsumo', delta: -2100, low: 0, mark: 'good' },
    { label: '南3局', kind: 'othersRon', delta: 0, low: 2, mark: 'bad' },
    { label: '南4局', kind: 'othersTsumo', delta: -700, low: 1, mark: 'fair' },
    { label: '西1局', kind: 'othersTsumo', delta: -500, low: 1, mark: 'fair' },
  ] as const;

  it('E-6 局は12個で、局の名前（本場つき）が順に並ぶ', () => {
    expect(summaries.map((s) => s.label)).toEqual(EXPECTED.map((e) => e.label));
  });

  it('E-6 AI の確率が5%未満の判断の数が、局ごとに 3・0・1・1・1・7・1・1・0・2・1・1', () => {
    expect(summaries.map((s) => s.lowProbCount)).toEqual(EXPECTED.map((e) => e.low));
    expect(summaries.reduce((n, s) => n + s.lowProbCount, 0)).toBe(19);
  });

  it('E-6 暫定の〇△✕が、数から決まる', () => {
    expect(summaries.map((s) => s.provisionalMark)).toEqual(EXPECTED.map((e) => e.mark));
  });

  it('E-6 局の結果の分類と本人の点の増減が、12局すべてで期待と一致する', () => {
    expect(summaries.map((s) => ({ kind: s.outcome.kind, delta: s.outcome.delta }))).toEqual(
      EXPECTED.map((e) => ({ kind: e.kind, delta: e.delta })),
    );
  });

  it('E-6 局ごとの判断の数の合計は、半荘の判断の数（178）', () => {
    expect(summaries.reduce((n, s) => n + s.decisionCount, 0)).toBe(178);
  });
});

describe('E-6 FX-1 の5半荘', () => {
  it('E-6 5半荘とも、局ごとの数の合計が不一致の一覧の件数（19・16・16・15・22）と同じ', () => {
    const expected = [19, 16, 16, 15, 22];
    FX1_IDS.forEach((id, i) => {
      const total = summarizeKyokus(load(id)).reduce((n, s) => n + s.lowProbCount, 0);
      expect(total, id).toBe(expected[i]);
    });
  });

  it('E-6 どの局も、結果が5種類のどれかに分類され、局の数は 12・13・11・16・15', () => {
    const counts = [12, 13, 11, 16, 15];
    FX1_IDS.forEach((id, i) => {
      const summaries = summarizeKyokus(load(id));
      expect(summaries).toHaveLength(counts[i] ?? -1);
      for (const s of summaries) {
        expect(['win', 'dealIn', 'draw', 'othersTsumo', 'othersRon']).toContain(s.outcome.kind);
        expect(s.rating).not.toBeNull();
      }
    });
  });

  it('E-6 本人の点の増減は、結果の種類と符号が合う（和了は正、放銃は負、他家どうしのロンは 0）', () => {
    for (const id of FX1_IDS) {
      for (const s of summarizeKyokus(load(id))) {
        if (s.outcome.kind === 'win') expect(s.outcome.delta).toBeGreaterThan(0);
        if (s.outcome.kind === 'dealIn') expect(s.outcome.delta).toBeLessThan(0);
        if (s.outcome.kind === 'othersRon') expect(s.outcome.delta).toBe(0);
        if (s.outcome.kind === 'othersTsumo') expect(s.outcome.delta).toBeLessThan(0);
      }
    }
  });
});
