/**
 * 出題の答え合わせに出す「確定している役」と「近い役」の組み立てと言い方（役の表示の調査の試作。R10-6・R11-16・R12-14）。画面には使わない。
 *
 * 比べる行動（打牌・チー・ポン・スルー・リーチ・しない）ごとに、その行動のあとの手（`yakuShapeOfChoice`）を役の判定の入力にして、
 *   - 確定している役: yaku.ts の `settledYaku`（聴牌なら、全ての待ちで付く役。そうでなければ副露で決まる役）
 *   - 近い役: yaku-near.ts の `nearYaku`（最短の和了より 1 枚までの遠回り、引く枚数 4 枚まで）
 * を求め（`yakuViewOf`）、2〜3 行の言い方にする（`describeYakuView`）。
 *
 * 言い方の決まり: 画面の言葉は聴牌・向聴（R12-9）。役の名前は雀魂の表示（漢字）。牌は、数牌が 5m のような表記、字牌は漢字。
 * 門前の手の立直・門前清自摸和は、いつでも付けられるので役の欄には出さず、一言（`closedNote`）だけにする。ドラは役ではない。
 */
import type { Decision } from './decision';
import { tileLabel } from './decision-ref';
import { type QuizChoice, answerOptions } from './quiz-choice';
import { shantenOfCounts } from './shanten';
import type { BoardState } from './replay';
import type { Wind } from './report-types';
import { type Tile, TILE_KIND_COUNT, countTiles, kindToTile, tileKind } from './tiles';
import {
  type SettledYaku,
  type YakuHit,
  type YakuId,
  type YakuMeld,
  type YakuShape,
  YAKU_NAMES,
  meldYaku,
  settledYaku,
  windKind,
  yakuMeldOf,
} from './yaku';
import { type NearYaku, nearYaku } from './yaku-near';

// ---- 行動のあとの手 ----

/** 行動のあとの手。riichi は、その行動で立直がかかる（リーチ）。 */
export interface ChoiceShape {
  shape: YakuShape;
  riichi: boolean;
}

function boardShape(board: Pick<BoardState, 'melds' | 'playerId' | 'seatWinds' | 'roundWind'>, counts: number[], extraMelds: YakuMeld[] = []): YakuShape {
  return {
    counts,
    melds: [...(board.melds[board.playerId] ?? []).map(yakuMeldOf), ...extraMelds],
    seatWind: board.seatWinds[board.playerId] as Wind,
    roundWind: board.roundWind,
  };
}

function ownTiles(board: Pick<BoardState, 'hand' | 'drawn'>): Tile[] {
  return board.drawn === null ? [...board.hand] : [...board.hand, board.drawn];
}

/**
 * 比べる行動のあとの手。
 * - 打牌: ツモ牌を含む手から、その牌を切ったあと（3n+1 枚）
 * - スルー（鳴きの判断）: 手牌のまま（3n+1 枚）。リーチ・カン・和了の「しない」: 切る前の手（3n+2 枚）
 * - チー・ポン: 手牌から 2 枚を出して、副露を足した手（3n+2 枚。まだ切っていない）
 * - リーチ: 切る前の手（3n+2 枚）に、立直がかかる
 * - カン・ツモ・ロン: 扱わない（null）
 */
export function yakuShapeOfChoice(decision: Pick<Decision, 'kind' | 'entry' | 'board'>, choice: QuizChoice): ChoiceShape | null {
  const { board } = decision;
  const tiles = ownTiles(board);
  if (choice.type === 'dahai') {
    const counts = countTiles(tiles);
    const kind = tileKind(choice.tile);
    if ((counts[kind] as number) === 0) return null;
    counts[kind] = (counts[kind] as number) - 1;
    return { shape: boardShape(board, counts), riichi: false };
  }
  const option = answerOptions(decision).find((o) => o.id === choice.id);
  if (option === undefined) return null;
  switch (option.kind) {
    case 'pass':
      return { shape: boardShape(board, countTiles(tiles)), riichi: false };
    case 'reach':
      return { shape: boardShape(board, countTiles(tiles)), riichi: true };
    case 'pon':
    case 'chi': {
      if (option.called === null) return null;
      const counts = countTiles(tiles);
      for (const t of option.use) counts[tileKind(t)] = (counts[tileKind(t)] as number) - 1;
      const kinds = [option.called, ...option.use].map(tileKind);
      const meld: YakuMeld =
        option.kind === 'pon' ? { type: 'tri', first: tileKind(option.called), open: true } : { type: 'seq', first: Math.min(...kinds), open: true };
      return { shape: boardShape(board, counts, [meld]), riichi: false };
    }
    default:
      return null;
  }
}

