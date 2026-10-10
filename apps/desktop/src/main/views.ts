/**
 * 検討画面の画面（ページ）と、画面の切り替えの決まり（N-5、U-10）。
 *
 * どの画面を見ているかは、メモリの中の状態だけで持つ。URL のパス・ハッシュ・履歴の項目は使わない
 * （ブラウザの戻る・進む・再読み込みが意味を持たない。使わないことは、eslint の規則が確かめる）。
 * 画面の行き来（← → と Alt+← / Alt+→）も、アプリの中の履歴（`viewHistory.ts`）で持つ。
 */

/**
 * 見ている画面。
 * - `none`: まだ何も選んでいない（起動の直後・半荘が 1 つも無い）。半荘の一覧が読めたら、いちばん新しい半荘になる
 * - `session`: 半荘 1 つ（`id` は半荘のフォルダの名前）
 * - `import`: 検討結果を取り込む
 * - `settings`: 設定
 */
export type View =
  | { kind: 'none' }
  | { kind: 'session'; id: string }
  | { kind: 'import' }
  | { kind: 'settings' };

export type ViewKind = View['kind'];

export const VIEW_KINDS: readonly ViewKind[] = ['none', 'session', 'import', 'settings'];

/** 最初に出す画面。知らない画面が来たときも、ここに戻る。 */
export const START_VIEW: View = { kind: 'none' };

export const sessionView = (id: string): View => ({ kind: 'session', id });

/** 画面を表す値を、画面に直す。知らない種類・形の合わない値（や、半荘の名前が空のもの）は、最初の画面。 */
export function resolveView(value: unknown): View {
  if (typeof value !== 'object' || value === null) return START_VIEW;
  const record = value as { kind?: unknown; id?: unknown };
  switch (record.kind) {
    case 'session':
      return typeof record.id === 'string' && record.id !== '' ? sessionView(record.id) : START_VIEW;
    case 'import':
      return { kind: 'import' };
    case 'settings':
      return { kind: 'settings' };
    default:
      return START_VIEW;
  }
}

/** 同じ画面か（半荘は、名前まで同じ）。 */
export function sameView(a: View, b: View): boolean {
  if (a.kind !== b.kind) return false;
  return a.kind === 'session' && b.kind === 'session' ? a.id === b.id : true;
}
