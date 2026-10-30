import { open } from '@tauri-apps/plugin-dialog';
import { act, render, screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { baseSettings, baseState, installTauriMock, type TauriMock } from '../../tests/tauri-mock';
import type { ReadsModelStatus } from '../api/reads';
import { ReadsModelBlock } from './ReadsModelBlock';
import { SettingsPage } from './SettingsPage';

vi.mock('@tauri-apps/api/core', () => ({
  invoke: vi.fn(),
  convertFileSrc: (path: string) => path,
}));
vi.mock('@tauri-apps/api/event', () => ({ listen: vi.fn() }));
vi.mock('@tauri-apps/plugin-dialog', () => ({ open: vi.fn(), save: vi.fn() }));

const MODEL_BYTES = 4_013_332;
const GROUP = '解析のモデル';
const META = 'hhim8826/mortal3-b40c192 · AGPL-3.0 · 天鳳の鳳凰卓 160 万局で学習';
const HELP =
  '他家の聴牌と待ちを読むモデルです（F23）。押したときだけ huggingface.co から取ります。半荘の画面の「読み」で使います。天鳳の牌譜で学習したモデルです。';
const SHA_ERROR = '取ったファイルが、決まった版と違います（sha256）。もう一度試してください';
const NOT_THE_MODEL = 'このファイルは決まった読みのモデルではありません（sha256 が違います）';

function status(patch: Partial<ReadsModelStatus> = {}): ReadsModelStatus {
  return {
    installed: false,
    bytes: null,
    sha256: null,
    downloading: false,
    repo: 'hhim8826/mortal3-b40c192',
    revision: '7784a9deddf63df03f023474116f715850d3c7a0',
    file: 'tenpai.onnx',
    license: 'AGPL-3.0',
    origin: '天鳳の鳳凰卓 160 万局で学習',
    ...patch,
  };
}

const NOT_INSTALLED = status();
const INSTALLED = status({
  installed: true,
  bytes: MODEL_BYTES,
  sha256: '50893ddca230bd90c678086bc8e3b9fe229492b5c9f15fe8145149464b8c1cea',
});

interface Deferred<T> {
  promise: Promise<T>;
  resolve: (value: T) => void;
  reject: (reason: unknown) => void;
}

function deferred<T>(): Deferred<T> {
  let resolve!: (value: T) => void;
  let reject!: (reason: unknown) => void;
  const promise = new Promise<T>((res, rej) => {
    resolve = res;
    reject = rej;
  });
  return { promise, resolve, reject };
}

type Handlers = NonNullable<Parameters<typeof installTauriMock>[0]>['handlers'];

/** Tauri の偽物。モデルの命令（通信するのは本体。ここでは本物の通信をしない）の答えを、試験ごとに決める。 */
function setup(handlers: Handlers = {}): TauriMock {
  return installTauriMock({
    handlers: { get_reads_model: () => NOT_INSTALLED, ...handlers },
  });
}

async function renderBlock(handlers: Handlers = {}) {
  const mock = setup(handlers);
  render(<ReadsModelBlock />);
  const group = await screen.findByRole('group', { name: GROUP });
  return { mock, group };
}

beforeEach(() => {
  vi.mocked(open).mockReset();
});

afterEach(() => {
  vi.useRealTimers();
});

describe('設定の「解析のモデル」の欄（F24、U-54）', () => {
  it('入っていないとき: 状態・出どころ・「Hugging Face から取る」と「ファイルを選ぶ…」を出す。主な操作の見た目にはしない', async () => {
    const { group } = await renderBlock();
    expect(within(group).getByText('読みのモデル')).toBeInTheDocument();
    expect(within(group).getByRole('status')).toHaveTextContent('入っていません');
    expect(within(group).getByText(META)).toBeInTheDocument();
    const download = within(group).getByRole('button', { name: 'Hugging Face から取る' });
    const choose = within(group).getByRole('button', { name: 'ファイルを選ぶ…' });
    expect(download).toBeEnabled();
    expect(choose).toBeEnabled();
    // 低頻度の操作が、いちばん目立つ要素にならない（主な操作の塗りにしない）
    expect(download).not.toHaveClass('primary');
    expect(choose).not.toHaveClass('primary');
    expect(within(group).queryByRole('button', { name: '消す' })).toBeNull();
    expect(within(group).queryByRole('button', { name: '取り消す' })).toBeNull();
    expect(within(group).queryByRole('alert')).toBeNull();
  });

  it('説明のアイコンが、行の名前のそばにあり、決まった文を持つ。ボタンの読み上げの説明にもなる', async () => {
    const { group } = await renderBlock();
    const tip = within(group).getByRole('button', { name: '読みのモデルの説明' });
    const label = within(group).getByText('読みのモデル');
    // アイコンは、行の名前のすぐ隣
    expect(label.parentElement).toBe(tip.closest('.ex-head'));
    expect(document.getElementById('reads-model-help')).toHaveTextContent(HELP);
    for (const name of ['Hugging Face から取る', 'ファイルを選ぶ…']) {
      expect(within(group).getByRole('button', { name })).toHaveAccessibleDescription(HELP);
    }
  });

  it('入っているとき: 大きさつきの状態と、「消す」だけを出す（取る・選ぶは出さない）', async () => {
    const { group } = await renderBlock({ get_reads_model: () => INSTALLED });
    expect(within(group).getByRole('status')).toHaveTextContent('入っています（4.0 MB）');
    expect(within(group).getByText(META)).toBeInTheDocument();
    expect(within(group).getByRole('button', { name: '消す' })).toBeEnabled();
    expect(within(group).queryByRole('button', { name: 'Hugging Face から取る' })).toBeNull();
    expect(within(group).queryByRole('button', { name: 'ファイルを選ぶ…' })).toBeNull();
  });

  it('本体の状態が読めない（答えが無い）間は、欄を出さない', async () => {
    setup({ get_reads_model: () => undefined });
    const { container } = render(<ReadsModelBlock />);
    await act(async () => {
      await new Promise((resolve) => setTimeout(resolve, 20));
    });
    expect(container).toBeEmptyDOMElement();
  });

  it('状態を読めなかったときは、理由だけを出す（ボタンは出さない）', async () => {
    setup({
      get_reads_model: () => {
        throw 'モデルの置き場を開けません';
      },
    });
    render(<ReadsModelBlock />);
    const alert = await screen.findByRole('alert');
    expect(alert).toHaveTextContent('読みのモデルの状態を読めませんでした: モデルの置き場を開けません');
    const group = screen.getByRole('group', { name: GROUP });
    expect(within(group).queryByRole('button', { name: /取る|選ぶ|消す/ })).toBeNull();
  });

  describe('取る', () => {
    it('押すと取り始め、取っている間は「取り消す」だけが押せる。進み具合の知らせで、済んだ分と全体が出る', async () => {
      const user = userEvent.setup();
      const download = deferred<ReadsModelStatus>();
      const { mock, group } = await renderBlock({ download_reads_model: () => download.promise });
      await user.click(within(group).getByRole('button', { name: 'Hugging Face から取る' }));
      expect(mock.count('download_reads_model')).toBe(1);
      // 取っている間: 最初の知らせが届くまでは、数を出さない
      const state = within(group).getByRole('status');
      expect(state).toHaveTextContent('取っています…');
      expect(state).not.toHaveTextContent('MB');
      expect(within(group).getByRole('button', { name: '取り消す' })).toBeEnabled();
      expect(within(group).queryByRole('button', { name: 'Hugging Face から取る' })).toBeNull();
      expect(within(group).queryByRole('button', { name: 'ファイルを選ぶ…' })).toBeNull();
      // 進み具合
      act(() => mock.emit('reads-model-progress', { done: 1_200_000, total: MODEL_BYTES }));
      expect(state).toHaveTextContent('取っています… 1.2 / 4.0 MB');
      act(() => mock.emit('reads-model-progress', { done: 3_000_000, total: MODEL_BYTES }));
      expect(state).toHaveTextContent('取っています… 3.0 / 4.0 MB');
      // 取り終えると、入っている状態になり、キーボードの位置は「消す」へ移る
      await act(async () => {
        download.resolve(INSTALLED);
        await download.promise;
      });
      expect(within(group).getByRole('status')).toHaveTextContent('入っています（4.0 MB）');
      await waitFor(() => expect(within(group).getByRole('button', { name: '消す' })).toHaveFocus());
      expect(within(group).queryByRole('alert')).toBeNull();
    });

    it('全体の大きさを告げられないときは、済んだ分だけを出す', async () => {
      const user = userEvent.setup();
      const download = deferred<ReadsModelStatus>();
      const { mock, group } = await renderBlock({ download_reads_model: () => download.promise });
      await user.click(within(group).getByRole('button', { name: 'Hugging Face から取る' }));
      act(() => mock.emit('reads-model-progress', { done: 1_200_000, total: null }));
      expect(within(group).getByRole('status')).toHaveTextContent(/^取っています… 1\.2 MB$/);
    });

    it('Enter キーだけでも取り始められる（キーボードだけで操作できる）', async () => {
      const user = userEvent.setup();
      const download = deferred<ReadsModelStatus>();
      const { mock, group } = await renderBlock({ download_reads_model: () => download.promise });
      within(group).getByRole('button', { name: 'Hugging Face から取る' }).focus();
      await user.keyboard('{Enter}');
      expect(mock.count('download_reads_model')).toBe(1);
    });

    it('失敗したら、理由を出して、状態を読み直す。もう一度押せて、キーボードの位置は「取る」へ戻る', async () => {
      const user = userEvent.setup();
      let calls = 0;
      const { mock, group } = await renderBlock({
        download_reads_model: () => {
          calls += 1;
          if (calls === 1) throw SHA_ERROR;
          return INSTALLED;
        },
      });
      const download = within(group).getByRole('button', { name: 'Hugging Face から取る' });
      await user.click(download);
      const alert = await within(group).findByRole('alert');
      expect(alert).toHaveTextContent(SHA_ERROR);
      expect(within(group).getByRole('status')).toHaveTextContent('入っていません');
      // 本体の状態を読み直している（最初の 1 回と、失敗のあとの 1 回）
      expect(mock.count('get_reads_model')).toBe(2);
      await waitFor(() =>
        expect(within(group).getByRole('button', { name: 'Hugging Face から取る' })).toHaveFocus(),
      );
      expect(within(group).getByRole('button', { name: 'ファイルを選ぶ…' })).toBeEnabled();
      // もう一度押すと、前の理由は消えて、入る
      await user.click(within(group).getByRole('button', { name: 'Hugging Face から取る' }));
      await waitFor(() => expect(within(group).getByRole('status')).toHaveTextContent('入っています（4.0 MB）'));
      expect(within(group).queryByRole('alert')).toBeNull();
    });

    it('取り消す: 取り消しの命令を呼び、押せなくして「取り消しています…」にする。取り消し終えたら、エラーにせず、入っていない状態へ戻る', async () => {
      const user = userEvent.setup();
      const download = deferred<ReadsModelStatus>();
      const { mock, group } = await renderBlock({
        download_reads_model: () => download.promise,
        cancel_reads_model_download: () => undefined,
      });
      await user.click(within(group).getByRole('button', { name: 'Hugging Face から取る' }));
      await user.click(within(group).getByRole('button', { name: '取り消す' }));
      expect(mock.count('cancel_reads_model_download')).toBe(1);
      expect(within(group).getByRole('status')).toHaveTextContent('取り消しています…');
      expect(within(group).getByRole('button', { name: '取り消す' })).toBeDisabled();
      // 本体が、取り消して終わる（入っていない状態を返す）
      await act(async () => {
        download.resolve(NOT_INSTALLED);
        await download.promise;
      });
      expect(within(group).getByRole('status')).toHaveTextContent('入っていません');
      expect(within(group).queryByRole('alert')).toBeNull();
      await waitFor(() =>
        expect(within(group).getByRole('button', { name: 'Hugging Face から取る' })).toHaveFocus(),
      );
    });

    it('取り消しの命令が失敗したら、理由を出して、取り消しをやり直せる', async () => {
      const user = userEvent.setup();
      const download = deferred<ReadsModelStatus>();
      const { group } = await renderBlock({
        download_reads_model: () => download.promise,
        cancel_reads_model_download: () => {
          throw '取り消せませんでした';
        },
      });
      await user.click(within(group).getByRole('button', { name: 'Hugging Face から取る' }));
      await user.click(within(group).getByRole('button', { name: '取り消す' }));
      expect(await within(group).findByRole('alert')).toHaveTextContent('取り消せませんでした');
      expect(within(group).getByRole('button', { name: '取り消す' })).toBeEnabled();
    });

    it('この画面を開いたとき、すでに取っている最中なら、その表示を出し、終わるまで本体の状態を読み直す', async () => {
      vi.useFakeTimers({ toFake: ['setInterval', 'clearInterval'] });
      let reads = 0;
      const { mock, group } = await renderBlock({
        get_reads_model: () => {
          reads += 1;
          return reads < 3 ? status({ downloading: true }) : INSTALLED;
        },
      });
      expect(within(group).getByRole('status')).toHaveTextContent('取っています…');
      expect(within(group).getByRole('button', { name: '取り消す' })).toBeEnabled();
      expect(mock.count('download_reads_model')).toBe(0);
      await act(async () => {
        await vi.advanceTimersByTimeAsync(1000);
      });
      expect(within(group).getByRole('status')).toHaveTextContent('取っています…');
      await act(async () => {
        await vi.advanceTimersByTimeAsync(1000);
      });
      expect(within(group).getByRole('status')).toHaveTextContent('入っています（4.0 MB）');
      expect(within(group).getByRole('button', { name: '消す' })).toBeInTheDocument();
    });
  });

  describe('ファイルを選ぶ', () => {
    it('.onnx だけを選ぶダイアログを開き、選んだパスで本体に頼む。決まった版なら、入っている状態になる', async () => {
      const user = userEvent.setup();
      vi.mocked(open).mockResolvedValue('C:\\Users\\test\\Downloads\\tenpai.onnx');
      const { mock, group } = await renderBlock({ choose_reads_model_file: () => INSTALLED });
      await user.click(within(group).getByRole('button', { name: 'ファイルを選ぶ…' }));
      expect(open).toHaveBeenCalledTimes(1);
      const options = vi.mocked(open).mock.calls[0]?.[0];
      expect(options).toMatchObject({ multiple: false, directory: false });
      expect(options?.filters).toEqual([{ name: '読みのモデル（ONNX）', extensions: ['onnx'] }]);
      await waitFor(() => expect(within(group).getByRole('status')).toHaveTextContent('入っています（4.0 MB）'));
      const call = mock.calls().find((c) => c.cmd === 'choose_reads_model_file');
      expect(call?.args).toEqual({ path: 'C:\\Users\\test\\Downloads\\tenpai.onnx' });
      await waitFor(() => expect(within(group).getByRole('button', { name: '消す' })).toHaveFocus());
    });

    it('ダイアログをやめたら、何もしない', async () => {
      const user = userEvent.setup();
      vi.mocked(open).mockResolvedValue(null);
      const { mock, group } = await renderBlock();
      await user.click(within(group).getByRole('button', { name: 'ファイルを選ぶ…' }));
      expect(open).toHaveBeenCalledTimes(1);
      expect(mock.count('choose_reads_model_file')).toBe(0);
      expect(within(group).getByRole('status')).toHaveTextContent('入っていません');
      expect(within(group).queryByRole('alert')).toBeNull();
    });

    it('決まった版でないファイルなら、本体が返した理由を出す', async () => {
      const user = userEvent.setup();
      vi.mocked(open).mockResolvedValue('C:\\x\\other.onnx');
      const { group } = await renderBlock({
        choose_reads_model_file: () => {
          throw NOT_THE_MODEL;
        },
      });
      await user.click(within(group).getByRole('button', { name: 'ファイルを選ぶ…' }));
      expect(await within(group).findByRole('alert')).toHaveTextContent(NOT_THE_MODEL);
      expect(within(group).getByRole('status')).toHaveTextContent('入っていません');
      expect(within(group).getByRole('button', { name: 'ファイルを選ぶ…' })).toBeEnabled();
    });

    it('ダイアログを開けなかったら、その理由を出す', async () => {
      const user = userEvent.setup();
      vi.mocked(open).mockRejectedValue(new Error('ダイアログを開けません'));
      const { mock, group } = await renderBlock();
      await user.click(within(group).getByRole('button', { name: 'ファイルを選ぶ…' }));
      expect(await within(group).findByRole('alert')).toHaveTextContent('ダイアログを開けません');
      expect(mock.count('choose_reads_model_file')).toBe(0);
    });

    it('確かめている間は、状態の行が「確かめています…」になり、どのボタンも押せない', async () => {
      const user = userEvent.setup();
      vi.mocked(open).mockResolvedValue('C:\\x\\tenpai.onnx');
      const choosing = deferred<ReadsModelStatus>();
      const { group } = await renderBlock({ choose_reads_model_file: () => choosing.promise });
      await user.click(within(group).getByRole('button', { name: 'ファイルを選ぶ…' }));
      await waitFor(() => expect(within(group).getByRole('status')).toHaveTextContent('確かめています…'));
      expect(within(group).getByRole('button', { name: 'Hugging Face から取る' })).toBeDisabled();
      expect(within(group).getByRole('button', { name: 'ファイルを選ぶ…' })).toBeDisabled();
      await act(async () => {
        choosing.resolve(INSTALLED);
        await choosing.promise;
      });
      expect(within(group).getByRole('status')).toHaveTextContent('入っています（4.0 MB）');
    });
  });

  describe('消す', () => {
    it('押すと本体に頼み、入っていない状態へ戻る。キーボードの位置は「取る」へ移る', async () => {
      const user = userEvent.setup();
      const { mock, group } = await renderBlock({
        get_reads_model: () => INSTALLED,
        delete_reads_model: () => NOT_INSTALLED,
      });
      await user.click(within(group).getByRole('button', { name: '消す' }));
      expect(mock.count('delete_reads_model')).toBe(1);
      await waitFor(() => expect(within(group).getByRole('status')).toHaveTextContent('入っていません'));
      expect(within(group).getByRole('button', { name: 'Hugging Face から取る' })).toBeInTheDocument();
      await waitFor(() =>
        expect(within(group).getByRole('button', { name: 'Hugging Face から取る' })).toHaveFocus(),
      );
    });

    it('消している間は、状態の行が「消しています…」になり、押せない。失敗したら理由を出し、入っているまま', async () => {
      const user = userEvent.setup();
      const deleting = deferred<ReadsModelStatus>();
      const { group } = await renderBlock({
        get_reads_model: () => INSTALLED,
        delete_reads_model: () => deleting.promise,
      });
      await user.click(within(group).getByRole('button', { name: '消す' }));
      expect(within(group).getByRole('status')).toHaveTextContent('消しています…');
      expect(within(group).getByRole('button', { name: '消す' })).toBeDisabled();
      await act(async () => {
        deleting.reject('モデルのファイルを消せませんでした: 使用中です');
        await deleting.promise.catch(() => undefined);
      });
      expect(await within(group).findByRole('alert')).toHaveTextContent('消せませんでした: 使用中です');
      expect(within(group).getByRole('status')).toHaveTextContent('入っています（4.0 MB）');
      expect(within(group).getByRole('button', { name: '消す' })).toBeEnabled();
    });
  });

  describe('キーボードと読み上げ', () => {
    it('Tab で、説明のアイコン → 取る → ファイルを選ぶ の順に届く', async () => {
      const user = userEvent.setup();
      const { group } = await renderBlock();
      within(group).getByRole('button', { name: '読みのモデルの説明' }).focus();
      await user.tab();
      expect(within(group).getByRole('button', { name: 'Hugging Face から取る' })).toHaveFocus();
      await user.tab();
      expect(within(group).getByRole('button', { name: 'ファイルを選ぶ…' })).toHaveFocus();
    });

    it('欄に名前があり、状態の行は行の名前を持つ。失敗の理由は alert で伝える', async () => {
      const user = userEvent.setup();
      const { group } = await renderBlock({
        download_reads_model: () => {
          throw SHA_ERROR;
        },
      });
      expect(group).toHaveAccessibleName(GROUP);
      expect(within(group).getByRole('status')).toHaveAccessibleName('読みのモデル');
      await user.click(within(group).getByRole('button', { name: 'Hugging Face から取る' }));
      expect(await within(group).findByRole('alert')).toHaveTextContent(SHA_ERROR);
    });

    it('取っている間は、欄が処理中（aria-busy）になる', async () => {
      const user = userEvent.setup();
      const download = deferred<ReadsModelStatus>();
      const { group } = await renderBlock({ download_reads_model: () => download.promise });
      expect(group).toHaveAttribute('aria-busy', 'false');
      await user.click(within(group).getByRole('button', { name: 'Hugging Face から取る' }));
      expect(group).toHaveAttribute('aria-busy', 'true');
    });
  });
});

describe('設定ページの中の「解析のモデル」', () => {
  it('設定の最後の欄として出る（更新の欄の手前）。ほかの欄の操作には影響しない', async () => {
    installTauriMock({
      state: baseState,
      settings: baseSettings,
      handlers: { get_reads_model: () => NOT_INSTALLED },
    });
    render(<SettingsPage />);
    const group = await screen.findByRole('group', { name: GROUP });
    const settings = group.closest('.settings');
    expect(settings).not.toBeNull();
    // 「記録の書き出し」「同期」より後ろにある
    const names = Array.from(settings?.children ?? []).map((child) => child.getAttribute('aria-labelledby'));
    expect(names.indexOf('reads-model-title')).toBeGreaterThan(names.indexOf('export-lbl'));
    expect(names.indexOf('reads-model-title')).toBeGreaterThan(names.indexOf('sync-lbl'));
    expect(screen.getByRole('button', { name: 'ボタンを登録' })).toBeEnabled();
  });
});
