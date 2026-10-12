/**
 * 週の集計（ACCEPTANCE の U-30、R11-12）の数え方の単体試験。作った答え・半荘から出した数が、手で数えた値と一致することを確かめる。
 * 画面（切り替え・図・吹き出し・「表で見る」・空の週・入力）は WeekPage.test.tsx、実ブラウザでの見え方は tests/browser/week.browser.test.ts。
 */
import { describe, expect, it } from 'vitest';

import type { LogPhase } from '../log/logModel';
import {
  CAUSES,
  RESULTS,
  WEEK_COUNT,
  loseMean,
  monthDayText,
  monthDayWeekdayText,
  percentSparkRange,
  resultOf,
  sharedCauseMax,
  slashText,
  summarizeWeeks,
  valueSparkRange,
  weekBounds,
  weekNameText,
  weekOfInstant,
  weekRangeText,
  weeksEndingAt,
  type ResultId,
  type WeekAnswer,
  type WeekEvaluation,
  type WeekSource,
} from './weekModel';

const local = (y: number, mo: number, d: number, h = 0, mi = 0) => new Date(y, mo - 1, d, h, mi, 0).getTime();

describe('U-30 週の区切り（月曜から日曜。日の区切りは午前 4 時。検討ログと同じ）', () => {
  it('月曜の午前 3 時 59 分は、前の週（日曜の続き）。午前 4 時から、その月曜の週', () => {
    expect(weekOfInstant(local(2026, 10, 12, 3, 59))).toBe('2026-10-05');
    expect(weekOfInstant(local(2026, 10, 12, 4, 0))).toBe('2026-10-12');
    expect(weekOfInstant(local(2026, 10, 12, 0, 0))).toBe('2026-10-05');
    expect(weekOfInstant(local(2026, 10, 12, 23, 59))).toBe('2026-10-12');
  });

  it('日曜の終わり・火曜から日曜まで、同じ週。月曜の午前 4 時で替わる', () => {
    for (const day of [5, 6, 7, 8, 9, 10, 11]) {
      expect(weekOfInstant(local(2026, 10, day, 12, 0)), `10/${day}`).toBe('2026-10-05');
    }
    expect(weekOfInstant(local(2026, 10, 11, 23, 59))).toBe('2026-10-05');
    expect(weekOfInstant(local(2026, 10, 5, 3, 59))).toBe('2026-09-28');
    expect(weekOfInstant(local(2026, 10, 5, 4, 0))).toBe('2026-10-05');
  });

  it('年をまたぐ週: 2025-12-29（月）の週は 2026-01-04（日）まで。2026-01-05 の午前 3 時 59 分は、まだ 12-29 の週', () => {
    expect(weekOfInstant(local(2025, 12, 31, 12, 0))).toBe('2025-12-29');
    expect(weekOfInstant(local(2026, 1, 1, 12, 0))).toBe('2025-12-29');
    expect(weekOfInstant(local(2026, 1, 4, 23, 59))).toBe('2025-12-29');
    expect(weekOfInstant(local(2026, 1, 5, 3, 59))).toBe('2025-12-29');
    expect(weekOfInstant(local(2026, 1, 5, 4, 0))).toBe('2026-01-05');
    // 元日の午前 3 時 59 分は、前の年の 12 月 31 日の続き
    expect(weekOfInstant(local(2026, 1, 1, 3, 59))).toBe('2025-12-29');
    expect(weekOfInstant(local(2025, 12, 28, 23, 59))).toBe('2025-12-22');
    // うるう日
    expect(weekOfInstant(local(2024, 2, 29, 12, 0))).toBe('2024-02-26');
  });

  it('直近 8 週の月曜（古い順）。年をまたいでも、7 日ずつ', () => {
    expect(WEEK_COUNT).toBe(8);
    expect(weeksEndingAt('2026-10-05')).toEqual([
      '2026-08-17',
      '2026-08-24',
      '2026-08-31',
      '2026-09-07',
      '2026-09-14',
      '2026-09-21',
      '2026-09-28',
      '2026-10-05',
    ]);
    expect(weeksEndingAt('2026-01-05', 3)).toEqual(['2025-12-22', '2025-12-29', '2026-01-05']);
  });

  it('週の名前・範囲の言い方（見本のとおり）', () => {
    expect(weekRangeText('2026-10-05')).toBe('10月5日（月）〜10月11日（日）');
    expect(weekRangeText('2025-12-29')).toBe('12月29日（月）〜1月4日（日）');
    expect(weekNameText('2026-10-05')).toBe('10月5日の週');
    expect(monthDayText('2026-01-05')).toBe('1月5日');
    expect(monthDayWeekdayText('2026-10-11')).toBe('10月11日（日）');
    expect(slashText('2026-08-17')).toBe('8/17');
  });

  it('週の ← → の範囲: 新しい側は今週まで。古い側は、記録のあるいちばん古い週まで（記録が今週だけなら、先週まで）', () => {
    expect(weekBounds('2026-10-05', '2026-08-17')).toEqual({ min: '2026-08-17', max: '2026-10-05' });
    expect(weekBounds('2026-10-05', '2026-10-05')).toEqual({ min: '2026-09-28', max: '2026-10-05' });
    expect(weekBounds('2026-10-05', null)).toEqual({ min: '2026-09-28', max: '2026-10-05' });
    expect(weekBounds('2026-10-05', '2026-09-28')).toEqual({ min: '2026-09-28', max: '2026-10-05' });
  });
});

