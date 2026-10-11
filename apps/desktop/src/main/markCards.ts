/**
 * 迷いマークのカード（F9）に出す、結びつけの状態と文言を決める。画面にも Tauri にも依存しない（試験しやすいように分けてある）。
 *
 * 迷いと評価は、押した時刻の順に 1 本に並べて、まとめて局に当てはめる（`linkTimeline`。E-29）。崩れて読めなかった部分は、前後の評価・迷いの
 * 局から決める。迷いマークごとに、次の順で決める（保存した選びは、自動の結果より先）:
 * 1. 保存した結びつけ（`links.marks`）が判断の鍵で、この結果に有る判断を指すなら、その判断（`findDecisionRef`）。利用者が選んだもの
 *    （`saved: true`）なので、「推定」の印は付けない。この選びは、ほかの迷いと評価の局を決める手がかりにもなる
 * 2. 保存した値が `"manual"`（局面を手で選ぶ）なら、手で選ぶ
 * 3. 保存した値が無い（または、この結果に無い判断の鍵）なら、自動の結果: 残り枚数が読めたものは、局の幅の中で 1 位の判断を推定として
 *    結びつける（`saved: false`。近い判断は、ほかの候補）。残り枚数が読めず、局だけ分かったものは、局の幅の中の判断から選んでもらう
 *    （`kind: 'kyoku'`。E-30、U-24）。前後の評価・迷いからも何も分からないものは、手で選ぶ
 *
 * どの状態のカードも、同じ構成の文言にする（U-13）: 1 行目「迷いN」と時刻（カードの部品が出す）、2 行目の局面（`markHeading`）、
 * スクショから読んだ値の静かな 1 行（`readingLine`。読めなかった部分は「読めず」）、局をどう決めたかの 1 文（`howText`。
 * 読み取りが崩れていたもの・前後の時刻から決めたものだけ）、その下に状態ごとの欄（推定の印・自分がした行動・ほかの候補・選び直す・手で選ぶ）。
 *
 * 利用者が選んだ判断が、推定にもほかの候補にも入らないとき（`far`。E-27）は、「自分：…」の下に、その旨の 1 行（`farLine`）と、
 * 推定・ほかの候補の札（推定には「（推定）」を足す。`farChipLabels`）を出す。
 *
 * AI の候補・確率・順位は、ここにも出てこない（SPEC F3、U-1）。出すのは、判断の呼び名と、自分が実際にした行動だけ。
 */
import {
  findDecisionRef,
  isFarFromReading,
  kyokuLabel,
  kyokuNumber,
  linkTimeline,
  type DecisionRef,
  type MarkCandidate,
  type MarkManualReason,
  type MortalReport,
  type PartialCenterText,
  type TimelineMarkLink,
  type TimelineNeighbour,
} from '@jantama/engine';

import type { SessionRecord } from '../api/types';
import { formatClock, partialCenterText, partialKyokuText } from './format';
import { markReadings, ratingReadings, type MarkReading } from './importFlow';

/** 迷いマークの結びつけの値のうち、「局面を手で選ぶ」という印（Rust 側の `LINK_MANUAL` と同じ）。 */
export const LINK_MANUAL = 'manual';

/** 推定で結びつけたことを示す印の文字。 */
export const ESTIMATE_TAG = '推定';
/** 「離れている」ときの札で、推定の札の文字のあとに足す印（E-27）。 */
export const ESTIMATE_SUFFIX = '（推定）';
/** 局面が決まっていない（手で選ぶ）カードの 2 行目。 */
export const UNDECIDED_TEXT = '局面は決まっていません';
/** 局だけ分かった（巡目が決まっていない）カードの 2 行目の、局の名前のあとの言葉。 */
export const UNDECIDED_JUNME_TEXT = '巡目は決まっていません';
/** スクショから中央の文字を読めなかったときの 1 行。 */
export const UNREADABLE_TEXT = 'スクショを読めませんでした';

