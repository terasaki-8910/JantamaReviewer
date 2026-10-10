import { open as openDialog } from '@tauri-apps/plugin-dialog';
import { act, render, screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { beforeEach, describe, expect, it, vi } from 'vitest';

import {
  COPIED_LINK,
  COPIED_PAIPU_ID,
  FX4_ID,
  FX4_TEXT,
  fx4Session,
  importHandlers,
} from '../../tests/import-fixtures';
import { installTauriMock, type TauriMock } from '../../tests/tauri-mock';
import type { SessionRecord } from '../api/types';
import { ANNOUNCED_STORAGE_KEY } from './announced';
import { App } from './App';
import { formatSessionShort } from './format';

vi.mock('@tauri-apps/api/core', () => ({
  invoke: vi.fn(),
  convertFileSrc: (path: string) => path,
}));
vi.mock('@tauri-apps/api/event', () => ({ listen: vi.fn() }));
vi.mock('@tauri-apps/plugin-dialog', () => ({ open: vi.fn() }));

const HOUR = 60 * 60 * 1000;
const IMPORT_BUTTON = '検討結果を取り込む';

/** 試験の間は実際の時計を使うので、半荘の開始は「いま」からの相対で作る（直近 7 日の絞り込みに入るように）。 */
function recordedSession(id = '20261009-190953', ago = 17 * HOUR): SessionRecord {
  return fx4Session(id, Date.now() - ago);
}

async function openImport(user: ReturnType<typeof userEvent.setup>) {
  await user.click(screen.getByRole('button', { name: IMPORT_BUTTON }));
  await screen.findByRole('heading', { level: 1, name: IMPORT_BUTTON });
}

/** 取り込みのページで、牌譜リンクを見つけた状態まで進める。 */
async function openImportWithLink(user: ReturnType<typeof userEvent.setup>) {
  await openImport(user);
  await screen.findByRole('heading', { name: 'コピーした牌譜リンクを見つけました' });
}

/** 「mjai で検討する」を押して、mjai の窓で結果を待つ状態にする。 */
async function startMjai(user: ReturnType<typeof userEvent.setup>) {
  await openImportWithLink(user);
  await user.click(screen.getByRole('button', { name: 'mjai で検討する' }));
  await screen.findByRole('heading', { name: 'mjai の窓で Submit を押してください' });
}

function reportFound(mock: TauriMock, id = FX4_ID) {
  act(() => mock.emit('mjai-window', { kind: 'report_found', id }));
}

function lastCall(mock: TauriMock, cmd: string) {
  return mock
    .calls()
    .filter((c) => c.cmd === cmd)
    .at(-1)?.args;
}

beforeEach(() => {
  vi.mocked(openDialog).mockReset();
});

describe('サイドバーの「検討結果を取り込む」', () => {
  it('サイドバーの上に、主な操作として置く。押すと取り込みのページになり、いまのページに印が付く', async () => {
    installTauriMock({ handlers: importHandlers([]) });
    const user = userEvent.setup();
    render(<App />);
    const side = screen.getByRole('complementary', { name: 'サイドバー' });
    const button = within(side).getByRole('button', { name: IMPORT_BUTTON });
    expect(button).toHaveClass('primary');
    expect(button).not.toHaveAttribute('aria-current');
    // ブランドと ← → のすぐ下、行き先（解き直し・ログ・週の集計）より前にある。
    const order = Array.from(side.querySelectorAll('button')).map((b) => b.getAttribute('title'));
    expect(order.slice(0, 4)).toEqual(['戻る（Alt+←）', '進む（Alt+→）', IMPORT_BUTTON, 'あとで作ります']);

    await user.click(button);
    expect(await screen.findByRole('heading', { level: 1, name: IMPORT_BUTTON })).toBeInTheDocument();
    expect(button).toHaveAttribute('aria-current', 'page');
    expect(screen.getByRole('button', { name: '設定' })).not.toHaveAttribute('aria-current');
  });
});

describe('牌譜リンクを待つ（E-15）', () => {
  it('クリップボードが空なら、そう伝えて、雀魂での手順を案内する。代わりの取り込み方も出す', async () => {
    installTauriMock({ handlers: importHandlers([], { read_clipboard_text: () => null }) });
    const user = userEvent.setup();
    render(<App />);
    await openImport(user);
    expect(await screen.findByRole('heading', { name: '牌譜リンクがありません' })).toBeInTheDocument();
    expect(screen.getByText('クリップボードが空です。')).toBeInTheDocument();
    expect(screen.getByText(/雀魂で「牌譜を共有」→「コピー」をしてから/)).toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'クリップボードを調べ直す' })).toBeInTheDocument();
    expect(screen.queryByRole('button', { name: 'mjai で検討する' })).toBeNull();
    // mjai の窓が使えないときの代わり（結果の URL を貼る・JSON ファイルを開く）。
    expect(screen.getByLabelText('mjai の結果の URL')).toBeInTheDocument();
    expect(screen.getByRole('button', { name: '結果の JSON ファイルを開く' })).toBeInTheDocument();
  });

  it('牌譜でない文字なら、リンクが無いと伝える。調べ直すと、新しくコピーしたリンクを見つける', async () => {
    let clipboard: string | null = 'おはようございます https://example.com/';
    installTauriMock({ handlers: importHandlers([], { read_clipboard_text: () => clipboard }) });
    const user = userEvent.setup();
    render(<App />);
    await openImport(user);
    expect(await screen.findByText('クリップボードに、雀魂の牌譜リンクがありません。')).toBeInTheDocument();
    clipboard = COPIED_LINK;
    await user.click(screen.getByRole('button', { name: 'クリップボードを調べ直す' }));
    expect(
      await screen.findByRole('heading', { name: 'コピーした牌譜リンクを見つけました' }),
    ).toBeInTheDocument();
  });

  it('クリップボードを読めなければ、その理由を出す', async () => {
    installTauriMock({
      handlers: importHandlers([], {
        read_clipboard_text: () => {
          throw 'クリップボードを読めませんでした: 別のアプリが使っています';
        },
      }),
    });
    const user = userEvent.setup();
    render(<App />);
    await openImport(user);
    expect(await screen.findByText(/別のアプリが使っています/)).toBeInTheDocument();
  });

  it('見つけたリンクは、雀魂の牌譜の ID の前後だけを出す（アカウントの番号は出さない）。日付も添える', async () => {
    installTauriMock({ handlers: importHandlers([]) });
    const user = userEvent.setup();
    render(<App />);
    await openImportWithLink(user);
    const panel = screen.getByRole('heading', { name: 'コピーした牌譜リンクを見つけました' }).closest('section');
    expect(panel).not.toBeNull();
    const text = panel?.textContent ?? '';
    expect(text).toContain('game.mahjongsoul.com/?paipu=261009-7c1e…89ab');
    expect(text).not.toContain('12345');
    expect(text).not.toContain('雀魂牌譜');
    expect(text).toContain('10月9日の半荘');
    expect(screen.getByRole('button', { name: 'mjai で検討する' })).toHaveClass('primary');
    expect(screen.getByText(/Mortal 4\.1b balanced/)).toBeInTheDocument();
  });
});

