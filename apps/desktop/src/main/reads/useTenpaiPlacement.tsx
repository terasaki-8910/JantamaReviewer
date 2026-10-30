/**
 * 他家の聴牌の確率（F23）の置き場所を決める。中央の箱に「聴牌 62%」が入るなら席の札（`chips`）、入らないなら卓の上の 1 行（`line`）。
 * 箱の大きさは、窓の幅だけでなく高さでも変わるので、箱そのものの幅を測る。測れない環境（jsdom）では、札にする。
 */
import { useLayoutEffect, useMemo, useState, type ReactNode } from 'react';

import type { ReadsMoment } from '../../api/reads';
import { tenpaiChips } from './explain';
import { TenpaiLine } from './TenpaiLine';

/** 札を席に置ける、中央の箱の中身の幅の下限。 */
export const CHIP_MIN_BOX_WIDTH = 150;

function contentWidth(element: Element): number {
  const style = getComputedStyle(element);
  return element.clientWidth - (Number.parseFloat(style.paddingLeft) || 0) - (Number.parseFloat(style.paddingRight) || 0);
}

export interface TenpaiPlacement {
  /** 卓と手牌の列に付ける ref（中央の箱を、この中から探す）。 */
  bindCol: (element: HTMLElement | null) => void;
  /** 席に出す札（席 → 聴牌の確率）。出さないときは null。 */
  chips: ReadonlyMap<number, number> | null;
  /** 卓の上の行に出す部品。出さないときは null。 */
  line: ReactNode;
}

export function useTenpaiPlacement(moment: ReadsMoment | null): TenpaiPlacement {
  const [col, bindCol] = useState<HTMLElement | null>(null);
  const [narrow, setNarrow] = useState(false);
  const active = moment !== null;

  useLayoutEffect(() => {
    const box = active ? col?.querySelector('.table .center') : null;
    if (box === null || box === undefined) return;
    const measure = () => {
      const width = contentWidth(box);
      // 表示されていない（幅 0）あいだは、決めない
      if (width > 0) setNarrow(width < CHIP_MIN_BOX_WIDTH);
    };
    measure();
    if (typeof ResizeObserver === 'undefined') return;
    const observer = new ResizeObserver(measure);
    observer.observe(box);
    return () => observer.disconnect();
  }, [active, col]);

  const chips = useMemo(() => (moment === null || narrow ? null : tenpaiChips(moment)), [moment, narrow]);
  return { bindCol, chips, line: moment !== null && narrow ? <TenpaiLine moment={moment} /> : null };
}
