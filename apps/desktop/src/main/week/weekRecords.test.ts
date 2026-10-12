/**
 * 週の成績（手入力）と来週の重点（ACCEPTANCE の U-30）の、入力の読み取り・確かめの単体試験。
 * 保存（SQLite）は src-tauri の study の試験、画面からの入力・保存・復元は WeekPage.test.tsx が確かめる。
 */
import { describe, expect, it } from 'vitest';

import type { WeekRecord } from '../../api/types';
import {
  FOCUS_MAX_LINES,
  FOCUS_MAX_LINE_CHARS,
  STAT_FIELDS,
  parseFocus,
  parseStat,
  statText,
  withFocus,
  withStat,
} from './weekRecords';

const field = (key: string) => STAT_FIELDS.find((f) => f.key === key) as (typeof STAT_FIELDS)[number];

describe('U-30 成績（手入力）の項目', () => {
  it('4位率・放銃率・平均順位・和了率・副露率・立直率の 6 つ。率は %、平均順位は位', () => {
    expect(STAT_FIELDS.map((f) => [f.key, f.label, f.unit])).toEqual([
      ['rank4', '4位率', '%'],
      ['deal', '放銃率', '%'],
      ['avg', '平均順位', '位'],
      ['win', '和了率', '%'],
      ['call', '副露率', '%'],
      ['riichi', '立直率', '%'],
    ]);
  });

  it('数を読み取る: 空は「入れていない」、全角の数字も、前後の空白も受ける。小数は 2 桁まで', () => {
    expect(parseStat('', field('rank4'))).toEqual({ ok: true, value: null });
    expect(parseStat('   ', field('rank4'))).toEqual({ ok: true, value: null });
    expect(parseStat('20.4', field('rank4'))).toEqual({ ok: true, value: 20.4 });
    expect(parseStat(' 2.41 ', field('avg'))).toEqual({ ok: true, value: 2.41 });
    expect(parseStat('２０．４', field('rank4'))).toEqual({ ok: true, value: 20.4 });
    expect(parseStat('0', field('rank4'))).toEqual({ ok: true, value: 0 });
    expect(parseStat('100', field('rank4'))).toEqual({ ok: true, value: 100 });
    expect(parseStat('1', field('avg'))).toEqual({ ok: true, value: 1 });
    expect(parseStat('4', field('avg'))).toEqual({ ok: true, value: 4 });
    expect(parseStat('20.', field('rank4')).ok).toBe(false);
  });

  it('数でない・範囲の外・小数が 3 桁以上は、理由つきで断る', () => {
    for (const bad of ['abc', '20,4', '-1', '+5', '1e2', '20.456', '20%', '二十', 'NaN', 'Infinity', '0x10']) {
      const result = parseStat(bad, field('rank4'));
      expect(result.ok, bad).toBe(false);
      expect(!result.ok && result.message).toContain('4位率');
    }
    const high = parseStat('100.5', field('rank4'));
    expect(!high.ok && high.message).toBe('4位率は、0 から 100 の数で入れてください');
    expect(parseStat('0.9', field('avg')).ok).toBe(false);
    expect(parseStat('4.01', field('avg')).ok).toBe(false);
    const avg = parseStat('5', field('avg'));
    expect(!avg.ok && avg.message).toBe('平均順位は、1 から 4 の数で入れてください');
  });

  it('保存してある数を、入力欄の文字にする（率は小数 1 桁、平均順位は 2 桁）', () => {
    expect(statText(20.4, field('rank4'))).toBe('20.4');
    expect(statText(20, field('rank4'))).toBe('20.0');
    expect(statText(2.4, field('avg'))).toBe('2.40');
    expect(statText(undefined, field('avg'))).toBe('');
  });
});

describe('U-30 来週の重点（1〜3 行。任意）', () => {
  it('空の行と、行の前後の空白を除く。空は「書いていない」', () => {
    expect(parseFocus('')).toEqual({ ok: true, value: '' });
    expect(parseFocus(' \n  \n')).toEqual({ ok: true, value: '' });
    expect(parseFocus('  受け入れを数える。 \r\n\r\n 押し引きは現物から。\n')).toEqual({
      ok: true,
      value: '受け入れを数える。\n押し引きは現物から。',
    });
  });

  it('4 行目・1 行が 101 文字を超えるときは、断る（3 行と 100 文字は通る）', () => {
    expect(FOCUS_MAX_LINES).toBe(3);
    expect(FOCUS_MAX_LINE_CHARS).toBe(100);
    expect(parseFocus('a\nb\nc').ok).toBe(true);
    const four = parseFocus('a\nb\nc\nd');
    expect(!four.ok && four.message).toBe('重点は 3 行までです');
    expect(parseFocus('あ'.repeat(100)).ok).toBe(true);
    const long = parseFocus('あ'.repeat(101));
    expect(!long.ok && long.message).toBe('重点の 1 行は 100 文字までです');
  });
});

describe('U-30 記録の作り方（1 項目だけ替える）', () => {
  const current: WeekRecord = { week: '2026-10-05', stats: { rank4: 20.4, avg: 2.41 }, focus: '重点' };

  it('成績の 1 項目を替える・消す。ほかの成績と重点は、そのまま', () => {
    expect(withStat(current, '2026-10-05', 'win', 22.1)).toEqual({
      week: '2026-10-05',
      stats: { rank4: 20.4, avg: 2.41, win: 22.1 },
      focus: '重点',
    });
    expect(withStat(current, '2026-10-05', 'rank4', null)).toEqual({ week: '2026-10-05', stats: { avg: 2.41 }, focus: '重点' });
    // 元の記録は書き換えない
    expect(current.stats).toEqual({ rank4: 20.4, avg: 2.41 });
    // 記録が無い週にも作れる
    expect(withStat(undefined, '2026-10-12', 'deal', 11.6)).toEqual({ week: '2026-10-12', stats: { deal: 11.6 }, focus: '' });
  });

  it('重点を替える。成績は、そのまま', () => {
    expect(withFocus(current, '2026-10-05', '新しい重点')).toEqual({
      week: '2026-10-05',
      stats: { rank4: 20.4, avg: 2.41 },
      focus: '新しい重点',
    });
    expect(withFocus(undefined, '2026-10-12', 'a')).toEqual({ week: '2026-10-12', stats: {}, focus: 'a' });
  });
});
