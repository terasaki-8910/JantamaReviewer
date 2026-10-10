import { act, fireEvent, render, screen } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { TOAST_AFTER_LEAVE_MS, TOAST_MS, Toast, type ToastModel } from './Toast';

beforeEach(() => {
  vi.useFakeTimers();
});

afterEach(() => {
  vi.useRealTimers();
});

const base: ToastModel = {
  id: 1,
  text: '2件の半荘を削除しました',
  ms: TOAST_MS,
  action: { label: '元に戻す', onAction: () => undefined, title: '元に戻す（Ctrl+Z）', keyShortcuts: 'Control+Z' },
};

// 偽のタイマーの下では、Testing Library の非同期の待ち（userEvent）が止まってしまう。同期の fireEvent で操作する。
function setup(toast: ToastModel = base) {
  const onClose = vi.fn();
  const view = render(<Toast toast={toast} onClose={onClose} />);
  return { onClose, view };
}

const advance = (ms: number) => act(() => vi.advanceTimersByTime(ms));

describe('U-9: 取り消しの通知（Toast）', () => {
  it('文と「元に戻す」と閉じるボタンを出す。「元に戻す」は Ctrl+Z の印と説明つき', () => {
    setup();
    expect(screen.getByText('2件の半荘を削除しました')).toBeInTheDocument();
    const undo = screen.getByRole('button', { name: '元に戻す' });
    expect(undo).toHaveAttribute('aria-keyshortcuts', 'Control+Z');
    expect(undo).toHaveAttribute('title', '元に戻す（Ctrl+Z）');
    expect(screen.getByRole('button', { name: '閉じる' })).toBeInTheDocument();
  });

  it('操作が無ければ、操作のボタンは出さない（「元に戻しました」の通知）', () => {
    setup({ id: 2, text: '1件の半荘を元に戻しました', ms: 3500 });
    expect(screen.queryByRole('button', { name: '元に戻す' })).toBeNull();
    expect(screen.getByRole('button', { name: '閉じる' })).toBeInTheDocument();
  });

  it('既定は 8 秒で消える（7.9 秒ではまだ）', () => {
    const { onClose } = setup();
    advance(TOAST_MS - 100);
    expect(onClose).not.toHaveBeenCalled();
    advance(100);
    expect(onClose).toHaveBeenCalledTimes(1);
  });

  it('マウスを乗せている間は消えない。離れたら、あと 4 秒で消える', () => {
    const { onClose } = setup();
    advance(3000);
    const undo = screen.getByRole('button', { name: '元に戻す' });
    fireEvent.mouseEnter(undo);
    advance(60_000);
    expect(onClose).not.toHaveBeenCalled();
    fireEvent.mouseLeave(undo);
    advance(TOAST_AFTER_LEAVE_MS - 100);
    expect(onClose).not.toHaveBeenCalled();
    advance(100);
    expect(onClose).toHaveBeenCalledTimes(1);
  });

  it('キーボードの位置が中にある間も消えない。外へ出たら、あと 4 秒で消える。中のボタンの間を移るだけなら止まったまま', () => {
    const { onClose } = setup();
    act(() => screen.getByRole('button', { name: '元に戻す' }).focus());
    advance(60_000);
    expect(onClose).not.toHaveBeenCalled();
    act(() => screen.getByRole('button', { name: '閉じる' }).focus());
    advance(60_000);
    expect(onClose).not.toHaveBeenCalled();
    act(() => screen.getByRole('button', { name: '閉じる' }).blur());
    advance(TOAST_AFTER_LEAVE_MS - 100);
    expect(onClose).not.toHaveBeenCalled();
    advance(100);
    expect(onClose).toHaveBeenCalledTimes(1);
  });

  it('新しい通知（番号が変わる）では、消えるまでの時間を数え直す', () => {
    const onClose = vi.fn();
    const { rerender } = render(<Toast toast={base} onClose={onClose} />);
    advance(TOAST_MS - 1000);
    rerender(<Toast toast={{ ...base, id: 2, text: '1件の半荘を元に戻しました' }} onClose={onClose} />);
    advance(TOAST_MS - 1000);
    expect(onClose).not.toHaveBeenCalled();
    advance(1000);
    expect(onClose).toHaveBeenCalledTimes(1);
  });

  it('閉じるボタンと、通知の中での Esc で閉じる', () => {
    const first = setup();
    fireEvent.click(screen.getByRole('button', { name: '閉じる' }));
    expect(first.onClose).toHaveBeenCalledTimes(1);
    first.view.unmount();

    const second = setup();
    act(() => screen.getByRole('button', { name: '元に戻す' }).focus());
    fireEvent.keyDown(document.activeElement as Element, { key: 'Escape' });
    expect(second.onClose).toHaveBeenCalledTimes(1);
  });

  it('通知の外にキーボードの位置があるときの Esc では、閉じない', () => {
    const { onClose } = setup();
    fireEvent.keyDown(document.body, { key: 'Escape' });
    expect(onClose).not.toHaveBeenCalled();
  });

  it('「元に戻す」を押すと、その操作が呼ばれる', () => {
    const onAction = vi.fn();
    setup({ ...base, action: { label: '元に戻す', onAction } });
    fireEvent.click(screen.getByRole('button', { name: '元に戻す' }));
    expect(onAction).toHaveBeenCalledTimes(1);
  });

  it('表示と同時に操作のボタンへキーボードの位置を移せる（ほかに移す先が無いとき）', () => {
    setup({ ...base, focusAction: true });
    expect(screen.getByRole('button', { name: '元に戻す' })).toHaveFocus();
  });

  it('アンマウントしたら、タイマーは止まる（閉じたあとに onClose が呼ばれない）', () => {
    const { onClose, view } = setup();
    view.unmount();
    advance(TOAST_MS * 2);
    expect(onClose).not.toHaveBeenCalled();
  });
});
