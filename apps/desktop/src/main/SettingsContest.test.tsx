/**
 * 設定ページの「拮抗の場面」（F17。ACCEPTANCE の U-42 の設定側・E-47）の画面の試験。
 * 差の値と条件の入切・巡目を変えると、その場で保存される（保存した設定で、通して見る画面と今日の出題の場面の数が変わることは、
 * Replay の試験（ReplayResolve.test.tsx）が確かめる）。
 */
import { act, render, screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { describe, expect, it, vi } from 'vitest';

import { baseSettings, installTauriMock, type TauriMock } from '../../tests/tauri-mock';
import type { Settings } from '../api/types';
import { SettingsPage } from './SettingsPage';

vi.mock('@tauri-apps/api/core', () => ({
  invoke: vi.fn(),
  convertFileSrc: (path: string) => path,
}));
vi.mock('@tauri-apps/api/event', () => ({ listen: vi.fn() }));
vi.mock('@tauri-apps/plugin-dialog', () => ({ open: vi.fn(), save: vi.fn() }));

/** 試験の見本は拮抗を切にしているので、アプリの既定（入）を重ねる。 */
const DEFAULTS: Settings = { ...baseSettings, contest_enabled: true };

function savedSettings(mock: TauriMock): Settings[] {
  return mock
    .calls()
    .filter((c) => c.cmd === 'set_settings')
    .map((c) => (c.args as { settings: Settings }).settings);
}

async function renderPage(settings: Settings = DEFAULTS) {
  const mock = installTauriMock({ settings });
  render(<SettingsPage />);
  await screen.findByRole('button', { name: 'ボタンを登録' });
  return mock;
}

const section = () => screen.getByRole('group', { name: '拮抗の場面' });
const enabledBox = () => screen.getByRole('checkbox', { name: '拮抗の場面を出す' });
const gapBox = () => screen.getByRole('spinbutton', { name: '1位と2位の差（ポイント）' });
const junmeBox = () => screen.getByRole('spinbutton', { name: '何巡目以降か' });
const junmeCheck = (n = 12) => screen.getByRole('checkbox', { name: `${n}巡目以降` });
const riichiCheck = () => screen.getByRole('checkbox', { name: '他家のリーチのあと' });
const callsCheck = () => screen.getByRole('checkbox', { name: '他家に2副露以上の人がいる' });

describe('F17 設定ページの「拮抗の場面」', () => {
  it('既定: 拮抗の場面を出す（入）・差 20 ポイント・12巡目以降・他家のリーチのあと・他家に2副露以上の人がいる（どれも入）。説明の文がある', async () => {
    await renderPage();
    expect(enabledBox()).toBeChecked();
    expect(gapBox()).toHaveValue(20);
    expect(junmeCheck()).toBeChecked();
    expect(junmeBox()).toHaveValue(12);
    expect(riichiCheck()).toBeChecked();
    expect(callsCheck()).toBeChecked();
    expect(
      screen.getByText(
        'AI の1位と2位の確率の差が小さい、局の終盤の判断を、通して見る画面と今日の出題に出します。条件はどれか1つに当たれば出します。',
      ),
    ).toBeInTheDocument();
    expect(enabledBox()).toHaveAccessibleDescription(/条件はどれか1つに当たれば出します/);
    // 拮抗の欄は、ほかの欄のあとにある（迷いだけを記録する、のチェックは、そのまま先頭のほうにある）
    const all = [...document.querySelectorAll('.settings > .setting')];
    expect(all[all.length - 1]).toBe(section());
    expect(screen.getByRole('checkbox', { name: '迷いだけを記録する' })).toBeInTheDocument();
    expect(within(section()).queryByRole('checkbox', { name: '迷いだけを記録する' })).toBeNull();
  });

  it('「拮抗の場面を出す」を切ると、差と条件の欄は押せなくなる（値は残る）。入れると、また押せる。そのつど保存する', async () => {
    const user = userEvent.setup();
    const mock = await renderPage();
    await user.click(enabledBox());
    await waitFor(() => expect(savedSettings(mock)).toHaveLength(1));
    expect(savedSettings(mock)[0]).toMatchObject({ contest_enabled: false, contest_gap_percent: 20, contest_min_junme: 12 });
    expect(enabledBox()).not.toBeChecked();
    expect(enabledBox()).toBeEnabled();
    for (const control of [gapBox(), junmeBox(), junmeCheck(), riichiCheck(), callsCheck()]) expect(control).toBeDisabled();
    expect(gapBox()).toHaveValue(20);
    expect(junmeCheck()).toBeChecked();
    await user.click(enabledBox());
    await waitFor(() => expect(savedSettings(mock)).toHaveLength(2));
    expect(savedSettings(mock)[1]?.contest_enabled).toBe(true);
    for (const control of [gapBox(), junmeBox(), junmeCheck(), riichiCheck(), callsCheck()]) expect(control).toBeEnabled();
  });

  it('差は、入力を終えたとき（フォーカスが外れたとき・Enter）に 1〜100 の整数で保存する。外れた値は、理由を出して元に戻す', async () => {
    const user = userEvent.setup();
    const mock = await renderPage();
    await user.click(gapBox());
    await user.tab();
    expect(savedSettings(mock)).toHaveLength(0);
    await user.clear(gapBox());
    await user.type(gapBox(), '35');
    expect(savedSettings(mock)).toHaveLength(0);
    await user.type(gapBox(), '{Enter}');
    await waitFor(() => expect(savedSettings(mock)).toHaveLength(1));
    expect(savedSettings(mock)[0]).toMatchObject({ contest_gap_percent: 35, contest_min_junme: 12, contest_enabled: true });
    expect(await screen.findByText('保存しました')).toBeInTheDocument();
    for (const bad of ['0', '101', '2.5', '']) {
      await user.clear(gapBox());
      if (bad !== '') await user.type(gapBox(), bad);
      await user.tab();
      expect(await screen.findByRole('alert')).toHaveTextContent('拮抗の差は 1ポイント から 100ポイント の間の整数で指定してください');
      expect(gapBox()).toHaveValue(35);
    }
    expect(savedSettings(mock)).toHaveLength(1);
    // 範囲の端は通る
    await user.clear(gapBox());
    await user.type(gapBox(), '100');
    await user.tab();
    await waitFor(() => expect(savedSettings(mock)).toHaveLength(2));
    expect(savedSettings(mock)[1]?.contest_gap_percent).toBe(100);
  });

  it('「N巡目以降」: チェックの文字は、入れた巡目（例: 9巡目以降）。巡目は 1〜24 の整数で保存し、外れた値は理由を出して戻す', async () => {
    const user = userEvent.setup();
    const mock = await renderPage();
    await user.clear(junmeBox());
    await user.type(junmeBox(), '9');
    await user.tab();
    await waitFor(() => expect(savedSettings(mock)).toHaveLength(1));
    expect(savedSettings(mock)[0]).toMatchObject({ contest_min_junme: 9, contest_by_junme: true, contest_gap_percent: 20 });
    expect(junmeCheck(9)).toBeChecked();
    expect(screen.queryByRole('checkbox', { name: '12巡目以降' })).toBeNull();
    for (const bad of ['0', '25', '']) {
      await user.clear(junmeBox());
      if (bad !== '') await user.type(junmeBox(), bad);
      await user.tab();
      expect(await screen.findByRole('alert')).toHaveTextContent('拮抗の巡目は 1巡目 から 24巡目 の間の整数で指定してください');
      expect(junmeBox()).toHaveValue(9);
    }
    expect(savedSettings(mock)).toHaveLength(1);
    // チェックを外すと、巡目の条件は使わない（巡目の値は残る）
    await user.click(junmeCheck(9));
    await waitFor(() => expect(savedSettings(mock)).toHaveLength(2));
    expect(savedSettings(mock)[1]).toMatchObject({ contest_by_junme: false, contest_min_junme: 9 });
    expect(junmeCheck(9)).not.toBeChecked();
  });

  it('他家のリーチのあと・他家に2副露以上の人がいる: チェックで、その場で保存する。ほかの設定はそのまま', async () => {
    const user = userEvent.setup();
    const mock = await renderPage();
    await user.click(riichiCheck());
    await waitFor(() => expect(savedSettings(mock)).toHaveLength(1));
    expect(savedSettings(mock)[0]).toMatchObject({
      contest_after_riichi: false,
      contest_two_calls: true,
      contest_by_junme: true,
      contest_gap_percent: 20,
      show_all_mismatches: false,
      replay_keys: baseSettings.replay_keys,
    });
    await user.click(callsCheck());
    await waitFor(() => expect(savedSettings(mock)).toHaveLength(2));
    expect(savedSettings(mock)[1]).toMatchObject({ contest_after_riichi: false, contest_two_calls: false });
    expect(riichiCheck()).not.toBeChecked();
    expect(callsCheck()).not.toBeChecked();
  });

  it('別の窓の変更（settings-changed）も、ここに反映する', async () => {
    const mock = await renderPage();
    act(() => {
      mock.emit('settings-changed', {
        ...DEFAULTS,
        contest_enabled: false,
        contest_gap_percent: 45,
        contest_min_junme: 8,
        contest_after_riichi: false,
      } satisfies Settings);
    });
    await waitFor(() => expect(gapBox()).toHaveValue(45));
    expect(enabledBox()).not.toBeChecked();
    expect(junmeBox()).toHaveValue(8);
    expect(junmeCheck(8)).toBeDisabled();
    expect(riichiCheck()).not.toBeChecked();
  });
});
