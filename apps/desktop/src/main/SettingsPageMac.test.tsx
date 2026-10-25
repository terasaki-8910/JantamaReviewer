/**
 * macOS の段階 2 の設定ページ: ウィジェット・迷いマークのボタン・画面の撮影・管理者の補助プログラムが無いので、その行は出さず、
 * 「まだ使えません」と書く。保存先・記録・出題の設定は、Windows と同じ。
 */
import { render, screen } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';

import { baseInputStatus, installTauriMock } from '../../tests/tauri-mock';
import { MAC_STAGE_2_PLATFORM, setPlatform, WINDOWS_PLATFORM } from '../shared/platform';
import { SettingsPage } from './SettingsPage';

vi.mock('@tauri-apps/api/core', () => ({
  invoke: vi.fn(),
  convertFileSrc: (path: string) => path,
}));
vi.mock('@tauri-apps/api/event', () => ({ listen: vi.fn() }));
vi.mock('@tauri-apps/plugin-dialog', () => ({ open: vi.fn(), save: vi.fn() }));

afterEach(() => setPlatform(WINDOWS_PLATFORM));

const NOT_YET =
  'Mac ではまだ使えません。ウィジェット・迷いマークのボタン・画面の撮影は、Mac 版の次の段階で対応します。';

describe('macOS（段階 2）の設定ページ', () => {
  it('Windows にだけある行（ボタンの登録・補助プログラム・ウィジェットの形・音・窓を探す語）を出さず、「まだ使えません」と書く', async () => {
    setPlatform(MAC_STAGE_2_PLATFORM);
    installTauriMock({
      inputStatus: { ...baseInputStatus, helper: { ...baseInputStatus.helper, installed: false } },
    });
    render(<SettingsPage />);
    // 保存先の行が出たら、描き終わっている
    await screen.findByText('データの保存先');
    expect(screen.getByRole('group', { name: '迷いマークのボタン' })).toHaveTextContent(NOT_YET);
    for (const gone of [
      screen.queryByRole('button', { name: 'ボタンを登録' }),
      screen.queryByText('補助プログラム'),
      screen.queryByRole('button', { name: '管理者の補助プログラムを設定する' }),
      screen.queryByText('テスト'),
      screen.queryByRole('group', { name: 'ウィジェットの形' }),
      screen.queryByRole('checkbox', { name: '迷いを記録したら音を鳴らす' }),
      screen.queryByLabelText('雀魂の窓を探す語（1行に1つ）'),
    ]) {
      expect(gone).toBeNull();
    }
    // 検討画面の設定は、そのまま使える
    expect(screen.getByRole('button', { name: 'フォルダを選ぶ' })).toBeInTheDocument();
    expect(screen.getByLabelText('1日に出す数')).toBeInTheDocument();
    expect(screen.getByRole('checkbox', { name: 'AI の1位と違う判断も、飛び先に入れる' })).toBeInTheDocument();
    expect(screen.getByRole('checkbox', { name: 'ドラを目立たせる' })).toBeInTheDocument();
  });

  it('「迷いだけを記録する」は、ウィジェットの無い Mac でも出す（半荘・週の集計の画面の部品の出し入れも決めるため）', async () => {
    setPlatform(MAC_STAGE_2_PLATFORM);
    installTauriMock();
    render(<SettingsPage />);
    await screen.findByText('データの保存先');
    expect(screen.getByRole('checkbox', { name: '迷いだけを記録する' })).toBeInTheDocument();
    // ウィジェットの形は Mac には無い（迷いだけを切っても出さない）
    expect(screen.queryByRole('group', { name: 'ウィジェットの形' })).toBeNull();
  });

  it('Windows では、これまでどおり全部の行が出る（「まだ使えません」は出ない）', async () => {
    installTauriMock();
    render(<SettingsPage />);
    expect(await screen.findByRole('button', { name: 'ボタンを登録' })).toBeInTheDocument();
    expect(screen.getByRole('group', { name: 'ウィジェットの形' })).toBeInTheDocument();
    expect(screen.getByRole('checkbox', { name: '迷いを記録したら音を鳴らす' })).toBeInTheDocument();
    expect(screen.getByLabelText('雀魂の窓を探す語（1行に1つ）')).toBeInTheDocument();
    expect(screen.queryByText(NOT_YET)).toBeNull();
  });
});
