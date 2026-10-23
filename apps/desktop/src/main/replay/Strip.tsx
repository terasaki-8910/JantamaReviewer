/**
 * 位置の帯（F12）。半荘の全体を、局ごとの区間に分けて横に並べ、いまの手の位置（縦の線）を出す。
 * 迷いの場面は帯の上の丸（細かいミスだけ四角。F17）、不一致の場面は下のひし形、拮抗の場面は下の短い横棒（色だけで区別しない）。
 * 解答済みの場面は、中を抜いた輪郭だけ。解決した場面（F16）は薄くする（押せば開ける）。
 * 帯を押す・引きずると、その手へ動く。印を押すと、その場面へ飛ぶ。帯は、スライダー（矢印で 1 手ずつ・Home・End）。
 * 他家の手牌を開いているときだけ（R16-7 の A）、他家が聴牌になった手の目盛り（帯の下の縁の小さな三角。この局のものは accent）と、その数と、この局の分を書いた 1 行を、帯の下に出す。
 * 目盛りは押せない（押す・引きずるは、帯のまま）ので、読み上げは 1 行のほうに任せる（目盛りは aria-hidden）。
 */
import type { ReplayScene, ReplayTimeline } from '@jantama/engine';
import { useCallback, useLayoutEffect, useMemo, useRef, useState, type CSSProperties, type KeyboardEvent, type PointerEvent } from 'react';

import { KIND_NAME } from '../study/labels';
import { kyokuShortLabel, mismatchName, turnLabel } from './replayModel';
import { layoutPins, stepAtPoint } from './stripLayout';

/** 他家が聴牌になった手の目盛り 1 つ。 */
export interface StripTick {
  /** その手（聴牌になった打牌）の通し番号。 */
  g: number;
  /** どの局か（いまの局の目盛りを、色で分ける）。 */
  kyokuPosition: number;
  /** 自分から見た呼び名（下家・対面・上家）。 */
  who: string;
  /** その人の何枚目の打牌か（N巡目）。 */
  n: number;
}

interface StripProps {
  timeline: ReplayTimeline;
  /** いまの手の通し番号。 */
  g: number;
  scenes: readonly ReplayScene[];
  /** 解答済みの場面の鍵。 */
  answered: ReadonlySet<string>;
  /** いま着いている場面の鍵（無ければ null）。 */
  currentKey: string | null;
  go: (g: number) => void;
  /** 他家が聴牌になった手の目盛り（他家の手牌を開いているときだけ渡す。無ければ出さない）。 */
  ticks?: readonly StripTick[];
}

type PinKind = 'doubt' | 'mis' | 'contest';

interface Pin {
  id: string;
  scene: ReplayScene;
  kind: PinKind;
  label: string;
}

/** 印の読み上げの名前。例: 迷い3（細かいミス） 東2局 6巡目 打牌（大きな不一致、拮抗でもある）（解答済み）（解決）。 */
function pinLabel(scene: ReplayScene, kind: PinKind, done: boolean): string {
  const where = `${scene.decision.kyokuLabel} ${scene.decision.junme}巡目 ${KIND_NAME[scene.decision.kind]}`;
  const doubt = scene.doubts.length === 0 ? '' : `迷い${scene.doubts.join('・')}${scene.fineMiss ? '（細かいミス）' : ''}`;
  const mis = scene.mismatch === null ? '' : mismatchName(scene.mismatch);
  const contest = scene.contest === null ? '' : '拮抗';
  const own = { doubt, mis, contest }[kind];
  const others = (['doubt', 'mis', 'contest'] as const)
    .filter((other) => other !== kind)
    .map((other) => ({ doubt, mis, contest })[other])
    .filter((text) => text !== '');
  const also = others.length === 0 ? '' : `（${others.join('、')}でもある）`;
  return `${own} ${where}${also}${done ? '（解答済み）' : ''}${scene.resolved ? '（解決）' : ''}`;
}

/** 印の形の名前（replay.css）。迷い = 丸、不一致 = ひし形、拮抗 = 短い横棒。 */
const PIN_CLASS: Record<PinKind, string> = { doubt: 'dbt', mis: 'mis', contest: 'cst' };

/** 印を置く x 座標（手の位置の割合から、押せる大きさが重ならないように）。 */
function placePins(list: readonly Pin[], width: number, total: number): number[] {
  return layoutPins(
    list.map((pin) => (total > 1 ? pin.scene.step / (total - 1) : 0)),
    width,
  );
}

