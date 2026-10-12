/**
 * 週の集計（F8、U-30、R11-12）の、画面に依存しない部分: 週の区切り・数え方・8 週の並び。純粋な関数だけ。
 *
 * - 週は月曜から日曜。日の区切りは午前 4 時（検討ログと同じ。`studyDate`・`weekStart`。ここでは作り直さない）
 * - 答えた局面 = 保存した答え 1 件（出題でも解き直しでも）。消した半荘・結果を読めない半荘の答えは、呼ぶ側が渡さない（D-3）
 * - 差の原因の割合は、その週に答えた局面に対する割合（R10-8）。1 つの局面に原因が 2 つ付くと両方に数えるので、合計は 100% を超える
 * - 局面の種類は重なる（検討ログの絞り込みと同じ `LogPhase`）。正解率は、その種類の局面のうち正解だった割合
 * - 一致率とずれ: 局ごとに、自分の〇△✕と AI 基準の段階を、エンジンの帯の規則（`agreesWithGrade`・`markOffsetFromGrade`。
 *   局の表の旗と同じ帯）で比べる。一致 = 同じ帯。ずれ = 自分 - AI 基準（〇3・△2・✕1。-2 から 2。負は、AI より低く付けた）
 * - 評価の週は、半荘を始めた週。迷いマークの週は、押した時刻の週。取り込んだ半荘の数は、半荘を始めた週
 */
import { CAUSE_CHOICES, addDays, studyDate, type CauseId, type HandOutcomeKind } from '@jantama/engine';

import type { AnswerMode } from '../../api/types';
import { PHASE_CHOICES, weekStart, type LogPhase } from '../log/logModel';

/** 小さな図の週の数（今週を含む直近 8 週）。 */
export const WEEK_COUNT = 8;

/** 原因の並び（答え合わせの画面と同じ）。 */
export const CAUSES: ReadonlyArray<{ id: CauseId; label: string }> = CAUSE_CHOICES;

/** 局の結果（点の図の 4 行）。他家のツモと他家どうしのロンは、「他家の和了」にまとめる。 */
export type ResultId = 'win' | 'dealIn' | 'draw' | 'others';

export const RESULTS: ReadonlyArray<{ id: ResultId; label: string }> = [
  { id: 'win', label: '自分の和了' },
  { id: 'dealIn', label: '放銃' },
  { id: 'draw', label: '流局' },
  { id: 'others', label: '他家の和了' },
];

/** 局の結果の分類（エンジン）を、点の図の行にする。 */
export function resultOf(kind: HandOutcomeKind): ResultId {
  switch (kind) {
    case 'win':
      return 'win';
    case 'dealIn':
      return 'dealIn';
    case 'draw':
      return 'draw';
    case 'othersTsumo':
    case 'othersRon':
      return 'others';
  }
}

// ---- 週と日付 ----

const WEEKDAYS = ['日', '月', '火', '水', '木', '金', '土'] as const;

function partsOf(date: string): { year: number; month: number; day: number } {
  const m = /^(\d{4})-(\d{2})-(\d{2})$/.exec(date);
  if (m === null) throw new RangeError(`日付は YYYY-MM-DD です: ${JSON.stringify(date)}`);
  return { year: Number(m[1]), month: Number(m[2]), day: Number(m[3]) };
}

/** その時刻の週の月曜（YYYY-MM-DD）。日の区切りは午前 4 時（月曜の午前 3 時 59 分は、前の週の日曜）。 */
export function weekOfInstant(ms: number): string {
  return weekStart(studyDate(new Date(ms)));
}

/** 「10月5日」。 */
export function monthDayText(date: string): string {
  const { month, day } = partsOf(date);
  return `${month}月${day}日`;
}

/** 「10月5日（月）」。 */
export function monthDayWeekdayText(date: string): string {
  const { year, month, day } = partsOf(date);
  return `${month}月${day}日（${WEEKDAYS[new Date(year, month - 1, day).getDay()] ?? ''}）`;
}

/** 「10/5」。小さな図の端の週の名前。 */
export function slashText(date: string): string {
  const { month, day } = partsOf(date);
  return `${month}/${day}`;
}

/** 週の範囲の言い方: 「10月5日（月）〜10月11日（日）」。 */
export function weekRangeText(monday: string): string {
  return `${monthDayWeekdayText(monday)}〜${monthDayWeekdayText(addDays(monday, 6))}`;
}

/** 週の名前: 「10月5日の週」。 */
export function weekNameText(monday: string): string {
  return `${monthDayText(monday)}の週`;
}

