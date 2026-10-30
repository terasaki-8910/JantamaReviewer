/**
 * 手牌の牌の下の数と、その吹き出しをつなぐ（F23）。どの数の吹き出しを開いているかを持ち、手牌（`Hand`）に渡す部品と、吹き出し本体を返す。
 * 開いている間に、見せる場面が替わった（手を進めた・読みを切った）ときは、吹き出しは閉じた扱いにする。
 */
import { useCallback, useMemo, useState, type ReactNode } from 'react';

import type { HandItem } from '../study/Hand';
import { explainTile, type ReadsMomentView } from './explain';
import type { HandReads } from './ReadsCell';
import { ReadsPopover } from './ReadsPopover';

interface Open {
  index: number;
  trigger: HTMLButtonElement;
  /** 開いたときの場面（局の番号と牌譜の位置）。場面が替わったら、閉じた扱い。 */
  moment: string;
}

const momentKey = (view: ReadsMomentView): string => `${view.moment.kyoku_index}/${view.moment.event_index}`;

export interface ReadsPopoverState {
  /** 手牌に渡す。読みを出さないとき（場面が無い・切）は null。 */
  handReads: HandReads | null;
  /** 吹き出し（開いていなければ null）。 */
  popover: ReactNode;
}

export function useReadsPopover(view: ReadsMomentView | null, items: readonly HandItem[]): ReadsPopoverState {
  const [open, setOpen] = useState<Open | null>(null);
  const key = view === null ? null : momentKey(view);

  const onOpen = useCallback(
    (index: number, trigger: HTMLButtonElement) => {
      if (key === null) return;
      setOpen((current) => (current !== null && current.index === index && current.moment === key ? null : { index, trigger, moment: key }));
    },
    [key],
  );
  const shown = open !== null && key !== null && open.moment === key ? open : null;
  const item = shown === null ? undefined : items.find((candidate) => candidate.index === shown.index && !candidate.called);
  const trigger = shown === null ? null : shown.trigger;
  const onClose = useCallback(
    (returnFocus: boolean) => {
      if (returnFocus && trigger !== null && trigger.isConnected) trigger.focus();
      setOpen(null);
    },
    [trigger],
  );

  const handReads = useMemo<HandReads | null>(
    () => (view === null ? null : { anyWait: view.moment.any_wait, openIndex: item === undefined || shown === null ? null : shown.index, onOpen }),
    [view, item, shown, onOpen],
  );
  const popover =
    view !== null && shown !== null && item !== undefined ? (
      <ReadsPopover explain={explainTile(view, item.tile)} trigger={shown.trigger} onClose={onClose} />
    ) : null;
  return { handReads, popover };
}
