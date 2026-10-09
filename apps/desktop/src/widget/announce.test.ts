import { describe, expect, it } from 'vitest';

import { baseState } from '../../tests/tauri-mock';
import type { AppState } from '../api/types';
import { describeChange } from './announce';

const next = (patch: Partial<AppState>): AppState => ({ ...baseState, ...patch });

describe('describeChange', () => {
  it('最初の受け取りでは何も言わない', () => {
    expect(describeChange(null, baseState)).toBe('');
  });

  it('評価が増えたら、何局目を何で記録したかを言う', () => {
    expect(describeChange(baseState, next({ ratings: [...baseState.ratings, 'bad'] }))).toBe(
      '5局目を✕で記録',
    );
    expect(describeChange(baseState, next({ ratings: [...baseState.ratings, 'fair'] }))).toBe(
      '5局目を△で記録',
    );
  });

  it('迷いが増えたら、合計を言う', () => {
    expect(describeChange(baseState, next({ mark_count: 3 }))).toBe('迷いの印を追加。合計3');
  });

  it('取り消しを言う', () => {
    expect(describeChange(baseState, next({ ratings: baseState.ratings.slice(0, 3) }))).toBe(
      '4局目の評価を取り消し',
    );
    expect(describeChange(baseState, next({ mark_count: 1 }))).toBe('迷いの印を取り消し。合計1');
  });

  it('新しい半荘を言う', () => {
    expect(
      describeChange(
        baseState,
        next({ session_id: '20261009-170000', mark_count: 0, ratings: [], next_hand: 1 }),
      ),
    ).toBe('新しい半荘を始めました');
  });

  it('変わっていなければ空', () => {
    expect(describeChange(baseState, { ...baseState })).toBe('');
  });
});
