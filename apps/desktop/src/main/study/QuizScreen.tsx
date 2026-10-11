/**
 * 出題 1 問の画面（見出し・卓と手牌・答えの欄）。出題（今日の出題）と解き直しが使う。
 * 半荘を通して見る画面（あとで作る）も、同じ部品（`Board`・`Hand`・`AnswerPanel`・`useQuizAnswer`）を使う。
 *
 * - 卓は雀魂と同じ配置。判断の 2〜3 巡前から「前の巡目」「次の巡目」で見られる（判断より先は見せない）。過去の盤面は、手牌を押せない
 * - 見出しの実戦の行動（「実戦：打3m」）は、出題だけ。解き直しは、答え合わせまで実戦の行動も AI の答えも出さない（U-1・U-17）
 * - 問題ごとに作り直す（呼ぶ側が `key` に問題の識別を入れる）。答えるまでの時間は、この画面を出した時刻から数える
 */
import { actualText, answerOptions, calledTileOf, shantenTag, type Seat } from '@jantama/engine';
import { useEffect, useMemo, useRef, useState, type ReactNode } from 'react';

import type { AnswerMode, AnswerRow } from '../../api/types';
import { AnswerPanel } from './AnswerPanel';
import { Board, boardInfoOf, Legend, anyCalled } from './Board';
import { doraKinds } from './dora';
import { Hand, type HandMark } from './Hand';
import { buildHandItems, handMarks, usedIndices } from './handMarks';
import { relationName } from './labels';
import { replaySteps } from './steps';
import { useStudy, type Located } from './StudyProvider';
import { useQuizAnswer } from './useQuizAnswer';

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

const NO_MARKS: ReadonlyMap<number, HandMark> = new Map();
const NO_USED: ReadonlySet<number> = new Set();

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
  const [selected, setSelected] = useState<number | null>(null);

  const quiz = useQuizAnswer({
    decision,
    sessionId: session.id,
    mode,
    threshold: study.threshold,
    previousIntervalDays,
    existing,
    record: study.recordAnswer,
  });

  const options = useMemo(() => answerOptions(decision), [decision]);
  // 他家の打牌への判断（鳴き・ロン）で、鳴く牌。手牌の右に離して置く
  const called = decision.kind === 'discard' ? null : calledTileOf(decision);
  const calledSeat = called === null ? null : (decision.entry.last_actor as Seat);

  const board = steps[step] ?? decision.board;
  const past = step < last;
  const items = useMemo(() => buildHandItems(board, past ? null : called), [board, past, called]);
  const dora = useMemo(() => (study.highlightDora ? doraKinds(board.doraMarkers) : null), [study.highlightDora, board]);
  const info = useMemo(() => boardInfoOf(decision.board, steps), [decision.board, steps]);
  const revealed = quiz.stage === 'revealed';

  const marks = useMemo(() => {
    const { choice, model } = quiz;
    if (!revealed || past || decision.kind !== 'discard' || model === null) return NO_MARKS;
    if (choice === null || choice.type !== 'dahai') return NO_MARKS;
    const actual = decision.entry.actual;
    return handMarks(items, {
      you: choice.tile,
      act: model.actualTile,
      top: model.topTile,
      actTsumogiri: actual.type === 'dahai' && actual.tsumogiri,
    });
  }, [revealed, past, decision, items, quiz]);

  const used = useMemo(() => {
    const { choice } = quiz;
    if (past || choice === null || choice.type !== 'option') return NO_USED;
    const option = options.find((candidate) => candidate.id === choice.id);
    return option === undefined ? NO_USED : usedIndices(items, option.use);
  }, [past, quiz, options, items]);

  const onPick = (index: number) => {
    if (past || quiz.stage !== 'answering') return;
    const item = items[index];
    if (item === undefined || item.called) return;
    if (selected === index) {
      setSelected(null);
      quiz.choose(null);
    } else {
      setSelected(index);
      quiz.choose({ type: 'dahai', tile: item.tile });
    }
  };

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

  const pickedTile = quiz.choice !== null && quiz.choice.type === 'dahai' ? quiz.choice.tile : null;
  const calledFrom = calledSeat === null ? null : relationName(decision.board.playerId, calledSeat);

  return (
    <div className="qz" data-state={revealed ? 'revealed' : 'answering'} data-dora={study.highlightDora ? 'on' : 'off'}>
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
      <div className="work">
        <section className="board-col" aria-label="盤面と手牌" data-view={past ? 'past' : 'now'}>
          <Board info={info} step={board} dora={dora} target={past ? null : calledSeat} />
          <Legend riichi={info.riichiAny} called={anyCalled(steps)} call={called !== null} pastView={past} />
          <Hand
            items={items}
            interactive={!past}
            kind={decision.kind}
            selected={selected}
            revealed={revealed}
            marks={marks}
            used={used}
            calledCaption={calledFrom === null ? null : `${calledFrom}の打牌`}
            dora={dora}
            onPick={onPick}
          />
        </section>
        <AnswerPanel
          decision={decision}
          mode={mode}
          quiz={quiz}
          pickedTile={pickedTile}
          options={options}
          calledFrom={calledFrom}
          dora={dora}
          threshold={study.threshold}
          nextLabel={nextLabel}
          onNext={onNext}
        />
      </div>
    </div>
  );
}
