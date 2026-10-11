// @vitest-environment node
/**
 * 評価の当てはめ直し（`ratingRelink.ts`。E-31）の試験。保存の窓口（`RelinkApi`）は偽物に差し替える。
 * 固定データは FX-5（10 月 11 日の半荘）。ユーザーの本物の links.json は、前の当てはめ方（局の読み取りと押した順だけ）で作ったもので、
 * 東3局に評価が無かったので、東3局1本場から後の評価が 1 局ずつ前にずれていた。
 */
import { describe, expect, it } from 'vitest';

import { FX4_TEXT, FX5_ID, FX5_STARTED, FX5_TEXT, FX5_USER_CHOICES, fx5Ocr, fx5Session } from '../../tests/import-fixtures';
import type { Links, SessionRecord } from '../api/types';
import { needsRatingRelink, relinkRatings, type RelinkApi } from './ratingRelink';

/** ユーザーの本物の links.json の評価（前の当てはめ方で作ったもの。評価の版は無い）。評価の id → 局の鍵。 */
const OLD_RATINGS: Record<string, string> = {
  '1': 'k0h0',
  '5': 'k1h0',
  '7': 'k2h0',
  '11': 'k2h1',
  '12': 'k3h0',
  '15': 'k3h1',
  '18': 'k4h2',
  '20': 'k5h0',
  '22': 'k6h0',
};

/** FX-5 の正しい評価の当てはめ（東3局 k2h0 は空欄）。 */
const NEW_RATINGS: Record<string, string> = {
  '1': 'k0h0',
  '5': 'k1h0',
  '7': 'k2h1',
  '11': 'k3h0',
  '12': 'k3h1',
  '15': 'k4h2',
  '18': 'k5h0',
  '20': 'k6h0',
  '22': 'k7h0',
};

function session(overrides: Partial<SessionRecord> = {}): SessionRecord {
  return fx5Session(FX5_ID, FX5_STARTED, {
    report_path: 'C:\\data\\games\\20261011-153540\\report.json',
    ocr: fx5Ocr(),
    links: { marks: { ...FX5_USER_CHOICES }, ratings: { ...OLD_RATINGS } },
    self_ratings: { kyokus: { k7h0: 'fair' } },
    ...overrides,
  });
}

/** 保存の窓口の偽物。`replaceRatingLinks` で、手元の記録の評価と版だけを置き換える（Rust 側と同じ決まり）。 */
function fakeApi(initial: SessionRecord, options: { report?: string | null; failSave?: string } = {}) {
  let current = initial;
  const calls: Array<{ ratings: Record<string, string>; version: number }> = [];
  const api: RelinkApi = {
    listSessions: async () => [current],
    readReport: async () => (options.report === undefined ? FX5_TEXT : options.report),
    replaceRatingLinks: async (_id, ratings, version) => {
      if (options.failSave !== undefined) throw options.failSave;
      calls.push({ ratings, version });
      current = { ...current, links: { ...current.links, ratings, ratings_version: version } };
    },
  };
  return { api, calls, get session() { return current; } };
}

describe('E-31 当てはめ直しが要るか', () => {
  const base = session();

  it('結果を取り込んであり、評価があり、当てはめ方の版が無い（昔の当てはめ方）か、いまの版（2）より小さいとき', () => {
    expect(needsRatingRelink(base)).toBe(true);
    expect(needsRatingRelink({ ...base, links: { ...base.links, ratings_version: 1 } })).toBe(true);
    expect(needsRatingRelink({ ...base, links: { ...base.links, ratings_version: 0 } })).toBe(true);
  });

  it('いまの版（2）以上なら要らない。取り込み前・評価が無い半荘も要らない', () => {
    expect(needsRatingRelink({ ...base, links: { ...base.links, ratings_version: 2 } })).toBe(false);
    expect(needsRatingRelink({ ...base, links: { ...base.links, ratings_version: 3 } })).toBe(false);
    expect(needsRatingRelink({ ...base, report_path: null })).toBe(false);
    expect(needsRatingRelink({ ...base, ratings: [] })).toBe(false);
  });
});

