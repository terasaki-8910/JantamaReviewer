/**
 * 検討結果の取り込みの状態（F1）。検討画面のシェル（App）が 1 つだけ持つ。
 * 取り込みの途中でほかの画面へ移っても、mjai の窓からの知らせ（結果が見つかった・窓が閉じられた）を取りこぼさないため。
 *
 * - クリップボード（E-15）: 検討画面が前面に来たとき、Rust 側からクリップボードの文字を受け取り、エンジンの
 *   `PaipuLinkAnnouncer`（`detectPaipuLink` + 同じ牌譜 ID は一度だけ）で、新しい牌譜リンクなら「取り込みますか」と知らせる。
 * - 流れ: 牌譜リンク → mjai の窓（Submit はユーザーが押す）→ 結果の受け取り → 検査 → 画面の読み取り → 結びつけ先の決定 →
 *   保存 → まとめ。mjai の窓が使えないときは、結果の URL を貼る・結果の JSON ファイルを開く、でも取り込める。
 * 段階ごとの処理は `importFlow.ts`（純粋な部分）に任せ、ここは状態と、Rust 側からの知らせをつなぐだけ。
 */
import { PaipuLinkAnnouncer, detectPaipuLink, type PaipuLink } from '@jantama/engine';
import { open as openDialog } from '@tauri-apps/plugin-dialog';
import { useCallback, useEffect, useMemo, useRef, useState } from 'react';

import { api, errorMessage, onMainWindowFocused, onMjaiWindow, onOcrProgress } from '../api/tauri';
import type { OcrProgress } from '../api/types';
import { readPageBackground } from '../shared/windowReady';
import { loadAnnouncedIds, saveAnnouncedIds } from './announced';
import {
  completeImport,
  prepareImport,
  type ImportContext,
  type ImportDeps,
  type ImportStep,
  type ImportSummary,
} from './importFlow';

/** クリップボードに牌譜リンクが無かった理由。 */
export type ClipboardProblem =
  | { kind: 'empty' }
  | { kind: 'no-link' }
  | { kind: 'unreadable'; message: string };

/** 結びつけ先を選んでもらう一覧の 1 行。 */
export interface ChooseOption {
  id: string;
  startedMs: number;
  markCount: number;
  ratingCount: number;
  /** 画面から読み取った局と点数が、この結果に合った半荘。 */
  matching: boolean;
}

export type ImportState =
  /** 牌譜リンクを待つ・見つけた。`checked` は、クリップボードを 1 度読んだか。`notice` は、貼り付けなどでの知らせ。 */
  | { phase: 'prompt'; checked: boolean; problem: ClipboardProblem | null; notice: string | null }
  /** mjai の窓を開いて、ユーザーが Submit を押すのを待っている。 */
  | { phase: 'window' }
  | { phase: 'working'; step: ImportStep; progress: OcrProgress | null }
  | { phase: 'choose'; options: ChooseOption[]; matchingCount: number; warning: string | null }
  | { phase: 'done'; summary: ImportSummary }
  | { phase: 'error'; title: string; message: string };

/** 牌譜リンクを待つ状態（最初の状態）。 */
type PromptState = Extract<ImportState, { phase: 'prompt' }>;

const PROMPT: PromptState = { phase: 'prompt', checked: false, problem: null, notice: null };

/** クリップボードの答え（文字・null）を、文字か null にそろえる（文字でないものは、文字が無いのと同じ）。 */
function textOrNull(value: unknown): string | null {
  return typeof value === 'string' ? value : null;
}

/** 結果を受け取る・結びつけを書くときに使うコマンド（試験では、Tauri の偽物がこれらに答える）。 */
const DEFAULT_DEPS: ImportDeps = {
  listSessions: () => api.listSessions(),
  ocrSessions: (ids) => api.ocrSessions(ids),
  saveReport: (sessionId, text) => api.saveReport(sessionId, text),
  replaceLinks: (sessionId, links) => api.replaceLinks(sessionId, links),
  now: () => Date.now(),
};

