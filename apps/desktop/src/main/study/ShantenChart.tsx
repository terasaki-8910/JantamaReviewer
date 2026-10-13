/**
 * 向聴数の折れ線（F14、R16-7 の A。局の評価の表の行を開いたときの、自分の向聴数の推移（提案 7・U-36）も、同じ部品を使う）。
 *
 * 横軸は、その人が切った枚数（0 は配牌）、縦軸は向聴数（上が聴牌（0 向聴）、下へ 1・2・3…）。階段の線で、切るたびの向聴数（切ったあとの手）を結ぶ。
 * 聴牌になった打牌の点は、三角（▲。色だけに頼らない）、ほかの点は丸。
 * 図は、1 つの止まり場所（Tab）。矢印キー（← →・Home・End）で点を選ぶと、吹き出し（値が先、名前があと。週の集計の図と同じ `ChartTip`）が出る。
 * マウスを乗せても同じ（いちばん近い点）。吹き出しの数字は、読み上げ用の説明（`aria-describedby`）にも、まとめて書く。
 * 色は styles/open-hands.css のトークンだけ。吹き出しは week/ChartTip.tsx（`ChartTipProvider` の中で使う）。
 */
import { useCallback, useId, useMemo, useRef, useState, type KeyboardEvent } from 'react';

import { useChartTip } from '../week/ChartTip';

/** 折れ線の 1 点。 */
export interface ShantenPoint {
  /** 横軸の値（切った枚数。0 は配牌）。 */
  n: number;
  /** 向聴数（0 が聴牌）。 */
  shanten: number;
  /** 吹き出しの値（例: 聴牌・2向聴）。 */
  value: string;
  /** 吹き出しの名前（例: 7枚目 打西（手出し））。 */
  name: string;
  /** 聴牌になった打牌の点か（三角で描く）。 */
  mark?: boolean;
}

interface ShantenChartProps {
  /** 図の名前（読み上げ用）。例: 対面の向聴数の推移。 */
  label: string;
  /** 点（n の昇順）。 */
  points: readonly ShantenPoint[];
  /** 左上の軸の名前（既定: 向聴数）。 */
  yTitle?: string;
  /** 右上の軸の名前（既定: 横軸: その人が切った枚数）。 */
  xTitle?: string;
}

const W = 300;
const H = 94;
const L = 30;
const R = 10;
const T = 24;
const B = 18;

