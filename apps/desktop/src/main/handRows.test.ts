import { parseReportText, summarizeHanchan, type HanchanSummary, type MortalReport } from '@jantama/engine';
import { describe, expect, it } from 'vitest';

import { FX4_TEXT, fx4Ocr, fx4Session } from '../../tests/import-fixtures';
import type { Links, MakaGrades, Rating, SelfRatings, SessionRecord } from '../api/types';
import { buildHandTable, makaGradeOf, pointText } from './handRows';

const parsed = parseReportText(FX4_TEXT);
if (!parsed.ok) throw new Error(parsed.error.message);
const report: MortalReport = parsed.value;
const summary: HanchanSummary = summarizeHanchan(report);

/** 取り込みが保存するとおりの、評価の結びつけ（評価の id 7〜11 が、局の順に 5 局）。 */
const IMPORTED_LINKS: Links = {
  marks: {},
  ratings: { '7': 'k0h0', '8': 'k1h0', '9': 'k1h1', '10': 'k2h0', '11': 'k2h1' },
};

interface Options {
  ratings?: readonly Rating[];
  links?: Links;
  selfRatings?: SelfRatings;
  maka?: MakaGrades;
}

/** FX-4 の半荘。ウィジェットの評価は、既定で 局の順に △・✕・△・✕・✕。 */
function session({
  ratings = ['fair', 'bad', 'fair', 'bad', 'bad'],
  links = IMPORTED_LINKS,
  selfRatings = { kyokus: {} },
  maka = { kyokus: {} },
}: Options = {}): SessionRecord {
  const base = fx4Session('20261009-190953', 0, { ocr: fx4Ocr(), links, self_ratings: selfRatings, maka });
  return { ...base, ratings: base.ratings.map((r, i) => ({ ...r, rating: ratings[i] ?? r.rating })), rating_count: ratings.length };
}

const build = (s: SessionRecord) => buildHandTable({ report, summary, session: s });

