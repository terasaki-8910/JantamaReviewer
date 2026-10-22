/**
 * 迷いだけを記録する設定（SPEC F0、ACCEPTANCE の U-46）が入のときの、半荘のページの画面の試験。
 * 〇△✕ を使う部品（局の評価の表の自分の列と付け直し・食い違いの旗・評価の数、取り込む前の評価の一覧）と、終局直後のメモの欄
 * （迷いのカードの「候補」「理由」・迷いマークの無い迷いを足す・追加のメモ・説明のアイコン）を出さず、設定を切ると元どおり出る。記録は消えない。
 * アプリ全体（App）を、半荘の保存先の偽物の上で動かし、設定のイベント（settings-changed）で入・切を切り替える。
 * 週の集計は week/WeekPage.test.tsx、通して見る画面の場面のメモは MarksMemoStudy.test.tsx、実ブラウザの幅 390px は
 * tests/browser/hanchan.browser.test.ts が確かめる。
 */
import { act, render, screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { FakeSessionStore, REPORT_TEXTS, local, seedSession } from '../../tests/fake-sessions';
import { fx4Ocr, fx4Session } from '../../tests/import-fixtures';
import { baseSettings, installTauriMock } from '../../tests/tauri-mock';
import type { Links, Memos, SessionRecord, Settings } from '../api/types';
import { App } from './App';
import { SessionPage } from './SessionPage';
import { summarizeReportText } from './sessionSummaries';
import { UndoProvider } from './undo/UndoProvider';

vi.mock('@tauri-apps/api/core', () => ({
  invoke: vi.fn(),
  convertFileSrc: (path: string) => `asset://localhost/${encodeURIComponent(path)}`,
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

const ID = '20261009-190953';
const LINKS: Links = { marks: {}, ratings: { '7': 'k0h0', '8': 'k1h0', '9': 'k1h1', '10': 'k2h0', '11': 'k2h1' } };
/** 迷い 1 に書いたメモと、迷いマークの無い迷いのメモ（位置だけ）。設定を切り替えても、消えない。 */
const MEMOS: Memos = {
  marks: { '1': { candidates: '3m・6p', reason: '東を残したい' } },
  extras: [{ id: 'x1', position: { kyoku: 1, honba: 0, junme: 5 }, candidates: '白', reason: '追加の理由' }],
};

/** FX-4 の半荘。ウィジェットで付けた評価は、局の順に △・✕・△・✕・✕（東2局・東3局・東3局1本場に旗）。 */
function imported(overrides: Partial<SessionRecord> = {}): SessionRecord {
  const base = fx4Session(ID, local(2026, 10, 9, 19, 9), {
    report_path: `C:\\data\\games\\${ID}\\report.json`,
    ocr: fx4Ocr(),
    links: LINKS,
    memos: MEMOS,
    self_ratings: { kyokus: { k0h0: 'good' } },
    ...overrides,
  });
  const ratings = ['fair', 'bad', 'fair', 'bad', 'bad'] as const;
  return { ...base, ratings: base.ratings.map((r, i) => ({ ...r, rating: ratings[i] ?? r.rating })) };
}

const settingsOf = (doubtOnly: boolean): Settings => ({ ...baseSettings, doubt_only: doubtOnly });

function setup(options: { doubtOnly?: boolean } = {}) {
  // 新しい順: FX-4 の半荘（今日）→ 昨日の、取り込み前の半荘（迷い 2・評価 1）。
  const older = seedSession(local(2026, 10, 8, 21, 0), { marks: 2, ratings: 1 });
  const store = new FakeSessionStore([{ session: imported(), report: 'fx4' }, older]);
  const mock = installTauriMock({ settings: settingsOf(options.doubtOnly ?? true), handlers: store.handlers });
  const user = userEvent.setup();
  render(<App />);
  /** 設定を替えたことを、画面に知らせる（設定ページ・メニュー・同期で変わったときと同じ）。 */
  const setDoubtOnly = (value: boolean) =>
    act(() => {
      mock.emit('settings-changed', settingsOf(value));
    });
  return { store, mock, user, setDoubtOnly };
}

const tableReady = () => screen.findByRole('table', { name: '局の評価' });
const card = (n: number) => screen.getByRole('article', { name: `迷い${n}` });
const headers = (table: HTMLElement) => within(table).getAllByRole('columnheader').map((h) => h.textContent);
const addButton = () => screen.queryByRole('button', { name: /迷いマークの無い迷いを足す/ });
const memoTip = () => screen.queryByRole('button', { name: '終局直後のメモの説明' });

describe('U-46 迷いだけの画面: 局の評価の表（取り込んだ半荘）', () => {
  it('自分の列（付け直し）・食い違いの旗・旗の説明が無い。AI 基準・MAKA・迷いの札は、そのまま出る', async () => {
    setup();
    const table = await tableReady();
    expect(headers(table)).toEqual(['局', '結果', '点', 'AI 基準', 'MAKA', '迷い']);
    expect(screen.queryByRole('button', { name: /自分の評価/ })).toBeNull();
    expect(table.querySelector('.self, .self-btn, .flag, [data-label="自分"]')).toBeNull();
    expect(screen.queryByText('結果が悪かった局を低く付けていないか')).toBeNull();
    expect(screen.queryByText(/どの局にも当てはまりませんでした/)).toBeNull();
    // 残る列: AI 基準の段階と Rating・MAKA の入力・迷いの札
    expect(within(table).getAllByRole('button', { name: /の MAKA を入力$/ }).length).toBeGreaterThan(0);
    expect(table.querySelectorAll('.ai .grade').length).toBeGreaterThan(0);
    expect(within(table).getAllByRole('button', { name: /カードへ移る$/ }).length).toBeGreaterThan(0);
  });

  it('どの行の列の数も、見出しと同じ（自分の列のぶんの空の穴が、行にも半荘全体の行にも残らない）', async () => {
    setup();
    const table = await tableReady();
    const columns = headers(table).length;
    const rows = [...table.querySelectorAll('thead tr, tbody tr:not(.hx-exp), tfoot tr')];
    expect(rows.length).toBeGreaterThan(5);
    for (const row of rows) expect(row.children, row.textContent ?? '').toHaveLength(columns);
    // 表の入れ物に、自分の列が無いことの目印
    expect(table.closest('.tbl-wrap')).toHaveClass('no-self');
  });

  it('局の名前を押すと、その局の結果の手が開く（列が減っても、開いた欄は表の幅いっぱい）', async () => {
    const { user } = setup();
    const table = await tableReady();
    await user.click(within(table).getByRole('button', { name: '東1局' }));
    const open = table.querySelector('tr.hx-exp td') as HTMLElement;
    expect(open).not.toBeNull();
    expect(open).toHaveAttribute('colspan', String(headers(table).length));
  });

  it('切にすると、自分の列・付け直し・旗が元どおり出る。付け直した評価（〇）と、ウィジェットの評価は消えていない', async () => {
    const { setDoubtOnly } = setup();
    const table = await tableReady();
    expect(headers(table)).not.toContain('自分');
    setDoubtOnly(false);
    await waitFor(() => expect(headers(table)).toEqual(['局', '結果', '点', '自分', 'AI 基準', 'MAKA', '迷い']));
    expect(table.closest('.tbl-wrap')).not.toHaveClass('no-self');
    // 東1局は、付け直した〇。東2局は、ウィジェットで付けた✕
    expect(within(table).getByRole('button', { name: '東1局の自分の評価（〇）' })).toBeInTheDocument();
    expect(within(table).getByRole('button', { name: '東2局の自分の評価（✕）' })).toBeInTheDocument();
    expect(table.querySelectorAll('.flag').length).toBeGreaterThan(0);
    expect(screen.getByText('結果が悪かった局を低く付けていないか')).toBeInTheDocument();
    // もう一度入れると、また隠れる
    setDoubtOnly(true);
    await waitFor(() => expect(headers(table)).toEqual(['局', '結果', '点', 'AI 基準', 'MAKA', '迷い']));
    expect(screen.queryByText('結果が悪かった局を低く付けていないか')).toBeNull();
  });

  it('切のとき（これまでの画面）は、自分の列・旗・旗の説明がある', async () => {
    setup({ doubtOnly: false });
    const table = await tableReady();
    expect(headers(table)).toEqual(['局', '結果', '点', '自分', 'AI 基準', 'MAKA', '迷い']);
    expect(within(table).getAllByRole('button', { name: /の自分の評価/ }).length).toBe(5);
    expect(screen.getByText('結果が悪かった局を低く付けていないか')).toBeInTheDocument();
  });
});

describe('U-46 迷いだけの画面: 終局直後のメモの欄（迷いのカード・追加のメモ）', () => {
  it('迷いのカードに「候補」「理由」の欄が無く、迷いマークの無い迷いを足す欄・追加のメモの一覧・メモの説明のアイコンも無い', async () => {
    setup();
    await tableReady();
    expect(screen.getAllByRole('article')).toHaveLength(6);
    for (let n = 1; n <= 6; n += 1) expect(within(card(n)).queryByRole('group', { name: `迷い${n}のメモ` })).toBeNull();
    expect(screen.queryByLabelText('候補')).toBeNull();
    expect(screen.queryByLabelText('理由（1行）')).toBeNull();
    expect(addButton()).toBeNull();
    expect(screen.queryByRole('list', { name: '追加のメモの一覧' })).toBeNull();
    expect(memoTip()).toBeNull();
    // 書いてあった文字も、画面のどこにも出ない（消えたのではなく、出していないだけ）
    expect(document.body.textContent).not.toContain('東を残したい');
    expect(document.body.textContent).not.toContain('追加の理由');
  });

  it('迷いのカードの本体は、そのまま出る: 画像・局面・「推定」・「選び直す」・「この局面を解く」はある（解くボタンは渡されたときだけ）', async () => {
    setup();
    await tableReady();
    expect(within(card(1)).getByRole('button', { name: '迷い1の画像を大きく見る' })).toBeInTheDocument();
    expect(within(card(1)).getByText('推定')).toBeInTheDocument();
    expect(within(card(1)).getByRole('button', { name: '迷い1を選び直す' })).toBeInTheDocument();
    expect(screen.getByRole('heading', { level: 2, name: '迷い（6）' })).toBeInTheDocument();
  });

  it('切にすると、メモの欄・足す欄・追加のメモ・説明のアイコンが元どおり出て、書いてあったメモが入っている', async () => {
    const { setDoubtOnly } = setup();
    await tableReady();
    setDoubtOnly(false);
    const group = await within(card(1)).findByRole('group', { name: '迷い1のメモ' });
    expect(within(group).getByLabelText('候補')).toHaveValue('3m・6p');
    expect(within(group).getByLabelText('理由（1行）')).toHaveValue('東を残したい');
    expect(addButton()).not.toBeNull();
    const extras = screen.getByRole('list', { name: '追加のメモの一覧' });
    expect(within(extras).getByDisplayValue('追加の理由')).toBeInTheDocument();
    expect(memoTip()).not.toBeNull();
    // 入れ直すと、また隠れる
    setDoubtOnly(true);
    await waitFor(() => expect(addButton()).toBeNull());
    expect(screen.queryByLabelText('候補')).toBeNull();
    expect(screen.queryByRole('list', { name: '追加のメモの一覧' })).toBeNull();
  });

  it('隠している間は、メモを保存するコマンドを呼ばない（位置だけの追加のメモの自動の結びつけも、ここでは走らない）', async () => {
    const { mock } = setup();
    await tableReady();
    await act(async () => {
      await Promise.resolve();
    });
    for (const cmd of ['set_memo', 'clear_memo', 'set_extra_memo', 'clear_extra_memo']) expect(mock.count(cmd)).toBe(0);
  });
});

describe('U-46 迷いだけの画面: 取り込む前の半荘・見出し・半荘が無いとき', () => {
  async function openOlder(user: ReturnType<typeof userEvent.setup>) {
    await tableReady();
    const list = screen.getByRole('navigation', { name: '半荘の一覧' });
    await user.click(within(list).getByRole('button', { name: /^21:00/ }));
    await screen.findByRole('heading', { level: 1, name: /10月8日/ });
  }

  it('取り込む前の半荘: 記録した〇△✕の一覧（評価の見出し）が無く、見出しの下の数は迷いだけ。迷いのカードは出る', async () => {
    const { user } = setup();
    await openOlder(user);
    expect(screen.getByText('取り込み前 · 迷い 2')).toBeInTheDocument();
    expect(screen.queryByText(/評価 \d/)).toBeNull();
    expect(screen.queryByRole('heading', { level: 2, name: /^評価（/ })).toBeNull();
    expect(screen.queryByRole('list', { name: '局の評価の一覧' })).toBeNull();
    expect(screen.queryByRole('img', { name: /^[〇△✕]$/ })).toBeNull();
    expect(screen.getAllByRole('article')).toHaveLength(2);
    // メモの欄も、足す欄も出ない（取り込む前の半荘も）
    expect(screen.queryByLabelText('候補')).toBeNull();
    expect(addButton()).toBeNull();
  });

  it('切にすると、取り込む前の半荘の評価の一覧・評価の数・メモの欄が元どおり出る', async () => {
    const { user, setDoubtOnly } = setup();
    await openOlder(user);
    setDoubtOnly(false);
    expect(await screen.findByText('取り込み前 · 迷い 2 · 評価 1')).toBeInTheDocument();
    expect(screen.getByRole('heading', { level: 2, name: '評価（1）' })).toBeInTheDocument();
    expect(within(screen.getByRole('list', { name: '局の評価の一覧' })).getAllByRole('listitem')).toHaveLength(1);
    expect(screen.getAllByLabelText('候補')).toHaveLength(2);
    expect(addButton()).not.toBeNull();
  });

  it('半荘が 1 つも無いとき、〇△✕ のことを言わない（切のときは、これまでの文）', async () => {
    const store = new FakeSessionStore([]);
    const mock = installTauriMock({ settings: settingsOf(true), handlers: store.handlers });
    render(<App />);
    expect(await screen.findByText('ウィジェットの「迷い」を押すと、ここに並びます。')).toBeInTheDocument();
    expect(document.body.textContent).not.toContain('〇△✕');
    act(() => {
      mock.emit('settings-changed', settingsOf(false));
    });
    expect(await screen.findByText('ウィジェットの「迷い」や〇△✕を押すと、ここに並びます。')).toBeInTheDocument();
  });
});

describe('U-46 SessionPage を直接使うとき（doubtOnly の指定）', () => {
  const summary = summarizeReportText(REPORT_TEXTS.fx4);

  function renderPage(doubtOnly: boolean | undefined, session: SessionRecord = imported()) {
    const store = new FakeSessionStore([{ session, report: 'fx4' }]);
    installTauriMock({ handlers: store.handlers });
    return render(
      <UndoProvider>
        <SessionPage session={session} summary={summary} {...(doubtOnly === undefined ? {} : { doubtOnly })} />
      </UndoProvider>,
    );
  }

  it('指定しなければ切（これまでどおり出す）。入にすると、表の自分の列とメモの欄が無い', async () => {
    const view = renderPage(undefined);
    expect(headers(await tableReady())).toContain('自分');
    expect(screen.getAllByLabelText('候補').length).toBeGreaterThan(0);
    view.unmount();
    renderPage(true);
    expect(headers(await tableReady())).not.toContain('自分');
    expect(screen.queryByLabelText('候補')).toBeNull();
  });

  it('結果を読んでいる間の見出しの下も、入のときは「迷い 6」だけ（切のときは「迷い 6 · 評価 5」）', () => {
    const session = imported();
    const off = render(
      <UndoProvider>
        <SessionPage session={session} summary={{ status: 'loading' }} />
      </UndoProvider>,
    );
    expect(screen.getByText('迷い 6 · 評価 5')).toBeInTheDocument();
    off.unmount();
    render(
      <UndoProvider>
        <SessionPage session={session} summary={{ status: 'loading' }} doubtOnly />
      </UndoProvider>,
    );
    expect(screen.getByText('迷い 6')).toBeInTheDocument();
    expect(screen.queryByText(/評価 5/)).toBeNull();
  });
});
