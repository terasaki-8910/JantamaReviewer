import { listDecisionRefs, parseReportText, type DecisionRef, type MortalReport } from '@jantama/engine';
import { describe, expect, it } from 'vitest';

import { FX4_TEXT, fx4Ocr, fx4Session } from '../../tests/import-fixtures';
import type { Links, SessionRecord } from '../api/types';
import {
  LINK_MANUAL,
  candidatesHeading,
  chipLabels,
  decisionOptions,
  kyokuOptions,
  markCaptionParts,
  markHeading,
  resolveMarks,
} from './markCards';

const parsed = parseReportText(FX4_TEXT);
if (!parsed.ok) throw new Error(parsed.error.message);
const report: MortalReport = parsed.value;
const decisions = listDecisionRefs(report);

/** 取り込みが保存するとおりの結びつけ（1 つに決まった迷い 1〜3 だけ、判断の鍵を保存する）。 */
const IMPORTED_LINKS: Links = {
  marks: { '1': 'k0h0e4', '2': 'k1h0e13', '3': 'k1h1e7' },
  ratings: {},
};

function session(links: Links = IMPORTED_LINKS): SessionRecord {
  return fx4Session('20261009-190953', 0, { ocr: fx4Ocr(), links });
}

const refOf = (key: string): DecisionRef => {
  const found = decisions.find((d) => d.key === key);
  if (!found) throw new Error(`判断が無い: ${key}`);
  return found;
};

