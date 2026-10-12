import { open, save } from '@tauri-apps/plugin-dialog';
import { render, screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { installTauriMock, type TauriMock } from '../../tests/tauri-mock';
import type { RecordsExported, RecordsOverview, RecordsPreview } from '../api/types';
import { RecordsBlock } from './RecordsBlock';
import { ShortcutGuardProvider } from './undo/shortcutGuard';

vi.mock('@tauri-apps/api/core', () => ({
  invoke: vi.fn(),
  convertFileSrc: (path: string) => path,
}));
vi.mock('@tauri-apps/api/event', () => ({ listen: vi.fn() }));
vi.mock('@tauri-apps/plugin-dialog', () => ({ open: vi.fn(), save: vi.fn() }));

const OVERVIEW: RecordsOverview = { sessions: 12, answers: 84, bytes: 420_000 };
const PICKED = 'C:\\Users\\test\\Documents\\jantama-records-20261009.json';
const CONFIRM_SENTENCE = 'いまの記録を、このファイルの内容に置き換えます（半荘 12・答え 84）。元には戻せません。';

/** 試験の「いま」: 2026 年 10 月 12 日（書き出しの既定の名前の日付）。 */
beforeEach(() => {
  vi.useFakeTimers({ toFake: ['Date'] });
  vi.setSystemTime(new Date(2026, 9, 12, 22, 0, 0));
  vi.mocked(open).mockReset();
  vi.mocked(save).mockReset();
});

afterEach(() => {
  vi.useRealTimers();
});

interface Handlers {
  overview?: RecordsOverview | (() => never);
  exported?: RecordsExported | (() => never);
  inspect?: RecordsPreview | (() => never);
  imported?: RecordsPreview | (() => never);
}

function setup(handlers: Handlers = {}, props: Partial<Parameters<typeof RecordsBlock>[0]> = {}): TauriMock {
  const reply = <T,>(value: T | (() => never) | undefined, fallback: T) => () =>
    typeof value === 'function' ? (value as () => never)() : (value ?? fallback);
  const mock = installTauriMock({
    handlers: {
      records_overview: reply(handlers.overview, OVERVIEW),
      export_records: reply(handlers.exported, { path: PICKED, sessions: 12, answers: 84, bytes: 420_000 }),
      inspect_records_file: reply(handlers.inspect, { sessions: 12, answers: 84, held: 0 }),
      import_records: reply(handlers.imported, { sessions: 12, answers: 84, held: 0 }),
    },
  });
  render(
    <ShortcutGuardProvider>
      <RecordsBlock {...props} />
    </ShortcutGuardProvider>,
  );
  return mock;
}

/** 呼ばれたコマンドの引数（名前の順）。 */
function argsOf(mock: TauriMock, cmd: string): unknown[] {
  return mock
    .calls()
    .filter((c) => c.cmd === cmd)
    .map((c) => c.args);
}

describe('記録の書き出しの欄（D-2、R11-14）', () => {
  it('入るものの一覧・入らないものの注意・ファイルの名前と大きさ・「書き出す」「読み込む」を出す。説明の文は、説明のアイコンの中', async () => {
    setup();
    const group = screen.getByRole('group', { name: '記録の書き出し' });
    expect(within(group).getByRole('button', { name: '書き出す' })).toBeEnabled();
    expect(within(group).getByRole('button', { name: '読み込む' })).toBeEnabled();
    expect(group).toHaveTextContent(
      '答え・解き直しの予定・迷いの結びつけ・自分の評価（〇△✕）・MAKA の評価・メモ・週の成績・設定',
    );
    expect(group).toHaveTextContent(
      'スクショと Mortal の結果は含みません。すべて残すときは、データの保存先のフォルダごと写してください。',
    );
    // 既定のファイルの名前（今日の日付）と、おおよその大きさ（数え終えてから）
    await waitFor(() => expect(group).toHaveTextContent('jantama-records-20261012.json（1つ・約 410 KB）'));
    // 説明の文は、本文には出さず、説明のアイコン（InfoTip）に入れる。2 つのボタンの説明にもなる
    const tip = within(group).getByRole('button', { name: '記録の書き出しの説明' });
    expect(tip).toHaveAttribute('aria-describedby', 'export-help');
    expect(document.getElementById('export-help')).toHaveTextContent(
      '記録をまとめて 1 つのファイル（JSON）に書き出します。書き出したファイルを読み込むと、記録が元に戻ります。',
    );
    expect(document.getElementById('export-help')).toHaveAttribute('hidden');
    expect(group.textContent).not.toContain('記録をまとめて 1 つのファイル');
    expect(within(group).getByRole('button', { name: '書き出す' })).toHaveAttribute('aria-describedby', 'export-help');
  });

  it('大きさが数えられなくても、ファイルの名前は出す（大きさは出さない）', async () => {
    const failing = () => {
      throw 'データの保存先を開けません';
    };
    const mock = setup({ overview: failing });
    const group = screen.getByRole('group', { name: '記録の書き出し' });
    await waitFor(() => expect(mock.count('records_overview')).toBe(1));
    expect(group).toHaveTextContent('jantama-records-20261012.json（1つ）');
    expect(group.textContent).not.toContain('KB');
  });

  it('「書き出す」: 保存のダイアログ（既定の名前 jantama-records-YYYYMMDD.json）で選んだ場所へ書き、知らせにファイルの名前と大きさを出す', async () => {
    const user = userEvent.setup();
    vi.mocked(save).mockResolvedValue(PICKED);
    const mock = setup();
    await user.click(screen.getByRole('button', { name: '書き出す' }));
    expect(vi.mocked(save)).toHaveBeenCalledWith(
      expect.objectContaining({ defaultPath: 'jantama-records-20261012.json' }),
    );
    expect(argsOf(mock, 'export_records')).toEqual([{ path: PICKED }]);
    const done = await screen.findByRole('status');
    expect(done).toHaveTextContent('書き出しました。jantama-records-20261009.json（約 410 KB）');
    // 知らせにキーボードの位置が移る
    await waitFor(() => expect(done).toHaveFocus());
  });

  it('「書き出す」: ダイアログをやめたら、何も書かない・何も出さない', async () => {
    const user = userEvent.setup();
    vi.mocked(save).mockResolvedValue(null);
    const mock = setup();
    await user.click(screen.getByRole('button', { name: '書き出す' }));
    expect(mock.count('export_records')).toBe(0);
    expect(screen.queryByRole('status')).toBeNull();
    expect(screen.queryByRole('alert')).toBeNull();
  });

  it('「書き出す」: 書けなかったら、理由を出す（書き出した知らせは出さない）', async () => {
    const user = userEvent.setup();
    vi.mocked(save).mockResolvedValue(PICKED);
    setup({
      exported: () => {
        throw 'ファイルを書けませんでした: アクセスが拒否されました';
      },
    });
    await user.click(screen.getByRole('button', { name: '書き出す' }));
    expect(await screen.findByRole('alert')).toHaveTextContent('ファイルを書けませんでした: アクセスが拒否されました');
    expect(screen.queryByText(/書き出しました/)).toBeNull();
  });

  it('「読み込む」: 選んだファイルを全部確かめてから、確認を出す。確認の文に半荘と答えの数。既定のボタンは「やめる」', async () => {
    const user = userEvent.setup();
    vi.mocked(open).mockResolvedValue(PICKED);
    const mock = setup();
    await user.click(screen.getByRole('button', { name: '読み込む' }));
    expect(argsOf(mock, 'inspect_records_file')).toEqual([{ path: PICKED }]);
    const dialog = await screen.findByRole('alertdialog', { name: 'このファイルの記録を読み込みますか' });
    expect(dialog).toHaveAttribute('aria-modal', 'true');
    expect(dialog).toHaveTextContent(`jantama-records-20261009.json${CONFIRM_SENTENCE}`);
    expect(within(dialog).getAllByRole('button').map((b) => b.textContent)).toEqual(['置き換える', 'やめる']);
    expect(within(dialog).getByRole('button', { name: 'やめる' })).toHaveFocus();
    // 確かめただけでは、何も置き換えない
    expect(mock.count('import_records')).toBe(0);
  });

  it('確認に、この保存先に半荘のフォルダが無い半荘の件数を足す（無ければ出さない）', async () => {
    const user = userEvent.setup();
    vi.mocked(open).mockResolvedValue(PICKED);
    setup({ inspect: { sessions: 12, answers: 84, held: 3 } });
    await user.click(screen.getByRole('button', { name: '読み込む' }));
    const dialog = await screen.findByRole('alertdialog');
    expect(dialog).toHaveTextContent(CONFIRM_SENTENCE);
    expect(dialog).toHaveTextContent('保存先に無い半荘が 3 件あります。そのフォルダを保存先に写すと、記録が付きます。');
  });

  it('確認の文に、取っておく半荘が無いときは、その 1 文を出さない', async () => {
    const user = userEvent.setup();
    vi.mocked(open).mockResolvedValue(PICKED);
    setup();
    await user.click(screen.getByRole('button', { name: '読み込む' }));
    expect(await screen.findByRole('alertdialog')).not.toHaveTextContent('保存先に無い半荘');
  });

  it('Esc で何もせずに閉じ、「読み込む」にキーボードの位置を戻す。背景を押しても閉じる', async () => {
    const user = userEvent.setup();
    vi.mocked(open).mockResolvedValue(PICKED);
    const changes: boolean[] = [];
    const mock = setup({}, { onModalChange: (isOpen) => changes.push(isOpen) });
    const importButton = screen.getByRole('button', { name: '読み込む' });
    await user.click(importButton);
    await screen.findByRole('alertdialog');
    expect(changes.at(-1)).toBe(true);
    await user.keyboard('{Escape}');
    expect(screen.queryByRole('alertdialog')).toBeNull();
    expect(changes.at(-1)).toBe(false);
    await waitFor(() => expect(importButton).toHaveFocus());
    expect(mock.count('import_records')).toBe(0);
    expect(screen.queryByRole('status')).toBeNull();

    // もう一度開いて、背景を押す
    await user.click(importButton);
    const dialog = await screen.findByRole('alertdialog');
    const backdrop = dialog.parentElement as HTMLElement;
    await user.pointer([{ target: backdrop, keys: '[MouseLeft]' }]);
    expect(screen.queryByRole('alertdialog')).toBeNull();
    expect(mock.count('import_records')).toBe(0);
  });

  it('確認の中では、Tab が 2 つのボタンの間だけを回る', async () => {
    const user = userEvent.setup();
    vi.mocked(open).mockResolvedValue(PICKED);
    setup();
    await user.click(screen.getByRole('button', { name: '読み込む' }));
    const dialog = await screen.findByRole('alertdialog');
    const inside = within(dialog).getAllByRole('button');
    const seen: Element[] = [];
    for (let i = 0; i < 5; i += 1) {
      await user.tab();
      seen.push(document.activeElement as Element);
    }
    expect(seen.every((el) => inside.includes(el as HTMLElement))).toBe(true);
    await user.tab({ shift: true });
    expect(inside.includes(document.activeElement as HTMLElement)).toBe(true);
  });

  it('「置き換える」: 読み込んで、「読み込みました（半荘 12・答え 84）。…」を出す。呼んだ側には、置き換えたと知らせる', async () => {
    const user = userEvent.setup();
    vi.mocked(open).mockResolvedValue(PICKED);
    const replaced: string[] = [];
    const mock = setup({}, { onReplaced: (text) => replaced.push(text) });
    await user.click(screen.getByRole('button', { name: '読み込む' }));
    await user.click(await screen.findByRole('button', { name: '置き換える' }));
    expect(argsOf(mock, 'import_records')).toEqual([{ path: PICKED }]);
    const done = await screen.findByRole('status');
    const text = '読み込みました（半荘 12・答え 84）。スクショと Mortal の結果は、データの保存先にあるものを使います。';
    expect(done).toHaveTextContent(text);
    expect(replaced).toEqual([text]);
    expect(screen.queryByRole('alertdialog')).toBeNull();
    await waitFor(() => expect(done).toHaveFocus());
  });

  it('取っておく半荘があったときは、読み込んだあとの知らせにも、その件数を出す', async () => {
    const user = userEvent.setup();
    vi.mocked(open).mockResolvedValue(PICKED);
    setup({
      inspect: { sessions: 12, answers: 84, held: 2 },
      imported: { sessions: 12, answers: 84, held: 2 },
    });
    await user.click(screen.getByRole('button', { name: '読み込む' }));
    await user.click(await screen.findByRole('button', { name: '置き換える' }));
    expect(await screen.findByRole('status')).toHaveTextContent(
      '保存先に無い半荘 2 件の記録は、そのフォルダを保存先に写したときに付きます。',
    );
  });

  it('呼んだ側が知らせの文を渡したら（読み込んだあとの画面の読み直し）、最初から出して、キーボードの位置を移す', async () => {
    setup({}, { initialNotice: '読み込みました（半荘 3・答え 4）。' });
    const done = screen.getByRole('status');
    expect(done).toHaveTextContent('読み込みました（半荘 3・答え 4）。');
    await waitFor(() => expect(done).toHaveFocus());
  });

  it('ファイルを確かめて正しくなければ、確認は出さず、理由を出す。何も置き換えない', async () => {
    const user = userEvent.setup();
    vi.mocked(open).mockResolvedValue(PICKED);
    const mock = setup({
      inspect: () => {
        throw 'このファイルは、新しい版のアプリで書き出されています（ファイルの版 2。このアプリは 1 まで）。アプリを新しくしてください。いまの記録は変わっていません。';
      },
    });
    await user.click(screen.getByRole('button', { name: '読み込む' }));
    expect(await screen.findByRole('alert')).toHaveTextContent('アプリを新しくしてください');
    expect(screen.queryByRole('alertdialog')).toBeNull();
    expect(mock.count('import_records')).toBe(0);
  });

  it('置き換えに失敗したら、理由を出す（読み込んだ知らせは出さない）', async () => {
    const user = userEvent.setup();
    vi.mocked(open).mockResolvedValue(PICKED);
    const replaced: string[] = [];
    setup(
      {
        imported: () => {
          throw '記録を入れ替えている途中で失敗しました: ここで失敗。いまの記録は変わっていません。';
        },
      },
      { onReplaced: (text) => replaced.push(text) },
    );
    await user.click(screen.getByRole('button', { name: '読み込む' }));
    await user.click(await screen.findByRole('button', { name: '置き換える' }));
    expect(await screen.findByRole('alert')).toHaveTextContent('いまの記録は変わっていません');
    expect(screen.queryByText(/読み込みました/)).toBeNull();
    expect(replaced).toEqual([]);
  });

  it('ファイルを選ぶダイアログをやめたら、何も出さない', async () => {
    const user = userEvent.setup();
    vi.mocked(open).mockResolvedValue(null);
    const mock = setup();
    await user.click(screen.getByRole('button', { name: '読み込む' }));
    expect(mock.count('inspect_records_file')).toBe(0);
    expect(screen.queryByRole('alertdialog')).toBeNull();
  });
});
