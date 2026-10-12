/**
 * 局の自己評価（〇△✕）と、AI 基準の段階の食い違い（F10）。
 *
 * 「結果が悪かった局を、内容を見ずに低く付けていないか」を確かめるための印を付ける規則。
 * 段階（S+〜E の14段階）を、〇△✕に合わせた 3 つの帯に分けて、自己評価の帯と段階の帯が 2 つ離れているときに印を付ける。
 * - 〇の帯: S+ から S- まで
 * - △の帯: A+ から A- まで
 * - ✕の帯: B+ から E まで
 * 例: ✕と付けたのに AI 基準が S の帯、または〇と付けたのに AI 基準が B 以下の帯。△は、どの帯とも 1 つ以内なので、印は付かない。
 * 区切りは13回目のシートの答え（R13-3）。実際に出る段階は S と A がほとんどで、B 以下は少ない（MAKA の評価67局で S 40・A 17・B 4・C 以下 6）ため、
 * A を△の帯に置く（12回目の補足「Bをとることがほぼない以上相対的にAは悪い結果」）。
 *
 * 週の集計の「一致」と「ずれ」（U-30）も、同じ帯で決める（別の規則は作らない）:
 * - ずれ = 自分の帯の評価から AI 基準の帯の評価を引いた値（〇を 3・△を 2・✕を 1 として。-2 から 2。0 は同じ帯）
 * - 一致 = ずれが 0（同じ帯）。印を付ける「食い違い」は、ずれの大きさが 2 以上
 *
 * 区切りを変えるときは、この 1 つのファイルだけを直す。
 */
import { GRADES, type Grade } from './grade';
import type { HandMark } from './outcome';

/** 帯の番号。0 = 〇の帯、1 = △の帯、2 = ✕の帯。 */
export type HandBand = 0 | 1 | 2;

/** 〇の帯の下限（S-）の、段階の添字。これ以上が〇の帯。 */
const GOOD_BAND_FROM = GRADES.indexOf('S-');
/** △の帯の下限（A-）の、段階の添字。これ以上、〇の帯の手前までが△の帯。それより下は✕の帯。 */
const FAIR_BAND_FROM = GRADES.indexOf('A-');

/** 印を付ける、帯の離れ方（これ以上離れたら印）。 */
export const FLAG_BAND_GAP = 2;

/** 段階を、〇△✕の帯にする。 */
export function gradeBand(grade: Grade): HandBand {
  const index = GRADES.indexOf(grade);
  if (index >= GOOD_BAND_FROM) return 0;
  if (index >= FAIR_BAND_FROM) return 1;
  return 2;
}

/** 自己評価（〇△✕）を、帯の番号にする。 */
export function markBand(mark: HandMark): HandBand {
  if (mark === 'good') return 0;
  return mark === 'fair' ? 1 : 2;
}

/**
 * 自己評価と AI 基準の段階が、大きく食い違っているか（印を付けるか）。
 * 自己評価が無い・段階が無い局は、比べられないので印を付けない。
 */
export function disagreesWithGrade(mark: HandMark | null, grade: Grade | null): boolean {
  if (mark === null || grade === null) return false;
  return Math.abs(markBand(mark) - gradeBand(grade)) >= FLAG_BAND_GAP;
}

/** 帯の評価の点（〇 = 3、△ = 2、✕ = 1）。 */
function bandValue(band: HandBand): number {
  return 3 - band;
}

/**
 * 自分の評価から AI 基準の評価を引いた差（段階。-2 から 2。負は、AI より低く付けた）。
 * 自己評価が無い・段階が無い局は、比べられないので null。
 */
export function markOffsetFromGrade(mark: HandMark | null, grade: Grade | null): number | null {
  if (mark === null || grade === null) return null;
  return bandValue(markBand(mark)) - bandValue(gradeBand(grade));
}

/** 自己評価と AI 基準が同じ帯か（週の集計の「一致」）。比べられない局は null。 */
export function agreesWithGrade(mark: HandMark | null, grade: Grade | null): boolean | null {
  const offset = markOffsetFromGrade(mark, grade);
  return offset === null ? null : offset === 0;
}
