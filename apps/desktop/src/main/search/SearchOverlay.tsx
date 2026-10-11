import {
  Fragment,
  useEffect,
  useEffectEvent,
  useId,
  useMemo,
  useRef,
  useState,
  type KeyboardEvent as ReactKeyboardEvent,
  type MouseEvent as ReactMouseEvent,
} from 'react';

import { GradeBadge } from '../GradeBadge';
import { Icon } from '../Icon';
import { MenuSelect } from '../MenuSelect';
import { clockLabel, normalize, STAGES, stageOption } from '../sessionFilter';
import type { ListRow } from '../sessionRows';
import type { SummaryMap } from '../sessionSummaries';
import { useStudy } from '../study/StudyProvider';
import { useShortcutBlocker } from '../undo/shortcutGuard';
import { splitHits } from './highlight';
import {
  FRESH_SEARCH,
  PERIODS,
  SORTS,
  buildSearchModel,
  dateHits,
  dateParts,
  hasAnyCondition,
  hasConditions,
  limitResult,
  matchedKyokus,
  periodLabel,
  runSearch,
  sortLabel,
  type GameEntry,
  type ProblemEntry,
  type SearchState,
} from './searchModel';

/**
 * 検索の重ね表示（U-22、R9-9、R10-5。承認済みの見本 round10-samples/search.html の移し）。
 * 検索のアイコンか Ctrl+K で、画面の上に重ねて開く。半荘と問題を日付・卓・局・メモで探し、種類・段階・期間・迷いあり・未解答で絞り、
 * 4 つの並べ方で並べる。↑ ↓ で行を選び（端では反対の端へ回る）、Enter か押下で開く。Esc・背景の押下・Ctrl+K・「Esc」の印で閉じる。
 *
 * - 開いている間は、裏の画面を操作できなくする（呼ぶ側が `inert` にする）。キーボードの位置は、この中を回る（Tab）。
 *   アプリのキー操作（Ctrl+Z・Alt+← など）は止める
 * - 検索欄は WAI-ARIA の combobox（行にキーボードの位置は移さず、`aria-activedescendant` で選んだ行を示す）
 * - 問題の行に、AI の候補・確率・順位は出さない。「AI との差が大きい順」は順番だけに使う（U-1、U-22）
 * - 閉じたあとのキーボードの位置の戻し先は、呼ぶ側が決める（裏の画面が `inert` でなくなってから戻すため）
 */
interface SearchOverlayProps {
  /** すべての半荘（新しい順。消した半荘は入っていない）。 */
  rows: readonly ListRow[];
  summaries: SummaryMap;
  /** 「本日」「昨日」の基準。 */
  now: number;
  onOpenGame: (sessionId: string) => void;
  onOpenProblem: (sessionId: string, key: string) => void;
  /** 閉じる。`opened` は、結果を開いて閉じたとき。 */
  onClose: (opened: boolean) => void;
}

type Entry = GameEntry | ProblemEntry;

/** 日本語の入力の変換中か（変換中の Enter・Esc・↑ ↓ は、変換のためのもの）。 */
function isComposing(event: ReactKeyboardEvent): boolean {
  return event.nativeEvent.isComposing || event.keyCode === 229;
}

/** 当たった文字に印（下線）を付けて出す。 */
function Hit({ text, terms }: { text: string; terms: readonly string[] }) {
  return (
    <>
      {splitHits(text, terms).map((segment, index) =>
        segment.hit ? (
          <mark className="hit" key={index}>
            {segment.text}
          </mark>
        ) : (
          <Fragment key={index}>{segment.text}</Fragment>
        ),
      )}
    </>
  );
}

/** 絞り込みの入・切のチップ（押すたびに切り替える）。 */
function ToggleChip({
  label,
  pressed,
  describedBy,
  onClick,
}: {
  label: string;
  pressed: boolean;
  describedBy?: string;
  onClick: () => void;
}) {
  return (
    <button type="button" className="fchip" aria-pressed={pressed} aria-describedby={describedBy} onClick={onClick}>
      <Icon name="check" className="chip-tick" />
      {label}
    </button>
  );
}

