/**
 * 牌の表記と基本の操作。
 *
 * 内部の牌は mjai の表記の文字列で持つ:
 * - 1m..9m（萬子）、1p..9p（筒子）、1s..9s（索子）
 * - E S W N（東南西北）、P F C（白・發・中）
 * - 赤五は 5mr・5pr・5sr
 *
 * 「種類」（kind）は赤かどうかを無視した 0..33 の番号。
 * 0-8 が萬子、9-17 が筒子、18-26 が索子、27-33 が E S W N P F C。
 */
export type Tile = string;

/** 牌の種類の数（34）。 */
export const TILE_KIND_COUNT = 34;

const HONOR_LETTERS = ['E', 'S', 'W', 'N', 'P', 'F', 'C'] as const;
const SUIT_LETTERS = ['m', 'p', 's'] as const;

const TILE_PATTERN = /^(?:[1-9][mps]|5[mps]r|[ESWNPFC])$/;

/** mjai の牌の表記として正しいか。 */
export function isTile(value: unknown): value is Tile {
  return typeof value === 'string' && TILE_PATTERN.test(value);
}

/** 赤五か。 */
export function isRedFive(tile: Tile): boolean {
  return tile.length === 3;
}

/** 赤を普通の五に戻す（5mr -> 5m）。赤でなければそのまま。 */
export function plainTile(tile: Tile): Tile {
  return tile.length === 3 ? tile.slice(0, 2) : tile;
}

/** 牌の種類（0..33）。赤五は普通の五と同じ種類。 */
export function tileKind(tile: Tile): number {
  const first = tile.charCodeAt(0);
  if (first >= 0x31 && first <= 0x39) {
    const suit = SUIT_LETTERS.indexOf(tile.charAt(1) as (typeof SUIT_LETTERS)[number]);
    if (suit >= 0) return suit * 9 + (first - 0x31);
  } else {
    const honor = HONOR_LETTERS.indexOf(tile as (typeof HONOR_LETTERS)[number]);
    if (honor >= 0) return 27 + honor;
  }
  throw new RangeError(`牌の表記として正しくありません: ${JSON.stringify(tile)}`);
}

/** 種類（0..33）から、赤でない牌の表記にする。 */
export function kindToTile(kind: number): Tile {
  if (!Number.isInteger(kind) || kind < 0 || kind >= TILE_KIND_COUNT) {
    throw new RangeError(`牌の種類は 0 から 33 の整数です: ${kind}`);
  }
  if (kind < 27) return `${(kind % 9) + 1}${SUIT_LETTERS[Math.floor(kind / 9)]}`;
  return HONOR_LETTERS[kind - 27] as string;
}

/** 数牌か（字牌でなければ）。 */
export function isNumberKind(kind: number): boolean {
  return kind < 27;
}

/** 二つの牌を並べ替えの順に比べる。種類の順で、同じ種類なら赤五を先にする。 */
export function compareTiles(a: Tile, b: Tile): number {
  const byKind = tileKind(a) - tileKind(b);
  if (byKind !== 0) return byKind;
  return Number(isRedFive(b)) - Number(isRedFive(a));
}

/** 牌を並べ替えた新しい配列。 */
export function sortTiles(tiles: readonly Tile[]): Tile[] {
  return [...tiles].sort(compareTiles);
}

/** 種類ごとの枚数（長さ 34）。赤は種類に含める。 */
export function countTiles(tiles: readonly Tile[]): number[] {
  const counts = new Array<number>(TILE_KIND_COUNT).fill(0);
  for (const tile of tiles) {
    const kind = tileKind(tile);
    counts[kind] = (counts[kind] ?? 0) + 1;
  }
  return counts;
}

/** 牌の並びを、天鳳の牌理の表記にする。例: `56m46688p1145888s`。字牌は 1z（東）から 7z（中）。赤は普通の五として書く。 */
export function toTenhouNotation(tiles: readonly Tile[]): string {
  const counts = countTiles(tiles);
  let out = '';
  for (let suit = 0; suit < 3; suit++) {
    let digits = '';
    for (let i = 0; i < 9; i++) digits += String(i + 1).repeat(counts[suit * 9 + i] ?? 0);
    if (digits) out += digits + SUIT_LETTERS[suit];
  }
  let honors = '';
  for (let i = 0; i < 7; i++) honors += String(i + 1).repeat(counts[27 + i] ?? 0);
  if (honors) out += `${honors}z`;
  return out;
}

/** 天鳳の牌理の表記を牌の並びにする。`0m` `0p` `0s` は赤五。不正な表記なら RangeError。 */
export function parseTenhouNotation(text: string): Tile[] {
  const tiles: Tile[] = [];
  let digits = '';
  for (const ch of text) {
    if (ch >= '0' && ch <= '9') {
      digits += ch;
      continue;
    }
    if (ch !== 'm' && ch !== 'p' && ch !== 's' && ch !== 'z') {
      throw new RangeError(`牌理の表記に使えない文字があります: ${JSON.stringify(ch)}`);
    }
    for (const d of digits) {
      if (ch === 'z') {
        const n = Number(d);
        if (n < 1 || n > 7) throw new RangeError(`字牌は 1z から 7z です: ${d}z`);
        tiles.push(HONOR_LETTERS[n - 1] as string);
      } else if (d === '0') {
        tiles.push(`5${ch}r`);
      } else {
        tiles.push(`${d}${ch}`);
      }
    }
    digits = '';
  }
  if (digits) throw new RangeError('牌理の表記が牌の種類（m p s z）で終わっていません');
  return tiles;
}
