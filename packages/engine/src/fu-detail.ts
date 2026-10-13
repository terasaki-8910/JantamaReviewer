/**
 * 符の内訳（F14、E-38。R15-3 の 8「符の内訳」）。Python の mahjong（MIT。MahjongRepository/mahjong 2.0.0）の
 * `FuCalculator.calculate_fu` の数え方（`fu_details`）を、エンジンの和了形の分解に移したもの（実行時に Python は使わない）。
 *
 * 内訳の項目（`FuReason`）は mahjong の `reason` と同じ名前:
 *   base（副底 20、門前ロンは 30）・penchan・kanchan・valued_pair・double_valued_pair・pair_wait・tsumo・hand_without_fu・
 *   closed_pon・open_pon・closed_terminal_pon・open_terminal_pon・closed_kan・open_kan・closed_terminal_kan・open_terminal_kan。七対子は base の 25。
 * どの分解・和了牌の入り方を数えるかは、`evaluateWinChosen`（飜数、同じなら符の高い解釈。HandCalculator と同じ選び方）が決める。
 * 正しさは、mahjong の `fu_details` の正解表（packages/engine/tests/fixtures/win-value-oracle.json。約 2,500 件）と全部照らす。
 *
 * 画面に出す言い方（`fuBreakdownOf`）: 門前ロンの 30 は「副底 20」と「門前ロン 10」に分ける（承認済みの見本）。
 */
import { type Block, type ChosenWin, type HitContext, type WinInput, type WinInterpretation, evaluateWinChosen, isTerminalOrHonorKind } from './yaku';

export type FuReason =
  | 'base'
  | 'penchan'
  | 'kanchan'
  | 'valued_pair'
  | 'double_valued_pair'
  | 'pair_wait'
  | 'tsumo'
  | 'hand_without_fu'
  | 'closed_pon'
  | 'open_pon'
  | 'closed_terminal_pon'
  | 'open_terminal_pon'
  | 'closed_kan'
  | 'open_kan'
  | 'closed_terminal_kan'
  | 'open_terminal_kan';

/** 符の項目 1 つ。`ron` は、ロンで完成したために明刻として数えた暗刻（暗刻の半分の符）。 */
export interface FuItem {
  reason: FuReason;
  fu: number;
  ron?: boolean;
}

/** 分解 1 つの符の内訳。`total` は 10 符単位に切り上げる前の合計、`rounded` は切り上げた符。 */
export interface FuDetail {
  items: FuItem[];
  total: number;
  rounded: number;
}

/** [幺九牌か][槓か][明か] → [符, 理由]。mahjong の `_PON_KAN_FU_TABLE` と同じ。 */
const PON_KAN_TABLE: readonly (readonly (readonly (readonly [number, FuReason])[])[])[] = [
  [
    [
      [4, 'closed_pon'],
      [2, 'open_pon'],
    ],
    [
      [16, 'closed_kan'],
      [8, 'open_kan'],
    ],
  ],
  [
    [
      [8, 'closed_terminal_pon'],
      [4, 'open_terminal_pon'],
    ],
    [
      [32, 'closed_terminal_kan'],
      [16, 'open_terminal_kan'],
    ],
  ],
];

/**
 * 分解 1 つ（と和了牌の入り方）の符の内訳。mahjong の `calculate_fu` と同じ順に項目を並べる
 * （待ち → 役牌の雀頭 → 単騎 → 刻子・槓子 → ツモ → 副露した平和形 → 副底）。七対子（塊が 7 つ）は 25 符。
 */
export function fuDetailOfDecomposition(blocks: readonly Block[], ctx: HitContext, interp: WinInterpretation | null): FuDetail {
  if (blocks.length === 7) return { items: [{ reason: 'base', fu: 25 }], total: 25, rounded: 25 };
  if (interp === null) throw new RangeError('符の内訳には、和了牌の入り方が要ります');
  const items: FuItem[] = [];
  let total = 0;
  const add = (reason: FuReason, fu: number, ron = false) => {
    items.push(ron ? { reason, fu, ron } : { reason, fu });
    total += fu;
  };
  const open = blocks.some((b) => b.open);
  const win = blocks[interp.index];
  if (win !== undefined && win.type === 'seq' && !win.meld) {
    const start = win.kind % 9;
    if ((start === 0 && interp.position === 2) || (start === 6 && interp.position === 0)) add('penchan', 2);
    if (interp.position === 1) add('kanchan', 2);
  }
  const pair = blocks.find((b) => b.type === 'pair');
  if (pair !== undefined) {
    const valued = [31, 32, 33, ctx.seatKind, ctx.roundKind].filter((k) => k === pair.kind).length;
    if (valued === 1) add('valued_pair', 2);
    else if (valued >= 2) add('double_valued_pair', 4);
  }
  if (win !== undefined && win.type === 'pair') add('pair_wait', 2);
  for (const [index, b] of blocks.entries()) {
    if (b.type !== 'tri' && b.type !== 'kan') continue;
    // ロンで、暗刻になるはずの刻子を完成させたときは、明刻として数える
    const ron = !ctx.tsumo && !b.meld && interp.index === index;
    const isOpen = b.open || ron;
    const [fu, reason] = PON_KAN_TABLE[isTerminalOrHonorKind(b.kind) ? 1 : 0]?.[b.type === 'kan' ? 1 : 0]?.[isOpen ? 1 : 0] as readonly [number, FuReason];
    add(reason, fu, ron && !b.open);
  }
  if (ctx.tsumo && total > 0) add('tsumo', 2);
  if (open && total === 0) add('hand_without_fu', 2);
  add('base', open || ctx.tsumo ? 20 : 30);
  return { items, total, rounded: Math.ceil(total / 10) * 10 };
}