export function SearchOverlay({ rows, summaries, now, onOpenGame, onOpenProblem, onClose }: SearchOverlayProps) {
  const study = useStudy();
  useShortcutBlocker(true);
  const baseId = useId();
  const listId = `${baseId}-list`;
  const typeLabelId = `${baseId}-type`;
  const optionId = (index: number) => `${baseId}-o-${index}`;

  const [state, setState] = useState<SearchState>(FRESH_SEARCH);
  const [showAll, setShowAll] = useState(false);
  const [active, setActive] = useState(0);

  const dialogRef = useRef<HTMLDivElement>(null);
  const inputRef = useRef<HTMLInputElement>(null);
  const bodyRef = useRef<HTMLDivElement>(null);
  const pressedOnBackdrop = useRef(false);
  // キーで選びを動かしたときだけ、選んだ行が見える所まで、一覧を動かす（マウスを動かして選んだときは動かさない）
  const scrollToActive = useRef(false);

  const model = useMemo(
    () =>
      buildSearchModel({
        rows,
        summaries,
        problems: study.model.problems,
        problemsReady: study.ready,
        answers: study.answers,
        threshold: study.threshold,
        now,
      }),
    [rows, summaries, study.model.problems, study.ready, study.answers, study.threshold, now],
  );
  const result = useMemo(() => runSearch(model, state, now), [model, state, now]);
  const shown = useMemo(() => limitResult(result, showAll), [result, showAll]);
  const entries = useMemo<Entry[]>(() => [...shown.games, ...shown.problems], [shown]);
  const activeIndex = Math.min(active, entries.length - 1);
  const total = result.games.length + result.problems.length;

  // 開いたら、検索欄にキーボードの位置を移す。開いている間は、裏の画面をスクロールさせない。
  useEffect(() => {
    inputRef.current?.focus();
    document.body.classList.add('sx-open');
    return () => document.body.classList.remove('sx-open');
  }, []);

  // Esc で閉じる。Tab は、この中を回る（外へ出さない）。キーは、ページ全体で受ける（押した物が消えて、キーボードの位置が
  // どこにも無くなっても、Esc で閉じられるように）。メニューが開いているときの Esc は、メニューが先に受けて止める。
  const onDialogKey = useEffectEvent((event: KeyboardEvent) => {
    if (event.key === 'Escape') {
      if (event.isComposing || event.keyCode === 229) return;
      event.preventDefault();
      event.stopPropagation();
      onClose(false);
      return;
    }
    if (event.key !== 'Tab') return;
    const dialog = dialogRef.current;
    const order = Array.from(
      dialog?.querySelectorAll<HTMLElement>('button:not([disabled]), input:not([disabled]), [tabindex="0"]') ?? [],
    );
    const first = order[0];
    const last = order.at(-1);
    if (first === undefined || last === undefined) return;
    const current = document.activeElement;
    if (event.shiftKey && (current === first || current === dialog)) {
      event.preventDefault();
      last.focus();
    } else if (!event.shiftKey && current === last) {
      event.preventDefault();
      first.focus();
    }
  });
  useEffect(() => {
    const handler = (event: KeyboardEvent) => onDialogKey(event);
    document.addEventListener('keydown', handler);
    return () => document.removeEventListener('keydown', handler);
  }, []);

  useEffect(() => {
    if (!scrollToActive.current) return;
    scrollToActive.current = false;
    bodyRef.current?.querySelector('[aria-selected="true"]')?.scrollIntoView?.({ block: 'nearest' });
  }, [activeIndex]);

  const update = (patch: Partial<SearchState>) => {
    setState((current) => ({ ...current, ...patch }));
    setActive(0);
  };

  const changeQuery = (query: string) => {
    update({ query });
    setShowAll(false);
  };

  // 「条件を解除」は、押すと消える。キーボードの位置が失われないよう、検索欄へ移す。
  const clearConditions = () => {
    update({ games: false, problems: false, stage: 'all', period: 'all', doubt: false, todo: false });
    inputRef.current?.focus();
  };

  const resetAll = () => {
    setState(FRESH_SEARCH);
    setShowAll(false);
    setActive(0);
    inputRef.current?.focus();
  };

  const openEntry = (entry: Entry) => {
    onClose(true);
    if (entry.type === 'game') onOpenGame(entry.id);
    else onOpenProblem(entry.sessionId, entry.key);
  };

  // ---- キー ----

  const move = (to: (current: number, count: number) => number) => {
    if (entries.length === 0) return;
    const next = to(activeIndex, entries.length);
    if (next === activeIndex) return;
    scrollToActive.current = true;
    setActive(next);
  };

  const onInputKeyDown = (event: ReactKeyboardEvent<HTMLInputElement>) => {
    if (isComposing(event)) return;
    if (event.key === 'ArrowDown' || event.key === 'ArrowUp') {
      event.preventDefault();
      const step = event.key === 'ArrowDown' ? 1 : -1;
      move((current, count) => (current + step + count) % count);
    } else if (event.key === 'Home' && event.ctrlKey) {
      event.preventDefault();
      move(() => 0);
    } else if (event.key === 'End' && event.ctrlKey) {
      event.preventDefault();
      move((_current, count) => count - 1);
    } else if (event.key === 'Enter') {
      const entry = entries[activeIndex];
      if (entry !== undefined) {
        event.preventDefault();
        openEntry(entry);
      }
    }
  };

  // ---- マウス（一覧の行。キーボードの位置は検索欄から動かさない） ----

  const rowAt = (event: ReactMouseEvent): { index: number; entry: Entry } | null => {
    const target = event.target;
    if (!(target instanceof Element)) return null;
    const index = Number(target.closest<HTMLElement>('[data-i]')?.dataset.i);
    const entry = entries[index];
    return Number.isInteger(index) && entry !== undefined ? { index, entry } : null;
  };

  const onListMouseMove = (event: ReactMouseEvent) => {
    const row = rowAt(event);
    if (row !== null && row.index !== activeIndex) setActive(row.index);
  };

  const onListClick = (event: ReactMouseEvent) => {
    const row = rowAt(event);
    if (row !== null) openEntry(row.entry);
  };

  // ---- 描く ----

  const stage = stageOption(state.stage);
  const problemsText = study.ready ? String(result.problems.length) : '読み込み中';
  const noRows = rows.length === 0 && !hasAnyCondition(state);

  return (
    <div
      className="sx-wrap"
      role="presentation"
      onMouseDown={(event) => {
        pressedOnBackdrop.current = event.target === event.currentTarget;
      }}
      onClick={(event) => {
        if (event.target === event.currentTarget && pressedOnBackdrop.current) onClose(false);
      }}
    >
      <div className="sx" role="dialog" aria-modal="true" aria-label="検索" tabIndex={-1} ref={dialogRef}>
        <div className="sx-top">
          <Icon name="search" />
          <input
            ref={inputRef}
            className="sx-in"
            type="search"
            role="combobox"
            aria-expanded={entries.length > 0}
            aria-controls={entries.length > 0 ? listId : undefined}
            aria-activedescendant={entries.length > 0 ? optionId(activeIndex) : undefined}
            aria-autocomplete="list"
            aria-haspopup="listbox"
            aria-label="半荘と問題を検索"
            placeholder="半荘・問題を探す（日付・卓・局・メモ）"
            autoComplete="off"
            spellCheck={false}
            value={state.query}
            onChange={(event) => changeQuery(event.target.value)}
            onKeyDown={onInputKeyDown}
          />
          {state.query !== '' && (
            <button
              type="button"
              className="sx-clear"
              aria-label="検索語を消す"
              onClick={() => {
                changeQuery('');
                inputRef.current?.focus();
              }}
            >
              <Icon name="close" />
            </button>
          )}
          <button
            type="button"
            className="sx-esc"
            aria-label="Esc で閉じる"
            title="Esc で閉じる"
            aria-keyshortcuts="Escape"
            onClick={() => onClose(false)}
          >
            Esc
          </button>
        </div>

        <div className="sx-filters" role="group" aria-label="絞り込み">
          <span className="sx-fl" id={typeLabelId}>
            種類
          </span>
          <ToggleChip label="半荘" pressed={state.games} describedBy={typeLabelId} onClick={() => update({ games: !state.games })} />
          <ToggleChip
            label="問題"
            pressed={state.problems}
            describedBy={typeLabelId}
            onClick={() => update({ problems: !state.problems })}
          />
          <MenuSelect
            label={`段階：${stage.label}`}
            menuLabel="段階で絞り込む"
            className={state.stage === 'all' ? 'fchip fsel' : 'fchip fsel is-on'}
            items={STAGES.map((option) => ({
              key: option.id,
              label: option.label,
              checked: state.stage === option.id,
              onSelect: () => update({ stage: option.id }),
            }))}
          >
            段階：{stage.label}
            <Icon name="chevronDown" />
          </MenuSelect>
          <MenuSelect
            label={`期間：${periodLabel(state.period)}`}
            menuLabel="期間で絞り込む"
            className={state.period === 'all' ? 'fchip fsel' : 'fchip fsel is-on'}
            items={PERIODS.map((option) => ({
              key: option.id,
              label: option.label,
              checked: state.period === option.id,
              onSelect: () => update({ period: option.id }),
            }))}
          >
            期間：{periodLabel(state.period)}
            <Icon name="chevronDown" />
          </MenuSelect>
          <ToggleChip label="迷いあり" pressed={state.doubt} onClick={() => update({ doubt: !state.doubt })} />
          <ToggleChip label="未解答" pressed={state.todo} onClick={() => update({ todo: !state.todo })} />
          <span className="sx-gap" />
          {hasConditions(state) && (
            <button type="button" className="link-btn sx-clearall" onClick={clearConditions}>
              条件を解除
            </button>
          )}
        </div>

        <div className="sx-sortbar">
          <span className="sx-count">
            半荘 <b>{result.games.length}</b> · 問題 <b>{problemsText}</b>
            {(shown.hidden > 0 || shown.collapsible) && (
              // 1 つのボタンで、名前と向きだけが変わる（押したあとも、キーボードの位置が、このボタンに残る）
              <button type="button" className="link-btn" onClick={() => setShowAll(shown.hidden > 0)}>
                {shown.hidden > 0 ? `すべて表示（あと${shown.hidden}件）` : '上位だけ表示'}
              </button>
            )}
          </span>
          <MenuSelect
            label={`並べ替え：${sortLabel(state.sort)}`}
            menuLabel="並べ替え"
            className="fchip fsel"
            items={SORTS.map((option) => ({
              key: option.id,
              label: option.label,
              checked: state.sort === option.id,
              onSelect: () => update({ sort: option.id }),
            }))}
          >
            並べ替え：{sortLabel(state.sort)}
            <Icon name="chevronDown" />
          </MenuSelect>
        </div>

        {/* 縦にあふれる領域は、キーボードで動かせるよう Tab の止まり場所にする（axe: scrollable-region-focusable） */}
        {/* eslint-disable-next-line jsx-a11y/no-noninteractive-tabindex -- 検索結果の欄は、矢印キーで送れるよう、止まり場所にする */}
        <div className="sx-body" tabIndex={0} ref={bodyRef}>
          {/* 行の選びと開く操作は、検索欄のキー（↑ ↓ Enter）でできる。ここは、マウスの押下を受けるだけの入れ物 */}
          <div
            role="presentation"
            onClick={onListClick}
            onMouseMove={onListMouseMove}
            onMouseDown={(event) => {
              // 行を押しても、キーボードの位置は検索欄から動かさない
              if (event.target instanceof Element && event.target.closest('[data-i]') !== null) event.preventDefault();
            }}
          >
            {entries.length > 0 ? (
              <ul className="sx-list" id={listId} role="listbox" aria-label="検索結果">
                {shown.games.length > 0 && <GroupHead name="半荘" count={result.games.length} />}
                {shown.games.map((game, offset) => (
                  <GameRow
                    key={game.id}
                    id={optionId(offset)}
                    index={offset}
                    selected={offset === activeIndex}
                    game={game}
                    terms={result.terms}
                    now={now}
                  />
                ))}
                {shown.problems.length > 0 && <GroupHead name="問題" count={result.problems.length} />}
                {shown.problems.map((problem, offset) => {
                  const index = shown.games.length + offset;
                  return (
                    <ProblemRow
                      key={`${problem.sessionId}/${problem.key}`}
                      id={optionId(index)}
                      index={index}
                      selected={index === activeIndex}
                      problem={problem}
                      terms={result.terms}
                      now={now}
                    />
                  );
                })}
              </ul>
            ) : (
              <Empty
                query={state.query}
                noRows={noRows}
                problemsLoading={!study.ready}
                onReset={resetAll}
              />
            )}
          </div>
        </div>

        <div className="sx-foot">
          <ul className="sx-keys" aria-label="キー操作">
            <li>
              <kbd>↑</kbd>
              <kbd>↓</kbd>選ぶ
            </li>
            <li>
              <kbd>Enter</kbd>開く
            </li>
            <li>
              <kbd>Esc</kbd>閉じる
            </li>
            <li>
              <kbd>Ctrl</kbd>
              <kbd>K</kbd>開く・閉じる
            </li>
          </ul>
        </div>
        <p className="sr-only" role="status" aria-live="polite">
          {total}件の結果
        </p>
      </div>
    </div>
  );
}

