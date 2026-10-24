/**
 * AI との比べの 1 行（F18、U-48）。半荘のページの見出しの、題の下の 1 行: 「AI 一致率 72.3% · 類似度 93.0 · 悪手率 6.2%」と、
 * 3 つの意味を書いた説明のアイコン（InfoTip。R11-1）。数えるのはエンジンの `aiMetricsOf`（呼ぶ側が、取り込んだ結果から数えて渡す）。
 * 名前のある一覧（ul）にして、読み上げでは「AI 一致率 72.3%」のように 1 項目ずつ聞こえる（区切りの「·」は読み上げない）。
 * 見た目は styles/sessions.css の `.head-metrics`（色はトークンだけ。ラベルは静かな色、値は文字の色で等幅の数字）。
 * 値が無い（判断が 0 の）ときは、何も出さない。
 */
import { formatRatePercent, formatSimilarity, type AiMetrics } from '@jantama/engine';

import { InfoTip } from './InfoTip';

/** 3 つの意味の説明（InfoTip の文）。`thresholdPercent` は設定の「大きな不一致の基準」（%）、数は半荘のもの。 */
export function aiMetricsHint(metrics: AiMetrics, thresholdPercent: number): string {
  return `AI（Mortal）と比べた数です。AI 一致率は、自分の判断のうち、AI の1位と同じだった割合（${metrics.matches}/${metrics.decisions}）。類似度は、Mortal の Rating と同じ値で、AI の1位なら満点、違えば AI の評価に応じた部分点です（NAGA の類似度に当たります）。悪手率は、実戦の行動の AI の確率が ${thresholdPercent}% より低かった判断の割合（${metrics.badMoves}/${metrics.decisions}）で、大きな不一致と同じ基準です（NAGA の悪手と同じ線）。`;
}

interface AiMetricsLineProps {
  metrics: AiMetrics;
  /** 大きな不一致の基準（確率。設定の「大きな不一致の基準」）。説明の文には、% にして書く。 */
  threshold: number;
}

export function AiMetricsLine({ metrics, threshold }: AiMetricsLineProps) {
  const { matchRate, similarity, badMoveRate } = metrics;
  if (matchRate === null || similarity === null || badMoveRate === null) return null;
  const items = [
    { label: 'AI 一致率', value: formatRatePercent(matchRate) },
    { label: '類似度', value: formatSimilarity(similarity) },
    { label: '悪手率', value: formatRatePercent(badMoveRate) },
  ];
  return (
    <div className="head-metrics">
      <ul className="metric-list" aria-label="AI との比べ">
        {items.map((item, index) => (
          <li key={item.label}>
            <span className="metric-lbl">{item.label}</span> <span className="metric-val mono">{item.value}</span>
            {index < items.length - 1 && (
              <span className="metric-sep" aria-hidden="true">
                {' · '}
              </span>
            )}
          </li>
        ))}
      </ul>
      <InfoTip label="AI 一致率・類似度・悪手率の説明">{aiMetricsHint(metrics, Math.round(threshold * 100))}</InfoTip>
    </div>
  );
}