// ---- 見立て ----

/** 見立ての状態。 */
export type YakuState =
  /** 副露した手: 役が確定している（聴牌なら、どの待ちでも役が付く）。 */
  | 'open-ok'
  /** 副露した手: 聴牌だが、役が付く待ちと付かない待ちがある。 */
  | 'open-partial'
  /** 副露した手: 聴牌だが、どの待ちでも役が付かない（和了れない）。 */
  | 'open-dead'
  /** 副露した手: まだ役が確定していないが、近い役がある。 */
  | 'open-seeking'
  /** 副露した手: 役が確定しておらず、近い役もない。 */
  | 'open-lost'
  /** 門前の手（立直・門前清自摸和が使える）。聴牌で、ダマだと役が付かない待ちがあるかは `dama` に。 */
  | 'closed';

/** 門前の聴牌の、ダマ（立直しない）での見立て。 */
export type DamaState = 'ok' | 'partial' | 'dead';

/** 3n+2 枚の手（鳴いた直後）で、聴牌になる切り方 1 つの、待ちと役。 */
export interface AfterDiscard {
  /** 切る牌の種類。 */
  kind: number;
  /** 切ったあとの待ち（役満の待ちを除く）。 */
  waits: number[];
  /** 役が付かない待ち。 */
  dead: number[];
  /** 全ての待ちで付く役。 */
  settled: YakuHit[];
}

export interface YakuView {
  closed: boolean;
  /** 閉じた手牌が 3n+1 枚で、聴牌している（待ちがある）。 */
  tenpai: boolean;
  /** 最短の和了までに引く枚数（向聴数 + 1）。3n+2 枚の手は、切ったあとの向聴数 + 1。 */
  rMin: number;
  settled: SettledYaku;
  near: NearYaku[];
  state: YakuState;
  /** 門前で聴牌のときだけ。 */
  dama: DamaState | null;
  riichi: boolean;
  /** 3n+2 枚の手で、最短の和了が 1 枚先（切れば聴牌）のとき、聴牌になる切り方ごとの待ちと役。それ以外は空。 */
  afterDiscard: AfterDiscard[];
}

/** 近い役の決まり（既定）。引く枚数 3 枚まで、最短の和了より 1 枚までの遠回り（README の定義）。 */
export const NEAR_POLICY = { extra: 1, maxDraws: 3 } as const;

/** 表示に出す近い役の数の上限（1 行に 1 つ。近い順。README の案）。 */
export const MAX_NEAR_LINES = 2;

export interface YakuViewOptions {
  /** 最短の和了より何枚まで遠回りを近い役とするか（既定 1）。 */
  extra?: number;
  /** 引く枚数の上限（既定 3）。 */
  maxDraws?: number;
  /** 立直がかかっている（リーチの行動）。 */
  riichi?: boolean;
}

/**
 * 表示に出す近い役（既定。README の案）。実戦の和了 69 件で多かった役のうち、手の作り方で狙える役: 役牌・断幺九・混一色（清一色を含む）・
 * 一気通貫・三色同順。対々和・七対子・小三元・三暗刻・混全帯幺九・三色同刻も `nearYaku` では求められるが、実戦に出る数が少ないので、
 * 最初の版では出さない。平和・一盃口は、聴牌のとき確定している役としてだけ出る（狙って作る役ではないため）。
 */
