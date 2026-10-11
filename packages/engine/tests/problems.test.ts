import { describe, expect, it } from 'vitest';

import { listDisagreements } from '../src/disagreement';
import { type ImportedGame, importReportText } from '../src/import';
import {
  type ProblemSource,
  buildDailySet,
  findDecisionByKey,
  keyOfDecision,
  listProblems,
  problemId,
  restOfProblems,
} from '../src/problems';
import { FX4_ID, loadReportText } from './helpers/fixtures';

function load(id: string): ImportedGame {
  const r = importReportText(loadReportText(id));
  if (!r.ok) throw new Error(`${id}: ${r.error.message}`);
  return r.value;
}

const fx4 = load(FX4_ID);
const f9da = load('f9da87cbcd7af5e9');

/** FX-4 の迷い 1〜6 が結びつく判断（ACCEPTANCE E-17・E-27。迷い 6 はユーザーが手で選んだ 東3局1本場 11巡目 の打3m）。 */
const FX4_MARKS = ['k0h0e4', 'k1h0e12', 'k1h1e7', 'k1h1e10', 'k2h1e6', 'k2h1e14'];

const source = (sessionId: string, startedMs: number, game: ImportedGame, markKeys: Array<string | null>): ProblemSource => ({
  sessionId,
  startedMs,
  game,
  markKeys,
});

