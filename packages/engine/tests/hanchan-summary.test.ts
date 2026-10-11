import { describe, expect, it } from 'vitest';

import { DEFAULT_GRADE_MODEL } from '../src/default-grade-model';
import { fitGradeModel, gradeIndexOf, predictGrade } from '../src/grade';
import { roomDispOf, roomLabel, roomLabelOf, summarizeHanchan } from '../src/hanchan-summary';
import { linkMarks } from '../src/mark-link';
import { summarizeKyokus } from '../src/outcome';
import { formatRating, gameRating, handRatings } from '../src/rating';
import { parseReportText } from '../src/report';
import type { MortalReport } from '../src/report-types';
import { FX1_IDS, FX1_DECISION_COUNTS, FX4_ID, loadFx4Ocr, loadReportText } from './helpers/fixtures';

function load(id: string): MortalReport {
  const r = parseReportText(loadReportText(id));
  if (!r.ok) throw new Error(r.error.message);
  return r.value;
}

describe('半荘のまとめ（FX-4）', () => {
  const report = load(FX4_ID);
  const marks = loadFx4Ocr().map((m) => ({ mark: m.mark, lines: m.lines }));
  const summary = summarizeHanchan(report, { marks });

  it('E-12 半荘全体の Rating は 93.0（mjai のサイトの値）', () => {
    expect(summary.ratingText).toBe('93.0');
    expect(summary.rating).toBeCloseTo(report.review.rating, 6);
    expect(summary.decisionCount).toBe(70);
    expect(summary.matchCount).toBe(62);
  });

  it('E-12 局ごとの Rating は 東1局 100.0・東2局 91.6・東2局1本場 86.5・東3局 94.6・東3局1本場 91.6', () => {
    expect(summary.kyokus.map((k) => k.label)).toEqual(['東1局', '東2局', '東2局1本場', '東3局', '東3局1本場']);
    expect(summary.kyokus.map((k) => k.ratingText)).toEqual(['100.0', '91.6', '86.5', '94.6', '91.6']);
    for (const k of summary.kyokus) expect(k.ratingText).toBe(formatRating(k.rating ?? NaN));
  });

  it('E-12 Rating の数値は gameRating・handRatings と同じ（局の順）', () => {
    expect(summary.rating).toBe(gameRating(report));
    expect(summary.kyokus.map((k) => k.rating)).toEqual(handRatings(report));
  });

  it('E-13 段階は、既定の当てはめで Rating（100 倍）から決まる。半荘全体は S-、局ごとは S+・S-・A・S・S-', () => {
    expect(summary.grade).toBe('S-');
    expect(summary.kyokus.map((k) => k.grade)).toEqual(['S+', 'S-', 'A', 'S', 'S-']);
    expect(summary.grade).toBe(predictGrade(DEFAULT_GRADE_MODEL, (summary.rating ?? NaN) * 100));
    for (const k of summary.kyokus) expect(k.grade).toBe(predictGrade(DEFAULT_GRADE_MODEL, (k.rating ?? NaN) * 100));
  });

  it('F10 局ごとの結果（自分の和了・放銃・他家のツモなど）と点の増減、局の始めの点数、判断の数', () => {
    expect(summary.kyokus.map((k) => [k.outcome.kind, k.outcome.delta])).toEqual([
      ['othersTsumo', -6000],
      ['othersTsumo', -3900],
      ['win', 1300],
      ['dealIn', -12000],
      ['dealIn', -8300],
    ]);
    expect(summary.kyokus.map((k) => k.startScore)).toEqual([25000, 19000, 15100, 16400, 4400]);
    expect(summary.kyokus.map((k) => k.decisionCount)).toEqual([18, 17, 13, 5, 17]);
  });

  it('F10 summarizeKyokus（E-6）の項目はそのまま入っている（暫定の〇△✕・5%未満の数）', () => {
    const base = summarizeKyokus(report);
    summary.kyokus.forEach((row, i) => expect(row).toMatchObject(base[i] ?? {}));
    expect(summary.kyokus.map((k) => k.provisionalMark)).toEqual(['good', 'fair', 'bad', 'good', 'bad']);
  });

  it('F1 卓は 玉の間・南（結果の「玉の間南喰赤」から）', () => {
    expect(summary.room).toBe('玉の間・南');
    expect(summary.roomDisp).toBe('玉の間南喰赤');
  });

  it('E-17 迷いマークの結びつけが、渡した順に付く（linkMarks と同じ）。読めた5枚は、1位が推定（ユーザーが選び直した判断）、読めない1枚は手で選ぶ', () => {
    expect(summary.marks.map((m) => m.status)).toEqual(['estimated', 'estimated', 'estimated', 'estimated', 'estimated', 'manual']);
    expect(summary.marks.map((m) => m.estimate?.key ?? null)).toEqual(['k0h0e4', 'k1h0e12', 'k1h1e7', 'k1h1e10', 'k2h1e6', null]);
    expect(summary.marks.map((m) => m.alternatives.map((c) => c.key))).toEqual([
      [],
      ['k1h0e14', 'k1h0e13'],
      [],
      ['k1h1e11'],
      ['k2h1e7'],
      [],
    ]);
    expect(summary.marks).toEqual(linkMarks(report, marks));
    expect(summary.marks[0]?.mark).toBe(marks[0]);
  });

  it('迷いマークを渡さなければ、結びつけは空', () => {
    expect(summarizeHanchan(report).marks).toEqual([]);
    expect(summarizeHanchan(report, {}).marks).toEqual([]);
    expect(summarizeHanchan(report, { marks: [] }).marks).toEqual([]);
  });

  it('E-13 段階の当てはめは差し替えられる（MAKA の評価が入力されて当てはめ直したモデル）', () => {
    const allC = fitGradeModel([
      { game: 'a', score: 10, grade: 'C' },
      { game: 'a', score: 90, grade: 'C' },
    ]);
    const custom = summarizeHanchan(report, { gradeModel: allC });
    expect(custom.grade).toBe('C');
    expect(custom.kyokus.map((k) => k.grade)).toEqual(['C', 'C', 'C', 'C', 'C']);
    // Rating や結果は変わらない
    expect(custom.ratingText).toBe(summary.ratingText);
    expect(custom.kyokus.map((k) => k.ratingText)).toEqual(summary.kyokus.map((k) => k.ratingText));
  });
});

