/**
 * 迷いと評価の、時間の並びでの当てはめ（E-29・E-30、F9・F11。2026-10-11 のチャットの依頼）。
 *
 * ウィジェットの迷いマークと評価は、押した時刻と画像しか持たない。押した順に 1 本に並べると、局は進む一方なので、
 * 画像が崩れて読めなかった迷いや評価も、前後の評価・迷いの局から、どの局かを逆算できる。
 * そこで、迷いと評価を押した時刻の順（同じ時刻は渡した順。迷い → 評価）に並べて、まとめて局に当てはめる。
 *
 * 守る決まり（E-29）:
 * 1. 評価のあとに押した迷い・評価は、その評価の局より後の局。迷いのあとに押した迷い・評価は、その迷いの局か、それより後の局
 *    （評価は終わった局に付けるので、評価のあとは次の局から。迷いは局の途中なので、同じ局が続いてよい）
 * 2. 評価は、どの局にも当てはめないこともできる（押し直し・半荘のあと）。同じ局に 2 つ当たるなら、あとに押したほうを残す。
 *    迷いは、自分の判断がある局にだけ当てはめる（迷いは、当てはめないことはできない）
 * 3. 読めたスクショ（局・残り枚数・点数がそろったものも、崩れて読めた部分だけのもの（E-28）も）に合う局と、
 *    ユーザーが選んだ迷いの結びつけ（links.json の判断の鍵）に、できるだけ合わせる。
 *    手がかりに合わない局に当てはめると、その手がかりごとに費用がかかる（下の定数）。
 *    読み取りと食い違う局に当てはめるより、評価を当てはめないほうが安い。ユーザーの選びは、読み取りよりずっと強い
 * 4. それでも決まらないときは、評価は早い局（直前に遊んでいた局）にする。迷いは、前後の評価・迷いの当てはめから決まる局の幅（`range`）
 *    の中で、早い局に置く（幅の中のどの局かは、まだ決まっていない）。局の幅は、前の評価の局の次か前の迷いの局から、
 *    次の評価か次の迷いの局まで
 *
 * 当てはめは、費用が最も小さい並びを動的計画法で探す。費用は、次の順で比べる（上のものが同じときだけ、下のもので決める）:
 * 1. 手がかりに合わない費用の合計（ユーザーの選び 100・すべて読めた読み取り 3・崩れた読み取り 2・当てはめなかった評価 1）
 * 2. 読み取りの無い（読み取りに合わない）局に置いた評価の数（手がかりのある評価を、残す）
 * 3. 当てはめなかった評価の、押した順での位置（先に押したものを、先に捨てる = あとに押したものを残す）
 * 4. 置いた局の添字の合計（早い局に置く）
 *
 * 迷いの結果は、局（`kyokuPosition`）・局の幅（`range`）・どう決めたか（`how`）・判断の順位づけ（E-30）:
 * - すべて読めた読み取り、残り枚数が読めた崩れた読み取り: 局の幅の中で、読み取りに合う局の判断に、E-17 と同じ順位を付ける
 *   （1位が推定、近いものがほかの候補。`status` は estimated）
 * - 残り枚数が読めない（局だけ分かった）迷い: 推定は出さず、局の幅の中の判断をすべて選ぶ候補にする（`status` は kyoku。E-30）
 * - 読めない迷いで、前後の評価・迷いから何も分からない（局の幅が半荘全体）もの、読み取りに合う局が無い・合う局に判断が無いもの:
 *   手で選ぶ（`status` は manual）
 *
 * 当てはめ方を変えたときは、`RATING_LINK_VERSION` を上げる（保存した評価の当てはめが、いまの当てはめ方より前のものか、見分けるため。E-31）。
 */
