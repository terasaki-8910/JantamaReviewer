import { describe, expect, it } from 'vitest';

import { resolveView, START_VIEW, VIEWS } from './views';

describe('N-5: 画面の名前の解決（メモリの中の状態だけで持つ）', () => {
  it('いま在る画面の名前は、そのまま画面になる', () => {
    expect(VIEWS).toEqual(['records', 'settings']);
    for (const view of VIEWS) expect(resolveView(view)).toBe(view);
  });

  it('知らない名前・文字列でない値・空は、最初の画面に戻る', () => {
    expect(START_VIEW).toBe('records');
    for (const unknown of [
      'review',
      'Records',
      ' records',
      '#/settings',
      '/settings',
      'settings?x=1',
      '',
      undefined,
      null,
      0,
      42,
      {},
      ['settings'],
    ]) {
      expect(resolveView(unknown), String(unknown)).toBe(START_VIEW);
    }
  });

  it('最初の画面は、一覧にある', () => {
    expect(VIEWS).toContain(START_VIEW);
  });
});
