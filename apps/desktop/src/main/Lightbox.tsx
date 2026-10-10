import { useEffect, useEffectEvent, useRef, useState } from 'react';

import { Icon } from './Icon';
import { useShortcutBlocker } from './undo/shortcutGuard';

/**
 * 迷いの画像の大きな表示（R7-4。承認済みの見本 round7-samples/lightbox.html と同じふるまい）。
 * - 前・次の画像へ: 画面の矢印のボタンと、← → のキー。端では、その向きのボタンが押せない
 * - 閉じる: Esc・背景の押下・閉じるボタン。閉じたあとのキーボードの位置の戻し先は、呼ぶ側が決める
 *   （裏の画面が `inert` でなくなってから戻すため。ConfirmDialog と同じ）
 * - 開いたとき、キーボードの位置はこの中へ移る。Tab は中のボタンの間だけを回る。裏の画面は、呼ぶ側が `inert` にする
 * - 開いている間は、アプリのキー操作（Ctrl+Z・Alt+← など）を止める
 */
export interface ViewerItem {
  /** 画像の場所（asset プロトコルの URL）。 */
  src: string;
  /** 画像の説明（読み上げ用）。 */
  alt: string;
  /** 画像の下に出す文。例: 迷い3 · 東2局1本場 · 6巡目 · 打牌の迷い */
  caption: string;
  /** 撮った時刻。例: 19:17:37 */
  time: string;
}

/** 大きな表示を開く求め（`opener` は、閉じたときにキーボードの位置を戻す先）。 */
export interface ViewerRequest {
  items: readonly ViewerItem[];
  /** 最初に出す画像（`items` の添字）。 */
  start: number;
  opener: HTMLElement | null;
}

interface LightboxProps {
  items: readonly ViewerItem[];
  start: number;
  onClose: () => void;
}

export function Lightbox({ items, start, onClose }: LightboxProps) {
  const last = Math.max(items.length - 1, 0);
  const [index, setIndex] = useState(() => Math.min(Math.max(start, 0), last));
  const rootRef = useRef<HTMLDivElement>(null);
  const prevRef = useRef<HTMLButtonElement>(null);
  const nextRef = useRef<HTMLButtonElement>(null);
  const closeRef = useRef<HTMLButtonElement>(null);
  useShortcutBlocker(true);

  // 開いている間は、裏の画面をスクロールさせない。開いたら、キーボードの位置をこの中へ移す。
  useEffect(() => {
    document.body.classList.add('lb-open');
    rootRef.current?.focus();
    return () => document.body.classList.remove('lb-open');
  }, []);

  const step = (delta: number) => setIndex((current) => Math.min(Math.max(current + delta, 0), last));

  // キー: 先に受けて（キャプチャ）、止める。
  const onKey = useEffectEvent((event: KeyboardEvent) => {
    if (event.key === 'Escape') {
      event.preventDefault();
      event.stopPropagation();
      onClose();
    } else if (event.key === 'ArrowLeft' || event.key === 'ArrowRight') {
      event.preventDefault();
      event.stopPropagation();
      step(event.key === 'ArrowLeft' ? -1 : 1);
    } else if (event.key === 'Tab') {
      // Tab は、この中の、押せるボタンの間だけを回る。
      const order = [prevRef.current, nextRef.current, closeRef.current].filter(
        (button): button is HTMLButtonElement => button !== null && !button.disabled,
      );
      const at = order.indexOf(document.activeElement as HTMLButtonElement);
      event.preventDefault();
      const next = at < 0 ? 0 : (at + (event.shiftKey ? order.length - 1 : 1)) % order.length;
      order[next]?.focus();
    }
  });
  useEffect(() => {
    const handler = (event: KeyboardEvent) => onKey(event);
    document.addEventListener('keydown', handler, true);
    return () => document.removeEventListener('keydown', handler, true);
  }, []);

  // 端に着いて押せなくなった矢印に、キーボードの位置が残らないよう、閉じるボタンへ移す。

  useEffect(() => {
    const active = document.activeElement;
    if (active instanceof HTMLButtonElement && active.disabled && rootRef.current?.contains(active)) {
      closeRef.current?.focus();
    }
  }, [index]);

  const item = items[index];
  if (item === undefined) return null;
  return (
    <div className="lb" role="dialog" aria-modal="true" aria-label="迷いの画像" tabIndex={-1} ref={rootRef}>
      {/* 背景。押すと閉じる（キーボードでは Esc。Tab の順には入れない） */}
      <button type="button" className="lb-backdrop" tabIndex={-1} aria-hidden="true" onClick={onClose} />
      <figure className="lb-fig">
        <img className="lb-img" src={item.src} alt={item.alt} draggable={false} />
        <figcaption className="lb-cap">
          {item.caption} · <span className="mono">{item.time}</span>
        </figcaption>
      </figure>
      <button
        type="button"
        className="lb-btn lb-prev"
        ref={prevRef}
        aria-label="前の画像"
        disabled={index === 0}
        onClick={() => step(-1)}
      >
        <Icon name="chevronLeft" />
      </button>
      <button
        type="button"
        className="lb-btn lb-next"
        ref={nextRef}
        aria-label="次の画像"
        disabled={index === last}
        onClick={() => step(1)}
      >
        <Icon name="chevronRight" />
      </button>
      <button type="button" className="lb-btn lb-close" ref={closeRef} aria-label="閉じる" onClick={onClose}>
        <Icon name="close" />
      </button>
    </div>
  );
}