import {
  type CenterText,
  type PartialCenterText,
  type ScreenReading,
  isFullReading,
  partialReadingOf,
} from './center-text';
import { type DecisionRef, decisionRefAt, findDecisionRef } from './decision-ref';
import { type KyokuFacts, kyokuFactsOf, locatePartialKyokus } from './kyoku-locate';
import { type MarkLink, type MarkManualReason, rankDecisions } from './mark-link';
import {
  HAND_START_TILES_LEFT,
  type RatingLinkInput,
  type RatingLinking,
  type RatingPlacement,
  type RatingPlacementHow,
  type RatingUnplacedReason,
  assembleRatingLinking,
} from './rating-placement';
import type { MortalReport } from './report-types';

/** ユーザーが選んだ迷いの結びつけ（links.json）に合わない局に、迷いを当てはめる費用。読み取りよりずっと強い手がかり。 */
export const CHOSEN_COST = 100;
/** 局・残り枚数・点数がすべて読めた読み取りに合わない局に、当てはめる費用。 */
export const FULL_READING_COST = 3;
/** 崩れて、読めた部分だけの読み取りに合わない局に、当てはめる費用。 */
export const PARTIAL_READING_COST = 2;
/** 評価を、どの局にも当てはめない費用。読み取りと食い違う局に当てはめるより安い。 */
export const UNPLACED_RATING_COST = 1;

/**
 * 評価の当てはめ方の版（links.json の `ratings_version`）。この版より前の当てはめ方（版の印が無いもの。局の読み取りと押した順だけで当てはめた）
 * で保存した評価の結びつけは、半荘の画面を開いたとき、1 回だけ当てはめ直す（E-31）。当てはめ方を変えたら、この数を上げる。
 */
export const RATING_LINK_VERSION = 2;

/** 迷い 1 件の入力。読み取り（`center` か `lines`。`retries` の読み直しも）と、押した時刻を持つ記録なら何でも渡せる。 */
export interface TimelineMarkInput extends ScreenReading {
  /** 押した時刻（ミリ秒）。 */
  t_ms: number;
  /**
   * ユーザーが選んだ結びつけ（links.json の迷いの値）。判断の鍵なら、その判断の局に当てはめる（いちばん強い手がかり）。
   * `"manual"`（局面を手で選ぶ）など、判断の鍵でないもの・この結果に無い判断は、使わない。
   */
  chosen?: string | null;
}

/**
 * 迷いの局をどう決めたか。
 * - chosen: ユーザーが選んだ判断の局
 * - reading: すべて読めた読み取りに合う局（時間の並びは、本場違いなど、合う局が複数のとき絞るのに使っただけ）
 * - partial: 崩れて、読めた部分だけの読み取りに合う局（局の名前の一部や残り枚数が読めなかった）
 * - timeline: 読み取りが決め手にならない（読めない・合う局が無い・時間の並びと食い違う）ので、前後の評価・迷いの時刻の並びから決めた
 */
export type MarkPlacementHow = 'chosen' | 'reading' | 'partial' | 'timeline';

/** 局の幅を決めた、前後の出来事（迷いか評価）。 */
export interface TimelineNeighbour {
  kind: 'mark' | 'rating';
  /** 渡した並び（迷いなら `marks`、評価なら `ratings`）の何番目か（0 から）。 */
  index: number;
  /** 押した時刻（ミリ秒）。 */
  t_ms: number;
  /** その出来事を当てはめた局（review.kyokus の添字）。 */
  kyokuPosition: number;
}

/** 局の幅（review.kyokus の添字。両端を含む。両端は、自分の判断がある局）。 */
export interface KyokuRange {
  from: number;
  to: number;
}

/** 時間の並びでの、迷い 1 件の結果。`MarkLink`（E-17）に、局・局の幅・どう決めたかを足したもの。 */
export interface TimelineMarkLink<T extends ScreenReading = TimelineMarkInput> extends MarkLink<T> {
  /** スクショから読めた部分（崩れた部分だけのものも含む）。点数も読めなければ null。 */
  reading: PartialCenterText | null;
  /** 当てはめた局（review.kyokus の添字）。判断が1つも無い半荘などで当てはめられなければ null。 */
  kyokuPosition: number | null;
  /**
   * 迷いのいる局の幅（前後の出来事から決まる幅の中で、読み取りに合う局に絞ったもの）。両端は自分の判断がある局。当てはめられなければ null。
   * 幅の中の判断が、順位づけ（estimated）と選び肢（kyoku の `choices`）の対象。
   */
  range: KyokuRange | null;
  how: MarkPlacementHow | null;
  /** 局の幅を決めた、前の出来事。無ければ null（その前は、半荘の最初から）。 */
  before: TimelineNeighbour | null;
  /** 局の幅を決めた、次の出来事。無ければ null（その先は、半荘の終わりまで）。 */
  after: TimelineNeighbour | null;
  /** `status` が kyoku のとき、選んでもらう判断（局の幅の中の、自分の判断すべて。半荘の順）。それ以外は空。 */
  choices: DecisionRef[];
}

