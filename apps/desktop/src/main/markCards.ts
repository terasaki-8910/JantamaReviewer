/**
 * 迷いマークのカード（F9）に出す、結びつけの状態と文言を決める。画面にも Tauri にも依存しない（試験しやすいように分けてある）。
 *
 * 迷いマークごとに、次の順で決める（保存した選びは、自動の結果より先）:
 * 1. 保存した結びつけ（`links.marks`）が判断の鍵で、この結果に有る判断を指すなら、その判断（`findDecisionRef`）。利用者が選んだもの
 *    （`saved: true`）なので、「推定」の印は付けない
 * 2. 保存した値が `"manual"`（局面を手で選ぶ）なら、手で選ぶ
 * 3. 保存した値が無い（または、この結果に無い判断の鍵）なら、自動の結果（`linkMarks`）: 読めたものは、1 位の判断を推定として
 *    結びつける（`saved: false`。近い判断は、ほかの候補）。読めないものは、手で選ぶ
 *
 * どの状態のカードも、同じ構成の文言にする（U-13）: 1 行目「迷いN」と時刻（カードの部品が出す）、2 行目の局面（`markHeading`）、
 * スクショから読んだ値の静かな 1 行（`readingLine`）、その下に状態ごとの欄（推定の印・自分がした行動・ほかの候補・選び直す・手で選ぶ）。
 *
 * AI の候補・確率・順位は、ここにも出てこない（SPEC F3、U-1）。出すのは、判断の呼び名と、自分が実際にした行動だけ。
 */
import {
  findDecisionRef,
  linkMarks,
  type CenterText,
  type DecisionRef,
  type MarkCandidate,
  type MarkManualReason,
  type MortalReport,
} from '@jantama/engine';

import type { SessionRecord } from '../api/types';
import { centerText } from './format';
import { markReadings } from './importFlow';

/** 迷いマークの結びつけの値のうち、「局面を手で選ぶ」という印（Rust 側の `LINK_MANUAL` と同じ）。 */
export const LINK_MANUAL = 'manual';

/** 推定で結びつけたことを示す印の文字。 */
export const ESTIMATE_TAG = '推定';
/** 局面が決まっていない（手で選ぶ）カードの 2 行目。 */
export const UNDECIDED_TEXT = '局面は決まっていません';
/** スクショから中央の文字を読めなかったときの 1 行。 */
export const UNREADABLE_TEXT = 'スクショを読めませんでした';

/** 迷いマーク 1 つの、いまの結びつけ。 */
export type MarkResolution =
  /**
   * 判断が決まっている。`saved` が true は、利用者が選んで保存したもの。false は、自動で 1 位を推定として結びつけたもの
   * （「推定」の印と、ほかの候補を出す）。
   */
  | { kind: 'linked'; ref: DecisionRef; saved: boolean }
  /** 手で選んでもらう。`reason` は、自動で決まらなかった理由（`chosen` は、利用者が手で選ぶと決めたもの）。 */
  | { kind: 'manual'; reason: MarkManualReason | 'chosen' };

export interface ResolvedMark {
  /** 記録の迷いマークの番号（取り消されていない記録の中での id）。結びつけの保存に使う。 */
  markId: number;
  /** 画面に出す番号（1 から。記録の順）。 */
  number: number;
  resolution: MarkResolution;
  /**
   * 自動の結びつけの 1 位（推定）と、ほかの候補（点の順）。読めなければ空。
   * 利用者が選んだあとも持つ（選び直すとき、札に出す）。
   */
  autoCandidates: MarkCandidate[];
  /** スクショから読んだ局・残りの牌の数・点数。読めなければ null。 */
  reading: CenterText | null;
  /** 自動で決まらなかった理由（読めたものは null）。 */
  autoReason: MarkManualReason | null;
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
    const estimate = link?.estimate ?? null;
    const autoCandidates = estimate === null || link === undefined ? [] : [estimate, ...link.alternatives];
    const stored = session.links.marks[String(mark.id)];
    const base = {
      markId: mark.id,
      number: index + 1,
      autoCandidates,
      reading: link?.center ?? null,
      autoReason: link === undefined ? ('unreadable' as const) : link.reason,
      stored,
    };

    if (stored !== undefined && stored !== LINK_MANUAL) {
      const ref = findDecisionRef(report, stored);
      if (ref !== null) return { ...base, resolution: { kind: 'linked', ref, saved: true } };
    }
    if (stored === LINK_MANUAL) return { ...base, resolution: { kind: 'manual', reason: 'chosen' } };

    if (estimate !== null) return { ...base, resolution: { kind: 'linked', ref: estimate, saved: false } };
    return { ...base, resolution: { kind: 'manual', reason: link?.reason ?? 'unreadable' } };
  });
}

/** 推定として結びつけてあるか（利用者が選んだものではないか）。 */
export function isEstimated(item: ResolvedMark): boolean {
  return item.resolution.kind === 'linked' && !item.resolution.saved;
}

