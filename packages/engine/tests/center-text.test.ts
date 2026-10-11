import { describe, expect, it } from 'vitest';

import { type CenterText, firstReadable, parseCenterText, readingOf } from '../src/center-text';
import { loadFx4Ocr } from './helpers/fixtures';

/** 空白だけの違いを気にせず書けるよう、行を ' | ' で区切った文字列から行を作る。 */
function lines(text: string): string[] {
  return text.split(' | ');
}

describe('E-16 局の読み取り（FX-4 の迷いマーク6枚の文字認識の写し）', () => {
  const marks = loadFx4Ocr();
  const read = (n: number) => {
    const mark = marks.find((m) => m.mark === n);
    if (!mark) throw new Error(`迷い${n}が無い`);
    return parseCenterText(mark.lines);
  };

  it('E-16 迷い1: 東1局・残り59枚・25000点（余の前に紛れた 8 は取らない）', () => {
    expect(read(1)).toEqual({ wind: 'E', number: 1, tilesLeft: 59, score: 25000 });
  });

  it('E-16 迷い2: 東2局・残り23枚・19000点（余が个に誤読されていても数字を取る）', () => {
    expect(read(2)).toEqual({ wind: 'E', number: 2, tilesLeft: 23, score: 19000 });
  });

  it('E-16 迷い3: 東2局・残り47枚・15100点（本場は読まない。点数で区別する）', () => {
    expect(read(3)).toEqual({ wind: 'E', number: 2, tilesLeft: 47, score: 15100 });
  });

  it('E-16 迷い4: 東2局・残り35枚・15100点', () => {
    expect(read(4)).toEqual({ wind: 'E', number: 2, tilesLeft: 35, score: 15100 });
  });

  it('E-16 迷い5: 東3局・残り46枚・4400点（4桁の点数）', () => {
    expect(read(5)).toEqual({ wind: 'E', number: 3, tilesLeft: 46, score: 4400 });
  });

  it('E-16 迷い6: 局が読めない（崩れた行だけ）ので null（読めない）', () => {
    expect(read(6)).toBeNull();
  });

  it('E-16 6枚すべてを通しても、読めたのは5枚だけ', () => {
    const results = marks.map((m) => parseCenterText(m.lines));
    expect(results.filter((r) => r !== null)).toHaveLength(5);
    expect(results.map((r) => r !== null)).toEqual([true, true, true, true, true, false]);
  });
});

