/**
 * 半荘を通して見る画面（F12）。取り込んだ半荘を、卓の配置の盤面で、1 手ずつ・1 巡ずつ・局ごとに進めて見る。
 *
 * - 1 手は、全員の打牌と鳴きの 1 つずつ（配牌・自分のツモ・リーチの宣言・カンと、局の終わりも 1 手）。盤面は、牌譜の再生（E-2）と同じ
 * - 迷いの場面（迷いマークを結びつけた判断）と悪手の場面（設定で、AI の1位と違う判断も飛び先に追加）は、位置の帯・
 *   場面の一覧から飛べる。場面に着くと、出題と同じ形で答えられる。答える前は、AI の候補・確率・順位を画面にも DOM にも出さない（U-1）
 * - 答えは、出題と同じに記録する（mode は quiz。1 日後の解き直しの予定が入り、今日の出題でも「答えた」になる）。
 *   答えた場面は、答え合わせのあとの形で開く。「次の迷いへ」「次の悪手へ」は、答えた場面も通る
 * - キー（既定は、, . で 1 手、← → で自分の判断、↑ ↓ で悪手、Shift+↑ ↓ で迷い、Shift+← → で局。割り当ては変えられる）
 * - 半荘を通して見る間、答えの下書き（選んだ答え・理由）は、場面を離れても残す（戻ると、続きから。答えるまでの時間は、最初に見たときから）
 * - 読み（F23）: 卓の上の「読み」を入にすると、自分のツモ・チー・ポンの手で、手牌の下に牌ごとの待たれる確率、他家の席に聴牌の確率が出る。
 *   盤面を見ているだけの手と、答えたあとの場面にだけある（答える前の場面には、切り替えも数も無く、読みのコマンドも呼ばない。U-1）。キーでも切り替える
 */
import {
  actualText,
  buildReplayTimeline,
  findDecisionByKey,
  listDecisionRefs,
  listReplayScenes,
  shantenTag,
  type DecisionRef,
  type ImportedGame,
} from '@jantama/engine';
import { useCallback, useLayoutEffect, useMemo, useRef, useState, useSyncExternalStore, type CSSProperties, type RefObject } from 'react';

import type { SessionRecord } from '../../api/types';
import { resolveMarks, type ResolvedMark } from '../markCards';
import type { ReadsMomentView } from '../reads/explain';
import { momentAtStep, momentFor } from '../reads/moments';
import { ReadsFeatureStatus, type ReadsWork } from '../reads/ReadsWork';
import { ReadsToggle } from '../reads/ReadsToggle';
import { useReadsFeature } from '../reads/useReadsFeature';
import { anyCalled, boardInfoOf } from '../study/Board';
import { useGameTracks } from '../study/OpenHands';
import { latestAnswerFor } from '../study/QuizPage';
import { useStudy } from '../study/StudyProvider';
import { relationName } from '../study/labels';
import { ControlBar } from './ControlBar';
import { REPLAY_ACTIONS } from './keys';
import { READS_BAND_PX, compactBelowHeight, replayNav, replayStops, sceneTags, turnLabel } from './replayModel';
import { BrowseWork, SceneWork, type SceneDrafts } from './ReplayWork';
import type { StripTick } from './Strip';
import { useReplayKeys, type ReplayHandlers } from './useReplayKeys';
import { useFineMissOnly } from './useFineMissOnly';
import { useReplaySettings } from './useReplaySettings';

function subscribeResize(onChange: () => void): () => void {
  window.addEventListener('resize', onChange);
  return () => window.removeEventListener('resize', onChange);
}

/** 窓の高さ。 */
function useWindowHeight(): number {
  return useSyncExternalStore(subscribeResize, () => window.innerHeight);
}

/**
 * 操作の段の「飛ぶ」段（悪手・迷い）が、窓の幅で折り返して増えた高さ（px。1 行のときは 0）。
 * 3 つの段が 1 行に収まる広さなら 0、収まらなければ 1 行ぶん（36px）ずつ。卓の外の高さ（`--chrome-h`）はそのまま、この分だけ卓を小さくする
 * （`.rp` の `--bar-extra`。文書全体をスクロールさせない。U-39）。レイアウトのない環境（試験の jsdom）では、いつも 0。
 */
