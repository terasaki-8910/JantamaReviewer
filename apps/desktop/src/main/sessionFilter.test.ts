import type { Grade } from '@jantama/engine';
import { describe, expect, it } from 'vitest';

import {
  NO_FILTER,
  SEARCH_FIELDS,
  STAGES,
  clockLabel,
  dayKey,
  dayLabel,
  filterRows,
  filterSummary,
  groupByDay,
  isFiltering,
  matchesQuery,
  passesStage,
  type FilterRow,
  type ListFilter,
} from './sessionFilter';

const local = (y: number, mo: number, d: number, h = 0, mi = 0, s = 0) =>
  new Date(y, mo - 1, d, h, mi, s).getTime();

/** 試験の「いま」: 2026 年 10 月 9 日 22:00。 */
const NOW = local(2026, 10, 9, 22, 0);

interface Row extends FilterRow {
  id: string;
}

function row(
  id: string,
  startedMs: number,
  grade: Grade | null,
  ratingText: string | null,
  markCount: number,
  room: string | null,
): Row {
  return { id, startedMs, markCount, imported: grade !== null, room, grade, ratingText };
}

/** 承認済みの見本（8 回目のシート）と同じ 8 半荘。新しい順。 */
const SEED: Row[] = [
  row('g1', local(2026, 10, 9, 19, 9), 'S-', '93.0', 6, '玉の間・南'),
  row('g2', local(2026, 10, 8, 21, 40), 'S-', '91.9', 3, '玉の間・南'),
  row('g3', local(2026, 10, 8, 20, 55), 'A', '87.3', 0, '玉の間・南'),
  row('g4', local(2026, 10, 7, 22, 10), 'A+', '90.2', 2, '玉の間・南'),
  row('g5', local(2026, 10, 7, 21, 15), 'A-', '83.3', 0, '玉の間・南'),
  row('g6', local(2026, 10, 4, 20, 12), 'B+', '79.8', 1, '金の間・南'),
  row('g7', local(2026, 10, 4, 19, 30), 'B', '75.6', 0, '金の間・南'),
  row('g8', local(2026, 10, 2, 22, 48), 'C+', '66.2', 0, '金の間・南'),
];

const ids = (rows: Row[]) => rows.map((r) => r.id);
const find = (query: string, stage: ListFilter['stage'] = 'all') =>
  ids(filterRows(SEED, { query, stage }, NOW));

describe('U-8: 日付ごとの並べ方', () => {
  it('見出しは 本日・昨日・M月D日。新しい順の行を、日付ごとにまとめる', () => {
    const groups = groupByDay(SEED, NOW);
    expect(groups.map((g) => g.label)).toEqual(['本日', '昨日', '10月7日', '10月4日', '10月2日']);
    expect(groups.map((g) => ids(g.rows))).toEqual([['g1'], ['g2', 'g3'], ['g4', 'g5'], ['g6', 'g7'], ['g8']]);
  });

  it('今年でない日付は、年も付ける。同じ月日でも、年が違えば別のまとまり', () => {
    const rows = [
      { startedMs: local(2026, 1, 5, 10) },
      { startedMs: local(2025, 1, 5, 10) },
      { startedMs: local(2025, 1, 5, 9) },
    ];
    const groups = groupByDay(rows, NOW);
    expect(groups.map((g) => g.label)).toEqual(['1月5日', '2025年1月5日']);
    expect(groups.map((g) => g.rows.length)).toEqual([1, 2]);
    expect(dayKey(local(2026, 1, 5)) === dayKey(local(2025, 1, 5))).toBe(false);
  });

  it('日付の境目: 0 時ちょうどは本日、前の日の 23:59:59 は昨日、その前の日は M月D日', () => {
    expect(dayLabel(local(2026, 10, 9, 0, 0, 0), NOW)).toBe('本日');
    expect(dayLabel(local(2026, 10, 8, 23, 59, 59), NOW)).toBe('昨日');
    expect(dayLabel(local(2026, 10, 8, 0, 0, 0), NOW)).toBe('昨日');
    expect(dayLabel(local(2026, 10, 7, 23, 59, 59), NOW)).toBe('10月7日');
    // 月をまたぐ昨日
    expect(dayLabel(local(2026, 9, 30, 12), local(2026, 10, 1, 8))).toBe('昨日');
  });

  it('開始時刻は 19:09 の形（0 を付ける）', () => {
    expect(clockLabel(local(2026, 10, 9, 19, 9))).toBe('19:09');
    expect(clockLabel(local(2026, 10, 9, 9, 5))).toBe('09:05');
  });

  it('空の一覧は、まとまりも無い', () => {
    expect(groupByDay([], NOW)).toEqual([]);
  });
});

