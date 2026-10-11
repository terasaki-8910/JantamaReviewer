import { describe, expect, it } from 'vitest';

import {
  type CenterText,
  type PartialCenterText,
  isFullReading,
  parseCenterText,
  parsePartialCenterText,
  partialOf,
  partialReadingOf,
  readParts,
  readingOf,
} from '../src/center-text';
import { loadFx4Ocr, loadFx5Ocr, loadFx5Widget } from './helpers/fixtures';

// E-28 崩れた読み取りの部分（2026-10-11 のチャットの依頼）。
// 局の名前（風・番号）か残りの牌の数が崩れていても、自分の点数（100 点単位の、数字だけの行）が読めれば、読めた部分を使う。
// E-16 の関数（すべてそろったときだけ読める）は変えない。

describe('E-28 崩れた読み取りの部分（FX-5 の迷いの文字認識の写し。10月11日の半荘）', () => {
  const ocr = loadFx5Ocr();
  const marks = loadFx5Widget().filter((e) => e.type === 'mark');
  const shotAt = (clock: string) => {
    const event = marks.find((e) => e.time.slice(11, 19) === clock);
    const shot = event?.screenshot === undefined ? undefined : ocr.entries[event.screenshot];
    if (shot === undefined) throw new Error(`${clock} の迷いが無い`);
    return { lines: shot.lines, retries: shot.retries?.map((r) => r.lines) };
  };
  /** 押した時刻（「15:37:02」）の迷いの、1回目と読み直しの行から、読めた部分のいちばん多いものを選ぶ。 */
  const partialAt = (clock: string): PartialCenterText | null => partialReadingOf(shotAt(clock));
  /** 同じ迷いを、E-16 の関数（すべてそろったときだけ読める）で読む。 */
  const strictAt = (clock: string): CenterText | null => readingOf(shotAt(clock));

  it('E-28 15:37:02 は 番号2・残り50・25000（局の名前の風が「第」に崩れている。読み直しの 1.5 倍の行から）', () => {
    expect(partialAt('15:37:02')).toEqual({ wind: null, number: 2, tilesLeft: 50, score: 25000 });
    expect(strictAt('15:37:02')).toBeNull();
  });

  it('E-28 15:38:10 は 番号2・25000（残りの牌の数も崩れている）', () => {
    expect(partialAt('15:38:10')).toEqual({ wind: null, number: 2, tilesLeft: null, score: 25000 });
    expect(strictAt('15:38:10')).toBeNull();
  });

  it('E-28 15:40:03 は 東・残り59・23700（局の番号が「ア」に崩れている）', () => {
    expect(partialAt('15:40:03')).toEqual({ wind: 'E', number: null, tilesLeft: 59, score: 23700 });
    expect(strictAt('15:40:03')).toBeNull();
  });

  it('E-28 15:50:36 は 南・残り60・33700', () => {
    expect(partialAt('15:50:36')).toEqual({ wind: 'S', number: null, tilesLeft: 60, score: 33700 });
    expect(strictAt('15:50:36')).toBeNull();
  });

  it('E-28 16:03:19 は 南・残り49・28500（局の番号の字が抜けている）', () => {
    expect(partialAt('16:03:19')).toEqual({ wind: 'S', number: null, tilesLeft: 49, score: 28500 });
    expect(strictAt('16:03:19')).toBeNull();
  });

  it('E-28 15:42:37 は読めない（どの読み取りにも、100 点単位の数字だけの行が無い）', () => {
    expect(partialAt('15:42:37')).toBeNull();
    expect(strictAt('15:42:37')).toBeNull();
  });

  it('E-28 すべて読める迷い（7枚）は、E-16 の読み取りと同じ値（崩れた部分ではなく、全部）', () => {
    const clocks = ['15:37:25', '15:42:52', '15:43:46', '15:52:15', '15:54:39', '15:56:01', '15:58:10'];
    for (const clock of clocks) {
      const strict = strictAt(clock);
      const partial = partialAt(clock);
      expect(strict, clock).not.toBeNull();
      expect(partial, clock).toEqual(strict === null ? null : partialOf(strict));
      expect(partial !== null && isFullReading(partial), clock).toBe(true);
    }
  });

  it('E-28 13枚の内訳: すべて読めたのは7枚（E-16 の読み取りと同じ）、崩れた部分だけ読めたのは5枚、読めないのは1枚', () => {
    const results = marks.map((e) => partialAt(e.time.slice(11, 19)));
    expect(results).toHaveLength(13);
    expect(results.filter((r) => r === null)).toHaveLength(1);
    expect(results.filter((r) => r !== null && isFullReading(r))).toHaveLength(7);
    expect(results.filter((r) => r !== null && !isFullReading(r))).toHaveLength(5);
    expect(marks.map((e) => strictAt(e.time.slice(11, 19))).filter((r) => r !== null)).toHaveLength(7);
  });
});

