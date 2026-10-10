import { describe, expect, it } from 'vitest';

import {
  HISTORY_LIMIT,
  currentView,
  historyReducer,
  isViewAvailable,
  startHistory,
  stepTarget,
  type HistoryAction,
  type ViewHistory,
} from './viewHistory';
import { sessionView, type View } from './views';

const s = sessionView;
const IMPORT: View = { kind: 'import' };
const SETTINGS: View = { kind: 'settings' };

function run(actions: HistoryAction[], from: ViewHistory = startHistory(s('a'))): ViewHistory {
  return actions.reduce(historyReducer, from);
}

const all = (ids: string[]) => (view: View) => isViewAvailable(view, new Set(ids));

describe('U-10: 画面の履歴（戻る・進む）', () => {
  it('新しい画面へ移ると、積み重なる。同じ画面へ移っても増えない', () => {
    const h = run([
      { type: 'push', view: s('b') },
      { type: 'push', view: s('b') },
      { type: 'push', view: SETTINGS },
    ]);
    expect(h.entries).toEqual([s('a'), s('b'), SETTINGS]);
    expect(currentView(h)).toEqual(SETTINGS);
  });

  it('戻ると、進めるようになる。進むと、また行き止まりになる', () => {
    let h = run([{ type: 'push', view: s('b') }, { type: 'push', view: s('c') }]);
    const available = all(['a', 'b', 'c']);
    expect(stepTarget(h, 1, available)).toBeNull();
    const back = stepTarget(h, -1, available);
    expect(back).toBe(1);
    h = historyReducer(h, { type: 'go', index: back as number });
    expect(currentView(h)).toEqual(s('b'));
    expect(stepTarget(h, 1, available)).toBe(2);
    expect(stepTarget(h, -1, available)).toBe(0);
    h = historyReducer(h, { type: 'go', index: 0 });
    expect(stepTarget(h, -1, available)).toBeNull();
  });

  it('途中で新しい画面へ移ると、先（進む側）の履歴は捨てる', () => {
    let h = run([{ type: 'push', view: s('b') }, { type: 'push', view: s('c') }]);
    h = historyReducer(h, { type: 'go', index: 0 });
    h = historyReducer(h, { type: 'push', view: s('d') });
    expect(h.entries).toEqual([s('a'), s('d')]);
    expect(stepTarget(h, 1, all(['a', 'b', 'c', 'd']))).toBeNull();
  });

  it('消した半荘は飛ばす。飛ばした先にも行けなければ、行き先は無い（ボタンは押せない）', () => {
    const h = run([
      { type: 'push', view: s('b') },
      { type: 'push', view: IMPORT },
      { type: 'push', view: s('c') },
    ]);
    // b を消した: c から戻ると、取り込み、その次は a（b は飛ばす）。
    const available = all(['a', 'c']);
    let at = h;
    at = historyReducer(at, { type: 'go', index: stepTarget(at, -1, available) as number });
    expect(currentView(at)).toEqual(IMPORT);
    at = historyReducer(at, { type: 'go', index: stepTarget(at, -1, available) as number });
    expect(currentView(at)).toEqual(s('a'));
    expect(stepTarget(at, -1, available)).toBeNull();
    // a も c も消した: 取り込みと設定だけ行ける。
    expect(stepTarget(h, -1, all([]))).toBe(2); // 取り込みは、半荘ではないので行ける
    const onlyDeleted = run([{ type: 'push', view: s('b') }]);
    expect(stepTarget(onlyDeleted, -1, all([]))).toBeNull();
    expect(stepTarget(onlyDeleted, -1, all(['a']))).toBe(0);
  });

  it('いまと同じ画面の項目は飛ばす（消したあとに行き先を置き換えて、同じ画面が隣り合っても、何も起きないボタンにならない）', () => {
    const h = run([
      { type: 'push', view: s('b') },
      { type: 'swap', from: s('b'), to: s('a') },
    ]);
    expect(h.entries).toEqual([s('a'), s('a')]);
    expect(stepTarget(h, -1, all(['a']))).toBeNull();
  });

  it('swap は、いま見ている画面が from のときだけ、置き換える（履歴は増えない）', () => {
    const h = run([{ type: 'push', view: s('b') }]);
    const swapped = historyReducer(h, { type: 'swap', from: s('b'), to: s('c') });
    expect(swapped.entries).toEqual([s('a'), s('c')]);
    expect(swapped.index).toBe(1);
    const notHere = historyReducer(h, { type: 'swap', from: s('zzz'), to: s('c') });
    expect(notHere).toBe(h);
  });

  it('「何も選んでいない」画面は、行き来では行かない。半荘の一覧が読めたら、いちばん新しい半荘になる', () => {
    const start = startHistory();
    expect(isViewAvailable({ kind: 'none' }, new Set(['a']))).toBe(false);
    expect(historyReducer(start, { type: 'listChanged', sessionIds: [] })).toBe(start);
    const loaded = historyReducer(start, { type: 'listChanged', sessionIds: ['new', 'old'] });
    expect(loaded.entries).toEqual([s('new')]);
    expect(currentView(loaded)).toEqual(s('new'));
  });

  it('見ている半荘が一覧から無くなったら、いちばん新しい半荘に（何も無ければ、何も選んでいない画面に）', () => {
    const h = startHistory(s('gone'));
    expect(historyReducer(h, { type: 'listChanged', sessionIds: ['x', 'y'] }).entries).toEqual([s('x')]);
    expect(historyReducer(h, { type: 'listChanged', sessionIds: [] }).entries).toEqual([{ kind: 'none' }]);
    // 見ている半荘が残っているときは、変えない。
    const keep = startHistory(s('y'));
    expect(historyReducer(keep, { type: 'listChanged', sessionIds: ['x', 'y'] })).toBe(keep);
    // 取り込み・設定は、一覧が変わっても、そのまま。
    const import_ = startHistory(IMPORT);
    expect(historyReducer(import_, { type: 'listChanged', sessionIds: [] })).toBe(import_);
  });

  it('go は、範囲の外・小数の位置を受け付けない', () => {
    const h = run([{ type: 'push', view: s('b') }]);
    for (const index of [-1, 2, 0.5, Number.NaN]) {
      expect(historyReducer(h, { type: 'go', index })).toBe(h);
    }
  });

  it('覚える画面の数に上限がある。超えたら、いちばん古いものから忘れる', () => {
    let h = startHistory(s('0'));
    for (let i = 1; i <= HISTORY_LIMIT + 20; i += 1) h = historyReducer(h, { type: 'push', view: s(String(i)) });
    expect(h.entries).toHaveLength(HISTORY_LIMIT);
    expect(currentView(h)).toEqual(s(String(HISTORY_LIMIT + 20)));
    expect(h.entries[0]).toEqual(s('21'));
    expect(h.index).toBe(HISTORY_LIMIT - 1);
  });

  it('isViewAvailable: 取り込みと設定はいつでも。半荘は、一覧にあるときだけ', () => {
    const ids = new Set(['a']);
    expect(isViewAvailable(IMPORT, ids)).toBe(true);
    expect(isViewAvailable(SETTINGS, ids)).toBe(true);
    expect(isViewAvailable(s('a'), ids)).toBe(true);
    expect(isViewAvailable(s('b'), ids)).toBe(false);
  });
});
