/**
 * 週の集計の「取り込んだ半荘から数えた値（参考）」の、AI 一致率・類似度・悪手率（ACCEPTANCE の U-48。SPEC の F18）の、画面の試験。
 * アプリ全体（App）を、半荘の保存先の偽物と、答えの記録の偽物の上で動かして、使う人と同じ操作で確かめる。
 * 数え方は、エンジンの ai-metrics.test.ts（E-48）と importedStats.test.ts（どの半荘がどの週に入るか・基準が届くか）。
 * 実ブラウザでの見え方（横スクロール・axe・幅 390px）は tests/browser/week.browser.test.ts。
 */
import { aiMetricsOf, formatRatePercent, formatSimilarity, parseReportText, totalAiMetrics } from '@jantama/engine';
import { act, cleanup, render, screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { REPORT_TEXTS, FakeSessionStore, local, seedSession, type ReportKey } from '../../../tests/fake-sessions';
import { FakeStudyStore } from '../../../tests/fake-study';
import { baseSettings, installTauriMock } from '../../../tests/tauri-mock';
import type { Settings } from '../../api/types';
import { App } from '../App';

vi.mock('@tauri-apps/api/core', () => ({
  invoke: vi.fn(),
  convertFileSrc: (path: string) => path,
}));
vi.mock('@tauri-apps/api/event', () => ({ listen: vi.fn() }));
vi.mock('@tauri-apps/plugin-dialog', () => ({ open: vi.fn() }));

/** 試験の「いま」: 2026 年 10 月 9 日（金）22:00。今週は 10 月 5 日（月）から。 */
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

/** 固定データの 7 半荘を、今週（10/5 から 10/11）に、始めた順に置く。 */
const WEEK: Array<{ key: ReportKey; at: number; id: string }> = [
  { key: 'fx1a', at: local(2026, 10, 5, 10, 0), id: 'g-fx1a' },
  { key: 'fx1b', at: local(2026, 10, 6, 11, 0), id: 'g-fx1b' },
  { key: 'fx1c', at: local(2026, 10, 6, 12, 0), id: 'g-fx1c' },
  { key: 'fx1d', at: local(2026, 10, 7, 13, 0), id: 'g-fx1d' },
  { key: 'fx1e', at: local(2026, 10, 7, 14, 0), id: 'g-fx1e' },
  { key: 'fx5', at: local(2026, 10, 8, 15, 35), id: 'g-fx5' },
  { key: 'fx4', at: local(2026, 10, 9, 19, 9), id: 'g-fx4' },
];

function setup(settings: Partial<Settings> = {}, seeds = WEEK) {
  const store = new FakeSessionStore(seeds.map((seed) => seedSession(seed.at, { id: seed.id, report: seed.key })));
  const study = new FakeStudyStore();
  const mock = installTauriMock({ settings: { ...baseSettings, ...settings }, handlers: { ...store.handlers, ...study.handlers } });
  const user = userEvent.setup();
  render(<App />);
  return { store, study, mock, user };
}

const textOf = (element: Element | null) => (element?.textContent ?? '').replace(/\s+/g, ' ').trim();
const section = (name: string) => screen.getByRole('heading', { level: 2, name }).closest('section') as HTMLElement;
const figure = (id: string) => document.querySelector<HTMLElement>(`figure[data-fig="${id}"]`);
const statTable = (root: HTMLElement) => within(root).getByRole('table', { name: /値ともとの数/ });
const rows = (table: HTMLElement) => within(table).getAllByRole('row').slice(1).map((row) => [...row.querySelectorAll('th, td')].map((cell) => textOf(cell)));

/** 週の集計を開いて、7 半荘の表が出るまで待つ。 */
async function openWeek(user: ReturnType<typeof userEvent.setup>): Promise<HTMLElement> {
  await screen.findByRole('navigation', { name: '半荘の一覧' });
  await user.click(screen.getByRole('button', { name: '週の集計' }));
  await screen.findByRole('heading', { level: 1, name: '週の集計' });
  await waitFor(() => expect(textOf(section(HEADING))).toContain('半荘 / 7半荘'), LOAD);
  return section(HEADING);
}

/** 半荘ごとの表を開いて、その本体の行を返す。 */
async function gameRows(user: ReturnType<typeof userEvent.setup>, root: HTMLElement): Promise<string[][]> {
  const toggle = within(root).getByRole('button', { name: /^半荘ごとに見る/ });
  if (toggle.getAttribute('aria-expanded') !== 'true') await user.click(toggle);
  return rows(within(root).getByRole('table', { name: '取り込んだ半荘ごとの成績' }));
}

/** 同じ結果を、エンジンの関数で数え直した値（画面に出る書き方）。 */
function expected(threshold: number) {
  const each = WEEK.map((seed) => {
    const parsed = parseReportText(REPORT_TEXTS[seed.key]);
    if (!parsed.ok) throw new Error(parsed.error.message);
    return aiMetricsOf(parsed.value, { threshold });
  });
  const total = totalAiMetrics(each);
  const texts = (m: (typeof each)[number]) => [formatRatePercent(m.matchRate ?? Number.NaN), formatSimilarity(m.similarity ?? Number.NaN), formatRatePercent(m.badMoveRate ?? Number.NaN)];
  return { each, total, eachTexts: each.map(texts), totalTexts: texts(total) };
}

describe('U-48 週の集計: AI 一致率・類似度・悪手率', () => {
  it('成績の表の最後に、「AI 一致率」「類似度」「悪手率」の 3 行（値ともとの数）。上の 7 行はそのまま。値は、エンジンの関数で数えた値と同じ', async () => {
    const { user } = setup();
    const root = await openWeek(user);
    const table = rows(statTable(root));
    expect(table.map((row) => row[0])).toEqual(['4位率', '放銃率', '平均順位', '和了率', '副露率', '立直率', '平均和了点', 'AI 一致率', '類似度', '悪手率']);
    expect(table.slice(7)).toEqual([
      ['AI 一致率', '79.4%', '920判断 / 1159判断'],
      ['類似度', '88.9', '1159判断'],
      ['悪手率', '8.8%', '102判断 / 1159判断（確率 5% 未満）'],
    ]);
    // 画面の値 = 同じ結果をエンジンで数えた値
    const { total, totalTexts } = expected(0.05);
    expect([total.decisions, total.matches, total.badMoves]).toEqual([1159, 920, 102]);
    expect(table.slice(7).map((row) => row[1])).toEqual(totalTexts);
    expect(within(statTable(root)).getAllByRole('columnheader').map((cell) => textOf(cell))).toEqual(['項目', '値', 'もとの数']);
  });

  it('既存の 7 行の値は変わらない（4位率 28.6% など）。手入力の成績の欄にも、3 つの値は入らない', async () => {
    const { user } = setup();
    const root = await openWeek(user);
    expect(rows(statTable(root)).slice(0, 7)).toEqual([
      ['4位率', '28.6%', '2半荘 / 7半荘'],
      ['放銃率', '11.0%', '9局 / 82局'],
      ['平均順位', '2.71位', '順位の合計 19 / 7半荘'],
      ['和了率', '19.5%', '16局 / 82局'],
      ['副露率', '29.3%', '24局 / 82局'],
      ['立直率', '19.5%', '16局 / 82局'],
      ['平均和了点', '6,925点', '和了 16回の点数の合計 110,800'],
    ]);
    const manual = section('成績（手入力）');
    expect(textOf(manual)).not.toContain('類似度');
    expect(textOf(manual)).not.toContain('悪手率');
    expect(within(manual).getAllByRole('textbox')).toHaveLength(6);
  });

  it('「半荘ごとに見る」の表の最後に、「AI 一致率」「類似度」「悪手率」の列。始めた順の 7 半荘それぞれの値が、エンジンで数えた値と同じ', async () => {
    const { user } = setup();
    const root = await openWeek(user);
    const body = await gameRows(user, root);
    const table = within(root).getByRole('table', { name: '取り込んだ半荘ごとの成績' });
    const heads = within(table).getAllByRole('columnheader').map((cell) => textOf(cell));
    expect(heads.slice(-4)).toEqual(['平均和了点', 'AI 一致率', '類似度', '悪手率']);
    expect(body).toHaveLength(7);
    expect(body.map((row) => row.slice(8))).toEqual([
      ['75.8%', '86.7', '10.7%'],
      ['80.2%', '90.2', '8.1%'],
      ['76.3%', '83.3', '10.3%'],
      ['81.4%', '91.9', '6.5%'],
      ['77.2%', '87.3', '10.9%'],
      ['81.6%', '92.1', '7.2%'],
      ['88.6%', '93.0', '7.1%'],
    ]);
    expect(body.map((row) => row.slice(8))).toEqual(expected(0.05).eachTexts);
    // 既存の列は、そのまま
    expect(body[0]?.slice(1, 8)).toEqual(['3位', '12', '2', '1', '1', '7', '6,500']);
  });

  it('設定の基準を 10% にすると、悪手率が替わる（週: 10.6%、「確率 10% 未満」）。基準を 5% に戻す（settings-changed）と、8.8% に戻る。一致率と類似度は変わらない', async () => {
    const { user, mock } = setup({ disagreement_percent: 10 });
    await openWeek(user);
    const bad = () => rows(statTable(section(HEADING))).slice(7);
    await waitFor(() => expect(bad()[2]).toEqual(['悪手率', '10.6%', '123判断 / 1159判断（確率 10% 未満）']), LOAD);
    expect(bad().slice(0, 2)).toEqual([
      ['AI 一致率', '79.4%', '920判断 / 1159判断'],
      ['類似度', '88.9', '1159判断'],
    ]);
    const root = section(HEADING);
    expect((await gameRows(user, root)).map((row) => row.slice(8))).toEqual([
      ['75.8%', '86.7', '14.0%'],
      ['80.2%', '90.2', '10.2%'],
      ['76.3%', '83.3', '10.9%'],
      ['81.4%', '91.9', '9.5%'],
      ['77.2%', '87.3', '12.4%'],
      ['81.6%', '92.1', '7.2%'],
      ['88.6%', '93.0', '7.1%'],
    ]);
    expect(expected(0.1).totalTexts).toEqual(['79.4%', '88.9', '10.6%']);

    act(() => {
      mock.emit('settings-changed', { ...baseSettings, disagreement_percent: 5 } satisfies Settings);
    });
    await waitFor(() => expect(bad()[2]).toEqual(['悪手率', '8.8%', '102判断 / 1159判断（確率 5% 未満）']), LOAD);
    expect((await gameRows(user, section(HEADING))).map((row) => row[10])).toEqual(['10.7%', '8.1%', '10.3%', '6.5%', '10.9%', '7.2%', '7.1%']);
  });

  it('呼び名は「AI 一致率」。週の「一致率」（自分の〇△✕ と AI 基準の一致）は別の数で、そのまま残る', async () => {
    const { user } = setup();
    const root = await openWeek(user);
    // 自分の〇△✕ の区画の「一致率」: 図の見出しは「一致率」のまま
    const agree = figure('agree');
    expect(agree).not.toBeNull();
    expect(textOf(agree?.querySelector('.wk-cap') ?? null)).toMatch(/^一致率/);
    // 新しい行は「AI 一致率」。「一致率」とだけ書いた行は、取り込んだ半荘の表には無い
    const labels = rows(statTable(root)).map((row) => row[0]);
    expect(labels).toContain('AI 一致率');
    expect(labels).not.toContain('一致率');
  });

  it('迷いだけの設定が入のときも出る（自分の〇△✕ の一致率の区画だけが隠れる）。切にすると、どちらも出る', async () => {
    const { user, mock } = setup({ doubt_only: true });
    const root = await openWeek(user);
    expect(figure('agree')).toBeNull();
    expect(rows(statTable(root)).slice(7).map((row) => [row[0], row[1]])).toEqual([
      ['AI 一致率', '79.4%'],
      ['類似度', '88.9'],
      ['悪手率', '8.8%'],
    ]);
    act(() => {
      mock.emit('settings-changed', { ...baseSettings, doubt_only: false } satisfies Settings);
    });
    await waitFor(() => expect(figure('agree')).not.toBeNull());
    expect(rows(statTable(section(HEADING))).slice(7).map((row) => row[1])).toEqual(['79.4%', '88.9', '8.8%']);
  });

  it('数える半荘は、既存の値と同じ: 半荘を消すと、3 つの値の判断の数も減る（FX-4 を消すと 1089 判断。一致 858・悪手 97）。元に戻すと戻る', async () => {
    const { user } = setup();
    await openWeek(user);
    await user.click(within(screen.getByRole('navigation', { name: '半荘の一覧' })).getByRole('button', { name: /19:09 の半荘のメニュー/ }));
    await user.click(screen.getByRole('menuitem', { name: '削除' }));
    await user.click(await screen.findByRole('button', { name: '削除' }));
    await waitFor(() => expect(textOf(section(HEADING))).toContain('半荘 / 6半荘'), LOAD);
    const after = rows(statTable(section(HEADING)));
    expect(after[7]).toEqual(['AI 一致率', '78.8%', '858判断 / 1089判断']);
    expect(after[8]?.[2]).toBe('1089判断');
    expect(after[9]).toEqual(['悪手率', '8.9%', '97判断 / 1089判断（確率 5% 未満）']);
    expect((await gameRows(user, section(HEADING))).map((row) => row[0])).toHaveLength(6);

    await user.click(await screen.findByRole('button', { name: '元に戻す' }));
    await waitFor(() => expect(textOf(section(HEADING))).toContain('半荘 / 7半荘'), LOAD);
    expect(rows(statTable(section(HEADING)))[7]).toEqual(['AI 一致率', '79.4%', '920判断 / 1159判断']);
  });

  it('取り込んだ半荘が無い週は、これまでどおり表を出さず 1 行だけ（3 つの行も無い）', async () => {
    const { user } = setup({}, WEEK.slice(0, 2).map((seed) => ({ ...seed, at: seed.at - 14 * 24 * 60 * 60 * 1000 })));
    await screen.findByRole('navigation', { name: '半荘の一覧' });
    await user.click(screen.getByRole('button', { name: '週の集計' }));
    await screen.findByRole('heading', { level: 1, name: '週の集計' });
    await waitFor(() => expect(within(section(HEADING)).getByText('この週に取り込んだ半荘はありません。')).toBeInTheDocument(), LOAD);
    expect(within(section(HEADING)).queryByRole('table')).toBeNull();
    expect(screen.queryByText('AI 一致率')).toBeNull();
  });
});
