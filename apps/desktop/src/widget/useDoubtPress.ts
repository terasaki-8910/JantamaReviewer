import { useRef, type KeyboardEvent, type MouseEvent, type PointerEvent } from 'react';

/** 押したまま、この距離（px）より動かしたら、押したのではなく、窓を動かすつもりとみなす（F0、W-15）。 */
export const DRAG_THRESHOLD_PX = 4;

interface UseDoubtPressOptions {
  /** 押して、動かさずに離した（またはキーで押した）。迷いマークを記録する。 */
  onPress: () => void;
  /** 押したまま `DRAG_THRESHOLD_PX` より動かした。窓を動かし始める（1 回の押しにつき 1 回だけ）。 */
  onDrag: () => void;
  /** 記録できない間（保存先を開けない）。押しても記録しない。 */
  disabled: boolean;
}

/**
 * 迷いだけのウィジェットのボタン（窓いっぱいの 1 つのボタン）の押し方（F0、W-15）。
 * 1 つのボタンで「押す」と「つかんで動かす」を見分ける:
 * - 押した点を覚え、押したまま 4px より動かしたら、窓を動かし始める。そのときは記録しない
 * - 動かさずに離したら、記録する
 * - Enter・Space も記録する（キーを押し続けても、繰り返しは数えない）
 * ふつうの click は、離したときに数え済みなので、二重に数えない。click が来るのは、キーボードか支援技術から押されたときで、
 * そのとき（`detail` が 0）だけ記録する。窓を動かし始めると、OS が動かしている間、離したことが画面に届かないので、
 * 押している状態は、次に押すときに作り直す。
 */
export function useDoubtPress({ onPress, onDrag, disabled }: UseDoubtPressOptions) {
  // 押している間だけ入る。`dragging` は、窓を動かし始めたあと（離しても記録しない）。
  const press = useRef<{ x: number; y: number; dragging: boolean } | null>(null);

  const onPointerDown = (event: PointerEvent<HTMLButtonElement>) => {
    // 主ボタンだけ（右クリックはメニュー、中ボタンは何もしない）。
    if (event.button !== 0 || disabled) return;
    press.current = { x: event.clientX, y: event.clientY, dragging: false };
    // 窓の外へ出ても、離すまで動きを受ける（窓は 48px しかなく、押した場所が端に近いと、すぐ外へ出る）。
    try {
      event.currentTarget.setPointerCapture(event.pointerId);
    } catch {
      // 受けられなくても、窓の中の動きは受けられる。
    }
  };

  const onPointerMove = (event: PointerEvent<HTMLButtonElement>) => {
    const current = press.current;
    if (current === null || current.dragging) return;
    if (Math.hypot(event.clientX - current.x, event.clientY - current.y) > DRAG_THRESHOLD_PX) {
      current.dragging = true;
      onDrag();
    }
  };

  const onPointerUp = (event: PointerEvent<HTMLButtonElement>) => {
    const current = press.current;
    press.current = null;
    if (current === null || current.dragging || event.button !== 0) return;
    onPress();
  };

  /** 押していたのが取り消された（OS が窓を動かし始めた・別の操作に取られた）。記録しない。 */
  const onPointerCancel = () => {
    press.current = null;
  };

  const onKeyDown = (event: KeyboardEvent<HTMLButtonElement>) => {
    if (event.key !== 'Enter' && event.key !== ' ') return;
    // ブラウザが続けて出す click を止める（二重に数えない）。
    event.preventDefault();
    if (event.repeat || disabled) return;
    onPress();
  };

  const onKeyUp = (event: KeyboardEvent<HTMLButtonElement>) => {
    // Space の click は、離したときに出る。止める。
    if (event.key === ' ') event.preventDefault();
  };

  const onClick = (event: MouseEvent<HTMLButtonElement>) => {
    // マウス・タッチ・ペンの click は、離したときに数え済み（detail は 1 以上）。
    if (event.detail !== 0 || disabled) return;
    onPress();
  };

  return { onPointerDown, onPointerMove, onPointerUp, onPointerCancel, onKeyDown, onKeyUp, onClick };
}
