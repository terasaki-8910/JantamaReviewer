import { describe, expect, it } from 'vitest';

import { findDecisionRef, listDecisionRefs } from '../src/decision-ref';
import { kyokuFactsOf } from '../src/kyoku-locate';
import { isFarFromReading, linkMarks } from '../src/mark-link';
import { HAND_START_TILES_LEFT } from '../src/rating-link';
import { parseReportText } from '../src/report';
import type { MortalReport } from '../src/report-types';
import {
  CHOSEN_COST,
  FULL_READING_COST,
  PARTIAL_READING_COST,
  RATING_LINK_VERSION,
  UNPLACED_RATING_COST,
  type TimelineMarkLink,
  linkTimeline,
} from '../src/timeline-link';
import { FX4_ID, FX5_ID, loadReportText } from './helpers/fixtures';
import {
  FX4_USER_CHOICES,
  FX5_USER_CHOICES,
  type FixtureMark,
  type FixtureRating,
  clockOf,
  fx4Timeline,
  fx5Timeline,
  withChoices,
} from './helpers/timeline-inputs';

function load(id: string): MortalReport {
  const r = parseReportText(loadReportText(id));
  if (!r.ok) throw new Error(r.error.message);
  return r.value;
}

/** 局の名前（局の添字 → 名前）。 */
const labelsOf = (report: MortalReport): string[] => kyokuFactsOf(report).map((f) => f.label);

/** 評価の結果を、押した時刻（「15:35:40」）→ 局の名前（当てはめなかったものは null）にする。 */
function ratingTable(report: MortalReport, ratings: ReturnType<typeof linkTimeline<FixtureMark, FixtureRating>>['ratings']): Array<[string, string | null]> {
  const labels = labelsOf(report);
  return ratings.placements.map((p) => [clockOf(p.rating.t_ms), p.position === null ? null : (labels[p.position] as string)]);
}

/** 迷いの結果を、押した時刻 → 局の名前にする。 */
function markTable(report: MortalReport, marks: readonly TimelineMarkLink<FixtureMark>[]): Array<[string, string | null]> {
  const labels = labelsOf(report);
  return marks.map((m) => [clockOf(m.mark.t_ms), m.kyokuPosition === null ? null : (labels[m.kyokuPosition] as string)]);
}

describe('E-29 費用と版の定数', () => {
  it('E-29 ユーザーの選び 100・すべて読めた読み取り 3・崩れた読み取り 2・当てはめなかった評価 1。当てはめ方の版は 2', () => {
    expect([CHOSEN_COST, FULL_READING_COST, PARTIAL_READING_COST, UNPLACED_RATING_COST]).toEqual([100, 3, 2, 1]);
    expect(RATING_LINK_VERSION).toBe(2);
  });
});

