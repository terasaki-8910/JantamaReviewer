/**
 * 半荘を通して見る画面の作業の面（左に卓・凡例・手牌、右に欄）。
 * - `BrowseWork`: 場面にいないとき。卓は、直前の打牌に印を付ける。手牌は押せない。右は「いまの一手」と場面の一覧。
 *   答える場面でない自分の判断の手番は、AI の評価をいつも出す（U-43）: 打牌の判断は手牌の上の棒、ほかの判断は右の欄の一覧
 * - `SceneWork`: 迷いと悪手の場面に着いたとき。出題と同じ（`QuizWork`）。答える前は、AI の候補・確率・順位を出さない（U-1）。
 *   答えは、出題と同じに記録する（`record_answer`・mode は quiz。1 日後の解き直しの予定も入る）。答えた場面は、答え合わせのあとの形で開く。
 *   迷いの場面は、答える前に、その迷いの終局直後のメモ（「候補」「理由」）を書ける・直せる（迷いのカードと同じ保存先。F4、U-28）。
 *   答えたあとは、メモは書き換えられず、自分の答えの下に出る（AI の情報は、答えるまで出さない）
 *   迷いの場面は、答えの欄のいちばん上に、その迷いのスクショの欄（前・次の手に付け替えられる。付け替えた先の場面へは、呼ぶ側が移る。U-45）
 * - 他家の手牌（F14、R15-5、R16-7）は、盤面に裏向きで置く。どれか 1 人の手牌を押すと 3 人分が開き、もう一度押すと閉じる。場面にいない手は、いつでも押せる。
 *   開いているあいだ、場面にいない手と、答えたあとの場面は、右の欄の上に「他家の手牌」の欄（聴牌の 1 行・向聴数の折れ線・待ちと点）を出し、
 *   盤面の河に聴牌になった打牌の枠を付ける。答える場面は、答えるまで、押せず、表の牌も DOM に出さない（U-35）。
 *   開け閉めの状態は、手を進めても残る（呼ぶ側が持つ。画面を離れると閉じに戻る）
 */
import type { DecisionRef, ImportedGame, ReplayScene, ReplayTimeline, TimelineStep } from '@jantama/engine';
import { useMemo } from 'react';

import type { AnswerRow, SessionRecord } from '../../api/types';
import type { ResolvedMark } from '../markCards';
import { MarkMemoFields } from '../MarkMemoFields';
import { memoOfMark, memosForDecision } from '../memos';
import type { ReadsWork } from '../reads/ReadsWork';
import { useReadsPopover } from '../reads/useReadsPopover';
import { useTenpaiPlacement } from '../reads/useTenpaiPlacement';
import { handBars } from '../study/aiBars';
import { Board, BoardTools, type BoardInfo } from '../study/Board';
import { doraKinds } from '../study/dora';
import { Hand, type HandMark } from '../study/Hand';
import { buildHandItems } from '../study/handMarks';
import { HesitationShots } from '../study/HesitationShots';
import { OpenHandsBlock, useOpenHandsView, type OpenHandsControl } from '../study/OpenHands';
import { QuizWork } from '../study/QuizWork';
import { browseBars } from '../study/reveal';
import { useStudy } from '../study/StudyProvider';
import type { QuizDraft } from '../study/useQuizAnswer';
import { useQuizWork } from '../study/useQuizWork';
import { NowPanel } from './NowPanel';

const NO_MARKS: ReadonlyMap<number, HandMark> = new Map();
const NO_USED: ReadonlySet<number> = new Set();
const noop = () => undefined;

interface BrowseWorkProps {
  /** 他家の手牌を組み立てる、取り込んだ半荘。 */
  game: ImportedGame;
  /** 他家の手牌の開け閉め。 */
  openHands: OpenHandsControl;
  timeline: ReplayTimeline;
  step: TimelineStep;
  /** 卓の外の決まり（局の中でそろえた、河の段の数など）。 */
  info: BoardInfo;
  /** 局の中のどこかに、鳴かれた牌があるか（凡例）。 */
  anyCalled: boolean;
  scenes: readonly ReplayScene[];
  answered: ReadonlySet<string>;
  go: (g: number) => void;
  /** 読み（F23）の、卓の上の切り替え・右の欄の上の状態の行・手牌の下と他家の席と吹き出しに出す場面。 */
  reads?: ReadsWork | null;
}

