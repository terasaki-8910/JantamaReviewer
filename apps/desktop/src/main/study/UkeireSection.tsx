/**
 * 受け入れ枚数（打牌の判断の答え合わせ。F6・U-18）。
 *
 * 行（自分・実戦・AI・最大。同じ打牌は 1 行）に、手牌だけで数えた枚数（「16枚」。天鳳牌理と同じ）と、場に見えている牌も除いた
 * 「残り」（小さく「残り11」）を並べる。行を押すと小窓が開き、受け入れ牌ごとの枚数と残り、合計を出す。打牌のあとが 2 シャンテンの行には、
 * 「2シャンテンからの先」の欄もある（E-23）。Esc か小窓の外を押すと閉じ、キーボードの位置は押した行に戻る。幅の狭い窓では、画面の下から出る。
 */
import { shantenTag, tenhouPairiUrl, type AcceptedDetail } from '@jantama/engine';
import { useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState, useSyncExternalStore, type KeyboardEvent } from 'react';
import { createPortal } from 'react-dom';

import { Icon } from '../Icon';
import { isDoraTile } from './dora';
import { followOf, type UkeireBox, type UkeireRow } from './reveal';
import { Tile } from './Tile';
import { kindOrder } from './tiles';

type PopTab = 'tiles' | '2sh';

/** 小窓を画面の下から出す幅（この幅より狭いとき）。 */
const SHEET_WIDTH = 640;

function subscribeResize(onChange: () => void): () => void {
  window.addEventListener('resize', onChange);
  return () => window.removeEventListener('resize', onChange);
}

/** 窓が狭いか（狭いときは、小窓を画面の下から出す）。 */
function useNarrow(): boolean {
  return useSyncExternalStore(subscribeResize, () => window.innerWidth < SHEET_WIDTH);
}

function Count({ value }: { value: number }) {
  return (
    <>
      <b>{value}</b>枚
    </>
  );
}

/** 自分の打牌との違い（同じシャンテン数どうしのときだけ）。枚数は、手牌だけで数えた数。 */
function Difference({ row, mine }: { row: UkeireRow; mine: UkeireRow | undefined }) {
  if (mine === undefined || row === mine || row.detail.shanten !== mine.detail.shanten) return null;
  const theirs = new Map<string, number>(row.detail.accepted.map((a) => [a.tile, a.count]));
  const own = new Map<string, number>(mine.detail.accepted.map((a) => [a.tile, a.count]));
  const only: Array<[string, number]> = [];
  const lack: Array<[string, number]> = [];
  const tiles = [...theirs.keys(), ...[...own.keys()].filter((tile) => !theirs.has(tile))].sort((a, b) => kindOrder(a) - kindOrder(b));
  for (const tile of tiles) {
    const d = (theirs.get(tile) ?? 0) - (own.get(tile) ?? 0);
    if (d > 0) only.push([tile, d]);
    else if (d < 0) lack.push([tile, -d]);
  }
  const who = row.tags[0] === '最大' ? '最大の打牌' : `${row.tags[0]}の打牌`;
  const diff = row.detail.ukeire - mine.detail.ukeire;
  const list = (items: Array<[string, number]>) =>
    items.map(([tile, n]) => (
      <span className="df-t" key={tile}>
        <Tile tile={tile} />
        <span className="ut-n">
          <b>{n}</b>枚
        </span>
      </span>
    ));
  if (only.length === 0 && lack.length === 0) {
    return (
      <div className="up-diff">
        <p className="up-diff-h">自分の打牌との違い</p>
        <p className="quiet">受け入れ牌も枚数も、自分の打牌と同じです。</p>
      </div>
    );
  }
  return (
    <div className="up-diff">
      <p className="up-diff-h">
        自分の打牌との違い{' '}
        <span className="df-n">{diff === 0 ? '枚数は同じ' : `${diff > 0 ? '+' : '−'}${Math.abs(diff)}枚`}</span>
      </p>
      {only.length > 0 && (
        <div className="df-row">
          <span className="df-l">{who}だけ</span>
          <span className="df-ts">{list(only)}</span>
        </div>
      )}
      {lack.length > 0 && (
        <div className="df-row">
          <span className="df-l">自分の打牌だけ</span>
          <span className="df-ts">{list(lack)}</span>
        </div>
      )}
    </div>
  );
}

/** 受け入れ牌の色（萬・筒・索・字）。色が替わるところに、少し間を空ける。 */
const suitOf = (a: AcceptedDetail): string => (a.kind >= 27 ? 'z' : a.tile.charAt(1));

