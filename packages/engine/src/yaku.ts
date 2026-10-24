/**
 * 役の判定（役の表示の調査の試作。R10-6・R11-16・R12-14）。画面には使わない。
 *
 * ここにあるのは、和了形（または和了形に 1 枚足した形）の役を数える部分と、聴牌の手の「確定している役」を求める部分。
 * 「近い役」の探索は yaku-near.ts、場面（出題の選択肢）への当てはめと言い方は yaku-view.ts。
 *
 * 雀魂の規則に合わせる: 喰いタン有り・後付け有り・赤ドラ有り・2 飜縛り無し。ドラ（表・裏・赤）は役ではないので数えない。
 * 数える役は、立直・門前清自摸和（どちらも手の形ではなく和了の状況で決まるので、旗で渡す）と、手の形で決まる通常の役
 * （平和・断幺九・一盃口・役牌・三色同順・一気通貫・混全帯幺九・七対子・対々和・三暗刻・三色同刻・三槓子・混老頭・小三元・混一色・
 * 純全帯幺九・二盃口・清一色）。扱わない: 役満、一発・嶺上開花・槍槓・海底・河底・ダブル立直・流し満貫（和了の状況で決まる役）。
 * 国士無双の形は、役満なので `kind: 'kokushi'` とだけ返す。
 *
 * 向聴数・受け入れ（shanten.ts）と同じく、牌は種類（0..33）の枚数の配列（長さ 34）で持つ。手牌（副露を除いた閉じた部分）の枚数は
 * 3n+1 か 3n+2（n は 4 - 副露の数）。
 */
import type { Fuuro, Wind } from './report-types';
import { shantenOfCounts } from './shanten';
import { type Tile, TILE_KIND_COUNT, kindToTile, tileKind } from './tiles';

/** 役の識別子。 */
export type YakuId =
  | 'riichi'
  | 'tsumo'
  | 'pinfu'
  | 'tanyao'
  | 'iipeikou'
  | 'ryanpeikou'
  | 'yakuhai-haku'
  | 'yakuhai-hatsu'
  | 'yakuhai-chun'
  | 'yakuhai-seat'
  | 'yakuhai-round'
  | 'sanshoku'
  | 'ittsu'
  | 'chanta'
  | 'junchan'
  | 'chiitoitsu'
  | 'toitoi'
  | 'sanankou'
  | 'sanshoku-doukou'
  | 'sankantsu'
  | 'honroto'
  | 'shosangen'
  | 'honitsu'
  | 'chinitsu';

/** 役の名前（画面に出す言い方）。場風・自風の役牌は、牌によって名前が変わるので、yaku-view.ts で作る。 */
export const YAKU_NAMES: Readonly<Record<YakuId, string>> = {
  riichi: '立直',
  tsumo: '門前清自摸和',
  pinfu: '平和',
  tanyao: '断幺九',
  iipeikou: '一盃口',
  ryanpeikou: '二盃口',
  'yakuhai-haku': '役牌 白',
  'yakuhai-hatsu': '役牌 發',
  'yakuhai-chun': '役牌 中',
  'yakuhai-seat': '役牌 自風',
  'yakuhai-round': '役牌 場風',
  sanshoku: '三色同順',
  ittsu: '一気通貫',
  chanta: '混全帯幺九',
  junchan: '純全帯幺九',
  chiitoitsu: '七対子',
  toitoi: '対々和',
  sanankou: '三暗刻',
  'sanshoku-doukou': '三色同刻',
  sankantsu: '三槓子',
  honroto: '混老頭',
  shosangen: '小三元',
  honitsu: '混一色',
  chinitsu: '清一色',
};

/** 役の飜数（門前・副露）。副露で付かない役は副露が 0。 */
export const YAKU_HAN: Readonly<Record<YakuId, readonly [closed: number, open: number]>> = {
  riichi: [1, 0],
  tsumo: [1, 0],
  pinfu: [1, 0],
  tanyao: [1, 1],
  iipeikou: [1, 0],
  ryanpeikou: [3, 0],
  'yakuhai-haku': [1, 1],
  'yakuhai-hatsu': [1, 1],
  'yakuhai-chun': [1, 1],
  'yakuhai-seat': [1, 1],
  'yakuhai-round': [1, 1],
  sanshoku: [2, 1],
  ittsu: [2, 1],
  chanta: [2, 1],
  junchan: [3, 2],
  chiitoitsu: [2, 0],
  toitoi: [2, 2],
  sanankou: [2, 2],
  'sanshoku-doukou': [2, 2],
  sankantsu: [2, 2],
  honroto: [2, 2],
  shosangen: [2, 2],
  honitsu: [3, 2],
  chinitsu: [6, 5],
};

