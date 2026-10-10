/**
 * 半荘のページを、アプリ全体（App）の中で確かめる試験（U-8・U-11、SPEC の F9・F10）。
 * 半荘の保存先の偽物（FakeSessionStore）の上で、使う人と同じ操作をする。
 * - 迷いの画像の大きな表示: 開く・裏の画面が操作できなくなる・閉じたらカードへキーボードの位置が戻る・開いている間はキー操作を止める
 * - 編集（迷いの結びつけ・自分の〇△✕・MAKA）の通知と、Ctrl+Z・Ctrl+Y・通知の「元に戻す」での取り消し・やり直し
 * 部品ごとの細かいふるまいは、SessionPage.test.tsx・Lightbox.test.tsx が確かめる。
 */
import { render, screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { FakeSessionStore, local, seedSession } from '../../tests/fake-sessions';
import { fx4Ocr, fx4Session } from '../../tests/import-fixtures';
import { installTauriMock } from '../../tests/tauri-mock';
import type { Links, SessionRecord } from '../api/types';
import { App } from './App';

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
});
afterEach(() => {
  vi.useRealTimers();
});

const ID = '20261009-190953';
const LINKS: Links = {
  marks: { '1': 'k0h0e4', '2': 'k1h0e13', '3': 'k1h1e7' },
  ratings: { '7': 'k0h0', '8': 'k1h0', '9': 'k1h1', '10': 'k2h0', '11': 'k2h1' },
};

function imported(): SessionRecord {
  const base = fx4Session(ID, local(2026, 10, 9, 19, 9), {
    report_path: `C:\\data\\games\\${ID}\\report.json`,
    ocr: fx4Ocr(),
    links: LINKS,
  });
  const ratings = ['fair', 'bad', 'fair', 'bad', 'bad'] as const;
  return { ...base, ratings: base.ratings.map((r, i) => ({ ...r, rating: ratings[i] ?? r.rating })) };
}

function setup() {
  // 新しい順: FX-4 の半荘（今日）→ 昨日の、取り込み前の半荘。
  const older = seedSession(local(2026, 10, 8, 21, 0), { marks: 2, ratings: 1 });
  const store = new FakeSessionStore([{ session: imported(), report: 'fx4' }, older]);
  const mock = installTauriMock({ handlers: store.handlers });
  const user = userEvent.setup();
  render(<App />);
  return { store, mock, user, olderId: older.session.id };
}

const card = (n: number) => screen.getByRole('article', { name: `迷い${n}` });
const thumb = (n: number) => within(card(n)).getByRole('button', { name: `迷い${n}の画像を大きく見る` });
const toastText = () => document.querySelector('.toast .toast-t')?.textContent ?? null;
const toastShows = (text: string) => waitFor(() => expect(toastText()).toBe(text));
const calls = (mock: ReturnType<typeof setup>['mock'], cmd: string) =>
  mock.calls().filter((c) => c.cmd === cmd).map((c) => c.args);
const app = () => document.querySelector('.app') as HTMLElement;

async function ready() {
  await screen.findByRole('table', { name: '局の評価' });
}

