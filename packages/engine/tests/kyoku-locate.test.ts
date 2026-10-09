import { describe, expect, it } from 'vitest';

import { importReport } from '../src/import';
import { kyokuFactsOf, kyokuFits, locateKyokus } from '../src/kyoku-locate';
import { parseReportText } from '../src/report';
import type { MortalReport } from '../src/report-types';
import { splitKyokus } from '../src/replay';
import { FX1_IDS, FX4_ID, loadReportJson, loadReportText } from './helpers/fixtures';

const ALL_IDS = [...FX1_IDS, FX4_ID];

function load(id: string): MortalReport {
  const r = parseReportText(loadReportText(id));
  if (!r.ok) throw new Error(r.error.message);
  return r.value;
}

/** 本人のリーチが成立した局の、成立したときの残りのツモ枚数（目で数えて書いた期待値。局の添字 → 残り枚数）。 */
const RIICHI: Record<string, Record<number, number[]>> = {
  f9da87cbcd7af5e9: { 1: [33] },
  f738896995c33fed: { 0: [46], 2: [28], 5: [28], 6: [49] },
  be0a2a523fdd7758: { 8: [45], 9: [34] },
  '002ca97adccc486d': { 3: [52], 7: [35], 9: [21] },
  '3a36dac7c7fc18ce': { 1: [29], 5: [55], 10: [45], 11: [34] },
  [FX4_ID]: {},
};

describe('局の照合の土台（kyokuFactsOf）', () => {
  it('局ごとの、局の名前・局の始めの点数が、牌譜（start_kyoku）と一致する（FX-1 の5半荘と FX-4 の全76局）', () => {
    let kyokus = 0;
    for (const id of ALL_IDS) {
      const report = load(id);
      const facts = kyokuFactsOf(report);
      const logs = splitKyokus(report.mjai_log);
      expect(facts, id).toHaveLength(report.review.kyokus.length);
      facts.forEach((f, i) => {
        expect(f.position, id).toBe(i);
        expect(f.startScore, `${id} ${f.label}`).toBe(logs[i]?.start.scores[report.player_id]);
        kyokus++;
      });
    }
    expect(kyokus).toBe(12 + 13 + 11 + 16 + 15 + 5);
  });

  it('本人のリーチが成立したときの残りの枚数が、期待どおり（ほかの局は空）', () => {
    for (const id of ALL_IDS) {
      const facts = kyokuFactsOf(load(id));
      facts.forEach((f, i) => expect(f.riichiTilesLeft, `${id} ${f.label}`).toEqual(RIICHI[id]?.[i] ?? []));
    }
  });

  it('リーチの成立の前後は、盤面の再生（board.riichi）と食い違わない: 成立後の判断は残り枚数が成立時以下、成立前は成立時以上', () => {
    let after = 0;
    for (const id of ALL_IDS) {
      const imported = importReport(loadReportJson(id));
      if (!imported.ok) throw new Error(imported.error.message);
      const facts = kyokuFactsOf(imported.value.report);
      for (const d of imported.value.decisions) {
        const accepted = facts[d.kyokuPosition]?.riichiTilesLeft[0];
        if (accepted === undefined) continue;
        if (d.board.riichi[imported.value.playerId] === 'accepted') {
          expect(d.entry.tiles_left, `${id} ${d.kyokuLabel} ${d.junme}巡目`).toBeLessThanOrEqual(accepted);
          after++;
        } else {
          expect(d.entry.tiles_left, `${id} ${d.kyokuLabel} ${d.junme}巡目`).toBeGreaterThanOrEqual(accepted);
        }
      }
    }
    expect(after).toBeGreaterThan(0);
  });

  it('牌譜の局の並びが review.kyokus と食い違っても（局が欠けている）、局の始めの点数は review から取り、リーチの情報だけ空になる', () => {
    const report = structuredClone(load('f9da87cbcd7af5e9'));
    // 牌譜から 2 局目（東2局）の start_kyoku を、局の名前が違うものに書き換える（本場を変える）
    const start = report.mjai_log.filter((e) => e.type === 'start_kyoku')[1];
    if (!start || start.type !== 'start_kyoku') throw new Error('start_kyoku が無い');
    start.honba = 9;
    const facts = kyokuFactsOf(report);
    expect(facts[1]?.startScore).toBe(25000);
    expect(facts[1]?.riichiTilesLeft).toEqual([]);
    expect(facts[0]?.riichiTilesLeft).toEqual([]);
  });
});

describe('局の照合（kyokuFits・locateKyokus）', () => {
  const report = load('f9da87cbcd7af5e9');
  const facts = kyokuFactsOf(report);

  it('局の名前（場風と局の番号）が違えば、点数が合っても当たらない', () => {
    const east2 = facts[1];
    if (!east2) throw new Error('東2局が無い');
    expect(kyokuFits(east2, { wind: 'E', number: 2, score: 25000 })).toBe(true);
    expect(kyokuFits(east2, { wind: 'E', number: 3, score: 25000 })).toBe(false);
    expect(kyokuFits(east2, { wind: 'S', number: 2, score: 25000 })).toBe(false);
    expect(kyokuFits(east2, { wind: 'W', number: 2, score: 25000 })).toBe(false);
  });

  it('局の番号が 1〜4 の整数でない読み取りは、どの局にも当たらない（次の風の局と取り違えない）', () => {
    const east1 = facts[0];
    const south1 = facts.find((f) => f.label === '南1局');
    if (!east1 || !south1) throw new Error('東1局か南1局が無い');
    for (const number of [0, 5, 1.5, -1, Number.NaN]) {
      expect(kyokuFits(east1, { wind: 'E', number, score: 25000 }), `${number}`).toBe(false);
      expect(kyokuFits(south1, { wind: 'E', number, score: south1.startScore }), `${number}`).toBe(false);
    }
  });

  it('点数が局の始めより高い・1000 点の倍数でない差は当たらない', () => {
    const east2 = facts[1];
    if (!east2) throw new Error('東2局が無い');
    for (const score of [25100, 26000, 24500, 24999, 0, -1000]) {
      expect(kyokuFits(east2, { wind: 'E', number: 2, score }), `${score}`).toBe(false);
    }
  });

  it('リーチが成立した残り枚数（33枚）ちょうどは、引いた点数にも引かない点数にも当たる', () => {
    const east2 = facts[1];
    if (!east2) throw new Error('東2局が無い');
    expect(kyokuFits(east2, { wind: 'E', number: 2, score: 24000, tilesLeft: 33 })).toBe(true);
    expect(kyokuFits(east2, { wind: 'E', number: 2, score: 25000, tilesLeft: 33 })).toBe(true);
    expect(kyokuFits(east2, { wind: 'E', number: 2, score: 24000, tilesLeft: 34 })).toBe(false);
    expect(kyokuFits(east2, { wind: 'E', number: 2, score: 24000, tilesLeft: 0 })).toBe(true);
  });

  it('locateKyokus は、当たる局を半荘の順に返す。当たらなければ空', () => {
    expect(locateKyokus(facts, { wind: 'E', number: 2, score: 32800 }).map((f) => f.label)).toEqual(['東2局1本場']);
    expect(locateKyokus(facts, { wind: 'E', number: 2, score: 25000 }).map((f) => f.label)).toEqual(['東2局']);
    expect(locateKyokus(facts, { wind: 'W', number: 3, score: 25000 })).toEqual([]);
  });
});