/** 時間の並びでの当てはめの結果。 */
export interface TimelineLinking<M extends ScreenReading = TimelineMarkInput, R = RatingLinkInput> {
  /** 迷いごとの結果（渡した順）。 */
  marks: TimelineMarkLink<M>[];
  /** 評価の結びつけ（`linkRatings` と同じ形）。 */
  ratings: RatingLinking<R>;
}

/** 時間の並びの 1 つの出来事（迷いか評価）。 */
interface Slot {
  kind: 'mark' | 'rating';
  /** 渡した並び（迷いなら `marks`、評価なら `ratings`）の何番目か。 */
  index: number;
  /** 渡した順の通し番号（迷い → 評価）。同じ時刻の並びを決める。 */
  input: number;
  t_ms: number;
  reading: PartialCenterText | null;
  /** 読み取りに合う局すべて（review.kyokus の添字）。読み取りが無ければ空。 */
  fits: number[];
  /**
   * 費用の手がかりになる局。読み取りが無い・読み取りに合う局が 1 つも無いときは null（手がかりが無い）。
   * 迷いは、読み取りに合う局のうち、自分の判断がある局。評価は、読み取りに合う局（局の始めの読み取りなら、その前の局）。
   */
  cands: ReadonlySet<number> | null;
  /** 読み取りに合わない局に当てはめる費用（すべて読めた 3・崩れた 2）。 */
  weight: number;
  /** ユーザーが選んだ判断の局（迷いだけ）。無ければ null。 */
  anchor: number | null;
  /** 評価のスクショが、局の始め（残り 66 枚以上）か。 */
  start: boolean;
  /** 当てはめた局。当てはめなければ null（評価だけ）。 */
  position: number | null;
}

/** 費用の成分の数（上の「費用は、次の順で比べる」の 4 つ）。 */
const COMPONENTS = 4;
/** 当てはめなかった（飛ばした）ことを表す印。 */
const SKIPPED = -1;

/**
 * 迷いと評価を、押した時刻の順に並べて局に当てはめる（E-29）。
 * `marks` は、読み取りと押した時刻（と、あればユーザーが選んだ結びつけ）を持つ迷い、`ratings` は同じく評価。どちらも渡した順に返る。
 */
