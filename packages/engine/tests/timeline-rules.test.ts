import { describe, expect, it } from 'vitest';

import type { CenterText } from '../src/center-text';
import type { Decision } from '../src/decision';
import { importReport } from '../src/import';
import { kyokuFactsOf } from '../src/kyoku-locate';
import { linkMarks } from '../src/mark-link';
import { alignRatings } from '../src/rating-alignment';
import { linkRatings } from '../src/rating-link';
import { parseReportText } from '../src/report';
import type { MortalReport } from '../src/report-types';
import { type TimelineMarkInput, linkTimeline } from '../src/timeline-link';
import { FX1_IDS, FX4_ID, loadReportJson, loadReportText } from './helpers/fixtures';

function load(id: string): MortalReport {
  const r = parseReportText(loadReportText(id));
  if (!r.ok) throw new Error(r.error.message);
  return r.value;
}

// 時間の並びでの当てはめ（E-29・E-30）の決まりを、作った入力で確かめる。
// 5局の半荘（FX-4）: 0 東1局(18)・1 東2局(17)・2 東2局1本場(13)・3 東3局(5)・4 東3局1本場(17)。かっこは自分の判断の数。

const report = load(FX4_ID);
const BASE = 1_000_000;

/** 局の位置・残りの牌の数から、その局の始めの点数で読んだ、すべて読めた読み取り。 */
function centerAt(position: number, tilesLeft: number, score?: number, source: MortalReport = report): CenterText {
  const f = kyokuFactsOf(source)[position];
  if (!f) throw new Error(`${position}局目が無い`);
  return {
    wind: (['E', 'S', 'W'] as const)[Math.floor(f.kyoku / 4)] as CenterText['wind'],
    number: ((f.kyoku % 4) + 1) as CenterText['number'],
    tilesLeft,
    score: score ?? f.startScore,
  };
}

/** 押した時刻は、番号の順に 1 分おき（`at` で変えられる）。 */
interface Press {
  id: number;
  t_ms: number;
}
type MarkIn = TimelineMarkInput & Press;
type RatingIn = { t_ms: number; center?: CenterText | null; lines?: string[]; id: number };

const mark = (id: number, extra: Partial<TimelineMarkInput> = {}, at = id): MarkIn => ({ id, t_ms: BASE + at * 60_000, ...extra });
const rate = (id: number, extra: Partial<RatingIn> = {}, at = id): RatingIn => ({ id, t_ms: BASE + at * 60_000, ...extra });

const mid = (position: number) => ({ center: centerAt(position, 30) });

/** 評価の結果を、評価の番号 → 当てはめた局（なければ null）にする。 */
function ratingAt(result: ReturnType<typeof linkTimeline<MarkIn, RatingIn>>): Record<number, number | null> {
  return Object.fromEntries(result.ratings.placements.map((p) => [p.rating.id, p.position]));
}
const markAt = (result: ReturnType<typeof linkTimeline<MarkIn, RatingIn>>): Record<number, number | null> =>
  Object.fromEntries(result.marks.map((m) => [m.mark.id, m.kyokuPosition]));

