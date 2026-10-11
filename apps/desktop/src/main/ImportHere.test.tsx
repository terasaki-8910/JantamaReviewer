/**
 * U-14 取り込み前の半荘のページから、その半荘に検討結果を取り込む（アプリ全体の中で）。
 * 取り込む半荘を決めてあるので、結びつけ先の照合（E-19）はしない。進み具合はそのページの中に出し（取り込みのページへ移らない）、
 * mjai の窓の題名には取り込み先を出す。画面から読んだ局・点数が結果と合わなければ、保存の前に聞く。
 * 取り込みの流れそのもの（検査・読み取り・保存）は ImportPage.test.tsx と importFlow.test.ts が確かめる。
 */
import { act, render, renderHook, screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { FakeSessionStore, local, seedSession } from '../../tests/fake-sessions';
import { COPIED_LINK, FX4_ID, FX4_TEXT, fx4Ocr, fx4Session, importHandlers } from '../../tests/import-fixtures';
import { installTauriMock, type TauriMock } from '../../tests/tauri-mock';
import type { OcrCache, SessionRecord } from '../api/types';
import { ANNOUNCED_STORAGE_KEY } from './announced';
import { App } from './App';
import { useImportFlow } from './useImportFlow';

vi.mock('@tauri-apps/api/core', () => ({
  invoke: vi.fn(),
  convertFileSrc: (path: string) => `asset://localhost/${encodeURIComponent(path)}`,
}));
vi.mock('@tauri-apps/api/event', () => ({ listen: vi.fn() }));
vi.mock('@tauri-apps/plugin-dialog', () => ({ open: vi.fn() }));

/** 試験の「いま」: 2026 年 10 月 9 日 22:00（日付を動かすのは Date だけ。タイマーは本物のまま）。 */
beforeEach(() => {
  vi.useFakeTimers({ toFake: ['Date'] });
  vi.setSystemTime(new Date(2026, 9, 9, 22, 0, 0));
  window.localStorage.removeItem(ANNOUNCED_STORAGE_KEY);
});
afterEach(() => {
  vi.useRealTimers();
});

const ID = '20261009-190953';
const ACTION = 'この半荘に検討結果を取り込む';

interface Options {
  /** 文字認識の結果。既定は FX-4（読み直しの行つき。迷い 6 も読める）。 */
  ocr?: OcrCache;
  handlers?: Record<string, (args: unknown) => unknown>;
  /** 取り込み前の半荘のほかに、結果の取り込み済みの半荘（FX-4 の別の半荘）を足す。 */
  withImported?: boolean;
  /** 文字認識を、これが済むまで待たせる（読み取りの途中の画面を見るため）。 */
  holdOcr?: Promise<void>;
}

function setup(options: Options = {}) {
  // 新しい順: 10月9日 19:09 の取り込み前の半荘（FX-4 の迷い 6・評価 5）→ 昨日の、取り込み前の半荘。
  const target = fx4Session(ID, local(2026, 10, 9, 19, 9));
  const older = seedSession(local(2026, 10, 8, 21, 0), { marks: 2, ratings: 1 });
  const seeds = [{ session: target }, older];
  if (options.withImported) {
    const done: SessionRecord = fx4Session('20261007-120000', local(2026, 10, 7, 12, 0), {
      report_path: 'C:\\data\\games\\20261007-120000\\report.json',
    });
    seeds.push({ session: done, report: 'fx4' } as { session: SessionRecord });
  }
  const store = new FakeSessionStore(seeds);
  const ocr = options.ocr ?? fx4Ocr({ retries: true });
  const importing = store.importHandlers(ocr);
  const hold = options.holdOcr;
  const mock = installTauriMock({
    handlers: {
      ...importHandlers([]),
      ...store.handlers,
      ...importing,
      ...(hold === undefined ? {} : { ocr_sessions: (args: unknown) => hold.then(() => importing.ocr_sessions?.(args)) }),
      ...options.handlers,
    },
  });
  const user = userEvent.setup();
  render(<App />);
  return { store, mock, user };
}

const calls = (mock: TauriMock, cmd: string) => mock.calls().filter((c) => c.cmd === cmd).map((c) => c.args);
const lastCall = (mock: TauriMock, cmd: string) => calls(mock, cmd).at(-1);
const found = (mock: TauriMock, id = FX4_ID) => act(() => mock.emit('mjai-window', { kind: 'report_found', id }));
const actionButton = () => screen.findByRole('button', { name: ACTION });
const panelOf = (heading: string) => screen.findByRole('heading', { name: heading }).then((h) => h.closest('section') as HTMLElement);

/** 半荘のページの見出し（10月9日 19:09 の半荘を開いている）。 */
const sessionHeading = () => screen.getByRole('heading', { level: 1, name: /10月9日\(金\) 19:09/ });

describe('U-14 この半荘に取り込む操作', () => {
  it('取り込み前の半荘のページに、主な操作として出る。取り込み済みの半荘には出ない', async () => {
    const { user } = setup({ withImported: true });
    const button = await actionButton();
    expect(button).toHaveClass('primary');
    expect(button).toBeEnabled();
    // 見出しの中（半荘の名前と同じ行）にある。ページの内容より前。
    expect(button.closest('header')).toBe(sessionHeading().closest('header'));
    // 取り込み済みの半荘（10月7日）には出ない。
    const list = screen.getByRole('navigation', { name: '半荘の一覧' });
    await user.click(within(list).getByRole('button', { name: /^12:00/ }));
    await screen.findByRole('heading', { level: 1, name: /10月7日/ });
    expect(screen.queryByRole('button', { name: ACTION })).toBeNull();
  });

  it('サイドバーの「検討結果を取り込む」とは別の操作（そちらは、今までどおり、取り込みのページを開く）', async () => {
    const { user } = setup();
    await actionButton();
    expect(screen.getAllByRole('button', { name: /検討結果を取り込む/ })).toHaveLength(2);
    await user.click(within(screen.getByRole('complementary', { name: 'サイドバー' })).getByRole('button', { name: '検討結果を取り込む' }));
    expect(await screen.findByRole('heading', { level: 1, name: '検討結果を取り込む' })).toBeInTheDocument();
    expect(screen.queryByRole('button', { name: ACTION })).toBeNull();
  });
});

describe('U-14 mjai の窓（題名に取り込み先を出す）と、ページの中の進み具合', () => {
  it('押すと、クリップボードの牌譜リンクで mjai の窓を開く。題名に出す取り込み先の呼び名を渡す。ページは移らず、Submit を待つ案内が、ページの中に出る', async () => {
    const { user, mock } = setup();
    await user.click(await actionButton());
    expect(await screen.findByRole('heading', { name: 'mjai の窓で Submit を押してください' })).toBeInTheDocument();
    expect(lastCall(mock, 'open_mjai_window')).toEqual({
      link: 'https://game.mahjongsoul.com/?paipu=261009-7c1e9b2a-4f3d-4e11-8a55-0123456789ab_a12345',
      background: expect.any(String),
      target: '10月9日 19:09',
    });
    // 取り込みのページへは移らない（半荘のページのまま。取り込みのページの見出しは無い）。
    expect(sessionHeading()).toBeInTheDocument();
    expect(screen.queryByRole('heading', { level: 1, name: '検討結果を取り込む' })).toBeNull();
    const panel = await panelOf('mjai の窓で Submit を押してください');
    expect(panel.textContent).toContain('取り込み先: 10月9日 19:09 の半荘');
    // 窓を開いている間は、操作は押せない。ページの内容（迷いのカード）はそのまま見える。
    expect(screen.getByRole('button', { name: ACTION })).toBeDisabled();
    expect(screen.getByRole('article', { name: '迷い1' })).toBeInTheDocument();
    // 窓を前面に出すと、同じ題名で開き直す（開いている窓の題名も、取り込み先のまま）。
    await user.click(within(panel).getByRole('button', { name: '窓を前面に出す' }));
    expect(calls(mock, 'open_mjai_window')).toHaveLength(2);
    expect(lastCall(mock, 'open_mjai_window')).toMatchObject({ target: '10月9日 19:09' });
  });

  it('「やめる」で窓を閉じて、案内を消す。もう一度押せる', async () => {
    const { user, mock } = setup();
    await user.click(await actionButton());
    const panel = await panelOf('mjai の窓で Submit を押してください');
    await user.click(within(panel).getByRole('button', { name: 'やめる' }));
    expect(mock.count('close_mjai_window')).toBe(1);
    await waitFor(() => expect(screen.queryByRole('heading', { name: 'mjai の窓で Submit を押してください' })).toBeNull());
    expect(screen.getByRole('button', { name: ACTION })).toBeEnabled();
  });

  it('結果が出ると、ページの中で取り込みが進む: 結果の取得・検査・読み取り（n / m）・保存。取り込みのページへは移らない', async () => {
    let finishOcr: () => void = () => undefined;
    const { user, mock, store } = setup({
      holdOcr: new Promise<void>((resolve) => {
        finishOcr = resolve;
      }),
    });
    await user.click(await actionButton());
    await screen.findByRole('heading', { name: 'mjai の窓で Submit を押してください' });
    found(mock);

    const panel = await panelOf('取り込んでいます');
    await waitFor(() => expect(panel.textContent).toContain('記録した画面から、局と点数を読み取っています'));
    act(() => mock.emit('ocr-progress', { done: 2, total: 6 }));
    expect(await within(panel).findByText('記録した画面から、局と点数を読み取っています（2 / 6）')).toBeInTheDocument();
    expect(within(panel).getByRole('progressbar', { name: '画面の読み取りの進み具合' })).toHaveAttribute('value', '2');
    expect(panel.textContent).toContain('取り込み先: 10月9日 19:09 の半荘');
    expect(sessionHeading()).toBeInTheDocument();
    expect(screen.queryByRole('heading', { level: 1, name: '検討結果を取り込む' })).toBeNull();

    // 読み取りが終われば、取り込み先の半荘に保存する（半荘を選ぶ画面は出ない）。
    finishOcr();
    expect(await screen.findByRole('heading', { name: '取り込みました' })).toBeInTheDocument();
    expect(lastCall(mock, 'fetch_report')).toEqual({ id: FX4_ID });
    expect(lastCall(mock, 'save_report')).toEqual({ sessionId: ID, text: FX4_TEXT });
    expect(screen.queryByRole('heading', { name: 'どの半荘の結果か、選んでください' })).toBeNull();
    expect(store.log).toContain(`save:${ID}`);
    // 保存した半荘のページが、取り込み済みの形（迷いのカードの推定・局の評価の表）になる。操作は消える。
    expect(await screen.findByRole('table', { name: '局の評価' })).toBeInTheDocument();
    expect(screen.queryByRole('button', { name: ACTION })).toBeNull();
    expect(within(screen.getByRole('article', { name: '迷い6' })).getByText('推定')).toBeInTheDocument();
  });

  it('結びつけ先の照合（E-19）はしない: 文字認識は、この半荘だけ。直近 7 日の外の半荘にも取り込める', async () => {
    const { user, mock } = setup();
    // 試験の「いま」は 10月9日 22:00。この半荘は、7 日より前にしておく。
    vi.setSystemTime(new Date(2026, 9, 30, 22, 0, 0));
    await user.click(await actionButton());
    await screen.findByRole('heading', { name: 'mjai の窓で Submit を押してください' });
    found(mock);
    await screen.findByRole('heading', { name: '取り込みました' });
    expect(calls(mock, 'ocr_sessions')).toEqual([{ sessionIds: [ID] }]);
    expect(lastCall(mock, 'save_report')).toMatchObject({ sessionId: ID });
  });

  it('知らせを閉じると、キーボードの位置は、押したボタンへ戻る（取り込みが済んだときは、見出しへ）', async () => {
    const { user, mock } = setup();
    await user.click(await actionButton());
    const panel = await panelOf('mjai の窓で Submit を押してください');
    await user.click(within(panel).getByRole('button', { name: 'やめる' }));
    await waitFor(() => expect(screen.getByRole('button', { name: ACTION })).toHaveFocus());

    await user.click(screen.getByRole('button', { name: ACTION }));
    await screen.findByRole('heading', { name: 'mjai の窓で Submit を押してください' });
    found(mock);
    const done = await panelOf('取り込みました');
    await user.click(within(done).getByRole('button', { name: '閉じる' }));
    // 取り込みが済んで、操作は消えている。見出しへ戻る。
    await waitFor(() => expect(sessionHeading()).toHaveFocus());
  });

  it('完了のあと、ページの中の知らせは「閉じる」で消える。取り込みのページには、古い結果が残らない', async () => {
    const { user, mock } = setup();
    await user.click(await actionButton());
    await screen.findByRole('heading', { name: 'mjai の窓で Submit を押してください' });
    found(mock);
    const done = await panelOf('取り込みました');
    expect(done.textContent).toMatch(/判断 70/);
    expect(done.textContent).toContain('迷い 6');
    expect(done.textContent).toContain('（迷い 6 つを、すべて推定で局面に結びつけました）');
    await user.click(within(done).getByRole('button', { name: '閉じる' }));
    await waitFor(() => expect(screen.queryByRole('heading', { name: '取り込みました' })).toBeNull());
    await user.click(
      within(screen.getByRole('complementary', { name: 'サイドバー' })).getByRole('button', { name: '検討結果を取り込む' }),
    );
    expect(await screen.findByRole('heading', { name: 'コピーした牌譜リンクを見つけました' })).toBeInTheDocument();
  });
});

describe('U-14 画面から読んだ局・点数が結果と合わないとき（保存の前に聞く）', () => {
  /** 迷い 2・4 と、評価 3 が、結果と合わない読み取り。 */
  function mismatching(): OcrCache {
    const cache = fx4Ocr();
    cache.entries['marks/m2.png'] = { lines: ['南 2 局', '个 4 0', '25000'] };
    cache.entries['marks/m4.png'] = { lines: ['東 2 局', '个 3 5', '17000'] };
    cache.entries['ratings/r3.png'] = { lines: ['西 1 局', '个 6 0', '25000'] };
    return cache;
  }

  it('合わなかった画面を挙げて、取り込むかどうかを聞く。聞いている間は、保存しない。「やめる」が主な操作', async () => {
    const { user, mock, store } = setup({ ocr: mismatching() });
    await user.click(await actionButton());
    await screen.findByRole('heading', { name: 'mjai の窓で Submit を押してください' });
    found(mock);
    const panel = await panelOf('画面から読んだ局・点数が、この結果と合いません');
    expect(panel.textContent).toContain('読めた 6 枚のうち、3 枚の局か点数が、取り込む結果と合いません');
    const items = within(within(panel).getByRole('list', { name: '結果と合わない画面' })).getAllByRole('listitem');
    expect(items.map((li) => li.textContent)).toEqual([
      '迷い2南2局・残り40・25,000点',
      '迷い4東2局・残り35・17,000点',
      '評価3局目西1局・残り60・25,000点',
    ]);
    expect(panel.textContent).toContain('10月9日 19:09 の半荘に取り込むと、結果はあとから入れ替えられません');
    expect(within(panel).getByRole('button', { name: 'やめる' })).toHaveClass('primary');
    expect(within(panel).getByRole('button', { name: 'それでも取り込む' })).not.toHaveClass('primary');
    expect(calls(mock, 'save_report')).toEqual([]);
    expect(store.log.filter((l) => l.startsWith('save:'))).toEqual([]);
    // 聞いている間、ほかの取り込みの案内は出ない（クリップボードの確認を止める）。ページも移らない。
    expect(sessionHeading()).toBeInTheDocument();
  });

  it('「やめる」: 何も保存せず、案内を消す。結果を取り込んでいない半荘のまま', async () => {
    const { user, mock, store } = setup({ ocr: mismatching() });
    await user.click(await actionButton());
    await screen.findByRole('heading', { name: 'mjai の窓で Submit を押してください' });
    found(mock);
    const panel = await panelOf('画面から読んだ局・点数が、この結果と合いません');
    await user.click(within(panel).getByRole('button', { name: 'やめる' }));
    await waitFor(() => expect(screen.queryByRole('heading', { name: /画面から読んだ局・点数/ })).toBeNull());
    expect(calls(mock, 'save_report')).toEqual([]);
    expect(store.session(ID).report_path).toBeNull();
    expect(screen.getByRole('button', { name: ACTION })).toBeEnabled();
  });

  it('「それでも取り込む」: この半荘に保存する。合わなかった迷いは、手で選ぶ（推定にしない）', async () => {
    const { user, mock, store } = setup({ ocr: mismatching() });
    await user.click(await actionButton());
    await screen.findByRole('heading', { name: 'mjai の窓で Submit を押してください' });
    found(mock);
    const panel = await panelOf('画面から読んだ局・点数が、この結果と合いません');
    await user.click(within(panel).getByRole('button', { name: 'それでも取り込む' }));
    expect(await screen.findByRole('heading', { name: '取り込みました' })).toBeInTheDocument();
    expect(lastCall(mock, 'save_report')).toEqual({ sessionId: ID, text: FX4_TEXT });
    expect(store.session(ID).report_path).not.toBeNull();
    await screen.findByRole('table', { name: '局の評価' });
    // 迷い 2・4 は、読んだ局・点数が結果の局に合わないので、手で選ぶ。ほかは推定。
    expect(within(screen.getByRole('article', { name: '迷い2' })).getByText('局面は決まっていません')).toBeInTheDocument();
    expect(within(screen.getByRole('article', { name: '迷い4' })).getByText('局面は決まっていません')).toBeInTheDocument();
    expect(within(screen.getByRole('article', { name: '迷い1' })).getByText('推定')).toBeInTheDocument();
  });

  it('文字認識が使えなくて何も読めないときは、食い違いは言えないので、聞かずに取り込む（理由を添える）', async () => {
    const { user, mock } = setup({
      handlers: {
        ocr_sessions: () => {
          throw 'Windows の日本語の文字認識が使えません。';
        },
      },
    });
    await user.click(await actionButton());
    await screen.findByRole('heading', { name: 'mjai の窓で Submit を押してください' });
    found(mock);
    const done = await panelOf('取り込みました');
    expect(done.textContent).toContain('日本語の文字認識が使えません');
    expect(screen.queryByRole('heading', { name: /画面から読んだ局・点数/ })).toBeNull();
  });
});

describe('U-14 確認の途中で取り込みのページへ移っても、同じ確認が出る', () => {
  it('合わない画面の確認は、取り込みのページにも出る（取り込み先も）。「やめる」で、何も保存せず、牌譜リンクを待つ状態へ戻る', async () => {
    const cache = fx4Ocr();
    cache.entries['marks/m2.png'] = { lines: ['南 2 局', '个 4 0', '25000'] };
    const { user, mock, store } = setup({ ocr: cache });
    await user.click(await actionButton());
    await screen.findByRole('heading', { name: 'mjai の窓で Submit を押してください' });
    found(mock);
    await screen.findByRole('heading', { name: '画面から読んだ局・点数が、この結果と合いません' });
    await user.click(
      within(screen.getByRole('complementary', { name: 'サイドバー' })).getByRole('button', { name: '検討結果を取り込む' }),
    );
    expect(await screen.findByRole('heading', { level: 1, name: '検討結果を取り込む' })).toBeInTheDocument();
    const panel = await panelOf('画面から読んだ局・点数が、この結果と合いません');
    expect(panel.textContent).toContain('迷い2');
    expect(panel.textContent).toContain('10月9日 19:09 の半荘に取り込むと、結果はあとから入れ替えられません');
    await user.click(within(panel).getByRole('button', { name: 'やめる' }));
    expect(await screen.findByRole('heading', { name: 'コピーした牌譜リンクを見つけました' })).toBeInTheDocument();
    expect(calls(mock, 'save_report')).toEqual([]);
    expect(store.session(ID).report_path).toBeNull();
  });

  it('取り込みのページで「それでも取り込む」を押すと、取り込み先の半荘に保存して、「取り込みました」になる', async () => {
    const cache = fx4Ocr();
    cache.entries['marks/m2.png'] = { lines: ['南 2 局', '个 4 0', '25000'] };
    const { user, mock } = setup({ ocr: cache });
    await user.click(await actionButton());
    await screen.findByRole('heading', { name: 'mjai の窓で Submit を押してください' });
    found(mock);
    await screen.findByRole('heading', { name: '画面から読んだ局・点数が、この結果と合いません' });
    await user.click(
      within(screen.getByRole('complementary', { name: 'サイドバー' })).getByRole('button', { name: '検討結果を取り込む' }),
    );
    await user.click(await screen.findByRole('button', { name: 'それでも取り込む' }));
    expect(await screen.findByRole('heading', { name: '取り込みました' })).toBeInTheDocument();
    expect(lastCall(mock, 'save_report')).toEqual({ sessionId: ID, text: FX4_TEXT });
  });
});

describe('U-14 始められないとき・失敗したとき', () => {
  it('クリップボードに牌譜リンクが無ければ、ページの上に理由と手順を出す。窓は開かない', async () => {
    const { user, mock } = setup({ handlers: { read_clipboard_text: () => 'おはようございます' } });
    await user.click(await actionButton());
    const notice = await screen.findByRole('alert');
    expect(notice).toHaveTextContent('クリップボードに、雀魂の牌譜リンクがありません。');
    expect(notice).toHaveTextContent('雀魂で「牌譜を共有」→「コピー」をしてから、もう一度押してください。');
    expect(mock.count('open_mjai_window')).toBe(0);
    expect(screen.getByRole('button', { name: ACTION })).toBeEnabled();
    expect(screen.queryByRole('heading', { name: 'mjai の窓で Submit を押してください' })).toBeNull();
  });

  it('クリップボードが空なら、そう伝える。もう一度押して牌譜リンクがあれば、始まり、理由は消える', async () => {
    let clipboard: string | null = null;
    const { user, mock } = setup({ handlers: { read_clipboard_text: () => clipboard } });
    await user.click(await actionButton());
    expect(await screen.findByRole('alert')).toHaveTextContent('クリップボードが空です。');
    clipboard = COPIED_LINK;
    await user.click(screen.getByRole('button', { name: ACTION }));
    await screen.findByRole('heading', { name: 'mjai の窓で Submit を押してください' });
    expect(screen.queryByRole('alert')).toBeNull();
    expect(mock.count('open_mjai_window')).toBe(1);
  });

  it('クリップボードを読めなければ、その理由を出す', async () => {
    const { user } = setup({
      handlers: {
        read_clipboard_text: () => {
          throw '別のアプリが使っています';
        },
      },
    });
    await user.click(await actionButton());
    expect(await screen.findByRole('alert')).toHaveTextContent('クリップボードを読めませんでした: 別のアプリが使っています');
  });

  it('mjai の窓を開けなければ、ページの中に失敗を出す。「閉じる」で消える', async () => {
    const { user } = setup({
      handlers: {
        open_mjai_window: () => {
          throw 'mjai の窓を開けませんでした: x';
        },
      },
    });
    await user.click(await actionButton());
    const panel = await panelOf('mjai の窓を開けませんでした');
    expect(within(panel).getByRole('alert')).toHaveTextContent('mjai の窓を開けませんでした: x');
    await user.click(within(panel).getByRole('button', { name: '閉じる' }));
    await waitFor(() => expect(screen.queryByRole('heading', { name: 'mjai の窓を開けませんでした' })).toBeNull());
    expect(screen.getByRole('button', { name: ACTION })).toBeEnabled();
  });

  it('結果が出る前に窓が閉じられたら、ページの中に、取り込みを中止したことを出す', async () => {
    const { user, mock } = setup();
    await user.click(await actionButton());
    await screen.findByRole('heading', { name: 'mjai の窓で Submit を押してください' });
    act(() => mock.emit('mjai-window', { kind: 'closed' }));
    const panel = await panelOf('取り込みを中止しました');
    expect(within(panel).getByRole('alert')).toHaveTextContent('結果が出る前に、mjai の窓が閉じられました');
    expect(mock.count('fetch_report')).toBe(0);
  });

  it('牌譜と結果が合わないときは、理由をページの中に出す。何も保存しない', async () => {
    const broken = JSON.parse(FX4_TEXT) as { review: { kyokus: Array<{ entries: Array<{ state: { tehai: string[] } }> }> } };
    for (const i of [0, 1, 2]) broken.review.kyokus[0]!.entries[0]!.state.tehai[i] = '9s';
    const { user, mock, store } = setup({ handlers: { fetch_report: () => JSON.stringify(broken) } });
    await user.click(await actionButton());
    await screen.findByRole('heading', { name: 'mjai の窓で Submit を押してください' });
    found(mock);
    const panel = await panelOf('牌譜と検討結果が合いません');
    expect(within(panel).getByRole('alert')).toHaveTextContent(/東1局 \d+巡目/);
    expect(calls(mock, 'save_report')).toEqual([]);
    expect(store.session(ID).report_path).toBeNull();
  });

  it('ほかの取り込み（サイドバーから始めたもの）が進んでいる間は、押せない。理由を添える', async () => {
    const { user } = setup();
    await actionButton();
    await user.click(within(screen.getByRole('complementary', { name: 'サイドバー' })).getByRole('button', { name: '検討結果を取り込む' }));
    await user.click(await screen.findByRole('button', { name: 'mjai で検討する' }));
    await screen.findByRole('heading', { name: 'mjai の窓で Submit を押してください' });
    // 半荘の一覧から、取り込み前の半荘のページへ戻る。
    const list = screen.getByRole('navigation', { name: '半荘の一覧' });
    await user.click(within(list).getByRole('button', { name: /^19:09/ }));
    const button = await actionButton();
    expect(button).toBeDisabled();
    expect(screen.getByText('ほかの取り込みが進んでいます')).toBeInTheDocument();
    // 取り込み先を決めた取り込みではないので、このページには進み具合を出さない。
    expect(screen.queryByText(/取り込み先:/)).toBeNull();
  });
});

describe('U-14 取り込みの途中で別のページへ移っても、続きを取りこぼさない', () => {
  it('窓で待っている間に取り込みのページへ移ると、同じ取り込みの案内が出る（取り込み先も）。結果が出れば、そのまま続く', async () => {
    const { user, mock } = setup();
    await user.click(await actionButton());
    await screen.findByRole('heading', { name: 'mjai の窓で Submit を押してください' });
    await user.click(within(screen.getByRole('complementary', { name: 'サイドバー' })).getByRole('button', { name: '検討結果を取り込む' }));
    expect(await screen.findByRole('heading', { level: 1, name: '検討結果を取り込む' })).toBeInTheDocument();
    expect(screen.getByRole('heading', { name: 'mjai の窓で Submit を押してください' })).toBeInTheDocument();
    found(mock);
    expect(await screen.findByRole('heading', { name: '取り込みました' })).toBeInTheDocument();
    expect(lastCall(mock, 'save_report')).toMatchObject({ sessionId: ID });
  });
});

describe('U-14 取り込み先は、次の取り込みに残らない（取り込みの状態を持つ部品の試験）', () => {
  function hook() {
    const store = new FakeSessionStore([{ session: fx4Session(ID, local(2026, 10, 9, 19, 9)) }]);
    const mock = installTauriMock({
      handlers: { ...importHandlers([]), ...store.handlers, ...store.importHandlers(fx4Ocr({ retries: true })) },
    });
    return { ...renderHook(() => useImportFlow()), mock, store };
  }
  const TARGET = { sessionId: ID, label: '10月9日 19:09' };

  it('始めると取り込み先が決まる。やめる・最初に戻る・「取り込みますか」を受けるで、牌譜リンクを待つ状態に戻ると、取り込み先も無くなる', async () => {
    const { result, mock } = hook();
    await act(async () => {
      expect(await result.current.startForSession(TARGET)).toEqual({ started: true });
    });
    expect(result.current.state.phase).toBe('window');
    expect(result.current.target).toEqual(TARGET);

    // やめる
    await act(async () => result.current.cancel());
    expect(result.current.state.phase).toBe('prompt');
    expect(result.current.target).toBeNull();

    // 失敗（結果が出る前に窓が閉じられた）→ 「取り込みますか」を受ける
    await act(async () => {
      await result.current.startForSession(TARGET);
    });
    act(() => mock.emit('mjai-window', { kind: 'closed' }));
    await waitFor(() => expect(result.current.state.phase).toBe('error'));
    expect(result.current.target).toEqual(TARGET);
    act(() => result.current.acceptOffer());
    expect(result.current.state.phase).toBe('prompt');
    expect(result.current.target).toBeNull();
  });

  it('取り込み先を決めた取り込みが失敗して、牌譜リンクを待つ状態に戻ったあとの、結果の URL を貼る取り込みは、取り込み先を決めない（結びつけ先の照合をする）', async () => {
    const { result, mock } = hook();
    await act(async () => {
      await result.current.startForSession(TARGET);
    });
    act(() => mock.emit('mjai-window', { kind: 'closed' }));
    await waitFor(() => expect(result.current.state.phase).toBe('error'));
    act(() => result.current.acceptOffer());
    // 取り込み先だった半荘を、直近 7 日の外にする。取り込み先が残っていれば、それでもその半荘に取り込む。
    // 残っていなければ、結びつけ先の候補（直近 7 日の、結果の無い半荘）が無いので、画像は読まず、記録の無い半荘になる。
    vi.setSystemTime(new Date(2026, 9, 30, 22, 0, 0));
    await act(async () => result.current.submitPastedUrl(`https://example.invalid/${FX4_ID}`));
    await waitFor(() => expect(calls(mock, 'save_report')).toHaveLength(1));
    expect(calls(mock, 'ocr_sessions')).toEqual([]);
    expect(lastCall(mock, 'save_report')).toMatchObject({ sessionId: null });
    expect(result.current.target).toBeNull();
  });
});
