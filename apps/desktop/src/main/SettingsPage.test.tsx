import { open } from '@tauri-apps/plugin-dialog';
import { act, fireEvent, render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { beforeEach, describe, expect, it, vi } from 'vitest';

import { baseSettings, baseState, installTauriMock, type TauriMock } from '../../tests/tauri-mock';
import type { Settings } from '../api/types';
import { SettingsPage } from './SettingsPage';

vi.mock('@tauri-apps/api/core', () => ({
  invoke: vi.fn(),
  convertFileSrc: (path: string) => path,
}));
vi.mock('@tauri-apps/api/event', () => ({ listen: vi.fn() }));
vi.mock('@tauri-apps/plugin-dialog', () => ({ open: vi.fn() }));

function savedSettings(mock: TauriMock): Settings[] {
  return mock
    .calls()
    .filter((c) => c.cmd === 'set_settings')
    .map((c) => (c.args as { settings: Settings }).settings);
}

async function renderPage(options: Parameters<typeof installTauriMock>[0] = {}) {
  const mock = installTauriMock(options);
  render(<SettingsPage />);
  await screen.findByRole('radio', { name: 'マウスの「戻る」ボタン' });
  return mock;
}

describe('設定ページ', () => {
  beforeEach(() => {
    vi.mocked(open).mockReset();
  });

  it('いまの設定を出す', async () => {
    await renderPage();
    expect(screen.getByRole('radio', { name: 'マウスの「戻る」ボタン' })).toBeChecked();
    expect(screen.getByRole('radio', { name: 'マウスの「進む」ボタン' })).not.toBeChecked();
    expect(screen.getByRole('radio', { name: '縦長' })).toBeChecked();
    expect(screen.getByRole('checkbox', { name: '迷いを記録したら音を鳴らす' })).toBeChecked();
    expect(screen.getByText(baseSettings.data_dir)).toBeInTheDocument();
    expect(screen.getByRole('textbox', { name: /雀魂の窓を探す語/ })).toHaveValue(
      '雀魂\nMahjong Soul',
    );
  });

  it('迷いマークのボタンを選ぶと、その場で保存する', async () => {
    const user = userEvent.setup();
    const mock = await renderPage();
    await user.click(screen.getByRole('radio', { name: 'マウスの「進む」ボタン' }));
    await waitFor(() => expect(savedSettings(mock)).toHaveLength(1));
    expect(savedSettings(mock)[0]?.trigger).toEqual({ kind: 'mouse_x2' });
    expect(await screen.findByText('保存しました')).toBeInTheDocument();
    await user.click(screen.getByRole('radio', { name: 'マウスの中ボタン' }));
    await waitFor(() => expect(savedSettings(mock)).toHaveLength(2));
    expect(savedSettings(mock)[1]?.trigger).toEqual({ kind: 'mouse_middle' });
  });

  it('ウィジェットの形を選ぶと、その場で保存する', async () => {
    const user = userEvent.setup();
    const mock = await renderPage();
    await user.click(screen.getByRole('radio', { name: '横長' }));
    await waitFor(() => expect(savedSettings(mock)).toHaveLength(1));
    expect(savedSettings(mock)[0]?.orientation).toBe('horizontal');
  });

  it('音のオンとオフを保存する', async () => {
    const user = userEvent.setup();
    const mock = await renderPage();
    await user.click(screen.getByRole('checkbox', { name: '迷いを記録したら音を鳴らす' }));
    await waitFor(() => expect(savedSettings(mock)).toHaveLength(1));
    expect(savedSettings(mock)[0]?.sound).toBe(false);
  });

  it('窓を探す語は、入力を終えたとき（フォーカスが外れたとき）に保存する。空行は捨てる', async () => {
    const user = userEvent.setup();
    const mock = await renderPage();
    const box = screen.getByRole('textbox', { name: /雀魂の窓を探す語/ });
    await user.clear(box);
    await user.type(box, '  雀魂  {Enter}{Enter}Majsoul client');
    expect(savedSettings(mock)).toHaveLength(0);
    await user.tab();
    await waitFor(() => expect(savedSettings(mock)).toHaveLength(1));
    expect(savedSettings(mock)[0]?.capture_keywords).toEqual(['雀魂', 'Majsoul client']);
  });

  it('変えていない語ではフォーカスが外れても保存しない', async () => {
    const user = userEvent.setup();
    const mock = await renderPage();
    const box = screen.getByRole('textbox', { name: /雀魂の窓を探す語/ });
    await user.click(box);
    await user.tab();
    expect(savedSettings(mock)).toHaveLength(0);
  });

  it('キーボードのキーを選び、押したキーを割り当てる。キーを押すまでは割り当てを変えない', async () => {
    const user = userEvent.setup();
    const mock = await renderPage();
    await user.click(screen.getByRole('radio', { name: 'キーボードのキー' }));
    expect(await screen.findByText('キーを押してください（Esc でやめる）')).toBeInTheDocument();
    expect(savedSettings(mock)).toHaveLength(0);
    act(() => {
      fireEvent.keyDown(window, { code: 'F8', key: 'F8' });
    });
    await waitFor(() => expect(savedSettings(mock)).toHaveLength(1));
    expect(savedSettings(mock)[0]?.trigger).toEqual({ kind: 'key', code: 'F8' });
  });

  it('Esc でキーの割り当てをやめられる', async () => {
    const user = userEvent.setup();
    const mock = await renderPage();
    await user.click(screen.getByRole('radio', { name: 'キーボードのキー' }));
    await screen.findByText('キーを押してください（Esc でやめる）');
    act(() => {
      fireEvent.keyDown(window, { code: 'Escape', key: 'Escape' });
    });
    await waitFor(() =>
      expect(screen.queryByText('キーを押してください（Esc でやめる）')).toBeNull(),
    );
    expect(savedSettings(mock)).toHaveLength(0);
  });

  it('割り当てられないキーは、理由を出して元のままにする', async () => {
    const user = userEvent.setup();
    await renderPage({
      handlers: {
        set_settings: () => {
          throw 'このキーは割り当てられません: Enter';
        },
      },
    });
    await user.click(screen.getByRole('radio', { name: 'キーボードのキー' }));
    await screen.findByText('キーを押してください（Esc でやめる）');
    act(() => {
      fireEvent.keyDown(window, { code: 'Enter', key: 'Enter' });
    });
    expect(await screen.findByRole('alert')).toHaveTextContent('このキーは割り当てられません: Enter');
  });

  it('保存先を選ぶと保存する。リポジトリの中なら理由を出して、表示は元のまま（D-1）', async () => {
    const user = userEvent.setup();
    vi.mocked(open).mockResolvedValue('C:\\work\\repo\\data');
    const mock = await renderPage({
      handlers: {
        set_settings: () => {
          throw '保存先がリポジトリの中です: C:\\work\\repo\\data（C:\\work\\repo の下）。リポジトリの外のフォルダを指定してください。';
        },
      },
    });
    await user.click(screen.getByRole('button', { name: 'フォルダを選ぶ' }));
    await waitFor(() => expect(savedSettings(mock)).toHaveLength(1));
    expect(savedSettings(mock)[0]?.data_dir).toBe('C:\\work\\repo\\data');
    expect(await screen.findByRole('alert')).toHaveTextContent('リポジトリの中です');
    expect(screen.getByText(baseSettings.data_dir)).toBeInTheDocument();
  });

  it('保存先を選ぶのをやめたら、何も保存しない', async () => {
    const user = userEvent.setup();
    vi.mocked(open).mockResolvedValue(null);
    const mock = await renderPage();
    await user.click(screen.getByRole('button', { name: 'フォルダを選ぶ' }));
    await waitFor(() => expect(open).toHaveBeenCalledTimes(1));
    expect(savedSettings(mock)).toHaveLength(0);
  });

  it('保存先を開けないときは、その理由を保存先の欄に出す', async () => {
    await renderPage({
      state: {
        ...baseState,
        status: 'error',
        session_id: null,
        error: String.raw`保存先がリポジトリの中です: C:\work\repo\data`,
      },
    });
    expect(await screen.findByRole('alert')).toHaveTextContent('保存先がリポジトリの中です');
  });

  it('起動時の知らせ（壊れた設定ファイルの退避）を出す', async () => {
    await renderPage({ startupNote: '設定ファイルを読めなかったため既定値で始めます。' });
    const note = await screen.findByText('設定ファイルを読めなかったため既定値で始めます。');
    expect(note).toHaveAttribute('role', 'status');
  });

  it('別の窓（ウィジェットの右クリック）で形を変えたら、ここにも反映する', async () => {
    const mock = await renderPage();
    act(() => {
      mock.emit('settings-changed', { ...baseSettings, orientation: 'horizontal' } satisfies Settings);
    });
    await waitFor(() => expect(screen.getByRole('radio', { name: '横長' })).toBeChecked());
  });
});
