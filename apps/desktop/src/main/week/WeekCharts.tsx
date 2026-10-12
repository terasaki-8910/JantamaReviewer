/**
 * 週の集計の図の部品（U-30）。承認済みの見本（11回目の week.js）を React に移したもの。
 * - `Fig`: 図 1 つの枠。見出し・「表で見る」（押すと、同じ数の表に替わる。もう一度押すと図に戻る）・図
 * - `DataTable`: 「表で見る」の表。横にはみ出すときは、キーボードで動かせるように、止まれる場所になる
 * - `LineChart`: 小さな折れ線（週ごとの推移）。マウスを乗せる・矢印キーで週を選ぶと、同じ吹き出しが出る
 * - `useRovingTip`: 1 つの Tab の止まり場所の中を、矢印キーで項目を選ぶ（横棒・点の図）
 * 色は styles/week.css のトークンだけ。吹き出しは ChartTip.tsx。
 */
import {
  useCallback,
  useEffect,
  useRef,
  useState,
  type CSSProperties,
  type KeyboardEvent as ReactKeyboardEvent,
  type ReactNode,
} from 'react';

import { useChartTip } from './ChartTip';

// ---- 表 ----

/** 横にはみ出す表の入れ物。はみ出すときだけ、キーボードで動かせる止まれる場所（名前つきの領域）にする。 */
export function ScrollWrap({ caption, children }: { caption: string; children: ReactNode }) {
  const ref = useRef<HTMLDivElement>(null);
  const [overflowing, setOverflowing] = useState(false);
  useEffect(() => {
    const element = ref.current;
    if (element === null) return undefined;
    const check = () => setOverflowing(element.scrollWidth > element.clientWidth + 1);
    check();
    window.addEventListener('resize', check);
    const observer = typeof ResizeObserver === 'undefined' ? null : new ResizeObserver(check);
    observer?.observe(element);
    return () => {
      window.removeEventListener('resize', check);
      observer?.disconnect();
    };
  }, []);
  return (
    <div
      className="wk-tablewrap"
      ref={ref}
      tabIndex={overflowing ? 0 : undefined}
      role={overflowing ? 'region' : undefined}
      aria-label={overflowing ? `${caption}（横にスクロールできます）` : undefined}
    >
      {children}
    </div>
  );
}

/** 「表で見る」の表。`current` は、太字にする行（今週の行）。1 列目は行の見出し。 */
export function DataTable({
  caption,
  head,
  rows,
  current = -1,
}: {
  caption: string;
  head: readonly string[];
  rows: ReadonlyArray<readonly string[]>;
  current?: number;
}) {
  return (
    <ScrollWrap caption={caption}>
      <table className="wk-table">
        <caption className="sr-only">{caption}</caption>
        <thead>
          <tr>
            {head.map((h) => (
              <th scope="col" key={h}>
                {h}
              </th>
            ))}
          </tr>
        </thead>
        <tbody>
          {rows.map((row, i) => (
            <tr key={row[0]} className={i === current ? 'cur' : undefined}>
              <th scope="row">{row[0]}</th>
              {row.slice(1).map((cell, j) => (
                // 列の見出しと並びが決まっている表なので、列の位置を鍵にする
                <td key={j}>{cell}</td>
              ))}
            </tr>
          ))}
        </tbody>
      </table>
    </ScrollWrap>
  );
}

/**
 * 図 1 つの枠。`chart` は図、`table` は「表で見る」の表。見ている方だけを描く。
 * `chart` は、見ている方（'chart' か 'table'）を受け取る関数でもよい。`keepChart` を渡すと、表を見ている間も `chart` を描き続ける
 * （成績の入力欄は、表の間も残し、小さな線だけを外す。そのため、関数で見ている方を受け取る）。
 */
export function Fig({
  id,
  title,
  sub,
  chart,
  table,
  className,
  keepChart = false,
}: {
  id: string;
  title: string;
  sub?: string;
  chart: ReactNode | ((view: 'chart' | 'table') => ReactNode);
  table: ReactNode;
  className?: string;
  keepChart?: boolean;
}) {
  const [view, setView] = useState<'chart' | 'table'>('chart');
  const tip = useChartTip();
  return (
    <figure className={className === undefined ? 'wk-fig' : `wk-fig ${className}`} data-view={view} data-fig={id}>
      <div className="wk-figh">
        <figcaption className="wk-cap">
          {title}
          {sub !== undefined && <span className="quiet">{sub}</span>}
        </figcaption>
        <button
          type="button"
          className="link-btn wk-tv"
          aria-pressed={view === 'table'}
          onClick={() => {
            tip.hide();
            setView((v) => (v === 'chart' ? 'table' : 'chart'));
          }}
        >
          {view === 'table' ? 'グラフで見る' : '表で見る'}
        </button>
      </div>
      {(view === 'chart' || keepChart) && (
        <div className="wk-chart">{typeof chart === 'function' ? chart(view) : chart}</div>
      )}
      {view === 'table' && table}
    </figure>
  );
}

