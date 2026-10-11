/**
 * 検討ログ（F5、U-29）。答えた問題を 1 行ずつ。上に、絞り込み（期間・種類・局面・原因・結果。1 行に並べる）と、要約の 1 行、
 * 「答えを出す」。行には、答えた日・局と巡目・半荘・種類と印・正解か・差の原因・学んだ原則・答えるまでの時間と選び直し・
 * 次の解き直しの日と、その場面の手牌（R11-11。プレビュー）を出す。行を押す（Enter）と、その問題を保存した答えで開く。
 *
 * 自分・実戦・AI の1位の欄は、「答えを出す」を入れたときだけ DOM に置く（既定は切。あとで解き直すときに答えが見えないように）。
 * 手牌と、正解か不正解かは、答えそのものではないので、いつも出す。
 */
import { useEffect, useMemo, type ReactNode } from 'react';

import type { AnswerMode } from '../../api/types';
import { Icon } from '../Icon';
import { MenuSelect, type MenuSelectItem } from '../MenuSelect';
import { formatElapsed, formatMonthDay } from '../study/labels';
import { StudyNotice } from '../study/StudyNotice';
import { useStudy } from '../study/StudyProvider';
import { HandPreview } from './HandPreview';
import {
  CAUSE_OPTIONS,
  KIND_CHOICES,
  PERIOD_CHOICES,
  PHASE_CHOICES,
  RESULT_CHOICES,
  buildLogRows,
  filterRows,
  hasFilter,
  summarize,
  type LogFilter,
  type LogRow,
  type LogSummary,
} from './logModel';
import type { LogState } from './useLogState';

const MODE_NAME: Readonly<Record<AnswerMode, string>> = { quiz: '出題', review: '解き直し' };

interface LogPageProps {
  state: LogState;
  /** 問題を、保存した答えで開く（半荘の名前・判断の鍵・最後の答えの種類）。 */
  onOpen: (sessionId: string, key: string, mode: AnswerMode) => void;
}

// ---- 絞り込み ----

type MultiGroup = 'kinds' | 'phases' | 'causes' | 'results';

interface GroupDef {
  id: MultiGroup;
  label: string;
  /** 選択肢（id と画面の文字）。 */
  choices: ReadonlyArray<{ id: string; label: string }>;
  /** 行が、その選択肢に当たるか。 */
  has: (row: LogRow, id: string) => boolean;
}

const GROUPS: readonly GroupDef[] = [
  { id: 'kinds', label: '種類', choices: KIND_CHOICES, has: (row, id) => row.kind === id },
  {
    id: 'phases',
    label: '局面',
    choices: PHASE_CHOICES.map((id) => ({ id, label: id })),
    has: (row, id) => (row.phases as readonly string[]).includes(id),
  },
  { id: 'causes', label: '原因', choices: CAUSE_OPTIONS, has: (row, id) => (row.causes as readonly string[]).includes(id) },
  {
    id: 'results',
    label: '結果',
    choices: RESULT_CHOICES,
    has: (row, id) => (row.correct ? 'correct' : 'wrong') === id,
  },
];

/** 選んでいる値の言い方: すべて・1 つならその名前・いくつかなら「2つ」。 */
function valueText(group: GroupDef, selected: readonly string[]): string {
  if (selected.length === 0) return 'すべて';
  if (selected.length === 1) return group.choices.find((c) => c.id === selected[0])?.label ?? 'すべて';
  return `${selected.length}つ`;
}

interface FiltersProps {
  rows: readonly LogRow[];
  state: LogState;
  today: string;
}

