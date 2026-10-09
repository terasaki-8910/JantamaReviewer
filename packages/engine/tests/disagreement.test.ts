import { describe, expect, it } from 'vitest';

import { listDisagreements } from '../src/disagreement';
import { type ImportedGame, importReportText } from '../src/import';
import { FX1_IDS, loadReportText } from './helpers/fixtures';

const EXPECTED_COUNTS: Record<(typeof FX1_IDS)[number], number> = {
  f9da87cbcd7af5e9: 19,
  f738896995c33fed: 16,
  be0a2a523fdd7758: 16,
  '002ca97adccc486d': 15,
  '3a36dac7c7fc18ce': 22,
};

const games = new Map<string, ImportedGame>();
for (const id of FX1_IDS) {
  const r = importReportText(loadReportText(id));
  if (!r.ok) throw new Error(`${id}: ${r.error.message}`);
  games.set(id, r.value);
}

function gameOf(id: string): ImportedGame {
  const g = games.get(id);
  if (!g) throw new Error(id);
  return g;
}

describe('E-4 不一致の一覧', () => {
  for (const id of FX1_IDS) {
    it(`E-4 ${id}: 確率が5%未満の判断が ${EXPECTED_COUNTS[id]} 件、確率の低い順に返る`, () => {
      const list = listDisagreements(gameOf(id).decisions, { limit: 1000 });
      expect(list.total).toBe(EXPECTED_COUNTS[id]);
      expect(list.items).toHaveLength(EXPECTED_COUNTS[id]);
      expect(list.rest).toHaveLength(0);
      for (const item of list.items) expect(item.prob).toBeLessThan(0.05);
      const probs = list.items.map((i) => i.prob);
      expect(probs).toEqual([...probs].sort((a, b) => a - b));
    });
  }

  it('E-4 基準以上の判断は入らない（5%ちょうど以上は含めない）', () => {
    const game = gameOf('f9da87cbcd7af5e9');
    const all = listDisagreements(game.decisions, { limit: 1000 });
    const included = new Set(all.items.map((i) => i.decision.index));
    for (const d of game.decisions) {
      const prob = d.entry.details[d.entry.actual_index]?.prob ?? NaN;
      expect(included.has(d.index), `${d.kyokuLabel} ${d.junme}巡目 prob=${prob}`).toBe(prob < 0.05);
    }
  });

  it('E-4 f9da87cbcd7af5e9 の1件目は、東4局13巡目の打3m', () => {
    const list = listDisagreements(gameOf('f9da87cbcd7af5e9').decisions);
    const first = list.items[0];
    expect(first).toBeDefined();
    if (!first) return;
    expect(first.decision.kyokuLabel).toBe('東4局');
    expect(first.decision.junme).toBe(13);
    expect(first.actual).toMatchObject({ type: 'dahai', pai: '3m' });
    expect(first.prob).toBeLessThan(1e-4);
  });

  it('E-4 1日に出す数の既定は5。先頭5件が items、残りが rest に入り、total は全件', () => {
    const list = listDisagreements(gameOf('f9da87cbcd7af5e9').decisions);
    expect(list.limit).toBe(5);
    expect(list.threshold).toBe(0.05);
    expect(list.items).toHaveLength(5);
    expect(list.rest).toHaveLength(14);
    expect(list.total).toBe(19);
    const full = listDisagreements(gameOf('f9da87cbcd7af5e9').decisions, { limit: 100 });
    expect([...list.items, ...list.rest].map((i) => i.decision.index)).toEqual(full.items.map((i) => i.decision.index));
  });

  it('E-4 件数（limit）と基準（threshold）は変えられる', () => {
    const decisions = gameOf('f9da87cbcd7af5e9').decisions;
    expect(listDisagreements(decisions, { limit: 3 }).items).toHaveLength(3);
    expect(listDisagreements(decisions, { limit: 0 }).items).toHaveLength(0);
    expect(listDisagreements(decisions, { limit: 0 }).total).toBe(19);
    const loose = listDisagreements(decisions, { threshold: 0.2, limit: 1000 });
    expect(loose.total).toBeGreaterThan(19);
    for (const item of loose.items) expect(item.prob).toBeLessThan(0.2);
    const strict = listDisagreements(decisions, { threshold: 0.001, limit: 1000 });
    expect(strict.total).toBeLessThan(19);
    expect(strict.total).toBeGreaterThan(0);
    expect(listDisagreements(decisions, { threshold: 0, limit: 1000 }).total).toBe(0);
  });

  it('E-4 打牌のほか、チー・ポン・スルー・リーチ・和了の判断も対象になる', () => {
    const types = new Set<string>();
    for (const id of FX1_IDS) {
      for (const item of listDisagreements(gameOf(id).decisions, { limit: 1000 }).items) types.add(item.actual.type);
    }
    expect(types.has('dahai')).toBe(true);
    expect(types.has('none')).toBe(true);
    expect(types.size).toBeGreaterThanOrEqual(3);
  });
});
