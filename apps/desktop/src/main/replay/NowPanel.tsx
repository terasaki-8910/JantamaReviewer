/**
 * 半荘をたどっているとき（場面にいないとき）の右の欄: 「いまの一手」と、「この半荘の場面」の一覧（F12）。
 * 場面を押すと、その場面へ飛ぶ。場面に着くまで、AI の答えは出さない（一覧にも、確率・順位は出さない。U-1）。
 * 局の終わりでは、「この局が終わりました」と、結果（和了・放銃・流局）と点の増減を出す。
 */
import type { ReplayScene, ReplayTimeline, TimelineStep } from '@jantama/engine';

import { Icon } from '../Icon';
import { KIND_NAME } from '../study/labels';
import { deltaItems, resultText, sceneSubText, sceneTags, stepText, turnLabel } from './replayModel';

interface NowPanelProps {
  timeline: ReplayTimeline;
  step: TimelineStep;
  scenes: readonly ReplayScene[];
  answered: ReadonlySet<string>;
  go: (g: number) => void;
}

export function NowPanel({ timeline, step, scenes, answered, go }: NowPanelProps) {
  const kyoku = timeline.kyokus[step.kyokuPosition];
  const me = timeline.playerId;
  const end = step.kind === 'end' && kyoku !== undefined ? kyoku.end : null;
  const doneCount = scenes.filter((scene) => answered.has(scene.key)).length;
  return (
    <section className="answer" aria-label="いまの一手と、この半荘の場面">
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
      <div className="scenes-h">
        <h2 className="sec-title">この半荘の場面</h2>
        <span className="scenes-n">
          {doneCount} / {scenes.length} 解答済み
        </span>
      </div>
      {scenes.length === 0 ? (
        <p className="quiet">迷いの場面と不一致の場面は、この半荘にはありません。</p>
      ) : (
        <ol className="scenes" aria-label="場面の一覧">
          {scenes.map((scene) => {
            const done = answered.has(scene.key);
            return (
              <li key={scene.key}>
                <button type="button" className="sc-row" data-key={scene.key} data-done={done ? 1 : 0} onClick={() => go(scene.step)}>
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
      <p className="quiet sc-hint">場面を押すと、その場面へ飛びます。場面に着くまで、AIの答えは出ません。</p>
    </section>
  );
}
