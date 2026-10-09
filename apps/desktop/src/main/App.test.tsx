import { render, screen, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

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

describe('検討画面のシェル', () => {
  it('サイドバーには、いま在る行き先（記録・設定）だけを置く', async () => {
    installTauriMock();
    render(<App />);
    const side = screen.getByRole('complementary', { name: 'サイドバー' });
    const nav = within(side).getByRole('navigation', { name: 'メイン' });
    expect(within(nav).getAllByRole('button').map((b) => b.textContent)).toEqual(['記録']);
    expect(within(side).getByRole('button', { name: '設定' })).toBeInTheDocument();
    // まだ作っていない機能の項目は置かない。
    for (const absent of ['検討', '解き直し', 'ログ', '週の集計', '取り込み']) {
      expect(within(side).queryByText(new RegExp(absent))).toBeNull();
    }
    expect(await screen.findByRole('heading', { level: 1, name: '記録' })).toBeInTheDocument();
  });

  it('記録と設定を切り替える。選んでいる行き先に aria-current が付く', async () => {
    installTauriMock();
    const user = userEvent.setup();
    render(<App />);
    const records = screen.getByRole('button', { name: '記録' });
    const settings = screen.getByRole('button', { name: '設定' });
    expect(records).toHaveAttribute('aria-current', 'page');
    expect(settings).not.toHaveAttribute('aria-current');

    await user.click(settings);
    expect(await screen.findByRole('heading', { level: 1, name: '設定' })).toBeInTheDocument();
    expect(settings).toHaveAttribute('aria-current', 'page');
    expect(records).not.toHaveAttribute('aria-current');

    await user.click(records);
    expect(await screen.findByRole('heading', { level: 1, name: '記録' })).toBeInTheDocument();
  });

  it('テーマの切り替えは 1 つのアイコンのボタンで、押すと覚える', async () => {
    installTauriMock();
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
    installTauriMock();
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
    const mock = installTauriMock();
    document.body.style.background = PAGE_BACKGROUNDS.light;
    render(<App />);
    expect(mock.count('window_ready')).toBe(0);
    await vi.waitFor(() => expect(mock.count('window_ready')).toBe(1));
    const call = mock.calls().find((c) => c.cmd === 'window_ready');
    expect(call?.args).toEqual({ background: PAGE_BACKGROUNDS.light });
  });

  it('N-7: テーマを切り替えると、窓の背景色を画面の色にそろえさせる', async () => {
    const mock = installTauriMock();
    const user = userEvent.setup();
    render(<App />);
    expect(mock.count('set_window_background')).toBe(0);
    await user.click(screen.getByRole('button', { name: 'ダークテーマに切り替え' }));
    await vi.waitFor(() => expect(mock.count('set_window_background')).toBe(1));
  });

  it('N-5: 画面を切り替えても、URL・ハッシュ・履歴の項目は変わらない（メモリの中だけで持つ）', async () => {
    installTauriMock();
    const user = userEvent.setup();
    const href = window.location.href;
    const historyLength = window.history.length;
    render(<App />);
    await user.click(screen.getByRole('button', { name: '設定' }));
    expect(await screen.findByRole('heading', { level: 1, name: '設定' })).toBeInTheDocument();
    await user.click(screen.getByRole('button', { name: '記録' }));
    expect(await screen.findByRole('heading', { level: 1, name: '記録' })).toBeInTheDocument();
    expect(window.location.href).toBe(href);
    expect(window.location.hash).toBe('');
    expect(window.history.length).toBe(historyLength);
  });

  it('N-5: 画面の中に、ページを移るリンクが無い（a 要素・フォームの送信が無い）', async () => {
    installTauriMock();
    const user = userEvent.setup();
    const { container } = render(<App />);
    for (const name of ['設定', '記録']) {
      await user.click(screen.getByRole('button', { name }));
      expect(container.querySelectorAll('a[href]')).toHaveLength(0);
      expect(container.querySelectorAll('form')).toHaveLength(0);
    }
  });
});
