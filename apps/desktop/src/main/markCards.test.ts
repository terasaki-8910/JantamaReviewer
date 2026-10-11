import { listDecisionRefs, parseReportText, type DecisionRef, type MortalReport } from '@jantama/engine';
import { describe, expect, it } from 'vitest';

import { FX4_TEXT, FX5_ID, FX5_STARTED, FX5_TEXT, FX5_USER_CHOICES, fx4Ocr, fx4Session, fx5Ocr, fx5Session } from '../../tests/import-fixtures';
import type { Links, OcrCache, SessionRecord } from '../api/types';
import {
  ESTIMATE_SUFFIX,
  ESTIMATE_TAG,
  LINK_MANUAL,
  UNDECIDED_JUNME_TEXT,
  UNDECIDED_TEXT,
  UNREADABLE_TEXT,
  alternativesOf,
  chipLabels,
  decisionOptions,
  estimateHeading,
  farChipLabels,
  farLine,
  isEstimated,
  isKyokuOnly,
  junmeSpanText,
  kyokuChoices,
  kyokuOptions,
  kyokuSpanText,
  markCaptionParts,
  markHeading,
  readingLine,
  resolveMarks,
} from './markCards';

const parsed = parseReportText(FX4_TEXT);
if (!parsed.ok) throw new Error(parsed.error.message);
const report: MortalReport = parsed.value;
const decisions = listDecisionRefs(report);

/** 取り込みが保存するとおりの結びつけ: 迷いマークは、保存しない（推定は、読み取りの写しと結果から出す）。 */
const IMPORTED_LINKS: Links = { marks: {}, ratings: {} };

/** ユーザーが本物のアプリで選び直した、FX-4 の迷い 1〜5 の結びつけ（E-17 の正解）。 */
const USER_CHOICES = ['k0h0e4', 'k1h0e12', 'k1h1e7', 'k1h1e10', 'k2h1e6'];

function session(links: Links = IMPORTED_LINKS, ocr: OcrCache | null = fx4Ocr()): SessionRecord {
  return fx4Session('20261009-190953', 0, { ocr, links });
}

const refOf = (key: string): DecisionRef => {
  const found = decisions.find((d) => d.key === key);
  if (!found) throw new Error(`判断が無い: ${key}`);
  return found;
};

