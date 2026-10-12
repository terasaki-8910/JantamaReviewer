/**
 * 週の成績（手入力）と来週の重点（U-30）の、入力の読み取りと確かめ。画面にも Tauri にも依存しない。
 * 保存は Rust 側（study.sqlite の weeks 表）が、同じ決まりで確かめ直す。ここは、画面に理由を出すために先に確かめる。
 *
 * - 成績: 数だけ（全角の数字・小数点も受ける）。小数は 2 桁まで。率は 0 から 100、平均順位は 1 から 4。空は「入れていない」
 * - 重点: 空の行を除いて 3 行まで、1 行は 100 文字まで。空は「書いていない」
 */
import type { WeekRecord, WeekStats } from '../../api/types';

export type StatKey = keyof WeekStats;

export interface StatField {
  key: StatKey;
  /** 画面の名前（ラベル）。 */
  label: string;
  unit: '%' | '位';
  /** 画面に出す小数の桁数。 */
  digits: 1 | 2;
  min: number;
  max: number;
  placeholder: string;
}

/** 成績の 6 つの項目（並びは、画面の並び）。 */
export const STAT_FIELDS: readonly StatField[] = [
  { key: 'rank4', label: '4位率', unit: '%', digits: 1, min: 0, max: 100, placeholder: '0.0' },
  { key: 'deal', label: '放銃率', unit: '%', digits: 1, min: 0, max: 100, placeholder: '0.0' },
  { key: 'avg', label: '平均順位', unit: '位', digits: 2, min: 1, max: 4, placeholder: '0.00' },
  { key: 'win', label: '和了率', unit: '%', digits: 1, min: 0, max: 100, placeholder: '0.0' },
  { key: 'call', label: '副露率', unit: '%', digits: 1, min: 0, max: 100, placeholder: '0.0' },
  { key: 'riichi', label: '立直率', unit: '%', digits: 1, min: 0, max: 100, placeholder: '0.0' },
];

export const FOCUS_MAX_LINES = 3;
export const FOCUS_MAX_LINE_CHARS = 100;

export type Parsed<T> = { ok: true; value: T } | { ok: false; message: string };

/** 入れた文字を、数にする。空は null（入れていない）。 */
export function parseStat(text: string, field: StatField): Parsed<number | null> {
  const normalized = text.normalize('NFKC').trim();
  if (normalized === '') return { ok: true, value: null };
  if (!/^\d+(\.\d{1,2})?$/.test(normalized)) {
    return { ok: false, message: `${field.label}は、数で入れてください（小数は 2 桁まで）` };
  }
  const value = Number(normalized);
  if (value < field.min || value > field.max) {
    return { ok: false, message: `${field.label}は、${field.min} から ${field.max} の数で入れてください` };
  }
  return { ok: true, value };
}

/** 保存してある数を、入力欄の文字にする。 */
export function statText(value: number | undefined, field: StatField): string {
  return value === undefined ? '' : value.toFixed(field.digits);
}

/** 重点を、空の行と行の前後の空白を除いた形にして確かめる（保存する形）。 */
export function parseFocus(text: string): Parsed<string> {
  const lines = text
    .split(/\r?\n/)
    .map((line) => line.trim())
    .filter((line) => line !== '');
  if (lines.length > FOCUS_MAX_LINES) return { ok: false, message: `重点は ${FOCUS_MAX_LINES} 行までです` };
  if (lines.some((line) => Array.from(line).length > FOCUS_MAX_LINE_CHARS)) {
    return { ok: false, message: `重点の 1 行は ${FOCUS_MAX_LINE_CHARS} 文字までです` };
  }
  return { ok: true, value: lines.join('\n') };
}

/** 成績の 1 項目を替えた記録（`value` が null なら、その項目を消す）。ほかの項目と重点は、そのまま。 */
export function withStat(current: WeekRecord | undefined, week: string, key: StatKey, value: number | null): WeekRecord {
  const stats: WeekStats = { ...(current?.stats ?? {}) };
  if (value === null) delete stats[key];
  else stats[key] = value;
  return { week, stats, focus: current?.focus ?? '' };
}

/** 重点を替えた記録。成績は、そのまま。 */
export function withFocus(current: WeekRecord | undefined, week: string, focus: string): WeekRecord {
  return { week, stats: { ...(current?.stats ?? {}) }, focus };
}
