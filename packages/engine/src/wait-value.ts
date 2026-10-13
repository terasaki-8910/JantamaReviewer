/**
 * 待ちと打点・待ちの形（答え合わせのタブ「待ちと打点」。F14、E-36・E-37。R15-2・R15-3）。
 *
 * 聴牌になる行動（比べる行動の打牌・スルー・チー・ポン→打牌。リーチの判断は、聴牌になる切り方すべて）ごとに 1 つの表を作り、待ち牌ごとに
 *   - 役・飜・符・点数を、ダマとリーチ（門前だけ）、ロンとツモで並べる（点数は majiang-core の和了の計算。majiang-adapter.ts）
 *   - 待ちの形（両面・嵌張・辺張・双碰・単騎。3 種類以上の待ちは、表の見出しで「多面張」）
 *   - 符の内訳（約束どおり、Python の mahjong の `fu_details` をエンジンに移したもの。fu-detail.ts）
 * を出す。数えないもの: 裏ドラ・一発・海底などの和了の状況で決まるものと、和了牌が赤のときの赤ドラ（和了牌は、赤でない牌として数える）。
 * 点数は、本場・供託を除いた値（承認済みの見本と同じ）。雀魂の規則（切り上げ満貫なし・喰いタンあり・赤ドラ各 1 枚）。
 *
 * 聴牌でない行動は表を作らない。表が 1 つも無ければ、`waitBoxOf` は null（タブを出さない）。答え合わせのあとにだけ呼ぶ（AI の行動を含むため。U-1）。
 */
import type { Decision } from './decision';
import { type FuBreakdown, fuBreakdownOf } from './fu-detail';
import { type WaitShape, type WinFlags, type WinValue, coreEvaluateWin, coreTenpaiWaits, coreWaitShapes } from './majiang-adapter';
import { type AnswerOption, type QuizChoice, answerOptions } from './quiz-choice';
import type { BoardState } from './replay';
import type { Fuuro, Seat } from './report-types';
import { type Tile, countTiles, kindToTile, plainTile, sortTiles, tileKind } from './tiles';
import { visibleTileCounts } from './ukeire-remaining';
import { type WinInput, yakuMeldOf } from './yaku';
import { type YakuMark, comparedActions } from './yaku-view';

export type { WaitShape } from './majiang-adapter';

/** ロンかツモの 1 行。点数は本場・供託を除く。 */
export interface WaitLine {
  /** 役が無い（和了できない）。ロンでは「ロンできない」、ツモでは「ツモできない」。 */
  none: boolean;
  han: number;
  /** 役満の倍数（役満でなければ 0）。 */
  yakuman: number;
  fu: number | null;
  /** 点数の名前（満貫・跳満など）。 */
  limit: string | null;
  /** ロンなら放銃者の支払い、ツモなら全員の支払いの合計。 */
  base: number;
  /** ツモのときの、子の支払いと親の支払い（親の和了では同じ）。 */
  tsumoPay: { child: number; dealer: number } | null;
  /** 符の内訳（符が出るときだけ。mahjong の数え方で、majiang-core の符と合わないときは null）。 */
  fuBreakdown: FuBreakdown | null;
}

/** ロンとツモ。 */
export interface WaitSide {
  ron: WaitLine;
  tsumo: WaitLine;
}

/** 待ち牌 1 種類の行。 */
export interface WaitRow {
  kind: number;
  /** 赤でない牌の表記。 */
  tile: Tile;
  /** 場に見えている牌（全員の河・副露・ドラ表示牌）と自分の手牌も除いた残り枚数。 */
  remaining: number;
  /** 待ちの形（解釈が複数あるときは全部。先頭が、待ちの形の 1 語）。 */
  shapes: WaitShape[];
  /** 自分の河にある（切る牌ならそれも含む）ので、ロンできない。 */
  furiten: boolean;
  /** どちらでも付く役。ロンの役。ロンできないときは、ツモの役から門前清自摸和を除いたもの。 */
  yaku: Array<{ name: string; han: number }>;
  dora: number;
  aka: number;
  dama: WaitSide;
  /** 門前でないときは null（リーチできない）。 */
  riichi: WaitSide | null;
}

/** 待ちも点も同じなので、1 つの表にまとめた、ほかの切り方。 */
export interface WaitSame {
  discard: Tile;
  tags: YakuMark[];
}