describe('E-29 (1) 評価のあとに押したものは、その評価の局より後。迷いのあとに押したものは、その迷いの局か後', () => {
  it('E-29 評価（局1と読めた）のあとの、読めない迷いは、局2以降。その迷いのあとの評価は、迷いと同じ局2でよい', () => {
    const result = linkTimeline(report, { marks: [mark(2)], ratings: [rate(1, mid(1)), rate(3)] });
    expect(markAt(result)[2]).toBe(2);
    expect(ratingAt(result)).toEqual({ 1: 1, 3: 2 });
  });

  it('E-29 迷い（局2と読めた）のあとの、読めない評価は、同じ局2に当てはまってよい。そのあとの評価は局3', () => {
    const result = linkTimeline(report, { marks: [mark(1, mid(2))], ratings: [rate(2), rate(3)] });
    expect(ratingAt(result)).toEqual({ 2: 2, 3: 3 });
  });

  it('E-29 迷い（局3と読めた）のあとの、読めない迷いは、同じ局3でよい', () => {
    const result = linkTimeline(report, { marks: [mark(1, mid(3)), mark(2)], ratings: [] });
    expect(markAt(result)).toEqual({ 1: 3, 2: 3 });
  });

  it('E-29 評価のあとの評価は、その評価の局より後（読めない評価は、局0・局1・局2…の順）', () => {
    const result = linkTimeline(report, { marks: [], ratings: [rate(1), rate(2), rate(3)] });
    expect(ratingAt(result)).toEqual({ 1: 0, 2: 1, 3: 2 });
    expect(result.ratings.placements.map((p) => p.how)).toEqual(['order', 'order', 'order']);
  });

  it('E-29 押した時刻の順に扱う: 渡す順がばらばらでも同じ結果。同じ時刻は渡した順（迷い、そのあと評価）', () => {
    const marks = [mark(10, mid(2), 10)];
    const ratings = [rate(11, {}, 11), rate(12, {}, 12)];
    const a = linkTimeline(report, { marks, ratings });
    const b = linkTimeline(report, { marks, ratings: [...ratings].reverse() });
    expect(ratingAt(a)).toEqual(ratingAt(b));
    expect(ratingAt(a)).toEqual({ 11: 2, 12: 3 });
    // 同じ時刻の評価は、渡した順（placements の order も渡した順）
    const same = linkTimeline(report, { marks: [], ratings: [rate(5, {}, 3), rate(6, {}, 3), rate(7, {}, 3)] });
    expect(same.ratings.placements.map((p) => [p.rating.id, p.order, p.position])).toEqual([
      [5, 0, 0],
      [6, 1, 1],
      [7, 2, 2],
    ]);
    // 同じ時刻の迷いと評価は、迷いが先: 迷い（局2）のあとの評価は局2でよい
    const tie = linkTimeline(report, { marks: [mark(1, mid(2), 5)], ratings: [rate(2, {}, 5)] });
    expect(ratingAt(tie)[2]).toBe(2);
  });
});

describe('E-29 (2) 評価は当てはめないこともできる。同じ局に2つ当たるなら、あとに押したほうを残す。迷いは判断のある局にだけ', () => {
  it('E-29 押し直し: 同じ局（局1）と読めた評価が2つ。あとのものを残し、先のものは当てはめない（duplicate）', () => {
    const result = linkTimeline(report, { marks: [], ratings: [rate(1, mid(0)), rate(2, mid(1)), rate(3, mid(1)), rate(4, mid(2))] });
    expect(ratingAt(result)).toEqual({ 1: 0, 2: null, 3: 1, 4: 2 });
    expect(result.ratings.placements[1]).toMatchObject({ position: null, how: null, unplaced: 'duplicate' });
    expect(result.ratings.extra.map((r) => r.id)).toEqual([2]);
  });

  it('E-29 読めない評価が、迷いに挟まれて同じ局に2つ当たるときも、あとに押したほうを残す（FX-4 の最後の2つの評価と同じ形）', () => {
    const result = linkTimeline(report, { marks: [mark(1, mid(4))], ratings: [rate(2), rate(3)] });
    expect(ratingAt(result)).toEqual({ 2: null, 3: 4 });
    expect(result.ratings.placements[0]?.unplaced).toBe('duplicate');
  });

  it('E-29 半荘のあと: 最後の局のあとに押した評価（局は足りない）は、当てはめない。当てはめられる評価が先に局を使う（読み取りのある評価）', () => {
    const ratings = [0, 1, 2, 3, 4].map((p) => rate(p + 1, mid(p)));
    const result = linkTimeline(report, { marks: [], ratings: [...ratings, rate(9)] });
    expect(ratingAt(result)).toEqual({ 1: 0, 2: 1, 3: 2, 4: 3, 5: 4, 9: null });
    expect(result.ratings.placements[5]).toMatchObject({ position: null, unplaced: 'no-room' });
    expect(result.ratings.status).toBe('tooMany');
    expect(result.ratings.message).toBe('評価が1件多いです（評価6件、局5局）。うち1件は、当てはめられませんでした');
  });

  it('E-29 手がかりのある評価を、手がかりの無い評価より先に残す: 局に空きが足りないとき、読み取りに合う評価が残る', () => {
    const result = linkTimeline(report, { marks: [], ratings: [rate(1, mid(4)), rate(2)] });
    expect(ratingAt(result)).toEqual({ 1: 4, 2: null });
  });

  it('E-29 迷いは、自分の判断がある局にだけ当てはめる: 判断が無い局3には、読めない迷いも、局3と読めた迷いも当てはまらない', () => {
    const empty = structuredClone(report);
    const kyoku = empty.review.kyokus[3];
    if (!kyoku) throw new Error('東3局が無い');
    kyoku.entries = [];
    const result = linkTimeline(empty, {
      marks: [mark(2), mark(3, { center: centerAt(3, 40, undefined, empty) })],
      ratings: [rate(1, { center: centerAt(2, 30, undefined, empty) })],
    });
    // 評価（局2）のあとの迷いは局3以降だが、局3に判断が無いので局4。局3と読めた迷いは、合う局に判断が無い（no-decision）
    expect(markAt(result)).toEqual({ 2: 4, 3: 4 });
    expect(result.marks[1]).toMatchObject({ status: 'manual', reason: 'no-decision', kyokuPositions: [3] });
    expect(result.marks[0]?.status).toBe('kyoku');
    // 評価は、判断が無い局にも当てはめられる
    const rating = linkTimeline(empty, { marks: [], ratings: [rate(1, mid(2)), rate(2)] });
    expect(ratingAt(rating)).toEqual({ 1: 2, 2: 3 });
  });
});

