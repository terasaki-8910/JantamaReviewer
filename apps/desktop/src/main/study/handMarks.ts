/**
 * 出題の手牌の組み立て（盤面の手牌・ツモ牌・鳴く牌 → 画面の並び）と、答え合わせのあとに牌の下へ出す印。
 * 画面（Hand.tsx）に依存しない純粋な関数。
 */
import { plainTile, type BoardState, type Tile } from '@jantama/engine';

import type { HandItem, HandMark, MarkKind } from './Hand';

/** 左から、手牌・ツモ牌・（鳴きの判断で）鳴く牌。 */
export function buildHandItems(board: Pick<BoardState, 'hand' | 'drawn'>, called: Tile | null): HandItem[] {
  const items: HandItem[] = board.hand.map((tile, index) => ({ tile, index, draw: false, called: false }));
  if (board.drawn !== null) items.push({ tile: board.drawn, index: items.length, draw: true, called: false });
  if (called !== null) items.push({ tile: called, index: items.length, draw: false, called: true });
  return items;
}

/** 鳴きの選択肢が手牌から出す牌の位置（同じ牌があればそれ、無ければ同じ種類の牌。赤五と普通の五の違いで、選択肢が分かれないため）。 */
export function usedIndices(items: readonly HandItem[], use: readonly Tile[]): ReadonlySet<number> {
  const used = new Set<number>();
  for (const tile of use) {
    const free = (item: HandItem) => !used.has(item.index) && !item.called;
    const exact = items.find((item) => free(item) && item.tile === tile);
    const found = exact ?? items.find((item) => free(item) && plainTile(item.tile) === plainTile(tile));
    if (found !== undefined) used.add(found.index);
  }
  return used;
}

export interface MarkTargets {
  /** 自分の答えの牌。 */
  you: Tile | null;
  /** 実戦の打牌。 */
  act: Tile | null;
  /** AI の 1 位の打牌。 */
  top: Tile | null;
  /** 実戦がツモ切りだったか（ツモ牌だけに「実戦」の文字を出す）。 */
  actTsumogiri: boolean;
}

const ORDER: readonly MarkKind[] = ['you', 'act', 'top'];

/**
 * 手牌の中で、自分・実戦・AI の打牌と同じ種類の牌に印を付ける（赤五と普通の五は同じ種類）。
 * 同じ種類の牌が何枚かあるときは、いちばん左の 1 枚だけに文字を出す（実戦がツモ切りなら、ツモ牌に）。
 */
export function handMarks(items: readonly HandItem[], targets: MarkTargets): Map<number, HandMark> {
  const marks = new Map<number, { kinds: MarkKind[]; labeled: MarkKind[] }>();
  for (const kind of ORDER) {
    const tile = targets[kind];
    if (tile === null) continue;
    let first = true;
    for (const item of items) {
      if (item.called || plainTile(item.tile) !== plainTile(tile)) continue;
      const mark = marks.get(item.index) ?? { kinds: [], labeled: [] };
      mark.kinds.push(kind);
      if (first) mark.labeled.push(kind);
      first = false;
      marks.set(item.index, mark);
    }
  }
  if (targets.act !== null && targets.actTsumogiri) {
    const drawn = items.find((item) => item.draw);
    if (drawn !== undefined && plainTile(drawn.tile) === plainTile(targets.act)) {
      for (const [index, mark] of marks) {
        mark.labeled = mark.labeled.filter((kind) => kind !== 'act');
        if (index === drawn.index && mark.kinds.includes('act')) mark.labeled.push('act');
      }
    }
  }
  return marks;
}
