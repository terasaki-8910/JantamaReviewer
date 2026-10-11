/**
 * 画面中央の文字認識の結果から、局・残りの牌の数・自分の点数を取り出す（E-16、F11）。
 *
 * 入力は、雀魂の画面の中央（局・残りの牌の数・点数が出る部分）を切り出した画像を、Windows の日本語の
 * 文字認識で読んだ行（上から順）。読み取りは取り込みのとき（対局後）だけ行う（SPEC 2章）。
 * 本場は読まない（局の左に出る供託・本場の数は崩れやすい）。本場は、局の始めの点数との照合で区別する（E-17）。
 *
 * 文字認識は読み間違える。残りの牌の数の見出し「余」は「个」などになりやすく、局の左の小さな数や記号は崩れる。
 * そこで見出しの字では決めず、並びと数字から取る。
 * - 局: 空白を除いて `(東|南|西)([1-4])局` に当たる最初の行
 * - 点数: 局の行より後ろにある、数字だけの 3〜6 桁の行のうち、いちばん下のもの
 *   （雀魂の点数は 100 点単位なので、そうでない数は誤読として捨てる）
 * - 残りの牌の数: 局の行の残りと、局と点数の間の行のうち、見出しの字（数字でない字）の後ろに
 *   1〜2 桁の数が付いているもの。見出しの前に紛れた数字（例: `8 个 59` の 8）は取らない。いちばん点数に近い行を選ぶ
 * どれか1つでも取れなければ null（読めない。呼び出す側は、ユーザーに手で選んでもらう）。
 */
import { INITIAL_TILES_LEFT } from './replay';

/** 局の風。東・南・西（四麻の半荘で出る風）。 */
export type CenterWind = 'E' | 'S' | 'W';

/** 画面中央の読み取り結果。 */
export interface CenterText {
  /** 場風。 */
  wind: CenterWind;
  /** 場の中の局の番号（1 から 4）。 */
  number: 1 | 2 | 3 | 4;
  /** 残りの牌の数（0 から 70）。 */
  tilesLeft: number;
  /** 自分の点数。 */
  score: number;
}

const WIND_OF_CHAR: Readonly<Record<string, CenterWind>> = { 東: 'E', 南: 'S', 西: 'W' };

/** 局。空白を除いた行に当てる。 */
const KYOKU_PATTERN = /(東|南|西)([1-4])局/;
/** 点数の行: 数字だけの 3〜6 桁（先頭は 0 でない）。 */
const SCORE_PATTERN = /^[1-9]\d{2,5}$/;
/** 残りの牌の数: 行の終わりの 1〜2 桁。その前に、見出しの字（数字でない字）がある。 */
const TILES_LEFT_PATTERN = /\D(\d{1,2})$/;

/** 全角を半角にそろえ、空白（全角を含む）をすべて除く。 */
function clean(line: string): string {
  return line.normalize('NFKC').replace(/\s+/g, '');
}

/** 候補の行（下のものから）のうち、見出しの字の後ろに 1〜2 桁の数が付いていて、0〜70 に収まるもの。 */
function tilesLeftIn(candidates: readonly string[]): number | null {
  for (let i = candidates.length - 1; i >= 0; i--) {
    const m = TILES_LEFT_PATTERN.exec(candidates[i] as string);
    if (!m) continue;
    const value = Number(m[1]);
    if (value <= INITIAL_TILES_LEFT) return value;
  }
  return null;
}

/**
 * 文字認識の行（上から順）から、局・残りの牌の数・自分の点数を取り出す。読めなければ null。
 * 例: `['0009 乙', '東 1 局', '8 个 59', '25000']` は、東1局・残り59枚・25000点。
 */
export function parseCenterText(lines: readonly string[]): CenterText | null {
  const cleaned = lines.map(clean);

  let kyokuLine = -1;
  let kyoku: RegExpExecArray | null = null;
  for (let i = 0; i < cleaned.length && kyoku === null; i++) {
    kyoku = KYOKU_PATTERN.exec(cleaned[i] as string);
    if (kyoku !== null) kyokuLine = i;
  }
  if (kyoku === null) return null;
  const wind = WIND_OF_CHAR[kyoku[1] as string];
  if (wind === undefined) return null;

  let scoreLine = -1;
  for (let i = cleaned.length - 1; i > kyokuLine; i--) {
    if (SCORE_PATTERN.test(cleaned[i] as string)) {
      scoreLine = i;
      break;
    }
  }
  if (scoreLine < 0) return null;
  const score = Number(cleaned[scoreLine]);
  if (score % 100 !== 0) return null;

  const kyokuText = cleaned[kyokuLine] as string;
  const rest = kyokuText.slice(kyoku.index + kyoku[0].length);
  const tilesLeft = tilesLeftIn([rest, ...cleaned.slice(kyokuLine + 1, scoreLine)]);
  if (tilesLeft === null) return null;

  return { wind, number: Number(kyoku[2]) as CenterText['number'], tilesLeft, score };
}

