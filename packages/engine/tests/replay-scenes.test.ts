import { describe, expect, it } from 'vitest';

import { listDisagreements } from '../src/disagreement';
import { type ImportedGame, importReportText } from '../src/import';
import { keyOfDecision, listProblems } from '../src/problems';
import { listReplayScenes, mismatchKindOf, replayMismatches } from '../src/replay-scenes';
import { buildReplayTimeline } from '../src/replay-timeline';
import { FX1_IDS, FX4_ID, loadReportText } from './helpers/fixtures';

function load(id: string): ImportedGame {
  const r = importReportText(loadReportText(id));
  if (!r.ok) throw new Error(`${id}: ${r.error.message}`);
  return r.value;
}

const fx4 = load(FX4_ID);
const f9da = load('f9da87cbcd7af5e9');

/** FX-4 の迷い 1〜6 が結びつく判断（ACCEPTANCE E-17・E-27。迷い 6 は、ユーザーが手で選んだ 東3局1本場 11巡目 の打3m）。 */
const FX4_MARKS = ['k0h0e4', 'k1h0e12', 'k1h1e7', 'k1h1e10', 'k2h1e6', 'k2h1e14'];

describe('E-26 通して見る画面の悪手', () => {
  it('E-26 既定は、確率 5% 未満の判断（悪手）。FX-4 は 5 件、f9da87cbcd7af5e9 は 19 件', () => {
    expect(replayMismatches(fx4.decisions)).toHaveLength(5);
    expect(replayMismatches(f9da.decisions)).toHaveLength(19);
    for (const found of replayMismatches(f9da.decisions)) {
      expect(found.kind).toBe('big');
      const entry = found.decision.entry;
      expect(entry.details[entry.actual_index]!.prob).toBeLessThan(0.05);
    }
  });

  it('E-26 「AI の1位と違う判断も、飛び先に入れる」を入れると、AI の1位と違う判断すべて。FX-4 は 8 件、f9da87cbcd7af5e9 は 43 件', () => {
    const fx4All = replayMismatches(fx4.decisions, { includeAll: true });
    const f9daAll = replayMismatches(f9da.decisions, { includeAll: true });
    expect(fx4All).toHaveLength(8);
    expect(f9daAll).toHaveLength(43);
    // 結果の記録でも、AI の1位と違うのは、FX-4 が 8、f9da が 43（review の判断の数 − 一致した数）
    expect(fx4.report.review.total_reviewed - fx4.report.review.total_matches).toBe(8);
    expect(f9da.report.review.total_reviewed - f9da.report.review.total_matches).toBe(43);
    // AI の1位と違う判断は、すべて入る。そうでない判断は 1 つも入らない
    for (const [game, found] of [
      [fx4, fx4All],
      [f9da, f9daAll],
    ] as const) {
      const included = new Set(found.map((item) => item.decision.index));
      for (const decision of game.decisions) {
        expect(included.has(decision.index), `${decision.kyokuLabel} ${decision.junme}巡目`).toBe(!decision.entry.is_equal);
      }
    }
  });

  it('E-26 設定を入れると、既定の件数はすべて含まれ（悪手は big のまま）、増えた分は other（確率が基準以上）', () => {
    for (const game of [fx4, f9da]) {
      const base = replayMismatches(game.decisions);
      const all = replayMismatches(game.decisions, { includeAll: true });
      const baseIds = new Set(base.map((item) => item.decision.index));
      for (const id of baseIds) expect(all.find((item) => item.decision.index === id)?.kind).toBe('big');
      const extra = all.filter((item) => !baseIds.has(item.decision.index));
      expect(extra.length).toBe(all.length - base.length);
      for (const item of extra) {
        expect(item.kind).toBe('other');
        expect(item.decision.entry.is_equal).toBe(false);
        const entry = item.decision.entry;
        expect(entry.details[entry.actual_index]!.prob).toBeGreaterThanOrEqual(0.05);
      }
    }
  });

  it('E-26 並びは半荘の順（確率の順ではない）', () => {
    const found = replayMismatches(f9da.decisions);
    const indexes = found.map((item) => item.decision.index);
    expect(indexes).toEqual([...indexes].sort((a, b) => a - b));
  });

  it('E-26 5 半荘すべてで、既定の件数は悪手の一覧（E-4）と同じ判断になる。設定は出題の基準（F2）を変えない', () => {
    for (const id of FX1_IDS) {
      const game = load(id);
      const list = listDisagreements(game.decisions, { limit: 1000 });
      const found = replayMismatches(game.decisions);
      expect(found.map((item) => item.decision.index).sort((a, b) => a - b)).toEqual(
        list.items.map((item) => item.decision.index).sort((a, b) => a - b),
      );
      // 出題の問題は、設定の影響を受けない（problems.ts は不一致の設定を持たない）
      const sources = [{ sessionId: 's', startedMs: 1, game, markKeys: [] }];
      expect(listProblems(sources).filter((p) => p.kind === 'disagreement')).toHaveLength(list.total);
    }
  });

  it('E-26 1 つの判断の分類（mismatchKindOf）: 確率が基準未満なら big、そうでなく AI の1位と違えば、設定が入のときだけ other', () => {
    const big = fx4.decisions.find((d) => keyOfDecision(d) === 'k1h0e12')!;
    expect(mismatchKindOf(big)).toBe('big');
    expect(mismatchKindOf(big, { includeAll: true })).toBe('big');
    const equal = fx4.decisions.find((d) => d.entry.is_equal)!;
    expect(mismatchKindOf(equal)).toBeNull();
    expect(mismatchKindOf(equal, { includeAll: true })).toBeNull();
    const other = replayMismatches(fx4.decisions, { includeAll: true }).find((item) => item.kind === 'other')!.decision;
    expect(mismatchKindOf(other)).toBeNull();
    expect(mismatchKindOf(other, { includeAll: true })).toBe('other');
  });
});