describe('mjai の窓', () => {
  it('「mjai で検討する」で窓を開き（牌譜リンクと背景の色を渡す）、Submit を待つ。やめるで閉じて戻る', async () => {
    const mock = installTauriMock({ handlers: importHandlers([]) });
    const user = userEvent.setup();
    render(<App />);
    await startMjai(user);
    expect(lastCall(mock, 'open_mjai_window')).toEqual({
      link: 'https://game.mahjongsoul.com/?paipu=261009-7c1e9b2a-4f3d-4e11-8a55-0123456789ab_a12345',
      background: expect.any(String),
    });
    expect(screen.getByText(/窓の Submit を押してください/)).toBeInTheDocument();
    expect(screen.getByText(/AI の答えは、ここには出ません/)).toBeInTheDocument();
    // 窓が使えないときの代わりの取り込み方も、待っている間に使える。
    expect(screen.getByLabelText('mjai の結果の URL')).toBeInTheDocument();

    await user.click(screen.getByRole('button', { name: '窓を前面に出す' }));
    expect(mock.count('open_mjai_window')).toBe(2);

    await user.click(screen.getByRole('button', { name: 'やめる' }));
    expect(mock.count('close_mjai_window')).toBe(1);
    expect(
      await screen.findByRole('heading', { name: 'コピーした牌譜リンクを見つけました' }),
    ).toBeInTheDocument();
  });

  it('窓を開けなければ、理由つきの失敗の画面にする', async () => {
    installTauriMock({
      handlers: importHandlers([], {
        open_mjai_window: () => {
          throw 'mjai の窓を開けませんでした: x';
        },
      }),
    });
    const user = userEvent.setup();
    render(<App />);
    await openImportWithLink(user);
    await user.click(screen.getByRole('button', { name: 'mjai で検討する' }));
    expect(await screen.findByRole('heading', { name: 'mjai の窓を開けませんでした' })).toBeInTheDocument();
    expect(screen.getByRole('alert')).toHaveTextContent('mjai の窓を開けませんでした: x');
  });

  it('結果が出る前に窓が閉じられたら、取り込みを中止して、理由を伝える', async () => {
    const mock = installTauriMock({ handlers: importHandlers([]) });
    const user = userEvent.setup();
    render(<App />);
    await startMjai(user);
    act(() => mock.emit('mjai-window', { kind: 'closed' }));
    expect(await screen.findByRole('alert')).toHaveTextContent('mjai の窓が閉じられました');
    expect(await screen.findByRole('heading', { name: 'コピーした牌譜リンクを見つけました' })).toBeInTheDocument();
    expect(mock.count('fetch_report')).toBe(0);
  });

  it('窓を待っていないときの知らせは、無視する（前の取り込みの名残）', async () => {
    const mock = installTauriMock({ handlers: importHandlers([]) });
    const user = userEvent.setup();
    render(<App />);
    await openImportWithLink(user);
    reportFound(mock);
    act(() => mock.emit('mjai-window', { kind: 'closed' }));
    await new Promise((resolve) => setTimeout(resolve, 20));
    expect(mock.count('fetch_report')).toBe(0);
    expect(screen.getByRole('heading', { name: 'コピーした牌譜リンクを見つけました' })).toBeInTheDocument();
  });
});