// ---- 矢印キーで項目を選ぶ ----

/**
 * 1 つの Tab の止まり場所の中で、矢印キー（↑ ↓ ← →・Home・End）で項目を選ぶ。選ぶと `onActivate` が呼ばれる（吹き出しを出す）。
 * 外れる・Esc で `onDeactivate`。返す `groupProps` を、止まり場所の要素に付ける。`active` は、いま選んでいる項目（無ければ null）。
 */
export function useRovingTip(
  count: number,
  label: string,
  onActivate: (index: number) => void,
  onDeactivate: () => void,
) {
  const [active, setActive] = useState<number | null>(null);
  const index = useRef(0);
  const activate = useCallback(
    (next: number) => {
      const at = ((next % count) + count) % count;
      index.current = at;
      setActive(at);
      onActivate(at);
    },
    [count, onActivate],
  );
  const deactivate = useCallback(() => {
    setActive(null);
    onDeactivate();
  }, [onDeactivate]);
  const groupProps = {
    tabIndex: 0,
    role: 'group' as const,
    'aria-label': `${label}（矢印キーで選ぶ）`,
    onFocus: () => activate(index.current),
    onBlur: deactivate,
    onKeyDown: (event: ReactKeyboardEvent) => {
      const key = event.key;
      if (key === 'ArrowDown' || key === 'ArrowRight') {
        event.preventDefault();
        activate(index.current + 1);
      } else if (key === 'ArrowUp' || key === 'ArrowLeft') {
        event.preventDefault();
        activate(index.current - 1);
      } else if (key === 'Home') {
        event.preventDefault();
        activate(0);
      } else if (key === 'End') {
        event.preventDefault();
        activate(count - 1);
      } else if (key === 'Escape') {
        deactivate();
      }
    },
  };
  return { active, groupProps };
}

// ---- 小さな折れ線 ----

export interface LineChartProps {
  /** 図の名前（読み上げ用）。例: 「受け入れ枚数の割合（直近8週）」。 */
  label: string;
  /** 週ごとの値（古い順）。無い週は null（線は、そこで切れる）。 */
  values: ReadonlyArray<number | null>;
  /** 縦の範囲。 */
  min: number;
  max: number;
  /** 縦軸の目盛り（小さな線では出さない）と、その文字。 */
  ticks?: readonly number[];
  tickLabel?: (tick: number) => string;
  /** 図の高さ（px）。 */
  height?: number;
  /** 軸の無い小さな線（一致率・成績）。 */
  spark?: boolean;
  /** 週ごとの吹き出し（値、名前）。 */
  tips: ReadonlyArray<readonly [string, string]>;
  /** 左右の端の週の名前（8/17 と 10/5 のような）。 */
  xl: readonly [string, string];
}

/** 図の中の位置（% 単位）: 週の真ん中、値の高さ。 */
const xAt = (k: number, n: number): number => ((k + 0.5) / n) * 100;
const yAt = (v: number, min: number, max: number): number => 6 + (1 - (v - min) / (max - min)) * 88;