export function Strip({ timeline, g, scenes, answered, currentKey, go, ticks }: StripProps) {
  const total = timeline.steps.length;
  const step = timeline.steps[g];
  const kyoku = step === undefined ? undefined : timeline.kyokus[step.kyokuPosition];
  const trackRef = useRef<HTMLDivElement>(null);
  const [width, setWidth] = useState(0);
  const dragging = useRef(false);

  // 印を置く幅は、帯の幅から決める（窓の幅が変わっても、押せる大きさが重ならないように）
  useLayoutEffect(() => {
    const track = trackRef.current;
    if (track === null) return undefined;
    const measure = () => setWidth(track.getBoundingClientRect().width);
    measure();
    if (typeof ResizeObserver === 'undefined') return undefined;
    const observer = new ResizeObserver(measure);
    observer.observe(track);
    return () => observer.disconnect();
  }, []);

  const pins = useMemo(() => {
    const up: Pin[] = [];
    const down: Pin[] = [];
    for (const scene of scenes) {
      const done = answered.has(scene.key);
      if (scene.doubts.length > 0) up.push({ id: `${scene.key}:doubt`, scene, kind: 'doubt', label: pinLabel(scene, 'doubt', done) });
      // 帯の下の段は、不一致のひし形と拮抗の横棒。手の位置の順に並べる（同じ場面なら、ひし形が先）
      if (scene.mismatch !== null) down.push({ id: `${scene.key}:mis`, scene, kind: 'mis', label: pinLabel(scene, 'mis', done) });
      if (scene.contest !== null) down.push({ id: `${scene.key}:contest`, scene, kind: 'contest', label: pinLabel(scene, 'contest', done) });
    }
    return { up, down };
  }, [scenes, answered]);

  const upX = useMemo(() => placePins(pins.up, width, total), [pins.up, width, total]);
  const downX = useMemo(() => placePins(pins.down, width, total), [pins.down, width, total]);

  const seek = useCallback(
    (clientX: number) => {
      const track = trackRef.current;
      if (track === null) return;
      const rect = track.getBoundingClientRect();
      if (rect.width <= 0) return;
      go(stepAtPoint(clientX, rect.left, rect.width, total));
    },
    [go, total],
  );

  const onPointerDown = (event: PointerEvent<HTMLDivElement>) => {
    // 動くのは、主のボタン（左）だけ。中ボタン・右ボタンでは、動かさない
    if (event.button !== 0) return;
    dragging.current = true;
    try {
      event.currentTarget.setPointerCapture(event.pointerId);
    } catch {
      // 取れなくても、押した位置には動ける
    }
    seek(event.clientX);
    event.currentTarget.focus();
  };

  const onKeyDown = (event: KeyboardEvent<HTMLDivElement>) => {
    if (event.altKey || event.ctrlKey || event.metaKey || event.shiftKey) return;
    let to: number | null = null;
    if (event.key === 'ArrowLeft') to = g - 1;
    else if (event.key === 'ArrowRight') to = g + 1;
    else if (event.key === 'Home') to = 0;
    else if (event.key === 'End') to = total - 1;
    if (to === null) return;
    event.preventDefault();
    event.stopPropagation();
    go(to);
  };

  const ratio = total > 1 ? g / (total - 1) : 0;
  const style = { '--p': ratio.toFixed(4) } as CSSProperties;
  const valueText =
    kyoku === undefined || step === undefined
      ? ''
      : `${kyoku.label} ${turnLabel(step.junme)}（手 ${step.position + 1} / ${kyoku.steps.length}）`;

  const renderPin = (pin: Pin, left: number | undefined) => {
    const done = answered.has(pin.scene.key);
    return (
      <button
        key={pin.id}
        type="button"
        className={`pin ${PIN_CLASS[pin.kind]}${pin.kind === 'mis' && pin.scene.mismatch === 'other' ? ' small' : ''}${pin.kind === 'doubt' && pin.scene.fineMiss ? ' sq' : ''}`}
        data-key={pin.scene.key}
        data-step={pin.scene.step}
        data-done={done ? '1' : '0'}
        data-resolved={pin.scene.resolved ? '1' : '0'}
        aria-label={pin.label}
        title={pin.label}
        aria-current={currentKey === pin.scene.key ? 'true' : undefined}
        style={left === undefined ? undefined : { left: `${left}px` }}
        onClick={() => go(pin.scene.step)}
      />
    );
  };

  const here = ticks?.filter((tick) => tick.kyokuPosition === step?.kyokuPosition) ?? [];
  return (
    <>
      <div className="tl">
        <div className="tl-pins up">{pins.up.map((pin, index) => renderPin(pin, upX[index]))}</div>
        <div
          className="tl-track"
          ref={trackRef}
          role="slider"
          tabIndex={0}
          aria-label="半荘の中の位置（左右の矢印で1手ずつ）"
          aria-valuemin={1}
          aria-valuemax={total}
          aria-valuenow={g + 1}
          aria-valuetext={valueText}
          onPointerDown={onPointerDown}
          onPointerMove={(event) => {
            if (dragging.current) seek(event.clientX);
          }}
          onPointerUp={() => {
            dragging.current = false;
          }}
          onPointerCancel={() => {
            dragging.current = false;
          }}
          onKeyDown={onKeyDown}
        >
          <span className="tl-fill" style={style} />
          {timeline.kyokus.map((item) => (
            <span className="tl-seg" key={item.position} style={{ flex: `${item.steps.length} 1 0` }}>
              <span className="long">{item.label}</span>
              <span className="short">{kyokuShortLabel(item.label)}</span>
            </span>
          ))}
          {ticks?.map((tick) => (
            <span
              className={`tk${tick.kyokuPosition === step?.kyokuPosition ? ' cur' : ''}`}
              key={`${tick.g}:${tick.who}`}
              aria-hidden="true"
              style={{ left: `${((total > 1 ? tick.g / (total - 1) : 0) * 100).toFixed(3)}%` }}
            />
          ))}
          <span className="tl-cursor" style={style} />
        </div>
        <div className="tl-pins down">{pins.down.map((pin, index) => renderPin(pin, downX[index]))}</div>
      </div>
      {ticks !== undefined && (
        <p className="tl-note" data-ticks={ticks.length}>
          <span className="tp-key" aria-hidden="true" />
          <span>
            他家が聴牌になった手の位置（この半荘で {ticks.length} か所）。この局: {here.length === 0 ? 'なし' : here.map((tick) => `${tick.who} ${tick.n}巡目`).join('、')}
          </span>
        </p>
      )}
    </>
  );
}
