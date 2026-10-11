import { describe, expect, it } from 'vitest';

import { partialReadingOf } from '../src/center-text';
import { kyokuFactsOf, kyokuFits, kyokuFitsPartial, locateKyokus, locatePartialKyokus } from '../src/kyoku-locate';
import { parseReportText } from '../src/report';
import type { MortalReport } from '../src/report-types';
import { FX4_ID, FX5_ID, loadFx5Ocr, loadFx5Widget, loadReportText } from './helpers/fixtures';

function load(id: string): MortalReport {
  const r = parseReportText(loadReportText(id));
  if (!r.ok) throw new Error(r.error.message);
  return r.value;
}

// E-28 読めた部分に合う局: 分かった風と番号が同じで、局の始めの点数が合う局（E-17 と同じリーチ棒の扱い）。

describe('E-28 FX-5 の局（読めた部分に合う局の前提）', () => {
  const facts = kyokuFactsOf(load(FX5_ID));

  it('10局の名前・局の始めの点数・リーチが成立した残り枚数', () => {
    expect(facts.map((f) => [f.label, f.startScore, f.riichiTilesLeft])).toEqual([
      ['東1局', 25000, []],
      ['東2局', 25000, []],
      ['東3局', 23700, []],
      ['東3局1本場', 23700, []],
      ['東4局', 31700, []],
      ['東4局1本場', 31700, [56]],
      ['南1局2本場', 33700, []],
      ['南2局', 32500, []],
      ['南3局', 20500, []],
      ['南4局', 28500, [35]],
    ]);
  });
});