/** 手の形で決まる役（立直と門前清自摸和を除く）。 */
export const SHAPE_YAKU: readonly YakuId[] = (Object.keys(YAKU_NAMES) as YakuId[]).filter((id) => id !== 'riichi' && id !== 'tsumo');

/** 副露 1 つ（役の判定に要るものだけ）。`first` は、順子なら先頭の牌の種類、刻子・槓子ならその牌の種類。 */
export interface YakuMeld {
  type: 'seq' | 'tri' | 'kan';
  first: number;
  /** 暗槓以外は true（門前を崩す）。 */
  open: boolean;
}

/** 結果 JSON の副露（Fuuro）を役の判定用にする。 */
export function yakuMeldOf(meld: Fuuro): YakuMeld {
  switch (meld.type) {
    case 'chi':
      return { type: 'seq', first: Math.min(tileKind(meld.pai), ...meld.consumed.map(tileKind)), open: true };
    case 'pon':
      return { type: 'tri', first: tileKind(meld.pai), open: true };
    case 'daiminkan':
    case 'kakan':
      return { type: 'kan', first: tileKind(meld.pai), open: true };
    case 'ankan':
      return { type: 'kan', first: tileKind(meld.consumed[0] as Tile), open: false };
  }
}

/** 役の判定に要る、手の形と場の風。`counts` は閉じた手牌（副露を除く）の種類ごとの枚数。 */
export interface YakuShape {
  counts: readonly number[];
  melds: readonly YakuMeld[];
  seatWind: Wind;
  roundWind: Wind;
}

/** 付いた役 1 つ。 */
export interface YakuHit {
  id: YakuId;
  /** 飜数（門前か副露かで決まる値。副露で下がる役は下がった値）。 */
  han: number;
}

const WIND_KIND: Readonly<Record<Wind, number>> = { E: 27, S: 28, W: 29, N: 30 };

/** 風の牌の種類（東 27・南 28・西 29・北 30）。 */
export function windKind(wind: Wind): number {
  return WIND_KIND[wind];
}

// ---- 牌の種類についての小さな道具 ----

export function isHonorKind(kind: number): boolean {
  return kind >= 27;
}

/** 数牌の数字（0 が 1、8 が 9）。字牌は呼ばない。 */
function numOf(kind: number): number {
  return kind % 9;
}

export function isTerminalOrHonorKind(kind: number): boolean {
  return kind >= 27 || numOf(kind) === 0 || numOf(kind) === 8;
}

function isDragonKind(kind: number): boolean {
  return kind >= 31;
}

/** 副露に使われている牌の種類ごとの枚数（長さ 34）。 */
export function meldKindCounts(melds: readonly YakuMeld[]): number[] {
  const counts = new Array<number>(TILE_KIND_COUNT).fill(0);
  for (const m of melds) {
    if (m.type === 'seq') {
      for (let i = 0; i < 3; i++) counts[m.first + i] = (counts[m.first + i] as number) + 1;
    } else {
      counts[m.first] = (counts[m.first] as number) + (m.type === 'kan' ? 4 : 3);
    }
  }
  return counts;
}

// ---- 分解 ----

/** 和了形の 1 つの塊。`meld` は副露、`open` は鳴いた（暗槓は false）。 */
export interface Block {
  type: 'seq' | 'tri' | 'kan' | 'pair';
  /** 順子は先頭の牌の種類。 */
  kind: number;
  open: boolean;
  meld: boolean;
}

function meldBlock(m: YakuMeld): Block {
  return { type: m.type, kind: m.first, open: m.open, meld: true };
}

/**
 * 閉じた手牌（3n+2 枚）を、(4 - 副露の数) 個の面子と 1 つの雀頭に分ける、すべての分け方。副露の塊を先頭に付けて返す。
 * 分けられなければ空。七対子・国士無双は含めない。
 */
export function decompose(counts: readonly number[], melds: readonly YakuMeld[]): Block[][] {
  const sets = 4 - melds.length;
  const work = [...counts];
  const out: Block[][] = [];
  const head = melds.map(meldBlock);
  const rec = (sets: number, hasPair: boolean, cur: Block[]): void => {
    let i = 0;
    while (i < TILE_KIND_COUNT && work[i] === 0) i++;
    if (i === TILE_KIND_COUNT) {
      if (sets === 0 && hasPair) out.push([...head, ...cur]);
      return;
    }
    const c = work[i] as number;
    if (sets > 0 && c >= 3) {
      work[i] = c - 3;
      cur.push({ type: 'tri', kind: i, open: false, meld: false });
      rec(sets - 1, hasPair, cur);
      cur.pop();
      work[i] = c;
    }
    if (sets > 0 && i < 27 && numOf(i) <= 6 && (work[i + 1] as number) > 0 && (work[i + 2] as number) > 0) {
      work[i] = c - 1;
      (work[i + 1] as number)--;
      (work[i + 2] as number)--;
      cur.push({ type: 'seq', kind: i, open: false, meld: false });
      rec(sets - 1, hasPair, cur);
      cur.pop();
      work[i] = c;
      (work[i + 1] as number)++;
      (work[i + 2] as number)++;
    }
    if (!hasPair && c >= 2) {
      work[i] = c - 2;
      cur.push({ type: 'pair', kind: i, open: false, meld: false });
      rec(sets, true, cur);
      cur.pop();
      work[i] = c;
    }
  };
  rec(sets, false, []);
  return out;
}

