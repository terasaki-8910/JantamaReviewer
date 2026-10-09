/**
 * シャンテン数と受け入れ枚数（E-3）。
 *
 * - シャンテン数は、一般形・七対子・国士無双の最小。七対子と国士無双は、閉じた手（副露なしの13・14枚）だけ。
 * - 受け入れ枚数は、自分の手牌だけを数える（天鳳牌理と同じ）。他家の捨て牌やドラ表示牌は数えない。
 *   ある牌を1枚加えてシャンテン数が下がるなら受け入れで、残りは 4 - （その牌の手牌の中の枚数）。
 * - 手牌の枚数は 3n+1 か 3n+2 枚。副露の数は枚数から決まる（14枚・13枚は0、11・10枚は1、8・7枚は2、5・4枚は3、2・1枚は4）。
 *
 * 一般形は、牌の種類（萬子・筒子・索子・字牌）ごとに「面子の数・搭子（対子を含む）の数・雀頭の有無」の
 * 組み合わせを数えておき（同じ並びは記憶する）、四つを足し合わせて 8 - 2×面子 - 搭子 - 雀頭 の最小を取る
 * （面子と搭子の合計は4まで）。
 */
import { type Tile, TILE_KIND_COUNT, countTiles, kindToTile, tileKind, toTenhouNotation } from './tiles';

const MAX_SETS = 4;
/** 表の添字は 面子の数×2 + 雀頭（0 か 1）。値は搭子の最大数で、作れない組み合わせは -1。 */
const TABLE_SIZE = (MAX_SETS + 1) * 2;

type SuitTable = Int8Array;

function newTable(): SuitTable {
  return new Int8Array(TABLE_SIZE).fill(-1);
}

const EMPTY_TABLE: SuitTable = (() => {
  const t = newTable();
  t[0] = 0;
  return t;
})();

/** sub の各組み合わせに、面子・搭子・雀頭を足して dest に（大きいほうを）書き込む。 */
function merge(dest: SuitTable, sub: SuitTable, addSets: number, addBlocks: number, addHead: number): void {
  for (let s = 0; s + addSets <= MAX_SETS; s++) {
    for (let h = 0; h + addHead <= 1; h++) {
      const blocks = sub[s * 2 + h] as number;
      if (blocks < 0) continue;
      const index = (s + addSets) * 2 + h + addHead;
      const value = blocks + addBlocks;
      if (value > (dest[index] as number)) dest[index] = value;
    }
  }
}

function encode(counts: number[], length: number): number {
  let code = 0;
  for (let i = 0; i < length; i++) code = code * 5 + (counts[i] as number);
  return code;
}

const numberSuitCache = new Map<number, SuitTable>();
const honorSuitCache = new Map<number, SuitTable>();

/**
 * 1種類の牌（数牌は9枚分、字牌は7枚分の枚数）から、面子・搭子・雀頭の組み合わせの表を作る。
 * counts は途中で書き換えるが、戻るときに元に戻す。
 */
function suitTable(counts: number[], length: number, sequences: boolean, cache: Map<number, SuitTable>, from: number): SuitTable {
  let i = from;
  while (i < length && counts[i] === 0) i++;
  if (i === length) return EMPTY_TABLE;
  const key = encode(counts, length);
  const cached = cache.get(key);
  if (cached) return cached;

  const result = newTable();
  const here = counts[i] as number;

  // この牌を1枚、どこにも使わない
  counts[i] = here - 1;
  merge(result, suitTable(counts, length, sequences, cache, i), 0, 0, 0);
  counts[i] = here;

  // 刻子
  if (here >= 3) {
    counts[i] = here - 3;
    merge(result, suitTable(counts, length, sequences, cache, i), 1, 0, 0);
    counts[i] = here;
  }

  // 順子
  if (sequences && i + 2 < length && (counts[i + 1] as number) > 0 && (counts[i + 2] as number) > 0) {
    counts[i] = here - 1;
    (counts[i + 1] as number)--;
    (counts[i + 2] as number)--;
    merge(result, suitTable(counts, length, sequences, cache, i), 1, 0, 0);
    (counts[i + 1] as number)++;
    (counts[i + 2] as number)++;
    counts[i] = here;
  }

  // 対子（搭子として、または雀頭として）
  if (here >= 2) {
    counts[i] = here - 2;
    const sub = suitTable(counts, length, sequences, cache, i);
    merge(result, sub, 0, 1, 0);
    // 雀頭にするのは、まだ雀頭が無い組み合わせから
    for (let s = 0; s <= MAX_SETS; s++) {
      const blocks = sub[s * 2] as number;
      if (blocks >= 0 && blocks > (result[s * 2 + 1] as number)) result[s * 2 + 1] = blocks;
    }
    counts[i] = here;
  }

  // 両面・辺張の搭子（隣り合う2枚）
  if (sequences && i + 1 < length && (counts[i + 1] as number) > 0) {
    counts[i] = here - 1;
    (counts[i + 1] as number)--;
    merge(result, suitTable(counts, length, sequences, cache, i), 0, 1, 0);
    (counts[i + 1] as number)++;
    counts[i] = here;
  }

  // 嵌張の搭子（1つ飛ばしの2枚）
  if (sequences && i + 2 < length && (counts[i + 2] as number) > 0) {
    counts[i] = here - 1;
    (counts[i + 2] as number)--;
    merge(result, suitTable(counts, length, sequences, cache, i), 0, 1, 0);
    (counts[i + 2] as number)++;
    counts[i] = here;
  }

  cache.set(key, result);
  return result;
}

