/**
 * ドラを目立たせる設定（U-19、R9-6・R10-7）の、どの牌に付けるかの決まり。
 *
 * ドラ表示牌が指す牌（数牌は次の数、9 の次は 1。風は 東→南→西→北→東、三元牌は 白→發→中→白）の面を黄色にする。
 * 付けるのは、手牌・河・副露の牌。赤五は、ドラ表示牌が指す五でもあるとき（ダブドラ）だけ付ける（赤いことでドラだと分かるため）。
 * 鳴かれて薄くなった河の牌と、ドラ表示牌そのものには付けない（呼ぶ側が、その牌には使わない）。
 * 色は、tokens.css の `--dora-fill`（quiz.css が、牌の面に重ねる）。
 */
import { plainTile, tileKind, type Tile } from '@jantama/engine';

const NEXT_HONOR: Readonly<Record<string, Tile>> = { E: 'S', S: 'W', W: 'N', N: 'E', P: 'F', F: 'C', C: 'P' };

/** ドラ表示牌が指す牌（赤でない表記）。 */
export function doraOfMarker(marker: Tile): Tile {
  const plain = plainTile(marker);
  const honor = NEXT_HONOR[plain];
  if (honor !== undefined) return honor;
  const next = (Number(plain.charAt(0)) % 9) + 1;
  return `${next}${plain.charAt(1)}`;
}

/** ドラ表示牌（開いた順）が指す牌の種類（0..33）の集まり。 */
export function doraKinds(markers: readonly Tile[]): ReadonlySet<number> {
  return new Set(markers.map((marker) => tileKind(doraOfMarker(marker))));
}

/**
 * その牌（手牌・河・副露の牌）に、ドラの強調を付けるか。`kinds` が null なら、設定が切（付けない）。
 * 赤五は、指される五（ドラ表示牌が指す種類）のときだけ true になる。
 */
export function isDoraTile(tile: Tile, kinds: ReadonlySet<number> | null): boolean {
  return kinds !== null && kinds.has(tileKind(tile));
}