/**
 * スクショ 1 枚の読み取り。結びつけの関数（迷いマーク・評価・半荘）には、このどちらかを持つ記録をそのまま渡せる。
 * 読み取り済みなら `center`（読めなかったときは null）、文字認識の行のままなら `lines`（`parseCenterText` に通す）。
 * どちらも無い記録は「読めない」として扱う。
 *
 * `retries` は、1 回目の読み取り（`lines`）で読めなかったときに順に試す、読み直しの行（E-20）。画像のコントラストを上げたものや、
 * 1.5 倍に広げたものを、文字認識にかけ直した結果。使うのは、`parseCenterText` が最初に読めたもの（1 回目で読めれば、使わない）。
 */
export interface ScreenReading {
  center?: CenterText | null;
  lines?: readonly string[];
  retries?: readonly (readonly string[])[];
}

/**
 * 文字認識の行のうち、最初に読めたものから、局・残りの牌の数・自分の点数を取り出す（E-20）。
 * 先に 1 回目の行（`lines`）を試し、読めなければ読み直しの行（`retries`）を順に試す。どれも読めなければ null。
 */
export function firstReadable(
  lines: readonly string[],
  retries: readonly (readonly string[])[] = [],
): CenterText | null {
  for (const attempt of [lines, ...retries]) {
    const parsed = parseCenterText(attempt);
    if (parsed !== null) return parsed;
  }
  return null;
}

/** スクショ 1 枚の読み取り結果。`center` があればそれ、無ければ `lines`（と `retries`）を読む。どちらも無ければ null（読めない）。 */
export function readingOf(input: ScreenReading): CenterText | null {
  if (input.center !== undefined) return input.center;
  if (input.lines === undefined) return null;
  return firstReadable(input.lines, input.retries);
}

// ---- 崩れた読み取りの部分（E-28。2026-10-11 のチャットの依頼。11回目のシートで確かめる） ----
//
// 文字認識は、局の名前を崩すことが多い（東が「第」、1 が「ア」、4 が抜ける、番号が無い、など）。局の名前（風・番号）か残りの牌の数が
// 崩れていても、自分の点数（100 点単位の、数字だけの行）が読めていれば、読めた部分だけを使えるようにする。
// 局の名前・残りの牌の数が全部そろったときだけ読める `parseCenterText` / `readingOf`（E-16）は、そのまま変えない。

/**
 * 崩れていても読めた部分だけの読み取り。風・番号・残りの牌の数は、読めたものだけが入る（読めなければ null）。点数は必ず入る
 * （局の名前も残りの牌の数も崩れたときの、局を決める手がかりが、点数の行だけのことがあるため）。
 */
export interface PartialCenterText {
  /** 場風。読めなければ null。 */
  wind: CenterWind | null;
  /** 場の中の局の番号（1 から 4）。読めなければ null。 */
  number: 1 | 2 | 3 | 4 | null;
  /** 残りの牌の数（0 から 70）。読めなければ null。 */
  tilesLeft: number | null;
  /** 自分の点数（100 点単位）。 */
  score: number;
}

/** 崩れてもよい局の行: 局の字の前の 1 字が風（東・南・西）か、局の番号の数字（1〜4）。空白を除いた行に当てる。 */
const KYOKU_LOOSE_PATTERN = /(東|南|西)?(.?)局/g;
/** 局の番号の字（1〜4）。 */
const KYOKU_NUMBER_PATTERN = /^[1-4]$/;
/** 点数の行（崩れた読み取り用）は、`SCORE_PATTERN` と同じ形で、100 点単位でないものは捨てて、さらに上の行を探す。 */
const LOOSE_SCORE_STEP = 100;

/** 読めた部分の数（風・番号・残りの牌の数のうち、読めたもの。0 から 3。点数は必ずあるので数えない）。 */
export function readParts(reading: PartialCenterText): number {
  return (reading.wind !== null ? 1 : 0) + (reading.number !== null ? 1 : 0) + (reading.tilesLeft !== null ? 1 : 0);
}

/** 風・番号・残りの牌の数がすべて読めているか（`CenterText` として使えるか）。 */
export function isFullReading(reading: PartialCenterText): reading is CenterText {
  return reading.wind !== null && reading.number !== null && reading.tilesLeft !== null;
}