describe('U-12: 段階の絞り込み', () => {
  it('メニューは すべて / A 以下 / B 以下 / C 以下 で、範囲を添える', () => {
    expect(STAGES.map((s) => [s.label, s.range])).toEqual([
      ['すべて', 'S+〜E'],
      ['A 以下', 'A+〜E'],
      ['B 以下', 'B+〜E'],
      ['C 以下', 'C+〜E'],
    ]);
  });

  it('「A 以下」は A+ から下。B 以下は B+ から下、C 以下は C+ から下', () => {
    expect(find('', 'all')).toEqual(['g1', 'g2', 'g3', 'g4', 'g5', 'g6', 'g7', 'g8']);
    expect(find('', 'A')).toEqual(['g3', 'g4', 'g5', 'g6', 'g7', 'g8']);
    expect(find('', 'B')).toEqual(['g6', 'g7', 'g8']);
    expect(find('', 'C')).toEqual(['g8']);
  });

  it('段階ごとの境目: A 以下に S- は入らず A+ は入る。B 以下に A- は入らず B+ は入る。C 以下に B- は入らず C+ は入る', () => {
    expect(passesStage('S-', 'A')).toBe(false);
    expect(passesStage('A+', 'A')).toBe(true);
    expect(passesStage('E', 'A')).toBe(true);
    expect(passesStage('A-', 'B')).toBe(false);
    expect(passesStage('B+', 'B')).toBe(true);
    expect(passesStage('B-', 'C')).toBe(false);
    expect(passesStage('C+', 'C')).toBe(true);
    expect(passesStage('D', 'C')).toBe(true);
    expect(passesStage('S+', 'all')).toBe(true);
  });

  it('段階がまだ無い半荘（取り込み前・読み込み中）は、「すべて」のときだけ出る', () => {
    expect(passesStage(null, 'all')).toBe(true);
    for (const stage of ['A', 'B', 'C'] as const) expect(passesStage(null, stage)).toBe(false);
  });
});

