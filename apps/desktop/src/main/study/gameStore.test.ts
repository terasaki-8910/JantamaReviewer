import { describe, expect, it, vi } from 'vitest';

import { REPORT_TEXTS } from '../../../tests/fake-sessions';
import { GameStore, gameFromReportText, type GameState } from './gameStore';

const session = (id: string, imported: boolean, path = `C:\\data\\${id}\\report.json`) => ({
  id,
  report_path: imported ? path : null,
});

const noPause = () => Promise.resolve();

async function settle(store: GameStore, ids: string[]) {
  await vi.waitFor(() => {
    for (const id of ids) expect(store.getSnapshot().get(id)?.status, id).not.toBe('loading');
  });
}

describe('出題が使う、牌譜を再生した結果', () => {
  it('結果の文字から、再生した結果（判断ごとの盤面つき）を作る', () => {
    const state = gameFromReportText(REPORT_TEXTS.fx4);
    expect(state.status).toBe('ready');
    if (state.status !== 'ready') return;
    expect(state.game.decisions).toHaveLength(70);
    expect(state.game.decisions[0]?.board.hand.length).toBeGreaterThan(10);
  });

  it('読めない結果・空・文字でないものは、理由つきで「読めない」になる（例外にしない）', () => {
    for (const bad of ['', '{"not":"a report"}', 'これは JSON ではない', null, undefined, 42]) {
      const state: GameState = gameFromReportText(bad);
      expect(state.status, String(bad)).toBe('unavailable');
      expect(state.status === 'unavailable' && state.reason !== '').toBe(true);
    }
  });

  it('取り込んだ半荘だけを、1 回ずつ読む。取り込み前の半荘は読まない。読み終えるまでは「読み込み中」', async () => {
    const load = vi.fn(async () => REPORT_TEXTS.fx4);
    const store = new GameStore(load, noPause);
    store.sync([session('a', true), session('b', false), session('c', true)]);
    expect(store.getSnapshot().get('a')?.status).toBe('loading');
    expect(store.getSnapshot().has('b')).toBe(false);
    await settle(store, ['a', 'c']);
    expect(load.mock.calls.map((call) => (call as unknown[])[0]).sort()).toEqual(['a', 'c']);
    expect(store.getSnapshot().get('a')?.status).toBe('ready');
    // 一覧が読み直されても、変わっていない半荘は読み直さない
    store.sync([session('a', true), session('b', false), session('c', true)]);
    await new Promise((resolve) => setTimeout(resolve, 10));
    expect(load).toHaveBeenCalledTimes(2);
  });

  it('結果の場所が変わった半荘は読み直し、一覧から無くなった半荘は忘れる', async () => {
    const load = vi.fn(async () => REPORT_TEXTS.fx4);
    const store = new GameStore(load, noPause);
    store.sync([session('a', true), session('c', true)]);
    await settle(store, ['a', 'c']);
    store.sync([session('a', true, 'C:\\data\\a\\report2.json')]);
    expect(store.getSnapshot().has('c')).toBe(false);
    await settle(store, ['a']);
    expect(load).toHaveBeenCalledTimes(3);
  });

  it('読み込みに失敗した半荘は、理由を持つだけで、ほかの半荘を止めない', async () => {
    const load = vi.fn(async (id: string) => {
      if (id === 'a') throw new Error('読み出せません');
      return REPORT_TEXTS.fx4;
    });
    const store = new GameStore(load, noPause);
    store.sync([session('a', true), session('b', true)]);
    await settle(store, ['a', 'b']);
    const a = store.getSnapshot().get('a');
    expect(a).toEqual({ status: 'unavailable', reason: '読み出せません' });
    expect(store.getSnapshot().get('b')?.status).toBe('ready');
  });

  it('変わるたびに、新しい値を知らせる（購読できる）', async () => {
    const store = new GameStore(async () => REPORT_TEXTS.fx4, noPause);
    const seen = vi.fn();
    const stop = store.subscribe(seen);
    store.sync([session('a', true)]);
    await settle(store, ['a']);
    expect(seen).toHaveBeenCalled();
    const before = store.getSnapshot();
    stop();
    store.sync([]);
    expect(store.getSnapshot()).not.toBe(before);
  });
});
