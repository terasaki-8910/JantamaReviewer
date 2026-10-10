/**
 * 半荘の一覧の、日付ごとの並べ方・検索・段階の絞り込み（U-8、U-12、R8-5）。画面に依存しない、純粋な関数だけ。
 *
 * - 日付の見出し: 本日・昨日・M月D日（今年でなければ、年も）。一覧は新しい順
 * - 検索: 日付（本日・昨日・10月9日・10/9）・開始時刻・卓（玉の間など）・段階・Rating・迷い・取り込み前の語に当たる。
 *   空白で区切った語は、すべてに当たること（AND）。全角・半角と大文字・小文字は区別しない。
 *   メモの文字は、あとで足す（`SEARCH_FIELDS` に 1 つ足すだけ）
 * - 段階: すべて / A 以下（A+〜E）/ B 以下 / C 以下。段階がまだ無い半荘（取り込み前など）は、段階を選んだときは出さない
 */
import type { Grade } from '@jantama/engine';

import { DISPLAY_GRADES } from './GradeBadge';

export type StageId = 'all' | 'A' | 'B' | 'C';

export interface StageOption {
  id: StageId;
  label: string;
  /** メニューに出す、段階の範囲。 */
  range: string;
  /** `DISPLAY_GRADES`（S+ から E）の中で、この位置から下が対象。 */
  from: number;
}

export const STAGES: readonly StageOption[] = [
  { id: 'all', label: 'すべて', range: 'S+〜E', from: 0 },
  { id: 'A', label: 'A 以下', range: 'A+〜E', from: 3 },
  { id: 'B', label: 'B 以下', range: 'B+〜E', from: 6 },
  { id: 'C', label: 'C 以下', range: 'C+〜E', from: 9 },
];

export function stageOption(id: StageId): StageOption {
  return STAGES.find((stage) => stage.id === id) ?? (STAGES[0] as StageOption);
}

export interface ListFilter {
  query: string;
  stage: StageId;
}

export const NO_FILTER: ListFilter = { query: '', stage: 'all' };

/** 全角・半角をそろえ、小文字にする。 */
export function normalize(text: string): string {
  return text.normalize('NFKC').toLowerCase();
}

/** 検索の語か段階の絞り込みが、かかっているか。 */
export function isFiltering(filter: ListFilter): boolean {
  return filter.stage !== 'all' || normalize(filter.query).trim() !== '';
}

/** 一覧の 1 行について、探す・絞り込むために必要な値。 */
export interface FilterRow {
  startedMs: number;
  markCount: number;
  /** 検討結果を取り込んだか。 */
  imported: boolean;
  room: string | null;
  grade: Grade | null;
  ratingText: string | null;
  /** 半荘のメモ（まだ無い）。あとで、メモの欄ができたら入れる。 */
  memo?: string;
}

// ---- 日付 ----

interface LocalDay {
  year: number;
  month: number;
  day: number;
}

function localDay(ms: number): LocalDay {
  const d = new Date(ms);
  return { year: d.getFullYear(), month: d.getMonth() + 1, day: d.getDate() };
}

/** 暦の日で数えた、`ms` から `now` までの日数（同じ日 = 0、前の日 = 1）。夏時間などに左右されない。 */
function daysBefore(now: number, ms: number): number {
  const a = localDay(now);
  const b = localDay(ms);
  return Math.round((Date.UTC(a.year, a.month - 1, a.day) - Date.UTC(b.year, b.month - 1, b.day)) / 86_400_000);
}

/** 日付ごとのまとまりの印（同じ日は同じ値）。 */
export function dayKey(ms: number): string {
  const { year, month, day } = localDay(ms);
  return `${year}-${month}-${day}`;
}

/** 日付の見出し: 本日・昨日・10月9日（今年でなければ 2025年1月1日）。 */
export function dayLabel(ms: number, now: number): string {
  const diff = daysBefore(now, ms);
  if (diff === 0) return '本日';
  if (diff === 1) return '昨日';
  const { year, month, day } = localDay(ms);
  return year === localDay(now).year ? `${month}月${day}日` : `${year}年${month}月${day}日`;
}

export interface DayGroup<T> {
  key: string;
  label: string;
  rows: T[];
}

