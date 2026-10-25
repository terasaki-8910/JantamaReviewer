/**
 * 半荘をたどっているとき（場面にいないとき）の右の欄: 「いまの一手」と、「この半荘の場面」の一覧（F12）。
 * 場面を押すと、その場面へ飛ぶ。場面に着くまで、AI の答えは出さない（一覧にも、確率・順位は出さない。U-1）。
 * 局の終わりでは、「この局が終わりました」と、結果（和了・放銃・流局）と点の増減を出す。
 * 答える場面ではない自分の判断の手番は、AI の評価をいつも出す: 打牌以外の判断は、ここに一覧（打牌の判断は、手牌の上の棒。U-43）。
 */
import type { ReplayScene, ReplayTimeline, TimelineStep } from '@jantama/engine';
import type { ReactNode } from 'react';

import { Icon } from '../Icon';
import { InfoTip } from '../InfoTip';
import { Evaluation } from '../study/Evaluation';
import { KIND_NAME } from '../study/labels';
import type { Bar } from '../study/reveal';
import { deltaItems, resultText, sceneSubText, sceneTags, stepText, turnLabel } from './replayModel';

interface NowPanelProps {
  timeline: ReplayTimeline;
  step: TimelineStep;
  scenes: readonly ReplayScene[];
  answered: ReadonlySet<string>;
  go: (g: number) => void;
  /** 右の欄の上に出す欄（他家の手牌を開いているとき。R16-7）。 */
  above?: ReactNode;
  /**
   * 自分の判断の手番（答える場面ではない）の、AI の評価の一覧。打牌以外の判断（鳴き・リーチ・和了・カン）だけ。
   * 打牌の判断は、手牌の上の棒で出すので、ここには出さない（U-43）。無ければ null。
   */
  evaluation?: readonly Bar[] | null;
  dora?: ReadonlySet<number> | null;
}

export function NowPanel({ timeline, step, scenes, answered, go, above, evaluation = null, dora = null }: NowPanelProps) {
  const kyoku = timeline.kyokus[step.kyokuPosition];
  const me = timeline.playerId;
  const end = step.kind === 'end' && kyoku !== undefined ? kyoku.end : null;
  const doneCount = scenes.filter((scene) => answered.has(scene.key)).length;
  return (
    <section className="answer" aria-label="いまの一手と、この半荘の場面">
      {above}
      <div className="now">
        <p className="now-k">いまの一手</p>
        <p className="now-t" aria-live="polite">
          {kyoku === undefined ? '' : stepText(step, me, kyoku.label)}
        </p>
        <p className="now-s">
          {kyoku?.label} · {turnLabel(step.junme)} · 手 {step.position + 1} / {kyoku?.steps.length}
        </p>
        {step.decision !== null && <p className="now-d">自分の判断の場面です（{KIND_NAME[step.decision.kind]}）</p>}
        {end !== null && (
          <div className="now-res">
            <b>{resultText(end, me)}</b>
            <ul className="deltas" aria-label="点数の増減">
              {deltaItems(end, me).map((item) => (
                <li key={item.name} className={item.mine ? 'me' : undefined}>
                  {item.text}
                </li>
              ))}
            </ul>
          </div>
        )}
      </div>
      {evaluation !== null && evaluation.length > 0 && <Evaluation bars={evaluation} discard={false} dora={dora} />}
      <div className="scenes-h">
        <div className="sec-head">
          <h2 className="sec-title">この半荘の場面</h2>
          <InfoTip label="場面の一覧の操作の説明" id="sc-hint">
            場面を押すと、その場面へ飛びます。場面に着くまで、AIの答えは出ません。
          </InfoTip>
        </div>
        <span className="scenes-n">
          {doneCount} / {scenes.length} 解答済み
        </span>
      </div>
      {scenes.length === 0 ? (
        <p className="quiet">迷いの場面と悪手の場面は、この半荘にはありません。</p>
      ) : (
        <ol className="scenes" aria-label="場面の一覧" aria-describedby="sc-hint">
          {scenes.map((scene) => {
            const done = answered.has(scene.key);
            return (
              <li key={scene.key}>
                <button
                  type="button"
                  className="sc-row"
                  data-key={scene.key}
                  data-done={done ? 1 : 0}
                  data-resolved={scene.resolved ? 1 : 0}
                  onClick={() => go(scene.step)}
                >
                  <span className="sc-where">
                    <b>
                      {scene.decision.kyokuLabel} {scene.decision.junme}巡目
                    </b>
                    <span className="sc-sub">
                      {sceneSubText(scene.decision, KIND_NAME[scene.decision.kind])} ·{' '}
                      {done ? (
                        <span className="sc-st done">
                          <Icon name="check" />
                          解答済み
                        </span>
                      ) : (
                        <span className="sc-st">未解答</span>
                      )}
                      {scene.resolved && (
                        <>
                          {' · '}
                          <span className="sc-st resolved">
                            <Icon name="check" />
                            解決
                          </span>
                        </>
                      )}
                    </span>
                  </span>
                  <span className="sc-tags">
                    {sceneTags(scene).map((tag) => (
                      <span className={`tag ${tag.kind}`} key={tag.text}>
                        {tag.text}
                      </span>
                    ))}
                  </span>
                </button>
              </li>
            );
          })}
        </ol>
      )}
    </section>
  );
}
