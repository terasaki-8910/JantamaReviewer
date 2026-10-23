/**
 * 解き直し（U-17）。今日が期限（午前 4 時までは前の日）の問題を、期限の古い順に 1 問ずつ解く。
 * 見出しに「解き直し · 今日の期限 6問」と「1 / 6」。実戦の行動と AI の答えは、答え合わせまで画面にも DOM にも出さない。
 * 答え合わせで、正解か不正解かと、次の解き直しの日・間隔の変わり方を出す。
 * 答えると期限が先へ延びて、その問題は期限の一覧から外れるので、始めたときの並びで最後まで進む。
 */
import { problemId } from '@jantama/engine';
import { useState } from 'react';

import { formatMonthDay } from './labels';
import { QuizScreen } from './QuizScreen';
import { StudyNotice } from './StudyNotice';
import { useStudy } from './StudyProvider';
import type { DueEntry } from './studyModel';

/** `due` は、解き直しを開いたときの、今日が期限の問題。開いたときの並びで、最後まで進む（答えると、一覧から外れるため）。 */
function ReviewFlow({ due }: { due: readonly DueEntry[] }) {
  const study = useStudy();
  const [queue] = useState(due);
  const [index, setIndex] = useState(0);
  const entry = queue[index];
  // 次に出す問題の位置。開いたあとに解決した問題は飛ばす（始めたときの並びのまま、解決していない次の問題へ進む。F16）
  let nextAt = index + 1;
  while (nextAt < queue.length && study.resolvedIds.has(problemId(queue[nextAt] as DueEntry))) nextAt++;

  if (queue.length === 0) {
    const { nextDue } = study.model;
    return (
      <StudyNotice title="解き直し">
        今日が期限の解き直しはありません。
        {nextDue !== null && `次の解き直しは、${formatMonthDay(nextDue)}です。`}
      </StudyNotice>
    );
  }

  if (entry === undefined) {
    const ids = new Set(queue.map((item) => problemId(item)));
    // この解き直しで答えた分（それぞれの、いちばん新しい答え）
    const done = new Map<string, boolean>();
    for (const row of study.answers) {
      const id = problemId({ sessionId: row.session_id, key: row.decision_key });
      if (row.mode === 'review' && ids.has(id)) done.set(id, row.correct);
    }
    const correct = [...done.values()].filter(Boolean).length;
    const { nextDue } = study.model;
    return (
      <StudyNotice title="解き直し">
        今日の解き直しは、終わりました（{queue.length}問のうち、正解 {correct}問）。
        {nextDue !== null && `次の解き直しは、${formatMonthDay(nextDue)}です。`}
      </StudyNotice>
    );
  }

  return (
    <QuizScreen
      key={problemId(entry)}
      located={{ session: entry.session, game: entry.game, decision: entry.decision }}
      mode="review"
      kicker={
        <p className="kicker">
          解き直し<span aria-hidden="true"> · </span>今日の期限 <b>{queue.length}</b>問
        </p>
      }
      progress={{ current: index + 1, total: queue.length }}
      markNumber={null}
      existing={null}
      previousIntervalDays={entry.answer.interval_days}
      nextLabel={nextAt >= queue.length ? '解き直しを終える' : '次の問題へ'}
      onNext={() => setIndex(nextAt)}
    />
  );
}

export function ReviewPage() {
  const study = useStudy();
  if (!study.ready) {
    return study.error === null ? (
      <StudyNotice title="解き直し">読み込み中です。</StudyNotice>
    ) : (
      <StudyNotice title="解き直し" alert>
        答えの記録を読めませんでした: {study.error}
      </StudyNotice>
    );
  }
  return <ReviewFlow due={study.model.due} />;
}
