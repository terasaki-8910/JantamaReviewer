import { describe, expect, it } from 'vitest';

import { type CenterText, parseCenterText } from '../src/center-text';
import type { Decision } from '../src/decision';
import { importReport } from '../src/import';
import { kyokuFactsOf, kyokuFits, locateKyokus } from '../src/kyoku-locate';
import {
  ALTERNATIVE_MARGIN,
  AFTER_PENALTY,
  MAX_ALTERNATIVES,
  PASS_PENALTY,
  WIN_PENALTY,
  type MarkLink,
  linkMarks,
  markScore,
} from '../src/mark-link';
import { parseReportText } from '../src/report';
import type { MortalReport, ReportEntry } from '../src/report-types';
import { FX1_IDS, FX4_ID, loadFx4Ocr, loadReportJson, loadReportText } from './helpers/fixtures';

function load(id: string): MortalReport {
  const r = parseReportText(loadReportText(id));
  if (!r.ok) throw new Error(r.error.message);
  return r.value;
}

/** 結びつけを、確かめたい項目だけにする。 */
function brief(link: MarkLink) {
  const pick = (c: { key: string; label: string; actionLabel: string; tilesLeft: number; tilesDiff: number; score: number }) => ({
    key: c.key,
    label: c.label,
    action: c.actionLabel,
    tilesLeft: c.tilesLeft,
    diff: c.tilesDiff,
    score: c.score,
  });
  return {
    status: link.status,
    reason: link.reason,
    estimate: link.estimate === null ? null : pick(link.estimate),
    alternatives: link.alternatives.map(pick),
  };
}

const reading = (wind: 'E' | 'S' | 'W', number: 1 | 2 | 3 | 4, tilesLeft: number, score: number): CenterText => ({
  wind,
  number,
  tilesLeft,
  score,
});

/** ユーザーが本物のアプリで選び直した、FX-4 の迷い 1〜5 の結びつけ（ACCEPTANCE の E-17 の正解。迷い 6 は覚えていないので、正解に入れない）。 */
const USER_CHOICES = ['k0h0e4', 'k1h0e12', 'k1h1e7', 'k1h1e10', 'k2h1e6'] as const;

