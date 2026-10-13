import { act, render, screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { installTauriMock, type TauriMock } from '../../tests/tauri-mock';
import type { SyncStatus } from '../api/types';
import { SyncBlock } from './SyncBlock';
import { stateLine } from './syncText';
import { ShortcutGuardProvider } from './undo/shortcutGuard';

vi.mock('@tauri-apps/api/core', () => ({
  invoke: vi.fn(),
  convertFileSrc: (path: string) => path,
}));
vi.mock('@tauri-apps/api/event', () => ({ listen: vi.fn() }));

const HOST = 'jantama-test-org.aws-ap-northeast-1.turso.io';
const TOKEN = 'TOKEN-SENTINEL-8c1e5a77-do-not-leak';
const LAST_OK = new Date(2026, 9, 13, 22, 10, 0).getTime();

const OFF: SyncStatus = {
  enabled: false,
  url_host: '',
  has_token: false,
  state: 'off',
  last_ok_ms: null,
  message: null,
  warnings: [],
  can_allow_mass_delete: false,
  device_id: 'd-0123abcd',
};

const READY: SyncStatus = { ...OFF, url_host: HOST, has_token: true };
const RUNNING: SyncStatus = { ...READY, enabled: true, state: 'idle', last_ok_ms: LAST_OK };

/** 試験の「いま」: 2026 年 10 月 13 日。 */
beforeEach(() => {
  vi.useFakeTimers({ toFake: ['Date'] });
  vi.setSystemTime(new Date(2026, 9, 13, 23, 0, 0));
});

afterEach(() => {
  vi.useRealTimers();
});

interface Setup {
  mock: TauriMock;
  onModalChange: ReturnType<typeof vi.fn>;
}

function setup(
  initial: SyncStatus | undefined,
  handlers: Record<string, (args: unknown) => unknown> = {},
): Setup {
  const onModalChange = vi.fn();
  const mock = installTauriMock({
    handlers: {
      get_sync_status: () => initial,
      ...handlers,
    },
  });
  render(
    <ShortcutGuardProvider>
      <SyncBlock onModalChange={onModalChange} />
    </ShortcutGuardProvider>,
  );
  return { mock, onModalChange };
}

function group() {
  return screen.getByRole('group', { name: '同期' });
}

function argsOf(mock: TauriMock, cmd: string): unknown[] {
  return mock
    .calls()
    .filter((c) => c.cmd === cmd)
    .map((c) => c.args);
}

describe('設定の「同期」の欄（F15、D-4）', () => {
  it('まだ設定していないとき: 2 つの入力欄・保存のボタン・使うかの選択（押せない）・状態の行を出す。説明の文は、説明のアイコンの中', async () => {
    setup(OFF);
    const block = group();
    await waitFor(() => expect(block).toHaveTextContent('まだ設定していません'));
    expect(within(block).getByLabelText('同期先の DB の URL')).toHaveValue('');
    const token = within(block).getByLabelText('トークン');
    expect(token).toHaveAttribute('type', 'password');
    expect(token).toHaveAttribute('autocomplete', 'off');
    expect(token).toHaveAttribute('placeholder', 'トークンを貼る');
    expect(within(block).getByRole('button', { name: '接続を保存' })).toBeEnabled();
    expect(within(block).getByRole('checkbox', { name: 'この端末で同期する' })).toBeDisabled();
    expect(block).toHaveTextContent('先に、URL とトークンを保存してください');
    expect(block).toHaveTextContent('未設定');
    expect(block).toHaveTextContent('未保存');
    expect(within(block).getByRole('button', { name: '今すぐ同期' })).toBeDisabled();
    expect(within(block).getByRole('button', { name: '同期用の DB を作り直す' })).toBeDisabled();
    expect(within(block).getByRole('button', { name: 'この端末の同期を切る' })).toBeDisabled();
    // 説明は、アイコンの中
    const tip = within(block).getByRole('button', { name: '同期の説明' });
    expect(tip).toHaveAttribute('aria-describedby', 'sync-help');
    expect(document.getElementById('sync-help')).toHaveTextContent('Turso Cloud を通して同期します');
    expect(block.textContent).not.toContain('裏で行います');
    // 入力欄の説明は、欄に結びつく
    expect(within(block).getByLabelText('同期先の DB の URL')).toHaveAttribute('aria-describedby', 'sync-url-help');
    expect(document.getElementById('sync-token-help')).toHaveTextContent('資格情報の保管庫');
    expect(document.getElementById('sync-token-help')).toHaveTextContent('ファイルにも、画面にも、ログにも残しません');
  });

  it('状態を読めなくても（コマンドが答えなくても）、欄は壊れずに出る', async () => {
    setup(undefined);
    expect(group()).toHaveTextContent('同期');
    expect(within(group()).getByRole('button', { name: '接続を保存' })).toBeEnabled();
  });

  it('「接続を保存」: URL とトークンを 1 回だけ渡し、保存できたらトークンの欄を空にして、画面のどこにもトークンの文字を残さない', async () => {
    const user = userEvent.setup();
    const { mock } = setup(OFF, {
      save_sync_connection: () => READY,
    });
    await user.type(screen.getByLabelText('同期先の DB の URL'), `libsql://${HOST}`);
    await user.type(screen.getByLabelText('トークン'), TOKEN);
    expect(screen.getByLabelText('トークン')).toHaveValue(TOKEN);
    await user.click(screen.getByRole('button', { name: '接続を保存' }));
    await waitFor(() => expect(group()).toHaveTextContent('接続を保存しました'));
    expect(argsOf(mock, 'save_sync_connection')).toEqual([{ url: `libsql://${HOST}`, token: TOKEN }]);
    // 保存できたので、欄は空に戻り、保存済みの表示になる
    expect(screen.getByLabelText('トークン')).toHaveValue('');
    expect(screen.getByLabelText('同期先の DB の URL')).toHaveValue('');
    expect(screen.getByLabelText('トークン')).toHaveAttribute('placeholder', '保存済み（貼り直すと置き換わります）');
    expect(group()).toHaveTextContent(HOST);
    expect(group()).toHaveTextContent('この PC の保管庫に保存済み');
    // トークンの文字は、画面の文章にも、属性にも無い
    expect(document.body.innerHTML).not.toContain(TOKEN);
    // トークンを渡したコマンドは、保存の 1 つだけ（状態の読み取りなどに、トークンは出ない）
    const withToken = mock.calls().filter((c) => JSON.stringify(c.args ?? null).includes(TOKEN));
    expect(withToken.map((c) => c.cmd)).toEqual(['save_sync_connection']);
  });

  it('トークンだけを貼り直したときは、URL は渡さない（いまのままにする）', async () => {
    const user = userEvent.setup();
    const { mock } = setup(RUNNING, { save_sync_connection: () => RUNNING });
    await user.type(screen.getByLabelText('トークン'), 'NEW-TOKEN-VALUE');
    await user.click(screen.getByRole('button', { name: '接続を保存' }));
    await waitFor(() => expect(argsOf(mock, 'save_sync_connection')).toHaveLength(1));
    expect(argsOf(mock, 'save_sync_connection')).toEqual([{ url: null, token: 'NEW-TOKEN-VALUE' }]);
  });

  it('何も貼らずに保存を押すと、理由を出し、保存のコマンドは呼ばない', async () => {
    const user = userEvent.setup();
    const { mock } = setup(OFF);
    await user.click(screen.getByRole('button', { name: '接続を保存' }));
    expect(await screen.findByRole('alert')).toHaveTextContent('URL かトークンを貼ってください');
    expect(mock.count('save_sync_connection')).toBe(0);
  });

  it('保存に失敗したら、理由を出し、貼ったトークンは残す（貼り直さなくていい）。キーボードの位置は理由へ移る', async () => {
    const user = userEvent.setup();
    setup(OFF, {
      save_sync_connection: () => {
        throw '同期先は、Turso Cloud の DB（ホスト名が .turso.io で終わるもの）だけです';
      },
    });
    await user.type(screen.getByLabelText('同期先の DB の URL'), 'libsql://example.com');
    await user.type(screen.getByLabelText('トークン'), TOKEN);
    await user.click(screen.getByRole('button', { name: '接続を保存' }));
    const alert = await screen.findByRole('alert');
    expect(alert).toHaveTextContent('Turso Cloud の DB');
    expect(alert).toHaveFocus();
    expect(screen.getByLabelText('トークン')).toHaveValue(TOKEN);
    // 理由に、貼った文字が出ていない（Rust 側が返す文は、貼った文字を写さない）
    expect(alert.textContent).not.toContain(TOKEN);
  });

  it('保存してあるときだけ、この端末で同期するを選べる。選ぶと、使う設定にして、状態が変わる', async () => {
    const user = userEvent.setup();
    const { mock } = setup(READY, { set_sync_enabled: () => RUNNING });
    const box = screen.getByRole('checkbox', { name: 'この端末で同期する' });
    await waitFor(() => expect(box).toBeEnabled());
    expect(box).not.toBeChecked();
    await user.click(box);
    await waitFor(() => expect(box).toBeChecked());
    expect(argsOf(mock, 'set_sync_enabled')).toEqual([{ enabled: true }]);
    expect(group()).toHaveTextContent('最後の同期: 10月13日 22:10');
  });

  it('使うのに足りないとき（コマンドが断る）は、理由を出し、選択は変わらない', async () => {
    const user = userEvent.setup();
    setup(READY, {
      set_sync_enabled: () => {
        throw '先に、トークンを保存してください';
      },
    });
    const box = screen.getByRole('checkbox', { name: 'この端末で同期する' });
    await waitFor(() => expect(box).toBeEnabled());
    await user.click(box);
    expect(await screen.findByRole('alert')).toHaveTextContent('先に、トークンを保存してください');
    expect(box).not.toBeChecked();
  });

  it('同期の状態の知らせが届くたびに、状態の行が変わる（同期中は、今すぐ同期を押せない）', async () => {
    const { mock } = setup(RUNNING);
    await waitFor(() => expect(group()).toHaveTextContent('最後の同期: 10月13日 22:10'));
    const now = within(group()).getByRole('button', { name: '今すぐ同期' });
    expect(now).toBeEnabled();
    act(() => mock.emit('sync-status', { ...RUNNING, state: 'syncing' }));
    await waitFor(() => expect(group()).toHaveTextContent('同期しています…'));
    expect(now).toBeDisabled();
    act(() => mock.emit('sync-status', { ...RUNNING, state: 'offline' }));
    await waitFor(() =>
      expect(group()).toHaveTextContent(
        '同期先につながりません。つながったときに、続きを同期します（最後の同期: 10月13日 22:10）',
      ),
    );
    expect(now).toBeEnabled();
    act(() =>
      mock.emit('sync-status', {
        ...RUNNING,
        state: 'attention',
        message: '同期先がトークンを受け付けません。トークンを貼り直してください',
      }),
    );
    await waitFor(() => expect(group()).toHaveTextContent('同期先がトークンを受け付けません'));
    // 注意（入れられなかった記録）も出す
    act(() => mock.emit('sync-status', { ...RUNNING, warnings: ['読めない記録があるので、同期を見送りました'] }));
    await waitFor(() => expect(group()).toHaveTextContent('読めない記録があるので、同期を見送りました'));
  });

  it('「今すぐ同期」を押すと、コマンドを呼ぶ（結果は、状態の知らせで届く）', async () => {
    const user = userEvent.setup();
    const { mock } = setup(RUNNING);
    await waitFor(() => expect(group()).toHaveTextContent('最後の同期'));
    await user.click(screen.getByRole('button', { name: '今すぐ同期' }));
    await waitFor(() => expect(mock.count('sync_now')).toBe(1));
  });

  it('「同期用の DB を作り直す」: 確認を出し、既定のボタンは「やめる」。やめると何も起きず、作り直すを選ぶと呼ぶ', async () => {
    const user = userEvent.setup();
    const { mock, onModalChange } = setup(RUNNING);
    const open = screen.getByRole('button', { name: '同期用の DB を作り直す' });
    await waitFor(() => expect(open).toBeEnabled());
    await user.click(open);
    const dialog = await screen.findByRole('alertdialog');
    expect(onModalChange).toHaveBeenLastCalledWith(true);
    expect(dialog).toHaveTextContent('同期用の DB を作り直しますか');
    expect(dialog).toHaveTextContent('この端末の記録から入れ直します');
    expect(within(dialog).getByRole('button', { name: 'やめる' })).toHaveFocus();
    await user.click(within(dialog).getByRole('button', { name: 'やめる' }));
    await waitFor(() => expect(screen.queryByRole('alertdialog')).toBeNull());
    expect(onModalChange).toHaveBeenLastCalledWith(false);
    expect(mock.count('rebuild_sync_db')).toBe(0);
    await waitFor(() => expect(open).toHaveFocus());
    // もう一度開いて、作り直す
    await user.click(open);
    await user.click(within(await screen.findByRole('alertdialog')).getByRole('button', { name: '作り直す' }));
    await waitFor(() => expect(mock.count('rebuild_sync_db')).toBe(1));
  });

  it('「この端末の同期を切る」: 確認（既定は「やめる」）のあと、コマンドを呼び、状態を「同期していません」にして、トークンは保存済みでなくなる', async () => {
    const user = userEvent.setup();
    const { mock } = setup(RUNNING, {
      disconnect_sync: () => ({ ...READY, has_token: false, state: 'off', enabled: false }),
    });
    const open = screen.getByRole('button', { name: 'この端末の同期を切る' });
    await waitFor(() => expect(open).toBeEnabled());
    await user.click(open);
    const dialog = await screen.findByRole('alertdialog');
    expect(dialog).toHaveTextContent('この端末の同期を切りますか');
    expect(dialog).toHaveTextContent('同期用の DB（ほかの端末の分）は、そのままです');
    expect(within(dialog).getByRole('button', { name: 'やめる' })).toHaveFocus();
    await user.click(within(dialog).getByRole('button', { name: '同期を切る' }));
    await waitFor(() => expect(mock.count('disconnect_sync')).toBe(1));
    await waitFor(() => expect(group()).toHaveTextContent('同期していません'));
    expect(group()).toHaveTextContent('未保存');
    expect(screen.getByRole('checkbox', { name: 'この端末で同期する' })).not.toBeChecked();
  });

  it('大量の消去を止めているときだけ、「削除をそのまま同期する」を出す（確認つき）', async () => {
    const user = userEvent.setup();
    const stopped: SyncStatus = {
      ...RUNNING,
      state: 'attention',
      message: '手元の記録が 80 件のうち 70 件、無くなっています。ほかの端末の記録を消さないよう、同期を止めました。',
      can_allow_mass_delete: true,
    };
    const { mock } = setup(stopped);
    await waitFor(() => expect(group()).toHaveTextContent('同期を止めました'));
    await user.click(within(group()).getByRole('button', { name: '削除をそのまま同期する' }));
    const dialog = await screen.findByRole('alertdialog');
    expect(within(dialog).getByRole('button', { name: 'やめる' })).toHaveFocus();
    expect(mock.count('allow_sync_mass_delete')).toBe(0);
    await user.click(within(dialog).getByRole('button', { name: 'そのまま同期する' }));
    await waitFor(() => expect(mock.count('allow_sync_mass_delete')).toBe(1));
    // 止めていないときは、ボタンが無い
    act(() => mock.emit('sync-status', RUNNING));
    await waitFor(() =>
      expect(within(group()).queryByRole('button', { name: '削除をそのまま同期する' })).toBeNull(),
    );
  });

  it('同期先は、ホスト名だけを出す（URL の細部もトークンも出さない）。端末の名前も出す', async () => {
    setup(RUNNING);
    await waitFor(() => expect(group()).toHaveTextContent(HOST));
    expect(group()).toHaveTextContent('d-0123abcd');
    // 同期先の表示は、ホスト名だけ（スキームも、パスも付かない）
    expect(screen.getByText(HOST).textContent).toBe(HOST);
  });
});

describe('状態の文（stateLine）', () => {
  const now = new Date(2026, 9, 13, 23, 0, 0).getTime();

  it('使っていない・まだ同期していない・同期中・つながらない・止めた・失敗の文を、状態から作る', () => {
    expect(stateLine(OFF, now)).toEqual({ text: 'まだ設定していません', tone: 'quiet' });
    expect(stateLine(READY, now)).toEqual({ text: '同期していません', tone: 'quiet' });
    expect(stateLine({ ...READY, enabled: true, state: 'idle' }, now).text).toBe('まだ同期していません');
    expect(stateLine(RUNNING, now)).toEqual({ text: '最後の同期: 10月13日 22:10', tone: 'quiet' });
    expect(stateLine({ ...RUNNING, state: 'syncing' }, now)).toEqual({ text: '同期しています…', tone: 'busy' });
    expect(stateLine({ ...READY, enabled: true, state: 'offline' }, now).text).toBe(
      '同期先につながりません。つながったときに、続きを同期します',
    );
    expect(stateLine({ ...RUNNING, state: 'error', message: '手元の記録を扱えませんでした' }, now)).toEqual({
      text: '手元の記録を扱えませんでした',
      tone: 'problem',
    });
    expect(stateLine({ ...RUNNING, state: 'error', message: null }, now).text).toBe('同期できませんでした');
  });

  it('去年の同期の時刻には、年を付ける', () => {
    const last = new Date(2025, 11, 31, 9, 5, 0).getTime();
    expect(stateLine({ ...RUNNING, last_ok_ms: last }, now).text).toBe('最後の同期: 2025年12月31日 09:05');
  });
});
