import { describe, expect, it } from 'vitest';

import { compareDiscardUkeire } from '../src/discard-compare';
import { decisionKey } from '../src/decision-ref';
import { type ImportedGame, importReportText } from '../src/import';
import { findDecisionByKey } from '../src/problems';
import type { BoardState } from '../src/replay';
import { discardOptions } from '../src/shanten';
import { countTiles, tileKind } from '../src/tiles';
import { discardDetails, findDiscardDetail, meldTiles, visibleTileCounts } from '../src/ukeire-remaining';
import { FX4_ID, loadFixtureJson, loadReportText } from './helpers/fixtures';

interface RemainingFixture {
  library: string;
  report: string;
  scenes: Array<{
    key: string;
    reasons: string[];
    junme: number;
    tiles: number;
    visible: Record<string, number>;
    options: Array<{
      discard: string;
      shanten: number;
      ukeire: number;
      remaining: number;
      accepted: Array<[string, number, number]>;
    }>;
  }>;
}

const fixture = loadFixtureJson<RemainingFixture>('remaining-fx4.json');

function load(id: string): ImportedGame {
  const r = importReportText(loadReportText(id));
  if (!r.ok) throw new Error(`${id}: ${r.error.message}`);
  return r.value;
}

describe('E-22 受け入れの残り: FX-4 の迷いと悪手の 10 場面の全打牌が、独立した実装（Python）の値と一致する', () => {
  const game = load(FX4_ID);

  it('E-22 正解表は FX-4 の 10 場面（迷い 6 + 悪手 5。迷い 2 は両方）で、Python の mahjong ライブラリで作ってある', () => {
    expect(fixture.library).toMatch(/^mahjong /);
    expect(fixture.report).toBe(FX4_ID);
    expect(fixture.scenes).toHaveLength(10);
    expect(fixture.scenes.filter((s) => s.reasons.some((r) => r.startsWith('迷い')))).toHaveLength(6);
    expect(fixture.scenes.filter((s) => s.reasons.includes('悪手'))).toHaveLength(5);
    expect(fixture.scenes.find((s) => s.key === 'k1h0e12')?.reasons).toEqual(['迷い2', '悪手']);
    // 手牌が 14 枚（3n+2）でない場面（鳴きの判断）は、切る牌が無い
    expect(fixture.scenes.filter((s) => s.options.length === 0).map((s) => s.key)).toEqual(['k1h1e10']);
  });

  for (const scene of fixture.scenes) {
    it(`E-22 ${scene.key}（${scene.reasons.join('・')}）: 切る牌ごとの、向聴数・手牌だけの枚数・残り・受け入れ牌ごとの枚数が一致する`, () => {
      const decision = findDecisionByKey(game, scene.key);
      expect(decision, scene.key).toBeDefined();
      if (!decision) return;
      expect(decision.junme).toBe(scene.junme);
      const details = discardDetails(decision.board);
      const actual = details.map((d) => ({
        discard: d.tile,
        shanten: d.shanten,
        ukeire: d.ukeire,
        remaining: d.remaining,
        accepted: d.accepted.map((a): [string, number, number] => [a.tile, a.count, a.remaining]),
      }));
      expect(actual).toEqual(scene.options);
      // 場に見えている牌の枚数も、正解表の「見えた牌」と一致する
      const visible = visibleTileCounts(decision.board);
      const expected = new Array<number>(34).fill(0);
      for (const [tile, n] of Object.entries(scene.visible)) expected[tileKind(tile)] = n;
      expect(visible).toEqual(expected);
    });
  }

  it('E-22 受け入れ牌の「手牌だけの枚数」は、これまでの数え方（E-3）のまま。残りはそれ以下で、0 未満にならない', () => {
    let checked = 0;
    for (const scene of fixture.scenes) {
      const decision = findDecisionByKey(game, scene.key);
      if (!decision) continue;
      const tiles = decision.board.drawn === null ? [...decision.board.hand] : [...decision.board.hand, decision.board.drawn];
      if (tiles.length % 3 !== 2) continue;
      const options = discardOptions(tiles);
      const details = discardDetails(decision.board);
      expect(details.map((d) => d.kind)).toEqual(options.map((o) => o.kind));
      for (const [i, detail] of details.entries()) {
        const option = options[i];
        expect(detail.ukeire).toBe(option?.ukeire);
        for (const [j, a] of detail.accepted.entries()) {
          expect(a.count).toBe(option?.accepted[j]?.remaining);
          expect(a.remaining).toBeGreaterThanOrEqual(0);
          expect(a.remaining).toBeLessThanOrEqual(a.count);
          checked++;
        }
      }
    }
    expect(checked).toBeGreaterThan(100);
  });

  it('E-22 compareDiscardUkeire は、同じ判断の残りを返す（自分・実戦・AI・最大の行は、ここから引ける）', () => {
    const decision = findDecisionByKey(game, 'k1h1e9');
    expect(decision).toBeDefined();
    if (!decision) return;
    const cmp = compareDiscardUkeire(decision, '6m');
    expect(cmp).not.toBeNull();
    if (!cmp) return;
    expect(cmp.details).toEqual(discardDetails(decision.board));
    const mine = findDiscardDetail(cmp.details, '6m');
    expect(mine?.shanten).toBe(2);
    const actual = findDiscardDetail(cmp.details, '4p');
    expect(actual?.shanten).toBe(1);
    expect(actual?.ukeire).toBe(12);
  });
});