/** 七対子の形か（閉じた手 14 枚が、7 種類の対子）。 */
export function isChiitoitsuCounts(counts: readonly number[]): boolean {
  let pairs = 0;
  for (const c of counts) {
    if (c === 2) pairs++;
    else if (c !== 0) return false;
  }
  return pairs === 7;
}

/** 国士無双の形か（閉じた手 14 枚）。 */
export function isKokushiCounts(counts: readonly number[]): boolean {
  let kinds = 0;
  let total = 0;
  for (let k = 0; k < TILE_KIND_COUNT; k++) {
    const c = counts[k] as number;
    total += c;
    if (c > 0) {
      if (!isTerminalOrHonorKind(k)) return false;
      kinds++;
    }
  }
  return total === 14 && kinds === 13;
}

// ---- 役の数え方（分解 1 つ） ----

/** 和了牌が、どの塊のどの位置を埋めたか（待ちの形）。 */
export interface WinInterpretation {
  /** 和了牌が入る塊（塊の配列の添字）。 */
  index: number;
  /** 順子の中の位置（0 = 先頭、1 = 真ん中、2 = 最後）。順子以外は -1。 */
  position: number;
}

export interface HitContext {
  seatKind: number;
  roundKind: number;
  tsumo: boolean;
  riichi: boolean;
}

function hit(id: YakuId, closed: boolean): YakuHit | null {
  const han = YAKU_HAN[id][closed ? 0 : 1];
  return han === 0 ? null : { id, han };
}

/**
 * 分解 1 つ（と、和了牌の入り方）に付く役。`interp` が null のときは、和了牌に依らない書き方をする
 * （平和は両面待ちを問わず、三暗刻はロンで暗刻が明刻になることを問わない）。近い役の探索で、候補を絞るのに使う。
 * 七対子の分解は、七つの対子の塊（type が pair）で表す。
 */
