/**
 * 出題の画面（`QuizScreen`）を、1 問だけ、取り込んだ半荘や保存先を使わずに動かすための道具（試験のデータで、画面の部品ではない）。
 * 答えの一覧は、本物の `StudyProvider` と同じく、記録・メモの保存で更新する（取り消しの積み重ねも本物）。
 */
import { findDecisionByKey, problemId, type Decision, type ImportedGame } from '@jantama/engine';
import { render } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { useRef, useState } from 'react';
import { vi, type Mock } from 'vitest';

import type { AnswerMode, AnswerNotes, AnswerRow, NewAnswer, SessionRecord } from '../src/api/types';
import { SettingsLinkProvider } from '../src/main/reads/settingsLink';
import { QuizScreen } from '../src/main/study/QuizScreen';
import { resolveCommand } from '../src/main/study/resolveEdits';
import { StudyProvider, type StudyValue } from '../src/main/study/StudyProvider';
import type { StudyModel } from '../src/main/study/studyModel';
import { UndoProvider, useUndo } from '../src/main/undo/UndoProvider';
import { answerRow, gameOf } from './fake-study';
import { seedSession, type ReportKey } from './fake-sessions';

const EMPTY_MODEL: StudyModel = {
  problems: [],
  today: { items: [], answered: 0, unanswered: 0, resolvedOnly: 0, rest: [], undecidedMarks: 0, sessionCount: 0 },
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
  /** 設定の「迷いだけを記録する」（F0、W-15）。既定は切（昔からの画面のまま）。 */
  doubtOnly?: boolean;
  markNumber?: number | null;
  progress?: { current: number; total: number } | null;
  nextLabel?: string;
  /** 答えの保存を差し替える（失敗させたいとき）。 */
  record?: (answer: NewAnswer) => Promise<AnswerRow>;
  /** 保存したメモの更新を差し替える。 */
  updateNotes?: (id: number, patch: Partial<AnswerNotes>) => Promise<void>;
  /** 半荘（迷いマーク・結びつけ・終局直後のメモを持たせたいとき）。既定は、迷いも評価も無い半荘。 */
  session?: SessionRecord;
  /** 最初から解決している局面の鍵（F16）。 */
  resolved?: readonly string[];
  /** 細かいミスの問題として開く（見出しに札が出る。F17）。 */
  fineMiss?: boolean;
  /** 設定の「解析のモデル」を開く関数（読みの案内の「設定を開く」。F23）。シェルの外では無い（既定は無し）。 */
  openModelSettings?: () => void;
}

export interface QuizProbe {
  /** 解決の保存の呼び出し（'on:鍵'・'off:鍵'）。 */
  resolveCalls: string[];
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

function Harness(props: HarnessProps) {
  return (
    <UndoProvider>
      <HarnessInner {...props} />
    </UndoProvider>
  );
}

function HarnessInner({ decision, imported, probe, ...options }: HarnessProps) {
  const undo = useUndo();
  const sessionId = (options.session ?? seedSession(0, { id: 'sess' }).session).id;
  const [resolvedKeys, setResolvedKeys] = useState<readonly string[]>(options.resolved ?? []);
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
    resolvedIds: new Set(resolvedKeys.map((key) => problemId({ sessionId, key }))),
    doubtOnly: options.doubtOnly ?? false,
    answers,
    model: EMPTY_MODEL,
    todayUnanswered: 0,
    dueCount: 0,
    locate: () => null,
    gameState: () => undefined,
    session: () => undefined,
    reloadSessions: async () => undefined,
    setResolved: async (_session, key, on) => {
      const before = resolvedKeys.includes(key);
      if (before === on) return;
      const api = {
        setResolved: async (_id: string, target: string, resolved: boolean) => {
          probe.resolveCalls.push(`${resolved ? 'on' : 'off'}:${target}`);
          setResolvedKeys((keys) => (resolved ? [...keys.filter((k) => k !== target), target] : keys.filter((k) => k !== target)));
        },
      };
      await undo.run(resolveCommand(api, async () => undefined, { sessionId, key, before, after: on }));
    },
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
    <StudyProvider value={value}>
      <SettingsLinkProvider value={options.openModelSettings ?? null}>
        <QuizScreen
          located={{ session: options.session ?? seedSession(0, { id: 'sess' }).session, game: imported, decision }}
          mode={options.mode ?? 'quiz'}
          progress={options.progress ?? null}
          markNumber={options.markNumber ?? null}
          fineMiss={options.fineMiss ?? false}
          badMove={options.fineMiss !== true && options.markNumber == null}
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
      </SettingsLinkProvider>
    </StudyProvider>
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
  const probe: QuizProbe = { resolveCalls: [], recorded: [], notes: [], onNext: vi.fn<() => void>() };
  const user = userEvent.setup();
  const view = render(<Harness decision={decision} imported={game(report)} probe={probe} {...options} />);
  return { user, probe, decision, ...view };
}