describe('取り込みの流れ（結果が見つかってから）', () => {
  it('結果を取り、検査し、画像を読んで、記録した半荘に結びつけ、まとめを出す。半荘を開ける', async () => {
    const session = recordedSession();
    const mock = installTauriMock({ handlers: importHandlers([session]), sessions: [session] });
    const user = userEvent.setup();
    render(<App />);
    await startMjai(user);
    reportFound(mock);

    expect(await screen.findByRole('heading', { name: '取り込みました' })).toBeInTheDocument();
    expect(lastCall(mock, 'fetch_report')).toEqual({ id: FX4_ID });
    expect(lastCall(mock, 'ocr_sessions')).toEqual({ sessionIds: [session.id] });
    expect(lastCall(mock, 'save_report')).toEqual({ sessionId: session.id, text: FX4_TEXT });
    expect(lastCall(mock, 'replace_links')).toEqual({
      sessionId: session.id,
      links: {
        marks: { '1': 'k0h0e4', '2': 'k1h0e13', '3': 'k1h1e7' },
        ratings: { '7': 'k0h0', '8': 'k1h0', '9': 'k1h1', '10': 'k2h0', '11': 'k2h1' },
      },
    });

    const panel = screen.getByRole('heading', { name: '取り込みました' }).closest('section') as HTMLElement;
    expect(within(panel).getByText('玉の間・南')).toBeInTheDocument();
    expect(within(panel).getByText('93.0')).toBeInTheDocument();
    expect(panel.textContent).toMatch(/判断 70/);
    expect(panel.textContent).toMatch(/大きな不一致 \d+/);
    expect(panel.textContent).toContain('迷い 6');
    expect(panel.textContent).toContain('3つは局面に結びつけました。3つは選んでください');
    expect(panel.textContent).toContain('局の評価 5 件のうち、5 件を局に当てはめました');

    // 取り込んだ半荘を、半荘のページで開く（サイドバーの一覧で、その半荘の行に印が付く）。
    await user.click(
      within(panel).getByRole('button', { name: `${formatSessionShort(session.started_ms)} の半荘を開く` }),
    );
    expect(await screen.findByRole('heading', { level: 1, name: /\d+月\d+日/ })).toBeInTheDocument();
    expect(screen.getByRole('button', { name: /迷い6/ })).toHaveAttribute('aria-current', 'true');
  });

  it('段階の途中は「取り込んでいます」と、いま何をしているかを出す', async () => {
    let finishOcr: (value: unknown) => void = () => undefined;
    const session = recordedSession();
    const mock = installTauriMock({
      handlers: importHandlers([session], {
        ocr_sessions: () =>
          new Promise((resolve) => {
            finishOcr = resolve;
          }),
      }),
    });
    const user = userEvent.setup();
    render(<App />);
    await startMjai(user);
    reportFound(mock);
    expect(await screen.findByRole('heading', { name: '取り込んでいます' })).toBeInTheDocument();
    await waitFor(() =>
      expect(screen.getByRole('status')).toHaveTextContent('記録した画面から、局と点数を読み取っています'),
    );
    // 進み具合の知らせで、「3 / 6」と進み具合の棒が出る。
    act(() => mock.emit('ocr-progress', { done: 3, total: 6 }));
    expect(await screen.findByText(/（3 \/ 6）/)).toBeInTheDocument();
    expect(screen.getByRole('progressbar', { name: '画面の読み取りの進み具合' })).toHaveAttribute('value', '3');
    finishOcr([]);
    expect(await screen.findByRole('heading', { name: /どの半荘の結果か|取り込みました/ })).toBeInTheDocument();
  });

  it('結果が取れなければ、理由を出して失敗にする。「最初からやり直す」で戻る', async () => {
    const mock = installTauriMock({
      handlers: importHandlers([], {
        fetch_report: () => {
          throw 'mjai のサイトに、この結果がありません（期限が切れて消えた可能性があります）。';
        },
      }),
    });
    const user = userEvent.setup();
    render(<App />);
    await startMjai(user);
    reportFound(mock);
    expect(await screen.findByRole('heading', { name: '結果を受け取れませんでした' })).toBeInTheDocument();
    expect(screen.getByRole('alert')).toHaveTextContent('期限が切れて消えた可能性');
    expect(mock.count('save_report')).toBe(0);
    await user.click(screen.getByRole('button', { name: '最初からやり直す' }));
    expect(
      await screen.findByRole('heading', { name: 'コピーした牌譜リンクを見つけました' }),
    ).toBeInTheDocument();
  });

  it('牌譜を再生して検討結果と合わなければ、局と巡目を含む理由を出して、何も保存しない', async () => {
    const broken = JSON.parse(FX4_TEXT) as {
      review: { kyokus: Array<{ entries: Array<{ state: { tehai: string[] } }> }> };
    };
    broken.review.kyokus[0]!.entries[0]!.state.tehai.fill('9s');
    const mock = installTauriMock({
      handlers: importHandlers([recordedSession()], { fetch_report: () => JSON.stringify(broken) }),
    });
    const user = userEvent.setup();
    render(<App />);
    await startMjai(user);
    reportFound(mock);
    expect(await screen.findByRole('heading', { name: '牌譜と検討結果が合いません' })).toBeInTheDocument();
    expect(screen.getByRole('alert').textContent).toMatch(/東1局 \d+巡目: 手牌が記録と一致しません/);
    expect(mock.count('ocr_sessions')).toBe(0);
    expect(mock.count('save_report')).toBe(0);
  });

  it('JSON でないものは、「JSON を読めませんでした」と伝える', async () => {
    const mock = installTauriMock({
      handlers: importHandlers([], { fetch_report: () => '<html>error</html>' }),
    });
    const user = userEvent.setup();
    render(<App />);
    await startMjai(user);
    reportFound(mock);
    expect(await screen.findByRole('heading', { name: '結果の JSON を読めませんでした' })).toBeInTheDocument();
    expect(mock.count('save_report')).toBe(0);
  });

  it('保存できなければ、失敗として出す', async () => {
    const session = recordedSession();
    const mock = installTauriMock({
      handlers: importHandlers([session], {
        save_report: () => {
          throw 'この半荘には、すでに結果が取り込まれています: x';
        },
      }),
    });
    const user = userEvent.setup();
    render(<App />);
    await startMjai(user);
    reportFound(mock);
    expect(await screen.findByRole('heading', { name: '保存できませんでした' })).toBeInTheDocument();
    expect(screen.getByRole('alert')).toHaveTextContent('すでに結果が取り込まれています');
    expect(mock.count('replace_links')).toBe(0);
  });

  it('記録した半荘が無ければ、画像は読まずに、記録の無い半荘として取り込む', async () => {
    const mock = installTauriMock({ handlers: importHandlers([]) });
    const user = userEvent.setup();
    render(<App />);
    await startMjai(user);
    reportFound(mock);
    expect(await screen.findByRole('heading', { name: '取り込みました' })).toBeInTheDocument();
    expect(mock.count('ocr_sessions')).toBe(0);
    expect(lastCall(mock, 'save_report')).toEqual({ sessionId: null, text: FX4_TEXT });
    expect(mock.count('replace_links')).toBe(0);
    expect(screen.getByText(/記録の無い半荘として取り込みました/)).toBeInTheDocument();
    expect(screen.getByText('93.0')).toBeInTheDocument();
  });

  it('合う半荘が複数あれば、新しい順に並べて選んでもらう。選んだ半荘に結びつける', async () => {
    const older = recordedSession('20261009-190000', 30 * HOUR);
    const newer = recordedSession('20261009-210000', 10 * HOUR);
    const mock = installTauriMock({ handlers: importHandlers([older, newer]) });
    const user = userEvent.setup();
    render(<App />);
    await startMjai(user);
    reportFound(mock);
    expect(await screen.findByRole('heading', { name: 'どの半荘の結果か、選んでください' })).toBeInTheDocument();
    const list = screen.getByRole('list', { name: '結びつける半荘の一覧（新しい順）' });
    const rows = within(list).getAllByRole('button');
    expect(rows).toHaveLength(2);
    expect(rows[0]).toHaveTextContent(formatSessionShort(newer.started_ms));
    expect(rows[1]).toHaveTextContent(formatSessionShort(older.started_ms));
    for (const row of rows) {
      expect(row).toHaveTextContent('迷い 6');
      expect(row).toHaveTextContent('画面が合う');
    }
    expect(mock.count('save_report')).toBe(0);

    await user.click(rows[1] as HTMLElement);
    expect(await screen.findByRole('heading', { name: '取り込みました' })).toBeInTheDocument();
    expect(lastCall(mock, 'save_report')).toEqual({ sessionId: older.id, text: FX4_TEXT });
    expect(lastCall(mock, 'replace_links')).toMatchObject({ sessionId: older.id });
  });

  it('一覧で「どれでもない」を選ぶと、記録の無い半荘として取り込む', async () => {
    const mock = installTauriMock({
      handlers: importHandlers([recordedSession('a', 30 * HOUR), recordedSession('b', 10 * HOUR)]),
    });
    const user = userEvent.setup();
    render(<App />);
    await startMjai(user);
    reportFound(mock);
    await screen.findByRole('heading', { name: 'どの半荘の結果か、選んでください' });
    await user.click(screen.getByRole('button', { name: /どれでもない/ }));
    expect(await screen.findByRole('heading', { name: '取り込みました' })).toBeInTheDocument();
    expect(lastCall(mock, 'save_report')).toEqual({ sessionId: null, text: FX4_TEXT });
  });

  it('文字認識が使えなければ、その理由を添えて、半荘を選んでもらう', async () => {
    const mock = installTauriMock({
      handlers: importHandlers([recordedSession()], {
        ocr_sessions: () => {
          throw 'Windows の日本語の文字認識が使えません。';
        },
      }),
    });
    const user = userEvent.setup();
    render(<App />);
    await startMjai(user);
    reportFound(mock);
    expect(await screen.findByRole('heading', { name: 'どの半荘の結果か、選んでください' })).toBeInTheDocument();
    expect(screen.getByText(/日本語の文字認識が使えません/)).toBeInTheDocument();
    expect(screen.getByText(/合うものが、見つかりませんでした/)).toBeInTheDocument();
  });

  it('取り込みのページを開いたまま、終わった取り込みの上でサイドバーのボタンを押すと、新しく始める', async () => {
    const mock = installTauriMock({ handlers: importHandlers([]) });
    const user = userEvent.setup();
    render(<App />);
    await startMjai(user);
    reportFound(mock);
    await screen.findByRole('heading', { name: '取り込みました' });
    await user.click(screen.getByRole('button', { name: IMPORT_BUTTON }));
    expect(
      await screen.findByRole('heading', { name: 'コピーした牌譜リンクを見つけました' }),
    ).toBeInTheDocument();
  });

  it('終わった取り込みから半荘を開いたあとは、次に取り込みを開くと、新しく始まる（古い結果が残らない）', async () => {
    const session = recordedSession();
    const mock = installTauriMock({ handlers: importHandlers([session]), sessions: [session] });
    const user = userEvent.setup();
    render(<App />);
    await startMjai(user);
    reportFound(mock);
    const done = await screen.findByRole('heading', { name: '取り込みました' });
    await user.click(
      within(done.closest('section') as HTMLElement).getByRole('button', { name: /の半荘を開く/ }),
    );
    await screen.findByRole('heading', { level: 1, name: /\d+月\d+日/ });
    await user.click(screen.getByRole('button', { name: IMPORT_BUTTON }));
    expect(
      await screen.findByRole('heading', { name: 'コピーした牌譜リンクを見つけました' }),
    ).toBeInTheDocument();
    expect(screen.queryByRole('heading', { name: '取り込みました' })).toBeNull();
  });

  it('取り込みの途中で別のページへ移っても、戻ると続きが見える（窓からの知らせを取りこぼさない）', async () => {
    const mock = installTauriMock({ handlers: importHandlers([]) });
    const user = userEvent.setup();
    render(<App />);
    await startMjai(user);
    await user.click(screen.getByRole('button', { name: '設定' }));
    await screen.findByRole('heading', { level: 1, name: '設定' });
    reportFound(mock);
    await waitFor(() => expect(mock.count('save_report')).toBe(1));
    await user.click(screen.getByRole('button', { name: IMPORT_BUTTON }));
    expect(await screen.findByRole('heading', { name: '取り込みました' })).toBeInTheDocument();
  });
});