describe('E-29 (3) 読めたスクショとユーザーの選びに、できるだけ合わせる（選び 100 > すべて読めた 3 > 崩れた 2 > 評価を当てはめない 1）', () => {
  it('E-29 読み取りと食い違う評価は、当てはめない（食い違う局に当てはめるより、費用が小さい）', () => {
    // 迷いは局3と読めた。そのあとに押した評価が局1と読めた: 局1には当てはめられない
    for (const reading of [{ center: centerAt(1, 30) }, { lines: ['2 局', '个 3 0', '19000'] }]) {
      const result = linkTimeline(report, { marks: [mark(1, mid(3))], ratings: [rate(2, reading)] });
      expect(ratingAt(result), JSON.stringify(reading)).toEqual({ 2: null });
      expect(result.ratings.placements[0]?.unplaced).toBe('no-room');
    }
  });

  it('E-29 評価を当てはめないほうが安くても、迷いは当てはめないことができない: 迷いの読み取りが食い違うときは、迷いを動かす（すべて読めた 3 > 崩れた 2）', () => {
    // 迷い1は局3（すべて読めた）、あとの迷い2は局1（崩れた読み取り）。迷いは局が進む一方なので、安いほう（崩れた）が合わなくなる
    const result = linkTimeline(report, { marks: [mark(1, mid(3)), mark(2, { lines: ['2 局', '个 3 0', '19000'] })], ratings: [] });
    expect(markAt(result)).toEqual({ 1: 3, 2: 3 });
    expect(result.marks.map((m) => m.how)).toEqual(['reading', 'timeline']);
  });

  it('E-29 ユーザーの選びは、読み取りより強い: 読み取り（局1）と違う局3の判断を選ぶと、局3に当てはまる（chosen）', () => {
    const chosenKey = 'k2h0e0'; // 東3局の最初の判断
    const result = linkTimeline(report, { marks: [mark(1, { ...mid(1), chosen: chosenKey })], ratings: [] });
    expect(result.marks[0]).toMatchObject({ kyokuPosition: 3, how: 'chosen' });
    // ユーザーの選びに合わせるためなら、評価を当てはめないことより、読み取りに合わない迷いを許す
    const pushed = linkTimeline(report, { marks: [mark(1, { chosen: chosenKey }), mark(3, mid(1))], ratings: [rate(2, mid(0))] });
    expect(markAt(pushed)).toEqual({ 1: 3, 3: 3 });
    expect(ratingAt(pushed)).toEqual({ 2: null });
  });

  it('E-29 読み取りに合う局が1つも無い評価は、読み取りが無いのと同じ（時間の並びで当てはめる）。迷いは「この半荘に合う局がありません」（no-kyoku）', () => {
    const wrong: CenterText = { wind: 'W', number: 4, tilesLeft: 30, score: 25000 };
    const result = linkTimeline(report, { marks: [mark(2, { center: wrong })], ratings: [rate(1, { center: wrong }), rate(3, mid(2))] });
    expect(result.ratings.placements.map((p) => [p.position, p.how])).toEqual([
      [0, 'order'],
      [2, 'ocr'],
    ]);
    expect(result.marks[0]).toMatchObject({ status: 'manual', reason: 'no-kyoku', kyokuPositions: [], center: wrong });
  });
});

