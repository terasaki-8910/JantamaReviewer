// 型の宣言（declare module）を、このファイルを読み込む側（画面の tsc）にも届ける。import では、宣言だけのファイルを指せない
// eslint-disable-next-line @typescript-eslint/triple-slash-reference
/// <reference path="./majiang-core.d.ts" />
/**
 * @kobalab/majiang-core（MIT。Copyright (c) 2021 Satoshi Kobayashi。THIRD_PARTY_NOTICES.md）の和了の計算・待ちの判定を、
 * エンジンの牌の表記（mjai）から呼ぶ受け口。**エンジンの中で majiang-core を読み込むのは、このファイルだけ**
 * （purity.test.ts の、名前を決めた例外。版は 1.4.1 に固定。R14-3）。ほかのファイルは、ここの関数だけを使う。
 *
 * 何をここで引き受けるか:
 * - 牌の表記の対応: mjai（1m・5mr・E・P）→ majiang-core（m1・m0・z1・z5）。副露は、鳴いた席から見た相手の向き（+ 下家・= 対面・- 上家）を付けた面子の文字列
 * - 供託: 呼ぶ側が渡す `kyotaku` は、局の始めの供託 + その局でこれまでに成立したリーチ棒（和了者が受け取る本数。自分のリーチ棒も入る）
 * - ロンの向き: ロンは、放銃した席（`target`。無ければ対面）の向きを付けて渡す
 * - 待ち: `tingpai` は聴牌でない手では受け入れを返すので、向聴数が 0 のときだけ待ちとして返す。自分の手牌と副露で 4 枚そろっている牌は待ちに入れない
 * - 待ちの形: `hule_mianzi` の面子の分解（和了牌に `!` が付く）から、両面・嵌張・辺張・双碰・単騎を読む
 *
 * 雀魂の規則（切り上げ満貫なし・喰いタンあり・赤ドラ各 1 枚・連風牌の雀頭は 4 符）は、majiang-core の既定の規則のまま。
 * 数えない: 裏ドラ・一発・海底などの和了の状況で決まるもの（呼ぶ側が旗で渡したときだけ数える）。
 */
import Majiang from '@kobalab/majiang-core';

import type { Fuuro, Seat, Wind } from './report-types';
import { type Tile, TILE_KIND_COUNT, countTiles, plainTile, tileKind } from './tiles';
import { meldTiles } from './ukeire-remaining';

const HONOR_NUMBER: Record<string, number> = { E: 1, S: 2, W: 3, N: 4, P: 5, F: 6, C: 7 };
const WIND_INDEX: Record<Wind, number> = { E: 0, S: 1, W: 2, N: 3 };

/** mjai の牌 → majiang-core の牌（赤五は m0 など）。 */
export function coreTile(tile: Tile): string {
  const honor = HONOR_NUMBER[tile];
  if (honor !== undefined) return `z${honor}`;
  if (tile.length === 3) return `${tile.charAt(1)}0`;
  return `${tile.charAt(1)}${tile.charAt(0)}`;
}

/** 牌の種類（0..33）→ majiang-core の牌（m1 など）。 */
export function coreKindTile(kind: number): string {
  if (kind >= 27) return `z${kind - 26}`;
  return `${'mps'.charAt(Math.floor(kind / 9))}${(kind % 9) + 1}`;
}

/** majiang-core の牌（m1・z1。赤は m0）→ 種類（0..33）。 */
export function kindOfCoreTile(tile: string): number {
  const n = tile.charAt(1) === '0' ? 5 : Number(tile.charAt(1));
  if (tile.charAt(0) === 'z') return 26 + n;
  return 'mps'.indexOf(tile.charAt(0)) * 9 + n - 1;
}

/** 数牌・字牌を、種類ごとにまとめた手牌の文字列にする（m123p0456z11）。 */
function closedText(tiles: readonly Tile[]): string {
  const groups: Record<string, number[]> = { m: [], p: [], s: [], z: [] };
  for (const tile of tiles) {
    const c = coreTile(tile);
    (groups[c.charAt(0)] as number[]).push(Number(c.charAt(1)));
  }
  let out = '';
  for (const suit of ['m', 'p', 's', 'z']) {
    const digits = (groups[suit] as number[]).sort((a, b) => (a === 0 ? 5 : a) - (b === 0 ? 5 : b) || a - b);
    if (digits.length > 0) out += suit + digits.join('');
  }
  return out;
}

/** 鳴いた席から見た相手の方向（+ 下家・= 対面・- 上家）。 */
function direction(actor: Seat, target: Seat): string {
  return ['', '+', '=', '-'][(target - actor + 4) % 4] as string;
}