/** 「半荘 · 5件」「問題 · 20件」の見出し（読み上げには出さない。行の先頭に、種類の言葉がある）。 */
function GroupHead({ name, count }: { name: string; count: number }) {
  return (
    <li className="sx-gh" role="presentation" aria-hidden="true">
      <span>
        <b>{name}</b> · {count}件
      </span>
    </li>
  );
}

interface RowFrame {
  id: string;
  index: number;
  selected: boolean;
  terms: readonly string[];
  now: number;
}

/** 日付の当たりを印にするための、画面に出す文字にそのまま入れて探す語（「10/9」で「10月9日」に印を付ける）。 */
function dateTerms(startedMs: number, now: number, terms: readonly string[]): string[] {
  if (terms.length === 0) return [];
  const hits = dateHits(startedMs, now, terms);
  const parts = dateParts(startedMs, now);
  return [
    ...(hits.monthDay ? [normalize(parts.monthDay)] : []),
    ...(hits.relative && parts.relative !== null ? [normalize(parts.relative)] : []),
  ];
}

/** 半荘の段階と Rating（取り込み前などは、文字だけ）。 */
function GameScore({ row, terms }: { row: ListRow; terms: readonly string[] }) {
  if (row.status === 'ready' && row.grade !== null) {
    return (
      <>
        <GradeBadge grade={row.grade} />
        <span className="s-rate">
          <Hit text={row.ratingText ?? ''} terms={terms} />
        </span>
      </>
    );
  }
  const text =
    row.status === 'none'
      ? '取り込み前'
      : row.status === 'unavailable'
        ? '結果を読めません'
        : row.status === 'loading'
          ? '読み込み中'
          : '判断なし';
  return (
    <>
      <span className="grade ghost" aria-hidden="true" />
      <span className="s-pending">
        <Hit text={text} terms={terms} />
      </span>
    </>
  );
}