describe('E-28 読めた部分を返す（作った入力）', () => {
  it('E-28 局の名前が崩れた形: 第 2 局・南 ア 局・南 局・東 ア 局 は、読めたほうの部分だけを取る', () => {
    expect(parsePartialCenterText(['第 2 局', '个 5 0', '25000'])).toEqual({ wind: null, number: 2, tilesLeft: 50, score: 25000 });
    expect(parsePartialCenterText(['南 ア 局', '个 6 0', '33700'])).toEqual({ wind: 'S', number: null, tilesLeft: 60, score: 33700 });
    expect(parsePartialCenterText(['南 局', '个 4 9', '28500'])).toEqual({ wind: 'S', number: null, tilesLeft: 49, score: 28500 });
    expect(parsePartialCenterText(['東 ア 局', '个 5 9', '23700'])).toEqual({ wind: 'E', number: null, tilesLeft: 59, score: 23700 });
  });

  it('E-28 局の行が読めなくても、点数の行があれば返す（局の行が無いときの残りの牌の数は、点数のすぐ上の行だけ）', () => {
    expect(parsePartialCenterText(['31700'])).toEqual({ wind: null, number: null, tilesLeft: null, score: 31700 });
    expect(parsePartialCenterText(['0 0', '8 个 、 3 2', '27500'])).toEqual({ wind: null, number: null, tilesLeft: 32, score: 27500 });
    // 上のほうの崩れた行（こ 0）は、残りの牌の数に取らない
    expect(parsePartialCenterText(['こ 0', '局 0 。', '2 5 0', '25000'])).toEqual({ wind: null, number: null, tilesLeft: null, score: 25000 });
    expect(parsePartialCenterText(['こ 0', '局 0 。', '个 5 0', '25000'])?.tilesLeft).toBe(50);
  });

  it('E-28 点数が読めなければ null（局の名前・残りの牌の数が読めていても）', () => {
    expect(parsePartialCenterText([])).toBeNull();
    expect(parsePartialCenterText(['第 2 局', '个 5 0'])).toBeNull();
    expect(parsePartialCenterText(['第 2 局', '个 5 0', '一 9800'])).toBeNull();
    expect(parsePartialCenterText(['東 1 局', '余 59', '25050'])).toBeNull();
    expect(parsePartialCenterText(['25000', '東 1 局'])).toBeNull();
  });

  it('E-28 点数は、100 点単位でない数字だけの行を捨てて、さらに上の行を探す（E-16 の関数は、そこで読めないとする）', () => {
    expect(parsePartialCenterText(['第 2 局', '个 5 0', '25000', '867'])).toEqual({ wind: null, number: 2, tilesLeft: 50, score: 25000 });
    expect(parseCenterText(['東 2 局', '个 5 0', '25000', '867'])).toBeNull();
  });

  it('E-28 すべて読めるものは、E-16 の関数と同じ値。風・番号・残りの牌の数・点数が、そのまま入る', () => {
    expect(parsePartialCenterText(['0009 乙', '東 1 局', '8 个 59', '25000'])).toEqual({ wind: 'E', number: 1, tilesLeft: 59, score: 25000 });
    expect(parsePartialCenterText(['東 3 局', '余 46', '4400'])).toEqual({ wind: 'E', number: 3, tilesLeft: 46, score: 4400 });
  });

  it('E-28 番号が 1〜4 でない・風が東南西でないときは、その部分は読めない扱い', () => {
    expect(parsePartialCenterText(['東 5 局', '余 59', '25000'])).toEqual({ wind: 'E', number: null, tilesLeft: 59, score: 25000 });
    expect(parsePartialCenterText(['北 1 局', '余 59', '25000'])).toEqual({ wind: null, number: 1, tilesLeft: 59, score: 25000 });
    expect(parsePartialCenterText(['乙 局 8 0', '余 59', '25000'])?.wind).toBeNull();
  });

  it('E-28 読めた部分の数: 風・番号・残りの牌の数のうち読めたもの（点数は必ず読めているので数えない）', () => {
    const base = { wind: null, number: null, tilesLeft: null, score: 25000 } satisfies PartialCenterText;
    expect(readParts(base)).toBe(0);
    expect(readParts({ ...base, number: 2 })).toBe(1);
    expect(readParts({ ...base, wind: 'S', tilesLeft: 3 })).toBe(2);
    expect(readParts({ wind: 'E', number: 1, tilesLeft: 59, score: 25000 })).toBe(3);
    expect(isFullReading({ ...base, wind: 'S', tilesLeft: 3 })).toBe(false);
    expect(isFullReading({ wind: 'E', number: 1, tilesLeft: 59, score: 25000 })).toBe(true);
  });

  it('E-28 入力は書き換えない。とても長い・奇妙な行でも、例外を出さない', () => {
    const input = ['第 2 局', '个 5 0', '25000'];
    const copy = [...input];
    parsePartialCenterText(input);
    expect(input).toEqual(copy);
    expect(parsePartialCenterText(['局'.repeat(10_000), '25000'])).toEqual({ wind: null, number: null, tilesLeft: null, score: 25000 });
    expect(parsePartialCenterText(['\0', '\r\n', '東 1 局 余 59'])).toBeNull();
  });
});