export function hitsOfDecomposition(blocks: readonly Block[], ctx: HitContext, interp: WinInterpretation | null): YakuHit[] {
  const hits: YakuHit[] = [];
  const add = (h: YakuHit | null) => {
    if (h !== null) hits.push(h);
  };
  const closed = blocks.every((b) => !b.open);
  const seqs = blocks.filter((b) => b.type === 'seq');
  const trips = blocks.filter((b) => b.type === 'tri' || b.type === 'kan');
  const pairs = blocks.filter((b) => b.type === 'pair');
  const chiitoi = pairs.length === 7;

  if (ctx.riichi) add(hit('riichi', closed));
  if (ctx.tsumo) add(hit('tsumo', closed));
  if (chiitoi) add(hit('chiitoitsu', true));

  // 断幺九
  const inside = (b: Block): boolean => {
    if (b.kind >= 27) return false;
    if (b.type === 'seq') return numOf(b.kind) >= 1 && numOf(b.kind) <= 5;
    return numOf(b.kind) >= 1 && numOf(b.kind) <= 7;
  };
  if (blocks.every(inside)) add(hit('tanyao', closed));

  // 平和
  if (closed && !chiitoi && trips.length === 0) {
    const pair = pairs[0];
    if (pair !== undefined && !isDragonKind(pair.kind) && pair.kind !== ctx.seatKind && pair.kind !== ctx.roundKind) {
      let ryanmen = true;
      if (interp !== null) {
        const w = blocks[interp.index];
        ryanmen = w !== undefined && w.type === 'seq' && ((interp.position === 0 && numOf(w.kind) <= 5) || (interp.position === 2 && numOf(w.kind) >= 1));
      }
      if (ryanmen) add(hit('pinfu', true));
    }
  }

  // 一盃口・二盃口
  if (closed && !chiitoi) {
    const bySeq = new Map<number, number>();
    for (const s of seqs) bySeq.set(s.kind, (bySeq.get(s.kind) ?? 0) + 1);
    let twins = 0;
    for (const n of bySeq.values()) twins += Math.floor(n / 2);
    if (twins >= 2) add(hit('ryanpeikou', true));
    else if (twins === 1) add(hit('iipeikou', true));
  }

  // 役牌
  for (const t of trips) {
    if (t.kind === 31) add(hit('yakuhai-haku', closed));
    if (t.kind === 32) add(hit('yakuhai-hatsu', closed));
    if (t.kind === 33) add(hit('yakuhai-chun', closed));
    if (t.kind === ctx.seatKind) add(hit('yakuhai-seat', closed));
    if (t.kind === ctx.roundKind) add(hit('yakuhai-round', closed));
  }

  // 三色同順・一気通貫
  const seqStarts = new Set(seqs.map((s) => s.kind));
  for (let a = 0; a < 7; a++) {
    if (seqStarts.has(a) && seqStarts.has(9 + a) && seqStarts.has(18 + a)) {
      add(hit('sanshoku', closed));
      break;
    }
  }
  for (let s = 0; s < 3; s++) {
    if (seqStarts.has(9 * s) && seqStarts.has(9 * s + 3) && seqStarts.has(9 * s + 6)) {
      add(hit('ittsu', closed));
      break;
    }
  }

  // 混全帯幺九・純全帯幺九・混老頭
  const edge = (b: Block): boolean => (b.type === 'seq' ? numOf(b.kind) === 0 || numOf(b.kind) === 6 : isTerminalOrHonorKind(b.kind));
  const anyHonor = blocks.some((b) => b.kind >= 27);
  if (blocks.every(edge)) {
    if (seqs.length > 0) add(hit(anyHonor ? 'chanta' : 'junchan', closed));
    else add(hit('honroto', closed));
  }

  // 対々和・三暗刻・三槓子・三色同刻
  if (trips.length === 4) add(hit('toitoi', closed));
  let concealed = trips.filter((t) => !t.open).length;
  if (interp !== null && !ctx.tsumo) {
    const w = blocks[interp.index];
    if (w !== undefined && (w.type === 'tri' || w.type === 'kan') && !w.open) concealed--;
  }
  if (concealed >= 3 && trips.length >= 3) add(hit('sanankou', closed));
  if (trips.filter((t) => t.type === 'kan').length >= 3) add(hit('sankantsu', closed));
  const tripKinds = new Set(trips.map((t) => t.kind));
  for (let n = 0; n < 9; n++) {
    if (tripKinds.has(n) && tripKinds.has(9 + n) && tripKinds.has(18 + n)) {
      add(hit('sanshoku-doukou', closed));
      break;
    }
  }

  // 小三元
  const dragonTrips = trips.filter((t) => isDragonKind(t.kind)).length;
  if (dragonTrips === 2 && pairs.some((p) => isDragonKind(p.kind))) add(hit('shosangen', closed));

  // 混一色・清一色
  const suits = new Set<number>();
  for (const b of blocks) if (b.kind < 27) suits.add(Math.floor(b.kind / 9));
  if (suits.size === 1) add(hit(anyHonor ? 'honitsu' : 'chinitsu', closed));

  return hits;
}

/** 役満の識別子（調べるのは、近い役の探索で、役満の和了形を普通の役の候補から外すため。画面には出さない）。 */
export type YakumanId = 'daisangen' | 'shosuushi' | 'daisuushi' | 'tsuisou' | 'chinroto' | 'ryuisou' | 'chuuren' | 'suuankou' | 'suukantsu' | 'kokushi';

const GREEN_KINDS = new Set([19, 20, 21, 23, 25, 32]);

/** 分解 1 つに付く役満（国士無双を除く）。HandCalculator の条件に合わせる。 */
export function yakumanOfDecomposition(blocks: readonly Block[], ctx: HitContext, interp: WinInterpretation | null): YakumanId[] {
  const out: YakumanId[] = [];
  const trips = blocks.filter((b) => b.type === 'tri' || b.type === 'kan');
  const pairs = blocks.filter((b) => b.type === 'pair');
  const hasSeq = blocks.some((b) => b.type === 'seq');
  const kindsOf = (b: Block): number[] => (b.type === 'seq' ? [b.kind, b.kind + 1, b.kind + 2] : [b.kind]);
  const allKinds = blocks.flatMap(kindsOf);
  const melds = blocks.filter((b) => b.meld);
  if (trips.filter((t) => t.kind >= 31).length === 3) out.push('daisangen');
  const windTrips = trips.filter((t) => t.kind >= 27 && t.kind <= 30).length;
  if (windTrips === 4) out.push('daisuushi');
  else if (windTrips === 3 && pairs.some((p) => p.kind >= 27 && p.kind <= 30)) out.push('shosuushi');
  if (!hasSeq && allKinds.every((k) => k >= 27)) out.push('tsuisou');
  if (!hasSeq && allKinds.every((k) => k < 27 && (k % 9 === 0 || k % 9 === 8))) out.push('chinroto');
  if (allKinds.every((k) => GREEN_KINDS.has(k))) out.push('ryuisou');
  if (blocks.length !== 7 && trips.length > 0 && melds.length === 0) {
    const suits = new Set(allKinds.filter((k) => k < 27).map((k) => Math.floor(k / 9)));
    if (suits.size === 1 && allKinds.every((k) => k < 27)) {
      const counts = new Array<number>(9).fill(0);
      for (const b of blocks) for (const k of b.type === 'seq' ? [b.kind, b.kind + 1, b.kind + 2] : b.type === 'pair' ? [b.kind, b.kind] : b.type === 'tri' ? [b.kind, b.kind, b.kind] : [b.kind, b.kind, b.kind, b.kind]) counts[k % 9] = (counts[k % 9] as number) + 1;
      const base = [3, 1, 1, 1, 1, 1, 1, 1, 3];
      const extra = counts.map((c, i) => c - (base[i] as number));
      if (extra.every((e) => e >= 0) && extra.reduce((a, b) => a + b, 0) === 1) out.push('chuuren');
    }
  }
  if (blocks.every((b) => !b.open)) {
    let concealed = trips.length;
    if (interp !== null && !ctx.tsumo) {
      const w = blocks[interp.index];
      if (w !== undefined && (w.type === 'tri' || w.type === 'kan')) concealed--;
    }
    if (concealed === 4) out.push('suuankou');
  }
  if (blocks.filter((b) => b.type === 'kan').length === 4) out.push('suukantsu');
  return out;
}

