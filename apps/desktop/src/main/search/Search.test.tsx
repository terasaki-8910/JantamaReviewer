/**
 * 検索の重ね表示と、サイドバーの新しい見出し（ACCEPTANCE の U-22・U-4・U-5・U-10・U-12）の、アプリ全体を通した試験。
 * アプリ全体（App）を、半荘の保存先の偽物と、答えの記録の偽物の上で動かして、使う人と同じ操作で確かめる。
 * 実ブラウザでの見え方（見出しの並び・横スクロール・axe・Tab）は、tests/browser/search.browser.test.ts が確かめる。
 */
import { findDecisionByKey } from '@jantama/engine';
import { render, screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { FakeSessionStore, local, seedSession } from '../../../tests/fake-sessions';
import { FakeStudyStore, answerRow, gameOf } from '../../../tests/fake-study';
import { fx4Ocr, fx4Session } from '../../../tests/import-fixtures';
import { baseSettings, installTauriMock } from '../../../tests/tauri-mock';
import { App } from '../App';

vi.mock('@tauri-apps/api/core', () => ({
  invoke: vi.fn(),
  convertFileSrc: (path: string) => path,
}));
vi.mock('@tauri-apps/api/event', () => ({ listen: vi.fn() }));
vi.mock('@tauri-apps/plugin-dialog', () => ({ open: vi.fn() }));

/** 試験の「いま」: 2026 年 10 月 9 日 22:00（日付だけ動かす）。 */
beforeEach(() => {
  vi.useFakeTimers({ toFake: ['Date'] });
  vi.setSystemTime(new Date(2026, 9, 9, 22, 0, 0));
});

afterEach(() => {
  vi.useRealTimers();
});

const FX4_ID = '20261009-190953';
const FX1A_ID = '20261009-171200';
const LOAD = { timeout: 20_000 };

/** FX-4（読み取りの写しつき。迷い 1〜5 は推定）と、f9da（迷いなし）。 */
function seeds() {
  return [
    {
      session: fx4Session(FX4_ID, local(2026, 10, 9, 19, 9), { report_path: `C:\\data\\games\\${FX4_ID}\\report.json`, ocr: fx4Ocr() }),
      report: 'fx4' as const,
    },
    seedSession(local(2026, 10, 9, 17, 12), { id: FX1A_ID, report: 'fx1a' }),
  ];
}

function setup(options: { study?: FakeStudyStore } = {}) {
  const sessions = new FakeSessionStore(seeds());
  const study = options.study ?? new FakeStudyStore();
  const mock = installTauriMock({
    settings: { ...baseSettings },
    handlers: { ...sessions.handlers, ...study.handlers },
  });
  const user = userEvent.setup();
  render(<App />);
  return { user, mock, sessions, study };
}

const side = () => screen.getByRole('complementary', { name: 'サイドバー' });
const searchButton = () => within(side()).getByRole('button', { name: '検索' });
const dialog = () => screen.getByRole('dialog', { name: '検索' });
const input = () => screen.getByRole('combobox', { name: '半荘と問題を検索' });
const options = () => within(dialog()).queryAllByRole('option');
const app = () => document.querySelector('.app') as HTMLElement;
const sideCount = () => within(screen.getByRole('navigation', { name: 'メイン' })).getByRole('button', { name: /^今日の出題/ }).querySelector('.count')?.textContent ?? null;

/** 出題のデータを読み終えて、サイドバーに数が出るまで待つ（重ね表示の問題も、そのあと探せる）。 */
async function loaded() {
  await screen.findByRole('navigation', { name: '半荘の一覧' });
  await waitFor(() => expect(sideCount()).not.toBeNull(), LOAD);
}

describe('U-22: サイドバーの見出し', () => {
  it('左にアプリのアイコン（画像・引きずれない）、右に検索のアイコンと ← →。アイコン・検索・戻る・進むの順（名前の文字は無い）', async () => {
    setup();
    await loaded();
    const head = side().querySelector('.side-head') as HTMLElement;
    const icon = head.querySelector('img.app-mark') as HTMLImageElement;
    expect(icon).toHaveAttribute('alt', 'JantamaReviewer');
    expect(icon).toHaveAttribute('draggable', 'false');
    expect(icon.getAttribute('src')).toMatch(/128x128.*\.png$/);
    expect(icon).toHaveAttribute('width', '30');
    // 見出しに、アプリの名前の文字は無い（アイコンだけ。U-22）
    expect(head.textContent?.trim()).toBe('');
    const buttons = [...head.querySelectorAll('button')].map((b) => b.getAttribute('aria-label'));
    expect(buttons).toEqual(['検索', '戻る', '進む']);
    // 並び: アイコン → 検索 → ← → のすぐ左に検索
    const order = [...head.querySelectorAll('img.app-mark, button')].map((el) => el.className.split(' ')[0] ?? '');
    expect(order[0]).toBe('app-mark');
    const tools = head.querySelector('.side-tools') as HTMLElement;
    expect([...tools.children].map((c) => c.className.split(' ').at(-1) ?? '')).toEqual(['search-btn', 'side-hist']);
    // ← → は、これまでどおり（見た画面が無いので、押せない）
    const history = within(head).getByRole('group', { name: '画面の履歴' });
    expect(within(history).getByRole('button', { name: '戻る' })).toBeDisabled();
    expect(within(history).getByRole('button', { name: '進む' })).toBeDisabled();
  });

  it('検索のアイコンは、枠の無いアイコンのボタン。名前は「検索」、Ctrl+K を title と aria-keyshortcuts に出す。重ね表示を開く前は aria-expanded=false', async () => {
    setup();
    await loaded();
    const button = searchButton();
    expect(button).toHaveClass('icon-btn');
    expect(button).toHaveAttribute('title', '検索（Ctrl+K）');
    expect(button).toHaveAttribute('aria-keyshortcuts', 'Control+K');
    expect(button).toHaveAttribute('aria-haspopup', 'dialog');
    expect(button).toHaveAttribute('aria-expanded', 'false');
    expect(button.querySelector('svg.ic')).not.toBeNull();
    expect(button.textContent).toBe('');
  });

  it('半荘の一覧の上の検索欄と段階の絞り込みは、これまでどおり（残してある。U-12）', async () => {
    const { user } = setup();
    await loaded();
    const list = screen.getByRole('navigation', { name: '半荘の一覧' });
    const rows = () => within(list).getAllByRole('button', { name: /^\d\d:\d\d/ });
    expect(rows()).toHaveLength(2);
    await user.type(within(list).getByRole('searchbox', { name: '半荘を検索（日付・卓・メモ）' }), '17:12');
    expect(rows()).toHaveLength(1);
    expect(within(list).getByText('「17:12」 1件')).toBeInTheDocument();
    await user.click(within(list).getByRole('button', { name: '解除' }));
    expect(rows()).toHaveLength(2);
    await user.click(within(list).getByRole('button', { name: /^段階/ }));
    await user.click(screen.getByRole('menuitemradio', { name: /^A 以下/ }));
    // f9da は A、FX-4 は S-。A 以下は 1 つ
    expect(rows()).toHaveLength(1);
    expect(within(list).getByText('A 以下 1件')).toBeInTheDocument();
  });
});

describe('U-22: 開く・閉じる（アイコン・Ctrl+K・Esc）と、キーボードの位置', () => {
  it('アイコンを押すと開く: 検索欄にキーボードの位置が移り、裏の画面は操作できない（inert）。アイコンは aria-expanded=true', async () => {
    const { user } = setup();
    await loaded();
    expect(screen.queryByRole('dialog', { name: '検索' })).toBeNull();
    await user.click(searchButton());
    expect(dialog()).toBeInTheDocument();
    expect(input()).toHaveFocus();
    expect(app()).toHaveAttribute('inert');
    expect(searchButton()).toHaveAttribute('aria-expanded', 'true');
    // 重ね表示は、裏の画面（.app）の外に描く（裏が inert でも、重ね表示は操作できる）
    expect(app().contains(dialog())).toBe(false);
  });

  it('Esc で閉じて、キーボードの位置が検索のアイコンに戻る。裏の画面は、また操作できる', async () => {
    const { user } = setup();
    await loaded();
    await user.click(searchButton());
    await user.keyboard('{Escape}');
    expect(screen.queryByRole('dialog', { name: '検索' })).toBeNull();
    expect(app()).not.toHaveAttribute('inert');
    expect(searchButton()).toHaveAttribute('aria-expanded', 'false');
    expect(searchButton()).toHaveFocus();
    expect(document.body).not.toHaveClass('sx-open');
  });

  it('Ctrl+K で開き、もう一度 Ctrl+K で閉じる（検索欄の中でも）。何も選んでいなかったときは、検索のアイコンに戻る', async () => {
    const { user } = setup();
    await loaded();
    await user.keyboard('{Control>}k{/Control}');
    expect(dialog()).toBeInTheDocument();
    expect(input()).toHaveFocus();
    await user.keyboard('{Control>}k{/Control}');
    expect(screen.queryByRole('dialog', { name: '検索' })).toBeNull();
    expect(searchButton()).toHaveFocus();
    // 検索語を入れてから Ctrl+K で閉じても、同じ
    await user.keyboard('{Control>}k{/Control}');
    await user.keyboard('東4局');
    await user.keyboard('{Control>}k{/Control}');
    expect(screen.queryByRole('dialog', { name: '検索' })).toBeNull();
  });

  it('開く前にキーボードの位置があった物（半荘の行など）に、閉じたあと戻る', async () => {
    const { user } = setup();
    await loaded();
    const row = within(screen.getByRole('navigation', { name: '半荘の一覧' })).getAllByRole('button', { name: /^\d\d:\d\d/ })[1] as HTMLElement;
    row.focus();
    await user.keyboard('{Control>}k{/Control}');
    expect(input()).toHaveFocus();
    await user.keyboard('{Escape}');
    expect(row).toHaveFocus();
  });

  it('背景を押しても閉じる（キーボードの位置は、開く前の物へ）', async () => {
    const { user } = setup();
    await loaded();
    await user.click(searchButton());
    await user.click(dialog().parentElement as HTMLElement);
    expect(screen.queryByRole('dialog', { name: '検索' })).toBeNull();
    expect(searchButton()).toHaveFocus();
  });

  it('メニュー（半荘の「…」）が開いている間の Ctrl+K は、何もしない', async () => {
    const { user } = setup();
    await loaded();
    const list = screen.getByRole('navigation', { name: '半荘の一覧' });
    await user.click(within(list).getAllByRole('button', { name: /の半荘のメニュー$/ })[0] as HTMLElement);
    expect(screen.getByRole('menu', { name: '半荘のメニュー' })).toBeInTheDocument();
    await user.keyboard('{Control>}k{/Control}');
    expect(screen.queryByRole('dialog', { name: '検索' })).toBeNull();
  });

  it('開いている間、アプリのキー操作（Alt+←）は止まる。閉じると、また動く', async () => {
    const { user } = setup();
    await loaded();
    // 見た画面を 1 つ増やして、戻れる状態にする
    await user.click(screen.getByRole('button', { name: '設定' }));
    await screen.findByRole('heading', { level: 1, name: '設定' });
    expect(within(side()).getByRole('button', { name: '戻る' })).toBeEnabled();
    await user.click(searchButton());
    await user.keyboard('{Alt>}{ArrowLeft}{/Alt}');
    expect(screen.getByRole('heading', { level: 1, name: '設定' })).toBeInTheDocument();
    await user.keyboard('{Escape}');
    await user.keyboard('{Alt>}{ArrowLeft}{/Alt}');
    expect(await screen.findByRole('heading', { level: 1, name: /10月9日\(金\)/ })).toBeInTheDocument();
  });
});

describe('U-22: 開く（半荘・問題）と、画面の履歴', () => {
  it('半荘の行を Enter で開く: 半荘のページが開き、重ね表示は閉じる。キーボードの位置は、ページの見出しへ。Alt+← で戻り、Alt+→ で進む（U-10）', async () => {
    const { user } = setup();
    await loaded();
    await screen.findByRole('heading', { level: 1, name: /10月9日\(金\) 19:09/ });
    await user.click(searchButton());
    // 2 つ目の半荘（17:12）を選んで開く
    await user.keyboard('{ArrowDown}{Enter}');
    expect(screen.queryByRole('dialog', { name: '検索' })).toBeNull();
    expect(app()).not.toHaveAttribute('inert');
    const heading = await screen.findByRole('heading', { level: 1, name: /10月9日\(金\) 17:12/ });
    expect(heading).toHaveFocus();
    const list = screen.getByRole('navigation', { name: '半荘の一覧' });
    expect(within(list).getAllByRole('button', { name: /^\d\d:\d\d/ })[1]).toHaveAttribute('aria-current', 'true');
    // 画面の履歴: 戻る・進む
    await user.keyboard('{Alt>}{ArrowLeft}{/Alt}');
    expect(await screen.findByRole('heading', { level: 1, name: /10月9日\(金\) 19:09/ })).toBeInTheDocument();
    await user.keyboard('{Alt>}{ArrowRight}{/Alt}');
    expect(await screen.findByRole('heading', { level: 1, name: /10月9日\(金\) 17:12/ })).toBeInTheDocument();
  });

  it('半荘の行をマウスで押しても開く', async () => {
    const { user } = setup();
    await loaded();
    await user.click(searchButton());
    await user.type(input(), '17:12');
    await user.click(options()[0] as HTMLElement);
    expect(await screen.findByRole('heading', { level: 1, name: /10月9日\(金\) 17:12/ })).toBeInTheDocument();
    expect(screen.queryByRole('dialog', { name: '検索' })).toBeNull();
  });

  it('問題の行を Enter で開く: 出題の画面がその問題で開く（答える前なので、AI の評価は無い）。手牌にキーボードの位置。Alt+← で戻れる', async () => {
    const { user } = setup();
    await loaded();
    await screen.findByRole('heading', { level: 1, name: /10月9日\(金\) 19:09/ });
    await user.click(searchButton());
    await user.click(screen.getByRole('button', { name: '問題' }));
    await user.type(input(), '東4局 13巡目');
    expect(options().length).toBeGreaterThan(0);
    const first = options()[0] as HTMLElement;
    expect(first).toHaveTextContent('東4局 13巡目');
    await user.keyboard('{Enter}');
    expect(screen.queryByRole('dialog', { name: '検索' })).toBeNull();
    expect(await screen.findByRole('heading', { level: 1, name: '東4局 13巡目' })).toBeInTheDocument();
    // 出題の画面: 答える前の見出しに、実戦の行動。AI の評価は、DOM に無い（U-1）
    expect(document.querySelector('.q-chips')?.textContent).toContain('実戦：打3m');
    expect(document.querySelector('[data-ai]')).toBeNull();
    expect(document.body.textContent).not.toMatch(/\d\s*%/);
    // 画面を開いたときに、キーボードの位置が無い（重ね表示が消えた）ので、出題の画面が手牌に置く
    await waitFor(() => expect(document.activeElement?.closest('.hand')).not.toBeNull());
    await user.keyboard('{Alt>}{ArrowLeft}{/Alt}');
    expect(await screen.findByRole('heading', { level: 1, name: /10月9日\(金\) 19:09/ })).toBeInTheDocument();
    await user.keyboard('{Alt>}{ArrowRight}{/Alt}');
    expect(await screen.findByRole('heading', { level: 1, name: '東4局 13巡目' })).toBeInTheDocument();
  });

  it('答えた問題を開くと、保存してある答えが出る（答え合わせのあとの形）。解答済みの印と原則で探せる', async () => {
    const imported = gameOf('fx1a');
    const decision = findDecisionByKey(imported, 'k3h0e15');
    expect(decision).toBeDefined();
    const study = new FakeStudyStore([
      answerRow({
        id: 1,
        session_id: FX1A_ID,
        decision_key: 'k3h0e15',
        choice: { type: 'dahai', tile: '3m' },
        reason: '孤立牌を切って受け入れを広く',
        correct: false,
        principle: '受け入れを数えてから切る',
        due_date: '2026-10-10',
      }),
    ]);
    const { user } = setup({ study });
    await loaded();
    await user.click(searchButton());
    await user.type(input(), '解答済み');
    expect(options()).toHaveLength(1);
    expect(options()[0]).toHaveTextContent('東4局 13巡目');
    expect(options()[0]).toHaveTextContent('原則: 受け入れを数えてから切る');
    await user.keyboard('{Enter}');
    expect(await screen.findByRole('heading', { level: 1, name: '東4局 13巡目' })).toBeInTheDocument();
    expect(await screen.findByRole('heading', { name: 'AIの評価（Mortal）' })).toBeInTheDocument();
    expect(screen.getByText('孤立牌を切って受け入れを広く')).toBeInTheDocument();
    expect(screen.getByLabelText('学んだ原則（1行）')).toHaveValue('受け入れを数えてから切る');
    expect(screen.queryByRole('button', { name: '答え合わせ' })).toBeNull();
  });

  it('重ね表示の問題は、今日の出題と同じ一覧（今日の 5 問 + 残り 23 問 = 28 問）。答えを隠したまま（AI の情報は出ない）', async () => {
    const { user } = setup();
    await loaded();
    await user.click(within(screen.getByRole('navigation', { name: 'メイン' })).getByRole('button', { name: /^今日の出題/ }));
    await screen.findByRole('heading', { level: 1, name: '今日の出題' });
    const today = within(screen.getByRole('list', { name: '今日の出題' })).getAllByRole('button').length;
    const rest = Number(/残り(\d+)問/.exec(document.querySelector('details.qrest summary')?.textContent ?? '')?.[1]);
    expect(today + rest).toBe(28);
    await user.click(searchButton());
    expect(dialog().querySelector('.sx-count')?.textContent).toMatch(/^半荘 2 · 問題 28/);
    await user.click(within(dialog()).getByRole('button', { name: /^すべて表示/ }));
    expect(options().filter((o) => /^問題 /.test(o.textContent ?? ''))).toHaveLength(28);
    expect(dialog().querySelector('[data-ai]')).toBeNull();
    expect(dialog().textContent).not.toMatch(/\d\s*%|Mortal/);
  });
});

describe('U-22: 消した半荘は、検索に出ない', () => {
  it('半荘を消すと（アプリを閉じるまで置き場にある間も）、その半荘と問題は検索に出ない。元に戻すと、また出る', async () => {
    const { user } = setup();
    await loaded();
    const list = screen.getByRole('navigation', { name: '半荘の一覧' });
    // 2 つ目（17:12）の半荘を消す
    await user.click(within(list).getAllByRole('button', { name: /の半荘のメニュー$/ })[1] as HTMLElement);
    await user.click(screen.getByRole('menuitem', { name: '削除' }));
    await user.click(await screen.findByRole('button', { name: '削除' }));
    await waitFor(() => expect(within(list).getAllByRole('button', { name: /^\d\d:\d\d/ })).toHaveLength(1));
    await user.keyboard('{Control>}k{/Control}');
    expect(dialog().querySelector('.sx-count')?.textContent).toMatch(/^半荘 1 /);
    expect(within(dialog()).queryByText(/17:12/)).toBeNull();
    await user.type(input(), '東4局');
    expect(options()).toHaveLength(0);
    await user.keyboard('{Escape}');
    // 元に戻す（Ctrl+Z）と、また出る
    await user.keyboard('{Control>}z{/Control}');
    await waitFor(() => expect(within(list).getAllByRole('button', { name: /^\d\d:\d\d/ })).toHaveLength(2));
    await user.keyboard('{Control>}k{/Control}');
    await user.type(input(), '東4局');
    await waitFor(() => expect(options().length).toBeGreaterThan(0), LOAD);
  });
});