describe('E-16 読み取りの許す範囲（作った入力）', () => {
  it('E-16 見出しの字は何でもよい: 余・个・介・全 など、数字でない字の後ろの数を取る', () => {
    for (const marker of ['余', '个', '介', '全', 'ㄗ', 'a']) {
      expect(parseCenterText(['0 0', '東 1 局', `${marker} 59`, '25000']), marker).toEqual({
        wind: 'E',
        number: 1,
        tilesLeft: 59,
        score: 25000,
      });
    }
  });

  it('E-16 空白の入り方（数字の間・見出しとの間・無し）や全角の数字・空白によらない', () => {
    const expected: CenterText = { wind: 'E', number: 3, tilesLeft: 46, score: 4400 };
    expect(parseCenterText(['東3局', '余46', '4400'])).toEqual(expected);
    expect(parseCenterText(['東 3 局', '余 4 6', '4 4 0 0'])).toEqual(expected);
    expect(parseCenterText(['東３局', '余４６', '４４００'])).toEqual(expected);
    expect(parseCenterText(['  東 3 局  ', '  余 46  ', '  4400  '])).toEqual(expected);
    expect(parseCenterText(['東3局', '', '余46', '', '4400'])).toEqual(expected);
  });

  it('E-16 南・西と、1〜4局', () => {
    expect(parseCenterText(['南 1 局', '余 66', '31000'])).toEqual({ wind: 'S', number: 1, tilesLeft: 66, score: 31000 });
    expect(parseCenterText(['南 4 局', '余 2', '8000'])).toEqual({ wind: 'S', number: 4, tilesLeft: 2, score: 8000 });
    expect(parseCenterText(['西 2 局', '余 40', '25000'])).toEqual({ wind: 'W', number: 2, tilesLeft: 40, score: 25000 });
  });

  it('E-16 残りの牌の数は 0 から 70。1 桁でもよい', () => {
    expect(parseCenterText(['東 1 局', '余 70', '25000'])?.tilesLeft).toBe(70);
    expect(parseCenterText(['東 1 局', '余 0', '25000'])?.tilesLeft).toBe(0);
    expect(parseCenterText(['東 1 局', '余 7', '25000'])?.tilesLeft).toBe(7);
  });

  it('E-16 点数は 3〜6 桁。上のほうの行より、いちばん下の数字だけの行を取る', () => {
    expect(parseCenterText(['東 1 局', '余 30', '100'])?.score).toBe(100);
    expect(parseCenterText(['東 1 局', '余 30', '102300'])?.score).toBe(102300);
    // 局と点数の間に数字だけの行があっても、いちばん下を点数にする
    expect(parseCenterText(['東 1 局', '1000', '余 30', '25000'])?.score).toBe(25000);
  });

  it('E-16 局と残りの牌の数が同じ行にあってもよい。局の左の崩れた数や記号は無視する', () => {
    expect(parseCenterText(['00 し 8 し 東 2 局 个 4 7', '15100'])).toEqual({ wind: 'E', number: 2, tilesLeft: 47, score: 15100 });
    expect(parseCenterText(['0009 乙', '東 1 局', '、 一', '8 个 59', '25000'])?.tilesLeft).toBe(59);
  });

  it('E-16 局の左の数字だけの行（供託・本場）は、局の行より前なので、点数にも残りの牌の数にも取らない', () => {
    expect(parseCenterText(['1200', '東 1 局', '余 59', '25000'])).toEqual({ wind: 'E', number: 1, tilesLeft: 59, score: 25000 });
    expect(parseCenterText(['00', '東 1 局', '余 59', '25000'])?.tilesLeft).toBe(59);
  });

  it('E-16 残りの牌の数の行が2つあるときは、点数に近い（下の）ほうを取る', () => {
    expect(parseCenterText(['東 1 局', '乙 00', '余 59', '25000'])?.tilesLeft).toBe(59);
  });

  it('E-16 読み取りは入力を書き換えない', () => {
    const input = ['0009 乙', '東 1 局', '8 个 59', '25000'];
    const copy = [...input];
    parseCenterText(input);
    expect(input).toEqual(copy);
  });
});

describe('E-16 読めないものは null（作った入力）', () => {
  it('E-16 空・空白だけ・局を含まない行は null', () => {
    expect(parseCenterText([])).toBeNull();
    expect(parseCenterText(['', '   '])).toBeNull();
    expect(parseCenterText(['余 59', '25000'])).toBeNull();
    expect(parseCenterText(lines('0009 乙 | 余 59 | 25000'))).toBeNull();
  });

  it('E-16 局が読めない（風が違う・番号が範囲外・局の字が無い）と null', () => {
    expect(parseCenterText(['北 1 局', '余 59', '25000'])).toBeNull();
    expect(parseCenterText(['東 5 局', '余 59', '25000'])).toBeNull();
    expect(parseCenterText(['東 0 局', '余 59', '25000'])).toBeNull();
    expect(parseCenterText(['東 1', '余 59', '25000'])).toBeNull();
    expect(parseCenterText(['乙 局 8 0', '余 59', '25000'])).toBeNull();
    expect(parseCenterText(['東 一 局', '余 59', '25000'])).toBeNull();
  });

  it('E-16 点数が読めない（行が無い・桁が合わない・100 点単位でない・崩れている）と null', () => {
    expect(parseCenterText(['東 1 局', '余 59'])).toBeNull();
    expect(parseCenterText(['東 1 局', '余 59', '25'])).toBeNull();
    expect(parseCenterText(['東 1 局', '余 59', '2500000'])).toBeNull();
    expect(parseCenterText(['東 1 局', '余 59', '25050'])).toBeNull();
    expect(parseCenterText(['東 1 局', '余 59', '025000'])).toBeNull();
    expect(parseCenterText(['東 1 局', '余 59', '25 000 円'])).toBeNull();
    expect(parseCenterText(['東 1 局', '余 59', '、 一 3 詈 0'])).toBeNull();
  });

  it('E-16 点数の行が崩れているとき、上のほうの数字だけの行を点数と取り違えない（100 点単位でなければ捨てる）', () => {
    expect(parseCenterText(['東 1 局', '859', '、 一 3 詈 0'])).toBeNull();
  });

  it('E-16 残りの牌の数が読めない（見出しが無い・3桁以上・71 以上・行が無い）と null', () => {
    expect(parseCenterText(['東 1 局', '59', '25000'])).toBeNull();
    expect(parseCenterText(['東 1 局', '个 159', '25000'])).toBeNull();
    expect(parseCenterText(['東 1 局', '余 71', '25000'])).toBeNull();
    expect(parseCenterText(['東 1 局', '余 99', '25000'])).toBeNull();
    expect(parseCenterText(['東 1 局', '余', '25000'])).toBeNull();
    expect(parseCenterText(['東 1 局', '25000'])).toBeNull();
  });

  it('E-16 局より前の行にだけ数字がある（点数・残りの牌の数が局の後ろに無い）と null', () => {
    expect(parseCenterText(['25000', '余 59', '東 1 局'])).toBeNull();
    expect(parseCenterText(['余 59 25000', '東 1 局'])).toBeNull();
  });

  it('E-16 とても長い・奇妙な行でも、例外を出さず null か結果を返す', () => {
    expect(parseCenterText(['あ'.repeat(100_000), '東 1 局', '余 59', '25000'])).toEqual({
      wind: 'E',
      number: 1,
      tilesLeft: 59,
      score: 25000,
    });
    expect(parseCenterText(['東'.repeat(10_000)])).toBeNull();
    expect(parseCenterText(['\0', '\r\n', '東 1 局 余 59'])).toBeNull();
  });
});

