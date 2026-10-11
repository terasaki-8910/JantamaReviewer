/**
 * 出題（今日の出題・解き直し・答え合わせ）が使うデータを、検討画面のシェルが 1 つだけ持つ。
 *
 * - 半荘ごとの再生した結果（`GameStore`）・答えの記録（`study.sqlite`）・設定（1日に出す数・基準・ドラ）を読む
 * - 今日（午前 4 時までは前の日）の組を、まだ無ければ作って保存する（作ったら、その日のうちは入れ替えない。E-24）。
 *   組は、すべての半荘の結果を読み終えてから作る（読み込み中に作ると、一部の半荘だけの組になる）
 * - サイドバーの数（今日のまだ答えていない数・解き直しの期限の数）と、各ページが使う `StudyModel` を作る
 * - 答えの記録・答え合わせのあとに直す欄の保存。保存したら、画面のデータも更新する
 */
import { STUDY_DAY_START_HOUR, findDecisionByKey, studyDate, type Decision, type ImportedGame } from '@jantama/engine';
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
import { GameStore, type GameState } from './gameStore';
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
  /** 大きな不一致の基準（確率）と、正解の基準。設定の「大きな不一致の基準」（%）から。 */
  threshold: number;
  dailyCount: number;
  /** 設定の「ドラを目立たせる」。 */
  highlightDora: boolean;
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
}

const EMPTY_MODEL: StudyModel = {
  problems: [],
  today: { items: [], answered: 0, unanswered: 0, rest: [], undecidedMarks: 0, sessionCount: 0 },
  due: [],
  nextDue: null,
};

const StudyContext = createContext<StudyValue | null>(null);

/** 半荘の一覧・答えの記録が読み込み前のときの、空の一覧（毎回新しい配列を作らない）。 */
const NO_SESSIONS: readonly SessionRecord[] = [];
const NO_ANSWERS: readonly AnswerRow[] = [];

export function StudyProvider({ value, children }: { value: StudyValue; children: ReactNode }) {
  return <StudyContext.Provider value={value}>{children}</StudyContext.Provider>;
}

export function useStudy(): StudyValue {
  const value = useContext(StudyContext);
  if (value === null) throw new Error('StudyProvider の中で使ってください');
  return value;
}

/** 設定の「大きな不一致の基準」（%）を、確率にする。 */
export function thresholdOf(percent: number): number {
  return percent / 100;
}

/**
 * 出題のデータを作る（検討画面のシェルが 1 回だけ呼び、結果を `StudyProvider` で配る）。
 * `sessions` は、消していない半荘（一覧に出ているもの）。読み込み前は null。
 */
export function useStudyData(sessions: readonly SessionRecord[] | null): StudyValue {
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

  const threshold = thresholdOf(settings?.disagreement_percent ?? 5);
  const dailyCount = settings?.daily_count ?? 5;

  const settled =
    sessions !== null &&
    sessions.every((s) => s.report_path === null || (games.get(s.id) !== undefined && games.get(s.id)?.status !== 'loading'));
  const ready = settings !== null && answers !== null && settled;

  const sessionList = useMemo(() => sessions ?? NO_SESSIONS, [sessions]);
  const collected = useMemo(
    () => (ready ? collectProblems(sessionList, games, threshold) : null),
    [ready, sessionList, games, threshold],
  );

  // 今日の組を、まだ無ければ作って保存する（作ったら入れ替えない。保存先の側でも、その日の組があれば入れ替えない）
  const needsSet = ready && (daily === null || daily.date !== studyDay || daily.items === null);
  const planned = useMemo(
    () => (needsSet && collected !== null ? plannedSet(collected.problems, answers ?? [], dailyCount) : []),
    [needsSet, collected, answers, dailyCount],
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
      },
      collected,
    );
  }, [ready, collected, sessionList, games, answers, threshold, daily, studyDay]);

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
      answers: answerList,
      model,
      todayUnanswered: ready ? model.today.unanswered : null,
      dueCount: ready ? model.due.length : null,
      locate,
      gameState,
      session,
      recordAnswer,
      updateNotes,
    }),
    [
      ready,
      error,
      studyDay,
      threshold,
      dailyCount,
      highlightDora,
      answerList,
      model,
      locate,
      gameState,
      session,
      recordAnswer,
      updateNotes,
    ],
  );
}