function AcceptedList({ accepted, dora }: { accepted: readonly AcceptedDetail[]; dora: ReadonlySet<number> | null }) {
  return (
    <ul className="ut-list" aria-label="受け入れ牌と枚数・残り">
      {accepted.map((a, index) => {
        const before = accepted[index - 1];
        const gap = before !== undefined && suitOf(before) !== suitOf(a);
        return (
          <li className={`ut${gap ? ' gap' : ''}`} key={a.tile}>
            <Tile tile={a.tile} dora={isDoraTile(a.tile, dora)} />
            <span className="ut-n">
              <Count value={a.count} />
            </span>
            <span className="ut-r">残り{a.remaining}</span>
          </li>
        );
      })}
    </ul>
  );
}

function FollowPanel({ box, row, dora }: { box: UkeireBox; row: UkeireRow; dora: ReadonlySet<number> | null }) {
  const follow = useMemo(() => followOf(box.tiles, row.tile), [box.tiles, row.tile]);
  if (follow === null) return null;
  const peak = follow.max;
  return (
    <>
      <p className="up-sum">
        <b>
          1シャンテンに進む牌 {follow.total}枚
        </b>
        （{follow.kinds}種類）
      </p>
      <p className="up-sum2">
        進んだあとの受け入れは、<b>平均 {follow.average.toFixed(1)}枚</b>・最大 {follow.max}枚
        <span className="up-sub">（引く牌の枚数で重みを付けた平均）</span>
      </p>
      <div className="fl-wrap">
        <table className="fl">
          <caption className="sr-only">2シャンテンの手から、1シャンテンに進む牌と、進んだあとの受け入れ枚数</caption>
          <thead>
            <tr>
              <th scope="col">引く牌</th>
              <th scope="col">枚数</th>
              <th scope="col">切る牌</th>
              <th scope="col">そのあとの受け入れ</th>
            </tr>
          </thead>
          <tbody>
            {follow.rows.map((r) => (
              <tr key={r.tile}>
                <td className="fl-t">
                  <Tile tile={r.tile} dora={isDoraTile(r.tile, dora)} />
                </td>
                <td className="fl-n">
                  <Count value={r.count} />
                </td>
                <td className="fl-d">
                  打<Tile tile={r.discard} dora={isDoraTile(r.discard, dora)} />
                </td>
                <td className="fl-u">
                  <span className="fl-uv">
                    <Count value={r.ukeire} />
                  </span>
                  <span className="track" aria-hidden="true">
                    <span className="fill" style={{ width: `${((r.ukeire / peak) * 100).toFixed(1)}%` }} />
                  </span>
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
      <p className="up-note">
        切る牌は、そのあとの受け入れがいちばん多くなるものを自動で選びました。打点・形・守備と鳴きは見ていません。自分の手牌だけを数えています。
      </p>
    </>
  );
}

interface PopoverProps {
  box: UkeireBox;
  row: UkeireRow;
  mine: UkeireRow | undefined;
  dora: ReadonlySet<number> | null;
  trigger: HTMLElement;
  initialTab: PopTab;
  /** 閉じる。`returnFocus` が true なら、キーボードの位置を押した行に戻す。 */
  onClose: (returnFocus: boolean) => void;
}

function Popover({ box, row, mine, dora, trigger, initialTab, onClose }: PopoverProps) {
  const popRef = useRef<HTMLDivElement>(null);
  const hasFollow = row.detail.shanten === 2;
  const [tab, setTab] = useState<PopTab>(hasFollow ? initialTab : 'tiles');
  const narrow = useNarrow();
  const detail = row.detail;

  // 行のそばに置く（描く前に決める）。横に置けないときは、行の上か下の、広いほう。行そのものには重ねない
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
    const r = trigger.getBoundingClientRect();
    const width = Math.min(404, window.innerWidth - 16);
    el.style.width = `${width}px`;
    el.style.maxHeight = '';
    let height = el.offsetHeight;
    let left = r.left - width - 10;
    let top: number;
    if (left < 8) {
      left = Math.min(Math.max(8, r.left), window.innerWidth - width - 8);
      const below = window.innerHeight - r.bottom - 14;
      const above = r.top - 14;
      const useBelow = below >= Math.min(height, 420) || below >= above;
      el.style.maxHeight = `${Math.min(660, Math.max(220, useBelow ? below : above))}px`;
      height = el.offsetHeight;
      top = useBelow ? r.bottom + 6 : Math.max(8, r.top - height - 6);
    } else {
      top = Math.min(Math.max(8, r.top - 14), Math.max(8, window.innerHeight - height - 8));
    }
    el.style.left = `${left}px`;
    el.style.top = `${top}px`;
  }, [narrow, trigger]);

  // 開いたとき・タブを替えたとき・窓の大きさが替わったとき、行のそばに置き直す
  useLayoutEffect(() => {
    place();
  }, [place, tab]);

  // 開いたら、小窓にキーボードの位置を移す（閉じたら、押した行に戻す）
  useEffect(() => {
    popRef.current?.focus({ preventScroll: true });
  }, []);

  useEffect(() => {
    const el = popRef.current;
    const onKeyDown = (event: globalThis.KeyboardEvent) => {
      if (event.key === 'Escape') {
        event.preventDefault();
        event.stopPropagation();
        onClose(true);
        return;
      }
      // 小窓は、画面をふさがない。端から Tab で出るときは、小窓を閉じて、押した行に戻す（Tab の順番が、行のつぎから続く）
      if (event.key === 'Tab' && el !== null && el.contains(document.activeElement)) {
        const focusable = [...el.querySelectorAll<HTMLElement>('button, [tabindex="0"], [href], input')].filter(
          (x) => !(x as HTMLButtonElement).disabled && x.getClientRects().length > 0 && x.closest('[hidden]') === null,
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
      // 別の行を押したときは、その行の処理に任せる
      if (target instanceof Element && target.closest('.uk-open') !== null) return;
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

  // 矢印キーでタブを替えたときは、替えた先のタブへキーボードの位置を移す（クリックのときは、押した所のまま）
  const focusTab = useRef(false);
  useEffect(() => {
    if (!focusTab.current) return;
    focusTab.current = false;
    document.getElementById(`uptab-${tab}`)?.focus();
  }, [tab]);

  const onTabKeys = (event: KeyboardEvent<HTMLButtonElement>) => {
    if (event.key !== 'ArrowLeft' && event.key !== 'ArrowRight' && event.key !== 'Home' && event.key !== 'End') return;
    event.preventDefault();
    const next: PopTab = event.key === 'ArrowLeft' || event.key === 'Home' ? 'tiles' : '2sh';
    if (next === tab) return;
    focusTab.current = true;
    setTab(next);
  };

  const tags = row.tags.join('・');
  return createPortal(
    <div
      className={`ukpop${narrow ? ' sheet' : ''}`}
      id="ukpop"
      role="dialog"
      aria-modal="false"
      aria-labelledby="ukpop-t"
      tabIndex={-1}
      ref={popRef}
      data-ai="ukeire-pop"
    >
      <div className="up-fix">
        <div className="up-h">
          <h3 className="up-t" id="ukpop-t">
            <span className="up-tags">{tags}</span>
            <span className="up-dis">
              打<Tile tile={row.tile} dora={isDoraTile(row.tile, dora)} />
            </span>
          </h3>
          <button type="button" className="icon-btn up-x" aria-label="閉じる" onClick={() => onClose(true)}>
            <Icon name="close" />
          </button>
        </div>
        {row.worse && (
          <p className="up-note warn">
            この打牌は{shantenTag(detail.shanten)}です（いちばん進む打牌は{shantenTag(box.minShanten)}）。受け入れ枚数は「あと1つ進む牌の数」なので、シャンテン数が違う打牌とは枚数で比べられません。
          </p>
        )}
        {hasFollow && (
          <div className="up-tabs" role="tablist" aria-label="表示の切り替え">
            <button
              type="button"
              role="tab"
              id="uptab-tiles"
              aria-controls="uppanel-tiles"
              aria-selected={tab === 'tiles'}
              tabIndex={tab === 'tiles' ? 0 : -1}
              onClick={() => setTab('tiles')}
              onKeyDown={onTabKeys}
            >
              受け入れ牌
            </button>
            <button
              type="button"
              role="tab"
              id="uptab-2sh"
              aria-controls="uppanel-2sh"
              aria-selected={tab === '2sh'}
              tabIndex={tab === '2sh' ? 0 : -1}
              onClick={() => setTab('2sh')}
              onKeyDown={onTabKeys}
            >
              2シャンテンからの先
            </button>
          </div>
        )}
      </div>
      {/* 縦にあふれる領域は、キーボードで動かせるよう Tab の止まり場所にする（axe: scrollable-region-focusable） */}
      {/* eslint-disable-next-line jsx-a11y/no-noninteractive-tabindex -- 受け入れ牌の一覧は、見出しの下の読む領域。矢印キーで送れるよう、止まり場所にする */}
      <div className="up-body" tabIndex={0}>
        <div
          className="up-panel"
          id="uppanel-tiles"
          role={hasFollow ? 'tabpanel' : 'group'}
          aria-labelledby={hasFollow ? 'uptab-tiles' : undefined}
          aria-label={hasFollow ? undefined : '受け入れ牌'}
          hidden={tab !== 'tiles'}
        >
          <p className="up-sum">
            <b>{shantenTag(detail.shanten)}</b>・受け入れ <b>{detail.ukeire}枚</b>（{detail.accepted.length}種類）・残り{' '}
            <b>{detail.remaining}枚</b>
          </p>
          <AcceptedList accepted={detail.accepted} dora={dora} />
          <Difference row={row} mine={mine} />
          <p className="up-note">
            枚数は自分の手牌だけで数えた数です（天鳳牌理と同じ）。残りは、場に見えている牌（全員の河・副露・ドラ表示牌）も除いた数です。
          </p>
        </div>
        {hasFollow && (
          <div className="up-panel" id="uppanel-2sh" role="tabpanel" aria-labelledby="uptab-2sh" hidden={tab !== '2sh'}>
            <FollowPanel box={box} row={row} dora={dora} />
          </div>
        )}
      </div>
    </div>,
    document.body,
  );
}

interface SectionProps {
  box: UkeireBox;
  dora: ReadonlySet<number> | null;
}

/** 受け入れ枚数の欄（行・一言・天鳳牌理のリンク）。 */
export function UkeireSection({ box, dora }: SectionProps) {
  const [open, setOpen] = useState<{ index: number; trigger: HTMLElement } | null>(null);
  const mine = box.rows.find((r) => r.tags.includes('自分'));
  const close = useCallback(
    (returnFocus: boolean) => {
      if (returnFocus && open !== null && open.trigger.isConnected) open.trigger.focus();
      setOpen(null);
    },
    [open],
  );

  return (
    <div className="q-sec" data-ai="ukeire-box">
      <h2 className="sec-title">受け入れ枚数</h2>
      <ul className="uk">
        {box.rows.map((row, index) => {
          const detail = row.detail;
          const width = ((detail.ukeire / box.maxCount) * 100).toFixed(1);
          return (
            <li className={`uk-row ${row.color}${row.worse ? ' worse' : ''}`} data-ai="ukeire" key={row.tile}>
              <button
                type="button"
                className="uk-open"
                aria-haspopup="dialog"
                aria-expanded={open?.index === index}
                aria-controls="ukpop"
                aria-describedby="uk-hint"
                onClick={(event) => {
                  const trigger = event.currentTarget;
                  setOpen(open?.index === index ? null : { index, trigger });
                }}
              >
                <span className="uk-top">
                  <span className="uk-tags">{row.tags.join('・')}</span>
                  <span className="uk-dis">
                    打<Tile tile={row.tile} dora={isDoraTile(row.tile, dora)} />
                  </span>
                  <span className="uk-sh">{shantenTag(detail.shanten)}</span>
                  <span className="uk-n">
                    {detail.ukeire}枚{' '}
                    <span className="uk-rem">残り{detail.remaining}</span>
                  </span>
                  <span className="uk-more" aria-hidden="true">
                    <Icon name="chevronRight" className="chev" />
                  </span>
                </span>
                <span className="track" aria-hidden="true">
                  <span className="fill" style={{ width: `${width}%` }} />
                </span>
              </button>
            </li>
          );
        })}
      </ul>
      {box.takeaway !== '' && <p className="takeaway">{box.takeaway}</p>}
      <p className="quiet uk-hint" id="uk-hint">
        行を押すと、受け入れ牌と枚数・残りの一覧を開きます。
      </p>
      {box.anyWorse && <p className="quiet">シャンテン数が違う打牌は、受け入れ枚数では比べられません。</p>}
      <div className="uk-links">
        <a className="q-link" href={box.pairiUrl || tenhouPairiUrl(box.tiles)} target="_blank" rel="noopener noreferrer">
          天鳳牌理で見る
          <Icon name="external" />
        </a>
      </div>
      {open !== null && box.rows[open.index] !== undefined && (
        <Popover
          box={box}
          row={box.rows[open.index] as UkeireRow}
          mine={mine}
          dora={dora}
          trigger={open.trigger}
          initialTab="tiles"
          onClose={close}
        />
      )}
    </div>
  );
}
