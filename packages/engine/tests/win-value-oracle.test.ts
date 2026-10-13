import { describe, expect, it } from 'vitest';

import { fuBreakdownOf, fuDetailOf } from '../src/fu-detail';
import { importReportText } from '../src/import';
import { type WaitShape, type WinSpec, coreEvaluateWin, coreTenpaiWaits, coreWaitShapes } from '../src/majiang-adapter';
import type { Fuuro, Seat, Wind } from '../src/report-types';
import { type Tile, countTiles, kindToTile, parseTenhouNotation, tileKind } from '../src/tiles';
import { type WinInput, YAKU_NAMES, type YakuId, yakuMeldOf } from '../src/yaku';
import { FIXTURES_DIR, FX1_IDS, FX4_ID, FX5_ID, loadFixtureJson, loadReportText } from './helpers/fixtures';
import { horaCasesOf } from './helpers/hora-rebuild';
import { ORACLE_YAKU_IDS, meldsOf } from './helpers/yaku-oracle';

// E-36（待ちと打点）・E-37（待ちの形）・E-38（符の内訳）: Python の mahjong ライブラリの正解表（fixtures/win-value-oracle.json。
// 作り方は generate_win_value.py）と、majiang-core（majiang-adapter.ts）・エンジンの符の内訳（fu-detail.ts）を全部照らす。
// 正解表は、実戦の聴牌になる手（win-value-hands.json。7 半荘の全判断の、聴牌になる行動すべて）の待ちごとの、ダマ・リーチ × ロン・ツモ
// （とその変種: 自風を 1 つずらして本場 1・供託 1）と、乱数の和了形の符の内訳。

interface OracleResult {
  e: string | null;
  h?: number;
  f?: number;
  m?: number;
  a?: number;
  t?: number;
  y?: string[];
  x?: boolean;
  d?: Array<[string, number]>;
}

interface OracleHand {
  id: string;
  waits: number[];
  cases: Record<string, Record<string, OracleResult>>;
}

interface OracleRandom {
  id: string;
  closed: string;
  melds: [string, number, boolean][];
  win: number;
  tsumo: boolean;
  riichi: boolean;
  seat: Wind;
  round: Wind;
  result: OracleResult;
}

interface DumpedHand {
  id: string;
  closed: Tile[];
  melds: Fuuro[];
  actor: Seat;
  seat: number;
  round: Wind;
  dora: Tile[];
}

const oracle = loadFixtureJson<{ library: string; hands: OracleHand[]; random: OracleRandom[] }>('win-value-oracle.json');
const dumped = new Map(loadFixtureJson<{ hands: DumpedHand[] }>('win-value-hands.json').hands.map((h) => [h.id, h]));

const WINDS: readonly Wind[] = ['E', 'S', 'W', 'N'];

/** Python の mahjong の役の名前（ドラ類を除く）→ 役の識別子の並び（並べ替え済み）。 */
function oracleYakuIds(names: readonly string[]): YakuId[] {
  return names
    .filter((n) => !/^(Dora|Aka Dora|Ura Dora)/.test(n))
    .map((n) => {
      const id = ORACLE_YAKU_IDS[n];
      if (id === undefined) throw new Error(`知らない役の名前: ${n}`);
      return id;
    })
    .sort();
}

const IDS_BY_JA_NAME = new Map<string, YakuId>(Object.entries(YAKU_NAMES).map(([id, name]) => [name, id as YakuId]));

/** adapter の役の名前（画面に出す言い方）→ 役の識別子（場風・自風が同じ牌のまとめた名前は 2 つ）。 */
function adapterYakuIds(names: readonly string[]): YakuId[] {
  const out: YakuId[] = [];
  for (const name of names) {
    const direct = IDS_BY_JA_NAME.get(name);
    if (direct !== undefined) {
      out.push(direct);
      continue;
    }
    const m = /^役牌 (.)（(場風・自風|場風|自風)）$/.exec(name);
    if (m === null) throw new Error(`知らない役の名前: ${name}`);
    if (m[2] !== '自風') out.push('yakuhai-round');
    if (m[2] !== '場風') out.push('yakuhai-seat');
  }
  return out.sort();
}