describe('E-29 (4) 決まらないときは、評価は早い局（直前に遊んでいた局）。局の始めの読み取りは、前の局', () => {
  it('E-29 読めない評価は、直前の迷いの局（その局の評価）に当てはまる。そのあとの評価は、次の局', () => {
    const result = linkTimeline(report, { marks: [mark(1, mid(3))], ratings: [rate(2), rate(3)] });
    expect(ratingAt(result)).toEqual({ 2: 3, 3: 4 });
    const two = linkTimeline(report, { marks: [mark(1, mid(2))], ratings: [rate(2), rate(3)] });
    expect(ratingAt(two)).toEqual({ 2: 2, 3: 3 });
  });

  it(`E-29 局の始め（残り ${66} 枚以上）の読み取りは、読んだ局の前の局の評価（ocr-start）。65枚は読んだ局（ocr）`, () => {
    const at = (position: number, tilesLeft: number) => {
      const result = linkTimeline(report, { marks: [], ratings: [rate(1, { center: centerAt(position, tilesLeft) })] });
      return result.ratings.placements[0];
    };
    expect(at(2, 66)).toMatchObject({ position: 1, how: 'ocr-start' });
    expect(at(2, 65)).toMatchObject({ position: 2, how: 'ocr' });
    expect(at(3, 70)).toMatchObject({ position: 2, how: 'ocr-start' });
    expect(at(2, 0)).toMatchObject({ position: 2, how: 'ocr' });
    // 最初の局の始めは、前の局が無いので当てはめない（before-first）
    expect(at(0, 68)).toMatchObject({ position: null, how: null, unplaced: 'before-first' });
  });

  it('E-29 局の名前が崩れていても、点数で局が決まる評価は、その局（崩れた読み取りの評価）。残り枚数が読めなければ、局の始めとは見ない', () => {
    // 19000 点は東2局（局1）の始めの点数。残り枚数が無い（点数だけ）なので、局1の評価
    const score = linkTimeline(report, { marks: [], ratings: [rate(1, { lines: ['19000'] })] });
    expect(score.ratings.placements[0]).toMatchObject({ position: 1, how: 'ocr', reading: { wind: null, number: null, tilesLeft: null, score: 19000 } });
    // 残り69枚で、番号 2 と読めた（風は崩れた）19000 点は、東2局の始め = 東1局の評価
    const startOfNext = linkTimeline(report, { marks: [], ratings: [rate(1, { lines: ['第 2 局', '个 6 9', '19000'] })] });
    expect(startOfNext.ratings.placements[0]).toMatchObject({ position: 0, how: 'ocr-start' });
  });
});

