import { open } from '@tauri-apps/plugin-dialog';
import { act, fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { beforeEach, describe, expect, it, vi } from 'vitest';

import {
  baseInputStatus,
  baseSettings,
  baseState,
  installTauriMock,
  type TauriMock,
} from '../../tests/tauri-mock';
import type { HelperStatus, InputStatus, PageKeyEvent, Settings } from '../api/types';
import { formatClock } from './format';
import { SettingsPage } from './SettingsPage';

vi.mock('@tauri-apps/api/core', () => ({
  invoke: vi.fn(),
  convertFileSrc: (path: string) => path,
}));
vi.mock('@tauri-apps/api/event', () => ({ listen: vi.fn() }));
vi.mock('@tauri-apps/plugin-dialog', () => ({ open: vi.fn() }));

const KEYCAP_X1 = 'マウスの戻るボタン（XButton1）';

function savedSettings(mock: TauriMock): Settings[] {
  return mock
    .calls()
    .filter((c) => c.cmd === 'set_settings')
    .map((c) => (c.args as { settings: Settings }).settings);
}

function status(patch: Partial<Omit<InputStatus, 'helper'>> & { helper?: Partial<HelperStatus> } = {}): InputStatus {
  return {
    ...baseInputStatus,
    ...patch,
    helper: { ...baseInputStatus.helper, ...patch.helper },
  };
}

async function renderPage(options: Parameters<typeof installTauriMock>[0] = {}) {
  const mock = installTauriMock(options);
  render(<SettingsPage />);
  await screen.findByRole('button', { name: 'ボタンを登録' });
  return mock;
}

function emitStatus(mock: TauriMock, next: InputStatus) {
  act(() => {
    mock.emit('input-status-changed', next);
  });
}

/** 窓の中のキーとして本体に知らせた入力（`report_page_key` の引数）。 */
function reportedKeys(mock: TauriMock): PageKeyEvent[] {
  return mock
    .calls()
    .filter((c) => c.cmd === 'report_page_key')
    .map((c) => (c.args as { key: PageKeyEvent }).key);
}

/** 窓にキーを押した知らせを送る。`false` なら、窓のものを動かさないよう止められた。 */
function pressInWindow(init: KeyboardEventInit): boolean {
  let notPrevented = true;
  act(() => {
    notPrevented = fireEvent.keyDown(window, init);
  });
  return notPrevented;
}

describe('設定ページ', () => {
  beforeEach(() => {
    vi.mocked(open).mockReset();
  });

  it('いまの設定を出す', async () => {
    await renderPage();
    expect(screen.getByText(KEYCAP_X1)).toBeInTheDocument();
    expect(screen.getByRole('radio', { name: '縦長' })).toBeChecked();
    expect(screen.getByRole('checkbox', { name: '迷いを記録したら音を鳴らす' })).toBeChecked();
    expect(screen.getByText(baseSettings.data_dir)).toBeInTheDocument();
    expect(screen.getByRole('textbox', { name: /雀魂の窓を探す語/ })).toHaveValue(
      '雀魂\nMahjong Soul',
    );
  });

  it('ウィジェットの形を選ぶと、その場で保存する', async () => {
    const user = userEvent.setup();
    const mock = await renderPage();
    await user.click(screen.getByRole('radio', { name: '横長' }));
    await waitFor(() => expect(savedSettings(mock)).toHaveLength(1));
    expect(savedSettings(mock)[0]?.orientation).toBe('horizontal');
  });

  it('W-12 設定のチェックで音の入・切を保存する（メニューの「音を鳴らす」と同じ設定）', async () => {
    const user = userEvent.setup();
    const mock = await renderPage();
    await user.click(screen.getByRole('checkbox', { name: '迷いを記録したら音を鳴らす' }));
    await waitFor(() => expect(savedSettings(mock)).toHaveLength(1));
    expect(savedSettings(mock)[0]?.sound).toBe(false);
    expect(await screen.findByText('保存しました')).toBeInTheDocument();
  });

  it('W-12 メニューで音を切り替えたら（settings-changed）、チェックも変わる', async () => {
    const mock = await renderPage();
    act(() => {
      mock.emit('settings-changed', { ...baseSettings, sound: false } satisfies Settings);
    });
    await waitFor(() =>
      expect(screen.getByRole('checkbox', { name: '迷いを記録したら音を鳴らす' })).not.toBeChecked(),
    );
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

describe('設定ページ: 迷いマークのボタンの登録（W-10）', () => {
  it('W-10 4 つの選択肢のラジオは無く、いまの割り当てと「ボタンを登録」が並ぶ', async () => {
    await renderPage();
    const group = screen.getByRole('group', { name: '迷いマークのボタン' });
    expect(within(group).getByText(KEYCAP_X1)).toBeInTheDocument();
    expect(within(group).getByRole('button', { name: 'ボタンを登録' })).toBeInTheDocument();
    expect(screen.queryByRole('radio', { name: /マウスの|キーボードのキー/ })).toBeNull();
  });

  it.each([
    [{ kind: 'mouse_x1' }, 'マウスの戻るボタン（XButton1）'],
    [{ kind: 'mouse_x2' }, 'マウスの進むボタン（XButton2）'],
    [{ kind: 'mouse_middle' }, 'マウスの中ボタン（MButton）'],
    [{ kind: 'key', code: 'F13' }, 'キー：F13'],
    [{ kind: 'key', code: 'KeyM', ctrl: true, alt: true }, 'Ctrl+Alt+M'],
    [{ kind: 'key', code: 'F8', shift: true }, 'Shift+F8'],
  ] as const)('W-10 割り当て %j は「%s」と出る', async (trigger, text) => {
    await renderPage({ settings: { ...baseSettings, trigger } });
    expect(screen.getByText(text)).toBeInTheDocument();
  });

  it('W-10 「ボタンを登録」を押すと、登録を始めるコマンドを呼ぶ。割り当ては、押されるまで変えない', async () => {
    const user = userEvent.setup();
    const mock = await renderPage();
    await user.click(screen.getByRole('button', { name: 'ボタンを登録' }));
    expect(mock.count('start_registration')).toBe(1);
    expect(savedSettings(mock)).toHaveLength(0);
  });

  it('W-10 待機中は、「押してください」の表示とキャンセルに変わり、キーボードの位置が待機の表示へ移る', async () => {
    const mock = await renderPage();
    emitStatus(mock, status({ registering: true }));
    const listening = await screen.findByText(
      '登録したいボタンを押してください（マウスのボタンでもキーでも）',
    );
    expect(listening).toHaveAttribute('role', 'status');
    await waitFor(() => expect(listening).toHaveFocus());
    expect(screen.getByRole('button', { name: 'キャンセル' })).toBeInTheDocument();
    expect(screen.queryByRole('button', { name: 'ボタンを登録' })).toBeNull();
    // 登録できない入力の案内（文字のキーは修飾キーと組み合わせる・左右のボタンは登録できない）。
    expect(screen.getByText(/Ctrl か Alt と組み合わせて/)).toBeInTheDocument();
    // 待機中は、いまの割り当ての表示を隠す（登録したいボタンを押すことに集中できる）。
    expect(screen.queryByText(KEYCAP_X1)).toBeNull();
  });

  it('W-10 キャンセルのボタンで取りやめ、「ボタンを登録」にキーボードの位置が戻る', async () => {
    const user = userEvent.setup();
    const mock = await renderPage();
    emitStatus(mock, status({ registering: true }));
    await user.click(await screen.findByRole('button', { name: 'キャンセル' }));
    expect(mock.count('cancel_registration')).toBe(1);
    emitStatus(mock, status({ registering: false }));
    const start = await screen.findByRole('button', { name: 'ボタンを登録' });
    await waitFor(() => expect(start).toHaveFocus());
    expect(savedSettings(mock)).toHaveLength(0);
  });

  it('W-10 待機中の Esc で取りやめる（待機中でないときは何もしない）', async () => {
    const mock = await renderPage();
    act(() => {
      fireEvent.keyDown(window, { code: 'Escape', key: 'Escape' });
    });
    expect(mock.count('cancel_registration')).toBe(0);
    emitStatus(mock, status({ registering: true }));
    await screen.findByRole('button', { name: 'キャンセル' });
    act(() => {
      fireEvent.keyDown(window, { code: 'Escape', key: 'Escape' });
    });
    expect(mock.count('cancel_registration')).toBe(1);
  });

  it('W-10 待機中に窓の中で押したキーを、修飾キーつきで本体に知らせ、窓のものは動かさない', async () => {
    const mock = await renderPage();
    emitStatus(mock, status({ registering: true }));
    await screen.findByRole('button', { name: 'キャンセル' });
    const passedOn = pressInWindow({ code: 'KeyM', key: 'm', ctrlKey: true, altKey: true });
    expect(reportedKeys(mock)).toEqual([
      { code: 'KeyM', ctrl: true, alt: true, shift: false, meta: false },
    ]);
    expect(passedOn).toBe(false);
    pressInWindow({ code: 'F13', key: 'F13' });
    pressInWindow({ code: 'F8', key: 'F8', shiftKey: true, metaKey: true });
    expect(reportedKeys(mock).slice(1)).toEqual([
      { code: 'F13', ctrl: false, alt: false, shift: false, meta: false },
      { code: 'F8', ctrl: false, alt: false, shift: true, meta: true },
    ]);
  });

  it('W-10 待機中でも、Tab・Enter・Space・Esc・修飾キー単独・繰り返し・日本語入力の途中は、キーとして知らせない', async () => {
    const mock = await renderPage();
    emitStatus(mock, status({ registering: true }));
    await screen.findByRole('button', { name: 'キャンセル' });
    // 画面の操作に使うキーは、窓のものも動かす（Tab で移動、Enter・Space でボタンを押せる）。
    expect(pressInWindow({ code: 'Tab', key: 'Tab' })).toBe(true);
    expect(pressInWindow({ code: 'Enter', key: 'Enter' })).toBe(true);
    expect(pressInWindow({ code: 'Space', key: ' ' })).toBe(true);
    for (const code of ['ControlLeft', 'ShiftRight', 'AltLeft', 'MetaRight', 'AltGraph']) {
      expect(pressInWindow({ code, key: code })).toBe(true);
    }
    expect(pressInWindow({ code: 'F13', key: 'F13', repeat: true })).toBe(true);
    expect(pressInWindow({ code: 'KeyM', key: 'm', isComposing: true, ctrlKey: true })).toBe(true);
    pressInWindow({ code: 'Escape', key: 'Escape' });
    expect(reportedKeys(mock)).toEqual([]);
    // Esc は取りやめになる。
    expect(mock.count('cancel_registration')).toBe(1);
  });

  it('W-10 待機中でなく、キーも割り当てていないとき（マウスのボタン）は、窓の中のキーを本体に知らせない', async () => {
    const mock = await renderPage();
    pressInWindow({ code: 'F13', key: 'F13' });
    pressInWindow({ code: 'KeyM', key: 'm', ctrlKey: true, altKey: true });
    expect(reportedKeys(mock)).toEqual([]);
  });

  it('W-10 登録の待機が終われば、窓の中のキーを知らせなくなる', async () => {
    const mock = await renderPage();
    emitStatus(mock, status({ registering: true }));
    await screen.findByRole('button', { name: 'キャンセル' });
    pressInWindow({ code: 'F13', key: 'F13' });
    expect(reportedKeys(mock)).toHaveLength(1);
    emitStatus(mock, status({ registering: false }));
    await screen.findByRole('button', { name: 'ボタンを登録' });
    pressInWindow({ code: 'F13', key: 'F13' });
    expect(reportedKeys(mock)).toHaveLength(1);
  });

  it('W-10 登録できたら、新しい割り当てが出る（キーは修飾キーつきで）', async () => {
    const mock = await renderPage();
    emitStatus(mock, status({ registering: true }));
    await screen.findByRole('button', { name: 'キャンセル' });
    // 本体の側が、拾った入力を設定に保存して、設定の変更と状態の変更を知らせる。
    act(() => {
      mock.emit('settings-changed', {
        ...baseSettings,
        trigger: { kind: 'key', code: 'KeyM', ctrl: true, alt: true },
      } satisfies Settings);
    });
    emitStatus(mock, status({ registering: false }));
    expect(await screen.findByText('Ctrl+Alt+M')).toBeInTheDocument();
    expect(screen.queryByText(KEYCAP_X1)).toBeNull();
  });

  it('W-10 登録を始められない・保存できなかったときの理由を出す', async () => {
    const mock = await renderPage();
    emitStatus(mock, status({ message: 'ボタンを拾う仕組みが動いていません。' }));
    expect(await screen.findByRole('alert')).toHaveTextContent('ボタンを拾う仕組みが動いていません');
  });

  it('W-10 登録の開始に失敗したら、理由を出す', async () => {
    const user = userEvent.setup();
    await renderPage({
      handlers: {
        start_registration: () => {
          throw '登録を始められません';
        },
      },
    });
    await user.click(screen.getByRole('button', { name: 'ボタンを登録' }));
    expect(await screen.findByRole('alert')).toHaveTextContent('登録を始められません');
  });
});

describe('設定ページ: テスト（W-11）', () => {
  it('W-11 最初は「ボタンを押すと、ここに表示されます。迷いマークは記録しません」', async () => {
    await renderPage();
    const probe = screen.getByRole('status', { name: 'テスト' });
    expect(probe).toHaveTextContent('ボタンを押すと、ここに表示されます。迷いマークは記録しません');
    expect(probe).toHaveAttribute('data-got', 'false');
  });

  it('W-11 ボタンを受け取ったら、「受け取りました hh:mm:ss」と出る', async () => {
    const mock = await renderPage();
    const at = new Date(2026, 9, 9, 19, 42, 5).getTime();
    emitStatus(mock, status({ probe_ms: at }));
    const probe = await screen.findByText(/受け取りました/);
    expect(probe).toHaveTextContent(`受け取りました ${formatClock(at)}`);
    expect(probe).toHaveTextContent('受け取りました 19:42:05');
    expect(probe).toHaveAttribute('data-got', 'true');
    // 受け取っただけで、記録は呼ばない。
  });

  it('W-11 テストは記録しない: 受け取っても、迷いマークの記録のコマンドは呼ばれない', async () => {
    const mock = await renderPage();
    emitStatus(mock, status({ probe_ms: Date.now() }));
    await screen.findByText(/受け取りました/);
    expect(mock.count('add_mark')).toBe(0);
    expect(mock.count('add_rating')).toBe(0);
  });

  it('W-11 ページを開いている間だけ、テストの欄を見せていると本体に知らせる', async () => {
    const mock = installTauriMock();
    const view = render(<SettingsPage />);
    await screen.findByRole('button', { name: 'ボタンを登録' });
    const wanted = () =>
      mock
        .calls()
        .filter((c) => c.cmd === 'set_probe_wanted')
        .map((c) => (c.args as { wanted: boolean }).wanted);
    expect(wanted()).toEqual([true]);
    view.unmount();
    expect(wanted()).toEqual([true, false]);
  });

  it('W-11 登録を始めると、前のテストの結果は消える（本体の状態のとおり）', async () => {
    const mock = await renderPage();
    emitStatus(mock, status({ probe_ms: Date.now() }));
    await screen.findByText(/受け取りました/);
    emitStatus(mock, status({ registering: true, probe_ms: null }));
    await screen.findByRole('button', { name: 'キャンセル' });
    expect(screen.getByRole('status', { name: 'テスト' })).toHaveAttribute('data-got', 'false');
  });

  it('W-11 キーを割り当てているとき、窓の中で押したキーを本体に知らせる（受け取りの表示は、本体の状態のとおり）', async () => {
    const mock = await renderPage({
      settings: { ...baseSettings, trigger: { kind: 'key', code: 'F13' } },
    });
    // 待機中ではないので、押したキーは窓のものも動かす（文字の入力などを邪魔しない）。
    const passedOn = pressInWindow({ code: 'F13', key: 'F13' });
    expect(passedOn).toBe(true);
    expect(reportedKeys(mock)).toEqual([
      { code: 'F13', ctrl: false, alt: false, shift: false, meta: false },
    ]);
    // 知らせるだけで、記録のコマンドは呼ばない（記録するかどうかは、本体がテストの状態で決める）。
    expect(mock.count('add_mark')).toBe(0);
    emitStatus(mock, status({ probe_ms: new Date(2026, 9, 9, 19, 42, 5).getTime() }));
    expect(await screen.findByText(/受け取りました/)).toHaveTextContent('受け取りました 19:42:05');
  });

  it('W-11 修飾キーつきの割り当て（Ctrl+Alt+M）も、押した修飾キーごと知らせる', async () => {
    const mock = await renderPage({
      settings: {
        ...baseSettings,
        trigger: { kind: 'key', code: 'KeyM', ctrl: true, alt: true },
      },
    });
    pressInWindow({ code: 'KeyM', key: 'm', ctrlKey: true, altKey: true });
    expect(reportedKeys(mock)).toEqual([
      { code: 'KeyM', ctrl: true, alt: true, shift: false, meta: false },
    ]);
  });

  it('W-11 割り当てが変わって、キーでなくなれば、窓の中のキーを知らせなくなる', async () => {
    const mock = await renderPage({
      settings: { ...baseSettings, trigger: { kind: 'key', code: 'F13' } },
    });
    act(() => {
      mock.emit('settings-changed', { ...baseSettings, trigger: { kind: 'mouse_x2' } } satisfies Settings);
    });
    await screen.findByText('マウスの進むボタン（XButton2）');
    pressInWindow({ code: 'F13', key: 'F13' });
    expect(reportedKeys(mock)).toEqual([]);
  });
});

describe('設定ページ: 管理者の補助プログラム（W-9）', () => {
  it('W-9 未設定: 「動いていません（雀魂の上ではボタンが効きません）」と、設定のボタン', async () => {
    const mock = await renderPage();
    const line = screen.getByRole('status', { name: '補助プログラム' });
    expect(line).toHaveTextContent('動いていません（雀魂の上ではボタンが効きません）');
    expect(screen.getByRole('button', { name: '管理者の補助プログラムを設定する' })).toBeEnabled();
    expect(screen.queryByRole('button', { name: '設定を解除する' })).toBeNull();
    expect(screen.queryByRole('button', { name: '起動する' })).toBeNull();
    expect(mock.count('setup_helper')).toBe(0);
  });

  it('W-9 設定のボタンは、設定のコマンドを呼ぶ（Windows の確認は、本体の側が出す）', async () => {
    const user = userEvent.setup();
    const mock = await renderPage();
    await user.click(screen.getByRole('button', { name: '管理者の補助プログラムを設定する' }));
    expect(mock.count('setup_helper')).toBe(1);
  });

  it('W-9 動いている: 「動いています」と、解除のボタンだけ', async () => {
    await renderPage({
      inputStatus: status({
        hook: 'helper',
        helper: { installed: true, running: true },
      }),
    });
    expect(screen.getByRole('status', { name: '補助プログラム' })).toHaveTextContent('動いています');
    expect(screen.getByRole('button', { name: '設定を解除する' })).toBeInTheDocument();
    expect(screen.queryByRole('button', { name: '管理者の補助プログラムを設定する' })).toBeNull();
    expect(screen.queryByRole('button', { name: '起動する' })).toBeNull();
  });

  it('W-9 設定済みだが動いていない: 起動と解除。もう一度の設定（確認）は出さない', async () => {
    const user = userEvent.setup();
    const mock = await renderPage({
      inputStatus: status({ helper: { installed: true, running: false } }),
    });
    expect(screen.getByRole('status', { name: '補助プログラム' })).toHaveTextContent(
      '動いていません（雀魂の上ではボタンが効きません）',
    );
    expect(screen.queryByRole('button', { name: '管理者の補助プログラムを設定する' })).toBeNull();
    await user.click(screen.getByRole('button', { name: '起動する' }));
    expect(mock.count('start_helper')).toBe(1);
    await user.click(screen.getByRole('button', { name: '設定を解除する' }));
    expect(mock.count('remove_helper')).toBe(1);
  });

  it('W-9 登録の有無をまだ確かめていない間は、設定のボタンを出さない（設定済みなのに確認を出さないため）', async () => {
    await renderPage({ inputStatus: status({ helper: { installed: null } }) });
    expect(screen.queryByRole('button', { name: '管理者の補助プログラムを設定する' })).toBeNull();
  });

  it('W-9 設定・解除・起動の途中は、そのことを出し、ボタンを押せない', async () => {
    const mock = await renderPage({
      inputStatus: status({ helper: { installed: false, busy: 'installing' } }),
    });
    expect(screen.getByRole('status', { name: '補助プログラム' })).toHaveTextContent(
      '設定しています。Windows の確認が出たら、許可してください',
    );
    expect(screen.getByRole('button', { name: '管理者の補助プログラムを設定する' })).toBeDisabled();
    emitStatus(mock, status({ helper: { installed: true, running: false, busy: 'removing' } }));
    expect(await screen.findByText(/解除しています/)).toBeInTheDocument();
    expect(screen.getByRole('button', { name: '設定を解除する' })).toBeDisabled();
    emitStatus(mock, status({ helper: { installed: true, running: false, busy: 'starting' } }));
    expect(await screen.findByText('起動しています')).toBeInTheDocument();
  });

  it('W-9 失敗の理由（確認が取り消された など）を出す', async () => {
    await renderPage({
      inputStatus: status({ helper: { installed: false, error: 'Windows の確認が取り消されました' } }),
    });
    expect(await screen.findByRole('alert')).toHaveTextContent('Windows の確認が取り消されました');
  });

  it('W-9 補助プログラムが動き出したら（状態の変更）、表示が変わる', async () => {
    const mock = await renderPage();
    emitStatus(
      mock,
      status({ hook: 'helper', helper: { installed: true, running: true } }),
    );
    await waitFor(() =>
      expect(screen.getByRole('status', { name: '補助プログラム' })).toHaveTextContent('動いています'),
    );
  });

  it('W-9 設定のコマンドが失敗したら、理由を出す', async () => {
    const user = userEvent.setup();
    await renderPage({
      handlers: {
        setup_helper: () => {
          throw '補助プログラムを動かせませんでした';
        },
      },
    });
    await user.click(screen.getByRole('button', { name: '管理者の補助プログラムを設定する' }));
    expect(await screen.findByRole('alert')).toHaveTextContent('補助プログラムを動かせませんでした');
  });
});
