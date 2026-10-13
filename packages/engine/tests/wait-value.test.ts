import { describe, expect, it } from 'vitest';

import type { Decision } from '../src/decision';
import { importReportText } from '../src/import';
import { coreTenpaiWaits } from '../src/majiang-adapter';
import { actualChoice } from '../src/quiz-choice';
import type { BoardState } from '../src/replay';
import type { Fuuro } from '../src/report-types';
import { type Tile, countTiles, parseTenhouNotation } from '../src/tiles';
import { type WaitPlan, type WaitRow, type WaitTable, MAX_WAIT_TABLES, waitBoxOf, waitPlansOf, waitTableOf } from '../src/wait-value';
import { FX1_IDS, FX4_ID, FX5_ID, loadReportText } from './helpers/fixtures';

// F14・E-36・E-37: 答え合わせのタブ「待ちと打点」の中身（wait-value.ts）。聴牌になる行動だけに表が出る。数字は、承認された見本（15回目）の値と同じ。
// 正解表との照合（役・飜・符・点数・符の内訳・待ちの形）は win-value-oracle.test.ts。ここは、表の作り方と、手で作った待ちの形。

function loadGame(id: string) {
  const game = importReportText(loadReportText(id));
  if (!game.ok) throw new Error(game.error.message);
  return game.value;
}

const games = new Map([...FX1_IDS, FX4_ID, FX5_ID].map((id) => [id, loadGame(id)]));

function decisionOf(id: string, label: string, entry: number): Decision {
  const d = games.get(id)?.decisions.find((x) => x.kyokuLabel === label && x.entryIndex === entry);
  if (d === undefined) throw new Error(`場面が見つかりません: ${id} ${label} ${entry}`);
  return d;
}

/** 手で作った盤面（東場・自分は親から数えて 1 つ目の南家）。 */
function boardOf(over: Partial<BoardState> = {}): BoardState {
  return {
    playerId: 1,
    kyokuIndex: 0,
    roundWind: 'E',
    kyoku: 1,
    honba: 0,
    kyotaku: 0,
    oya: 0,
    seatWinds: ['E', 'S', 'W', 'N'],
    scores: [25000, 25000, 25000, 25000],
    doraMarkers: [],
    tilesLeft: 50,
    junme: 5,
    hand: [],
    drawn: null,
    handCounts: [13, 13, 13, 13],
    rivers: [[], [], [], []],
    melds: [[], [], [], []],
    riichi: ['none', 'none', 'none', 'none'],
    ...over,
  };
}

function planOf(hand: string, melds: Fuuro[] = [], discard: Tile | null = null): WaitPlan {
  return { key: 'x', tags: [], discard, option: null, hand: parseTenhouNotation(hand), melds, extraSeen: new Array<number>(34).fill(0) };
}

function tableOf(hand: string, over: Partial<BoardState> = {}, melds: Fuuro[] = []): WaitTable {
  const table = waitTableOf({ board: boardOf({ melds: [[], melds, [], []], ...over }) }, planOf(hand, melds));
  if (table === null) throw new Error(`聴牌ではありません: ${hand}`);
  return table;
}

const shapesOf = (table: WaitTable) => table.waits.map((w) => `${w.tile}:${w.shapes.join('／')}`);

