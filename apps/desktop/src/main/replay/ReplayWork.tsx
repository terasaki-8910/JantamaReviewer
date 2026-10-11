/**
 * 半荘を通して見る画面の作業の面（左に卓・凡例・手牌、右に欄）。
 * - `BrowseWork`: 場面にいないとき。卓は、直前の打牌に印を付ける。手牌は押せない。右は「いまの一手」と場面の一覧
 * - `SceneWork`: 迷いと不一致の場面に着いたとき。出題と同じ（`QuizWork`）。答える前は、AI の候補・確率・順位を出さない（U-1）。
 *   答えは、出題と同じに記録する（`record_answer`・mode は quiz。1 日後の解き直しの予定も入る）。答えた場面は、答え合わせのあとの形で開く。
 *   迷いの場面は、答える前に、その迷いの終局直後のメモ（「候補」「理由」）を書ける・直せる（迷いのカードと同じ保存先。F4、U-28）。
 *   答えたあとは、メモは書き換えられず、自分の答えの下に出る（AI の情報は、答えるまで出さない）
 */
import type { ReplayScene, ReplayTimeline, TimelineStep } from '@jantama/engine';
import { useMemo } from 'react';

import type { AnswerRow, SessionRecord } from '../../api/types';
import type { ResolvedMark } from '../markCards';
import { MarkMemoFields } from '../MarkMemoFields';
import { memoOfMark, memosForDecision } from '../memos';
import { Board, Legend, type BoardInfo } from '../study/Board';
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
  /** 卓の外の決まり（局の中でそろえた、河の段の数など）。 */
  info: BoardInfo;
  /** 局の中のどこかに、鳴かれた牌があるか（凡例）。 */
  anyCalled: boolean;
  scenes: readonly ReplayScene[];
  answered: ReadonlySet<string>;
  go: (g: number) => void;
}

export function BrowseWork({ timeline, step, info, anyCalled, scenes, answered, go }: BrowseWorkProps) {
  const study = useStudy();
  const items = useMemo(() => buildHandItems(step.board, null), [step.board]);
  const dora = useMemo(() => (study.highlightDora ? doraKinds(step.board.doraMarkers) : null), [study.highlightDora, step.board]);
  // 直前の打牌を、その席の河の最後の牌に印する
  const latest = step.event.type === 'dahai' ? step.actor : null;
  return (
    <div className="qz" data-state="browse" data-dora={study.highlightDora ? 'on' : 'off'}>
      <div className="work">
        <section className="board-col" aria-label="盤面と手牌" data-view="now">
          <Board info={info} step={step.board} dora={dora} latest={latest} />
          <Legend riichi={info.riichiAny} called={anyCalled} call={false} pastView={false} latest={latest !== null} />
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
  step: TimelineStep;
  info: BoardInfo;
  anyCalled: boolean;
  scene: ReplayScene;
  /** 半荘（メモを読み書きする）と、迷いマークの結びつけ（答えたあとに出すメモを探す）。 */
  session: SessionRecord;
  resolved: readonly ResolvedMark[];
  /** すでに答えた場面の、保存してある答え。 */
  existing: AnswerRow | null;
  drafts: SceneDrafts;
  nextLabel: string;
  onNext: () => void;
}

export function SceneWork({ step, info, anyCalled, scene, session, resolved, existing, drafts, nextLabel, onNext }: SceneWorkProps) {
  const study = useStudy();
  const reload = study.reloadSessions;
  const sessionId = session.id;
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
  // 答える前: この場面の迷い（`scene.doubts`は迷いの番号）ごとのメモの欄。答えたあと: 結びついたメモを、書き換えずに出す
  const memoEditor =
    scene.doubts.length === 0 ? undefined : (
      <>
        {scene.doubts.map((number) => {
          const mark = session.marks[number - 1];
          return mark === undefined ? null : (
            <MarkMemoFields
              key={mark.id}
              sessionId={sessionId}
              markId={mark.id}
              number={number}
              saved={memoOfMark(session.memos, mark.id)}
              reload={reload}
              reasonLabel="理由"
            />
          );
        })}
      </>
    );
  const memoShown = useMemo(
    () => (work.revealed ? memosForDecision({ memos: session.memos, resolved, decisionKey: key }) : undefined),
    [work.revealed, session.memos, resolved, key],
  );
  return (
    <div className="qz" data-state={work.revealed ? 'revealed' : 'answering'} data-dora={study.highlightDora ? 'on' : 'off'}>
      <QuizWork
        work={work}
        decision={scene.decision}
        mode="quiz"
        info={info}
        board={step.board}
        past={false}
        anyCalled={anyCalled}
        nextLabel={nextLabel}
        onNext={onNext}
        memoEditor={memoEditor}
        memoShown={memoShown}
      />
    </div>
  );
}