/**
 * 符（和了の形で決まる符。HandCalculator の数え方に合わせる）。同じ飜数の解釈のうち、どれが選ばれるかを決めるのに使う。
 * 戻り値は、10 符単位に切り上げる前の値（`raw`）と、切り上げた値（`fu`）。七対子は 25 符。
 */
export function fuOfDecomposition(blocks: readonly Block[], ctx: HitContext, interp: WinInterpretation): { raw: number; fu: number } {
  if (blocks.length === 7) return { raw: 25, fu: 25 };
  const open = blocks.some((b) => b.open);
  let total = 0;
  const win = blocks[interp.index];
  if (win !== undefined && win.type === 'seq' && !win.meld) {
    const start = numOf(win.kind);
    if ((start === 0 && interp.position === 2) || (start === 6 && interp.position === 0)) total += 2;
    if (interp.position === 1) total += 2;
  }
  const pair = blocks.find((b) => b.type === 'pair');
  if (pair !== undefined) {
    const valued = [31, 32, 33, ctx.seatKind, ctx.roundKind].filter((k) => k === pair.kind).length;
    if (valued === 1) total += 2;
    else if (valued >= 2) total += 4;
  }
  if (win !== undefined && win.type === 'pair') total += 2;
  for (const [index, b] of blocks.entries()) {
    if (b.type !== 'tri' && b.type !== 'kan') continue;
    let isOpen = b.open;
    // ロンで、暗刻になるはずの刻子を完成させたときは、明刻として数える
    if (!ctx.tsumo && !b.meld && interp.index === index) isOpen = true;
    const simple = isTerminalOrHonorKind(b.kind) ? 1 : 0;
    const kan = b.type === 'kan' ? 1 : 0;
    total += [[[4, 2], [16, 8]], [[8, 4], [32, 16]]][simple]?.[kan]?.[isOpen ? 1 : 0] ?? 0;
  }
  if (ctx.tsumo && total > 0) total += 2;
  if (open && total === 0) total += 2;
  total += open || ctx.tsumo ? 20 : 30;
  return { raw: total, fu: Math.ceil(total / 10) * 10 };
}

function hanOf(hits: readonly YakuHit[]): number {
  return hits.reduce((sum, h) => sum + h.han, 0);
}

/** 和了の入力。`counts` は和了牌を含む閉じた手牌（3n+2 枚）。 */
export interface WinInput extends YakuShape {
  /** 和了牌の種類。 */
  winKind: number;
  tsumo: boolean;
  /** 立直をかけている（門前のときだけ数える）。 */
  riichi: boolean;
}

/** 和了の評価。`hits` は、点の高い解釈（飜数、同じなら符）の役。点が同じで役が違う解釈が複数あれば、そのすべてに付く役だけを返す。 */
export interface WinEvaluation {
  /** regular: 4 面子 1 雀頭、chiitoitsu: 七対子、kokushi: 国士無双、none: 和了形ではない。 */
  kind: 'regular' | 'chiitoitsu' | 'kokushi' | 'none';
  /** 役満のとき、その役満（`hits` は空。HandCalculator と同じく、役満には普通の役を足さない）。 */
  yakuman: YakumanId[];
  hits: YakuHit[];
  han: number;
  fu: number;
  /** 飜数も符も同じで役が違う解釈の数（1 なら一意）。 */
  ties: number;
}