export function linkTimeline<M extends TimelineMarkInput, R extends RatingLinkInput>(
  report: MortalReport,
  input: { marks: readonly M[]; ratings: readonly R[] },
): TimelineLinking<M, R> {
  const facts = kyokuFactsOf(report);
  const kyokuCount = facts.length;
  const hasDecisions = facts.map((f) => (report.review.kyokus[f.position]?.entries.length ?? 0) > 0);
  const decisionKyokus = facts.map((f) => f.position).filter((position) => hasDecisions[position]);
  // 自分の判断がある局が 1 つも無ければ、迷いは当てはめられない（評価だけを当てはめる）
  const marksPlaceable = decisionKyokus.length > 0;

  // ---- 1. 出来事を作って、押した時刻の順に並べる ----
  const makeSlot = (kind: Slot['kind'], index: number, source: ScreenReading & { t_ms: number }, chosen: string | null): Slot => {
    const reading = partialReadingOf(source);
    const fits = reading === null ? [] : locatePartialKyokus(facts, reading).map((f) => f.position);
    const start = kind === 'rating' && reading !== null && reading.tilesLeft !== null && reading.tilesLeft >= HAND_START_TILES_LEFT;
    // 読み取りに合う局が 1 つも無いもの（点数の読み間違いなど）は、どこを指してもいないので、読み取りが無いのと同じに扱う
    let cands: Set<number> | null = null;
    if (reading !== null && fits.length > 0) {
      if (kind === 'mark') cands = new Set(fits.filter((position) => hasDecisions[position]));
      else cands = new Set(start ? fits.map((position) => position - 1).filter((position) => position >= 0) : fits);
    }
    const chosenRef = chosen === null ? null : findDecisionRef(report, chosen);
    return {
      kind,
      index,
      input: 0,
      t_ms: source.t_ms,
      reading,
      fits,
      cands,
      weight: reading !== null && isFullReading(reading) ? FULL_READING_COST : PARTIAL_READING_COST,
      anchor: kind === 'mark' && chosenRef !== null ? chosenRef.kyokuPosition : null,
      start,
      position: null,
    };
  };
  const slots: Slot[] = [
    ...(marksPlaceable ? input.marks.map((mark, index) => makeSlot('mark', index, mark, mark.chosen ?? null)) : []),
    ...input.ratings.map((rating, index) => makeSlot('rating', index, rating, null)),
  ];
  slots.forEach((slot, i) => {
    slot.input = i;
  });
  slots.sort((a, b) => a.t_ms - b.t_ms || a.input - b.input);

  // ---- 2. 費用が最も小さい当てはめを探す ----
  solve(slots, kyokuCount, hasDecisions);

  // ---- 3. 評価の結果 ----
  const placements = ratingPlacements(slots, input.ratings);
  const ratings = assembleRatingLinking(kyokuCount, placements);

  // ---- 4. 迷いの結果 ----
  const placedMarks = new Map<number, TimelineMarkLink<M>>();
  if (marksPlaceable) {
    const howOf = new Map<Slot, MarkPlacementHow>();
    for (const slot of slots) if (slot.kind === 'mark') howOf.set(slot, markHowOf(slot));
    slots.forEach((slot, at) => {
      if (slot.kind !== 'mark' || slot.position === null) return;
      const mark = input.marks[slot.index] as M;
      placedMarks.set(slot.index, markLinkOf({ report, mark, slot, slots, at, howOf, decisionKyokus, hasDecisions }));
    });
  }
  const marks = input.marks.map((mark, index): TimelineMarkLink<M> => placedMarks.get(index) ?? unplacedMark(facts, mark, index));
  return { marks, ratings };
}

// ---------------------------------------------------------------------------------------------------------------------
// 当てはめ（動的計画法）

/**
 * 出来事（押した時刻の順）を、局に当てはめる。結果は `slot.position` に入れる。
 *
 * 状態は「いちばん最後に置いた出来事の局（まだ何も置いていなければ -1）」と「それが評価か」。
 * 次の出来事は、前が評価なら、その局より後の局、前が迷いなら、その局か後の局に置ける。評価は、置かずに飛ばしてもよい（費用 1）。
 */