/** 聴牌になる行動 1 つの表。 */
export interface WaitTable {
  /** 画面の鍵。 */
  key: string;
  tags: YakuMark[];
  /** 切る牌（打牌・チー・ポンのあとの打牌）。スルーでは null。 */
  discard: Tile | null;
  /** 待ち牌・残り枚数・飜・符・点数・待ちの形が全部同じ、ほかの切り方（承認された見本の「待ちも点も同じ」）。まとめたものが無ければ空。 */
  same: WaitSame[];
  /** 打牌以外の行動のボタン（チー・ポン・スルー）。 */
  option: AnswerOption | null;
  /** その行動のあとの手が門前か（リーチできるか）。 */
  closed: boolean;
  /** 手全体の待ちの形の 1 語（3 種類以上の待ちは「多面張」）。 */
  shape: string;
  /** `shape` が多面張か。 */
  wide: boolean;
  /** 待ち全体の残り枚数。 */
  remaining: number;
  waits: WaitRow[];
}

export interface WaitBox {
  tables: WaitTable[];
  /** 自分が親か（ツモを「オール」で書く）。 */
  dealer: boolean;
  /** 表の数の上限を超えて、出さなかった表の数。 */
  omitted: number;
}

/** 1 つの判断で出す表の数の上限。 */
export const MAX_WAIT_TABLES = 8;

/** 聴牌かどうかを調べる、行動のあとの手。 */
export interface WaitPlan {
  key: string;
  tags: YakuMark[];
  discard: Tile | null;
  option: AnswerOption | null;
  /** 切ったあと（または鳴いたあと・スルーのまま）の閉じた手牌（3n+1 枚）。 */
  hand: Tile[];
  /** その行動のあとの副露（チー・ポンなら、その副露を足したもの）。 */
  melds: Fuuro[];
  /** 場に見えている枚数のうち、盤面の外にあるもの（切る牌、チー・ポンで手牌から出す牌）。 */
  extraSeen: number[];
}

function ownTiles(board: Pick<BoardState, 'hand' | 'drawn'>): Tile[] {
  return board.drawn === null ? [...board.hand] : [...board.hand, board.drawn];
}

/** 手牌から切る牌 1 枚を抜く（その牌そのもの、無ければ赤でない牌、無ければ同じ種類）。無ければ null。 */
function removeOne(tiles: readonly Tile[], tile: Tile): Tile[] | null {
  const out = [...tiles];
  let at = out.indexOf(tile);
  if (at < 0) at = out.indexOf(plainTile(tile));
  if (at < 0) at = out.findIndex((t) => tileKind(t) === tileKind(tile));
  if (at < 0) return null;
  out.splice(at, 1);
  return out;
}

function addSeen(extra: number[], tile: Tile): void {
  const kind = tileKind(tile);
  extra[kind] = (extra[kind] as number) + 1;
}

/** 打牌の行動 1 つ（手牌は 3n+2 枚）の手。 */
function discardPlan(tiles: readonly Tile[], melds: Fuuro[], tile: Tile, tags: YakuMark[], option: AnswerOption | null, key: string): WaitPlan | null {
  const hand = removeOne(tiles, tile);
  if (hand === null) return null;
  const extraSeen = new Array<number>(34).fill(0);
  addSeen(extraSeen, tile);
  return { key, tags, discard: tile, option, hand: sortTiles(hand), melds, extraSeen };
}

/** 切ったあとが聴牌になる、切る牌（種類ごとに 1 つ。赤でない牌を先に）。 */
function tenpaiDiscardTiles(tiles: readonly Tile[], melds: readonly Fuuro[], me: Seat): Tile[] {
  const seen = new Set<number>();
  const out: Tile[] = [];
  for (const t of sortTiles(tiles)) {
    const kind = tileKind(t);
    if (seen.has(kind)) continue;
    seen.add(kind);
    const pick = tiles.includes(plainTile(t)) ? plainTile(t) : t;
    const rest = removeOne(tiles, pick);
    if (rest !== null && coreTenpaiWaits(rest, melds, me).length > 0) out.push(pick);
  }
  return out;
}

/**
 * 行動のあとの手の一覧。`mine` を渡すと、比べる行動（自分・実戦・AI。鳴きの判断はチー・ポン・スルー）の手だけ。
 * リーチの判断は、聴牌になる切り方すべて（実戦・AI の打牌に印）。`mine` が null なら、判断のすべての行動の手（試験用）。
 * 聴牌でない手も含む（聴牌かどうかは、`waitBoxOf` が調べる）。
 */
