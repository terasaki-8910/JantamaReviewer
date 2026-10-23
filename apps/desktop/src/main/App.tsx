import { useCallback, useEffect, useEffectEvent, useMemo, useReducer, useRef, useState, type ReactNode } from 'react';

import { api, errorMessage } from '../api/tauri';
import type { AnswerMode, SessionRecord } from '../api/types';
import { ariaModShortcut, historyKeyDirection, modShortcut } from '../shared/platform';
import { applyTheme, effectiveTheme, storeTheme, type ThemeChoice } from '../shared/theme';
import { reportBackground, signalWindowReady } from '../shared/windowReady';
import { ConfirmDialog } from './ConfirmDialog';
import { solvedProblemCount, solvedProblemsLine } from './deleteImpact';
import { ImportOffer } from './ImportOffer';
import { ImportPage } from './ImportPage';
import { Lightbox, type ViewerRequest } from './Lightbox';
import { LogPage } from './log/LogPage';
import { useLogState } from './log/useLogState';
import { ReplayPage } from './replay/ReplayPage';
import { relinkRatings } from './ratingRelink';
import { RereadStore } from './rereadStore';
import { SearchOverlay } from './search/SearchOverlay';
import { useSearchOverlay } from './search/useSearchOverlay';
import { SessionList, type SessionListHandle } from './SessionList';
import { buildListRows, neighborAfterDelete } from './sessionRows';
import { SessionPage } from './SessionPage';
import { SettingsPage } from './SettingsPage';
import { Sidebar, TopBar } from './Sidebar';
import { QuizPage } from './study/QuizPage';
import { ReviewPage } from './study/ReviewPage';
import { StudyProvider, useStudyData, type StudyValue } from './study/StudyProvider';
import { TodayPage } from './study/TodayPage';
import { WeekPage } from './week/WeekPage';
import { TOAST_MS, Toast, type ToastModel } from './Toast';
import { UndoProvider, useUndo, useUndoEvents } from './undo/UndoProvider';
import { ViewerProvider, type OpenViewer } from './ViewerContext';
import { useShortcutsBlocked } from './undo/shortcutGuard';
import type { UndoCommand, UndoEvent } from './undo/undoStack';
import { useImportFlow } from './useImportFlow';
import { useSessions, useSummariesAndFit, useToday } from './useSessions';
import { useSidebar } from './useSidebar';
import { currentView, historyReducer, isViewAvailable, startHistory, stepTarget } from './viewHistory';
import { quizView, replayView, sessionView, viewSessionId, type View } from './views';

/** 半荘の一覧を読み終える前の、空の一覧（週の集計に渡す。毎回新しい配列を作らない）。 */
const NO_SESSIONS: readonly SessionRecord[] = [];

/** 取り消したあとの「元に戻しました」の通知の長さ（ミリ秒）。 */
const UNDONE_TOAST_MS = 3500;

export interface AppProps {
  /**
   * 消す半荘に、解いた問題がいくつあるか（確認の文に足す）。既定は、答えの記録（study.sqlite）に数えてもらう。
   * 試験では、数をすぐ返す関数を渡せる。
   */
  solvedProblems?: (sessionIds: readonly string[]) => number | Promise<number>;
}

/**
 * 検討画面（メインの窓）。承認済みのシェル: 左に固定幅のサイドバー、右に本文。幅 640px 未満では、サイドバーは隠れ、左上のボタンで
 * 引き出しとして重ねて開く。広い窓でも、同じボタンでサイドバーをしまえる（U-32。出す・しまう・開く・閉じるは useSidebar.ts）。
 * サイドバーに、主な操作「検討結果を取り込む」・半荘の一覧（日付ごと・検索・段階の絞り込み・削除）・設定とテーマの切り替え。
 * 見た画面の履歴（← → と Alt+← / Alt+→）と、操作の取り消し（Ctrl+Z・Ctrl+Y。半荘の削除が最初の利用者）は、ここで受ける。
 */
