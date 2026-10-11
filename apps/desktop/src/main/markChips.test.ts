/**
 * 局の評価の表の「迷い」の列の札（R11-9、U-27）を決める部分の試験。FX-4（取り込み前の読み取りの写し）と FX-5（10月11日の半荘。迷い 13）を使う。
 * 札は、迷いのカードと同じ結びつけ（`resolveMarks`）から作る。
 */
import { parseReportText, type MortalReport } from '@jantama/engine';
import { describe, expect, it } from 'vitest';

import { FX4_TEXT, FX5_ID, FX5_STARTED, FX5_TEXT, FX5_USER_CHOICES, fx4Ocr, fx4Session, fx5Ocr, fx5Session } from '../../tests/import-fixtures';
import type { Links, OcrCache, SessionRecord } from '../api/types';
import { chipsByKyoku, markChip, UNDECIDED_CHIP_TEXT, type MarkChip } from './markChips';
import { resolveMarks } from './markCards';

function reportOf(text: string): MortalReport {
  const parsed = parseReportText(text);
  if (!parsed.ok) throw new Error(parsed.error.message);
  return parsed.value;
}

const fx4Report = reportOf(FX4_TEXT);
const fx5Report = reportOf(FX5_TEXT);

const fx5 = (marks: Links['marks'] = {}): SessionRecord =>
  fx5Session(FX5_ID, FX5_STARTED, { report_path: 'x', ocr: fx5Ocr(), links: { marks, ratings: {} } });

/** 札を「局の添字: 種類 文字」の行にする（確かめやすい形）。 */
function rows(chips: Map<number, MarkChip[]>): string[] {
  return [...chips.entries()]
    .sort((a, b) => a[0] - b[0])
    .map(([position, list]) => `${position}: ${list.map((c) => `${c.kind} ${c.text}`).join(' / ')}`);
}

describe('U-27 迷いの札（FX-5。11回目の見本の値）', () => {
  it('何も選んでいないとき: 推定は枠だけ（estimate）、局だけ分かった迷い 3・5 は「巡目は未定」（undecided）', () => {
    expect(rows(chipsByKyoku(resolveMarks(fx5Report, fx5())))).toEqual([
      '1: estimate 迷い1 5巡目 打6s / estimate 迷い2 6巡目 打9m / undecided 迷い3 巡目は未定',
      '3: estimate 迷い4 3巡目 打中',
      '4: undecided 迷い5 巡目は未定 / estimate 迷い6 5巡目 白をポン / estimate 迷い7 8巡目 打3m',
      '6: estimate 迷い8 3巡目 打1s / estimate 迷い9 10巡目 打8p',
      '7: estimate 迷い10 6巡目 打2m / estimate 迷い11 9巡目 7mをポン',
      '8: estimate 迷い12 4巡目 打發',
      '9: estimate 迷い13 6巡目 打2p',
    ]);
  });

  it('ユーザーが選んだ 7 つ（迷い 1・3・4・5・6・8・13）は chosen。選んだ迷いは、その判断の局と巡目の札になる（迷い 3 は 8巡目 打9m、迷い 5 は東4局の 5巡目 打2s）', () => {
    expect(rows(chipsByKyoku(resolveMarks(fx5Report, fx5({ ...FX5_USER_CHOICES }))))).toEqual([
      '1: chosen 迷い1 5巡目 打6s / estimate 迷い2 6巡目 打9m / chosen 迷い3 8巡目 打9m',
      '3: chosen 迷い4 2巡目 打1m',
      '4: chosen 迷い5 5巡目 打2s / chosen 迷い6 6巡目 打4p / estimate 迷い7 8巡目 打3m',
      '6: chosen 迷い8 3巡目 打1s / estimate 迷い9 10巡目 打8p',
      '7: estimate 迷い10 6巡目 打2m / estimate 迷い11 9巡目 7mをポン',
      '8: estimate 迷い12 4巡目 打發',
      '9: chosen 迷い13 6巡目 打2p',
    ]);
  });

  it('札の番号は、迷いのカードの番号（記録の順）。記録の番号（markId）は、取り消された記録を飛ばした保存の鍵で、番号とは別', () => {
    const resolved = resolveMarks(fx5Report, fx5());
    const chips = [...chipsByKyoku(resolved).values()].flat().sort((a, b) => a.number - b.number);
    expect(chips.map((c) => c.number)).toEqual(Array.from({ length: 13 }, (_, i) => i + 1));
    // FX-5 の迷いの id は 2・3・4・6・8・9・10・13・14・16・17・19・21（評価の id が間に入る）
    expect(chips.map((c) => c.markId)).toEqual([2, 3, 4, 6, 8, 9, 10, 13, 14, 16, 17, 19, 21]);
  });

  it('読み上げの名前に、状態（選んだ・推定・巡目は未定）を入れる。見える文字（「迷い1 5巡目 打6s」）で始まる', () => {
    const resolved = resolveMarks(fx5Report, fx5({ ...FX5_USER_CHOICES }));
    const byNumber = new Map([...chipsByKyoku(resolved).values()].flat().map((c) => [c.number, c] as const));
    expect(byNumber.get(1)?.label).toBe('迷い1 5巡目 打6s（選んだ）。カードへ移る');
    expect(byNumber.get(2)?.label).toBe('迷い2 6巡目 打9m（推定）。カードへ移る');
    for (const chip of byNumber.values()) expect(chip.label.startsWith(chip.text)).toBe(true);
    const undecided = [...chipsByKyoku(resolveMarks(fx5Report, fx5())).values()].flat().find((c) => c.number === 3);
    expect(undecided?.label).toBe('迷い3 巡目は未定。カードへ移る');
    expect(undecided?.what).toBe(UNDECIDED_CHIP_TEXT);
  });

  it('札の種類は 3 つ（色だけに頼らない: チェック・枠だけ・点線は、画面が種類で描き分ける）。選ぶと、巡目は未定の札が選んだ札に替わる', () => {
    const kindsOf = (marks: Links['marks']) =>
      [...new Set([...chipsByKyoku(resolveMarks(fx5Report, fx5(marks))).values()].flat().map((c) => c.kind))].sort();
    expect(kindsOf({})).toEqual(['estimate', 'undecided']);
    expect(kindsOf({ ...FX5_USER_CHOICES })).toEqual(['chosen', 'estimate']);
  });

  it('局の幅が複数の局のとき、「巡目は未定」の札は先頭の局に出し、読み上げの名前に局の幅を足す（本場違いで点数が同じ局が続くとき）', () => {
    const resolved = resolveMarks(fx5Report, fx5());
    const item = resolved[4];
    if (item === undefined) throw new Error('迷い 5 が無い');
    const base = markChip(item);
    expect(base?.kind).toBe('undecided');
    // 局の幅を 2 局にした見立て（迷い 5 の選び肢を、東4局と東4局1本場の判断にする）
    const wide = {
      ...item,
      timeline: item.timeline === null ? null : { ...item.timeline, choices: [...item.timeline.choices, ...(fx5ChoicesOfNextKyoku(resolved) ?? [])] },
    };
    const widened = markChip(wide);
    expect(widened?.position).toBe(base?.position);
    expect(widened?.label).toMatch(/（東4局〜東4局1本場のどれか）。カードへ移る$/);
  });
});

