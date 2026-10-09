import { act, fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { beforeEach, describe, expect, it, vi } from 'vitest';

import { baseSettings, baseState, installTauriMock, type TauriMock } from '../../tests/tauri-mock';
import type { AppState, Settings } from '../api/types';
import { ErrorBoundary } from '../shared/ErrorBoundary';
import { resetWindowReadyForTest } from '../shared/windowReady';
import { WidgetApp } from './WidgetApp';

vi.mock('@tauri-apps/api/core', () => ({
  invoke: vi.fn(),
  convertFileSrc: (path: string) => `asset://localhost/${encodeURIComponent(path)}`,
}));
vi.mock('@tauri-apps/api/event', () => ({ listen: vi.fn() }));

const RATE_LABEL = '（終わった局の評価）';

async function renderWidget(options: { state?: AppState; settings?: Settings } = {}) {
  const mock = installTauriMock(options);
  const view = render(<WidgetApp />);
  // 状態と形を受け取ってから描かれる。
  await screen.findByRole('group', { name: '終わった局の評価' });
  return { mock, ...view };
}

describe('ウィジェット: 表示', () => {
  beforeEach(() => {
    vi.useRealTimers();
  });

  it('次の局番号・迷いの数・記録中の表示が出る', async () => {
    await renderWidget();
    expect(screen.getByText('次：5局目')).toBeInTheDocument();
    expect(screen.getByText('記録中')).toBeInTheDocument();
    const doubt = screen.getByRole('button', { name: /^迷い 2/ });
    expect(within(doubt).getByText('2')).toBeInTheDocument();
  });

  it('状態を受け取る前は、何も描かない（間違った数字を一瞬出さない）', () => {
    installTauriMock({
      handlers: { get_state: () => new Promise(() => {}), get_settings: () => new Promise(() => {}) },
    });
    const { container } = render(<WidgetApp />);
    expect(container).toBeEmptyDOMElement();
  });

  it('state-changed のイベントで、数字がその場で変わる', async () => {
    const { mock } = await renderWidget();
    act(() => {
      mock.emit('state-changed', {
        ...baseState,
        mark_count: 3,
        ratings: [...baseState.ratings, 'bad'],
        next_hand: 6,
      } satisfies AppState);
    });
    expect(await screen.findByText('次：6局目')).toBeInTheDocument();
    expect(screen.getByRole('button', { name: /^迷い 3/ })).toBeInTheDocument();
  });

  it('割り当てたボタンで付けた迷い（ウィジェットのボタンを押していない）も、数字に反映される', async () => {
    const { mock } = await renderWidget();
    expect(mock.count('add_mark')).toBe(0);
    act(() => {
      mock.emit('state-changed', { ...baseState, mark_count: 3 } satisfies AppState);
    });
    expect(await screen.findByRole('button', { name: /^迷い 3/ })).toBeInTheDocument();
    expect(mock.count('add_mark')).toBe(0);
  });

  it('半荘が始まっていないときは「待機中」、保存先を開けないときは「エラー」', async () => {
    const idle: AppState = {
      ...baseState,
      status: 'idle',
      session_id: null,
      mark_count: 0,
      ratings: [],
      next_hand: 1,
      can_undo: false,
    };
    const { mock } = await renderWidget({ state: idle });
    expect(screen.getByText('待機中')).toBeInTheDocument();
    expect(screen.getByText('次：1局目')).toBeInTheDocument();
    act(() => {
      mock.emit('state-changed', {
        ...idle,
        status: 'error',
        error: '保存先がリポジトリの中です',
      } satisfies AppState);
    });
    expect(await screen.findByText('エラー')).toBeInTheDocument();
    // 記録できない間は、記録のボタンを押せない。
    expect(screen.getByRole('button', { name: `〇${RATE_LABEL}` })).toBeDisabled();
    expect(screen.getByRole('button', { name: /^迷い/ })).toBeDisabled();
  });

  it('取り消せる記録が無いときは「取り消し」が押せない', async () => {
    await renderWidget({ state: { ...baseState, can_undo: false } });
    expect(screen.getByRole('button', { name: '取り消し' })).toBeDisabled();
  });

  it('評価と迷いが増えたら、読み上げ用の文が出る', async () => {
    const { mock } = await renderWidget();
    act(() => {
      mock.emit('state-changed', {
        ...baseState,
        ratings: [...baseState.ratings, 'good'],
        next_hand: 6,
      } satisfies AppState);
    });
    await waitFor(() => {
      expect(document.querySelector('[aria-live="polite"]')).toHaveTextContent('5局目を〇で記録');
    });
    act(() => {
      mock.emit('state-changed', {
        ...baseState,
        mark_count: 3,
        ratings: [...baseState.ratings, 'good'],
        next_hand: 6,
      } satisfies AppState);
    });
    await waitFor(() => {
      expect(document.querySelector('[aria-live="polite"]')).toHaveTextContent('迷いの印を追加。合計3');
    });
  });
});

describe('ウィジェット: 縦長と横長', () => {
  it('縦長（既定）: 「次：N局目」は評価の組の中、状態は上', async () => {
    const { container } = await renderWidget();
    const root = container.querySelector('.widget');
    expect(root).toHaveClass('v');
    expect(root).not.toHaveClass('h');
    const group = screen.getByRole('group', { name: '終わった局の評価' });
    expect(within(group).getByText('次：5局目')).toBeInTheDocument();
    expect(container.querySelector('.info')).toBeNull();
  });

  it('横長: 状態と「次：N局目」が左の情報欄にまとまり、評価の組はボタンだけ', async () => {
    const { container } = await renderWidget({
      settings: { ...baseSettings, orientation: 'horizontal' },
    });
    const root = container.querySelector('.widget');
    expect(root).toHaveClass('h');
    expect(root).not.toHaveClass('v');
    const info = container.querySelector('.info') as HTMLElement;
    expect(within(info).getByText('記録中')).toBeInTheDocument();
    expect(within(info).getByText('次：5局目')).toBeInTheDocument();
    const group = screen.getByRole('group', { name: '終わった局の評価' });
    expect(within(group).getAllByRole('button')).toHaveLength(3);
    expect(within(group).queryByText('次：5局目')).toBeNull();
  });

  it('settings-changed のイベントで、形がその場で切り替わる', async () => {
    const { mock, container } = await renderWidget();
    expect(container.querySelector('.widget')).toHaveClass('v');
    act(() => {
      mock.emit('settings-changed', { ...baseSettings, orientation: 'horizontal' } satisfies Settings);
    });
    await waitFor(() => expect(container.querySelector('.widget')).toHaveClass('h'));
    act(() => {
      mock.emit('settings-changed', { ...baseSettings, orientation: 'vertical' } satisfies Settings);
    });
    await waitFor(() => expect(container.querySelector('.widget')).toHaveClass('v'));
  });

  it('どちらの形でも、ボタンは 5 つ（〇 △ ✕ 迷い 取り消し）で、評価は aria-label に文字がある', async () => {
    for (const orientation of ['vertical', 'horizontal'] as const) {
      const { unmount } = await renderWidget({ settings: { ...baseSettings, orientation } });
      const names = screen.getAllByRole('button').map((b) => b.getAttribute('aria-label') ?? b.textContent);
      expect(names).toEqual([
        `〇${RATE_LABEL}`,
        `△${RATE_LABEL}`,
        `✕${RATE_LABEL}`,
        '迷い 2（押すと印を追加）',
        '取り消し',
      ]);
      unmount();
    }
  });

  it('ボタン以外の場所をつかむと窓を動かせる（ドラッグ領域は deep、ボタンは領域の外）', async () => {
    const { container } = await renderWidget();
    expect(container.querySelector('.widget')).toHaveAttribute('data-tauri-drag-region', 'deep');
    for (const button of screen.getAllByRole('button')) {
      expect(button.tagName).toBe('BUTTON');
      expect(button).not.toHaveAttribute('data-tauri-drag-region');
    }
  });
});

describe('ウィジェット: ボタンは正しいコマンドを呼ぶ', () => {
  let mock: TauriMock;

  beforeEach(async () => {
    ({ mock } = await renderWidget());
  });

  it('〇 △ ✕ はそれぞれ good / fair / bad の評価を送る', async () => {
    const user = userEvent.setup();
    await user.click(screen.getByRole('button', { name: `〇${RATE_LABEL}` }));
    await user.click(screen.getByRole('button', { name: `△${RATE_LABEL}` }));
    await user.click(screen.getByRole('button', { name: `✕${RATE_LABEL}` }));
    const ratings = mock
      .calls()
      .filter((c) => c.cmd === 'add_rating')
      .map((c) => c.args);
    expect(ratings).toEqual([{ rating: 'good' }, { rating: 'fair' }, { rating: 'bad' }]);
  });

  it('迷いのボタンは add_mark を呼ぶ', async () => {
    const user = userEvent.setup();
    await user.click(screen.getByRole('button', { name: /^迷い/ }));
    expect(mock.count('add_mark')).toBe(1);
  });

  it('取り消しは undo を呼ぶ', async () => {
    const user = userEvent.setup();
    await user.click(screen.getByRole('button', { name: '取り消し' }));
    expect(mock.count('undo')).toBe(1);
  });

  it('評価・迷い・取り消し以外のコマンドは、押しても呼ばない', async () => {
    const user = userEvent.setup();
    await user.click(screen.getByRole('button', { name: `〇${RATE_LABEL}` }));
    const called = new Set(mock.calls().map((c) => c.cmd));
    expect([...called].sort()).toEqual(['add_rating', 'get_settings', 'get_state']);
  });

  it('右クリックでネイティブのメニューを出す（ブラウザの標準メニューは出さない）', async () => {
    const event = new MouseEvent('contextmenu', { bubbles: true, cancelable: true });
    const notPrevented = fireEvent(document.body, event);
    expect(notPrevented).toBe(false);
    expect(mock.count('show_widget_menu')).toBe(1);
  });
});

describe('ウィジェット: 窓を見せる知らせ（N-7）と、エラー画面（N-5）', () => {
  beforeEach(() => {
    resetWindowReadyForTest();
  });

  it('N-7: 状態と形を受け取って本物の絵を描いたあとに、window_ready を 1 回だけ送る', async () => {
    const { mock } = await renderWidget();
    await vi.waitFor(() => expect(mock.count('window_ready')).toBe(1));
    // そのあと状態が変わっても、知らせ直さない。
    act(() => {
      mock.emit('state-changed', { ...baseState, mark_count: 3 } satisfies AppState);
    });
    await screen.findByRole('button', { name: /^迷い 3/ });
    await new Promise((resolve) => setTimeout(resolve, 300));
    expect(mock.count('window_ready')).toBe(1);
  });

  it('N-7: 状態を受け取る前（何も描いていない間）は、窓を見せてよいと知らせない', async () => {
    const mock = installTauriMock({
      handlers: { get_state: () => new Promise(() => {}), get_settings: () => new Promise(() => {}) },
    });
    render(<WidgetApp />);
    await new Promise((resolve) => setTimeout(resolve, 400));
    expect(mock.count('window_ready')).toBe(0);
  });

  it('N-5: 最初の状態を受け取れなかったら、アプリの中のエラー画面（小さい窓向け）に替わる', async () => {
    vi.spyOn(console, 'error').mockImplementation(() => {});
    installTauriMock({
      handlers: {
        get_state: () => {
          throw '保存先を開けません';
        },
      },
    });
    render(
      <ErrorBoundary compact>
        <WidgetApp />
      </ErrorBoundary>,
    );
    const alert = await screen.findByRole('alert');
    expect(alert).toHaveClass('error-screen', 'compact');
    expect(screen.getByRole('button', { name: '再表示' })).toBeInTheDocument();
    vi.restoreAllMocks();
  });
});
