/**
 * 迷いの画像の大きな表示（R7-4）の、部品の試験。承認済みの見本（round7-samples/lightbox.html）と同じふるまいを確かめる:
 * 前・次（矢印のボタンと ← →）、Esc・背景の押下・閉じるボタンで閉じる、キーボードの位置が中へ移り、Tab は中だけを回る。
 * 裏の画面を操作できなくすること・閉じたあとにカードへキーボードの位置を戻すことは、App 全体の試験（Hanchan.test.tsx）が確かめる。
 */
import { render, screen, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { describe, expect, it, vi } from 'vitest';

import { Lightbox, type ViewerItem } from './Lightbox';
import { UndoProvider } from './undo/UndoProvider';

const ITEMS: ViewerItem[] = [
  { src: 'asset://one.png', alt: '迷い1のスクリーンショット', caption: '迷い1 · 東1局 · 4巡目 · 打牌の迷い', time: '19:09:53' },
  { src: 'asset://two.png', alt: '迷い2のスクリーンショット', caption: '迷い2 · 東2局 · 11巡目 · 鳴きの迷い', time: '19:15:57' },
  { src: 'asset://three.png', alt: '迷い3のスクリーンショット', caption: '迷い3 · 東2局1本場 · 6巡目 · 打牌の迷い', time: '19:17:37' },
];

function setup(start = 0, items: readonly ViewerItem[] = ITEMS) {
  const onClose = vi.fn();
  const user = userEvent.setup();
  const view = render(
    <UndoProvider>
      <Lightbox items={items} start={start} onClose={onClose} />
    </UndoProvider>,
  );
  return { onClose, user, view };
}

const dialog = () => screen.getByRole('dialog', { name: '迷いの画像' });
const prev = () => screen.getByRole('button', { name: '前の画像' });
const next = () => screen.getByRole('button', { name: '次の画像' });
const close = () => screen.getByRole('button', { name: '閉じる' });
const shownSrc = () => (within(dialog()).getByRole('img') as HTMLImageElement).getAttribute('src');

describe('R7-4 画像の大きな表示', () => {
  it('開いた画像と、その説明（「迷いN · 局 · 巡目 · 種類」と時刻）を出す。モーダルで、キーボードの位置は中へ移る', () => {
    setup(1);
    expect(dialog()).toHaveAttribute('aria-modal', 'true');
    expect(shownSrc()).toBe('asset://two.png');
    expect(within(dialog()).getByRole('img')).toHaveAccessibleName('迷い2のスクリーンショット');
    expect(within(dialog()).getByRole('img')).toHaveAttribute('draggable', 'false');
    const caption = dialog().querySelector('figcaption') as HTMLElement;
    expect(caption.textContent).toBe('迷い2 · 東2局 · 11巡目 · 鳴きの迷い · 19:15:57');
    expect(caption.querySelector('.mono')?.textContent).toBe('19:15:57');
    expect(dialog()).toHaveFocus();
    // 裏の画面はスクロールさせない。
    expect(document.body).toHaveClass('lb-open');
  });

  it('前・次のボタン: 端では、その向きのボタンが押せない', async () => {
    const { user } = setup(0);
    expect(prev()).toBeDisabled();
    expect(next()).toBeEnabled();
    await user.click(next());
    expect(shownSrc()).toBe('asset://two.png');
    expect(prev()).toBeEnabled();
    await user.click(next());
    expect(shownSrc()).toBe('asset://three.png');
    expect(next()).toBeDisabled();
    await user.click(prev());
    expect(shownSrc()).toBe('asset://two.png');
  });

  it('← → のキーでも前後へ動く。端では動かない', async () => {
    const { user } = setup(0);
    await user.keyboard('{ArrowLeft}');
    expect(shownSrc()).toBe('asset://one.png');
    await user.keyboard('{ArrowRight}');
    await user.keyboard('{ArrowRight}');
    expect(shownSrc()).toBe('asset://three.png');
    await user.keyboard('{ArrowRight}');
    expect(shownSrc()).toBe('asset://three.png');
    await user.keyboard('{ArrowLeft}');
    expect(shownSrc()).toBe('asset://two.png');
  });

  it('端の矢印のボタンにキーボードの位置があって押せなくなったら、閉じるボタンへ移す', async () => {
    const { user } = setup(1);
    next().focus();
    await user.keyboard('{Enter}');
    expect(shownSrc()).toBe('asset://three.png');
    expect(next()).toBeDisabled();
    expect(close()).toHaveFocus();
  });

  it('Esc で閉じる（ほかへは伝えない）。閉じるボタンでも閉じる', async () => {
    const outside = vi.fn();
    document.addEventListener('keydown', outside);
    const { user, onClose } = setup(0);
    await user.keyboard('{Escape}');
    expect(onClose).toHaveBeenCalledTimes(1);
    expect(outside).not.toHaveBeenCalled();
    document.removeEventListener('keydown', outside);
    await user.click(close());
    expect(onClose).toHaveBeenCalledTimes(2);
  });

  it('背景を押すと閉じる。画像・説明・ボタンを押しても閉じない', async () => {
    const { user, onClose } = setup(0);
    await user.click(within(dialog()).getByRole('img'));
    await user.click(dialog().querySelector('figcaption') as HTMLElement);
    await user.click(next());
    expect(onClose).not.toHaveBeenCalled();
    await user.click(dialog().querySelector('.lb-backdrop') as HTMLElement);
    expect(onClose).toHaveBeenCalledTimes(1);
  });

  it('背景のボタンは、Tab の順に入らず、読み上げにも出ない', () => {
    setup(0);
    const backdrop = dialog().querySelector('.lb-backdrop') as HTMLElement;
    expect(backdrop).toHaveAttribute('tabindex', '-1');
    expect(backdrop).toHaveAttribute('aria-hidden', 'true');
  });

  it('Tab は、中の押せるボタン（前・次・閉じる）の間だけを回る。端で押せないボタンは飛ばす。Shift+Tab は逆回り', async () => {
    const { user } = setup(0);
    await user.tab();
    expect(next()).toHaveFocus(); // 前は押せない（先頭）
    await user.tab();
    expect(close()).toHaveFocus();
    await user.tab();
    expect(next()).toHaveFocus(); // 一周して戻る
    await user.tab({ shift: true });
    expect(close()).toHaveFocus();
    await user.tab({ shift: true });
    expect(next()).toHaveFocus();

    await user.click(next());
    await user.click(next()); // 最後の画像
    next().blur();
    await user.tab();
    expect(prev()).toHaveFocus(); // 次は押せない（最後）
  });

  it('画像が 1 枚だけなら、前も次も押せない', () => {
    setup(0, [ITEMS[0] as ViewerItem]);
    expect(prev()).toBeDisabled();
    expect(next()).toBeDisabled();
  });

  it('始まりの位置が範囲の外でも、端の画像を出す', () => {
    setup(99);
    expect(shownSrc()).toBe('asset://three.png');
  });

  it('閉じると、裏の画面をスクロールさせない印を外す', () => {
    const { view } = setup(0);
    expect(document.body).toHaveClass('lb-open');
    view.unmount();
    expect(document.body).not.toHaveClass('lb-open');
  });

  it('開いている間は、アプリのキー操作（Ctrl+Z）を止める', async () => {
    const { user } = setup(0);
    const seen: boolean[] = [];
    const listener = (event: KeyboardEvent) => seen.push(event.defaultPrevented);
    document.addEventListener('keydown', listener);
    await user.keyboard('{Control>}z{/Control}');
    document.removeEventListener('keydown', listener);
    // UndoProvider は、止められているとき（開いている画像ビューア）は、キーを横取りしない（defaultPrevented にしない）。
    expect(seen.every((prevented) => !prevented)).toBe(true);
  });
});
