/**
 * 終局直後のメモ（F4、U-28）の、画面にも Tauri にも依存しない決まり（試験しやすいように分けてある）。
 *
 * メモは 2 種類（保存は半荘のフォルダの `memos.json`）:
 * - 迷いマークのメモ: 迷いマークの記録の番号（`MarkRecord.id`）ごとに「候補」と「理由（1行）」
 * - 迷いマークの無い迷いのメモ（`ExtraMemo`）: 局・巡目を手で選んだ判断の鍵に結びつける
 *
 * 答え合わせのあとの「終局直後のメモ」には、その問題（判断の鍵）に結びつく迷いマークのメモと、その判断の鍵のメモを出す
 * （`memosForDecision`）。AI の情報は、ここにも出てこない（U-1）。
 */
import type { ExtraMemo, MemoEntry, Memos } from '../api/types';
import type { ResolvedMark } from './markCards';

/** 「候補」の長さの上限（文字数。Rust 側の `MAX_MEMO_CANDIDATES_CHARS` と同じ）。 */
export const MEMO_CANDIDATES_MAX = 40;
/** 「理由」の長さの上限（文字数。Rust 側の `MAX_MEMO_REASON_CHARS` と同じ）。 */
export const MEMO_REASON_MAX = 80;

export const NO_MEMOS: Memos = { marks: {}, extras: [] };
export const EMPTY_MEMO: MemoEntry = { candidates: '', reason: '' };

/** 前後の空白を除いたメモ。「候補」も「理由」も空なら undefined（空のメモは持たない）。 */
export function normalizeMemo(entry: MemoEntry | undefined): MemoEntry | undefined {
  if (entry === undefined) return undefined;
  const candidates = entry.candidates.trim();
  const reason = entry.reason.trim();
  return candidates === '' && reason === '' ? undefined : { candidates, reason };
}

/** 同じメモか（前後の空白は無いものとして比べる。空のメモと無いメモは同じ）。 */
export function sameMemo(a: MemoEntry | undefined, b: MemoEntry | undefined): boolean {
  const left = normalizeMemo(a);
  const right = normalizeMemo(b);
  if (left === undefined || right === undefined) return left === right;
  return left.candidates === right.candidates && left.reason === right.reason;
}

/** 迷いマークのメモ。無ければ undefined。 */
export function memoOfMark(memos: Memos, markId: number): MemoEntry | undefined {
  return memos.marks[String(markId)];
}

/** 迷いマークの無い迷いのメモの、次の名前（`x1`・`x2`…。いまある名前の数字の最大に 1 足す）。 */
export function nextExtraId(extras: readonly ExtraMemo[]): string {
  let max = 0;
  for (const extra of extras) {
    const match = /^x(\d+)$/.exec(extra.id);
    if (match !== null) max = Math.max(max, Number(match[1]));
  }
  return `x${max + 1}`;
}

/** 答え合わせのあとに出す、メモ 1 つ。 */
export interface ShownMemo {
  /** 出どころ。迷いマークのメモか、迷いマークの無い迷いのメモか。 */
  source: 'mark' | 'extra';
  /** 「迷い3」「追加のメモ」。メモが 2 つ以上あるときの見分けに使う。 */
  label: string;
  memo: MemoEntry;
}

/**
 * ある判断（鍵）に結びつくメモ（答え合わせのあとの「終局直後のメモ」）。迷いマークのメモは、その判断に結びついた迷い
 * （保存した選びか、推定で結びついたもの。`resolution.kind === 'linked'`）の番号の順、そのあとに、その鍵の迷いマークの無い迷いのメモ（足した順）。
 * 「候補」も「理由」も空のメモは出さない。
 */
export function memosForDecision(args: {
  memos: Memos;
  resolved: readonly ResolvedMark[];
  decisionKey: string;
}): ShownMemo[] {
  const { memos, resolved, decisionKey } = args;
  const shown: ShownMemo[] = [];
  for (const mark of resolved) {
    if (mark.resolution.kind !== 'linked' || mark.resolution.ref.key !== decisionKey) continue;
    const memo = normalizeMemo(memoOfMark(memos, mark.markId));
    if (memo !== undefined) shown.push({ source: 'mark', label: `迷い${mark.number}`, memo });
  }
  for (const extra of memos.extras) {
    if (extra.decision !== decisionKey) continue;
    const memo = normalizeMemo({ candidates: extra.candidates, reason: extra.reason });
    if (memo !== undefined) shown.push({ source: 'extra', label: '追加のメモ', memo });
  }
  return shown;
}
