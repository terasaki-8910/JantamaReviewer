/**
 * 設定の「拮抗の場面」（F17。`contest_*`）を、エンジンの `ContestOptions` にする。
 * 差は設定ではポイント（%）、エンジンでは確率の差（20 → 0.2）。「N巡目以降」は、切のとき null。
 */
import { DEFAULT_CONTEST_OPTIONS, type ContestOptions } from '@jantama/engine';

import type { Settings } from '../../api/types';

export type ContestSettings = Pick<
  Settings,
  'contest_enabled' | 'contest_gap_percent' | 'contest_by_junme' | 'contest_min_junme' | 'contest_after_riichi' | 'contest_two_calls'
>;

/**
 * 設定から拮抗の場面の設定を作る。設定を読み込む前（null）と、項目が無い昔の設定は、既定値（入・差 20 ポイント・12 巡目以降・
 * 他家のリーチのあと・他家に2副露以上）。
 */
export function contestOptionsOf(settings: Partial<ContestSettings> | null | undefined): ContestOptions {
  const defaults = DEFAULT_CONTEST_OPTIONS;
  if (settings === null || settings === undefined) return { ...defaults };
  const percent = settings.contest_gap_percent;
  const minJunme = settings.contest_min_junme;
  return {
    enabled: settings.contest_enabled ?? defaults.enabled,
    maxGap: percent === undefined ? defaults.maxGap : percent / 100,
    minJunme: (settings.contest_by_junme ?? true) ? (minJunme ?? defaults.minJunme) : null,
    afterRiichi: settings.contest_after_riichi ?? defaults.afterRiichi,
    twoCalls: settings.contest_two_calls ?? defaults.twoCalls,
  };
}
