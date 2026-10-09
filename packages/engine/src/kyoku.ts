/** 局の名前や風の扱い。 */
import type { Seat, Wind } from './report-types';

const WIND_ORDER: readonly Wind[] = ['E', 'S', 'W', 'N'];
const WIND_NAMES = ['東', '南', '西', '北'] as const;

/**
 * 局の通し番号（東1局が 0、東4局が 3、南1局が 4、西1局が 8）と本場から、局の名前を作る。
 * 例: (3, 0) は「東4局」、(2, 1) は「東3局1本場」。
 */
export function kyokuLabel(kyoku: number, honba: number): string {
  const wind = WIND_NAMES[Math.floor(kyoku / 4)] ?? '?';
  const label = `${wind}${(kyoku % 4) + 1}局`;
  return honba > 0 ? `${label}${honba}本場` : label;
}

/** 場風と場の中の局の番号（1 から 4）から、局の通し番号にする。 */
export function kyokuNumber(roundWind: Wind, kyokuInWind: number): number {
  return WIND_ORDER.indexOf(roundWind) * 4 + kyokuInWind - 1;
}

/** 席ごとの自風。親の席が東、そこから席の順に南・西・北。 */
export function seatWindsFor(oya: Seat): Wind[] {
  return [0, 1, 2, 3].map((seat) => WIND_ORDER[(seat - oya + 4) % 4] as Wind);
}