function tableOf(counts: readonly number[], offset: number, length: number, sequences: boolean): SuitTable {
  const slice: number[] = [];
  for (let i = 0; i < length; i++) slice.push(counts[offset + i] as number);
  return suitTable(slice, length, sequences, sequences ? numberSuitCache : honorSuitCache, 0);
}

/** 一般形（4面子1雀頭）のシャンテン数。meldCount は副露の数。 */
function regularShanten(counts: readonly number[], meldCount: number): number {
  let dp = EMPTY_TABLE;
  for (const [offset, length, sequences] of [
    [0, 9, true],
    [9, 9, true],
    [18, 9, true],
    [27, 7, false],
  ] as const) {
    const table = tableOf(counts, offset, length, sequences);
    const next = newTable();
    for (let s = 0; s <= MAX_SETS; s++) {
      for (let h = 0; h <= 1; h++) {
        const have = dp[s * 2 + h] as number;
        if (have < 0) continue;
        for (let s2 = 0; s + s2 <= MAX_SETS; s2++) {
          for (let h2 = 0; h + h2 <= 1; h2++) {
            const blocks = table[s2 * 2 + h2] as number;
            if (blocks < 0) continue;
            const index = (s + s2) * 2 + h + h2;
            const value = have + blocks;
            if (value > (next[index] as number)) next[index] = value;
          }
        }
      }
    }
    dp = next;
  }

  let best = 8;
  for (let s = 0; s <= MAX_SETS; s++) {
    for (let h = 0; h <= 1; h++) {
      const blocks = dp[s * 2 + h] as number;
      if (blocks < 0) continue;
      const sets = meldCount + s;
      if (sets > MAX_SETS) continue;
      const value = 8 - 2 * sets - Math.min(blocks, MAX_SETS - sets) - h;
      if (value < best) best = value;
    }
  }
  return best;
}

/** 七対子のシャンテン数（閉じた手の13・14枚）。 */
function chiitoitsuShanten(counts: readonly number[]): number {
  let pairs = 0;
  let kinds = 0;
  for (const c of counts) {
    if (c >= 1) kinds++;
    if (c >= 2) pairs++;
  }
  return 6 - pairs + Math.max(0, 7 - kinds);
}

const ORPHAN_KINDS = [0, 8, 9, 17, 18, 26, 27, 28, 29, 30, 31, 32, 33] as const;

/** 国士無双のシャンテン数（閉じた手の13・14枚）。 */
function kokushiShanten(counts: readonly number[]): number {
  let kinds = 0;
  let pair = 0;
  for (const kind of ORPHAN_KINDS) {
    const c = counts[kind] as number;
    if (c >= 1) kinds++;
    if (c >= 2) pair = 1;
  }
  return 13 - kinds - pair;
}

/** 手牌の枚数から副露の数を決める。3n+1 か 3n+2 枚（1〜14枚）でなければ RangeError。 */
export function meldCountForTileCount(total: number): number {
  if (!Number.isInteger(total) || total < 1 || total > 14 || total % 3 === 0) {
    throw new RangeError(`手牌の枚数は 3n+1 か 3n+2 枚（1〜14枚）です: ${total}`);
  }
  return Math.floor((14 - total) / 3);
}

function validateCounts(counts: readonly number[]): number {
  if (counts.length !== TILE_KIND_COUNT) {
    throw new RangeError(`枚数の配列の長さは ${TILE_KIND_COUNT} です: ${counts.length}`);
  }
  let total = 0;
  for (const c of counts) {
    if (!Number.isInteger(c) || c < 0 || c > 4) throw new RangeError(`同じ牌は 0 から 4 枚です: ${c}`);
    total += c;
  }
  return total;
}

/**
 * 種類ごとの枚数（長さ 34）からシャンテン数を求める。-1 は和了形、0 は聴牌。
 * 手牌が 13・14 枚なら七対子と国士無双も見る。
 */
