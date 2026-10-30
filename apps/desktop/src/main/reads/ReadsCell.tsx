/**
 * 手牌の牌の下の、読みの数（F23）。牌 1 枚ごとに 1 つのボタンで、「だれかがその牌を待っている確率」を整数の % で出し（0.5% 未満は 0）、
 * 数の下に、長さで表す細い帯を付ける（帯は、確率 25% で全幅）。押すと、その牌の吹き出しを開く。
 * 手牌の牌そのものは、出題では答えのボタンなので、吹き出しは開かない。
 * 色は灰色だけ（accent は AI の1位の印に残す）: 数と帯は `--muted`、確率が 10% 以上の数だけ `--ink`。
 * 答える前は DOM に無い（U-1）ので、`data-ai` を付ける。
 */
import type { KeyboardEvent } from 'react';

import { barRatio, cellLabel, percentOf, STRONG_FROM } from './explain';

/** 手牌が持つ、読みの数の部品に渡すもの。 */
export interface HandReads {
  /** 種類（0〜33）ごとの、だれかが待っている確率。 */
  anyWait: readonly number[];
  /** 吹き出しを開いている牌の位置（`HandItem.index`）。無ければ null。 */
  openIndex: number | null;
  /** 牌の下の数を押した（吹き出しを開く。同じ牌なら閉じる）。 */
  onOpen: (index: number, trigger: HTMLButtonElement) => void;
}

interface ReadsCellProps {
  /** 読み上げる牌の名前（例: 五筒）。 */
  tileName: string;
  /** だれかがこの牌を待っている確率（0〜1）。 */
  probability: number;
  expanded: boolean;
  /** 矢印キーで動く組の、Tab の止まり場所か。 */
  tabStop: boolean;
  bind: (element: HTMLButtonElement | null) => void;
  onOpen: (trigger: HTMLButtonElement) => void;
  onKeyDown: (event: KeyboardEvent<HTMLButtonElement>) => void;
}

export function ReadsCell({ tileName, probability, expanded, tabStop, bind, onOpen, onKeyDown }: ReadsCellProps) {
  const label = cellLabel(tileName, probability);
  return (
    <button
      type="button"
      className={`rd-cell${probability >= STRONG_FROM ? ' is-strong' : ''}`}
      data-ai="reads-cell"
      aria-label={label}
      title={label}
      aria-haspopup="dialog"
      aria-expanded={expanded}
      aria-controls={expanded ? 'rdpop' : undefined}
      tabIndex={tabStop ? 0 : -1}
      ref={bind}
      onClick={(event) => onOpen(event.currentTarget)}
      onKeyDown={onKeyDown}
    >
      <span className="rd-n" aria-hidden="true">
        {percentOf(probability)}
      </span>
      <span className="rd-bar" aria-hidden="true">
        <span className="rd-fill" style={{ width: `${(barRatio(probability) * 100).toFixed(1)}%` }} />
      </span>
    </button>
  );
}