describe('E-31 前の当てはめ方で作った評価の結びつけを、1 回だけ当てはめ直して保存する（FX-5）', () => {
  it('評価 9 つが、FX-5 の評価の局になる（東1局 △・東2局 △・東3局 空・東3局1本場 〇・東4局 ✕・東4局1本場 〇・南1局2本場 △・南2局 ✕・南3局 〇・南4局 ✕）。版 2 を書く', async () => {
    const fake = fakeApi(session());
    expect(await relinkRatings(fake.api, FX5_ID)).toBe(true);
    expect(fake.calls).toEqual([{ ratings: NEW_RATINGS, version: 2 }]);
    // 東3局（k2h0）に当てはまった評価は無い
    expect(Object.values(fake.calls[0]?.ratings ?? {})).not.toContain('k2h0');
  });

  it('迷いの結びつけ（links.marks）と、表で付け直した〇△✕（self-ratings）は、窓口に渡さない = 変えない', async () => {
    const original = session();
    const fake = fakeApi(original);
    await relinkRatings(fake.api, FX5_ID);
    // 評価の結びつけと版だけを渡す（迷いの結びつけは、引数に無い）
    expect(Object.keys(fake.calls[0] ?? {}).sort()).toEqual(['ratings', 'version']);
    expect(fake.session.links.marks).toEqual(original.links.marks);
    expect(fake.session.self_ratings).toEqual({ kyokus: { k7h0: 'fair' } });
  });

  it('当てはめ直したあとは、もう一度呼んでも何もしない（版が書いてあるので、1 回だけ）', async () => {
    const fake = fakeApi(session());
    expect(await relinkRatings(fake.api, FX5_ID)).toBe(true);
    expect(await relinkRatings(fake.api, FX5_ID)).toBe(false);
    expect(fake.calls).toHaveLength(1);
  });

  it('利用者が選んだ迷いの結びつけを、手がかりに使う（選びが無くても、読み取りだけで FX-5 は同じ結果になる）', async () => {
    const withoutChoices = fakeApi(session({ links: { marks: {}, ratings: { ...OLD_RATINGS } } }));
    await relinkRatings(withoutChoices.api, FX5_ID);
    expect(withoutChoices.calls[0]?.ratings).toEqual(NEW_RATINGS);
    // 選んだ判断が、読み取りと違う局のとき（迷い id=3 を、南1局2本場の判断にした）は、その局の手がかりが勝つ
    const moved: Links = { marks: { '3': 'k4h2e2' }, ratings: { ...OLD_RATINGS } };
    const withChoice = fakeApi(session({ links: moved }));
    await relinkRatings(withChoice.api, FX5_ID);
    expect(withChoice.calls[0]?.ratings).not.toEqual(NEW_RATINGS);
  });

  it('読み取りの写しが無くても（文字認識を使えなかった）、迷いの選びと押した順で当てはめ直す。評価の数だけ書く', async () => {
    const fake = fakeApi(session({ ocr: null }));
    expect(await relinkRatings(fake.api, FX5_ID)).toBe(true);
    expect(Object.keys(fake.calls[0]?.ratings ?? {}).sort((a, b) => Number(a) - Number(b))).toEqual(['1', '5', '7', '11', '12', '15', '18', '20', '22']);
    expect(fake.calls[0]?.version).toBe(2);
  });

  it('当てはめられなかった評価は、空の文字列（どの局にも結びつけない）で書く', async () => {
    // 評価が局より多い（FX-4 の結果に FX-5 の評価 9 つを当てると、5 局に入りきらない）
    const fake = fakeApi(session(), { report: FX4_TEXT });
    expect(await relinkRatings(fake.api, FX5_ID)).toBe(true);
    const written = Object.values(fake.calls[0]?.ratings ?? {});
    expect(written).toHaveLength(9);
    expect(written.filter((value) => value === '').length).toBeGreaterThan(0);
  });
});

describe('E-31 要らないとき・できないとき', () => {
  it('版が新しい・評価が無い・取り込み前・半荘が見つからないときは、何も書かず false', async () => {
    const done = fakeApi(session({ links: { marks: {}, ratings: { ...NEW_RATINGS }, ratings_version: 2 } }));
    expect(await relinkRatings(done.api, FX5_ID)).toBe(false);
    expect(done.calls).toEqual([]);
    expect(await relinkRatings(fakeApi(session({ ratings: [] })).api, FX5_ID)).toBe(false);
    expect(await relinkRatings(fakeApi(session({ report_path: null })).api, FX5_ID)).toBe(false);
    expect(await relinkRatings(fakeApi(session()).api, 'no-such-session')).toBe(false);
  });

  it('結果を読めないとき（無い・空・JSON でない）は、何も書かず false', async () => {
    for (const report of [null, '', '<html>error</html>']) {
      const fake = fakeApi(session(), { report });
      expect(await relinkRatings(fake.api, FX5_ID), String(report)).toBe(false);
      expect(fake.calls).toEqual([]);
    }
  });

  it('保存に失敗したら投げる（版を書けていないので、次の起動でもう一度試せる）', async () => {
    const fake = fakeApi(session(), { failSave: 'ディスクがいっぱいです' });
    await expect(relinkRatings(fake.api, FX5_ID)).rejects.toBe('ディスクがいっぱいです');
    expect(needsRatingRelink(fake.session)).toBe(true);
  });
});
