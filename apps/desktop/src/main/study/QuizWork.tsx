/**
 * 出題 1 問の作業の面（左に卓・凡例・手牌、右に答えの欄）。出題（`QuizScreen`）と、半荘を通して見る画面の場面（`SceneWork`）が使う。
 * 状態は `useQuizWork` が持つ（呼ぶ側が、いちばん外の `.qz` の `data-state` に、答え合わせのあとかを入れる）。
 * 手牌の上には、AI の評価の棒の帯をいつも取っておく（打牌の判断の答え合わせのあとだけ、棒が出る。U-43）。凡例は、卓の上の説明のアイコンの中。
 * 他家の手牌（F14、R16-7）: 盤面に裏向きで置き、どれか 1 人の手牌を押すと 3 人分が開く。答えるまでは押せず、表の牌も DOM に出さない（U-1・U-35）。
 * 開いているあいだ、答えの欄の上に「他家の手牌」の欄（聴牌の 1 行・向聴数の折れ線・待ちと点）を出す。開け閉めの状態は、呼ぶ側が持つ（`openHands`）。
 */
import type { BoardState, Decision, ImportedGame } from '@jantama/engine';
import type { ReactNode } from 'react';

import type { AnswerMode } from '../../api/types';
import type { ShownMemo } from '../memos';
import type { ReadsWork } from '../reads/ReadsWork';
import { useReadsPopover } from '../reads/useReadsPopover';
import { useTenpaiPlacement } from '../reads/useTenpaiPlacement';
import { AnswerPanel } from './AnswerPanel';
import { Board, BoardTools, type BoardInfo } from './Board';
import { Hand } from './Hand';
import { OpenHandsBlock, useOpenHandsView, type OpenHandsControl } from './OpenHands';
import type { QuizWorkState } from './useQuizWork';

export interface QuizWorkProps {
  work: QuizWorkState;
  decision: Decision;
  mode: AnswerMode;
  info: BoardInfo;
  /** 見せる盤面。 */
  board: BoardState;
  /** 過去の盤面を見ているか（手牌を押せない。卓の上に「過去の盤面」を出す）。 */
  past: boolean;
  /** 河のどこかに、鳴かれた牌があるか（凡例）。 */
  anyCalled: boolean;
  nextLabel: string;
  onNext: () => void;
  /** 答える前に出す、終局直後のメモの欄（半荘を通して見る画面の迷いの場面）。 */
  memoEditor?: ReactNode;
  /** 答え合わせのあとに、自分の答えの下へ出す「終局直後のメモ」。 */
  memoShown?: readonly ShownMemo[];
  /** 答えの欄のいちばん上に出す、迷いのスクショの欄（迷いマークを結びつけた場面。U-45）。 */
  shots?: ReactNode;
  /** 取り込んだ半荘（他家の手牌を、牌譜から組み立てる）。 */
  game: ImportedGame;
  /** 見せている盤面の、牌譜の位置（他家の手牌を、その時点で開く。過去の盤面は、その時点の手牌）。 */
  eventIndex: number;
  /** 他家の手牌の開け閉め（呼ぶ側が持つ。画面を離れると閉じに戻る）。 */
  openHands: OpenHandsControl;
  /** 読み（F23）。答え合わせのあとだけ渡す（答える前は渡さず、切り替えも数も札も DOM に無い。U-1）。 */
  reads?: ReadsWork | null;
}

export function QuizWork({ work, decision, mode, info, board, past, anyCalled, nextLabel, onNext, memoEditor, memoShown, shots, game, eventIndex, openHands, reads = null }: QuizWorkProps) {
  // 答えるまでは押せない（表の牌は作らない）。答えたあとは、過去の盤面でも押せる（その時点の他家の手牌）
  const view = useOpenHandsView(game, decision.kyokuPosition, eventIndex, openHands, work.revealed);
  // 読み（F23）: 手牌の下の数・他家の席の札・数の吹き出し
  const readsView = reads === null ? null : reads.view;
  const popover = useReadsPopover(readsView, work.items);
  const { bindCol, chips, line: tenpaiLine } = useTenpaiPlacement(readsView === null ? null : readsView.moment);
  return (
    <div className="work">
      <section className="board-col" ref={bindCol} aria-label="盤面と手牌" data-view={past ? 'past' : 'now'}>
        <BoardTools
          riichi={info.riichiAny}
          called={anyCalled}
          call={work.called !== null}
          pastView={past}
          tenpai={view.showing}
          dora={work.dora !== null}
          handsHint={work.revealed}
          reads={
            <>
              {reads?.toggle}
              {tenpaiLine}
            </>
          }
        />
        <Board info={info} step={board} dora={work.dora} target={past ? null : work.calledSeat} hands={view.hands} tenpai={view.tenpai} reads={chips} />
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
          bars={work.bars}
          reads={popover.handReads}
        />
      </section>
      {popover.popover}
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
        shots={shots}
        resolve={work.resolve}
        past={past}
        above={
          view.showing && view.seats !== null ? (
            <>
              {reads?.status}
              <OpenHandsBlock me={game.playerId} seats={view.seats} eventIndex={eventIndex} dora={work.dora} tracks={view.tracks} />
            </>
          ) : (
            reads?.status
          )
        }
      />
    </div>
  );
}
