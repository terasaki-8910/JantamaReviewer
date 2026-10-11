/**
 * 終局直後のメモ（F4、U-28）の、画面に依存しない決まりの試験: 空のメモの扱い・追加のメモの名前・問題（判断の鍵）に結びつくメモを探す。
 */
import { listDecisionRefs, parseReportText, type DecisionRef, type MortalReport } from '@jantama/engine';
import { describe, expect, it } from 'vitest';

import { REPORT_TEXTS } from '../../tests/fake-sessions';
import { FX4_TEXT, fx4Ocr, fx4Session } from '../../tests/import-fixtures';
import type { ExtraMemo, Memos } from '../api/types';
import { resolveMarks } from './markCards';
import {
  autoLinkTarget,
  decisionsNearPosition,
  memoOfMark,
  memosForDecision,
  nextExtraId,
  normalizeMemo,
  parseWhole,
  placeOf,
  placePickLabels,
  positionText,
  sameMemo,
} from './memos';

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

describe('U-28 位置（局・本場・巡目）の呼び名と入力', () => {
  it('位置の呼び名: 局の名前（本場があれば付ける）と巡目', () => {
    expect(positionText({ kyoku: 2, honba: 0, junme: 9 })).toBe('東3局 9巡目');
    expect(positionText({ kyoku: 1, honba: 1, junme: 6 })).toBe('東2局1本場 6巡目');
    expect(positionText({ kyoku: 7, honba: 0, junme: 18 })).toBe('南4局 18巡目');
    expect(positionText({ kyoku: 8, honba: 2, junme: 1 })).toBe('西1局2本場 1巡目');
  });

  it('入力欄の文字は、範囲の中の整数だけ受け付ける（空・小数・符号・範囲の外・数でないものは null）', () => {
    expect(parseWhole('9', 1, 30)).toBe(9);
    expect(parseWhole(' 30 ', 1, 30)).toBe(30);
    expect(parseWhole('0', 0, 99)).toBe(0);
    for (const bad of ['', ' ', '0', '31', '1.5', '-1', '+3', '1e1', 'あ', '1000']) {
      expect(parseWhole(bad, 1, 30), bad).toBeNull();
    }
    expect(parseWhole('100', 0, 99)).toBeNull();
  });

  it('保存するときの局面は、あるものだけ（判断の鍵・位置）を持つ', () => {
    const base = { id: 'x1', candidates: '', reason: '' };
    const position = { kyoku: 2, honba: 0, junme: 9 };
    expect(placeOf({ ...base, decision: 'k2h0e5' })).toEqual({ decision: 'k2h0e5' });
    expect(placeOf({ ...base, position })).toEqual({ position });
    expect(Object.keys(placeOf({ ...base, position }))).toEqual(['position']);
    expect(placeOf({ ...base, decision: 'k2h0e5', position })).toEqual({ decision: 'k2h0e5', position });
  });
});