export interface ImportFlow {
  state: ImportState;
  /** クリップボードにある牌譜リンク（無ければ null）。 */
  link: PaipuLink | null;
  /** 「この半荘を取り込みますか」と知らせている牌譜リンク（まだ知らせていない新しいリンクだけ）。 */
  offer: PaipuLink | null;
  /** クリップボードを読み直す（取り込みのページを開いたとき・「調べ直す」）。 */
  refreshClipboard: () => Promise<void>;
  /** mjai の窓を開いて、URL 欄に牌譜リンクを入れる。 */
  startMjai: () => Promise<void>;
  /** 開いている mjai の窓を前面に出す。 */
  showMjaiWindow: () => Promise<void>;
  /** やめる（mjai の窓を閉じて、最初の状態に戻る）。 */
  cancel: () => void;
  /** 貼り付けた文字から結果の ID を探して、取り込む。 */
  submitPastedUrl: (text: string) => Promise<void>;
  /** 結果の JSON ファイルを選んで、取り込む。 */
  chooseFile: () => Promise<void>;
  /** 結びつけ先の半荘を選ぶ（null なら、記録の無い半荘として取り込む）。 */
  choose: (sessionId: string | null) => Promise<void>;
  /** 完了・失敗の画面から、最初の状態に戻る。 */
  reset: () => void;
  /** 「取り込みますか」を受ける（取り込みの画面へ移る前に呼ぶ）。 */
  acceptOffer: () => void;
  dismissOffer: () => void;
}

