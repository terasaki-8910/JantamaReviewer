import { describe, expect, it } from 'vitest';

import { findDecisionRef, listDecisionRefs } from '../src/decision-ref';
import { type MarkLink, isFarFromReading, linkMarks } from '../src/mark-link';
import { parseReportText } from '../src/report';
import type { MortalReport } from '../src/report-types';
import { FX4_ID, loadFx4Ocr, loadReportText } from './helpers/fixtures';

function load(id: string): MortalReport {
  const r = parseReportText(loadReportText(id));
  if (!r.ok) throw new Error(r.error.message);
  return r.value;
}

/** ユーザーが本物のアプリで選び直した、FX-4 の迷い 1〜5 の結びつけ（E-17 の正解）。 */
const USER_CHOICES = ['k0h0e4', 'k1h0e12', 'k1h1e7', 'k1h1e10', 'k2h1e6'] as const;
/** 迷い 6 は、ユーザーが 東3局1本場 11巡目の打3m（残り29枚）に結びつけた（スクショの 東3局・残り38・4400 から離れている）。 */
const MARK6_CHOICE = 'k2h1e14';

describe('E-27 離れている（ユーザーが選んだ判断が、推定にもほかの候補にも入らない）', () => {
  const report = load(FX4_ID);
  const marks = loadFx4Ocr().map((m) => ({ lines: m.lines, retries: m.retries?.map((r) => r.lines) }));
  const links = linkMarks(report, marks);
  const link = (n: number): MarkLink => {
    const found = links[n - 1];
    if (!found) throw new Error(`迷い${n} が無い`);
    return found;
  };

  it('E-27 FX-4 の迷い 6: 東3局1本場 11巡目 打3m（残り29枚）を選ぶと、読み取り（東3局・残り38・4400点）から離れている', () => {
    expect(findDecisionRef(report, MARK6_CHOICE)).toMatchObject({
      label: '東3局1本場 11巡目 · 打牌の迷い',
      actionLabel: '打3m',
      tilesLeft: 29,
    });
    expect(link(6).center).toEqual({ wind: 'E', number: 3, tilesLeft: 38, score: 4400 });
    // 推定は 9巡目の打北、ほかの候補は 8巡目の鳴かない判断。選んだ判断は、どちらでもない。
    expect(link(6).estimate?.key).toBe('k2h1e10');
    expect(link(6).alternatives.map((c) => c.key)).toEqual(['k2h1e9']);
    expect(isFarFromReading(link(6), MARK6_CHOICE)).toBe(true);
  });

  it('E-27 FX-4 の迷い 1〜5 を、ユーザーが選んだ判断（E-17）にしても、離れていない', () => {
    USER_CHOICES.forEach((key, i) => {
      expect(isFarFromReading(link(i + 1), key), `迷い${i + 1} ${key}`).toBe(false);
    });
  });

  it('E-27 推定そのものと、ほかの候補を選んでも、離れていない（迷い 2 の 3 つ、迷い 6 の 2 つ）', () => {
    for (const l of links) {
      for (const candidate of [l.estimate, ...l.alternatives]) {
        if (candidate === null) continue;
        expect(isFarFromReading(l, candidate.key), `迷い${l.index + 1} ${candidate.key}`).toBe(false);
      }
    }
    expect([link(2).estimate, ...link(2).alternatives].map((c) => c?.key)).toEqual(['k1h0e12', 'k1h0e14', 'k1h0e13']);
    expect([link(6).estimate, ...link(6).alternatives].map((c) => c?.key)).toEqual(['k2h1e10', 'k2h1e9']);
  });

  it('E-27 半荘の全判断（70）のうち、推定にもほかの候補にも入らないものだけが、離れている', () => {
    const refs = listDecisionRefs(report);
    expect(refs).toHaveLength(70);
    let far = 0;
    for (const l of links) {
      const near = new Set([l.estimate, ...l.alternatives].flatMap((c) => (c === null ? [] : [c.key])));
      for (const ref of refs) {
        const expected = l.status === 'estimated' && !near.has(ref.key);
        expect(isFarFromReading(l, ref.key), `迷い${l.index + 1} ${ref.key}`).toBe(expected);
        if (expected) far += 1;
      }
    }
    // 読めた 6 つのどれも、候補は 1〜3 つなので、離れている判断は、半荘の判断の数から候補を引いた数。
    const candidates = links.reduce((sum, l) => sum + (l.estimate === null ? 0 : 1 + l.alternatives.length), 0);
    expect(far).toBe(6 * 70 - candidates);
  });

  it('E-27 別の局の判断を選んでも、離れている（局が違えば、推定にもほかの候補にも入らない）', () => {
    // 迷い 1（東1局・残り59）に、東3局1本場の判断を選ぶ。
    expect(isFarFromReading(link(1), 'k2h1e6')).toBe(true);
    expect(isFarFromReading(link(1), 'k0h0e4')).toBe(false);
  });

  it('E-27 読めない迷い（読み取りが無い）は、どの判断を選んでも、離れていない', () => {
    const [unreadable] = linkMarks(report, [{ lines: loadFx4Ocr()[5]?.lines }]);
    expect(unreadable?.status).toBe('manual');
    expect(unreadable?.reason).toBe('unreadable');
    for (const ref of listDecisionRefs(report)) {
      expect(isFarFromReading(unreadable as MarkLink, ref.key), ref.key).toBe(false);
    }
    expect(isFarFromReading(unreadable as MarkLink, MARK6_CHOICE)).toBe(false);
  });

  it('E-27 読めても、合う局が無い・その局に判断が無い迷い（推定が無いもの）は、離れていない', () => {
    const [noKyoku] = linkMarks(report, [{ center: { wind: 'S', number: 2, tilesLeft: 40, score: 25000 } }]);
    expect(noKyoku?.reason).toBe('no-kyoku');
    expect(isFarFromReading(noKyoku as MarkLink, MARK6_CHOICE)).toBe(false);

    const empty = structuredClone(report);
    const kyoku = empty.review.kyokus[0];
    if (!kyoku) throw new Error('東1局が無い');
    kyoku.entries = [];
    const [noDecision] = linkMarks(empty, [{ center: { wind: 'E', number: 1, tilesLeft: 59, score: 25000 } }]);
    expect(noDecision?.reason).toBe('no-decision');
    expect(isFarFromReading(noDecision as MarkLink, MARK6_CHOICE)).toBe(false);
  });

  it('E-27 選んだ値が判断の鍵でない（手で選ぶ・空・壊れた値）ときは、判断を選んでいないので、離れていない', () => {
    for (const value of ['manual', '', 'garbage', 'k2h1', 'k2h1e', 'K2H1E14']) {
      expect(isFarFromReading(link(6), value), value).toBe(false);
    }
  });
});
