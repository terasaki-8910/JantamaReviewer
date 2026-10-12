import Majiang from '@kobalab/majiang-core';
import { describe, expect, it } from 'vitest';

import { importReportText } from '../src/import';
import { shantenOfCounts } from '../src/shanten';
import { TILE_KIND_COUNT, countTiles, tileKind } from '../src/tiles';
import { evaluateWin, waitsOf, yakuMeldOf } from '../src/yaku';
import { nearYaku } from '../src/yaku-near';
import { SHAPE_YAKU, type YakuId } from '../src/yaku';
import { FX1_IDS, FX4_ID, FX5_ID, loadFixtureJson, loadReportText } from './helpers/fixtures';
import { majiangEvaluate, majiangHand, majiangWaits } from './helpers/majiang-evaluate';
import { type OracleWin, type YakuOracleFixture, oracleIds, oracleYakuman, shapeOf } from './helpers/yaku-oracle';

// 役の調査: @kobalab/majiang-core（MIT。電脳麻将の基本ライブラリ）の hule・tingpai を、Python の mahjong ライブラリの正解表と、
// エンジンの自前の実装（yaku.ts）の両方と突き合わせる。majiang-core を土台にできるか（analysis/yaku/README.md の比較）の根拠。

const oracle = loadFixtureJson<YakuOracleFixture>('yaku-oracle.json');

function winInput(r: OracleWin) {
  return { ...shapeOf(r), winKind: r.win, tsumo: r.tsumo, riichi: r.riichi };
}

describe('majiang-core の hule・tingpai: Python の mahjong ライブラリの正解表との照合', () => {
  it('和了形（役満を含む）: 役の一覧・飜数・符が全部一致する。役満は種類が一致する', () => {
    let compared = 0;
    let yakuman = 0;
    for (const r of [...oracle.complete, ...oracle.wins]) {
      const ev = majiangEvaluate(winInput(r));
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
        expect(ev.han, where).toBe(0);
      }
      compared++;
    }
    expect(compared).toBeGreaterThan(3500);
    expect(yakuman).toBeGreaterThan(100);
  });

  it('聴牌の手: 待ち（tingpai。副露に 4 枚ある牌を除く）と、待ちごとの役（ロン）が全部一致する', () => {
    let waitsChecked = 0;
    for (const r of oracle.tenpai) {
      const shape = shapeOf(r);
      const where = `${r.closed} ${JSON.stringify(r.melds)}`;
      const meldCounts = new Array<number>(TILE_KIND_COUNT).fill(0);
      for (const m of shape.melds) {
        if (m.type === 'seq') for (let i = 0; i < 3; i++) meldCounts[m.first + i] = (meldCounts[m.first + i] as number) + 1;
        else meldCounts[m.first] = (meldCounts[m.first] as number) + (m.type === 'kan' ? 4 : 3);
      }
      const waits = majiangWaits(shape.counts, shape.melds).filter((k) => (shape.counts[k] as number) + (meldCounts[k] as number) < 4);
      expect(waits, where).toEqual(Object.keys(r.waits).map(Number));
      for (const k of waits) {
        const theirs = r.waits[String(k)];
        if (theirs === undefined) continue;
        const counts = [...shape.counts];
        counts[k] = (counts[k] as number) + 1;
        const ev = majiangEvaluate({ ...shape, counts, winKind: k, tsumo: false, riichi: r.riichi });
        if (theirs.yakuman) {
          expect(ev.yakuman.length > 0, `${where} 待ち ${k}`).toBe(true);
        } else {
          expect(ev.hits.map((h) => h.id).sort(), `${where} 待ち ${k}`).toEqual(oracleIds(theirs.yaku));
        }
        waitsChecked++;
      }
    }
    expect(waitsChecked).toBeGreaterThan(2000);
  });
});