describe('F9 迷いマークの結びつけの状態（FX-4。保存した選びは、自動の結果より先）', () => {
  it('取り込んだとおりに保存してあるとき: 迷い 1〜3 は決まっている、4・5 は候補が複数、6 は手で選ぶ（E-17）', () => {
    const resolved = resolveMarks(report, session());
    expect(resolved.map((r) => r.resolution.kind)).toEqual(['linked', 'linked', 'linked', 'candidates', 'candidates', 'manual']);
    expect(resolved.map((r) => r.number)).toEqual([1, 2, 3, 4, 5, 6]);
    expect(resolved.map((r) => r.markId)).toEqual([1, 2, 3, 4, 5, 6]);

    const linked = resolved.slice(0, 3).map((r) => (r.resolution.kind === 'linked' ? r.resolution : null));
    expect(linked.map((l) => l?.ref.key)).toEqual(['k0h0e4', 'k1h0e13', 'k1h1e7']);
    expect(linked.map((l) => l?.saved)).toEqual([true, true, true]);
    expect(linked.map((l) => l?.ref.actionLabel)).toEqual(['打5p', '鳴かない判断', '打南']);

    const four = resolved[3]?.resolution;
    expect(four?.kind === 'candidates' ? four.candidates.map((c) => c.key) : null).toEqual(['k1h1e10', 'k1h1e11', 'k1h1e12']);
    const five = resolved[4]?.resolution;
    expect(five?.kind === 'candidates' ? five.candidates.map((c) => c.key) : null).toEqual(['k2h1e6', 'k2h1e7']);
    expect(resolved[5]?.resolution).toEqual({ kind: 'manual', reason: 'unreadable' });
    expect(resolved[5]?.autoCandidates).toEqual([]);
  });

  it('保存した選びが無いとき: 自動で 1 つに決まったものは、決まっているとして出す（saved は false）', () => {
    const resolved = resolveMarks(report, session({ marks: {}, ratings: {} }));
    expect(resolved.map((r) => r.resolution.kind)).toEqual(['linked', 'linked', 'linked', 'candidates', 'candidates', 'manual']);
    for (const r of resolved.slice(0, 3)) {
      expect(r.resolution.kind === 'linked' && r.resolution.saved).toBe(false);
      expect(r.stored).toBeUndefined();
    }
  });

  it('保存した選びは、自動の結果に勝つ: 候補から選んだ・自動で決まったものを別の判断に選び直した', () => {
    const resolved = resolveMarks(
      report,
      session({
        marks: { '1': 'k0h0e5', '2': 'k1h0e13', '3': 'k1h1e7', '4': 'k1h1e11', '5': 'k2h1e7', '6': 'k2h1e9' },
        ratings: {},
      }),
    );
    expect(resolved.map((r) => (r.resolution.kind === 'linked' ? r.resolution.ref.key : r.resolution.kind))).toEqual([
      'k0h0e5',
      'k1h0e13',
      'k1h1e7',
      'k1h1e11',
      'k2h1e7',
      'k2h1e9',
    ]);
    expect(resolved.map((r) => r.stored)).toEqual(['k0h0e5', 'k1h0e13', 'k1h1e7', 'k1h1e11', 'k2h1e7', 'k2h1e9']);
    // 選んだあとも、自動の候補は持っている（選び直すとき、札に出す）。
    expect(resolved[3]?.autoCandidates.map((c) => c.key)).toEqual(['k1h1e10', 'k1h1e11', 'k1h1e12']);
    expect(resolved[4]?.autoCandidates.map((c) => c.key)).toEqual(['k2h1e6', 'k2h1e7']);
    expect(resolved[0]?.resolution.kind === 'linked' && resolved[0].resolution.saved).toBe(true);
  });

  it('保存した値が「手で選ぶ」（manual）のときは、自動で決まっていても、手で選ぶ欄になる', () => {
    expect(LINK_MANUAL).toBe('manual');
    const resolved = resolveMarks(report, session({ marks: { '1': LINK_MANUAL, '5': LINK_MANUAL }, ratings: {} }));
    expect(resolved[0]?.resolution).toEqual({ kind: 'manual', reason: 'chosen' });
    expect(resolved[0]?.stored).toBe('manual');
    expect(resolved[4]?.resolution).toEqual({ kind: 'manual', reason: 'chosen' });
    expect(resolved[4]?.autoCandidates.map((c) => c.key)).toEqual(['k2h1e6', 'k2h1e7']);
  });

  it('保存した鍵がこの結果に無いときは（古い・違う半荘の鍵）、保存が無いものとして、自動の結果に戻る', () => {
    const resolved = resolveMarks(report, session({ marks: { '1': 'k9h9e1', '4': 'k1h1e99', '6': 'garbage' }, ratings: {} }));
    expect(resolved[0]?.resolution.kind === 'linked' && resolved[0].resolution.ref.key).toBe('k0h0e4');
    expect(resolved[0]?.resolution.kind === 'linked' && resolved[0].resolution.saved).toBe(false);
    expect(resolved[3]?.resolution.kind).toBe('candidates');
    expect(resolved[5]?.resolution).toEqual({ kind: 'manual', reason: 'unreadable' });
    // 取り消すときに戻す値は、保存してあった文字のまま。
    expect(resolved[0]?.stored).toBe('k9h9e1');
  });

  it('読み取りの写しが無い（文字認識を使えなかった）ときは、すべて手で選ぶ', () => {
    const resolved = resolveMarks(report, fx4Session('20261009-190953', 0, { ocr: null, links: { marks: {}, ratings: {} } }));
    expect(resolved.map((r) => r.resolution)).toEqual(Array.from({ length: 6 }, () => ({ kind: 'manual', reason: 'unreadable' })));
  });

  it('迷いが 0 件なら、空', () => {
    expect(resolveMarks(report, { marks: [], ocr: null, links: { marks: {}, ratings: {} } })).toEqual([]);
  });
});

