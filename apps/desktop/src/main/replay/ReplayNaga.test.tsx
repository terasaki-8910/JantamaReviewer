/**
 * 通して見る画面の操作の段の「NAGA の結果を開く」リンク（F22 段 2。ACCEPTANCE の U-52 の段 2 の部分）と、
 * 半荘のページで貼った URL が、そのまま通して見る画面に届くことの画面の試験。
 * アプリ全体（App）を、半荘の保存先の偽物と、答えの記録の偽物の上で動かして、使う人と同じ操作で確かめる。
 * 実ブラウザでの見え方（横スクロール・axe・操作の段の高さが変わらないこと）は、tests/browser/replay.browser.test.ts が確かめる。
 */
import { render, screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { FakeSessionStore, local, seedSession } from '../../../tests/fake-sessions';
import { FakeStudyStore } from '../../../tests/fake-study';
import { fx4Ocr, fx4Session } from '../../../tests/import-fixtures';
import { installTauriMock } from '../../../tests/tauri-mock';
import type { Links } from '../../api/types';
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
  window.localStorage.clear();
});

afterEach(() => {
  vi.useRealTimers();
  window.localStorage.clear();
});

const FX4_ID = '20261009-190953';
const FX1A_ID = '20261009-171200';
const LOAD = { timeout: 20_000 };
const REPORT_URL = 'https://naga.dmv.nico/htmls/report_viewer.html?report_id=abc';

const USER_LINKS: Links = {
  ratings: {},
  marks: { '1': 'k0h0e4', '2': 'k1h0e12', '3': 'k1h1e7', '4': 'k1h1e10', '5': 'k2h1e6', '6': 'k2h1e14' },
};

function setup(options: { naga?: string } = {}) {
  const fx4Seed = {
    session: fx4Session(FX4_ID, local(2026, 10, 9, 19, 9), {
      report_path: `C:\\data\\games\\${FX4_ID}\\report.json`,
      ocr: fx4Ocr(),
      links: USER_LINKS,
      naga: options.naga === undefined ? null : { url: options.naga, saved_ms: 1_760_000_000_000 },
    }),
    report: 'fx4' as const,
  };
  const sessions = new FakeSessionStore([fx4Seed, seedSession(local(2026, 10, 9, 17, 12), { id: FX1A_ID, report: 'fx1a' })]);
  const study = new FakeStudyStore();
  const mock = installTauriMock({ handlers: { ...sessions.handlers, ...study.handlers } });
  const user = userEvent.setup();
  render(<App />);
  return { user, mock, sessions };
}

const sideCount = () =>
  within(screen.getByRole('navigation', { name: 'メイン' }))
    .getByRole('button', { name: /^今日の出題/ })
    .querySelector('.count')?.textContent ?? null;

async function loaded() {
  await screen.findByRole('navigation', { name: '半荘の一覧' });
  await waitFor(() => expect(sideCount()).toBe('5'), LOAD);
}

async function openReplay(user: ReturnType<typeof userEvent.setup>) {
  await user.click(await screen.findByRole('button', { name: 'この半荘を通して見る' }));
  await screen.findByRole('region', { name: '半荘を進める' });
}

const barLink = () => screen.queryByRole('link', { name: 'NAGA の結果を開く' });
const toastText = () => document.querySelector('.toast .toast-t')?.textContent ?? null;