describe('F9・E-17 迷いマークの結びつけの状態（FX-4。保存した選びは、自動の結果より先）', () => {
  it('何も保存していないとき: 読めた迷い 1〜5 は、1 位を推定として結びつける（ユーザーの選び直しと一致）。迷い 6 は読めないが、前後の評価と迷いから局が分かる（局だけ分かった迷い）', () => {
    const resolved = resolveMarks(report, session());
    expect(resolved.map((r) => r.resolution.kind)).toEqual(['linked', 'linked', 'linked', 'linked', 'linked', 'kyoku']);
    expect(resolved.map((r) => r.number)).toEqual([1, 2, 3, 4, 5, 6]);
    expect(resolved.map((r) => r.markId)).toEqual([1, 2, 3, 4, 5, 6]);

    const linked = resolved.slice(0, 5).map((r) => (r.resolution.kind === 'linked' ? r.resolution : null));
    expect(linked.map((l) => l?.ref.key)).toEqual(USER_CHOICES);
    expect(linked.map((l) => l?.saved)).toEqual([false, false, false, false, false]);
    expect(linked.map((l) => l?.ref.actionLabel)).toEqual(['打5p', '打8p', '打南', '東をポン', '打9m']);
    for (const r of resolved.slice(0, 5)) {
      expect(isEstimated(r)).toBe(true);
      expect(r.stored).toBeUndefined();
    }

    // 迷い 6 は、前の迷い 5（東3局1本場と読めた）と、次の評価（東3局1本場）の間に押したので、東3局1本場。巡目は決まらない
    expect(resolved[5]?.resolution).toEqual({ kind: 'kyoku' });
    expect(resolved[5]?.autoCandidates).toEqual([]);
    expect(resolved[5]?.reading).toBeNull();
    expect(isEstimated(resolved[5] as (typeof resolved)[number])).toBe(false);
    expect(isKyokuOnly(resolved[5] as (typeof resolved)[number])).toBe(true);
    expect(resolved[5] && kyokuChoices(resolved[5])).toHaveLength(17);
  });

  it('推定の迷いの、ほかの候補（1 位は含まない）と、スクショから読んだ値', () => {
    const resolved = resolveMarks(report, session());
    expect(resolved.map((r) => alternativesOf(r).map((c) => c.key))).toEqual([
      [],
      ['k1h0e14', 'k1h0e13'],
      [],
      ['k1h1e11'],
      ['k2h1e7'],
      [],
    ]);
    // 1 位と、ほかの候補を合わせたものが、自動の候補（選び直すときの札）
    expect(resolved[1]?.autoCandidates.map((c) => c.key)).toEqual(['k1h0e12', 'k1h0e14', 'k1h0e13']);
    expect(resolved.map((r) => r.reading)).toEqual([
      { wind: 'E', number: 1, tilesLeft: 59, score: 25000 },
      { wind: 'E', number: 2, tilesLeft: 23, score: 19000 },
      { wind: 'E', number: 2, tilesLeft: 47, score: 15100 },
      { wind: 'E', number: 2, tilesLeft: 35, score: 15100 },
      { wind: 'E', number: 3, tilesLeft: 46, score: 4400 },
      null,
    ]);
  });

  it('読み直し（E-20）の写しがあれば、迷い 6 も 東3局・残り38枚・4400点 と読めて、推定で結びつく（打北 9巡目。ほかの候補は 8巡目の鳴かない判断）', () => {
    const resolved = resolveMarks(report, session(IMPORTED_LINKS, fx4Ocr({ retries: true })));
    const six = resolved[5];
    expect(six?.resolution.kind === 'linked' && six.resolution.ref.key).toBe('k2h1e10');
    expect(six?.resolution.kind === 'linked' && six.resolution.saved).toBe(false);
    expect(six && alternativesOf(six).map((c) => c.key)).toEqual(['k2h1e9']);
    expect(six?.reading).toEqual({ wind: 'E', number: 3, tilesLeft: 38, score: 4400 });
  });

  it('保存した選びは、推定に勝つ（saved は true。「推定」の印は付かない）。選んだあとも、自動の候補は持っている', () => {
    const resolved = resolveMarks(
      report,
      session({
        marks: { '1': 'k0h0e5', '2': 'k1h0e12', '3': 'k1h1e7', '4': 'k1h1e11', '5': 'k2h1e7', '6': 'k2h1e9' },
        ratings: {},
      }),
    );
    expect(resolved.map((r) => (r.resolution.kind === 'linked' ? r.resolution.ref.key : r.resolution.kind))).toEqual([
      'k0h0e5',
      'k1h0e12',
      'k1h1e7',
      'k1h1e11',
      'k2h1e7',
      'k2h1e9',
    ]);
    expect(resolved.map((r) => r.stored)).toEqual(['k0h0e5', 'k1h0e12', 'k1h1e7', 'k1h1e11', 'k2h1e7', 'k2h1e9']);
    for (const r of resolved) {
      expect(r.resolution.kind === 'linked' && r.resolution.saved).toBe(true);
      expect(isEstimated(r)).toBe(false);
      expect(alternativesOf(r).every((c) => c.key !== (r.resolution.kind === 'linked' ? r.resolution.ref.key : ''))).toBe(true);
    }
    // 自動の候補は、選んだあとも持っている（選び直すとき、札に出す）。
    expect(resolved[3]?.autoCandidates.map((c) => c.key)).toEqual(['k1h1e10', 'k1h1e11']);
    expect(resolved[4]?.autoCandidates.map((c) => c.key)).toEqual(['k2h1e6', 'k2h1e7']);
  });

  it('保存した値が「手で選ぶ」（manual）のときは、自動で決まっていても、手で選ぶ欄になる', () => {
    expect(LINK_MANUAL).toBe('manual');
    const resolved = resolveMarks(report, session({ marks: { '1': LINK_MANUAL, '5': LINK_MANUAL }, ratings: {} }));
    expect(resolved[0]?.resolution).toEqual({ kind: 'manual', reason: 'chosen' });
    expect(resolved[0]?.stored).toBe('manual');
    expect(resolved[4]?.resolution).toEqual({ kind: 'manual', reason: 'chosen' });
    expect(resolved[4]?.autoCandidates.map((c) => c.key)).toEqual(['k2h1e6', 'k2h1e7']);
  });

  it('保存した鍵がこの結果に無いときは（古い・違う半荘の鍵）、保存が無いものとして、推定に戻る', () => {
    const resolved = resolveMarks(report, session({ marks: { '1': 'k9h9e1', '4': 'k1h1e99', '6': 'garbage' }, ratings: {} }));
    expect(resolved[0]?.resolution.kind === 'linked' && resolved[0].resolution.ref.key).toBe('k0h0e4');
    expect(resolved[0]?.resolution.kind === 'linked' && resolved[0].resolution.saved).toBe(false);
    expect(resolved[3]?.resolution.kind === 'linked' && resolved[3].resolution.ref.key).toBe('k1h1e10');
    expect(resolved[5]?.resolution).toEqual({ kind: 'kyoku' });
    // 取り消すときに戻す値は、保存してあった文字のまま。
    expect(resolved[0]?.stored).toBe('k9h9e1');
  });

  it('読み取りの写しが無い（文字認識を使えなかった）ときは、推定は 1 つも付かない。局は、評価と迷いを押した時刻の並びだけから決まる（局だけ分かった迷い）', () => {
    const resolved = resolveMarks(report, session({ marks: {}, ratings: {} }, null));
    expect(resolved.every((r) => r.resolution.kind === 'kyoku')).toBe(true);
    expect(resolved.every((r) => r.reading === null && r.autoCandidates.length === 0)).toBe(true);
    // 評価は 5 つとも押した順に局へ入るので、迷いは、その評価の間の局（評価が押し忘れた局の分だけ、実際とずれうる）
    expect(resolved.map(kyokuSpanText)).toEqual(['東1局', '東2局', '東2局1本場', '東2局1本場', '東3局', '東3局']);
  });

  it('読み取りの写しが無く、評価も無いときは、手で選ぶ（前後から何も分からない）', () => {
    const noRatings = { ...session({ marks: {}, ratings: {} }, null), ratings: [] };
    const resolved = resolveMarks(report, noRatings);
    expect(resolved.map((r) => r.resolution)).toEqual(Array.from({ length: 6 }, () => ({ kind: 'manual', reason: 'unreadable' })));
  });

  it('読めても、この半荘に合う局が無い迷いは、手で選ぶ（理由は no-kyoku。読んだ値は残す）', () => {
    const other: OcrCache = { geometry: fx4Ocr().geometry, entries: { 'marks/m1.png': { lines: ['南 2 局', '余 40', '25000'] } } };
    const resolved = resolveMarks(report, session(IMPORTED_LINKS, other));
    expect(resolved[0]?.resolution).toEqual({ kind: 'manual', reason: 'no-kyoku' });
    expect(resolved[0]?.autoReason).toBe('no-kyoku');
    expect(resolved[0]?.reading).toEqual({ wind: 'S', number: 2, tilesLeft: 40, score: 25000 });
  });

  it('迷いが 0 件なら、空', () => {
    expect(resolveMarks(report, { marks: [], ratings: [], ocr: null, links: { marks: {}, ratings: {} } })).toEqual([]);
  });
});