describe('E-28 1回目と読み直しのうち、読めた部分のいちばん多いものを使う', () => {
  const first = ['第 2 局', '个 5 0', '25000']; // 番号・残りの牌の数（2 つ）
  const second = ['東 2 局', '个 46', '25000']; // すべて（3 つ）
  const third = ['局', '25000']; // 無し（0 個）
  const sameCount = ['東 ア 局', '个 5 9', '25000']; // 風・残りの牌の数（2 つ）

  it('E-28 読めた部分が最も多い読み取りを使う（読み直しのほうが多ければ、読み直し）', () => {
    expect(partialReadingOf({ lines: first, retries: [second] })).toEqual({ wind: 'E', number: 2, tilesLeft: 46, score: 25000 });
    expect(partialReadingOf({ lines: third, retries: [first] })).toEqual({ wind: null, number: 2, tilesLeft: 50, score: 25000 });
  });

  it('E-28 同じ数なら、先の読み取り（1回目、そのあと読み直しの順）を使う', () => {
    expect(partialReadingOf({ lines: first, retries: [sameCount] })).toEqual({ wind: null, number: 2, tilesLeft: 50, score: 25000 });
    expect(partialReadingOf({ lines: sameCount, retries: [first] })).toEqual({ wind: 'E', number: null, tilesLeft: 59, score: 25000 });
  });

  it('E-28 点数が読めない読み取りは、飛ばす。どれも読めなければ null', () => {
    expect(partialReadingOf({ lines: ['崩れた', '行'], retries: [first] })).toEqual({ wind: null, number: 2, tilesLeft: 50, score: 25000 });
    expect(partialReadingOf({ lines: ['崩れた', '行'], retries: [['これも']] })).toBeNull();
    expect(partialReadingOf({ lines: ['崩れた'] })).toBeNull();
    expect(partialReadingOf({})).toBeNull();
    expect(partialReadingOf({ retries: [first] })).toBeNull();
  });

  it('E-28 center があれば、それが先（すべて読めたものとして、そのまま。null なら読めない）', () => {
    const given: CenterText = { wind: 'S', number: 2, tilesLeft: 10, score: 1000 };
    expect(partialReadingOf({ center: given, lines: first })).toEqual({ wind: 'S', number: 2, tilesLeft: 10, score: 1000 });
    expect(partialReadingOf({ center: null, lines: first, retries: [second] })).toBeNull();
  });

  it('E-28 すべて読めるものがあるときは、E-20 の readingOf と同じ結果（FX-4 の迷い6枚。読み直しを含む）', () => {
    const mark6 = loadFx4Ocr().find((m) => m.mark === 6);
    if (!mark6?.retries) throw new Error('迷い6の読み直しの写しが無い');
    const strict = readingOf({ lines: mark6.lines, retries: mark6.retries.map((r) => r.lines) });
    expect(strict).toEqual({ wind: 'E', number: 3, tilesLeft: 38, score: 4400 });
    for (const mark of loadFx4Ocr()) {
      const retries = mark.retries?.map((r) => r.lines);
      const full = readingOf({ lines: mark.lines, retries });
      expect(partialReadingOf({ lines: mark.lines, retries }), `迷い${mark.mark}`).toEqual(full === null ? null : partialOf(full));
    }
  });

  it('E-28 読み直しの行を渡しても、入力は書き換えない', () => {
    const retries = [[...first], [...second]];
    const copy = structuredClone(retries);
    partialReadingOf({ lines: third, retries });
    expect(retries).toEqual(copy);
  });
});
