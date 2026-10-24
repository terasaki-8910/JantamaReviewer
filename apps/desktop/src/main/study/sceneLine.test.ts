/**
 * 答える前の欄の、場面の情報の 1 行（U-47）の言い方。画面を使わず、盤面の河と立直の状態だけで確かめる。
 * 値（数・人の名前）が別の部品になっていること（画面が濃い色で出す）と、部品をつないだ文字の両方を見る。
 */
import type { BoardState, RiichiState, RiverTile, Seat, Tile } from '@jantama/engine';
import { describe, expect, it } from 'vitest';

import { riichiOpponents, riichiParts, sceneLine, type LinePart } from './sceneLine';

const textOf = (parts: readonly LinePart[]): string => parts.map((part) => part.text).join('');
/** 値（濃い色で出す部品）の文字だけ。 */
const strongOf = (parts: readonly LinePart[]): string[] => parts.filter((part) => part.strong).map((part) => part.text);
const riichiText = (board: Pick<BoardState, 'playerId' | 'riichi' | 'rivers'>): string => textOf(riichiParts(board));

/** 河 1 本分: 切った牌の列。`riichiAt` は、立直の宣言牌が何枚目か（1 から）。`calledAt` は、鳴かれた牌が何枚目か。 */
function river(count: number, riichiAt: number | null = null, calledAt: number[] = []): RiverTile[] {
  return Array.from({ length: count }, (_, index) => ({
    tile: '1m' as Tile,
    tsumogiri: false,
    riichi: riichiAt === index + 1,
    calledBy: calledAt.includes(index + 1) ? (1 as Seat) : null,
  }));
}

function boardOf(me: Seat, riichi: RiichiState[], rivers: RiverTile[][]): Pick<BoardState, 'playerId' | 'riichi' | 'rivers'> {
  return { playerId: me, riichi, rivers };
}

describe('他家の立直（U-47）', () => {
  it('立直している他家がいなければ「他家の立直なし」（自分の立直は数えない）', () => {
    const board = boardOf(0, ['accepted', 'none', 'none', 'none'], [river(5, 5), river(5), river(5), river(5)]);
    expect(riichiOpponents(board)).toEqual([]);
    expect(riichiText(board)).toBe('他家の立直なし');
    expect(strongOf(riichiParts(board))).toEqual([]);
  });

  it('1 人: 「対面が立直（9巡目）」。N巡目は、立直の宣言牌が河の何枚目か。人の呼び名と巡目が値', () => {
    const board = boardOf(0, ['none', 'none', 'accepted', 'none'], [river(9), river(9), river(9, 9), river(9)]);
    expect(riichiOpponents(board)).toEqual([{ seat: 2, relation: '対面', junme: 9 }]);
    expect(riichiText(board)).toBe('対面が立直（9巡目）');
    expect(riichiParts(board)).toEqual([
      { text: '対面', strong: true },
      { text: 'が立直（', strong: false },
      { text: '9', strong: true },
      { text: '巡目）', strong: false },
    ]);
  });

  it('鳴かれた牌も、河の枚数に数える（宣言牌の前に鳴かれた牌があっても、N 枚目）', () => {
    const board = boardOf(0, ['none', 'accepted', 'none', 'none'], [river(7), river(8, 7, [2, 4]), river(7), river(7)]);
    expect(riichiText(board)).toBe('下家が立直（7巡目）');
  });

  it('2 人以上: 席の順（下家・対面・上家）に「・」でつなぐ。本人の席が替わっても、本人から見た呼び名', () => {
    // 本人が席 2: 下家は席 3、対面は席 0、上家は席 1
    const board = boardOf(2, ['accepted', 'accepted', 'none', 'declared'], [river(10, 8), river(12, 4), river(11), river(11, 11)]);
    expect(riichiOpponents(board).map((opponent) => opponent.relation)).toEqual(['下家', '対面', '上家']);
    expect(riichiText(board)).toBe('下家が立直（11巡目）・対面が立直（8巡目）・上家が立直（4巡目）');
    expect(strongOf(riichiParts(board))).toEqual(['下家', '11', '対面', '8', '上家', '4']);
  });

  it('下家と上家の 2 人でも、下家が先（宣言した順ではない）', () => {
    const board = boardOf(1, ['accepted', 'none', 'none', 'accepted'], [river(6, 2), river(6), river(6), river(6, 6)]);
    // 本人が席 1: 下家は席 2、対面は席 3、上家は席 0
    expect(riichiText(board)).toBe('対面が立直（6巡目）・上家が立直（2巡目）');
  });

  it('立直を宣言したが、宣言牌がまだ河に無いときは、巡目を付けない', () => {
    const board = boardOf(0, ['declared', 'declared', 'none', 'none'], [river(4), river(4), river(4), river(4)]);
    expect(riichiText(board)).toBe('下家が立直');
    expect(strongOf(riichiParts(board))).toEqual(['下家']);
  });
});

describe('場面の 1 行（巡目・向聴数・他家の立直）', () => {
  const board = boardOf(0, ['none', 'none', 'accepted', 'none'], [river(9), river(9), river(9, 9), river(9)]);
  const quiet = boardOf(0, ['none', 'none', 'none', 'none'], [river(3), river(3), river(3), river(3)]);
  /** 1 行の文字（項目を「 · 」でつなぐ。画面の 1 行と同じ）。 */
  const lineText = (line: ReturnType<typeof sceneLine>) => [line.junme, line.shanten, line.riichi].map(textOf).join(' · ');

  it('「12巡目 · 1向聴 · 対面が立直（9巡目）」。数と人の名前が値', () => {
    const line = sceneLine({ junme: 12, shanten: 1, board: board as BoardState });
    expect(line).toEqual({
      junme: [
        { text: '12', strong: true },
        { text: '巡目', strong: false },
      ],
      shanten: [
        { text: '1', strong: true },
        { text: '向聴', strong: false },
      ],
      riichi: riichiParts(board),
    });
    expect(lineText(line)).toBe('12巡目 · 1向聴 · 対面が立直（9巡目）');
    expect([line.junme, line.shanten, line.riichi].flatMap(strongOf)).toEqual(['12', '1', '対面', '9']);
  });

  it('聴牌（向聴数 0）は「聴牌」全体が値', () => {
    const line = sceneLine({ junme: 4, shanten: 0, board: quiet as BoardState });
    expect(lineText(line)).toBe('4巡目 · 聴牌 · 他家の立直なし');
    expect(line.shanten).toEqual([{ text: '聴牌', strong: true }]);
    expect([line.junme, line.shanten, line.riichi].flatMap(strongOf)).toEqual(['4', '聴牌']);
  });
});