export function App({ solvedProblems = solvedProblemCount }: AppProps = {}) {
  // 記録を置き換えたとき（設定の「読み込む」。D-2）は、画面のデータも、取り消しの履歴も、すべて読み直す。`key` を変えて、
  // シェルごと作り直す（読み込んだあとの設定のページを開いて、「読み込みました…」を出す）。履歴の取り消しは、置き換える前の記録を指すので、持ち越さない。
  const [boot, setBoot] = useState<{ epoch: number; notice: string | null }>({ epoch: 0, notice: null });
  return (
    <UndoProvider key={boot.epoch}>
      <Shell
        solvedProblems={solvedProblems}
        recordsNotice={boot.notice}
        startOnSettings={boot.epoch > 0}
        onRecordsReplaced={(notice) => setBoot((current) => ({ epoch: current.epoch + 1, notice }))}
      />
    </UndoProvider>
  );
}

/** 確認を出している削除（消したい半荘と、確認を閉じたときにキーボードの位置を戻す先）。 */
interface PendingDelete {
  ids: string[];
  opener: HTMLElement | null;
}

function failureText(event: Extract<UndoEvent, { type: 'failed' }>): string {
  const reason = errorMessage(event.error);
  switch (event.action) {
    case 'run':
      return `${event.command.label}ができませんでした: ${reason}`;
    case 'undo':
      return `元に戻せませんでした: ${reason}`;
    case 'redo':
      return `やり直せませんでした: ${reason}`;
  }
}

interface ShellProps extends Required<AppProps> {
  /** 記録を読み込んだあとの、設定のページに出す知らせ。 */
  recordsNotice: string | null;
  /** 記録を読み込んだあと（シェルを作り直したとき）は、設定のページから始める。 */
  startOnSettings: boolean;
  /** 設定の「読み込む」で記録を置き換えたとき。 */
  onRecordsReplaced: (notice: string) => void;
}

