/**
 * 局の評価の表の「迷い」の列（R11-9、U-27）に並べる札を決める。画面にも Tauri にも依存しない（試験しやすいように分けてある）。
 *
 * 迷いマークごとの結びつけ（`resolveMarks`。迷いのカードと同じもの）から、局ごとに札を作る:
 * - 利用者が選んだ（`linked`・`saved`）: 「迷い1 5巡目 打6s」。札の形は、チェックつき（accent の淡い塗り）
 * - 推定（`linked`・保存していない）: 同じ文字。札の形は、枠だけ
 * - 局だけ分かった（巡目が決まっていない。`kyoku`）: 「迷い3 巡目は未定」。札の形は、点線。局の幅が複数の局なら、先頭の局に出す
 * - 局面を手で選ぶ（局が分からない。`manual`）: 表には出さない（どの局にも当てはまらない）
 *
 * 札は、色だけで見分けなくてよいように、形（チェック・点線・枠だけ）でも違う。読み上げの名前にも、状態を入れる。
 * AI の候補・確率・順位は出てこない（SPEC F3）。出すのは、判断の呼び名（自分が実際にした行動）だけ。
 */
import { kyokuChoices, kyokuOptions, kyokuSpanText, type ResolvedMark } from './markCards';

/** 札の種類。選んだ（チェックつき）・推定（枠だけ）・巡目は未定（点線）。 */
export type ChipKind = 'chosen' | 'estimate' | 'undecided';

export interface MarkChip {
  /** 迷いマークの記録の番号（保存の鍵）。 */
  markId: number;
  /** 画面に出す番号（1 から）。 */
  number: number;
  kind: ChipKind;
  /** 札の文字の前半（太字にする）。例: 「迷い1」。 */
  head: string;
  /** 札の文字の後半。例: 「5巡目 打6s」「巡目は未定」。 */
  what: string;
  /** 札の文字。例: 「迷い1 5巡目 打6s」「迷い3 巡目は未定」。 */
  text: string;
  /** 読み上げの名前。例: 「迷い1 5巡目 打6s（推定）。カードへ移る」。 */
  label: string;
  /** 札が出る局（review.kyokus の添字）。 */
  position: number;
}

/** 状態を読み上げの名前に足す言葉。 */
const KIND_TEXT: Readonly<Record<Exclude<ChipKind, 'undecided'>, string>> = { chosen: '選んだ', estimate: '推定' };

/** 「巡目は未定」の札に出す言葉。 */
export const UNDECIDED_CHIP_TEXT = '巡目は未定';

/** 迷い 1 つの札。表に出さない迷い（局面を手で選ぶもの）は null。 */
export function markChip(item: ResolvedMark): MarkChip | null {
  const { resolution } = item;
  if (resolution.kind === 'manual') return null;
  const head = `迷い${item.number}`;
  if (resolution.kind === 'kyoku') {
    const position = kyokuOptions(kyokuChoices(item))[0]?.position;
    if (position === undefined) return null;
    // 局の幅が複数の局のとき（本場違いで点数が同じ局が続く）は、どこまでの幅かを読み上げに足す
    const span = kyokuOptions(kyokuChoices(item)).length > 1 ? `（${kyokuSpanText(item)}のどれか）` : '';
    return {
      markId: item.markId,
      number: item.number,
      kind: 'undecided',
      head,
      what: UNDECIDED_CHIP_TEXT,
      text: `${head} ${UNDECIDED_CHIP_TEXT}`,
      label: `${head} ${UNDECIDED_CHIP_TEXT}${span}。カードへ移る`,
      position,
    };
  }
  const { ref, saved } = resolution;
  const kind: ChipKind = saved ? 'chosen' : 'estimate';
  const what = `${ref.junme}巡目 ${ref.actionLabel}`;
  return {
    markId: item.markId,
    number: item.number,
    kind,
    head,
    what,
    text: `${head} ${what}`,
    label: `${head} ${what}（${KIND_TEXT[kind]}）。カードへ移る`,
    position: ref.kyokuPosition,
  };
}

/** 局ごとの札（局の添字 → 札。迷いの番号の順）。札の無い局は入らない。 */
export function chipsByKyoku(resolved: readonly ResolvedMark[]): Map<number, MarkChip[]> {
  const byKyoku = new Map<number, MarkChip[]>();
  for (const item of resolved) {
    const chip = markChip(item);
    if (chip === null) continue;
    const list = byKyoku.get(chip.position) ?? [];
    list.push(chip);
    byKyoku.set(chip.position, list);
  }
  return byKyoku;
}