describe('U-12: 検索（日付・卓・メモ）', () => {
  it('日付: 昨日・10月7日・10/7（全角でも）。本日・今日も当たる', () => {
    expect(find('昨日')).toEqual(['g2', 'g3']);
    expect(find('10月7日')).toEqual(['g4', 'g5']);
    expect(find('10/7')).toEqual(['g4', 'g5']);
    expect(find('１０／７')).toEqual(['g4', 'g5']);
    expect(find('本日')).toEqual(['g1']);
    expect(find('今日')).toEqual(['g1']);
    expect(find('10月')).toEqual(['g1', 'g2', 'g3', 'g4', 'g5', 'g6', 'g7', 'g8']);
  });

  it('卓: 玉の間・金の間', () => {
    expect(find('玉の間')).toEqual(['g1', 'g2', 'g3', 'g4', 'g5']);
    expect(find('金の間')).toEqual(['g6', 'g7', 'g8']);
    expect(find('南')).toHaveLength(8);
  });

  it('開始時刻・段階の文字・Rating・迷い', () => {
    expect(find('19:09')).toEqual(['g1']);
    expect(find('21:')).toEqual(['g2', 'g5']);
    expect(find('s-')).toEqual(['g1', 'g2']);
    expect(find('S-')).toEqual(['g1', 'g2']);
    expect(find('a+')).toEqual(['g4']);
    expect(find('93.0')).toEqual(['g1']);
    expect(find('迷い')).toEqual(['g1', 'g2', 'g4', 'g6']);
    expect(find('迷い3')).toEqual(['g2']);
  });

  it('空白で区切った語は、すべてに当たる（AND）。全角の空白でも区切る', () => {
    expect(find('昨日 玉の間')).toEqual(['g2', 'g3']);
    expect(find('昨日　迷い')).toEqual(['g2']);
    expect(find('昨日 金の間')).toEqual([]);
    expect(find('   ')).toHaveLength(8);
  });

  it('段階と合わせられる。見えない行は、検索の語が当たっても出ない', () => {
    expect(find('金の間', 'A')).toEqual(['g6', 'g7', 'g8']);
    expect(find('玉の間', 'A')).toEqual(['g3', 'g4', 'g5']);
    expect(find('玉の間', 'C')).toEqual([]);
    expect(find('zzz')).toEqual([]);
  });

  it('数字で始まる語は、別の数字の途中には当たらない（1月9日が 11月9日に、9:05 が 19:05 に当たらない）', () => {
    const rows: Row[] = [
      row('nov', local(2026, 11, 9, 19, 5), 'A', '80.0', 0, null),
      row('jan', local(2026, 1, 9, 9, 5), 'A', '80.0', 0, null),
    ];
    const run = (query: string) => ids(filterRows(rows, { query, stage: 'all' }, local(2026, 12, 20)));
    expect(run('1月9日')).toEqual(['jan']);
    expect(run('11月9日')).toEqual(['nov']);
    expect(run('9日')).toEqual(['nov', 'jan']);
    expect(run('9:05')).toEqual(['jan']);
    expect(run('09:05')).toEqual(['jan']);
    expect(run('19:05')).toEqual(['nov']);
    expect(run('1/9')).toEqual(['jan']);
    expect(run('01/09')).toEqual(['jan']);
  });

  it('今年でない日付は、年を付けても探せる', () => {
    const old = row('old', local(2025, 1, 1, 9, 0), 'B', '70.0', 0, '金の間・南');
    expect(matchesQuery(old, '2025年1月1日', NOW)).toBe(true);
    expect(matchesQuery(old, '2025/1/1', NOW)).toBe(true);
    expect(matchesQuery(old, '2026年1月1日', NOW)).toBe(false);
  });

  it('取り込み前の半荘は「取り込み前」で探せる。段階・Rating・卓の語には当たらない', () => {
    const pending = row('p', local(2026, 10, 9, 20, 0), null, null, 2, null);
    expect(matchesQuery(pending, '取り込み前', NOW)).toBe(true);
    expect(matchesQuery(pending, '迷い2', NOW)).toBe(true);
    expect(matchesQuery(pending, '玉の間', NOW)).toBe(false);
    expect(matchesQuery(pending, 's', NOW)).toBe(false);
    expect(matchesQuery(SEED[0] as Row, '取り込み前', NOW)).toBe(false);
  });

  it('メモの文字も探せる口がある（メモの欄ができたら、行の memo に入れるだけ）', () => {
    const memo: Row = { ...(SEED[2] as Row), memo: 'ピンフ崩れ 鳴きすぎ' };
    expect(matchesQuery(memo, 'ピンフ', NOW)).toBe(true);
    expect(matchesQuery(memo, '鳴きすぎ 昨日', NOW)).toBe(true);
    expect(matchesQuery(SEED[2] as Row, 'ピンフ', NOW)).toBe(false);
    expect(SEARCH_FIELDS.length).toBeGreaterThanOrEqual(8);
  });
});

describe('U-12: 件数と「解除」の行', () => {
  it('絞り込みの言葉: 「A 以下 6件」「「玉の間」 5件」「A 以下 · 「金の間」 3件」', () => {
    expect(filterSummary({ query: '', stage: 'A' }, 6)).toBe('A 以下 6件');
    expect(filterSummary({ query: '玉の間', stage: 'all' }, 5)).toBe('「玉の間」 5件');
    expect(filterSummary({ query: ' 金の間 ', stage: 'A' }, 3)).toBe('A 以下 · 「金の間」 3件');
    expect(filterSummary({ query: 'zzz', stage: 'B' }, 0)).toBe('B 以下 · 「zzz」 0件');
  });

  it('かかっているかの判断: 段階が「すべて」以外、または検索の語が空白以外を含む', () => {
    expect(isFiltering(NO_FILTER)).toBe(false);
    expect(isFiltering({ query: '  　', stage: 'all' })).toBe(false);
    expect(isFiltering({ query: '昨日', stage: 'all' })).toBe(true);
    expect(isFiltering({ query: '', stage: 'C' })).toBe(true);
  });
});