function Shell({ solvedProblems, recordsNotice, startOnSettings, onRecordsReplaced }: ShellProps) {
  // どの画面を見ているか・見てきた画面の履歴は、メモリの中だけで持つ（URL のパスや履歴は使わない）。
  const [nav, dispatch] = useReducer(historyReducer, undefined, () =>
    startOnSettings ? startHistory({ kind: 'settings' }) : startHistory(),
  );
  const view = currentView(nav);
  const [theme, setTheme] = useState<ThemeChoice>(effectiveTheme);
  const now = useToday();
  const undo = useUndo();
  const shortcutsBlocked = useShortcutsBlocked();
  // 検索の重ね表示（検索のアイコンと Ctrl+K で開く。U-22）
  const search = useSearchOverlay();
  // 検討ログの絞り込みと「答えを出す」。問題を開いて戻っても残るよう、画面の外で持つ
  const log = useLogState();
  // 設定の「記録の読み込み」の確認を開いているか（開いている間は、裏の画面を操作できなくする）
  const [recordsModal, setRecordsModal] = useState(false);
  // 読み込んだあとの知らせは、読み込んだあとの設定のページに 1 度だけ出す（ほかの画面へ移ったら、忘れる）
  const [notice, setNotice] = useState(recordsNotice);
  if (notice !== null && view.kind !== 'settings') setNotice(null);

  // 半荘の一覧。読めるたびに、いま見ている半荘が残っているかを確かめる（何も選んでいなければ、いちばん新しい半荘にする）。
  const { sessions, error: loadError, reload } = useSessions((list) =>
    dispatch({ type: 'listChanged', sessionIds: list.map((session) => session.id) }),
  );
  // 結果を取り込んだ半荘のまとめ（卓・段階・Rating）と、MAKA の評価から合わせ直した当てはめ（F10、U-31）。段階はどこでも、この当てはめで決める
  const { summaries, fit } = useSummariesAndFit(sessions);
  // 取り込みの状態は、画面を移っても保つ（mjai の窓からの知らせを、取りこぼさないため）。取り込んだ半荘の段階も、いまの当てはめで決める
  const flow = useImportFlow(fit.fit.model);
  // 出題（今日の出題・解き直し・答え合わせ）のデータ。半荘の結果の再生・答えの記録・今日の組を、ここで 1 つだけ持つ
  const study = useStudyData(sessions, reload);
  // 前の作り方で読んだ半荘の読み直し（F11）。半荘の画面を開いたときに 1 回だけ。済んだら、一覧を読み直して、新しい読み取りを反映する。
  const [rereads] = useState(
    () =>
      new RereadStore({
        needed: api.needsOcrReread,
        reread: api.rereadOcr,
        changed: reload,
        // 読み直しのあとに、前の当てはめ方で当てはめた評価を、1 回だけ当てはめ直す（E-31）
        relink: (sessionId) => relinkRatings(api, sessionId),
      }),
  );
  const rows = useMemo(() => buildListRows(sessions ?? [], summaries), [sessions, summaries]);
  const sessionIds = useMemo(() => new Set(rows.map((row) => row.id)), [rows]);
  const available = useCallback((candidate: View) => isViewAvailable(candidate, sessionIds), [sessionIds]);
  const canGoBack = stepTarget(nav, -1, available) !== null;
  const canGoForward = stepTarget(nav, 1, available) !== null;

  const listRef = useRef<SessionListHandle>(null);
  // 操作が済んで一覧が描き直されたあとに、キーボードの位置を一覧へ戻すための合図（増えるたびに、戻す）。
  const [settleTick, setSettleTick] = useState(0);

  // 最初の絵を描き終えたと知らせる。窓は、それまで隠れている（N-7）。
  useEffect(() => {
    void signalWindowReady();
  }, []);

  // OS のテーマが変わったとき（明示して選んでいなければ）表示を合わせる。
  useEffect(() => {
    const query = window.matchMedia('(prefers-color-scheme: dark)');
    const sync = () => setTheme(effectiveTheme());
    query.addEventListener('change', sync);
    return () => query.removeEventListener('change', sync);
  }, []);

  const toggleTheme = useCallback(() => {
    const next: ThemeChoice = effectiveTheme() === 'dark' ? 'light' : 'dark';
    applyTheme(next);
    storeTheme(next);
    setTheme(next);
    void reportBackground();
  }, []);

  // ---- 読み上げ用の欄と、通知 ----

  const [live, setLive] = useState('');
  const liveTimer = useRef<number | null>(null);
  const announce = useCallback((message: string) => {
    // 同じ文でも読み上げ直されるよう、いったん空にしてから入れる。
    setLive('');
    if (liveTimer.current !== null) window.clearTimeout(liveTimer.current);
    liveTimer.current = window.setTimeout(() => setLive(message), 30);
  }, []);
  useEffect(
    () => () => {
      if (liveTimer.current !== null) window.clearTimeout(liveTimer.current);
    },
    [],
  );

  const [toast, setToast] = useState<ToastModel | null>(null);
  const toastCount = useRef(0);
  const showToast = useCallback(
    (next: Omit<ToastModel, 'id' | 'ms'> & { ms?: number }) => {
      toastCount.current += 1;
      setToast({ id: toastCount.current, ms: TOAST_MS, ...next });
      announce(next.text);
    },
    [announce],
  );
  // 削除のあと、キーボードの位置を戻せる先が無い（半荘が 1 つも残らない）ときは、通知の「元に戻す」に移す。
  const focusToastAction = useRef(false);

  // 取り消しの積み重ねの知らせを、通知にする。実行とやり直しには「元に戻す」を付ける。ほかの命令が積まれたら、前の通知は消す
  // （前の通知の「元に戻す」は、もう押せる順番ではないため）。
  useUndoEvents((event) => {
    if (event.type === 'failed') {
      showToast({ text: failureText(event) });
      return;
    }
    const text = event.command.messages?.[event.type];
    if (text === undefined) {
      setToast(null);
      return;
    }
    if (event.type === 'undo') {
      showToast({ text, ms: UNDONE_TOAST_MS });
      return;
    }
    const focusAction = focusToastAction.current;
    focusToastAction.current = false;
    showToast({
      text,
      focusAction,
      action: {
        label: '元に戻す',
        title: `元に戻す（${modShortcut('Z')}）`,
        keyShortcuts: ariaModShortcut('Z'),
        // 通知の「元に戻す」は、押すと消える。キーボードの位置が消えないよう、一覧の「選択」か検索欄に移す。
        onAction: () =>
          void undo
            .undo()
            .then(() => setSettleTick((tick) => tick + 1))
            .catch(() => undefined),
      },
    });
  });

  // ---- 見た画面の履歴（← → と Alt+← / Alt+→） ----

  const step = useCallback(
    (direction: -1 | 1) => {
      const index = stepTarget(nav, direction, available);
      if (index !== null) dispatch({ type: 'go', index });
    },
    [nav, available],
  );

  const onHistoryKey = useEffectEvent((event: KeyboardEvent) => {
    // Windows は Alt+← →、macOS は Cmd+[ ]（Option+← → は、入力欄の単語の移動なので使わない）。
    const direction = historyKeyDirection(event);
    if (direction === null) return;
    // メニューやダイアログが開いている間は、そこに任せる。マウスの戻る・進むのボタンには、何も割り当てない（SPEC 3a）。
    if (shortcutsBlocked()) return;
    event.preventDefault();
    step(direction === 'back' ? -1 : 1);
  });
  useEffect(() => {
    const handler = (event: KeyboardEvent) => onHistoryKey(event);
    document.addEventListener('keydown', handler);
    return () => document.removeEventListener('keydown', handler);
  }, []);

  // ---- 画面の切り替え ----

  const { reset, acceptOffer } = flow;
  const phase = flow.state.phase;
  const push = useCallback((next: View) => dispatch({ type: 'push', view: next }), []);
  const openImport = useCallback(() => {
    // 別のページから来たときは、取り込みの続き（途中・完了・失敗）をそのまま見せる（別のページにいる間に終わっても、
    // 結果を見逃さない）。取り込みのページを開いたまま押したときは、終わった取り込みを閉じて、新しく始める。
    if (view.kind === 'import' && (phase === 'done' || phase === 'error')) reset();
    push({ kind: 'import' });
  }, [phase, push, reset, view.kind]);
  const acceptImportOffer = useCallback(() => {
    acceptOffer();
    push({ kind: 'import' });
  }, [acceptOffer, push]);
  const openSession = useCallback(
    (sessionId: string) => {
      // 終わった取り込みの結果は、半荘を開いたら閉じる（次に取り込みを開いたとき、古い結果が残らないように）。
      reset();
      push(sessionView(sessionId));
    },
    [push, reset],
  );
  const openFromList = useCallback((sessionId: string) => push(sessionView(sessionId)), [push]);
  const openToday = useCallback(() => push({ kind: 'today' }), [push]);
  const openReview = useCallback(() => push({ kind: 'review' }), [push]);
  const openLog = useCallback(() => push({ kind: 'log' }), [push]);
  const openWeek = useCallback(() => push({ kind: 'week' }), [push]);
  // ログの行: 保存した答えで開く（答えの種類は、最後の答えのもの）
  const openLogged = useCallback((sessionId: string, key: string, mode: AnswerMode) => push(quizView(sessionId, key, mode)), [push]);
  const openProblem = useCallback((sessionId: string, key: string) => push(quizView(sessionId, key)), [push]);
  // 半荘を通して見る画面。`key` は、開く判断の鍵（迷いのカードの「この局面を解く」）。無ければ半荘の頭から
  const openReplay = useCallback((sessionId: string, key?: string) => push(replayView(sessionId, key)), [push]);

  // 取り込みが終わったら、一覧を読み直す（保存した結果の段階・Rating を出すため。Rust 側の知らせの取りこぼしにも備える）。
  useEffect(() => {
    if (phase === 'done') void reload();
  }, [phase, reload]);

  // ---- 半荘の削除（確認 → 実行 → 通知。取り消しの積み重ねに載る） ----

  const [pending, setPending] = useState<PendingDelete | null>(null);
  const focusAfterClose = useRef<HTMLElement | null>(null);

  const requestDelete = useCallback((ids: string[], opener: HTMLElement | null) => {
    if (ids.length > 0) setPending({ ids, opener });
  }, []);

  // 消す半荘の、解いた問題の数（確認の文に足す。答えの記録に数えてもらう）。数えている間は 0 として、行を出さない
  const [solvedCount, setSolvedCount] = useState<{ key: string; count: number } | null>(null);
  const pendingKey = pending === null ? null : pending.ids.join(',');
  useEffect(() => {
    if (pending === null || pendingKey === null) return undefined;
    let alive = true;
    Promise.resolve(solvedProblems(pending.ids)).then(
      (count) => {
        if (alive) setSolvedCount({ key: pendingKey, count });
      },
      () => undefined,
    );
    return () => {
      alive = false;
    };
  }, [pending, pendingKey, solvedProblems]);
  const solved = pendingKey !== null && solvedCount?.key === pendingKey ? solvedCount.count : 0;

  const cancelDelete = () => {
    focusAfterClose.current = pending?.opener ?? null;
    setPending(null);
  };

  // 確認を閉じたあと（裏の画面が操作できるようになってから）、キーボードの位置を戻す。
  useEffect(() => {
    const target = focusAfterClose.current;
    if (pending !== null || target === null) return;
    focusAfterClose.current = null;
    if (target.isConnected) target.focus();
  }, [pending]);

  const deleteCommand = (ids: string[]): UndoCommand => {
    const count = ids.length;
    // いま見ている半荘（と、その半荘の出題）を消すなら、隣の半荘へ移す。履歴は増やさず、見ている項目を置き換える。
    // 元に戻したら、もとの画面に戻る。
    const hereSession = viewSessionId(view);
    const here = hereSession !== null && ids.includes(hereSession) ? view : null;
    const neighbor = here === null ? null : neighborAfterDelete(
      rows.map((row) => row.id),
      new Set(ids),
    );
    const to: View | null = here === null ? null : neighbor === null ? { kind: 'none' } : sessionView(neighbor);
    const swap = (from: View, into: View) => dispatch({ type: 'swap', from, to: into });
    return {
      label: '半荘の削除',
      messages: {
        run: `${count}件の半荘を削除しました`,
        undo: `${count}件の半荘を元に戻しました`,
        redo: `${count}件の半荘を削除しました`,
      },
      execute: async () => {
        if (here !== null && to !== null) swap(here, to);
        try {
          await api.deleteSessions(ids);
        } catch (error) {
          if (here !== null && to !== null) swap(to, here);
          throw error;
        }
        await reload();
      },
      undo: async () => {
        await api.restoreSessions(ids);
        await reload();
        if (here !== null && to !== null) swap(to, here);
      },
    };
  };

  const confirmDelete = () => {
    if (pending === null) return;
    const { ids, opener } = pending;
    setPending(null);
    focusToastAction.current = ids.length >= rows.length;
    undo
      .run(deleteCommand(ids))
      .then(() => setSettleTick((tick) => tick + 1))
      .catch(() => {
        // 失敗の理由は、積み重ねの知らせ（'failed'）が通知に出す。キーボードの位置は、確認を開いた所に戻す。
        focusToastAction.current = false;
        if (opener?.isConnected) opener.focus();
      });
  };

  // 削除が済んで一覧が描き直されたあと（選択をやめて）、キーボードの位置を戻す。
  useEffect(() => {
    if (settleTick > 0) listRef.current?.settleAfterDelete();
  }, [settleTick]);

  // ---- 迷いの画像の大きな表示（開く・閉じる。裏の画面は操作できなくなる。閉じたら、押したカードへキーボードの位置を戻す） ----

  const [viewer, setViewer] = useState<ViewerRequest | null>(null);
  const focusAfterViewer = useRef<HTMLElement | null>(null);

  const closeViewer = () => {
    focusAfterViewer.current = viewer?.opener ?? null;
    setViewer(null);
  };

  // 閉じたあと（裏の画面が操作できるようになってから）、キーボードの位置を戻す。
  useEffect(() => {
    const target = focusAfterViewer.current;
    if (viewer !== null || target === null) return;
    focusAfterViewer.current = null;
    if (target.isConnected) target.focus();
  }, [viewer]);

  // ---- 描く ----

  // サイドバーの出す・しまう・引き出し（U-32）。検索・削除の確認・画像の大きな表示が開いている間は、Esc と Tab をそちらに任せる
  const sidebar = useSidebar({ suspended: pending !== null || viewer !== null || search.open || recordsModal });
  // 引き出しの項目（取り込み・今日の出題・解き直し・設定・半荘）を選んだら、引き出しを閉じて、左上のボタンへキーボードの位置を戻す
  const choose = <Args extends unknown[]>(action: (...args: Args) => void) => (...args: Args) => {
    action(...args);
    sidebar.closeDrawer(true);
  };
  // 検索の結果を開いたときは、引き出しだけ閉じる（開いた画面が、キーボードの位置を決める）
  const chooseFromSearch = <Args extends unknown[]>(action: (...args: Args) => void) => (...args: Args) => {
    action(...args);
    sidebar.closeDrawer(false);
  };
  const tools = {
    canGoBack,
    canGoForward,
    onGoBack: () => step(-1),
    onGoForward: () => step(1),
    searchOpen: search.open,
    onSearch: search.show,
  };

  const selectedSession = view.kind === 'session' ? (sessions?.find((s) => s.id === view.id) ?? null) : null;
  const currentId = view.kind === 'session' ? view.id : view.kind === 'replay' ? view.sessionId : null;
  const solvedLine = solvedProblemsLine(solved);

  return (
    <Providers study={study} openViewer={setViewer}>
      <div
        className="app"
        data-sb={sidebar.shown ? 'shown' : 'hidden'}
        data-drawer={sidebar.drawerOpen ? 'open' : 'closed'}
        inert={pending !== null || viewer !== null || search.open || recordsModal}
      >
        <Sidebar
          view={view}
          theme={theme}
          {...tools}
          expanded={sidebar.expanded}
          drawer={sidebar.drawerOpen}
          onToggleSidebar={sidebar.toggle}
          toggleRef={sidebar.sideToggleRef}
          sideRef={sidebar.sideRef}
          onImport={choose(openImport)}
          onSettings={choose(() => push({ kind: 'settings' }))}
          onToggleTheme={toggleTheme}
          todayCount={study.todayUnanswered}
          dueCount={study.dueCount}
          onToday={choose(openToday)}
          onReview={choose(openReview)}
          onLog={choose(openLog)}
          onWeek={choose(openWeek)}
        >
          <SessionList
            ref={listRef}
            rows={rows}
            now={now}
            currentId={currentId}
            loaded={sessions !== null}
            loadError={loadError}
            onOpen={choose(openFromList)}
            onRequestDelete={requestDelete}
            announce={announce}
          />
        </Sidebar>
        {/* 引き出しの幕。押すと閉じる（キーボードでは Esc。Tab の順には入れない） */}
        {sidebar.drawerOpen && (
          <button type="button" className="scrim" tabIndex={-1} aria-hidden="true" onClick={() => sidebar.closeDrawer(true)} />
        )}
        <main className="main" inert={sidebar.drawerOpen}>
          {(sidebar.narrow || !sidebar.shown) && (
            <TopBar onToggle={sidebar.toggle} toggleRef={sidebar.topToggleRef} tools={tools} />
          )}
          {flow.offer && view.kind !== 'import' && (
            <ImportOffer link={flow.offer} onAccept={acceptImportOffer} onDismiss={flow.dismissOffer} />
          )}
          {view.kind === 'settings' && (
            <SettingsPage
              onRecordsModal={setRecordsModal}
              onRecordsReplaced={onRecordsReplaced}
              recordsNotice={notice}
            />
          )}
          {view.kind === 'import' && <ImportPage flow={flow} onOpenSession={openSession} />}
          {view.kind === 'today' && <TodayPage onOpen={openProblem} />}
          {view.kind === 'review' && <ReviewPage />}
          {view.kind === 'log' && <LogPage state={log} onOpen={openLogged} />}
          {view.kind === 'week' && <WeekPage sessions={sessions ?? NO_SESSIONS} summaries={summaries} />}
          {view.kind === 'replay' && <ReplayPage sessionId={view.sessionId} startKey={view.key} />}
          {view.kind === 'quiz' && (
            <QuizPage
              sessionId={view.sessionId}
              decisionKey={view.key}
              mode={view.mode}
              onOpen={openProblem}
              onToday={openToday}
              onReview={openReview}
            />
          )}
          {selectedSession !== null && (
            <SessionPage
              key={selectedSession.id}
              session={selectedSession}
              summary={summaries.get(selectedSession.id)}
              onChanged={reload}
              onOpenImage={setViewer}
              importFlow={flow}
              rereads={rereads}
              onOpenReplay={openReplay}
              fit={fit}
              threshold={study.threshold}
              doubtOnly={study.doubtOnly}
            />
          )}
          {sessions !== null && selectedSession === null && (view.kind === 'none' || view.kind === 'session') && (
            <EmptyPage doubtOnly={study.doubtOnly} />
          )}
        </main>
        {toast !== null && <Toast toast={toast} onClose={() => setToast(null)} />}
      </div>
      {viewer !== null && <Lightbox items={viewer.items} start={viewer.start} onClose={closeViewer} />}
      {search.open && (
        <SearchOverlay
          rows={rows}
          summaries={summaries}
          now={now}
          onOpenGame={chooseFromSearch(openFromList)}
          onOpenProblem={chooseFromSearch(openProblem)}
          onClose={search.hide}
        />
      )}
      {pending !== null && (
        <ConfirmDialog
          title={`${pending.ids.length}件の半荘を削除します。`}
          description={
            <>
              {solvedLine !== null && (
                <>
                  {solvedLine}
                  <br />
                </>
              )}
              記録とスクショも消えます。
              <br />
              アプリを閉じるまでは元に戻せます。
            </>
          }
          confirmLabel="削除"
          cancelLabel="キャンセル"
          onConfirm={confirmDelete}
          onCancel={cancelDelete}
        />
      )}
      {/* 読み上げ用の欄。role="status" は付けない（取り込みの案内・進み具合の role="status" と区別するため） */}
      <p className="sr-only" aria-live="polite">
        {live}
      </p>
    </Providers>
  );
}

/** 出題のデータと、迷いの画像を大きく表示する関数（半荘のページの迷いのカードと、出題・通して見る画面の「迷いのスクショ」が使う）を、画面に配る。 */
function Providers({ study, openViewer, children }: { study: StudyValue; openViewer: OpenViewer; children: ReactNode }) {
  return (
    <StudyProvider value={study}>
      <ViewerProvider value={openViewer}>{children}</ViewerProvider>
    </StudyProvider>
  );
}

/** 半荘が 1 つも無いときの本文。迷いだけを記録する設定が入のときは、〇△✕ のことを言わない。 */
function EmptyPage({ doubtOnly }: { doubtOnly: boolean }) {
  return (
    <>
      <header className="head">
        <h1 className="title">半荘がありません</h1>
      </header>
      <div className="page">
        <p className="empty">
          {doubtOnly ? 'ウィジェットの「迷い」を押すと、ここに並びます。' : 'ウィジェットの「迷い」や〇△✕を押すと、ここに並びます。'}
        </p>
      </div>
    </>
  );
}
