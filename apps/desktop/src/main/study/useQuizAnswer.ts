/**
 * 出題 1 問の答えの状態: 答える → 答え合わせ（記録）。出題・解き直し・半荘を通して見る画面が、同じ動きで使う。
 *
 * - 答え（打牌なら牌、ほかはボタン）と理由（1 行）が両方そろうまで、答え合わせは押せない（U-2）
 * - 一度選んだものを別のものに変えたら、選び直し 1 回（選び外しと、同じ種類の牌どうしは数えない。R8-6）
 * - 答え合わせを押した時刻・見せた時刻・答えるまでの時間・選び直した回数・正解か・次の予定を、答えとして保存する
 *   （保存できなければ、答える前の画面に戻して、理由を出す。何も記録しない）
 * - 答え合わせの内容（AI の評価）は、保存に成功してから、画面に出す（答える前の画面には、AI の情報を一切出さない。U-1）
 * すでに答えた問題（出題）を開いたときは、保存してある答えから、答え合わせのあとの形で始める。
 * 半荘を通して見る画面は、場面を離れても戻ってこられるので、答える前の下書き（選んだ答え・理由・選び直した回数・見せた時刻）を、
 * 呼ぶ側の置き場（`draft`）に預けられる。戻ったときは、その下書きから始める（答えるまでの時間は、最初に見せたときから数える）。
 */
import {
  keyOfDecision,
  plainTile,
  scheduleFirstReview,
  scheduleReview,
  studyDate,
  type Decision,
  type QuizChoice,
} from '@jantama/engine';
import { useCallback, useEffect, useEffectEvent, useMemo, useRef, useState } from 'react';

import { errorMessage } from '../../api/tauri';
import type { AnswerMode, AnswerRow, NewAnswer } from '../../api/types';
import { buildReveal, type RevealModel } from './reveal';

export type QuizStage = 'answering' | 'saving' | 'revealed';

/** 答える前の下書き。 */
export interface QuizDraft {
  choice: QuizChoice | null;
  reason: string;
  reselects: number;
  /** 最後に選んだ答えの鍵（選び直しの数え方に使う）。 */
  committed: string | null;
  /** 問題を最初に見せた時刻（ミリ秒）。 */
  shownAt: number;
}

/** 下書きの置き場。`initial` は、前に預けた下書き（無ければ null）。 */
export interface QuizDraftStore {
  initial: QuizDraft | null;
  save: (draft: QuizDraft) => void;
}

export interface QuizAnswerOptions {
  decision: Decision;
  sessionId: string;
  mode: AnswerMode;
  /** 正解とする確率の下限（設定の「大きな不一致の基準」）。 */
  threshold: number;
  /** 解き直しのとき、前の答えのあとの間隔（日）。出題では null。 */
  previousIntervalDays: number | null;
  /** すでに答えた出題。あれば、答え合わせのあとの形で始める。 */
  existing: AnswerRow | null;
  record: (answer: NewAnswer) => Promise<AnswerRow>;
  /** 答える前の下書きの置き場（任意）。すでに答えた問題には使わない。 */
  draft?: QuizDraftStore;
}

/** 解き直しの結果（E-5・R8-6）。 */
export interface Verdict {
  correct: boolean;
  /** 次の解き直しまでの間隔（日）と、その日（YYYY-MM-DD）。 */
  intervalDays: number;
  dueDate: string;
  /** 前の間隔（日）。 */
  previousDays: number | null;
  reselected: boolean;
}

export interface QuizAnswer {
  stage: QuizStage;
  choice: QuizChoice | null;
  reason: string;
  setReason: (value: string) => void;
  /** 答えを選ぶ（null は、選び外し）。 */
  choose: (choice: QuizChoice | null) => void;
  reselects: number;
  canReveal: boolean;
  /** 答え合わせ。保存に成功したら true。 */
  reveal: () => Promise<boolean>;
  /** 答えるまでの時間（秒）。答え合わせのあとだけ。 */
  elapsedSec: number | null;
  /** 保存した答え（答え合わせのあと）。 */
  row: AnswerRow | null;
  /** 答え合わせの内容（AI の評価）。答え合わせのあとだけ。 */
  model: RevealModel | null;
  /** 解き直しの結果（解き直しの答え合わせのあと）。 */
  verdict: Verdict | null;
  /** 保存できなかった理由。 */
  error: string | null;
}

function keyOf(choice: QuizChoice): string {
  return choice.type === 'dahai' ? plainTile(choice.tile) : choice.id;
}