describe('E-29 FX-5（10月11日の半荘）を、読み取りだけで当てはめる（ユーザーの選びは使わない）', () => {
  const report = load(FX5_ID);
  const { marks, ratings } = fx5Timeline();
  const result = linkTimeline(report, { marks, ratings });

  it('E-29 迷い7つ（ユーザーが選んだもの）は、どれも、ユーザーが選んだ判断の局になる', () => {
    expect(Object.keys(FX5_USER_CHOICES)).toHaveLength(7);
    for (const [id, key] of Object.entries(FX5_USER_CHOICES)) {
      const link = result.marks.find((m) => m.mark.id === Number(id));
      const chosen = findDecisionRef(report, key);
      expect(chosen, key).not.toBeNull();
      expect(link?.kyokuPosition, `迷い id=${id}`).toBe(chosen?.kyokuPosition);
    }
  });

  it('E-29 迷い13は、押した時刻の順に 東2局・東2局・東2局・東3局1本場・東4局×3・南1局2本場×2・南2局×2・南3局・南4局', () => {
    expect(markTable(report, result.marks)).toEqual([
      ['15:37:02', '東2局'],
      ['15:37:25', '東2局'],
      ['15:38:10', '東2局'],
      ['15:40:03', '東3局1本場'],
      ['15:42:37', '東4局'],
      ['15:42:52', '東4局'],
      ['15:43:46', '東4局'],
      ['15:50:36', '南1局2本場'],
      ['15:52:15', '南1局2本場'],
      ['15:54:39', '南2局'],
      ['15:56:01', '南2局'],
      ['15:58:10', '南3局'],
      ['16:03:19', '南4局'],
    ]);
  });

  it('E-29 評価9つは、FX-5 の評価の局になる: 東1局・東2局・東3局1本場・東4局・東4局1本場・南1局2本場・南2局・南3局・南4局（東3局は空欄）', () => {
    expect(ratingTable(report, result.ratings)).toEqual([
      ['15:35:40', '東1局'],
      ['15:39:22', '東2局'],
      ['15:41:44', '東3局1本場'],
      ['15:45:13', '東4局'],
      ['15:46:25', '東4局1本場'],
      ['15:52:43', '南1局2本場'],
      ['15:57:10', '南2局'],
      ['16:01:05', '南3局'],
      ['16:04:51', '南4局'],
    ]);
    // 評価の値は、押した順に △・△・〇・✕・〇・△・✕・〇・✕。局ごとに並べると、東3局だけが空欄
    const labels = labelsOf(report);
    expect(result.ratings.assigned.map((r, i) => [labels[i], r?.rating ?? null])).toEqual([
      ['東1局', 'fair'],
      ['東2局', 'fair'],
      ['東3局', null],
      ['東3局1本場', 'good'],
      ['東4局', 'bad'],
      ['東4局1本場', 'good'],
      ['南1局2本場', 'fair'],
      ['南2局', 'bad'],
      ['南3局', 'good'],
      ['南4局', 'bad'],
    ]);
    expect(result.ratings.missingHands).toEqual([2]);
    expect(result.ratings.extra).toEqual([]);
    expect(result.ratings.status).toBe('tooFew');
    expect(result.ratings.message).toBe('評価が1件足りません（評価9件、局10局）');
  });

  it('E-29 評価ごとの当てはめ方: 読めなかったものは時間の並び（order）、点数が読めたものは ocr、局の始め（残り69枚）のスクショは前の局（ocr-start）', () => {
    expect(result.ratings.placements.map((p) => [p.rating.id, p.how, p.unplaced])).toEqual([
      [1, 'order', null],
      [5, 'ocr-start', null],
      [7, 'order', null],
      [11, 'ocr', null],
      [12, 'ocr', null],
      [15, 'ocr', null],
      [18, 'order', null],
      [20, 'order', null],
      [22, 'ocr', null],
    ]);
    // 評価 5 は、スクショが 3 局・残り69枚・23700 点で、東3局（と東3局1本場）の始め。前の局の東2局の評価になる
    expect(result.ratings.placements[1]?.reading).toEqual({ wind: null, number: 3, tilesLeft: 69, score: 23700 });
    expect(HAND_START_TILES_LEFT).toBe(66);
  });

  it('E-29 迷いごとの決め方: 崩れた読み取りは partial、すべて読めたものは reading、読めなかったものは timeline', () => {
    expect(result.marks.map((m) => [m.mark.id, m.how])).toEqual([
      [2, 'partial'],
      [3, 'reading'],
      [4, 'partial'],
      [6, 'partial'],
      [8, 'timeline'],
      [9, 'reading'],
      [10, 'reading'],
      [13, 'partial'],
      [14, 'reading'],
      [16, 'reading'],
      [17, 'reading'],
      [19, 'reading'],
      [21, 'partial'],
    ]);
  });

  it('E-29 迷いの局の幅は、前後の評価・迷いの当てはめから決まる（読めなかった迷い 15:42:37 は、前の評価 15:41:44（東3局1本場）の次の局から、次の迷い 15:42:52（東4局）まで = 東4局だけ）', () => {
    const unreadable = result.marks.find((m) => m.mark.id === 8);
    expect(unreadable?.range).toEqual({ from: 4, to: 4 });
    expect(unreadable?.before).toEqual({ kind: 'rating', index: 2, t_ms: ratings[2]?.t_ms, kyokuPosition: 3 });
    expect(unreadable?.after).toEqual({ kind: 'mark', index: 5, t_ms: marks[5]?.t_ms, kyokuPosition: 4 });
    // 最初の迷いの前は半荘の最初の評価（東1局）、最後の迷いの次は無い
    expect(result.marks[0]?.before).toMatchObject({ kind: 'rating', kyokuPosition: 0 });
    expect(result.marks[12]?.after).toMatchObject({ kind: 'rating', kyokuPosition: 9 });
  });
});

