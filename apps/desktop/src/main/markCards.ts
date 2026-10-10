/**
 * 迷いマークのカード（F9）に出す、結びつけの状態を決める。画面にも Tauri にも依存しない（試験しやすいように分けてある）。
 *
 * 迷いマークごとに、次の順で決める（保存した選びは、自動の結果より先）:
 * 1. 保存した結びつけ（`links.marks`）が判断の鍵で、この結果に有る判断を指すなら、その判断（`findDecisionRef`）
 * 2. 保存した値が `"manual"`（局面を手で選ぶ）なら、手で選ぶ
 * 3. 保存した値が無い（または、この結果に無い判断の鍵）なら、自動の結果（`linkMarks`）:
 *    1 つに決まった（linked）・候補が複数（candidates）・手で選ぶ（manual）
 *
 * AI の候補・確率・順位は、ここにも出てこない（SPEC F3）。出すのは、判断の呼び名と、自分が実際にした行動だけ。
 */
import {
  findDecisionRef,
  linkMarks,
  type DecisionRef,
  type MarkCandidate,
  type MarkManualReason,
  type MortalReport,
} from '@jantama/engine';

import type { SessionRecord } from '../api/types';
import { markReadings } from './importFlow';

/** 迷いマークの結びつけの値のうち、「局面を手で選ぶ」という印（Rust 側の `LINK_MANUAL` と同じ）。 */
export const LINK_MANUAL = 'manual';

/** 迷いマーク 1 つの、いまの結びつけ。 */
export type MarkResolution =
  /** 判断が決まっている。`saved` は、保存した選び（false は、自動で 1 つに決まったもの）。 */
  | { kind: 'linked'; ref: DecisionRef; saved: boolean }
  /** 候補が 2 つ以上ある。選んでもらう。 */
  | { kind: 'candidates'; candidates: MarkCandidate[] }
  /** 手で選んでもらう。`reason` は、自動で決まらなかった理由（`chosen` は、利用者が手で選ぶと決めたもの）。 */
  | { kind: 'manual'; reason: MarkManualReason | 'chosen' };

export interface ResolvedMark {
  /** 記録の迷いマークの番号（取り消されていない記録の中での id）。結びつけの保存に使う。 */
  markId: number;
  /** 画面に出す番号（1 から。記録の順）。 */
  number: number;
  resolution: MarkResolution;
  /** 自動の結びつけの候補。2 つ以上あれば、選び直すときに、札に出す（保存した選びがあっても持つ）。 */
  autoCandidates: MarkCandidate[];
  /** 保存した結びつけの値（無ければ undefined）。取り消すときに、この値へ戻す。 */
  stored: string | undefined;
}

/** 迷いマークごとの、いまの結びつけ（記録の順）。 */
export function resolveMarks(
  report: MortalReport,
  session: Pick<SessionRecord, 'marks' | 'ocr' | 'links'>,
): ResolvedMark[] {
  const auto = linkMarks(report, markReadings(session, session.ocr));
  return session.marks.map((mark, index): ResolvedMark => {
    const link = auto[index];
    const autoCandidates = link?.candidates ?? [];
    const stored = session.links.marks[String(mark.id)];
    const base = { markId: mark.id, number: index + 1, autoCandidates, stored };

    if (stored !== undefined && stored !== LINK_MANUAL) {
      const ref = findDecisionRef(report, stored);
      if (ref !== null) return { ...base, resolution: { kind: 'linked', ref, saved: true } };
    }
    if (stored === LINK_MANUAL) return { ...base, resolution: { kind: 'manual', reason: 'chosen' } };

    if (link === undefined) return { ...base, resolution: { kind: 'manual', reason: 'unreadable' } };
    if (link.status === 'linked' && link.candidates[0] !== undefined) {
      return { ...base, resolution: { kind: 'linked', ref: link.candidates[0], saved: false } };
    }
    if (link.status === 'candidates') {
      return { ...base, resolution: { kind: 'candidates', candidates: link.candidates } };
    }
    return { ...base, resolution: { kind: 'manual', reason: link.reason ?? 'unreadable' } };
  });
}

/** 同じ値が 2 つ以上あるか。 */
function hasDuplicates(values: readonly string[]): boolean {
  return new Set(values).size !== values.length;
}

/**
 * 候補の札の文字: 実戦の行動（「打8p」「鳴かない判断」など）。
 * 同じ文字が重なるときは、巡目を足す。それでも重なるときは、局の名前も足す。
 */