export function useImportFlow(): ImportFlow {
  const [state, setStateRaw] = useState<ImportState>(PROMPT);
  const [link, setLinkRaw] = useState<PaipuLink | null>(null);
  const [offer, setOffer] = useState<PaipuLink | null>(null);

  // 知らせを受ける側が、再描画を待たずに最新の状態を見られるように、同じ値を ref にも持つ。
  const stateRef = useRef(state);
  const linkRef = useRef<PaipuLink | null>(null);
  const contextRef = useRef<ImportContext | null>(null);
  const announcerRef = useRef<PaipuLinkAnnouncer | null>(null);
  // 取り込みの世代。やめる・やり直す・次の取り込みを始めるたびに進めて、古い処理の結果を捨てる。
  const generationRef = useRef(0);
  // 前面に来たときのクリップボードの確認が、いま動いているか。
  const focusCheckBusyRef = useRef(false);

  const setState = useCallback((next: ImportState | ((current: ImportState) => ImportState)) => {
    const value = typeof next === 'function' ? next(stateRef.current) : next;
    stateRef.current = value;
    setStateRaw(value);
  }, []);
  const setLink = useCallback((value: PaipuLink | null) => {
    linkRef.current = value;
    setLinkRaw(value);
  }, []);
  const begin = useCallback(() => {
    generationRef.current += 1;
    return generationRef.current;
  }, []);
  const isCurrent = useCallback((token: number) => generationRef.current === token, []);
  const announcer = useCallback(() => {
    announcerRef.current ??= new PaipuLinkAnnouncer(loadAnnouncedIds());
    return announcerRef.current;
  }, []);
  const remember = useCallback(
    (paipuId: string) => {
      announcer().markAnnounced(paipuId);
      saveAnnouncedIds(announcer().ids());
    },
    [announcer],
  );

  /** 牌譜リンクを待つ状態のときだけ、その状態の知らせ・クリップボードの結果を書き換える。 */
  const patchPrompt = useCallback(
    (patch: Partial<Extract<ImportState, { phase: 'prompt' }>>) => {
      setState((current) =>
        current.phase === 'prompt' ? { ...current, checked: true, ...patch } : current,
      );
    },
    [setState],
  );

  const refreshClipboard = useCallback(async () => {
    let text: string | null;
    try {
      text = textOrNull(await api.readClipboardText());
    } catch (error) {
      setLink(null);
      patchPrompt({ problem: { kind: 'unreadable', message: errorMessage(error) } });
      return;
    }
    const found = text === null ? null : detectPaipuLink(text);
    setLink(found);
    patchPrompt({
      problem: found
        ? null
        : text === null || text.trim() === ''
          ? { kind: 'empty' }
          : { kind: 'no-link' },
    });
  }, [patchPrompt, setLink]);

  /**
   * 検討画面が前面に来たとき: 新しい牌譜リンクなら、一度だけ「取り込みますか」と知らせる（E-15）。
   * 前面に来ると、Rust 側の知らせ・画面の focus・表示の変化が、ほぼ同時に重なって届く。読みにいくのは 1 回にまとめる
   * （Rust 側も読み取りを 1 つずつにしてあるが、同じ答えを何度も取る必要はない）。
   */
  const checkClipboardOnFocus = useCallback(async () => {
    const phase = stateRef.current.phase;
    // 取り込みの途中は、別の知らせで邪魔しない（次に前面に来たときに、知らせる）。
    if (phase === 'window' || phase === 'working' || phase === 'choose') return;
    if (focusCheckBusyRef.current) return;
    focusCheckBusyRef.current = true;
    try {
      let text: string | null;
      try {
        text = textOrNull(await api.readClipboardText());
      } catch {
        return;
      }
      if (text === null) return;
      const fresh = announcer().announce(text);
      if (fresh === null) return;
      saveAnnouncedIds(announcer().ids());
      setLink(fresh);
      setOffer(fresh);
      patchPrompt({ problem: null });
    } finally {
      focusCheckBusyRef.current = false;
    }
  }, [announcer, patchPrompt, setLink]);

  // ---- 受け取った結果を、検査して、結びつけ、保存する ----

  const finish = useCallback(
    async (context: ImportContext, sessionId: string | null, token: number) => {
      setState({ phase: 'working', step: 'saving', progress: null });
      try {
        const summary = await completeImport(DEFAULT_DEPS, context, sessionId);
        if (!isCurrent(token)) return;
        contextRef.current = null;
        setState({ phase: 'done', summary });
      } catch (error) {
        if (!isCurrent(token)) return;
        contextRef.current = null;
        setState({ phase: 'error', title: '保存できませんでした', message: errorMessage(error) });
      }
    },
    [isCurrent, setState],
  );

  const processText = useCallback(
    async (text: string, token: number) => {
      const prepared = await prepareImport(DEFAULT_DEPS, text, (step) => {
        if (isCurrent(token)) setState({ phase: 'working', step, progress: null });
      });
      if (!isCurrent(token)) return;
      if (!prepared.ok) {
        setState({ phase: 'error', ...prepared.failure });
        return;
      }
      const context = prepared.context;
      contextRef.current = context;
      const { match } = context;
      if (match.kind === 'match') {
        await finish(context, match.sessionId, token);
      } else if (match.kind === 'new') {
        await finish(context, null, token);
      } else {
        const matching = new Set(match.matchingIds);
        setState({
          phase: 'choose',
          matchingCount: match.matchingIds.length,
          warning: context.ocrWarning,
          options: match.sessionIds.flatMap((id) => {
            const session = context.sessions.find((s) => s.id === id);
            return session
              ? [
                  {
                    id,
                    startedMs: session.started_ms,
                    markCount: session.mark_count,
                    ratingCount: session.rating_count,
                    matching: matching.has(id),
                  },
                ]
              : [];
          }),
        });
      }
    },
    [finish, isCurrent, setState],
  );

  const processReportId = useCallback(
    async (id: string) => {
      const wasWindow = stateRef.current.phase === 'window';
      const token = begin();
      setState({ phase: 'working', step: 'fetching', progress: null });
      // 窓で Submit を押す代わりに貼り付けから来たときは、開いたままの窓を閉じる。
      if (wasWindow) void api.closeMjaiWindow().catch(() => undefined);
      let text: string;
      try {
        text = await api.fetchReport(id);
      } catch (error) {
        if (!isCurrent(token)) return;
        setState({
          phase: 'error',
          title: '結果を受け取れませんでした',
          message: errorMessage(error),
        });
        return;
      }
      if (!isCurrent(token)) return;
      await processText(text, token);
    },
    [begin, isCurrent, processText, setState],
  );

  // ---- Rust 側からの知らせ ----

  useEffect(() => {
    let alive = true;
    const disposers: Array<() => void> = [];
    const track = (listening: Promise<() => void>) => {
      void listening.then((dispose) => {
        if (alive) disposers.push(dispose);
        else dispose();
      });
    };
    track(
      onMjaiWindow((event) => {
        // 窓を開いて待っているとき以外の知らせは、前の取り込みの名残なので無視する。
        if (stateRef.current.phase !== 'window') return;
        if (event.kind === 'closed') {
          begin();
          setState({
            phase: 'prompt',
            checked: true,
            problem: null,
            notice:
              '結果が出る前に、mjai の窓が閉じられました。取り込みを中止しました。もう一度、「mjai で検討する」を押してください。',
          });
          void refreshClipboard();
        } else {
          void processReportId(event.id);
        }
      }),
    );
    track(
      onOcrProgress((progress) => {
        setState((current) =>
          current.phase === 'working' && current.step === 'reading'
            ? { ...current, progress }
            : current,
        );
      }),
    );
    // 検討画面が前面に来たとき。Rust 側の知らせと、画面自身の focus の、どちらでも拾う（同じリンクは一度しか知らせない）。
    track(onMainWindowFocused(() => void checkClipboardOnFocus()));
    const onFocus = () => void checkClipboardOnFocus();
    const onVisible = () => {
      if (document.visibilityState === 'visible') onFocus();
    };
    window.addEventListener('focus', onFocus);
    document.addEventListener('visibilitychange', onVisible);
    return () => {
      alive = false;
      disposers.forEach((dispose) => dispose());
      window.removeEventListener('focus', onFocus);
      document.removeEventListener('visibilitychange', onVisible);
    };
  }, [begin, checkClipboardOnFocus, processReportId, refreshClipboard, setState]);

  // ---- 画面からの操作 ----

  const startMjai = useCallback(async () => {
    const target = linkRef.current;
    if (target === null) return;
    const token = begin();
    try {
      await api.openMjaiWindow(target.url, readPageBackground());
    } catch (error) {
      if (!isCurrent(token)) return;
      setState({
        phase: 'error',
        title: 'mjai の窓を開けませんでした',
        message: errorMessage(error),
      });
      return;
    }
    if (!isCurrent(token)) return;
    remember(target.paipuId);
    setOffer(null);
    setState({ phase: 'window' });
  }, [begin, isCurrent, remember, setState]);

  const showMjaiWindow = useCallback(async () => {
    const target = linkRef.current;
    if (target === null) return;
    try {
      await api.openMjaiWindow(target.url, readPageBackground());
    } catch (error) {
      setState({
        phase: 'error',
        title: 'mjai の窓を開けませんでした',
        message: errorMessage(error),
      });
    }
  }, [setState]);

  const toPrompt = useCallback(
    (notice: string | null) => {
      begin();
      contextRef.current = null;
      setState({ ...PROMPT, notice });
      void refreshClipboard();
    },
    [begin, refreshClipboard, setState],
  );

  const cancel = useCallback(() => {
    void api.closeMjaiWindow().catch(() => undefined);
    toPrompt(null);
  }, [toPrompt]);

  const reset = useCallback(() => toPrompt(null), [toPrompt]);

  const submitPastedUrl = useCallback(
    async (text: string) => {
      let id: string | null;
      try {
        id = await api.reportIdFromText(text);
      } catch (error) {
        patchPrompt({ notice: errorMessage(error) });
        return;
      }
      if (id === null) {
        patchPrompt({
          notice:
            '貼り付けた文字に、mjai の結果の URL が見つかりません。mjai の結果のページの URL（結果の ID を含むもの）を、そのまま貼り付けてください。',
        });
        return;
      }
      await processReportId(id);
    },
    [patchPrompt, processReportId],
  );

  const chooseFile = useCallback(async () => {
    let selected: string | string[] | null;
    try {
      selected = await openDialog({
        multiple: false,
        directory: false,
        filters: [{ name: '検討結果の JSON', extensions: ['json'] }],
      });
    } catch (error) {
      patchPrompt({ notice: errorMessage(error) });
      return;
    }
    if (typeof selected !== 'string') return;
    const wasWindow = stateRef.current.phase === 'window';
    const token = begin();
    setState({ phase: 'working', step: 'fetching', progress: null });
    if (wasWindow) void api.closeMjaiWindow().catch(() => undefined);
    let text: string;
    try {
      text = await api.readReportFileText(selected);
    } catch (error) {
      if (!isCurrent(token)) return;
      setState({
        phase: 'error',
        title: '結果のファイルを読めませんでした',
        message: errorMessage(error),
      });
      return;
    }
    if (!isCurrent(token)) return;
    await processText(text, token);
  }, [begin, isCurrent, patchPrompt, processText, setState]);

  const choose = useCallback(
    async (sessionId: string | null) => {
      const context = contextRef.current;
      if (context === null || stateRef.current.phase !== 'choose') return;
      await finish(context, sessionId, begin());
    },
    [begin, finish],
  );

  const acceptOffer = useCallback(() => {
    setOffer(null);
    const phase = stateRef.current.phase;
    if (phase === 'done' || phase === 'error') {
      begin();
      setState({ phase: 'prompt', checked: true, problem: null, notice: null });
    }
  }, [begin, setState]);

  const dismissOffer = useCallback(() => setOffer(null), []);

  return useMemo(
    () => ({
      state,
      link,
      offer,
      refreshClipboard,
      startMjai,
      showMjaiWindow,
      cancel,
      submitPastedUrl,
      chooseFile,
      choose,
      reset,
      acceptOffer,
      dismissOffer,
    }),
    [
      state,
      link,
      offer,
      refreshClipboard,
      startMjai,
      showMjaiWindow,
      cancel,
      submitPastedUrl,
      chooseFile,
      choose,
      reset,
      acceptOffer,
      dismissOffer,
    ],
  );
}