/** 局の名前で当たった半荘の行に添える、当たった局（3 つまで。残りは「ほか N局」）。 */
function kyokuNote(matched: readonly string[]): string {
  const rest = matched.length - 3;
  return `局: ${matched.slice(0, 3).join('、')}${rest > 0 ? ` ほか${rest}局` : ''}`;
}

function GameRow({ game, id, index, selected, terms, now }: RowFrame & { game: GameEntry }) {
  const { row } = game;
  const parts = dateParts(game.startedMs, now);
  const extra = dateTerms(game.startedMs, now, terms);
  const allTerms = [...terms, ...extra];
  // 2 行目: メモ（無ければ要約）。局の名前で当たったのに、2 行目に出ていないときは、当たった局を添える
  const sub = game.memo ?? game.summary;
  const matched = matchedKyokus(game, terms);
  const note = matched.length === 0 || matched.every((label) => sub.includes(label)) ? null : kyokuNote(matched);
  const problemInfo =
    row.status === 'none' || game.problemCount === null
      ? null
      : game.problemCount === 0
        ? '問題なし'
        : `問題 ${game.problemCount}${game.unanswered ? ` · 未解答 ${game.unanswered}` : ''}`;
  return (
    <li className="sx-row" role="option" id={id} aria-selected={selected} data-i={index}>
      <span className="sx-main">
        <span className="sr-only">半荘 </span>
        <span className="s-time">
          <Hit text={clockLabel(game.startedMs)} terms={terms} />
        </span>
        <GameScore row={row} terms={terms} />
        <span className="t">
          <Hit text={parts.relative === null ? parts.monthDay : `${parts.monthDay}（${parts.relative}）`} terms={allTerms} />
          {row.room !== null && (
            <>
              {' · '}
              <Hit text={row.room} terms={terms} />
            </>
          )}
        </span>
      </span>
      {(sub !== '' || note !== null) && (
        <span className="sx-sub">
          <Hit text={sub} terms={terms} />
          {note !== null && (
            <>
              {sub === '' ? '' : ' · '}
              <Hit text={note} terms={terms} />
            </>
          )}
        </span>
      )}
      <span className="sx-r">
        {row.markCount > 0 && (
          <span className="s-doubt">
            <Hit text={`迷い${row.markCount}`} terms={terms} />
          </span>
        )}
        {problemInfo !== null && <span>{problemInfo}</span>}
      </span>
    </li>
  );
}