describe('F10 局の評価の表の行（FX-4）', () => {
  it('1 行 = 1 局。局・結果・点・AI 基準（段階と Rating）が、取り込んだ結果から入る', () => {
    const { rows } = build(session());
    expect(rows.map((r) => r.label)).toEqual(['東1局', '東2局', '東2局1本場', '東3局', '東3局1本場']);
    expect(rows.map((r) => r.key)).toEqual(['k0h0', 'k1h0', 'k1h1', 'k2h0', 'k2h1']);
    expect(rows.map((r) => r.resultText)).toEqual(['他家のツモ', '他家のツモ', '和了', '放銃', '放銃']);
    expect(rows.map((r) => r.deltaText)).toEqual(['−6,000', '−3,900', '+1,300', '−12,000', '−8,300']);
    expect(rows.map((r) => r.grade)).toEqual(['S+', 'S-', 'A', 'S', 'S-']);
    expect(rows.map((r) => r.ratingText)).toEqual(['100.0', '91.6', '86.5', '94.6', '91.6']);
  });

  it('自分の〇△✕は、ウィジェットで付けた評価を、局の順に当てはめたもの。FX-4 では、東2局・東3局・東3局1本場に印', () => {
    const table = build(session());
    expect(table.rows.map((r) => r.self)).toEqual(['fair', 'bad', 'fair', 'bad', 'bad']);
    expect(table.rows.map((r) => r.flagged)).toEqual([false, true, false, true, true]);
    expect(table.rows.filter((r) => r.flagged).map((r) => r.label)).toEqual(['東2局', '東3局', '東3局1本場']);
    expect(table.flaggedCount).toBe(3);
    expect(table.unplacedRatings).toBe(0);
    // 上書きは無い。
    expect(table.rows.every((r) => r.override === undefined && r.widget === r.self)).toBe(true);
  });

  it('〇と付けた局は、AI 基準が S でも A でも印は付かない。✕と付けた局は、AI 基準が S のときだけ印が付き、A のときは付かない', () => {
    const all = build(session({ ratings: ['good', 'good', 'good', 'good', 'good'] }));
    expect(all.flaggedCount).toBe(0);
    const bad = build(session({ ratings: ['bad', 'bad', 'bad', 'bad', 'bad'] }));
    // AI 基準は S+・S-・A・S・S-。東2局1本場だけが A（△の帯）で、✕とは帯が 1 つしか離れないので印は付かない
    expect(bad.rows.map((r) => r.flagged)).toEqual([true, true, false, true, true]);
    expect(bad.flaggedCount).toBe(4);
  });

  it('評価の結びつけが保存されていないときは、自動の当てはめ（迷いと評価を押した時刻の順。E-29）を使う', () => {
    // 評価のスクショの読み取りが無い FX-4 の評価は、迷いの局（読み取りで決まる）の間に、時刻の順で当てはまる。
    // 最後の 2 つの評価（19:22:41・19:23:54）は、どちらも最後の局 東3局1本場。押し直しとして、あとのものを残し、東3局は空欄になる
    const table = build(session({ links: { marks: {}, ratings: {} } }));
    expect(table.rows.map((r) => r.self)).toEqual(['fair', 'bad', 'fair', null, 'bad']);
    expect(table.unplacedRatings).toBe(1);
  });

  it('利用者が選んだ迷いの結びつけは、評価の自動の当てはめの手がかりになる（保存した評価の結びつけは、それより先）', () => {
    // 迷い 5（19:21:58）を 東3局（局 3）の判断に結びつけると、そのあとに押した評価は、東3局以降
    const choice = 'k2h0e0';
    const withChoice = build(session({ links: { marks: { '5': choice }, ratings: {} } }));
    expect(withChoice.rows.map((r) => r.self)).toEqual(['fair', 'bad', 'fair', 'bad', 'bad']);
    expect(withChoice.unplacedRatings).toBe(0);
  });

  it('保存した結びつけは、自動の当てはめに勝つ。空の鍵は「どの局にも結びつけない」', () => {
    // 評価 7 を 東3局1本場へ、評価 11 を どこにも結びつけない。
    const links: Links = {
      marks: {},
      ratings: { '7': 'k2h1', '8': 'k1h0', '9': 'k1h1', '10': 'k2h0', '11': '' },
    };
    const table = build(session({ links, ratings: ['good', 'bad', 'fair', 'bad', 'bad'] }));
    expect(table.rows.map((r) => r.self)).toEqual([null, 'bad', 'fair', 'bad', 'good']);
    expect(table.unplacedRatings).toBe(1);
  });

  it('同じ局に 2 つ当たったときは、あとに押した評価を使い、押し負けた評価は「当てはまらなかった」に数える', () => {
    const links: Links = { marks: {}, ratings: { '7': 'k0h0', '8': 'k0h0', '9': 'k1h1', '10': 'k2h0', '11': 'k2h1' } };
    const table = build(session({ links, ratings: ['fair', 'good', 'fair', 'bad', 'bad'] }));
    expect(table.rows.map((r) => r.self)).toEqual(['good', null, 'fair', 'bad', 'bad']);
    expect(table.unplacedRatings).toBe(1);
  });

  it('この結果に無い局の鍵に結びついた評価は、どの局にも出ない（当てはまらなかった）', () => {
    const links: Links = { marks: {}, ratings: { '7': 'k9h9', '8': 'k1h0', '9': 'k1h1', '10': 'k2h0', '11': 'k2h1' } };
    const table = build(session({ links }));
    expect(table.rows[0]?.self).toBeNull();
    expect(table.unplacedRatings).toBe(1);
  });

  it('付け直した上書きは、ウィジェットの評価に勝つ。none は「評価なし」', () => {
    const table = build(
      session({ selfRatings: { kyokus: { k0h0: 'good', k1h0: 'none', k2h1: 'fair' } } }),
    );
    expect(table.rows.map((r) => r.self)).toEqual(['good', null, 'fair', 'bad', 'fair']);
    expect(table.rows.map((r) => r.widget)).toEqual(['fair', 'bad', 'fair', 'bad', 'bad']);
    expect(table.rows.map((r) => r.override)).toEqual(['good', 'none', undefined, undefined, 'fair']);
    // 印は、表に出している自分の評価で決まる（東2局は「評価なし」にしたので印が消え、東3局1本場は △ にしたので消える）。
    expect(table.rows.map((r) => r.flagged)).toEqual([false, false, false, true, false]);
  });

  it('ウィジェットで評価を付けていない局も、上書きで付けられる（押し忘れた局）', () => {
    const table = build(
      session({
        links: { marks: {}, ratings: { '7': 'k0h0', '8': 'k1h0', '9': '', '10': 'k2h0', '11': 'k2h1' } },
        selfRatings: { kyokus: { k1h1: 'bad' } },
      }),
    );
    expect(table.rows[2]?.widget).toBeNull();
    expect(table.rows[2]?.self).toBe('bad');
    // 東2局1本場は A（△の帯）なので、上書きで✕を付けても印は付かない（帯が 1 つ離れ）。S の局に付けた✕（東2局・東3局・東3局1本場）には印が付く
    expect(table.rows[2]?.flagged).toBe(false);
    expect(table.rows.map((r) => r.flagged)).toEqual([false, true, false, true, true]);
  });

  it('MAKA: 入れた段階を出す。入れていない局・14 段階にない文字は空', () => {
    const table = build(session({ maka: { kyokus: { k0h0: 'C-', k1h0: 'S+', k1h1: 'great', k2h0: 's' }, hanchan: 'A+' } }));
    expect(table.rows.map((r) => r.maka)).toEqual(['C-', 'S+', null, null, null]);
    expect(table.hanchan.maka).toBe('A+');
    expect(build(session({ maka: { kyokus: {}, hanchan: 'X' } })).hanchan.maka).toBeNull();
    expect(build(session()).hanchan.maka).toBeNull();
  });

  it('半荘全体の行: AI 基準は半荘の段階と Rating（見出しと同じ）', () => {
    const table = build(session());
    expect(table.hanchan.grade).toBe(summary.grade);
    expect(table.hanchan.ratingText).toBe('93.0');
  });

  it('表の中身に、AI の候補・確率・順位は無い（段階と Rating の数字だけ）', () => {
    const table = build(session());
    const text = JSON.stringify(table);
    expect(text).not.toMatch(/prob|確率|順位|candidate|q_value|details/);
    expect(Object.keys(table.rows[0] ?? {}).sort()).toEqual(
      ['deltaText', 'flagged', 'grade', 'key', 'label', 'maka', 'override', 'position', 'ratingText', 'resultText', 'self', 'widget'].sort(),
    );
  });
});

describe('点の増減・MAKA の段階の文字', () => {
  it('点: 符号つき・3 桁ごとに区切る・マイナスは U+2212・0 は 0', () => {
    expect(pointText(8800)).toBe('+8,800');
    expect(pointText(-12000)).toBe('−12,000');
    expect(pointText(300)).toBe('+300');
    expect(pointText(-700)).toBe('−700');
    expect(pointText(0)).toBe('0');
    expect(pointText(123456)).toBe('+123,456');
  });

  it('MAKA の段階: 14 段階の名前のとおりのときだけ段階にする（大文字小文字・空白は許さない）', () => {
    expect(makaGradeOf('S+')).toBe('S+');
    expect(makaGradeOf('E')).toBe('E');
    expect(makaGradeOf('s+')).toBeNull();
    expect(makaGradeOf(' S+')).toBeNull();
    expect(makaGradeOf('F')).toBeNull();
    expect(makaGradeOf('')).toBeNull();
    expect(makaGradeOf(undefined)).toBeNull();
  });
});