/** 副露 1 つを majiang-core の面子の文字列にする。actor は鳴いた席。 */
function coreMeld(meld: Fuuro, actor: Seat): string {
  const digitsOf = (tiles: readonly Tile[]) => tiles.map((t) => coreTile(t).charAt(1)).join('');
  const suit = (t: Tile) => coreTile(t).charAt(0);
  switch (meld.type) {
    case 'chi':
      return `${suit(meld.pai)}${coreTile(meld.pai).charAt(1)}-${digitsOf(meld.consumed)}`;
    case 'pon':
    case 'daiminkan':
      return `${suit(meld.pai)}${digitsOf(meld.consumed)}${coreTile(meld.pai).charAt(1)}${direction(actor, meld.target)}`;
    case 'kakan': {
      // ポンの 3 枚（鳴いた牌の向き）のあとに、加えた 1 枚
      const dir = direction(actor, meld.previous_pon_target);
      return `${suit(meld.pai)}${digitsOf(meld.consumed)}${coreTile(meld.previous_pon_pai).charAt(1)}${dir}${coreTile(meld.pai).charAt(1)}`;
    }
    case 'ankan':
      return `${suit(meld.consumed[0] as Tile)}${digitsOf(meld.consumed)}`;
  }
}

/** 手牌の文字列。last を渡すと、その牌をツモ牌として末尾に置く。 */
function coreHandText(closed: readonly Tile[], melds: readonly Fuuro[], actor: Seat, last: Tile | null): string {
  const text = closedText(closed) + (last === null ? '' : coreTile(last));
  return melds.length === 0 ? text : `${text},${melds.map((m) => coreMeld(m, actor)).join(',')}`;
}

/** 和了の状況（立直・一発・ダブル立直・海底・河底・嶺上・槍槓・天和・地和）。旗を渡したときだけ数える。 */
export interface WinFlags {
  riichi: boolean;
  doubleRiichi?: boolean;
  ippatsu?: boolean;
  /** 1 = 海底摸月、2 = 河底撈魚。 */
  haitei?: 0 | 1 | 2;
  rinshan?: boolean;
  chankan?: boolean;
  /** 1 = 天和、2 = 地和。 */
  tenhou?: 0 | 1 | 2;
}

/** 和了 1 つの入力。 */
export interface WinSpec {
  /** 閉じた手牌（和了牌を含まない 3n+1 枚）。赤五は赤のまま渡す（和了牌は、赤を渡さない決まり。呼ぶ側が守る）。 */
  closed: readonly Tile[];
  melds: readonly Fuuro[];
  /** 和了牌。 */
  winTile: Tile;
  tsumo: boolean;
  flags: WinFlags;
  /** 自風を、親からの相対席で（0 = 親、1 = 南家 ...）。 */
  seatIndex: number;
  roundWind: Wind;
  /** ドラ表示牌（開いたものすべて）。 */
  doraMarkers: readonly Tile[];
  /** 裏ドラ表示牌（立直の和了だけ）。 */
  uraMarkers: readonly Tile[];
  honba: number;
  /** 供託のリーチ棒（和了者が受け取る本数）。局の始めの供託 + その局で成立したリーチ棒。 */
  kyotaku: number;
  /** 副露の向きの計算用の、和了者の席。 */
  actor: Seat;
  /** ロンのとき、放銃した席（支払う席の計算用。無ければ対面）。 */
  target?: Seat;
}

/** 和了の結果（役・飜・符・点数）。 */
export interface WinValue {
  /** 役（ドラ・赤ドラ・裏ドラは含めない）。名前は画面に出す言い方。 */
  yaku: Array<{ name: string; han: number }>;
  /** ドラ類の飜。 */
  dora: { dora: number; aka: number; ura: number };
  /** 役とドラ類を合わせた飜（役満は 0）。 */
  han: number;
  fu: number | null;
  /** 役満の倍数（役満でなければ 0）。 */
  yakuman: number;
  /** 本場・供託を除いた点数。ロンなら放銃者の支払い、ツモなら全員の支払いの合計。 */
  base: number;
  /** ツモのとき: 子の支払いと親の支払い（本場を除く。親の和了では同じ）。 */
  tsumoPay: { child: number; dealer: number } | null;
  /** 本場・供託を含めた点数の移動（親からの相対席 0..3）。 */
  fenpei: number[];
  /** 役が無い・和了形でない。 */
  none: boolean;
  /** 点数の名前（満貫・跳満など）。無ければ null。 */
  limit: string | null;
}