describe('エンジンの自前の実装（yaku.ts）と majiang-core: 和了牌・自摸/ロン・風を変えた全部の組み合わせで一致する', () => {
  it('和了形 1500 手 × 和了牌（手牌の全種類）× 自摸/ロン × 風 2 通り（正解表の風と、1 つずらした風）: 役・飜数・符・役満が全部一致する', () => {
    const winds = ['E', 'S', 'W', 'N'] as const;
    let compared = 0;
    for (const r of oracle.complete.slice(0, 1500)) {
      const shape = shapeOf(r);
      const closed = shape.melds.every((m) => !m.open);
      for (let kind = 0; kind < TILE_KIND_COUNT; kind++) {
        if ((shape.counts[kind] as number) === 0) continue;
        for (const tsumo of [true, false]) {
          for (const shift of [0, 1]) {
            const seatWind = winds[(winds.indexOf(r.seat) + shift) % 4] as (typeof winds)[number];
            const roundWind = winds[(winds.indexOf(r.round) + shift) % 4] as (typeof winds)[number];
            const input = { ...shape, seatWind, roundWind, winKind: kind, tsumo, riichi: r.riichi && closed };
            const own = evaluateWin(input);
            const theirs = majiangEvaluate(input);
            const where = `${r.closed} ${JSON.stringify(r.melds)} 和了牌 ${kind} ${tsumo ? '自摸' : 'ロン'} 自風 ${seatWind} 場風 ${roundWind}`;
            expect(own.kind !== 'none', where).toBe(theirs.kind !== 'none');
            if (own.kind === 'none') continue;
            expect([...own.yakuman].sort(), where).toEqual([...theirs.yakuman].sort());
            if (own.yakuman.length > 0) continue;
            expect(own.hits.map((h) => h.id).sort(), where).toEqual(theirs.hits.map((h) => h.id).sort());
            if (own.han > 0) {
              expect(own.han, where).toBe(theirs.han);
              expect(own.fu, where).toBe(theirs.fu);
            }
            compared++;
          }
        }
      }
    }
    expect(compared).toBeGreaterThan(20_000);
  });
});

describe('majiang-core の xiangting（向聴数）: エンジンの向聴数と一致する', () => {
  it('実戦の全判断（7 半荘 1159 件。ツモ牌つきの 14 枚も、鳴きの判断の 13 枚も、副露つきも）で同じ値', () => {
    let n = 0;
    for (const id of [...FX1_IDS, FX4_ID, FX5_ID]) {
      const game = importReportText(loadReportText(id));
      if (!game.ok) throw new Error(game.error.message);
      for (const d of game.value.decisions) {
        const b = d.board;
        const tiles = b.drawn === null ? [...b.hand] : [...b.hand, b.drawn];
        const counts = countTiles(tiles);
        const melds = (b.melds[b.playerId] ?? []).map(yakuMeldOf);
        const shoupai = Majiang.Shoupai.fromString(majiangHand(counts, melds, b.drawn === null ? null : tileKind(b.drawn)));
        expect(Majiang.Util.xiangting(shoupai), `${id} ${d.kyokuLabel} ${d.junme}巡目`).toBe(shantenOfCounts(counts));
        n++;
      }
    }
    expect(n).toBe(1159);
  });
});

describe('近い役を、majiang-core の hule の上に載せる（nearYaku の evaluate を差し替える）', () => {
  interface NearSample extends Pick<OracleWin, 'closed' | 'melds' | 'seat' | 'round'> {
    min_r: number | null;
    by_yaku: Record<string, number>;
    rmax_used?: number;
  }
  const near = loadFixtureJson<{ rmax: number; samples: NearSample[] }>('yaku-near.json');

  it('力ずくの正解表（418 手）と、役ごとの距離が全部一致する（自前の evaluateWin を使うときと同じ）', () => {
    let checked = 0;
    for (const s of near.samples) {
      const shape = shapeOf(s);
      const rmax = s.rmax_used ?? near.rmax;
      const result = nearYaku(shape, { extra: 99, maxDraws: rmax, evaluate: majiangEvaluate });
      const mine = new Map<YakuId, number>(result.near.map((n) => [n.id, n.draws]));
      const theirs = new Map<YakuId, number>();
      for (const [name, r] of Object.entries(s.by_yaku)) {
        const [id] = oracleIds([name]);
        if (id !== undefined) theirs.set(id, r);
      }
      for (const id of SHAPE_YAKU) {
        expect(mine.get(id) ?? null, `${s.closed} ${JSON.stringify(s.melds)} ${id}`).toBe(theirs.get(id) ?? null);
        if (mine.has(id)) checked++;
      }
    }
    expect(checked).toBeGreaterThan(1000);
  });

  it('settledYaku の待ちごとの役も、majiang-core の hule で同じになる（実戦の和了 69 件の直前の聴牌）', () => {
    for (const w of oracle.wins) {
      const shape = shapeOf(w);
      const counts = [...shape.counts];
      counts[w.win] = (counts[w.win] as number) - 1;
      const own = waitsOf({ ...shape, counts }, w.riichi).find((x) => x.kind === w.win);
      const ev = majiangEvaluate({ ...shape, winKind: w.win, tsumo: false, riichi: w.riichi });
      expect(own?.hits.map((h) => h.id).sort(), `${w.game} ${w.kyoku}`).toEqual(ev.hits.map((h) => h.id).sort());
    }
  });
});
