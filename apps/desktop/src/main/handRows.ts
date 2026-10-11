/**
 * 局の評価の表（F10）の行を作る。画面にも Tauri にも依存しない（試験しやすいように分けてある）。
 *
 * 1 行 = 取り込んだ結果の 1 局。次を並べる:
 * - 結果と点の増減（`summary.kyokus` の局のまとめ）
 * - 自分の〇△✕: ウィジェットで付けた評価を、局に当てはめたもの（保存した結びつけ `links.ratings` が先。無いものは、迷いと評価を
 *   押した時刻の順に並べて当てはめる `linkRatings`。E-29）に、表で付け直した上書き（`self_ratings`）を重ねたもの。上書きの `none` は「評価なし」
 * - AI 基準: 局の Rating から当てはめた段階（まとめにある）
 * - MAKA: 利用者が入れた段階（任意。入れていなければ空）
 * - 印: 自分の〇△✕と AI 基準が大きく食い違う局（`disagreesWithGrade`。規則はエンジンの 1 つの関数）
 *
 * AI の候補・確率・順位は出てこない（SPEC F3）。出すのは、局の Rating から決めた段階と、その Rating の数字だけ。
 */
import {
  disagreesWithGrade,
  GRADES,
  linkRatings,
  type Grade,
  type HanchanSummary,
  type HandOutcomeKind,
  type MortalReport,
} from '@jantama/engine';

import type { Rating, SelfRatingValue, SessionRecord } from '../api/types';
import { kyokuKey, markReadings, ratingReadings } from './importFlow';

/** 局の結果の言い方（承認済みの見本の言葉）。 */
export const RESULT_TEXT: Readonly<Record<HandOutcomeKind, string>> = {
  win: '和了',
  dealIn: '放銃',
  draw: '流局',
  othersTsumo: '他家のツモ',
  othersRon: '他家どうしのロン',
};

/** 点の増減の書き方: 「+1,300」「−6,000」（マイナスは U+2212）。0 は「0」。 */
export function pointText(delta: number): string {
  if (delta === 0) return '0';
  const digits = String(Math.abs(delta)).replace(/\B(?=(\d{3})+(?!\d))/g, ',');
  return `${delta > 0 ? '+' : '−'}${digits}`;
}

/** 保存してある MAKA の段階の名前を、段階にする。14 段階のどれでもなければ null（無いものとして扱う）。 */
export function makaGradeOf(value: string | undefined): Grade | null {
  return GRADES.find((grade) => grade === value) ?? null;
}

export interface HandRow {
  /** 何番目の局か（review.kyokus の添字）。 */
  position: number;
  /** 局の鍵（自己評価・MAKA の保存の鍵）。 */
  key: string;
  /** 局の名前。例: 東2局1本場。 */
  label: string;
  /** 結果。例: 放銃。 */
  resultText: string;
  /** 点の増減。例: −12,000。 */
  deltaText: string;
  /** 表に出す、自分の〇△✕。無ければ null。 */
  self: Rating | null;
  /** ウィジェットで付けた評価（上書きの前）。無ければ null。 */
  widget: Rating | null;
  /** 保存してある上書き。無ければ undefined。 */
  override: SelfRatingValue | undefined;
  /** AI 基準（局の Rating から当てはめた段階）。判断の無い局は null。 */
  grade: Grade | null;
  /** その局の Rating（100 倍・小数第 1 位）。判断の無い局は null。 */
  ratingText: string | null;
  /** 入れてある MAKA の段階。無ければ null。 */
  maka: Grade | null;
  /** 自分の〇△✕と AI 基準が大きく食い違うか。 */
  flagged: boolean;
}

export interface HandTableData {
  rows: HandRow[];
  /** ウィジェットで付けた評価のうち、どの局にも出ていないものの数（局が足りない・同じ局に重なった、など）。 */
  unplacedRatings: number;
  /** 印の付いた局の数。 */
  flaggedCount: number;
  /** 半荘全体の行。 */
  hanchan: { grade: Grade | null; ratingText: string | null; maka: Grade | null };
}

/**
 * ウィジェットで付けた評価を、局ごとに当てはめる（局の添字 → 評価）。
 * 1 つの評価について、保存した結びつけ（局の鍵。空は「どの局にも結びつけない」）があればそれ、無ければ自動の当てはめ
 * （`linkRatings`。迷いと、利用者が選んだ迷いの結びつけも、手がかりにする）。同じ局に 2 つ当たったときは、あとに押したほうを使う。
 */
function widgetRatingsByKyoku(
  report: MortalReport,
  session: Pick<SessionRecord, 'marks' | 'ratings' | 'ocr' | 'links'>,
): { byPosition: Array<Rating | null>; unplaced: number } {
  const readings = ratingReadings(session, session.ocr);
  const automatic = new Map<number, number | null>();
  if (readings.length > 0) {
    for (const placement of linkRatings(report, readings, markReadings(session, session.ocr)).placements) {
      automatic.set(placement.rating.id, placement.position);
    }
  }
  const positionOfKey = new Map(report.review.kyokus.map((k, i) => [kyokuKey(k.kyoku, k.honba), i] as const));
  const byPosition: Array<Rating | null> = report.review.kyokus.map(() => null);
  const ordered = [...session.ratings].sort((a, b) => a.t_ms - b.t_ms || a.id - b.id);
  for (const rating of ordered) {
    const stored = session.links.ratings[String(rating.id)];
    const position =
      stored === undefined ? (automatic.get(rating.id) ?? null) : stored === '' ? null : (positionOfKey.get(stored) ?? null);
    if (position !== null) byPosition[position] = rating.rating;
  }
  const filled = byPosition.filter((value) => value !== null).length;
  return { byPosition, unplaced: session.ratings.length - filled };
}

/** 局の評価の表を作る。 */
export function buildHandTable(args: {
  report: MortalReport;
  summary: HanchanSummary;
  session: Pick<SessionRecord, 'marks' | 'ratings' | 'ocr' | 'links' | 'self_ratings' | 'maka'>;
}): HandTableData {
  const { report, summary, session } = args;
  const widget = widgetRatingsByKyoku(report, session);
  const rows = summary.kyokus.map((kyoku): HandRow => {
    const key = kyokuKey(kyoku.kyoku, kyoku.honba);
    const widgetRating = widget.byPosition[kyoku.position] ?? null;
    const override = session.self_ratings.kyokus[key];
    const self = override === undefined ? widgetRating : override === 'none' ? null : override;
    return {
      position: kyoku.position,
      key,
      label: kyoku.label,
      resultText: RESULT_TEXT[kyoku.outcome.kind],
      deltaText: pointText(kyoku.outcome.delta),
      self,
      widget: widgetRating,
      override,
      grade: kyoku.grade,
      ratingText: kyoku.ratingText,
      maka: makaGradeOf(session.maka.kyokus[key]),
      flagged: disagreesWithGrade(self, kyoku.grade),
    };
  });
  return {
    rows,
    unplacedRatings: widget.unplaced,
    flaggedCount: rows.filter((row) => row.flagged).length,
    hanchan: { grade: summary.grade, ratingText: summary.ratingText, maka: makaGradeOf(session.maka.hanchan) },
  };
}
