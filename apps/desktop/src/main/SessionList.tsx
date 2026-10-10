import {
  Fragment,
  useEffect,
  useEffectEvent,
  useId,
  useImperativeHandle,
  useMemo,
  useRef,
  useState,
  type KeyboardEvent as ReactKeyboardEvent,
  type MouseEvent as ReactMouseEvent,
  type Ref,
} from 'react';

import { GradeBadge } from './GradeBadge';
import { Icon } from './Icon';
import { Popup, type PopupItem } from './Popup';
import {
  NO_FILTER,
  STAGES,
  clockLabel,
  dayLabel,
  filterRows,
  filterSummary,
  groupByDay,
  isFiltering,
  stageOption,
  type ListFilter,
} from './sessionFilter';
import type { ListRow } from './sessionRows';
import { useShortcutsBlocked } from './undo/shortcutGuard';
import { isTextEntryTarget } from './undo/UndoProvider';

/**
 * サイドバーの半荘の一覧（U-8・U-9・U-12、R7-1・R8-3・R8-5）。
 * 見出し「半荘」と「選択」・検索欄と「段階」・絞り込みの件数と「解除」・日付ごとの行。行は、開始時刻・段階と Rating
 * （取り込む前は「取り込み前」）・迷いの数。行の「…」のメニュー（開く・削除）と、「選択」で複数を選んでまとめて消す操作もここ。
 *
 * 検索の語・段階・選択は、この部品の中で持つ（サイドバーは、どの画面でも出ているので、語や選択は画面を移っても残る）。
 * 削除そのものは、確認も取り消しも呼ぶ側（検討画面）が受け持つ。ここは「消したい」と頼むだけ（`onRequestDelete`）。
 */

export interface SessionListHandle {
  /** 削除が済んだあと: 選択をやめて、キーボードの位置を「選択」か検索欄へ戻す。戻す先があれば true。 */
  settleAfterDelete: () => boolean;
}

interface SessionListProps {
  /** すべての半荘（新しい順）。 */
  rows: readonly ListRow[];
  /** 「本日」「昨日」の基準。 */
  now: number;
  /** いま本文に出している半荘（印を付ける）。 */
  currentId: string | null;
  /** 640px 未満（アイコンだけの細い列）か。細い列では、選択と削除は出さない。 */
  narrow: boolean;
  /** 一覧を読み終えたか。読む前に「半荘がありません」と出さないため。 */
  loaded: boolean;
  /** 一覧を読めなかった理由。 */
  loadError: string | null;
  onOpen: (id: string) => void;
  /** 消したい半荘。`opener` は、確認を閉じたときにキーボードの位置を戻す先。 */
  onRequestDelete: (ids: string[], opener: HTMLElement | null) => void;
  /** 読み上げ用の欄に伝える。 */
  announce: (message: string) => void;
  ref?: Ref<SessionListHandle>;
}

type PopupState =
  | { kind: 'row'; id: string; anchor: HTMLElement }
  | { kind: 'stage'; anchor: HTMLElement };

type PendingFocus = 'master' | 'select' | 'search';

/** 行の「…」のラベルや、細い列の説明に使う、半荘の呼び名（「本日 19:09」）。 */
function rowName(row: ListRow, now: number): string {
  return `${dayLabel(row.startedMs, now)} ${clockLabel(row.startedMs)}`;
}