function limitName(han: number, fu: number | null, yakuman: number): string | null {
  if (yakuman > 0) return yakuman >= 2 ? `${yakuman}倍役満` : '役満';
  if (han >= 13) return '数え役満';
  if (han >= 11) return '三倍満';
  if (han >= 8) return '倍満';
  if (han >= 6) return '跳満';
  if (han === 5 || (fu !== null && ((han === 4 && fu >= 40) || (han === 3 && fu >= 70)))) return '満貫';
  return null;
}

/** 役の名前を、画面に出す言い方にする（majiang-core の「翻牌 白」「場風 東」「自風 南」）。 */
function yakuName(name: string): string {
  if (name.startsWith('場風 ')) return `役牌 ${name.slice(3)}（場風）`;
  if (name.startsWith('自風 ')) return `役牌 ${name.slice(3)}（自風）`;
  if (name.startsWith('翻牌 ')) return `役牌 ${name.slice(3)}`;
  return name;
}

/** 場風と自風が同じ牌の役牌を 1 行にまとめる（役牌 東（場風・自風）2飜）。 */
function mergeDoubleWind(yaku: Array<{ name: string; han: number }>): Array<{ name: string; han: number }> {
  const seat = yaku.find((y) => y.name.endsWith('（自風）'));
  const round = yaku.find((y) => y.name.endsWith('（場風）'));
  if (seat === undefined || round === undefined) return yaku;
  if (seat.name.slice(0, -4) !== round.name.slice(0, -4)) return yaku;
  const merged = { name: `${seat.name.slice(0, -4)}（場風・自風）`, han: seat.han + round.han };
  return yaku.flatMap((y) => (y === round ? [] : y === seat ? [merged] : [y]));
}

const NO_WIN: WinValue = { yaku: [], dora: { dora: 0, aka: 0, ura: 0 }, han: 0, fu: null, yakuman: 0, base: 0, tsumoPay: null, fenpei: [0, 0, 0, 0], none: true, limit: null };

/** majiang-core の hule で、和了の役・飜・符・点数を求める。役が無い・和了形でないときは `none`。 */
export function coreEvaluateWin(spec: WinSpec): WinValue {
  const param = Majiang.Util.hule_param({
    zhuangfeng: WIND_INDEX[spec.roundWind],
    menfeng: spec.seatIndex,
    lizhi: spec.flags.riichi ? (spec.flags.doubleRiichi === true ? 2 : 1) : 0,
    yifa: spec.flags.ippatsu === true,
    qianggang: spec.flags.chankan === true,
    lingshang: spec.flags.rinshan === true,
    haidi: spec.flags.haitei ?? 0,
    tianhu: spec.flags.tenhou ?? 0,
    baopai: spec.doraMarkers.map(coreTile),
    fubaopai: spec.uraMarkers.length > 0 ? spec.uraMarkers.map(coreTile) : null,
    changbang: spec.honba,
    lizhibang: spec.kyotaku,
  });
  let shoupai;
  let rongpai: string | undefined;
  if (spec.tsumo) {
    shoupai = Majiang.Shoupai.fromString(coreHandText(spec.closed, spec.melds, spec.actor, spec.winTile));
  } else {
    shoupai = Majiang.Shoupai.fromString(coreHandText(spec.closed, spec.melds, spec.actor, null));
    rongpai = `${coreTile(spec.winTile)}${spec.target === undefined ? '=' : direction(spec.actor, spec.target)}`;
  }
  const r = Majiang.Util.hule(shoupai, rongpai, param);
  if (r === undefined || r.hupai === undefined || r.defen === 0) return NO_WIN;
  const dora = { dora: 0, aka: 0, ura: 0 };
  const yaku: Array<{ name: string; han: number }> = [];
  for (const h of r.hupai) {
    if (h.name === 'ドラ') dora.dora += Number(h.fanshu);
    else if (h.name === '赤ドラ') dora.aka += Number(h.fanshu);
    else if (h.name === '裏ドラ') dora.ura += Number(h.fanshu);
    else if (typeof h.fanshu === 'string') yaku.push({ name: h.name, han: 0 });
    else yaku.push({ name: yakuName(h.name), han: Number(h.fanshu) });
  }
  const yakuman = r.damanguan ?? 0;
  const han = r.damanguan !== undefined ? 0 : (r.fanshu as number);
  const fu: number | null = r.damanguan !== undefined ? null : (r.fu as number);
  // 点数: 本場・供託を除いた値を、fenpei から戻す
  const fenpei = r.fenpei as number[];
  let base: number;
  let tsumoPay: { child: number; dealer: number } | null = null;
  if (rongpai !== undefined) {
    base = (fenpei[spec.seatIndex] as number) - spec.honba * 300 - spec.kyotaku * 1000;
  } else {
    base = r.defen;
    const others = [0, 1, 2, 3].filter((i) => i !== spec.seatIndex);
    const dealerPay = spec.seatIndex === 0 ? 0 : -(fenpei[0] as number) - spec.honba * 100;
    const childIndex = others.find((i) => i !== 0) as number;
    const childPay = -(fenpei[childIndex] as number) - spec.honba * 100;
    tsumoPay = spec.seatIndex === 0 ? { child: childPay, dealer: childPay } : { child: childPay, dealer: dealerPay };
  }
  return { yaku: mergeDoubleWind(yaku), dora, han, fu, yakuman, base, tsumoPay, fenpei, none: false, limit: limitName(han, fu, yakuman) };
}

