import type { CenterReading } from '@jantama/engine';

import type { Trigger } from '../api/types';

const WEEKDAYS = ['日', '月', '火', '水', '木', '金', '土'] as const;

function two(n: number): string {
  return String(n).padStart(2, '0');
}

/** 半荘の見出し: 「10月9日(金) 16:12」。今年でなければ年も付ける。 */
export function formatSessionTitle(ms: number, now: number = Date.now()): string {
  const d = new Date(ms);
  const year = d.getFullYear() === new Date(now).getFullYear() ? '' : `${d.getFullYear()}年`;
  const weekday = WEEKDAYS[d.getDay()] ?? '';
  return `${year}${d.getMonth() + 1}月${d.getDate()}日(${weekday}) ${two(d.getHours())}:${two(d.getMinutes())}`;
}

/** 半荘の短い呼び名: 「10月9日 19:09」。今年でなければ年も付ける。取り込みの案内に使う。 */
export function formatSessionShort(ms: number, now: number = Date.now()): string {
  const d = new Date(ms);
  const year = d.getFullYear() === new Date(now).getFullYear() ? '' : `${d.getFullYear()}年`;
  return `${year}${d.getMonth() + 1}月${d.getDate()}日 ${two(d.getHours())}:${two(d.getMinutes())}`;
}

/** 迷いマーク・評価の時刻: 「16:14:32」。 */
export function formatClock(ms: number): string {
  const d = new Date(ms);
  return `${two(d.getHours())}:${two(d.getMinutes())}:${two(d.getSeconds())}`;
}

/** キーの名前を、設定画面に出す短い表記にする（`KeyM` → `M`、`F8` → `F8`）。 */
export function formatKeyCode(code: string): string {
  if (/^Key[A-Z]$/.test(code)) return code.slice(3);
  if (/^Digit[0-9]$/.test(code)) return code.slice(5);
  if (/^Numpad[0-9]$/.test(code)) return `テンキー ${code.slice(6)}`;
  const numpad: Record<string, string> = {
    NumpadAdd: '+',
    NumpadSubtract: '-',
    NumpadMultiply: '*',
    NumpadDivide: '/',
    NumpadDecimal: '.',
  };
  const mapped = numpad[code];
  if (mapped) return `テンキー ${mapped}`;
  return code;
}

const MOUSE_TRIGGER_NAMES = {
  mouse_x1: 'マウスの戻るボタン（XButton1）',
  mouse_x2: 'マウスの進むボタン（XButton2）',
  mouse_middle: 'マウスの中ボタン（MButton）',
} as const;

/**
 * 割り当てを、設定に出す文にする（W-10）。マウスのボタンは名前、キーは修飾キーつきの「Ctrl+Alt+M」、
 * 修飾キーが無いキーは「キー：F13」。承認済みの見本（round7-samples）の書き方。
 */
export function describeTrigger(trigger: Trigger): string {
  if (trigger.kind !== 'key') return MOUSE_TRIGGER_NAMES[trigger.kind];
  const key = formatKeyCode(trigger.code);
  const modifiers = [
    trigger.ctrl && 'Ctrl',
    trigger.alt && 'Alt',
    trigger.shift && 'Shift',
    trigger.win && 'Win',
  ].filter((name): name is string => typeof name === 'string');
  return modifiers.length > 0 ? [...modifiers, key].join('+') : `キー：${key}`;
}

const WIND_NAMES = { E: '東', S: '南', W: '西' } as const;

/** 点数の書き方: 3 桁ごとにコンマ。例: 15,100。 */
export function groupedNumber(value: number): string {
  return String(value).replace(/\B(?=(\d{3})+(?!\d))/g, ',');
}

/**
 * スクショから読んだ中央の文字の書き方: 「東2局・残り47・15,100点」。残りの牌の数が無いとき（局と点数だけ読めたとき）は省く。
 * 本場は読めない（点数との照合で区別する）ので、書かない。
 */
export function centerText(center: CenterReading): string {
  const parts = [`${WIND_NAMES[center.wind]}${center.number}局`];
  if (center.tilesLeft !== undefined) parts.push(`残り${center.tilesLeft}`);
  parts.push(`${groupedNumber(center.score)}点`);
  return parts.join('・');
}
