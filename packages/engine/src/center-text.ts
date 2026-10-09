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
 */
export interface ScreenReading {
  center?: CenterText | null;
  lines?: readonly string[];
}

/** スクショ 1 枚の読み取り結果。`center` があればそれ、無ければ `lines` を読む。どちらも無ければ null（読めない）。 */
export function readingOf(input: ScreenReading): CenterText | null {
  if (input.center !== undefined) return input.center;
  return input.lines === undefined ? null : parseCenterText(input.lines);
}
