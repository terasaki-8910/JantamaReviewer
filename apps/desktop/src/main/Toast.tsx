import { useEffect, useRef } from 'react';

import { Icon } from './Icon';

/**
 * 操作のあとの短い通知（削除したあとの「元に戻す」など）。
 * - 既定は 8 秒で消える。マウスを乗せている間・キーボードの位置が中にある間は消えず、離れたら、あと 4 秒で消える
 * - Esc で閉じる。閉じるボタンもある
 * - 通知の文を読み上げるのは、別の読み上げ用の欄（`Announcer`）。この部品は、見える通知と操作だけ
 */

export const TOAST_MS = 8000;
/** 読んでいる間に止めていた通知が、離れたあと消えるまで。 */
export const TOAST_AFTER_LEAVE_MS = 4000;

export interface ToastModel {
  /** 通知ごとの番号（新しい通知で、消えるまでの時間を数え直す）。 */
  id: number;
  text: string;
  /** 「元に戻す」など、通知に付ける操作。`title` はマウスを乗せたときの説明、`keyShortcuts` は読み上げ用のキー（Control+Z など）。 */
  action?: { label: string; onAction: () => void; title?: string; keyShortcuts?: string };
  /** 消えるまでの時間（ミリ秒）。 */
  ms: number;
  /** 表示と同時に、キーボードの位置を操作のボタンに移す（ほかに移す先が無いとき）。 */
  focusAction?: boolean;
}

interface ToastProps {
  toast: ToastModel;
  onClose: () => void;
}

export function Toast({ toast, onClose }: ToastProps) {
  const rootRef = useRef<HTMLDivElement>(null);
  const actionRef = useRef<HTMLButtonElement>(null);
  const timer = useRef<number | null>(null);
  const closeRef = useRef(onClose);
  useEffect(() => {
    closeRef.current = onClose;
  });

  // 通知ごとに、消えるまでの時間を数え直す。
  useEffect(() => {
    const stop = () => {
      if (timer.current !== null) window.clearTimeout(timer.current);
      timer.current = null;
    };
    stop();
    timer.current = window.setTimeout(() => closeRef.current(), toast.ms);
    return stop;
  }, [toast.id, toast.ms]);

  useEffect(() => {
    if (toast.focusAction) actionRef.current?.focus();
  }, [toast.id, toast.focusAction]);

  // 通知の中にキーボードの位置があるとき、Esc で閉じる。
  useEffect(() => {
    const onKeyDown = (event: KeyboardEvent) => {
      if (event.key !== 'Escape' || !rootRef.current?.contains(document.activeElement)) return;
      event.preventDefault();
      event.stopPropagation();
      closeRef.current();
    };
    document.addEventListener('keydown', onKeyDown);
    return () => document.removeEventListener('keydown', onKeyDown);
  }, []);

  const pause = () => {
    if (timer.current !== null) window.clearTimeout(timer.current);
    timer.current = null;
  };
  const resume = () => {
    pause();
    timer.current = window.setTimeout(() => closeRef.current(), TOAST_AFTER_LEAVE_MS);
  };

  return (
    <div
      className="toast"
      ref={rootRef}
      onMouseEnter={pause}
      onMouseLeave={() => {
        if (!rootRef.current?.contains(document.activeElement)) resume();
      }}
      onFocus={pause}
      onBlur={(event) => {
        // 通知の中のボタンの間を移るだけなら、止めたまま。
        if (event.relatedTarget instanceof Node && rootRef.current?.contains(event.relatedTarget)) return;
        if (!rootRef.current?.matches(':hover')) resume();
      }}
    >
      <span className="toast-t">{toast.text}</span>
      {toast.action && (
        <button
          type="button"
          className="btn sm"
          ref={actionRef}
          aria-keyshortcuts={toast.action.keyShortcuts}
          title={toast.action.title}
          onClick={toast.action.onAction}
        >
          {toast.action.label}
        </button>
      )}
      <button type="button" className="icon-btn toast-x" aria-label="閉じる" onClick={onClose}>
        <Icon name="close" />
      </button>
    </div>
  );
}
