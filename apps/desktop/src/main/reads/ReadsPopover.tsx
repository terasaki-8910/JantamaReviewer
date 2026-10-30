/**
 * 手牌の牌の下の数を押したときの吹き出し（F23）。受け入れ枚数の小窓（`UkeireSection`）と同じ部品の形・見た目（`.ukpop`）で、
 * 牌の列の上に出す（牌の列にかけない。上に入らないときだけ牌の下）。幅 640px 未満では画面の下から出る。
 * 軽い閉じ方: Esc（キーボードの位置は押した数へ戻す）・外を押す・別の数を押す（その数の吹き出しに替わる）。Tab で端から出たときも閉じて、押した数へ戻す。
 *
 * 中身（SPEC F23）:
 * - 見出し: 牌と「だれかが待っている確率 N%」
 * - 他家ごと（下家・対面・上家）に 1 行: 名前（リーチは「（リーチ）」）・聴牌の確率・この牌を待っている確率・守備の目安（リーチした他家だけ）
 * - 読み直した他家（リーチか、聴牌の確率が 50% 以上）には、さらに、効いた捨て牌（2 つまで。無ければ「大きく動かす捨て牌なし」）・
 *   読みの上位 5 牌・実際の待ち（聴牌していなければ「聴牌していなかった」）
 * 答える前は DOM に無い（U-1）ので、`data-ai` を付ける。
 */
import type { DangerClass } from '@jantama/engine';
import { useCallback, useEffect, useId, useLayoutEffect, useRef, useSyncExternalStore } from 'react';
import { createPortal } from 'react-dom';

import { Icon } from '../Icon';
import { Tile } from '../study/Tile';
import type { OpponentExplain, TileExplain } from './explain';

/** 小窓を画面の下から出す幅（`UkeireSection` と同じ）。 */
const SHEET_WIDTH = 640;

function subscribeResize(onChange: () => void): () => void {
  window.addEventListener('resize', onChange);
  return () => window.removeEventListener('resize', onChange);
}

function useNarrow(): boolean {
  return useSyncExternalStore(subscribeResize, () => window.innerWidth < SHEET_WIDTH);
}

/** 分類の札の見た目（守備の欄と同じ）: 現物は塗り、無スジは濃い枠、そのほかは薄い枠。 */
const classKind = (cls: DangerClass): string => (cls === '現物' ? 'safe' : cls === '無スジ' ? 'risky' : 'mid');

function Opponent({ opponent }: { opponent: OpponentExplain }) {
  const { name, reread } = opponent;
  return (
    <li className="rd-opp" data-seat={opponent.seat}>
      <p className="rd-opp-h">
        <span className="rd-opp-name">
          {name}
          {opponent.riichi ? '（リーチ）' : ''}
        </span>
        <span className="rd-opp-n">聴牌 {opponent.tenpai}%</span>
        <span className="rd-opp-n">この牌 {opponent.wait}%</span>
        {opponent.defense !== null && (
          <span className={`dg-c ${classKind(opponent.defense.cls)}`} title={opponent.defense.note}>
            {opponent.defense.cls}
          </span>
        )}
      </p>
      {reread !== null && (
        <div className="rd-opp-d">
          <p>{reread.reasons.length === 0 ? '大きく動かす捨て牌なし' : `効いた捨て牌: ${reread.reasons.join('、')}`}</p>
          <p>{`${name}の読みの上位: ${reread.topWaits}`}</p>
          <p>{`${name}の実際の待ち: ${reread.actualWaits ?? '聴牌していなかった'}`}</p>
        </div>
      )}
    </li>
  );
}

interface ReadsPopoverProps {
  explain: TileExplain;
  /** 押した数のボタン。この上に出す。閉じるときの、キーボードの位置の戻り先。 */
  trigger: HTMLElement;
  /** 閉じる。`returnFocus` が true なら、キーボードの位置を押した数へ戻す。 */
  onClose: (returnFocus: boolean) => void;
}