describe('E-30 FX-5 の迷い: 局が決まったあと、残り枚数が読めれば局の幅の中で順位を付け、読めなければ局の幅の判断をすべて候補にする', () => {
  const report = load(FX5_ID);
  const { marks, ratings } = fx5Timeline();
  const result = linkTimeline(report, { marks, ratings });
  const byClock = (clock: string): TimelineMarkLink<FixtureMark> => {
    const found = result.marks.find((m) => clockOf(m.mark.t_ms) === clock);
    if (!found) throw new Error(`${clock} の迷いが無い`);
    return found;
  };

  it('E-30 15:37:02・15:50:36・16:03:19 は、残り枚数が読めた崩れた読み取りなので推定が付き、推定（1位）がユーザーの選びと一致する', () => {
    const expected: Record<string, string> = { '15:37:02': 'k1h0e5', '15:50:36': 'k4h2e2', '16:03:19': 'k7h0e6' };
    for (const [clock, key] of Object.entries(expected)) {
      const link = byClock(clock);
      expect(link.status, clock).toBe('estimated');
      expect(link.estimate?.key, clock).toBe(key);
      expect(link.choices, clock).toEqual([]);
    }
    expect(byClock('15:37:02').estimate).toMatchObject({ label: '東2局 5巡目 · 打牌の迷い', actionLabel: '打6s', tilesLeft: 50, tilesDiff: 0 });
    expect(byClock('15:50:36').estimate).toMatchObject({ label: '南1局2本場 3巡目 · 打牌の迷い', actionLabel: '打1s', tilesLeft: 61, tilesDiff: 1 });
    expect(byClock('16:03:19').estimate).toMatchObject({ label: '南4局 6巡目 · リーチの迷い', actionLabel: '打2p', tilesLeft: 49, tilesDiff: 0 });
  });

  it('E-30 15:38:10 と 15:42:37 は、局は決まったが残り枚数が読めない。推定を出さず（kyoku）、局の幅の中の判断をすべて選ぶ候補にする', () => {
    const labels = labelsOf(report);
    for (const [clock, kyoku, count] of [
      ['15:38:10', 1, 15],
      ['15:42:37', 4, 16],
    ] as const) {
      const link = byClock(clock);
      expect(link.status, clock).toBe('kyoku');
      expect(link.estimate, clock).toBeNull();
      expect(link.alternatives, clock).toEqual([]);
      expect(link.reason, clock).toBeNull();
      expect(link.kyokuPosition, clock).toBe(kyoku);
      expect(link.range, clock).toEqual({ from: kyoku, to: kyoku });
      expect(link.choices, clock).toHaveLength(count);
      // 局の幅の中の判断すべて（半荘の順）
      expect(link.choices.map((c) => c.key), clock).toEqual(
        listDecisionRefs(report)
          .filter((d) => d.kyokuPosition === kyoku)
          .map((d) => d.key),
      );
      expect(link.choices.every((c) => c.kyokuLabel === labels[kyoku]), clock).toBe(true);
    }
    // ユーザーが選んだ判断は、候補に入っている
    expect(byClock('15:38:10').choices.map((c) => c.key)).toContain('k1h0e8');
    expect(byClock('15:42:37').choices.map((c) => c.key)).toContain('k3h0e4');
  });

  it('E-30 15:42:37 は読めない（reading が null）が、前後の評価・迷いから局の幅が決まる。15:38:10 は、読めた部分（番号2・25000）から局が決まる', () => {
    expect(byClock('15:42:37')).toMatchObject({ reading: null, center: null, how: 'timeline', kyokuPositions: [] });
    expect(byClock('15:38:10')).toMatchObject({
      reading: { wind: null, number: 2, tilesLeft: null, score: 25000 },
      center: null,
      how: 'partial',
      kyokuPositions: [1],
    });
  });

  it('E-30 残り枚数が読めた迷いは、局の幅の中で E-17 と同じ順位を付ける: すべて読めて局が1つに決まる迷いは、linkMarks（E-17）と同じ推定・ほかの候補', () => {
    const plain = linkMarks(
      report,
      marks.map((m) => ({ lines: m.lines, retries: m.retries })),
    );
    for (const clock of ['15:37:25', '15:52:15', '15:54:39', '15:56:01', '15:58:10']) {
      const link = byClock(clock);
      const expected = plain[marks.findIndex((m) => clockOf(m.t_ms) === clock)];
      expect(link.status, clock).toBe('estimated');
      expect(link.estimate, clock).toEqual(expected?.estimate);
      expect(link.alternatives, clock).toEqual(expected?.alternatives);
    }
  });

  it('E-30 局が2つ（東3局・東3局1本場）に当たる 15:40:03 は、自分の判断がある東3局1本場の判断から推定する（東3局には判断が無い）', () => {
    const link = byClock('15:40:03');
    expect(link.kyokuPositions).toEqual([2, 3]);
    expect(link.kyokuPosition).toBe(3);
    expect(link.status).toBe('estimated');
    expect(link.estimate).toMatchObject({ kyokuLabel: '東3局1本場', junme: 3, actionLabel: '打中', tilesLeft: 59 });
  });

  it('E-30 局が2つ（東4局・東4局1本場）に当たる迷いも、前後の評価・迷いで幅が東4局に絞られ、東4局の判断だけから推定する', () => {
    const link = byClock('15:42:52');
    expect(link.kyokuPositions).toEqual([4, 5]);
    expect(link.range).toEqual({ from: 4, to: 4 });
    expect(link.estimate).toMatchObject({ kyokuLabel: '東4局', junme: 5, actionLabel: '白をポン', tilesLeft: 49 });
    expect([link.estimate, ...link.alternatives].every((c) => c?.kyokuPosition === 4)).toBe(true);
  });

  it('E-30 迷い13 のうち、手で選ぶ迷い（manual）は1つも無い', () => {
    expect(result.marks.filter((m) => m.status === 'manual')).toEqual([]);
    expect(result.marks.map((m) => m.status)).toEqual([
      'estimated',
      'estimated',
      'kyoku',
      'estimated',
      'kyoku',
      'estimated',
      'estimated',
      'estimated',
      'estimated',
      'estimated',
      'estimated',
      'estimated',
      'estimated',
    ]);
  });
});

