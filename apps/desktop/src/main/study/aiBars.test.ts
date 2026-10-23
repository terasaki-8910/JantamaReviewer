/**
 * AI の評価の棒（U-43）の、高さ・数字・読み上げの文。画面を使わず、手牌と判断の記録（候補と確率）だけで確かめる。
 */
import type { ReportEntry, Tile } from '@jantama/engine';
import { describe, expect, it } from 'vitest';

import { barHeight, formatBarProbability, handBars } from './aiBars';
import type { HandItem } from './Hand';
import { buildHandItems } from './handMarks';

/** 候補（牌と確率。結果 JSON の並び = 評価の高い順）と、実戦の打牌から、判断の記録の必要な部分を作る。 */
function entryOf(candidates: Array<[Tile, number]>, actual: Tile): Pick<ReportEntry, 'details' | 'actual'> {
  return {
    details: candidates.map(([pai, prob], index) => ({
      action: { type: 'dahai' as const, actor: 0 as const, pai, tsumogiri: false },
      q_value: 10 - index,
      prob,
    })),
    actual: { type: 'dahai', actor: 0, pai: actual, tsumogiri: false },
  };
}

/** 手牌（ツモ牌は最後）から、手牌の並び。 */
function itemsOf(hand: Tile[], drawn: Tile | null = null, called: Tile | null = null): HandItem[] {
  return buildHandItems({ hand, drawn }, called);
}

describe('棒の高さ: 40px × 確率（四捨五入）。0 より大きければ 2px 以上、0 なら棒なし', () => {
  it('0 は 0、ごく小さい確率は 2px', () => {
    expect(barHeight(0)).toBe(0);
    expect(barHeight(1e-9)).toBe(2);
    // 1.2% は 0.48px → 四捨五入で 0 だが、0 より大きいので 2px
    expect(barHeight(0.012)).toBe(2);
  });

  it('40px × 確率。100% は 40px。確率が 1 を少し超えても 40px', () => {
    expect(barHeight(0.5)).toBe(20);
    expect(barHeight(0.977)).toBe(39);
    expect(barHeight(0.0625)).toBe(3);
    expect(barHeight(1)).toBe(40);
    expect(barHeight(1.0000001)).toBe(40);
  });
});

describe('棒の上の数字: 小数 1 桁と %。0.1% 未満は <0.1%', () => {
  it('例', () => {
    expect(formatBarProbability(0.977)).toBe('97.7%');
    expect(formatBarProbability(0.0227)).toBe('2.3%');
    expect(formatBarProbability(0.001)).toBe('0.1%');
    expect(formatBarProbability(0.00099)).toBe('<0.1%');
    expect(formatBarProbability(0)).toBe('<0.1%');
    expect(formatBarProbability(1)).toBe('100.0%');
  });
});