/** 月曜 `last` で終わる、直近 `count` 週の月曜（古い順）。 */
export function weeksEndingAt(last: string, count: number = WEEK_COUNT): string[] {
  return Array.from({ length: count }, (_, i) => addDays(last, -7 * (count - 1 - i)));
}

// ---- 入力 ----

/** 答えた局面 1 つ。 */
export interface WeekAnswer {
  /** 答えた週の月曜。 */
  week: string;
  mode: AnswerMode;
  correct: boolean;
  /** 差の原因。 */
  causes: readonly string[];
  /** 局面の種類（向聴数・鳴き・押し引き・序盤）。 */
  phases: readonly LogPhase[];
}

/** 自分の〇△✕と AI 基準を比べられた局 1 つ。 */
export interface WeekEvaluation {
  /** 半荘を始めた週の月曜。 */
  week: string;
  result: ResultId;
  /** 自分 - AI 基準（-2 から 2）。 */
  offset: number;
}

/** 迷いマーク 1 つ。 */
export interface WeekMark {
  /** 押した週の月曜。 */
  week: string;
  /** その迷いの問題に、答えがあるか。 */
  answered: boolean;
}

export interface WeekSource {
  answers: readonly WeekAnswer[];
  evaluations: readonly WeekEvaluation[];
  marks: readonly WeekMark[];
  /** 取り込んだ半荘の、半荘を始めた週の月曜（半荘 1 つにつき 1 つ）。 */
  games: readonly string[];
}

// ---- 1 週ぶんの数 ----

export interface PhaseRow {
  id: LogPhase;
  /** その種類の局面の数。 */
  n: number;
  correct: number;
  /** 正解率（%。四捨五入）。局面が無ければ null。 */
  rate: number | null;
}

export interface ResultRow {
  id: ResultId;
  label: string;
  /** その結果の、比べられた局の数。 */
  n: number;
  /** ずれの平均（段階）。局が無ければ null。 */
  mean: number | null;
}

export interface WeekSummary {
  /** 週の月曜。 */
  week: string;
  /** 答えた局面の数。 */
  answers: number;
  quiz: number;
  review: number;
  correct: number;
  /** 正解率（%）。答えが無ければ null。 */
  correctPercent: number | null;
  /** 原因ごとの、その原因が付いた局面の数。 */
  causeCounts: Readonly<Record<CauseId, number>>;
  /** 原因ごとの割合（%。答えた局面に対して。四捨五入）。答えが無ければ null。 */
  causePercents: Readonly<Record<CauseId, number>> | null;
  phases: readonly PhaseRow[];
  /** 自分の〇△✕と AI 基準を比べた局の数。 */
  evaluated: number;
  /** そのうち、同じ帯だった局の数。 */
  agreed: number;
  /** 一致率（%。四捨五入）。比べた局が無ければ null。 */
  agreePercent: number | null;
  results: readonly ResultRow[];
  marks: number;
  marksAnswered: number;
  games: number;
}

const percent = (part: number, whole: number): number => Math.round((part / whole) * 100);

/** 数の無い原因の表（0 で埋める）。 */
function zeroCauses(): Record<CauseId, number> {
  return { ukeire: 0, shape: 0, value: 0, defense: 0, other: 0 };
}

/** 1 週ぶんを数える。`answers` などは、その週のものだけ渡す。 */
function summarizeOne(
  week: string,
  answers: readonly WeekAnswer[],
  evaluations: readonly WeekEvaluation[],
  marks: readonly WeekMark[],
  games: number,
): WeekSummary {
  const causeCounts = zeroCauses();
  for (const answer of answers) {
    // 同じ原因が 2 つ入っていても、1 つの局面に 1 回だけ数える
    for (const id of new Set(answer.causes)) {
      if (id in causeCounts) causeCounts[id as CauseId] += 1;
    }
  }
  const correct = answers.filter((a) => a.correct).length;
  const causePercents: Record<CauseId, number> | null =
    answers.length === 0
      ? null
      : {
          ukeire: percent(causeCounts.ukeire, answers.length),
          shape: percent(causeCounts.shape, answers.length),
          value: percent(causeCounts.value, answers.length),
          defense: percent(causeCounts.defense, answers.length),
          other: percent(causeCounts.other, answers.length),
        };
  const phases: PhaseRow[] = PHASE_CHOICES.map((id) => {
    const inPhase = answers.filter((a) => a.phases.includes(id));
    const right = inPhase.filter((a) => a.correct).length;
    return { id, n: inPhase.length, correct: right, rate: inPhase.length === 0 ? null : percent(right, inPhase.length) };
  });
  const results: ResultRow[] = RESULTS.map(({ id, label }) => {
    const rows = evaluations.filter((e) => e.result === id);
    const mean = rows.length === 0 ? null : rows.reduce((sum, e) => sum + e.offset, 0) / rows.length;
    return { id, label, n: rows.length, mean };
  });
  const agreed = evaluations.filter((e) => e.offset === 0).length;
  return {
    week,
    answers: answers.length,
    quiz: answers.filter((a) => a.mode === 'quiz').length,
    review: answers.filter((a) => a.mode === 'review').length,
    correct,
    correctPercent: answers.length === 0 ? null : percent(correct, answers.length),
    causeCounts,
    causePercents,
    phases,
    evaluated: evaluations.length,
    agreed,
    agreePercent: evaluations.length === 0 ? null : percent(agreed, evaluations.length),
    results,
    marks: marks.length,
    marksAnswered: marks.filter((m) => m.answered).length,
    games,
  };
}

