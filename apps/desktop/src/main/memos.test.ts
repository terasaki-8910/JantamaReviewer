/**
 * 終局直後のメモ（F4、U-28）の、画面に依存しない決まりの試験: 空のメモの扱い・追加のメモの名前・問題（判断の鍵）に結びつくメモを探す。
 */
import { parseReportText, type MortalReport } from '@jantama/engine';
import { describe, expect, it } from 'vitest';

import { FX4_TEXT, fx4Ocr, fx4Session } from '../../tests/import-fixtures';
import type { Memos } from '../api/types';
import { resolveMarks } from './markCards';
import { memoOfMark, memosForDecision, nextExtraId, normalizeMemo, sameMemo } from './memos';

const parsed = parseReportText(FX4_TEXT);
if (!parsed.ok) throw new Error(parsed.error.message);
const report: MortalReport = parsed.value;

describe('U-28 メモの値', () => {
  it('前後の空白を除く。「候補」も「理由」も空なら、メモは無い（undefined）', () => {
    expect(normalizeMemo({ candidates: ' 3m・6p ', reason: '　形　' })).toEqual({ candidates: '3m・6p', reason: '形' });
    expect(normalizeMemo({ candidates: '', reason: '理由だけ' })).toEqual({ candidates: '', reason: '理由だけ' });
    expect(normalizeMemo({ candidates: '  ', reason: '\t' })).toBeUndefined();
    expect(normalizeMemo(undefined)).toBeUndefined();
  });

  it('同じメモか: 前後の空白は無いものとして比べる。空のメモと無いメモは同じ', () => {
    expect(sameMemo({ candidates: '3m ', reason: '' }, { candidates: '3m', reason: '' })).toBe(true);
    expect(sameMemo({ candidates: '3m', reason: '' }, { candidates: '3m', reason: 'a' })).toBe(false);
    expect(sameMemo(undefined, { candidates: '', reason: ' ' })).toBe(true);
    expect(sameMemo(undefined, { candidates: '3m', reason: '' })).toBe(false);
    expect(sameMemo(undefined, undefined)).toBe(true);
  });

  it('迷いマークのメモは、記録の番号（10 進の文字列）で引く', () => {
    const memos: Memos = { marks: { '4': { candidates: '3m', reason: '' } }, extras: [] };
    expect(memoOfMark(memos, 4)).toEqual({ candidates: '3m', reason: '' });
    expect(memoOfMark(memos, 3)).toBeUndefined();
  });

  it('追加のメモの次の名前: いまある x の番号の最大に 1 足す（空なら x1）。形の違う名前は数えない', () => {
    expect(nextExtraId([])).toBe('x1');
    const extra = (id: string) => ({ id, decision: 'k0h0e0', candidates: '', reason: '' });
    expect(nextExtraId([extra('x1'), extra('x3')])).toBe('x4');
    expect(nextExtraId([extra('x2'), extra('other'), extra('x10b')])).toBe('x3');
  });
});

describe('U-28 問題（判断の鍵）に結びつくメモ（FX-4）', () => {
  // FX-4: 迷い 1〜5 の推定は、ユーザーが選び直した判断と同じ（k0h0e4・k1h0e12・k1h1e7・k1h1e10・k2h1e6）。迷い 6 は局だけ分かった迷い
  const session = fx4Session('20261009-190953', 0, { ocr: fx4Ocr(), links: { marks: {}, ratings: {} } });
  const resolved = resolveMarks(report, session);
  const keyOf = (index: number): string => {
    const resolution = resolved[index]?.resolution;
    if (resolution?.kind !== 'linked') throw new Error(`迷い${index + 1}は判断に結びついていない`);
    return resolution.ref.key;
  };

  it('その判断に結びついた迷い（推定でもよい）のメモを出す。名前は「迷いN」', () => {
    const memos: Memos = { marks: { '3': { candidates: '南・6m', reason: '東を残したい' } }, extras: [] };
    expect(memosForDecision({ memos, resolved, decisionKey: keyOf(2) })).toEqual([
      { source: 'mark', label: '迷い3', memo: { candidates: '南・6m', reason: '東を残したい' } },
    ]);
  });

  it('ほかの判断・メモの無い迷い・空のメモには、出さない', () => {
    const memos: Memos = { marks: { '3': { candidates: '南・6m', reason: '' }, '4': { candidates: ' ', reason: '' } }, extras: [] };
    expect(memosForDecision({ memos, resolved, decisionKey: keyOf(0) })).toEqual([]);
    expect(memosForDecision({ memos, resolved, decisionKey: keyOf(3) })).toEqual([]);
    expect(memosForDecision({ memos: { marks: {}, extras: [] }, resolved, decisionKey: keyOf(2) })).toEqual([]);
  });

  it('迷いマークの無い迷いのメモは、その判断の鍵で出す（足した順）。迷いのメモのあとに並ぶ。空のメモは出さない', () => {
    const key = keyOf(2);
    const memos: Memos = {
      marks: { '3': { candidates: 'a', reason: '' } },
      extras: [
        { id: 'x1', decision: key, candidates: '', reason: '押した' },
        { id: 'x2', decision: 'k9h9e9', candidates: 'ほか', reason: '' },
        { id: 'x3', decision: key, candidates: '', reason: '' },
        { id: 'x4', decision: key, candidates: 'b', reason: '' },
      ],
    };
    expect(memosForDecision({ memos, resolved, decisionKey: key }).map((m) => `${m.source}:${m.label}:${m.memo.candidates}|${m.memo.reason}`)).toEqual([
      'mark:迷い3:a|',
      'extra:追加のメモ:|押した',
      'extra:追加のメモ:b|',
    ]);
  });

  it('局だけ分かった迷い（迷い 6。判断が決まっていない）のメモは、どの問題にも出ない', () => {
    expect(resolved[5]?.resolution.kind).toBe('kyoku');
    const memos: Memos = { marks: { '6': { candidates: 'x', reason: 'y' } }, extras: [] };
    for (let index = 0; index < 5; index += 1) {
      expect(memosForDecision({ memos, resolved, decisionKey: keyOf(index) })).toEqual([]);
    }
  });

  it('同じ判断に迷いが 2 つ結びつくときは、迷いの番号の順に両方出す', () => {
    const doubled = fx4Session('20261009-190953', 0, {
      ocr: fx4Ocr(),
      links: { marks: { '1': keyOf(2), '3': keyOf(2) }, ratings: {} },
    });
    const both = resolveMarks(report, doubled);
    const memos: Memos = { marks: { '3': { candidates: 'c3', reason: '' }, '1': { candidates: 'c1', reason: '' } }, extras: [] };
    expect(memosForDecision({ memos, resolved: both, decisionKey: keyOf(2) }).map((m) => m.label)).toEqual(['迷い1', '迷い3']);
  });
});
