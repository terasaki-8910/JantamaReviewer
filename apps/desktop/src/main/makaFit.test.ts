/**
 * MAKA の当てはめの見込み（U-31、R11-13）の単体試験。画面の部分（局の評価の表の下の 1 行と「合わせ直しました」）は
 * MakaFit.test.tsx、実ブラウザでの見え方は tests/browser/hanchan.browser.test.ts が確かめる。
 *
 * - 入力の作り方（`fitInputOf`）: MAKA の評価を入れた局だけ・点数のある局だけ・並びは半荘の名前の順
 * - 半荘のまとめの覚え方（`SummaryStore`）: 最初は基礎の 67 局。評価を入れると当てはめ直して、覚えているすべてのまとめの段階を
 *   付け直す。変わらなければ、当てはめ直さない。消した半荘の評価は数えない。基礎と同じ半荘の局の評価は、基礎の記録を置き換える
 */
import {
  DEFAULT_GRADE_MODEL,
  MAKA_BASE_RECORDS,
  fitMaka,
  percentOf,
  predictGrade,
  summarizeHanchan,
  parseReportText,
  type Grade,
} from '@jantama/engine';
import { describe, expect, it, vi } from 'vitest';

import type { MakaGrades } from '../api/types';
import { REPORT_TEXTS } from '../../tests/fake-sessions';
import { FX4_TEXT } from '../../tests/import-fixtures';
import { fitInputOf, fitSignature, initialFitState } from './makaFit';
import { SummaryStore, summarizeReportText } from './sessionSummaries';

const F9DA = 'f9da87cbcd7af5e9';

const session = (id: string, maka: MakaGrades['kyokus'] = {}) => ({
  id,
  report_path: `C:\\data\\games\\${id}\\report.json`,
  maka: { kyokus: maka },
});

const noPause = () => Promise.resolve();

/** 局の鍵（k<局の通し番号>h<本場>）。FX-4: 東1局 k0h0・東2局 k1h0・東2局1本場 k1h1・東3局 k2h0・東3局1本場 k2h1。 */
const FX4_KEYS = ['k0h0', 'k1h0', 'k1h1', 'k2h0', 'k2h1'];

function storeOf(texts: Record<string, string>): SummaryStore {
  return new SummaryStore(async (id) => texts[id] ?? null, noPause);
}

async function settle(store: SummaryStore, ids: string[]) {
  await vi.waitFor(() => {
    for (const id of ids) expect(store.getSnapshot().get(id)?.status, id).toBe('ready');
  });
}

const percents = (state: { fit: { exact: number | null; withinOne: number | null } }) => [
  percentOf(state.fit.exact),
  percentOf(state.fit.withinOne),
];

function gradesOf(store: SummaryStore, id: string): Array<Grade | null> {
  const state = store.getSnapshot().get(id);
  if (state?.status !== 'ready') throw new Error(`まとめが無い: ${id}`);
  return state.summary.kyokus.map((k) => k.grade);
}

describe('U-31 当てはめの入力（fitInputOf）', () => {
  const ready = (text: string) => {
    const state = summarizeReportText(text);
    if (state.status !== 'ready') throw new Error('読めない');
    return state.summary;
  };

  it('MAKA の評価を入れた局だけが記録になる（点数は Rating の 100 倍）。入れていない半荘は、入力に出ない', () => {
    const fx4 = ready(FX4_TEXT);
    const input = fitInputOf([
      { sessionId: 'a', summary: fx4, maka: { k1h1: 'A-', k2h0: 'S' } },
      { sessionId: 'b', summary: fx4, maka: {} },
    ]);
    expect(input.users.map((u) => [u.sessionId, u.label, u.grade])).toEqual([
      ['a', '東2局1本場', 'A-'],
      ['a', '東3局', 'S'],
    ]);
    expect(input.users[0]?.score).toBeCloseTo((fx4.kyokus[2]?.rating as number) * 100, 9);
    // 半荘の突き合わせに使う局（点数のあるすべての局）は、評価を入れた半荘だけ
    expect(input.sessions.map((s) => [s.sessionId, s.kyokus.length])).toEqual([['a', 5]]);
  });

  it('知らない段階の名前・知らない局の鍵は、無いものとして扱う（保存した値が壊れていても止まらない）', () => {
    const fx4 = ready(FX4_TEXT);
    const input = fitInputOf([{ sessionId: 'a', summary: fx4, maka: { k0h0: 'Z', k9h9: 'S', k1h0: 'B' } }]);
    expect(input.users.map((u) => [u.label, u.grade])).toEqual([['東2局', 'B']]);
  });

  it('並びは、半荘の名前の順（読み込みが終わる順に左右されない）。入力が空の印は空の文字列', () => {
    const fx4 = ready(FX4_TEXT);
    const a = fitInputOf([
      { sessionId: 'b', summary: fx4, maka: { k0h0: 'S' } },
      { sessionId: 'a', summary: fx4, maka: { k0h0: 'A' } },
    ]);
    const b = fitInputOf([
      { sessionId: 'a', summary: fx4, maka: { k0h0: 'A' } },
      { sessionId: 'b', summary: fx4, maka: { k0h0: 'S' } },
    ]);
    expect(a.users.map((u) => u.sessionId)).toEqual(['a', 'b']);
    expect(fitSignature(a)).toBe(fitSignature(b));
    expect(fitSignature(fitInputOf([]))).toBe('');
    expect(fitSignature(a)).not.toBe(fitSignature(fitInputOf([{ sessionId: 'a', summary: fx4, maka: { k0h0: 'B' } }])));
  });

  it('判断の無い局（点数が無い）に入れた評価は、記録にならない', () => {
    const parsed = parseReportText(FX4_TEXT);
    if (!parsed.ok) throw new Error('読めない');
    const report = structuredClone(parsed.value);
    (report.review.kyokus[0] as { entries: unknown[] }).entries = [];
    const summary = summarizeHanchan(report);
    expect(summary.kyokus[0]?.rating).toBeNull();
    const input = fitInputOf([{ sessionId: 'a', summary, maka: { k0h0: 'S', k1h0: 'B' } }]);
    expect(input.users.map((u) => u.label)).toEqual(['東2局']);
  });
});