export function useQuizAnswer(options: QuizAnswerOptions): QuizAnswer {
  const { decision, sessionId, mode, threshold, previousIntervalDays, existing, record, draft } = options;
  // 前に預けた下書き（すでに答えた問題では使わない）
  const [restored] = useState(() => (existing === null ? (draft?.initial ?? null) : null));
  // 問題を見せた時刻（見せたあとの最初の描画で決める。呼ぶ側は、問題ごとに作り直す。下書きがあれば、最初に見せた時刻のまま）
  const shownAt = useRef(restored?.shownAt ?? 0);
  useEffect(() => {
    if (shownAt.current === 0) shownAt.current = Date.now();
  }, []);
  const committed = useRef<string | null>(restored?.committed ?? null);
  const [stage, setStage] = useState<QuizStage>(existing === null ? 'answering' : 'revealed');
  const [choice, setChoice] = useState<QuizChoice | null>(
    existing === null ? (restored?.choice ?? null) : (existing.choice as QuizChoice),
  );
  const [reason, setReason] = useState(existing?.reason ?? restored?.reason ?? '');
  const [reselects, setReselects] = useState(existing?.reselect_count ?? restored?.reselects ?? 0);

  // 答える前の下書きを、置き場に預ける（選んだ答え・理由・選び直した回数が変わるたびに）
  const hasDraft = draft !== undefined;
  const saveDraft = useEffectEvent((snapshot: QuizDraft) => draft?.save(snapshot));
  useEffect(() => {
    if (!hasDraft || stage !== 'answering') return;
    saveDraft({ choice, reason, reselects, committed: committed.current, shownAt: shownAt.current });
  }, [hasDraft, stage, choice, reason, reselects]);
  const [row, setRow] = useState<AnswerRow | null>(existing);
  const [elapsedSec, setElapsedSec] = useState<number | null>(existing === null ? null : existing.duration_ms / 1000);
  const [error, setError] = useState<string | null>(null);

  const choose = useCallback((next: QuizChoice | null) => {
    if (next === null) {
      setChoice(null);
      return;
    }
    const key = keyOf(next);
    if (committed.current !== null && committed.current !== key) setReselects((n) => n + 1);
    committed.current = key;
    setChoice(next);
  }, []);

  const canReveal = stage === 'answering' && choice !== null && reason.trim().length > 0;

  const reveal = useCallback(async (): Promise<boolean> => {
    if (!canReveal || choice === null) return false;
    const answeredAt = Date.now();
    const durationMs = Math.max(0, answeredAt - shownAt.current);
    const model = buildReveal(decision, choice, threshold);
    const today = studyDate(new Date(answeredAt));
    const schedule =
      mode === 'quiz'
        ? scheduleFirstReview(today)
        : scheduleReview(previousIntervalDays, model.correct, today, reselects);
    setStage('saving');
    setError(null);
    try {
      const saved = await record({
        session_id: sessionId,
        decision_key: keyOfDecision(decision),
        mode,
        shown_at: shownAt.current,
        answered_at: answeredAt,
        choice,
        reason: reason.trim(),
        duration_ms: durationMs,
        reselect_count: reselects,
        correct: model.correct,
        causes: [],
        principle: '',
        maka_move: null,
        interval_days: schedule.intervalDays,
        due_date: schedule.dueDate,
      });
      setRow(saved);
      setElapsedSec(durationMs / 1000);
      setStage('revealed');
      return true;
    } catch (failure) {
      setStage('answering');
      setError(`答えを保存できませんでした: ${errorMessage(failure)}`);
      return false;
    }
  }, [canReveal, choice, decision, mode, previousIntervalDays, reason, record, reselects, sessionId, threshold]);

  const model = useMemo(
    () => (stage === 'revealed' && choice !== null ? buildReveal(decision, choice, threshold) : null),
    [stage, choice, decision, threshold],
  );

  const verdict = useMemo<Verdict | null>(() => {
    if (mode !== 'review' || stage !== 'revealed' || row === null) return null;
    return {
      correct: row.correct,
      intervalDays: row.interval_days,
      dueDate: row.due_date,
      previousDays: previousIntervalDays,
      reselected: row.reselect_count >= 1,
    };
  }, [mode, stage, row, previousIntervalDays]);

  return { stage, choice, reason, setReason, choose, reselects, canReveal, reveal, elapsedSec, row, model, verdict, error };
}
