/**
 * 前の作り方で読んだ半荘の読み直しの進み具合（F11、E-27、U-23）の単体試験。Rust 側のコマンドは、偽物に差し替える。
 * 画面（状態の 1 行・描き直し）は、SessionPage.test.tsx が確かめる。
 */
import { describe, expect, it, vi } from 'vitest';

import { IDLE_REREADS, RereadStore, type RereadDeps } from './rereadStore';

interface Deferred<T> {
  promise: Promise<T>;
  resolve: (value: T) => void;
  reject: (reason: unknown) => void;
}

function deferred<T>(): Deferred<T> {
  let resolve!: (value: T) => void;
  let reject!: (reason: unknown) => void;
  const promise = new Promise<T>((ok, ng) => {
    resolve = ok;
    reject = ng;
  });
  return { promise, resolve, reject };
}

/** 何もかも一気に進めて、待ちを使い切る。 */
const settle = () => new Promise<void>((done) => setTimeout(done, 0));

function setup(overrides: Partial<RereadDeps> = {}) {
  const log: string[] = [];
  const deps: RereadDeps = {
    needed: vi.fn(async (id: string) => {
      log.push(`needed:${id}`);
      return true;
    }),
    reread: vi.fn(async (id: string) => {
      log.push(`reread:${id}`);
      return true;
    }),
    changed: vi.fn(async () => {
      log.push('changed');
    }),
    ...overrides,
  };
  const store = new RereadStore(deps);
  const seen: string[][] = [];
  store.subscribe(() => seen.push([...store.getSnapshot()]));
  return { store, deps, log, seen };
}