describe('E-29 迷いの局の幅と、その決め方（前の評価の局の次か前の迷いの局から、次の評価か次の迷いの局まで）', () => {
  it('E-29 読めない迷いは、前後の評価（局1・局3）の間 = 局2・局3 が幅。局は幅の中の早い局（2）。選び肢は、幅の中の判断すべて（局2・局3 の 13 + 5）', () => {
    const result = linkTimeline(report, { marks: [mark(2)], ratings: [rate(1, mid(1)), rate(3, mid(3))] });
    const link = result.marks[0];
    expect(link).toMatchObject({ status: 'kyoku', how: 'timeline', kyokuPosition: 2, range: { from: 2, to: 3 }, reading: null });
    expect(link?.before).toMatchObject({ kind: 'rating', index: 0, kyokuPosition: 1 });
    expect(link?.after).toMatchObject({ kind: 'rating', index: 1, kyokuPosition: 3 });
    expect(link?.choices).toHaveLength(13 + 5);
    expect(new Set(link?.choices.map((c) => c.kyokuPosition))).toEqual(new Set([2, 3]));
    expect(link?.estimate).toBeNull();
    expect(link?.alternatives).toEqual([]);
  });

  it('E-29 評価の局の次から: 評価（局1）の次は局2。迷いの局から: 前の迷い（局2と読めた）の局は含む', () => {
    const afterRating = linkTimeline(report, { marks: [mark(2)], ratings: [rate(1, mid(1)), rate(3, mid(4))] });
    expect(afterRating.marks[0]?.range).toEqual({ from: 2, to: 4 });
    const afterMark = linkTimeline(report, { marks: [mark(1, mid(2)), mark(2)], ratings: [rate(3, mid(4))] });
    expect(afterMark.marks[1]?.range).toEqual({ from: 2, to: 4 });
    expect(afterMark.marks[1]?.before).toMatchObject({ kind: 'mark', index: 0, kyokuPosition: 2 });
  });

  it('E-29 時間の並びだけで置いた迷いは、前後の手がかりにしない: 読めない迷いが続いても、幅は同じ（1つの局に潰れない）', () => {
    const result = linkTimeline(report, { marks: [mark(2), mark(3)], ratings: [rate(1, mid(1)), rate(4, mid(3))] });
    expect(result.marks.map((m) => m.range)).toEqual([
      { from: 2, to: 3 },
      { from: 2, to: 3 },
    ]);
    expect(markAt(result)).toEqual({ 2: 2, 3: 2 });
  });

  it('E-29 前の出来事が無ければ半荘の最初の局から、次の出来事が無ければ最後の局まで（その中の、判断がある局）', () => {
    const result = linkTimeline(report, { marks: [mark(2), mark(4)], ratings: [rate(1, mid(1)), rate(3, mid(3))] });
    expect(result.marks[1]).toMatchObject({ range: { from: 4, to: 4 }, after: null });
    expect(result.marks[1]?.before).toMatchObject({ kind: 'rating', kyokuPosition: 3 });
    const first = linkTimeline(report, { marks: [mark(1)], ratings: [rate(2, mid(1))] });
    expect(first.marks[0]).toMatchObject({ range: { from: 0, to: 1 }, before: null });
  });

  it('E-29 前後から何も分からない（幅が、判断のある局すべて）読めない迷いは、手で選ぶ（unreadable）', () => {
    const result = linkTimeline(report, { marks: [mark(1)], ratings: [] });
    expect(result.marks[0]).toMatchObject({ status: 'manual', reason: 'unreadable', range: { from: 0, to: 4 }, choices: [] });
    const whole = linkTimeline(report, { marks: [mark(1)], ratings: [rate(2, mid(4))] });
    expect(whole.marks[0]).toMatchObject({ status: 'manual', reason: 'unreadable' });
  });

  it('E-30 残り枚数が読めた崩れた読み取りは、局の幅の中の、読み取りに合う局の判断に順位を付ける（局が2つに当たっても、幅の外の局は入らない）', () => {
    // f738896995c33fed: 東3局2本場（局4）と東3局3本場（局5）は、どちらも 20700 点始まり
    const big = load('f738896995c33fed');
    const reading = { lines: ['東 3 局', '个 60', '20700'] };
    const both = linkTimeline(big, { marks: [mark(1, reading)], ratings: [] });
    expect(both.marks[0]?.kyokuPositions).toEqual([4, 5]);
    expect(both.marks[0]?.estimate?.key).toBe('k2h3e2');
    // 評価（局4と読めた）のあとに押したので、局5に絞られる: 局4の判断は、候補に入らない
    const centerAt4: CenterText = { wind: 'E', number: 3, tilesLeft: 20, score: 20700 };
    const narrowed = linkTimeline(big, { marks: [mark(2, reading)], ratings: [{ id: 1, t_ms: BASE + 60_000, center: { ...centerAt4, tilesLeft: 20 } }] });
    // 評価の読み取りは 局4 または 局5（20700 点）。早い局 4 に当てはまり、迷いは局5 以降
    expect(narrowed.marks[0]?.kyokuPosition).toBe(5);
    expect([narrowed.marks[0]?.estimate, ...(narrowed.marks[0]?.alternatives ?? [])].every((c) => c?.kyokuPosition === 5)).toBe(true);
  });
});