describe('E-17 迷いマークの結びつけ（FX-4 の迷いマーク6枚。ユーザーが選び直した結びつけが正解）', () => {
  const report = load(FX4_ID);
  const ocr = loadFx4Ocr();
  const marks = ocr.map((m) => ({ mark: m.mark, lines: m.lines, retries: m.retries?.map((r) => r.lines) }));
  const links = linkMarks(report, marks);

  it('E-17 6枚が押した順に返り、渡した迷いマークがそのまま付く', () => {
    expect(links).toHaveLength(6);
    links.forEach((link, i) => {
      expect(link.index).toBe(i);
      expect(link.mark).toBe(marks[i]);
    });
  });

  it('E-17 読めた5枚（迷い1〜5）は、どれも1位が、ユーザーが選び直した判断と一致する', () => {
    expect(links.slice(0, 5).map((l) => l.estimate?.key)).toEqual([...USER_CHOICES]);
    for (const link of links.slice(0, 5)) expect(link.status).toBe('estimated');
  });

  it('E-17 迷い1 → 東1局 4巡目 打5p（残り59枚。差 0）。ほかの候補なし', () => {
    expect(brief(links[0] as MarkLink)).toEqual({
      status: 'estimated',
      reason: null,
      estimate: { key: 'k0h0e4', label: '東1局 4巡目 · 打牌の迷い', action: '打5p', tilesLeft: 59, diff: 0, score: 0 },
      alternatives: [],
    });
    expect(links[0]?.kyokuPositions).toEqual([0]);
  });

  it('E-17 迷い2 → 東2局 11巡目 打8p（残り25枚。差 2）。直前の鳴かない判断（残り22枚）は、スルーの分と読んだあとの分で後ろになり、ほかの候補', () => {
    expect(brief(links[1] as MarkLink)).toEqual({
      status: 'estimated',
      reason: null,
      estimate: { key: 'k1h0e12', label: '東2局 11巡目 · 打牌の迷い', action: '打8p', tilesLeft: 25, diff: 2, score: 2 },
      alternatives: [
        { key: 'k1h0e14', label: '東2局 12巡目 · 打牌の迷い', action: '打9m', tilesLeft: 21, diff: 2, score: 2.25 },
        { key: 'k1h0e13', label: '東2局 11巡目 · 鳴きの迷い', action: '鳴かない判断', tilesLeft: 22, diff: 1, score: 2.75 },
      ],
    });
    expect(links[1]?.kyokuPositions).toEqual([1]);
  });

  it('E-17 迷い3 → 点数 15100 で 東2局1本場（15100）と区別し、6巡目 打南（残り46枚。差 1）。ほかの候補なし', () => {
    expect(brief(links[2] as MarkLink)).toEqual({
      status: 'estimated',
      reason: null,
      estimate: { key: 'k1h1e7', label: '東2局1本場 6巡目 · 打牌の迷い', action: '打南', tilesLeft: 46, diff: 1, score: 1.25 },
      alternatives: [],
    });
    expect(links[2]?.kyokuPositions).toEqual([2]);
  });

  it('E-17 迷い4 → 8巡目の東のポン（差 1）。同じ残り枚数のそのあとの打7pは、鳴きが先なので、ほかの候補。和了の判断は入らない', () => {
    expect(brief(links[3] as MarkLink)).toEqual({
      status: 'estimated',
      reason: null,
      estimate: { key: 'k1h1e10', label: '東2局1本場 8巡目 · 鳴きの迷い', action: '東をポン', tilesLeft: 36, diff: 1, score: 1 },
      alternatives: [
        { key: 'k1h1e11', label: '東2局1本場 9巡目 · 打牌の迷い', action: '打7p', tilesLeft: 36, diff: 1, score: 1 },
      ],
    });
  });

  it('E-17 迷い5 → 東3局1本場（4400）の6巡目 打9m（差 1）。7巡目の打1pはほかの候補', () => {
    expect(brief(links[4] as MarkLink)).toEqual({
      status: 'estimated',
      reason: null,
      estimate: { key: 'k2h1e6', label: '東3局1本場 6巡目 · 打牌の迷い', action: '打9m', tilesLeft: 47, diff: 1, score: 1 },
      alternatives: [{ key: 'k2h1e7', label: '東3局1本場 7巡目 · 打牌の迷い', action: '打1p', tilesLeft: 45, diff: 1, score: 1.25 }],
    });
    expect(links[4]?.kyokuPositions).toEqual([4]);
  });

  it('E-17 迷い6 → 1回目では読めないが、読み直し（E-20）で 東3局・残り38枚・4400点 と読めて、余38に近い判断に結びつく', () => {
    expect(links[5]?.center).toEqual({ wind: 'E', number: 3, tilesLeft: 38, score: 4400 });
    expect(links[5]?.kyokuPositions).toEqual([4]);
    // 1位は 9巡目の打北（残り37枚。差 1 で、読んだあと）。ちょうど残り38枚の「鳴かない判断」は、スルーの分で2位（ほかの候補）。
    expect(brief(links[5] as MarkLink)).toEqual({
      status: 'estimated',
      reason: null,
      estimate: { key: 'k2h1e10', label: '東3局1本場 9巡目 · 打牌の迷い', action: '打北', tilesLeft: 37, diff: 1, score: 1.25 },
      alternatives: [
        { key: 'k2h1e9', label: '東3局1本場 8巡目 · 鳴きの迷い', action: '鳴かない判断', tilesLeft: 38, diff: 0, score: 1.5 },
      ],
    });
  });

  it('E-17 読み直しが無ければ、迷い6は読めない（手で選ぶ）', () => {
    const [link] = linkMarks(report, [{ lines: ocr[5]?.lines }]);
    expect(brief(link as MarkLink)).toEqual({ status: 'manual', reason: 'unreadable', estimate: null, alternatives: [] });
    expect(link?.center).toBeNull();
    expect(link?.kyokuPositions).toEqual([]);
  });

  it('E-17 文字認識の行（lines）のまま渡しても、読み取り済み（center）を渡しても、同じ結果になる', () => {
    const byCenter = linkMarks(
      report,
      marks.map((m) => ({ center: parseCenterText(m.lines) ?? parseCenterText(m.retries?.[0] ?? []) })),
    );
    expect(byCenter.map(brief)).toEqual(links.map(brief));
  });

  it('E-17 推定と候補の鍵は、保存して当て直せる（判断の番号は局の中の番号）', () => {
    const keys = links.flatMap((l) => [l.estimate?.key, ...l.alternatives.map((c) => c.key)]).filter((k) => k !== undefined);
    expect(keys).toEqual([
      'k0h0e4',
      'k1h0e12',
      'k1h0e14',
      'k1h0e13',
      'k1h1e7',
      'k1h1e10',
      'k1h1e11',
      'k2h1e6',
      'k2h1e7',
      'k2h1e10',
      'k2h1e9',
    ]);
    expect(new Set(keys).size).toBe(keys.length);
  });
});

