import { describe, expect, it } from 'vitest';

import { resolveView, sameView, sessionView, START_VIEW, VIEW_KINDS, type View } from './views';

describe('N-5: 画面の解決（メモリの中の状態だけで持つ）', () => {
  it('いま在る画面は、そのまま画面になる', () => {
    expect(VIEW_KINDS).toEqual(['none', 'session', 'import', 'settings']);
    const views: View[] = [{ kind: 'none' }, sessionView('20261009-161200'), { kind: 'import' }, { kind: 'settings' }];
    for (const view of views) expect(resolveView(view)).toEqual(view);
  });

  it('知らない種類・文字列・形の合わない値・半荘の名前が無い画面は、最初の画面に戻る', () => {
    expect(START_VIEW).toEqual({ kind: 'none' });
    for (const unknown of [
      'review',
      'records',
      '#/settings',
      '/settings',
      '',
      undefined,
      null,
      0,
      42,
      [],
      {},
      { kind: 'review' },
      { kind: 'Settings' },
      { kind: 'records' },
      { kind: 'session' },
      { kind: 'session', id: '' },
      { kind: 'session', id: 7 },
      { kind: ['settings'] },
    ]) {
      expect(resolveView(unknown), JSON.stringify(unknown)).toEqual(START_VIEW);
    }
  });

  it('余計な項目は落として、画面の形だけを返す', () => {
    expect(resolveView({ kind: 'settings', extra: 'x' })).toEqual({ kind: 'settings' });
    expect(resolveView({ kind: 'session', id: 'a-1', extra: 'x' })).toEqual({ kind: 'session', id: 'a-1' });
  });

  it('同じ画面かは、種類と（半荘なら）名前で決まる', () => {
    expect(sameView(sessionView('a'), sessionView('a'))).toBe(true);
    expect(sameView(sessionView('a'), sessionView('b'))).toBe(false);
    expect(sameView({ kind: 'import' }, { kind: 'import' })).toBe(true);
    expect(sameView({ kind: 'import' }, { kind: 'settings' })).toBe(false);
    expect(sameView(sessionView('a'), { kind: 'import' })).toBe(false);
    expect(sameView({ kind: 'none' }, { kind: 'none' })).toBe(true);
  });
});