/** 読み取り済みの `CenterText` を、部分の形（すべて読めた）にする。 */
export function partialOf(center: CenterText): PartialCenterText {
  return { wind: center.wind, number: center.number, tilesLeft: center.tilesLeft, score: center.score };
}

/** 局の行から、風と番号を読む（崩れていてよい）。風も番号も読めなければ null。`end` は、局の字の次の位置。 */
function looseKyokuIn(line: string): { wind: CenterWind | null; number: 1 | 2 | 3 | 4 | null; end: number } | null {
  for (const m of line.matchAll(KYOKU_LOOSE_PATTERN)) {
    const wind = m[1] === undefined ? null : (WIND_OF_CHAR[m[1]] ?? null);
    const digit = m[2] ?? '';
    const number = KYOKU_NUMBER_PATTERN.test(digit) ? (Number(digit) as 1 | 2 | 3 | 4) : null;
    if (wind === null && number === null) continue;
    return { wind, number, end: m.index + m[0].length };
  }
  return null;
}

/**
 * 文字認識の行（上から順）から、読めた部分だけを取り出す（E-28）。点数が読めなければ null。
 * 全部そろって読める（`parseCenterText` が読める）ものは、その結果をそのまま返す。そうでなければ、次のとおり読める部分だけを取る。
 * - 局: 空白を除いた行のうち、局の字の前の 1 字が風（東・南・西）か 1〜4 の数字である最初の行。風と番号は、読めたほうだけ
 *   例: `第 2 局` は番号 2、`南 ア 局` と `南 局` は風 南、`東 ア 局` は風 東
 * - 点数: 局の行より後ろ（局の行が無ければ、すべての行）の、数字だけの 3〜6 桁の行のうち、100 点単位で、いちばん下のもの
 *   （`parseCenterText` と違い、100 点単位でない行は誤読として捨てて、さらに上を探す）
 * - 残りの牌の数: 局の行があれば、`parseCenterText` と同じ（局の行の残りと、局と点数の間の行）。局の行が無いときは、
 *   点数の行のすぐ上の 1 行だけ（上のほうの崩れた行を、残りの牌の数と取り違えないため）。見出しの字の後ろに 1〜2 桁の数が付いていて、0〜70 のもの
 */
export function parsePartialCenterText(lines: readonly string[]): PartialCenterText | null {
  const full = parseCenterText(lines);
  if (full !== null) return partialOf(full);

  const cleaned = lines.map(clean);
  let kyoku: ReturnType<typeof looseKyokuIn> = null;
  let kyokuLine = -1;
  for (let i = 0; i < cleaned.length && kyoku === null; i++) {
    kyoku = looseKyokuIn(cleaned[i] as string);
    if (kyoku !== null) kyokuLine = i;
  }

  let scoreLine = -1;
  for (let i = cleaned.length - 1; i > kyokuLine; i--) {
    const line = cleaned[i] as string;
    if (SCORE_PATTERN.test(line) && Number(line) % LOOSE_SCORE_STEP === 0) {
      scoreLine = i;
      break;
    }
  }
  if (scoreLine < 0) return null;

  let candidates: string[];
  if (kyoku !== null) {
    candidates = [(cleaned[kyokuLine] as string).slice(kyoku.end), ...cleaned.slice(kyokuLine + 1, scoreLine)];
  } else {
    candidates = scoreLine >= 1 ? [cleaned[scoreLine - 1] as string] : [];
  }
  return {
    wind: kyoku?.wind ?? null,
    number: kyoku?.number ?? null,
    tilesLeft: tilesLeftIn(candidates),
    score: Number(cleaned[scoreLine]),
  };
}

/**
 * スクショ 1 枚から、読めた部分のいちばん多い読み取りを選ぶ（E-28）。1 回目の行（`lines`）と読み直しの行（`retries`）を、それぞれ
 * `parsePartialCenterText` で読み、読めた部分（風・番号・残りの牌の数）の数が最も多いものを使う（同じ数なら、先のもの）。
 * どれも点数が読めなければ null。`center` があればそれが先（読み取り済みの値は、すべて読めたものとして、そのまま。null なら読めない）。
 * すべて読めるものがあれば、`readingOf` と同じ結果になる。
 */
export function partialReadingOf(input: ScreenReading): PartialCenterText | null {
  if (input.center !== undefined) return input.center === null ? null : partialOf(input.center);
  if (input.lines === undefined) return null;
  let best: PartialCenterText | null = null;
  for (const attempt of [input.lines, ...(input.retries ?? [])]) {
    const parsed = parsePartialCenterText(attempt);
    if (parsed !== null && (best === null || readParts(parsed) > readParts(best))) best = parsed;
  }
  return best;
}
