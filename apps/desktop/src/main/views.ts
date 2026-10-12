/**
 * 検討画面の画面（ページ）と、画面の切り替えの決まり（N-5、U-10）。
 *
 * どの画面を見ているかは、メモリの中の状態だけで持つ。URL のパス・ハッシュ・履歴の項目は使わない
 * （ブラウザの戻る・進む・再読み込みが意味を持たない。使わないことは、eslint の規則が確かめる）。
 * 画面の行き来（← → と Alt+← / Alt+→）も、アプリの中の履歴（`viewHistory.ts`）で持つ。
 */

import type { AnswerMode } from '../api/types';

/**
 * 見ている画面。
 * - `none`: まだ何も選んでいない（起動の直後・半荘が 1 つも無い）。半荘の一覧が読めたら、いちばん新しい半荘になる
 * - `session`: 半荘 1 つ（`id` は半荘のフォルダの名前）
 * - `import`: 検討結果を取り込む
 * - `settings`: 設定
 * - `today`: 今日の出題の一覧（U-15）
 * - `quiz`: 出題 1 問（半荘の名前と判断の鍵。`mode` は、出題か解き直しか）。今日の出題・残りから開く
 * - `review`: 解き直し（今日が期限の問題を 1 問ずつ。U-17）
 * - `replay`: 半荘を通して見る画面（半荘の名前と、開く判断の鍵。鍵が無ければ、半荘の頭から。F12、U-21）
 * - `log`: 検討ログ（答えた問題を 1 行ずつ。絞り込みと「答えを出す」は、画面の外（シェル）が持つので、ここには入れない。F5、U-29）
 * - `week`: 週の集計（週は、画面の中だけの状態。ほかの画面へ移って戻ると、今週に戻る。F8、U-30）
 */
export type View =
  | { kind: 'none' }
  | { kind: 'session'; id: string }
  | { kind: 'import' }
  | { kind: 'settings' }
  | { kind: 'today' }
  | { kind: 'quiz'; sessionId: string; key: string; mode: AnswerMode }
  | { kind: 'review' }
  | { kind: 'log' }
  | { kind: 'week' }
  | { kind: 'replay'; sessionId: string; key?: string };

export type ViewKind = View['kind'];

export const VIEW_KINDS: readonly ViewKind[] = [
  'none',
  'session',
  'import',
  'settings',
  'today',
  'quiz',
  'review',
  'log',
  'week',
  'replay',
];

/** 最初に出す画面。知らない画面が来たときも、ここに戻る。 */
export const START_VIEW: View = { kind: 'none' };

export const sessionView = (id: string): View => ({ kind: 'session', id });

export const quizView = (sessionId: string, key: string, mode: AnswerMode = 'quiz'): View => ({
  kind: 'quiz',
  sessionId,
  key,
  mode,
});

/** 半荘を通して見る画面。`key` は、開く判断の鍵（迷いのカードの「この局面を解く」から開くとき）。無ければ半荘の頭から。 */
export const replayView = (sessionId: string, key?: string): View =>
  key === undefined ? { kind: 'replay', sessionId } : { kind: 'replay', sessionId, key };

/** 半荘に結びついた画面なら、その半荘の名前（半荘の画面・その半荘の出題・その半荘を通して見る画面）。 */
export function viewSessionId(view: View): string | null {
  if (view.kind === 'session') return view.id;
  if (view.kind === 'quiz' || view.kind === 'replay') return view.sessionId;
  return null;
}

/** 画面を表す値を、画面に直す。知らない種類・形の合わない値（や、半荘の名前が空のもの）は、最初の画面。 */
export function resolveView(value: unknown): View {
  if (typeof value !== 'object' || value === null) return START_VIEW;
  const record = value as { kind?: unknown; id?: unknown; sessionId?: unknown; key?: unknown; mode?: unknown };
  switch (record.kind) {
    case 'session':
      return typeof record.id === 'string' && record.id !== '' ? sessionView(record.id) : START_VIEW;
    case 'import':
      return { kind: 'import' };
    case 'settings':
      return { kind: 'settings' };
    case 'today':
      return { kind: 'today' };
    case 'review':
      return { kind: 'review' };
    case 'log':
      return { kind: 'log' };
    case 'week':
      return { kind: 'week' };
    case 'replay':
      return typeof record.sessionId === 'string' && record.sessionId !== ''
        ? replayView(record.sessionId, typeof record.key === 'string' && record.key !== '' ? record.key : undefined)
        : START_VIEW;
    case 'quiz':
      return typeof record.sessionId === 'string' &&
        record.sessionId !== '' &&
        typeof record.key === 'string' &&
        record.key !== '' &&
        (record.mode === 'quiz' || record.mode === 'review')
        ? quizView(record.sessionId, record.key, record.mode)
        : START_VIEW;
    default:
      return START_VIEW;
  }
}

/** 同じ画面か（半荘は名前まで、出題は半荘の名前・判断の鍵・種類まで、通して見る画面は半荘の名前と開く判断の鍵まで同じ）。 */
export function sameView(a: View, b: View): boolean {
  if (a.kind !== b.kind) return false;
  if (a.kind === 'session' && b.kind === 'session') return a.id === b.id;
  if (a.kind === 'quiz' && b.kind === 'quiz') return a.sessionId === b.sessionId && a.key === b.key && a.mode === b.mode;
  if (a.kind === 'replay' && b.kind === 'replay') return a.sessionId === b.sessionId && a.key === b.key;
  return true;
}