/** 迷いマーク 1 つの、いまの結びつけ。 */
export type MarkResolution =
  /**
   * 判断が決まっている。`saved` が true は、利用者が選んで保存したもの。false は、自動で 1 位を推定として結びつけたもの
   * （「推定」の印と、ほかの候補を出す）。
   */
  | { kind: 'linked'; ref: DecisionRef; saved: boolean }
  /**
   * 局だけ分かった（残り枚数が読めない・読めない。E-30）。巡目は決まらないので、局の幅の中の判断から選んでもらう
   * （選び肢は `timeline.choices`）。判断を選ぶまでは、判断が決まっていない迷いとして数える（問題にも入らない）。
   */
  | { kind: 'kyoku' }
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
  /** スクショから読めた部分（崩れて、読めなかった部分は null）。点数も読めなければ null。 */
  reading: PartialCenterText | null;
  /** 自動で決まらなかった理由（読めたものは null）。 */
  autoReason: MarkManualReason | null;
  /** 保存した結びつけの値（無ければ undefined）。取り消すときに、この値へ戻す。 */
  stored: string | undefined;
  /**
   * 利用者が選んだ判断が、スクショから読んだ値から離れているか（E-27）。推定にも、ほかの候補にも入らない判断を選んでいるときだけ true。
   * 推定のまま（選んでいない）・読めない・手で選ぶと決めた迷いは、false。
   */
  far: boolean;
  /** 時間の並びでの当てはめの結果（局・局の幅・どう決めたか・選び肢）。当てはめていなければ null。 */
  timeline: TimelineMarkLink<MarkReading> | null;
  /**
   * 局をどう決めたかの 1 文（U-24）。読み取りが崩れていて、読めた部分と点数から決めたもの・前後の評価や迷いの時刻から決めたものだけ。
   * 利用者が選んだもの・すべて読めた読み取りで決まったもの・手で選ぶものは null。
   */
  howText: string | null;
}

/** 局の名前の並び（重ならない。局の順）。 */
function uniqueLabels(refs: readonly DecisionRef[]): string[] {
  return [...new Set(refs.map((ref) => ref.kyokuLabel))];
}

/** 局の名前が 1 つなら「東4局です」、複数なら「東4局から東4局1本場までのどれかです」。 */
function whereText(labels: readonly string[]): string {
  const first = labels[0] ?? '';
  const last = labels[labels.length - 1] ?? '';
  return labels.length <= 1 ? `${first}です` : `${first}から${last}までのどれかです`;
}

/** 局の幅を決めた前後の出来事の言い方: 「東3局1本場の評価（15:41:44）」「東4局の迷い9（15:42:52）」。 */
function neighbourText(report: MortalReport, neighbour: TimelineNeighbour): string {
  const kyoku = report.review.kyokus[neighbour.kyokuPosition];
  const label = kyoku === undefined ? '' : kyokuLabel(kyoku.kyoku, kyoku.honba);
  const time = formatClock(neighbour.t_ms);
  return neighbour.kind === 'rating' ? `${label}の評価（${time}）` : `${label}の迷い${neighbour.index + 1}（${time}）`;
}

/**
 * 局をどう決めたかの 1 文（U-24）。`labels` は、決まった局の名前（局の幅が複数の局なら、その並び）。
 * - 局の名前の一部が読めなかったので、読めた部分と点数で決めたもの: 「局の名前の一部が読めなかったので、読めた部分と点数から、東2局です。」
 * - 前後の評価・迷いの時刻の並びで決めたもの: 「東3局1本場の評価（15:41:44）と東4局の迷い9（15:42:52）の間に押したので、東4局です。」
 * - それ以外（すべて読めた読み取りで決まったもの・利用者が選んだもの）は null
 */
function howSentence(report: MortalReport, link: TimelineMarkLink<MarkReading>, labels: readonly string[]): string | null {
  const where = whereText(labels);
  if (link.how === 'partial') {
    const reading = link.reading;
    // 局の名前（風と番号）は読めていて、残り枚数だけ読めないときは、局は読み取りのとおり。書くことが無い
    if (reading === null || (reading.wind !== null && reading.number !== null)) return null;
    return `局の名前の一部が読めなかったので、読めた部分と点数から、${where}。`;
  }
  if (link.how !== 'timeline') return null;
  const before = link.before === null ? null : neighbourText(report, link.before);
  const after = link.after === null ? null : neighbourText(report, link.after);
  if (before !== null && after !== null) return `${before}と${after}の間に押したので、${where}。`;
  if (before !== null) return `${before}のあとに押したので、${where}。`;
  if (after !== null) return `${after}より前に押したので、${where}。`;
  return null;
}

