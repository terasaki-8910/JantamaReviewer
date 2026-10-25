/**
 * 出題（今日の出題・解き直し・答え合わせ）が使うデータを、検討画面のシェルが 1 つだけ持つ。
 *
 * - 半荘ごとの再生した結果（`GameStore`）・答えの記録（`study.sqlite`）・設定（1日に出す数・ドラ）を読む
 * - 今日（午前 4 時までは前の日）の組を、まだ無ければ作って保存する（作ったら、その日のうちは入れ替えない。E-24）。
 *   組は、すべての半荘の結果を読み終えてから作る（読み込み中に作ると、一部の半荘だけの組になる）
 * - サイドバーの数（今日のまだ答えていない数・解き直しの期限の数）と、各ページが使う `StudyModel` を作る
 * - 答えの記録・答え合わせのあとに直す欄の保存。保存したら、画面のデータも更新する
 * - 解決した局面（F16）: 消していない半荘の `resolved.json` から、問題の識別（`problemId`）の集まりを作り、今日の出題・残り・解き直しに渡す。
 *   入れ切りは `setResolved`（取り消せる命令にして積む。U-11）
 */
import {
  STUDY_DAY_START_HOUR,
  DEFAULT_DISAGREEMENT_THRESHOLD,
  findDecisionByKey,
  problemId,
  studyDate,
  type Decision,
  type ImportedGame,
} from '@jantama/engine';
import {
  createContext,
  useCallback,
  useContext,
  useEffect,
  useMemo,
  useRef,
  useState,
  useSyncExternalStore,
  type ReactNode,
} from 'react';

import { api, errorMessage, onSettingsChanged } from '../../api/tauri';
import type { AnswerNotes, AnswerRow, NewAnswer, SessionRecord, Settings, StoredProblemRef } from '../../api/types';
import { useUndo } from '../undo/UndoProvider';
import { GameStore, type GameState } from './gameStore';
import { resolveCommand } from './resolveEdits';
import { buildStudyModel, collectProblems, plannedSet, type StudyModel } from './studyModel';

/** 次に「今日」が替わる（午前 4 時になる）までの、ミリ秒。 */
export function msUntilNextStudyDay(now: Date): number {
  const next = new Date(now.getFullYear(), now.getMonth(), now.getDate(), STUDY_DAY_START_HOUR, 0, 0, 0);
  if (next.getTime() <= now.getTime()) next.setDate(next.getDate() + 1);
  return next.getTime() - now.getTime();
}

/** 出題の「今日」（YYYY-MM-DD）。午前 4 時になったら、替わる。 */
export function useStudyDay(): string {
  const [day, setDay] = useState(() => studyDate(new Date()));
  useEffect(() => {
    const timer = window.setTimeout(() => setDay(studyDate(new Date())), msUntilNextStudyDay(new Date()) + 1000);
    return () => window.clearTimeout(timer);
  }, [day]);
  return day;
}

/** 設定。読み込み前は null。設定ページで変えたら（`settings-changed`）、すぐに替わる。 */
export function useSettings(): Settings | null {
  const [settings, setSettings] = useState<Settings | null>(null);
  useEffect(() => {
    let alive = true;
    let dispose: (() => void) | null = null;
    void api
      .getSettings()
      .then((value) => {
        if (alive) setSettings(value);
      })
      .catch(() => undefined);
    void onSettingsChanged((value) => setSettings(value)).then((fn) => {
      if (alive) dispose = fn;
      else fn();
    });
    return () => {
      alive = false;
      dispose?.();
    };
  }, []);
  return settings;
}

export interface Located {
  session: SessionRecord;
  game: ImportedGame;
  decision: Decision;
}

export interface StudyValue {
  /** 設定・答え・すべての半荘の結果を読み終えた（数と組を出してよい）。 */
  ready: boolean;
  /** 答えのファイルなどを読めなかった理由（読めたら null）。 */
  error: string | null;
  /** 今日（午前 4 時までは前の日）。 */
  studyDay: string;
  /** 悪手の基準と正解の下限（5% 固定）。 */
  threshold: number;
  dailyCount: number;
  /** 設定の「ドラを目立たせる」。 */
  highlightDora: boolean;
  /** 解決した問題の識別（`problemId`。消した半荘は入れない。F16）。 */
  resolvedIds: ReadonlySet<string>;
  /**
   * 設定の「迷いだけを記録する」（F0、W-15）。入なら、〇△✕（局の自己評価）と終局直後メモの画面の部品を出さない（記録は消さない）。
   * 設定を読み込むまでは false（出す。読めなかったときも、記録を隠さない）。
   */
  doubtOnly: boolean;
  answers: readonly AnswerRow[];
  model: StudyModel;
  /** サイドバーの数。読み終えるまでは null（出さない）。 */
  todayUnanswered: number | null;
  dueCount: number | null;
  /** 半荘の名前と判断の鍵から、半荘・再生した結果・判断を引く。無ければ null。 */
  locate: (sessionId: string, key: string) => Located | null;
  gameState: (sessionId: string) => GameState | undefined;
  session: (sessionId: string) => SessionRecord | undefined;
  recordAnswer: (answer: NewAnswer) => Promise<AnswerRow>;
  /** 答え合わせのあとに直す欄を直す。渡した欄だけを替え、ほかは、いまの保存の値のまま。 */
  updateNotes: (id: number, patch: Partial<AnswerNotes>) => Promise<AnswerRow>;
  /**
   * 局面の解決を入れる・切る（F16）。保存して、半荘の一覧を読み直し、取り消せる命令（「解決」。Ctrl+Z・Ctrl+Y）として積む。
   * すでにその形のときは何もしない。失敗は、取り消しの積み重ねの知らせ（通知）に出るので、ここでは投げない。
   */
  setResolved: (sessionId: string, key: string, on: boolean) => Promise<void>;
  /**
   * 半荘の一覧を読み直す（半荘を通して見る画面の中で保存したもの、場面でのメモなどを、一覧に反映する）。
   * 保存のコマンドは、状態の変化も知らせるので、一覧はそれでも読み直される。これは、保存が済んだ直後に、確かに反映するため。
   */
  reloadSessions: () => Promise<void>;
}

