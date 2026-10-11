import { describe, expect, it } from 'vitest';

import type { Decision } from '../src/decision';
import { actualProbability } from '../src/disagreement';
import { type ImportedGame, importReportText } from '../src/import';
import { findDecisionByKey } from '../src/problems';
import {
  actualChoice,
  actualText,
  answerOptions,
  choiceProbability,
  choiceText,
  discardCandidates,
  discardProbability,
  sameChoice,
  topChoice,
} from '../src/quiz-choice';
import { FX1_IDS, FX4_ID, loadReportText } from './helpers/fixtures';

function load(id: string): ImportedGame {
  const r = importReportText(loadReportText(id));
  if (!r.ok) throw new Error(`${id}: ${r.error.message}`);
  return r.value;
}

const fx4 = load(FX4_ID);
const all = [...FX1_IDS, FX4_ID].map(load);
const decisions: Decision[] = all.flatMap((g) => g.decisions);

describe('U-16 出題の答え: 打牌以外は雀魂と同じ並びのボタンで答え、どの答えも AI の候補の確率に当たる', () => {
  it('U-16 FX-4 の東2局1本場 8巡目の「東をポン」の判断: ポン → スルー の順（AI の順ではなく、雀魂の並び）', () => {
    const d = findDecisionByKey(fx4, 'k1h1e10');
    expect(d?.kind).toBe('call');
    if (!d) return;
    const options = answerOptions(d);
    expect(options.map((o) => o.id)).toEqual(['pon', 'pass']);
    expect(options.map((o) => o.label)).toEqual(['ポン', 'スルー']);
    expect(options[0]?.text).toBe('東をポン');
    expect(options[0]?.called).toBe('E');
    expect(options[0]?.use).toEqual(['E', 'E']);
    expect(actualChoice(d)).toEqual({ type: 'option', id: 'pon' });
    expect(actualText(d)).toBe('東をポン');
    // 答えが指す確率は、結果 JSON の実戦の行動の確率と同じ（ポン）。スルーは「何もしない」の候補の確率
    expect(choiceProbability(d, actualChoice(d))).toBeCloseTo(actualProbability(d.entry), 12);
    const none = d.entry.details.find((x) => x.action.type === 'none');
    expect(choiceProbability(d, { type: 'option', id: 'pass' })).toBeCloseTo(none?.prob ?? NaN, 12);
  });

  it('U-16 打牌の判断: 切る牌の確率が答えの確率。実戦の牌は、実戦の行動の確率と同じ', () => {
    const d = findDecisionByKey(fx4, 'k1h1e9');
    expect(d?.kind).toBe('discard');
    if (!d) return;
    expect(actualChoice(d)).toEqual({ type: 'dahai', tile: '4p' });
    expect(actualText(d)).toBe('打4p');
    expect(choiceProbability(d, actualChoice(d))).toBeCloseTo(actualProbability(d.entry), 12);
    const candidates = discardCandidates(d.entry);
    expect(candidates.length).toBeGreaterThan(5);
    // AI の 1 位の打牌は、候補の先頭
    const top = topChoice(d);
    expect(top).toEqual({ type: 'dahai', tile: candidates[0]?.tile });
    expect(choiceProbability(d, top ?? { type: 'dahai', tile: '' })).toBeCloseTo(candidates[0]?.probability ?? NaN, 12);
    // 手牌に無い牌（候補に無い牌）は 0
    expect(discardProbability(d.entry, 'C')).toBe(0);
  });

  it('U-16 赤五と普通の五は、同じ牌の答えとして扱う（候補が普通の五だけでも、赤五を選んだ答えが当たる）', () => {
    const base = fx4.decisions.find((d) => d.kind === 'discard');
    if (!base) throw new Error('打牌の判断がありません');
    const entry = {
      details: [
        { action: { type: 'dahai' as const, actor: 0 as const, pai: '5p', tsumogiri: false }, q_value: 1, prob: 0.7 },
        { action: { type: 'dahai' as const, actor: 0 as const, pai: '9s', tsumogiri: false }, q_value: 0, prob: 0.3 },
      ],
    };
    expect(discardProbability(entry, '5pr')).toBeCloseTo(0.7, 12);
    expect(discardProbability(entry, '5p')).toBeCloseTo(0.7, 12);
    expect(sameChoice({ type: 'dahai', tile: '5pr' }, { type: 'dahai', tile: '5p' })).toBe(true);
    expect(sameChoice({ type: 'dahai', tile: '5p' }, { type: 'dahai', tile: '9s' })).toBe(false);
    expect(sameChoice({ type: 'option', id: 'pon' }, { type: 'option', id: 'pon' })).toBe(true);
    expect(sameChoice({ type: 'option', id: 'pon' }, { type: 'dahai', tile: '5p' })).toBe(false);
  });

  it('U-16 同じ牌の打牌の候補（ツモ切りか手出しかの違い）は 1 つにまとめる', () => {
    const merged = discardCandidates({
      details: [
        { action: { type: 'dahai', actor: 0, pai: '3m', tsumogiri: true }, q_value: 1, prob: 0.4 },
        { action: { type: 'dahai', actor: 0, pai: '3m', tsumogiri: false }, q_value: 0.5, prob: 0.2 },
        { action: { type: 'dahai', actor: 0, pai: '4m', tsumogiri: false }, q_value: 0, prob: 0.1 },
      ],
    });
    expect(merged.map((c) => [c.tile, Math.round(c.probability * 10)])).toEqual([
      ['3m', 6],
      ['4m', 1],
    ]);
  });

  it('U-16 FX-1・FX-4 の全判断: 打牌以外の判断のボタンは、候補の確率を合計して 1 になり、実戦の行動と AI の 1 位がボタンの中にある', () => {
    const kinds = new Set<string>();
    let checked = 0;
    for (const d of decisions) {
      if (d.kind === 'discard') {
        const cands = discardCandidates(d.entry);
        const sum = cands.reduce((s, c) => s + c.probability, 0);
        // 打牌の候補だけの確率（九種九牌の候補が混じる判断は、1 に満たない）
        expect(sum).toBeLessThanOrEqual(1 + 1e-6);
        if (d.entry.actual.type === 'dahai') {
          const actual = actualChoice(d);
          expect(actual.type).toBe('dahai');
          expect(choiceProbability(d, actual), `${d.kyokuLabel} ${d.junme}巡目`).toBeCloseTo(actualProbability(d.entry), 9);
        }
        continue;
      }
      const options = answerOptions(d);
      kinds.add(d.kind);
      const where = `${d.kyokuLabel} ${d.junme}巡目 ${d.kind}`;
      expect(new Set(options.map((o) => o.id)).size, where).toBe(options.length);
      expect(options.at(-1)?.id, where).toBe('pass');
      expect(options.length, where).toBeGreaterThanOrEqual(2);
      const sum = options.reduce((s, o) => s + o.probability, 0);
      expect(sum, where).toBeCloseTo(1, 4);
      const actual = actualChoice(d);
      expect(actual.type).toBe('option');
      expect(options.some((o) => actual.type === 'option' && o.id === actual.id), where).toBe(true);
      // 実戦の行動の確率は、実戦の行動に当たるボタンの確率の一部（同じ行動はまとめるので、同じか大きい）
      expect(choiceProbability(d, actual) + 1e-9, where).toBeGreaterThanOrEqual(actualProbability(d.entry));
      const top = topChoice(d);
      expect(top?.type, where).toBe('option');
      // ボタンの並びは、チー → ポン → カン → リーチ → ツモ・ロン → パス
      const order = ['chi', 'pon', 'kan', 'reach', 'hora', 'pass'];
      const ranks = options.map((o) => order.indexOf(o.kind));
      expect(ranks, where).toEqual([...ranks].sort((a, b) => a - b));
      checked++;
    }
    expect(checked).toBeGreaterThan(250);
    expect(kinds).toEqual(new Set(['call', 'riichi', 'win', 'kan']));
  });

  it('U-16 リーチ・和了・カンの判断も、雀魂と同じ並びのボタンで答える（リーチ／しない、ツモ・ロン／スキップ、カン／しない）', () => {
    const by = (kind: Decision['kind']) => decisions.find((d) => d.kind === kind);
    const riichi = by('riichi');
    const win = by('win');
    const kan = by('kan');
    expect(riichi && answerOptions(riichi).map((o) => o.label)).toEqual(expect.arrayContaining(['リーチ', 'しない']));
    expect(win && answerOptions(win).map((o) => o.label).at(-1)).toBe('スキップ');
    expect(win && answerOptions(win).some((o) => o.label === 'ツモ' || o.label === 'ロン')).toBe(true);
    expect(kan && answerOptions(kan).map((o) => o.label)).toEqual(expect.arrayContaining(['カン', 'しない']));
    // 「しない」は、何もしない候補が無いので、ほかの候補（ふつうの打牌）の確率の合計。リーチ + しない = 1
    if (riichi) {
      const options = answerOptions(riichi);
      const reach = options.find((o) => o.kind === 'reach');
      const pass = options.find((o) => o.kind === 'pass');
      expect((reach?.probability ?? 0) + (pass?.probability ?? 0)).toBeCloseTo(1, 4);
      expect(choiceText(riichi, { type: 'option', id: 'pass' })).toBe('リーチしない');
    }
  });

  it('U-16 チーは、手牌から出す組み合わせごとに別のボタン（小さい組み合わせから）。見出し「6sをチー（4s 5s）」の形', () => {
    const chiCall = decisions.find((d) => d.kind === 'call' && answerOptions(d).filter((o) => o.kind === 'chi').length >= 2);
    expect(chiCall).toBeDefined();
    if (!chiCall) return;
    const chis = answerOptions(chiCall).filter((o) => o.kind === 'chi');
    expect(new Set(chis.map((o) => o.id)).size).toBe(chis.length);
    for (const o of chis) {
      expect(o.id).toMatch(/^chi:/);
      expect(o.use).toHaveLength(2);
      expect(o.text).toMatch(/^.+をチー（.+）$/);
      expect(o.called).toBe(chiCall.entry.tile);
    }
  });
});
