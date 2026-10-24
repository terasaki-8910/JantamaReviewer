/**
 * 今日の出題の一覧（U-15）。今日の組（保存してあるもの）の問題を、局・巡目・迷いの印・種類・向聴数・どの半荘かと
 * いっしょに並べ、解いた数と「続きから」を出す。今日の分のほかは「残り N問」に畳み、開けば、追加で解ける。
 * 結びつけが決まっていない迷いがあれば、その数と、半荘のページで決めると入ることを出す。
 * 解決した問題（F16）は、「解決」の札を付けて薄くする（押せば開ける）。「続きから」と、サイドバーの数には数えない。
 * 答えるまで、AI の情報は何も出さない（並べ替えの確率も、ここには出さない。U-1）。
 */
import { shantenTag, type Problem } from '@jantama/engine';
import type { CSSProperties } from 'react';

import { Icon } from '../Icon';
import { formatSessionShort } from '../format';
import { KIND_NAME, formatMonthDayOfMs } from './labels';
import { StudyNotice } from './StudyNotice';
import { useStudy } from './StudyProvider';
import type { TodayItem } from './studyModel';

interface TodayPageProps {
  /** 問題を開く（半荘の名前と判断の鍵）。 */
  onOpen: (sessionId: string, key: string) => void;
}

interface RowProps {
  n: number;
  problem: Problem;
  answered: boolean;
  /** 解決した問題か（F16）。 */
  resolved: boolean;
  next: boolean;
  onOpen: TodayPageProps['onOpen'];
}

function ProblemRow({ n, problem, answered, resolved, next, onOpen }: RowProps) {
  const { decision } = problem;
  return (
    <li>
      <button
        type="button"
        className={`qrow${answered ? ' done' : ''}${next ? ' next' : ''}${resolved ? ' resolved' : ''}`}
        data-resolved={resolved ? '1' : undefined}
        onClick={() => onOpen(problem.sessionId, problem.key)}
      >
        <span className="no">{n}</span>
        <span className="main-l">
          <span className="l1">
            <span className="t">
              {decision.kyokuLabel} {decision.junme}巡目
            </span>
            {problem.markNumber !== null && <span className="q-tag doubt">迷い{problem.markNumber}</span>}
          </span>
          <span className="l2">
            {KIND_NAME[decision.kind]} · {shantenTag(decision.shanten)} · <span className="nw">{formatSessionShort(problem.startedMs)} の半荘</span>
          </span>
        </span>
        <span className="st">
          {resolved && (
            <span className="st-resolved">
              <Icon name="check" />
              解決
            </span>
          )}
          {answered ? (
            <>
              <Icon name="check" />
              解答済み
            </>
          ) : next ? (
            '次はここから'
          ) : null}
        </span>
      </button>
    </li>
  );
}

/** 組の説明の 1 行（どの半荘から何問か）。 */
function ruleLine(items: readonly TodayItem[], sessionCount: number): string {
  const days = new Set(items.map((item) => formatMonthDayOfMs(item.problem.startedMs)));
  const [day] = [...days];
  const where =
    days.size === 1 && day !== undefined
      ? `${day}の${sessionCount === 1 ? '' : `${sessionCount}つの`}半荘`
      : `${sessionCount}つの半荘`;
  return `${where}から${items.length}問。細かいミス（迷ったうえで実戦が AI の1位と違った局面）を先に、次にほかの迷い、AI との差が大きい順の大きな不一致、最後に拮抗した局面を入れています。1日に出す数は設定で変えられます。`;
}

export function TodayPage({ onOpen }: TodayPageProps) {
  const study = useStudy();
  if (!study.ready) {
    return study.error === null ? (
      <StudyNotice title="今日の出題">読み込み中です。</StudyNotice>
    ) : (
      <StudyNotice title="今日の出題" alert>
        答えの記録を読めませんでした: {study.error}
      </StudyNotice>
    );
  }
  const { today } = study.model;
  const { items, answered, resolvedOnly, rest, undecidedMarks } = today;
  if (items.length === 0 && rest.length === 0) {
    return (
      <>
        <StudyNotice title="今日の出題">
          出す問題がありません。検討結果を取り込んだ半荘に、AIとの差が大きい局面や、迷いに結びついた局面があると、ここに出ます。
        </StudyNotice>
        {undecidedMarks > 0 && <UndecidedNote count={undecidedMarks} />}
      </>
    );
  }
  // 続きは、まだ答えていない、解決していない問題から。答えないまま解決した問題は、進み具合の分母にも入れない（解決は、もう出さない印）
  const firstUnanswered = items.findIndex((item) => item.answer === null && !item.resolved);
  const total = items.length - resolvedOnly;
  return (
    <>
      <header className="head qhead">
        <div className="q-main">
          <div className="q-l">
            <h1 className="title">今日の出題</h1>
          </div>
        </div>
      </header>
      <div className="page">
        <div className="q-top">
          <div className="q-prog">
            <div className="nums">
              <b>{answered}</b> / {total} 問を解きました
              {resolvedOnly > 0 && <span className="q-resolved-n">（解決 {resolvedOnly}問を除く）</span>}
            </div>
            <div className="track" aria-hidden="true">
              <span className="fill" style={{ '--p': total === 0 ? 0 : (answered / total).toFixed(3) } as CSSProperties} />
            </div>
          </div>
          {firstUnanswered >= 0 && (
            <button
              type="button"
              className="btn primary lg"
              onClick={() => {
                const item = items[firstUnanswered];
                if (item !== undefined) onOpen(item.problem.sessionId, item.problem.key);
              }}
            >
              {answered > 0 ? `続きから（${firstUnanswered + 1}問目）` : '出題を始める'}
            </button>
          )}
        </div>
        {/* 一覧と説明は、組に問題があるかぎり出す（全部を答えないまま解決しても、「解決」の札を付けた行を残し、開いて解決を切れるように） */}
        {items.length > 0 && <p className="q-rule">{ruleLine(items, today.sessionCount)}</p>}
        {items.length > 0 && (
          <ol className="qlist" aria-label="今日の出題">
            {items.map((item, index) => (
              <ProblemRow
                key={`${item.problem.sessionId}/${item.problem.key}`}
                n={index + 1}
                problem={item.problem}
                answered={item.answer !== null}
                resolved={item.resolved}
                next={answered > 0 && index === firstUnanswered}
                onOpen={onOpen}
              />
            ))}
          </ol>
        )}
        {rest.length > 0 && (
          <details className="qrest">
            <summary>
              <Icon name="chevronRight" className="chev" />
              残り{rest.length}問
            </summary>
            <ol className="qlist" aria-label="残りの出題">
              {rest.map((problem, index) => (
                <ProblemRow
                  key={`${problem.sessionId}/${problem.key}`}
                  n={items.length + index + 1}
                  problem={problem}
                  answered={false}
                  resolved={false}
                  next={false}
                  onOpen={onOpen}
                />
              ))}
            </ol>
          </details>
        )}
        {undecidedMarks > 0 && <UndecidedNote count={undecidedMarks} />}
      </div>
    </>
  );
}

function UndecidedNote({ count }: { count: number }) {
  return (
    <p className="q-note">
      <Icon name="info" />
      <span>迷い{count}件は、どの局面か決まっていません。半荘のページで選ぶと、ここに入ります。</span>
    </p>
  );
}