describe('E-28 読めた部分に合う局（FX-5）', () => {
  const report = load(FX5_ID);
  const facts = kyokuFactsOf(report);
  const positions = (reading: Parameters<typeof locatePartialKyokus>[1]) => locatePartialKyokus(facts, reading).map((f) => f.position);

  it('E-28 番号と点数（風は読めず）: 番号2・25000 は 東2局だけ（東1局も 25000 だが、番号が違う）', () => {
    expect(positions({ wind: null, number: 2, score: 25000, tilesLeft: null })).toEqual([1]);
  });

  it('E-28 風と点数（番号は読めず）: 東・23700 は 東3局と東3局1本場。南・33700 は 南1局2本場。南・28500 は 南4局', () => {
    expect(positions({ wind: 'E', number: null, score: 23700, tilesLeft: 59 })).toEqual([2, 3]);
    expect(positions({ wind: 'S', number: null, score: 33700, tilesLeft: 60 })).toEqual([6]);
    expect(positions({ wind: 'S', number: null, score: 28500, tilesLeft: 49 })).toEqual([9]);
  });

  it('E-28 点数だけ: 局の始めの点数が合う局すべて（31700 は 東4局と東4局1本場。33700 は 南1局2本場だけ）', () => {
    expect(positions({ wind: null, number: null, score: 31700 })).toEqual([4, 5]);
    expect(positions({ wind: null, number: null, score: 33700 })).toEqual([6]);
    expect(positions({ wind: null, number: null, score: 25000 })).toEqual([0, 1]);
  });

  it('E-28 読めた風・番号は、局の名前と同じでなければならない（風だけ・番号だけ・両方）', () => {
    expect(positions({ wind: 'S', number: null, score: 25000 })).toEqual([]);
    expect(positions({ wind: 'E', number: 1, score: 25000 })).toEqual([0]);
    expect(positions({ wind: 'E', number: 2, score: 25000 })).toEqual([1]);
    expect(positions({ wind: 'S', number: 2, score: 25000 })).toEqual([]);
    expect(positions({ wind: null, number: 4, score: 31700 })).toEqual([4, 5]);
    expect(positions({ wind: null, number: 4, score: 28500 })).toEqual([9]);
  });

  it('E-28 リーチ棒の分を引いた点数は、リーチが成立したあと（読んだ残り枚数が成立時以下）だけ当たる。残り枚数が読めていなければ、局のどこかで出していれば当たる', () => {
    // 南4局は 28500 始まりで、残り35枚でリーチが成立する。27500 は、成立したあと（残り35枚以下）にだけ読める
    expect(positions({ wind: null, number: null, score: 27500, tilesLeft: 32 })).toEqual([9]);
    expect(positions({ wind: null, number: null, score: 27500, tilesLeft: 35 })).toEqual([9]);
    expect(positions({ wind: null, number: null, score: 27500, tilesLeft: 36 })).toEqual([]);
    expect(positions({ wind: null, number: null, score: 27500 })).toEqual([9]);
    expect(positions({ wind: null, number: null, score: 27500, tilesLeft: null })).toEqual([9]);
    // 東4局1本場（31700 始まり）は、残り56枚でリーチが成立する。30700 は残り54枚で当たる
    expect(positions({ wind: 'E', number: null, score: 30700, tilesLeft: 54 })).toEqual([5]);
    expect(positions({ wind: 'E', number: null, score: 30700, tilesLeft: 60 })).toEqual([]);
  });

  it('E-28 点数が局の始めの点数に合わない（1000 点単位でない差・始めの点数より大きい・リーチ棒 2 本分）局は当たらない', () => {
    expect(positions({ wind: null, number: null, score: 24500 })).toEqual([]);
    expect(positions({ wind: null, number: null, score: 99900 })).toEqual([]);
    expect(positions({ wind: null, number: null, score: 26500, tilesLeft: 20 })).toEqual([]);
  });

  it('E-28 番号が 1〜4 でない・整数でないものは、どの局にも当たらない', () => {
    expect(positions({ wind: 'E', number: 0, score: 25000 })).toEqual([]);
    expect(positions({ wind: 'E', number: 5, score: 25000 })).toEqual([]);
    expect(positions({ wind: null, number: 2.5, score: 25000 })).toEqual([]);
  });

  it('E-28 風も番号もそろっていれば、E-17 の kyokuFits と同じ結果（全部読めたときの局の特定は変わらない）', () => {
    const cases: Array<Parameters<typeof kyokuFits>[1]> = [
      { wind: 'E', number: 2, score: 25000, tilesLeft: 46 },
      { wind: 'E', number: 3, score: 23700, tilesLeft: 59 },
      { wind: 'E', number: 4, score: 31700, tilesLeft: 49 },
      { wind: 'S', number: 4, score: 27500, tilesLeft: 32 },
      { wind: 'S', number: 4, score: 27500, tilesLeft: 40 },
      { wind: 'S', number: 1, score: 33700 },
    ];
    for (const reading of cases) {
      expect(locatePartialKyokus(facts, reading).map((f) => f.position), JSON.stringify(reading)).toEqual(
        locateKyokus(facts, reading).map((f) => f.position),
      );
      for (const f of facts) expect(kyokuFitsPartial(f, reading)).toBe(kyokuFits(f, reading));
    }
  });

  it('E-28 FX-5 の崩れた迷い5枚の読み取りが、それぞれ合う局（ユーザーが選んだ局）に当たる', () => {
    const ocr = loadFx5Ocr();
    const marks = loadFx5Widget().filter((e) => e.type === 'mark');
    const fitsAt = (clock: string): number[] => {
      const event = marks.find((e) => e.time.slice(11, 19) === clock);
      const shot = event?.screenshot === undefined ? undefined : ocr.entries[event.screenshot];
      if (shot === undefined) throw new Error(`${clock} の迷いが無い`);
      const reading = partialReadingOf({ lines: shot.lines, retries: shot.retries?.map((r) => r.lines) });
      return reading === null ? [] : positions(reading);
    };
    expect(fitsAt('15:37:02')).toEqual([1]); // 東2局（ユーザーが選んだ k1h0e5）
    expect(fitsAt('15:38:10')).toEqual([1]); // 東2局（k1h0e8）
    expect(fitsAt('15:40:03')).toEqual([2, 3]); // 東3局か東3局1本場（東3局には自分の判断が無い。ユーザーが選んだのは東3局1本場 k2h1e1）
    expect(fitsAt('15:50:36')).toEqual([6]); // 南1局2本場（k4h2e2）
    expect(fitsAt('16:03:19')).toEqual([9]); // 南4局（k7h0e6）
    expect(fitsAt('15:42:37')).toEqual([]); // 読めない
  });
});

describe('E-28 FX-4 でも、崩れた部分だけで局が絞れる', () => {
  const facts = kyokuFactsOf(load(FX4_ID));
  const positions = (reading: Parameters<typeof locatePartialKyokus>[1]) => locatePartialKyokus(facts, reading).map((f) => f.position);

  it('E-28 東2局1本場（15100）と東2局（19000）は、点数だけで区別できる。番号3の 4400 は 東3局1本場', () => {
    expect(positions({ wind: null, number: null, score: 15100 })).toEqual([2]);
    expect(positions({ wind: null, number: null, score: 19000 })).toEqual([1]);
    expect(positions({ wind: null, number: 3, score: 4400 })).toEqual([4]);
    expect(positions({ wind: 'E', number: null, score: 16400 })).toEqual([3]);
  });
});
