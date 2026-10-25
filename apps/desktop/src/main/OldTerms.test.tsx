/**
 * 呼び方の統一とやめたもの（F19。ACCEPTANCE の U-49）の画面の試験: 主な画面に「大きな不一致」「不一致」「拮抗」が出ない。
 * アプリ全体（App）を、半荘の保存先の偽物と、答えの記録の偽物の上で動かし、使う人と同じ操作で画面を開いて、
 * 見える文字と、読み上げの名前・説明（aria-label・aria-description・title・alt・placeholder）を調べる。
 * 説明のアイコンの重なりの文は、閉じている間も DOM にあるので、文字に入る。
 */
import { render, screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { FakeSessionStore, local, seedSession } from '../../tests/fake-sessions';
import { FakeStudyStore } from '../../tests/fake-study';
import { fx4Ocr, fx4Session } from '../../tests/import-fixtures';
import { revealed } from '../../tests/reveal';
import { baseSettings, installTauriMock } from '../../tests/tauri-mock';
import { App } from './App';

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
const LOAD = { timeout: 20_000 };
const OLD_TERMS = /大きな不一致|不一致|拮抗/;
const ATTRIBUTES = ['aria-label', 'aria-description', 'title', 'alt', 'placeholder'];

function setup() {
  const sessions = new FakeSessionStore([
    {
      session: fx4Session(FX4_ID, local(2026, 10, 9, 19, 9), {
        report_path: `C:\\data\\games\\${FX4_ID}\\report.json`,
        ocr: fx4Ocr(),
        links: { ratings: {}, marks: { '1': 'k0h0e4', '2': 'k1h0e12', '3': 'k1h1e7', '4': 'k1h1e10', '5': 'k2h1e6', '6': 'k2h1e14' } },
      }),
      report: 'fx4' as const,
    },
    seedSession(local(2026, 10, 9, 17, 12), { id: '20261009-171200', report: 'fx1a' }),
  ]);
  const study = new FakeStudyStore();
  installTauriMock({
    // 広げる設定を入にして、AI の1位と違う判断の場面も画面に出す
    settings: { ...baseSettings, show_all_mismatches: true },
    handlers: { ...sessions.handlers, ...study.handlers },
  });
  const user = userEvent.setup();
  render(<App />);
  return { user };
}

const sideButton = (name: RegExp) => within(screen.getByRole('navigation', { name: 'メイン' })).getByRole('button', { name });

/** いまの画面の、見える文字と、読み上げの名前・説明の文字。古い呼び方を含むものだけを返す。 */
function oldTermsOnScreen(): string[] {
  const found: string[] = [];
  const text = document.body.textContent ?? '';
  for (const match of text.matchAll(/.{0,20}(?:大きな不一致|不一致|拮抗).{0,20}/g)) found.push(`文字: ${match[0]}`);
  for (const element of document.body.querySelectorAll('*')) {
    for (const name of ATTRIBUTES) {
      const value = element.getAttribute(name);
      if (value !== null && OLD_TERMS.test(value)) found.push(`${name}: ${value}`);
    }
  }
  return found;
}

describe('U-49 画面に古い呼び方（大きな不一致・不一致・拮抗）が出ない', () => {
  it('半荘のページ・通して見る画面・今日の出題・出題（答える前と答え合わせのあと）・解き直し・ログ・週の集計・設定', { timeout: 60_000 }, async () => {
    const { user } = setup();
    await screen.findByRole('navigation', { name: '半荘の一覧' });
    await waitFor(() => expect(sideButton(/^今日の出題/).querySelector('.count')?.textContent).toBeTruthy(), LOAD);

    // 半荘のページ（起動したときに開く、いちばん新しい半荘）
    await screen.findByRole('button', { name: 'この半荘を通して見る' });
    expect(oldTermsOnScreen(), '半荘のページ').toEqual([]);

    // 通して見る画面（悪手の段と、場面の一覧）
    await user.click(screen.getByRole('button', { name: 'この半荘を通して見る' }));
    await screen.findByRole('region', { name: '半荘を進める' });
    expect(document.querySelector('.jump[data-kind="mismatch"]')?.textContent ?? '').toContain('悪手');
    expect(oldTermsOnScreen(), '通して見る画面').toEqual([]);

    // 今日の出題と、1 問目の出題（答える前・答え合わせのあと）
    await user.click(sideButton(/^今日の出題/));
    await screen.findByRole('heading', { level: 1, name: '今日の出題' });
    expect(oldTermsOnScreen(), '今日の出題').toEqual([]);
    const rows = within(screen.getByRole('list', { name: '今日の出題' })).getAllByRole('button');
    await user.click(rows[0] as HTMLElement);
    await screen.findByLabelText('理由（1行）');
    expect(oldTermsOnScreen(), '出題（答える前）').toEqual([]);
    const radios = screen.queryAllByRole('radio');
    if (radios.length > 0) await user.click(radios[0] as HTMLElement);
    else await user.click(screen.getAllByRole('button', { name: /を切る$/ })[0] as HTMLElement);
    await user.type(screen.getByLabelText('理由（1行）'), '試験の理由');
    await user.click(screen.getByRole('button', { name: '答え合わせ' }));
    await revealed();
    expect(oldTermsOnScreen(), '出題（答え合わせのあと）').toEqual([]);

    // 解き直し・ログ・週の集計・設定
    await user.click(sideButton(/^解き直し/));
    await screen.findByRole('heading', { level: 1, name: '解き直し' });
    expect(oldTermsOnScreen(), '解き直し').toEqual([]);
    await user.click(sideButton(/^ログ/));
    await screen.findByRole('heading', { level: 1, name: 'ログ' });
    expect(oldTermsOnScreen(), 'ログ').toEqual([]);
    await user.click(sideButton(/^週の集計/));
    await screen.findByRole('heading', { level: 1, name: '週の集計' });
    expect(oldTermsOnScreen(), '週の集計').toEqual([]);
    await user.click(screen.getByRole('button', { name: '設定' }));
    await screen.findByRole('heading', { level: 1, name: '設定' });
    expect(screen.getByRole('checkbox', { name: 'AI の1位と違う判断も、飛び先に入れる' })).toBeChecked();
    expect(screen.queryByRole('spinbutton', { name: /基準/ })).toBeNull();
    expect(oldTermsOnScreen(), '設定').toEqual([]);
  });
});