describe('U-13 カードの 2 行目と、スクショから読んだ値の 1 行（どの状態も同じ構成）', () => {
  const resolved = resolveMarks(report, session());
  const headings = resolved.map(markHeading);

  it('推定: 「局 巡目 · 種類」。1 位とほかの候補の巡目がまたがるときは、「8〜9巡目」の形にまとめる。局・種類は 1 位のもの', () => {
    expect(headings[0]).toBe('東1局 4巡目 · 打牌の迷い');
    expect(headings[1]).toBe('東2局 11〜12巡目 · 打牌の迷い'); // 1位 11巡目の打8p・12巡目の打9m・11巡目の鳴かない判断
    expect(headings[2]).toBe('東2局1本場 6巡目 · 打牌の迷い');
    expect(headings[3]).toBe('東2局1本場 8〜9巡目 · 鳴きの迷い'); // 1位 8巡目の東のポン・9巡目の打7p
    expect(headings[4]).toBe('東3局1本場 6〜7巡目 · 打牌の迷い');
  });

  it('利用者が選んだもの: 巡目は 1 つ（選んだ判断のもの）。「局 巡目 · 種類」の形は同じ', () => {
    const chosen = resolveMarks(report, session({ marks: { '4': 'k1h1e11', '5': 'k2h1e6' }, ratings: {} }));
    expect(chosen[3] && markHeading(chosen[3])).toBe('東2局1本場 9巡目 · 打牌の迷い');
    expect(chosen[4] && markHeading(chosen[4])).toBe('東3局1本場 6巡目 · 打牌の迷い');
  });

  it('手で選ぶ: 局面は決まっていません。利用者が手で選ぶと決めても、同じ文', () => {
    expect(UNDECIDED_TEXT).toBe('局面は決まっていません');
    const chosen = resolveMarks(report, session({ marks: { '5': LINK_MANUAL }, ratings: {} }));
    expect(chosen[4] && markHeading(chosen[4])).toBe(UNDECIDED_TEXT);
  });

  it('局だけ分かった（巡目が決まっていない）: 局の名前と、「巡目は決まっていません」', () => {
    expect(UNDECIDED_JUNME_TEXT).toBe('巡目は決まっていません');
    expect(headings[5]).toBe('東3局1本場 · 巡目は決まっていません');
  });

  it('巡目の書き方: 1 つなら「8巡目」、またがるなら「8〜9巡目」（最小〜最大）', () => {
    expect(junmeSpanText([8])).toBe('8巡目');
    expect(junmeSpanText([8, 8])).toBe('8巡目');
    expect(junmeSpanText([9, 8])).toBe('8〜9巡目');
    expect(junmeSpanText([11, 12, 11, 14])).toBe('11〜14巡目');
    expect(junmeSpanText([])).toBe('');
  });

  it('estimateHeading: 巡目は同じ局の候補だけでまとめる（別の本場の候補の巡目は混ぜない）', () => {
    const east2 = refOf('k1h1e10');
    const otherKyoku = { ...refOf('k2h1e6'), junme: 20 };
    expect(estimateHeading(east2, [refOf('k1h1e11'), otherKyoku])).toBe('東2局1本場 8〜9巡目 · 鳴きの迷い');
    expect(estimateHeading(east2, [])).toBe('東2局1本場 8巡目 · 鳴きの迷い');
  });

  it('画像の大きな表示の下の文（区切りごと）: 推定は 「推定」を足す。選んだもの・手で選ぶ・取り込み前', () => {
    expect(ESTIMATE_TAG).toBe('推定');
    expect(markCaptionParts(resolved[2] ?? null)).toEqual(['東2局1本場', '6巡目', '打牌の迷い', '推定']);
    expect(markCaptionParts(resolved[3] ?? null)).toEqual(['東2局1本場', '8〜9巡目', '鳴きの迷い', '推定']);
    expect(markCaptionParts(resolved[5] ?? null)).toEqual(['東3局1本場', '巡目は決まっていません']);
    const manual = resolveMarks(report, session({ marks: { '5': LINK_MANUAL }, ratings: {} }));
    expect(markCaptionParts(manual[4] ?? null)).toEqual([UNDECIDED_TEXT]);
    expect(markCaptionParts(null)).toEqual([]);
    const chosen = resolveMarks(report, session({ marks: { '3': 'k1h1e7' }, ratings: {} }));
    expect(markCaptionParts(chosen[2] ?? null)).toEqual(['東2局1本場', '6巡目', '打牌の迷い']);
  });

  it('スクショから読んだ値の 1 行: 「スクショ: 東2局・残り47・15,100点」。読めなければ「スクショを読めませんでした」。どの状態でも出す', () => {
    expect(resolved.map(readingLine)).toEqual([
      'スクショ: 東1局・残り59・25,000点',
      'スクショ: 東2局・残り23・19,000点',
      'スクショ: 東2局・残り47・15,100点',
      'スクショ: 東2局・残り35・15,100点',
      'スクショ: 東3局・残り46・4,400点',
      UNREADABLE_TEXT,
    ]);
    expect(UNREADABLE_TEXT).toBe('スクショを読めませんでした');
    // 利用者が選んだあとも、手で選ぶと決めたあとも、同じ 1 行
    const chosen = resolveMarks(report, session({ marks: { '3': 'k1h1e7', '5': LINK_MANUAL }, ratings: {} }));
    expect(chosen[2] && readingLine(chosen[2])).toBe('スクショ: 東2局・残り47・15,100点');
    expect(chosen[4] && readingLine(chosen[4])).toBe('スクショ: 東3局・残り46・4,400点');
  });

  it('読めても決まらなかったとき（この半荘に合う局が無い・その局に判断が無い）は、理由を足す', () => {
    const other: OcrCache = { geometry: fx4Ocr().geometry, entries: { 'marks/m1.png': { lines: ['南 2 局', '余 40', '25000'] } } };
    const noKyoku = resolveMarks(report, session(IMPORTED_LINKS, other));
    expect(noKyoku[0] && readingLine(noKyoku[0])).toBe('スクショ: 南2局・残り40・25,000点 · この半荘に合う局がありません');
    expect(noKyoku[0] && markHeading(noKyoku[0])).toBe(UNDECIDED_TEXT);

    const empty = structuredClone(report);
    const kyoku = empty.review.kyokus[0];
    if (!kyoku) throw new Error('東1局が無い');
    kyoku.entries = [];
    const noDecision = resolveMarks(empty, session());
    expect(noDecision[0]?.resolution).toEqual({ kind: 'manual', reason: 'no-decision' });
    expect(noDecision[0] && readingLine(noDecision[0])).toBe('スクショ: 東1局・残り59・25,000点 · その局に自分の判断がありません');
  });

  it('AI の候補・確率・順位は、どの文にも出てこない（実戦の行動と、判断の呼び名だけ）', () => {
    const withRetries = resolveMarks(report, session(IMPORTED_LINKS, fx4Ocr({ retries: true })));
    const texts = [
      ...headings,
      ...[...resolved, ...withRetries].flatMap((r) => markCaptionParts(r)),
      ...[...resolved, ...withRetries].map(readingLine),
      ...resolved.flatMap((r) => (r.resolution.kind === 'linked' ? [r.resolution.ref.actionLabel] : [])),
      ...resolved.flatMap((r) => chipLabels(r.autoCandidates)),
    ];
    for (const text of texts) expect(text).not.toMatch(/%|％|確率|順位|AI|prob/i);
  });
});