/** 推定のとき、ほかの候補（1 位の推定は含まない）。 */
export function alternativesOf(item: ResolvedMark): MarkCandidate[] {
  const { resolution } = item;
  if (resolution.kind !== 'linked') return [];
  return item.autoCandidates.filter((candidate) => candidate.key !== resolution.ref.key);
}

/** 巡目の書き方: 1 つなら「8巡目」、違う巡目にまたがるなら「8〜9巡目」。 */
export function junmeSpanText(junmes: readonly number[]): string {
  if (junmes.length === 0) return '';
  const low = Math.min(...junmes);
  const high = Math.max(...junmes);
  return low === high ? `${low}巡目` : `${low}〜${high}巡目`;
}

/**
 * 推定のカードの 2 行目: 「東2局1本場 8〜9巡目 · 鳴きの迷い」。局・種類は 1 位の判断のもの。
 * 巡目は、同じ局の、1 位とほかの候補の巡目をまとめて書く（巡目が違うなら「8〜9巡目」の形。どれが当たりかは、まだ決まっていない）。
 */
export function estimateHeading(estimate: DecisionRef, alternatives: readonly DecisionRef[]): string {
  const sameKyoku = [estimate, ...alternatives].filter((c) => c.kyokuPosition === estimate.kyokuPosition);
  const span = junmeSpanText(sameKyoku.map((c) => c.junme));
  return `${estimate.kyokuLabel} ${span} · ${estimate.kindLabel}`;
}

/**
 * カードの 2 行目:
 * - 利用者が選んだもの: 「東2局1本場 6巡目 · 打牌の迷い」
 * - 推定: 同じ形で、巡目は 1 位とほかの候補をまとめる（「東2局1本場 8〜9巡目 · 鳴きの迷い」）
 * - 手で選ぶ: 「局面は決まっていません」
 */
export function markHeading(item: ResolvedMark): string {
  const { resolution } = item;
  if (resolution.kind === 'manual') return UNDECIDED_TEXT;
  if (resolution.saved) return resolution.ref.label;
  return estimateHeading(resolution.ref, alternativesOf(item));
}

/**
 * 画像の大きな表示の下に出す文の、カードの 2 行目に当たる部分（区切りごと）。
 * 例: [東2局1本場, 6巡目, 打牌の迷い]・[東2局1本場, 8〜9巡目, 鳴きの迷い, 推定]・[局面は決まっていません]。取り込み前は空。
 */
export function markCaptionParts(item: ResolvedMark | null): string[] {
  if (item === null) return [];
  const { resolution } = item;
  if (resolution.kind === 'manual') return [UNDECIDED_TEXT];
  const { ref, saved } = resolution;
  if (saved) return [ref.kyokuLabel, `${ref.junme}巡目`, ref.kindLabel];
  const sameKyoku = item.autoCandidates.filter((c) => c.kyokuPosition === ref.kyokuPosition);
  return [ref.kyokuLabel, junmeSpanText(sameKyoku.map((c) => c.junme)), ref.kindLabel, ESTIMATE_TAG];
}

/**
 * スクショから読んだ値の 1 行（どの状態のカードにも出す）:
 * - 読めた: 「スクショ: 東2局・残り47・15,100点」
 * - 読めなかった: 「スクショを読めませんでした」
 * 読めても、この半荘に合う局が無い・その局に判断が無いときは、理由を足す。
 */
export function readingLine(item: ResolvedMark): string {
  if (item.reading === null) return UNREADABLE_TEXT;
  const text = `スクショ: ${centerText(item.reading)}`;
  if (item.resolution.kind === 'linked') return text;
  if (item.autoReason === 'no-kyoku') return `${text} · この半荘に合う局がありません`;
  if (item.autoReason === 'no-decision') return `${text} · その局に自分の判断がありません`;
  return text;
}

/** 同じ値が 2 つ以上あるか。 */
function hasDuplicates(values: readonly string[]): boolean {
  return new Set(values).size !== values.length;
}

/**
 * 候補の札の文字: 実戦の行動（「打8p」「鳴かない判断」など）。
 * 候補が違う巡目にまたがるときは、すべての札に巡目を足す（「12巡目 打9m」）。違う局にまたがる（本場違いで点数が同じ）ときは、
 * 局の名前も足す。それでも同じ文字が重なるときは、局の中の何番目かを足す。
 * 推定のカードでは、1 位とほかの候補をまとめて呼び（巡目をそろえるため）、ほかの候補の札だけを使う。
 */
export function chipLabels(candidates: readonly DecisionRef[]): string[] {
  const first = candidates[0];
  if (first === undefined) return [];
  const manyKyokus = !candidates.every((c) => c.kyokuPosition === first.kyokuPosition);
  const manyTurns = !candidates.every((c) => c.junme === first.junme);
  const labels = candidates.map((c) => {
    const turn = manyKyokus || manyTurns ? `${c.junme}巡目 ` : '';
    const kyoku = manyKyokus ? `${c.kyokuLabel} ` : '';
    return `${kyoku}${turn}${c.actionLabel}`;
  });
  if (!hasDuplicates(labels)) return labels;
  return candidates.map((c, i) => `${labels[i]}（${c.entryIndex + 1}番目）`);
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
