import type { Tile as TileCode } from '@jantama/engine';

import { tileName, tileSrc } from './tiles';

interface TileProps {
  tile: TileCode;
  /** 読み上げの文字。既定は牌の名前。飾りだけで意味が重なるときは、空の文字にする。 */
  alt?: string;
  className?: string;
  /** ドラの強調を付ける牌（設定が入のとき、ドラ表示牌が指す牌。読み上げにも「（ドラ）」を足す）。 */
  dora?: boolean;
}

/** 牌 1 枚（図柄は画像。面は CSS の背景。引きずれない）。 */
export function Tile({ tile, alt, className, dora = false }: TileProps) {
  const name = (alt ?? tileName(tile)) + (dora && alt !== '' ? '（ドラ）' : '');
  const classes = ['tile', className, dora ? 'is-dora' : undefined].filter((c) => c !== undefined).join(' ');
  return (
    <span className={classes}>
      <img src={tileSrc(tile)} alt={name} draggable={false} />
    </span>
  );
}

/** 裏向きの牌（暗槓の両端）。 */
export function BackTile() {
  return <span className="tile back" role="img" aria-label="裏向きの牌" />;
}