export function SessionList({
  rows,
  now,
  currentId,
  narrow,
  loaded,
  loadError,
  onOpen,
  onRequestDelete,
  announce,
  ref,
}: SessionListProps) {
  const [filter, setFilter] = useState<ListFilter>(NO_FILTER);
  const [selecting, setSelecting] = useState(false);
  const [selected, setSelected] = useState<ReadonlySet<string>>(() => new Set());
  const [popup, setPopup] = useState<PopupState | null>(null);
  const shortcutsBlocked = useShortcutsBlocked();

  const scrollRef = useRef<HTMLDivElement>(null);
  const searchRef = useRef<HTMLInputElement>(null);
  const stageRef = useRef<HTMLButtonElement>(null);
  const selectRef = useRef<HTMLButtonElement>(null);
  const masterRef = useRef<HTMLInputElement>(null);
  const deleteRef = useRef<HTMLButtonElement>(null);
  const listId = useId();
  const pendingFocus = useRef<PendingFocus | null>(null);

  // 細い列では、選択の欄は出さない（広げたら、選んでいたものが残っている）。
  const selectMode = selecting && !narrow;
  const visible = useMemo(() => filterRows(rows, filter, now), [rows, filter, now]);
  const groups = useMemo(() => groupByDay(visible, now), [visible, now]);
  // 見えていない半荘は、選んだことにしない（見えない半荘を消さないため）。
  const selectedIds = useMemo(() => visible.filter((row) => selected.has(row.id)).map((row) => row.id), [visible, selected]);
  const filterOn = rows.length > 0 && isFiltering(filter);

  // キーボードの位置を戻す先は、描き直したあとに決まる（「選択」の欄が、描き直しで現れるため）。
  useEffect(() => {
    const target = pendingFocus.current;
    if (target === null) return;
    pendingFocus.current = null;
    (target === 'master' ? masterRef.current : target === 'select' ? selectRef.current : searchRef.current)?.focus();
  });

  // 一部だけ選んでいるときの、チェックの「半分」の印。
  useEffect(() => {
    if (masterRef.current) {
      masterRef.current.indeterminate = selectedIds.length > 0 && selectedIds.length < visible.length;
    }
  });

  // 戻る・進むで本文の半荘が変わったとき、一覧の中の見える所へ動かす（貼り付く日付の見出しの分を空ける）。
  useEffect(() => {
    const list = scrollRef.current;
    const current = list?.querySelector<HTMLElement>('[aria-current="true"]');
    if (!list || !current) return;
    const item = current.closest('.s-item') ?? current;
    const listRect = list.getBoundingClientRect();
    const rect = item.getBoundingClientRect();
    const sticky = 34;
    if (rect.top < listRect.top + sticky) list.scrollTop -= listRect.top + sticky - rect.top;
    else if (rect.bottom > listRect.bottom) list.scrollTop += rect.bottom - listRect.bottom;
  }, [currentId]);

  useImperativeHandle(
    ref,
    () => ({
      settleAfterDelete: () => {
        setSelecting(false);
        setSelected(new Set());
        // 絞り込みの欄があるのは、半荘が 1 つでも残っているとき。
        if (visible.length > 0) pendingFocus.current = 'select';
        else if (rows.length > 0) pendingFocus.current = 'search';
        return rows.length > 0;
      },
    }),
    [visible.length, rows.length],
  );

  // ---- 絞り込み ----

  const changeFilter = (next: ListFilter) => {
    setFilter(next);
    const nextVisible = filterRows(rows, next, now);
    // 見えなくなった行の選択は外す（見えない半荘を消さないため）。
    setSelected((previous) => {
      if (previous.size === 0) return previous;
      const showing = new Set(nextVisible.map((row) => row.id));
      const kept = [...previous].filter((id) => showing.has(id));
      return kept.length === previous.size ? previous : new Set(kept);
    });
    announce(isFiltering(next) ? filterSummary(next, nextVisible.length) : '絞り込みを解除しました');
  };

  const clearAll = () => {
    changeFilter(NO_FILTER);
    searchRef.current?.focus();
  };

  const clearQuery = () => changeFilter({ ...filter, query: '' });

  const onSearchKeyDown = (event: ReactKeyboardEvent<HTMLInputElement>) => {
    // 日本語の変換中の Esc・↓ は、変換のためのもの。
    if (event.nativeEvent.isComposing) return;
    if (event.key === 'Escape' && filter.query !== '') {
      event.preventDefault();
      event.stopPropagation();
      clearQuery();
    } else if (event.key === 'ArrowDown') {
      const first = scrollRef.current?.querySelector<HTMLElement>('[data-open], .s-cb');
      if (first) {
        event.preventDefault();
        first.focus();
      }
    }
  };

  // ---- 選択 ----

  const enterSelect = () => {
    setSelecting(true);
    setSelected(new Set());
    pendingFocus.current = 'master';
  };

  const exitSelect = (focusBack: boolean) => {
    setSelecting(false);
    setSelected(new Set());
    if (focusBack) pendingFocus.current = 'select';
  };

  const selectAll = (on: boolean) => {
    setSelected(on ? new Set(visible.map((row) => row.id)) : new Set());
    announce(`${on ? visible.length : 0}件を選択中`);
  };

  const toggleRow = (id: string, on: boolean) => {
    const next = new Set(selectedIds);
    if (on) next.add(id);
    else next.delete(id);
    setSelected(next);
    announce(`${next.size}件を選択中`);
  };

  // 確認を取り消したら、キーボードの位置は「削除」のボタンに戻る。
  const askDelete = () => {
    if (selectedIds.length > 0) onRequestDelete(selectedIds, deleteRef.current);
  };

  // 選択の間のキー: Esc で選択をやめる・Ctrl+A ですべて選ぶ・Delete で消す。文字を打つ欄にいる間・メニューやダイアログが開いている間は、動かさない。
  const onSelectKey = useEffectEvent((event: KeyboardEvent) => {
    if (shortcutsBlocked() || isTextEntryTarget(event.target) || event.isComposing) return;
    if (event.key === 'Escape') {
      event.preventDefault();
      exitSelect(true);
    } else if ((event.ctrlKey || event.metaKey) && !event.altKey && (event.key === 'a' || event.key === 'A')) {
      event.preventDefault();
      selectAll(true);
    } else if (event.key === 'Delete' && selectedIds.length > 0) {
      event.preventDefault();
      onRequestDelete(selectedIds, deleteRef.current);
    }
  });
  useEffect(() => {
    if (!selectMode) return undefined;
    const handler = (event: KeyboardEvent) => onSelectKey(event);
    document.addEventListener('keydown', handler);
    return () => document.removeEventListener('keydown', handler);
  }, [selectMode]);

  // ---- 行の操作 ----

  const focusRow = (id: string) => {
    // 半荘の名前は、英数字と - だけ（保存先の決まり）。そのまま、属性の値に使える。
    document.querySelector<HTMLElement>(`.session-scroll [data-open="${id}"]`)?.focus();
  };

  const openRowMenu = (id: string, anchor: HTMLElement) => setPopup({ kind: 'row', id, anchor });

  const onListClick = (event: ReactMouseEvent<HTMLDivElement>) => {
    const target = event.target as HTMLElement;
    const more = target.closest<HTMLElement>('[data-more]');
    if (more) {
      const id = more.getAttribute('data-more') ?? '';
      if (popup?.kind === 'row' && popup.id === id) setPopup(null);
      else openRowMenu(id, more);
      return;
    }
    const open = target.closest<HTMLElement>('[data-open]');
    if (open) onOpen(open.getAttribute('data-open') ?? '');
  };

  // 右クリック・Menu キー・Shift+F10 でも、行のメニューを開く。
  const onListContextMenu = (event: ReactMouseEvent<HTMLDivElement>) => {
    const item = (event.target as HTMLElement).closest<HTMLElement>('.s-item');
    const anchor =
      item?.querySelector<HTMLElement>('[data-more]') ?? item?.querySelector<HTMLElement>('[data-open]');
    const id = item?.getAttribute('data-id');
    if (!item || !anchor || !id || selectMode) return;
    event.preventDefault();
    openRowMenu(id, anchor);
  };

  // 矢印で行から行へ。→ で行の「…」、← で行へ戻る（Tab でも全部に届く）。Alt が付くものは履歴の操作なので触らない。
  const onListKeyDown = (event: ReactKeyboardEvent<HTMLDivElement>) => {
    if (event.altKey || event.ctrlKey || event.metaKey || event.shiftKey) return;
    const target = event.target as HTMLElement;
    const kind = target.hasAttribute('data-open')
      ? '[data-open]'
      : target.hasAttribute('data-more')
        ? '[data-more]'
        : target.classList.contains('s-cb')
          ? '.s-cb'
          : null;
    if (kind === null) return;
    if (event.key === 'ArrowDown' || event.key === 'ArrowUp') {
      const all = Array.from(scrollRef.current?.querySelectorAll<HTMLElement>(kind) ?? []);
      const next = all[all.indexOf(target) + (event.key === 'ArrowDown' ? 1 : -1)];
      if (next) {
        event.preventDefault();
        next.focus();
      }
    } else if (event.key === 'ArrowRight' && kind === '[data-open]') {
      const more = target.closest('.s-item')?.querySelector<HTMLElement>('[data-more]');
      if (more) {
        event.preventDefault();
        more.focus();
      }
    } else if (event.key === 'ArrowLeft' && kind === '[data-more]') {
      const open = target.closest('.s-item')?.querySelector<HTMLElement>('[data-open]');
      if (open) {
        event.preventDefault();
        open.focus();
      }
    }
  };

  // ---- メニュー ----

  const closePopup = () => setPopup(null);

  const rowMenuItems = (id: string, anchor: HTMLElement): PopupItem[] => [
    {
      kind: 'item',
      key: 'open',
      label: '開く',
      onSelect: () => {
        onOpen(id);
        focusRow(id);
      },
    },
    { kind: 'separator', key: 'sep' },
    { kind: 'item', key: 'delete', label: '削除', onSelect: () => onRequestDelete([id], anchor) },
  ];

  const stageMenuItems = (): PopupItem[] =>
    STAGES.map((stage) => ({
      kind: 'radio',
      key: stage.id,
      label: stage.label,
      hint: stage.range,
      checked: filter.stage === stage.id,
      onSelect: () => {
        changeFilter({ ...filter, stage: stage.id });
        stageRef.current?.focus();
      },
    }));

  // ---- 描く ----

  const empty = rows.length === 0;
  const stage = stageOption(filter.stage);

  return (
    <nav className="sessions" aria-label="半荘の一覧">
      {!selectMode && (
        <div className="list-head">
          <h2 className="sec-title">半荘</h2>
          {visible.length > 0 && (
            <button type="button" className="link-btn" ref={selectRef} onClick={enterSelect}>
              選択
            </button>
          )}
        </div>
      )}
      {selectMode && (
        <div className="selbar" role="group" aria-label="半荘を選択">
          <div className="selbar-top">
            <input
              type="checkbox"
              className="s-cb"
              ref={masterRef}
              aria-label="表示中の半荘をすべて選択"
              title="すべて選択"
              checked={visible.length > 0 && selectedIds.length === visible.length}
              onChange={(event) => selectAll(event.target.checked)}
            />
            <span className="selbar-n">{selectedIds.length}件を選択中</span>
          </div>
          <div className="selbar-act">
            <button
              type="button"
              className="btn sm danger"
              ref={deleteRef}
              aria-keyshortcuts="Delete"
              disabled={selectedIds.length === 0}
              onClick={askDelete}
            >
              削除
            </button>
            <button type="button" className="btn sm" onClick={() => exitSelect(true)}>
              キャンセル
            </button>
          </div>
        </div>
      )}
      {!empty && (
        <div className="filter" role="search">
          <div className={filter.query === '' ? 'search' : 'search has-clear'}>
            <Icon name="search" className="search-ic" />
            <input
              type="search"
              className="search-in"
              placeholder="日付・卓・メモ"
              aria-label="半荘を検索（日付・卓・メモ）"
              autoComplete="off"
              spellCheck={false}
              ref={searchRef}
              value={filter.query}
              onChange={(event) => changeFilter({ ...filter, query: event.target.value })}
              onKeyDown={onSearchKeyDown}
            />
            {filter.query !== '' && (
              <button
                type="button"
                className="search-x"
                aria-label="検索語を消す"
                onClick={() => {
                  clearQuery();
                  searchRef.current?.focus();
                }}
              >
                <Icon name="close" />
              </button>
            )}
          </div>
          <button
            type="button"
            className="btn sm stage-btn"
            ref={stageRef}
            data-on={filter.stage !== 'all'}
            aria-haspopup="menu"
            aria-expanded={popup?.kind === 'stage'}
            aria-label={`段階（${stage.label}）`}
            title="段階で絞り込む"
            onClick={(event) => {
              if (popup?.kind === 'stage') setPopup(null);
              else setPopup({ kind: 'stage', anchor: event.currentTarget });
            }}
          >
            <span>段階</span>
            <Icon name="chevronDown" className="stage-ic" />
          </button>
        </div>
      )}
      {filterOn && (
        <p className="fstat">
          <span>{filterSummary(filter, visible.length)}</span>
          <button type="button" className="link-btn" onClick={clearAll}>
            解除
          </button>
        </p>
      )}
      {/* 矢印・右クリックは、各行のボタンから上がってくる。ここは、それを受けるだけの入れ物 */}
      <div
        className="session-scroll"
        ref={scrollRef}
        role="presentation"
        onClick={onListClick}
        onContextMenu={onListContextMenu}
        onKeyDown={onListKeyDown}
      >
        {loadError !== null && (
          <p className="empty-note selectable" role="alert">
            {loadError}
          </p>
        )}
        {loadError === null && loaded && empty && <p className="empty-note">半荘がありません</p>}
        {!empty && visible.length === 0 && <p className="empty-note">一致する半荘がありません</p>}
        {groups.map((group) => (
          <section key={group.key} aria-labelledby={`${listId}-${group.key}`}>
            <h3 className="date-head" id={`${listId}-${group.key}`}>
              {group.label}
            </h3>
            <ul className="session-list">
              {group.rows.map((row) => (
                <li className="s-item" key={row.id} data-id={row.id}>
                  {selectMode ? (
                    <label className={selected.has(row.id) ? 'session-row srow is-sel' : 'session-row srow'}>
                      <input
                        type="checkbox"
                        className="s-cb"
                        checked={selected.has(row.id)}
                        onChange={(event) => toggleRow(row.id, event.target.checked)}
                      />
                      <RowContent row={row} />
                    </label>
                  ) : (
                    <>
                      <button
                        type="button"
                        className="session-row srow"
                        data-open={row.id}
                        aria-current={row.id === currentId ? 'true' : undefined}
                        title={narrow ? narrowTitle(row, now) : undefined}
                      >
                        <RowContent row={row} />
                      </button>
                      <button
                        type="button"
                        className="row-more"
                        data-more={row.id}
                        aria-haspopup="menu"
                        aria-expanded={popup?.kind === 'row' && popup.id === row.id}
                        aria-label={`${rowName(row, now)} の半荘のメニュー`}
                        title="メニュー"
                      >
                        <Icon name="more" />
                      </button>
                    </>
                  )}
                </li>
              ))}
            </ul>
          </section>
        ))}
      </div>
      {popup?.kind === 'row' && (
        <Popup label="半荘のメニュー" anchor={popup.anchor} items={rowMenuItems(popup.id, popup.anchor)} onClose={closePopup} />
      )}
      {popup?.kind === 'stage' && (
        <Popup label="段階で絞り込む" anchor={popup.anchor} items={stageMenuItems()} onClose={closePopup} />
      )}
    </nav>
  );
}