describe('R7-4 迷いの画像の大きな表示（アプリ全体の中で）', () => {
  it('カードの画像を押すと開き、裏の画面は操作できなくなる。説明は「迷いN · 局 · 巡目 · 種類」と時刻', async () => {
    const { user } = setup();
    await ready();
    expect(screen.queryByRole('dialog', { name: '迷いの画像' })).toBeNull();
    await user.click(thumb(3));
    const dialog = screen.getByRole('dialog', { name: '迷いの画像' });
    expect(dialog).toHaveFocus();
    expect(app()).toHaveAttribute('inert');
    expect(within(dialog).getByRole('img')).toHaveAttribute(
      'src',
      `asset://localhost/${encodeURIComponent('C:\\data\\games\\20261009-190953\\marks\\m3.png')}`,
    );
    expect(dialog.querySelector('figcaption')?.textContent).toBe('迷い3 · 東2局1本場 · 6巡目 · 打牌の迷い · 19:17:37');
    // 3 枚目から、前（2 枚目）・次（4 枚目）へ。
    await user.click(within(dialog).getByRole('button', { name: '次の画像' }));
    expect(dialog.querySelector('figcaption')?.textContent).toBe('迷い4 · 東2局1本場 · 候補が3つ · 19:18:24');
    await user.keyboard('{ArrowLeft}{ArrowLeft}');
    expect(dialog.querySelector('figcaption')?.textContent).toBe('迷い2 · 東2局 · 11巡目 · 鳴きの迷い · 19:15:57');
  });

  it('Esc で閉じると、押したカードの画像のボタンにキーボードの位置が戻り、裏の画面がまた操作できる', async () => {
    const { user } = setup();
    await ready();
    await user.click(thumb(5));
    expect(app()).toHaveAttribute('inert');
    await user.keyboard('{Escape}');
    await waitFor(() => expect(screen.queryByRole('dialog', { name: '迷いの画像' })).toBeNull());
    expect(app()).not.toHaveAttribute('inert');
    expect(thumb(5)).toHaveFocus();
    expect(document.body).not.toHaveClass('lb-open');
  });

  it('背景を押しても、閉じるボタンでも閉じて、押したカードへ戻る。開いたまま前後に動いたあとは、最初に押したカードへ戻る', async () => {
    const { user } = setup();
    await ready();
    await user.click(thumb(2));
    const dialog = screen.getByRole('dialog', { name: '迷いの画像' });
    await user.click(dialog.querySelector('.lb-backdrop') as HTMLElement);
    await waitFor(() => expect(screen.queryByRole('dialog', { name: '迷いの画像' })).toBeNull());
    expect(thumb(2)).toHaveFocus();

    await user.click(thumb(1));
    await user.keyboard('{ArrowRight}{ArrowRight}');
    await user.click(screen.getByRole('button', { name: '閉じる' }));
    await waitFor(() => expect(screen.queryByRole('dialog', { name: '迷いの画像' })).toBeNull());
    expect(thumb(1)).toHaveFocus();
  });

  it('開いている間は、Ctrl+Z（取り消し）も Alt+←（画面の履歴）も働かない', async () => {
    const { user, mock, store } = setup();
    await ready();
    // 取り消せる操作を 1 つしておく（迷い 5 を選ぶ）。
    await user.click(within(card(5)).getByRole('button', { name: '打1p' }));
    await waitFor(() => expect(store.session(ID).links.marks['5']).toBe('k2h1e7'));
    await user.click(thumb(1));
    await user.keyboard('{Control>}z{/Control}');
    await user.keyboard('{Alt>}{ArrowLeft}{/Alt}');
    expect(calls(mock, 'clear_mark_link')).toEqual([]);
    expect(store.session(ID).links.marks['5']).toBe('k2h1e7');
    await user.keyboard('{Escape}');
    await waitFor(() => expect(screen.queryByRole('dialog')).toBeNull());
    // 閉じれば、また効く。
    await user.keyboard('{Control>}z{/Control}');
    await waitFor(() => expect(store.session(ID).links.marks['5']).toBeUndefined());
  });
});