describe('E-20 読み直し（コントラストを上げた画像・1.5倍に広げた画像で読み直した行）を、最初に読めたものから取る', () => {
  const mark6 = loadFx4Ocr().find((m) => m.mark === 6);
  if (!mark6?.retries) throw new Error('迷い6の読み直しの写しが無い');
  const [contrast, enlarged] = mark6.retries.map((r) => r.lines);
  const expected: CenterText = { wind: 'E', number: 3, tilesLeft: 38, score: 4400 };

  it('E-20 迷い6: 1回目の行は読めない（null）が、読み直しの行はどちらも 東3局・残り38枚・4400点（余の前の 8 は取らない）', () => {
    expect(parseCenterText(mark6.lines)).toBeNull();
    expect(parseCenterText(contrast ?? [])).toEqual(expected);
    expect(parseCenterText(enlarged ?? [])).toEqual(expected);
  });

  it('E-20 firstReadable: 1回目で読めれば、読み直しは見ない。読めなければ、読み直しを順に試して、最初に読めたものを使う', () => {
    const first = ['東 1 局', '余 59', '25000'];
    const later = ['東 2 局', '余 40', '19000'];
    expect(firstReadable(first, [later])).toEqual({ wind: 'E', number: 1, tilesLeft: 59, score: 25000 });
    expect(firstReadable(mark6.lines, [contrast ?? [], later])).toEqual(expected);
    // 最初の読み直しが読めなければ、次の読み直し
    expect(firstReadable(mark6.lines, [['崩れた', '行'], enlarged ?? []])).toEqual(expected);
    // どれも読めなければ null。読み直しが無くてもよい
    expect(firstReadable(mark6.lines, [['崩れた', '行']])).toBeNull();
    expect(firstReadable(mark6.lines)).toBeNull();
    expect(firstReadable(first)).toEqual({ wind: 'E', number: 1, tilesLeft: 59, score: 25000 });
  });

  it('E-20 readingOf: lines だけなら 1回目だけ。retries があれば、1回目で読めないときに使う。center があれば、それが先', () => {
    expect(readingOf({ lines: mark6.lines })).toBeNull();
    expect(readingOf({ lines: mark6.lines, retries: [contrast ?? []] })).toEqual(expected);
    expect(readingOf({ lines: ['東 1 局', '余 59', '25000'], retries: [contrast ?? []] })?.number).toBe(1);
    const given: CenterText = { wind: 'S', number: 2, tilesLeft: 10, score: 1000 };
    expect(readingOf({ center: given, lines: mark6.lines, retries: [contrast ?? []] })).toBe(given);
    expect(readingOf({ center: null, retries: [contrast ?? []] })).toBeNull();
    expect(readingOf({ retries: [contrast ?? []] })).toBeNull();
    expect(readingOf({})).toBeNull();
  });

  it('E-20 読み直しの行を渡しても、入力は書き換えない', () => {
    const retries = [[...(contrast ?? [])], [...(enlarged ?? [])]];
    const copy = structuredClone(retries);
    firstReadable(mark6.lines, retries);
    expect(retries).toEqual(copy);
  });
});
