/**
 * 近い役の探索（役の表示の調査の試作。R10-6・R11-16・R12-14）。画面には使わない。
 *
 * 手（閉じた手牌 3n+1 枚か 3n+2 枚と副露）から、和了形 W（4 面子 1 雀頭か七対子。副露はそのまま）を作るのに、
 * あと何枚引けばよいか（引く枚数 r）を、役ごとに最小にして求める。
 *
 *   r(W) = |W| - (W と手牌で共通する牌の数)   （牌は種類で数える。W と手牌の枚数の少ないほう）
 *   役 Y の距離 = Y が付く（HandCalculator が数える役の一覧に Y が入る。yaku.ts の evaluateWin）W のうち、r が最小のもの
 *
 * 3n+1 枚の手では、r = 1 が聴牌（1 枚引けば和了）で、r は向聴数 + 1。3n+2 枚の手（鳴いた直後でまだ切っていない手）では、
 * r = 0 が和了形そのもの。r 枚引いて、手牌から（3n+1 なら r - 1 枚、3n+2 なら r 枚）切る。
 * 最短の和了（役を問わない）の距離は、向聴数から決まる（`rMin` = shantenOfCounts + 1）。役ごとの距離との差が「遠回り」（`extra`）。
 *
 * 探索は、W の面子（順子 21 種・刻子 34 種から (4 - 副露の数) 個）と雀頭（34 種）を深さ優先で選び、足りない牌の数が予算を
 * 超えたら打ち切る。七対子は、対子にする 7 種類を数の多い順に選ぶ（役ごとに、使える牌を絞って選ぶ）。
 * 形だけで付く役（分解 1 つで決まる役）で候補を絞ってから、本当に付くかは、和了牌の入り方を含めて evaluateWin で確かめる
 * （平和の両面待ち・三暗刻のロン・飜数の高い別の分解に負ける場合など）。和了牌は、引く牌のどれか（最後に引く牌）。
 * 自摸和了として確かめる（門前清自摸和は役に数えない。ロンだと三暗刻が付かない待ちでも、自摸なら付くので）。
 *
 * 牌の枚数は、同じ牌 4 枚までで、副露に使った分を除く。他家の捨て牌・ドラ表示牌は見ない（受け入れ枚数 E-3 と同じ数え方）。
 */
import { shantenOfCounts } from './shanten';
import { TILE_KIND_COUNT } from './tiles';
import {
  type Block,
  type HitContext,
  SHAPE_YAKU,
  type YakuId,
  type YakuMeld,
  type WinEvaluation,
  type WinInput,
  type YakuShape,
  evaluateWin,
  hitsOfDecomposition,
  isTerminalOrHonorKind,
  meldKindCounts,
  windKind,
  YAKU_HAN,
} from './yaku';

export interface NearOptions {
  /** 最短の和了より何枚まで遠回りを許すか（既定 1）。 */
  extra?: number;
  /** 引く枚数の上限（既定 4）。最短の和了がこれより遠い手には、近い役を返さない。 */
  maxDraws?: number;
  /** 調べる役（既定は形で決まる役の全部）。 */
  ids?: readonly YakuId[];
  /**
   * 和了形に付く役を確かめる関数（既定は yaku.ts の `evaluateWin`）。別の実装（@kobalab/majiang-core の hule など）に差し替えて、
   * 探索の上に載せられるかを調べるための口。`hits` が付く役（役満のときは空）。
   */
  evaluate?: (input: WinInput) => Pick<WinEvaluation, 'hits'>;
}

/** 近い役 1 つ。 */
export interface NearYaku {
  id: YakuId;
  /** 飜数（門前か副露かで決まる値）。 */
  han: number;
  /** この役が付く和了形に、あと何枚引けばよいか。 */
  draws: number;
  /** 最短の和了との差（遠回りの枚数）。 */
  extra: number;
  /** 最も近い和了形（閉じた手牌の種類ごとの枚数）。同じ距離の和了形が複数あるときは、見つけた最初のもの。 */
  target: number[];
  /** 和了牌の種類（最後に引く牌）。 */
  win: number;
  /** 手牌から切る牌の種類（重複あり）。 */
  drop: number[];
  /** 引く牌の種類（重複あり）。 */
  need: number[];
}

