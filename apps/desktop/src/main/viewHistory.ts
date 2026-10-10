/**
 * 見た画面の履歴（U-10、R8-4）。サイドバーの上の ← → と Alt+← / Alt+→ で、画面（半荘・取り込み・設定）を行き来する。
 * ブラウザの履歴（history・URL）は使わない（N-5）。メモリの中の、ただの並び。
 *
 * - 新しい画面へ移ると、いまより先（進む側）の履歴は捨てる
 * - 消した半荘は飛ばす。行き先が無い向きのボタンは押せない
 * - マウスの戻る・進むのボタンには割り当てない（迷いマークのボタンと重なるため。SPEC 3a）
 *
 * ここは、純粋な関数だけ（画面に依存しない）。
 */
import { sameView, sessionView, START_VIEW, type View } from './views';

/** 覚えておく画面の数の上限。これを超えたら、いちばん古いものから忘れる。 */
export const HISTORY_LIMIT = 100;

export interface ViewHistory {
  readonly entries: readonly View[];
  /** いま見ている項目の位置。 */
  readonly index: number;
}

export function startHistory(view: View = START_VIEW): ViewHistory {
  return { entries: [view], index: 0 };
}

export function currentView(history: ViewHistory): View {
  return history.entries[history.index] ?? START_VIEW;
}

/** いま行ける画面か。半荘は、一覧にあるものだけ（消した半荘は行けない）。何も選んでいない画面には、行き来では行かない。 */
export function isViewAvailable(view: View, sessionIds: ReadonlySet<string>): boolean {
  switch (view.kind) {
    case 'none':
      return false;
    case 'session':
      return sessionIds.has(view.id);
    default:
      return true;
  }
}

/**
 * 向き（-1 = 戻る、1 = 進む）の、行き先の位置。行けない画面（消した半荘など）といまと同じ画面は飛ばす。無ければ null。
 */
export function stepTarget(
  history: ViewHistory,
  direction: -1 | 1,
  isAvailable: (view: View) => boolean,
): number | null {
  const here = currentView(history);
  for (let at = history.index + direction; at >= 0 && at < history.entries.length; at += direction) {
    const entry = history.entries[at];
    if (entry !== undefined && isAvailable(entry) && !sameView(entry, here)) return at;
  }
  return null;
}

export type HistoryAction =
  /** 新しい画面へ移る（使う人が、行を押した・ボタンを押したとき）。同じ画面なら何もしない。 */
  | { type: 'push'; view: View }
  /** いま見ている画面が `from` なら、`to` に置き換える（履歴は増やさない）。消したあとの行き先と、元に戻したあとの戻り先に使う。 */
  | { type: 'swap'; from: View; to: View }
  /** 履歴の位置を移す（← → を押したとき）。 */
  | { type: 'go'; index: number }
  /** 半荘の一覧が読めた・変わった。何も選んでいなければ、いちばん新しい半荘に。見ている半荘が無くなっていれば、同じく。 */
  | { type: 'listChanged'; sessionIds: readonly string[] };

export function historyReducer(history: ViewHistory, action: HistoryAction): ViewHistory {
  switch (action.type) {
    case 'push': {
      if (sameView(currentView(history), action.view)) return history;
      const kept = [...history.entries.slice(0, history.index + 1), action.view];
      const entries = kept.length > HISTORY_LIMIT ? kept.slice(kept.length - HISTORY_LIMIT) : kept;
      return { entries, index: entries.length - 1 };
    }
    case 'swap': {
      if (!sameView(currentView(history), action.from)) return history;
      const entries = [...history.entries];
      entries[history.index] = action.to;
      return { ...history, entries };
    }
    case 'go': {
      const ok = Number.isInteger(action.index) && action.index >= 0 && action.index < history.entries.length;
      return ok ? { ...history, index: action.index } : history;
    }
    case 'listChanged': {
      const here = currentView(history);
      const newest = action.sessionIds[0];
      const fallback = newest === undefined ? START_VIEW : sessionView(newest);
      const lost = here.kind === 'session' && !action.sessionIds.includes(here.id);
      const unset = here.kind === 'none' && newest !== undefined;
      if (!lost && !unset) return history;
      return historyReducer(history, { type: 'swap', from: here, to: fallback });
    }
  }
}