describe('E-24 今日の出題: 迷いの問題を先に、残りを大きな不一致で確率の低い順に、1日に出す数まで', () => {
  it('E-24 FX-4 だけを取り込んだ状態では、今日の 5 問は迷い 1〜5 の局面になる（迷い 6 は残り）', () => {
    const problems = listProblems([source('s4', 1000, fx4, FX4_MARKS)]);
    const daily = buildDailySet(problems, new Set(), 5);
    expect(daily.map((p) => p.key)).toEqual(FX4_MARKS.slice(0, 5));
    expect(daily.every((p) => p.kind === 'mark')).toBe(true);
    expect(daily.map((p) => p.markNumber)).toEqual([1, 2, 3, 4, 5]);
    const rest = restOfProblems(problems, new Set(), daily);
    // 迷い 6 が先に来て、そのあとに大きな不一致（迷い 2 は迷いの問題として数えるので、不一致は 5 − 1 = 4 問）
    expect(rest[0]?.key).toBe('k2h1e14');
    expect(rest.slice(1).every((p) => p.kind === 'disagreement')).toBe(true);
    expect(rest).toHaveLength(1 + 4);
  });

  it('E-24 迷いと大きな不一致の両方に当たる判断は、1 問（迷いの問題）として数える', () => {
    const problems = listProblems([source('s4', 1000, fx4, FX4_MARKS)]);
    // FX-4 の大きな不一致は 5 つ。そのうち迷い 2（k1h0e12）は迷いの問題の側に入る
    expect(listDisagreements(fx4.decisions).total).toBe(5);
    expect(problems.filter((p) => p.key === 'k1h0e12')).toHaveLength(1);
    expect(problems.find((p) => p.key === 'k1h0e12')?.kind).toBe('mark');
    expect(problems).toHaveLength(6 + 4);
    expect(new Set(problems.map(problemId)).size).toBe(problems.length);
  });

  it('E-24 同じ判断に迷いマークが 2 つ結びついていても 1 問（先の迷い）。結びつけが決まっていない迷い（null）は問題にならない', () => {
    const problems = listProblems([source('s4', 1000, fx4, ['k0h0e4', null, 'k0h0e4', 'k1h1e7', null])]);
    const marks = problems.filter((p) => p.kind === 'mark');
    expect(marks.map((p) => [p.key, p.markNumber])).toEqual([
      ['k0h0e4', 1],
      ['k1h1e7', 4],
    ]);
    // この結果に無い鍵は、問題にならない
    expect(listProblems([source('s4', 1000, fx4, ['k9h9e9'])]).filter((p) => p.kind === 'mark')).toEqual([]);
  });

  it('E-24 迷いの問題は、新しい半荘から、迷いの順。そのあと、大きな不一致が確率の低い順（同じなら新しい半荘から）', () => {
    const older = source('older', 1000, fx4, FX4_MARKS);
    const newer = source('newer', 2000, f9da, [keyOfDecision(f9da.decisions[3] as never), null, keyOfDecision(f9da.decisions[1] as never)]);
    const problems = listProblems([older, newer]);
    const markPart = problems.filter((p) => p.kind === 'mark');
    expect(markPart.map((p) => [p.sessionId, p.markNumber])).toEqual([
      ['newer', 1],
      ['newer', 3],
      ...[1, 2, 3, 4, 5, 6].map((n) => ['older', n]),
    ]);
    // 迷いの問題がすべて先で、大きな不一致が後ろ
    const firstDisagreement = problems.findIndex((p) => p.kind === 'disagreement');
    expect(problems.slice(0, firstDisagreement).every((p) => p.kind === 'mark')).toBe(true);
    expect(problems.slice(firstDisagreement).every((p) => p.kind === 'disagreement')).toBe(true);
    const disagreements = problems.slice(firstDisagreement);
    for (let i = 1; i < disagreements.length; i++) {
      const a = disagreements[i - 1];
      const b = disagreements[i];
      if (!a || !b) continue;
      expect(a.probability <= b.probability, `${i}`).toBe(true);
      if (a.probability === b.probability) expect(a.startedMs >= b.startedMs).toBe(true);
    }
    // 2 つの半荘の大きな不一致（19 + 5。迷いにしたものは除く）が、確率だけで混ざって並ぶ
    const sessionsInOrder = new Set(disagreements.map((p) => p.sessionId));
    expect(sessionsInOrder).toEqual(new Set(['older', 'newer']));
    expect(disagreements.length).toBeLessThanOrEqual(19 + 5);
  });

  it('E-24 迷いの無い半荘では、大きな不一致が確率の低い順に並び、先頭は 東4局13巡目 の打3m（E-4）', () => {
    const problems = listProblems([source('f', 1000, f9da, [])]);
    expect(problems).toHaveLength(19);
    const first = problems[0];
    expect(first?.decision.kyokuLabel).toBe('東4局');
    expect(first?.decision.junme).toBe(13);
    expect(problems.map((p) => p.key)).toEqual(listDisagreements(f9da.decisions, { limit: 100 }).items.map((it) => keyOfDecision(it.decision)));
  });

  it('E-24 基準（既定 5%）を変えると、大きな不一致の問題が増減する', () => {
    const count = (threshold: number) => listProblems([source('f', 1000, f9da, [])], { threshold }).length;
    expect(count(0.05)).toBe(19);
    expect(count(0.1)).toBeGreaterThan(19);
    expect(count(0.01)).toBeLessThan(19);
  });

  it('E-24 答えた問題は入らない。1日に出す数（既定 5）まで入り、足りなければ、あるだけ', () => {
    const problems = listProblems([source('s4', 1000, fx4, FX4_MARKS)]);
    const answered = new Set(['k0h0e4', 'k1h0e12'].map((key) => problemId({ sessionId: 's4', key })));
    expect(buildDailySet(problems, answered, 5).map((p) => p.key)).toEqual(['k1h1e7', 'k1h1e10', 'k2h1e6', 'k2h1e14', expect.any(String)]);
    expect(buildDailySet(problems, new Set(), 3)).toHaveLength(3);
    expect(buildDailySet(problems, new Set(), 100)).toHaveLength(problems.length);
    expect(buildDailySet(problems, new Set(), 0)).toEqual([]);
    expect(buildDailySet([], new Set(), 5)).toEqual([]);
  });

  it('E-24 消した半荘の問題は、その半荘を渡さなければ入らない（残りの半荘だけで組む）', () => {
    const both = listProblems([source('older', 1000, fx4, FX4_MARKS), source('newer', 2000, f9da, [])]);
    const without = listProblems([source('older', 1000, fx4, FX4_MARKS)]);
    expect(both.some((p) => p.sessionId === 'newer')).toBe(true);
    expect(without.some((p) => p.sessionId === 'newer')).toBe(false);
    expect(buildDailySet(without, new Set(), 5).map((p) => p.sessionId)).toEqual(['older', 'older', 'older', 'older', 'older']);
  });

  it('E-24 その日の組が決まったあとに取り込んだ半荘の問題は、その日は「残り」に入る（組は変わらない）', () => {
    const before = listProblems([source('older', 1000, fx4, FX4_MARKS)]);
    const daily = buildDailySet(before, new Set(), 5);
    const after = listProblems([source('older', 1000, fx4, FX4_MARKS), source('newer', 2000, f9da, [keyOfDecision(f9da.decisions[0] as never)])]);
    // 組は保存してあるものを使うので、あとからの再計算では変えない。新しい半荘の問題は、組に入っていないので、残りに出る
    const rest = restOfProblems(after, new Set(), daily);
    expect(rest.some((p) => p.sessionId === 'newer')).toBe(true);
    expect(rest.every((p) => !daily.some((d) => problemId(d) === problemId(p)))).toBe(true);
    // 新しい半荘の迷いの問題が、再計算なら先頭に来る（だから、組は保存して使う）
    expect(buildDailySet(after, new Set(), 5)[0]?.sessionId).toBe('newer');
  });

  it('E-24 判断の鍵から判断を引ける。鍵は、局の通し番号・本場・局の中の番号', () => {
    for (const key of FX4_MARKS) {
      const d = findDecisionByKey(fx4, key);
      expect(d, key).toBeDefined();
      expect(d && keyOfDecision(d)).toBe(key);
    }
  });
});
