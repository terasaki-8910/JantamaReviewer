/**
 * 検討画面の画面（ページ）の一覧と、画面の切り替えの決まり（N-5）。
 *
 * どの画面を見ているかは、メモリの中の状態だけで持つ。URL のパス・ハッシュ・履歴の項目は使わない
 * （ブラウザの戻る・進む・再読み込みが意味を持たない。使わないことは、eslint の規則が確かめる）。
 */
export const VIEWS = ['records', 'settings'] as const;

export type View = (typeof VIEWS)[number];

/** 最初に出す画面。知らない画面の名前が来たときも、ここに戻る。 */
export const START_VIEW: View = 'records';

/** 画面の名前を画面に直す。知らない名前（や文字列でないもの）は、最初の画面。 */
export function resolveView(name: unknown): View {
  return VIEWS.find((view) => view === name) ?? START_VIEW;
}
