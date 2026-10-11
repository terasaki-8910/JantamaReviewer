/**
 * サイドバーの出す・しまう・引き出し（U-32、R11-15）の画面の試験。
 * 実ブラウザでの見え方（左端から始まる・幕・横スクロール・axe・Tab の輪）は、tests/browser/shell.browser.test.ts が確かめる。
 * ここは、状態・フォーカス・キー・保存を、使う人と同じ操作で確かめる。jsdom には窓の幅が無いので、matchMedia を、幅を切り替えられる偽物にする。
 */
import { act, fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { FakeSessionStore, local, seedSession } from '../../tests/fake-sessions';
import { installTauriMock } from '../../tests/tauri-mock';
import { SIDEBAR_STORAGE_KEY, readSidebarShown, storeSidebarShown } from '../shared/sidebarPref';
import { App } from './App';

vi.mock('@tauri-apps/api/core', () => ({
  invoke: vi.fn(),
  convertFileSrc: (path: string) => path,
}));
vi.mock('@tauri-apps/api/event', () => ({ listen: vi.fn() }));
vi.mock('@tauri-apps/plugin-dialog', () => ({ open: vi.fn() }));

const originalMatchMedia = window.matchMedia;

/** 窓の幅が 640px 未満かを切り替えられる matchMedia（切り替えると、change を送る）。 */
function installWidth(initial: 'wide' | 'narrow') {
  let narrow = initial === 'narrow';
  const listeners = new Set<() => void>();
  window.matchMedia = ((query: string) => {
    const isWidth = query.includes('width < 640px');
    return {
      matches: isWidth ? narrow : false,
      media: query,
      onchange: null,
      addEventListener: (_type: string, listener: () => void) => {
        if (isWidth) listeners.add(listener);
      },
      removeEventListener: (_type: string, listener: () => void) => {
        listeners.delete(listener);
      },
      addListener: vi.fn(),
      removeListener: vi.fn(),
      dispatchEvent: vi.fn(),
    };
  }) as unknown as typeof window.matchMedia;
  return {
    set(next: 'wide' | 'narrow') {
      narrow = next === 'narrow';
      act(() => listeners.forEach((listener) => listener()));
    },
  };
}

/** jsdom には描画が無く、getClientRects がいつも空になる。見えている物として数えさせる（Tab の輪の確かめ用）。 */
function stubLayout() {
  return vi.spyOn(Element.prototype, 'getClientRects').mockImplementation(() => [{}] as unknown as DOMRectList);
}

beforeEach(() => {
  vi.useFakeTimers({ toFake: ['Date'] });
  vi.setSystemTime(new Date(2026, 9, 9, 22, 0, 0));
});

afterEach(() => {
  vi.useRealTimers();
  vi.restoreAllMocks();
  window.matchMedia = originalMatchMedia;
  document.body.style.overflow = '';
});

function start() {
  const store = new FakeSessionStore([
    seedSession(local(2026, 10, 9, 19, 9), { marks: 3, report: 'fx4' }),
    seedSession(local(2026, 10, 8, 21, 40), { marks: 0 }),
  ]);
  installTauriMock({ handlers: store.handlers });
  const user = userEvent.setup();
  const view = render(<App />);
  return { user, view };
}

const side = () => document.getElementById('sidebar') as HTMLElement;
const main = () => document.querySelector('main.main') as HTMLElement;
const app = () => document.querySelector('.app') as HTMLElement;
const topBar = () => document.querySelector('header.topbar');
const topToggle = () => within(topBar() as HTMLElement).getByRole('button', { name: /^サイドバーを/ });
const sideToggle = () => within(side()).getByRole('button', { name: /^サイドバーを/ });
const scrim = () => document.querySelector('.scrim');

async function ready() {
  await screen.findByRole('heading', { level: 1, name: /10月9日/ });
}

describe('U-32 広い窓: 同じボタンでサイドバーをしまえる。選びは覚える', () => {
  it('起動すると、サイドバーが出ていて、その見出しの左端に「サイドバーを閉じる」のボタンがある。本文の上の帯は無い', async () => {
    installWidth('wide');
    start();
    await ready();
    expect(side()).not.toHaveAttribute('inert');
    expect(app()).toHaveAttribute('data-sb', 'shown');
    expect(topBar()).toBeNull();
    const toggle = sideToggle();
    expect(toggle).toHaveAccessibleName('サイドバーを閉じる');
    expect(toggle).toHaveAttribute('aria-expanded', 'true');
    expect(toggle).toHaveAttribute('aria-controls', 'sidebar');
    // 見出しの左端（アプリのアイコンより前）
    const head = side().querySelector('.side-head') as HTMLElement;
    expect(head.querySelector('button, img')).toBe(toggle);
    // 引き出しの部品（幕・ダイアログの役割）は無い
    expect(scrim()).toBeNull();
    expect(side()).not.toHaveAttribute('role');
    expect(main()).not.toHaveAttribute('inert');
  });

  it('押すと、サイドバーがしまわれ（操作できない）、本文の上の帯に「サイドバーを開く」のボタンが出て、キーボードの位置がそこへ移る。もう一度押すと戻り、位置はサイドバーの中のボタンへ', async () => {
    installWidth('wide');
    const { user } = start();
    await ready();
    await user.click(sideToggle());
    expect(side()).toHaveAttribute('inert');
    expect(app()).toHaveAttribute('data-sb', 'hidden');
    expect(topBar()).not.toBeNull();
    const open = topToggle();
    expect(open).toHaveAccessibleName('サイドバーを開く');
    expect(open).toHaveAttribute('aria-expanded', 'false');
    expect(open).toHaveFocus();
    // しまっても、帯に検索と ← → がある（どれも使える）
    expect(within(topBar() as HTMLElement).getByRole('button', { name: '検索' })).toBeInTheDocument();
    expect(within(topBar() as HTMLElement).getByRole('group', { name: '画面の履歴' })).toBeInTheDocument();
    // 帯のボタンは、アプリのアイコンより前
    expect((topBar() as HTMLElement).querySelector('button, img')).toBe(open);
    await user.click(open);
    expect(side()).not.toHaveAttribute('inert');
    expect(app()).toHaveAttribute('data-sb', 'shown');
    expect(topBar()).toBeNull();
    expect(sideToggle()).toHaveFocus();
  });

  it('しまった選びは、保存領域に覚える（起動し直すと、しまったまま）。出し直すと、それも覚える', async () => {
    installWidth('wide');
    const first = start();
    await ready();
    await first.user.click(sideToggle());
    expect(window.localStorage.getItem(SIDEBAR_STORAGE_KEY)).toBe('hidden');
    first.view.unmount();

    // 起動し直す: しまったまま
    const second = start();
    await ready();
    expect(side()).toHaveAttribute('inert');
    expect(topBar()).not.toBeNull();
    await second.user.click(topToggle());
    expect(window.localStorage.getItem(SIDEBAR_STORAGE_KEY)).toBe('shown');
    second.view.unmount();

    start();
    await ready();
    expect(side()).not.toHaveAttribute('inert');
    expect(topBar()).toBeNull();
  });

  it('しまっていても、検索と Ctrl+K は、いつもどおり動く。検索を閉じると、帯の検索のアイコンへ位置が戻る', async () => {
    installWidth('wide');
    const { user } = start();
    await ready();
    await user.click(sideToggle());
    await user.click(within(topBar() as HTMLElement).getByRole('button', { name: '検索' }));
    expect(await screen.findByRole('dialog', { name: '検索' })).toBeInTheDocument();
    await user.keyboard('{Escape}');
    expect(screen.queryByRole('dialog', { name: '検索' })).toBeNull();
    expect(within(topBar() as HTMLElement).getByRole('button', { name: '検索' })).toHaveFocus();
    // Ctrl+K
    await user.keyboard('{Control>}k{/Control}');
    expect(await screen.findByRole('dialog', { name: '検索' })).toBeInTheDocument();
    await user.keyboard('{Escape}');
    expect(screen.queryByRole('dialog', { name: '検索' })).toBeNull();
  });
});

describe('U-32 窓の幅と、保存した選び', () => {
  it('保存領域が読めない・書けなくても、出して動く（しまう選びは覚えられないだけ）', async () => {
    installWidth('wide');
    const get = vi.spyOn(Storage.prototype, 'getItem').mockImplementation(() => {
      throw new Error('blocked');
    });
    const set = vi.spyOn(Storage.prototype, 'setItem').mockImplementation(() => {
      throw new Error('blocked');
    });
    expect(readSidebarShown()).toBe(true);
    expect(() => storeSidebarShown(false)).not.toThrow();
    const { user } = start();
    await ready();
    expect(side()).not.toHaveAttribute('inert');
    await user.click(sideToggle());
    expect(side()).toHaveAttribute('inert');
    expect(get).toHaveBeenCalled();
    expect(set).toHaveBeenCalled();
  });

  it('保存してある選びが「出す」「しまう」以外・空でも、出す', () => {
    window.localStorage.setItem(SIDEBAR_STORAGE_KEY, 'unknown');
    expect(readSidebarShown()).toBe(true);
    window.localStorage.setItem(SIDEBAR_STORAGE_KEY, 'hidden');
    expect(readSidebarShown()).toBe(false);
    window.localStorage.removeItem(SIDEBAR_STORAGE_KEY);
    expect(readSidebarShown()).toBe(true);
  });

  it('広い窓でしまっておいて、細い窓で開くと、引き出しとして開く（しまった選びが、引き出しを塞がない）', async () => {
    const width = installWidth('wide');
    window.localStorage.setItem(SIDEBAR_STORAGE_KEY, 'hidden');
    const { user } = start();
    await ready();
    width.set('narrow');
    await user.click(topToggle());
    expect(side()).not.toHaveAttribute('inert');
    expect(side()).toHaveAttribute('role', 'dialog');
    // 引き出しを開いても、広い窓のしまった選びは書き換えない
    expect(window.localStorage.getItem(SIDEBAR_STORAGE_KEY)).toBe('hidden');
  });
});

describe('U-32 細い窓: 引き出し', () => {
  it('640px 未満では、サイドバーは隠れ（操作できない）、本文の上の帯に「サイドバーを開く」のボタンがある。本文は操作できる', async () => {
    installWidth('narrow');
    start();
    await ready();
    expect(side()).toHaveAttribute('inert');
    expect(side()).not.toHaveAttribute('role');
    expect(main()).not.toHaveAttribute('inert');
    expect(scrim()).toBeNull();
    const open = topToggle();
    expect(open).toHaveAccessibleName('サイドバーを開く');
    expect(open).toHaveAttribute('aria-expanded', 'false');
    expect(open).toHaveAttribute('aria-controls', 'sidebar');
    // 帯の左端にボタン、右に検索と ← →
    expect((topBar() as HTMLElement).firstElementChild).toBe(open);
  });

  it('開くと、サイドバー全体が、ダイアログとして出る。幕が出て、裏（本文）は操作できず、位置は引き出しへ移る。ページはスクロールしない', async () => {
    installWidth('narrow');
    const { user } = start();
    await ready();
    await user.click(topToggle());
    expect(side()).not.toHaveAttribute('inert');
    expect(side()).toHaveAttribute('role', 'dialog');
    expect(side()).toHaveAttribute('aria-modal', 'true');
    expect(side()).toHaveAccessibleName('サイドバー');
    expect(app()).toHaveAttribute('data-drawer', 'open');
    expect(scrim()).not.toBeNull();
    expect(main()).toHaveAttribute('inert');
    expect(side()).toHaveFocus();
    expect(document.body.style.overflow).toBe('hidden');
    // 項目は全部ある（行き先・半荘の一覧・検索・設定）
    expect(within(side()).getByRole('button', { name: '検討結果を取り込む' })).toBeInTheDocument();
    expect(within(side()).getByRole('navigation', { name: '半荘の一覧' })).toBeInTheDocument();
    expect(within(side()).getByRole('searchbox')).toBeInTheDocument();
    expect(within(side()).getByRole('button', { name: '設定' })).toBeInTheDocument();
    // サイドバーの中のボタンは、「サイドバーを閉じる」
    expect(sideToggle()).toHaveAccessibleName('サイドバーを閉じる');
    expect(sideToggle()).toHaveAttribute('aria-expanded', 'true');
  });

  it('Esc で閉じて、左上のボタンへ位置が戻る（ページのスクロールも戻る）', async () => {
    installWidth('narrow');
    const { user } = start();
    await ready();
    const open = topToggle();
    await user.click(open);
    await user.keyboard('{Escape}');
    expect(app()).toHaveAttribute('data-drawer', 'closed');
    expect(side()).toHaveAttribute('inert');
    expect(scrim()).toBeNull();
    expect(main()).not.toHaveAttribute('inert');
    expect(topToggle()).toHaveFocus();
    expect(document.body.style.overflow).toBe('');
  });

  it('幕を押すと閉じて、位置が左上のボタンへ戻る。サイドバーの中のボタンでも閉じる', async () => {
    installWidth('narrow');
    const { user } = start();
    await ready();
    await user.click(topToggle());
    fireEvent.click(scrim() as Element);
    expect(app()).toHaveAttribute('data-drawer', 'closed');
    expect(topToggle()).toHaveFocus();
    await user.click(topToggle());
    await user.click(sideToggle());
    expect(app()).toHaveAttribute('data-drawer', 'closed');
    expect(topToggle()).toHaveFocus();
  });

  it('項目を選ぶと（半荘・今日の出題・設定・取り込み）、その画面が開き、引き出しが閉じて、位置が左上のボタンへ戻る', async () => {
    installWidth('narrow');
    const { user } = start();
    await ready();
    // 半荘
    await user.click(topToggle());
    const rows = within(within(side()).getByRole('navigation', { name: '半荘の一覧' })).getAllByRole('button', { name: /^\d\d:\d\d/ });
    await user.click(rows[1] as HTMLElement);
    expect(await screen.findByRole('heading', { level: 1, name: /10月8日/ })).toBeInTheDocument();
    expect(app()).toHaveAttribute('data-drawer', 'closed');
    expect(topToggle()).toHaveFocus();
    // 設定
    await user.click(topToggle());
    await user.click(within(side()).getByRole('button', { name: '設定' }));
    expect(await screen.findByRole('heading', { level: 1, name: '設定' })).toBeInTheDocument();
    expect(app()).toHaveAttribute('data-drawer', 'closed');
    expect(topToggle()).toHaveFocus();
    // 検討結果を取り込む
    await user.click(topToggle());
    await user.click(within(side()).getByRole('button', { name: '検討結果を取り込む' }));
    expect(await screen.findByRole('heading', { level: 1, name: '検討結果を取り込む' })).toBeInTheDocument();
    expect(app()).toHaveAttribute('data-drawer', 'closed');
    // 今日の出題
    await user.click(topToggle());
    await user.click(within(side()).getByRole('button', { name: /^今日の出題/ }));
    expect(await screen.findByRole('heading', { level: 1, name: '今日の出題' })).toBeInTheDocument();
    expect(app()).toHaveAttribute('data-drawer', 'closed');
    expect(topToggle()).toHaveFocus();
  });

  it('Tab は引き出しの中だけを回る（最後から先頭へ、先頭から Shift+Tab で最後へ）', async () => {
    installWidth('narrow');
    stubLayout();
    const { user } = start();
    await ready();
    await user.click(topToggle());
    for (let i = 0; i < 40; i += 1) {
      await user.tab();
      expect(side().contains(document.activeElement), `Tab ${i}`).toBe(true);
    }
    for (let i = 0; i < 12; i += 1) {
      await user.tab({ shift: true });
      expect(side().contains(document.activeElement), `Shift+Tab ${i}`).toBe(true);
    }
    // 外（本文）の物には、届かない
    expect(main().contains(document.activeElement)).toBe(false);
  });

  it('メニュー（半荘の「…」）が開いている間の Esc は、メニューだけを閉じる（引き出しは開いたまま）', async () => {
    installWidth('narrow');
    const { user } = start();
    await ready();
    await user.click(topToggle());
    await user.click(within(side()).getAllByRole('button', { name: /の半荘のメニュー/ })[0] as HTMLElement);
    expect(await screen.findByRole('menu', { name: '半荘のメニュー' })).toBeInTheDocument();
    await user.keyboard('{Escape}');
    expect(screen.queryByRole('menu')).toBeNull();
    expect(app()).toHaveAttribute('data-drawer', 'open');
    await user.keyboard('{Escape}');
    expect(app()).toHaveAttribute('data-drawer', 'closed');
  });

  it('引き出しから検索を開いて、Esc で閉じると、検索だけが閉じる（引き出しは開いたまま、位置は引き出しの検索のアイコンへ）', async () => {
    installWidth('narrow');
    const { user } = start();
    await ready();
    await user.click(topToggle());
    const icon = within(side()).getByRole('button', { name: '検索' });
    await user.click(icon);
    expect(await screen.findByRole('dialog', { name: '検索' })).toBeInTheDocument();
    await user.keyboard('{Escape}');
    expect(screen.queryByRole('dialog', { name: '検索' })).toBeNull();
    expect(app()).toHaveAttribute('data-drawer', 'open');
    expect(icon).toHaveFocus();
  });

  it('帯の検索のアイコンからも検索が開き、閉じると帯のアイコンへ位置が戻る。Ctrl+K も使える（引き出しは開かない）', async () => {
    installWidth('narrow');
    const { user } = start();
    await ready();
    const icon = within(topBar() as HTMLElement).getByRole('button', { name: '検索' });
    await user.click(icon);
    expect(await screen.findByRole('dialog', { name: '検索' })).toBeInTheDocument();
    await user.keyboard('{Escape}');
    expect(icon).toHaveFocus();
    expect(app()).toHaveAttribute('data-drawer', 'closed');
    await user.keyboard('{Control>}k{/Control}');
    expect(await screen.findByRole('dialog', { name: '検索' })).toBeInTheDocument();
    expect(app()).toHaveAttribute('data-drawer', 'closed');
  });

  it('引き出しから、検索の結果を開くと、その画面が開き、引き出しが閉じる', async () => {
    installWidth('narrow');
    const { user } = start();
    await ready();
    await user.click(topToggle());
    await user.click(within(side()).getByRole('button', { name: '検索' }));
    const box = await screen.findByRole('combobox', { name: '半荘と問題を検索' });
    await user.type(box, '10月8日');
    await user.keyboard('{Enter}');
    expect(await screen.findByRole('heading', { level: 1, name: /10月8日/ })).toBeInTheDocument();
    await waitFor(() => expect(app()).toHaveAttribute('data-drawer', 'closed'));
  });

  it('窓が広がって境を越えたら、引き出しは閉じる。また細くなっても、開いたままにはならない', async () => {
    const width = installWidth('narrow');
    const { user } = start();
    await ready();
    await user.click(topToggle());
    expect(app()).toHaveAttribute('data-drawer', 'open');
    width.set('wide');
    expect(app()).toHaveAttribute('data-drawer', 'closed');
    expect(side()).not.toHaveAttribute('inert');
    expect(scrim()).toBeNull();
    expect(main()).not.toHaveAttribute('inert');
    expect(document.body.style.overflow).toBe('');
    width.set('narrow');
    expect(app()).toHaveAttribute('data-drawer', 'closed');
    expect(side()).toHaveAttribute('inert');
  });

  it('引き出しが開いている間も、検索・履歴の ← →・テーマの切り替えは使える', async () => {
    installWidth('narrow');
    const { user } = start();
    await ready();
    await user.click(topToggle());
    const history = within(side()).getByRole('group', { name: '画面の履歴' });
    expect(within(history).getByRole('button', { name: '戻る' })).toBeDisabled();
    await user.click(within(side()).getByRole('button', { name: /^ダークテーマに切り替え/ }));
    expect(document.documentElement).toHaveAttribute('data-theme', 'dark');
    expect(app()).toHaveAttribute('data-drawer', 'open');
  });
});