/** 分解 1 つについて、和了牌の入り方をすべて挙げる。 */
export function interpretations(blocks: readonly Block[], winKind: number): WinInterpretation[] {
  const out: WinInterpretation[] = [];
  const seen = new Set<string>();
  for (const [index, b] of blocks.entries()) {
    if (b.meld) continue;
    let position = -1;
    if (b.type === 'seq') {
      position = winKind - b.kind;
      if (position < 0 || position > 2) continue;
    } else if (winKind !== b.kind) {
      continue;
    }
    const key = `${b.type}:${b.kind}:${position}`;
    if (seen.has(key)) continue;
    seen.add(key);
    out.push({ index, position });
  }
  return out;
}

const TYPE_RANK: Readonly<Record<Block['type'], number>> = { kan: 0, tri: 1, pair: 2, seq: 3 };

/**
 * 飜数も符も同じ解釈が複数あるときの、符の内訳に使う解釈の決め方。Python の mahjong は、分解を (牌の種類, 塊の種類（槓子・刻子・雀頭・順子の順）) の
 * 並びの小さいほうから、和了牌を含む塊も同じ並びの前のほうから数え、同点なら先に数えたものを選ぶ。それと同じ順の鍵（小さいほうが先）。
 */
function mahjongOrderKey(blocks: readonly Block[], interp: WinInterpretation | null): number[] {
  const code = (b: Block): number => b.kind * 4 + TYPE_RANK[b.type];
  const sorted = blocks.map(code).sort((a, b) => a - b);
  const win = interp === null ? undefined : blocks[interp.index];
  return [...sorted, win === undefined ? -1 : sorted.indexOf(code(win))];
}

function compareKeys(a: readonly number[], b: readonly number[]): number {
  for (let i = 0; i < Math.min(a.length, b.length); i++) {
    const d = (a[i] as number) - (b[i] as number);
    if (d !== 0) return d;
  }
  return a.length - b.length;
}

/** 和了の評価で選ばれた解釈（分解と、和了牌の入り方）。符の内訳（fu-detail.ts）を求めるのに使う。七対子は `interp` が null。 */
export interface ChosenWin {
  blocks: readonly Block[];
  interp: WinInterpretation | null;
  ctx: HitContext;
}

/** 和了の役を数える。点（飜数、同じなら符）がいちばん高い解釈（和了牌の入り方を含む）を選ぶ。HandCalculator と同じ選び方。 */
export function evaluateWin(input: WinInput): WinEvaluation {
  return evaluateWinChosen(input).evaluation;
}

/** `evaluateWin` と同じ評価に、選ばれた解釈を添えて返す（和了形でない・国士無双のときの `chosen` は null）。 */
export function evaluateWinChosen(input: WinInput): { evaluation: WinEvaluation; chosen: ChosenWin | null } {
  const ctx: HitContext = { seatKind: windKind(input.seatWind), roundKind: windKind(input.roundWind), tsumo: input.tsumo, riichi: input.riichi };
  interface Candidate {
    hits: YakuHit[];
    yakuman: YakumanId[];
    blocks: readonly Block[];
    interp: WinInterpretation | null;
  }
  let best: Candidate[] = [];
  /** 符の内訳に使う解釈（`best` のうち、Python の mahjong が先に数える並びのもの）と、その並びの鍵。 */
  let chosen: Candidate | null = null;
  let chosenKey: number[] | null = null;
  let bestHan = -1;
  let bestFu = -1;
  let bestRaw = -1;
  let kind: WinEvaluation['kind'] = 'none';
  const sameCandidate = (a: Candidate, b: Candidate): boolean =>
    a.yakuman.length > 0 || b.yakuman.length > 0
      ? a.yakuman.length === b.yakuman.length && a.yakuman.every((y) => b.yakuman.includes(y))
      : sameIds(a.hits, b.hits);
  const consider = (c: Candidate, fu: { raw: number; fu: number }, k: WinEvaluation['kind']) => {
    const han = c.yakuman.length > 0 ? 13 * c.yakuman.length : hanOf(c.hits);
    const better = han > bestHan || (han === bestHan && (fu.fu > bestFu || (fu.fu === bestFu && fu.raw > bestRaw)));
    if (better) {
      bestHan = han;
      bestFu = fu.fu;
      bestRaw = fu.raw;
      best = [c];
      chosen = c;
      chosenKey = null;
      kind = k;
    } else if (han === bestHan && fu.fu === bestFu && fu.raw === bestRaw) {
      if (!best.some((b) => sameCandidate(b, c))) best.push(c);
      if (chosen !== null) {
        const key = mahjongOrderKey(c.blocks, c.interp);
        chosenKey ??= mahjongOrderKey(chosen.blocks, chosen.interp);
        if (compareKeys(key, chosenKey) < 0) {
          chosen = c;
          chosenKey = key;
        }
      }
    }
  };

  for (const blocks of decompose(input.counts, input.melds)) {
    for (const interp of interpretations(blocks, input.winKind)) {
      const yakuman = yakumanOfDecomposition(blocks, ctx, interp);
      consider({ hits: yakuman.length > 0 ? [] : hitsOfDecomposition(blocks, ctx, interp), yakuman, blocks, interp }, fuOfDecomposition(blocks, ctx, interp), 'regular');
    }
  }
  if (input.melds.length === 0 && isChiitoitsuCounts(input.counts)) {
    const pairs: Block[] = [];
    for (let k = 0; k < TILE_KIND_COUNT; k++) if (input.counts[k] === 2) pairs.push({ type: 'pair', kind: k, open: false, meld: false });
    const yakuman = yakumanOfDecomposition(pairs, ctx, null);
    consider({ hits: yakuman.length > 0 ? [] : hitsOfDecomposition(pairs, ctx, null), yakuman, blocks: pairs, interp: null }, { raw: 25, fu: 25 }, 'chiitoitsu');
  }
  if (kind === 'none' && input.melds.length === 0 && isKokushiCounts(input.counts)) {
    return { evaluation: { kind: 'kokushi', yakuman: ['kokushi'], hits: [], han: 13, fu: 0, ties: 1 }, chosen: null };
  }
  if (kind === 'none') return { evaluation: { kind: 'none', yakuman: [], hits: [], han: 0, fu: 0, ties: 0 }, chosen: null };
  // 点が最大のうち、同点が複数あれば、そのすべてに共通する役だけを返す（どれが選ばれても付く役）
  const first = best[0] as Candidate;
  const common = first.hits.filter((h) => best.every((b) => b.hits.some((x) => x.id === h.id)));
  const pick = (chosen ?? first) as Candidate;
  return {
    evaluation: { kind, yakuman: first.yakuman, hits: common, han: bestHan, fu: bestFu, ties: best.length },
    chosen: { blocks: pick.blocks, interp: pick.interp, ctx },
  };
}