export interface NearResult {
  /** 最短の和了（役を問わない）に、あと何枚引けばよいか。向聴数 + 1。0 は和了形（3n+2 枚の手のみ）。 */
  rMin: number;
  /** 近い役。引く枚数の少ない順、同じなら飜数の多い順。 */
  near: NearYaku[];
  /** 探索した和了形の数（計測用）。 */
  leaves: number;
}

// ---- 面子の種類の表（順子 0..20 は 先頭の牌 = 色 * 9 + 数字、刻子 21..54 は 牌の種類 + 21） ----

const SEQ_TYPE_COUNT = 21;
const SET_TYPE_COUNT = SEQ_TYPE_COUNT + TILE_KIND_COUNT;

function seqStart(id: number): number {
  return Math.floor(id / 7) * 9 + (id % 7);
}

/** 対子にできる牌に絞る関数が要る役（七対子）。 */
interface PairVariant {
  id: YakuId;
  /** 使ってよい牌の種類。 */
  allowed: (kind: number) => boolean;
}

function pairVariants(): PairVariant[] {
  const variants: PairVariant[] = [
    { id: 'chiitoitsu', allowed: () => true },
    { id: 'tanyao', allowed: (k) => k < 27 && k % 9 >= 1 && k % 9 <= 7 },
    { id: 'honroto', allowed: (k) => isTerminalOrHonorKind(k) },
  ];
  for (let suit = 0; suit < 3; suit++) {
    variants.push({ id: 'chinitsu', allowed: (k) => k < 27 && Math.floor(k / 9) === suit });
    variants.push({ id: 'honitsu', allowed: (k) => k >= 27 || (k < 27 && Math.floor(k / 9) === suit) });
  }
  return variants;
}

const PAIR_VARIANTS = pairVariants();

/** 手牌 H を W に変えるときの、引く牌と切る牌。 */
function diffKinds(hand: readonly number[], target: readonly number[]): { need: number[]; drop: number[] } {
  const need: number[] = [];
  const drop: number[] = [];
  for (let k = 0; k < TILE_KIND_COUNT; k++) {
    const h = hand[k] as number;
    const w = target[k] as number;
    for (let i = h; i < w; i++) need.push(k);
    for (let i = w; i < h; i++) drop.push(k);
  }
  return { need, drop };
}

/**
 * 手（閉じた手牌 3n+1 枚か 3n+2 枚と副露）から、形で決まる役ごとの距離を求め、近い役（最短の和了より遠回りが `extra` 枚以内で、
 * 引く枚数が `maxDraws` 以内）を返す。
 */
