import type { DecisionKind, Tile as TileCode } from '@jantama/engine';
import { useRef, useState, type CSSProperties, type KeyboardEvent } from 'react';

import type { HandBar, HandBars } from './aiBars';
import { isDoraTile } from './dora';
import { Tile } from './Tile';
import { tileName, tileSrc } from './tiles';

/** 手牌の 1 枚（左から、手牌・ツモ牌・鳴きの判断で鳴く牌）。 */
export interface HandItem {
  tile: TileCode;
  /** 手牌の中の位置（0 から。ツモ牌は最後）。 */
  index: number;
  /** ツモ牌。 */
  draw: boolean;
  /** 鳴く牌（他家の打牌。鳴きの判断で、手牌の右に離して置く）。 */
  called: boolean;
}

export type MarkKind = 'you' | 'act' | 'top';

/** 答え合わせのあとに、牌の下に出す印（自分・実戦・AI）。 */
export interface HandMark {
  /** この牌に当たる印（自分・実戦・AI の順）。 */
  kinds: MarkKind[];
  /** 文字を出す印（同じ種類の牌が何枚かあるとき、1 枚だけに文字を出す）。 */
  labeled: MarkKind[];
}

const MARK_ORDER: readonly MarkKind[] = ['you', 'act', 'top'];
const MARK_NAME: Readonly<Record<MarkKind, string>> = { you: '自分', act: '実戦', top: 'AI' };

interface HandProps {
  items: readonly HandItem[];
  /** 切る牌を選べるか（打牌の判断の、いまの盤面）。選べないときは、手牌ごと操作できない。 */
  interactive: boolean;
  kind: DecisionKind;
  /** 選んでいる牌の位置。 */
  selected: number | null;
  /** 答え合わせのあとか（牌は押せず、印を出す）。 */
  revealed: boolean;
  marks: ReadonlyMap<number, HandMark>;
  /** 鳴きの選択肢が使う手牌の位置。 */
  used: ReadonlySet<number>;
  /** 鳴く牌の上に出す説明（例: 下家の打牌）。 */
  calledCaption: string | null;
  dora: ReadonlySet<number> | null;
  onPick: (index: number) => void;
  /**
   * AI の評価の棒（牌の上）。出してよい場面（打牌の判断の答え合わせのあと・通して見る画面の自分の打牌の手番）でだけ渡す。
   * 渡さないときも、棒の帯（`--band`）は空のまま取っておく（答える前と答えたあとで、盤面が動かないように。U-1・U-39）。
   */
  bars?: HandBars | null;
}

/** 牌の上の棒 1 本（読み上げない。読み上げは、手牌のそばの一覧が受け持つ）。AI の情報なので `data-ai`。 */
function BarColumn({ bar }: { bar: HandBar | undefined }) {
  if (bar === undefined) return null;
  return (
    <span className={`ai-bar${bar.top ? ' is-top' : ''}`} aria-hidden="true" data-ai="bar" style={{ '--h': `${bar.height}px` } as CSSProperties}>
      {bar.height > 0 && <span className="ai-fill" />}
      {bar.label !== null && <span className="ai-num">{bar.label}</span>}
    </span>
  );
}

function tileLabel(item: HandItem, dora: boolean): string {
  return `${tileName(item.tile)}${dora ? '（ドラ）' : ''}${item.draw ? '（ツモ牌）' : ''}`;
}