describe('U-52 通して見る画面の「NAGA の結果を開く」', () => {
  it('URL を保存していない半荘では、操作の段に出ない（キーの一覧のアイコンだけ）', async () => {
    const { user } = setup();
    await loaded();
    await openReplay(user);
    expect(barLink()).toBeNull();
    const bar = screen.getByRole('region', { name: '半荘を進める' });
    expect(within(bar).getByRole('button', { name: 'キーの一覧と割り当て' })).toBeInTheDocument();
  });

  it('URL を保存してある半荘では、1 段目のキーの一覧のアイコンのとなり（左）に、リンクが出る: 名前と説明は「NAGA の結果を開く」、同じ URL、いつものブラウザで開く形', async () => {
    const { user } = setup({ naga: REPORT_URL });
    await loaded();
    await openReplay(user);
    const link = barLink();
    expect(link).not.toBeNull();
    expect(link).toHaveAttribute('href', REPORT_URL);
    expect(link).toHaveAttribute('target', '_blank');
    expect(link?.getAttribute('rel')).toMatch(/noopener/);
    expect(link?.getAttribute('rel')).toMatch(/noreferrer/);
    expect(link).toHaveAttribute('title', 'NAGA の結果を開く');
    // 1 段目の中の、キーの一覧のアイコンの直前
    const keyHelp = screen.getByRole('button', { name: 'キーの一覧と割り当て' });
    const firstRow = document.querySelector('.pb-row.top') as HTMLElement;
    expect(firstRow.contains(link)).toBe(true);
    expect(link?.nextElementSibling).toBe(keyHelp.closest('.keyhelp'));
    // アイコンだけのリンク（文字は読み上げの名前にある）
    expect(link?.textContent).toBe('');
    expect(link?.querySelector('svg')).not.toBeNull();
  });
});

describe('U-52 半荘のページで保存した URL は、通して見る画面にも届く', () => {
  it('貼って保存 → 通して見る画面にリンクが出る。戻って消す → 通して見る画面から消える。Ctrl+Z で戻すと、また出る', async () => {
    const { user, sessions } = setup();
    await loaded();
    const urlInput = await screen.findByRole('textbox', { name: 'NAGA の結果の URL' });
    await user.click(urlInput);
    await user.paste(REPORT_URL);
    await user.click(screen.getByRole('button', { name: '保存' }));
    const section = screen.getByRole('region', { name: 'NAGA の結果' });
    await within(section).findByRole('link', { name: REPORT_URL });
    expect(sessions.session(FX4_ID).naga?.url).toBe(REPORT_URL);
    // 見出しの操作は、「この半荘を通して見る」のとなり
    const head = screen.getByRole('link', { name: 'NAGA の結果を開く' });
    expect(head.closest('.head-actions')?.querySelector('button.primary')?.textContent).toBe('この半荘を通して見る');
    expect(toastText()).toBe('NAGA の結果を保存しました');

    await openReplay(user);
    expect(barLink()).toHaveAttribute('href', REPORT_URL);

    // 半荘のページに戻って消す
    await user.keyboard('{Alt>}{ArrowLeft}{/Alt}');
    const back = await screen.findByRole('region', { name: 'NAGA の結果' });
    await user.click(within(back).getByRole('button', { name: '消す' }));
    await waitFor(() => expect(within(back).queryByRole('link')).toBeNull());
    expect(toastText()).toBe('NAGA の結果を消しました');
    await openReplay(user);
    expect(barLink()).toBeNull();

    // 通して見る画面でも、Ctrl+Z は消したのを戻す（通して見る画面に、文字を打つ欄は無い）
    await user.keyboard('{Control>}z{/Control}');
    await waitFor(() => expect(barLink()).toHaveAttribute('href', REPORT_URL));
    expect(sessions.session(FX4_ID).naga?.url).toBe(REPORT_URL);
    expect(toastText()).toBe('NAGA の結果の削除を元に戻しました');
  });

  it('保存を取り消すと、通知は「NAGA の結果の保存を元に戻しました」。やり直すと「NAGA の結果を保存しました」', async () => {
    const { user } = setup();
    await loaded();
    const urlInput = await screen.findByRole('textbox', { name: 'NAGA の結果の URL' });
    await user.click(urlInput);
    await user.paste(REPORT_URL);
    await user.keyboard('{Enter}');
    await screen.findByRole('link', { name: REPORT_URL });
    await user.keyboard('{Control>}z{/Control}');
    await waitFor(() => expect(toastText()).toBe('NAGA の結果の保存を元に戻しました'));
    await screen.findByRole('textbox', { name: 'NAGA の結果の URL' });
    await user.keyboard('{Control>}y{/Control}');
    await waitFor(() => expect(toastText()).toBe('NAGA の結果を保存しました'));
    await screen.findByRole('link', { name: REPORT_URL });
  });
});
