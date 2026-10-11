import type { CSSProperties } from 'react';

import { Meld } from '../study/Board';
import { layoutMeld, MELD_NAME } from '../study/meldLayout';
import { Tile } from '../study/Tile';
import { tileName } from '../study/tiles';
import type { HandPreview as HandPreviewModel } from './logModel';

/** 読み上げ用の 1 文: 手牌 一萬・二萬 …、ツモ牌 五筒、副露 ポン 白白白（鳴きの判断は、下家の打牌 東）。 */
export function handPreviewLabel(hand: HandPreviewModel): string {
  const closed = hand.items.filter((item) => !item.draw && !item.called).map((item) => tileName(item.tile));
  const drawn = hand.items.find((item) => item.draw);
  const called = hand.items.find((item) => item.called);
  const parts = [`手牌 ${closed.join('・')}`];
  if (drawn !== undefined) parts.push(`ツモ牌 ${tileName(drawn.tile)}`);
  if (called !== undefined) parts.push(`${hand.calledFrom ?? '他家'}の打牌 ${tileName(called.tile)}`);
  for (const meld of hand.melds) {
    const layout = layoutMeld(meld, hand.seat);
    const tiles = [...layout.tiles, ...(layout.added === undefined ? [] : [layout.added])].map((tile) => tileName(tile));
    parts.push(`副露 ${MELD_NAME[layout.kind]} ${tiles.join('')}`);
  }
  return parts.join('、');
}

/**
 * 行全体の幅を、牌の幅の何枚分かで数える（牌の大きさを、列の幅に収まるように決めるため）。
 * `units` は、牌（横向きの牌は 4/3 枚分）の数。`gaps` は、手牌から離れている所の数（ツモ牌・鳴く牌・副露それぞれの前）。
 */
export function handExtent(hand: HandPreviewModel): { units: number; tiles: number; gaps: number } {
  let units = 0;
  let tiles = 0;
  let gaps = 0;
  for (const item of hand.items) {
    units += 1;
    tiles += 1;
    if (item.draw || item.called) gaps += 1;
  }
  for (const meld of hand.melds) {
    const layout = layoutMeld(meld, hand.seat);
    const count = layout.tiles.length;
    units += count + (layout.side >= 0 ? 1 / 3 : 0);
    tiles += count;
    gaps += 1;
  }
  return { units, tiles, gaps };
}

/**
 * 検討ログの行に出す、その場面の手牌（R11-11。プレビュー）。小さな牌を並べる。ツモ牌は少し離して手牌の右に、
 * 他家の打牌への判断（鳴き・ロン）では、手牌の右に、鳴く牌を輪をつけて離して置く（出題の画面の手牌と同じ並び）。
 * 副露は、そのさらに右に、盤面と同じ並べ方で出す。
 * 手牌は答えではないので、「答えを出す」が切のときも出す。1 つの画像として読み上げる。
 */
export function HandPreview({ hand }: { hand: HandPreviewModel }) {
  const { units, tiles, gaps } = handExtent(hand);
  const style = { '--tu': units, '--tn': tiles, '--tg': gaps } as CSSProperties;
  return (
    <span
      className="l-hand"
      role="img"
      aria-label={handPreviewLabel(hand)}
      data-called={hand.calledFrom === null ? undefined : '1'}
      style={style}
    >
      {hand.items.map((item) =>
        item.called ? (
          <span className="l-hs gap" key={`c${item.index}`}>
            {hand.calledFrom !== null && <span className="l-cap">{hand.calledFrom}の打牌</span>}
            <Tile tile={item.tile} className="target" alt="" />
          </span>
        ) : (
          <span className={`l-hs${item.draw ? ' gap' : ''}`} key={item.index}>
            <Tile tile={item.tile} alt="" />
          </span>
        ),
      )}
      {hand.melds.map((meld, index) => (
        <span className="l-hs gap l-meld" key={`m${index}`}>
          <Meld as="span" meld={meld} seat={hand.seat} dora={null} />
        </span>
      ))}
    </span>
  );
}