describe('E-17 順位づけの点（残りの牌の数の差に、スルー・和了・読んだあとの分を足す）', () => {
  const entry = (tilesLeft: number, action: 'none' | 'dahai' | 'hora', kinds: Array<'none' | 'dahai' | 'hora' | 'pon'> = [action]) =>
    ({
      tiles_left: tilesLeft,
      actual: action === 'none' ? { type: 'none' } : action === 'hora' ? { type: 'hora', actor: 0, target: 0 } : { type: 'dahai', actor: 0, pai: '1m', tsumogiri: false },
      details: kinds.map((type) => ({
        action: type === 'none' ? { type: 'none' } : type === 'hora' ? { type: 'hora', actor: 0, target: 0 } : { type: type === 'pon' ? 'pon' : 'dahai', actor: 0, pai: '1m' },
        q_value: 0,
        prob: 0,
      })),
    }) as unknown as Pick<ReportEntry, 'tiles_left' | 'actual' | 'details'>;

  it('E-17 重みは 1.5・3・0.25、候補にする幅は 0.75、候補の数は最大 4 つ', () => {
    expect([PASS_PENALTY, WIN_PENALTY, AFTER_PENALTY, ALTERNATIVE_MARGIN, MAX_ALTERNATIVES]).toEqual([1.5, 3, 0.25, 0.75, 4]);
  });

  it('E-17 打牌は、残りの牌の数の差そのまま。読んだより前なら差、後なら差に 0.25', () => {
    expect(markScore(entry(40, 'dahai'), 40)).toBe(0);
    expect(markScore(entry(43, 'dahai'), 40)).toBe(3);
    expect(markScore(entry(38, 'dahai'), 40)).toBe(2.25);
  });

  it('E-17 スルー（鳴かない判断）は 1.5 を足す。読んだあとなら、さらに 0.25', () => {
    expect(markScore(entry(40, 'none', ['none', 'pon']), 40)).toBe(1.5);
    expect(markScore(entry(41, 'none', ['none', 'pon']), 40)).toBe(2.5);
    expect(markScore(entry(39, 'none', ['none', 'pon']), 40)).toBe(2.75);
  });

  it('E-17 実際に鳴いた判断は、スルーではないので足さない', () => {
    expect(markScore(entry(40, 'dahai', ['pon', 'none']), 40)).toBe(0);
  });

  it('E-17 和了の判断は 3 を足す（和了しない判断も、スルーの 1.5 は重ねない）', () => {
    expect(markScore(entry(40, 'hora', ['hora', 'none']), 40)).toBe(3);
    expect(markScore(entry(39, 'hora', ['hora', 'none']), 40)).toBe(4.25);
    expect(markScore(entry(40, 'none', ['hora', 'none']), 40)).toBe(3);
  });
});

