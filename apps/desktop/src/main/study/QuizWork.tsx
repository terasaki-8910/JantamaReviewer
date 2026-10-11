/**
 * 出題 1 問の作業の面（左に卓・凡例・手牌、右に答えの欄）。出題（`QuizScreen`）と、半荘を通して見る画面の場面（`SceneWork`）が使う。
 * 状態は `useQuizWork` が持つ（呼ぶ側が、いちばん外の `.qz` の `data-state` に、答え合わせのあとかを入れる）。
 */
import type { BoardState, Decision } from '@jantama/engine';
import type { ReactNode } from 'react';

import type { AnswerMode } from '../../api/types';
import type { ShownMemo } from '../memos';
import { AnswerPanel } from './AnswerPanel';
import { Board, Legend, type BoardInfo } from './Board';
import { Hand } from './Hand';
import type { QuizWorkState } from './useQuizWork';

export interface QuizWorkProps {
  work: QuizWorkState;
  decision: Decision;
  mode: AnswerMode;
  info: BoardInfo;
  /** 見せる盤面。 */
  board: BoardState;
  /** 過去の盤面を見ているか（手牌を押せない。凡例に「過去の盤面」を出す）。 */
  past: boolean;
  /** 河のどこかに、鳴かれた牌があるか（凡例）。 */
  anyCalled: boolean;
  nextLabel: string;
  onNext: () => void;
  /** 答える前に出す、終局直後のメモの欄（半荘を通して見る画面の迷いの場面）。 */
  memoEditor?: ReactNode;
  /** 答え合わせのあとに、自分の答えの下へ出す「終局直後のメモ」。 */
  memoShown?: readonly ShownMemo[];
}

export function QuizWork({ work, decision, mode, info, board, past, anyCalled, nextLabel, onNext, memoEditor, memoShown }: QuizWorkProps) {
  return (
    <div className="work">
      <section className="board-col" aria-label="盤面と手牌" data-view={past ? 'past' : 'now'}>
        <Board info={info} step={board} dora={work.dora} target={past ? null : work.calledSeat} />
        <Legend riichi={info.riichiAny} called={anyCalled} call={work.called !== null} pastView={past} />
        <Hand
          items={work.items}
          interactive={!past}
          kind={decision.kind}
          selected={work.selected}
          revealed={work.revealed}
          marks={work.marks}
          used={work.used}
          calledCaption={work.calledFrom === null ? null : `${work.calledFrom}の打牌`}
          dora={work.dora}
          onPick={work.onPick}
        />
      </section>
      <AnswerPanel
        decision={decision}
        mode={mode}
        quiz={work.quiz}
        pickedTile={work.pickedTile}
        options={work.options}
        calledFrom={work.calledFrom}
        dora={work.dora}
        threshold={work.threshold}
        nextLabel={nextLabel}
        onNext={onNext}
        memoEditor={memoEditor}
        memoShown={memoShown}
      />
    </div>
  );
}