describe('U-28 位置だけのメモを判断に結びつける（FX-5）', () => {
  const fx5 = parseReportText(REPORT_TEXTS.fx5);
  if (!fx5.ok) throw new Error(fx5.error.message);
  const decisions: DecisionRef[] = listDecisionRefs(fx5.value);
  const extra = (position: { kyoku: number; honba: number; junme: number }, rest: Partial<ExtraMemo> = {}): ExtraMemo => ({
    id: 'x1',
    position,
    candidates: '',
    reason: '',
    ...rest,
  });
  const keys = (refs: readonly DecisionRef[]) => refs.map((ref) => ref.key);

  it('局・本場・巡目に自分の判断がちょうど 1 つあれば、自動で結びつける判断になる（東2局 5巡目 = 打6s）', () => {
    expect(autoLinkTarget(extra({ kyoku: 1, honba: 0, junme: 5 }), decisions)?.key).toBe('k1h0e5');
    expect(autoLinkTarget(extra({ kyoku: 2, honba: 1, junme: 3 }), decisions)?.key).toBe('k2h1e3');
  });

  it('判断が 2 つ以上ある巡目（東2局 4巡目 = 打白・鳴かない判断）は、自動で結びつけない。選ぶ物は、その巡目の判断', () => {
    const position = { kyoku: 1, honba: 0, junme: 4 };
    expect(autoLinkTarget(extra(position), decisions)).toBeNull();
    const near = decisionsNearPosition(position, decisions);
    expect(near.level).toBe('junme');
    expect(keys(near.options)).toEqual(['k1h0e3', 'k1h0e4']);
  });

  it('その巡目に判断が無いときは、同じ局・本場の判断（東2局 20巡目 → 東2局のすべて）。自動では結びつけない', () => {
    const position = { kyoku: 1, honba: 0, junme: 20 };
    expect(autoLinkTarget(extra(position), decisions)).toBeNull();
    const near = decisionsNearPosition(position, decisions);
    expect(near.level).toBe('honba');
    expect(near.options).toHaveLength(15);
    expect(new Set(near.options.map((ref) => ref.kyokuLabel))).toEqual(new Set(['東2局']));
  });

  it('その本場に判断が無いときは、同じ局のほかの本場の判断（東3局 0本場 → 東3局1本場）。本場が合わなければ、自動では結びつけない', () => {
    const position = { kyoku: 2, honba: 0, junme: 3 };
    const near = decisionsNearPosition(position, decisions);
    expect(near.level).toBe('kyoku');
    expect(new Set(near.options.map((ref) => ref.kyokuLabel))).toEqual(new Set(['東3局1本場']));
    expect(autoLinkTarget(extra(position), decisions)).toBeNull();
  });

  it('その局に判断が無い（半荘に無い局）ときは、選ぶ物も無い', () => {
    const position = { kyoku: 9, honba: 0, junme: 5 };
    expect(decisionsNearPosition(position, decisions)).toEqual({ level: 'none', options: [] });
    expect(autoLinkTarget(extra(position), decisions)).toBeNull();
  });

  it('判断の鍵をもう持つメモ・位置の無いメモ・判断の一覧が無いときは、自動で結びつけない', () => {
    const position = { kyoku: 1, honba: 0, junme: 5 };
    expect(autoLinkTarget(extra(position, { decision: 'k1h0e3' }), decisions)).toBeNull();
    expect(autoLinkTarget({ id: 'x1', decision: 'k1h0e5', candidates: '', reason: '' }, decisions)).toBeNull();
    expect(autoLinkTarget({ id: 'x1', candidates: '', reason: '' }, decisions)).toBeNull();
    expect(autoLinkTarget(extra(position), [])).toBeNull();
  });

  it('選ぶ判断の名前は、局・巡目と実戦の行動（AI の答えは出さない）。同じ名前が重なるときは、局の中の何番目かを足す', () => {
    const near = decisionsNearPosition({ kyoku: 1, honba: 0, junme: 4 }, decisions);
    expect(placePickLabels(near.options)).toEqual(['東2局 4巡目 · 打白', '東2局 4巡目 · 鳴かない判断']);
    const twins = decisions
      .filter((ref) => ref.key === 'k1h0e5' || ref.key === 'k1h0e6')
      .map((ref) => ({ ...ref, actionLabel: '打9m', junme: 5 }));
    expect(placePickLabels(twins)).toEqual(['東2局 5巡目 · 打9m（6番目）', '東2局 5巡目 · 打9m（7番目）']);
    for (const label of placePickLabels(decisions)) expect(label).not.toMatch(/\d\s*[%％]|確率|順位/);
  });

  it('答え合わせのあとの「終局直後のメモ」には、判断の鍵が付いたメモだけが出る（位置だけのメモは、結びつくまで出ない）', () => {
    const resolved = resolveMarks(report, fx4Session('20261009-190953', 0, { ocr: fx4Ocr(), links: { marks: {}, ratings: {} } }));
    const position = { kyoku: 1, honba: 1, junme: 6 };
    const memos = (extras: ExtraMemo[]): Memos => ({ marks: {}, extras });
    const only = extra(position, { candidates: '南', reason: '東を残す' });
    // 位置だけ: その位置の判断の問題（k1h1e7）にも出ない
    expect(memosForDecision({ memos: memos([only]), resolved, decisionKey: 'k1h1e7' })).toEqual([]);
    // 判断の鍵が付いたあと（位置は残る）は、その判断の問題に出る
    expect(memosForDecision({ memos: memos([{ ...only, decision: 'k1h1e7' }]), resolved, decisionKey: 'k1h1e7' })).toEqual([
      { source: 'extra', label: '追加のメモ', memo: { candidates: '南', reason: '東を残す' } },
    ]);
    // 古い形（判断の鍵だけ）も出る
    expect(
      memosForDecision({
        memos: memos([{ id: 'x2', decision: 'k1h1e7', candidates: 'a', reason: '' }]),
        resolved,
        decisionKey: 'k1h1e7',
      }).map((m) => m.memo.candidates),
    ).toEqual(['a']);
  });
});