function sameIds(a: readonly YakuHit[], b: readonly YakuHit[]): boolean {
  return a.length === b.length && a.every((h) => b.some((x) => x.id === h.id));
}

// ---- 聴牌の手の「確定している役」 ----

/** 待ち 1 種類と、その牌で和了ったときの役。 */
export interface WaitYaku {
  kind: number;
  tile: Tile;
  /** 手牌（副露の分も）にある、その牌の枚数（4 枚目まで）。 */
  held: number;
  hits: YakuHit[];
  han: number;
  /** 国士無双の待ち（役満。役は数えない）。 */
  kokushi: boolean;
  /** 役満になる待ち（国士無双を含む。`hits` は空）。 */
  yakuman: YakumanId[];
}

/** 聴牌の手（閉じた手牌が 3n+1 枚）の、待ちごとの役。聴牌でなければ空。ロンで和了る前提（門前清自摸和は数えない）。 */
export function waitsOf(shape: YakuShape, riichi = false): WaitYaku[] {
  const total = shape.counts.reduce((a, b) => a + b, 0);
  if (total % 3 !== 1) throw new RangeError(`待ちを数えるのは 3n+1 枚の手牌です: ${total}枚`);
  const meldCounts = meldKindCounts(shape.melds);
  const counts = [...shape.counts];
  const waits: WaitYaku[] = [];
  for (let kind = 0; kind < TILE_KIND_COUNT; kind++) {
    const have = counts[kind] as number;
    if (have + (meldCounts[kind] as number) >= 4) continue;
    counts[kind] = have + 1;
    if (shantenOfCounts(counts) === -1) {
      const evaluation = evaluateWin({ ...shape, counts, winKind: kind, tsumo: false, riichi });
      waits.push({
        kind,
        tile: kindToTile(kind),
        held: have + (meldCounts[kind] as number),
        hits: evaluation.hits,
        han: evaluation.han,
        kokushi: evaluation.kind === 'kokushi',
        yakuman: evaluation.yakuman,
      });
    }
    counts[kind] = have;
  }
  return waits;
}

/** 副露だけで決まる役（役牌の刻子・槓子）。どう和了っても付く。 */
export function meldYaku(shape: Pick<YakuShape, 'melds' | 'seatWind' | 'roundWind'>): YakuHit[] {
  const seat = windKind(shape.seatWind);
  const round = windKind(shape.roundWind);
  const hits: YakuHit[] = [];
  for (const m of shape.melds) {
    if (m.type === 'seq') continue;
    if (m.first === 31) hits.push({ id: 'yakuhai-haku', han: 1 });
    if (m.first === 32) hits.push({ id: 'yakuhai-hatsu', han: 1 });
    if (m.first === 33) hits.push({ id: 'yakuhai-chun', han: 1 });
    if (m.first === seat) hits.push({ id: 'yakuhai-seat', han: 1 });
    if (m.first === round) hits.push({ id: 'yakuhai-round', han: 1 });
  }
  return hits;
}

