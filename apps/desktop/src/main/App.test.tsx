import { render, screen, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { FakeSessionStore, local, seedSession } from '../../tests/fake-sessions';
import { installTauriMock, PAGE_BACKGROUNDS } from '../../tests/tauri-mock';
import { THEME_STORAGE_KEY } from '../shared/theme';
import { resetWindowReadyForTest } from '../shared/windowReady';
import { App } from './App';

vi.mock('@tauri-apps/api/core', () => ({
  invoke: vi.fn(),
  convertFileSrc: (path: string) => path,
}));
vi.mock('@tauri-apps/api/event', () => ({ listen: vi.fn() }));
vi.mock('@tauri-apps/plugin-dialog', () => ({ open: vi.fn() }));

/** 試験の「いま」: 2026 年 10 月 9 日 22:00（日付を動かすのは Date だけ。タイマーは本物のまま）。 */
beforeEach(() => {
  vi.useFakeTimers({ toFake: ['Date'] });
  vi.setSystemTime(new Date(2026, 9, 9, 22, 0, 0));
});

afterEach(() => {
  vi.useRealTimers();
});

function twoSessions() {
  return new FakeSessionStore([
    seedSession(local(2026, 10, 9, 19, 9), { marks: 3, report: 'fx4' }),
    seedSession(local(2026, 10, 8, 21, 40), { marks: 0 }),
  ]);
}

describe('検討画面のシェル（U-8）', () => {
  it('サイドバーの上に、名前と ← →、主な操作「検討結果を取り込む」、行き先（今日の出題・解き直し・ログは押せる。週の集計はまだ押せない）を置く', async () => {
    const store = twoSessions();
    installTauriMock({ handlers: store.handlers });
    render(<App />);
    const side = screen.getByRole('complementary', { name: 'サイドバー' });
    const history = within(side).getByRole('group', { name: '画面の履歴' });
    expect(within(history).getByRole('button', { name: '戻る' })).toBeDisabled();
    expect(within(history).getByRole('button', { name: '進む' })).toBeDisabled();
    // 取り込みの入口は、行き先の一覧の外（上）に、主な操作として 1 つだけ。
    expect(within(side).getAllByRole('button', { name: '検討結果を取り込む' })).toHaveLength(1);
    const nav = within(side).getByRole('navigation', { name: 'メイン' });
    expect(within(nav).queryByRole('button', { name: '検討結果を取り込む' })).toBeNull();
    const items = within(nav).getAllByRole('button');
    // 今日の出題が解き直しの上。数（読み込み後）は、行の右に付く
    expect(items.map((b) => b.querySelector('.label')?.textContent)).toEqual(['今日の出題', '解き直し', 'ログ', '週の集計']);
    for (const item of items.slice(0, 3)) {
      expect(item).not.toHaveAttribute('aria-disabled');
      expect(item).toHaveAttribute('title', item.querySelector('.label')?.textContent ?? '');
    }
    for (const item of items.slice(3)) {
      expect(item).toHaveAttribute('aria-disabled', 'true');
      expect(item).toHaveAttribute('title', 'あとで作ります');
    }
    expect(within(side).getByRole('button', { name: '設定' })).toBeInTheDocument();
    expect(await within(side).findByRole('navigation', { name: '半荘の一覧' })).toBeInTheDocument();
  });

  it('まだ作っていない行き先（週の集計）を押しても、何も起きない（本文もそのまま）', async () => {
    installTauriMock({ handlers: twoSessions().handlers });
    const user = userEvent.setup();
    render(<App />);
    await screen.findByRole('heading', { level: 1, name: /10月9日/ });
    for (const name of ['週の集計']) {
      await user.click(screen.getByRole('button', { name }));
      expect(screen.getByRole('heading', { level: 1, name: /10月9日/ })).toBeInTheDocument();
      expect(screen.getByRole('button', { name })).not.toHaveAttribute('aria-current');
    }
  });

  it('起動すると、いちばん新しい半荘が開く（行に印が付く）。半荘と設定を切り替える。選んでいる行き先に aria-current が付く', async () => {
    installTauriMock({ handlers: twoSessions().handlers });
    const user = userEvent.setup();
    render(<App />);
    expect(await screen.findByRole('heading', { level: 1, name: /10月9日\(金\) 19:09/ })).toBeInTheDocument();
    const list = screen.getByRole('navigation', { name: '半荘の一覧' });
    const rows = within(list).getAllByRole('button', { name: /^\d\d:\d\d/ });
    expect(rows[0]).toHaveAttribute('aria-current', 'true');
    expect(rows[1]).not.toHaveAttribute('aria-current');

    const settings = screen.getByRole('button', { name: '設定' });
    expect(settings).not.toHaveAttribute('aria-current');
    await user.click(settings);
    expect(await screen.findByRole('heading', { level: 1, name: '設定' })).toBeInTheDocument();
    expect(settings).toHaveAttribute('aria-current', 'page');
    expect(rows[0]).not.toHaveAttribute('aria-current');

    await user.click(rows[1] as HTMLElement);
    expect(await screen.findByRole('heading', { level: 1, name: /10月8日\(木\) 21:40/ })).toBeInTheDocument();
    expect(rows[1]).toHaveAttribute('aria-current', 'true');
    expect(settings).not.toHaveAttribute('aria-current');
  });

  it('半荘が 1 つも無いときは、本文に短い案内を出し、一覧にも「半荘がありません」と出す（検索・選択の欄は出さない）', async () => {
    installTauriMock({ handlers: new FakeSessionStore([]).handlers });
    render(<App />);
    expect(await screen.findByRole('heading', { level: 1, name: '半荘がありません' })).toBeInTheDocument();
    expect(screen.getByText(/ウィジェットの「迷い」や〇△✕を押すと、ここに並びます/)).toBeInTheDocument();
    const list = screen.getByRole('navigation', { name: '半荘の一覧' });
    expect(within(list).getByText('半荘がありません')).toBeInTheDocument();
    expect(within(list).queryByRole('searchbox')).toBeNull();
    expect(within(list).queryByRole('button', { name: '選択' })).toBeNull();
    expect(within(list).queryByRole('button', { name: /^段階/ })).toBeNull();
  });

  it('一覧を読めなかったら、理由を出す', async () => {
    installTauriMock({
      handlers: {
        list_sessions: () => {
          throw '保存先を開けませんでした';
        },
      },
    });
    render(<App />);
    expect(await screen.findByRole('alert')).toHaveTextContent('保存先を開けませんでした');
  });

  it('テーマの切り替えは 1 つのアイコンのボタンで、押すと覚える', async () => {
    installTauriMock({ handlers: twoSessions().handlers });
    const user = userEvent.setup();
    render(<App />);
    const toggle = screen.getByRole('button', { name: 'ダークテーマに切り替え' });
    await user.click(toggle);
    expect(document.documentElement).toHaveAttribute('data-theme', 'dark');
    expect(window.localStorage.getItem(THEME_STORAGE_KEY)).toBe('dark');
    const back = screen.getByRole('button', { name: 'ライトテーマに切り替え' });
    await user.click(back);
    expect(document.documentElement).toHaveAttribute('data-theme', 'light');
    expect(window.localStorage.getItem(THEME_STORAGE_KEY)).toBe('light');
  });

  it('main の領域は 1 つだけ', () => {
    installTauriMock({ handlers: twoSessions().handlers });
    render(<App />);
    expect(screen.getAllByRole('main')).toHaveLength(1);
  });
});

describe('検討画面: 窓を見せる知らせ（N-7）と、URL・履歴を使わない切り替え（N-5）', () => {
  beforeEach(() => {
    resetWindowReadyForTest();
    document.body.style.background = '';
  });

  afterEach(() => {
    document.body.style.background = '';
  });

  it('N-7: 最初の絵を描いたあとに、いま描いている背景の色を添えて、window_ready を 1 回だけ送る', async () => {
    const mock = installTauriMock({ handlers: twoSessions().handlers });
    document.body.style.background = PAGE_BACKGROUNDS.light;
    render(<App />);
    expect(mock.count('window_ready')).toBe(0);
    await vi.waitFor(() => expect(mock.count('window_ready')).toBe(1));
    const call = mock.calls().find((c) => c.cmd === 'window_ready');
    expect(call?.args).toEqual({ background: PAGE_BACKGROUNDS.light });
  });

  it('N-7: テーマを切り替えると、窓の背景色を画面の色にそろえさせる', async () => {
    const mock = installTauriMock({ handlers: twoSessions().handlers });
    const user = userEvent.setup();
    render(<App />);
    expect(mock.count('set_window_background')).toBe(0);
    await user.click(screen.getByRole('button', { name: 'ダークテーマに切り替え' }));
    await vi.waitFor(() => expect(mock.count('set_window_background')).toBe(1));
  });

  it('N-5: 画面を切り替えても、URL・ハッシュ・履歴の項目は変わらない（メモリの中だけで持つ）', async () => {
    installTauriMock({ handlers: twoSessions().handlers });
    const user = userEvent.setup();
    const href = window.location.href;
    const historyLength = window.history.length;
    render(<App />);
    await screen.findByRole('heading', { level: 1, name: /10月9日/ });
    await user.click(screen.getByRole('button', { name: '設定' }));
    expect(await screen.findByRole('heading', { level: 1, name: '設定' })).toBeInTheDocument();
    await user.click(screen.getByRole('button', { name: '検討結果を取り込む' }));
    expect(await screen.findByRole('heading', { level: 1, name: '検討結果を取り込む' })).toBeInTheDocument();
    await user.click(screen.getByRole('button', { name: /^21:40/ }));
    expect(await screen.findByRole('heading', { level: 1, name: /10月8日/ })).toBeInTheDocument();
    await user.click(screen.getByRole('button', { name: '戻る' }));
    await user.keyboard('{Alt>}{ArrowLeft}{/Alt}');
    expect(window.location.href).toBe(href);
    expect(window.location.hash).toBe('');
    expect(window.history.length).toBe(historyLength);
  });

  it('N-5: 画面の中に、ページを移るリンクが無い（a 要素・フォームの送信が無い）', async () => {
    installTauriMock({ handlers: twoSessions().handlers });
    const user = userEvent.setup();
    const { container } = render(<App />);
    await screen.findByRole('heading', { level: 1, name: /10月9日/ });
    for (const name of ['設定', '検討結果を取り込む', /^21:40/]) {
      await user.click(screen.getByRole('button', { name }));
      expect(container.querySelectorAll('a[href]')).toHaveLength(0);
      expect(container.querySelectorAll('form')).toHaveLength(0);
    }
  });
});