function solve(slots: readonly Slot[], kyokuCount: number, hasDecisions: readonly boolean[]): void {
  const count = slots.length;
  // 状態 = (何番目の出来事まで済んだか, 最後に置いた局 + 1, 最後が評価か)
  const width = kyokuCount + 1;
  const stateOf = (done: number, last: number, afterRating: number): number => (done * width + last) * 2 + afterRating;
  const states = (count + 1) * width * 2;
  const cost = new Float64Array(states * COMPONENTS).fill(Number.POSITIVE_INFINITY);
  const from = new Int32Array(states).fill(-1);
  const placed = new Int16Array(states).fill(SKIPPED);

  const extra = new Float64Array(COMPONENTS);
  /** 状態 `to` へ、状態 `base` から、費用 `extra`（4 成分）を足して進めるとき、いまより安ければ記録する。 */
  const relax = (to: number, base: number, position: number): void => {
    for (let c = 0; c < COMPONENTS; c++) {
      const next = (cost[base * COMPONENTS + c] as number) + (extra[c] as number);
      const current = cost[to * COMPONENTS + c] as number;
      if (next > current) return;
      if (next < current) break;
    }
    for (let c = 0; c < COMPONENTS; c++) cost[to * COMPONENTS + c] = (cost[base * COMPONENTS + c] as number) + (extra[c] as number);
    from[to] = base;
    placed[to] = position;
  };

  for (let c = 0; c < COMPONENTS; c++) cost[stateOf(0, 0, 0) * COMPONENTS + c] = 0;
  for (let i = 0; i < count; i++) {
    const slot = slots[i] as Slot;
    for (let last = 0; last <= kyokuCount; last++) {
      for (let afterRating = 0; afterRating < 2; afterRating++) {
        const base = stateOf(i, last, afterRating);
        if (!Number.isFinite(cost[base * COMPONENTS] as number)) continue;
        // 評価は、置かずに飛ばせる。先に押した評価ほど、費用を安くして、あとに押した評価を残す（押し直し）
        if (slot.kind === 'rating') {
          extra.set([UNPLACED_RATING_COST, 0, i + 1, 0]);
          relax(stateOf(i + 1, last, afterRating), base, SKIPPED);
        }
        const first = Math.max(0, last - 1 + afterRating);
        for (let position = first; position < kyokuCount; position++) {
          if (slot.kind === 'mark' && !hasDecisions[position]) continue;
          extra.set([conflictCost(slot, position), unsupportedCount(slot, position), 0, position]);
          relax(stateOf(i + 1, position + 1, slot.kind === 'rating' ? 1 : 0), base, position);
        }
      }
    }
  }

  // いちばん安い終わり方を選んで、さかのぼる
  let best = -1;
  for (let last = 0; last <= kyokuCount; last++) {
    for (let afterRating = 0; afterRating < 2; afterRating++) {
      const state = stateOf(count, last, afterRating);
      if (!Number.isFinite(cost[state * COMPONENTS] as number)) continue;
      if (best < 0 || lessCost(cost, state, best)) best = state;
    }
  }
  if (best < 0) return;
  let state = best;
  for (let i = count; i >= 1; i--) {
    const position = placed[state] as number;
    (slots[i - 1] as Slot).position = position === SKIPPED ? null : position;
    state = from[state] as number;
  }
}

/** 費用の成分を、上から順に比べて、`a` が `b` より小さいか。 */
function lessCost(cost: Float64Array, a: number, b: number): boolean {
  for (let c = 0; c < COMPONENTS; c++) {
    const x = cost[a * COMPONENTS + c] as number;
    const y = cost[b * COMPONENTS + c] as number;
    if (x !== y) return x < y;
  }
  return false;
}

/**
 * 出来事を、この局に置くときの、手がかりに合わない費用。
 * - ユーザーが選んだ判断がある迷い: その局なら 0、違えば 100
 * - 読み取りがある: 合う局なら 0、合わなければ、すべて読めた読み取りは 3・崩れた読み取りは 2
 * - 読み取りが無い: 0（どこに置いてもよい）
 */
function conflictCost(slot: Slot, position: number): number {
  if (slot.anchor !== null) return slot.anchor === position ? 0 : CHOSEN_COST;
  if (slot.cands === null) return 0;
  return slot.cands.has(position) ? 0 : slot.weight;
}

/** 出来事を、この局に置くとき、手がかりの無い局に置いた評価として数える数（評価だけ。1 か 0）。迷いは 0。 */
function unsupportedCount(slot: Slot, position: number): number {
  if (slot.kind !== 'rating') return 0;
  return slot.cands !== null && slot.cands.has(position) ? 0 : 1;
}

// ---------------------------------------------------------------------------------------------------------------------
// 評価の結果