describe('E-17 順位づけの並びと、ほかの候補の数・幅（FX-4 の局を作り替えた入力）', () => {
  /** 東1局の判断の残りの牌の数を、指定どおりに書き換えた結果。 */
  function withTilesLeft(values: number[]): MortalReport {
    const report = structuredClone(load(FX4_ID));
    const kyoku = report.review.kyokus[0];
    if (!kyoku) throw new Error('東1局が無い');
    kyoku.entries = kyoku.entries.slice(0, values.length);
    kyoku.entries.forEach((e, i) => {
      e.tiles_left = values[i] as number;
    });
    return report;
  }
  const east1 = (tilesLeft: number): CenterText => reading('E', 1, tilesLeft, 25000);

  it('E-17 同じ点の判断が続くときは、結果の中で先の判断が1位。ほかの候補は最大 4 つ', () => {
    const report = withTilesLeft(Array.from({ length: 10 }, () => 50));
    const [link] = linkMarks(report, [{ center: east1(50) }]);
    expect(link?.estimate?.entryIndex).toBe(0);
    expect(link?.alternatives.map((c) => c.entryIndex)).toEqual([1, 2, 3, 4]);
  });

  it('E-17 1位との点の差が 0.75 を超える判断は、ほかの候補にならない（ちょうど 0.75 は入る）', () => {
    // 残り 50 の読み取りに対し、判断は 50（点 0）・49（後なので 1.25）・51（前なので 1）・47（後なので 3.25）
    const report = withTilesLeft([50, 49, 51, 47]);
    const [link] = linkMarks(report, [{ center: east1(50) }]);
    expect(link?.estimate?.entryIndex).toBe(0);
    expect(link?.alternatives).toEqual([]);
    // 残り 49 の読み取り: 49（0）・50（前なので 1）・51（前なので 2）・47（後なので 2.25）→ 差 1 は幅の外
    const [near] = linkMarks(withTilesLeft([49, 50]), [{ center: east1(49) }]);
    expect(near?.estimate?.entryIndex).toBe(0);
    expect(near?.alternatives).toEqual([]);
    // 点が 0 と 0.25 と 0.75 の判断は、すべて候補。1.0 は入らない（実戦の読み取りの FX-4 迷い2 の鳴かない判断が、ちょうど 0.75 で入る）
    const exact = linkMarks(load(FX4_ID), [{ center: reading('E', 2, 23, 19000) }])[0];
    expect(exact?.alternatives.map((c) => c.score - (exact.estimate?.score ?? 0))).toEqual([0.25, 0.75]);
  });

  it('E-17 読んだ時点より後の判断は、同じ差の前の判断より後ろ（前が1位）', () => {
    // 残り 50 の読み取りで、49（後。1.25）と 51（前。1）
    const report = withTilesLeft([49, 51]);
    const [link] = linkMarks(report, [{ center: east1(50) }]);
    expect(link?.estimate?.entryIndex).toBe(1);
    expect(link?.alternatives.map((c) => c.entryIndex)).toEqual([0]);
  });

  it('E-17 残りの牌の数が判断のどれとも離れていても、いちばん近い判断を推定にする（差は tilesDiff で分かる）', () => {
    const [link] = linkMarks(load(FX4_ID), [{ center: reading('E', 3, 5, 16400) }]);
    expect(link?.status).toBe('estimated');
    expect(link?.estimate).toMatchObject({ key: 'k2h0e4', tilesLeft: 51, tilesDiff: 46 });
    expect(link?.alternatives).toEqual([]);
  });
});

