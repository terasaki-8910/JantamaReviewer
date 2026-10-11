/**
 * 終局直後のメモ（F4、U-28）の、画面にも Tauri にも依存しない決まり（試験しやすいように分けてある）。
 *
 * メモは 2 種類（保存は半荘のフォルダの `memos.json`）:
 * - 迷いマークのメモ: 迷いマークの記録の番号（`MarkRecord.id`）ごとに「候補」と「理由（1行）」
 * - 迷いマークの無い迷いのメモ（`ExtraMemo`）: 局面を、手で選んだ位置（局・本場・巡目。結果を取り込む前に足せる）か、
 *   判断の鍵（取り込んだあとに足す・位置から結びつく）で持つ。位置だけのメモは、取り込んだあと、その位置にある判断が 1 つならそれに
 *   自動で結びつけ（`autoLinkTarget`）、そうでなければ、近い判断から選んでもらう（`decisionsNearPosition`）
 *
 * 答え合わせのあとの「終局直後のメモ」には、その問題（判断の鍵）に結びつく迷いマークのメモと、その判断の鍵のメモを出す
 * （`memosForDecision`）。判断の鍵がまだ無い（位置だけの）メモは出さない。AI の情報は、ここにも出てこない（U-1）。
 */
import { kyokuLabel, type DecisionRef } from '@jantama/engine';

import type { ExtraMemo, ExtraMemoPlace, MemoEntry, MemoPosition, Memos } from '../api/types';
import type { ResolvedMark } from './markCards';

/** 「候補」の長さの上限（文字数。Rust 側の `MAX_MEMO_CANDIDATES_CHARS` と同じ）。 */
export const MEMO_CANDIDATES_MAX = 40;
/** 「理由」の長さの上限（文字数。Rust 側の `MAX_MEMO_REASON_CHARS` と同じ）。 */
export const MEMO_REASON_MAX = 80;

/** 迷いの見出しのそばの説明のアイコン（i）に出す、終局直後のメモの説明（取り込む前の半荘にも、取り込んだ半荘にも出す）。 */
export const MEMO_INTRO =
  'AI の答えを見る前に、そのとき考えたことを書き留めます。局と巡目は、検討結果を取り込むときに画像から読むので、書かなくて構いません。';

/** 位置の範囲（Rust 側の `MAX_MEMO_KYOKU`・`MAX_MEMO_HONBA`・`MIN_MEMO_JUNME`・`MAX_MEMO_JUNME` と同じ）。 */
export const MEMO_KYOKU_MAX = 15;
export const MEMO_HONBA_MAX = 99;
export const MEMO_JUNME_MIN = 1;
export const MEMO_JUNME_MAX = 30;
/** 局のメニューに並べる局の通し番号（東1局が 0 から、西4局の 11 まで）。 */
export const MEMO_KYOKU_CHOICES: readonly number[] = Array.from({ length: 12 }, (_, kyoku) => kyoku);

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

/** 位置の呼び名: 「東3局 9巡目」「東2局1本場 6巡目」。 */
export function positionText(position: MemoPosition): string {
  return `${kyokuLabel(position.kyoku, position.honba)} ${position.junme}巡目`;
}

/** 入力欄の文字を、範囲の中の整数にする。空・小数・範囲の外・数でないものは null。 */
export function parseWhole(text: string, min: number, max: number): number | null {
  const trimmed = text.trim();
  if (!/^\d{1,3}$/.test(trimmed)) return null;
  const value = Number(trimmed);
  return value >= min && value <= max ? value : null;
}

/** 追加のメモの局面（保存するときの、判断の鍵と位置。無い方は含めない）。 */
export function placeOf(extra: ExtraMemo): ExtraMemoPlace {
  return {
    ...(extra.decision === undefined ? {} : { decision: extra.decision }),
    ...(extra.position === undefined ? {} : { position: extra.position }),
  };
}

/** 位置の近くの判断（`decisionsNearPosition` の答え）。 */
export interface NearDecisions {
  /**
   * どこまで広げて見つけたか。`junme`: 同じ局・本場・巡目 / `honba`: 同じ局・本場（その巡目に判断が無い）/
   * `kyoku`: 同じ局（本場は問わない。その局・本場に判断が無い）/ `none`: その局に判断が無い。
   */
  level: 'junme' | 'honba' | 'kyoku' | 'none';
  /** 見つけた判断（半荘の順）。 */
  options: DecisionRef[];
}

/**
 * 位置にある、自分の判断。同じ局・本場・巡目の判断があればそれ、無ければ同じ局・本場の判断、それも無ければ同じ局の判断
 * （近い順に広げる。選んでもらうとき、選べる物が無い行き止まりにしないため）。
 */
export function decisionsNearPosition(position: MemoPosition, decisions: readonly DecisionRef[]): NearDecisions {
  const sameKyoku = decisions.filter((d) => d.kyoku === position.kyoku);
  const sameHonba = sameKyoku.filter((d) => d.honba === position.honba);
  const sameJunme = sameHonba.filter((d) => d.junme === position.junme);
  if (sameJunme.length > 0) return { level: 'junme', options: sameJunme };
  if (sameHonba.length > 0) return { level: 'honba', options: sameHonba };
  if (sameKyoku.length > 0) return { level: 'kyoku', options: sameKyoku };
  return { level: 'none', options: [] };
}

/**
 * 位置だけのメモを自動で結びつける判断: 位置（局・本場・巡目）に、自分の判断がちょうど 1 つあるときだけ、その判断。
 * 判断の鍵をもう持つメモ・位置の無いメモ・判断が 0 や 2 つ以上のときは null（選んでもらう）。
 */
export function autoLinkTarget(extra: ExtraMemo, decisions: readonly DecisionRef[]): DecisionRef | null {
  if (extra.decision !== undefined || extra.position === undefined) return null;
  const near = decisionsNearPosition(extra.position, decisions);
  return near.level === 'junme' && near.options.length === 1 ? (near.options[0] ?? null) : null;
}

/** 選んでもらう判断の名前（「東3局 9巡目 · 打5s」。同じ名前が重なるときは、局の中の何番目かを足す）。AI の答えは出さない。 */
export function placePickLabels(options: readonly DecisionRef[]): string[] {
  const plain = options.map((d) => `${d.kyokuLabel} ${d.junme}巡目 · ${d.actionLabel}`);
  const unique = new Set(plain).size === plain.length;
  return unique ? plain : options.map((d, i) => `${plain[i] ?? ''}（${d.entryIndex + 1}番目）`);
}
