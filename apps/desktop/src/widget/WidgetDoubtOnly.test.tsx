/**
 * 迷いだけを記録する設定（F0、W-15）のウィジェット: 48px 角の窓いっぱいの「迷い」ボタン 1 つ。
 * 〇△✕・「次：N局目」・取り消しは DOM に無く、押して動かさずに離すと記録、押したまま 4px より動かすと窓を動かし始める。
 * 窓の大きさそのもの（48×48px）とメニューは Rust 側（widget_window.rs・menu.rs）の試験が確かめる。
 * 〇△✕ を持つこれまでの縦長・横長は WidgetApp.test.tsx が確かめる。
 */
import { act, fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { beforeEach, describe, expect, it, vi } from 'vitest';

import { baseSettings, baseState, installTauriMock } from '../../tests/tauri-mock';
import type { AppState, Settings } from '../api/types';
import { WidgetApp } from './WidgetApp';

// 押したまま動かしたとき、窓を動かし始める呼び出し（getCurrentWindow().startDragging()）を受ける。
const { startDragging } = vi.hoisted(() => ({ startDragging: vi.fn<() => Promise<void>>() }));

vi.mock('@tauri-apps/api/core', () => ({
  invoke: vi.fn(),
  convertFileSrc: (path: string) => `asset://localhost/${encodeURIComponent(path)}`,
}));
vi.mock('@tauri-apps/api/event', () => ({ listen: vi.fn() }));
vi.mock('@tauri-apps/api/window', () => ({ getCurrentWindow: () => ({ startDragging }) }));

const RATE_LABEL = '（終わった局の評価）';
const DOUBT_ONLY: Settings = { ...baseSettings, doubt_only: true };

/** 迷いだけの設定でウィジェットを描き、「迷い」のボタンが出るまで待つ。 */
async function renderSquare(options: { state?: AppState; settings?: Partial<Settings> } = {}) {
  const mock = installTauriMock({
    settings: { ...DOUBT_ONLY, ...options.settings },
    ...(options.state === undefined ? {} : { state: options.state }),
  });
  const view = render(<WidgetApp />);
  const button = await screen.findByRole('button', { name: /^迷い/ });
  return { mock, button, ...view };
}

/** ポインターの押下・移動・離す。座標は窓の中。 */
const press = (button: HTMLElement, x = 20, y = 20) =>
  fireEvent.pointerDown(button, { button: 0, pointerId: 1, clientX: x, clientY: y });
const release = (button: HTMLElement, x = 20, y = 20) =>
  fireEvent.pointerUp(button, { button: 0, pointerId: 1, clientX: x, clientY: y });
const moveTo = (button: HTMLElement, x: number, y: number) =>
  fireEvent.pointerMove(button, { pointerId: 1, clientX: x, clientY: y });
/** 何も起きないことを確かめるために、少し待つ。 */
const settle = () => new Promise((resolve) => setTimeout(resolve, 50));

beforeEach(() => {
  vi.useRealTimers();
  startDragging.mockReset();
  startDragging.mockResolvedValue(undefined);
});

describe('W-15 迷いだけのウィジェット: 表示', () => {
  it('「迷い」ボタン 1 つだけ: 〇△✕・「次：N局目」・取り消しのボタンは DOM に無い', async () => {
    const { container, button } = await renderSquare();
    expect(screen.getAllByRole('button')).toEqual([button]);
    expect(button).toHaveAccessibleName('迷い 2（押すと印を追加）');
    expect(container.querySelector('.widget')).toHaveClass('sq');
    expect(screen.queryByRole('group', { name: '終わった局の評価' })).toBeNull();
    expect(screen.queryByRole('button', { name: new RegExp(RATE_LABEL) })).toBeNull();
    expect(screen.queryByRole('button', { name: '取り消し' })).toBeNull();
    expect(screen.queryByText(/次：/)).toBeNull();
    expect(container.querySelector('.rate, .rate-btn, .undo, .next, .info, .status')).toBeNull();
    expect(container.querySelector('svg')).toBeNull();
  });

  it('ボタンの中は「迷い」の文字・迷いの数・小さな点だけ（点は読み上げない）。窓の中にあるのはこのボタンだけ', async () => {
    const { button } = await renderSquare();
    expect(button.textContent).toBe('迷い2');
    expect(within(button).getByText('迷い')).toHaveClass('lbl');
    expect(within(button).getByText('2')).toHaveClass('num');
    expect(button.querySelector('.dot')).toHaveAttribute('aria-hidden', 'true');
    expect(button).toHaveClass('w-btn', 'doubt', 'sq-btn');
    expect(button.parentElement).toHaveClass('widget', 'sq');
    expect(button.parentElement?.children).toHaveLength(1);
  });

  it('迷いの数は、状態が変わるとその場で変わる（割り当てたボタンで付けた迷いも）', async () => {
    const { mock } = await renderSquare();
    act(() => {
      mock.emit('state-changed', { ...baseState, mark_count: 12 } satisfies AppState);
    });
    expect(await screen.findByRole('button', { name: '迷い 12（押すと印を追加）' })).toHaveTextContent('迷い12');
    expect(mock.count('add_mark')).toBe(0);
  });

  it('記録中は塗りの点、待機中は中抜きの点（.dot.idle）、エラーは濃い点（.dot.error）。状態は読み上げの説明に載る', async () => {
    const idle: AppState = {
      ...baseState,
      status: 'idle',
      session_id: null,
      mark_count: 0,
      ratings: [],
      next_hand: 1,
      can_undo: false,
    };
    const { mock, button } = await renderSquare();
    const dot = () => button.querySelector('.dot') as HTMLElement;
    expect(dot().className).toBe('dot');
    expect(button).toHaveAccessibleDescription('記録中');
    act(() => {
      mock.emit('state-changed', idle);
    });
    await waitFor(() => expect(dot()).toHaveClass('idle'));
    expect(button).toHaveAccessibleDescription('待機中');
    act(() => {
      mock.emit('state-changed', { ...idle, status: 'error', error: '保存先がリポジトリの中です' } satisfies AppState);
    });
    await waitFor(() => expect(dot()).toHaveClass('error'));
    expect(button).toHaveAccessibleDescription('エラー：保存先がリポジトリの中です');
    expect(button).toBeDisabled();
  });

  it('形（縦長・横長）によらず同じ四角。迷いだけを切ると、選んでいた形のウィジェットに戻る（settings-changed）', async () => {
    const { mock, container } = await renderSquare({ settings: { orientation: 'horizontal' } });
    expect(container.querySelector('.widget')).toHaveClass('sq');
    act(() => {
      mock.emit('settings-changed', { ...baseSettings, orientation: 'horizontal', doubt_only: false } satisfies Settings);
    });
    await waitFor(() => expect(container.querySelector('.widget')).toHaveClass('h'));
    expect(screen.getAllByRole('button')).toHaveLength(5);
    expect(screen.getByText('次：5局目')).toBeInTheDocument();
    act(() => {
      mock.emit('settings-changed', { ...baseSettings, orientation: 'vertical', doubt_only: true } satisfies Settings);
    });
    await waitFor(() => expect(container.querySelector('.widget')).toHaveClass('sq'));
    expect(screen.getAllByRole('button')).toHaveLength(1);
    expect(screen.queryByText(/次：/)).toBeNull();
  });

  it('右クリックでネイティブのメニューを出す（取り消しはそこにある。ブラウザの標準メニューは出さない）', async () => {
    const { mock } = await renderSquare();
    const notPrevented = fireEvent(document.body, new MouseEvent('contextmenu', { bubbles: true, cancelable: true }));
    expect(notPrevented).toBe(false);
    expect(mock.count('show_widget_menu')).toBe(1);
    expect(mock.count('undo')).toBe(0);
  });

  it('N-7: 迷いだけの設定を受け取る前は、何も描かず、窓を見せてよいとも知らせない', async () => {
    const mock = installTauriMock({ handlers: { get_settings: () => new Promise(() => {}) } });
    const { container } = render(<WidgetApp />);
    await new Promise((resolve) => setTimeout(resolve, 300));
    expect(container).toBeEmptyDOMElement();
    expect(mock.count('window_ready')).toBe(0);
  });
});

describe('W-15 迷いだけのウィジェット: 押す・つかんで動かす・キー', () => {
  it('押して、動かさずに離すと、迷いマークを 1 件記録する（窓は動かさない）。記録したらボタンが光る', async () => {
    const { mock, button } = await renderSquare();
    press(button);
    expect(mock.count('add_mark')).toBe(0);
    release(button);
    await waitFor(() => expect(mock.count('add_mark')).toBe(1));
    expect(startDragging).not.toHaveBeenCalled();
    expect(button).toHaveClass('flash');
  });

  it('ふつうのクリック（押す・離す・click）でも、数えるのは 1 回だけ', async () => {
    const { mock, button } = await renderSquare();
    await userEvent.setup().click(button);
    expect(mock.count('add_mark')).toBe(1);
    expect(startDragging).not.toHaveBeenCalled();
  });

  it('押したまま 5px 動かすと、窓を動かし始めて、記録しない（1 回だけ呼ぶ）。離しても記録しない', async () => {
    const { mock, button } = await renderSquare();
    press(button, 20, 20);
    moveTo(button, 22, 20);
    expect(startDragging).not.toHaveBeenCalled();
    moveTo(button, 25, 20);
    expect(startDragging).toHaveBeenCalledTimes(1);
    moveTo(button, 40, 33);
    moveTo(button, 60, 50);
    expect(startDragging).toHaveBeenCalledTimes(1);
    release(button, 60, 50);
    await settle();
    expect(mock.count('add_mark')).toBe(0);
    expect(button).not.toHaveClass('flash');
  });

  it('4px までの動きは、押したままでも「押した」（5px から動かし始める）。斜めは距離で見る', async () => {
    const { mock, button } = await renderSquare();
    press(button, 20, 20);
    moveTo(button, 24, 20);
    moveTo(button, 20, 16);
    release(button, 24, 20);
    await waitFor(() => expect(mock.count('add_mark')).toBe(1));
    expect(startDragging).not.toHaveBeenCalled();
    // 横 3px・縦 3px は約 4.2px で、動かし始める
    press(button, 20, 20);
    moveTo(button, 23, 23);
    expect(startDragging).toHaveBeenCalledTimes(1);
    release(button, 23, 23);
    expect(mock.count('add_mark')).toBe(1);
  });

  it('窓を動かし始めたあと、離したことが画面に届かなくても、次の押しは普通に記録になる', async () => {
    const { mock, button } = await renderSquare();
    press(button);
    moveTo(button, 30, 20);
    expect(startDragging).toHaveBeenCalledTimes(1);
    // OS が窓を動かしている間は、離したことが届かない。次の押しから、やり直す。
    press(button);
    release(button);
    await waitFor(() => expect(mock.count('add_mark')).toBe(1));
    press(button);
    moveTo(button, 30, 20);
    expect(startDragging).toHaveBeenCalledTimes(2);
  });

  it('押しが取り消された（pointercancel）ときは、そのあと離しても記録しない', async () => {
    const { mock, button } = await renderSquare();
    press(button);
    fireEvent.pointerCancel(button, { pointerId: 1 });
    release(button);
    await settle();
    expect(mock.count('add_mark')).toBe(0);
  });

  it('中ボタン・右ボタンの押しでは、記録も窓の移動もしない', async () => {
    const { mock, button } = await renderSquare();
    for (const which of [1, 2]) {
      fireEvent.pointerDown(button, { button: which, pointerId: 1, clientX: 20, clientY: 20 });
      fireEvent.pointerMove(button, { pointerId: 1, clientX: 40, clientY: 40 });
      fireEvent.pointerUp(button, { button: which, pointerId: 1, clientX: 40, clientY: 40 });
    }
    await settle();
    expect(mock.count('add_mark')).toBe(0);
    expect(startDragging).not.toHaveBeenCalled();
  });

  it('押す前の動きや、押さずに離しただけでは、何もしない', async () => {
    const { mock, button } = await renderSquare();
    moveTo(button, 60, 60);
    release(button);
    await settle();
    expect(mock.count('add_mark')).toBe(0);
    expect(startDragging).not.toHaveBeenCalled();
  });

  it('窓を動かし始められなかったら、読み上げの欄に理由を出す（記録はしない）', async () => {
    startDragging.mockRejectedValue('この操作は許可されていません');
    const { mock, button } = await renderSquare();
    press(button);
    moveTo(button, 40, 20);
    await waitFor(() => {
      expect(document.querySelector('[aria-live="polite"]')).toHaveTextContent('この操作は許可されていません');
    });
    release(button, 40, 20);
    expect(mock.count('add_mark')).toBe(0);
  });

  it('Enter で記録する。押し続けたときの繰り返しは数えない', async () => {
    const { mock, button } = await renderSquare();
    button.focus();
    fireEvent.keyDown(button, { key: 'Enter' });
    await waitFor(() => expect(mock.count('add_mark')).toBe(1));
    fireEvent.keyDown(button, { key: 'Enter', repeat: true });
    fireEvent.keyDown(button, { key: 'Enter', repeat: true });
    expect(mock.count('add_mark')).toBe(1);
    expect(startDragging).not.toHaveBeenCalled();
  });

  it('キーボードの Enter と Space は、ブラウザが続けて出す click とあわせて、1 回ずつ数える', async () => {
    const { mock, button } = await renderSquare();
    const user = userEvent.setup();
    button.focus();
    await user.keyboard('{Enter}');
    expect(mock.count('add_mark')).toBe(1);
    await user.keyboard(' ');
    expect(mock.count('add_mark')).toBe(2);
    // 関係のないキーでは記録しない
    await user.keyboard('a');
    await user.keyboard('{Escape}');
    expect(mock.count('add_mark')).toBe(2);
  });

  it('click だけが届いたとき（支援技術からの押下。detail が 0）は 1 回記録する。マウスの click（detail が 1 以上）は数えない', async () => {
    const { mock, button } = await renderSquare();
    fireEvent.click(button);
    await waitFor(() => expect(mock.count('add_mark')).toBe(1));
    fireEvent.click(button, { detail: 1 });
    expect(mock.count('add_mark')).toBe(1);
  });

  it('保存先を開けない（エラー）間は、押しても・キーでも記録しない', async () => {
    const error: AppState = { ...baseState, status: 'error', error: '保存先がリポジトリの中です' };
    const { mock, button } = await renderSquare({ state: error });
    expect(button).toBeDisabled();
    press(button);
    release(button);
    fireEvent.keyDown(button, { key: 'Enter' });
    fireEvent.click(button);
    await settle();
    expect(mock.count('add_mark')).toBe(0);
  });

  it('呼ぶコマンドは add_mark だけ（評価・取り消し・形のコマンドは呼ばない）', async () => {
    const { mock, button } = await renderSquare();
    press(button);
    release(button);
    await waitFor(() => expect(mock.count('add_mark')).toBe(1));
    const called = new Set(mock.calls().map((c) => c.cmd));
    expect([...called].sort()).toEqual(['add_mark', 'get_settings', 'get_state']);
  });
});
