import { answerOptions, choiceProbability, findDecisionByKey, type Decision, type QuizChoice } from '@jantama/engine';
import { describe, expect, it } from 'vitest';

import { gameOf } from '../../../tests/fake-study';
import { buildReveal, followOf, formatProbability } from './reveal';

const fx4 = gameOf('fx4');
const fx1a = gameOf('fx1a');
const fx1e = gameOf('fx1e');

function decisionOf(game: typeof fx4, key: string): Decision {
  const decision = findDecisionByKey(game, key);
  if (decision === undefined) throw new Error(`判断が無い: ${key}`);
  return decision;
}

const dahai = (tile: string): QuizChoice => ({ type: 'dahai', tile: tile as never });

describe('F6 確率の書き方', () => {
  it('97.72%・0.01% 未満は <0.01%', () => {
    expect(formatProbability(0.9772)).toBe('97.72%');
    expect(formatProbability(0.0228)).toBe('2.28%');
    expect(formatProbability(0.0001)).toBe('0.01%');
    expect(formatProbability(0.00005)).toBe('<0.01%');
    expect(formatProbability(0)).toBe('<0.01%');
  });
});

describe('U-3 答え合わせの内容（打牌の判断）', () => {
  // f9da: 東4局 13巡目。実戦は打3m、AI の 1 位は打7s、自分の答えは打1s（ツモ牌）
  const decision = decisionOf(fx1a, 'k3h0e15');
  const model = buildReveal(decision, dahai('1s'));

  it('AI の評価: 確率の高い順の上位 4 つと、自分の答え・実戦の行動。印は自分・実戦・AI', () => {
    const tags = model.bars.map((bar) => bar.tags.join('・'));
    expect(model.bars.length).toBeGreaterThanOrEqual(4);
    expect(model.bars.length).toBeLessThanOrEqual(6);
    expect(model.bars[0]?.tile).toBe('7s');
    expect(model.bars[0]?.tags).toEqual(['AI']);
    expect(model.bars[0]?.kind).toBe('top');
    const mine = model.bars.find((bar) => bar.tile === '1s');
    expect(mine?.tags).toEqual(['自分']);
    expect(mine?.kind).toBe('you');
    const actual = model.bars.find((bar) => bar.tile === '3m');
    expect(actual?.tags).toEqual(['実戦']);
    expect(actual?.kind).toBe('act');
    expect(tags.filter((tag) => tag !== '')).toEqual(expect.arrayContaining(['AI', '自分', '実戦']));
    // 確率は高い順（自分と実戦の追加分を除く先頭 4 つ）
    const head = model.bars.slice(0, 4).map((bar) => bar.probability);
    expect([...head].sort((a, b) => b - a)).toEqual(head);
  });

  it('自分の答えの確率と、正解か（既定の基準 5%）。AI の確率の和は 1', () => {
    expect(model.probability).toBe(choiceProbability(decision, dahai('1s')));
    expect(model.correct).toBe(model.probability >= 0.05);
    const ai = buildReveal(decision, dahai('7s'));
    expect(ai.correct).toBe(true);
    expect(ai.probability).toBeGreaterThan(0.9);
    // 基準を変えると、正解の判定が変わる
    expect(buildReveal(decision, dahai('1s'), 0.0001).correct).toBe(model.probability >= 0.0001);
  });

  it('切れない牌を選んでも（候補に無い）、確率 0 の棒として自分の答えを出す', () => {
    const odd = buildReveal(decision, dahai('9p'));
    expect(odd.probability).toBe(0);
    expect(odd.correct).toBe(false);
    expect(odd.bars.find((bar) => bar.tile === '9p')?.tags).toEqual(['自分']);
  });

  it('受け入れ枚数の行: 自分・実戦・AI・最大。同じ打牌は 1 行にまとめ、手牌だけの枚数と残りを持つ', () => {
    const box = model.ukeire;
    expect(box).not.toBeNull();
    if (box === null) return;
    const tagsOf = (tile: string) => box.rows.find((row) => row.tile === tile)?.tags;
    expect(tagsOf('1s')).toEqual(expect.arrayContaining(['自分']));
    expect(tagsOf('3m')).toEqual(expect.arrayContaining(['実戦']));
    expect(tagsOf('7s')).toEqual(expect.arrayContaining(['AI']));
    // 同じ打牌の行は 1 つ（牌ごとに高々 1 行）
    expect(new Set(box.rows.map((row) => row.tile)).size).toBe(box.rows.length);
    for (const row of box.rows) {
      expect(row.detail.remaining).toBeLessThanOrEqual(row.detail.ukeire);
      expect(row.detail.accepted.reduce((sum, a) => sum + a.count, 0)).toBe(row.detail.ukeire);
      expect(row.detail.accepted.reduce((sum, a) => sum + a.remaining, 0)).toBe(row.detail.remaining);
    }
    // 棒の長さの基準は、行の中の最大
    expect(box.maxCount).toBe(Math.max(...box.rows.map((row) => row.detail.ukeire)));
    // 実戦の 3m は 2 向聴になる打牌（枚数で比べられない）
    expect(box.rows.find((row) => row.tile === '3m')?.worse).toBe(true);
    expect(box.anyWorse).toBe(true);
    expect(box.minShanten).toBe(1);
    // 天鳳牌理のリンク（ツモ牌を含む 14 枚）
    expect(box.pairiUrl).toBe('https://tenhou.net/2/?q=33444m34678p1577s');
    expect(box.tiles).toHaveLength(14);
  });

  it('一言: 自分の打牌と AI の打牌の、向聴数と受け入れ枚数の比べ方', () => {
    expect(model.ukeire?.takeaway).toBe('AIの打牌のほうが受け入れが少ない → 形の質・打点・守備のどれかで差がついた');
    expect(buildReveal(decision, dahai('7s')).ukeire?.takeaway).toBe('AIと同じ打牌です');
    expect(buildReveal(decision, dahai('3m')).ukeire?.takeaway).toBe(
      '自分の打牌は2向聴、AIの打牌は1向聴 → 向聴数で差がついた',
    );
  });
});

