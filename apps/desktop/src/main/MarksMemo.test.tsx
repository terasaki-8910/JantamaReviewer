/**
 * 半荘のページの「迷い」の列（R11-9、U-27）と、終局直後のメモ（F4、U-28）の画面の試験。
 * 半荘の保存先の偽物（FakeSessionStore）の上で、取り込んだ半荘（FX-5・FX-4）と取り込む前の半荘を出し、使う人と同じ操作で確かめる。
 * 通して見る画面の場面でのメモと、答え合わせのあとのメモは、MarksMemoStudy.test.tsx。実ブラウザでの見え方は、tests/browser/marks-memo.browser.test.ts。
 */
import { cleanup, render, screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { useCallback, useMemo, useState } from 'react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { FakeSessionStore, REPORT_TEXTS, local } from '../../tests/fake-sessions';
import { FX5_ID, FX5_STARTED, FX5_USER_CHOICES, fx4Ocr, fx4Session, fx5Ocr, fx5Session } from '../../tests/import-fixtures';
import { withoutImagesAndFitLine } from '../../tests/fit-line';
import { installTauriMock } from '../../tests/tauri-mock';
import type { Memos, SessionRecord } from '../api/types';
import { MARK_CHIPS_HINT } from './HandTable';
import { MEMO_DEBOUNCE_MS } from './MemoFields';
import { SessionPage, FLASH_MS } from './SessionPage';
import { summarizeReportText, type SummaryState } from './sessionSummaries';
import { UndoProvider } from './undo/UndoProvider';

vi.mock('@tauri-apps/api/core', () => ({
  invoke: vi.fn(),
  convertFileSrc: (path: string) => `asset://localhost/${encodeURIComponent(path)}`,
}));
vi.mock('@tauri-apps/api/event', () => ({ listen: vi.fn() }));

const scrollIntoView = vi.fn();

beforeEach(() => {
  document.body.className = '';
  scrollIntoView.mockReset();
  Object.defineProperty(Element.prototype, 'scrollIntoView', { configurable: true, writable: true, value: scrollIntoView });
});

afterEach(() => {
  cleanup();
});

function fx5Imported(overrides: Partial<SessionRecord> = {}): SessionRecord {
  return fx5Session(FX5_ID, FX5_STARTED, {
    report_path: `C:\\data\\games\\${FX5_ID}\\report.json`,
    ocr: fx5Ocr(),
    links: { marks: {}, ratings: {} },
    ...overrides,
  });
}

const FX4_ID = '20261009-190953';
function fx4Imported(overrides: Partial<SessionRecord> = {}): SessionRecord {
  return fx4Session(FX4_ID, local(2026, 10, 9, 19, 9), {
    report_path: `C:\\data\\games\\${FX4_ID}\\report.json`,
    ocr: fx4Ocr(),
    links: { marks: {}, ratings: {} },
    ...overrides,
  });
}

/** 取り込む前の半荘: 迷い 2（画像なし）。 */
function recorded(overrides: Partial<SessionRecord> = {}): SessionRecord {
  const base = fx4Session('20261009-161200', local(2026, 10, 9, 16, 12));
  const marks = base.marks.slice(0, 2).map((mark) => ({ ...mark, screenshot: null, capture: null, capture_error: '試験の画像なし', screenshot_path: null }));
  return { ...base, mark_count: 2, marks, rating_count: 0, ratings: [], ...overrides };
}

interface SetupOptions {
  session: SessionRecord;
  report?: 'fx4' | 'fx5';
  handlers?: Record<string, (args: unknown) => unknown>;
}

function setup(options: SetupOptions) {
  const { session } = options;
  const store = new FakeSessionStore([{ session, ...(options.report === undefined ? {} : { report: options.report }) }]);
  const mock = installTauriMock({ handlers: { ...store.handlers, ...options.handlers } });
  const user = userEvent.setup();
  const summary: SummaryState | undefined = options.report === undefined ? undefined : summarizeReportText(REPORT_TEXTS[options.report]);

  function Harness() {
    const [current, setCurrent] = useState(() => store.session(session.id));
    const reload = useCallback(async () => setCurrent(store.session(session.id)), []);
    const stable = useMemo(() => summary, []);
    return (
      <UndoProvider>
        <SessionPage session={current} summary={stable} onChanged={reload} />
      </UndoProvider>
    );
  }
  let view = render(<Harness />);
  /** 半荘のページを閉じて、開き直す（保存先は、そのまま。アプリを開き直したのと同じ）。 */
  const reopen = () => {
    view.unmount();
    view = render(<Harness />);
  };
  return { store, mock, user, reopen };
}

const tableReady = () => screen.findByRole('table', { name: '局の評価' });
const card = (n: number) => screen.getByRole('article', { name: `迷い${n}` });
const memoGroup = (n: number) => within(card(n)).getByRole('group', { name: `迷い${n}のメモ` });
const candidates = (n: number) => within(memoGroup(n)).getByLabelText('候補');
const reason = (n: number) => within(memoGroup(n)).getByLabelText('理由（1行）');
const calls = (store: FakeSessionStore) => [...store.memoCalls];
const undoKey = (user: ReturnType<typeof userEvent.setup>) => user.keyboard('{Control>}z{/Control}');
const redoKey = (user: ReturnType<typeof userEvent.setup>) => user.keyboard('{Control>}y{/Control}');

/** 局の評価の表の、局の行（局の名前で探す）。 */
function rowOf(table: HTMLElement, label: string): HTMLElement {
  const header = within(table).getByRole('rowheader', { name: label });
  return header.closest('tr') as HTMLElement;
}

const chipsIn = (row: HTMLElement) => within(row).queryAllByRole('button', { name: /カードへ移る$/ });
const chipTexts = (row: HTMLElement) => chipsIn(row).map((chip) => chip.textContent);

describe('U-27 局の評価の表の「迷い」の列（FX-5）', () => {
  it('列の見出しは「迷い」。局ごとに、その局の迷いが「迷い1 5巡目 打6s」の札で並ぶ。札が無い局は空。半荘全体の行にも札は無い', async () => {
    setup({ session: fx5Imported(), report: 'fx5' });
    const table = await tableReady();
    expect(within(table).getAllByRole('columnheader').map((h) => h.textContent)).toEqual(['局', '結果', '点', '自分', 'AI 基準', 'MAKA', '迷い']);
    expect(chipTexts(rowOf(table, '東1局'))).toEqual([]);
    expect(chipTexts(rowOf(table, '東2局'))).toEqual(['迷い1 5巡目 打6s', '迷い2 6巡目 打9m', '迷い3 巡目は未定']);
    expect(chipTexts(rowOf(table, '東3局'))).toEqual([]);
    expect(chipTexts(rowOf(table, '東3局1本場'))).toEqual(['迷い4 3巡目 打中']);
    expect(chipTexts(rowOf(table, '東4局'))).toEqual(['迷い5 巡目は未定', '迷い6 5巡目 白をポン', '迷い7 8巡目 打3m']);
    expect(chipTexts(rowOf(table, '東4局1本場'))).toEqual([]);
    expect(chipTexts(rowOf(table, '南1局2本場'))).toEqual(['迷い8 3巡目 打1s', '迷い9 10巡目 打8p']);
    expect(chipTexts(rowOf(table, '南2局'))).toEqual(['迷い10 6巡目 打2m', '迷い11 9巡目 7mをポン']);
    expect(chipTexts(rowOf(table, '南3局'))).toEqual(['迷い12 4巡目 打發']);
    expect(chipTexts(rowOf(table, '南4局'))).toEqual(['迷い13 6巡目 打2p']);
    expect(chipsIn(within(table).getByRole('rowheader', { name: '半荘全体' }).closest('tr') as HTMLElement)).toEqual([]);
    // 札の総数は迷いの数（13）と同じ
    expect(within(table).getAllByRole('button', { name: /カードへ移る$/ })).toHaveLength(13);
  });

  it('札の形で状態が分かる（色だけに頼らない）: 推定は枠だけ、巡目は未定は点線、選んだものはチェックつき。読み上げの名前にも状態が入る', async () => {
    setup({ session: fx5Imported({ links: { marks: { ...FX5_USER_CHOICES }, ratings: {} } }), report: 'fx5' });
    const table = await tableReady();
    const first = rowOf(table, '東2局');
    const [one, two, three] = chipsIn(first) as [HTMLElement, HTMLElement, HTMLElement];
    expect(one).toHaveAccessibleName('迷い1 5巡目 打6s（選んだ）。カードへ移る');
    expect(one).toHaveAttribute('data-kind', 'chosen');
    expect(one.querySelector('svg.mk-ck')).not.toBeNull();
    expect(two).toHaveAccessibleName('迷い2 6巡目 打9m（推定）。カードへ移る');
    expect(two).toHaveAttribute('data-kind', 'estimate');
    expect(two.querySelector('svg')).toBeNull();
    expect(three).toHaveAccessibleName('迷い3 8巡目 打9m（選んだ）。カードへ移る');
    // 見える文字が、そのまま読み上げの名前の頭にある（ラベルの文字と名前をそろえる。axe の label-content-name-mismatch）
    for (const chip of [one, two, three]) expect(chip.getAttribute('aria-label')?.startsWith(chip.textContent ?? '?')).toBe(true);
    // 選ぶ前は、迷い 3 は巡目が未定（点線）
    cleanup();
    setup({ session: fx5Imported(), report: 'fx5' });
    const fresh = rowOf(await tableReady(), '東2局');
    const undecided = chipsIn(fresh)[2] as HTMLElement;
    expect(undecided).toHaveAttribute('data-kind', 'undecided');
    expect(undecided).toHaveAccessibleName('迷い3 巡目は未定。カードへ移る');
    expect(undecided.querySelector('svg')).toBeNull();
  });

  it('U-25 札の説明（押すとカードへ移る・点線・チェック）は、本文に出さず、表の見出し「局の評価」のそばの (i) に、乗せるか選ぶと重ねて出る。札が無いときは、列も (i) も出ない', async () => {
    const { user } = setup({ session: fx5Imported(), report: 'fx5' });
    const table = await tableReady();
    expect(MARK_CHIPS_HINT).toBe('迷いの札を押すと、その迷いのカードへ移ります。点線の札は巡目が未定、チェックの付いた札は選んだもの、ほかは推定です。');
    // 本文（表のまわり）には、説明の文が出ていない。説明の重なりも、閉じている
    expect(table.closest('section')?.textContent).not.toContain('迷いの札を押すと');
    expect(document.querySelector('.marks-note')).toBeNull();
    expect(screen.queryByRole('tooltip')).toBeNull();
    // (i) は、見出しのすぐ右。表は、同じ文を読み上げの説明として持つ
    const heading = screen.getByRole('heading', { level: 2, name: '局の評価' });
    const icon = within(heading.closest('.sec-head') as HTMLElement).getByRole('button', { name: '迷いの札の説明' });
    expect(table).toHaveAccessibleDescription(MARK_CHIPS_HINT);
    await user.hover(icon);
    expect(screen.getByRole('tooltip')).toHaveTextContent(MARK_CHIPS_HINT);
    await user.keyboard('{Escape}');
    expect(screen.queryByRole('tooltip')).toBeNull();
    await user.unhover(icon);
    icon.focus();
    await user.keyboard('{Enter}');
    expect(screen.getByRole('tooltip')).toHaveTextContent(MARK_CHIPS_HINT);
    await user.keyboard('{Escape}');
    expect(screen.queryByRole('tooltip')).toBeNull();
    cleanup();
    setup({ session: fx4Imported({ marks: [], mark_count: 0 }), report: 'fx4' });
    const empty = await tableReady();
    expect(within(empty).queryByRole('columnheader', { name: '迷い' })).toBeNull();
    expect(screen.queryByRole('button', { name: '迷いの札の説明' })).toBeNull();
    expect(empty).not.toHaveAttribute('aria-describedby');
  });

  it('札を押すと、その迷いのカードへ移る: カードへキーボードの位置が移り、少しの間目立ち（is-flash）、そのあと戻る。カードが画面の中ほどへ寄る', async () => {
    const { user } = setup({ session: fx5Imported(), report: 'fx5' });
    const table = await tableReady();
    const chip = chipsIn(rowOf(table, '南2局'))[1] as HTMLElement;
    expect(chip).toHaveAccessibleName('迷い11 9巡目 7mをポン（推定）。カードへ移る');
    await user.click(chip);
    const target = card(11);
    expect(target).toHaveFocus();
    expect(target).toHaveClass('is-flash');
    expect(scrollIntoView).toHaveBeenCalledWith({ block: 'center', behavior: 'smooth' });
    await waitFor(() => expect(target).not.toHaveClass('is-flash'), { timeout: FLASH_MS + 1500 });
    // ほかのカードは目立たない
    expect(document.querySelectorAll('.mcard.is-flash')).toHaveLength(0);
  });

  it('キーボードでも同じ: Tab で札に着き、Enter で、そのカードへ移る。続けて別の札を押すと、目立つのは新しいカードだけ', async () => {
    const { user } = setup({ session: fx5Imported(), report: 'fx5' });
    const table = await tableReady();
    const [a, b] = chipsIn(rowOf(table, '東2局')) as [HTMLElement, HTMLElement];
    a.focus();
    await user.keyboard('{Enter}');
    expect(card(1)).toHaveFocus();
    expect(card(1)).toHaveClass('is-flash');
    b.focus();
    await user.keyboard('{Enter}');
    expect(card(2)).toHaveFocus();
    expect(card(2)).toHaveClass('is-flash');
    expect(card(1)).not.toHaveClass('is-flash');
  });

  it('巡目が未定の迷い（迷い 3）の札も、そのカードへ移る', async () => {
    const { user } = setup({ session: fx5Imported(), report: 'fx5' });
    const table = await tableReady();
    await user.click(chipsIn(rowOf(table, '東2局'))[2] as HTMLElement);
    expect(card(3)).toHaveFocus();
    expect(card(3)).toHaveClass('is-flash');
  });

  it('動きを減らす設定では、スクロールをなめらかにしない（色だけが変わる）', async () => {
    const original = window.matchMedia;
    window.matchMedia = ((query: string) => ({ ...original(query), matches: query.includes('reduce') })) as typeof window.matchMedia;
    try {
      const { user } = setup({ session: fx5Imported(), report: 'fx5' });
      const table = await tableReady();
      await user.click(chipsIn(rowOf(table, '東2局'))[0] as HTMLElement);
      expect(scrollIntoView).toHaveBeenCalledWith({ block: 'center', behavior: 'auto' });
      expect(card(1)).toHaveFocus();
    } finally {
      window.matchMedia = original;
    }
  });

  it('迷いを選び直すと、札が替わる（推定の枠だけの札が、選んだチェックつきの札になり、局も移る）', async () => {
    const { user } = setup({ session: fx5Imported(), report: 'fx5' });
    const table = await tableReady();
    expect(chipTexts(rowOf(table, '東2局'))).toContain('迷い3 巡目は未定');
    await user.click(within(card(3)).getByRole('button', { name: '迷い3の判断を選ぶ' }));
    await user.click(screen.getByRole('menuitemradio', { name: '8巡目 · 打9m' }));
    await waitFor(() => expect(chipsIn(rowOf(table, '東2局'))[2]).toHaveAttribute('data-kind', 'chosen'));
    expect(chipsIn(rowOf(table, '東2局'))[2]).toHaveAccessibleName('迷い3 8巡目 打9m（選んだ）。カードへ移る');
  });
});

describe('U-27 局の評価の表の「迷い」の列（FX-4）', () => {
  it('札は、迷いのカードと同じ結びつけ。読み取りがどの局にも合わない迷い（局面を手で選ぶ）は、札にならない', async () => {
    const cache = fx4Ocr();
    cache.entries['marks/m1.png'] = { lines: ['南 2 局', '余 40', '25000'] };
    setup({ session: fx4Imported({ ocr: cache }), report: 'fx4' });
    const table = await tableReady();
    const all = within(table).getAllByRole('button', { name: /カードへ移る$/ }).map((chip) => chip.textContent);
    expect(all.some((text) => text?.startsWith('迷い1'))).toBe(false);
    expect(all).toHaveLength(5);
    expect(screen.getByText('局面は決まっていません')).toBeInTheDocument();
  });
});

describe('U-28 迷いのカードのメモ', () => {
  it('取り込む前の半荘のカードにも、「候補」「理由（1行）」の欄がある（空）。迷いマークの無い迷いは、取り込んだあとに足せることを伝える', () => {
    setup({ session: recorded() });
    expect(candidates(1)).toHaveValue('');
    expect(reason(1)).toHaveValue('');
    expect(candidates(1)).toHaveAttribute('placeholder', '例: 3m・6p');
    expect(reason(1)).toHaveAttribute('placeholder', '考えたことを1行で');
    expect(candidates(1)).toHaveAttribute('maxlength', '40');
    expect(reason(1)).toHaveAttribute('maxlength', '80');
    expect(screen.getByText('迷いマークの無い迷いは、検討結果を取り込んだあとに足せます。')).toBeInTheDocument();
    expect(screen.queryByRole('button', { name: '迷いマークの無い迷いを足す' })).toBeNull();
  });

  it('打って欄の外へ出ると保存する（迷いの記録の番号で）。保存した文は、半荘のページを開き直しても残る', async () => {
    const { user, store, reopen } = setup({ session: recorded() });
    await user.type(candidates(2), '南・6m');
    expect(calls(store)).toEqual([]);
    await user.tab();
    await waitFor(() => expect(store.session('20261009-161200').memos.marks['2']).toEqual({ candidates: '南・6m', reason: '' }));
    await user.type(reason(2), '東を残して形を整えたい{Enter}');
    await waitFor(() => expect(store.session('20261009-161200').memos.marks['2']).toEqual({ candidates: '南・6m', reason: '東を残して形を整えたい' }));
    // 1 つ目のカードには何も入らない
    expect(store.session('20261009-161200').memos.marks['1']).toBeUndefined();
    reopen();
    expect(candidates(2)).toHaveValue('南・6m');
    expect(reason(2)).toHaveValue('東を残して形を整えたい');
    expect(candidates(1)).toHaveValue('');
  });

  it('欄の外へ出ずに、打つのをやめて少し経つ前に画面が替わっても（半荘のページが外れても）、打った文は書き込む', async () => {
    const { user, store, reopen } = setup({ session: recorded() });
    await user.type(candidates(1), '3m・6p');
    expect(calls(store)).toEqual([]);
    reopen();
    await waitFor(() => expect(calls(store)).toEqual(['set:1:3m・6p|']));
    expect(candidates(1)).toHaveValue('3m・6p');
  });

  it('Enter でも保存する（欄の位置は動かない）。変えていないときは、保存しない', async () => {
    const { user, store } = setup({ session: recorded() });
    await user.type(candidates(1), '3m・6p{Enter}');
    await waitFor(() => expect(calls(store)).toEqual(['set:1:3m・6p|']));
    expect(candidates(1)).toHaveFocus();
    await user.tab();
    await user.tab();
    // 打たずに通り過ぎても、書き込まない
    expect(calls(store)).toEqual(['set:1:3m・6p|']);
  });

  it('打つのをやめて少し経つと、欄の外へ出なくても書き込んでおく（取り消しの命令にはしない）。そのあと欄の外へ出ると、1 つの命令になり、取り消すと打ち始める前に戻る', async () => {
    const { user, store } = setup({ session: recorded() });
    await user.type(candidates(1), '3m');
    await new Promise((resolve) => setTimeout(resolve, MEMO_DEBOUNCE_MS + 300));
    await waitFor(() => expect(store.session('20261009-161200').memos.marks['1']).toEqual({ candidates: '3m', reason: '' }));
    expect(calls(store)).toEqual(['set:1:3m|']);
    await user.tab();
    await waitFor(() => expect(calls(store)).toEqual(['set:1:3m|', 'set:1:3m|']));
    // 欄の外にキーボードの位置がある（理由の欄でも、文字を打つ欄の中では、アプリの取り消しは動かない）。ページの外へ出して取り消す
    (document.activeElement as HTMLElement | null)?.blur();
    await undoKey(user);
    await waitFor(() => expect(store.session('20261009-161200').memos.marks['1']).toBeUndefined());
    expect(calls(store).at(-1)).toBe('clear:1');
    await waitFor(() => expect(candidates(1)).toHaveValue(''));
    await redoKey(user);
    await waitFor(() => expect(candidates(1)).toHaveValue('3m'));
  });

  it('U-11 Ctrl+Z: 欄の外では、メモの入力を取り消す・Ctrl+Y でやり直す。欄の中では、アプリの取り消しは動かない（欄の取り消しに任せる）', async () => {
    const { user, store } = setup({ session: recorded() });
    await user.type(candidates(1), 'ポン・スルー');
    await user.tab();
    await waitFor(() => expect(store.session('20261009-161200').memos.marks['1']?.candidates).toBe('ポン・スルー'));
    // 理由の欄に位置がある間は、Ctrl+Z は、アプリの取り消しではない（保存したメモは、そのまま）
    expect(reason(1)).toHaveFocus();
    const before = calls(store).length;
    await undoKey(user);
    expect(calls(store)).toHaveLength(before);
    expect(store.session('20261009-161200').memos.marks['1']?.candidates).toBe('ポン・スルー');
    // 欄の外へ出ると、取り消せる
    await user.click(document.body);
    await undoKey(user);
    await waitFor(() => expect(store.session('20261009-161200').memos.marks['1']).toBeUndefined());
    await redoKey(user);
    await waitFor(() => expect(store.session('20261009-161200').memos.marks['1']?.candidates).toBe('ポン・スルー'));
  });

  it('書き直しの取り消しは、直前の保存に戻す（元の文）。2 回書き直したら、2 回取り消せる', async () => {
    const { user, store } = setup({ session: recorded() });
    await user.type(candidates(1), 'A{Enter}');
    await waitFor(() => expect(store.session('20261009-161200').memos.marks['1']?.candidates).toBe('A'));
    await user.type(candidates(1), 'B{Enter}');
    await waitFor(() => expect(store.session('20261009-161200').memos.marks['1']?.candidates).toBe('AB'));
    await user.click(document.body);
    await undoKey(user);
    await waitFor(() => expect(store.session('20261009-161200').memos.marks['1']?.candidates).toBe('A'));
    await waitFor(() => expect(candidates(1)).toHaveValue('A'));
    await undoKey(user);
    await waitFor(() => expect(store.session('20261009-161200').memos.marks['1']).toBeUndefined());
    await waitFor(() => expect(candidates(1)).toHaveValue(''));
  });

  it('「候補」も「理由」も空にすると、メモを消す。前後の空白は、保存する文から除く', async () => {
    const { user, store } = setup({ session: recorded({ memos: { marks: { '1': { candidates: '3m', reason: '形' } }, extras: [] } }) });
    expect(candidates(1)).toHaveValue('3m');
    expect(reason(1)).toHaveValue('形');
    await user.clear(candidates(1));
    await user.type(candidates(1), '  1p  {Enter}');
    await waitFor(() => expect(store.session('20261009-161200').memos.marks['1']).toEqual({ candidates: '1p', reason: '形' }));
    await user.clear(candidates(1));
    await user.clear(reason(1));
    await user.tab();
    await waitFor(() => expect(store.session('20261009-161200').memos.marks['1']).toBeUndefined());
  });

  it('保存できなかったときは、欄の下に理由を出す（打った文は欄に残る）', async () => {
    const { user, store } = setup({ session: recorded() });
    store.failNextMemo = '半荘のフォルダに書けません';
    await user.type(candidates(1), '3m');
    await user.tab();
    const alert = await within(memoGroup(1)).findByRole('alert');
    expect(alert).toHaveTextContent('メモを保存できませんでした: 半荘のフォルダに書けません');
    expect(candidates(1)).toHaveValue('3m');
    // もう一度打って出ると、保存できる（理由は消える）
    await user.type(candidates(1), '・6p{Enter}');
    await waitFor(() => expect(store.session('20261009-161200').memos.marks['1']?.candidates).toBe('3m・6p'));
    await waitFor(() => expect(within(memoGroup(1)).queryByRole('alert')).toBeNull());
  });

  it('取り込んだ半荘のカードにも、結びつけの欄の下に、メモの欄がある。保存の鍵は、迷いの記録の番号（迷い 1 = 記録の番号 2）', async () => {
    setup({ session: fx5Imported({ memos: { marks: { '2': { candidates: '3m', reason: 'x' } }, extras: [] } }), report: 'fx5' });
    await tableReady();
    const first = card(1);
    // 結びつけの欄（「自分：…」）のあとに、メモの欄が続く
    const link = first.querySelector('.msub');
    const group = within(first).getByRole('group', { name: '迷い1のメモ' });
    expect(link).not.toBeNull();
    expect((link as Element).compareDocumentPosition(group) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy();
    expect(within(first).getByLabelText('候補')).toHaveValue('3m');
    expect(within(first).getByLabelText('理由（1行）')).toHaveValue('x');
    expect(within(card(2)).getByLabelText('候補')).toHaveValue('');
  });

  it('メモの欄には、AI の候補・確率・順位は出ない（答えるまで隠す）', async () => {
    setup({ session: fx5Imported({ memos: { marks: { '2': { candidates: '3m', reason: 'x' } }, extras: [] } }), report: 'fx5' });
    await tableReady();
    const html = withoutImagesAndFitLine(document.body.innerHTML);
    expect(html).not.toMatch(/data-ai/i);
    expect(html).not.toMatch(/\d\s*[%％]|確率|順位|probab|\bprob\b|q_value/i);
  });
});

describe('U-28 迷いマークの無い迷いを足す', () => {
  const addButton = () => screen.getByRole('button', { name: '迷いマークの無い迷いを足す' });

  async function openPanel(user: ReturnType<typeof userEvent.setup>) {
    await user.click(addButton());
    return screen.getByRole('region', { name: '迷いマークの無い迷いを足す' });
  }

  /** 局を名前で、判断を名前か、メニューの何番目か（0 から）で選ぶ。選んだ判断の名前を返す。 */
  async function pick(user: ReturnType<typeof userEvent.setup>, panel: HTMLElement, kyoku: string, decision: string | number) {
    await user.click(within(panel).getByRole('button', { name: '追加するメモの局を選ぶ' }));
    await user.click(screen.getByRole('menuitemradio', { name: kyoku }));
    await user.click(within(panel).getByRole('button', { name: '追加するメモの巡目と判断を選ぶ' }));
    const item = typeof decision === 'string' ? screen.getByRole('menuitemradio', { name: decision }) : screen.getAllByRole('menuitemradio')[decision];
    const name = item?.textContent ?? '';
    await user.click(item as HTMLElement);
    return name;
  }

  it('局のメニュー → 判断のメニューの順に、この半荘の判断から選ぶ。判断のメニューは、選んだ局の判断だけ。局を選ぶまで判断は選べない', async () => {
    const { user } = setup({ session: fx5Imported(), report: 'fx5' });
    await tableReady();
    const panel = await openPanel(user);
    expect(within(panel).getByRole('button', { name: '追加するメモの巡目と判断を選ぶ' })).toBeDisabled();
    expect(within(panel).getByRole('button', { name: '足す' })).toBeDisabled();
    await user.click(within(panel).getByRole('button', { name: '追加するメモの局を選ぶ' }));
    const kyokus = within(screen.getByRole('menu', { name: '追加するメモの局' })).getAllByRole('menuitemradio').map((item) => item.textContent);
    // 判断の無い東3局は選べない
    expect(kyokus).toEqual(['東1局', '東2局', '東3局1本場', '東4局', '東4局1本場', '南1局2本場', '南2局', '南3局', '南4局']);
    await user.click(screen.getByRole('menuitemradio', { name: '東2局' }));
    await user.click(within(panel).getByRole('button', { name: '追加するメモの巡目と判断を選ぶ' }));
    const decisions = within(screen.getByRole('menu', { name: '追加するメモの判断' })).getAllByRole('menuitemradio');
    expect(decisions).toHaveLength(15);
    expect(decisions.map((item) => item.textContent)).toContain('5巡目 · 打6s');
  });

  it('局・判断・候補・理由を入れて「足す」: 判断の鍵で保存し、追加のメモのカードが並ぶ。パネルは閉じ、キーボードの位置は、新しいカードの「候補」へ移る', async () => {
    const { user, store } = setup({ session: fx5Imported(), report: 'fx5' });
    await tableReady();
    const panel = await openPanel(user);
    await pick(user, panel, '東2局', '5巡目 · 打6s');
    await user.type(within(panel).getByLabelText('候補'), '6s・9m');
    await user.type(within(panel).getByLabelText('理由（1行）'), '押すか引くか');
    await user.click(within(panel).getByRole('button', { name: '足す' }));
    await waitFor(() => expect(store.session(FX5_ID).memos.extras).toEqual([{ id: 'x1', decision: 'k1h0e5', candidates: '6s・9m', reason: '押すか引くか' }]));
    expect(calls(store)).toEqual(['set-extra:x1:k1h0e5:6s・9m|押すか引くか']);
    expect(screen.queryByRole('region', { name: '迷いマークの無い迷いを足す' })).toBeNull();
    const list = screen.getByRole('list', { name: '追加のメモの一覧' });
    const extra = within(list).getByRole('article', { name: '追加のメモ' });
    expect(within(extra).getByText('迷いマークなし')).toBeInTheDocument();
    expect(within(extra).getByText('手で足した')).toBeInTheDocument();
    expect(within(extra).getByText('東2局 5巡目 · 打牌の迷い')).toBeInTheDocument();
    const group = within(extra).getByRole('group', { name: '追加のメモ 東2局 5巡目 · 打牌の迷い' });
    expect(within(group).getByLabelText('候補')).toHaveValue('6s・9m');
    expect(within(group).getByLabelText('候補')).toHaveFocus();
    // 迷いの見出しの数は、迷いマークの数のまま（13）
    expect(screen.getByRole('heading', { level: 2, name: '迷い（13）' })).toBeInTheDocument();
    expect(addButton()).toBeInTheDocument();
  });

  it('候補も理由も空のまま足せる（足したあとに書く）。足したメモに書くと、同じ名前で保存し直す', async () => {
    const { user, store } = setup({ session: fx5Imported(), report: 'fx5' });
    await tableReady();
    const panel = await openPanel(user);
    await pick(user, panel, '南4局', 0);
    await user.click(within(panel).getByRole('button', { name: '足す' }));
    await waitFor(() => expect(store.session(FX5_ID).memos.extras).toHaveLength(1));
    const extra = store.session(FX5_ID).memos.extras[0];
    expect(extra).toMatchObject({ id: 'x1', candidates: '', reason: '' });
    expect(extra?.decision).toMatch(/^k7h0e\d+$/);
    const group = screen.getByRole('group', { name: /^追加のメモ 南4局/ });
    await user.type(within(group).getByLabelText('候補'), '1p{Enter}');
    await waitFor(() => expect(store.session(FX5_ID).memos.extras[0]).toEqual({ ...extra, candidates: '1p' }));
    expect(store.session(FX5_ID).memos.extras).toHaveLength(1);
  });

  it('「やめる」で閉じる（何も保存しない）。キーボードの位置は、押したボタンへ戻る', async () => {
    const { user, store } = setup({ session: fx5Imported(), report: 'fx5' });
    await tableReady();
    const panel = await openPanel(user);
    expect(within(panel).getByRole('heading', { name: '迷いマークの無い迷いを足す' })).toHaveFocus();
    await user.click(within(panel).getByRole('button', { name: 'やめる' }));
    expect(screen.queryByRole('region', { name: '迷いマークの無い迷いを足す' })).toBeNull();
    await waitFor(() => expect(addButton()).toHaveFocus());
    expect(calls(store)).toEqual([]);
  });

  it('追加のメモを足したあと、Ctrl+Z で足したことを取り消せる。Ctrl+Y で足し直す。「消す」も取り消せる（判断の鍵も文も元のまま）', async () => {
    const { user, store } = setup({ session: fx5Imported(), report: 'fx5' });
    await tableReady();
    const panel = await openPanel(user);
    await pick(user, panel, '東2局', '5巡目 · 打6s');
    await user.type(within(panel).getByLabelText('候補'), '6s');
    await user.click(within(panel).getByRole('button', { name: '足す' }));
    await waitFor(() => expect(store.session(FX5_ID).memos.extras).toHaveLength(1));
    await user.click(document.body);
    await undoKey(user);
    await waitFor(() => expect(store.session(FX5_ID).memos.extras).toEqual([]));
    expect(screen.queryByRole('list', { name: '追加のメモの一覧' })).toBeNull();
    await redoKey(user);
    await waitFor(() => expect(store.session(FX5_ID).memos.extras).toHaveLength(1));
    await user.click(screen.getByRole('button', { name: '追加のメモを消す' }));
    await waitFor(() => expect(store.session(FX5_ID).memos.extras).toEqual([]));
    await user.click(document.body);
    await undoKey(user);
    await waitFor(() => expect(store.session(FX5_ID).memos.extras).toEqual([{ id: 'x1', decision: 'k1h0e5', candidates: '6s', reason: '' }]));
  });

  it('保存した追加のメモは、半荘のページを開き直しても残る。2 つ目の名前は x2', async () => {
    const memos: Memos = { marks: {}, extras: [{ id: 'x1', decision: 'k4h2e5', candidates: '5s・發', reason: '押すか引くか' }] };
    const { user, store, reopen } = setup({ session: fx5Imported({ memos }), report: 'fx5' });
    await tableReady();
    const group = screen.getByRole('group', { name: /^追加のメモ 南1局2本場/ });
    expect(within(group).getByLabelText('候補')).toHaveValue('5s・發');
    expect(within(group).getByLabelText('理由（1行）')).toHaveValue('押すか引くか');
    const panel = await openPanel(user);
    await pick(user, panel, '東1局', 0);
    await user.click(within(panel).getByRole('button', { name: '足す' }));
    await waitFor(() => expect(store.session(FX5_ID).memos.extras.map((e) => e.id)).toEqual(['x1', 'x2']));
    reopen();
    await tableReady();
    expect(screen.getAllByRole('article', { name: '追加のメモ' })).toHaveLength(2);
  });
});

describe('U-4・U-5 メモと札の操作は、キーボードで届く', () => {
  it('Tab の順: 札 → カードのメモの欄。札は押せるボタン、メモの欄は文字を打つ欄', async () => {
    const { user } = setup({ session: fx5Imported(), report: 'fx5' });
    const table = await tableReady();
    const chip = chipsIn(rowOf(table, '東2局'))[0] as HTMLElement;
    expect(chip.tagName).toBe('BUTTON');
    expect(chip).not.toHaveAttribute('tabindex', '-1');
    await user.click(chip);
    expect(card(1)).toHaveFocus();
    await user.tab();
    // カードの中の次の操作へ進む（画像・結びつけの欄を経て、メモの欄にも着く）
    const reached = new Set<Element | null>();
    for (let i = 0; i < 12; i += 1) {
      reached.add(document.activeElement);
      await user.tab();
    }
    expect(reached.has(candidates(1))).toBe(true);
    expect(reached.has(reason(1))).toBe(true);
  });
});