describe('E-37 待ちの形（手で作った例）', () => {
  it('両面: 連続する 2 枚の両側（23m の 1m・4m）', () => {
    const table = tableOf('23m456p789s11122z');
    expect(shapesOf(table)).toEqual(['1m:両面', '4m:両面']);
    expect(table.shape).toBe('両面');
    expect(table.wide).toBe(false);
  });

  it('嵌張: 真ん中の 1 枚（13m の 2m）', () => {
    expect(shapesOf(tableOf('13m456p789s11122z'))).toEqual(['2m:嵌張']);
  });

  it('辺張: 12m の 3m、89m の 7m', () => {
    expect(shapesOf(tableOf('12m456p789s11122z'))).toEqual(['3m:辺張']);
    expect(shapesOf(tableOf('89m456p789s11122z'))).toEqual(['7m:辺張']);
  });

  it('双碰: 2 組の対子のどちらか（11m と 55m の 1m・5m）。残りは、手牌の 2 枚を除いた 2 枚ずつ', () => {
    const table = tableOf('1155m456p789s111z');
    expect(shapesOf(table)).toEqual(['1m:双碰', '5m:双碰']);
    expect(table.waits.map((w) => w.remaining)).toEqual([2, 2]);
    expect(table.shape).toBe('双碰');
  });

  it('単騎: 1 枚の対子待ち（2z の南）', () => {
    const table = tableOf('234m456p789s1112z');
    expect(shapesOf(table)).toEqual(['S:単騎']);
    expect(table.shape).toBe('単騎');
  });

  it('七対子の待ちも単騎（4z の北）', () => {
    const table = tableOf('1133m5577p2299s4z');
    expect(table.waits.map((w) => w.tile)).toEqual(['N']);
    expect(table.waits[0]?.shapes).toEqual(['単騎']);
  });

  it('3 種類以上の待ちは、手全体の形を「多面張」と言う（34567m の 2m・5m・8m）', () => {
    const table = tableOf('34567m456p789s11z');
    expect(table.waits.map((w) => w.tile)).toEqual(['2m', '5m', '8m']);
    expect(table.shape).toBe('多面張');
    expect(table.wide).toBe(true);
    expect(table.waits.every((w) => w.shapes.length > 0)).toBe(true);
  });

  it('解釈が複数あるときは、全部並べる（2344m の 4m は、234 を完成させる両面と、44 の単騎）', () => {
    const table = tableOf('2344m456p789s111z');
    const four = table.waits.find((w) => w.tile === '4m') as WaitRow;
    expect(four.shapes).toEqual(expect.arrayContaining(['両面', '単騎']));
    expect(four.shapes).toHaveLength(2);
  });
});

describe('F14 待ちと打点の表（手で作った盤面）', () => {
  it('門前の手は、ダマ・リーチ × ロン・ツモを並べ、副露した手はリーチを出さない', () => {
    const closed = tableOf('23m456p789s11122z');
    expect(closed.closed).toBe(true);
    expect(closed.waits.every((w) => w.riichi !== null)).toBe(true);
    // 南家（自風 南）の手で、南の雀頭は役牌の符。ダマの 1m ロンは、役が無い（東の暗刻は場風だが、ロンで完成していない）
    const open = tableOf('23m456p789s22z', {}, [{ type: 'pon', target: 2, pai: 'E', consumed: ['E', 'E'] }]);
    expect(open.closed).toBe(false);
    expect(open.waits.every((w) => w.riichi === null)).toBe(true);
    expect(open.waits.map((w) => w.tile)).toEqual(['1m', '4m']);
    // 場風の東をポンしているので役牌 1 飜、副露した手の符は 20 + 明刻（幺九牌）4 + 雀頭（南は自風）2 = 26 → 30
    const ron = open.waits[0]?.dama.ron;
    expect(ron?.han).toBe(1);
    expect(ron?.fu).toBe(30);
    expect(ron?.base).toBe(1000);
  });

  it('自分の河にある牌の待ちは、フリテンの印が付く。切る牌も河に数える', () => {
    const board = boardOf({ rivers: [[], [{ tile: '4m', tsumogiri: false, riichi: false, calledBy: null }], [], []] });
    const table = waitTableOf({ board }, planOf('23m456p789s11122z'));
    expect(table?.waits.map((w) => [w.tile, w.furiten])).toEqual([
      ['1m', false],
      ['4m', true],
    ]);
    const cut = waitTableOf({ board: boardOf() }, planOf('23m456p789s11122z', [], '1m'));
    expect(cut?.waits.map((w) => [w.tile, w.furiten])).toEqual([
      ['1m', true],
      ['4m', false],
    ]);
  });

  it('残り枚数は、自分の手牌・場に見えている牌（河・副露・ドラ表示牌）・切る牌を除く', () => {
    const board = boardOf({
      doraMarkers: ['3m'], // ドラ表示牌 3m（見えている）
      rivers: [[], [], [{ tile: '1m', tsumogiri: true, riichi: false, calledBy: null }], [{ tile: '1m', tsumogiri: false, riichi: false, calledBy: 2 }]],
      melds: [[], [], [{ type: 'pon', target: 3, pai: '1m', consumed: ['1m', '1m'] }], []],
    });
    // 1m: 河 1 + 鳴かれた牌は河で数えず副露で 3 = 4 → 残り 0。4m: 手牌 0・見えている 0 → 4
    const table = waitTableOf({ board }, planOf('23m456p789s11122z'));
    expect(table?.waits.map((w) => [w.tile, w.remaining])).toEqual([
      ['1m', 0],
      ['4m', 4],
    ]);
    expect(table?.remaining).toBe(4);
  });

  it('赤ドラは、手牌の中の赤だけを数える。和了牌は赤でない牌として数える', () => {
    // 手牌に 5pr（赤）。待ちの 1m・4m は赤でない牌として和了るので、赤ドラは 1 のまま
    const table = tableOf('23m406p789s11122z');
    expect(table.waits.map((w) => w.aka)).toEqual([1, 1]);
    // 待ちが 5 の牌（赤を持っていても、和了牌が赤のときの赤ドラは数えない）
    const five = tableOf('34m666p789s11122z');
    expect(five.waits.map((w) => w.tile)).toEqual(['2m', '5m']);
    expect(five.waits.every((w) => w.aka === 0)).toBe(true);
  });

  it('符の内訳の合計が、画面の符と合わないときは、内訳を出さない（符の数だけ）', () => {
    const table = tableOf('23m456p789s11122z');
    for (const w of table.waits) for (const line of [w.dama.ron, w.dama.tsumo, w.riichi?.ron, w.riichi?.tsumo]) {
      if (line === undefined || line.none) continue;
      expect(line.fuBreakdown?.rounded).toBe(line.fu);
    }
  });
});