describe('手牌の棒', () => {
  const hand: Tile[] = ['1m', '3m', '3m', '5p', '7p', '8p', '2s', '4s', '6s', '8s', 'E', 'E', 'S'];

  it('牌ごとに 1 本（鳴く牌には無い）。確率は、その牌の候補から。候補に無い牌は 0（棒なし）', () => {
    const items = itemsOf(hand, 'N', '9m');
    const result = handBars(items, entryOf([['E', 0.6], ['1m', 0.3], ['N', 0.1]], 'E'), null);
    expect([...result.bars.keys()]).toEqual(items.filter((item) => !item.called).map((item) => item.index));
    expect(result.bars.get(items.find((item) => item.tile === 'E')!.index)?.probability).toBe(0.6);
    // 候補に無い牌
    const bare = result.bars.get(items.find((item) => item.tile === '5p')!.index);
    expect(bare).toMatchObject({ probability: 0, height: 0, label: null, top: false });
    expect(result.bars.get(items.find((item) => item.called)?.index ?? -1)).toBeUndefined();
  });

  it('数字は、確率の上位 3 つ（0.5% 以上）。4 番目以降には出ない', () => {
    const items = itemsOf(hand);
    const result = handBars(items, entryOf([['E', 0.5], ['1m', 0.3], ['S', 0.15], ['8s', 0.04], ['5p', 0.01]], 'E'), null);
    const labels = (tile: Tile) => result.bars.get(items.find((item) => item.tile === tile)!.index)?.label;
    expect(labels('E')).toBe('50.0%');
    expect(labels('1m')).toBe('30.0%');
    expect(labels('S')).toBe('15.0%');
    expect(labels('8s')).toBeNull();
    expect(labels('5p')).toBeNull();
  });

  it('上位 3 つでも、0.5% 未満の牌には出ない（実戦・自分の牌は、確率にかかわらず出る）', () => {
    const items = itemsOf(hand);
    // 3 位が 0.4%: 出ない。自分の答え（7p。0.1% 未満）と実戦（6s）は出る
    const result = handBars(items, entryOf([['E', 0.9], ['1m', 0.095], ['S', 0.004], ['8s', 0.001]], '6s'), '7p');
    const labels = (tile: Tile) => result.bars.get(items.find((item) => item.tile === tile)!.index)?.label;
    expect(labels('E')).toBe('90.0%');
    expect(labels('1m')).toBe('9.5%');
    expect(labels('S')).toBeNull();
    expect(labels('7p')).toBe('<0.1%');
    expect(labels('6s')).toBe('<0.1%');
  });

  it('同じ牌が何枚かあるときは、いちばん左の 1 枚だけに数字。棒は、どの 1 枚にも同じ高さ', () => {
    const items = itemsOf(hand);
    const result = handBars(items, entryOf([['3m', 0.8], ['E', 0.2]], '3m'), '3m');
    const threes = items.filter((item) => item.tile === '3m');
    const eastWinds = items.filter((item) => item.tile === 'E');
    expect(threes).toHaveLength(2);
    expect(result.bars.get(threes[0]!.index)?.label).toBe('80.0%');
    expect(result.bars.get(threes[1]!.index)?.label).toBeNull();
    expect(result.bars.get(threes[1]!.index)?.height).toBe(result.bars.get(threes[0]!.index)?.height);
    expect(result.bars.get(eastWinds[0]!.index)?.label).toBe('20.0%');
    expect(result.bars.get(eastWinds[1]!.index)?.label).toBeNull();
  });

  it('同じ牌が手牌とツモ牌にあるときも、左（手牌）の 1 枚だけ', () => {
    const items = itemsOf(['1m', '2m', '3m', '4p', '5p', '6p', '7s', '8s', '9s', 'E', 'E', 'S', 'W'], 'E');
    const result = handBars(items, entryOf([['E', 1]], 'E'), null);
    const east = items.filter((item) => item.tile === 'E');
    expect(east).toHaveLength(3);
    expect(result.bars.get(east[0]!.index)?.label).toBe('100.0%');
    expect(result.bars.get(east[1]!.index)?.label).toBeNull();
    expect(result.bars.get(east[2]!.index)?.label).toBeNull();
    expect(east[2]!.draw).toBe(true);
  });

  it('赤五と普通の五は、別の候補（右の欄の一覧と同じ牌の合わせ方）。それぞれの確率と、それぞれの数字', () => {
    const items = itemsOf(['2m', '3m', '4m', '5p', '5pr', '6p', '7s', '8s', '9s', 'E', 'E', 'S', 'W'], 'N');
    const result = handBars(items, entryOf([['5p', 0.7], ['5pr', 0.25], ['N', 0.05]], '5pr'), null);
    const plain = result.bars.get(items.find((item) => item.tile === '5p')!.index);
    const red = result.bars.get(items.find((item) => item.tile === '5pr')!.index);
    expect(plain).toMatchObject({ probability: 0.7, label: '70.0%', height: 28 });
    expect(red).toMatchObject({ probability: 0.25, label: '25.0%', height: 10 });
  });

  it('AI の 1 位（結果 JSON の先頭の打牌）の牌は top。同じ牌が何枚あっても、どれも top', () => {
    const items = itemsOf(hand);
    const result = handBars(items, entryOf([['3m', 0.55], ['E', 0.4], ['S', 0.05]], 'E'), null);
    const tops = [...result.bars.entries()].filter(([, bar]) => bar.top).map(([index]) => items[index]!.tile);
    expect(tops).toEqual(['3m', '3m']);
  });

  it('AI の 1 位が打牌でないとき（九種九牌など）は、どの牌も top ではない', () => {
    const items = itemsOf(hand);
    const entry = entryOf([['3m', 0.2], ['E', 0.1]], '3m');
    const withRyukyoku: Pick<ReportEntry, 'details' | 'actual'> = {
      ...entry,
      details: [{ action: { type: 'ryukyoku', actor: 0, reason: 'kyushu_kyuhai' } as never, q_value: 20, prob: 0.7 }, ...entry.details],
    };
    const result = handBars(items, withRyukyoku, null);
    expect([...result.bars.values()].some((bar) => bar.top)).toBe(false);
  });

  it('読み上げの文: 確率の高い順に「打5p 97.7%」。赤五は「打赤5p」、字牌は漢字', () => {
    const items = itemsOf(['2m', '3m', '4m', '5p', '5pr', '6p', '7s', '8s', '9s', 'E', 'E', 'S', 'W'], 'N');
    const result = handBars(items, entryOf([['5p', 0.9772], ['5pr', 0.02], ['E', 0.0027], ['N', 0.0001]], '5p'), null);
    expect(result.spoken).toEqual(['打5p 97.7%', '打赤5p 2.0%', '打東 0.3%', '打北 <0.1%']);
  });
});