/** 渡した週ごとに数える（週の月曜 → 数）。`source` の、ほかの週のものは使わない。 */
export function summarizeWeeks(weeks: readonly string[], source: WeekSource): Map<string, WeekSummary> {
  const result = new Map<string, WeekSummary>();
  for (const week of weeks) {
    result.set(
      week,
      summarizeOne(
        week,
        source.answers.filter((a) => a.week === week),
        source.evaluations.filter((e) => e.week === week),
        source.marks.filter((m) => m.week === week),
        source.games.filter((g) => g === week).length,
      ),
    );
  }
  return result;
}

/**
 * 和了できなかった局（放銃・他家の和了）の、ずれの平均（局数で重みを付けた平均）と、その局数。
 * 週の集計の 1 文「和了できなかった局を、AI より平均 0.8 段階低く付けています」に使う。無ければ null。
 */
export function loseMean(summary: WeekSummary): { mean: number; n: number } | null {
  const rows = summary.results.filter((r) => (r.id === 'dealIn' || r.id === 'others') && r.mean !== null);
  const n = rows.reduce((sum, r) => sum + r.n, 0);
  if (n === 0) return null;
  return { mean: rows.reduce((sum, r) => sum + (r.mean as number) * r.n, 0) / n, n };
}

// ---- 小さな図の目盛り ----

/** 原因の小さな図が共有する縦軸の上端（%）。ふだんは 60。それを超える週があれば、80、100。 */
export function sharedCauseMax(summaries: readonly WeekSummary[]): 60 | 80 | 100 {
  let top = 0;
  for (const s of summaries) {
    if (s.causePercents === null) continue;
    for (const { id } of CAUSES) top = Math.max(top, s.causePercents[id]);
  }
  return top <= 60 ? 60 : top <= 80 ? 80 : 100;
}

/** 一致率の小さな線の縦の範囲。値の上下に余白を付ける（0 から 100 に収める。値が 1 つも無ければ 0〜100）。 */
export function percentSparkRange(values: ReadonlyArray<number | null>): { min: number; max: number } {
  const nums = values.filter((v): v is number => v !== null);
  if (nums.length === 0) return { min: 0, max: 100 };
  return { min: Math.max(0, Math.min(...nums) - 6), max: Math.min(100, Math.max(...nums) + 6) };
}

/**
 * 成績の小さな線の縦の範囲。値の幅の 3 割を、上下に足す。値が 1 つだけ、またはどれも同じなら、`flat` の幅（その値の前後）にする。
 * 値が 1 つも無ければ 0〜1（線は引かない）。
 */
export function valueSparkRange(values: ReadonlyArray<number | null>, flat: number): { min: number; max: number } {
  const nums = values.filter((v): v is number => v !== null);
  if (nums.length === 0) return { min: 0, max: 1 };
  const lo = Math.min(...nums);
  const hi = Math.max(...nums);
  if (hi - lo < 1e-9) return { min: lo - flat, max: hi + flat };
  const pad = (hi - lo) * 0.3;
  return { min: lo - pad, max: hi + pad };
}

// ---- 見られる週の範囲 ----

/**
 * 週の ← → で行ける範囲。新しい側は、今週まで。古い側は、記録のあるいちばん古い週まで。ただし、記録が無い週も 1 つ前までは
 * 見られる（今週に記録しかないとき、先週の「答えの無い週」の形を見られるように）。
 * `earliest` は、記録のあるいちばん古い週の月曜（無ければ null）。
 */
export function weekBounds(current: string, earliest: string | null): { min: string; max: string } {
  const previous = addDays(current, -7);
  return { min: earliest === null || earliest > previous ? previous : earliest, max: current };
}