describe('E-29・E-30 ユーザーの選びを基準にする（FX-5）', () => {
  const report = load(FX5_ID);
  const base = fx5Timeline();
  const chosen = withChoices(base.marks, FX5_USER_CHOICES);
  const result = linkTimeline(report, { marks: chosen, ratings: base.ratings });
  const plain = linkTimeline(report, base);

  it('E-29 ユーザーが選んだ迷い7つは、決め方が chosen。ほかの迷いの決め方は変わらない', () => {
    expect(result.marks.map((m) => [m.mark.id, m.how === 'chosen'])).toEqual(
      result.marks.map((m) => [m.mark.id, FX5_USER_CHOICES[m.mark.id] !== undefined]),
    );
    expect(markTable(report, result.marks)).toEqual(markTable(report, plain.marks));
    expect(ratingTable(report, result.ratings)).toEqual(ratingTable(report, plain.ratings));
  });

  it('E-30 ユーザーが選んだ迷いにも、自動の結果（推定・ほかの候補・選び肢）は付く。選んだ判断は、推定・ほかの候補・選び肢のどれかに入る（迷い id=6 は、読み取り 残59 から離れた 残63 を選んだので、入らず、離れている）', () => {
    for (const link of result.marks) {
      const key = FX5_USER_CHOICES[link.mark.id];
      if (key === undefined) continue;
      const keys = [link.estimate, ...link.alternatives, ...link.choices].flatMap((c) => (c ? [c.key] : []));
      if (link.mark.id === 6) {
        expect(keys, `迷い id=${link.mark.id}`).not.toContain(key);
        expect(isFarFromReading(report, link, key), `迷い id=${link.mark.id}`).toBe(true);
      } else {
        expect(keys, `迷い id=${link.mark.id}`).toContain(key);
        expect(isFarFromReading(report, link, key), `迷い id=${link.mark.id}`).toBe(false);
      }
    }
  });

  it('E-29 ユーザーの選びは読み取りより強い: 読み取りと違う局を選ぶと、その局に当てはまる（読み取りに合わない費用 3 より、選びに合わない費用 100 が重い）', () => {
    // 東2局（k1）の迷い id=3 を、南1局2本場（pos 6）の判断に結びつけた。評価・迷いの時間の並びは、それに合わせて動く
    const moved = withChoices(base.marks, { 3: 'k4h2e2' });
    const r = linkTimeline(report, { marks: moved, ratings: base.ratings });
    const link = r.marks.find((m) => m.mark.id === 3);
    expect(link?.kyokuPosition).toBe(6);
    expect(link?.how).toBe('chosen');
    // その迷いより前の評価（id=1 東1局）は動かない。あとの迷い・評価は、南1局2本場以降に押し出される（読み取りに合わなくなる）
    expect(r.ratings.placements[0]).toMatchObject({ position: 0 });
    for (const mark of r.marks.filter((m) => m.mark.t_ms > (link?.mark.t_ms ?? 0))) {
      expect(mark.kyokuPosition ?? -1, `迷い id=${mark.mark.id}`).toBeGreaterThanOrEqual(6);
    }
  });

  it('E-29 判断の鍵でない値（"manual"）や、この結果に無い判断の鍵は、基準にしない', () => {
    const noise = base.marks.map((m, i) => ({ ...m, chosen: i % 2 === 0 ? 'manual' : 'k99h9e99' }));
    const r = linkTimeline(report, { marks: noise, ratings: base.ratings });
    expect(r.marks.some((m) => m.how === 'chosen')).toBe(false);
    expect(markTable(report, r.marks)).toEqual(markTable(report, plain.marks));
    const empty = linkTimeline(report, { marks: base.marks.map((m) => ({ ...m, chosen: null })), ratings: base.ratings });
    expect(markTable(report, empty.marks)).toEqual(markTable(report, plain.marks));
  });
});