export function LineChart({ label, values, min, max, ticks = [], tickLabel, height = 76, spark = false, tips, xl }: LineChartProps) {
  const tip = useChartTip();
  const plotRef = useRef<HTMLDivElement>(null);
  const n = values.length;
  const [hover, setHover] = useState<number | null>(null);
  const index = useRef(n - 1);

  // 値の連なり（null で切れる）
  const segments: Array<Array<[number, number]>> = [];
  let current: Array<[number, number]> = [];
  values.forEach((v, k) => {
    if (v === null) {
      if (current.length > 0) segments.push(current);
      current = [];
    } else {
      current.push([xAt(k, n), yAt(v, min, max)]);
    }
  });
  if (current.length > 0) segments.push(current);
  const points = (segment: Array<[number, number]>) => segment.map((p) => `${p[0].toFixed(2)},${p[1].toFixed(2)}`).join(' ');
  const drawn = segments.filter((segment) => segment.length > 1);

  const last = values[n - 1] ?? null;

  /** 週 `k` を指す。`fromKeyboard` のときは、読み上げ用の欄にも出す。 */
  const point = useCallback(
    (k: number, fromKeyboard: boolean) => {
      const at = Math.max(0, Math.min(n - 1, k));
      index.current = at;
      setHover(at);
      const plot = plotRef.current;
      if (plot === null) return;
      const rect = plot.getBoundingClientRect();
      const v = values[at] ?? null;
      const x = rect.left + (rect.width * xAt(at, n)) / 100;
      const y = rect.top + (rect.height * (v === null ? 50 : yAt(v, min, max))) / 100;
      const text = tips[at] ?? ['', ''];
      tip.show(text[0], text[1], x, y, fromKeyboard);
    },
    [n, values, min, max, tips, tip],
  );
  const off = useCallback(() => {
    setHover(null);
    tip.hide();
  }, [tip]);

  const hoverValue = hover === null ? null : (values[hover] ?? null);
  const style = { '--h': `${height}px` } as CSSProperties;
  return (
    <div className={spark ? 'lc lc-spark' : 'lc'} style={style} data-hov={hover === null ? undefined : '1'}>
      {!spark && (
        <div className="lc-y" aria-hidden="true">
          {ticks.map((t) => (
            <span key={t} style={{ top: `${yAt(t, min, max).toFixed(2)}%` }}>
              {tickLabel === undefined ? t : tickLabel(t)}
            </span>
          ))}
        </div>
      )}
      {/* eslint-disable-next-line jsx-a11y/no-noninteractive-element-interactions -- 図は、1 つの止まり場所。矢印キーで週を選ぶ（吹き出しは、マウスと同じ） */}
      <div
        className="lc-plot"
        ref={plotRef}
        // eslint-disable-next-line jsx-a11y/no-noninteractive-tabindex -- 図の 1 つの止まり場所（矢印キーで週を選ぶ）
        tabIndex={0}
        role="group"
        aria-label={`${label}（矢印キーで週を選ぶ）`}
        onPointerMove={(event) => {
          const rect = event.currentTarget.getBoundingClientRect();
          point(Math.floor(((event.clientX - rect.left) / rect.width) * n), false);
        }}
        onPointerLeave={off}
        onFocus={() => point(index.current, true)}
        onBlur={off}
        onKeyDown={(event) => {
          if (event.key === 'ArrowRight') {
            event.preventDefault();
            point(index.current + 1, true);
          } else if (event.key === 'ArrowLeft') {
            event.preventDefault();
            point(index.current - 1, true);
          } else if (event.key === 'Home') {
            event.preventDefault();
            point(0, true);
          } else if (event.key === 'End') {
            event.preventDefault();
            point(n - 1, true);
          } else if (event.key === 'Escape') {
            off();
          }
        }}
      >
        <i className="band" style={{ left: `${(((n - 1) / n) * 100).toFixed(2)}%`, width: `${(100 / n).toFixed(2)}%` }} />
        <svg className="lc-svg" viewBox="0 0 100 100" preserveAspectRatio="none" aria-hidden="true" focusable="false">
          {ticks.map((t, i) => (
            <line
              key={t}
              className={i === 0 ? 'g g0' : 'g'}
              x1="0"
              x2="100"
              y1={yAt(t, min, max).toFixed(2)}
              y2={yAt(t, min, max).toFixed(2)}
            />
          ))}
          {drawn.map((segment) => (
            <polygon
              key={`a${segment[0]?.[0]}`}
              className="ar"
              points={`${points(segment)} ${(segment[segment.length - 1] as [number, number])[0].toFixed(2)},100 ${(segment[0] as [number, number])[0].toFixed(2)},100`}
            />
          ))}
          {drawn.map((segment) => (
            <polyline key={`l${segment[0]?.[0]}`} className="ln" points={points(segment)} />
          ))}
        </svg>
        <i className="cross" style={hover === null ? undefined : { left: `${xAt(hover, n)}%` }} />
        {last !== null && <i className="dot cur" style={{ left: `${xAt(n - 1, n)}%`, top: `${yAt(last, min, max)}%` }} />}
        <i
          className="dot hov"
          style={
            hover === null || hoverValue === null
              ? { opacity: 0 }
              : { left: `${xAt(hover, n)}%`, top: `${yAt(hoverValue, min, max)}%` }
          }
        />
      </div>
      <div className="lc-x" aria-hidden="true">
        <span>{xl[0]}</span>
        <span>{xl[1]}</span>
      </div>
    </div>
  );
}