/** 閉じた手牌の中だけで決まる役牌の刻子。自風と場風は別の役として数える。 */
export function heldYakuhai(shape: Pick<YakuShape, 'counts' | 'seatWind' | 'roundWind'>): YakuHit[] {
  const seat = windKind(shape.seatWind);
  const round = windKind(shape.roundWind);
  const hits: YakuHit[] = [];
  if ((shape.counts[31] as number) >= 3) hits.push({ id: 'yakuhai-haku', han: 1 });
  if ((shape.counts[32] as number) >= 3) hits.push({ id: 'yakuhai-hatsu', han: 1 });
  if ((shape.counts[33] as number) >= 3) hits.push({ id: 'yakuhai-chun', han: 1 });
  if ((shape.counts[seat] as number) >= 3) hits.push({ id: 'yakuhai-seat', han: 1 });
  if ((shape.counts[round] as number) >= 3) hits.push({ id: 'yakuhai-round', han: 1 });
  return hits;
}

/**
 * 副露か手の中の役牌で決まる、確定している役（聴牌していなくても付く）。
 * 副露の役が先で、そのあとに手の中の役牌の刻子。同じ役がすでにあれば足さない。
 */
export function fixedYaku(shape: Pick<YakuShape, 'counts' | 'melds' | 'seatWind' | 'roundWind'>): YakuHit[] {
  const hits = meldYaku(shape);
  const ids = new Set(hits.map((hit) => hit.id));
  for (const held of heldYakuhai(shape)) {
    if (!ids.has(held.id)) hits.push(held);
  }
  return hits;
}

/** 一部の待ちだけで付く役。 */
export interface PartialYaku {
  id: YakuId;
  /** 付く待ちの牌の種類。 */
  waits: number[];
}

/** 手の「確定している役」。 */
export interface SettledYaku {
  /** 門前か（暗槓だけの副露は門前）。 */
  closed: boolean;
  /** 聴牌か。聴牌でなければ `waits` は空で、`settled` は副露か手の中の役牌で決まる役だけ。 */
  tenpai: boolean;
  /** 待ちごとの役（役満になる待ちは含めない）。 */
  waits: WaitYaku[];
  /** 確定している役。聴牌なら全ての待ちで付く役（副露で決まる役を含む）、そうでなければ副露か手の中の役牌で決まる役。 */
  settled: YakuHit[];
  /** 一部の待ちでしか付かない役（聴牌のとき）。 */
  partial: PartialYaku[];
  /** 役が 1 つも付かない待ち（聴牌のとき。副露した手なら和了れない待ち、門前ならロンできない（自摸なら門前清自摸和が付く）待ち）。 */
  deadWaits: number[];
  /** 役満になる待ち（国士無双を含む。役は数えない）。 */
  yakumanWaits: number[];
}

/**
 * 閉じた手牌が 3n+1 枚の手の、確定している役。
 * 聴牌のときは、待ちごとに役を数え、全ての待ちで付く役を確定とする。聴牌でなければ、副露か手の中の役牌で決まる役だけ。
 * 手牌が 3n+2 枚（鳴いた直後など、まだ切っていない手）には使えない（RangeError）。
 */
export function settledYaku(shape: YakuShape, riichi = false): SettledYaku {
  const total = shape.counts.reduce((a, b) => a + b, 0);
  if (total % 3 !== 1) throw new RangeError(`確定している役を数えるのは 3n+1 枚の手牌です: ${total}枚`);
  const closed = shape.melds.every((m) => !m.open);
  const all = waitsOf(shape, riichi);
  const yakumanWaits = all.filter((w) => w.yakuman.length > 0).map((w) => w.kind);
  const waits = all.filter((w) => w.yakuman.length === 0);
  if (waits.length === 0) {
    return { closed, tenpai: all.length > 0, waits: [], settled: fixedYaku(shape), partial: [], deadWaits: [], yakumanWaits };
  }
  const ids = new Set<YakuId>();
  for (const w of waits) for (const h of w.hits) ids.add(h.id);
  const settled: YakuHit[] = [];
  const partial: PartialYaku[] = [];
  for (const id of ids) {
    const have = waits.filter((w) => w.hits.some((h) => h.id === id));
    if (have.length === waits.length) {
      const han = Math.min(...waits.map((w) => (w.hits.find((h) => h.id === id) as YakuHit).han));
      settled.push({ id, han });
    } else {
      partial.push({ id, waits: have.map((w) => w.kind) });
    }
  }
  const order = (id: YakuId) => (Object.keys(YAKU_NAMES) as YakuId[]).indexOf(id);
  settled.sort((a, b) => order(a.id) - order(b.id));
  partial.sort((a, b) => order(a.id) - order(b.id));
  return {
    closed,
    tenpai: true,
    waits,
    settled,
    partial,
    deadWaits: waits.filter((w) => w.hits.length === 0).map((w) => w.kind),
    yakumanWaits,
  };
}