function useBarExtra(rootRef: RefObject<HTMLElement | null>): number {
  const [extra, setExtra] = useState(0);
  useLayoutEffect(() => {
    const root = rootRef.current;
    const jumps = root?.querySelector<HTMLElement>('.pb-jumps') ?? null;
    if (jumps === null) return undefined;
    const measure = () => {
      const groups = [...jumps.querySelectorAll<HTMLElement>('.jump')];
      const oneRow = groups.length === 0 ? 0 : Math.min(...groups.map((group) => group.offsetHeight));
      setExtra(Math.max(0, jumps.offsetHeight - oneRow));
    };
    measure();
    if (typeof ResizeObserver === 'undefined') return undefined;
    const observer = new ResizeObserver(measure);
    observer.observe(jumps);
    return () => observer.disconnect();
  }, [rootRef]);
  return extra;
}

export interface ReplayScreenProps {
  session: SessionRecord;
  game: ImportedGame;
  /** 開く判断の鍵（迷いのカードの「この局面を解く」から開くとき）。無ければ半荘の頭から。 */
  startKey?: string;
}

export function ReplayScreen({ session, game, startKey }: ReplayScreenProps) {
  const study = useStudy();
  const settings = useReplaySettings();
  const timeline = useMemo(() => buildReplayTimeline(game), [game]);
  const resolved = useMemo(() => resolveMarks(game.report, session), [game.report, session]);
  const decisionRefs = useMemo(() => listDecisionRefs(game.report), [game.report]);
  const markKeys = useMemo(
    () => resolved.map((mark) => (mark.resolution.kind === 'linked' ? mark.resolution.ref.key : null)),
    [resolved],
  );
  // この半荘で解決した局面の鍵（F16）。解決した場面は、場面の一覧と位置の帯には薄く残り、前・次の移動では止まらない
  const resolvedKeys = useMemo(() => new Set(Object.keys(session.resolved.decisions)), [session.resolved]);
  const scenes = useMemo(
    () =>
      listReplayScenes(timeline, game.decisions, {
        markKeys,
        includeAll: settings.showAllMismatches,
        resolvedKeys,
      }),
    [timeline, game.decisions, markKeys, settings.showAllMismatches, resolvedKeys],
  );
  // 「細かいミスだけ」（F17）。入れると、前・次の迷いと迷いの数が、細かいミスだけになる
  const [fineMissOnly, setFineMissOnly] = useFineMissOnly();
  const stops = useMemo(() => replayStops(timeline, scenes, { fineMissOnly }), [timeline, scenes, fineMissOnly]);

  const [g, setG] = useState(() => {
    const decision = startKey === undefined ? undefined : findDecisionByKey(game, startKey);
    return decision === undefined ? 0 : (timeline.stepOfDecision.get(decision.index) ?? 0);
  });
  // 迷いを付け替えたあと、付け替えた先の手の写真へキーボードの位置を渡す依頼。移った先の手と組にして持つ（下の `onRelinked`）
  const [focusRequest, setFocusRequest] = useState<{ markId: number; step: number } | null>(null);
  const last = timeline.steps.length - 1;
  const go = useCallback(
    (to: number) => {
      setG(Math.max(0, Math.min(last, to)));
      // どの手へ移るときも、依頼は捨てる（写真が見つからないまま残ると、あとでその迷いの場面を開いたとき、思いがけず写真へ移ってしまう）
      setFocusRequest(null);
    },
    [last],
  );
  const nav = useMemo(() => replayNav(timeline, stops, g), [timeline, stops, g]);

  const step = timeline.steps[g];
  const kyoku = step === undefined ? undefined : timeline.kyokus[step.kyokuPosition];
  const scene = scenes.find((item) => item.step === g) ?? null;

  // 卓の外の決まり（河の段の数など）は、局の中でそろえる（手を進めても、卓の大きさが変わらないように）
  const boards = useMemo(() => (kyoku === undefined ? [] : kyoku.steps.map((item) => item.board)), [kyoku]);
  const info = useMemo(() => (step === undefined ? null : boardInfoOf(step.board, boards)), [step, boards]);
  const calledSomewhere = useMemo(() => anyCalled(boards), [boards]);
  // 窓の高さが足りないときは、卓を小さい配置にする（操作の段・卓・手牌が、1 画面に入るように）
  const windowHeight = useWindowHeight();
  const rootRef = useRef<HTMLDivElement>(null);
  const barExtra = useBarExtra(rootRef);
  const [drafts] = useState<SceneDrafts>(() => new Map());
  // 他家の手牌の開け閉め（盤面の手牌を押す。F14、R16-7）: 手を進めても、開いたままにする（この画面を離れると、閉じに戻る）
  const [handsOpen, setHandsOpen] = useState(false);
  const openHands = useMemo(() => ({ open: handsOpen, onToggle: () => setHandsOpen((value) => !value) }), [handsOpen]);

  const answered = useMemo(
    () =>
      new Set(
        study.answers.filter((row) => row.session_id === session.id && row.mode === 'quiz').map((row) => row.decision_key),
      ),
    [study.answers, session.id],
  );

  // 読み（F23）。盤面を見ているだけの手と、答えたあとの場面でだけ使う（答える前の場面では、設定も読みも呼ばない）
  const readsActive = scene === null || answered.has(scene.key);
  const reads = useReadsFeature(session.id, readsActive);
  const { visible: readsVisible, reads: readsData, toggle: toggleReads, loaded: readsLoaded } = reads;
  const readsView = useMemo<ReadsMomentView | null>(() => {
    if (!readsVisible || readsData === null || step === undefined) return null;
    const moment = momentFor(readsData, momentAtStep(step, game.playerId));
    return moment === null ? null : { moment, board: step.board };
  }, [readsVisible, readsData, step, game.playerId]);
  // 切り替えは、卓の上の 1 行（盤面の見方の左）に置く。操作の段に置くと、狭い窓で操作の段が 1 行増えて、答えるときに卓が動く
  const readsKeyChord = settings.keys.toggle_reads ?? null;
  const readsWork = useMemo<ReadsWork>(
    () => ({
      toggle: readsActive && readsLoaded ? <ReadsToggle on={readsVisible} onToggle={toggleReads} keyChord={readsKeyChord} /> : null,
      status: <ReadsFeatureStatus feature={reads} />,
      view: readsView,
    }),
    [reads, readsView, readsActive, readsLoaded, readsVisible, toggleReads, readsKeyChord],
  );

  // 他家が聴牌になった手の目盛り（位置の帯。他家の手牌を、いま開いて見せているときだけ。答える場面の答える前は、開いていても出さない）
  const showingHands = handsOpen && (scene === null || answered.has(scene.key));
  const gameTracks = useGameTracks(game, showingHands);
  const ticks = useMemo<StripTick[] | undefined>(() => {
    if (gameTracks === null) return undefined;
    const stepOfEvent = new Map(timeline.steps.map((item) => [item.eventIndex, item.index]));
    const out: StripTick[] = [];
    for (const tracks of gameTracks) {
      for (const track of tracks.seats) {
        for (const mark of track.marks) {
          const at = stepOfEvent.get(mark.eventIndex);
          if (at !== undefined) out.push({ g: at, kyokuPosition: tracks.kyokuPosition, who: relationName(timeline.playerId, track.seat), n: mark.n });
        }
      }
    }
    return out.sort((a, b) => a.g - b.g);
  }, [gameTracks, timeline]);

  // 迷いのスクショの欄で、迷いを前・次の手に付け替えたら、付け替えた先の場面へ移る（その場面の、その迷いの写真へ、キーボードの位置を渡す）。
  // 移る先の手が無いときは、依頼を出さない。出した依頼は、その手にいるあいだだけ渡し、渡し終えたら捨てる
  const focusMark = focusRequest !== null && focusRequest.step === g ? focusRequest.markId : null;
  const onFocusDone = useCallback(() => setFocusRequest(null), []);
  const onRelinked = useCallback(
    (mark: ResolvedMark, to: DecisionRef) => {
      const decision = findDecisionByKey(game, to.key);
      const at = decision === undefined ? undefined : timeline.stepOfDecision.get(decision.index);
      if (at === undefined) return;
      go(at);
      // `go` が依頼を捨てるので、移ったあとに出す
      setFocusRequest({ markId: mark.markId, step: at });
    },
    [game, timeline, go],
  );

  const handlers = useMemo(() => {
    const table = {} as ReplayHandlers;
    for (const action of REPLAY_ACTIONS) {
      if (action.id === 'toggle_reads') {
        // 読みの入切は、切り替えがある手（盤面を見ているだけの手・答えたあとの場面）でだけ働く
        table[action.id] = () => {
          if (readsActive && readsLoaded) toggleReads();
        };
        continue;
      }
      const id = action.id;
      table[id] = () => {
        const to = nav[id];
        if (to !== null) go(to);
      };
    }
    return table;
  }, [nav, go, readsActive, readsLoaded, toggleReads]);
  useReplayKeys(settings.keys, handlers);

  if (step === undefined || info === null) return null;
  const compact = windowHeight < compactBelowHeight(info.rows, info.riichiAny, barExtra, reads.reserved ? READS_BAND_PX : 0);

  // 「次の場面へ」: いまより後ろの、次の場面（迷いか悪手。解決した場面は飛ばす）。無ければ、1 手先
  const nextScene = scenes.find((item) => item.step > g && !item.resolved);
  const afterReveal = () => go(nextScene === undefined ? g + 1 : nextScene.step);

  return (
    <div
      className="rp"
      ref={rootRef}
      data-compact={compact ? '1' : undefined}
      data-reads={reads.reserved ? 'on' : undefined}
      style={barExtra > 0 ? ({ '--bar-extra': `${barExtra}px` } as CSSProperties) : undefined}
    >
      <header className="head qhead">
        <div className="q-main">
          <div className="q-l">
            <h1 className="title">
              {kyoku?.label} {turnLabel(step.junme)}
            </h1>
            {scene !== null && (
              <ul className="q-chips" aria-label="この場面">
                <li className="q-chip">{shantenTag(scene.decision.shanten)}</li>
                <li className="q-chip">実戦：{actualText(scene.decision)}</li>
                {sceneTags(scene).map((tag) => (
                  <li className={`q-chip ${tag.kind === 'doubt' ? 'is-doubt' : 'is-mis'}`} key={tag.text}>
                    {tag.text}
                  </li>
                ))}
              </ul>
            )}
          </div>
        </div>
      </header>
      <ControlBar
        timeline={timeline}
        g={g}
        scenes={scenes}
        nav={nav}
        keys={settings.keys}
        answered={answered}
        currentKey={scene === null ? null : scene.key}
        go={go}
        onChangeKeys={(next) => settings.update({ replay_keys: next })}
        ticks={ticks}
        fineMissOnly={fineMissOnly}
        onFineMissOnly={setFineMissOnly}
        nagaUrl={session.naga?.url ?? null}
      />
      {scene === null ? (
        <BrowseWork
          game={game}
          openHands={openHands}
          timeline={timeline}
          step={step}
          info={info}
          anyCalled={calledSomewhere}
          scenes={scenes}
          answered={answered}
          go={go}
          reads={readsWork}
        />
      ) : (
        <SceneWork
          key={scene.key}
          game={game}
          openHands={openHands}
          step={step}
          info={info}
          anyCalled={calledSomewhere}
          scene={scene}
          session={session}
          resolved={resolved}
          decisions={decisionRefs}
          existing={latestAnswerFor(study.answers, session.id, scene.key, 'quiz')}
          drafts={drafts}
          nextLabel={nextScene === undefined ? '続きを見る' : '次の場面へ'}
          onNext={afterReveal}
          onRelinked={onRelinked}
          focusMarkId={focusMark}
          onFocusDone={onFocusDone}
          reads={readsWork}
        />
      )}
    </div>
  );
}
