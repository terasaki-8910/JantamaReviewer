import { describe, expect, it } from 'vitest';

import { type CenterText, parseCenterText } from '../src/center-text';
import type { Decision } from '../src/decision';
import { importReport } from '../src/import';
import { kyokuFactsOf, kyokuFits, locateKyokus } from '../src/kyoku-locate';
import { type MarkLink, linkMarks } from '../src/mark-link';
import { parseReportText } from '../src/report';
import type { MortalReport } from '../src/report-types';
import { FX1_IDS, FX4_ID, loadFx4Ocr, loadReportJson, loadReportText } from './helpers/fixtures';

function load(id: string): MortalReport {
  const r = parseReportText(loadReportText(id));
  if (!r.ok) throw new Error(r.error.message);
  return r.value;
}

/** 候補を、確かめたい項目だけにする。 */
function brief(link: MarkLink) {
  return {
    status: link.status,
    reason: link.reason,
    candidates: link.candidates.map((c) => ({
      key: c.key,
      label: c.label,
      action: c.actionLabel,
      tilesLeft: c.tilesLeft,
      diff: c.tilesDiff,
    })),
  };
}

const reading = (wind: 'E' | 'S' | 'W', number: 1 | 2 | 3 | 4, tilesLeft: number, score: number): CenterText => ({
  wind,
  number,
  tilesLeft,
  score,
});