/** 迷いマークごとの、いまの結びつけ（記録の順）。 */
export function resolveMarks(
  report: MortalReport,
  session: Pick<SessionRecord, 'marks' | 'ratings' | 'ocr' | 'links'>,
): ResolvedMark[] {
  // 迷いと評価を押した時刻の順に並べて、局に当てはめる（E-29）。利用者が選んだ結びつけは、いちばん強い手がかり
  const timeline = linkTimeline(report, {
    marks: markReadings(session, session.ocr),
    ratings: ratingReadings(session, session.ocr),
  });
  return session.marks.map((mark, index): ResolvedMark => {
    const link = timeline.marks[index] ?? null;
    const estimate = link?.estimate ?? null;
    const autoCandidates = estimate === null || link === null ? [] : [estimate, ...link.alternatives];
    const stored = session.links.marks[String(mark.id)];
    const base = {
      markId: mark.id,
      number: index + 1,
      autoCandidates,
      reading: link?.reading ?? null,
      autoReason: link === null ? ('unreadable' as const) : link.reason,
      stored,
      far: false,
      timeline: link,
      howText: null as string | null,
    };

    if (stored !== undefined && stored !== LINK_MANUAL) {
      const ref = findDecisionRef(report, stored);
      if (ref !== null) {
        const far = link !== null && isFarFromReading(report, link, stored);
        return { ...base, far, resolution: { kind: 'linked', ref, saved: true } };
      }
    }
    if (stored === LINK_MANUAL) return { ...base, resolution: { kind: 'manual', reason: 'chosen' } };

    if (estimate !== null && link !== null) {
      return { ...base, howText: howSentence(report, link, [estimate.kyokuLabel]), resolution: { kind: 'linked', ref: estimate, saved: false } };
    }
    if (link !== null && link.status === 'kyoku') {
      return { ...base, howText: howSentence(report, link, uniqueLabels(link.choices)), resolution: { kind: 'kyoku' } };
    }
    return { ...base, resolution: { kind: 'manual', reason: link?.reason ?? 'unreadable' } };
  });
}

/** 推定として結びつけてあるか（利用者が選んだものではないか）。 */
export function isEstimated(item: ResolvedMark): boolean {
  return item.resolution.kind === 'linked' && !item.resolution.saved;
}

/** 局だけ分かった迷い（局の幅の中の判断から、選んでもらう。E-30）か。 */
export function isKyokuOnly(item: ResolvedMark): boolean {
  return item.resolution.kind === 'kyoku';
}

/** 推定のとき、ほかの候補（1 位の推定は含まない）。 */
export function alternativesOf(item: ResolvedMark): MarkCandidate[] {
  const { resolution } = item;
  if (resolution.kind !== 'linked') return [];
  return item.autoCandidates.filter((candidate) => candidate.key !== resolution.ref.key);
}

/** 局だけ分かった迷いが選べる、局の幅の中の判断（半荘の順）。それ以外は空。 */
export function kyokuChoices(item: ResolvedMark): readonly DecisionRef[] {
  return item.resolution.kind === 'kyoku' ? (item.timeline?.choices ?? []) : [];
}

/** 局だけ分かった迷いの、局の名前: 1 局なら「東4局」、複数の局にまたがるなら「東4局〜東4局1本場」。 */
export function kyokuSpanText(item: ResolvedMark): string {
  const labels = uniqueLabels(kyokuChoices(item));
  const first = labels[0] ?? '';
  const last = labels[labels.length - 1] ?? '';
  return labels.length <= 1 ? first : `${first}〜${last}`;
}

/** 巡目の書き方: 1つなら「8巡目」、違う巡目にまたがるなら「8〜9巡目」。 */
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
 * - 局だけ分かったもの: 「東4局 · 巡目は決まっていません」（局の幅が複数の局なら「東4局〜東4局1本場 · …」）
 * - 手で選ぶ: 「局面は決まっていません」
 */
export function markHeading(item: ResolvedMark): string {
  const { resolution } = item;
  if (resolution.kind === 'manual') return UNDECIDED_TEXT;
  if (resolution.kind === 'kyoku') return `${kyokuSpanText(item)} · ${UNDECIDED_JUNME_TEXT}`;
  if (resolution.saved) return resolution.ref.label;
  return estimateHeading(resolution.ref, alternativesOf(item));
}