export const SHOWN_NEAR: readonly YakuId[] = ['yakuhai-haku', 'yakuhai-hatsu', 'yakuhai-chun', 'yakuhai-seat', 'yakuhai-round', 'tanyao', 'sanshoku', 'ittsu', 'honitsu', 'chinitsu'];

/** 役牌・三色同順・一気通貫が付くのに、手牌に足りない牌（その牌を引く必要がある）。ほかの役は null（どの牌でもよい）。 */
export function forcedNeedOf(n: NearYaku, shape: Pick<YakuShape, 'counts' | 'melds' | 'seatWind' | 'roundWind'>): number[] | null {
  switch (n.id) {
    case 'yakuhai-haku':
    case 'yakuhai-hatsu':
    case 'yakuhai-chun':
    case 'yakuhai-seat':
    case 'yakuhai-round': {
      const kind = yakuhaiKind(n.id, shape);
      return new Array<number>(Math.max(0, 3 - (shape.counts[kind] as number))).fill(kind);
    }
    case 'sanshoku':
      return sanshokuPlan(n, shape).need;
    case 'ittsu':
      return ittsuPlan(n, shape).need;
    default:
      return null;
  }
}

function yakuhaiKind(id: YakuId, shape: Pick<YakuShape, 'seatWind' | 'roundWind'>): number {
  return id === 'yakuhai-haku' ? 31 : id === 'yakuhai-hatsu' ? 32 : id === 'yakuhai-chun' ? 33 : windKind(id === 'yakuhai-seat' ? shape.seatWind : shape.roundWind);
}

/** 近い役として出す上限の「指定の牌の枚数」。役牌は 1 枚以上持っているとき、三色同順・一気通貫は足りない牌が 2 枚までのとき。 */
export const MAX_FORCED_NEED = 2;

/** 表示に出す近い役か。 */
export function isShownNear(n: NearYaku, shape: Pick<YakuShape, 'counts' | 'melds' | 'seatWind' | 'roundWind'>): boolean {
  if (!SHOWN_NEAR.includes(n.id)) return false;
  const need = forcedNeedOf(n, shape);
  return need === null || need.length <= MAX_FORCED_NEED;
}

/** 手と風から、見立てを作る。 */
export function yakuViewOf(shape: YakuShape, options: YakuViewOptions = {}): YakuView {
  const riichi = options.riichi ?? false;
  const total = shape.counts.reduce((a, b) => a + b, 0);
  const closed = shape.melds.every((m) => !m.open);
  const searched = nearYaku(shape, { extra: options.extra ?? NEAR_POLICY.extra, maxDraws: options.maxDraws ?? NEAR_POLICY.maxDraws });
  const near = { ...searched, near: searched.near.filter((n) => isShownNear(n, shape)) };
  const settled: SettledYaku =
    total % 3 === 1
      ? settledYaku(shape, riichi)
      : { closed, tenpai: false, waits: [], settled: meldYaku(shape), partial: [], deadWaits: [], yakumanWaits: [] };
  if (riichi && closed && !settled.settled.some((h) => h.id === 'riichi')) settled.settled = [{ id: 'riichi', han: 1 }, ...settled.settled];
  // 確定している役・一部の待ちで付く役は、近い役に出さない（同じ役を 2 度出さない）
  const known = new Set<YakuId>([...settled.settled.map((h) => h.id), ...settled.partial.map((p) => p.id)]);
  near.near = near.near.filter((n) => !known.has(n.id));
  // 聴牌（または切れば聴牌）で、役が確定しているときは、近い役を出さない（役の有無に関わらない、打点の話になるため）
  if (near.rMin <= 1 && settled.settled.some((h) => h.id !== 'riichi')) near.near = [];
  const tenpai = settled.tenpai;
  const afterDiscard: AfterDiscard[] = [];
  if (total % 3 === 2 && near.rMin === 1) {
    for (let kind = 0; kind < TILE_KIND_COUNT; kind++) {
      if ((shape.counts[kind] as number) === 0) continue;
      const counts = [...shape.counts];
      counts[kind] = (counts[kind] as number) - 1;
      if (shantenOfCounts(counts) !== 0) continue;
      const after = settledYaku({ ...shape, counts }, riichi);
      if (after.waits.length === 0) continue;
      afterDiscard.push({ kind, waits: after.waits.map((w) => w.kind), dead: after.deadWaits, settled: after.settled });
    }
  }
  let state: YakuState = 'closed';
  let dama: DamaState | null = null;
  if (closed) {
    if (tenpai && settled.waits.length > 0) {
      dama = settled.deadWaits.length === 0 ? 'ok' : settled.deadWaits.length === settled.waits.length ? 'dead' : 'partial';
    }
  } else if (settled.settled.length === 0 && afterDiscard.length > 0) {
    // 鳴いた直後で、切れば聴牌になる手: 聴牌になる切り方のうち、役が付く待ちを持つものがあるか
    const alive = afterDiscard.filter((a) => a.dead.length < a.waits.length);
    if (alive.length === 0) state = 'open-dead';
    else state = alive.some((a) => a.dead.length === 0) ? 'open-ok' : 'open-partial';
  } else if (tenpai && settled.waits.length > 0) {
    if (settled.deadWaits.length === 0) state = 'open-ok';
    else state = settled.deadWaits.length === settled.waits.length ? 'open-dead' : 'open-partial';
  } else if (settled.settled.length > 0) {
    state = 'open-ok';
  } else {
    state = near.near.length > 0 ? 'open-seeking' : 'open-lost';
  }
  return { closed, tenpai, rMin: near.rMin, settled, near: near.near, state, dama, riichi, afterDiscard };
}

