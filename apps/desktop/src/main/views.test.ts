import { describe, expect, it } from 'vitest';

import {
  quizView,
  replayView,
  resolveView,
  sameView,
  sessionView,
  START_VIEW,
  VIEW_KINDS,
  viewSessionId,
  type View,
} from './views';

describe('N-5: 画面の解決（メモリの中の状態だけで持つ）', () => {
  it('いま在る画面は、そのまま画面になる', () => {
    expect(VIEW_KINDS).toEqual(['none', 'session', 'import', 'settings', 'today', 'quiz', 'review', 'replay']);
    const views: View[] = [
      { kind: 'none' },
      sessionView('20261009-161200'),
      { kind: 'import' },
      { kind: 'settings' },
      { kind: 'today' },
      { kind: 'review' },
      quizView('20261009-161200', 'k2h1e14'),
      quizView('20261009-161200', 'k2h1e14', 'review'),
      replayView('20261009-161200'),
      replayView('20261009-161200', 'k2h1e14'),
    ];
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
      { kind: 'Review' },
      { kind: 'Settings' },
      { kind: 'records' },
      { kind: 'session' },
      { kind: 'session', id: '' },
      { kind: 'session', id: 7 },
      { kind: ['settings'] },
      // 出題は、半荘の名前・判断の鍵・種類がそろったものだけ
      { kind: 'quiz' },
      { kind: 'quiz', sessionId: 'a', key: 'k1h0e1' },
      { kind: 'quiz', sessionId: '', key: 'k1h0e1', mode: 'quiz' },
      { kind: 'quiz', sessionId: 'a', key: '', mode: 'quiz' },
      { kind: 'quiz', sessionId: 'a', key: 'k1h0e1', mode: 'practice' },
      { kind: 'quiz', sessionId: 7, key: 'k1h0e1', mode: 'quiz' },
      // 通して見る画面は、半荘の名前が要る
      { kind: 'replay' },
      { kind: 'replay', sessionId: '' },
      { kind: 'replay', sessionId: 7, key: 'k1h0e1' },
    ]) {
      expect(resolveView(unknown), JSON.stringify(unknown)).toEqual(START_VIEW);
    }
  });

  it('余計な項目は落として、画面の形だけを返す', () => {
    expect(resolveView({ kind: 'settings', extra: 'x' })).toEqual({ kind: 'settings' });
    expect(resolveView({ kind: 'session', id: 'a-1', extra: 'x' })).toEqual({ kind: 'session', id: 'a-1' });
    expect(resolveView({ kind: 'today', extra: 'x' })).toEqual({ kind: 'today' });
    expect(resolveView({ kind: 'quiz', sessionId: 'a', key: 'k1h0e1', mode: 'review', extra: 'x' })).toEqual(
      quizView('a', 'k1h0e1', 'review'),
    );
    expect(resolveView({ kind: 'replay', sessionId: 'a', key: 'k1h0e1', extra: 'x' })).toEqual(replayView('a', 'k1h0e1'));
    // 開く判断の鍵が空・文字でないときは、半荘の頭から
    expect(resolveView({ kind: 'replay', sessionId: 'a', key: '' })).toEqual(replayView('a'));
    expect(resolveView({ kind: 'replay', sessionId: 'a', key: 5 })).toEqual(replayView('a'));
  });

  it('同じ画面かは、種類と（半荘なら）名前で決まる', () => {
    expect(sameView(sessionView('a'), sessionView('a'))).toBe(true);
    expect(sameView(sessionView('a'), sessionView('b'))).toBe(false);
    expect(sameView({ kind: 'import' }, { kind: 'import' })).toBe(true);
    expect(sameView({ kind: 'import' }, { kind: 'settings' })).toBe(false);
    expect(sameView(sessionView('a'), { kind: 'import' })).toBe(false);
    expect(sameView({ kind: 'none' }, { kind: 'none' })).toBe(true);
    expect(sameView({ kind: 'today' }, { kind: 'today' })).toBe(true);
    expect(sameView({ kind: 'today' }, { kind: 'review' })).toBe(false);
    // 出題は、半荘の名前・判断の鍵・種類まで同じとき
    expect(sameView(quizView('a', 'k1h0e1'), quizView('a', 'k1h0e1'))).toBe(true);
    expect(sameView(quizView('a', 'k1h0e1'), quizView('b', 'k1h0e1'))).toBe(false);
    expect(sameView(quizView('a', 'k1h0e1'), quizView('a', 'k1h0e2'))).toBe(false);
    expect(sameView(quizView('a', 'k1h0e1'), quizView('a', 'k1h0e1', 'review'))).toBe(false);
    expect(sameView(quizView('a', 'k1h0e1'), sessionView('a'))).toBe(false);
    // 通して見る画面は、半荘の名前と開く判断の鍵まで同じとき
    expect(sameView(replayView('a'), replayView('a'))).toBe(true);
    expect(sameView(replayView('a', 'k1h0e1'), replayView('a', 'k1h0e1'))).toBe(true);
    expect(sameView(replayView('a', 'k1h0e1'), replayView('a', 'k1h0e2'))).toBe(false);
    expect(sameView(replayView('a'), replayView('a', 'k1h0e1'))).toBe(false);
    expect(sameView(replayView('a'), replayView('b'))).toBe(false);
    expect(sameView(replayView('a'), sessionView('a'))).toBe(false);
  });

  it('半荘に結びついた画面（半荘の画面・その半荘の出題）は、半荘の名前を持つ', () => {
    expect(viewSessionId(sessionView('a'))).toBe('a');
    expect(viewSessionId(quizView('b', 'k1h0e1'))).toBe('b');
    expect(viewSessionId(replayView('c'))).toBe('c');
    expect(viewSessionId(replayView('c', 'k1h0e1'))).toBe('c');
    for (const view of [{ kind: 'none' }, { kind: 'import' }, { kind: 'settings' }, { kind: 'today' }, { kind: 'review' }] as const) {
      expect(viewSessionId(view)).toBeNull();
    }
  });
});