describe('E-17 迷いマークの結びつけ（FX-4 の迷いマーク6枚）', () => {
  const report = load(FX4_ID);
  const marks = loadFx4Ocr().map((m) => ({ mark: m.mark, center: parseCenterText(m.lines) }));
  const links = linkMarks(report, marks);

  it('E-17 6枚が押した順に返り、渡した迷いマークがそのまま付く', () => {
    expect(links).toHaveLength(6);
    links.forEach((link, i) => {
      expect(link.index).toBe(i);
      expect(link.mark).toBe(marks[i]);
    });
  });

  it('E-17 迷い1 → 東1局 4巡目 打5p（残り59枚。差 0）に結びつく', () => {
    expect(brief(links[0] as MarkLink)).toEqual({
      status: 'linked',
      reason: null,
      candidates: [{ key: 'k0h0e4', label: '東1局 4巡目 · 打牌の迷い', action: '打5p', tilesLeft: 59, diff: 0 }],
    });
    expect(links[0]?.kyokuPositions).toEqual([0]);
  });

  it('E-17 迷い2 → 東2局 11巡目 の鳴かない判断（残り22枚。差 1）に結びつく', () => {
    expect(brief(links[1] as MarkLink)).toEqual({
      status: 'linked',
      reason: null,
      candidates: [{ key: 'k1h0e13', label: '東2局 11巡目 · 鳴きの迷い', action: '鳴かない判断', tilesLeft: 22, diff: 1 }],
    });
    expect(links[1]?.kyokuPositions).toEqual([1]);
  });

  it('E-17 迷い3 → 点数 15100 で 東2局1本場（15100）と区別し、6巡目 打南（残り46枚。差 1）に結びつく', () => {
    expect(brief(links[2] as MarkLink)).toEqual({
      status: 'linked',
      reason: null,
      candidates: [{ key: 'k1h1e7', label: '東2局1本場 6巡目 · 打牌の迷い', action: '打南', tilesLeft: 46, diff: 1 }],
    });
    expect(links[2]?.kyokuPositions).toEqual([2]);
  });

  it('E-17 迷い4 → 候補3つ（8巡目の東のポン・9巡目の打7p・9巡目の和了。どれも差 1）', () => {
    expect(brief(links[3] as MarkLink)).toEqual({
      status: 'candidates',
      reason: null,
      candidates: [
        { key: 'k1h1e10', label: '東2局1本場 8巡目 · 鳴きの迷い', action: '東をポン', tilesLeft: 36, diff: 1 },
        { key: 'k1h1e11', label: '東2局1本場 9巡目 · 打牌の迷い', action: '打7p', tilesLeft: 36, diff: 1 },
        { key: 'k1h1e12', label: '東2局1本場 9巡目 · 和了の迷い', action: '和了', tilesLeft: 34, diff: 1 },
      ],
    });
  });

  it('E-17 迷い5 → 東3局1本場（4400）の候補2つ（6巡目の打9m・7巡目の打1p。どちらも差 1）', () => {
    expect(brief(links[4] as MarkLink)).toEqual({
      status: 'candidates',
      reason: null,
      candidates: [
        { key: 'k2h1e6', label: '東3局1本場 6巡目 · 打牌の迷い', action: '打9m', tilesLeft: 47, diff: 1 },
        { key: 'k2h1e7', label: '東3局1本場 7巡目 · 打牌の迷い', action: '打1p', tilesLeft: 45, diff: 1 },
      ],
    });
    expect(links[4]?.kyokuPositions).toEqual([4]);
  });

  it('E-17 迷い6 → 読めないので「手で選ぶ」（候補なし）', () => {
    expect(brief(links[5] as MarkLink)).toEqual({ status: 'manual', reason: 'unreadable', candidates: [] });
    expect(links[5]?.center).toBeNull();
    expect(links[5]?.kyokuPositions).toEqual([]);
  });

  it('E-17 文字認識の行（lines）のまま渡しても、読み取り済み（center）と同じ結果になる', () => {
    const byLines = linkMarks(
      report,
      loadFx4Ocr().map((m) => ({ lines: m.lines })),
    );
    expect(byLines.map(brief)).toEqual(links.map(brief));
  });

  it('E-17 候補の鍵は、保存して当て直せる（判断の番号は局の中の番号）', () => {
    const keys = links.flatMap((l) => l.candidates.map((c) => c.key));
    expect(keys).toEqual(['k0h0e4', 'k1h0e13', 'k1h1e7', 'k1h1e10', 'k1h1e11', 'k1h1e12', 'k2h1e6', 'k2h1e7']);
    expect(new Set(keys).size).toBe(keys.length);
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
      expect(brief(link as MarkLink), `残り${tilesLeft}枚`).toEqual({ status: 'manual', reason: 'no-kyoku', candidates: [] });
    }
    const [link] = linkMarks(report, [{ center: reading('E', 2, 40, 25000) }]);
    expect(link?.kyokuPositions).toEqual([1]);
    expect(link?.candidates.map((c) => c.key)).toEqual(['k1h0e8']);
  });

  it('E-17 リーチ棒の分を引いて当たる読み取りは、残り枚数がいちばん近い判断（リーチの判断）に結びつく', () => {
    const [link] = linkMarks(report, [{ center: reading('E', 2, 30, 24000) }]);
    expect(brief(link as MarkLink)).toEqual({
      status: 'linked',
      reason: null,
      candidates: [{ key: 'k1h0e10', label: '東2局 10巡目 · リーチの迷い', action: 'リーチ', tilesLeft: 33, diff: 3 }],
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

  it('E-17 局が1つに決まらない（kyokuPositions が複数）。両方の局の判断から、差がいちばん小さいものを選ぶ', () => {
    const [link] = linkMarks(report, [{ center: reading('E', 3, 60, 20700) }]);
    expect(link?.kyokuPositions).toEqual([4, 5]);
    // 3本場の 3 巡目（残り60枚）が差 0。2本場の最も近い判断は残り62枚と58枚（差 2）
    expect(brief(link as MarkLink)).toEqual({
      status: 'linked',
      reason: null,
      candidates: [{ key: 'k2h3e2', label: '東3局3本場 3巡目 · 打牌の迷い', action: '打中', tilesLeft: 60, diff: 0 }],
    });
  });

  it('E-17 差が同じ判断が別の局にもあれば、どちらも候補にする', () => {
    const [link] = linkMarks(report, [{ center: reading('E', 3, 68, 20700) }]);
    expect(link?.kyokuPositions).toEqual([4, 5]);
    expect(link?.status).toBe('candidates');
    expect(link?.candidates.map((c) => [c.key, c.tilesDiff])).toEqual([
      ['k2h2e0', 0],
      ['k2h3e0', 0],
    ]);
  });

  it('E-17 点数が違えば、本場は1つに決まる', () => {
    const [link] = linkMarks(report, [{ center: reading('E', 3, 60, 19700) }]);
    expect(link?.kyokuPositions).toEqual([3]);
    expect(link?.candidates.map((c) => c.key)).toEqual(['k2h1e2']);
  });

  it('E-17 同じ点数で3つ続く局（002ca97adccc486d の南4局・1本場・2本場）は、3つとも当たる', () => {
    const r = load('002ca97adccc486d');
    const [link] = linkMarks(r, [{ center: reading('S', 4, 46, 32400) }]);
    expect(link?.kyokuPositions).toEqual([13, 14, 15]);
    expect(link?.candidates.map((c) => [c.key, c.tilesDiff])).toEqual([
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
  });

  it('E-17 読めたが、この半荘に合う局が無い（別の半荘のスクショ）は no-kyoku。読み取った内容は返す', () => {
    const center = reading('S', 2, 40, 25000);
    const [link] = linkMarks(report, [{ center }]);
    expect(link).toMatchObject({ status: 'manual', reason: 'no-kyoku', center, kyokuPositions: [], candidates: [] });
  });

  it('E-17 合う局に自分の判断が1つも無いときは no-decision（局の位置は返す）', () => {
    const empty = structuredClone(report);
    const kyoku = empty.review.kyokus[3];
    if (!kyoku) throw new Error('東3局が無い');
    kyoku.entries = [];
    const [link] = linkMarks(empty, [{ center: reading('E', 3, 55, 16400) }]);
    expect(link).toMatchObject({ status: 'manual', reason: 'no-decision', kyokuPositions: [3], candidates: [] });
  });

  it('E-17 迷いマークが1つも無ければ空の一覧', () => {
    expect(linkMarks(report, [])).toEqual([]);
  });

  it('E-17 残りの牌の数が判断のどれとも離れていても、いちばん近い判断を返す（差は tilesDiff で分かる）', () => {
    const [link] = linkMarks(report, [{ center: reading('E', 3, 5, 16400) }]);
    expect(link?.status).toBe('linked');
    expect(link?.candidates[0]).toMatchObject({ key: 'k2h0e4', tilesLeft: 51, tilesDiff: 46 });
  });
});

describe('E-17 FX-1 の5半荘と FX-4 の全判断（盤面の点数と照らす）', () => {
  it('E-17 どの判断も、その時点の局・残りの牌の数・点数（リーチ棒の分を引いた表示）から結びつけると、その判断が差 0 の候補に入る', () => {
    let checked = 0;
    for (const id of [...FX1_IDS, FX4_ID]) {
      const imported = importReport(loadReportJson(id));
      if (!imported.ok) throw new Error(imported.error.message);
      const { decisions, report, playerId } = imported.value;
      const marks = decisions.map((d: Decision) => ({
        center: {
          wind: d.board.roundWind as 'E' | 'S' | 'W',
          number: d.board.kyoku as 1 | 2 | 3 | 4,
          tilesLeft: d.entry.tiles_left,
          score: d.board.scores[playerId] as number,
        },
      }));
      const links = linkMarks(report, marks);
      links.forEach((link, i) => {
        const d = decisions[i] as Decision;
        const hit = link.candidates.find((c) => c.kyokuPosition === d.kyokuPosition && c.entryIndex === d.entryIndex);
        expect(hit, `${id} ${d.kyokuLabel} ${d.junme}巡目`).toBeDefined();
        expect(link.candidates.every((c) => c.tilesDiff === 0), `${id} ${d.kyokuLabel} ${d.junme}巡目`).toBe(true);
        checked++;
      });
    }
    expect(checked).toBe(178 + 197 + 156 + 231 + 202 + 70);
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