describe('E-29・E-30 迷いの状態（estimated・kyoku・manual）', () => {
  it('E-30 崩れていて残り枚数が読めない迷い（局が分かる）は kyoku。残り枚数も読めれば estimated', () => {
    const noTiles = linkTimeline(report, { marks: [mark(1, { lines: ['2 局', '19000'] })], ratings: [] });
    expect(noTiles.marks[0]).toMatchObject({ status: 'kyoku', how: 'partial', kyokuPosition: 1, range: { from: 1, to: 1 } });
    expect(noTiles.marks[0]?.choices).toHaveLength(17);
    const withTiles = linkTimeline(report, { marks: [mark(1, { lines: ['2 局', '个 2 3', '19000'] })], ratings: [] });
    expect(withTiles.marks[0]).toMatchObject({ status: 'estimated', how: 'partial' });
    expect(withTiles.marks[0]?.estimate).toMatchObject({ key: 'k1h0e12', actionLabel: '打8p', tilesLeft: 25 });
  });

  it('E-29 読み取りが時間の並びと食い違う迷い（迷いは動かせない）は、局の幅の中で順位を付ける（timeline）。読み取りの局ではない', () => {
    // 迷い1は、ユーザーが局3の判断を選んだ。あとの迷い2は局1と読めたが、迷いは局が進む一方なので、局3以降に置くしかない
    const result = linkTimeline(report, { marks: [mark(1, { chosen: 'k2h0e0' }), mark(2, mid(1))], ratings: [] });
    expect(result.marks[1]).toMatchObject({ how: 'timeline', kyokuPosition: 3, status: 'estimated', kyokuPositions: [1] });
    expect(result.marks[1]?.range).toEqual({ from: 3, to: 4 });
    expect([3, 4]).toContain(result.marks[1]?.estimate?.kyokuPosition);
  });

  it('E-29 評価と迷いの読み取りが食い違うときは、迷いを動かさず、評価を当てはめない（評価を当てはめないほうが安い）', () => {
    const result = linkTimeline(report, { marks: [mark(2, mid(1))], ratings: [rate(1, mid(3))] });
    expect(result.marks[0]).toMatchObject({ how: 'reading', kyokuPosition: 1 });
    expect(ratingAt(result)).toEqual({ 1: null });
  });

  it('E-29 読み取りに合う局が無いなら no-kyoku、合う局に判断が無いなら no-decision', () => {
    const noKyoku = linkTimeline(report, { marks: [mark(1, { center: { wind: 'S', number: 2, tilesLeft: 40, score: 25000 } })], ratings: [] });
    expect(noKyoku.marks[0]).toMatchObject({ status: 'manual', reason: 'no-kyoku', estimate: null, alternatives: [], choices: [] });
  });

  it('E-29 自分の判断がある局が1つも無い半荘では、迷いは当てはめられない（kyokuPosition・range が null）。評価は当てはめられる', () => {
    const empty = structuredClone(report);
    for (const kyoku of empty.review.kyokus) kyoku.entries = [];
    const result = linkTimeline(empty, {
      marks: [mark(1, { center: centerAt(1, 30, undefined, empty) }), mark(2), mark(3, { center: null })],
      ratings: [rate(4), rate(5)],
    });
    expect(result.marks.map((m) => [m.status, m.reason, m.kyokuPosition, m.range])).toEqual([
      ['manual', 'no-decision', null, null],
      ['manual', 'unreadable', null, null],
      ['manual', 'unreadable', null, null],
    ]);
    expect(result.ratings.assigned.map((r) => r?.id ?? null)).toEqual([4, 5, null, null, null]);
  });

  it('E-29 迷いも評価も無ければ、空の結果。評価が無ければ、すべての局が空欄', () => {
    const none = linkTimeline(report, { marks: [], ratings: [] });
    expect(none.marks).toEqual([]);
    expect(none.ratings.placements).toEqual([]);
    expect(none.ratings.assigned).toEqual([null, null, null, null, null]);
    expect(none.ratings.status).toBe('tooFew');
    expect(none.ratings.missingHands).toEqual([0, 1, 2, 3, 4]);
  });
});