describe('E-27 離れている（利用者が選んだ判断が、推定にもほかの候補にも入らない）', () => {
  /** 迷い 6 は、読み直し（E-20）で 東3局・残り38・4400点 と読める。ユーザーは、東3局1本場 11巡目の打3m（残り29）に結びつけた。 */
  const retried = fx4Ocr({ retries: true });
  const MARK6_FAR = 'k2h1e14';
  const resolved = resolveMarks(report, session({ marks: { '6': MARK6_FAR }, ratings: {} }, retried));

  it('迷い 6 に、東3局1本場 11巡目 打3m（残り29）を選ぶと、離れている。ほかの迷いは、選んでいないので離れていない', () => {
    expect(refOf(MARK6_FAR)).toMatchObject({ label: '東3局1本場 11巡目 · 打牌の迷い', actionLabel: '打3m', tilesLeft: 29 });
    expect(resolved.map((r) => r.far)).toEqual([false, false, false, false, false, true]);
    // 選んだ判断は「利用者が選んだもの」（推定の印は付かない）で、自動の候補（推定とほかの候補）も持っている。
    expect(resolved[5]?.resolution.kind === 'linked' && resolved[5].resolution.saved).toBe(true);
    expect(resolved[5]?.autoCandidates.map((c) => c.key)).toEqual(['k2h1e10', 'k2h1e9']);
    expect(resolved[5]?.reading).toEqual({ wind: 'E', number: 3, tilesLeft: 38, score: 4400 });
  });

  it('迷い 1〜5 を、ユーザーが選んだ判断（E-17）にしても、離れていない。推定や、ほかの候補を選んでも、離れていない', () => {
    const marks = Object.fromEntries(USER_CHOICES.map((key, i) => [String(i + 1), key]));
    const chosen = resolveMarks(report, session({ marks, ratings: {} }, retried));
    expect(chosen.slice(0, 5).map((r) => r.far)).toEqual([false, false, false, false, false]);
    // ほかの候補（迷い 2 の 12巡目の打9m、迷い 6 の 8巡目の鳴かない判断）を選んでも、離れていない。
    const alternatives = resolveMarks(report, session({ marks: { '2': 'k1h0e14', '6': 'k2h1e9' }, ratings: {} }, retried));
    expect(alternatives.map((r) => r.far)).toEqual([false, false, false, false, false, false]);
    for (const r of [...chosen, ...alternatives]) expect(farLine(r)).toBeNull();
  });

  it('読み取りと同じ局の判断を選んだとき: 「スクショの値（残り38）と離れています。選んだ局面は残り29です。」（局の名前は書かない）', () => {
    expect(resolved[5] && farLine(resolved[5])).toBe('スクショの値（残り38）と離れています。選んだ局面は残り29です。');
  });

  it('読み取りと違う局の判断を選んだとき: 「スクショの値（東3局・残り46）と離れています。選んだ局面は東2局1本場です。」（読んだ局の名前と、選んだ局の名前を書く）', () => {
    // 迷い 5 は 東3局・残り46・4400点。東2局1本場 6巡目の打南（k1h1e7）を選ぶ。
    const other = resolveMarks(report, session({ marks: { '5': 'k1h1e7' }, ratings: {} }, retried));
    expect(other[4]?.far).toBe(true);
    expect(other[4] && farLine(other[4])).toBe('スクショの値（東3局・残り46）と離れています。選んだ局面は東2局1本場です。');
    // 本場だけが違う局（読んだ 東3局 に対して 東3局1本場）は、同じ局として扱う（上の「残り」の書き方）。
    expect(refOf(MARK6_FAR).kyokuLabel).toBe('東3局1本場');
  });

  it('離れていないとき・推定のまま・手で選ぶ・読めない・この結果に無い鍵では、1 行は無い（null）', () => {
    const states = [
      resolveMarks(report, session()), // 保存なし（推定のまま。迷い 6 は読めない）
      resolveMarks(report, session({ marks: { '6': LINK_MANUAL }, ratings: {} }, retried)), // 手で選ぶと決めた
      resolveMarks(report, session({ marks: { '6': 'k9h9e1' }, ratings: {} }, retried)), // この結果に無い鍵（推定に戻る）
      resolveMarks(report, session({ marks: { '6': MARK6_FAR }, ratings: {} })), // 読み直しの前（迷い 6 が読めない）
    ];
    for (const list of states) {
      expect(list.every((r) => !r.far)).toBe(true);
      expect(list.every((r) => farLine(r) === null)).toBe(true);
    }
  });

  it('読み直しの前（迷い 6 が読めない写し）は、選んだ判断があっても離れていない。読み直したあとで、離れていると分かる', () => {
    const links = { marks: { '6': MARK6_FAR }, ratings: {} };
    const before = resolveMarks(report, session(links));
    expect(before[5]?.far).toBe(false);
    expect(before[5]?.reading).toBeNull();
    const after = resolveMarks(report, session(links, retried));
    expect(after[5]?.far).toBe(true);
    // 結びつけ（保存した選び）は、読み直しの前も後も同じ。読み直しは、保存した値を変えない。
    expect(before[5]?.stored).toBe(MARK6_FAR);
    expect(after[5]?.stored).toBe(MARK6_FAR);
  });

  it('離れているときの札の文字: 先頭（推定）にだけ「（推定）」。ほかの候補はそのまま', () => {
    expect(ESTIMATE_SUFFIX).toBe('（推定）');
    expect(farChipLabels(resolved[5]?.autoCandidates ?? [])).toEqual(['9巡目 打北（推定）', '8巡目 鳴かない判断']);
    // 推定だけのとき（ほかの候補が無い）も、推定の札は出す。
    expect(farChipLabels([refOf('k0h0e4')])).toEqual(['打5p（推定）']);
    expect(farChipLabels([])).toEqual([]);
  });

  it('1 行にも札にも、AI の候補・確率・順位は出てこない（実戦の行動と、残り枚数と、局の名前だけ）', () => {
    const texts = [
      resolved[5] ? farLine(resolved[5]) : null,
      ...farChipLabels(resolved[5]?.autoCandidates ?? []),
    ];
    for (const text of texts) expect(text ?? '').not.toMatch(/%|％|確率|順位|AI|prob/i);
  });
});

