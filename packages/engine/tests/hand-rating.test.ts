import { describe, expect, it } from 'vitest';

import { GRADES } from '../src/grade';
import { summarizeHanchan } from '../src/hanchan-summary';
import { FLAG_BAND_GAP, agreesWithGrade, disagreesWithGrade, gradeBand, markBand, markOffsetFromGrade } from '../src/hand-rating';
import type { HandMark } from '../src/outcome';
import { parseReportText } from '../src/report';
import { FX4_ID, loadReportText } from './helpers/fixtures';

const MARKS: HandMark[] = ['good', 'fair', 'bad'];

describe('F10 自己評価と AI 基準の食い違い（R13-3 の帯）', () => {
  it('段階は、S+〜S- が〇の帯、A+〜A- が△の帯、B+〜E が✕の帯（R13-3）', () => {
    const bands: Record<string, number> = {};
    for (const grade of GRADES) bands[grade] = gradeBand(grade);
    expect(bands).toEqual({
      'S+': 0,
      S: 0,
      'S-': 0,
      'A+': 1,
      A: 1,
      'A-': 1,
      'B+': 2,
      B: 2,
      'B-': 2,
      'C+': 2,
      C: 2,
      'C-': 2,
      D: 2,
      E: 2,
    });
  });

  it('自己評価は 〇=0・△=1・✕=2', () => {
    expect(MARKS.map(markBand)).toEqual([0, 1, 2]);
  });

  it('印が付くのは、帯が 2 つ離れたとき: ✕と付けて S の帯、または〇と付けて B 以下の帯', () => {
    expect(FLAG_BAND_GAP).toBe(2);
    for (const grade of ['S+', 'S', 'S-'] as const) {
      expect(disagreesWithGrade('bad', grade), `✕ と ${grade}`).toBe(true);
      expect(disagreesWithGrade('good', grade), `〇 と ${grade}`).toBe(false);
    }
    for (const grade of ['B+', 'B', 'B-', 'C+', 'C', 'C-', 'D', 'E'] as const) {
      expect(disagreesWithGrade('good', grade), `〇 と ${grade}`).toBe(true);
      expect(disagreesWithGrade('bad', grade), `✕ と ${grade}`).toBe(false);
    }
  });

  it('△は、どの段階とも印が付かない（帯の差が 1 以内）', () => {
    for (const grade of GRADES) expect(disagreesWithGrade('fair', grade), grade).toBe(false);
  });

  it('A の帯は、〇とも✕とも印が付かない（12回目の補足「Aが×は納得」）', () => {
    for (const grade of ['A+', 'A', 'A-'] as const) {
      expect(disagreesWithGrade('good', grade), grade).toBe(false);
      expect(disagreesWithGrade('bad', grade), grade).toBe(false);
    }
  });

  it('自己評価が無い・段階が無い局は、比べられないので印を付けない', () => {
    expect(disagreesWithGrade(null, 'S+')).toBe(false);
    expect(disagreesWithGrade('bad', null)).toBe(false);
    expect(disagreesWithGrade(null, null)).toBe(false);
  });

  it('FX-4: 評価を局の順に 〇・△・✕・…（△・✕・△・✕・✕）と置くと、東2局・東3局・東3局1本場に印が付く', () => {
    const parsed = parseReportText(loadReportText(FX4_ID));
    if (!parsed.ok) throw new Error(parsed.error.message);
    const kyokus = summarizeHanchan(parsed.value).kyokus;
    const placed: HandMark[] = ['fair', 'bad', 'fair', 'bad', 'bad'];
    const flagged = kyokus.filter((k, i) => disagreesWithGrade(placed[i] ?? null, k.grade)).map((k) => k.label);
    expect(flagged).toEqual(['東2局', '東3局', '東3局1本場']);
    // 局ごとの段階（既定の当てはめ）。
    expect(kyokus.map((k) => k.grade)).toEqual(['S+', 'S-', 'A', 'S', 'S-']);
  });
});

describe('U-30 週の集計の「一致」と「ずれ」は、同じ帯の規則から決まる（別の規則を作らない）', () => {
  it('ずれは、自分の評価（〇3・△2・✕1）から AI 基準の帯の評価を引いた値。AI より低く付けると負', () => {
    expect(markOffsetFromGrade('bad', 'S')).toBe(-2);
    expect(markOffsetFromGrade('bad', 'A')).toBe(-1);
    expect(markOffsetFromGrade('fair', 'S-')).toBe(-1);
    expect(markOffsetFromGrade('good', 'S-')).toBe(0);
    expect(markOffsetFromGrade('fair', 'A-')).toBe(0);
    expect(markOffsetFromGrade('bad', 'B+')).toBe(0);
    expect(markOffsetFromGrade('good', 'A+')).toBe(1);
    expect(markOffsetFromGrade('good', 'B')).toBe(2);
    expect(markOffsetFromGrade('fair', 'C')).toBe(1);
  });

  it('自己評価か段階が無い局は、比べない（ずれも一致も null）', () => {
    expect(markOffsetFromGrade(null, 'S')).toBeNull();
    expect(markOffsetFromGrade('good', null)).toBeNull();
    expect(agreesWithGrade(null, 'S')).toBeNull();
    expect(agreesWithGrade('good', null)).toBeNull();
  });

  it('すべての組み合わせで: 一致 = ずれが 0 = 同じ帯。印（disagreesWithGrade）= ずれの大きさが帯の差の基準以上', () => {
    for (const mark of MARKS) {
      for (const grade of GRADES) {
        const offset = markOffsetFromGrade(mark, grade) as number;
        expect(offset, `${mark} ${grade}`).toBe(gradeBand(grade) - markBand(mark));
        expect(agreesWithGrade(mark, grade), `${mark} ${grade}`).toBe(markBand(mark) === gradeBand(grade));
        expect(disagreesWithGrade(mark, grade), `${mark} ${grade}`).toBe(Math.abs(offset) >= FLAG_BAND_GAP);
        expect(Math.abs(offset)).toBeLessThanOrEqual(2);
      }
    }
  });
});