describe('E-29 評価だけを返す linkRatings は、linkTimeline の評価と同じ。迷い（と選び）は、評価の手がかりになる', () => {
  it('E-29 迷いを渡さなければ、評価だけで当てはめる（評価が少なければ、E-7 の押した順と同じ）', () => {
    for (const count of [0, 3, 5]) {
      const ratings = Array.from({ length: count }, (_, i) => rate(i + 1));
      const result = linkRatings(report, ratings);
      const aligned = alignRatings(ratings, 5);
      expect(result.assigned).toEqual(aligned.assigned);
      expect(result.extra).toEqual(aligned.extra);
      expect(result.missingHands).toEqual(aligned.missingHands);
      expect(result.status).toBe(aligned.status);
    }
  });

  it('E-29 迷い（と、ユーザーが選んだ結びつけ）を渡すと、評価の局が変わる', () => {
    const ratings = [rate(2), rate(4)];
    expect(linkRatings(report, ratings).assigned.map((r) => r?.id ?? null)).toEqual([2, 4, null, null, null]);
    const withMarks = linkRatings(report, ratings, [mark(1, mid(2)), mark(3, { chosen: 'k3h0e0' })]);
    expect(withMarks.assigned.map((r) => r?.id ?? null)).toEqual([null, null, 2, 4, null]);
    expect(linkTimeline(report, { marks: [mark(1, mid(2)), mark(3, { chosen: 'k3h0e0' })], ratings }).ratings).toEqual(withMarks);
  });

  it('E-29 入力の並びは書き換えない', () => {
    const marks = [mark(3, mid(1)), mark(1, mid(0))];
    const ratings = [rate(2, mid(0)), rate(1)];
    const copy = structuredClone({ marks, ratings });
    linkTimeline(report, { marks, ratings });
    expect({ marks, ratings }).toEqual(copy);
  });
});