function ProblemRow({ problem, id, index, selected, terms, now }: RowFrame & { problem: ProblemEntry }) {
  const extra = dateTerms(problem.game.startedMs, now, terms);
  const sub = `${problem.kindName} · ${problem.shanten} · ${problem.where}`;
  return (
    <li className="sx-row" role="option" id={id} aria-selected={selected} data-i={index}>
      <span className="sx-main">
        <span className="sr-only">問題 </span>
        <span className="t">
          <Hit text={problem.title} terms={terms} />
        </span>
        {problem.markNumber !== null && (
          <span className="q-tag doubt">
            <Hit text={`迷い${problem.markNumber}`} terms={terms} />
          </span>
        )}
      </span>
      <span className="sx-sub">
        <Hit text={sub} terms={[...terms, ...extra]} />
        {problem.principle !== null && (
          <>
            {' · 原則: '}
            <Hit text={problem.principle} terms={terms} />
          </>
        )}
      </span>
      <span className="sx-r">
        <span>
          <Hit text={problem.answered ? '解答済み' : '未解答'} terms={terms} />
        </span>
      </span>
    </li>
  );
}

/** 当たる行が無いときの案内（見本の r5-none.png）。 */
function Empty({
  query,
  noRows,
  problemsLoading,
  onReset,
}: {
  query: string;
  noRows: boolean;
  problemsLoading: boolean;
  onReset: () => void;
}) {
  if (noRows) {
    return (
      <div className="sx-empty">
        <p>まだ半荘がありません。</p>
        <p className="quiet">ウィジェットで記録するか、検討結果を取り込むと、ここで探せます。</p>
      </div>
    );
  }
  const text = query.trim();
  return (
    <div className="sx-empty">
      <p>
        <b>{text === '' ? 'この条件' : `「${text}」`}</b>に当てはまる半荘・問題はありません。
      </p>
      <p className="quiet">
        {problemsLoading ? '問題を読み込んでいます。読み終えると、問題も探せます。' : '検索語を短くするか、絞り込みを外してください。'}
      </p>
      <button type="button" className="btn sm" onClick={onReset}>
        検索語と条件を解除
      </button>
    </div>
  );
}