describe('F9 候補の札の文字', () => {
  it('同じ巡目・同じ局なら、実戦の行動だけ（打7p・和了・東をポン）', () => {
    expect(chipLabels([refOf('k1h1e11'), refOf('k1h1e12')])).toEqual(['打7p', '和了']);
    expect(chipLabels([{ ...refOf('k1h1e10'), junme: 9 }, refOf('k1h1e11'), refOf('k1h1e12')])).toEqual(['東をポン', '打7p', '和了']);
  });

  it('違う巡目にまたがるときは、すべての札に巡目を足す（1 位の推定も、ほかの候補も）', () => {
    expect(chipLabels([refOf('k1h1e10'), refOf('k1h1e11')])).toEqual(['8巡目 東をポン', '9巡目 打7p']);
    expect(chipLabels([refOf('k2h1e6'), refOf('k2h1e7')])).toEqual(['6巡目 打9m', '7巡目 打1p']);
    expect(chipLabels([refOf('k1h0e12'), refOf('k1h0e14'), refOf('k1h0e13')])).toEqual([
      '11巡目 打8p',
      '12巡目 打9m',
      '11巡目 鳴かない判断',
    ]);
  });

  it('違う局にまたがる（本場違いで点数が同じ）ときは、局の名前も足す', () => {
    const same = { ...refOf('k1h0e12'), kyokuLabel: '東2局1本場', kyokuPosition: 2, key: 'k1h1e99' };
    expect(chipLabels([refOf('k1h0e12'), same])).toEqual(['東2局 11巡目 打8p', '東2局1本場 11巡目 打8p']);
  });

  it('それでも同じ文字が重なるときは、局の中の何番目かを足す。候補が無ければ空', () => {
    const twin = { ...refOf('k1h0e12'), entryIndex: 99, key: 'k1h0e99' };
    expect(chipLabels([refOf('k1h0e12'), twin])).toEqual(['打8p（13番目）', '打8p（100番目）']);
    expect(chipLabels([])).toEqual([]);
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

// ---- E-28〜E-30・U-24: FX-5（10月11日の半荘）の迷いのカードの文言 ----

describe('U-24 局だけ分かった迷いと、崩れた読み取りの迷いのカード（FX-5）', () => {
  const fx5Parsed = parseReportText(FX5_TEXT);
  if (!fx5Parsed.ok) throw new Error(fx5Parsed.error.message);
  const fx5Report: MortalReport = fx5Parsed.value;
  const fx5Decisions = listDecisionRefs(fx5Report);
  const fx5 = (links: Links = { marks: {}, ratings: {} }) => fx5Session(FX5_ID, FX5_STARTED, { ocr: fx5Ocr(), links, report_path: 'C:/data/report.json' });
  /** カードの番号（1 から。記録の順）→ 結びつけの状態。迷い 13 は、記録の id 2・3・4・6・8・9・10・13・14・16・17・19・21。 */
  const resolved = resolveMarks(fx5Report, fx5());
  const card = (n: number) => resolved[n - 1] as (typeof resolved)[number];

  it('迷い 13 のうち、局だけ分かった迷い（残り枚数が読めない）は 2 つ（15:38:10 = カード 3、15:42:37 = カード 5）。ほかの 11 は推定。手で選ぶものは無い', () => {
    expect(resolved.map((r) => r.resolution.kind)).toEqual([
      'linked',
      'linked',
      'kyoku',
      'linked',
      'kyoku',
      'linked',
      'linked',
      'linked',
      'linked',
      'linked',
      'linked',
      'linked',
      'linked',
    ]);
    expect(resolved.filter((r) => isEstimated(r))).toHaveLength(11);
    expect(resolved.map((r) => r.markId)).toEqual([2, 3, 4, 6, 8, 9, 10, 13, 14, 16, 17, 19, 21]);
  });

  it('局だけ分かった迷いの 2 行目は、局の名前と「巡目は決まっていません」。推定の印も「選び直す」も無い（自動の候補が無い）', () => {
    expect(markHeading(card(3))).toBe('東2局 · 巡目は決まっていません');
    expect(markHeading(card(5))).toBe('東4局 · 巡目は決まっていません');
    expect(kyokuSpanText(card(5))).toBe('東4局');
    expect(isEstimated(card(5))).toBe(false);
    expect(card(5).autoCandidates).toEqual([]);
    expect(markCaptionParts(card(5))).toEqual(['東4局', '巡目は決まっていません']);
  });

  it('局だけ分かった迷いが選べる判断は、局の幅の中の判断だけ（15:38:10 は東2局の 15、15:42:37 は東4局の 16）。AI の答えは出ない', () => {
    expect(kyokuChoices(card(3))).toHaveLength(15);
    expect(kyokuChoices(card(5))).toHaveLength(16);
    expect(kyokuChoices(card(5)).every((d) => d.kyokuLabel === '東4局')).toBe(true);
    // 選び肢の呼び名は、局の判断の呼び名（自分が実際にした行動）だけ
    expect(kyokuOptions(kyokuChoices(card(5)))).toEqual([{ position: 4, label: '東4局' }]);
    expect(decisionOptions(kyokuChoices(card(5)), 4)[4]).toMatchObject({ key: 'k3h0e4', label: '5巡目 · 打2s' });
    expect(kyokuChoices(card(1))).toEqual([]); // 推定の迷いは、局の幅の判断を並べない
    expect(fx5Decisions.filter((d) => d.kyokuPosition === 4)).toHaveLength(16);
  });

  it('スクショの値の 1 行: 読めた部分を書き、読めなかった部分は「読めず」。全部読めたものは、これまでどおり', () => {
    expect(readingLine(card(1))).toBe('スクショ: 風は読めず・2局・残り50・25,000点'); // 15:37:02
    expect(readingLine(card(3))).toBe('スクショ: 風は読めず・2局・残りは読めず・25,000点'); // 15:38:10
    expect(readingLine(card(4))).toBe('スクショ: 東・局の番号は読めず・残り59・23,700点'); // 15:40:03
    expect(readingLine(card(5))).toBe(UNREADABLE_TEXT); // 15:42:37
    expect(readingLine(card(8))).toBe('スクショ: 南・局の番号は読めず・残り60・33,700点'); // 15:50:36
    expect(readingLine(card(2))).toBe('スクショ: 東2局・残り46・25,000点'); // 15:37:25
    expect(readingLine(card(13))).toBe('スクショ: 南・局の番号は読めず・残り49・28,500点'); // 16:03:19
  });

  it('局をどう決めたかの 1 文: 崩れた読み取りは「読めた部分と点数から」。読めなかったものは、前後の評価・迷いの時刻から', () => {
    expect(card(1).howText).toBe('局の名前の一部が読めなかったので、読めた部分と点数から、東2局です。');
    expect(card(3).howText).toBe('局の名前の一部が読めなかったので、読めた部分と点数から、東2局です。');
    expect(card(4).howText).toBe('局の名前の一部が読めなかったので、読めた部分と点数から、東3局1本場です。');
    expect(card(8).howText).toBe('局の名前の一部が読めなかったので、読めた部分と点数から、南1局2本場です。');
    expect(card(13).howText).toBe('局の名前の一部が読めなかったので、読めた部分と点数から、南4局です。');
    // 15:42:37（カード 5）: 前の評価 15:41:44（東3局1本場）と、次の迷い 15:42:52（カード 6。東4局）の間
    expect(card(5).howText).toBe('東3局1本場の評価（15:41:44）と東4局の迷い6（15:42:52）の間に押したので、東4局です。');
  });

  it('すべて読めた読み取りで決まった迷い・利用者が選んだ迷い・手で選ぶ迷いには、1 文は付かない', () => {
    for (const n of [2, 6, 7, 9, 10, 11, 12]) expect(card(n).howText, `カード${n}`).toBeNull();
    const chosen = resolveMarks(fx5Report, fx5({ marks: FX5_USER_CHOICES as Links['marks'], ratings: {} }));
    expect(chosen.every((r) => r.howText === null || !r.stored)).toBe(true);
    for (const r of chosen.filter((c) => c.stored !== undefined)) {
      expect(r.howText, `迷い${r.number}`).toBeNull();
      expect(r.resolution.kind === 'linked' && r.resolution.saved).toBe(true);
    }
    const manual = resolveMarks(fx5Report, fx5({ marks: { '8': LINK_MANUAL }, ratings: {} }));
    expect(manual[4]?.resolution).toEqual({ kind: 'manual', reason: 'chosen' });
    expect(manual[4]?.howText).toBeNull();
  });

  it('15:37:02・15:50:36・16:03:19 の推定は、ユーザーが選んだ判断と一致する（E-30）。カードの 2 行目も、局と巡目', () => {
    expect([card(1), card(8), card(13)].map((r) => r.resolution.kind === 'linked' && r.resolution.ref.key)).toEqual(['k1h0e5', 'k4h2e2', 'k7h0e6']);
    expect(markHeading(card(1))).toBe('東2局 5巡目 · 打牌の迷い');
    expect(markHeading(card(13))).toBe('南4局 6巡目 · リーチの迷い');
  });

  it('利用者が選んだ迷いは、ほかの迷いの局を決める手がかりになる（選び直すと、近くの迷いの局の幅が変わる）', () => {
    // 15:42:37（カード 5）に、東4局の判断を選ぶ。そのあとの迷い（カード 6・7）は、東4局以降
    const chosen = resolveMarks(fx5Report, fx5({ marks: { '8': 'k3h0e4' }, ratings: {} }));
    expect(chosen[4]?.resolution.kind === 'linked' && chosen[4].resolution.ref.key).toBe('k3h0e4');
    expect(chosen[5]?.resolution.kind === 'linked' && chosen[5].resolution.ref.kyokuLabel).toBe('東4局');
  });

  it('局だけ分かった迷いと、崩れた読み取りの文に、AI の候補・確率・順位は出てこない', () => {
    const texts = resolved.flatMap((r) => [markHeading(r), readingLine(r), r.howText ?? '', ...markCaptionParts(r)]);
    for (const text of texts) expect(text).not.toMatch(/%|％|確率|順位|AI|prob/i);
  });
});