// ---- 言い方 ----

/** 言い方の部品。文字か、牌の並び（牌は小さな画像で出す）。 */
export type YakuPart = { text: string } | { tiles: Tile[] };

export interface YakuLine {
  /** 役の識別子（場風・自風の役牌を 1 行にまとめたときは、先のもの）。 */
  id: YakuId;
  /** 札の文字。例: 役牌 東（場風）。 */
  name: string;
  /** 飜数（門前か副露かで決まる値）。 */
  han: number;
  parts: YakuPart[];
  /** 近い役のとき: あと何枚引くか、最短の和了より何枚遠回りか。 */
  draws?: number;
  extra?: number;
}

export interface YakuText {
  /** 確定している役。 */
  settled: YakuLine[];
  /** 一部の待ちでしか付かない役（聴牌のとき）。 */
  partial: YakuLine[];
  /** 近い役。 */
  near: YakuLine[];
  /** 警告（副露した手で役が無い・和了れない待ちがある）。無ければ null。 */
  warning: { level: 'danger' | 'info'; parts: YakuPart[] } | null;
  /** 門前の一言（立直・門前清自摸和が使える）。副露した手では null。 */
  closedNote: string | null;
  /** 鳴いて門前を崩す行動のときの一言（立直・門前清自摸和・平和・一盃口が付かなくなる）。それ以外は null。 */
  openNote: string | null;
}

const WIND_NAMES = ['東', '南', '西', '北'] as const;
const SUIT_NAMES = ['萬子', '筒子', '索子'] as const;

function tilesOfKinds(kinds: readonly number[]): Tile[] {
  return kinds.map(kindToTile);
}

function unique<T>(items: readonly T[]): T[] {
  return [...new Set(items)];
}

/** 役の名前。場風・自風の役牌は、牌の名前を入れる。 */
export function yakuLabel(id: YakuId, shape: Pick<YakuShape, 'seatWind' | 'roundWind'>): string {
  if (id === 'yakuhai-seat') return `役牌 ${WIND_NAMES[windKind(shape.seatWind) - 27]}（自風）`;
  if (id === 'yakuhai-round') return `役牌 ${WIND_NAMES[windKind(shape.roundWind) - 27]}（場風）`;
  return YAKU_NAMES[id];
}

function hitLine(hit: YakuHit, shape: YakuShape, parts: YakuPart[]): YakuLine {
  return { id: hit.id, name: yakuLabel(hit.id, shape), han: hit.han, parts };
}

