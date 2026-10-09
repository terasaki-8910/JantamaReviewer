/**
 * 取り込んだ半荘 1 つのまとめ（半荘の一覧の行と、検討画面の局の表に出すもの。F9・F10・F11）。
 *
 * - 卓: 結果に書いてある卓の表示（`split_logs[0].rule.disp`。例: 玉の間南喰赤）を「玉の間・南」の形にする
 * - Rating: 半荘全体と局ごと（E-12。mjai のサイトの値と同じ式）。表示用に小数第1位までの文字列も付ける
 * - 段階: Rating（100 倍）を、段階の当てはめ（E-13。既定は `DEFAULT_GRADE_MODEL`）で S+〜E の14段階にしたもの。半荘全体も局ごと
 * - 局ごと: 局の名前・結果（自分の和了・放銃・流局など）と点の増減・判断の数・暫定の〇△✕（`summarizeKyokus`）に、Rating・段階を足したもの
 * - 迷いマーク: 渡した迷いマークの結びつけ（E-17。`linkMarks`）
 */
import type { ScreenReading } from './center-text';
import { DEFAULT_GRADE_MODEL } from './default-grade-model';
import { type Grade, type GradeModel, predictGrade } from './grade';
import { type MarkLink, linkMarks } from './mark-link';
import { type KyokuSummary, summarizeKyokus } from './outcome';
import { formatRating, gameRating } from './rating';
import type { MortalReport } from './report-types';

/**
 * 卓の表示（rule.disp）から、「玉の間・南」の形の呼び名を作る。
 * 卓の名前（東・南の前まで）と、東か南（半荘の長さ）を取り、喰い断・赤ドラなどの表示は省く。
 * 東も南も見つからなければ、表示をそのまま返す。
 */
export function roomLabelOf(disp: string): string {
  const text = disp.trim();
  const m = /^(.+?)(東|南)/.exec(text);
  return m ? `${m[1]}・${m[2]}` : text;
}

/** 結果に書いてある卓の表示（`split_logs[0].rule.disp`）。無い・文字列でないときは null。 */
export function roomDispOf(report: MortalReport): string | null {
  const first: unknown = report.split_logs[0];
  if (typeof first !== 'object' || first === null) return null;
  const rule = (first as { rule?: unknown }).rule;
  if (typeof rule !== 'object' || rule === null) return null;
  const disp = (rule as { disp?: unknown }).disp;
  return typeof disp === 'string' && disp.trim() !== '' ? disp.trim() : null;
}

/** 卓の呼び名。例: 玉の間・南。結果に卓の表示が無ければ null。 */
export function roomLabel(report: MortalReport): string | null {
  const disp = roomDispOf(report);
  return disp === null ? null : roomLabelOf(disp);
}

/** 局ごとの行。`summarizeKyokus` の 1 局分に、段階などを足したもの。 */
export interface HanchanKyokuRow extends KyokuSummary {
  /** 本人の、局の始めの点数。 */
  startScore: number;
  /** Rating（`rating` は 0 から 1）を 100 倍して小数第1位までにした文字列。例: 91.6。判断が無い局は null。 */
  ratingText: string | null;
  /** 局の Rating から当てはめた段階。判断が無い局は null。 */
  grade: Grade | null;
}

/** 半荘のまとめ。 */
export interface HanchanSummary<T extends ScreenReading = ScreenReading> {
  /** 卓の呼び名。例: 玉の間・南。 */
  room: string | null;
  /** 結果に書いてある卓の表示のまま。例: 玉の間南喰赤。 */
  roomDisp: string | null;
  /** 半荘全体の Rating（0 から 1）。判断が1つも無ければ null。 */
  rating: number | null;
  /** 半荘全体の Rating を 100 倍して小数第1位までにした文字列。例: 93.0。mjai のサイトの値と同じ。 */
  ratingText: string | null;
  /** 半荘全体の Rating から当てはめた段階。 */
  grade: Grade | null;
  /** 判断の数（review.total_reviewed）。 */
  decisionCount: number;
  /** Mortal の1位と同じだった判断の数（review.total_matches）。 */
  matchCount: number;
  /** 局ごとの行（局の順）。 */
  kyokus: HanchanKyokuRow[];
  /** 渡した迷いマークの結びつけ（渡した順。渡さなければ空）。 */
  marks: MarkLink<T>[];
}

export interface HanchanSummaryOptions<T extends ScreenReading = ScreenReading> {
  /** 点数から段階への当てはめ。既定は `DEFAULT_GRADE_MODEL`（MAKA の評価が入力されたら、当てはめ直したものを渡す）。 */
  gradeModel?: GradeModel;
  /** 迷いマーク（読み取り済みの `center` か、文字認識の行 `lines` を持つ記録）。あれば `marks` に結びつけを返す。 */
  marks?: readonly T[];
}

/** 取り込んだ半荘のまとめを作る。 */
export function summarizeHanchan<T extends ScreenReading = ScreenReading>(
  report: MortalReport,
  options: HanchanSummaryOptions<T> = {},
): HanchanSummary<T> {
  const model = options.gradeModel ?? DEFAULT_GRADE_MODEL;
  const gradeOf = (rating: number | null): Grade | null => (rating === null ? null : predictGrade(model, rating * 100));

  const rating = gameRating(report);
  const kyokus = summarizeKyokus(report).map(
    (k): HanchanKyokuRow => ({
      ...k,
      startScore: report.review.kyokus[k.position]?.relative_scores[0] ?? 0,
      ratingText: k.rating === null ? null : formatRating(k.rating),
      grade: gradeOf(k.rating),
    }),
  );

  return {
    room: roomLabel(report),
    roomDisp: roomDispOf(report),
    rating,
    ratingText: rating === null ? null : formatRating(rating),
    grade: gradeOf(rating),
    decisionCount: report.review.total_reviewed,
    matchCount: report.review.total_matches,
    kyokus,
    marks: options.marks ? linkMarks(report, options.marks) : [],
  };
}