const answer = (week: string, patch: Partial<WeekAnswer> = {}): WeekAnswer => ({
  week,
  mode: 'quiz',
  correct: true,
  causes: [],
  phases: ['1シャンテン'],
  ...patch,
});

const evaluation = (week: string, result: ResultId, offset: number): WeekEvaluation => ({ week, result, offset });

const source = (patch: Partial<WeekSource>): WeekSource => ({ answers: [], evaluations: [], marks: [], games: [], ...patch });

const W = '2026-10-05';
const PREV = '2026-09-28';

describe('U-30 今週の数・差の原因の割合（局面に対する割合。2 つ付いた局面は両方に数える）', () => {
  it('答えた局面（出題・解き直し）・正解率は、その週の答えだけから数える', () => {
    const s = summarizeWeeks(
      [PREV, W],
      source({
        answers: [
          answer(W, { mode: 'quiz', correct: true }),
          answer(W, { mode: 'quiz', correct: false }),
          answer(W, { mode: 'review', correct: true }),
          answer(W, { mode: 'review', correct: true }),
          answer(PREV, { mode: 'quiz', correct: false }),
        ],
      }),
    );
    const week = s.get(W);
    expect(week?.answers).toBe(4);
    expect([week?.quiz, week?.review]).toEqual([2, 2]);
    expect(week?.correct).toBe(3);
    expect(week?.correctPercent).toBe(75);
    expect(s.get(PREV)?.answers).toBe(1);
    expect(s.get(PREV)?.correctPercent).toBe(0);
  });

  it('原因の割合は、答えた局面に対して。2 つ付いた局面は両方に数えるので、合計が 100% を超える', () => {
    // 10 局面: 受け入れ 6（うち 3 つは形も）、打点 2、守備 1、何も付かない 3 ... 合計 12 件の原因が 10 局面に付く
    const causes: string[][] = [
      ['ukeire', 'shape'],
      ['ukeire', 'shape'],
      ['ukeire', 'shape'],
      ['ukeire'],
      ['ukeire'],
      ['ukeire'],
      ['value'],
      ['value'],
      ['defense'],
      [],
    ];
    const s = summarizeWeeks([W], source({ answers: causes.map((c) => answer(W, { causes: c })) })).get(W);
    expect(s?.answers).toBe(10);
    expect(s?.causeCounts).toEqual({ ukeire: 6, shape: 3, value: 2, defense: 1, other: 0 });
    expect(s?.causePercents).toEqual({ ukeire: 60, shape: 30, value: 20, defense: 10, other: 0 });
    const total = Object.values(s?.causePercents ?? {}).reduce((sum, p) => sum + p, 0);
    expect(total).toBe(120);
    expect(total).toBeGreaterThan(100);
  });

  it('割合は四捨五入（1/3 は 33%、2/3 は 67%）。原因が付いていない局面も、分母に入る', () => {
    const s = summarizeWeeks(
      [W],
      source({ answers: [answer(W, { causes: ['ukeire'] }), answer(W, { causes: ['ukeire'] }), answer(W, { causes: [] }), answer(W)] }),
    ).get(W);
    expect(s?.causePercents?.ukeire).toBe(50);
    const third = summarizeWeeks(
      [W],
      source({ answers: [answer(W, { causes: ['shape'] }), answer(W), answer(W)] }),
    ).get(W);
    expect(third?.causePercents?.shape).toBe(33);
    const twoThirds = summarizeWeeks([W], source({ answers: [answer(W, { causes: ['shape'] }), answer(W, { causes: ['shape'] }), answer(W)] })).get(W);
    expect(twoThirds?.causePercents?.shape).toBe(67);
  });

  it('同じ原因が 1 つの局面に 2 回入っていても、1 回だけ数える。知らない原因は数えない', () => {
    const s = summarizeWeeks([W], source({ answers: [answer(W, { causes: ['ukeire', 'ukeire', 'nothing'] })] })).get(W);
    expect(s?.causeCounts).toEqual({ ukeire: 1, shape: 0, value: 0, defense: 0, other: 0 });
    expect(s?.causePercents?.ukeire).toBe(100);
  });

  it('答えの無い週は、割合も正解率も null（0% ではない）。数は 0', () => {
    const s = summarizeWeeks([W], source({})).get(W);
    expect(s?.answers).toBe(0);
    expect(s?.correctPercent).toBeNull();
    expect(s?.causePercents).toBeNull();
    expect(s?.causeCounts).toEqual({ ukeire: 0, shape: 0, value: 0, defense: 0, other: 0 });
    expect(s?.agreePercent).toBeNull();
    expect(s?.phases.every((p) => p.n === 0 && p.rate === null)).toBe(true);
    expect(s?.results.every((r) => r.n === 0 && r.mean === null)).toBe(true);
  });

  it('原因の一覧は、答え合わせの画面と同じ 5 つ。種類の一覧は、検討ログの絞り込みと同じ 6 つ', () => {
    expect(CAUSES.map((c) => c.label)).toEqual(['受け入れ枚数', '形の質', '打点', '守備', 'その他']);
    const s = summarizeWeeks([W], source({})).get(W);
    expect(s?.phases.map((p) => p.id)).toEqual(['2シャンテン以上', '1シャンテン', '聴牌', '鳴き', '押し引き', '序盤']);
  });
});