describe('半荘のまとめ（FX-1 の5半荘）', () => {
  it('E-12 半荘全体の Rating の文字列が、結果 JSON の review.rating と同じ（f9da87cbcd7af5e9 は 86.7）', () => {
    for (const id of FX1_IDS) {
      const report = load(id);
      const s = summarizeHanchan(report);
      expect(s.ratingText, id).toBe(formatRating(report.review.rating));
      expect(s.decisionCount, id).toBe(FX1_DECISION_COUNTS[id]);
      expect(s.matchCount, id).toBe(report.review.total_matches);
      expect(s.room, id).toBe('玉の間・南');
    }
    expect(summarizeHanchan(load('f9da87cbcd7af5e9')).ratingText).toBe('86.7');
  });

  it('局の数は 12・13・11・16・15 で、どの局にも Rating の文字列と段階が付き、段階は点数に対して単調', () => {
    const counts = [12, 13, 11, 16, 15];
    FX1_IDS.forEach((id, i) => {
      const s = summarizeHanchan(load(id));
      expect(s.kyokus, id).toHaveLength(counts[i] ?? -1);
      for (const k of s.kyokus) {
        expect(k.ratingText, `${id} ${k.label}`).not.toBeNull();
        expect(k.grade, `${id} ${k.label}`).not.toBeNull();
      }
      expect(s.grade, id).not.toBeNull();
      // 点数が高い局ほど、段階は下がらない
      const pairs = s.kyokus.map((k) => [k.rating ?? NaN, gradeIndexOf(k.grade ?? '') ?? NaN] as const).sort((a, b) => a[0] - b[0]);
      pairs.forEach((p, j) => expect(p[1], id).toBeGreaterThanOrEqual(pairs[j - 1]?.[1] ?? -1));
    });
  });
});

describe('F1 卓の呼び名', () => {
  it('卓の名前と半荘の長さを「・」でつなぎ、喰い断・赤ドラの表示は省く', () => {
    expect(roomLabelOf('玉の間南喰赤')).toBe('玉の間・南');
    expect(roomLabelOf('玉の間東喰赤')).toBe('玉の間・東');
    expect(roomLabelOf('王座の間南喰赤')).toBe('王座の間・南');
    expect(roomLabelOf('金の間東喰赤')).toBe('金の間・東');
    expect(roomLabelOf('銅の間南')).toBe('銅の間・南');
    expect(roomLabelOf('  玉の間南喰赤  ')).toBe('玉の間・南');
  });

  it('東も南も見つからない表示は、そのまま返す', () => {
    expect(roomLabelOf('友人戦')).toBe('友人戦');
    expect(roomLabelOf('')).toBe('');
  });

  it('結果に卓の表示が無い・形が違うときは null', () => {
    const report = load(FX4_ID);
    const withLogs = (split_logs: unknown[]): MortalReport => ({ ...report, split_logs });
    expect(roomLabel(withLogs([]))).toBeNull();
    expect(roomLabel(withLogs([null]))).toBeNull();
    expect(roomLabel(withLogs([{}]))).toBeNull();
    expect(roomLabel(withLogs([{ rule: null }]))).toBeNull();
    expect(roomLabel(withLogs([{ rule: { disp: 5 } }]))).toBeNull();
    expect(roomLabel(withLogs([{ rule: { disp: '  ' } }]))).toBeNull();
    expect(roomDispOf(withLogs([{ rule: { disp: '玉の間南喰赤' } }]))).toBe('玉の間南喰赤');
    expect(summarizeHanchan(withLogs([])).room).toBeNull();
    expect(summarizeHanchan(withLogs([])).roomDisp).toBeNull();
  });
});

describe('判断の無い半荘', () => {
  it('判断が1つも無ければ Rating・段階は null、局の行も Rating・段階が null', () => {
    const report = structuredClone(load(FX4_ID));
    for (const k of report.review.kyokus) k.entries = [];
    report.review.total_reviewed = 0;
    report.review.total_matches = 0;
    const s = summarizeHanchan(report);
    expect(s.rating).toBeNull();
    expect(s.ratingText).toBeNull();
    expect(s.grade).toBeNull();
    expect(s.kyokus.map((k) => [k.rating, k.ratingText, k.grade])).toEqual(Array.from({ length: 5 }, () => [null, null, null]));
    expect(s.decisionCount).toBe(0);
  });
});
