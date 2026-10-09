/**
 * 段階（S+〜E の14段階）と、点数から段階への当てはめ（E-13、F10）。
 *
 * 点数は Mortal の Rating を 100 倍した値。MAKA の評価（段階）を入力するたびに、
 * 点数が高いほど段階が下がらない形（単調）で当てはめ直す。半荘を1つずつ外して予測する検証で、
 * 「ぴったり何割・±1段階以内何割」を出す。
 */
import { type IsotonicModel, fitIsotonic, predictIsotonic } from './isotonic';

/** 段階。添字が小さいほど低く、E が 0、S+ が 13。 */
export const GRADES = ['E', 'D', 'C-', 'C', 'C+', 'B-', 'B', 'B+', 'A-', 'A', 'A+', 'S-', 'S', 'S+'] as const;
export type Grade = (typeof GRADES)[number];

export const MAX_GRADE_INDEX = GRADES.length - 1;

/** 段階の名前を添字（0 から 13）にする。大文字小文字は区別しない。知らない名前は null。 */
export function gradeIndexOf(label: string): number | null {
  const index = (GRADES as readonly string[]).indexOf(label.trim().toUpperCase());
  return index < 0 ? null : index;
}

/** 添字（0 から 13）を段階の名前にする。範囲外は RangeError。 */
export function gradeLabel(index: number): Grade {
  const grade = Number.isInteger(index) ? GRADES[index] : undefined;
  if (grade === undefined) throw new RangeError(`段階の添字は 0 から ${MAX_GRADE_INDEX} の整数です: ${index}`);
  return grade;
}

/** 当てはめ値を段階の添字にする。四捨五入（.5 は切り上げ）して 0 から 13 に収める。 */
export function roundGradeIndex(value: number): number {
  return Math.min(Math.max(Math.floor(value + 0.5), 0), MAX_GRADE_INDEX);
}

function toIndex(grade: Grade | number): number {
  if (typeof grade === 'number') {
    gradeLabel(grade);
    return grade;
  }
  const index = gradeIndexOf(grade);
  if (index === null) throw new RangeError(`知らない段階です: ${JSON.stringify(grade)}`);
  return index;
}

/** 当てはめに使う 1 件の記録。MAKA の評価を入力するたびに 1 局分が増える。 */
export interface GradeRecord {
  /** どの半荘か（半荘を外す検証で使う名前。結果の ID など）。 */
  game: string;
  /** 点数（Mortal の Rating の 100 倍）。 */
  score: number;
  /** MAKA の評価。段階の名前（S+ など）か添字。 */
  grade: Grade | number;
}

export interface GradeModel {
  readonly isotonic: IsotonicModel;
  /** 当てはめに使った記録の数。 */
  readonly recordCount: number;
}

/** 記録から当てはめる。任意の記録の一覧から当てはめ直せる。記録が空なら RangeError。 */
export function fitGradeModel(records: readonly GradeRecord[]): GradeModel {
  if (records.length === 0) throw new RangeError('当てはめる記録がありません');
  const isotonic = fitIsotonic(
    records.map((r) => r.score),
    records.map((r) => toIndex(r.grade)),
  );
  return { isotonic, recordCount: records.length };
}

/** 点数の当てはめ値（段階の添字の連続値。0 から 13 に収める前）。 */
export function predictGradeValue(model: GradeModel, score: number): number {
  return predictIsotonic(model.isotonic, score);
}

/** 点数の段階の添字（0 から 13）。 */
export function predictGradeIndex(model: GradeModel, score: number): number {
  return roundGradeIndex(predictGradeValue(model, score));
}

/** 点数の段階。 */
export function predictGrade(model: GradeModel, score: number): Grade {
  return gradeLabel(predictGradeIndex(model, score));
}

/** 予測と MAKA の評価の一致の度合い。割合は 0 から 1。 */
export interface GradeAgreement {
  count: number;
  /** 段階がぴったり同じ割合。 */
  exact: number;
  /** ±1段階以内の割合。 */
  withinOne: number;
  /** ±2段階以内の割合。 */
  withinTwo: number;
  /** 段階のずれの平均。 */
  meanAbsoluteError: number;
}

/** 当てはめ値（連続値）を段階に丸めて、MAKA の評価（段階の添字）と比べる。 */
export function summarizeGradeAgreement(predicted: readonly number[], actual: readonly number[]): GradeAgreement {
  if (predicted.length !== actual.length) throw new RangeError('予測と評価の数が違います');
  const n = predicted.length;
  let exact = 0;
  let one = 0;
  let two = 0;
  let sum = 0;
  predicted.forEach((p, i) => {
    const err = Math.abs(roundGradeIndex(p) - (actual[i] as number));
    if (err === 0) exact++;
    if (err <= 1) one++;
    if (err <= 2) two++;
    sum += err;
  });
  const ratio = (k: number): number => (n === 0 ? Number.NaN : k / n);
  return { count: n, exact: ratio(exact), withinOne: ratio(one), withinTwo: ratio(two), meanAbsoluteError: ratio(sum) };
}

/** 半荘を1つずつ外す検証の結果。 */
export interface LeaveOneGameOutResult {
  /** 記録ごとの当てはめ値（その記録の半荘を外して当てはめたもの）。記録と同じ順。 */
  predictions: number[];
  /** 記録ごとの予測の段階の添字（0 から 13）。 */
  grades: number[];
  agreement: GradeAgreement;
}

/**
 * 半荘を1つずつ外して当てはめ、外した半荘の記録を予測する。
 * 半荘が1つしかない（外すと当てはめるものが無くなる）ときは null。
 */
export function evaluateLeaveOneGameOut(records: readonly GradeRecord[]): LeaveOneGameOutResult | null {
  const games = [...new Set(records.map((r) => r.game))];
  if (games.length < 2) return null;
  const predictions = new Array<number>(records.length).fill(Number.NaN);
  for (const game of games) {
    const model = fitGradeModel(records.filter((r) => r.game !== game));
    records.forEach((r, i) => {
      if (r.game === game) predictions[i] = predictGradeValue(model, r.score);
    });
  }
  const actual = records.map((r) => toIndex(r.grade));
  return {
    predictions,
    grades: predictions.map(roundGradeIndex),
    agreement: summarizeGradeAgreement(predictions, actual),
  };
}