describe('F14 判断ごとの表（実戦の半荘）', () => {
  it('リーチの判断（南4局 10巡目）: 聴牌になる切り方すべてに表。形は多面張・嵌張。符の内訳は承認された見本と同じ', () => {
    const d = decisionOf(FX5_ID, '南4局', 10);
    expect(d.kind).toBe('riichi');
    const box = waitBoxOf(d, actualChoice(d));
    expect(box).not.toBeNull();
    const tables = (box as NonNullable<typeof box>).tables;
    // 1s と 4s は、待ちも点も同じ（多面張 6s・9s・南）なので、1 つの表にまとまる（承認された見本の「待ちも点も同じ」）
    expect(tables.map((t) => [t.discard, t.shape, t.remaining])).toEqual([
      ['1s', '多面張', 6],
      ['6s', '嵌張', 4],
      ['9s', '嵌張', 4],
    ]);
    expect(tables[0]?.tags).toEqual(['AI']);
    expect(tables[0]?.same).toEqual([{ discard: '4s', tags: [] }]);
    expect(tables[1]?.same).toEqual([]);
    const six = tables[0]?.waits.find((w) => w.tile === '6s') as WaitRow;
    // ロン 8000（4 飜 40 符）・ツモ 2000・4000（5 飜 30 符）、リーチはロン 8000（5 飜 40 符）・ツモ 3000・6000（6 飜 30 符）
    expect([six.dama.ron.han, six.dama.ron.fu, six.dama.ron.base, six.dama.ron.limit]).toEqual([4, 40, 8000, '満貫']);
    expect([six.dama.tsumo.han, six.dama.tsumo.fu, six.dama.tsumo.tsumoPay]).toEqual([5, 30, { child: 2000, dealer: 4000 }]);
    expect([six.riichi?.ron.han, six.riichi?.ron.fu, six.riichi?.ron.base]).toEqual([5, 40, 8000]);
    expect(six.riichi?.tsumo.tsumoPay).toEqual({ child: 3000, dealer: 6000 });
    expect(six.yaku.map((y) => `${y.name}${y.han}`)).toEqual(['一盃口1', '混一色3']);
    // 40符の内訳: 副底 20・門前ロン 10・明刻（中張牌・ロンで完成）2・連風牌の雀頭 4。合計 36 を 10 符単位に切り上げて 40
    const fu = six.dama.ron.fuBreakdown;
    expect(fu?.items).toEqual([
      { label: '副底', fu: 20 },
      { label: '門前ロン', fu: 10 },
      { label: '明刻（中張牌・ロンで完成）', fu: 2 },
      { label: '連風牌の雀頭', fu: 4 },
    ]);
    expect([fu?.total, fu?.rounded]).toEqual([36, 40]);
    expect(fu?.note).toBe('ロンで完成した刻子は、明刻として数える（暗刻の半分の符）');
    // 場風・自風が同じ南の役牌は 1 行にまとめる
    const south = tables[0]?.waits.find((w) => w.tile === 'S') as WaitRow;
    expect(south.yaku.map((y) => `${y.name}${y.han}`)).toEqual(['役牌 南（場風・自風）2', '一盃口1', '混一色3']);
  });

  it('待ちも点も同じ表だけをまとめる: 待ち・残り・形・飜・符・点数のどれかが違えば、別の表のまま', () => {
    const d = decisionOf(FX5_ID, '南4局', 10);
    const box = waitBoxOf(d, actualChoice(d));
    // まとめる前の表（聴牌になる 4 つの切り方）の数と、まとめたあとの数
    const plans = waitPlansOf(d, actualChoice(d)).filter((p) => waitTableOf(d, p) !== null);
    expect(plans).toHaveLength(4);
    expect(box?.tables).toHaveLength(3);
    // まとめた表の、ほかの切り方も、元の表と同じ待ち・同じ点
    const merged = box?.tables[0] as WaitTable;
    const other = waitTableOf(d, plans.find((p) => p.discard === '4s') as WaitPlan) as WaitTable;
    expect(other.waits.map((w) => [w.tile, w.remaining, w.dama.ron.base])).toEqual(merged.waits.map((w) => [w.tile, w.remaining, w.dama.ron.base]));
    // スルー（切る牌が無い表）は、ほかの表とまとめない
    const call = games.get(FX5_ID)?.decisions.find((x) => x.kyokuLabel === '東4局' && x.kind === 'call' && x.junme === 8) as Decision;
    const callBox = waitBoxOf(call, actualChoice(call));
    expect(callBox?.tables.find((t) => t.discard === null)?.same).toEqual([]);
  });

  it('ダマでロンできない待ち（役が無い）は、ロンを「なし」にし、役の欄には役を付けた分を出す（東4局1本場 4巡目）', () => {
    const d = decisionOf(FX5_ID, '東4局1本場', 4);
    const box = waitBoxOf(d, actualChoice(d));
    const table = box?.tables[0] as WaitTable;
    expect(table.discard).toBe('4p');
    const wait = table.waits[0] as WaitRow;
    expect(wait.shapes).toEqual(['嵌張']);
    expect(wait.dama.ron.none).toBe(true);
    expect(wait.dama.ron.fuBreakdown).toBeNull();
    // ドラ 1・赤ドラ 1 だけで、役は無い。ツモなら門前清自摸和が付く（3 飜 30 符）。リーチなら 3 飜 40 符（5200）
    expect(wait.yaku).toEqual([]);
    expect([wait.dora, wait.aka]).toEqual([1, 1]);
    expect([wait.dama.tsumo.han, wait.dama.tsumo.fu]).toEqual([3, 30]);
    expect([wait.riichi?.ron.han, wait.riichi?.ron.fu, wait.riichi?.ron.base]).toEqual([3, 40, 5200]);
  });

  it('両面の聴牌で、片方の待ちだけ役が無い（南4局 5巡目）。実戦と AI の打牌に印', () => {
    const d = decisionOf(FX5_ID, '南4局', 5);
    const box = waitBoxOf(d, actualChoice(d));
    const table = box?.tables[0] as WaitTable;
    expect(table.tags).toEqual(['実戦', 'AI']);
    expect(table.waits.map((w) => [w.tile, w.remaining, w.dama.ron.none])).toEqual([
      ['5s', 4, true],
      ['8s', 1, false],
    ]);
  });

  it('ポンのあとの打牌の判断（東4局 8巡目）: 自分・実戦の打牌と AI の打牌に表。副露した手はリーチを出さない', () => {
    const d = decisionOf(FX5_ID, '東4局', 8);
    const box = waitBoxOf(d, actualChoice(d));
    expect(box?.tables.map((t) => [t.tags.join('・'), t.discard, t.shape])).toEqual([
      ['自分・実戦', '3m', '双碰'],
      ['AI', '5m', '嵌張'],
    ]);
    expect(box?.tables.every((t) => !t.closed && t.waits.every((w) => w.riichi === null))).toBe(true);
  });

  it('鳴きの判断（東4局 8巡目）: スルーは、いまの手の待ち。チーは、鳴いたあとに切る牌ごとの表（印の無いボタンは「候補」）', () => {
    const d = decisionOf(FX5_ID, '東4局', 8);
    const call = games.get(FX5_ID)?.decisions.find((x) => x.kyokuLabel === '東4局' && x.kind === 'call' && x.junme === 8) as Decision;
    const box = waitBoxOf(call, actualChoice(call));
    expect(box).not.toBeNull();
    const pass = box?.tables.find((t) => t.option?.kind === 'pass');
    expect(pass?.discard).toBeNull();
    expect(pass?.tags).toEqual(['自分', '実戦', 'AI']);
    const chi = box?.tables.find((t) => t.option?.kind === 'chi');
    expect(chi?.discard).not.toBeNull();
    expect(chi?.tags).toEqual([]);
    void d;
  });

  it('聴牌にならない判断は、表が無い（null）。カン・和了の判断も null', () => {
    let tenpai = 0;
    let none = 0;
    for (const game of games.values()) {
      for (const d of game.decisions) {
        const box = waitBoxOf(d, actualChoice(d));
        if (d.kind === 'kan' || d.kind === 'win') {
          expect(box, `${d.kyokuLabel} ${d.junme}巡目 ${d.kind}`).toBeNull();
          continue;
        }
        // 切っても 1 向聴以上の判断は、聴牌になる切り方が無い
        if (d.kind === 'discard' && d.shanten >= 1) {
          expect(box, `${d.kyokuLabel} ${d.junme}巡目`).toBeNull();
          none++;
        }
        if (box !== null) {
          tenpai++;
          expect(box.tables.length).toBeGreaterThan(0);
          expect(box.tables.length).toBeLessThanOrEqual(MAX_WAIT_TABLES);
        }
      }
    }
    expect(tenpai).toBeGreaterThan(30);
    expect(none).toBeGreaterThan(300);
  });

  it('全判断で、表の待ちが majiang-core の待ちと一致し、リーチは門前の表だけ。残りは 0〜4 枚', () => {
    let tables = 0;
    for (const game of games.values()) {
      for (const d of game.decisions) {
        const me = d.board.playerId;
        for (const plan of waitPlansOf(d, null)) {
          const table = waitTableOf(d, plan);
          const kinds = coreTenpaiWaits(plan.hand, plan.melds, me);
          if (table === null) {
            expect(kinds, `${d.kyokuLabel} ${d.junme}巡目 ${plan.key}`).toEqual([]);
            continue;
          }
          tables++;
          expect(table.waits.map((w) => w.kind)).toEqual(kinds);
          expect(table.closed).toBe(plan.melds.every((m) => m.type === 'ankan'));
          for (const w of table.waits) {
            expect(w.remaining).toBeGreaterThanOrEqual(0);
            expect(w.remaining).toBeLessThanOrEqual(4 - (countTiles(plan.hand)[w.kind] as number));
            expect(w.riichi === null).toBe(!table.closed);
            expect(w.shapes.length).toBeGreaterThan(0);
          }
        }
      }
    }
    expect(tables).toBeGreaterThan(150);
  });
});