describe('代わりの取り込み方（F1）', () => {
  it('結果の URL を貼ると、結果の ID を取り出して、取り込む', async () => {
    const mock = installTauriMock({
      handlers: importHandlers([], { read_clipboard_text: () => null }),
    });
    const user = userEvent.setup();
    render(<App />);
    await openImport(user);
    await screen.findByRole('heading', { name: '牌譜リンクがありません' });
    const url = `https://mjai.ekyu.moe/killerducky/?data=/report/${FX4_ID}.json`;
    await user.type(screen.getByLabelText('mjai の結果の URL'), url);
    await user.click(screen.getByRole('button', { name: 'この URL で取り込む' }));
    expect(await screen.findByRole('heading', { name: '取り込みました' })).toBeInTheDocument();
    expect(lastCall(mock, 'report_id_from_text')).toEqual({ text: url });
    expect(lastCall(mock, 'fetch_report')).toEqual({ id: FX4_ID });
  });

  it('Enter キーでも取り込める（日本語入力の変換中の Enter は、取り込みにしない）', async () => {
    const mock = installTauriMock({
      handlers: importHandlers([], { read_clipboard_text: () => null }),
    });
    const user = userEvent.setup();
    render(<App />);
    await openImport(user);
    await screen.findByRole('heading', { name: '牌譜リンクがありません' });
    await user.type(screen.getByLabelText('mjai の結果の URL'), `${FX4_ID}{Enter}`);
    expect(await screen.findByRole('heading', { name: '取り込みました' })).toBeInTheDocument();
    expect(mock.count('fetch_report')).toBe(1);
  });

  it('結果の URL が見つからない文字なら、その旨を出して、取りに行かない。空の間はボタンが押せない', async () => {
    const mock = installTauriMock({
      handlers: importHandlers([], { read_clipboard_text: () => null }),
    });
    const user = userEvent.setup();
    render(<App />);
    await openImport(user);
    await screen.findByRole('heading', { name: '牌譜リンクがありません' });
    const button = screen.getByRole('button', { name: 'この URL で取り込む' });
    expect(button).toBeDisabled();
    await user.type(screen.getByLabelText('mjai の結果の URL'), 'これは URL ではありません');
    expect(button).toBeEnabled();
    await user.click(button);
    expect(await screen.findByRole('alert')).toHaveTextContent('結果の URL が見つかりません');
    expect(mock.count('fetch_report')).toBe(0);
  });

  it('mjai の窓を開いて待っている間に URL を貼ると、窓を閉じて取り込む', async () => {
    const mock = installTauriMock({ handlers: importHandlers([]) });
    const user = userEvent.setup();
    render(<App />);
    await startMjai(user);
    await user.type(screen.getByLabelText('mjai の結果の URL'), FX4_ID);
    await user.click(screen.getByRole('button', { name: 'この URL で取り込む' }));
    expect(await screen.findByRole('heading', { name: '取り込みました' })).toBeInTheDocument();
    expect(mock.count('close_mjai_window')).toBe(1);
  });

  it('結果の JSON ファイルを選ぶと、読み込んで取り込む。選ばなければ何もしない', async () => {
    const mock = installTauriMock({
      handlers: importHandlers([], { read_clipboard_text: () => null }),
    });
    const user = userEvent.setup();
    render(<App />);
    await openImport(user);
    await screen.findByRole('heading', { name: '牌譜リンクがありません' });

    vi.mocked(openDialog).mockResolvedValueOnce(null);
    await user.click(screen.getByRole('button', { name: '結果の JSON ファイルを開く' }));
    expect(mock.count('read_report_file_text')).toBe(0);

    vi.mocked(openDialog).mockResolvedValueOnce('C:\\Users\\test\\Downloads\\report.json');
    await user.click(screen.getByRole('button', { name: '結果の JSON ファイルを開く' }));
    expect(await screen.findByRole('heading', { name: '取り込みました' })).toBeInTheDocument();
    expect(lastCall(mock, 'read_report_file_text')).toEqual({ path: 'C:\\Users\\test\\Downloads\\report.json' });
    expect(vi.mocked(openDialog)).toHaveBeenLastCalledWith({
      multiple: false,
      directory: false,
      filters: [{ name: '検討結果の JSON', extensions: ['json'] }],
    });
  });

  it('ファイルを読めなければ、理由を出す', async () => {
    installTauriMock({
      handlers: importHandlers([], {
        read_clipboard_text: () => null,
        read_report_file_text: () => {
          throw '結果の JSON ファイル（拡張子が .json のもの）を選んでください。';
        },
      }),
    });
    const user = userEvent.setup();
    render(<App />);
    await openImport(user);
    await screen.findByRole('heading', { name: '牌譜リンクがありません' });
    vi.mocked(openDialog).mockResolvedValueOnce('C:\\x\\report.txt');
    await user.click(screen.getByRole('button', { name: '結果の JSON ファイルを開く' }));
    expect(await screen.findByRole('heading', { name: '結果のファイルを読めませんでした' })).toBeInTheDocument();
    expect(screen.getByRole('alert')).toHaveTextContent('拡張子が .json');
  });
});

