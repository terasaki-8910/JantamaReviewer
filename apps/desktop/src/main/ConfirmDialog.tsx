import { useEffect, useEffectEvent, useId, useRef, type ReactNode } from 'react';

import { useShortcutBlocker } from './undo/shortcutGuard';

/**
 * 取り返しのつかない操作の確認（削除など）。WAI-ARIA の alertdialog:
 * - 開いたとき、キーボードの位置は「キャンセル」から始まる（うっかり Enter で消さないため）
 * - Tab は、ダイアログの中の 2 つのボタンの間だけを回る。裏の画面は、呼ぶ側が `inert` にする
 * - Esc・背景の押下・キャンセルで、何もせずに閉じる（背景は、押し始めも終わりも背景のときだけ。文字を選ぶ操作で閉じない）
 * - 開いている間は、アプリのキー操作（Ctrl+Z・Alt+← など）を止める
 * 確定のボタンは、赤にしない（赤は「自分の手」の印に取ってある）。反転した墨の色（.btn.danger）。
 * 閉じたあとの、キーボードの位置の戻し先は、呼ぶ側が決める（裏の画面が `inert` でなくなってから戻すため）。
 */
interface ConfirmDialogProps {
  title: string;
  /** 説明。1 行ずつ <br> で区切るなら、呼ぶ側が書く。 */
  description: ReactNode;
  confirmLabel: string;
  cancelLabel: string;
  onConfirm: () => void;
  onCancel: () => void;
}

export function ConfirmDialog({
  title,
  description,
  confirmLabel,
  cancelLabel,
  onConfirm,
  onCancel,
}: ConfirmDialogProps) {
  const titleId = useId();
  const descriptionId = useId();
  const confirmRef = useRef<HTMLButtonElement>(null);
  const cancelRef = useRef<HTMLButtonElement>(null);
  const pressedOnBackdrop = useRef(false);
  useShortcutBlocker(true);

  // 取り返しのつかない操作なので、最初のキーボードの位置は「キャンセル」。
  useEffect(() => {
    cancelRef.current?.focus();
  }, []);

  // ダイアログが開いている間は、裏の画面をスクロールさせない。
  useEffect(() => {
    document.body.classList.add('dlg-open');
    return () => document.body.classList.remove('dlg-open');
  }, []);

  const cancel = useEffectEvent(onCancel);
  useEffect(() => {
    const onKeyDown = (event: KeyboardEvent) => {
      if (event.key === 'Escape') {
        event.preventDefault();
        event.stopPropagation();
        cancel();
        return;
      }
      if (event.key !== 'Tab') return;
      // Tab は、ダイアログの外へ出さない。
      const order = [confirmRef.current, cancelRef.current].filter((b): b is HTMLButtonElement => b !== null);
      const at = order.indexOf(document.activeElement as HTMLButtonElement);
      event.preventDefault();
      const next = at < 0 ? 0 : (at + (event.shiftKey ? order.length - 1 : 1)) % order.length;
      order[next]?.focus();
    };
    document.addEventListener('keydown', onKeyDown, true);
    return () => document.removeEventListener('keydown', onKeyDown, true);
  }, []);

  return (
    <div
      className="dlg-wrap"
      role="presentation"
      onMouseDown={(event) => {
        pressedOnBackdrop.current = event.target === event.currentTarget;
      }}
      onClick={(event) => {
        if (event.target === event.currentTarget && pressedOnBackdrop.current) onCancel();
      }}
    >
      <div
        className="dlg"
        role="alertdialog"
        aria-modal="true"
        aria-labelledby={titleId}
        aria-describedby={descriptionId}
        tabIndex={-1}
      >
        <h2 className="dlg-t" id={titleId}>
          {title}
        </h2>
        <p className="dlg-d" id={descriptionId}>
          {description}
        </p>
        <div className="dlg-act">
          <button type="button" className="btn danger" ref={confirmRef} onClick={onConfirm}>
            {confirmLabel}
          </button>
          <button type="button" className="btn" ref={cancelRef} onClick={onCancel}>
            {cancelLabel}
          </button>
        </div>
      </div>
    </div>
  );
}
