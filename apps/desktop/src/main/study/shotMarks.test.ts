/**
 * 迷いのスクショの欄（U-45）の、どの迷いを出すか・前後の手・読み上げの文。
 */
import { findDecisionByKey, listDecisionRefs, type DecisionRef } from '@jantama/engine';
import { describe, expect, it } from 'vitest';

import { fx4Ocr, fx4Session } from '../../../tests/import-fixtures';
import { gameOf } from '../../../tests/fake-study';
import type { Links } from '../../api/types';
import { resolveMarks } from '../markCards';
import { marksOfDecision, neighbourDecisions, relinkedText } from './shotMarks';

const game = gameOf('fx4');
const refs = listDecisionRefs(game.report);

function resolvedWith(links: Links) {
  return resolveMarks(game.report, fx4Session('s', 0, { report_path: 'r.json', ocr: fx4Ocr(), links }));
}

describe('この判断に結びついている迷い', () => {
  it('推定の結びつけ: 迷い 3 は東2局1本場 6巡目（k1h1e7）。迷いの番号の順', () => {
    const resolved = resolvedWith({ ratings: {}, marks: {} });
    expect(marksOfDecision(resolved, 'k1h1e7').map((item) => item.number)).toEqual([3]);
    expect(marksOfDecision(resolved, 'k0h0e0')).toEqual([]);
  });

  it('同じ判断に 2 つの迷いを選んだら、2 つとも（番号の順）。選んだものは saved', () => {
    const resolved = resolvedWith({ ratings: {}, marks: { '5': 'k1h1e7', '2': 'k1h1e7' } });
    const here = marksOfDecision(resolved, 'k1h1e7');
    expect(here.map((item) => item.number)).toEqual([2, 3, 5]);
    expect(here.filter((item) => item.resolution.kind === 'linked' && item.resolution.saved).map((item) => item.number)).toEqual([2, 5]);
  });

  it('判断が決まっていない迷い（手で選ぶ）は、どの判断にも出ない', () => {
    const resolved = resolvedWith({ ratings: {}, marks: { '3': 'manual' } });
    expect(marksOfDecision(resolved, 'k1h1e7').map((item) => item.number)).not.toContain(3);
  });
});

describe('前・次の手（自分の判断を半荘の順に並べた、前と次）', () => {
  it('真ん中の判断は、前と次がある。半荘の順（listDecisionRefs）のとおり', () => {
    const at = refs.findIndex((ref) => ref.key === 'k1h1e7');
    const { prev, next } = neighbourDecisions(refs, 'k1h1e7');
    expect(prev?.key).toBe(refs[at - 1]?.key);
    expect(next?.key).toBe(refs[at + 1]?.key);
    expect(prev).not.toBeNull();
    expect(next).not.toBeNull();
  });

  it('最初の判断は前が無く、最後の判断は次が無い', () => {
    expect(neighbourDecisions(refs, refs[0]!.key)).toEqual({ prev: null, next: refs[1] });
    expect(neighbourDecisions(refs, refs.at(-1)!.key)).toEqual({ prev: refs.at(-2), next: null });
  });

  it('一覧に無い鍵は、前も次も無い', () => {
    expect(neighbourDecisions(refs, 'k9h9e9')).toEqual({ prev: null, next: null });
    expect(neighbourDecisions([], 'k1h1e7')).toEqual({ prev: null, next: null });
  });

  it('前・次は、局をまたぐ（局の最初の判断の前は、前の局の最後の判断）', () => {
    const firstOfSecondKyoku = refs.find((ref) => ref.kyokuPosition === 1) as DecisionRef;
    const { prev } = neighbourDecisions(refs, firstOfSecondKyoku.key);
    expect(prev?.kyokuPosition).toBe(0);
    expect(findDecisionByKey(game, firstOfSecondKyoku.key)).toBeDefined();
  });
});

describe('付け替えたあとの読み上げの文', () => {
  it('「迷いNを局・巡目・判断の種類に付け替えました」', () => {
    const ref = refs.find((item) => item.key === 'k1h1e10') as DecisionRef;
    expect(relinkedText(3, ref)).toBe(`迷い3を${ref.label}に付け替えました`);
    expect(relinkedText(3, ref)).toMatch(/^迷い3を東2局1本場 \d+巡目 · .+の迷いに付け替えました$/);
  });
});
