import { DEFAULT_CONTEST_OPTIONS, contestOf } from '@jantama/engine';
import { describe, expect, it } from 'vitest';

import { gameOf } from '../../../tests/fake-study';
import { baseSettings } from '../../../tests/tauri-mock';
import { contestOptionsOf } from './contestOptions';

describe('F17 設定の「拮抗の場面」を、エンジンの設定にする', () => {
  it('設定を読み込む前（null）と、項目が無い昔の設定は、既定値（入・差 20 ポイント・12 巡目以降・他家のリーチのあと・他家に2副露以上）', () => {
    expect(contestOptionsOf(null)).toEqual(DEFAULT_CONTEST_OPTIONS);
    expect(contestOptionsOf(undefined)).toEqual(DEFAULT_CONTEST_OPTIONS);
    expect(contestOptionsOf({})).toEqual(DEFAULT_CONTEST_OPTIONS);
    expect(DEFAULT_CONTEST_OPTIONS).toEqual({ enabled: true, maxGap: 0.2, minJunme: 12, afterRiichi: true, twoCalls: true });
  });

  it('差はポイント（%）から確率の差（20 → 0.2）。出す・出さないと、2 つの条件は、そのまま', () => {
    const options = contestOptionsOf({
      contest_enabled: false,
      contest_gap_percent: 35,
      contest_by_junme: true,
      contest_min_junme: 9,
      contest_after_riichi: false,
      contest_two_calls: false,
    });
    expect(options).toEqual({ enabled: false, maxGap: 0.35, minJunme: 9, afterRiichi: false, twoCalls: false });
  });

  it('「N巡目以降」を切ると、巡目の条件は無し（null）。巡目の値は残っていても使わない', () => {
    expect(contestOptionsOf({ contest_by_junme: false, contest_min_junme: 9 }).minJunme).toBeNull();
    expect(contestOptionsOf({ contest_by_junme: true, contest_min_junme: 9 }).minJunme).toBe(9);
    expect(contestOptionsOf({ contest_by_junme: true }).minJunme).toBe(12);
  });

  it('試験用の設定の見本（拮抗は切）から作ると、拮抗の場面は出ない。入にすると、f9da の東4局 8巡目が拮抗になる（差 0.062。他家の条件による）', () => {
    const game = gameOf('fx1a');
    const found = (options: ReturnType<typeof contestOptionsOf>) =>
      game.decisions.filter((decision) => contestOf(decision, options) !== null).map((decision) => `${decision.kyokuLabel} ${decision.junme}`);
    expect(found(contestOptionsOf(baseSettings))).toEqual([]);
    expect(found(contestOptionsOf({ ...baseSettings, contest_enabled: true }))).toEqual(['東4局 8']);
    // 差を 1 ポイントにすると、境目の外（0.062 > 0.01）。巡目・リーチ・副露の条件を全部切っても、拮抗にならない
    expect(found(contestOptionsOf({ ...baseSettings, contest_enabled: true, contest_gap_percent: 1 }))).toEqual([]);
    expect(
      found(contestOptionsOf({ ...baseSettings, contest_enabled: true, contest_after_riichi: false, contest_two_calls: false, contest_by_junme: false })),
    ).toEqual([]);
  });
});