describe('U-23 読み直しの進み具合（RereadStore）', () => {
  it('前の作り方で読んだ半荘: 確かめる → 読み直す → 一覧を読み直す、の順。読み直している間だけ、その半荘の名前が入る', async () => {
    const reread = deferred<boolean>();
    const changed = deferred<void>();
    const { store, log, seen } = setup({
      reread: async (id) => {
        log.push(`reread:${id}`);
        return reread.promise;
      },
      changed: async () => {
        log.push('changed');
        return changed.promise;
      },
    });
    expect(store.getSnapshot().size).toBe(0);

    store.open('a');
    await settle();
    // 確かめて、読み直しを始めた。
    expect(log).toEqual(['needed:a', 'reread:a']);
    expect([...store.getSnapshot()]).toEqual(['a']);

    reread.resolve(true);
    await settle();
    // 一覧を読み直している間も、状態の 1 行は残す（古い値のまま、1 行だけ消えることが無いように）。
    expect(log).toEqual(['needed:a', 'reread:a', 'changed']);
    expect([...store.getSnapshot()]).toEqual(['a']);

    changed.resolve();
    await settle();
    expect(store.getSnapshot().size).toBe(0);
    expect(seen).toEqual([['a'], []]);
  });

  it('同じ半荘は、この起動の間、1 回だけ: 読み直している最中に開き直しても、済んだあとに開き直しても、もう確かめない', async () => {
    const reread = deferred<boolean>();
    const { store, deps } = setup({ reread: vi.fn(() => reread.promise) });
    store.open('a');
    store.open('a');
    await settle();
    store.open('a');
    expect(deps.needed).toHaveBeenCalledTimes(1);
    expect(deps.reread).toHaveBeenCalledTimes(1);
    reread.resolve(true);
    await settle();
    store.open('a');
    store.open('a');
    await settle();
    expect(deps.needed).toHaveBeenCalledTimes(1);
    expect(deps.reread).toHaveBeenCalledTimes(1);
    expect(deps.changed).toHaveBeenCalledTimes(1);
  });

  it('読み直しが要らない半荘: 確かめるだけ。状態の 1 行も出さず、一覧も読み直さず、2 回目も確かめない', async () => {
    const { store, deps, seen } = setup({ needed: vi.fn(async () => false) });
    store.open('a');
    await settle();
    store.open('a');
    await settle();
    expect(deps.needed).toHaveBeenCalledTimes(1);
    expect(deps.reread).not.toHaveBeenCalled();
    expect(deps.changed).not.toHaveBeenCalled();
    expect(seen).toEqual([]);
  });

  it('確かめている間に読み直しが要らなくなった（読み直しが false）ときは、一覧を読み直さない。状態の 1 行は消える', async () => {
    const { store, deps, seen } = setup({ reread: vi.fn(async () => false) });
    store.open('a');
    await settle();
    expect(deps.changed).not.toHaveBeenCalled();
    expect(seen).toEqual([['a'], []]);
  });

  it('読み直しに失敗したとき: 一覧を読み直さず、状態の 1 行を消す。同じ半荘では、もう一度は試さない（繰り返さない）', async () => {
    const { store, deps, seen } = setup({
      reread: vi.fn(async () => {
        throw '日本語の文字認識が使えません';
      }),
    });
    store.open('a');
    await settle();
    expect(seen).toEqual([['a'], []]);
    expect(deps.changed).not.toHaveBeenCalled();
    store.open('a');
    await settle();
    expect(deps.needed).toHaveBeenCalledTimes(1);
    expect(deps.reread).toHaveBeenCalledTimes(1);
  });

  it('要るかどうかを確かめられなかったときは、読み直さない（状態の 1 行も出さない）。もう一度は確かめない', async () => {
    const { store, deps, seen } = setup({
      needed: vi.fn(async () => {
        throw '保存先を開けません';
      }),
    });
    store.open('a');
    await settle();
    store.open('a');
    await settle();
    expect(deps.reread).not.toHaveBeenCalled();
    expect(seen).toEqual([]);
    expect(deps.needed).toHaveBeenCalledTimes(1);
  });

  it('半荘ごとに別: a を読み直している間に b を開けば、b も確かめて、どちらも状態に入る', async () => {
    const a = deferred<boolean>();
    const b = deferred<boolean>();
    const { store, deps } = setup({
      reread: vi.fn((id: string) => (id === 'a' ? a.promise : b.promise)),
    });
    store.open('a');
    store.open('b');
    await settle();
    expect([...store.getSnapshot()].sort()).toEqual(['a', 'b']);
    a.resolve(true);
    await settle();
    expect([...store.getSnapshot()]).toEqual(['b']);
    b.resolve(true);
    await settle();
    expect(store.getSnapshot().size).toBe(0);
    expect(deps.changed).toHaveBeenCalledTimes(2);
  });

  it('getSnapshot は、変わらないうちは同じ値（useSyncExternalStore の決まり）。読み直しが無いときは、いつも同じ空の集まり', async () => {
    const reread = deferred<boolean>();
    const { store } = setup({ reread: vi.fn(() => reread.promise) });
    const empty = store.getSnapshot();
    expect(store.getSnapshot()).toBe(empty);
    store.open('a');
    await settle();
    const reading = store.getSnapshot();
    expect(reading).not.toBe(empty);
    expect(store.getSnapshot()).toBe(reading);
    reread.resolve(true);
    await settle();
    expect(store.getSnapshot()).toBe(empty);
    expect(IDLE_REREADS.getSnapshot()).toBe(IDLE_REREADS.getSnapshot());
  });

  it('購読をやめた受け手には、知らせない', async () => {
    const { store } = setup();
    const heard: number[] = [];
    const stop = store.subscribe(() => heard.push(1));
    stop();
    store.open('a');
    await settle();
    expect(heard).toEqual([]);
  });

  it('何もしない読み直し（IDLE_REREADS）: 開いても何も起きず、状態は空のまま', () => {
    expect(() => IDLE_REREADS.open('a')).not.toThrow();
    expect(IDLE_REREADS.getSnapshot().size).toBe(0);
    expect(IDLE_REREADS.subscribe(() => undefined)()).toBeUndefined();
  });
});

