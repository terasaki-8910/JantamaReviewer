import { open } from '@tauri-apps/plugin-dialog';
import { render, screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { FakeSessionStore, local, seedSession } from '../../tests/fake-sessions';
import { installTauriMock } from '../../tests/tauri-mock';
import { App } from './App';

vi.mock('@tauri-apps/api/core', () => ({
  invoke: vi.fn(),
  convertFileSrc: (path: string) => path,
}));
vi.mock('@tauri-apps/api/event', () => ({ listen: vi.fn() }));
vi.mock('@tauri-apps/plugin-dialog', () => ({ open: vi.fn(), save: vi.fn() }));

const PICKED = 'C:\\Users\\test\\jantama-records-20261009.json';

/** 試験の「いま」: 2026 年 10 月 9 日 22:00（日付を動かすのは Date だけ。タイマーは本物のまま）。 */
beforeEach(() => {
  vi.useFakeTimers({ toFake: ['Date'] });
  vi.setSystemTime(new Date(2026, 9, 9, 22, 0, 0));
  vi.mocked(open).mockReset();
});

afterEach(() => {
  vi.useRealTimers();
});

function setup() {
  const store = new FakeSessionStore([
    seedSession(local(2026, 10, 9, 19, 9), { marks: 3, report: 'fx4' }),
    seedSession(local(2026, 10, 8, 21, 40), { marks: 0 }),
  ]);
  const mock = installTauriMock({
    handlers: {
      ...store.handlers,
      records_overview: () => ({ sessions: 2, answers: 0, bytes: 3_000 }),
      inspect_records_file: () => ({ sessions: 2, answers: 7, held: 0 }),
      import_records: () => ({ sessions: 2, answers: 7, held: 0 }),
    },
  });
  vi.mocked(open).mockResolvedValue(PICKED);
  return { store, mock, user: userEvent.setup() };
}

async function openSettings(user: ReturnType<typeof userEvent.setup>) {
  await screen.findByRole('heading', { level: 1, name: /10月9日/ });
  await user.click(screen.getByRole('button', { name: '設定' }));
  return screen.findByRole('group', { name: '記録の書き出し' });
}

describe('設定の「読み込む」と、検討画面の読み直し（D-2、R11-14）', () => {
  it('確認を開いている間は、裏の画面（サイドバーと本文）が操作できない。やめると、また操作できて、「読み込む」に戻る', async () => {
    const { user } = setup();
    render(<App />);
    const group = await openSettings(user);
    const importButton = within(group).getByRole('button', { name: '読み込む' });
    await user.click(importButton);
    const dialog = await screen.findByRole('alertdialog');
    const app = document.querySelector('.app') as HTMLElement;
    expect(app).toHaveAttribute('inert');
    // 確認は、裏の画面の外（body の直下）にあるので、操作できる
    expect(app.contains(dialog)).toBe(false);
    expect(within(dialog).getByRole('button', { name: 'やめる' })).toHaveFocus();
    await user.keyboard('{Escape}');
    expect(screen.queryByRole('alertdialog')).toBeNull();
    expect(app).not.toHaveAttribute('inert');
    await waitFor(() => expect(importButton).toHaveFocus());
  });

  it('置き換えると、画面のデータをすべて読み直し（半荘の一覧・答え・週）、設定のページに「読み込みました…」を出す', async () => {
    const { user, mock } = setup();
    render(<App />);
    const group = await openSettings(user);
    await waitFor(() => expect(mock.count('list_answers')).toBeGreaterThan(0));
    const before = {
      sessions: mock.count('list_sessions'),
      answers: mock.count('list_answers'),
      settings: mock.count('get_settings'),
    };
    await user.click(within(group).getByRole('button', { name: '読み込む' }));
    await user.click(await screen.findByRole('button', { name: '置き換える' }));

    await waitFor(() =>
      expect(screen.getByRole('group', { name: '記録の書き出し' })).toHaveTextContent(
        '読み込みました（半荘 2・答え 7）。スクショと Mortal の結果は、データの保存先にあるものを使います。',
      ),
    );
    expect(screen.getByRole('heading', { level: 1, name: '設定' })).toBeInTheDocument();
    // 半荘の一覧・答えの記録・設定を、読み直している
    await waitFor(() => expect(mock.count('list_sessions')).toBeGreaterThan(before.sessions));
    expect(mock.count('list_answers')).toBeGreaterThan(before.answers);
    expect(mock.count('get_settings')).toBeGreaterThan(before.settings);
    // 裏の画面は、また操作できる
    expect(document.querySelector('.app')).not.toHaveAttribute('inert');
  });

  it('置き換える前の操作の取り消しは、持ち越さない（Ctrl+Z で、置き換える前の削除を戻さない）', async () => {
    const { user, store } = setup();
    render(<App />);
    await screen.findByRole('heading', { level: 1, name: /10月9日/ });
    const list = screen.getByRole('navigation', { name: '半荘の一覧' });
    const row = within(list).getAllByRole('button', { name: /^\d\d:\d\d/ })[1] as HTMLElement;
    await user.click(within(row.closest('li') as HTMLElement).getByRole('button', { name: /のメニュー/ }));
    await user.click(within(screen.getByRole('menu')).getByRole('menuitem', { name: '削除' }));
    await user.click(within(screen.getByRole('alertdialog')).getByRole('button', { name: '削除' }));
    await waitFor(() => expect(store.log).toHaveLength(1));

    await user.click(screen.getByRole('button', { name: '設定' }));
    const group = await screen.findByRole('group', { name: '記録の書き出し' });
    await user.click(within(group).getByRole('button', { name: '読み込む' }));
    await user.click(await screen.findByRole('button', { name: '置き換える' }));
    await waitFor(() =>
      expect(screen.getByRole('group', { name: '記録の書き出し' })).toHaveTextContent('読み込みました'),
    );

    await user.keyboard('{Control>}z{/Control}');
    expect(store.log).toHaveLength(1);
    expect(store.log[0]).toMatch(/^delete:/);
  });

  it('読み込んだあとの知らせは 1 度だけ。ほかの画面へ移って設定に戻ると、出ていない', async () => {
    const { user } = setup();
    render(<App />);
    const group = await openSettings(user);
    await user.click(within(group).getByRole('button', { name: '読み込む' }));
    await user.click(await screen.findByRole('button', { name: '置き換える' }));
    await waitFor(() =>
      expect(screen.getByRole('group', { name: '記録の書き出し' })).toHaveTextContent('読み込みました'),
    );
    await user.click(screen.getByRole('button', { name: '週の集計' }));
    await screen.findByRole('heading', { level: 1, name: '週の集計' });
    await user.click(screen.getByRole('button', { name: '設定' }));
    const again = await screen.findByRole('group', { name: '記録の書き出し' });
    expect(again).not.toHaveTextContent('読み込みました');
  });
});