describe('F9 カードの 1 行目（承認済みの見本の書き方）', () => {
  const resolved = resolveMarks(report, session());
  const headings = resolved.map(markHeading);

  it('決まっている: 「東1局 4巡目 · 打牌の迷い」。鳴きは「鳴きの迷い」', () => {
    expect(headings[0]).toBe('東1局 4巡目 · 打牌の迷い');
    expect(headings[1]).toBe('東2局 11巡目 · 鳴きの迷い');
    expect(headings[2]).toBe('東2局1本場 6巡目 · 打牌の迷い');
  });

  it('候補が複数: 同じ局なら局を出し、巡目も同じなら巡目も出す。「候補がN つ」', () => {
    expect(headings[3]).toBe('東2局1本場 · 候補が3つ'); // 8巡目・9巡目・9巡目 と、巡目が違う
    expect(headings[4]).toBe('東3局1本場 · 候補が2つ'); // 6巡目・7巡目
    // 巡目も同じなら、巡目まで出す（見本の迷い 2）。
    expect(candidatesHeading([refOf('k1h0e12'), refOf('k1h0e13')])).toBe('東2局 11巡目 · 候補が2つ');
    // 局が違うものが混じるときは、局も出さない。
    expect(candidatesHeading([refOf('k1h0e12'), refOf('k1h1e7')])).toBe('候補が2つ');
  });

  it('手で選ぶ: 「読み取れませんでした」。利用者が手で選ぶと決めたとき、候補があれば、候補の言い方のまま', () => {
    expect(headings[5]).toBe('読み取れませんでした');
    const chosen = resolveMarks(report, session({ marks: { '5': LINK_MANUAL }, ratings: {} }));
    expect(chosen[4] && markHeading(chosen[4])).toBe('東3局1本場 · 候補が2つ');
    const unreadableChosen = resolveMarks(report, session({ marks: { '6': LINK_MANUAL }, ratings: {} }));
    expect(unreadableChosen[5] && markHeading(unreadableChosen[5])).toBe('読み取れませんでした');
  });

  it('画像の大きな表示の下の文（区切りごと）: 決まっている・候補・手で選ぶ・取り込み前', () => {
    expect(markCaptionParts(resolved[2] ?? null)).toEqual(['東2局1本場', '6巡目', '打牌の迷い']);
    expect(markCaptionParts(resolved[4] ?? null)).toEqual(['東3局1本場', '候補が2つ']);
    expect(markCaptionParts(resolved[5] ?? null)).toEqual(['読み取れませんでした']);
    expect(markCaptionParts(null)).toEqual([]);
  });

  it('AI の候補・確率・順位は、どの文にも出てこない（実戦の行動と、判断の呼び名だけ）', () => {
    const texts = [
      ...headings,
      ...resolved.flatMap((r) => markCaptionParts(r)),
      ...resolved.flatMap((r) => (r.resolution.kind === 'linked' ? [r.resolution.ref.actionLabel] : [])),
      ...resolved.flatMap((r) => chipLabels(r.autoCandidates)),
    ];
    for (const text of texts) expect(text).not.toMatch(/%|％|確率|順位|AI|prob/i);
  });
});

describe('F9 候補の札の文字', () => {
  it('実戦の行動（打8p・鳴かない判断・東をポン・和了）', () => {
    expect(chipLabels([refOf('k1h1e10'), refOf('k1h1e11'), refOf('k1h1e12')])).toEqual(['東をポン', '打7p', '和了']);
    expect(chipLabels([refOf('k2h1e6'), refOf('k2h1e7')])).toEqual(['打9m', '打1p']);
  });

  it('同じ行動が重なるときは、巡目を足す。それでも重なるときは、局の名前も足す', () => {
    // 東2局の 打9m は 6巡目と 12巡目に有る。
    expect(chipLabels([refOf('k1h0e5'), refOf('k1h0e14')])).toEqual(['6巡目 打9m', '12巡目 打9m']);
    // 局が違い、巡目も行動も同じ（本場違いなど）。
    const same = { ...refOf('k1h0e5'), kyokuLabel: '東2局1本場', key: 'k1h1e99' };
    expect(chipLabels([refOf('k1h0e5'), same])).toEqual(['東2局 6巡目 打9m', '東2局1本場 6巡目 打9m']);
  });
});

describe('F9 「局面を手で選ぶ」の選択肢', () => {
  it('局: 局の順に、同じ局は 1 つ（FX-4 は 5 局）', () => {
    expect(kyokuOptions(decisions)).toEqual([
      { position: 0, label: '東1局' },
      { position: 1, label: '東2局' },
      { position: 2, label: '東2局1本場' },
      { position: 3, label: '東3局' },
      { position: 4, label: '東3局1本場' },
    ]);
  });

  it('判断: 選んだ局の判断だけ、局の中の順に、「巡目 · 実戦の行動」', () => {
    const options = decisionOptions(decisions, 4);
    expect(options).toHaveLength(17);
    expect(options[0]).toMatchObject({ key: 'k2h1e0', label: '1巡目 · 打北' });
    expect(options[6]).toMatchObject({ key: 'k2h1e6', label: '6巡目 · 打9m' });
    expect(options[5]).toMatchObject({ key: 'k2h1e5', label: '5巡目 · 鳴かない判断' });
    expect(decisionOptions(decisions, 99)).toEqual([]);
  });

  it('判断の文字が重なる局では、局の中の何番目かを足す（選び分けられる）', () => {
    const twin = [refOf('k0h0e0'), { ...refOf('k0h0e1'), junme: 1, actionLabel: refOf('k0h0e0').actionLabel, key: 'k0h0e1' }];
    expect(decisionOptions(twin, 0).map((o) => o.label)).toEqual(['1巡目 · 打9m（1番目）', '1巡目 · 打9m（2番目）']);
  });
});