/** 場風・自風の役牌を 1 行にまとめる（ダブ東など。同じ牌が両方のとき）。 */
function mergeDoubleWind<T extends { id: YakuId; name: string; han: number }>(lines: T[], shape: Pick<YakuShape, 'seatWind' | 'roundWind'>): T[] {
  if (shape.seatWind !== shape.roundWind) return lines;
  const seat = lines.find((l) => l.id === 'yakuhai-seat');
  const round = lines.find((l) => l.id === 'yakuhai-round');
  if (seat === undefined || round === undefined) return lines;
  const wind = WIND_NAMES[windKind(shape.seatWind) - 27];
  const merged = { ...seat, name: `役牌 ${wind}（場風・自風）`, han: seat.han + round.han };
  return lines.filter((l) => l !== round).map((l) => (l === seat ? merged : l));
}

function forbiddenForTanyao(counts: readonly number[]): number[] {
  const kinds: number[] = [];
  for (let k = 0; k < TILE_KIND_COUNT; k++) {
    if (k >= 27 || k % 9 === 0 || k % 9 === 8) for (let i = 0; i < (counts[k] as number); i++) kinds.push(k);
  }
  return kinds;
}

/** 副露の順子の先頭の牌の種類。 */
function meldSeqStarts(shape: Pick<YakuShape, 'melds'>): Set<number> {
  return new Set(shape.melds.filter((m) => m.type === 'seq').map((m) => m.first));
}

/** 順子（先頭の牌の種類 start）が、副露にあるか、W（閉じた手牌の和了形）の 3 枚でそろうか。 */
function seqPresent(start: number, melded: ReadonlySet<number>, target: readonly number[]): boolean {
  return melded.has(start) || ((target[start] as number) > 0 && (target[start + 1] as number) > 0 && (target[start + 2] as number) > 0);
}

/** 順子をそろえるのに、手牌に無い牌（副露にあれば無し）。 */
function missingOfSeq(start: number, melded: ReadonlySet<number>, counts: readonly number[]): number[] {
  if (melded.has(start)) return [];
  return [start, start + 1, start + 2].filter((k) => (counts[k] as number) === 0);
}

/** 三色同順: そろえる数字（0 が 123、6 が 789）と、手牌に足りない牌。W が 3 色とも持つ並び（副露の順子を含む）のうち、足りない牌がいちばん少ないもの。 */
function sanshokuPlan(n: Pick<NearYaku, 'target'>, shape: Pick<YakuShape, 'counts' | 'melds'>): { a: number; need: number[] } {
  const melded = meldSeqStarts(shape);
  let best = { a: 0, need: [] as number[] };
  let bestMissing = Infinity;
  for (let a = 0; a < 7; a++) {
    if (![0, 1, 2].every((s) => seqPresent(9 * s + a, melded, n.target))) continue;
    const need = [0, 1, 2].flatMap((s) => missingOfSeq(9 * s + a, melded, shape.counts));
    if (need.length < bestMissing) {
      bestMissing = need.length;
      best = { a, need };
    }
  }
  return best;
}

/** 一気通貫: そろえる色と、手牌に足りない牌。 */
function ittsuPlan(n: Pick<NearYaku, 'target'>, shape: Pick<YakuShape, 'counts' | 'melds'>): { suit: number; need: number[] } {
  const melded = meldSeqStarts(shape);
  let best = { suit: 0, need: [] as number[] };
  let bestMissing = Infinity;
  for (let suit = 0; suit < 3; suit++) {
    const starts = [9 * suit, 9 * suit + 3, 9 * suit + 6];
    if (!starts.every((st) => seqPresent(st, melded, n.target))) continue;
    const need = starts.flatMap((st) => missingOfSeq(st, melded, shape.counts));
    if (need.length < bestMissing) {
      bestMissing = need.length;
      best = { suit, need };
    }
  }
  return best;
}