function Filters({ rows, state, today }: FiltersProps) {
  const { filter, setFilter, clearFilter } = state;
  const periodItems: MenuSelectItem[] = PERIOD_CHOICES.map((choice) => ({
    key: choice.id,
    label: choice.label,
    hint: `${filterRows(rows, { ...filter, period: choice.id }, today).length}問`,
    checked: filter.period === choice.id,
    onSelect: () => setFilter({ period: choice.id }),
  }));
  const periodLabel = PERIOD_CHOICES.find((choice) => choice.id === filter.period)?.label ?? '';
  return (
    <div className="lfilters" role="group" aria-label="絞り込み">
      <MenuSelect
        label={`期間 ${periodLabel}`}
        menuLabel="期間"
        className="btn sm lf"
        placement="start"
        items={periodItems}
      >
        <span className="lf-k">期間</span> <span className="lf-v">{periodLabel}</span>
        <Icon name="chevronDown" />
      </MenuSelect>
      {GROUPS.map((group) => {
        const selected: readonly string[] = filter[group.id];
        // その項目を選んだときの数: ほかの絞り込みをかけた行のうち、その選択肢に当たるもの
        const base = filterRows(rows, filter, today, group.id);
        const items: MenuSelectItem[] = group.choices.map((choice) => ({
          key: choice.id,
          label: choice.label,
          hint: String(base.filter((row) => group.has(row, choice.id)).length),
          checked: selected.includes(choice.id),
          onSelect: () => {
            const next = selected.includes(choice.id)
              ? selected.filter((id) => id !== choice.id)
              : [...selected, choice.id];
            // 並びは、メニューの並びのまま
            setFilter({ [group.id]: group.choices.map((c) => c.id).filter((id) => next.includes(id)) } as Partial<LogFilter>);
          },
        }));
        const value = valueText(group, selected);
        return (
          <MenuSelect
            key={group.id}
            label={`${group.label} ${value}`}
            menuLabel={group.label}
            className={`btn sm lf${selected.length > 0 ? ' on' : ''}`}
            placement="start"
            multiple
            items={items}
          >
            <span className="lf-k">{group.label}</span> <span className="lf-v">{value}</span>
            <Icon name="chevronDown" />
          </MenuSelect>
        );
      })}
      {hasFilter(filter) && (
        <button type="button" className="link-btn" onClick={() => clearFilter(filter.period)}>
          解除
        </button>
      )}
    </div>
  );
}

// ---- 要約 ----

/** 要約の 1 行。数は、行と同じ値（絞り込みのあとの行から）。 */
function SummaryLine({ summary }: { summary: LogSummary }): ReactNode {
  if (summary.count === 0 || summary.correctPercent === null || summary.averageSeconds === null) {
    return (
      <>
        <b>0</b>問
      </>
    );
  }
  return (
    <>
      <b>{summary.count}</b>問・正解 <b>{summary.correctPercent}</b>%・答えるまで 平均 <b>{formatElapsed(summary.averageSeconds)}</b>・選び直しあり{' '}
      <b>{summary.reselected}</b>問・MAKA と食い違い <b>{summary.makaDiffers}</b>問
    </>
  );
}

// ---- 行 ----

function RowItem({ row, showAnswers, today, onOpen }: { row: LogRow; showAnswers: boolean; today: string; onOpen: LogPageProps['onOpen'] }) {
  const next = row.nextDue <= today ? '今日' : formatMonthDay(row.nextDue);
  return (
    <li>
      <button type="button" className="lrow" data-problem={row.id} onClick={() => onOpen(row.sessionId, row.key, row.mode)}>
        <span className="l-when">
          <span className="l-date">{formatMonthDay(row.date)}</span>
          <span className="l-mode">{MODE_NAME[row.mode]}</span>
        </span>
        <span className="l-main">
          <span className="l-l1">
            <span className="l-t">{row.title}</span>
            <span className="q-tag">{row.kindName}</span>
            {row.tags.map((tag) => (
              <span className="q-tag" key={tag}>
                {tag}
              </span>
            ))}
            {row.markNumber !== null && <span className="q-tag doubt">迷い{row.markNumber}</span>}
            {row.makaDiffers && <span className="q-tag maka">MAKA と食い違い</span>}
          </span>
          <span className="l-l2">
            <span className="nw">{row.where}</span>
          </span>
          <HandPreview hand={row.hand} />
          {(row.causeLabels.length > 0 || row.principle !== '') && (
            <span className="l-l3">
              {row.causeLabels.map((label) => (
                <span className="lchip" key={label}>
                  {label}
                </span>
              ))}
              {row.principle !== '' && (
                <span className="l-pr">
                  <span className="l-prl">原則</span> {row.principle}
                </span>
              )}
            </span>
          )}
        </span>
        {showAnswers && (
          <span className="l-ans">
            <span className="l-a you">
              <span className="l-ak">自分</span> {row.you}
            </span>
            <span className="l-a act">
              <span className="l-ak">実戦</span> {row.actual}
            </span>
            <span className="l-a top">
              <span className="l-ak">AI の1位</span> {row.top}
            </span>
          </span>
        )}
        <span className="l-meta">
          <span className={`l-res ${row.correct ? 'ok' : 'ng'}`}>
            <Icon name={row.correct ? 'check' : 'close'} />
            {row.correct ? '正解' : '不正解'}
          </span>
          <span className="l-sub">
            <span className="l-time">
              答えるまで {formatElapsed(row.seconds)} · 選び直し {row.reselects}回
            </span>
            <span className="l-next">
              次の解き直し <b>{next}</b>
            </span>
          </span>
        </span>
      </button>
    </li>
  );
}

