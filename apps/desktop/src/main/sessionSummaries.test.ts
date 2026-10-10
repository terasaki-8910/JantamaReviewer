import { describe, expect, it, vi } from 'vitest';

import { FX4_TEXT } from '../../tests/import-fixtures';
import { SummaryStore, summarizeReportText, type SummaryState } from './sessionSummaries';

const session = (id: string, imported: boolean) => ({
  id,
  report_path: imported ? `C:\\data\\games\\${id}\\report.json` : null,
});

/** 読み込みの終わりを、試験が決める。 */
function deferred<T>() {
  let resolve: (value: T) => void = () => undefined;
  let reject: (reason: unknown) => void = () => undefined;
  const promise = new Promise<T>((ok, ng) => {
    resolve = ok;
    reject = ng;
  });
  return { promise, resolve, reject };
}

/** 次の画面への譲りは、すぐ終わらせる（試験の時間を使わない）。 */
const noPause = () => Promise.resolve();

async function settle(store: SummaryStore, ids: string[]) {
  await vi.waitFor(() => {
    for (const id of ids) expect(store.getSnapshot().get(id)?.status, id).not.toBe('loading');
  });
}

describe('U-8: 半荘のまとめ（卓・段階・Rating）', () => {
  it('取り込んだ結果の文字から、卓・Rating・段階を作る（mjai のサイトの値と同じ 93.0）', () => {
    const state = summarizeReportText(FX4_TEXT);
    expect(state.status).toBe('ready');
    if (state.status !== 'ready') return;
    expect(state.summary.room).toBe('玉の間・南');
    expect(state.summary.ratingText).toBe('93.0');
    expect(state.summary.grade).not.toBeNull();
    expect(state.summary.kyokus.length).toBe(5);
  });

  it('読めない結果・空・文字でないものは、理由つきで「読めない」になる（例外にしない）', () => {
    for (const bad of ['', '{"not":"a report"}', 'これは JSON ではない', null, undefined, 42]) {
      const state = summarizeReportText(bad);
      expect(state.status, String(bad)).toBe('unavailable');
      expect(state.status === 'unavailable' && state.reason !== '').toBe(true);
    }
  });
});

