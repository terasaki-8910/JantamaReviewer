/**
 * 出題の画面に出す、短い言い方（種類の名前・時間・日付）。
 */
import type { DecisionKind, Seat } from '@jantama/engine';

/** 判断の種類の名前（今日の出題の行に出す）。 */
export const KIND_NAME: Readonly<Record<DecisionKind, string>> = {
  discard: '打牌',
  call: '鳴き',
  riichi: 'リーチ',
  win: '和了',
  kan: 'カン',
};

/** 答えるまでの時間: 0:38。 */
export function formatElapsed(seconds: number): string {
  const total = Math.max(0, Math.round(seconds));
  return `${Math.floor(total / 60)}:${String(total % 60).padStart(2, '0')}`;
}

/** 暦の日付（YYYY-MM-DD）を、10月16日 にする。 */
export function formatMonthDay(date: string): string {
  const [, month, day] = date.split('-');
  return `${Number(month)}月${Number(day)}日`;
}

const RELATION_NAME = ['自分', '下家', '対面', '上家'] as const;

/** 本人の席 `me` から見た、席 `seat` の呼び名（自分・下家・対面・上家）。 */
export function relationName(me: Seat, seat: Seat): string {
  return RELATION_NAME[(((seat - me) % 4) + 4) % 4] ?? '';
}

/** 時刻（ミリ秒）の日付を、10月9日 にする。 */
export function formatMonthDayOfMs(ms: number): string {
  const date = new Date(ms);
  return `${date.getMonth() + 1}月${date.getDate()}日`;
}
