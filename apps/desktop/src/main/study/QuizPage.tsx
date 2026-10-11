/**
 * 出題の画面（今日の出題の 1 問、または、残りから追加で解く 1 問、解き直しの 1 問を直接開いたとき）。
 * 出題は、今日の組の何問目かを見出しに出し、答え合わせのあとは「次の問題へ」で、今日の次の問題に進む。
 * 組の最後（または組に入っていない問題）では、今日の出題に戻る。
 */
import type { AnswerMode, AnswerRow } from '../../api/types';
import { QuizScreen } from './QuizScreen';
import { StudyNotice } from './StudyNotice';
import { useStudy } from './StudyProvider';

interface QuizPageProps {
  sessionId: string;
  decisionKey: string;
  mode: AnswerMode;
  /** 今日の次の問題を開く。 */
  onOpen: (sessionId: string, key: string) => void;
  onToday: () => void;
  onReview: () => void;
}

/** その問題の、いちばん新しい答え（`mode` を渡せば、その種類の中で）。無ければ null。 */
export function latestAnswerFor(
  answers: readonly AnswerRow[],
  sessionId: string,
  key: string,
  mode?: AnswerMode,
): AnswerRow | null {
  let latest: AnswerRow | null = null;
  for (const row of answers) {
    if (row.session_id !== sessionId || row.decision_key !== key) continue;
    if (mode !== undefined && row.mode !== mode) continue;
    if (latest === null || row.answered_at >= latest.answered_at) latest = row;
  }
  return latest;
}

export function QuizPage({ sessionId, decisionKey, mode, onOpen, onToday, onReview }: QuizPageProps) {
  const study = useStudy();
  if (!study.ready) {
    return <StudyNotice title="出題">読み込み中です。</StudyNotice>;
  }
  const located = study.locate(sessionId, decisionKey);
  if (located === null) {
    return (
      <StudyNotice title="出題">
        この問題を開けませんでした。半荘を消したか、取り込んだ結果を読み出せなかったためです。
      </StudyNotice>
    );
  }

  const { today, problems } = study.model;
  const items = today.items;
  const index = items.findIndex((item) => item.problem.sessionId === sessionId && item.problem.key === decisionKey);
  const key = `${sessionId}/${decisionKey}/${mode}`;

  if (mode === 'review') {
    const latest = latestAnswerFor(study.answers, sessionId, decisionKey);
    return (
      <QuizScreen
        key={key}
        located={located}
        mode="review"
        kicker={<p className="kicker">解き直し</p>}
        markNumber={null}
        existing={null}
        previousIntervalDays={latest === null ? null : latest.interval_days}
        nextLabel="解き直しに戻る"
        onNext={onReview}
      />
    );
  }

  const inSet = index >= 0 ? items[index] : undefined;
  const problem = inSet?.problem ?? problems.find((p) => p.sessionId === sessionId && p.key === decisionKey) ?? null;
  const existing = inSet !== undefined ? inSet.answer : latestAnswerFor(study.answers, sessionId, decisionKey, 'quiz');
  // 今日の次の問題: いまの問題より後ろの、まだ答えていない問題。無ければ、前の側の答えていない問題
  const isOther = (_: unknown, at: number) => at !== index;
  const pending = items.map((item, at) => ({ item, at })).filter(({ item, at }) => item.answer === null && isOther(item, at));
  const nextItem = (pending.find(({ at }) => at > index) ?? pending[0])?.item;
  const openNext = () => {
    // 答えた直後の一覧を見る（画面の描き直しを待たずに、いまの答えの数で決める）
    if (nextItem === undefined) onToday();
    else onOpen(nextItem.problem.sessionId, nextItem.problem.key);
  };

  return (
    <QuizScreen
      key={key}
      located={located}
      mode="quiz"
      progress={index >= 0 ? { current: index + 1, total: items.length } : null}
      markNumber={problem?.markNumber ?? null}
      existing={existing}
      previousIntervalDays={null}
      nextLabel={nextItem === undefined ? '今日の出題に戻る' : '次の問題へ'}
      onNext={openNext}
    />
  );
}