export function LogPage({ state, onOpen }: LogPageProps) {
  const study = useStudy();
  const { ready, answers, locate, studyDay, error } = study;
  const { problems } = study.model;
  const { filter, clearFilter, showAnswers, setShowAnswers } = state;
  const rows = useMemo(
    () => (ready ? buildLogRows({ answers, locate, problems }) : []),
    [ready, answers, locate, problems],
  );
  const shown = useMemo(() => filterRows(rows, filter, studyDay), [rows, filter, studyDay]);
  const summary = useMemo(() => summarize(shown), [shown]);

  // 問題を開いて戻ったとき、ログの見ていた位置に戻す（画面は、開いている間、消えるため）
  const { scroll } = state;
  useEffect(() => {
    if (scroll.current > 0) window.scrollTo(0, scroll.current);
    const remember = () => {
      scroll.current = window.scrollY;
    };
    window.addEventListener('scroll', remember, { passive: true });
    return () => window.removeEventListener('scroll', remember);
  }, [scroll, ready]);

  if (!ready) {
    return error === null ? (
      <StudyNotice title="ログ">読み込み中です。</StudyNotice>
    ) : (
      <StudyNotice title="ログ" alert>
        答えの記録を読めませんでした: {error}
      </StudyNotice>
    );
  }
  if (rows.length === 0) {
    return (
      <StudyNotice title="ログ">
        答えた問題がまだありません。今日の出題で答え合わせをすると、ここに並びます。
      </StudyNotice>
    );
  }
  return (
    <>
      <header className="head qhead">
        <div className="q-main">
          <div className="q-l">
            <h1 className="title">ログ</h1>
          </div>
        </div>
      </header>
      <div className="page">
        <Filters rows={rows} state={state} today={studyDay} />
        <div className="lbar">
          <p className="lsum" role="status">
            <SummaryLine summary={summary} />
          </p>
          <div className="lans">
            <label className="check">
              <input
                type="checkbox"
                checked={showAnswers}
                aria-describedby="log-answers-help"
                onChange={(event) => setShowAnswers(event.target.checked)}
              />
              答えを出す
            </label>
            <p className="quiet" id="log-answers-help">
              あとで解き直すときに答えが見えてしまわないよう、ふだんは隠します。
            </p>
          </div>
        </div>
        {shown.length > 0 ? (
          <ol className="llist" aria-label="答えた問題" data-ans={showAnswers ? 'on' : 'off'}>
            {shown.map((row) => (
              <RowItem key={row.id} row={row} showAnswers={showAnswers} today={studyDay} onOpen={onOpen} />
            ))}
          </ol>
        ) : (
          <div className="lempty">
            <p>この条件に合う問題はありません。</p>
            <button type="button" className="btn sm" onClick={() => clearFilter('all')}>
              絞り込みを解除
            </button>
          </div>
        )}
      </div>
    </>
  );
}