describe('U-8: まとめの覚え方（SummaryStore）', () => {
  it('結果を取り込んだ半荘だけを読む。読み込み中は loading、終わると ready', async () => {
    const wait = deferred<string>();
    const load = vi.fn((id: string) => (id === 'a' ? wait.promise : Promise.resolve(FX4_TEXT)));
    const store = new SummaryStore(load, noPause);
    store.sync([session('a', true), session('b', false), session('c', true)]);
    expect(store.getSnapshot().get('a')?.status).toBe('loading');
    expect(store.getSnapshot().has('b')).toBe(false);
    expect(store.getSnapshot().get('c')?.status).toBe('loading');
    wait.resolve(FX4_TEXT);
    await settle(store, ['a', 'c']);
    expect(load.mock.calls.map((c) => c[0])).toEqual(['a', 'c']);
    expect(store.getSnapshot().get('a')?.status).toBe('ready');
    expect(store.getSnapshot().has('b')).toBe(false);
  });

  it('読み込みは 1 つずつ（同時に 2 つ動かさない）。新しい半荘（先に渡したもの）から', async () => {
    const order: string[] = [];
    let inFlight = 0;
    let maxInFlight = 0;
    const load = async (id: string) => {
      inFlight += 1;
      maxInFlight = Math.max(maxInFlight, inFlight);
      order.push(id);
      await Promise.resolve();
      inFlight -= 1;
      return FX4_TEXT;
    };
    const store = new SummaryStore(load, noPause);
    store.sync(['n1', 'n2', 'n3', 'n4'].map((id) => session(id, true)));
    await settle(store, ['n1', 'n2', 'n3', 'n4']);
    expect(order).toEqual(['n1', 'n2', 'n3', 'n4']);
    expect(maxInFlight).toBe(1);
  });

  it('一覧が変わっても、読んだ半荘を読み直さない。無くなった半荘は忘れる', async () => {
    const load = vi.fn(async () => FX4_TEXT);
    const store = new SummaryStore(load, noPause);
    store.sync([session('a', true), session('b', true)]);
    await settle(store, ['a', 'b']);
    expect(load).toHaveBeenCalledTimes(2);
    const snapshot = store.getSnapshot();

    store.sync([session('a', true), session('b', true)]);
    expect(load).toHaveBeenCalledTimes(2);
    expect(store.getSnapshot()).toBe(snapshot);

    store.sync([session('b', true), session('c', true)]);
    expect(store.getSnapshot().has('a')).toBe(false);
    expect(store.getSnapshot().get('b')?.status).toBe('ready');
    await settle(store, ['c']);
    expect(load).toHaveBeenCalledTimes(3);
  });

  it('結果の場所が変わった（取り込み直した）半荘は、作り直す。取り込み前から取り込み済みになったら、新しく読む', async () => {
    const load = vi.fn(async () => FX4_TEXT);
    const store = new SummaryStore(load, noPause);
    store.sync([session('a', false)]);
    expect(store.getSnapshot().size).toBe(0);
    store.sync([session('a', true)]);
    await settle(store, ['a']);
    expect(load).toHaveBeenCalledTimes(1);
    store.sync([{ id: 'a', report_path: 'D:\\moved\\a\\report.json' }]);
    await settle(store, ['a']);
    expect(load).toHaveBeenCalledTimes(2);
  });

  it('読み込み中に半荘が無くなったら、遅れて着いた答えは捨てる', async () => {
    const wait = deferred<string>();
    const store = new SummaryStore(() => wait.promise, noPause);
    store.sync([session('a', true)]);
    store.sync([]);
    expect(store.getSnapshot().has('a')).toBe(false);
    wait.resolve(FX4_TEXT);
    await Promise.resolve();
    await new Promise((resolve) => setTimeout(resolve, 5));
    expect(store.getSnapshot().has('a')).toBe(false);
  });

  it('読み込みが失敗したら、その半荘だけ「読めない」になり、あとの半荘は読み続ける', async () => {
    const store = new SummaryStore(async (id) => {
      if (id === 'bad') throw '保存先を開けませんでした';
      if (id === 'missing') return null;
      return FX4_TEXT;
    }, noPause);
    store.sync(['bad', 'missing', 'ok'].map((id) => session(id, true)));
    await settle(store, ['bad', 'missing', 'ok']);
    const states = store.getSnapshot();
    expect(states.get('bad')).toEqual({ status: 'unavailable', reason: '保存先を開けませんでした' });
    expect(states.get('missing')?.status).toBe('unavailable');
    expect(states.get('ok')?.status).toBe('ready');
  });

  it('invalidate で、作り直す（半荘を指定すれば、その半荘だけ）', async () => {
    const load = vi.fn(async () => FX4_TEXT);
    const store = new SummaryStore(load, noPause);
    store.sync([session('a', true), session('b', true)]);
    await settle(store, ['a', 'b']);
    store.invalidate('a');
    expect(store.getSnapshot().get('a')?.status).toBe('loading');
    expect(store.getSnapshot().get('b')?.status).toBe('ready');
    await settle(store, ['a']);
    expect(load).toHaveBeenCalledTimes(3);
    store.invalidate();
    await settle(store, ['a', 'b']);
    expect(load).toHaveBeenCalledTimes(5);
    store.invalidate('nobody');
    expect(load).toHaveBeenCalledTimes(5);
  });

  it('変わるたびに知らせる。外すと止まる。変わらなければ、値は同じ', async () => {
    const store = new SummaryStore(async () => FX4_TEXT, noPause);
    let calls = 0;
    const off = store.subscribe(() => {
      calls += 1;
    });
    store.sync([session('a', true)]);
    await settle(store, ['a']);
    expect(calls).toBeGreaterThanOrEqual(2); // loading と ready
    const done = calls;
    off();
    store.invalidate('a');
    await settle(store, ['a']);
    expect(calls).toBe(done);
  });

  it('読み込み前の状態は、半荘ごとに loading と ready のどちらか（取り込み前の半荘は入らない）', async () => {
    const store = new SummaryStore(async () => FX4_TEXT, noPause);
    store.sync([session('a', true), session('z', false)]);
    const states: SummaryState['status'][] = [...store.getSnapshot().values()].map((s) => s.status);
    expect(states).toEqual(['loading']);
    await settle(store, ['a']);
  });
});
