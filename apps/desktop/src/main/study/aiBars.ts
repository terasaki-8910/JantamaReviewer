/**
 * AI の評価の棒（F3・F12、U-43）: 打牌の判断の候補と確率を、手牌の牌ごとの縦の棒にする。
 * 画面（Hand.tsx）に依存しない純粋な関数。呼ぶ側は、棒を出してよい場面（答え合わせのあと・通して見る画面の自分の打牌の手番）でだけ呼ぶ（U-1）。
 *
 * - 棒は手牌の牌ごとに 1 本（鳴く牌には無い）。確率は、その牌の候補（赤五と普通の五は別の候補。右の欄の一覧と同じ牌の合わせ方）から。候補に無い牌は 0
 * - 棒の高さは 40px × 確率（四捨五入。0 より大きければ 2px 以上、0 なら棒なし）
 * - 数字は、確率の上位 3 つ（0.5% 以上）・自分の答えの牌・実戦の牌。同じ牌が手牌に何枚かあるときは、いちばん左の 1 枚だけ
 * - 読み上げ用に、牌と確率を確率の高い順に並べた文（「打5p 97.7%」）も作る
 */
import { discardCandidates, tileLabel, type ReportEntry, type Tile } from '@jantama/engine';

import type { HandItem } from './Hand';

/** 棒の高さの上限（確率 100% のとき。px）。 */
export const BAR_MAX_PX = 40;
/** 確率が 0 より大きいときの、棒の高さの下限（px）。 */
export const BAR_MIN_PX = 2;
/** 確率の上位に数字を出す、牌の数。 */
export const LABELED_TOP_COUNT = 3;
/** 上位でも、確率がこれより低い牌には数字を出さない（0.5%）。 */
export const LABEL_MIN_PROBABILITY = 0.005;

/** 棒 1 本（手牌の 1 枚の上）。 */
export interface HandBar {
  /** AI がこの牌に付けた確率（0〜1）。 */
  probability: number;
  /** 棒の高さ（px）。確率が 0 なら 0（棒を描かない）。 */
  height: number;
  /** AI の 1 位の牌か（強い色で描く）。 */
  top: boolean;
  /** 棒の上の数字（例: 97.7%）。数字を出さない棒は null。 */
  label: string | null;
}

export interface HandBars {
  /** 手牌の位置（`HandItem.index`）→ 棒。鳴く牌には無い。 */
  bars: ReadonlyMap<number, HandBar>;
  /** 読み上げ用の文（確率の高い順。例: 打5p 97.7%）。 */
  spoken: readonly string[];
}

/** 棒の高さ（px）。確率 0 は 0、0 より大きければ 40px × 確率（四捨五入）を 2px 以上で。 */
export function barHeight(probability: number): number {
  if (!(probability > 0)) return 0;
  return Math.max(BAR_MIN_PX, Math.round(BAR_MAX_PX * Math.min(probability, 1)));
}

/** 棒の上の数字: 小数 1 桁と %（97.7%）。0.1% 未満は <0.1%。 */
export function formatBarProbability(probability: number): string {
  const percent = probability * 100;
  return percent < 0.1 ? '<0.1%' : `${percent.toFixed(1)}%`;
}

/**
 * 手牌の棒を作る。`items` は手牌の並び（左から、手牌・ツモ牌・鳴く牌）、`entry` は判断の記録、`mine` は自分の答えの牌
 * （答えが無い、通して見る画面では null）。
 */
export function handBars(items: readonly HandItem[], entry: Pick<ReportEntry, 'details' | 'actual'>, mine: Tile | null): HandBars {
  const candidates = discardCandidates(entry);
  const probabilityOf = new Map<Tile, number>(candidates.map((candidate) => [candidate.tile, candidate.probability]));
  // 確率の高い順（同じ確率は、結果 JSON の並びのまま）
  const ranked = [...candidates].sort((a, b) => b.probability - a.probability);

  // 数字を出す牌（赤五と普通の五は別の牌）
  const labelTiles = new Set<Tile>(
    ranked
      .filter((candidate) => candidate.probability >= LABEL_MIN_PROBABILITY)
      .slice(0, LABELED_TOP_COUNT)
      .map((candidate) => candidate.tile),
  );
  if (mine !== null) labelTiles.add(mine);
  if (entry.actual.type === 'dahai') labelTiles.add(entry.actual.pai);

  const topAction = entry.details[0]?.action;
  const topTile = topAction?.type === 'dahai' ? topAction.pai : null;

  const labeled = new Set<Tile>();
  const bars = new Map<number, HandBar>();
  for (const item of items) {
    if (item.called) continue;
    const probability = Math.min(Math.max(probabilityOf.get(item.tile) ?? 0, 0), 1);
    // 同じ牌は、いちばん左の 1 枚だけに数字を出す
    const showLabel = labelTiles.has(item.tile) && !labeled.has(item.tile);
    if (showLabel) labeled.add(item.tile);
    bars.set(item.index, {
      probability,
      height: barHeight(probability),
      top: topTile !== null && item.tile === topTile,
      label: showLabel ? formatBarProbability(probability) : null,
    });
  }

  const spoken = ranked.map((candidate) => `打${tileLabel(candidate.tile)} ${formatBarProbability(candidate.probability)}`);
  return { bars, spoken };
}