describe('U-31 まとめの覚え方と、MAKA の評価からの当てはめ直し（SummaryStore）', () => {
  it('最初は、基礎の 67 局の当てはめ（ぴったり 34%・±1段階以内 66%）。まとめの段階は、既定の当てはめのもの', async () => {
    const store = storeOf({ a: FX4_TEXT });
    expect(store.getFit()).toEqual(initialFitState());
    expect(store.getFit().fit.recordCount).toBe(67);
    expect(store.getFit().revision).toBe(0);
    expect(percents(store.getFit())).toEqual([34, 66]);
    store.sync([session('a')]);
    await settle(store, ['a']);
    expect(store.getFit().revision).toBe(0);
    const state = store.getSnapshot().get('a');
    expect(state?.status === 'ready' && state.summary.grade).toBe(predictGrade(DEFAULT_GRADE_MODEL, 93.0));
  });

  it('MAKA の評価を 1 つ入れると、局数が 68 になって当てはめ直し、まとめの段階が新しい当てはめのものに替わる（半荘全体も）', async () => {
    const store = storeOf({ a: FX4_TEXT, b: FX4_TEXT });
    store.sync([session('a'), session('b')]);
    await settle(store, ['a', 'b']);
    const before = gradesOf(store, 'a');
    const beforeFit = store.getFit();
    // 東2局1本場（Rating 86.5）を C- と入れる
    store.sync([session('a', { k1h1: 'C-' }), session('b')]);
    const fit = store.getFit();
    expect(fit).not.toBe(beforeFit);
    expect(fit.revision).toBe(1);
    expect(fit.fit.recordCount).toBe(68);
    expect(fit.fit.userCount).toBe(1);
    expect(fit.fit.model.recordCount).toBe(68);
    // 見込みは、エンジンの fitMaka と同じ値
    const parsed = summarizeReportText(FX4_TEXT);
    if (parsed.status !== 'ready') throw new Error('読めない');
    const expected = fitMaka(
      [{ sessionId: 'a', label: '東2局1本場', score: (parsed.summary.kyokus[2]?.rating as number) * 100, grade: 'C-' }],
      [{ sessionId: 'a', kyokus: parsed.summary.kyokus.map((k) => ({ label: k.label, score: (k.rating as number) * 100 })) }],
    );
    expect(fit.fit.exact).toBe(expected.exact);
    expect(fit.fit.withinOne).toBe(expected.withinOne);
    // 覚えているすべてのまとめの段階が、新しい当てはめのもの（評価を入れていない半荘 b も）。Rating は変わらない
    const after = gradesOf(store, 'a');
    expect(after).not.toEqual(before);
    expect(gradesOf(store, 'b')).toEqual(after);
    const state = store.getSnapshot().get('a');
    if (state?.status !== 'ready') throw new Error('まとめが無い');
    for (const kyoku of state.summary.kyokus) {
      expect(kyoku.grade).toBe(predictGrade(fit.fit.model, (kyoku.rating as number) * 100));
    }
    expect(state.summary.grade).toBe(predictGrade(fit.fit.model, (state.summary.rating as number) * 100));
    expect(state.summary.ratingText).toBe('93.0');
  });

  it('評価を入れるたびに局数が 1 ずつ増え、入れ直すと同じ局の記録が替わり、消すと基礎の 67 局に戻る', async () => {
    const store = storeOf({ a: FX4_TEXT });
    store.sync([session('a')]);
    await settle(store, ['a']);
    const counts: number[] = [];
    const maka: MakaGrades['kyokus'] = {};
    for (const [i, key] of FX4_KEYS.entries()) {
      maka[key] = (['S', 'A', 'B', 'C', 'D'] as const)[i] as string;
      store.sync([session('a', { ...maka })]);
      counts.push(store.getFit().fit.recordCount);
    }
    expect(counts).toEqual([68, 69, 70, 71, 72]);
    expect(store.getFit().revision).toBe(5);
    // 同じ局の評価を替える: 局数は同じで、当てはめが替わる
    const revision = store.getFit().revision;
    store.sync([session('a', { ...maka, k0h0: 'E' })]);
    expect(store.getFit().fit.recordCount).toBe(72);
    expect(store.getFit().revision).toBe(revision + 1);
    // 全部消す: 基礎の 67 局・既定の当てはめに戻り、段階も既定のものに戻る
    store.sync([session('a')]);
    expect(store.getFit().fit.recordCount).toBe(67);
    expect(store.getFit().fit.model).toEqual(DEFAULT_GRADE_MODEL);
    expect(percents(store.getFit())).toEqual([34, 66]);
    const state = store.getSnapshot().get('a');
    expect(state?.status === 'ready' && state.summary.grade).toBe(predictGrade(DEFAULT_GRADE_MODEL, 93.0));
  });

  it('評価が変わっていなければ、当てはめ直さない（一覧を読み直すたびに、値は同じ）', async () => {
    const store = storeOf({ a: FX4_TEXT });
    store.sync([session('a', { k0h0: 'S' })]);
    await settle(store, ['a']);
    const fit = store.getFit();
    const snapshot = store.getSnapshot();
    // 一覧を読み直すと、半荘の値は新しい物になるが、中身は同じ
    store.sync([session('a', { k0h0: 'S' })]);
    expect(store.getFit()).toBe(fit);
    expect(store.getSnapshot()).toBe(snapshot);
  });

  it('まとめを読み終える前から入れてある評価は、読み終えたときに数える（起動のとき）', async () => {
    const store = storeOf({ a: FX4_TEXT });
    store.sync([session('a', { k0h0: 'S', k1h0: 'A' })]);
    expect(store.getFit().fit.recordCount).toBe(67);
    await settle(store, ['a']);
    expect(store.getFit().fit.recordCount).toBe(69);
    expect(store.getFit().fit.userCount).toBe(2);
    // 読み込みの途中で作ったまとめも、いまの当てはめの段階になる
    const state = store.getSnapshot().get('a');
    if (state?.status !== 'ready') throw new Error('まとめが無い');
    expect(state.summary.grade).toBe(predictGrade(store.getFit().fit.model, (state.summary.rating as number) * 100));
  });

  it('消した半荘（一覧に無い半荘）の評価は数えない。元に戻したら、また数える（D-3）', async () => {
    const store = storeOf({ a: FX4_TEXT, b: FX4_TEXT });
    store.sync([session('a', { k0h0: 'S' }), session('b', { k1h0: 'B' })]);
    await settle(store, ['a', 'b']);
    expect(store.getFit().fit.recordCount).toBe(69);
    // b を消した（一覧から外れた）
    store.sync([session('a', { k0h0: 'S' })]);
    expect(store.getFit().fit.recordCount).toBe(68);
    expect(store.getFit().fit.userCount).toBe(1);
    // b を戻した
    store.sync([session('a', { k0h0: 'S' }), session('b', { k1h0: 'B' })]);
    await settle(store, ['a', 'b']);
    expect(store.getFit().fit.recordCount).toBe(69);
  });

  it('基礎の半荘と同じ半荘（f9da…。中身が同じ）の局の評価は、基礎の記録を置き換える（局数は 67 のまま）', async () => {
    const store = storeOf({ x: REPORT_TEXTS.fx1a });
    store.sync([session('x')]);
    await settle(store, ['x']);
    // 東2局の MAKA は、基礎では S。D と入れ直す
    const baseGrade = MAKA_BASE_RECORDS.find((r) => r.game === F9DA && r.label === '東2局')?.grade;
    expect(baseGrade).toBe('S');
    store.sync([session('x', { k1h0: 'D' })]);
    expect(store.getFit().fit.recordCount).toBe(67);
    expect(store.getFit().fit.userCount).toBe(1);
    expect(store.getFit().fit.replacedCount).toBe(1);
    expect(store.getFit().fit.model).not.toEqual(DEFAULT_GRADE_MODEL);
    // 基礎と同じ評価を入れ直しても、当てはめは変わらない
    store.sync([session('x', { k1h0: 'S' })]);
    expect(store.getFit().fit.model).toEqual(DEFAULT_GRADE_MODEL);
    expect(percents(store.getFit())).toEqual([34, 66]);
  });

  it('当てはめが替わるたびに、受け手に知らせる（外すと止まる）', async () => {
    const store = storeOf({ a: FX4_TEXT });
    let calls = 0;
    const off = store.subscribe(() => {
      calls += 1;
    });
    store.sync([session('a')]);
    await settle(store, ['a']);
    const before = calls;
    store.sync([session('a', { k0h0: 'S' })]);
    expect(calls).toBeGreaterThan(before);
    off();
    const done = calls;
    store.sync([session('a', { k0h0: 'B' })]);
    expect(calls).toBe(done);
    expect(store.getFit().revision).toBe(2);
  });
});
