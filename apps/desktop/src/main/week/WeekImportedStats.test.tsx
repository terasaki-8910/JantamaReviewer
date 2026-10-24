/**
 * 週の集計の「取り込んだ半荘から数えた値（参考）」（ACCEPTANCE の U-37。F14、R15-7 の B）の、画面の試験。
 * アプリ全体（App）を、半荘の保存先の偽物と、答えの記録（週の成績・重点を含む）の偽物の上で動かして、使う人と同じ操作で確かめる。
 * 数え方は、エンジンの hanchan-stats.test.ts（牌譜から数え直した値）と importedStats.test.ts（どの半荘がどの週に入るか）。
 * 実ブラウザでの見え方（横スクロール・axe・Tab・幅 390px）は tests/browser/week.browser.test.ts。
 */
import { cleanup, render, screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { FakeSessionStore, local, seedSession, type ReportKey } from '../../../tests/fake-sessions';
import { FakeStudyStore } from '../../../tests/fake-study';
import { installTauriMock } from '../../../tests/tauri-mock';
import type { WeekRecord } from '../../api/types';
import { App } from '../App';

vi.mock('@tauri-apps/api/core', () => ({
  invoke: vi.fn(),
  convertFileSrc: (path: string) => path,
}));
vi.mock('@tauri-apps/api/event', () => ({ listen: vi.fn() }));
vi.mock('@tauri-apps/plugin-dialog', () => ({ open: vi.fn() }));

/** 試験の「いま」: 2026 年 10 月 9 日（金）22:00。今週は 10 月 5 日（月）から、先週は 9 月 28 日から。 */
beforeEach(() => {
  vi.useFakeTimers({ toFake: ['Date'] });
  vi.setSystemTime(new Date(2026, 9, 9, 22, 0, 0));
});

afterEach(() => {
  cleanup();
  vi.useRealTimers();
});

const LOAD = { timeout: 20_000 };
const HEADING = '取り込んだ半荘から数えた値（参考）';
const NONE_LINE = 'この週に取り込んだ半荘はありません。';

type Seed = { session: ReturnType<typeof seedSession>['session']; report?: ReportKey };

/** 固定データの 7 半荘を、今週（10/5 から 10/11）に置く。FX-4 は 10/9 19:09。 */
function thisWeek(): Seed[] {
  return [
    seedSession(local(2026, 10, 5, 10, 0), { id: 'g-fx1a', report: 'fx1a' }),
    seedSession(local(2026, 10, 6, 11, 0), { id: 'g-fx1b', report: 'fx1b' }),
    seedSession(local(2026, 10, 6, 12, 0), { id: 'g-fx1c', report: 'fx1c' }),
    seedSession(local(2026, 10, 7, 13, 0), { id: 'g-fx1d', report: 'fx1d' }),
    seedSession(local(2026, 10, 7, 14, 0), { id: 'g-fx1e', report: 'fx1e' }),
    seedSession(local(2026, 10, 8, 15, 35), { id: 'g-fx5', report: 'fx5' }),
    seedSession(local(2026, 10, 9, 19, 9), { id: 'g-fx4', report: 'fx4' }),
  ];
}

function setup(sessions: Seed[] = thisWeek(), study = new FakeStudyStore()) {
  const store = new FakeSessionStore(sessions);
  installTauriMock({ handlers: { ...store.handlers, ...study.handlers } });
  const user = userEvent.setup();
  render(<App />);
  return { store, study, user };
}

/** サイドバーの「週の集計」を押して、ページが数を出すまで待つ。 */
async function openWeek(user: ReturnType<typeof userEvent.setup>) {
  await screen.findByRole('navigation', { name: '半荘の一覧' });
  await user.click(screen.getByRole('button', { name: '週の集計' }));
  await screen.findByRole('heading', { level: 1, name: '週の集計' });
  await screen.findByRole('list', { name: /の数$/ }, LOAD);
}

const textOf = (element: Element | null) => (element?.textContent ?? '').replace(/\s+/g, ' ').trim();
const section = (name: string) => screen.getByRole('heading', { level: 2, name }).closest('section') as HTMLElement;
const range = () => textOf(document.querySelector('.wk-range'));
const statTable = (root: HTMLElement) => within(root).getByRole('table', { name: /値ともとの数/ });
const rows = (table: HTMLElement) => within(table).getAllByRole('row').slice(1).map((row) => [...row.querySelectorAll('th, td')].map((cell) => textOf(cell)));

/** 7 半荘の表が、読み込みを終えて出るまで待つ。 */
async function importedSection(): Promise<HTMLElement> {
  await waitFor(() => expect(screen.getByRole('heading', { level: 2, name: HEADING })).toBeInTheDocument(), LOAD);
  const root = section(HEADING);
  await waitFor(() => expect(textOf(root)).toContain('半荘 / 7半荘'), LOAD);
  return root;
}

describe('U-37 取り込んだ半荘からの成績: 週の集計の別の表（手入力の成績の下）', () => {
  it('成績（手入力）の下に別の表が出る。項目・値・もとの数が、固定データの 7 半荘の値（見本の値）と一致する', async () => {
    const { user } = setup();
    await openWeek(user);
    const root = await importedSection();
    // 手入力の成績の区画の下（DOM の順で後ろ）で、来週の重点の上
    const manual = section('成績（手入力）');
    const focus = section('来週の重点');
    expect(manual.compareDocumentPosition(root) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy();
    expect(root.compareDocumentPosition(focus) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy();
    // 手入力のカードは、表の区画の外
    expect(root.querySelector('input')).toBeNull();
    expect(manual.querySelector('table')).toBeNull();
    expect(rows(statTable(root))).toEqual([
      ['4位率', '28.6%', '2半荘 / 7半荘'],
      ['放銃率', '11.0%', '9局 / 82局'],
      ['平均順位', '2.71位', '順位の合計 19 / 7半荘'],
      ['和了率', '19.5%', '16局 / 82局'],
      ['副露率', '29.3%', '24局 / 82局'],
      ['立直率', '19.5%', '16局 / 82局'],
      ['平均和了点', '6,925点', '和了 16回の点数の合計 110,800'],
      ['AI 一致率', '79.4%', '920判断 / 1159判断'],
      ['類似度', '88.9', '1159判断'],
      ['悪手率', '8.8%', '102判断 / 1159判断（確率 5% 未満）'],
    ]);
    expect(within(statTable(root)).getAllByRole('columnheader').map((cell) => textOf(cell))).toEqual(['項目', '値', 'もとの数']);
  });

  it('見出しのそばの説明のアイコンに、手入力と別であること・雀魂の数字と合わないことが書いてある', async () => {
    const { user } = setup();
    await openWeek(user);
    const root = await importedSection();
    const tip = within(root).getByRole('button', { name: '取り込んだ半荘からの成績の説明' });
    expect(tip).toHaveAccessibleDescription(
      '取り込んだ半荘の記録だけから数えた値です。雀魂の成績の画面は読みません。対局の数が少ないうえ、数え方も雀魂と同じとは限らないので、雀魂の成績の数字とは合いません。手入力の成績は、そのまま残ります。',
    );
  });

  it('手入力の成績の値は変わらない: 取り込んだ半荘が増えても減っても、入れた値も保存した記録もそのまま。この区画からは保存しない', async () => {
    const study = new FakeStudyStore();
    study.weeks.set('2026-10-05', { week: '2026-10-05', stats: { rank4: 20.4, deal: 11.6, avg: 2.41 }, focus: '' } satisfies WeekRecord);
    const { user, store } = setup(thisWeek(), study);
    await openWeek(user);
    const root = await importedSection();
    const manual = section('成績（手入力）');
    const values = () => within(manual).getAllByRole('textbox').map((input) => (input as HTMLInputElement).value);
    await waitFor(() => expect(values()).toEqual(['20.4', '11.6', '2.41', '', '', '']), LOAD);
    expect(textOf(statTable(root))).toContain('28.6%');
    const before = structuredClone([...study.weeks.values()]);

    // 取り込んだ半荘が減る（FX-4 を消す）と、表の値は変わるが、手入力の値と保存した記録は変わらない
    await user.click(within(screen.getByRole('navigation', { name: '半荘の一覧' })).getByRole('button', { name: /19:09 の半荘のメニュー/ }));
    await user.click(screen.getByRole('menuitem', { name: '削除' }));
    await user.click(await screen.findByRole('button', { name: '削除' }));
    await waitFor(() => expect(textOf(section(HEADING))).toContain('半荘 / 6半荘'), LOAD);
    expect(rows(statTable(section(HEADING)))[0]).toEqual(['4位率', '16.7%', '1半荘 / 6半荘']);
    expect(values()).toEqual(['20.4', '11.6', '2.41', '', '', '']);
    expect([...study.weeks.values()]).toEqual(before);
    expect(study.weekCalls).toEqual([]);

    // 元に戻して、取り込んだ半荘が増える（7 半荘に戻る）と、表の値は戻るが、手入力の値と保存した記録は変わらない
    await user.click(await screen.findByRole('button', { name: '元に戻す' }));
    await waitFor(() => expect(textOf(section(HEADING))).toContain('半荘 / 7半荘'), LOAD);
    expect(rows(statTable(section(HEADING)))[0]).toEqual(['4位率', '28.6%', '2半荘 / 7半荘']);
    expect(values()).toEqual(['20.4', '11.6', '2.41', '', '', '']);
    expect([...study.weeks.values()]).toEqual(before);
    expect(study.weekCalls).toEqual([]);
    expect(store.trashedIds).toEqual([]);
    // 別の週（先週。取り込んだ半荘は無い）へ行って戻っても、手入力の値はそのまま
    await user.click(screen.getByRole('button', { name: '前の週' }));
    await user.click(screen.getByRole('button', { name: '次の週' }));
    await waitFor(() => expect(values()).toEqual(['20.4', '11.6', '2.41', '', '', '']), LOAD);
    expect(study.weekCalls).toEqual([]);
  });

  it('手入力の成績を入れても、取り込んだ半荘から数えた表は変わらない', async () => {
    const { user, study } = setup();
    await openWeek(user);
    const root = await importedSection();
    const before = rows(statTable(root));
    await user.type(screen.getByRole('textbox', { name: '4位率' }), '55');
    await user.tab();
    await waitFor(() => expect(study.weeks.get('2026-10-05')?.stats.rank4).toBe(55), LOAD);
    expect(rows(statTable(section(HEADING)))).toEqual(before);
  });

  it('「半荘ごとに見る（7半荘）」は、キーボードで開閉できる。開くと半荘ごとの表（順位・局数・和了・放銃・立直・副露・平均和了点）が出る', async () => {
    const { user } = setup();
    await openWeek(user);
    const root = await importedSection();
    const toggle = within(root).getByRole('button', { name: '半荘ごとに見る（7半荘）' });
    expect(toggle).toHaveAttribute('aria-expanded', 'false');
    expect(within(root).queryByRole('table', { name: '取り込んだ半荘ごとの成績' })).toBeNull();
    // Tab で止まれる。Enter で開く
    toggle.focus();
    await user.keyboard('{Enter}');
    expect(toggle).toHaveAttribute('aria-expanded', 'true');
    const games = within(root).getByRole('table', { name: '取り込んだ半荘ごとの成績' });
    expect(within(games).getAllByRole('columnheader').map((cell) => textOf(cell))).toEqual(['半荘', '順位', '局数', '和了', '放銃', '立直', '副露', '平均和了点', 'AI 一致率', '類似度', '悪手率']);
    const body = rows(games);
    expect(body).toHaveLength(7);
    // 古い順。先頭は f9da（10/5 10:00）、最後は FX-4（10/9 19:09）
    expect(body[0]?.[0]).toMatch(/^10月5日\(月\) 10:00/);
    expect(body[0]?.slice(1)).toEqual(['3位', '12', '2', '1', '1', '7', '6,500', '75.8%', '86.7', '10.7%']);
    expect(body[6]?.[0]).toMatch(/^10月9日\(金\) 19:09/);
    expect(body[6]?.slice(1)).toEqual(['4位', '5', '1', '2', '0', '2', '1,000', '88.6%', '93.0', '7.1%']);
    // 半荘ごとの値の合計が、上の表の「もとの数」になる
    const sum = (column: number) => body.reduce((total, row) => total + Number(row[column]), 0);
    expect(sum(2)).toBe(82);
    expect(sum(3)).toBe(16);
    expect(sum(4)).toBe(9);
    expect(sum(5)).toBe(16);
    expect(sum(6)).toBe(24);
    // Space で閉じる
    await user.keyboard(' ');
    expect(toggle).toHaveAttribute('aria-expanded', 'false');
    expect(within(root).queryByRole('table', { name: '取り込んだ半荘ごとの成績' })).toBeNull();
    // マウスでも開く
    await user.click(toggle);
    expect(toggle).toHaveAttribute('aria-expanded', 'true');
  });

  it('週を替えると、その週の半荘だけを数える。取り込んだ半荘が無い週は、表を出さず 1 行だけ', async () => {
    const seeds: Seed[] = [
      ...thisWeek().slice(5), // FX-5（10/8）と FX-4（10/9）だけ今週
      seedSession(local(2026, 10, 2, 17, 12), { id: 'g-last', report: 'fx1a' }), // 先週
      seedSession(local(2026, 9, 20, 9, 0), { id: 'g-old' }), // 3 週前。結果は取り込んでいない（取り込んだ半荘が無い週）
    ];
    const { user } = setup(seeds);
    await openWeek(user);
    let root = await waitFor(() => {
      const found = section(HEADING);
      expect(textOf(found)).toContain('半荘 / 2半荘');
      return found;
    }, LOAD);
    expect(rows(statTable(root))[0]).toEqual(['4位率', '50.0%', '1半荘 / 2半荘']);
    // 先週: f9da だけ
    await user.click(screen.getByRole('button', { name: '前の週' }));
    expect(range()).toBe('9月28日（月）〜10月4日（日）');
    await waitFor(() => expect(textOf(section(HEADING))).toContain('半荘 / 1半荘'), LOAD);
    root = section(HEADING);
    expect(rows(statTable(root))[0]).toEqual(['4位率', '0.0%', '0半荘 / 1半荘']);
    expect(within(root).getByRole('button', { name: '半荘ごとに見る（1半荘）' })).toBeInTheDocument();
    // 2 週前: 半荘も結果も無い週
    await user.click(screen.getByRole('button', { name: '前の週' }));
    expect(range()).toBe('9月21日（月）〜9月27日（日）');
    root = section(HEADING);
    expect(within(root).getByText(NONE_LINE)).toBeInTheDocument();
    expect(within(root).queryByRole('table')).toBeNull();
    expect(within(root).queryByRole('button', { name: /半荘ごとに見る/ })).toBeNull();
    // 3 週前: 結果を取り込んでいない半荘（迷いマークだけ）がある週も、1 行だけ
    await user.click(screen.getByRole('button', { name: '前の週' }));
    expect(range()).toBe('9月14日（月）〜9月20日（日）');
    expect(within(section(HEADING)).getByText(NONE_LINE)).toBeInTheDocument();
    expect(within(section(HEADING)).queryByRole('table')).toBeNull();
    // 手入力の成績の欄は、どの週にもそのまま出ている
    expect(within(section('成績（手入力）')).getAllByRole('textbox')).toHaveLength(6);
  });

  it('月曜の午前 3 時 59 分に始めた半荘は前の週に数える（午前 4 時の区切り）', async () => {
    const seeds: Seed[] = [
      seedSession(local(2026, 10, 5, 3, 59), { id: 'g-early', report: 'fx4' }),
      seedSession(local(2026, 10, 5, 4, 0), { id: 'g-edge', report: 'fx5' }),
    ];
    const { user } = setup(seeds);
    await openWeek(user);
    await waitFor(() => expect(textOf(section(HEADING))).toContain('半荘 / 1半荘'), LOAD);
    expect(rows(statTable(section(HEADING)))[0]).toEqual(['4位率', '0.0%', '0半荘 / 1半荘']); // FX-5 は 2 位
    await user.click(screen.getByRole('button', { name: '前の週' }));
    await waitFor(() => expect(rows(statTable(section(HEADING)))[0]).toEqual(['4位率', '100.0%', '1半荘 / 1半荘']), LOAD); // FX-4 は 4 位
  });

  it('記録が何も無い（半荘も答えも無い）ときも、今週の区画は 1 行だけ。表は出ない', async () => {
    const { user } = setup([]);
    await openWeek(user);
    const root = section(HEADING);
    expect(within(root).getByText(NONE_LINE)).toBeInTheDocument();
    expect(within(root).queryByRole('table')).toBeNull();
  });
});
