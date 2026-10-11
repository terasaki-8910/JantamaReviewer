/**
 * 出題の画面（`QuizScreen`）を、1 問だけ、取り込んだ半荘や保存先を使わずに動かすための道具（試験のデータで、画面の部品ではない）。
 * 答えの一覧は、本物の `StudyProvider` と同じく、記録・メモの保存で更新する（取り消しの積み重ねも本物）。
 */
import { findDecisionByKey, type Decision, type ImportedGame } from '@jantama/engine';
import { render } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { useRef, useState } from 'react';
import { vi, type Mock } from 'vitest';

import type { AnswerMode, AnswerNotes, AnswerRow, NewAnswer } from '../src/api/types';
import { QuizScreen } from '../src/main/study/QuizScreen';
import { StudyProvider, type StudyValue } from '../src/main/study/StudyProvider';
import type { StudyModel } from '../src/main/study/studyModel';
import { UndoProvider } from '../src/main/undo/UndoProvider';
import { answerRow, gameOf } from './fake-study';
import type { ReportKey } from './fake-sessions';

const EMPTY_MODEL: StudyModel = {
  problems: [],
  today: { items: [], answered: 0, unanswered: 0, rest: [], undecidedMarks: 0, sessionCount: 0 },
  due: [],
  nextDue: null,
};

export interface QuizOptions {
  report?: ReportKey;
  /** 判断の鍵。 */
  key?: string;
  /** 鍵の代わりに、条件で判断を探す。 */
  find?: (decision: Decision) => boolean;
  mode?: AnswerMode;
  existing?: AnswerRow | null;
  previousIntervalDays?: number | null;
  highlightDora?: boolean;
  markNumber?: number | null;
  progress?: { current: number; total: number } | null;
  nextLabel?: string;
  /** 答えの保存を差し替える（失敗させたいとき）。 */
  record?: (answer: NewAnswer) => Promise<AnswerRow>;
  /** 保存したメモの更新を差し替える。 */
  updateNotes?: (id: number, patch: Partial<AnswerNotes>) => Promise<void>;
}

export interface QuizProbe {
  recorded: NewAnswer[];
  /** メモの保存の呼び出し（答えの番号と、渡した欄）。 */
  notes: Array<{ id: number; patch: Partial<AnswerNotes> }>;
  onNext: Mock<() => void>;
}

const games = new Map<ReportKey, ImportedGame>();
export function game(report: ReportKey): ImportedGame {
  const found = games.get(report) ?? gameOf(report);
  games.set(report, found);
  return found;
}

/** 判断を探す。 */
export function decisionOf(report: ReportKey, options: { key?: string; find?: (decision: Decision) => boolean }): Decision {
  const imported = game(report);
  const decision =
    options.key !== undefined
      ? findDecisionByKey(imported, options.key)
      : options.find !== undefined
        ? imported.decisions.find(options.find)
        : undefined;
  if (decision === undefined) throw new Error(`判断が見つかりません: ${report} ${options.key ?? ''}`);
  return decision;
}

interface HarnessProps extends QuizOptions {
  decision: Decision;
  imported: ImportedGame;
  probe: QuizProbe;
}

function Harness({ decision, imported, probe, ...options }: HarnessProps) {
  const [answers, setAnswers] = useState<AnswerRow[]>(options.existing === null || options.existing === undefined ? [] : [options.existing]);
  const rows = useRef(answers);
  rows.current = answers;
  const nextId = useRef(100);

  const value: StudyValue = {
    ready: true,
    error: null,
    studyDay: '2026-10-09',
    threshold: 0.05,
    dailyCount: 5,
    highlightDora: options.highlightDora ?? false,
    answers,
    model: EMPTY_MODEL,
    todayUnanswered: 0,
    dueCount: 0,
    locate: () => null,
    gameState: () => undefined,
    session: () => undefined,
    recordAnswer: async (answer) => {
      probe.recorded.push(answer);
      const row =
        options.record !== undefined
          ? await options.record(answer)
          : answerRow({
              ...answer,
              id: nextId.current++,
              causes: answer.causes ?? [],
              principle: answer.principle ?? '',
              maka_move: answer.maka_move ?? null,
            });
      setAnswers((current) => [...current, row]);
      return row;
    },
    updateNotes: async (id, patch) => {
      probe.notes.push({ id, patch });
      await options.updateNotes?.(id, patch);
      const current = rows.current.find((row) => row.id === id);
      if (current === undefined) throw new Error(`答えが無い: ${id}`);
      const next: AnswerRow = { ...current, ...patch } as AnswerRow;
      setAnswers((all) => all.map((row) => (row.id === id ? next : row)));
      return next;
    },
  };

  return (
    <UndoProvider>
      <StudyProvider value={value}>
        <QuizScreen
          located={{ session: { id: 'sess', started_ms: 0 } as never, game: imported, decision }}
          mode={options.mode ?? 'quiz'}
          progress={options.progress ?? null}
          markNumber={options.markNumber ?? null}
          existing={options.existing ?? null}
          previousIntervalDays={options.previousIntervalDays ?? null}
          nextLabel={options.nextLabel ?? '次の問題へ'}
          onNext={probe.onNext}
          kicker={
            (options.mode ?? 'quiz') === 'review' ? (
              <p className="kicker">
                解き直し<span aria-hidden="true"> · </span>今日の期限 <b>6</b>問
              </p>
            ) : undefined
          }
        />
      </StudyProvider>
    </UndoProvider>
  );
}

/** 1 問を描く。 */
export function renderQuiz(options: QuizOptions = {}) {
  const report = options.report ?? 'fx1a';
  const lookup =
    options.key === undefined && options.find === undefined
      ? { key: 'k3h0e15' }
      : { ...(options.key !== undefined ? { key: options.key } : {}), ...(options.find !== undefined ? { find: options.find } : {}) };
  const decision = decisionOf(report, lookup);
  const probe: QuizProbe = { recorded: [], notes: [], onNext: vi.fn<() => void>() };
  const user = userEvent.setup();
  const view = render(<Harness decision={decision} imported={game(report)} probe={probe} {...options} />);
  return { user, probe, decision, ...view };
}