describe('E-17 局の特定（点数で本場を区別し、リーチ棒の分は引いて比べる）', () => {
  // f9da87cbcd7af5e9: 本人は席1。東2局（25000 始まり）の10巡目に、残り33枚でリーチが成立する。
  const report = load('f9da87cbcd7af5e9');

  it('E-17 リーチが成立したあと（残り33枚以下）は、局の始めの点数から 1000 点引いた点数でも、その局に当たる', () => {
    for (const tilesLeft of [33, 30, 17]) {
      const [link] = linkMarks(report, [{ center: reading('E', 2, tilesLeft, 24000) }]);
      expect(link?.status, `残り${tilesLeft}枚`).not.toBe('manual');
      expect(link?.kyokuPositions, `残り${tilesLeft}枚`).toEqual([1]);
    }
  });

  it('E-17 リーチが成立する前（残り34枚以上）に 24000 点は読めない。引く前の 25000 点なら当たる', () => {
    for (const tilesLeft of [34, 40, 69]) {
      const [link] = linkMarks(report, [{ center: reading('E', 2, tilesLeft, 24000) }]);
      expect(brief(link as MarkLink), `残り${tilesLeft}枚`).toEqual({ status: 'manual', reason: 'no-kyoku', estimate: null, alternatives: [] });
    }
    const [link] = linkMarks(report, [{ center: reading('E', 2, 40, 25000) }]);
    expect(link?.kyokuPositions).toEqual([1]);
    expect(link?.estimate?.key).toBe('k1h0e8');
  });

  it('E-17 リーチ棒の分を引いて当たる読み取りは、残り枚数のいちばん近い判断（リーチの判断）を推定にする', () => {
    const [link] = linkMarks(report, [{ center: reading('E', 2, 30, 24000) }]);
    expect(link?.status).toBe('estimated');
    expect(link?.estimate).toMatchObject({
      key: 'k1h0e10',
      label: '東2局 10巡目 · リーチの迷い',
      actionLabel: 'リーチ',
      tilesLeft: 33,
      tilesDiff: 3,
    });
  });

  it('E-17 引ける棒は自分のリーチ1本だけ。2本分（23000 点）や、1000 点でない差（24500 点）は当たらない', () => {
    for (const score of [23000, 24500, 26000, 24900]) {
      const [link] = linkMarks(report, [{ center: reading('E', 2, 30, score) }]);
      expect(link?.reason, `${score}点`).toBe('no-kyoku');
    }
  });

  it('E-17 局の名前は合っても点数が合わなければ「手で選ぶ」（no-kyoku）。別の局の点数でも当たらない', () => {
    // 東2局1本場の始めの点数は 32800。東2局の 25000 とは別
    const fits = linkMarks(report, [{ center: reading('E', 2, 50, 32800) }]);
    expect(fits[0]?.kyokuPositions).toEqual([2]);
    const wrong = linkMarks(report, [{ center: reading('E', 2, 50, 31000) }, { center: reading('S', 1, 50, 25000) }, { center: reading('W', 4, 50, 25000) }]);
    expect(wrong.map((l) => [l.status, l.reason])).toEqual([
      ['manual', 'no-kyoku'],
      ['manual', 'no-kyoku'],
      ['manual', 'no-kyoku'],
    ]);
  });

  it('E-17 kyokuFits: 残りの牌の数が無いときは、局のどこかでリーチ棒が出ていれば引ける', () => {
    const facts = kyokuFactsOf(report);
    const east2 = facts[1];
    if (!east2) throw new Error('東2局が無い');
    expect(east2.label).toBe('東2局');
    expect(east2.startScore).toBe(25000);
    expect(east2.riichiTilesLeft).toEqual([33]);
    expect(kyokuFits(east2, { wind: 'E', number: 2, score: 24000 })).toBe(true);
    expect(kyokuFits(east2, { wind: 'E', number: 2, score: 25000 })).toBe(true);
    expect(kyokuFits(east2, { wind: 'E', number: 2, score: 23000 })).toBe(false);
    // リーチの無い局では引けない
    const east1 = facts[0];
    if (!east1) throw new Error('東1局が無い');
    expect(east1.riichiTilesLeft).toEqual([]);
    expect(kyokuFits(east1, { wind: 'E', number: 1, score: 24000 })).toBe(false);
  });
});

