import { act, fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { beforeEach, describe, expect, it, vi } from 'vitest';

import { FakeSessionStore } from '../../../tests/fake-sessions';
import { baseSettings, baseState, installTauriMock, type TauriMock } from '../../../tests/tauri-mock';
import type { AppState, Settings } from '../../api/types';
import type { UpdateCheck, UpdateInfo } from '../../api/update';
import { WidgetApp } from '../../widget/WidgetApp';
import { App } from '../App';

vi.mock('@tauri-apps/api/core', () => ({
  invoke: vi.fn(),
  convertFileSrc: (path: string) => path,
}));
vi.mock('@tauri-apps/api/event', () => ({ listen: vi.fn() }));
vi.mock('@tauri-apps/plugin-dialog', () => ({ open: vi.fn(), save: vi.fn() }));

const REGION = 'アプリの更新';
const CURRENT = '0.2.0';

const INFO: UpdateInfo = { current_version: CURRENT, configured: true };

function available(version: string): UpdateCheck {
  return { current_version: CURRENT, kind: 'available', version, notes: null, date: null };
}

const UP_TO_DATE: UpdateCheck = { current_version: CURRENT, kind: 'up_to_date' };

interface Scenario {
  /** `get_update_info` の答え。 */
  info?: UpdateInfo | null;
  /** `check_update` の答え（関数なら、呼ぶたびに）。 */
  check?: UpdateCheck | ((call: number) => UpdateCheck | Promise<UpdateCheck>);
  /** 記録の状態（ウィジェットが半荘を記録している間は 'recording'）。 */
  status?: AppState['status'];
  /** 設定に覚えてある、飛ばした版。 */
  skipped?: string | null;
  /** `install_update` の答え。投げれば、失敗。 */
  install?: () => unknown;
  /** `skip_update_version` の答え。投げれば、失敗。 */
  skip?: (version: string) => unknown;
}

/** Tauri の偽物。更新の層（check_update ・ install_update など）も、ここで差し替える（本物の通信はしない）。 */
function setup(scenario: Scenario = {}): TauriMock {
  const settings: Settings = { ...baseSettings, skipped_update_version: scenario.skipped ?? null };
  let checkCalls = 0;
  return installTauriMock({
    state: { ...baseState, status: scenario.status ?? 'idle' },
    settings,
    handlers: {
      ...new FakeSessionStore([]).handlers,
      get_update_info: () => (scenario.info === undefined ? INFO : scenario.info),
      check_update: () => {
        checkCalls += 1;
        const check = scenario.check ?? available('0.2.1');
        return typeof check === 'function' ? check(checkCalls) : check;
      },
      install_update: () => scenario.install?.(),
      skip_update_version: (args) => {
        const { version } = args as { version: string };
        if (scenario.skip) return scenario.skip(version);
        return { ...settings, skipped_update_version: version };
      },
    },
  });
}

async function banner() {
  return screen.findByRole('region', { name: REGION });
}

/** 起動のときの確かめが済むまで待ってから、画面が落ち着くのを待つ。 */
async function settle(mock: TauriMock, checks = 1) {
  await waitFor(() => expect(mock.count('check_update')).toBe(checks));
  await act(async () => {
    await new Promise((resolve) => setTimeout(resolve, 20));
  });
}

function recordingNow(mock: TauriMock, status: AppState['status']) {
  act(() => {
    mock.emit('state-changed', { ...baseState, status } satisfies AppState);
  });
}

beforeEach(() => {
  vi.useRealTimers();
});

describe('更新の帯（U-51）', () => {
  it('新しい版が見つかると、検討画面の上に「新しい版 0.2.1 があります」と 3 つのボタンが出る', async () => {
    setup();
    render(<App />);
    const region = await banner();
    expect(within(region).getByText('新しい版 0.2.1 があります')).toBeInTheDocument();
    const install = within(region).getByRole('button', { name: '今すぐ入れ直す' });
    expect(install).toBeEnabled();
    expect(install).toHaveClass('primary');
    expect(within(region).getByRole('button', { name: 'あとで' })).toBeEnabled();
    expect(within(region).getByRole('button', { name: 'この版は飛ばす' })).toBeEnabled();
    // 本文の上（見出しのページの前）に置く。取り込みの誘いと同じ並び
    const main = screen.getByRole('main');
    expect(main.contains(region)).toBe(true);
    expect(region.compareDocumentPosition(screen.getByRole('heading', { level: 1, name: '半荘がありません' })) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy();
  });

  it('領域に名前が付き、ボタンは Tab で順に届く（キーボードで操作できる）', async () => {
    const user = userEvent.setup();
    const mock = setup();
    render(<App />);
    const region = await banner();
    expect(region.tagName).toBe('SECTION');
    const install = within(region).getByRole('button', { name: '今すぐ入れ直す' });
    install.focus();
    await user.tab();
    expect(within(region).getByRole('button', { name: 'あとで' })).toHaveFocus();
    await user.tab();
    expect(within(region).getByRole('button', { name: 'この版は飛ばす' })).toHaveFocus();
    // Enter でも押せる（押すまでは、ダウンロードも入れ直しもしない）
    expect(mock.count('install_update')).toBe(0);
    install.focus();
    await user.keyboard('{Enter}');
    await waitFor(() => expect(mock.count('install_update')).toBe(1));
  });

  it('起動のとき、確かめるのは 1 回だけ。確かめる前は、帯が無い', async () => {
    const mock = setup();
    render(<App />);
    expect(screen.queryByRole('region', { name: REGION })).toBeNull();
    await banner();
    expect(mock.count('get_update_info')).toBe(1);
    await settle(mock);
    expect(mock.count('check_update')).toBe(1);
  });

  it('今の版と同じか古い版・最新のときは出ない', async () => {
    for (const check of [UP_TO_DATE, available('0.2.0'), available('v0.2.0'), available('0.1.9')]) {
      const mock = setup({ check });
      const { unmount } = render(<App />);
      await settle(mock);
      expect(screen.queryByRole('region', { name: REGION })).toBeNull();
      unmount();
    }
  });

  it('飛ばした版と同じ版では出ない。飛ばした版より新しい版では出る', async () => {
    const same = setup({ skipped: '0.2.1' });
    const first = render(<App />);
    await settle(same);
    expect(screen.queryByRole('region', { name: REGION })).toBeNull();
    first.unmount();

    setup({ skipped: '0.2.1', check: available('0.2.2') });
    render(<App />);
    expect(within(await banner()).getByText('新しい版 0.2.2 があります')).toBeInTheDocument();
  });

  it('版は semver で比べる（0.10.0 は 0.9.0 より新しい）', async () => {
    setup({ info: { current_version: '0.9.0', configured: true }, check: { ...available('0.10.0'), current_version: '0.9.0' } });
    render(<App />);
    expect(within(await banner()).getByText('新しい版 0.10.0 があります')).toBeInTheDocument();
  });

  it('「あとで」で帯が消え、起動し直す（作り直す）まで出ない', async () => {
    const user = userEvent.setup();
    const mock = setup();
    const first = render(<App />);
    await user.click(within(await banner()).getByRole('button', { name: 'あとで' }));
    expect(screen.queryByRole('region', { name: REGION })).toBeNull();
    expect(mock.count('install_update')).toBe(0);
    expect(mock.count('skip_update_version')).toBe(0);
    // 同じ起動の間は、画面を移っても出ない
    await user.click(screen.getByRole('button', { name: '設定' }));
    await screen.findByRole('heading', { level: 1, name: '設定' });
    await user.click(screen.getByRole('button', { name: '週の集計' }));
    await screen.findByRole('heading', { level: 1, name: '週の集計' });
    expect(screen.queryByRole('region', { name: REGION })).toBeNull();
    first.unmount();
    // 起動し直すと、また出る（覚えていない）
    const again = setup();
    render(<App />);
    expect(await banner()).toBeInTheDocument();
    expect(again.count('skip_update_version')).toBe(0);
  });

  it('「この版は飛ばす」で消え、設定に覚える（保存の命令が 1 回）。同じ版では出ず、もっと新しい版では出る', async () => {
    const user = userEvent.setup();
    const mock = setup();
    const first = render(<App />);
    await user.click(within(await banner()).getByRole('button', { name: 'この版は飛ばす' }));
    await waitFor(() => expect(screen.queryByRole('region', { name: REGION })).toBeNull());
    const saved = mock.calls().filter((call) => call.cmd === 'skip_update_version');
    expect(saved).toHaveLength(1);
    expect(saved[0]?.args).toEqual({ version: '0.2.1' });
    expect(mock.count('install_update')).toBe(0);
    first.unmount();

    // 次の起動: 設定に覚えてある → 同じ版では出ない
    const sameVersion = setup({ skipped: '0.2.1' });
    const second = render(<App />);
    await settle(sameVersion);
    expect(screen.queryByRole('region', { name: REGION })).toBeNull();
    second.unmount();
    // もっと新しい版では、また出る
    setup({ skipped: '0.2.1', check: available('0.3.0') });
    render(<App />);
    expect(within(await banner()).getByText('新しい版 0.3.0 があります')).toBeInTheDocument();
  });

  it('飛ばす設定を保存できなかったら、理由を出して、帯は残す', async () => {
    const user = userEvent.setup();
    setup({
      skip: () => {
        throw '設定を保存できませんでした: 書き込めません';
      },
    });
    render(<App />);
    const region = await banner();
    await user.click(within(region).getByRole('button', { name: 'この版は飛ばす' }));
    expect(await within(region).findByRole('alert')).toHaveTextContent('設定を保存できませんでした: 書き込めません');
    expect(screen.getByRole('region', { name: REGION })).toBeInTheDocument();
  });

  it('「今すぐ入れ直す」を押すまで、入れ直しは呼ばない。押したときだけ、1 回呼ぶ', async () => {
    const user = userEvent.setup();
    const mock = setup({ install: () => new Promise(() => {}) });
    render(<App />);
    const region = await banner();
    await settle(mock);
    expect(mock.count('install_update')).toBe(0);
    await user.click(within(region).getByRole('button', { name: '今すぐ入れ直す' }));
    await waitFor(() => expect(mock.count('install_update')).toBe(1));
    // 入れている間は、文が替わり、ボタンは押せない（重ねて呼ばない）
    expect(await within(region).findByText('新しい版を入れています…')).toBeInTheDocument();
    for (const name of ['今すぐ入れ直す', 'あとで', 'この版は飛ばす']) {
      expect(within(region).getByRole('button', { name })).toBeDisabled();
    }
    await act(async () => {
      await new Promise((resolve) => setTimeout(resolve, 20));
    });
    expect(mock.count('install_update')).toBe(1);
  });

  it('入れ直しに失敗したら、理由を出して、もう一度押せる', async () => {
    const user = userEvent.setup();
    let failing = true;
    const mock = setup({
      install: () => {
        if (failing) throw '更新の署名を確かめられませんでした。安全のため、入れ直しを中止しました';
        return undefined;
      },
    });
    render(<App />);
    const region = await banner();
    await user.click(within(region).getByRole('button', { name: '今すぐ入れ直す' }));
    expect(await within(region).findByRole('alert')).toHaveTextContent(
      '入れ直せませんでした: 更新の署名を確かめられませんでした。安全のため、入れ直しを中止しました',
    );
    expect(within(region).getByRole('button', { name: '今すぐ入れ直す' })).toBeEnabled();
    failing = false;
    await user.click(within(region).getByRole('button', { name: '今すぐ入れ直す' }));
    await waitFor(() => expect(mock.count('install_update')).toBe(2));
  });

  it('記録中は「今すぐ入れ直す」を押せず、理由が出る。記録が終わると押せる（確かめるのは、起動のときの 1 回のまま）', async () => {
    const user = userEvent.setup();
    const mock = setup();
    render(<App />);
    const region = await banner();
    recordingNow(mock, 'recording');
    const install = await within(region).findByRole('button', { name: '今すぐ入れ直す' });
    await waitFor(() => expect(install).toBeDisabled());
    expect(within(region).getByText('記録中は入れ直せません（対局のあとで）')).toBeInTheDocument();
    expect(install).toHaveAccessibleDescription('記録中は入れ直せません（対局のあとで）');
    // 「あとで」「この版は飛ばす」は、記録中でも押せる
    expect(within(region).getByRole('button', { name: 'あとで' })).toBeEnabled();
    await user.click(install);
    expect(mock.count('install_update')).toBe(0);
    recordingNow(mock, 'idle');
    await waitFor(() => expect(within(region).getByRole('button', { name: '今すぐ入れ直す' })).toBeEnabled());
    expect(within(region).queryByText('記録中は入れ直せません（対局のあとで）')).toBeNull();
    expect(mock.count('check_update')).toBe(1);
  });

  it('記録中の起動では、確かめない（通信しない）', async () => {
    const mock = setup({ status: 'recording' });
    render(<App />);
    await waitFor(() => expect(mock.count('get_update_info')).toBe(1));
    await waitFor(() => expect(mock.count('get_state')).toBeGreaterThan(0));
    await act(async () => {
      await new Promise((resolve) => setTimeout(resolve, 30));
    });
    expect(mock.count('check_update')).toBe(0);
    expect(screen.queryByRole('region', { name: REGION })).toBeNull();
  });

  it('更新の仕組みが設定されていなければ、確かめない', async () => {
    const mock = setup({ info: { current_version: CURRENT, configured: false } });
    render(<App />);
    await waitFor(() => expect(mock.count('get_update_info')).toBe(1));
    await act(async () => {
      await new Promise((resolve) => setTimeout(resolve, 30));
    });
    expect(mock.count('check_update')).toBe(0);
    expect(screen.queryByRole('region', { name: REGION })).toBeNull();
  });

  it('起動のときの確かめが失敗しても、何も出さない（画面も止めない）', async () => {
    for (const check of [
      { current_version: CURRENT, kind: 'failed', message: '通信できませんでした' } satisfies UpdateCheck,
      () => {
        throw '通信できませんでした';
      },
    ]) {
      const mock = setup({ check });
      const { unmount } = render(<App />);
      await settle(mock);
      expect(screen.queryByRole('region', { name: REGION })).toBeNull();
      expect(screen.queryByRole('alert')).toBeNull();
      expect(screen.getByRole('heading', { level: 1, name: '半荘がありません' })).toBeInTheDocument();
      unmount();
    }
  });

  it('更新の層が答えを返さなくても（読めない答え）、落ちない', async () => {
    const mock = setup({ info: null });
    render(<App />);
    await waitFor(() => expect(mock.count('get_update_info')).toBe(1));
    await act(async () => {
      await new Promise((resolve) => setTimeout(resolve, 20));
    });
    expect(mock.count('check_update')).toBe(0);
    expect(await screen.findByRole('heading', { level: 1, name: '半荘がありません' })).toBeInTheDocument();
  });

  it('設定のページには帯を出さない（同じ案内を「更新」の欄が出す）。ほかのページには出る', async () => {
    const user = userEvent.setup();
    setup();
    render(<App />);
    await banner();
    await user.click(screen.getByRole('button', { name: '設定' }));
    await screen.findByRole('heading', { level: 1, name: '設定' });
    expect(screen.queryByRole('region', { name: REGION })).toBeNull();
    await user.click(screen.getByRole('button', { name: '週の集計' }));
    await screen.findByRole('heading', { level: 1, name: '週の集計' });
    expect(screen.getByRole('region', { name: REGION })).toBeInTheDocument();
  });

  it('書きかけのメモの欄にキーボードの位置があっても、入れ直しの前に欄から外れる（欄が、打った分を先に保存する）', async () => {
    const mock = setup({ install: () => new Promise(() => {}) });
    render(<App />);
    const region = await banner();
    const field = document.createElement('input');
    document.body.appendChild(field);
    field.focus();
    const lostFocus = vi.fn(() => expect(mock.count('install_update')).toBe(0));
    field.addEventListener('blur', lostFocus);
    expect(field).toHaveFocus();
    // マウスの押下のようにキーボードの位置を動かさずに押しても、入れ直しの命令より先に、欄から外れる
    fireEvent.click(within(region).getByRole('button', { name: '今すぐ入れ直す' }));
    await waitFor(() => expect(mock.count('install_update')).toBe(1));
    expect(lostFocus).toHaveBeenCalledTimes(1);
    field.remove();
  });
});

describe('設定の「更新」の欄（U-51）', () => {
  async function openSettings(user: ReturnType<typeof userEvent.setup>) {
    await user.click(screen.getByRole('button', { name: '設定' }));
    await screen.findByRole('heading', { level: 1, name: '設定' });
    return screen.findByRole('group', { name: '更新' });
  }

  it('今の版と「更新を確かめる」がある。確かめる前は、確かめていないと分かる', async () => {
    const user = userEvent.setup();
    setup({ status: 'recording', check: UP_TO_DATE });
    render(<App />);
    const group = await openSettings(user);
    expect(within(group).getByText('今の版')).toBeInTheDocument();
    expect(within(group).getByText(CURRENT)).toBeInTheDocument();
    expect(within(group).getByRole('button', { name: '更新を確かめる' })).toBeEnabled();
    expect(within(group).getByText('まだ確かめていません')).toBeInTheDocument();
  });

  it('押すと確かめて、「最新です」が出る', async () => {
    const user = userEvent.setup();
    const mock = setup({ status: 'recording', check: UP_TO_DATE });
    render(<App />);
    const group = await openSettings(user);
    await user.click(within(group).getByRole('button', { name: '更新を確かめる' }));
    expect(await within(group).findByText('最新です')).toBeInTheDocument();
    expect(mock.count('check_update')).toBe(1);
    expect(screen.queryByRole('region', { name: REGION })).toBeNull();
  });

  it('新しい版があれば、「新しい版 0.2.1 があります」と 3 つの操作が出る。「今すぐ入れ直す」だけが入れ直しを呼ぶ', async () => {
    const user = userEvent.setup();
    const mock = setup({ status: 'idle', check: available('0.2.1'), install: () => new Promise(() => {}) });
    render(<App />);
    const group = await openSettings(user);
    await user.click(within(group).getByRole('button', { name: '更新を確かめる' }));
    expect(await within(group).findByText('新しい版 0.2.1 があります')).toBeInTheDocument();
    expect(within(group).getByRole('button', { name: 'あとで' })).toBeEnabled();
    expect(within(group).getByRole('button', { name: 'この版は飛ばす' })).toBeEnabled();
    expect(mock.count('install_update')).toBe(0);
    await user.click(within(group).getByRole('button', { name: '今すぐ入れ直す' }));
    await waitFor(() => expect(mock.count('install_update')).toBe(1));
    expect(await within(group).findByText('新しい版を入れています…')).toBeInTheDocument();
    expect(within(group).getByRole('button', { name: '更新を確かめる' })).toBeDisabled();
  });

  it('記録中は「今すぐ入れ直す」が押せず、理由が出る', async () => {
    const user = userEvent.setup();
    const mock = setup({ status: 'recording', check: available('0.2.1') });
    render(<App />);
    const group = await openSettings(user);
    await user.click(within(group).getByRole('button', { name: '更新を確かめる' }));
    await within(group).findByText('新しい版 0.2.1 があります');
    const install = within(group).getByRole('button', { name: '今すぐ入れ直す' });
    expect(install).toBeDisabled();
    expect(within(group).getByText('記録中は入れ直せません（対局のあとで）')).toBeInTheDocument();
    await user.click(install);
    expect(mock.count('install_update')).toBe(0);
  });

  it('起動のときに見つかった版が、そのまま欄に出ている。「あとで」を押すと一言が付き、確かめ直しても変わらない', async () => {
    const user = userEvent.setup();
    const mock = setup({ status: 'idle', check: available('0.2.1') });
    render(<App />);
    // 起動のときに見つかった版が、そのまま欄に出ている
    const group = await openSettings(user);
    expect(await within(group).findByText('新しい版 0.2.1 があります')).toBeInTheDocument();
    await user.click(within(group).getByRole('button', { name: 'あとで' }));
    expect(within(group).getByText('新しい版 0.2.1 があります（あとで入れ直します）')).toBeInTheDocument();
    expect(within(group).queryByRole('button', { name: 'あとで' })).toBeNull();
    expect(within(group).getByRole('button', { name: '更新を確かめる' })).toHaveFocus();
    expect(mock.count('skip_update_version')).toBe(0);

    // 確かめ直しても、あとでにした版のまま（起動し直すまで）
    await user.click(within(group).getByRole('button', { name: '更新を確かめる' }));
    await waitFor(() => expect(mock.count('check_update')).toBe(2));
    expect(await within(group).findByText('新しい版 0.2.1 があります（あとで入れ直します）')).toBeInTheDocument();
  });

  it('飛ばした版でも、設定から確かめたときは、新しい版があることを伝え、入れ直せる', async () => {
    const user = userEvent.setup();
    const mock = setup({ status: 'idle', skipped: '0.2.1', check: available('0.2.1'), install: () => new Promise(() => {}) });
    render(<App />);
    const group = await openSettings(user);
    await user.click(within(group).getByRole('button', { name: '更新を確かめる' }));
    expect(await within(group).findByText('新しい版 0.2.1 があります（この版は飛ばす設定です）')).toBeInTheDocument();
    expect(within(group).queryByRole('button', { name: 'この版は飛ばす' })).toBeNull();
    await user.click(within(group).getByRole('button', { name: '今すぐ入れ直す' }));
    await waitFor(() => expect(mock.count('install_update')).toBe(1));
  });

  it('設定の欄から「この版は飛ばす」を押すと、覚える（保存の命令が 1 回）', async () => {
    const user = userEvent.setup();
    const mock = setup({ status: 'recording', check: available('0.2.1') });
    render(<App />);
    const group = await openSettings(user);
    await user.click(within(group).getByRole('button', { name: '更新を確かめる' }));
    await user.click(await within(group).findByRole('button', { name: 'この版は飛ばす' }));
    await waitFor(() =>
      expect(within(group).getByText('新しい版 0.2.1 があります（この版は飛ばす設定です）')).toBeInTheDocument(),
    );
    const saved = mock.calls().filter((call) => call.cmd === 'skip_update_version');
    expect(saved).toHaveLength(1);
    expect(saved[0]?.args).toEqual({ version: '0.2.1' });
  });

  it('確かめられなかったときは、「確かめられませんでした」と理由が出る', async () => {
    const user = userEvent.setup();
    setup({
      status: 'recording',
      check: { current_version: CURRENT, kind: 'failed', message: '通信できませんでした（dns error）' },
    });
    render(<App />);
    const group = await openSettings(user);
    await user.click(within(group).getByRole('button', { name: '更新を確かめる' }));
    expect(await within(group).findByText('確かめられませんでした')).toBeInTheDocument();
    expect(within(group).getByText('通信できませんでした（dns error）')).toBeInTheDocument();
  });

  it('命令そのものが失敗したときも、「確かめられませんでした」と理由が出る。落ちない', async () => {
    const user = userEvent.setup();
    setup({
      status: 'recording',
      check: () => {
        throw 'アプリの更新は、検討画面からだけ扱えます';
      },
    });
    render(<App />);
    const group = await openSettings(user);
    await user.click(within(group).getByRole('button', { name: '更新を確かめる' }));
    expect(await within(group).findByText('確かめられませんでした')).toBeInTheDocument();
    expect(within(group).getByText('アプリの更新は、検討画面からだけ扱えます')).toBeInTheDocument();
  });

  it('更新の仕組みがまだ設定されていないときは、そう伝える（通信しない）', async () => {
    const user = userEvent.setup();
    const mock = setup({
      info: { current_version: CURRENT, configured: false },
      check: { current_version: CURRENT, kind: 'not_configured' },
    });
    render(<App />);
    const group = await openSettings(user);
    expect(within(group).getByText('更新の仕組みがまだ設定されていません')).toBeInTheDocument();
    expect(mock.count('check_update')).toBe(0);
    await user.click(within(group).getByRole('button', { name: '更新を確かめる' }));
    await waitFor(() => expect(mock.count('check_update')).toBe(1));
    expect(within(group).getByText('更新の仕組みがまだ設定されていません')).toBeInTheDocument();
  });

  it('起動のときの確かめが失敗していても、設定の欄には出さない（設定から確かめたときだけ出す）', async () => {
    const user = userEvent.setup();
    const mock = setup({
      status: 'idle',
      check: (call) =>
        call === 1
          ? { current_version: CURRENT, kind: 'failed', message: '通信できませんでした' }
          : { current_version: CURRENT, kind: 'up_to_date' },
    });
    render(<App />);
    await settle(mock);
    const group = await openSettings(user);
    expect(within(group).getByText('まだ確かめていません')).toBeInTheDocument();
    expect(within(group).queryByText('確かめられませんでした')).toBeNull();
  });
});

describe('ウィジェットには出ない（U-51）', () => {
  it('ウィジェットは、更新を確かめず、帯も出さない', async () => {
    const mock = setup({ check: available('0.2.1') });
    render(<WidgetApp />);
    await screen.findByRole('group', { name: '終わった局の評価' });
    await act(async () => {
      await new Promise((resolve) => setTimeout(resolve, 30));
    });
    expect(screen.queryByRole('region', { name: REGION })).toBeNull();
    expect(screen.queryByText(/新しい版/)).toBeNull();
    for (const cmd of ['get_update_info', 'check_update', 'install_update', 'skip_update_version']) {
      expect(mock.count(cmd), cmd).toBe(0);
    }
  });
});
