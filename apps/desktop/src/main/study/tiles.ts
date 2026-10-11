/**
 * 牌の画像（FluffyStuff/riichi-mahjong-tiles。パブリックドメイン。`public/tiles/` に置いた SVG）と、牌の呼び名。
 * 牌の面（`Front.svg`）は CSS の背景で、図柄の SVG をその上に重ねる（quiz.css の `.tile`）。
 */
import { isRedFive, plainTile, tileKind, type Tile } from '@jantama/engine';

const SUIT_FILE = { m: 'Man', p: 'Pin', s: 'Sou' } as const;
const HONOR_FILE: Readonly<Record<string, string>> = {
  E: 'Ton',
  S: 'Nan',
  W: 'Shaa',
  N: 'Pei',
  P: 'Haku',
  F: 'Hatsu',
  C: 'Chun',
};
const HONOR_NAME: Readonly<Record<string, string>> = { E: '東', S: '南', W: '西', N: '北', P: '白', F: '發', C: '中' };
const NUMBER_NAME = ['', '一', '二', '三', '四', '五', '六', '七', '八', '九'] as const;
const SUIT_NAME = { m: '萬', p: '筒', s: '索' } as const;

/** 図柄の SVG のファイルの名前（拡張子なし）。赤五は `Man5-Dora` など。 */
export function tileFile(tile: Tile): string {
  const honor = HONOR_FILE[tile];
  if (honor !== undefined) return honor;
  const suit = SUIT_FILE[tile.charAt(1) as keyof typeof SUIT_FILE];
  return `${suit}${isRedFive(tile) ? '5-Dora' : tile.charAt(0)}`;
}

/** 図柄の画像の場所（アプリの public の下）。 */
export function tileSrc(tile: Tile): string {
  return `/tiles/${tileFile(tile)}.svg`;
}

/** 画像の代わりの文字（読み上げ用）。例: 一萬・赤五筒・東。 */
export function tileName(tile: Tile): string {
  const honor = HONOR_NAME[tile];
  if (honor !== undefined) return honor;
  const suit = SUIT_NAME[tile.charAt(1) as keyof typeof SUIT_NAME];
  return `${isRedFive(tile) ? '赤五' : NUMBER_NAME[Number(tile.charAt(0))]}${suit}`;
}

/** 牌の並べ替えの順（種類の順）。 */
export function kindOrder(tile: Tile): number {
  return tileKind(plainTile(tile));
}