describe('F12 場面の一覧（迷いと悪手）', () => {
  const timeline = buildReplayTimeline(fx4);

  it('FX-4: 迷い 6・不一致 5（迷い 2 は不一致でもある）で、場面は 10。時間軸の順に並ぶ', () => {
    const scenes = listReplayScenes(timeline, fx4.decisions, { markKeys: FX4_MARKS });
    expect(scenes).toHaveLength(10);
    expect(scenes.filter((scene) => scene.doubts.length > 0)).toHaveLength(6);
    expect(scenes.filter((scene) => scene.mismatch !== null)).toHaveLength(5);
    const both = scenes.filter((scene) => scene.doubts.length > 0 && scene.mismatch !== null);
    expect(both.map((scene) => scene.key)).toEqual(['k1h0e12']);
    expect(both[0]!.doubts).toEqual([2]);
    expect(scenes.map((scene) => scene.key)).toEqual([
      'k0h0e4',
      'k1h0e12',
      'k1h1e6',
      'k1h1e7',
      'k1h1e9',
      'k1h1e10',
      'k2h1e2',
      'k2h1e6',
      'k2h1e14',
      'k2h1e16',
    ]);
    const steps = scenes.map((scene) => scene.step);
    expect(steps).toEqual([...steps].sort((a, b) => a - b));
    for (const scene of scenes) {
      expect(timeline.steps[scene.step]!.decision).toBe(scene.decision);
      expect(keyOfDecision(scene.decision)).toBe(scene.key);
    }
  });

  it('F12 迷いの番号は、結びつけた迷いマークの並びの位置 + 1。同じ判断に 2 つ結びついていれば、両方の番号。決まっていない迷い（null）は場面にならない', () => {
    const scenes = listReplayScenes(timeline, fx4.decisions, { markKeys: ['k0h0e4', null, 'k0h0e4', 'k1h1e7', null] });
    const marked = scenes.filter((scene) => scene.doubts.length > 0);
    expect(marked.map((scene) => [scene.key, scene.doubts])).toEqual([
      ['k0h0e4', [1, 3]],
      ['k1h1e7', [4]],
    ]);
    // 迷いが無ければ、不一致だけ（5 件）
    expect(listReplayScenes(timeline, fx4.decisions, { markKeys: [] })).toHaveLength(5);
  });

  it('F12 「AI の1位と違う判断も、不一致として出す」を入れると、場面が増える（増えた分は other）。迷いの場面は変わらない', () => {
    const base = listReplayScenes(timeline, fx4.decisions, { markKeys: FX4_MARKS });
    const all = listReplayScenes(timeline, fx4.decisions, { markKeys: FX4_MARKS, includeAll: true });
    expect(all.filter((scene) => scene.mismatch !== null)).toHaveLength(8);
    expect(all.length).toBeGreaterThan(base.length);
    expect(all.filter((scene) => scene.doubts.length > 0)).toHaveLength(6);
    expect(all.filter((scene) => scene.mismatch === 'other')).toHaveLength(3);
    for (const scene of base) expect(all.find((s) => s.key === scene.key)?.mismatch).toBe(scene.mismatch);
  });

  it('E-45・E-46 細かいミスと解決済みを場面に付ける', () => {
    const resolvedKeys = new Set(['k0h0e4']);
    const scenes = listReplayScenes(timeline, fx4.decisions, {
      markKeys: FX4_MARKS,
      resolvedKeys,
    });
    expect(scenes.find((scene) => scene.key === 'k1h0e12')?.fineMiss).toBe(true);
    expect(scenes.filter((scene) => scene.doubts.length > 0 && scene.key !== 'k1h0e12').every((scene) => !scene.fineMiss)).toBe(true);
    expect(scenes.find((scene) => scene.key === 'k0h0e4')?.resolved).toBe(true);
    expect(scenes.filter((scene) => scene.key !== 'k0h0e4').every((scene) => !scene.resolved)).toBe(true);
    const unresolved = listReplayScenes(timeline, fx4.decisions, { markKeys: FX4_MARKS });
    expect(unresolved.every((scene) => !scene.resolved)).toBe(true);
  });
});