describe('E-23 2向聴からの先（画面が出す値）', () => {
  it('f9da 東4局13巡目 打3m: 48枚・14種類・平均 19.3・最大 33', () => {
    const decision = decisionOf(fx1a, 'k3h0e15');
    const box = buildReveal(decision, dahai('3m')).ukeire;
    expect(box).not.toBeNull();
    const follow = followOf(box?.tiles ?? [], '3m');
    expect(follow?.total).toBe(48);
    expect(follow?.kinds).toBe(14);
    expect(follow?.average.toFixed(1)).toBe('19.3');
    expect(follow?.max).toBe(33);
  });

  it('FX-4 東2局1本場8巡目 打6m: 50枚・15種類・平均 12.9・最大 43', () => {
    const decision = decisionOf(fx4, 'k1h1e9');
    const box = buildReveal(decision, dahai('6m')).ukeire;
    const follow = followOf(box?.tiles ?? [], '6m');
    expect(follow?.total).toBe(50);
    expect(follow?.kinds).toBe(15);
    expect(follow?.average.toFixed(1)).toBe('12.9');
    expect(follow?.max).toBe(43);
  });

  it('切ったあとが 2 向聴でない打牌は、先を数えない（null）。手牌に無い牌も null', () => {
    const decision = decisionOf(fx1a, 'k3h0e15');
    const box = buildReveal(decision, dahai('7s')).ukeire;
    expect(followOf(box?.tiles ?? [], '7s')).toBeNull();
    expect(followOf(box?.tiles ?? [], '9p')).toBeNull();
  });
});

describe('U-3 答え合わせの内容（打牌以外の判断）', () => {
  it('鳴きの判断: 答えのボタンごとの棒。受け入れ枚数・牌理は出さない', () => {
    // 東2局1本場 8巡目: 対面の東をポンするか、スルーするか
    const call = fx4.decisions.find((d) => d.kind === 'call' && d.kyokuLabel === '東2局1本場' && d.junme === 8);
    if (call === undefined) throw new Error('鳴きの判断が無い');
    const options = answerOptions(call);
    expect(options.map((option) => option.label)).toEqual(['ポン', 'スルー']);
    const model = buildReveal(call, { type: 'option', id: 'pon' });
    expect(model.ukeire).toBeNull();
    expect(model.actualTile).toBeNull();
    expect(model.bars.every((bar) => bar.tile === null && bar.option !== null)).toBe(true);
    expect(model.bars.map((bar) => bar.option?.id).sort()).toEqual(['pass', 'pon']);
    const mine = model.bars.find((bar) => bar.option?.id === 'pon');
    expect(mine?.tags).toContain('自分');
    expect(model.probability).toBeCloseTo(mine?.probability ?? -1, 10);
  });

  it('リーチの判断: リーチ・しない', () => {
    const riichi = decisionOf(fx1e, 'k2h4e5');
    expect(riichi.kind).toBe('riichi');
    const model = buildReveal(riichi, { type: 'option', id: 'pass' });
    expect(model.bars.map((bar) => bar.option?.label)).toEqual(expect.arrayContaining(['リーチ', 'しない']));
    expect(model.ukeire).toBeNull();
  });
});