export function waitPlansOf(decision: Pick<Decision, 'kind' | 'entry' | 'board'>, mine: QuizChoice | null): WaitPlan[] {
  const { board, entry } = decision;
  const me = board.playerId;
  const melds = [...(board.melds[me] ?? [])];
  const tiles = ownTiles(board);
  const plans: WaitPlan[] = [];
  const push = (plan: WaitPlan | null) => {
    if (plan !== null) plans.push(plan);
  };
  if (decision.kind === 'discard') {
    if (mine === null) {
      for (const tile of tenpaiDiscardTiles(tiles, melds, me)) push(discardPlan(tiles, melds, tile, [], null, `dahai:${tile}`));
      return plans;
    }
    for (const { choice, tags } of comparedActions(decision, mine)) {
      if (choice.type === 'dahai') push(discardPlan(tiles, melds, choice.tile, tags, null, `dahai:${choice.tile}`));
    }
    return plans;
  }
  if (decision.kind === 'riichi') {
    // 聴牌になる切り方すべて。実戦（リーチしなかったとき）と AI の打牌に印
    const marks = new Map<number, YakuMark[]>();
    if (entry.actual.type === 'dahai') marks.set(tileKind(entry.actual.pai), ['実戦']);
    if (entry.expected.type === 'dahai') marks.set(tileKind(entry.expected.pai), [...(marks.get(tileKind(entry.expected.pai)) ?? []), 'AI']);
    const exact = new Map<number, Tile>();
    if (entry.actual.type === 'dahai') exact.set(tileKind(entry.actual.pai), entry.actual.pai);
    if (entry.expected.type === 'dahai' && !exact.has(tileKind(entry.expected.pai))) exact.set(tileKind(entry.expected.pai), entry.expected.pai);
    const picked = tenpaiDiscardTiles(tiles, melds, me).map((t) => exact.get(tileKind(t)) ?? t);
    const tagged = picked.filter((t) => marks.has(tileKind(t)));
    const rest = picked.filter((t) => !marks.has(tileKind(t)));
    for (const tile of [...tagged, ...rest]) push(discardPlan(tiles, melds, tile, marks.get(tileKind(tile)) ?? [], null, `dahai:${tile}`));
    return plans;
  }
  if (decision.kind !== 'call') return plans;
  // 鳴きの判断: スルー（いまの手のまま）と、チー・ポン（鳴いたあとに切る牌）
  const options = answerOptions(decision);
  const chosen = mine === null ? options.map((o) => ({ option: o, tags: [] as YakuMark[] })) : comparedActions(decision, mine).flatMap(({ choice, tags }) => (choice.type === 'option' ? [{ option: options.find((o) => o.id === choice.id), tags }] : []));
  for (const { option, tags } of chosen) {
    if (option === undefined) continue;
    if (option.kind === 'pass') {
      push({ key: `option:${option.id}`, tags, discard: null, option, hand: sortTiles(tiles), melds, extraSeen: new Array<number>(34).fill(0) });
    } else if ((option.kind === 'chi' || option.kind === 'pon') && option.called !== null) {
      let after: Tile[] | null = [...tiles];
      for (const t of option.use) after = after === null ? null : removeOne(after, t);
      if (after === null) continue;
      const meld: Fuuro = { type: option.kind, target: entry.last_actor, pai: option.called, consumed: [...option.use] };
      const withMeld = [...melds, meld];
      for (const tile of tenpaiDiscardTiles(after, withMeld, me)) {
        const rest = removeOne(after, tile);
        if (rest === null) continue;
        const extraSeen = new Array<number>(34).fill(0);
        for (const t of option.use) addSeen(extraSeen, t);
        addSeen(extraSeen, tile);
        push({ key: `option:${option.id}:${tile}`, tags, discard: tile, option, hand: sortTiles(rest), melds: withMeld, extraSeen });
      }
    }
  }
  return plans;
}

const WIND_ORDER = ['E', 'S', 'W', 'N'] as const;

/** 待ち牌 1 つの、ロンかツモの 1 行。 */
function lineOf(value: WinValue, input: WinInput): WaitLine {
  let fuBreakdown: FuBreakdown | null = null;
  if (!value.none && value.fu !== null) {
    const made = fuBreakdownOf(input);
    // majiang-core の符と、mahjong の数え方の符が食い違うときは、内訳を出さない（符の数だけ出す）
    if (made !== null && made.rounded === value.fu) fuBreakdown = made;
  }
  return { none: value.none, han: value.han, yakuman: value.yakuman, fu: value.fu, limit: value.limit, base: value.base, tsumoPay: value.tsumoPay, fuBreakdown };
}

const NO_FLAGS = (riichi: boolean): WinFlags => ({ riichi });