function ratingPlacements<R extends RatingLinkInput>(slots: readonly Slot[], ratings: readonly R[]): RatingPlacement<R>[] {
  const ordered = slots.map((slot, at) => ({ slot, at })).filter(({ slot }) => slot.kind === 'rating');
  return ordered.map(({ slot, at }, order): RatingPlacement<R> => {
    const rating = ratings[slot.index] as R;
    const { position, reading } = slot;
    const center: CenterText | null = reading !== null && isFullReading(reading) ? reading : null;
    if (position !== null) {
      const how: RatingPlacementHow = slot.cands !== null && slot.cands.has(position) ? (slot.start ? 'ocr-start' : 'ocr') : 'order';
      return { rating, order, center, reading, position, how, unplaced: null };
    }
    return { rating, order, center, reading, position: null, how: null, unplaced: unplacedReason(slots, at) };
  });
}

/** 当てはめなかった評価（`slots[at]`）の理由。 */
function unplacedReason(slots: readonly Slot[], at: number): RatingUnplacedReason {
  const slot = slots[at] as Slot;
  // 最初の局が始まったところのスクショ（前の局が無い）
  if (slot.start && slot.fits.length > 0 && slot.fits.every((position) => position === 0)) return 'before-first';
  // あとに押した評価が、この評価が行くはずの局に当てはまっている（押し直し。あとのものを残した）
  const floor = lowerBound(slots, at);
  const later = slots.slice(at + 1).filter((other) => other.kind === 'rating' && other.position !== null);
  const taken = later.some((other) => (slot.cands === null ? other.position === floor : slot.cands.has(other.position as number)));
  return taken ? 'duplicate' : 'no-room';
}

/** `slots[at]` が置ける、いちばん早い局（前に置いた出来事から決まる。評価のあとは次の局、迷いのあとは同じ局から）。 */
function lowerBound(slots: readonly Slot[], at: number): number {
  for (let i = at - 1; i >= 0; i--) {
    const before = slots[i] as Slot;
    if (before.position !== null) return before.kind === 'rating' ? before.position + 1 : before.position;
  }
  return 0;
}

// ---------------------------------------------------------------------------------------------------------------------
// 迷いの結果

function markHowOf(slot: Slot): MarkPlacementHow {
  const position = slot.position;
  if (position === null) return 'timeline';
  if (slot.anchor === position) return 'chosen';
  if (slot.cands !== null && slot.cands.has(position)) {
    return slot.reading !== null && isFullReading(slot.reading) ? 'reading' : 'partial';
  }
  return 'timeline';
}

/** 局の幅を決める、前（`step` = -1）か次（`step` = 1）の出来事。時間の並びだけで置いた迷いは、手がかりにならないので飛ばす。 */
function neighbourOf(slots: readonly Slot[], at: number, step: -1 | 1, howOf: ReadonlyMap<Slot, MarkPlacementHow>): Slot | null {
  for (let i = at + step; i >= 0 && i < slots.length; i += step) {
    const other = slots[i] as Slot;
    if (other.position === null) continue;
    if (other.kind === 'mark' && howOf.get(other) === 'timeline') continue;
    return other;
  }
  return null;
}

interface MarkContext<M> {
  report: MortalReport;
  mark: M;
  slot: Slot;
  slots: readonly Slot[];
  at: number;
  howOf: ReadonlyMap<Slot, MarkPlacementHow>;
  decisionKyokus: readonly number[];
  hasDecisions: readonly boolean[];
}

function neighbourInfo(other: Slot | null): TimelineNeighbour | null {
  if (other === null || other.position === null) return null;
  return { kind: other.kind, index: other.index, t_ms: other.t_ms, kyokuPosition: other.position };
}

/** 自分の判断の鍵と呼び名（`positions` の局の、すべての判断。半荘の順）。 */
function decisionsOf(report: MortalReport, positions: readonly number[]): DecisionRef[] {
  return positions.flatMap((position) =>
    (report.review.kyokus[position]?.entries ?? []).flatMap((_, entryIndex) => {
      const ref = decisionRefAt(report, position, entryIndex);
      return ref === null ? [] : [ref];
    }),
  );
}