function specOf(hand: DumpedHand, kind: number, variant: 'base' | 'variant', riichi: boolean, tsumo: boolean): WinSpec {
  return {
    closed: hand.closed,
    melds: hand.melds,
    winTile: kindToTile(kind),
    tsumo,
    flags: { riichi },
    seatIndex: variant === 'base' ? hand.seat : (hand.seat + 1) % 4,
    roundWind: hand.round,
    doraMarkers: hand.dora,
    uraMarkers: [],
    honba: variant === 'base' ? 0 : 1,
    kyotaku: variant === 'base' ? 0 : 1,
    actor: hand.actor,
  };
}

function inputOf(spec: WinSpec): WinInput {
  const counts = countTiles([...spec.closed, spec.winTile]);
  return {
    counts,
    melds: spec.melds.map(yakuMeldOf),
    seatWind: WINDS[spec.seatIndex] as Wind,
    roundWind: spec.roundWind,
    winKind: tileKind(spec.winTile),
    tsumo: spec.tsumo,
    riichi: spec.flags.riichi,
  };
}

/** 計算した全ケース（正解表の hands）。 */
function* realCases(): Generator<{ id: string; hand: DumpedHand; kind: number; key: string; spec: WinSpec; theirs: OracleResult }> {
  for (const rec of oracle.hands) {
    const hand = dumped.get(rec.id);
    if (hand === undefined) throw new Error(`手が見つかりません: ${rec.id}`);
    for (const [kindText, row] of Object.entries(rec.cases)) {
      const kind = Number(kindText);
      for (const [key, theirs] of Object.entries(row)) {
        const [variant, mode, how] = key.split('-') as ['base' | 'variant', 'dama' | 'riichi', 'ron' | 'tsumo'];
        yield { id: `${rec.id} 待ち ${kindToTile(kind)} ${key}`, hand, kind, key, spec: specOf(hand, kind, variant, mode === 'riichi', how === 'tsumo'), theirs };
      }
    }
  }
}

describe('E-36 待ちと打点: 牌譜の和了 69 件の再計算', () => {
  it('固定データの 7 半荘の和了 69 件を、牌譜から手を組み立てて計算し直すと、牌譜の点の増減（本場・供託を含む）と全部一致する', () => {
    let n = 0;
    let withBonus = 0;
    for (const id of [...FX1_IDS, FX4_ID, FX5_ID]) {
      const game = importReportText(loadReportText(id));
      if (!game.ok) throw new Error(game.error.message);
      for (let position = 0; position < game.value.kyokus.length; position++) {
        for (const h of horaCasesOf(game.value, id, position)) {
          expect(h.value.none, h.id).toBe(false);
          expect(h.deltasCore, h.id).toEqual(h.deltasLog);
          if (h.spec.honba > 0 || h.spec.kyotaku > 0) withBonus++;
          n++;
        }
      }
    }
    expect(n).toBe(69);
    // 本場・供託の付いた和了を含む（付いていなければ、本場・供託の確かめにならない）
    expect(withBonus).toBeGreaterThan(5);
  });
});