describe('E-31 読み直しのあとの、評価の当てはめ直し（relink）', () => {
  it('読み直しが済んでから、評価を当てはめ直す: 確かめる → 読み直す → 当てはめ直す → 一覧を読み直す（1 回）、の順', async () => {
    const log: string[] = [];
    const { store } = setup({
      needed: async (id) => (log.push(`needed:${id}`), true),
      reread: async (id) => (log.push(`reread:${id}`), true),
      relink: async (id) => (log.push(`relink:${id}`), true),
      changed: async () => void log.push('changed'),
    });
    store.open('a');
    await settle();
    expect(log).toEqual(['needed:a', 'reread:a', 'relink:a', 'changed']);
    expect(store.getSnapshot().size).toBe(0);
  });

  it('読み直しが要らない半荘も、評価は当てはめ直す。状態の 1 行（読み直している印）は出ない', async () => {
    const relink = deferred<boolean>();
    const { store, log, seen } = setup({
      needed: async (id) => (log.push(`needed:${id}`), false),
      relink: async (id) => (log.push(`relink:${id}`), relink.promise),
    });
    store.open('a');
    await settle();
    expect(log).toEqual(['needed:a', 'relink:a']);
    expect(store.getSnapshot().size).toBe(0);
    relink.resolve(true);
    await settle();
    expect(log).toEqual(['needed:a', 'relink:a', 'changed']);
    expect(seen).toEqual([]);
  });

  it('読み取りの写しが無い半荘（reread: false）は、読み直しを確かめず、評価の当てはめ直しだけ確かめる', async () => {
    const { store, deps, log } = setup({ relink: vi.fn(async (id: string) => (log.push(`relink:${id}`), false)) });
    store.open('a', { reread: false });
    await settle();
    expect(deps.needed).not.toHaveBeenCalled();
    expect(deps.reread).not.toHaveBeenCalled();
    expect(log).toEqual(['relink:a']);
    // 当てはめ直さなかった（false）ので、一覧は読み直さない
    expect(deps.changed).not.toHaveBeenCalled();
  });

  it('読み直しに失敗したときは、当てはめ直さない（前の読み取りで版を書かない。次の起動でもう一度）', async () => {
    const relink = vi.fn(async () => true);
    const { store, deps } = setup({
      reread: async () => {
        throw new Error('読み直せません');
      },
      relink,
    });
    store.open('a');
    await settle();
    expect(relink).not.toHaveBeenCalled();
    expect(deps.changed).not.toHaveBeenCalled();
    expect(store.getSnapshot().size).toBe(0);
  });

  it('当てはめ直しに失敗しても、読み直しの結果は画面に反映する。もう一度は試さない（開き直しても）', async () => {
    const relink = vi.fn(async () => {
      throw new Error('保存できません');
    });
    const { store, deps } = setup({ relink });
    store.open('a');
    await settle();
    expect(deps.changed).toHaveBeenCalledTimes(1);
    expect(store.getSnapshot().size).toBe(0);
    store.open('a');
    await settle();
    expect(relink).toHaveBeenCalledTimes(1);
  });

  it('当てはめ直しを渡さなければ、これまでどおり（読み直しだけ）', async () => {
    const { store, log } = setup();
    store.open('a');
    await settle();
    expect(log).toEqual(['needed:a', 'reread:a', 'changed']);
  });

  it('同じ半荘は、この起動の間、1 回だけ（当てはめ直しも）', async () => {
    const relink = vi.fn(async () => false);
    const { store } = setup({ needed: async () => false, relink });
    store.open('a');
    await settle();
    store.open('a');
    store.open('a', { reread: false });
    await settle();
    expect(relink).toHaveBeenCalledTimes(1);
    store.open('b');
    await settle();
    expect(relink).toHaveBeenCalledTimes(2);
  });
});
