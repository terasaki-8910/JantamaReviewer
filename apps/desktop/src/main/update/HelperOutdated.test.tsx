import { act, render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { describe, expect, it, vi } from 'vitest';

import { baseInputStatus, installTauriMock, type TauriMock } from '../../../tests/tauri-mock';
import type { HelperStatus, InputStatus } from '../../api/types';
import { SettingsPage } from '../SettingsPage';

vi.mock('@tauri-apps/api/core', () => ({
  invoke: vi.fn(),
  convertFileSrc: (path: string) => path,
}));
vi.mock('@tauri-apps/api/event', () => ({ listen: vi.fn() }));
vi.mock('@tauri-apps/plugin-dialog', () => ({ open: vi.fn(), save: vi.fn() }));

const NOTICE = '新しい補助プログラムがあります。設定し直してください';

function status(helper: Partial<HelperStatus>, hook: InputStatus['hook'] = 'helper'): InputStatus {
  return { ...baseInputStatus, hook, helper: { ...baseInputStatus.helper, ...helper } };
}

async function renderPage(inputStatus: InputStatus): Promise<TauriMock> {
  const mock = installTauriMock({ inputStatus });
  render(<SettingsPage />);
  await screen.findByRole('status', { name: '補助プログラム' });
  return mock;
}

describe('設定ページ: 補助プログラムの写しが前の版のまま（F21）', () => {
  it('本体と一緒に入っている補助プログラムと、設定済みの写しが違えば、「設定し直してください」と「設定し直す」が出る', async () => {
    const user = userEvent.setup();
    const mock = await renderPage(status({ installed: true, running: true, outdated: true }));
    const row = screen.getByRole('status', { name: '補助プログラム' });
    expect(row).toHaveTextContent('動いています');
    expect(screen.getByText(NOTICE)).toBeInTheDocument();
    const redo = screen.getByRole('button', { name: '設定し直す' });
    expect(redo).toBeEnabled();
    // 押したときだけ、設定の操作（Windows の確認が出る）を呼ぶ
    expect(mock.count('setup_helper')).toBe(0);
    await user.click(redo);
    expect(mock.count('setup_helper')).toBe(1);
    // 設定の解除は、これまでどおり出ている
    expect(screen.getByRole('button', { name: '設定を解除する' })).toBeInTheDocument();
  });

  it('写しが同じ・比べられないときは、出ない', async () => {
    for (const outdated of [false, null, undefined]) {
      const mock = installTauriMock({ inputStatus: status({ installed: true, running: true, outdated }) });
      const view = render(<SettingsPage />);
      await screen.findByRole('status', { name: '補助プログラム' });
      expect(screen.queryByText(NOTICE)).toBeNull();
      expect(screen.queryByRole('button', { name: '設定し直す' })).toBeNull();
      expect(mock.count('setup_helper')).toBe(0);
      view.unmount();
    }
  });

  it('設定していない（写しが無い）ときは、出ない。いつもの「管理者の補助プログラムを設定する」だけ', async () => {
    await renderPage(status({ installed: false, running: false, outdated: true }, 'in_process'));
    expect(screen.queryByText(NOTICE)).toBeNull();
    expect(screen.queryByRole('button', { name: '設定し直す' })).toBeNull();
    expect(screen.getByRole('button', { name: '管理者の補助プログラムを設定する' })).toBeInTheDocument();
  });

  it('設定し直している間は、一言も出ない。写しが同じになったら（状態の変更）、消える', async () => {
    const mock = await renderPage(status({ installed: true, running: true, outdated: true }));
    expect(screen.getByText(NOTICE)).toBeInTheDocument();
    act(() => {
      mock.emit('input-status-changed', status({ installed: true, running: true, outdated: true, busy: 'installing' }));
    });
    expect(screen.queryByText(NOTICE)).toBeNull();
    expect(screen.getByRole('button', { name: '設定し直す' })).toBeDisabled();
    act(() => {
      mock.emit('input-status-changed', status({ installed: true, running: true, outdated: false }));
    });
    expect(screen.queryByText(NOTICE)).toBeNull();
    expect(screen.queryByRole('button', { name: '設定し直す' })).toBeNull();
  });
});
