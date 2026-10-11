/**
 * 位置の帯（F12）。半荘の全体を、局ごとの区間に分けて横に並べ、いまの手の位置（縦の線）を出す。
 * 迷いの場面は帯の上の丸、不一致の場面は下のひし形（色だけで区別しない）。解答済みの場面は、中を抜いた輪郭だけ。
 * 帯を押す・引きずると、その手へ動く。印を押すと、その場面へ飛ぶ。帯は、スライダー（矢印で 1 手ずつ・Home・End）。
 */
import type { ReplayScene, ReplayTimeline } from '@jantama/engine';
import { useCallback, useLayoutEffect, useMemo, useRef, useState, type CSSProperties, type KeyboardEvent, type PointerEvent } from 'react';

import { KIND_NAME } from '../study/labels';
import { kyokuShortLabel, mismatchName, turnLabel } from './replayModel';
import { layoutPins, stepAtPoint } from './stripLayout';

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
}

interface Pin {
  id: string;
  scene: ReplayScene;
  kind: 'doubt' | 'mis';
  label: string;
}

function pinLabel(scene: ReplayScene, kind: 'doubt' | 'mis', done: boolean): string {
  const where = `${scene.decision.kyokuLabel} ${scene.decision.junme}巡目 ${KIND_NAME[scene.decision.kind]}`;
  const doubt = `迷い${scene.doubts.join('・')}`;
  const mis = scene.mismatch === null ? '' : mismatchName(scene.mismatch);
  const head = kind === 'doubt' ? doubt : mis;
  const also = kind === 'doubt' ? (mis === '' ? '' : `（${mis}でもある）`) : scene.doubts.length > 0 ? `（${doubt}でもある）` : '';
  return `${head} ${where}${also}${done ? '（解答済み）' : ''}`;
}

/** 印を置く x 座標（手の位置の割合から、押せる大きさが重ならないように）。 */
function placePins(list: readonly Pin[], width: number, total: number): number[] {
  return layoutPins(
    list.map((pin) => (total > 1 ? pin.scene.step / (total - 1) : 0)),
    width,
  );
}

export function Strip({ timeline, g, scenes, answered, currentKey, go }: StripProps) {
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
      if (scene.mismatch !== null) down.push({ id: `${scene.key}:mis`, scene, kind: 'mis', label: pinLabel(scene, 'mis', done) });
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
        className={`pin ${pin.kind === 'doubt' ? 'dbt' : 'mis'}${pin.kind === 'mis' && pin.scene.mismatch === 'other' ? ' small' : ''}`}
        data-key={pin.scene.key}
        data-step={pin.scene.step}
        data-done={done ? '1' : '0'}
        aria-label={pin.label}
        title={pin.label}
        aria-current={currentKey === pin.scene.key ? 'true' : undefined}
        style={left === undefined ? undefined : { left: `${left}px` }}
        onClick={() => go(pin.scene.step)}
      />
    );
  };

  return (
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
        <span className="tl-cursor" style={style} />
      </div>
      <div className="tl-pins down">{pins.down.map((pin, index) => renderPin(pin, downX[index]))}</div>
    </div>
  );
}