describe('U-30 局面の種類（重なる。正解率は種類ごと）', () => {
  it('1 つの局面が 2 つの種類に当たるときは、両方に数える。正解率は、その種類の局面のうちの正解', () => {
    const phases = (...p: LogPhase[]) => p;
    const s = summarizeWeeks(
      [W],
      source({
        answers: [
          answer(W, { phases: phases('1シャンテン', '序盤'), correct: true }),
          answer(W, { phases: phases('1シャンテン', '序盤'), correct: false }),
          answer(W, { phases: phases('2シャンテン以上'), correct: true }),
          answer(W, { phases: phases('聴牌', '鳴き'), correct: true }),
          answer(W, { phases: phases('1シャンテン', '押し引き'), correct: false }),
        ],
      }),
    ).get(W);
    const row = (id: LogPhase) => s?.phases.find((p) => p.id === id);
    expect([row('2シャンテン以上')?.n, row('2シャンテン以上')?.rate]).toEqual([1, 100]);
    expect([row('1シャンテン')?.n, row('1シャンテン')?.correct, row('1シャンテン')?.rate]).toEqual([3, 1, 33]);
    expect([row('聴牌')?.n, row('聴牌')?.rate]).toEqual([1, 100]);
    expect([row('鳴き')?.n, row('鳴き')?.rate]).toEqual([1, 100]);
    expect([row('押し引き')?.n, row('押し引き')?.rate]).toEqual([1, 0]);
    expect([row('序盤')?.n, row('序盤')?.rate]).toEqual([2, 50]);
    // 種類の数の合計は、局面の数を超えうる
    expect(s?.phases.reduce((sum, p) => sum + p.n, 0)).toBe(9);
  });
});