export function nearYaku(shape: YakuShape, options: NearOptions = {}): NearResult {
  const extra = options.extra ?? 1;
  const maxDraws = options.maxDraws ?? 4;
  const targetIds = new Set<YakuId>(options.ids ?? SHAPE_YAKU);
  const evaluate = options.evaluate ?? evaluateWin;
  const counts = shape.counts;
  const total = counts.reduce((a, b) => a + b, 0);
  const sets = 4 - shape.melds.length;
  const size = 3 * sets + 2;
  if (sets < 0 || (total !== size && total !== size - 1)) {
    throw new RangeError(`閉じた手牌は ${size - 1} 枚か ${size} 枚です（副露 ${shape.melds.length} 個）: ${total}枚`);
  }
  const rMin = shantenOfCounts(counts) + 1;
  const budget = Math.min(rMin + extra, maxDraws);
  if (rMin > budget || rMin === 0) return { rMin, near: [], leaves: 0 };

  const meldCounts = meldKindCounts(shape.melds);
  const cap = meldCounts.map((c) => 4 - c);
  const closed = shape.melds.every((m) => !m.open);
  const ctx: HitContext = { seatKind: windKind(shape.seatWind), roundKind: windKind(shape.roundWind), tsumo: true, riichi: false };
  const meldBlocks: Block[] = shape.melds.map((m: YakuMeld) => ({ type: m.type, kind: m.first, open: m.open, meld: true }));

  const best = new Map<YakuId, { draws: number; target: number[]; win: number }>();
  let leaves = 0;

  /** 候補の役のうち、距離が縮まるものを evaluateWin で確かめて記録する。 */
  const record = (draws: number, target: readonly number[], candidates: Iterable<YakuId>): void => {
    const pending: YakuId[] = [];
    for (const id of candidates) {
      if (!targetIds.has(id)) continue;
      const have = best.get(id);
      if (have === undefined || draws < have.draws) pending.push(id);
    }
    if (pending.length === 0) return;
    const wins: number[] = [];
    for (let k = 0; k < TILE_KIND_COUNT; k++) if ((target[k] as number) > (counts[k] as number)) wins.push(k);
    for (const win of wins) {
      const ev = evaluate({ ...shape, counts: target, winKind: win, tsumo: true, riichi: false });
      for (const id of [...pending]) {
        if (ev.hits.some((h) => h.id === id)) {
          best.set(id, { draws, target: [...target], win });
          pending.splice(pending.indexOf(id), 1);
        }
      }
      if (pending.length === 0) return;
    }
  };

  // ---- 4 面子 1 雀頭 ----
  const left = [...counts];
  const used = new Array<number>(TILE_KIND_COUNT).fill(0);
  const chosen: number[] = [];

  const leaf = (cost: number, pair: number): void => {
    leaves++;
    const blocks: Block[] = [...meldBlocks];
    for (const id of chosen) {
      if (id < SEQ_TYPE_COUNT) blocks.push({ type: 'seq', kind: seqStart(id), open: false, meld: false });
      else blocks.push({ type: 'tri', kind: id - SEQ_TYPE_COUNT, open: false, meld: false });
    }
    blocks.push({ type: 'pair', kind: pair, open: false, meld: false });
    const candidates = hitsOfDecomposition(blocks, ctx, null).map((h) => h.id);
    if (candidates.length > 0) record(cost, used, candidates);
  };

  const dfs = (depth: number, minId: number, cost: number): void => {
    if (depth === sets) {
      for (let p = 0; p < TILE_KIND_COUNT; p++) {
        if ((used[p] as number) + 2 > (cap[p] as number)) continue;
        const take = Math.min(left[p] as number, 2);
        const next = cost + 2 - take;
        if (next > budget) continue;
        used[p] = (used[p] as number) + 2;
        leaf(next, p);
        used[p] = (used[p] as number) - 2;
      }
      return;
    }
    for (let id = minId; id < SET_TYPE_COUNT; id++) {
      if (id < SEQ_TYPE_COUNT) {
        const a = seqStart(id);
        if ((used[a] as number) + 1 > (cap[a] as number) || (used[a + 1] as number) + 1 > (cap[a + 1] as number) || (used[a + 2] as number) + 1 > (cap[a + 2] as number)) continue;
        let add = 0;
        let t0 = 0;
        let t1 = 0;
        let t2 = 0;
        if ((left[a] as number) > 0) t0 = 1;
        if ((left[a + 1] as number) > 0) t1 = 1;
        if ((left[a + 2] as number) > 0) t2 = 1;
        add = 3 - t0 - t1 - t2;
        if (cost + add > budget) continue;
        left[a] = (left[a] as number) - t0;
        left[a + 1] = (left[a + 1] as number) - t1;
        left[a + 2] = (left[a + 2] as number) - t2;
        used[a] = (used[a] as number) + 1;
        used[a + 1] = (used[a + 1] as number) + 1;
        used[a + 2] = (used[a + 2] as number) + 1;
        chosen.push(id);
        dfs(depth + 1, id, cost + add);
        chosen.pop();
        used[a] = (used[a] as number) - 1;
        used[a + 1] = (used[a + 1] as number) - 1;
        used[a + 2] = (used[a + 2] as number) - 1;
        left[a] = (left[a] as number) + t0;
        left[a + 1] = (left[a + 1] as number) + t1;
        left[a + 2] = (left[a + 2] as number) + t2;
      } else {
        const k = id - SEQ_TYPE_COUNT;
        if ((used[k] as number) + 3 > (cap[k] as number)) continue;
        const take = Math.min(left[k] as number, 3);
        const add = 3 - take;
        if (cost + add > budget) continue;
        left[k] = (left[k] as number) - take;
        used[k] = (used[k] as number) + 3;
        chosen.push(id);
        dfs(depth + 1, id, cost + add);
        chosen.pop();
        used[k] = (used[k] as number) - 3;
        left[k] = (left[k] as number) + take;
      }
    }
  };
  dfs(0, 0, 0);

  // ---- 七対子（閉じた手のみ） ----
  // 対子にする 7 種類を選ぶ。引く枚数は 14 - Σ min(手牌の枚数, 2)。引く枚数の少ない順に（同じなら全部の選び方を）調べて、
  // evaluateWin で役が付くと確かめられたところで止める（選び方によっては、順子の組み合わせとして和了形になり、七対子としては
  // 数えられないことがあるため）。
  if (shape.melds.length === 0) {
    const value = (k: number): number => Math.min(counts[k] as number, 2);
    for (const variant of PAIR_VARIANTS) {
      if (!targetIds.has(variant.id)) continue;
      const kinds: number[] = [];
      for (let k = 0; k < TILE_KIND_COUNT; k++) if (variant.allowed(k)) kinds.push(k);
      if (kinds.length < 7) continue;
      kinds.sort((x, y) => value(y) - value(x) || x - y);
      // suffix[i][n] = kinds[i..] のうち、先頭から n 個の value の和（上限の見積もり）
      const prefix = [0];
      for (const k of kinds) prefix.push((prefix[prefix.length - 1] as number) + value(k));
      const top = (from: number, n: number): number => (prefix[Math.min(kinds.length, from + n)] as number) - (prefix[from] as number);
      const picked: number[] = [];
      let found = false;
      const walk = (from: number, kept: number, goal: number): void => {
        if (found) return;
        if (picked.length === 7) {
          if (kept !== goal) return;
          const target = new Array<number>(TILE_KIND_COUNT).fill(0);
          for (const k of picked) target[k] = 2;
          const before = best.get(variant.id)?.draws ?? Infinity;
          record(14 - goal, target, [variant.id]);
          if ((best.get(variant.id)?.draws ?? Infinity) < before) found = true;
          return;
        }
        const need = 7 - picked.length;
        for (let i = from; i + need <= kinds.length; i++) {
          // これ以降に選べる最大の和でも goal に届かない、または今の和が goal を超えるなら打ち切る
          if (kept + top(i, need) < goal) break;
          const v = value(kinds[i] as number);
          if (kept + v > goal) continue;
          picked.push(kinds[i] as number);
          walk(i + 1, kept + v, goal);
          picked.pop();
          if (found) return;
        }
      };
      for (let cost = Math.max(1, 0); cost <= budget && !found; cost++) {
        if (best.has(variant.id) && (best.get(variant.id)?.draws ?? Infinity) <= cost) break;
        walk(0, 0, 14 - cost);
      }
    }
  }

  const near: NearYaku[] = [];
  for (const [id, found] of best) {
    const han = YAKU_HAN[id][closed ? 0 : 1];
    if (han === 0) continue;
    const { need, drop } = diffKinds(counts, found.target);
    near.push({ id, han, draws: found.draws, extra: found.draws - rMin, target: found.target, win: found.win, drop, need });
  }
  near.sort((a, b) => a.draws - b.draws || b.han - a.han);
  return { rMin, near, leaves };
}