function nearLine(n: NearYaku, shape: YakuShape): YakuLine {
  const counts = shape.counts;
  const base = { id: n.id, han: n.han, draws: n.draws, extra: n.extra };
  const name = yakuLabel(n.id, shape);
  switch (n.id) {
    case 'yakuhai-haku':
    case 'yakuhai-hatsu':
    case 'yakuhai-chun':
    case 'yakuhai-seat':
    case 'yakuhai-round': {
      const kind = yakuhaiKind(n.id, shape);
      const have = counts[kind] as number;
      const tile = kindToTile(kind);
      const parts: YakuPart[] =
        have >= 3
          ? [{ tiles: [tile, tile, tile] }, { text: 'がそろっている' }]
          : have === 2
            ? [{ tiles: [tile, tile] }, { text: 'が2枚。あと1枚（ポンかツモ）で付く' }]
            : have === 1
              ? [{ tiles: [tile] }, { text: 'が1枚。あと2枚そろえると付く' }]
              : [{ tiles: [tile] }, { text: 'が0枚。3枚そろえる必要がある' }];
      return { ...base, name, parts };
    }
    case 'tanyao': {
      const drop = forbiddenForTanyao(counts);
      const parts: YakuPart[] = drop.length === 0 ? [{ text: 'いまの手は全部2〜8' }] : [{ tiles: tilesOfKinds(drop) }, { text: 'を切ると、ほかは全部2〜8' }];
      return { ...base, name, parts };
    }
    case 'honitsu':
    case 'chinitsu': {
      let suit = 0;
      for (let k = 0; k < 27; k++) if ((n.target[k] as number) > 0) suit = Math.floor(k / 9);
      const drop: number[] = [];
      for (let k = 0; k < TILE_KIND_COUNT; k++) {
        const outside = k < 27 ? Math.floor(k / 9) !== suit : n.id === 'chinitsu';
        if (outside) for (let i = 0; i < (counts[k] as number); i++) drop.push(k);
      }
      const what = n.id === 'chinitsu' ? `${SUIT_NAMES[suit]}だけ` : `${SUIT_NAMES[suit]}と字牌だけ`;
      const parts: YakuPart[] = drop.length === 0 ? [{ text: `いまの手は${what}` }] : [{ text: `${what}にする。切る: ` }, { tiles: tilesOfKinds(drop) }];
      return { ...base, name, parts };
    }
    case 'ittsu': {
      const plan = ittsuPlan(n, shape);
      return { ...base, name, parts: [{ text: `${SUIT_NAMES[plan.suit]}の123・456・789。あと ` }, { tiles: tilesOfKinds(plan.need) }] };
    }
    case 'sanshoku': {
      const plan = sanshokuPlan(n, shape);
      return { ...base, name, parts: [{ text: `${plan.a + 1}${plan.a + 2}${plan.a + 3}の三色。あと ` }, { tiles: tilesOfKinds(plan.need) }] };
    }
    case 'chiitoitsu': {
      let pairs = 0;
      for (let k = 0; k < TILE_KIND_COUNT; k++) if ((counts[k] as number) >= 2) pairs++;
      return { ...base, name, parts: [{ text: `対子が${pairs}組。あと${n.draws}枚で7組` }] };
    }
    case 'toitoi': {
      let sets = 0;
      let pairs = 0;
      for (let k = 0; k < TILE_KIND_COUNT; k++) {
        if ((counts[k] as number) >= 3) sets++;
        else if ((counts[k] as number) === 2) pairs++;
      }
      sets += shape.melds.filter((m) => m.type !== 'seq').length;
      return { ...base, name, parts: [{ text: `刻子（槓子）${sets}組、対子${pairs}組。あと${n.draws}枚` }] };
    }
    default: {
      const need = unique(n.need);
      return { ...base, name, parts: [{ text: `あと${n.draws}枚: ` }, { tiles: tilesOfKinds(need) }] };
    }
  }
}