describe('U-30 一致率と結果ごとのずれ（自分の〇△✕ と AI 基準。エンジンの帯の規則）', () => {
  it('一致 = ずれが 0 の局。一致率は一致した局 / 比べた局。結果ごとに、ずれの平均（局数つき）', () => {
    const s = summarizeWeeks(
      [W],
      source({
        evaluations: [
          evaluation(W, 'win', 0),
          evaluation(W, 'win', 1),
          evaluation(W, 'dealIn', -2),
          evaluation(W, 'dealIn', -1),
          evaluation(W, 'dealIn', 0),
          evaluation(W, 'draw', 0),
          evaluation(W, 'others', -1),
          evaluation(W, 'others', -2),
          evaluation(W, 'others', 0),
          evaluation(W, 'others', 0),
        ],
      }),
    ).get(W);
    expect(s?.evaluated).toBe(10);
    expect(s?.agreed).toBe(5);
    expect(s?.agreePercent).toBe(50);
    expect(s?.results.map((r) => [r.id, r.label, r.n])).toEqual([
      ['win', '自分の和了', 2],
      ['dealIn', '放銃', 3],
      ['draw', '流局', 1],
      ['others', '他家の和了', 4],
    ]);
    expect(s?.results.map((r) => r.mean)).toEqual([0.5, -1, 0, -0.75]);
  });

  it('和了できなかった局（放銃・他家の和了）のずれは、局数で重みを付けた平均', () => {
    const s = summarizeWeeks(
      [W],
      source({
        evaluations: [
          evaluation(W, 'dealIn', -2),
          evaluation(W, 'dealIn', -1),
          evaluation(W, 'others', -1),
          evaluation(W, 'others', 0),
          evaluation(W, 'others', 0),
          evaluation(W, 'win', 2),
          evaluation(W, 'draw', -2),
        ],
      }),
    ).get(W);
    const lose = loseMean(s as NonNullable<typeof s>);
    expect(lose?.n).toBe(5);
    expect(lose?.mean).toBeCloseTo(-0.8, 10);
    // 比べた局が無い週・和了できなかった局が無い週は、null
    expect(loseMean(summarizeWeeks([W], source({})).get(W) as never)).toBeNull();
    expect(loseMean(summarizeWeeks([W], source({ evaluations: [evaluation(W, 'win', 1)] })).get(W) as never)).toBeNull();
  });

  it('別の週の評価は、その週に数えない。点の図の 4 行は、いつも自分の和了・放銃・流局・他家の和了の順', () => {
    const s = summarizeWeeks([PREV, W], source({ evaluations: [evaluation(PREV, 'win', 1)] }));
    expect(s.get(W)?.evaluated).toBe(0);
    expect(s.get(PREV)?.evaluated).toBe(1);
    expect(RESULTS.map((r) => r.label)).toEqual(['自分の和了', '放銃', '流局', '他家の和了']);
  });

  it('局の結果の分類: 他家のツモも、他家どうしのロンも「他家の和了」', () => {
    expect([resultOf('win'), resultOf('dealIn'), resultOf('draw'), resultOf('othersTsumo'), resultOf('othersRon')]).toEqual([
      'win',
      'dealIn',
      'draw',
      'others',
      'others',
    ]);
  });
});

describe('U-30 迷いマーク・半荘の数', () => {
  it('迷いマークは押した週、半荘は始めた週で数える。「答えたもの」は、答えのある迷い', () => {
    const s = summarizeWeeks(
      [PREV, W],
      source({
        marks: [
          { week: W, answered: true },
          { week: W, answered: true },
          { week: W, answered: false },
          { week: PREV, answered: false },
        ],
        games: [W, W, PREV],
      }),
    );
    expect([s.get(W)?.marks, s.get(W)?.marksAnswered, s.get(W)?.games]).toEqual([3, 2, 2]);
    expect([s.get(PREV)?.marks, s.get(PREV)?.marksAnswered, s.get(PREV)?.games]).toEqual([1, 0, 1]);
  });
});

describe('U-30 小さな図の縦の範囲', () => {
  const sums = (percents: number[]) =>
    summarizeWeeks(
      percents.map((_, i) => `2026-0${i + 1}-05`),
      source({}),
    );

  it('原因の割合の縦軸は、ふだん 0〜60%。60% を超える週があれば 80%、80% を超えれば 100%（5 つの図で同じ）', () => {
    const make = (top: number) =>
      [...sums([0]).values()].map((s) => ({ ...s, causePercents: { ukeire: top, shape: 10, value: 5, defense: 0, other: 0 } }));
    expect(sharedCauseMax(make(38))).toBe(60);
    expect(sharedCauseMax(make(60))).toBe(60);
    expect(sharedCauseMax(make(61))).toBe(80);
    expect(sharedCauseMax(make(80))).toBe(80);
    expect(sharedCauseMax(make(81))).toBe(100);
    expect(sharedCauseMax([...sums([0]).values()])).toBe(60);
  });

  it('一致率の線の範囲は、値の上下に 6 ずつ（0〜100 の中）。値が無ければ 0〜100', () => {
    expect(percentSparkRange([60, null, 71, 64])).toEqual({ min: 54, max: 77 });
    expect(percentSparkRange([2, 98])).toEqual({ min: 0, max: 100 });
    expect(percentSparkRange([null, null])).toEqual({ min: 0, max: 100 });
  });

  it('成績の線の範囲は、値の幅の 3 割を上下に足す。1 つだけ・全部同じなら、その値の前後', () => {
    const r = valueSparkRange([20, null, 22, 21], 1);
    expect(r.min).toBeCloseTo(19.4, 10);
    expect(r.max).toBeCloseTo(22.6, 10);
    expect(valueSparkRange([20.4], 1)).toEqual({ min: 19.4, max: 21.4 });
    const flat = valueSparkRange([2.4, 2.4], 0.05);
    expect(flat.min).toBeCloseTo(2.35, 10);
    expect(flat.max).toBeCloseTo(2.45, 10);
    expect(valueSparkRange([null, null], 1)).toEqual({ min: 0, max: 1 });
  });
});