describe('E-22 場に見えている牌の数え方（作った盤面で）', () => {
  /** 場の見えている牌の数え方だけを確かめる、最小の盤面。 */
  function board(partial: Partial<BoardState>): Pick<BoardState, 'rivers' | 'melds' | 'doraMarkers'> {
    return {
      rivers: [[], [], [], []],
      melds: [[], [], [], []],
      doraMarkers: [],
      ...partial,
    };
  }
  const river = (tile: string, calledBy: 0 | 1 | 2 | 3 | null = null) => ({ tile, tsumogiri: false, riichi: false, calledBy });

  it('E-22 河の牌と、ドラ表示牌を 1 枚ずつ数える。赤五は普通の五と同じ種類', () => {
    const counts = visibleTileCounts(
      board({
        rivers: [[river('5mr'), river('5m')], [river('E')], [], [river('E')]],
        doraMarkers: ['5m', 'S'],
      }),
    );
    expect(counts[tileKind('5m')]).toBe(3);
    expect(counts[tileKind('E')]).toBe(2);
    expect(counts[tileKind('S')]).toBe(1);
  });

  it('E-22 鳴かれた牌は、河では数えず、副露の中で 1 回だけ数える（チー・ポン・大明槓）', () => {
    const counts = visibleTileCounts(
      board({
        rivers: [[], [river('3s', 2)], [], []],
        melds: [[], [], [{ type: 'chi', target: 1, pai: '3s', consumed: ['4s', '5s'] }], []],
      }),
    );
    expect(counts[tileKind('3s')]).toBe(1);
    expect(counts[tileKind('4s')]).toBe(1);
    expect(counts[tileKind('5s')]).toBe(1);
    const kan = visibleTileCounts(
      board({
        rivers: [[river('P', 1)], [], [], []],
        melds: [[], [{ type: 'daiminkan', target: 0, pai: 'P', consumed: ['P', 'P', 'P'] }], [], []],
      }),
    );
    expect(kan[tileKind('P')]).toBe(4);
  });

  it('E-22 暗槓は 4 枚、加槓は鳴いた牌・手牌から出した牌・加えた牌の 4 枚', () => {
    expect(meldTiles({ type: 'ankan', consumed: ['7p', '7p', '7p', '7p'] })).toHaveLength(4);
    const kakan = meldTiles({ type: 'kakan', pai: '7p', previous_pon_target: 2, previous_pon_pai: '7p', consumed: ['7p', '7p'] });
    expect(kakan).toHaveLength(4);
    const counts = visibleTileCounts(
      board({
        rivers: [[], [], [river('7p', 0)], []],
        melds: [[{ type: 'kakan', pai: '7p', previous_pon_target: 2, previous_pon_pai: '7p', consumed: ['7p', '7p'] }], [], [], []],
      }),
    );
    expect(counts[tileKind('7p')]).toBe(4);
  });

  it('E-22 残りは、4 から、切ったあとの手牌の数・見えている数・切る牌自身を引き、0 未満にしない', () => {
    // 14 枚: 1m 1m 2m 3m 4m 5m 6m 7m 8m 9m 1p 2p 3p 9s。1m は手牌に 2 枚、河に 1 枚、ドラ表示牌に 1 枚 → 4 枚とも見えている
    const hand = ['1m', '1m', '2m', '3m', '4m', '5m', '6m', '7m', '8m', '9m', '1p', '2p', '3p'];
    const b: Pick<BoardState, 'hand' | 'drawn' | 'rivers' | 'melds' | 'doraMarkers'> = {
      hand,
      drawn: '9s',
      rivers: [[river('1m')], [], [], []],
      melds: [[], [], [], []],
      doraMarkers: ['1m'],
    };
    const details = discardDetails(b);
    expect(details).toHaveLength(13);
    const own = countTiles([...hand, '9s']);
    expect(own[tileKind('1m')]).toBe(2);
    // 9s を切るなら、残りは、すべての受け入れ牌で「4 − 手牌 − 見えている」。1m は手牌 2 + 河 1 + ドラ表示牌 1 = 4 で、残り 0
    const cut9s = findDiscardDetail(details, '9s');
    expect(cut9s).toBeDefined();
    for (const a of cut9s?.accepted ?? []) {
      const inHand = own[a.kind] as number;
      const seen = (a.tile === '1m' ? 2 : 0) + (a.tile === '9s' ? 1 : 0);
      expect(a.count).toBe(4 - inHand);
      expect(a.remaining).toBe(Math.max(0, 4 - inHand - seen));
    }
    // 切る牌そのものが受け入れ牌になる打牌（9m を切ると、9m 自身は見えている 1 枚と数える）
    const cut9m = findDiscardDetail(details, '9m');
    const back = cut9m?.accepted.find((a) => a.tile === '9m');
    if (back) {
      expect(back.count).toBe(4 - ((own[tileKind('9m')] as number) - 1));
      expect(back.remaining).toBe(back.count - 1);
    }
  });

  it('E-22 3n+1 枚の手牌（鳴きの判断）には、切る牌が無いので空', () => {
    expect(
      discardDetails({
        hand: ['1m', '2m', '3m', '4m', '5m', '6m', '7m', '8m', '9m', '1p', '2p', '3p', '9s'],
        drawn: null,
        rivers: [[], [], [], []],
        melds: [[], [], [], []],
        doraMarkers: [],
      }),
    ).toEqual([]);
  });
});

describe('E-22 判断の鍵', () => {
  it('E-22 鍵（k<局>h<本場>e<番号>）で判断を引ける', () => {
    const game = load(FX4_ID);
    const d = game.decisions[0];
    expect(d).toBeDefined();
    if (!d) return;
    expect(findDecisionByKey(game, decisionKey(d.kyoku, d.honba, d.entryIndex))).toBe(d);
    expect(findDecisionByKey(game, 'k9h9e9')).toBeUndefined();
  });
});