describe('E-29 FX-4（10月9日の半荘。10月9日の記録を足したもの）を、読み取りだけで当てはめる', () => {
  const report = load(FX4_ID);
  const { marks, ratings } = fx4Timeline();
  const result = linkTimeline(report, { marks, ratings });

  it('E-29 迷い6つが、どれもユーザーが選んだ局になる（迷い 6 は 東3局1本場）', () => {
    for (const [id, key] of Object.entries(FX4_USER_CHOICES)) {
      const link = result.marks.find((m) => m.mark.id === Number(id));
      expect(link?.kyokuPosition, `迷い id=${id}`).toBe(findDecisionRef(report, key)?.kyokuPosition);
    }
    expect(markTable(report, result.marks)).toEqual([
      ['19:09:53', '東1局'],
      ['19:15:57', '東2局'],
      ['19:17:37', '東2局1本場'],
      ['19:18:24', '東2局1本場'],
      ['19:21:58', '東3局1本場'],
      ['19:22:36', '東3局1本場'],
    ]);
  });

  it('E-29 19:22:41 の評価は当てはめず（押し直し）、19:23:54 の評価が 東3局1本場になる。東3局は空欄', () => {
    expect(ratingTable(report, result.ratings)).toEqual([
      ['19:12:50', '東1局'],
      ['19:16:39', '東2局'],
      ['19:19:11', '東2局1本場'],
      ['19:22:41', null],
      ['19:23:54', '東3局1本場'],
    ]);
    expect(result.ratings.placements[3]).toMatchObject({ position: null, how: null, unplaced: 'duplicate' });
    expect(result.ratings.assigned.map((r) => r?.id ?? null)).toEqual([2, 4, 7, null, 11]);
    expect(result.ratings.extra.map((r) => r.id)).toEqual([10]);
    expect(result.ratings.missingHands).toEqual([3]);
    expect(result.ratings.status).toBe('exact');
    expect(result.ratings.message).toBe('評価と局は同数です（評価5件、局5局）が、1件を当てはめられず、1局が空欄です');
  });

  it('E-17 の結果は変わらない: 迷い6つの推定・ほかの候補が、linkMarks（E-17）と同じ。1〜5 の推定は、ユーザーが選んだ判断', () => {
    const plain = linkMarks(
      report,
      marks.map((m) => ({ lines: m.lines, retries: m.retries })),
    );
    expect(result.marks.map((m) => m.estimate)).toEqual(plain.map((l) => l.estimate));
    expect(result.marks.map((m) => m.alternatives)).toEqual(plain.map((l) => l.alternatives));
    expect(result.marks.map((m) => m.kyokuPositions)).toEqual(plain.map((l) => l.kyokuPositions));
    expect(result.marks.map((m) => m.status)).toEqual(['estimated', 'estimated', 'estimated', 'estimated', 'estimated', 'estimated']);
    expect(result.marks.slice(0, 5).map((m) => m.estimate?.key)).toEqual(['k0h0e4', 'k1h0e12', 'k1h1e7', 'k1h1e10', 'k2h1e6']);
    expect(result.marks[5]?.estimate?.key).toBe('k2h1e10');
  });

  it('E-29 評価の読み取りが無くても（FX-4 の評価は、スクショを読んでいない）、迷いの局と時間の並びで、評価の局が決まる', () => {
    expect(result.ratings.placements.map((p) => [p.rating.id, p.how])).toEqual([
      [2, 'order'],
      [4, 'order'],
      [7, 'order'],
      [10, null],
      [11, 'order'],
    ]);
  });

  it('E-29 FX-4 の迷い6（読み直しで読める）が読み直し無しで読めないときは、前後から 東3局1本場 と決まり、局の幅の中の判断を選ぶ候補にする', () => {
    const noRetries = marks.map((m, i) => (i === 5 ? { id: m.id, t_ms: m.t_ms, lines: m.lines } : m));
    const r = linkTimeline(report, { marks: noRetries, ratings });
    const link = r.marks[5];
    expect(link).toMatchObject({ status: 'kyoku', how: 'timeline', kyokuPosition: 4, range: { from: 4, to: 4 }, reading: null });
    expect(link?.choices).toHaveLength(17);
    // 評価の当てはめは、読み取りが無くても変わらない
    expect(ratingTable(report, r.ratings)).toEqual(ratingTable(report, result.ratings));
  });
});