export function chipLabels(candidates: readonly DecisionRef[]): string[] {
  const plain = candidates.map((c) => c.actionLabel);
  if (!hasDuplicates(plain)) return plain;
  const withTurn = candidates.map((c) => `${c.junme}巡目 ${c.actionLabel}`);
  if (!hasDuplicates(withTurn)) return withTurn;
  return candidates.map((c) => `${c.kyokuLabel} ${c.junme}巡目 ${c.actionLabel}`);
}

/**
 * 候補が複数のカードの 1 行目を、区切りごとに分けたもの: [局, 巡目, 「候補がN つ」]。
 * 候補がみな同じ局なら局の名前を、みな同じ巡目なら巡目も入れる（違うものは入れない）。
 */
function candidatesParts(candidates: readonly DecisionRef[]): string[] {
  const count = `候補が${candidates.length}つ`;
  const first = candidates[0];
  if (first === undefined || !candidates.every((c) => c.kyokuLabel === first.kyokuLabel)) return [count];
  const sameTurn = candidates.every((c) => c.junme === first.junme);
  return sameTurn ? [first.kyokuLabel, `${first.junme}巡目`, count] : [first.kyokuLabel, count];
}

/** 候補が複数のカードの 1 行目。「東2局 11巡目 · 候補が2つ」。 */
export function candidatesHeading(candidates: readonly DecisionRef[]): string {
  const parts = candidatesParts(candidates);
  const count = parts.at(-1) ?? '';
  // 局と巡目は空白で、候補の数は「 · 」でつなぐ。
  const where = parts.slice(0, -1).join(' ');
  return where === '' ? count : `${where} · ${count}`;
}

/** カードの 1 行目: 決まっていれば「東2局1本場 6巡目 · 打牌の迷い」、候補が複数なら候補の数、そうでなければ「読み取れませんでした」。 */
export function markHeading(item: ResolvedMark): string {
  const { resolution } = item;
  if (resolution.kind === 'linked') return resolution.ref.label;
  if (resolution.kind === 'candidates') return candidatesHeading(resolution.candidates);
  // 候補はあったが、利用者が手で選ぶと決めた（読み取れなかったのではない）。
  if (resolution.reason === 'chosen' && item.autoCandidates.length >= 2) return candidatesHeading(item.autoCandidates);
  return '読み取れませんでした';
}

/**
 * 画像の大きな表示の下に出す文の、カードの 1 行目に当たる部分（区切りごと）。
 * 例: [東2局1本場, 6巡目, 打牌の迷い]・[東3局1本場, 候補が2つ]・[読み取れませんでした]。取り込み前は空。
 */
export function markCaptionParts(item: ResolvedMark | null): string[] {
  if (item === null) return [];
  const { resolution } = item;
  if (resolution.kind === 'linked') {
    const { ref } = resolution;
    return [ref.kyokuLabel, `${ref.junme}巡目`, ref.kindLabel];
  }
  if (resolution.kind === 'candidates') return candidatesParts(resolution.candidates);
  if (resolution.reason === 'chosen' && item.autoCandidates.length >= 2) return candidatesParts(item.autoCandidates);
  return ['読み取れませんでした'];
}

/** 「局面を手で選ぶ」の、局の選択肢（局の順。同じ局は 1 つ）。 */
export interface KyokuOption {
  /** 何番目の局か（review.kyokus の添字）。 */
  position: number;
  /** 局の名前。例: 東2局1本場。 */
  label: string;
}

export function kyokuOptions(decisions: readonly DecisionRef[]): KyokuOption[] {
  const seen = new Set<number>();
  const options: KyokuOption[] = [];
  for (const decision of decisions) {
    if (seen.has(decision.kyokuPosition)) continue;
    seen.add(decision.kyokuPosition);
    options.push({ position: decision.kyokuPosition, label: decision.kyokuLabel });
  }
  return options;
}

/** 「局面を手で選ぶ」の、判断の選択肢。 */
export interface DecisionOption {
  key: string;
  /** 例: 「11巡目 · 打8p」。同じ文字が重なるときは、局の中の何番目かを足す。 */
  label: string;
  ref: DecisionRef;
}

/** 局の判断の選択肢（局の中の順）。自分が実際にした行動の名前だけで、AI の答えは出さない。 */
export function decisionOptions(decisions: readonly DecisionRef[], kyokuPosition: number): DecisionOption[] {
  const inKyoku = decisions.filter((d) => d.kyokuPosition === kyokuPosition);
  const plain = inKyoku.map((d) => `${d.junme}巡目 · ${d.actionLabel}`);
  const unique = !hasDuplicates(plain);
  return inKyoku.map((ref, i) => ({
    key: ref.key,
    label: unique ? (plain[i] as string) : `${plain[i]}（${ref.entryIndex + 1}番目）`,
    ref,
  }));
}