describe('E-36 待ちと打点: Python の mahjong の正解表との照合（実戦の聴牌の手の、全部の待ち）', () => {
  it('待ち牌が、Python が調べた待ちと全部一致する（手牌と副露で 4 枚そろった牌は待ちに入れない）', () => {
    expect(oracle.hands.length).toBeGreaterThan(150);
    let waits = 0;
    for (const rec of oracle.hands) {
      const hand = dumped.get(rec.id) as DumpedHand;
      expect(coreTenpaiWaits(hand.closed, hand.melds, hand.actor), rec.id).toEqual(rec.waits);
      waits += rec.waits.length;
    }
    expect(waits).toBeGreaterThan(240);
  });

  it('待ちごとの役・飜・符・点数が、ダマ・リーチ × ロン・ツモ（と、本場 1・供託 1 の変種）で、全部一致する', () => {
    let compared = 0;
    let none = 0;
    let yakuman = 0;
    let bonus = 0;
    for (const c of realCases()) {
      const mine = coreEvaluateWin(c.spec);
      const t = c.theirs;
      if (t.e !== null) {
        // 役が無い（ロンできない）。ライブラリのエラーは no_yaku だけ
        expect(t.e, c.id).toBe('no_yaku');
        expect(mine.none, c.id).toBe(true);
        none++;
        continue;
      }
      expect(mine.none, c.id).toBe(false);
      if (t.x === true) {
        expect(mine.yakuman, c.id).toBeGreaterThan(0);
        yakuman++;
      } else {
        expect(mine.yakuman, c.id).toBe(0);
        expect(mine.han, c.id).toBe(t.h);
        expect(mine.fu, c.id).toBe(t.f);
        expect(adapterYakuIds(mine.yaku.map((y) => y.name)), c.id).toEqual(oracleYakuIds(t.y as string[]));
      }
      if (c.spec.tsumo) {
        const pay = mine.tsumoPay as { child: number; dealer: number };
        if (c.spec.seatIndex === 0) expect(pay.child, c.id).toBe(t.m);
        else expect([pay.dealer, pay.child], c.id).toEqual([t.m, t.a]);
      } else {
        expect(mine.base, c.id).toBe(t.m);
      }
      // 和了者の受け取り（本場・供託込み）
      expect(mine.fenpei[c.spec.seatIndex], c.id).toBe(t.t);
      if (c.key.startsWith('variant')) bonus++;
      compared++;
    }
    expect(compared).toBeGreaterThan(1000);
    expect(none).toBeGreaterThan(20);
    expect(yakuman).toBeGreaterThanOrEqual(0);
    expect(bonus).toBeGreaterThan(400);
  });
});

describe('E-37 待ちの形', () => {
  const KIND_OF_SHAPE: Record<WaitShape, string> = { 嵌張: 'kanchan', 辺張: 'penchan', 単騎: 'pair_wait', 両面: 'none', 双碰: 'none' };

  it('嵌張・辺張・単騎の判定が、Python の mahjong の符の内訳（kanchan・penchan・pair_wait）と一致する', () => {
    const seen = new Set<string>();
    let compared = 0;
    let chiitoitsu = 0;
    for (const c of realCases()) {
      if (c.theirs.e !== null || c.theirs.x === true) continue;
      const shapes = coreWaitShapes(c.hand.closed, c.hand.melds, c.hand.actor, c.kind);
      expect(shapes.length, c.id).toBeGreaterThan(0);
      const details = c.theirs.d ?? [];
      if (details.length === 1 && details[0]?.[1] === 25) {
        // 七対子: 符は 25 で固定で、待ちの符は付かない。どの待ちも、対子の片割れ（単騎）
        expect(shapes, c.id).toContain('単騎');
        chiitoitsu++;
        continue;
      }
      const waitFu = details.map(([reason]) => reason).filter((r) => ['kanchan', 'penchan', 'pair_wait'].includes(r));
      expect(waitFu.length, c.id).toBeLessThanOrEqual(1);
      const got = waitFu[0] ?? 'none';
      // 解釈が複数あるとき（例: 嵌張と双碰）は、Python が選んだ解釈が、含まれていればよい
      expect(shapes.map((s) => KIND_OF_SHAPE[s]), c.id).toContain(got);
      seen.add(got);
      compared++;
    }
    expect(compared + chiitoitsu).toBeGreaterThan(1000);
    expect(chiitoitsu).toBeGreaterThan(0);
    // 3 つの待ちが、どれも正解表に現れる（現れなければ、確かめになっていない）
    expect([...seen].sort()).toEqual(['kanchan', 'none', 'pair_wait', 'penchan']);
  });
});

