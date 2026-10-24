import { describe, expect, it } from 'vitest';

import { countTiles, parseTenhouNotation } from '../src/tiles';
import { SHAPE_YAKU, type YakuId, type YakuShape, evaluateWin, fixedYaku, settledYaku, waitsOf, yakuMeldOf } from '../src/yaku';
import { loadFixtureJson } from './helpers/fixtures';
import { type OracleWin, type YakuOracleFixture, oracleIds, oracleYakuman, shapeOf } from './helpers/yaku-oracle';

const oracle = loadFixtureJson<YakuOracleFixture>('yaku-oracle.json');

function evaluate(r: OracleWin) {
  return evaluateWin({ ...shapeOf(r), winKind: r.win, tsumo: r.tsumo, riichi: r.riichi });
}

describe('役の判定: Python の mahjong ライブラリ（HandCalculator）を正解として', () => {
  it('正解表の作りが期待どおり（ライブラリのバージョン、件数、見ている役が一通り出てくる）', () => {
    expect(oracle.library).toBe('mahjong 2.0.0');
    expect(oracle.complete.length).toBe(4000); // E-33: 和了形 4000
    expect(oracle.tenpai.length).toBe(1500); // E-33: 聴牌の手 1500
    expect(oracle.wins.length).toBe(69);
    // どの役も、正解表に十分な数（20 件以上）出てくる
    const seen = new Map<YakuId, number>();
    for (const r of oracle.complete) {
      if (r.oracle.yakuman) continue;
      for (const id of oracleIds(r.oracle.yaku)) seen.set(id, (seen.get(id) ?? 0) + 1);
    }
    for (const id of [...SHAPE_YAKU, 'riichi', 'tsumo'] as const) {
      expect(seen.get(id) ?? 0, `${id} の件数`).toBeGreaterThanOrEqual(20);
    }
  });

  it('和了形: 役の一覧・飜数・符が全部一致する。役満の手は、役満の種類が一致する', () => {
    let compared = 0;
    let yakuman = 0;
    for (const r of oracle.complete) {
      const ev = evaluate(r);
      const where = `${r.closed} ${JSON.stringify(r.melds)} 和了牌 ${r.win} ${r.tsumo ? '自摸' : 'ロン'}`;
      if (r.oracle.yakuman) {
        expect([...ev.yakuman].sort(), where).toEqual(oracleYakuman(r.oracle.yaku));
        yakuman++;
        continue;
      }
      expect(ev.yakuman, where).toEqual([]);
      expect(ev.hits.map((h) => h.id).sort(), where).toEqual(oracleIds(r.oracle.yaku));
      if (r.oracle.error === null) {
        expect(ev.han, where).toBe(r.oracle.han);
        expect(ev.fu, where).toBe(r.oracle.fu);
      } else {
        expect(r.oracle.error).toBe('no_yaku');
        expect(ev.han, where).toBe(0);
      }
      compared++;
    }
    expect(compared).toBeGreaterThan(3500);
    expect(yakuman).toBeGreaterThan(100);
  });

  it('実戦の和了 69 件（7 半荘）: 役の一覧・飜数・符が全部一致する（役満は無い）', () => {
    for (const r of oracle.wins) {
      expect(r.oracle.yakuman).toBe(false);
      const ev = evaluate(r);
      const where = `${r.game} ${r.kyoku} 席${r.actor ?? ''} ${r.closed}`;
      expect(ev.hits.map((h) => h.id).sort(), where).toEqual(oracleIds(r.oracle.yaku));
      if (r.oracle.error === null) {
        expect(ev.han, where).toBe(r.oracle.han);
        expect(ev.fu, where).toBe(r.oracle.fu);
      }
    }
  });

  it('聴牌の手（ロン）: 待ちの牌の集まりと、待ちごとの役が一致する。役が付かない待ちは、ライブラリが no_yaku にする待ち', () => {
    let compared = 0;
    let dead = 0;
    for (const r of oracle.tenpai) {
      const shape = shapeOf(r);
      const waits = waitsOf(shape, r.riichi);
      const where = `${r.closed} ${JSON.stringify(r.melds)}`;
      expect(
        waits.map((w) => w.kind),
        where,
      ).toEqual(Object.keys(r.waits).map(Number));
      for (const w of waits) {
        const theirs = r.waits[String(w.kind)];
        expect(theirs, where).toBeDefined();
        if (theirs === undefined) continue;
        expect(w.yakuman.length > 0, `${where} 待ち ${w.tile}`).toBe(theirs.yakuman);
        if (theirs.yakuman) continue;
        expect(w.hits.map((h) => h.id).sort(), `${where} 待ち ${w.tile}`).toEqual(oracleIds(theirs.yaku));
        if (theirs.error === 'no_yaku') dead++;
        else expect(w.han, `${where} 待ち ${w.tile}`).toBe(theirs.han);
      }
      compared++;
    }
    expect(compared).toBeGreaterThan(1200);
    expect(dead).toBeGreaterThan(80);
  });

  it('確定している役: 聴牌なら全ての待ちで付く役、そうでなければ副露で決まる役だけ', () => {
    let tenpai = 0;
    for (const r of oracle.tenpai) {
      const settled = settledYaku(shapeOf(r), r.riichi);
      const lists = Object.values(r.waits)
        .filter((w) => !w.yakuman)
        .map((w) => oracleIds(w.yaku));
      if (lists.length === 0) continue; // 待ちが全部役満の手は、普通の役を数えない
      const common = (lists[0] ?? []).filter((id) => lists.every((l) => l.includes(id)));
      expect(settled.settled.map((h) => h.id).sort(), `${r.closed} ${JSON.stringify(r.melds)}`).toEqual(common);
      expect(settled.tenpai).toBe(Object.keys(r.waits).length > 0);
      if (settled.tenpai) tenpai++;
    }
    expect(tenpai).toBeGreaterThan(1200);
  });

  it('副露か手の中の役牌で決まる役: 副露の役が先、手の中の役牌の刻子があと。同じ役は 1 度だけ。聴牌していない手の確定している役と同じ', () => {
    // 白をポン。手の中に發と自風の南の刻子（場風は東）
    const hand = countTiles(parseTenhouNotation('14m25p6s222z666z'));
    const pon = { type: 'tri', first: 31, open: true } as const;
    const shape: YakuShape = { counts: hand, melds: [pon], seatWind: 'S', roundWind: 'E' };
    expect(fixedYaku(shape).map((hit) => [hit.id, hit.han])).toEqual([
      ['yakuhai-haku', 1],
      ['yakuhai-hatsu', 1],
      ['yakuhai-seat', 1],
    ]);
    // 副露にも手の中にも同じ役があれば足さない（実際の手では起きないが、足す決まりとして）
    expect(fixedYaku({ ...shape, melds: [{ type: 'tri', first: 32, open: true }] }).map((hit) => hit.id)).toEqual(['yakuhai-hatsu', 'yakuhai-seat']);
    // 役牌の無い手・順子だけの副露は、空
    expect(fixedYaku({ counts: countTiles(parseTenhouNotation('147m258p369s1z')), melds: [{ type: 'seq', first: 0, open: true }], seatWind: 'S', roundWind: 'E' })).toEqual([]);
    // 聴牌していない 3n+1 枚の手の「確定している役」は、これと同じ
    const scattered: YakuShape = { ...shape, counts: countTiles(parseTenhouNotation('147m258p3s222z')) };
    const settled = settledYaku(scattered);
    expect(settled.tenpai).toBe(false);
    expect(settled.settled).toEqual(fixedYaku(scattered));
    expect(settled.settled.map((hit) => hit.id)).toEqual(['yakuhai-haku', 'yakuhai-seat']);
  });

  it('副露の変換: 結果 JSON のチー・ポン・槓を、順子・刻子・槓子にする', () => {
    expect(yakuMeldOf({ type: 'chi', target: 0, pai: '3m', consumed: ['4m', '5mr'] })).toEqual({ type: 'seq', first: 2, open: true });
    expect(yakuMeldOf({ type: 'pon', target: 1, pai: 'E', consumed: ['E', 'E'] })).toEqual({ type: 'tri', first: 27, open: true });
    expect(yakuMeldOf({ type: 'ankan', consumed: ['P', 'P', 'P', 'P'] })).toEqual({ type: 'kan', first: 31, open: false });
    expect(yakuMeldOf({ type: 'daiminkan', target: 2, pai: '9s', consumed: ['9s', '9s', '9s'] })).toEqual({ type: 'kan', first: 26, open: true });
    expect(yakuMeldOf({ type: 'kakan', pai: '1p', previous_pon_target: 3, previous_pon_pai: '1p', consumed: ['1p', '1p', '1p'] })).toEqual({
      type: 'kan',
      first: 9,
      open: true,
    });
  });
});