const EMPTY_MODEL: StudyModel = {
  problems: [],
  today: { items: [], answered: 0, unanswered: 0, resolvedOnly: 0, rest: [], undecidedMarks: 0, sessionCount: 0 },
  due: [],
  nextDue: null,
};

const StudyContext = createContext<StudyValue | null>(null);

/** 半荘の一覧・答えの記録が読み込み前のときの、空の一覧（毎回新しい配列を作らない）。 */
const NO_SESSIONS: readonly SessionRecord[] = [];
const NO_ANSWERS: readonly AnswerRow[] = [];

/** 解決した問題の識別の集まり。消していない半荘（一覧に出ているもの）の `resolved.json` から。 */
export function resolvedIdsOf(sessions: readonly SessionRecord[]): Set<string> {
  const ids = new Set<string>();
  for (const session of sessions) {
    for (const key of Object.keys(session.resolved.decisions)) ids.add(problemId({ sessionId: session.id, key }));
  }
  return ids;
}

export function StudyProvider({ value, children }: { value: StudyValue; children: ReactNode }) {
  return <StudyContext.Provider value={value}>{children}</StudyContext.Provider>;
}

export function useStudy(): StudyValue {
  const value = useContext(StudyContext);
  if (value === null) throw new Error('StudyProvider の中で使ってください');
  return value;
}

/**
 * 設定の「迷いだけを記録する」（F0）。〇△✕ の数を出すかどうかだけを知りたい部品が使う。`StudyProvider` の外では false（出す）。
 * 出題のデータ全体（`useStudy`）は、無いと投げるので、そこまで要らない部品は、こちらを使う。
 */
export function useDoubtOnly(): boolean {
  return useContext(StudyContext)?.doubtOnly ?? false;
}

/**
 * 出題のデータを作る（検討画面のシェルが 1 回だけ呼び、結果を `StudyProvider` で配る）。
 * `sessions` は、消していない半荘（一覧に出ているもの）。読み込み前は null。
 */