/** 手牌。切る牌を選ぶときは、1 つの Tab の止まり場所（矢印キーで牌の間を動く）で、Space か Enter で選ぶ。 */
export function Hand({ items, interactive, kind, selected, revealed, marks, used, calledCaption, dora, onPick, bars = null }: HandProps) {
  const refs = useRef(new Map<number, HTMLButtonElement>());
  // 矢印キーで動いた位置（選んでいる牌が替わったら、そこへ戻す）
  const [moved, setMoved] = useState<{ for: number | null; at: number } | null>(null);
  const rove = moved !== null && moved.for === selected ? moved.at : (selected ?? 0);

  const onKeyDown = (event: KeyboardEvent<HTMLButtonElement>) => {
    const { key } = event;
    if (key !== 'ArrowLeft' && key !== 'ArrowRight' && key !== 'Home' && key !== 'End') return;
    // Alt+← → は画面の戻る・進む、Shift+← → は通して見る画面の前・次の局。ここでは使わない
    if (event.altKey || event.ctrlKey || event.metaKey || event.shiftKey) return;
    const buttons = [...refs.current.entries()].filter(([, el]) => !el.disabled).sort((a, b) => a[0] - b[0]);
    const current = buttons.findIndex(([, el]) => el === document.activeElement);
    if (current < 0) return;
    const to =
      key === 'Home' ? 0 : key === 'End' ? buttons.length - 1 : Math.max(0, Math.min(buttons.length - 1, current + (key === 'ArrowRight' ? 1 : -1)));
    event.preventDefault();
    event.stopPropagation();
    const target = buttons[to];
    if (target === undefined) return;
    setMoved({ for: selected, at: target[0] });
    target[1].focus();
  };

  return (
    <>
      <div className="hand-wrap" data-kind={kind} inert={!interactive}>
        <div className="hand" role="group" aria-label="手牌（右端がツモ牌）">
          {items.map((item) => {
            const isDora = !item.called && isDoraTile(item.tile, dora);
            if (item.called) {
              return (
                <span className="slot draw" key={`c${item.index}`}>
                  {calledCaption !== null && <span className="cap-top">{calledCaption}</span>}
                  <Tile tile={item.tile} className="target" alt={`${tileName(item.tile)}（${calledCaption ?? '他家の打牌'}）`} />
                </span>
              );
            }
            const bar = bars?.bars.get(item.index);
            if (kind !== 'discard' || !interactive) {
              return (
                <span className={`slot${item.draw ? ' draw' : ''}`} key={item.index} data-use={used.has(item.index) ? '1' : undefined}>
                  <BarColumn bar={bar} />
                  <Tile tile={item.tile} dora={isDora} alt={`${tileName(item.tile)}${item.draw ? '（ツモ牌）' : ''}`} />
                </span>
              );
            }
            const mark = marks.get(item.index);
            const present = mark === undefined ? [] : MARK_ORDER.filter((k) => mark.kinds.includes(k));
            const ring = present.length === 0 ? undefined : present[0] === 'you' ? 'you' : present.includes('top') ? 'top' : 'act';
            const base = tileLabel(item, isDora);
            const label =
              present.length > 0 ? `${base}（${present.map((k) => MARK_NAME[k]).join('・')}）` : `${base}を切る`;
            const pressed = selected === item.index && !revealed;
            return (
              <span
                className={`slot${item.draw ? ' draw' : ''}`}
                key={item.index}
                data-mark={present.length > 0 ? present.join(' ') : undefined}
                data-ai={present.length > 0 ? 'mark' : undefined}
                data-ring={ring}
              >
                <BarColumn bar={bar} />
                <button
                  type="button"
                  className={`tile tile-btn${isDora ? ' is-dora' : ''}`}
                  aria-pressed={pressed}
                  aria-label={label}
                  tabIndex={item.index === rove ? 0 : -1}
                  disabled={revealed}
                  ref={(el) => {
                    if (el === null) refs.current.delete(item.index);
                    else refs.current.set(item.index, el);
                  }}
                  onClick={() => onPick(item.index)}
                  onKeyDown={onKeyDown}
                >
                  <img src={tileSrc(item.tile)} alt={tileName(item.tile)} draggable={false} />
                </button>
                <span className="mks" aria-hidden="true">
                  {mark !== undefined &&
                    MARK_ORDER.filter((k) => mark.labeled.includes(k)).map((k) => (
                      <span className={`mk ${k}`} key={k}>
                        {MARK_NAME[k]}
                      </span>
                    ))}
                </span>
              </span>
            );
          })}
        </div>
      </div>
      {/* 棒の読み上げ（棒は読み上げない）。手牌の外に置く: 手牌は inert のことがあり、その中は読み上げられないため */}
      {bars !== null && (
        <ul className="sr-only" aria-label="AIの評価" data-ai="bars-list">
          {bars.spoken.map((text, index) => (
            <li key={`${index}${text}`}>{text}</li>
          ))}
        </ul>
      )}
    </>
  );
}