export function ReadsPopover({ explain, trigger, onClose }: ReadsPopoverProps) {
  const popRef = useRef<HTMLDivElement>(null);
  const titleId = useId();
  const narrow = useNarrow();

  // 牌の列の上に置く（牌の列にかけない）。上に入らないときは牌の下。窓の中に収める。描く前に決める
  const place = useCallback(() => {
    const el = popRef.current;
    if (el === null) return;
    if (narrow) {
      el.style.left = '';
      el.style.top = '';
      el.style.width = '';
      el.style.maxHeight = '';
      return;
    }
    const cell = trigger.getBoundingClientRect();
    const tiles = (trigger.closest('.slot') ?? trigger).getBoundingClientRect();
    const width = Math.min(404, window.innerWidth - 16);
    el.style.width = `${width}px`;
    el.style.maxHeight = '';
    const natural = el.offsetHeight;
    const above = tiles.top - 10 - 8;
    const below = window.innerHeight - cell.bottom - 6 - 8;
    const useAbove = natural <= above || above >= below;
    el.style.maxHeight = `${Math.max(180, Math.min(660, useAbove ? above : below))}px`;
    const height = el.offsetHeight;
    el.style.left = `${Math.min(Math.max(8, cell.left + cell.width / 2 - width / 2), window.innerWidth - width - 8)}px`;
    el.style.top = `${useAbove ? Math.max(8, tiles.top - 10 - height) : cell.bottom + 6}px`;
  }, [narrow, trigger]);

  useLayoutEffect(() => {
    place();
  }, [place]);

  // 開いたら、吹き出しにキーボードの位置を移す（閉じたら、押した数に戻す）
  useEffect(() => {
    popRef.current?.focus({ preventScroll: true });
  }, []);

  useEffect(() => {
    const el = popRef.current;
    const onKeyDown = (event: KeyboardEvent) => {
      if (event.key === 'Escape') {
        event.preventDefault();
        event.stopPropagation();
        onClose(true);
        return;
      }
      // 吹き出しは、画面をふさがない。端から Tab で出るときは、閉じて、押した数に戻す（Tab の順番が、数のつぎから続く）
      if (event.key === 'Tab' && el !== null && el.contains(document.activeElement)) {
        const focusable = [...el.querySelectorAll<HTMLElement>('button, [tabindex="0"], [href], input')].filter(
          (candidate) => !(candidate as HTMLButtonElement).disabled && candidate.getClientRects().length > 0,
        );
        const current = document.activeElement;
        const leaves =
          (current === el && event.shiftKey) ||
          (!event.shiftKey && current === focusable[focusable.length - 1]) ||
          (event.shiftKey && current === focusable[0]);
        if (leaves) {
          event.preventDefault();
          onClose(true);
        }
      }
    };
    const onMouseDown = (event: MouseEvent) => {
      const target = event.target;
      if (!(target instanceof Node)) return;
      if (el?.contains(target) === true || trigger.contains(target)) return;
      // 別の数を押したときは、その数の処理に任せる（吹き出しがその数のものに替わる）
      if (target instanceof Element && target.closest('.rd-cell') !== null) return;
      onClose(false);
    };
    document.addEventListener('keydown', onKeyDown, true);
    document.addEventListener('mousedown', onMouseDown, true);
    window.addEventListener('resize', place);
    window.addEventListener('scroll', place, true);
    return () => {
      document.removeEventListener('keydown', onKeyDown, true);
      document.removeEventListener('mousedown', onMouseDown, true);
      window.removeEventListener('resize', place);
      window.removeEventListener('scroll', place, true);
    };
  }, [onClose, place, trigger]);

  return createPortal(
    <div
      className={`ukpop rd-pop${narrow ? ' sheet' : ''}`}
      id="rdpop"
      role="dialog"
      aria-modal="false"
      aria-labelledby={titleId}
      tabIndex={-1}
      ref={popRef}
      data-ai="reads-pop"
    >
      <div className="up-fix">
        <div className="up-h">
          <h3 className="up-t" id={titleId}>
            <span className="up-dis">
              <Tile tile={explain.tile} />
            </span>
            <span>
              だれかが待っている確率 <b className="rd-pop-n">{explain.anyWait}%</b>
            </span>
          </h3>
          <button type="button" className="icon-btn up-x" aria-label="閉じる" onClick={() => onClose(true)}>
            <Icon name="close" />
          </button>
        </div>
      </div>
      {/* 縦にあふれる領域は、キーボードで動かせるよう Tab の止まり場所にする（axe: scrollable-region-focusable） */}
      {/* eslint-disable-next-line jsx-a11y/no-noninteractive-tabindex -- 他家ごとの読みは、見出しの下の読む領域。矢印キーで送れるよう、止まり場所にする */}
      <div className="up-body" tabIndex={0}>
        <ul className="rd-opps" aria-label="他家ごとの読み">
          {explain.opponents.map((opponent) => (
            <Opponent opponent={opponent} key={opponent.seat} />
          ))}
        </ul>
      </div>
    </div>,
    document.body,
  );
}
