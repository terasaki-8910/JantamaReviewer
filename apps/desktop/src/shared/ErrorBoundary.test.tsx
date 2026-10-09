import { render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { useEffect } from 'react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { ErrorBoundary, ErrorScreen } from './ErrorBoundary';
import { signalWindowReady } from './windowReady';

// 知らせの送り方そのものは windowReady.test.ts が確かめる。ここでは、エラー画面が知らせを呼ぶことだけを確かめる。
vi.mock('./windowReady', () => ({ signalWindowReady: vi.fn(async () => {}) }));

/** 描くたびに、壊れるかどうかを外から決められる部品。作られた回数も数える。 */
function makeBomb() {
  const state = { broken: true, mounts: 0 };
  function Bomb() {
    useEffect(() => {
      state.mounts += 1;
    }, []);
    if (state.broken) throw new Error('描画の途中で壊れた');
    return <p>ふつうの画面</p>;
  }
  return { state, Bomb };
}

beforeEach(() => {
  vi.mocked(signalWindowReady).mockClear();
  // React は、境界が受けた例外をコンソールに出す。テストの出力を汚さない。
  vi.spyOn(console, 'error').mockImplementation(() => {});
});

afterEach(() => {
  vi.restoreAllMocks();
});

describe('N-5: アプリの中のエラー画面', () => {
  it('壊れていなければ、子の部品をそのまま描く', () => {
    const { state, Bomb } = makeBomb();
    state.broken = false;
    render(
      <ErrorBoundary>
        <Bomb />
      </ErrorBoundary>,
    );
    expect(screen.getByText('ふつうの画面')).toBeInTheDocument();
    expect(screen.queryByRole('alert')).toBeNull();
  });

  it('描画で例外が出たら、アプリのデザインのエラー画面（短い日本語とボタン）に替わる', () => {
    const { Bomb } = makeBomb();
    render(
      <ErrorBoundary>
        <Bomb />
      </ErrorBoundary>,
    );
    const alert = screen.getByRole('alert');
    expect(alert).toHaveClass('error-screen');
    expect(
      screen.getByRole('heading', { level: 1, name: '表示できませんでした' }),
    ).toBeInTheDocument();
    expect(screen.getByText('画面を描いている途中で、問題が起きました。')).toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'もう一度表示する' })).toBeInTheDocument();
    // 例外の中身（英語のメッセージやスタック）は、画面に出さない。
    expect(alert.textContent).not.toMatch(/Error|描画の途中で壊れた|at /);
  });

  it('小さい窓（ウィジェット）では、短い文言と詰めた配置になる', () => {
    const { Bomb } = makeBomb();
    render(
      <ErrorBoundary compact>
        <Bomb />
      </ErrorBoundary>,
    );
    expect(screen.getByRole('alert')).toHaveClass('error-screen', 'compact');
    expect(screen.getByRole('heading', { name: '表示エラー' })).toBeInTheDocument();
    expect(screen.getByRole('button', { name: '再表示' })).toBeInTheDocument();
  });

  it('ボタンで、子の部品を作り直す（ブラウザの再読み込みではなく、描き直し）', async () => {
    const user = userEvent.setup();
    const { state, Bomb } = makeBomb();
    render(
      <ErrorBoundary>
        <Bomb />
      </ErrorBoundary>,
    );
    expect(screen.getByRole('alert')).toBeInTheDocument();

    // 直ったあとに押せば、元の画面に戻る。
    state.broken = false;
    await user.click(screen.getByRole('button', { name: 'もう一度表示する' }));
    expect(screen.getByText('ふつうの画面')).toBeInTheDocument();
    expect(screen.queryByRole('alert')).toBeNull();
    expect(state.mounts).toBe(1);
  });

  it('直っていないうちに押すと、またエラー画面になる（無限に繰り返さない）', async () => {
    const user = userEvent.setup();
    const { Bomb } = makeBomb();
    render(
      <ErrorBoundary>
        <Bomb />
      </ErrorBoundary>,
    );
    await user.click(screen.getByRole('button', { name: 'もう一度表示する' }));
    expect(screen.getByRole('alert')).toBeInTheDocument();
    await user.click(screen.getByRole('button', { name: 'もう一度表示する' }));
    expect(screen.getByRole('alert')).toBeInTheDocument();
  });

  it('例外の内容は、コンソールに残す', () => {
    const log = vi.spyOn(console, 'error').mockImplementation(() => {});
    const { Bomb } = makeBomb();
    render(
      <ErrorBoundary>
        <Bomb />
      </ErrorBoundary>,
    );
    const logged = log.mock.calls.some((args) =>
      args.some((a) => String(a).includes('画面を描けませんでした')),
    );
    expect(logged).toBe(true);
  });

  it('エラー画面でも「描き終えた」と知らせる（窓が見えないままにならない）', () => {
    const { Bomb } = makeBomb();
    render(
      <ErrorBoundary>
        <Bomb />
      </ErrorBoundary>,
    );
    expect(signalWindowReady).toHaveBeenCalledTimes(1);
  });

  it('ErrorScreen: 押すと onRetry が呼ばれる', async () => {
    const user = userEvent.setup();
    const onRetry = vi.fn();
    render(<ErrorScreen onRetry={onRetry} />);
    await user.click(screen.getByRole('button', { name: 'もう一度表示する' }));
    expect(onRetry).toHaveBeenCalledTimes(1);
  });
});