/** 新しい順に並んだ行を、日付ごとにまとめる（並びは変えない）。 */
export function groupByDay<T extends { startedMs: number }>(rows: readonly T[], now: number): DayGroup<T>[] {
  const groups: DayGroup<T>[] = [];
  for (const row of rows) {
    const key = dayKey(row.startedMs);
    const last = groups.at(-1);
    if (last && last.key === key) last.rows.push(row);
    else groups.push({ key, label: dayLabel(row.startedMs, now), rows: [row] });
  }
  return groups;
}

const two = (n: number) => String(n).padStart(2, '0');

/** 行に出す開始時刻: 19:09。 */
export function clockLabel(ms: number): string {
  const d = new Date(ms);
  return `${two(d.getHours())}:${two(d.getMinutes())}`;
}

// ---- 検索 ----

interface SearchContext {
  now: number;
}

/** 検索で当てる文字を、行から取り出す口。メモなど、新しい項目は、ここに足す。 */
type SearchField = (row: FilterRow, context: SearchContext) => string[];

const dateField: SearchField = (row, { now }) => {
  const { year, month, day } = localDay(row.startedMs);
  const diff = daysBefore(now, row.startedMs);
  const relative = diff === 0 ? ['本日', '今日'] : diff === 1 ? ['昨日'] : [];
  return [
    ...relative,
    `${month}月${day}日`,
    `${year}年${month}月${day}日`,
    `${month}/${day}`,
    `${two(month)}/${two(day)}`,
    `${year}/${month}/${day}`,
  ];
};

const timeField: SearchField = (row) => {
  const d = new Date(row.startedMs);
  const padded = `${two(d.getHours())}:${two(d.getMinutes())}`;
  return d.getHours() < 10 ? [padded, `${d.getHours()}:${two(d.getMinutes())}`] : [padded];
};

const roomField: SearchField = (row) => (row.room ? [row.room] : []);
const gradeField: SearchField = (row) => (row.grade ? [row.grade] : []);
const ratingField: SearchField = (row) => (row.ratingText ? [row.ratingText] : []);
const doubtField: SearchField = (row) => (row.markCount > 0 ? [`迷い${row.markCount}`] : []);
const importField: SearchField = (row) => (row.imported ? [] : ['取り込み前']);
const memoField: SearchField = (row) => (row.memo ? [row.memo] : []);

export const SEARCH_FIELDS: readonly SearchField[] = [
  dateField,
  timeField,
  roomField,
  gradeField,
  ratingField,
  doubtField,
  importField,
  memoField,
];

/** 数字で始まる語は、別の数字の途中には当てない（「1月9日」が「11月9日」に、「9:05」が「19:05」に当たらない）。 */
function includesAtBoundary(haystack: string, term: string): boolean {
  const startsWithDigit = /\d/.test(term.charAt(0));
  for (let at = haystack.indexOf(term); at >= 0; at = haystack.indexOf(term, at + 1)) {
    if (!startsWithDigit || at === 0 || !/\d/.test(haystack.charAt(at - 1))) return true;
  }
  return false;
}

/** 検索の語（空白で区切った、すべて）に、この行が当たるか。語が空なら、当たる。 */
export function matchesQuery(row: FilterRow, query: string, now: number): boolean {
  const terms = normalize(query).trim().split(/\s+/).filter(Boolean);
  if (terms.length === 0) return true;
  const haystack = normalize(SEARCH_FIELDS.flatMap((field) => field(row, { now })).join(' '));
  return terms.every((term) => includesAtBoundary(haystack, term));
}

/** 段階の絞り込みに、この行が入るか。段階がまだ無い行は、「すべて」以外では入らない。 */
export function passesStage(grade: Grade | null, stage: StageId): boolean {
  if (stage === 'all') return true;
  if (grade === null) return false;
  return DISPLAY_GRADES.indexOf(grade) >= stageOption(stage).from;
}

/** 検索と段階の絞り込みを、かけ合わせる。並びは変えない。 */
export function filterRows<T extends FilterRow>(rows: readonly T[], filter: ListFilter, now: number): T[] {
  return rows.filter((row) => passesStage(row.grade, filter.stage) && matchesQuery(row, filter.query, now));
}

/** 絞り込み中に一覧の上へ出す 1 行: 「A 以下 6件」「A 以下 · 「玉の間」 3件」。 */
export function filterSummary(filter: ListFilter, count: number): string {
  const parts: string[] = [];
  if (filter.stage !== 'all') parts.push(stageOption(filter.stage).label);
  const query = filter.query.trim();
  if (normalize(query) !== '') parts.push(`「${query}」`);
  return `${parts.join(' · ')} ${count}件`;
}