export function useStudyData(sessions: readonly SessionRecord[] | null, reloadSessions: () => Promise<void>): StudyValue {
  const settings = useSettings();
  const studyDay = useStudyDay();
  const [answers, setAnswers] = useState<AnswerRow[] | null>(null);
  const [daily, setDaily] = useState<{ date: string; items: StoredProblemRef[] | null } | null>(null);
  const [error, setError] = useState<string | null>(null);
  const answersRef = useRef<AnswerRow[]>([]);
  useEffect(() => {
    answersRef.current = answers ?? [];
  }, [answers]);

  const [store] = useState(() => new GameStore((id) => api.readReport(id)));
  useEffect(() => {
    if (sessions !== null) store.sync(sessions);
  }, [store, sessions]);
  const games = useSyncExternalStore(store.subscribe, store.getSnapshot);

  // 答えの記録を読む
  useEffect(() => {
    let alive = true;
    api.listAnswers().then(
      (rows) => {
        if (alive) setAnswers(rows);
      },
      (failure: unknown) => {
        if (!alive) return;
        setError(errorMessage(failure));
        setAnswers([]);
      },
    );
    return () => {
      alive = false;
    };
  }, []);

  const threshold = DEFAULT_DISAGREEMENT_THRESHOLD;
  const dailyCount = settings?.daily_count ?? 5;

  const settled =
    sessions !== null &&
    sessions.every((s) => s.report_path === null || (games.get(s.id) !== undefined && games.get(s.id)?.status !== 'loading'));
  const ready = settings !== null && answers !== null && settled;

  const sessionList = useMemo(() => sessions ?? NO_SESSIONS, [sessions]);
  const resolvedIds = useMemo(() => resolvedIdsOf(sessionList), [sessionList]);
  const collected = useMemo(
    () => (ready ? collectProblems(sessionList, games) : null),
    [ready, sessionList, games],
  );

  // 今日の組を、まだ無ければ作って保存する（作ったら入れ替えない。保存先の側でも、その日の組があれば入れ替えない）
  const needsSet = ready && (daily === null || daily.date !== studyDay || daily.items === null);
  const planned = useMemo(
    () => (needsSet && collected !== null ? plannedSet(collected.problems, answers ?? [], dailyCount, resolvedIds) : []),
    [needsSet, collected, answers, dailyCount, resolvedIds],
  );
  useEffect(() => {
    if (!needsSet) return undefined;
    let alive = true;
    void (async () => {
      try {
        const stored = await api.getDailySet(studyDay);
        if (!alive) return;
        if (stored !== null) {
          setDaily({ date: studyDay, items: stored });
          return;
        }
        if (planned.length === 0) {
          setDaily({ date: studyDay, items: null });
          return;
        }
        const saved = await api.saveDailySet(studyDay, planned);
        if (alive) setDaily({ date: studyDay, items: saved });
      } catch (failure) {
        if (alive) setError(errorMessage(failure));
      }
    })();
    return () => {
      alive = false;
    };
  }, [needsSet, studyDay, planned]);

  const model = useMemo(() => {
    if (!ready || collected === null) return EMPTY_MODEL;
    return buildStudyModel(
      {
        sessions: sessionList,
        games,
        answers: answers ?? [],
        threshold,
        daily: daily !== null && daily.date === studyDay ? daily.items : null,
        today: studyDay,
        resolved: resolvedIds,
      },
      collected,
    );
  }, [ready, collected, sessionList, games, answers, threshold, daily, studyDay, resolvedIds]);

  const recordAnswer = useCallback(async (answer: NewAnswer): Promise<AnswerRow> => {
    const row = await api.recordAnswer(answer);
    setAnswers((rows) => [...(rows ?? []), row]);
    return row;
  }, []);

  const updateNotes = useCallback(async (id: number, patch: Partial<AnswerNotes>): Promise<AnswerRow> => {
    const current = answersRef.current.find((row) => row.id === id);
    const notes: AnswerNotes = {
      causes: patch.causes ?? current?.causes ?? [],
      principle: patch.principle ?? current?.principle ?? '',
      maka_move: patch.maka_move === undefined ? (current?.maka_move ?? null) : patch.maka_move,
    };
    const row = await api.updateAnswerNotes(id, notes);
    setAnswers((rows) => (rows ?? []).map((r) => (r.id === row.id ? row : r)));
    return row;
  }, []);

  // 解決の入れ切り。いまの形は、画面が持っている半荘の一覧から読む（古い写しで二重に積まないよう、最新を参照で持つ）
  const undo = useUndo();
  const sessionsRef = useRef<readonly SessionRecord[]>(NO_SESSIONS);
  useEffect(() => {
    sessionsRef.current = sessionList;
  }, [sessionList]);
  const setResolved = useCallback(
    async (sessionId: string, key: string, on: boolean): Promise<void> => {
      const session = sessionsRef.current.find((s) => s.id === sessionId);
      const before = session !== undefined && Object.hasOwn(session.resolved.decisions, key);
      if (before === on) return;
      await undo.run(resolveCommand(api, reloadSessions, { sessionId, key, before, after: on })).catch(() => undefined);
    },
    [undo, reloadSessions],
  );

  const locate = useCallback(
    (sessionId: string, key: string): Located | null => {
      const session = sessionList.find((s) => s.id === sessionId);
      const state = games.get(sessionId);
      if (session === undefined || state === undefined || state.status !== 'ready') return null;
      const decision = findDecisionByKey(state.game, key);
      return decision === undefined ? null : { session, game: state.game, decision };
    },
    [sessionList, games],
  );

  const gameState = useCallback((sessionId: string) => games.get(sessionId), [games]);
  const session = useCallback((sessionId: string) => sessionList.find((s) => s.id === sessionId), [sessionList]);

  const highlightDora = settings?.highlight_dora ?? false;
  const doubtOnly = settings?.doubt_only === true;
  const answerList = answers ?? NO_ANSWERS;
  // 描き直しのたびに別の値にならないよう、中身が変わったときだけ作り直す（配った先の画面が、無駄に描き直されない）
  return useMemo(
    () => ({
      ready,
      error,
      studyDay,
      threshold,
      dailyCount,
      highlightDora,
      resolvedIds,
      doubtOnly,
      answers: answerList,
      model,
      todayUnanswered: ready ? model.today.unanswered : null,
      dueCount: ready ? model.due.length : null,
      locate,
      gameState,
      session,
      recordAnswer,
      updateNotes,
      setResolved,
      reloadSessions,
    }),
    [
      ready,
      error,
      studyDay,
      threshold,
      dailyCount,
      highlightDora,
      resolvedIds,
      doubtOnly,
      answerList,
      model,
      locate,
      gameState,
      session,
      recordAnswer,
      updateNotes,
      setResolved,
      reloadSessions,
    ],
  );
}
