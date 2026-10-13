/**
 * 図の吹き出し（U-30）。マウスを乗せる・キーボードで選ぶと、点・棒の数字（値が先、名前があと）が出る。
 *
 * - 吹き出しは 1 つだけ（`ChartTipProvider` が body の下に描く）。本文は `container-type` の入った箱の中なので、
 *   欄の中に置くと、位置の基準が窓ではなく本文になってしまう（InfoTip と同じ事情）
 * - 位置は、マウスの動きのたびに直接置く（描き直さない）。窓の中に収め、上に入らなければ下に出す
 * - 吹き出しは読み上げない（aria-hidden）。同じ数字は、図の「表で見る」の表と、キーボードで選んだときの読み上げ用の欄
 *   （aria-live）で読める。吹き出しは、見える人のための補助で、数字の唯一の入口にはしない
 */
import { createContext, useCallback, useContext, useEffect, useMemo, useRef, useState, type ReactNode } from 'react';
import { createPortal } from 'react-dom';

export interface ChartTipApi {
  /** 吹き出しを出す。`x`・`y` は、指す点の窓の中の位置（px）。`announce` は、キーボードで選んだとき（読み上げ用の欄にも出す）。 */
  show: (value: string, label: string, x: number, y: number, announce?: boolean) => void;
  hide: () => void;
}

const ChartTipContext = createContext<ChartTipApi | null>(null);

export function useChartTip(): ChartTipApi {
  const api = useContext(ChartTipContext);
  if (api === null) throw new Error('ChartTipProvider の中で使ってください');
  return api;
}

/** 窓の端からあける余白（px）。 */
const EDGE = 8;

export function ChartTipProvider({ children }: { children: ReactNode }) {
  const tipRef = useRef<HTMLDivElement>(null);
  const valueRef = useRef<HTMLSpanElement>(null);
  const labelRef = useRef<HTMLSpanElement>(null);
  const [spoken, setSpoken] = useState('');

  const show = useCallback<ChartTipApi['show']>((value, label, x, y, announce = false) => {
    const tip = tipRef.current;
    if (tip === null || valueRef.current === null || labelRef.current === null) return;
    valueRef.current.textContent = value;
    labelRef.current.textContent = label;
    tip.hidden = false;
    // 前の位置のまま測ると、右端の近くでは使える幅が狭まり、文が折り返された幅になる。左上に置いてから測る
    tip.style.left = '0px';
    tip.style.top = '0px';
    const width = tip.offsetWidth;
    const height = tip.offsetHeight;
    const left = Math.min(Math.max(EDGE, x + 12), window.innerWidth - width - EDGE);
    let top = y - height - 10;
    if (top < EDGE) top = y + 14;
    tip.style.left = `${left}px`;
    tip.style.top = `${top}px`;
    if (announce) setSpoken(`${value}。${label}`);
  }, []);

  const hide = useCallback(() => {
    if (tipRef.current !== null) tipRef.current.hidden = true;
  }, []);

  // 画面を離れるときに、出しっぱなしにならない（portal ごと消える）
  useEffect(() => hide, [hide]);

  const api = useMemo<ChartTipApi>(() => ({ show, hide }), [show, hide]);
  return (
    <ChartTipContext.Provider value={api}>
      {children}
      {createPortal(
        <div className="wk-tip" ref={tipRef} hidden aria-hidden="true">
          <span className="wk-tip-v" ref={valueRef} />
          <span className="wk-tip-l" ref={labelRef} />
        </div>,
        document.body,
      )}
      <p className="sr-only" aria-live="polite">
        {spoken}
      </p>
    </ChartTipContext.Provider>
  );
}