export function shantenOfCounts(counts: readonly number[]): number {
  const total = validateCounts(counts);
  const meldCount = meldCountForTileCount(total);
  let best = regularShanten(counts, meldCount);
  if (meldCount === 0) {
    best = Math.min(best, chiitoitsuShanten(counts), kokushiShanten(counts));
  }
  return best;
}

/** 牌の並びからシャンテン数を求める（閉じた手の部分だけを渡す）。 */
export function shanten(tiles: readonly Tile[]): number {
  return shantenOfCounts(countTiles(tiles));
}

/** 受け入れの牌 1 種類。 */
export interface AcceptedTile {
  /** 赤でない牌の表記。 */
  tile: Tile;
  /** 牌の種類（0..33）。 */
  kind: number;
  /** 自分の手牌を除いた残りの枚数。 */
  remaining: number;
}

/** 3n+1 枚の手牌のシャンテン数と受け入れ。 */
export interface UkeireResult {
  shanten: number;
  /** 受け入れ枚数の合計。 */
  total: number;
  accepted: AcceptedTile[];
}

function ukeireOfCounts(counts: number[]): UkeireResult {
  const base = shantenOfCounts(counts);
  const accepted: AcceptedTile[] = [];
  let total = 0;
  for (let kind = 0; kind < TILE_KIND_COUNT; kind++) {
    const have = counts[kind] as number;
    if (have >= 4) continue;
    counts[kind] = have + 1;
    const after = shantenOfCounts(counts);
    counts[kind] = have;
    if (after < base) {
      const remaining = 4 - have;
      accepted.push({ tile: kindToTile(kind), kind, remaining });
      total += remaining;
    }
  }
  return { shanten: base, total, accepted };
}

/** 3n+1 枚（13枚など）の手牌の、シャンテン数と受け入れ枚数。 */
export function ukeire(tiles: readonly Tile[]): UkeireResult {
  const counts = countTiles(tiles);
  const total = validateCounts(counts);
  if (total % 3 !== 1) throw new RangeError(`受け入れ枚数は 3n+1 枚の手牌で数えます: ${total}枚`);
  return ukeireOfCounts(counts);
}

/** 3n+2 枚の手牌で、牌の種類を1つ切った後の結果。 */
export interface DiscardOption {
  /** 切る牌（赤でない表記。手牌に同じ種類が複数あっても1つにまとめる）。 */
  tile: Tile;
  kind: number;
  /** 切った後のシャンテン数。 */
  shanten: number;
  /** 切った後の受け入れ枚数。 */
  ukeire: number;
  accepted: AcceptedTile[];
}

/**
 * 3n+2 枚（14枚など）の手牌について、切る牌の種類ごとに、切った後のシャンテン数と受け入れ枚数を返す。
 * 並びは手牌の牌の順（萬子・筒子・索子・字牌）。
 */
export function discardOptions(tiles: readonly Tile[]): DiscardOption[] {
  const counts = countTiles(tiles);
  const total = validateCounts(counts);
  if (total % 3 !== 2) throw new RangeError(`切る牌ごとの受け入れは 3n+2 枚の手牌で数えます: ${total}枚`);
  const options: DiscardOption[] = [];
  for (let kind = 0; kind < TILE_KIND_COUNT; kind++) {
    const have = counts[kind] as number;
    if (have === 0) continue;
    counts[kind] = have - 1;
    const result = ukeireOfCounts(counts);
    counts[kind] = have;
    options.push({ tile: kindToTile(kind), kind, shanten: result.shanten, ukeire: result.total, accepted: result.accepted });
  }
  return options;
}

/**
 * 切る牌の候補のうち、切った後のシャンテン数が最小で、その中で受け入れ枚数が最大のもの（複数あれば全部）。
 * 「最大の受け入れ枚数」の比較（F6）に使う。候補が空なら空。
 */
export function bestDiscardOptions(options: readonly DiscardOption[]): DiscardOption[] {
  let bestShanten = Infinity;
  for (const o of options) bestShanten = Math.min(bestShanten, o.shanten);
  let bestUkeire = -1;
  for (const o of options) if (o.shanten === bestShanten) bestUkeire = Math.max(bestUkeire, o.ukeire);
  return options.filter((o) => o.shanten === bestShanten && o.ukeire === bestUkeire);
}

/** 切る牌（赤でも普通でも同じ種類として）に対応する候補。無ければ undefined。 */
export function findDiscardOption(options: readonly DiscardOption[], tile: Tile): DiscardOption | undefined {
  const kind = tileKind(tile);
  return options.find((o) => o.kind === kind);
}

/**
 * 天鳳牌理の URL（F6）。`tiles` は閉じた手の牌（副露した牌は含めない）。
 * 赤五は普通の五として書く（牌理は赤を区別しない）。
 */
export function tenhouPairiUrl(tiles: readonly Tile[]): string {
  return `https://tenhou.net/2/?q=${toTenhouNotation(tiles)}`;
}