describe('「この半荘を取り込みますか」（E-15）', () => {
  it('検討画面が前面に来たとき、新しい牌譜リンクを見つけたら、一度だけ知らせる', async () => {
    const mock = installTauriMock({ handlers: importHandlers([]) });
    const user = userEvent.setup();
    render(<App />);
    act(() => mock.emit('main-window-focused', null));
    const offer = await screen.findByRole('status');
    expect(offer).toHaveTextContent('この半荘を取り込みますか');
    expect(offer).toHaveTextContent('10月9日の半荘');
    expect(window.localStorage.getItem(ANNOUNCED_STORAGE_KEY)).toBe(JSON.stringify([COPIED_PAIPU_ID]));

    await user.click(within(offer).getByRole('button', { name: 'あとで' }));
    expect(screen.queryByText(/この半荘を取り込みますか/)).toBeNull();
    // 同じ牌譜 ID は、もう知らせない（何度前面に来ても）。
    const before = mock.count('read_clipboard_text');
    act(() => mock.emit('main-window-focused', null));
    await waitFor(() => expect(mock.count('read_clipboard_text')).toBe(before + 1));
    window.dispatchEvent(new Event('focus'));
    await waitFor(() => expect(mock.count('read_clipboard_text')).toBe(before + 2));
    expect(screen.queryByText(/この半荘を取り込みますか/)).toBeNull();
  });

  it('前面に来たときの 3 つの知らせ（Rust 側・画面の focus・表示の変化）が重なって届いても、クリップボードを読むのは 1 回', async () => {
    // 読み取りが重なると、実機でヒープが壊れて落ちた（Rust 側は鍵で守ってあるが、同じ答えを何度も取らない）。
    const mock = installTauriMock({
      handlers: importHandlers([], { read_clipboard_text: () => null }),
    });
    render(<App />);
    const before = mock.count('read_clipboard_text');
    act(() => {
      mock.emit('main-window-focused', null);
      window.dispatchEvent(new Event('focus'));
      document.dispatchEvent(new Event('visibilitychange'));
    });
    await waitFor(() => expect(mock.count('read_clipboard_text')).toBe(before + 1));
    await new Promise((resolve) => setTimeout(resolve, 30));
    expect(mock.count('read_clipboard_text')).toBe(before + 1);
    // 終わったあとの次の知らせは、また読む。
    act(() => mock.emit('main-window-focused', null));
    await waitFor(() => expect(mock.count('read_clipboard_text')).toBe(before + 2));
  });

  it('「取り込む」を押すと、取り込みのページで、そのリンクの案内が出る', async () => {
    const mock = installTauriMock({ handlers: importHandlers([]) });
    const user = userEvent.setup();
    render(<App />);
    act(() => mock.emit('main-window-focused', null));
    await user.click(await screen.findByRole('button', { name: '取り込む' }));
    expect(await screen.findByRole('heading', { level: 1, name: IMPORT_BUTTON })).toBeInTheDocument();
    expect(
      await screen.findByRole('heading', { name: 'コピーした牌譜リンクを見つけました' }),
    ).toBeInTheDocument();
    expect(screen.queryByText('この半荘を取り込みますか')).toBeNull();
  });

  it('前に知らせた牌譜 ID は、アプリを開き直しても知らせない', async () => {
    window.localStorage.setItem(ANNOUNCED_STORAGE_KEY, JSON.stringify([COPIED_PAIPU_ID]));
    const mock = installTauriMock({ handlers: importHandlers([]) });
    render(<App />);
    act(() => mock.emit('main-window-focused', null));
    await waitFor(() => expect(mock.count('read_clipboard_text')).toBe(1));
    await new Promise((resolve) => setTimeout(resolve, 20));
    expect(screen.queryByText(/この半荘を取り込みますか/)).toBeNull();
  });

  it('牌譜でない文字・空のクリップボードでは、知らせない', async () => {
    let clipboard: string | null = 'ただの文章 https://example.com/';
    const mock = installTauriMock({
      handlers: importHandlers([], { read_clipboard_text: () => clipboard }),
    });
    render(<App />);
    act(() => mock.emit('main-window-focused', null));
    await waitFor(() => expect(mock.count('read_clipboard_text')).toBe(1));
    clipboard = null;
    act(() => mock.emit('main-window-focused', null));
    await waitFor(() => expect(mock.count('read_clipboard_text')).toBe(2));
    expect(screen.queryByText(/この半荘を取り込みますか/)).toBeNull();
  });

  it('取り込みの途中（mjai の窓を待っている間など）は、知らせない', async () => {
    const mock = installTauriMock({ handlers: importHandlers([]) });
    const user = userEvent.setup();
    render(<App />);
    await startMjai(user);
    const before = mock.count('read_clipboard_text');
    act(() => mock.emit('main-window-focused', null));
    await new Promise((resolve) => setTimeout(resolve, 20));
    expect(mock.count('read_clipboard_text')).toBe(before);
    expect(screen.queryByText('この半荘を取り込みますか')).toBeNull();
  });

  it('取り込みのページを開いているときは、ページ自身が案内するので、知らせの帯は出さない', async () => {
    const mock = installTauriMock({ handlers: importHandlers([]) });
    const user = userEvent.setup();
    render(<App />);
    await openImportWithLink(user);
    act(() => mock.emit('main-window-focused', null));
    await waitFor(() => expect(mock.count('read_clipboard_text')).toBeGreaterThanOrEqual(2));
    expect(screen.queryByRole('button', { name: 'あとで' })).toBeNull();
  });
});