describe('E-17 本場違いで点数が同じ局が続くとき', () => {
  // f738896995c33fed（本人は席3）: 東3局2本場と東3局3本場は、どちらも 20700 点始まり。
  const report = load('f738896995c33fed');

  it('E-17 局が1つに決まらない（kyokuPositions が複数）。両方の局の判断をまとめて並べ、点がいちばん小さいものを推定にする', () => {
    const [link] = linkMarks(report, [{ center: reading('E', 3, 60, 20700) }]);
    expect(link?.kyokuPositions).toEqual([4, 5]);
    // 3本場の 3 巡目（残り60枚）が差 0。2本場の最も近い判断は残り62枚と58枚（差 2）で、1位との差が幅の外
    expect(brief(link as MarkLink)).toEqual({
      status: 'estimated',
      reason: null,
      estimate: { key: 'k2h3e2', label: '東3局3本場 3巡目 · 打牌の迷い', action: '打中', tilesLeft: 60, diff: 0, score: 0 },
      alternatives: [],
    });
  });

  it('E-17 点が同じ判断が別の局にもあれば、どちらの局の判断も候補になる（局の早いほうが1位）', () => {
    const [link] = linkMarks(report, [{ center: reading('E', 3, 68, 20700) }]);
    expect(link?.kyokuPositions).toEqual([4, 5]);
    expect(link?.status).toBe('estimated');
    expect([link?.estimate, ...(link?.alternatives ?? [])].map((c) => [c?.key, c?.tilesDiff])).toEqual([
      ['k2h2e0', 0],
      ['k2h3e0', 0],
    ]);
  });

  it('E-17 点数が違えば、本場は1つに決まる', () => {
    const [link] = linkMarks(report, [{ center: reading('E', 3, 60, 19700) }]);
    expect(link?.kyokuPositions).toEqual([3]);
    expect(link?.estimate?.key).toBe('k2h1e2');
  });

  it('E-17 同じ点数で3つ続く局（002ca97adccc486d の南4局・1本場・2本場）は、3つとも当たる', () => {
    const r = load('002ca97adccc486d');
    const [link] = linkMarks(r, [{ center: reading('S', 4, 46, 32400) }]);
    expect(link?.kyokuPositions).toEqual([13, 14, 15]);
    expect([link?.estimate, ...(link?.alternatives ?? [])].map((c) => [c?.key, c?.tilesDiff])).toEqual([
      ['k7h0e6', 0],
      ['k7h2e5', 0],
    ]);
  });

  it('E-17 locateKyokus は、当たる局をすべて半荘の順に返す', () => {
    const facts = kyokuFactsOf(report);
    expect(locateKyokus(facts, { wind: 'E', number: 3, score: 20700, tilesLeft: 50 }).map((f) => f.label)).toEqual([
      '東3局2本場',
      '東3局3本場',
    ]);
    expect(locateKyokus(facts, { wind: 'E', number: 3, score: 1 })).toEqual([]);
  });
});

describe('E-17 手で選ぶ（manual）になるとき', () => {
  const report = load(FX4_ID);

  it('E-17 読めない（center が null・lines が崩れている・どちらも無い）は unreadable', () => {
    const links = linkMarks(report, [{ center: null }, { lines: ['00', '乙 局 8 0', '8 3 3 0'] }, {}]);
    expect(links.map((l) => [l.status, l.reason, l.center])).toEqual([
      ['manual', 'unreadable', null],
      ['manual', 'unreadable', null],
      ['manual', 'unreadable', null],
    ]);
    for (const link of links) expect([link.estimate, link.alternatives]).toEqual([null, []]);
  });

  it('E-17 読めたが、この半荘に合う局が無い（別の半荘のスクショ）は no-kyoku。読み取った内容は返す', () => {
    const center = reading('S', 2, 40, 25000);
    const [link] = linkMarks(report, [{ center }]);
    expect(link).toMatchObject({ status: 'manual', reason: 'no-kyoku', center, kyokuPositions: [], estimate: null, alternatives: [] });
  });

  it('E-17 合う局に自分の判断が1つも無いときは no-decision（局の位置は返す）', () => {
    const empty = structuredClone(report);
    const kyoku = empty.review.kyokus[3];
    if (!kyoku) throw new Error('東3局が無い');
    kyoku.entries = [];
    const [link] = linkMarks(empty, [{ center: reading('E', 3, 55, 16400) }]);
    expect(link).toMatchObject({ status: 'manual', reason: 'no-decision', kyokuPositions: [3], estimate: null, alternatives: [] });
  });

  it('E-17 迷いマークが1つも無ければ空の一覧', () => {
    expect(linkMarks(report, [])).toEqual([]);
  });
});

