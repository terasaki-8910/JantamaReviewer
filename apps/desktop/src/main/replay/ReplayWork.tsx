/**
 * 半荘を通して見る画面の作業の面（左に卓・凡例・手牌、右に欄）。
 * - `BrowseWork`: 場面にいないとき。卓は、直前の打牌に印を付ける。手牌は押せない。右は「いまの一手」と場面の一覧
 * - `SceneWork`: 迷いと不一致の場面に着いたとき。出題と同じ（`QuizWork`）。答える前は、AI の候補・確率・順位を出さない（U-1）。
 *   答えは、出題と同じに記録する（`record_answer`・mode は quiz。1 日後の解き直しの予定も入る）。答えた場面は、答え合わせのあとの形で開く
 */
import type { ReplayScene, ReplayTimeline, TimelineStep } from '@jantama/engine';
import { useMemo } from 'react';

import type { AnswerRow } from '../../api/types';
import { Board, Legend, anyCalled, boardInfoOf } from '../study/Board';
import { doraKinds } from '../study/dora';
import { Hand, type HandMark } from '../study/Hand';
import { buildHandItems } from '../study/handMarks';
import { QuizWork } from '../study/QuizWork';
import { useStudy } from '../study/StudyProvider';
import type { QuizDraft } from '../study/useQuizAnswer';
import { useQuizWork } from '../study/useQuizWork';
import { NowPanel } from './NowPanel';

const NO_MARKS: ReadonlyMap<number, HandMark> = new Map();
const NO_USED: ReadonlySet<number> = new Set();
const noop = () => undefined;

interface BrowseWorkProps {
  timeline: ReplayTimeline;
  step: TimelineStep;
  scenes: readonly ReplayScene[];
  answered: ReadonlySet<string>;
  go: (g: number) => void;
}

/** 局の中の盤面（卓の大きさを、局の中でそろえるのに使う）。 */
function useKyokuBoards(timeline: ReplayTimeline, step: TimelineStep) {
  const kyoku = timeline.kyokus[step.kyokuPosition];
  return useMemo(() => (kyoku === undefined ? [step.board] : kyoku.steps.map((item) => item.board)), [kyoku, step.board]);
}

export function BrowseWork({ timeline, step, scenes, answered, go }: BrowseWorkProps) {
  const study = useStudy();
  const boards = useKyokuBoards(timeline, step);
  const info = useMemo(() => boardInfoOf(step.board, boards), [step.board, boards]);
  const items = useMemo(() => buildHandItems(step.board, null), [step.board]);
  const dora = useMemo(() => (study.highlightDora ? doraKinds(step.board.doraMarkers) : null), [study.highlightDora, step.board]);
  // 直前の打牌を、その席の河の最後の牌に印する
  const latest = step.event.type === 'dahai' ? step.actor : null;
  return (
    <div className="qz" data-state="browse" data-dora={study.highlightDora ? 'on' : 'off'}>
      <div className="work">
        <section className="board-col" aria-label="盤面と手牌" data-view="now">
          <Board info={info} step={step.board} dora={dora} latest={latest} />
          <Legend riichi={info.riichiAny} called={anyCalled(boards)} call={false} pastView={false} latest={latest !== null} />
          <Hand
            items={items}
            interactive={false}
            kind="discard"
            selected={null}
            revealed={false}
            marks={NO_MARKS}
            used={NO_USED}
            calledCaption={null}
            dora={dora}
            onPick={noop}
          />
        </section>
        <NowPanel timeline={timeline} step={step} scenes={scenes} answered={answered} go={go} />
      </div>
    </div>
  );
}

/** 場面ごとの答えの下書き（場面を離れて、戻ったときに残す）。 */
export type SceneDrafts = Map<string, QuizDraft>;

interface SceneWorkProps {
  timeline: ReplayTimeline;
  step: TimelineStep;
  scene: ReplayScene;
  sessionId: string;
  /** すでに答えた場面の、保存してある答え。 */
  existing: AnswerRow | null;
  drafts: SceneDrafts;
  nextLabel: string;
  onNext: () => void;
}

export function SceneWork({ timeline, step, scene, sessionId, existing, drafts, nextLabel, onNext }: SceneWorkProps) {
  const study = useStudy();
  const boards = useKyokuBoards(timeline, step);
  const info = useMemo(() => boardInfoOf(step.board, boards), [step.board, boards]);
  const key = scene.key;
  const draft = useMemo(
    () => ({ initial: drafts.get(key) ?? null, save: (value: QuizDraft) => void drafts.set(key, value) }),
    [drafts, key],
  );
  const work = useQuizWork({
    decision: scene.decision,
    sessionId,
    mode: 'quiz',
    board: step.board,
    past: false,
    existing,
    previousIntervalDays: null,
    draft,
  });
  return (
    <div className="qz" data-state={work.revealed ? 'revealed' : 'answering'} data-dora={study.highlightDora ? 'on' : 'off'}>
      <QuizWork
        work={work}
        decision={scene.decision}
        mode="quiz"
        info={info}
        board={step.board}
        past={false}
        anyCalled={anyCalled(boards)}
        nextLabel={nextLabel}
        onNext={onNext}
      />
    </div>
  );
}
