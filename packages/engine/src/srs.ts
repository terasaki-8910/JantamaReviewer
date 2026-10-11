/**
 * 解き直しの予定（E-5、E-25、F7）。
 *
 * 間隔は 1 → 3 → 7 → 14 → 30 → 60日。正解が続くと次の間隔へ進み（60日からは進まない）、間違えると1日に戻る。
 * 正解でも、答えを選び直した（選び直した回数が 1 以上の）問題は、間隔を進めず同じ間隔でもう一度出す（R8-6）。
 * 正解は、AI がその行動に付けた確率が5%以上のとき（F2 の基準と同じ）。
 * 出題（今日の出題）で答えた問題は、正解かどうかにかかわらず、1日後に解き直しに出る（E-25）。
 * 日付は、利用者の地域の暦の日付（YYYY-MM-DD の文字列）で扱う。UTC ではなく、手元の暦で数える。
 * 今日の日付は引数で渡す（関数の中で現在時刻を読まないので、テストで固定できる）。
 * 「今日」は、午前 4 時までを前の日として数える（`studyDate`。Anki と同じ。夜遅くまで打った日の出題が、日付をまたいで変わらないように）。
 */

/** 解き直しの間隔（日）。 */
export const REVIEW_INTERVALS_DAYS = [1, 3, 7, 14, 30, 60] as const;

/** 正解とする、AI がその行動に付けた確率の下限（5%）。 */
export const CORRECT_PROBABILITY_THRESHOLD = 0.05;

/** AI がその行動に付けた確率が基準以上なら正解。 */
export function isCorrectAnswer(prob: number, threshold: number = CORRECT_PROBABILITY_THRESHOLD): boolean {
  return prob >= threshold;
}

/**
 * 次の間隔（日）。
 * - 初めて予定を立てる（current が null）: 1日
 * - 間違えた: 1日に戻る
 * - 正解: いまより長い次の間隔（60日のあとは60日）
 */
export function nextIntervalDays(current: number | null, correct: boolean): number {
  if (current === null || !correct) return Math.min(...REVIEW_INTERVALS_DAYS);
  const next = REVIEW_INTERVALS_DAYS.find((d) => d > current);
  return next ?? Math.max(...REVIEW_INTERVALS_DAYS);
}

const DATE_PATTERN = /^(\d{4})-(\d{2})-(\d{2})$/;

/** 暦の日付（YYYY-MM-DD）として正しいか確かめて、年・月・日にする。正しくなければ RangeError。 */
function parseLocalDate(text: string): { year: number; month: number; day: number } {
  const m = DATE_PATTERN.exec(text);
  const year = Number(m?.[1]);
  const month = Number(m?.[2]);
  const day = Number(m?.[3]);
  if (!m || month < 1 || month > 12 || day < 1 || day > new Date(year, month, 0).getDate()) {
    throw new RangeError(`日付は YYYY-MM-DD の実在する日付です: ${JSON.stringify(text)}`);
  }
  return { year, month, day };
}

/** 手元の暦の日付（YYYY-MM-DD）にする。UTC ではなく、その時刻の地域の暦で数える。 */
export function toLocalDateString(date: Date): string {
  const y = String(date.getFullYear()).padStart(4, '0');
  const m = String(date.getMonth() + 1).padStart(2, '0');
  const d = String(date.getDate()).padStart(2, '0');
  return `${y}-${m}-${d}`;
}

/** 「今日」が切り替わる時刻（ローカル時刻の時）。これより前は、前の日として数える。 */
export const STUDY_DAY_START_HOUR = 4;

/**
 * 出題・解き直しの「今日」。その時刻の地域の暦の日付で、午前 4 時（`STUDY_DAY_START_HOUR`）より前は前の日。
 * 今日の出題・解き直しの期限・答えた日は、すべてこの 1 つの関数で決める。
 */
export function studyDate(now: Date): string {
  return toLocalDateString(new Date(now.getTime() - STUDY_DAY_START_HOUR * 3_600_000));
}

/** 暦の日付に日数を足す（負の数も可）。月末・年末・うるう年は暦のとおり。 */
export function addDays(date: string, days: number): string {
  if (!Number.isInteger(days)) throw new RangeError(`日数は整数です: ${days}`);
  const { year, month, day } = parseLocalDate(date);
  return toLocalDateString(new Date(year, month - 1, day + days));
}

export interface ReviewSchedule {
  /** 次の間隔（日）。 */
  intervalDays: number;
  /** 次に解き直す日（暦の日付）。 */
  dueDate: string;
}

/**
 * 答えたあとの予定。current は前回の間隔（日。初めてなら null）、today は答えた日（暦の日付）。
 * 次に解き直す日は、today に新しい間隔を足した日。
 * - 間違えた: 1日
 * - 正解でも、答えを選び直した（`reselectCount` が 1 以上）: 間隔は進めず、前回と同じ間隔（まだ間隔が無ければ 1日。R8-6）
 * - 正解: 次の間隔
 */
export function scheduleReview(
  current: number | null,
  correct: boolean,
  today: string,
  reselectCount = 0,
): ReviewSchedule {
  const intervalDays =
    correct && reselectCount >= 1 ? (current ?? nextIntervalDays(null, true)) : nextIntervalDays(current, correct);
  return { intervalDays, dueDate: addDays(today, intervalDays) };
}

/** 出題（今日の出題）で答えたときの、最初の予定: 正解かどうかにかかわらず、1日後（E-25）。today は答えた日。 */
export function scheduleFirstReview(today: string): ReviewSchedule {
  return scheduleReview(null, true, today);
}

/** 今日が期限の日か、過ぎているか。 */
export function isDue(dueDate: string, today: string): boolean {
  parseLocalDate(dueDate);
  parseLocalDate(today);
  return dueDate <= today;
}