export function ShantenChart({ label, points, yTitle = '向聴数', xTitle = '横軸: その人が切った枚数' }: ShantenChartProps) {
  const tip = useChartTip();
  const descId = useId();
  const svgRef = useRef<SVGSVGElement>(null);
  const [active, setActive] = useState<number | null>(null);
  const index = useRef(Math.max(0, points.length - 1));
  const count = points.length;

  const maxN = Math.max(6, ...points.map((p) => p.n));
  const maxS = Math.max(3, ...points.map((p) => p.shanten));
  const { x, y } = useMemo(
    () => ({
      x: (n: number) => L + (n / maxN) * (W - L - R),
      y: (s: number) => T + (s / maxS) * (H - T - B),
    }),
    [maxN, maxS],
  );

  const first = points[0];
  let line = first === undefined ? '' : `M ${x(first.n)} ${y(first.shanten)}`;
  for (let i = 1; i < count; i++) {
    const p = points[i] as ShantenPoint;
    line += ` H ${x(p.n)} V ${y(p.shanten)}`;
  }

  const show = useCallback(
    (at: number, fromKeyboard: boolean) => {
      const next = Math.max(0, Math.min(count - 1, at));
      index.current = next;
      setActive(next);
      const svg = svgRef.current;
      const p = points[next];
      if (svg === null || p === undefined) return;
      const rect = svg.getBoundingClientRect();
      tip.show(p.value, p.name, rect.left + (rect.width * x(p.n)) / W, rect.top + (rect.height * y(p.shanten)) / H, fromKeyboard);
    },
    [count, points, tip, x, y],
  );
  const off = useCallback(() => {
    setActive(null);
    tip.hide();
  }, [tip]);

  const onKeyDown = (event: KeyboardEvent<HTMLDivElement>) => {
    if (event.altKey || event.ctrlKey || event.metaKey || event.shiftKey) return;
    const key = event.key;
    if (key === 'ArrowRight') show(index.current + 1, true);
    else if (key === 'ArrowLeft') show(index.current - 1, true);
    else if (key === 'Home') show(0, true);
    else if (key === 'End') show(count - 1, true);
    else if (key === 'Escape') {
      off();
      return;
    } else return;
    // ← → と Home・End は、半荘を通して見る画面のキー（前・次の判断、局の頭・終わり）にも割り当てられている。図に位置があるときは、ここで受ける
    event.preventDefault();
    event.stopPropagation();
  };

  const summary = points.map((p) => `${p.name}: ${p.value}`).join('、');
  return (
    <div className="shchart">
      {/* eslint-disable-next-line jsx-a11y/no-noninteractive-element-interactions -- 図は、1 つの止まり場所。矢印キーで点を選ぶ（吹き出しは、マウスと同じ） */}
      <div
        className="shchart-plot"
        // eslint-disable-next-line jsx-a11y/no-noninteractive-tabindex -- 図の 1 つの止まり場所（矢印キーで点を選ぶ）
        tabIndex={0}
        role="group"
        aria-label={`${label}（矢印キーで点を選ぶ）`}
        aria-describedby={descId}
        onFocus={() => show(index.current, true)}
        onBlur={off}
        onKeyDown={onKeyDown}
        onPointerMove={(event) => {
          const svg = svgRef.current;
          if (svg === null || count === 0) return;
          const rect = svg.getBoundingClientRect();
          const px = ((event.clientX - rect.left) / rect.width) * W;
          let best = 0;
          let gap = Number.POSITIVE_INFINITY;
          points.forEach((p, i) => {
            const d = Math.abs(x(p.n) - px);
            if (d < gap) {
              gap = d;
              best = i;
            }
          });
          show(best, false);
        }}
        onPointerLeave={off}
      >
        <svg ref={svgRef} className="shchart-svg" viewBox={`0 0 ${W} ${H}`} aria-hidden="true" focusable="false">
          {Array.from({ length: maxS + 1 }, (_, s) => (
            <g key={s}>
              <line className={s === 0 ? 'g g0' : 'g'} x1={L} x2={W - R} y1={y(s)} y2={y(s)} />
              <text x={L - 6} y={y(s) + 3.5} textAnchor="end">
                {s === 0 ? '聴牌' : s}
              </text>
            </g>
          ))}
          {Array.from({ length: Math.floor(maxN / 2) + 1 }, (_, k) => k * 2).map((n) => (
            <text key={n} x={x(n)} y={H - 4} textAnchor="middle">
              {n === 0 ? '配牌' : n}
            </text>
          ))}
          <text className="ax" x={0} y={8} textAnchor="start">
            {yTitle}
          </text>
          <text className="ax" x={W - R} y={8} textAnchor="end">
            {xTitle}
          </text>
          <path className="ln" d={line} />
          {points.map((p, i) =>
            p.mark === true ? (
              <path key={p.n} className="tpm" d={`M ${x(p.n)} ${y(p.shanten) - 6.5} L ${x(p.n) + 6} ${y(p.shanten) + 4} L ${x(p.n) - 6} ${y(p.shanten) + 4} Z`} />
            ) : (
              <circle key={p.n} className="nd" cx={x(p.n)} cy={y(p.shanten)} r={i === active ? 3.6 : 2.4} />
            ),
          )}
          {active !== null && points[active] !== undefined && (
            <circle className="cur" cx={x((points[active] as ShantenPoint).n)} cy={y((points[active] as ShantenPoint).shanten)} r={6} />
          )}
        </svg>
      </div>
      <p className="sr-only" id={descId}>
        {summary}
      </p>
    </div>
  );
}