/** 和了の入力の、符の内訳（選ばれた解釈のもの）。和了形でない・国士無双は null。 */
export function fuDetailOf(input: WinInput): FuDetail | null {
  const { chosen } = evaluateWinChosen(input);
  return chosen === null ? null : fuDetailOfChosen(chosen);
}

function fuDetailOfChosen(chosen: ChosenWin): FuDetail {
  return fuDetailOfDecomposition(chosen.blocks, chosen.ctx, chosen.interp);
}

// ---- 画面に出す言い方 ----

const LABELS: Readonly<Record<FuReason, string>> = {
  base: '副底',
  penchan: '辺張待ち',
  kanchan: '嵌張待ち',
  valued_pair: '役牌の雀頭',
  double_valued_pair: '連風牌の雀頭',
  pair_wait: '単騎待ち',
  tsumo: 'ツモ',
  hand_without_fu: '副露した平和形',
  closed_pon: '暗刻（中張牌）',
  open_pon: '明刻（中張牌）',
  closed_terminal_pon: '暗刻（幺九牌）',
  open_terminal_pon: '明刻（幺九牌）',
  closed_kan: '暗槓（中張牌）',
  open_kan: '明槓（中張牌）',
  closed_terminal_kan: '暗槓（幺九牌）',
  open_terminal_kan: '明槓（幺九牌）',
};

/** 画面に出す順: 副底・門前ロン → 面子（暗刻・明刻・槓子）→ 雀頭 → 待ち → ツモ。 */
const ORDER: readonly FuReason[] = [
  'base',
  'closed_pon',
  'open_pon',
  'closed_terminal_pon',
  'open_terminal_pon',
  'closed_kan',
  'open_kan',
  'closed_terminal_kan',
  'open_terminal_kan',
  'valued_pair',
  'double_valued_pair',
  'hand_without_fu',
  'pair_wait',
  'kanchan',
  'penchan',
  'tsumo',
];

export const FU_NOTE_RON_PON = 'ロンで完成した刻子は、明刻として数える（暗刻の半分の符）';
export const FU_NOTE_CHIITOITSU = '七対子は符が 25 で決まっていて、ほかの符は付かない';
export const FU_NOTE_PINFU_TSUMO = '門前の平和のツモは、ツモの 2 符が付かず 20 符';

/** 画面の符の内訳（項目の名前と符、合計、切り上げた符、注）。 */
export interface FuBreakdown {
  items: Array<{ label: string; fu: number }>;
  /** 10 符単位に切り上げる前の合計。 */
  total: number;
  /** 切り上げた符（画面の「40符」）。 */
  rounded: number;
  note: string | null;
}

/** 符の内訳を、画面に出す言い方にする。 */
export function fuBreakdownOfDetail(detail: FuDetail, input: { tsumo: boolean; closed: boolean }): FuBreakdown {
  const sorted = [...detail.items].sort((a, b) => ORDER.indexOf(a.reason) - ORDER.indexOf(b.reason));
  const items: FuBreakdown['items'] = [];
  let note: string | null = null;
  for (const d of sorted) {
    if (d.reason === 'base') {
      if (d.fu === 25) {
        items.push({ label: '七対子（25符で固定）', fu: 25 });
        note = FU_NOTE_CHIITOITSU;
      } else if (d.fu === 30) {
        items.push({ label: '副底', fu: 20 });
        items.push({ label: '門前ロン', fu: 10 });
      } else {
        items.push({ label: '副底', fu: 20 });
      }
      continue;
    }
    const label = LABELS[d.reason];
    items.push({ label: d.ron === true ? label.replace(/）$/, '・ロンで完成）') : label, fu: d.fu });
  }
  if (detail.items.some((d) => d.ron === true)) note = FU_NOTE_RON_PON;
  if (note === null && input.tsumo && input.closed && detail.items.length === 1) note = FU_NOTE_PINFU_TSUMO;
  return { items, total: detail.total, rounded: detail.rounded, note };
}

/** 和了の入力の、画面の符の内訳。和了形でない・国士無双は null。 */
export function fuBreakdownOf(input: WinInput): FuBreakdown | null {
  const detail = fuDetailOf(input);
  if (detail === null) return null;
  return fuBreakdownOfDetail(detail, { tsumo: input.tsumo, closed: input.melds.every((m) => !m.open) });
}
