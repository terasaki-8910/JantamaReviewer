import { GRADES, type Grade } from '@jantama/engine';

/**
 * 段階の印（U-7、R7-2・R8-2）。14 段階（S+〜E）すべてに使う、ただ 1 つの部品。
 * S+〜B- の 9 段は、卓の緑 1 色の濃さで塗り、C+〜E は塗らずに線だけにする。色は tokens.css のトークンから
 * （`data-grade` で styles/sessions.css が選ぶ）。ここでは色を決めない。
 */

/** 表示の順（強い順）: S+ S S- A+ A A- B+ B B- C+ C C- D E。エンジンの `GRADES` は弱い順なので、逆にする。 */
export const DISPLAY_GRADES: readonly Grade[] = [...GRADES].reverse();

/** 塗りのある段階（S+〜B-）。それより下は線だけ。 */
export const FILLED_GRADES: readonly Grade[] = DISPLAY_GRADES.slice(0, 9);

export function isFilledGrade(grade: Grade): boolean {
  return FILLED_GRADES.includes(grade);
}

interface GradeBadgeProps {
  grade: Grade;
  /** `lg` は、半荘のページの見出しに置く大きさ。既定は一覧の行の大きさ。 */
  size?: 'sm' | 'lg';
}

export function GradeBadge({ grade, size = 'sm' }: GradeBadgeProps) {
  return (
    <span className={size === 'lg' ? 'grade lg' : 'grade'} data-grade={grade}>
      {grade}
    </span>
  );
}