/** 行動のあとの手（聴牌）の表。聴牌でなければ null。 */
export function waitTableOf(decision: Pick<Decision, 'board'>, plan: WaitPlan): WaitTable | null {
  const { board } = decision;
  const me = board.playerId;
  const kinds = coreTenpaiWaits(plan.hand, plan.melds, me);
  if (kinds.length === 0) return null;
  const closed = plan.melds.every((m) => m.type === 'ankan');
  const visible = visibleTileCounts(board);
  const own = countTiles(plan.hand);
  const river = new Set<number>((board.rivers[me] ?? []).map((r) => tileKind(r.tile)));
  if (plan.discard !== null) river.add(tileKind(plan.discard));
  const seatIndex = (me - board.oya + 4) % 4;
  const seatWind = board.seatWinds[me] ?? WIND_ORDER[seatIndex];
  const roundWind = board.roundWind;
  const melds = plan.melds.map(yakuMeldOf);
  const spec = (kind: number, tsumo: boolean, riichi: boolean) => ({
    closed: plan.hand,
    melds: plan.melds,
    winTile: kindToTile(kind),
    tsumo,
    flags: NO_FLAGS(riichi),
    seatIndex,
    roundWind,
    doraMarkers: board.doraMarkers,
    uraMarkers: [] as Tile[],
    honba: 0,
    kyotaku: 0,
    actor: me,
  });
  const input = (kind: number, tsumo: boolean, riichi: boolean): WinInput => {
    const counts = [...own];
    counts[kind] = (counts[kind] as number) + 1;
    return { counts, melds, seatWind: seatWind as WinInput['seatWind'], roundWind, winKind: kind, tsumo, riichi: riichi && closed };
  };
  const waits: WaitRow[] = kinds.map((kind) => {
    const sideOf = (riichi: boolean) => {
      const ron = coreEvaluateWin(spec(kind, false, riichi));
      const tsumo = coreEvaluateWin(spec(kind, true, riichi));
      return { ron, tsumo, side: { ron: lineOf(ron, input(kind, false, riichi)), tsumo: lineOf(tsumo, input(kind, true, riichi)) } };
    };
    const dama = sideOf(false);
    const riichi = closed ? sideOf(true) : null;
    const yaku = dama.ron.none ? dama.tsumo.yaku.filter((y) => y.name !== '門前清自摸和') : dama.ron.yaku;
    const remaining = Math.max(0, 4 - (visible[kind] as number) - (own[kind] as number) - (plan.extraSeen[kind] as number));
    return {
      kind,
      tile: kindToTile(kind),
      remaining,
      shapes: coreWaitShapes(plan.hand, plan.melds, me, kind),
      furiten: river.has(kind),
      yaku,
      dora: dama.tsumo.dora.dora,
      aka: dama.tsumo.dora.aka,
      dama: dama.side,
      riichi: riichi === null ? null : riichi.side,
    };
  });
  const wide = waits.length >= 3;
  const firsts = [...new Set(waits.flatMap((w) => (w.shapes[0] === undefined ? [] : [w.shapes[0]])))];
  return {
    key: plan.key,
    tags: plan.tags,
    discard: plan.discard,
    same: [],
    option: plan.option,
    closed,
    shape: wide ? '多面張' : firsts.join('・'),
    wide,
    remaining: waits.reduce((a, w) => a + w.remaining, 0),
    waits,
  };
}

/** 待ち牌・残り枚数・形・飜・符・点数が同じ（打牌だけが違う）表の鍵。 */
function contentKey(table: WaitTable): string {
  const line = (l: WaitLine) => [l.none, l.han, l.yakuman, l.fu, l.base];
  return JSON.stringify([
    table.option?.id ?? null,
    table.waits.map((w) => [w.tile, w.remaining, w.shapes, w.furiten, line(w.dama.ron), line(w.dama.tsumo), w.riichi === null ? null : [line(w.riichi.ron), line(w.riichi.tsumo)]]),
  ]);
}

/** 待ちも点も同じ表（打牌違い）を 1 つにまとめる。先頭の表（印の付いたものが先）が、まとめた表の打牌になる。 */
function mergeSame(tables: readonly WaitTable[]): WaitTable[] {
  const out: Array<{ table: WaitTable; key: string }> = [];
  for (const table of tables) {
    const key = contentKey(table);
    const found = table.discard === null ? undefined : out.find((o) => o.key === key && o.table.discard !== null);
    if (found !== undefined && table.discard !== null) found.table.same.push({ discard: table.discard, tags: table.tags });
    else out.push({ table, key });
  }
  return out.map((o) => o.table);
}

/**
 * 答え合わせのタブ「待ちと打点」の中身。聴牌になる行動が無ければ null（タブを出さない）。
 * 比べる行動（`comparedActions`）の、聴牌になるものごとに表を作る。リーチの判断は、聴牌になる切り方すべて。
 * 待ちも点も同じ表（打牌だけが違う）は、1 つにまとめる（`WaitTable.same`）。
 */
export function waitBoxOf(decision: Pick<Decision, 'kind' | 'entry' | 'board'>, mine: QuizChoice): WaitBox | null {
  const built: WaitTable[] = [];
  for (const plan of waitPlansOf(decision, mine)) {
    const table = waitTableOf(decision, plan);
    if (table !== null) built.push(table);
  }
  if (built.length === 0) return null;
  const tables = mergeSame(built);
  return { tables: tables.slice(0, MAX_WAIT_TABLES), dealer: decision.board.oya === decision.board.playerId, omitted: Math.max(0, tables.length - MAX_WAIT_TABLES) };
}