describe('E-29 FX-1 の5半荘と FX-4 での通し: 各局の迷い（読み取りが合う）と評価（読めない）から、迷いと評価の局を取り戻す', () => {
  /** その判断の時点の局・残りの牌の数・点数を、そのまま読み取りにした迷い。 */
  const readingOf = (d: Decision, playerId: number): CenterText => ({
    wind: d.board.roundWind as 'E' | 'S' | 'W',
    number: d.board.kyoku as 1 | 2 | 3 | 4,
    tilesLeft: d.entry.tiles_left,
    score: d.board.scores[playerId] as number,
  });

  /** 各局に、迷い2つ（最初と最後の判断。読み取りが合う）と、局の終わりに押した読めない評価（`forgotten` の局は押し忘れる）を、時間の順に作る。 */
  function build(id: string, forgotten: (position: number) => boolean) {
    const imported = importReport(loadReportJson(id));
    if (!imported.ok) throw new Error(imported.error.message);
    const { decisions, report: r, playerId } = imported.value;
    const marks: MarkIn[] = [];
    const ratings: RatingIn[] = [];
    const expectedMark = new Map<number, number>();
    const expectedRating = new Map<number, number>();
    let n = 0;
    r.review.kyokus.forEach((_, position) => {
      const own = decisions.filter((d) => d.kyokuPosition === position);
      for (const d of own.length >= 2 ? [own[0], own[own.length - 1]] : own) {
        if (!d) continue;
        n += 1;
        marks.push({ id: n, t_ms: BASE + n * 60_000, center: readingOf(d, playerId) });
        expectedMark.set(n, position);
      }
      n += 1;
      if (!forgotten(position)) {
        ratings.push({ id: n, t_ms: BASE + n * 60_000 });
        expectedRating.set(n, position);
      }
    });
    return { report: r, marks, ratings, expectedMark, expectedRating };
  }

  it('E-29 評価を毎局押したとき: 迷いも評価も、すべて正しい局に入る（本場違いで点数が同じ局が続いても、評価が区切る）', () => {
    let kyokusChecked = 0;
    for (const id of [...FX1_IDS, FX4_ID]) {
      const { report: r, marks, ratings, expectedMark, expectedRating } = build(id, () => false);
      const result = linkTimeline(r, { marks, ratings });
      for (const link of result.marks) expect(link.kyokuPosition, `${id} 迷い${link.mark.id}`).toBe(expectedMark.get(link.mark.id));
      for (const p of result.ratings.placements) expect(p.position, `${id} 評価${p.rating.id}`).toBe(expectedRating.get(p.rating.id));
      expect(result.ratings.placements.every((p) => p.unplaced === null)).toBe(true);
      // 迷いはどれも、局が決まる読み取りなので推定が付く。局が1つに決まる迷いは、E-17（linkMarks）と同じ推定
      expect(result.marks.every((m) => m.status === 'estimated')).toBe(true);
      const plain = linkMarks(r, marks);
      result.marks.forEach((link, i) => {
        if (plain[i]?.kyokuPositions.length === 1) expect(link.estimate?.key, `${id} 迷い${i + 1}`).toBe(plain[i]?.estimate?.key);
      });
      kyokusChecked += r.review.kyokus.length;
    }
    expect(kyokusChecked).toBe(12 + 13 + 11 + 16 + 15 + 5);
  });

  it('E-29 3局に1局の評価を押し忘れても、迷いが局を決めるので、押した評価は正しい局に入り、押し忘れた局は空欄になる（局が1つに決まる読み取りの半荘）', () => {
    let games = 0;
    for (const id of [...FX1_IDS, FX4_ID]) {
      const { report: r, marks, ratings, expectedMark, expectedRating } = build(id, (position) => position % 3 === 2);
      const ambiguous = linkMarks(r, marks).some((l) => l.kyokuPositions.length !== 1);
      const result = linkTimeline(r, { marks, ratings });
      // 本場違いで同じ点数の局が続く半荘は、評価の押し忘れで区切りが無くなると、どちらの局か決まらない（早い局になる）
      for (const link of result.marks) {
        if (ambiguous) expect(link.kyokuPositions, `${id} 迷い${link.mark.id}`).toContain(expectedMark.get(link.mark.id));
        else expect(link.kyokuPosition, `${id} 迷い${link.mark.id}`).toBe(expectedMark.get(link.mark.id));
      }
      if (ambiguous) continue;
      games++;
      for (const p of result.ratings.placements) expect(p.position, `${id} 評価${p.rating.id}`).toBe(expectedRating.get(p.rating.id));
      const forgottenKyokus = r.review.kyokus.map((_, i) => i).filter((i) => i % 3 === 2);
      expect(result.ratings.missingHands, id).toEqual(forgottenKyokus);
    }
    expect(games).toBeGreaterThanOrEqual(1);
  });
});
