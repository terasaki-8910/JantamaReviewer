/**
 * 出題 1 問の画面（見出し・卓と手牌・答えの欄）。出題（今日の出題）と解き直しが使う。
 * 半荘を通して見る画面（replay/）の場面も、同じ部品（`QuizWork`・`useQuizWork`。中は `Board`・`Hand`・`AnswerPanel`・`useQuizAnswer`）を使う。
 *
 * - 卓は雀魂と同じ配置。判断の 2〜3 巡前から「前の巡目」「次の巡目」で見られる（判断より先は見せない）。過去の盤面は、手牌を押せない
 * - 見出しの実戦の行動（「実戦：打3m」）は、出題だけ。解き直しは、答え合わせまで実戦の行動も AI の答えも出さない（U-1・U-17）
 * - 問題ごとに作り直す（呼ぶ側が `key` に問題の識別を入れる）。答えるまでの時間は、この画面を出した時刻から数える
 * - 答え合わせのあと、自分の答えの下に「終局直後のメモ」（その問題に結びつく迷いのメモ・追加のメモ。F4、U-28）。答える前は、DOM にも無い
 */
import { actualText, keyOfDecision, shantenTag } from '@jantama/engine';
import { useEffect, useMemo, useRef, useState, type ReactNode } from 'react';

import type { AnswerMode, AnswerRow } from '../../api/types';
import { resolveMarks } from '../markCards';
import { memosForDecision } from '../memos';
import { anyCalled, boardInfoOf } from './Board';
import { QuizWork } from './QuizWork';
import { replaySteps } from './steps';
import { useStudy, type Located } from './StudyProvider';
import { useQuizWork } from './useQuizWork';

export interface QuizScreenProps {
  located: Located;
  mode: AnswerMode;
  /** 見出しの上の 1 行（解き直しの「解き直し · 今日の期限 6問」）。 */
  kicker?: ReactNode;
  /** 今日の出題・解き直しの、何問目か。 */
  progress?: { current: number; total: number } | null;
  /** 迷いの問題のとき、何番目の迷いか。 */
  markNumber: number | null;
  /** すでに答えた問題（あれば、答え合わせのあとの形で開く）。 */
  existing: AnswerRow | null;
  /** 解き直しのとき、前の答えのあとの間隔（日）。 */
  previousIntervalDays: number | null;
  nextLabel: string;
  onNext: () => void;
}

function TriangleLeft() {
  return (
    <svg viewBox="0 0 10 10" aria-hidden="true" focusable="false">
      <path d="M8 1v8L2 5z" />
    </svg>
  );
}

function TriangleRight() {
  return (
    <svg viewBox="0 0 10 10" aria-hidden="true" focusable="false">
      <path d="M2 1v8l6-4z" />
    </svg>
  );
}

export function QuizScreen({
  located,
  mode,
  kicker,
  progress = null,
  markNumber,
  existing,
  previousIntervalDays,
  nextLabel,
  onNext,
}: QuizScreenProps) {
  const study = useStudy();
  const { game, decision, session } = located;
  const steps = useMemo(() => replaySteps(game, decision), [game, decision]);
  const last = steps.length - 1;
  const [step, setStep] = useState(last);

  const board = steps[step] ?? decision.board;
  const past = step < last;
  const work = useQuizWork({ decision, sessionId: session.id, mode, board, past, existing, previousIntervalDays });
  const info = useMemo(() => boardInfoOf(decision.board, steps), [decision.board, steps]);
  // 答え合わせのあとにだけ、その問題に結びつくメモを探す（答える前は、探しも、出しもしない）
  const memoShown = useMemo(
    () =>
      work.revealed
        ? memosForDecision({
            memos: session.memos,
            resolved: resolveMarks(game.report, session),
            decisionKey: keyOfDecision(decision),
          })
        : undefined,
    [work.revealed, session, game.report, decision],
  );

  // 巡目の行き来。押したボタンが端で押せなくなったとき、キーボードの位置が消えないよう、もう一方へ移す
  const prevRef = useRef<HTMLButtonElement>(null);
  const nextRef = useRef<HTMLButtonElement>(null);
  const pressed = useRef<'prev' | 'next' | null>(null);
  useEffect(() => {
    const which = pressed.current;
    if (which === null) return;
    pressed.current = null;
    const button = which === 'prev' ? prevRef.current : nextRef.current;
    if (button !== null && button.disabled) (which === 'prev' ? nextRef : prevRef).current?.focus();
  }, [step]);

  // 前の問題の「次の問題へ」や、一覧の行を押して開いたとき（押したボタンが消えて、キーボードの位置が無いとき）は、
  // 最初の操作（手牌の Tab の止まり場所か、答えのボタン）へ移す。サイドバーなどから開いたときは、位置を奪わない
  const rootRef = useRef<HTMLDivElement>(null);
  useEffect(() => {
    if (existing !== null) return;
    const active = document.activeElement;
    if (active !== null && active !== document.body) return;
    rootRef.current
      ?.querySelector<HTMLElement>('.hand .tile-btn[tabindex="0"], .q-choices [role="radio"][tabindex="0"]')
      ?.focus({ preventScroll: true });
  }, [existing]);

  return (
    <div
      className="qz"
      ref={rootRef}
      data-state={work.revealed ? 'revealed' : 'answering'}
      data-dora={study.highlightDora ? 'on' : 'off'}
    >
      <header className="head qhead">
        <div className="q-main">
          {kicker}
          <div className="q-l">
            {progress !== null && (
              <p className="progress">
                <b>{progress.current}</b> / {progress.total}
              </p>
            )}
            <h1 className="title">
              {decision.kyokuLabel} {decision.junme}巡目
            </h1>
            <ul className="q-chips">
              <li className="q-chip">{shantenTag(decision.shanten)}</li>
              {mode === 'quiz' && <li className="q-chip">実戦：{actualText(decision)}</li>}
              {markNumber !== null && <li className="q-chip is-doubt">迷い{markNumber}</li>}
            </ul>
          </div>
        </div>
        <div className="replay" role="group" aria-label="巡目を戻して見る">
          <button
            type="button"
            className="btn"
            ref={prevRef}
            disabled={step <= 0}
            onClick={() => {
              pressed.current = 'prev';
              setStep(Math.max(0, step - 1));
            }}
          >
            <TriangleLeft />
            前の巡目
          </button>
          <span className="turn" aria-live="polite">
            <b>{board.junme}</b>巡目
          </span>
          <button
            type="button"
            className="btn"
            ref={nextRef}
            disabled={step >= last}
            onClick={() => {
              pressed.current = 'next';
              setStep(Math.min(last, step + 1));
            }}
          >
            次の巡目
            <TriangleRight />
          </button>
        </div>
      </header>
      <QuizWork
        work={work}
        decision={decision}
        mode={mode}
        info={info}
        board={board}
        past={past}
        anyCalled={anyCalled(steps)}
        nextLabel={nextLabel}
        onNext={onNext}
        memoShown={memoShown}
      />
    </div>
  );
}