/** 細い列で、行にマウスを乗せたときの説明（時刻などは、画面には出ていない）。 */
function narrowTitle(row: ListRow, now: number): string {
  const score = row.grade !== null ? `${row.grade} ${row.ratingText ?? ''}`.trim() : row.status === 'none' ? '取り込み前' : '';
  const doubt = row.markCount > 0 ? ` 迷い${row.markCount}` : '';
  return `${rowName(row, now)} ${score}${doubt}`.trim();
}

/** 行の中身: 開始時刻・段階と Rating（取り込む前は「取り込み前」）・迷いの数。 */
function RowContent({ row }: { row: ListRow }) {
  return (
    <>
      <span className="s-time">{clockLabel(row.startedMs)}</span>{' '}
      <RowScore row={row} />{' '}
      {row.markCount > 0 && <span className="s-doubt">迷い{row.markCount}</span>}
    </>
  );
}

function RowScore({ row }: { row: ListRow }) {
  if (row.status === 'ready' && row.grade !== null) {
    return (
      <Fragment>
        <GradeBadge grade={row.grade} />{' '}
        <span className="s-rate">{row.ratingText}</span>
      </Fragment>
    );
  }
  if (row.status === 'none') {
    // 細い列では、文字は見えない所へ寄せて、点線の印だけを見せる（CSS）。
    return (
      <>
        <span className="s-pending">取り込み前</span>
        <span className="grade ghost narrow-only" aria-hidden="true" />
      </>
    );
  }
  return (
    <>
      <span className="grade ghost" aria-hidden="true" />
      <span className={row.status === 'loading' ? 's-pending sr-only' : 's-pending'}>
        {row.status === 'loading' ? '読み込み中' : row.status === 'unavailable' ? '結果を読めません' : '判断なし'}
      </span>
    </>
  );
}