describe('E-17 FX-1 の5半荘と FX-4 の全判断（盤面の点数と照らす）', () => {
  /** その判断の時点の局・残りの牌の数・点数（リーチ棒の分を引いた表示）を、そのまま読み取りにした迷いマーク。 */
  function exactMarks(decisions: readonly Decision[], playerId: number) {
    return decisions.map((d) => ({
      center: {
        wind: d.board.roundWind as 'E' | 'S' | 'W',
        number: d.board.kyoku as 1 | 2 | 3 | 4,
        tilesLeft: d.entry.tiles_left,
        score: d.board.scores[playerId] as number,
      },
    }));
  }

  it('E-17 どの判断も、その時点の局・残りの牌の数・点数から結びつけると、1位の点は 0 以下（差 0 の判断に勝てる判断は無い）で、局はその判断の局に合う', () => {
    let checked = 0;
    for (const id of [...FX1_IDS, FX4_ID]) {
      const imported = importReport(loadReportJson(id));
      if (!imported.ok) throw new Error(imported.error.message);
      const { decisions, report, playerId } = imported.value;
      const links = linkMarks(report, exactMarks(decisions, playerId));
      links.forEach((link, i) => {
        const d = decisions[i] as Decision;
        const label = `${id} ${d.kyokuLabel} ${d.junme}巡目`;
        expect(link.status, label).toBe('estimated');
        expect(link.kyokuPositions, label).toContain(d.kyokuPosition);
        // 同じ状態の判断（スルーや和了のおまけの重みが無いもの）が1位のとき、その点は 0（残りの牌の数が同じ）。
        const own = d.entry;
        const ownScore = markScore(own, own.tiles_left);
        expect(link.estimate?.score ?? Number.POSITIVE_INFINITY, label).toBeLessThanOrEqual(ownScore);
        checked++;
      });
    }
    expect(checked).toBe(178 + 197 + 156 + 231 + 202 + 70);
  });

  it('E-17 打牌・リーチ・実際に鳴いた判断・カンは、自分の読み取りで、必ず1位かほかの候補に入る。局が1つに決まり、残り枚数が局の中で1つだけの判断は、必ず1位', () => {
    let alwaysIn = 0;
    let uniqueTop = 0;
    for (const id of [...FX1_IDS, FX4_ID]) {
      const imported = importReport(loadReportJson(id));
      if (!imported.ok) throw new Error(imported.error.message);
      const { decisions, report, playerId } = imported.value;
      const links = linkMarks(report, exactMarks(decisions, playerId));
      links.forEach((link, i) => {
        const d = decisions[i] as Decision;
        if (d.kind === 'win' || d.entry.actual.type === 'none') return;
        const label = `${id} ${d.kyokuLabel} ${d.junme}巡目 ${d.kind}`;
        const found = [link.estimate, ...link.alternatives].some(
          (c) => c?.kyokuPosition === d.kyokuPosition && c.entryIndex === d.entryIndex,
        );
        expect(found, label).toBe(true);
        alwaysIn++;
        const sameState = (report.review.kyokus[d.kyokuPosition]?.entries ?? []).filter((e) => e.tiles_left === d.entry.tiles_left);
        if (link.kyokuPositions.length === 1 && sameState.length === 1) {
          expect(link.estimate?.entryIndex, label).toBe(d.entryIndex);
          uniqueTop++;
        }
      });
    }
    expect(alwaysIn).toBeGreaterThan(800);
    expect(uniqueTop).toBeGreaterThan(500);
  });

  it('E-17 リーチ棒が出たあとの判断が、実際に FX-1 の中にある（上の確かめが棒の分の引き算を通っている）', () => {
    let afterRiichi = 0;
    for (const id of FX1_IDS) {
      const imported = importReport(loadReportJson(id));
      if (!imported.ok) throw new Error(imported.error.message);
      const { decisions, report, playerId } = imported.value;
      for (const d of decisions) {
        const start = report.review.kyokus[d.kyokuPosition]?.relative_scores[0] ?? 0;
        if ((d.board.scores[playerId] as number) === start - 1000) afterRiichi++;
      }
    }
    expect(afterRiichi).toBeGreaterThan(0);
  });
});