/** 見立てを、2〜3 行分の言い方にする。 */
export function describeYakuView(view: YakuView, shape: YakuShape, breaksClosed = false): YakuText {
  const settled = mergeDoubleWind(
    view.settled.settled.map((h) => hitLine(h, shape, [])),
    shape,
  );
  const partial = mergeDoubleWind(
    view.settled.partial.map((p) => ({
      ...hitLine({ id: p.id, han: 0 }, shape, [{ text: '待ち ' }, { tiles: tilesOfKinds(p.waits) }, { text: ' のとき' }]),
    })),
    shape,
  );
  const near = mergeDoubleWind(
    view.near.map((n) => nearLine(n, shape)),
    shape,
  ).slice(0, MAX_NEAR_LINES);
  let warning: YakuText['warning'] = null;
  const dead = tilesOfKinds(view.settled.deadWaits);
  if (view.state === 'open-dead' && view.afterDiscard.length > 0) {
    const waits = unique(view.afterDiscard.flatMap((a) => a.waits)).sort((a, b) => a - b);
    warning = { level: 'danger', parts: [{ text: '役無し聴牌にしかならない。待ち ' }, { tiles: tilesOfKinds(waits) }, { text: ' のどれでも、役が付かないので和了れない' }] };
  } else if (view.state === 'open-partial' && view.afterDiscard.length > 0) {
    const best = view.afterDiscard.filter((a) => a.dead.length < a.waits.length).sort((a, b) => a.dead.length / a.waits.length - b.dead.length / b.waits.length)[0];
    const alive = best === undefined ? [] : best.waits.filter((w) => !best.dead.includes(w));
    warning = { level: 'danger', parts: [{ text: '聴牌になっても、役が付く待ちは ' }, { tiles: tilesOfKinds(alive) }, { text: ' だけ（切り方による）' }] };
  } else if (view.state === 'open-dead') {
    warning = { level: 'danger', parts: [{ text: '役無し聴牌。待ち ' }, { tiles: dead }, { text: ' のどれでも、役が付かないので和了れない' }] };
  } else if (view.state === 'open-partial') {
    warning = { level: 'danger', parts: [{ text: '待ち ' }, { tiles: dead }, { text: ' は役が付かず、和了れない' }] };
  } else if (view.state === 'open-seeking') {
    const closest = Math.min(...view.near.map((n) => n.extra));
    warning =
      closest <= 0
        ? { level: 'info', parts: [{ text: '副露した手の役は、まだ確定していない（近い役を保てば付く）' }] }
        : { level: 'danger', parts: [{ text: '副露した手に、まだ役が無い。近い役を作るには、最短より1枚遠回りになる' }] };
  } else if (view.state === 'open-lost') {
    warning = { level: 'danger', parts: [{ text: '副露した手に役が無く、近い役も無い（引く3枚以内で付く役が無い）。このままでは和了れない' }] };
  } else if (view.dama === 'dead') {
    warning = { level: 'info', parts: [{ text: 'ダマ（立直なし）だと、役が無く、ロンできない。立直か自摸が要る' }] };
  } else if (view.dama === 'partial') {
    warning = { level: 'info', parts: [{ text: 'ダマだと、待ち ' }, { tiles: dead }, { text: ' はロンできない（立直か自摸なら和了れる）' }] };
  }
  return {
    settled,
    partial,
    near,
    warning,
    closedNote: view.closed ? '門前: 立直・門前清自摸和が使える' : null,
    openNote: breaksClosed ? '門前を崩す: 立直・門前清自摸和・平和・一盃口が付かなくなる' : null,
  };
}

/** `yakuViewOf` と `describeYakuView` を続けて呼ぶ。 */
export function yakuTextOfChoice(decision: Pick<Decision, 'kind' | 'entry' | 'board'>, choice: QuizChoice, options: YakuViewOptions = {}): { view: YakuView; text: YakuText; shape: YakuShape } | null {
  const made = yakuShapeOfChoice(decision, choice);
  if (made === null) return null;
  const view = yakuViewOf(made.shape, { ...options, riichi: options.riichi ?? made.riichi });
  const wasClosed = (decision.board.melds[decision.board.playerId] ?? []).every((m) => m.type === 'ankan');
  return { view, text: describeYakuView(view, made.shape, wasClosed && !view.closed), shape: made.shape };
}

/** 牌の種類の並びを、牌の呼び名にする（サンプルの JSON 用）。 */
export function kindsLabel(kinds: readonly number[]): string {
  return kinds.map((k) => tileLabel(kindToTile(k))).join(' ');
}
