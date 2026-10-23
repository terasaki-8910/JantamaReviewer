/**
 * 半荘を通して見る画面（F12）。取り込んだ半荘を、卓の配置の盤面で、1 手ずつ・1 巡ずつ・局ごとに進めて見る。
 *
 * - 1 手は、全員の打牌と鳴きの 1 つずつ（配牌・自分のツモ・リーチの宣言・カンと、局の終わりも 1 手）。盤面は、牌譜の再生（E-2）と同じ
 * - 迷いの場面（迷いマークを結びつけた判断）と不一致の場面（既定は大きな不一致。設定で、AI の1位と違う判断すべて）は、位置の帯・
 *   場面の一覧から飛べる。場面に着くと、出題と同じ形で答えられる。答える前は、AI の候補・確率・順位を画面にも DOM にも出さない（U-1）
 * - 答えは、出題と同じに記録する（mode は quiz。1 日後の解き直しの予定が入り、今日の出題でも「答えた」になる）。
 *   答えた場面は、答え合わせのあとの形で開く。「次の迷いへ」「次の不一致へ」は、答えた場面も通る
 * - キー（既定は、, . で 1 手、← → で自分の判断、↑ ↓ で不一致、Shift+↑ ↓ で迷い、Shift+← → で局。割り当ては変えられる）
 * - 半荘を通して見る間、答えの下書き（選んだ答え・理由）は、場面を離れても残す（戻ると、続きから。答えるまでの時間は、最初に見たときから）
 */
import {
  actualText,
  buildReplayTimeline,
  findDecisionByKey,
  listDecisionRefs,
  listReplayScenes,
  shantenTag,
  type ImportedGame,
} from '@jantama/engine';
import { useCallback, useMemo, useState, useSyncExternalStore } from 'react';

import type { SessionRecord } from '../../api/types';
import { resolveMarks } from '../markCards';
import { anyCalled, boardInfoOf } from '../study/Board';
import { useGameTracks } from '../study/OpenHands';
import { latestAnswerFor } from '../study/QuizPage';
import { useStudy } from '../study/StudyProvider';
import { relationName } from '../study/labels';
import { ControlBar } from './ControlBar';
import { REPLAY_ACTIONS } from './keys';
import { compactBelowHeight, replayNav, replayStops, sceneTags, turnLabel } from './replayModel';
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
        threshold: study.threshold,
        includeAll: settings.showAllMismatches,
        contest: study.contest,
        resolvedKeys,
      }),
    [timeline, game.decisions, markKeys, study.threshold, settings.showAllMismatches, study.contest, resolvedKeys],
  );
  // 「細かいミスだけ」（F17）。入れると、前・次の迷いと迷いの数が、細かいミスだけになる
  const [fineMissOnly, setFineMissOnly] = useFineMissOnly();
  const stops = useMemo(() => replayStops(timeline, scenes, { fineMissOnly }), [timeline, scenes, fineMissOnly]);

  const [g, setG] = useState(() => {
    const decision = startKey === undefined ? undefined : findDecisionByKey(game, startKey);
    return decision === undefined ? 0 : (timeline.stepOfDecision.get(decision.index) ?? 0);
  });
  const last = timeline.steps.length - 1;
  const go = useCallback((to: number) => setG(Math.max(0, Math.min(last, to))), [last]);
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

  const handlers = useMemo(() => {
    const table = {} as ReplayHandlers;
    for (const action of REPLAY_ACTIONS) {
      table[action.id] = () => {
        const to = nav[action.id];
        if (to !== null) go(to);
      };
    }
    return table;
  }, [nav, go]);
  useReplayKeys(settings.keys, handlers);

  if (step === undefined || info === null) return null;
  const compact = windowHeight < compactBelowHeight(info.rows, info.riichiAny);

  // 「次の場面へ」: いまより後ろの、次の場面（迷いでも不一致でも拮抗でも。解決した場面は飛ばす）。無ければ、1 手先
  const nextScene = scenes.find((item) => item.step > g && !item.resolved);
  const afterReveal = () => go(nextScene === undefined ? g + 1 : nextScene.step);

  return (
    <div className="rp" data-compact={compact ? '1' : undefined}>
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
        showAll={settings.showAllMismatches}
        answered={answered}
        currentKey={scene === null ? null : scene.key}
        go={go}
        onChangeKeys={(next) => settings.update({ replay_keys: next })}
        ticks={ticks}
        fineMissOnly={fineMissOnly}
        onFineMissOnly={setFineMissOnly}
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
        />
      )}
    </div>
  );
}