/**
 * 画像の大きな表示の下に出す文の、カードの 2 行目に当たる部分（区切りごと）。
 * 例: [東2局1本場, 6巡目, 打牌の迷い]・[東2局1本場, 8〜9巡目, 鳴きの迷い, 推定]・[東4局, 巡目は決まっていません]・[局面は決まっていません]。
 * 取り込み前は空。
 */
export function markCaptionParts(item: ResolvedMark | null): string[] {
  if (item === null) return [];
  const { resolution } = item;
  if (resolution.kind === 'manual') return [UNDECIDED_TEXT];
  if (resolution.kind === 'kyoku') return [kyokuSpanText(item), UNDECIDED_JUNME_TEXT];
  const { ref, saved } = resolution;
  if (saved) return [ref.kyokuLabel, `${ref.junme}巡目`, ref.kindLabel];
  const sameKyoku = item.autoCandidates.filter((c) => c.kyokuPosition === ref.kyokuPosition);
  return [ref.kyokuLabel, junmeSpanText(sameKyoku.map((c) => c.junme)), ref.kindLabel, ESTIMATE_TAG];
}

/**
 * スクショから読んだ値の 1 行（どの状態のカードにも出す）:
 * - 読めた: 「スクショ: 東2局・残り47・15,100点」
 * - 崩れて、一部だけ読めた: 「スクショ: 風は読めず・2局・残り50・25,000点」（読めなかった部分は「読めず」）
 * - 読めなかった: 「スクショを読めませんでした」
 * 読めても、この半荘に合う局が無い・その局に判断が無いときは、理由を足す。
 */
export function readingLine(item: ResolvedMark): string {
  if (item.reading === null) return UNREADABLE_TEXT;
  const text = `スクショ: ${partialCenterText(item.reading)}`;
  if (item.resolution.kind !== 'manual') return text;
  if (item.autoReason === 'no-kyoku') return `${text} · この半荘に合う局がありません`;
  if (item.autoReason === 'no-decision') return `${text} · その局に自分の判断がありません`;
  return text;
}

/**
 * 「離れている」ときの 1 行（E-27。カードの「自分：…」の下に、警告のアイコンと並べて出す）。離れていなければ null。
 * - 選んだ判断が、スクショから読んだ局と同じ局（本場は問わない）: 「スクショの値（残り38）と離れています。選んだ局面は残り29です。」
 * - 違う局: 「スクショの値（東3局・残り38）と離れています。選んだ局面は東2局1本場です。」
 *   局の名前が崩れていたときは、読めた部分を書く（「スクショの値（風は読めず・2局・残り50）と離れています。…」）
 */
export function farLine(item: ResolvedMark): string | null {
  const { reading, resolution } = item;
  if (!item.far || reading === null || reading.tilesLeft === null || resolution.kind !== 'linked') return null;
  const { ref } = resolution;
  const { wind, number } = reading;
  const readKyokuNumber = wind !== null && number !== null ? kyokuNumber(wind, number) : null;
  const sameKyoku =
    readKyokuNumber !== null
      ? readKyokuNumber === ref.kyoku
      : (item.timeline?.kyokuPositions.includes(ref.kyokuPosition) ?? false);
  if (sameKyoku) {
    return `スクショの値（残り${reading.tilesLeft}）と離れています。選んだ局面は残り${ref.tilesLeft}です。`;
  }
  const readKyoku = readKyokuNumber !== null ? kyokuLabel(readKyokuNumber, 0) : partialKyokuText(wind, number);
  return `スクショの値（${readKyoku}・残り${reading.tilesLeft}）と離れています。選んだ局面は${ref.kyokuLabel}です。`;
}

/**
 * 「離れている」ときの札の文字（E-27）: 自動の候補（先頭が推定）それぞれの札の文字（`chipLabels`）のうち、推定には「（推定）」を足す。
 * 例: ['9巡目 打北（推定）', '8巡目 鳴かない判断']。
 */
export function farChipLabels(candidates: readonly DecisionRef[]): string[] {
  return chipLabels(candidates).map((label, i) => (i === 0 ? `${label}${ESTIMATE_SUFFIX}` : label));
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