describe('E-38 符の内訳', () => {
  const sortedItems = (items: ReadonlyArray<readonly [string, number]>) => [...items].map(([r, f]) => `${r}:${f}`).sort();

  it('実戦の聴牌の手の全部のケースで、符の内訳の各項目と合計が、Python の mahjong の fu_details と一致する', () => {
    let compared = 0;
    const reasons = new Set<string>();
    for (const c of realCases()) {
      if (c.theirs.e !== null || c.theirs.x === true) continue;
      const detail = fuDetailOf(inputOf(c.spec));
      expect(detail, c.id).not.toBeNull();
      const d = detail as NonNullable<typeof detail>;
      expect(sortedItems(d.items.map((i) => [i.reason, i.fu])), c.id).toEqual(sortedItems(c.theirs.d as Array<[string, number]>));
      expect(d.rounded, c.id).toBe(c.theirs.f);
      // 画面の符（majiang-core）と、内訳の合計が合う（合わなければ、画面は内訳を出さない）
      expect(d.rounded, c.id).toBe(coreEvaluateWin(c.spec).fu);
      for (const i of d.items) reasons.add(i.reason);
      compared++;
    }
    expect(compared).toBeGreaterThan(1000);
    expect(reasons.has('base') && reasons.has('kanchan') && reasons.has('penchan') && reasons.has('pair_wait') && reasons.has('tsumo')).toBe(true);
  });

  it('乱数で作った和了形（副露・七対子・槓子を含む）でも、符の内訳が、fu_details と一致する', () => {
    let compared = 0;
    const reasons = new Set<string>();
    for (const r of oracle.random) {
      if (r.result.e !== null || r.result.x === true) continue;
      const counts = countTiles(parseTenhouNotation(r.closed));
      const input: WinInput = { counts, melds: meldsOf(r.melds), seatWind: r.seat, roundWind: r.round, winKind: r.win, tsumo: r.tsumo, riichi: r.riichi };
      const detail = fuDetailOf(input);
      const where = `${r.id} ${r.closed} ${JSON.stringify(r.melds)}`;
      expect(detail, where).not.toBeNull();
      const d = detail as NonNullable<typeof detail>;
      expect(sortedItems(d.items.map((i) => [i.reason, i.fu])), where).toEqual(sortedItems(r.result.d as Array<[string, number]>));
      expect(d.rounded, where).toBe(r.result.f);
      for (const i of d.items) reasons.add(i.reason);
      compared++;
    }
    expect(compared).toBeGreaterThan(1000);
    // 槓子・役牌の雀頭・連風牌・七対子の 25 符まで、正解表に現れる
    for (const reason of ['closed_kan', 'open_terminal_kan', 'closed_terminal_pon', 'valued_pair', 'double_valued_pair', 'hand_without_fu']) {
      expect(reasons.has(reason), reason).toBe(true);
    }
  });

  it('正解表の件数: 実戦の手と乱数の和了形を合わせて 2,500 件ほど', () => {
    let real = 0;
    for (const rec of oracle.hands) for (const row of Object.values(rec.cases)) real += Object.keys(row).length;
    expect(real + oracle.random.length).toBeGreaterThan(2400);
  });

  it('画面の内訳: 閉じた手のロンは「副底 20」と「門前ロン 10」に分け、合計が切り上げた符になる', () => {
    // 手牌 234m 456p 78p 678s 66m（待ち 3p・6p の両面）、ロン 3p: 平和の形で、門前ロンの 30 符
    const input: WinInput = { counts: countTiles(parseTenhouNotation('23466m345678p678s')), melds: [], seatWind: 'S', roundWind: 'E', winKind: 11, tsumo: false, riichi: false };
    const made = fuBreakdownOf(input);
    expect(made).not.toBeNull();
    expect(made?.items).toEqual([
      { label: '副底', fu: 20 },
      { label: '門前ロン', fu: 10 },
    ]);
    expect(made?.rounded).toBe(30);
    expect(made?.note).toBeNull();
  });
});