/** 自分の手牌（閉じた手と副露）に 4 枚そろっている牌の種類。待ちには入らない。 */
function heldAll(closed: readonly Tile[], melds: readonly Fuuro[]): Set<number> {
  const counts = countTiles([...closed, ...melds.flatMap(meldTiles)]);
  const out = new Set<number>();
  for (let kind = 0; kind < TILE_KIND_COUNT; kind++) if ((counts[kind] as number) >= 4) out.add(kind);
  return out;
}

/**
 * 聴牌の手（閉じた手牌 3n+1 枚）の待ち牌（種類の昇順）。聴牌でなければ空。
 * `tingpai` は、聴牌でない手では「向聴数が減る牌」を返すので、向聴数が 0 のときだけ待ちとして返す。
 */
export function coreTenpaiWaits(closed: readonly Tile[], melds: readonly Fuuro[], actor: Seat): number[] {
  const shoupai = Majiang.Shoupai.fromString(coreHandText(closed, melds, actor, null));
  if (Majiang.Util.xiangting(shoupai) !== 0) return [];
  const full = heldAll(closed, melds);
  const tiles: string[] = Majiang.Util.tingpai(shoupai) ?? [];
  return tiles
    .map(kindOfCoreTile)
    .filter((kind) => !full.has(kind))
    .sort((a, b) => a - b);
}

/** 待ちの形。 */
export type WaitShape = '両面' | '嵌張' | '辺張' | '双碰' | '単騎';

/**
 * 待ち牌（種類）を引いて和了形になるときの、待ちの形の解釈（majiang-core の hule_mianzi の面子の分解から）。
 * 解釈が複数あるときは全部返す（例: 嵌張と双碰）。和了形にならないときは空。
 */
export function coreWaitShapes(closed: readonly Tile[], melds: readonly Fuuro[], actor: Seat, winKind: number): WaitShape[] {
  const shoupai = Majiang.Shoupai.fromString(coreHandText(closed, melds, actor, null));
  const decompositions = Majiang.Util.hule_mianzi(shoupai, `${coreKindTile(winKind)}=`);
  const found: WaitShape[] = [];
  const add = (shape: WaitShape) => {
    if (!found.includes(shape)) found.push(shape);
  };
  for (const mianzi of decompositions) {
    const m = mianzi.find((x) => x.includes('!'));
    if (m === undefined) continue;
    if (mianzi.length === 7 || mianzi.length === 13 || mianzi.length === 1) {
      // 七対子・国士・九蓮は、待ち牌の対子（単騎）として扱う
      add('単騎');
      continue;
    }
    // 例: m12=!3（順子 123 の 2 で和了）、m66=!（雀頭）、m111=!（刻子）。! の前が、和了牌までの数字
    const [before = '', after = ''] = m.replace(/[+=\-_]!/, '|').split('|');
    // 面子の文字列は先頭に種類の文字（m など）が付いている
    const nums = (before + after).replace(/0/g, '5').slice(1);
    const pos = before.length - 1; // 和了牌が、面子の何番目か（1 = 先頭、2 = 真ん中、3 = 末尾）
    if (nums.length === 2) add('単騎');
    else if (nums.charAt(0) === nums.charAt(1)) add('双碰');
    else {
      const first = Number(nums.charAt(0));
      if (pos === 2) add('嵌張');
      else if ((pos === 3 && first === 1) || (pos === 1 && first === 7)) add('辺張');
      else add('両面');
    }
  }
  return found;
}

/** 牌（赤五を含む）を、同じ牌（種類）として比べる。 */
export function sameKind(a: Tile, b: Tile): boolean {
  return tileKind(plainTile(a)) === tileKind(plainTile(b));
}