describe('U-11 半荘のページの編集の通知と取り消し（アプリ全体の中で）', () => {
  it('迷いを選ぶと、通知（「元に戻す」付き）が出る。通知の「元に戻す」で戻り、「元に戻しました」と出る', async () => {
    const { user, store } = setup();
    await ready();
    await user.click(within(card(4)).getByRole('button', { name: '打7p' }));
    await toastShows('迷い4を東2局1本場 9巡目の局面に結びつけました');
    expect(store.session(ID).links.marks['4']).toBe('k1h1e11');
    await user.click(within(document.querySelector('.toast') as HTMLElement).getByRole('button', { name: '元に戻す' }));
    await toastShows('迷い4の結びつけを元に戻しました');
    await waitFor(() => expect(within(card(4)).getByText('選んでください')).toBeInTheDocument());
    expect(store.session(ID).links.marks['4']).toBeUndefined();
  });

  it('Ctrl+Z で取り消し、Ctrl+Y でやり直す。自分の評価・MAKA も、同じ積み重ねに載る（新しいものから順に戻る）', async () => {
    const { user, store } = setup();
    const table = await screen.findByRole('table', { name: '局の評価' });
    // 1) 東2局の自分の評価を ✕ → 〇。2) 東1局の MAKA を C-。3) 迷い 5 を選ぶ。
    await user.click(within(table).getByRole('button', { name: '東2局の自分の評価（✕）' }));
    await user.click(screen.getByRole('menuitemradio', { name: '〇' }));
    await toastShows('東2局の自分の評価を〇にしました');
    await user.click(within(table).getByRole('button', { name: '東1局の MAKA（未入力）' }));
    await user.click(screen.getByRole('menuitemradio', { name: 'C-' }));
    await toastShows('東1局の MAKA を C- にしました');
    await user.click(within(card(5)).getByRole('button', { name: '打9m' }));
    await toastShows('迷い5を東3局1本場 6巡目の局面に結びつけました');

    await user.keyboard('{Control>}z{/Control}');
    await toastShows('迷い5の結びつけを元に戻しました');
    expect(store.session(ID).links.marks['5']).toBeUndefined();
    await user.keyboard('{Control>}z{/Control}');
    await toastShows('東1局の MAKA を元に戻しました');
    expect(store.session(ID).maka.kyokus).toEqual({});
    await user.keyboard('{Control>}z{/Control}');
    await toastShows('東2局の自分の評価を元に戻しました');
    expect(store.session(ID).self_ratings.kyokus).toEqual({});
    await waitFor(() => expect(within(table).getByRole('button', { name: '東2局の自分の評価（✕）' })).toBeInTheDocument());

    // やり直し（Ctrl+Y）は、取り消した順の逆。
    await user.keyboard('{Control>}y{/Control}');
    await toastShows('東2局の自分の評価を〇にしました');
    await user.keyboard('{Control>}y{/Control}');
    await toastShows('東1局の MAKA を C- にしました');
    await user.keyboard('{Control>}y{/Control}');
    await toastShows('迷い5を東3局1本場 6巡目の局面に結びつけました');
    expect(store.session(ID).self_ratings.kyokus).toEqual({ k1h0: 'good' });
    expect(store.session(ID).maka.kyokus).toEqual({ k0h0: 'C-' });
    expect(store.session(ID).links.marks['5']).toBe('k2h1e6');
  });

  it('別の半荘を開いたあとでも、Ctrl+Z は前の編集を取り消す（通知で、何を戻したか分かる）', async () => {
    const { user, store, olderId } = setup();
    await ready();
    await user.click(within(card(5)).getByRole('button', { name: '打1p' }));
    await toastShows('迷い5を東3局1本場 7巡目の局面に結びつけました');
    // 取り込み前の半荘を開く。
    const list = screen.getByRole('navigation', { name: '半荘の一覧' });
    await user.click(within(list).getByRole('button', { name: /^21:00/ }));
    await screen.findByRole('heading', { level: 1, name: /10月8日/ });
    expect(screen.queryByRole('table')).toBeNull();
    await user.keyboard('{Control>}z{/Control}');
    await toastShows('迷い5の結びつけを元に戻しました');
    expect(store.session(ID).links.marks['5']).toBeUndefined();
    expect(store.session(olderId).links.marks).toEqual({});
    // 元の半荘へ戻ると、選ぶ前の状態になっている。
    await user.click(within(list).getByRole('button', { name: /^19:09/ }));
    await waitFor(() => expect(within(card(5)).getByText('選んでください')).toBeInTheDocument());
  });

  it('保存できなかったときは、理由を通知に出し、表も変えない', async () => {
    const store = new FakeSessionStore([{ session: imported(), report: 'fx4' }]);
    installTauriMock({
      handlers: {
        ...store.handlers,
        set_self_rating: () => {
          throw 'フォルダに書けませんでした';
        },
      },
    });
    const user = userEvent.setup();
    render(<App />);
    const table = await screen.findByRole('table', { name: '局の評価' });
    await user.click(within(table).getByRole('button', { name: '東2局の自分の評価（✕）' }));
    await user.click(screen.getByRole('menuitemradio', { name: '〇' }));
    await toastShows('局の評価の付け直しができませんでした: フォルダに書けませんでした');
    expect(within(table).getByRole('button', { name: '東2局の自分の評価（✕）' })).toBeInTheDocument();
    expect(document.querySelector('.toast')?.querySelector('button.btn')).toBeNull();
  });

  it('文字を打つ欄（検索）の中の Ctrl+Z は、半荘のページの編集を戻さない', async () => {
    const { user, store } = setup();
    await ready();
    await user.click(within(card(5)).getByRole('button', { name: '打1p' }));
    await waitFor(() => expect(store.session(ID).links.marks['5']).toBe('k2h1e7'));
    await user.click(screen.getByRole('searchbox'));
    await user.keyboard('昨日{Control>}z{/Control}');
    expect(store.session(ID).links.marks['5']).toBe('k2h1e7');
  });
});