/** 東4局1本場（局の添字 5）の判断を、どれか 1 つ取り出す（局の幅を広げる試験用）。 */
function fx5ChoicesOfNextKyoku(resolved: ReturnType<typeof resolveMarks>) {
  const six = resolved[5];
  return six !== undefined && six.resolution.kind === 'linked' ? [{ ...six.resolution.ref, kyokuPosition: 5, kyokuLabel: '東4局1本場' }] : null;
}

describe('U-27 表に出さない迷い（FX-4）', () => {
  const session = (ocr: OcrCache): SessionRecord => fx4Session('20261009-190953', 0, { ocr, links: { marks: {}, ratings: {} } });

  it('読み取りがこの半荘のどの局にも合わず、局が分からない迷い（局面を手で選ぶ）は、札にしない（どの局にも当てはまらない）', () => {
    const cache = fx4Ocr();
    cache.entries['marks/m1.png'] = { lines: ['南 2 局', '余 40', '25000'] };
    const resolved = resolveMarks(fx4Report, session(cache));
    expect(resolved[0]?.resolution.kind).toBe('manual');
    expect(markChip(resolved[0] as (typeof resolved)[number])).toBeNull();
    const chips = chipsByKyoku(resolved);
    expect([...chips.values()].flat().map((c) => c.number)).not.toContain(1);
    // ほかの迷い（2〜6）は、札になる
    expect([...chips.values()].flat().map((c) => c.number).sort((a, b) => a - b)).toEqual([2, 3, 4, 5, 6]);
  });

  it('局面を手で選ぶと決めた迷い（"manual"）も、札にしない', () => {
    const marked = fx4Session('20261009-190953', 0, { ocr: fx4Ocr(), links: { marks: { '1': 'manual' }, ratings: {} } });
    const resolved = resolveMarks(fx4Report, marked);
    expect(resolved[0]?.resolution).toEqual({ kind: 'manual', reason: 'chosen' });
    expect([...chipsByKyoku(resolved).values()].flat().map((c) => c.number)).not.toContain(1);
  });

  it('迷いが無い半荘は、札の入れ物が空（列を出さない）', () => {
    const none = fx4Session('20261009-190953', 0, { ocr: fx4Ocr(), links: { marks: {}, ratings: {} }, marks: [], mark_count: 0 });
    expect(chipsByKyoku(resolveMarks(fx4Report, none)).size).toBe(0);
  });
});
