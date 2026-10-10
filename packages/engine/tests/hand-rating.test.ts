import { describe, expect, it } from 'vitest';

import { GRADES } from '../src/grade';
import { summarizeHanchan } from '../src/hanchan-summary';
import { FLAG_BAND_GAP, disagreesWithGrade, gradeBand, markBand } from '../src/hand-rating';
import type { HandMark } from '../src/outcome';
import { parseReportText } from '../src/report';
import { FX4_ID, loadReportText } from './helpers/fixtures';

const MARKS: HandMark[] = ['good', 'fair', 'bad'];

describe('F10 自己評価と AI 基準の食い違い（暫定の規則）', () => {
  it('段階は、S+〜A- が〇の帯、B+〜B- が△の帯、C+〜E が✕の帯', () => {
    const bands: Record<string, number> = {};
    for (const grade of GRADES) bands[grade] = gradeBand(grade);
    expect(bands).toEqual({
      'S+': 0,
      S: 0,
      'S-': 0,
      'A+': 0,
      A: 0,
      'A-': 0,
      'B+': 1,
      B: 1,
      'B-': 1,
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

  it('印が付くのは、帯が 2 つ離れたとき: ✕と付けて S・A の帯、または〇と付けて C 以下の帯', () => {
    expect(FLAG_BAND_GAP).toBe(2);
    for (const grade of ['S+', 'S', 'S-', 'A+', 'A', 'A-'] as const) {
      expect(disagreesWithGrade('bad', grade), `✕ と ${grade}`).toBe(true);
      expect(disagreesWithGrade('good', grade), `〇 と ${grade}`).toBe(false);
    }
    for (const grade of ['C+', 'C', 'C-', 'D', 'E'] as const) {
      expect(disagreesWithGrade('good', grade), `〇 と ${grade}`).toBe(true);
      expect(disagreesWithGrade('bad', grade), `✕ と ${grade}`).toBe(false);
    }
  });

  it('△は、どの段階とも印が付かない（帯の差が 1 以内）', () => {
    for (const grade of GRADES) expect(disagreesWithGrade('fair', grade), grade).toBe(false);
  });

  it('B の帯は、〇とも✕とも印が付かない', () => {
    for (const grade of ['B+', 'B', 'B-'] as const) {
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