export function BrowseWork({ game, openHands, timeline, step, info, anyCalled, scenes, answered, go, reads = null }: BrowseWorkProps) {
  const study = useStudy();
  const items = useMemo(() => buildHandItems(step.board, null), [step.board]);
  const dora = useMemo(() => (study.highlightDora ? doraKinds(step.board.doraMarkers) : null), [study.highlightDora, step.board]);
  // 自分の判断の手番: 打牌の判断は手牌の上の棒、ほかの判断は右の欄の一覧（答える場面ではないので、いつも出す）
  const { decision } = step;
  const bars = useMemo(
    () => (decision !== null && decision.kind === 'discard' ? handBars(items, decision.entry, null) : null),
    [decision, items],
  );
  const evaluation = useMemo(() => (decision === null ? null : browseBars(decision)), [decision]);
  // 直前の打牌を、その席の河の最後の牌に印する
  const latest = step.event.type === 'dahai' ? step.actor : null;
  // 場面にいない手は、他家の手牌をいつでも開ける
  const view = useOpenHandsView(game, step.kyokuPosition, step.eventIndex, openHands, true);
  // 読み（F23）。盤面を見ているだけの手は、いつでも出せる（見せる場面が無い手では、数も札も出さない）
  const readsView = reads === null ? null : reads.view;
  const popover = useReadsPopover(readsView, items);
  const { bindCol, chips, line: tenpaiLine } = useTenpaiPlacement(readsView === null ? null : readsView.moment);
  return (
    <div className="qz" data-state="browse" data-dora={study.highlightDora ? 'on' : 'off'}>
      <div className="work">
        <section className="board-col" ref={bindCol} aria-label="盤面と手牌" data-view="now">
          <BoardTools
            riichi={info.riichiAny}
            called={anyCalled}
            call={false}
            pastView={false}
            latest={latest !== null}
            tenpai={view.showing}
            dora={dora !== null}
            handsHint
            reads={
              <>
                {reads?.toggle}
                {tenpaiLine}
              </>
            }
          />
          <Board info={info} step={step.board} dora={dora} latest={latest} hands={view.hands} tenpai={view.tenpai} reads={chips} />
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
            bars={bars}
            reads={popover.handReads}
          />
        </section>
        {popover.popover}
        <NowPanel
          timeline={timeline}
          step={step}
          scenes={scenes}
          answered={answered}
          go={go}
          evaluation={evaluation}
          dora={dora}
          above={
            view.showing && view.seats !== null ? (
              <>
                {reads?.status}
                <OpenHandsBlock me={game.playerId} seats={view.seats} eventIndex={step.eventIndex} dora={dora} tracks={view.tracks} />
              </>
            ) : (
              reads?.status
            )
          }
        />
      </div>
    </div>
  );
}

/** 場面ごとの答えの下書き（場面を離れて、戻ったときに残す）。 */
export type SceneDrafts = Map<string, QuizDraft>;

interface SceneWorkProps {
  game: ImportedGame;
  /** 他家の手牌の開け閉め（答えたあとだけ押せる。開いていれば、答えたあとに、盤面に表向きで出て、欄が出る）。 */
  openHands: OpenHandsControl;
  step: TimelineStep;
  info: BoardInfo;
  anyCalled: boolean;
  scene: ReplayScene;
  /** 半荘（メモを読み書きする）と、迷いマークの結びつけ（答えたあとに出すメモを探す）。 */
  session: SessionRecord;
  resolved: readonly ResolvedMark[];
  /** この半荘のすべての判断（位置だけの追加のメモを、位置にある判断に結びつけて出すため）。 */
  decisions: readonly DecisionRef[];
  /** すでに答えた場面の、保存してある答え。 */
  existing: AnswerRow | null;
  drafts: SceneDrafts;
  nextLabel: string;
  onNext: () => void;
  /** 迷いのスクショの欄で、迷いを前・次の手に付け替えて、保存できたあと（付け替えた先の場面へ移る）。 */
  onRelinked: (mark: ResolvedMark, to: DecisionRef) => void;
  /** 付け替えたあと、キーボードの位置を渡す迷いの記録の番号（付け替えた先の場面の、その迷いの写真へ）。 */
  focusMarkId: number | null;
  onFocusDone: () => void;
  /** 読み（F23）。答えたあとの場面でだけ使う（答える前は渡されても使わない。U-1）。 */
  reads?: ReadsWork | null;
}

export function SceneWork({
  game,
  openHands,
  step,
  info,
  anyCalled,
  scene,
  session,
  resolved,
  decisions,
  existing,
  drafts,
  nextLabel,
  onNext,
  onRelinked,
  focusMarkId,
  onFocusDone,
  reads = null,
}: SceneWorkProps) {
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
  // 迷いだけを記録する設定が入のときは、答える前のメモの欄を出さない（答えたあとの、書いてあるメモは出す。F0、U-46）
  const memoEditor =
    study.doubtOnly || scene.doubts.length === 0 ? undefined : (
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
    () => (work.revealed ? memosForDecision({ memos: session.memos, resolved, decisionKey: key, decisions }) : undefined),
    [work.revealed, session.memos, resolved, decisions, key],
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
        shots={
          scene.doubts.length === 0 ? undefined : (
            <HesitationShots
              decisionKey={key}
              session={session}
              resolved={resolved}
              decisions={decisions}
              onRelinked={onRelinked}
              focusMarkId={focusMarkId}
              onFocusDone={onFocusDone}
            />
          )
        }
        game={game}
        eventIndex={step.eventIndex}
        openHands={openHands}
        reads={work.revealed ? reads : null}
      />
    </div>
  );
}