function markLinkOf<M extends TimelineMarkInput>(ctx: MarkContext<M>): TimelineMarkLink<M> {
  const { report, mark, slot, slots, at, howOf, decisionKyokus, hasDecisions } = ctx;
  const { reading, fits } = slot;
  const how = howOf.get(slot) as MarkPlacementHow;
  const position = slot.position as number;

  // 前後の出来事から決まる局の幅: 前の評価の局の次か前の迷いの局から、次の評価か次の迷いの局まで（その中の、自分の判断がある局）
  const beforeSlot = neighbourOf(slots, at, -1, howOf);
  const afterSlot = neighbourOf(slots, at, 1, howOf);
  const first = decisionKyokus[0] as number;
  const last = decisionKyokus[decisionKyokus.length - 1] as number;
  const low = beforeSlot === null ? first : (beforeSlot.position as number) + (beforeSlot.kind === 'rating' ? 1 : 0);
  const high = afterSlot === null ? last : (afterSlot.position as number);
  const inRange = decisionKyokus.filter((kyoku) => kyoku >= low && kyoku <= high);

  // 判断を選ぶ局: 局の幅の中の、読み取りに合う局。時間の並びと食い違うとき（合う局が幅に無いとき）は、局の幅そのもの
  const fitsWithDecisions = fits.filter((kyoku) => hasDecisions[kyoku]);
  const narrowed = inRange.filter((kyoku) => fitsWithDecisions.includes(kyoku));
  const choiceKyokus = narrowed.length > 0 ? narrowed : inRange;
  // 迷いのいる局の幅（両端は、自分の判断がある局）。読み取りで絞れていれば、絞ったあとの幅
  const range: KyokuRange = { from: choiceKyokus[0] ?? position, to: choiceKyokus[choiceKyokus.length - 1] ?? position };

  const base = {
    index: slot.index,
    mark,
    center: reading !== null && isFullReading(reading) ? reading : null,
    reading,
    kyokuPositions: fits,
    kyokuPosition: position,
    range,
    how,
    before: neighbourInfo(beforeSlot),
    after: neighbourInfo(afterSlot),
  };
  const manual = (reason: MarkManualReason): TimelineMarkLink<M> => ({
    ...base,
    status: 'manual',
    estimate: null,
    alternatives: [],
    reason,
    choices: [],
  });

  // 読めない: 前後の評価・迷いから何も分からない（局の幅が、自分の判断がある局すべて）なら、手で選ぶ
  if (reading === null) {
    if (inRange.length >= decisionKyokus.length) return manual('unreadable');
    return { ...base, status: 'kyoku', estimate: null, alternatives: [], reason: null, choices: decisionsOf(report, inRange) };
  }
  if (fits.length === 0) return manual('no-kyoku');
  if (fitsWithDecisions.length === 0) return manual('no-decision');

  if (reading.tilesLeft !== null) {
    const { estimate, alternatives } = rankDecisions(report, choiceKyokus, reading.tilesLeft);
    if (estimate === null) return manual('no-decision');
    return { ...base, status: 'estimated', estimate, alternatives, reason: null, choices: [] };
  }
  return { ...base, status: 'kyoku', estimate: null, alternatives: [], reason: null, choices: decisionsOf(report, choiceKyokus) };
}

/** 当てはめられなかった迷い（自分の判断がある局が 1 つも無い）。読み取りが無ければ unreadable、合う局が無ければ no-kyoku、あれば no-decision。 */
function unplacedMark<M extends TimelineMarkInput>(facts: readonly KyokuFacts[], mark: M, index: number): TimelineMarkLink<M> {
  const reading = partialReadingOf(mark);
  const fits = reading === null ? [] : locatePartialKyokus(facts, reading).map((f) => f.position);
  const reason: MarkManualReason = reading === null ? 'unreadable' : fits.length === 0 ? 'no-kyoku' : 'no-decision';
  return {
    index,
    mark,
    status: 'manual',
    center: reading !== null && isFullReading(reading) ? reading : null,
    reading,
    kyokuPositions: fits,
    estimate: null,
    alternatives: [],
    reason,
    kyokuPosition: null,
    range: null,
    how: null,
    before: null,
    after: null,
    choices: [],
  };
}
