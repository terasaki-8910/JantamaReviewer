/**
 * 半荘のページの「迷い」の列（R11-9、U-27）と、終局直後のメモ（F4、U-28）の画面の試験。
 * 半荘の保存先の偽物（FakeSessionStore）の上で、取り込んだ半荘（FX-5・FX-4）と取り込む前の半荘を出し、使う人と同じ操作で確かめる。
 * 通して見る画面の場面でのメモと、答え合わせのあとのメモは、MarksMemoStudy.test.tsx。実ブラウザでの見え方は、tests/browser/marks-memo.browser.test.ts。
 */
import { act, cleanup, render, screen, waitFor, within } from '@testing-library/react';
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
import { MEMO_INTRO } from './memos';
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
  const importing = store.importHandlers(fx4Ocr());
  const mock = installTauriMock({ handlers: { ...store.handlers, ...importing, ...options.handlers } });
  const user = userEvent.setup();
  const summary: SummaryState | undefined = options.report === undefined ? undefined : summarizeReportText(REPORT_TEXTS[options.report]);
  // 半荘のページの、保存したあとの読み直し（取り込みが済んだあとに、呼び出し側が呼べるよう、外へ出す）
  let reloadPage: () => Promise<void> = async () => undefined;

  function Harness() {
    const [current, setCurrent] = useState(() => store.session(session.id));
    const reload = useCallback(async () => setCurrent(store.session(session.id)), []);
    reloadPage = reload;
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
  /** この半荘に、結果（FX-4）を取り込んだことにして、ページを読み直す（取り込む前に足したメモが、どうなるかを見る）。 */
  const importReport = async (text: string = REPORT_TEXTS.fx4) => {
    await importing.save_report?.({ sessionId: session.id, text });
    await act(async () => reloadPage());
  };
  return { store, mock, user, reopen, importReport };
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
  it('取り込む前の半荘のカードにも、「候補」「理由（1行）」の欄がある（空）。迷いマークの無い迷いも、取り込む前から足せる（「取り込んだあとに足せます」の 1 行は無い）', () => {
    setup({ session: recorded() });
    expect(candidates(1)).toHaveValue('');
    expect(reason(1)).toHaveValue('');
    expect(candidates(1)).toHaveAttribute('placeholder', '例: 3m・6p');
    expect(reason(1)).toHaveAttribute('placeholder', '考えたことを1行で');
    expect(candidates(1)).toHaveAttribute('maxlength', '40');
    expect(reason(1)).toHaveAttribute('maxlength', '80');
    expect(screen.queryByText('迷いマークの無い迷いは、検討結果を取り込んだあとに足せます。')).toBeNull();
    expect(document.body.textContent).not.toContain('取り込んだあとに足せます');
    expect(screen.getByRole('button', { name: '迷いマークの無い迷いを足す' })).toBeEnabled();
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

describe('U-28 取り込む前に迷いマークの無い迷いを足す（位置で。FX-4 の半荘の、取り込む前）', () => {
  type User = ReturnType<typeof userEvent.setup>;
  const addButton = () => screen.getByRole('button', { name: '迷いマークの無い迷いを足す' });
  const submitButton = (panel: HTMLElement) => within(panel).getByRole('button', { name: '足す' });
  const honbaInput = (panel: HTMLElement) => within(panel).getByRole('spinbutton', { name: '本場' });
  const junmeInput = (panel: HTMLElement) => within(panel).getByRole('spinbutton', { name: '巡目' });
  const ID = '20261009-161200';

  async function openPanel(user: User) {
    await user.click(addButton());
    return screen.getByRole('region', { name: '迷いマークの無い迷いを足す' });
  }

  /** 局を名前で選び、本場（あれば）と巡目を入れる。 */
  async function fill(user: User, panel: HTMLElement, where: { kyoku: string; honba?: string; junme: string }) {
    await user.click(within(panel).getByRole('button', { name: '追加するメモの局を選ぶ' }));
    await user.click(screen.getByRole('menuitemradio', { name: where.kyoku }));
    if (where.honba !== undefined) {
      await user.clear(honbaInput(panel));
      await user.type(honbaInput(panel), where.honba);
    }
    await user.type(junmeInput(panel), where.junme);
  }

  it('足すボタンを押すと、局のメニュー・本場（既定 0）・巡目・候補・理由（1行）と、「足す」「やめる」が出る。キーボードの位置は見出しへ移る。「足す」は、局と巡目を入れるまで押せない', async () => {
    const { user } = setup({ session: recorded() });
    const panel = await openPanel(user);
    expect(within(panel).getByRole('heading', { name: '迷いマークの無い迷いを足す' })).toHaveFocus();
    expect(within(panel).getByText('画像が無いので、局と巡目は手で選びます。')).toBeInTheDocument();
    expect(honbaInput(panel)).toHaveValue(0);
    expect(junmeInput(panel)).toHaveValue(null);
    expect(within(panel).getByLabelText('候補')).toHaveValue('');
    expect(within(panel).getByLabelText('理由（1行）')).toHaveValue('');
    expect(submitButton(panel)).toBeDisabled();
    expect(within(panel).getByRole('button', { name: 'やめる' })).toBeEnabled();
    // 局を選んだだけでは、まだ押せない
    await user.click(within(panel).getByRole('button', { name: '追加するメモの局を選ぶ' }));
    await user.click(screen.getByRole('menuitemradio', { name: '東3局' }));
    expect(within(panel).getByRole('button', { name: '追加するメモの局 東3局' })).toBeInTheDocument();
    expect(submitButton(panel)).toBeDisabled();
    await user.type(junmeInput(panel), '9');
    expect(submitButton(panel)).toBeEnabled();
  });

  it('局のメニューは、東1局から西4局までの 12（取り込む前は、西入したかどうかを決める材料が無いので、西も並べる）。本場は 0〜99、巡目は 1〜30 の整数', async () => {
    const { user } = setup({ session: recorded() });
    const panel = await openPanel(user);
    await user.click(within(panel).getByRole('button', { name: '追加するメモの局を選ぶ' }));
    const items = within(screen.getByRole('menu', { name: '追加するメモの局' })).getAllByRole('menuitemradio');
    expect(items.map((item) => item.textContent)).toEqual([
      '東1局', '東2局', '東3局', '東4局', '南1局', '南2局', '南3局', '南4局', '西1局', '西2局', '西3局', '西4局',
    ]);
    await user.keyboard('{Escape}');
    expect(honbaInput(panel)).toHaveAttribute('min', '0');
    expect(honbaInput(panel)).toHaveAttribute('max', '99');
    expect(junmeInput(panel)).toHaveAttribute('min', '1');
    expect(junmeInput(panel)).toHaveAttribute('max', '30');
  });

  it('範囲の外の巡目・本場は、入れた欄の下に理由を出して、「足す」を押せないままにする。直すと、理由は消えて押せる', async () => {
    const { user } = setup({ session: recorded() });
    const panel = await openPanel(user);
    await fill(user, panel, { kyoku: '東3局', junme: '31' });
    expect(within(panel).getByText('巡目は 1〜30 で入れてください。')).toBeInTheDocument();
    expect(junmeInput(panel)).toBeInvalid();
    expect(junmeInput(panel)).toHaveAccessibleDescription('巡目は 1〜30 で入れてください。');
    expect(submitButton(panel)).toBeDisabled();
    await user.clear(junmeInput(panel));
    expect(within(panel).queryByText(/巡目は 1〜30/)).toBeNull();
    await user.type(junmeInput(panel), '0');
    expect(within(panel).getByText('巡目は 1〜30 で入れてください。')).toBeInTheDocument();
    expect(submitButton(panel)).toBeDisabled();
    await user.clear(junmeInput(panel));
    await user.type(junmeInput(panel), '30');
    expect(within(panel).queryByText(/巡目は 1〜30/)).toBeNull();
    expect(submitButton(panel)).toBeEnabled();
    await user.clear(honbaInput(panel));
    await user.type(honbaInput(panel), '100');
    expect(within(panel).getByText('本場は 0〜99 で入れてください。')).toBeInTheDocument();
    expect(submitButton(panel)).toBeDisabled();
    await user.clear(honbaInput(panel));
    await user.type(honbaInput(panel), '2');
    expect(within(panel).queryByText(/本場は 0〜99/)).toBeNull();
    expect(submitButton(panel)).toBeEnabled();
  });

  it('局・本場・巡目・候補・理由を入れて「足す」: 判断の鍵は付けずに位置で保存し、追加のメモのカードが並ぶ。パネルは閉じ、キーボードの位置は、新しいカードの「候補」へ移る', async () => {
    const { user, store } = setup({ session: recorded() });
    const panel = await openPanel(user);
    await fill(user, panel, { kyoku: '東3局', junme: '9' });
    await user.type(within(panel).getByLabelText('候補'), '5s・發');
    await user.type(within(panel).getByLabelText('理由（1行）'), '押すか引くか');
    await user.click(submitButton(panel));
    await waitFor(() =>
      expect(store.session(ID).memos.extras).toEqual([
        { id: 'x1', position: { kyoku: 2, honba: 0, junme: 9 }, candidates: '5s・發', reason: '押すか引くか' },
      ]),
    );
    expect(store.session(ID).memos.extras[0]).not.toHaveProperty('decision');
    expect(calls(store)).toEqual(['set-extra:x1:@2.0.9:5s・發|押すか引くか']);
    expect(screen.queryByRole('region', { name: '迷いマークの無い迷いを足す' })).toBeNull();
    const extra = within(screen.getByRole('list', { name: '追加のメモの一覧' })).getByRole('article', { name: '追加のメモ' });
    expect(within(extra).getByText('迷いマークなし')).toBeInTheDocument();
    expect(within(extra).getByText('手で足した')).toBeInTheDocument();
    expect(within(extra).getByText('東3局 9巡目')).toBeInTheDocument();
    const group = within(extra).getByRole('group', { name: '追加のメモ 東3局 9巡目' });
    expect(within(group).getByLabelText('候補')).toHaveValue('5s・發');
    expect(within(group).getByLabelText('候補')).toHaveFocus();
    // 結果を取り込む前の半荘には、判断を選ぶ欄は無い
    expect(within(extra).queryByRole('button', { name: /局面を選んでください/ })).toBeNull();
    // 迷いの見出しの数は、迷いマークの数のまま（2）
    expect(screen.getByRole('heading', { level: 2, name: '迷い（2）' })).toBeInTheDocument();
    expect(addButton()).toBeInTheDocument();
  });

  it('本場があれば、呼び名に付く（東3局2本場 9巡目）。候補と理由は空のまま足せる。2 つ目の名前は x2', async () => {
    const { user, store } = setup({ session: recorded() });
    let panel = await openPanel(user);
    await fill(user, panel, { kyoku: '東3局', junme: '9' });
    await user.click(submitButton(panel));
    await waitFor(() => expect(store.session(ID).memos.extras).toHaveLength(1));
    panel = await openPanel(user);
    await fill(user, panel, { kyoku: '東3局', honba: '2', junme: '4' });
    await user.click(submitButton(panel));
    await waitFor(() => expect(store.session(ID).memos.extras.map((e) => e.id)).toEqual(['x1', 'x2']));
    expect(store.session(ID).memos.extras[1]).toEqual({ id: 'x2', position: { kyoku: 2, honba: 2, junme: 4 }, candidates: '', reason: '' });
    expect(screen.getByRole('group', { name: '追加のメモ 東3局2本場 4巡目' })).toBeInTheDocument();
  });

  it('保存した追加のメモは、半荘のページを開き直しても残る（位置も、文も）。書き直しても、位置は変わらない（判断の鍵も付かない）', async () => {
    const { user, store, reopen } = setup({ session: recorded() });
    const panel = await openPanel(user);
    await fill(user, panel, { kyoku: '南4局', honba: '1', junme: '12' });
    await user.type(within(panel).getByLabelText('候補'), 'リーチ');
    await user.click(submitButton(panel));
    await waitFor(() => expect(store.session(ID).memos.extras).toHaveLength(1));
    reopen();
    const group = screen.getByRole('group', { name: '追加のメモ 南4局1本場 12巡目' });
    expect(within(group).getByLabelText('候補')).toHaveValue('リーチ');
    await user.type(within(group).getByLabelText('理由（1行）'), '待ちが良い{Enter}');
    await waitFor(() =>
      expect(store.session(ID).memos.extras).toEqual([
        { id: 'x1', position: { kyoku: 7, honba: 1, junme: 12 }, candidates: 'リーチ', reason: '待ちが良い' },
      ]),
    );
    expect(calls(store).every((call) => call.startsWith('set-extra:x1:@7.1.12:'))).toBe(true);
  });

  it('U-11 足したあと Ctrl+Z で足したことを取り消せる（位置も戻る）。Ctrl+Y で足し直す。「消す」も取り消せる（位置も文も元のまま）。書き直しも取り消せる', async () => {
    const { user, store } = setup({ session: recorded() });
    const panel = await openPanel(user);
    await fill(user, panel, { kyoku: '東3局', junme: '9' });
    await user.type(within(panel).getByLabelText('候補'), '5s');
    await user.click(submitButton(panel));
    await waitFor(() => expect(store.session(ID).memos.extras).toHaveLength(1));
    const placed = { id: 'x1', position: { kyoku: 2, honba: 0, junme: 9 }, candidates: '5s', reason: '' };
    await user.click(document.body);
    await undoKey(user);
    await waitFor(() => expect(store.session(ID).memos.extras).toEqual([]));
    expect(screen.queryByRole('list', { name: '追加のメモの一覧' })).toBeNull();
    await redoKey(user);
    await waitFor(() => expect(store.session(ID).memos.extras).toEqual([placed]));
    // 書き直し
    const group = screen.getByRole('group', { name: '追加のメモ 東3局 9巡目' });
    await user.type(within(group).getByLabelText('理由（1行）'), '速い{Enter}');
    await waitFor(() => expect(store.session(ID).memos.extras[0]?.reason).toBe('速い'));
    await user.click(document.body);
    await undoKey(user);
    await waitFor(() => expect(store.session(ID).memos.extras).toEqual([placed]));
    // 消す → 取り消す
    await user.click(screen.getByRole('button', { name: '追加のメモを消す' }));
    await waitFor(() => expect(store.session(ID).memos.extras).toEqual([]));
    await user.click(document.body);
    await undoKey(user);
    await waitFor(() => expect(store.session(ID).memos.extras).toEqual([placed]));
  });

  it('「やめる」で閉じる（何も保存しない）。キーボードの位置は、押したボタンへ戻る', async () => {
    const { user, store } = setup({ session: recorded() });
    const panel = await openPanel(user);
    await fill(user, panel, { kyoku: '東3局', junme: '9' });
    await user.click(within(panel).getByRole('button', { name: 'やめる' }));
    expect(screen.queryByRole('region', { name: '迷いマークの無い迷いを足す' })).toBeNull();
    await waitFor(() => expect(addButton()).toHaveFocus());
    expect(calls(store)).toEqual([]);
    expect(store.session(ID).memos.extras).toEqual([]);
  });

  it('保存できなかったときは、パネルの中に理由を出して、開いたままにする（入れた値は残る）', async () => {
    const { user, store } = setup({ session: recorded() });
    const panel = await openPanel(user);
    await fill(user, panel, { kyoku: '東3局', junme: '9' });
    store.failNextMemo = '半荘のフォルダに書けません';
    await user.click(submitButton(panel));
    expect(await within(panel).findByRole('alert')).toHaveTextContent('メモを足せませんでした: 半荘のフォルダに書けません');
    expect(screen.getByRole('region', { name: '迷いマークの無い迷いを足す' })).toBeInTheDocument();
    expect(junmeInput(panel)).toHaveValue(9);
    expect(store.session(ID).memos.extras).toEqual([]);
  });

  it('Tab で、足すボタン → 局のメニュー → 本場 → 巡目 → 候補 → 理由 → 足す → やめる の順に着く', async () => {
    const { user } = setup({ session: recorded() });
    const panel = await openPanel(user);
    await fill(user, panel, { kyoku: '東3局', junme: '9' });
    within(panel).getByRole('heading').focus();
    const names: string[] = [];
    for (let i = 0; i < 8; i += 1) {
      await user.tab();
      const active = document.activeElement as HTMLElement;
      names.push(active.getAttribute('aria-label') ?? active.textContent ?? '');
    }
    expect(names.slice(0, 7)).toEqual(['追加するメモの局 東3局', '本場', '巡目', '', '', '足す', 'やめる']);
    expect(within(panel).getByLabelText('候補')).toBeInTheDocument();
  });
});

describe('U-28 迷いの見出しのそばの説明（i）', () => {
  it('取り込む前にも取り込んだあとにも、見出し「迷い（N）」のすぐ右の (i) に、終局直後のメモの説明が入る。本文には出ない', async () => {
    const { user } = setup({ session: recorded() });
    const heading = screen.getByRole('heading', { level: 2, name: '迷い（2）' });
    const icon = within(heading.closest('.sec-head') as HTMLElement).getByRole('button', { name: '終局直後のメモの説明' });
    expect(MEMO_INTRO).toBe('AI の答えを見る前に、そのとき考えたことを書き留めます。局と巡目は、検討結果を取り込むときに画像から読むので、書かなくて構いません。');
    expect(heading.closest('section')?.textContent).not.toContain('AI の答えを見る前に');
    expect(screen.queryByRole('tooltip')).toBeNull();
    expect(icon).toHaveAccessibleDescription(MEMO_INTRO);
    await user.hover(icon);
    expect(screen.getByRole('tooltip')).toHaveTextContent(MEMO_INTRO);
    await user.keyboard('{Escape}');
    expect(screen.queryByRole('tooltip')).toBeNull();
    cleanup();
    setup({ session: fx5Imported(), report: 'fx5' });
    await tableReady();
    const imported = screen.getByRole('heading', { level: 2, name: '迷い（13）' });
    expect(within(imported.closest('.sec-head') as HTMLElement).getByRole('button', { name: '終局直後のメモの説明' })).toBeInTheDocument();
  });
});

describe('U-28 取り込んだあとの位置だけのメモ（FX-5。迷いマークの無い迷いの局面を、位置から判断へ結びつける）', () => {
  type User = ReturnType<typeof userEvent.setup>;
  const withExtras = (...extras: Memos['extras']) => fx5Imported({ memos: { marks: {}, extras } });
  const placed = (position: { kyoku: number; honba: number; junme: number }, id = 'x1') => ({ id, position, candidates: '6s', reason: '押す' });
  const picker = () => screen.queryByRole('button', { name: '追加のメモの局面を選んでください' });
  const pickerMenuItems = () => within(screen.getByRole('menu', { name: '追加のメモの局面' })).getAllByRole('menuitemradio');

  async function pickFirst(user: User): Promise<void> {
    await user.click(screen.getByRole('button', { name: '追加のメモの局面を選んでください' }));
    await user.click(pickerMenuItems()[0] as HTMLElement);
  }

  it('位置に自分の判断がちょうど 1 つ（東2局 5巡目 = 打6s）なら、自動で判断の鍵を足す（位置は残す）。選ぶ欄は出ない。取り消しの履歴には載せない', async () => {
    const { store, user } = setup({ session: withExtras(placed({ kyoku: 1, honba: 0, junme: 5 })), report: 'fx5' });
    await tableReady();
    await waitFor(() =>
      expect(store.session(FX5_ID).memos.extras).toEqual([
        { id: 'x1', decision: 'k1h0e5', position: { kyoku: 1, honba: 0, junme: 5 }, candidates: '6s', reason: '押す' },
      ]),
    );
    expect(calls(store)).toEqual(['set-extra:x1:k1h0e5@1.0.5:6s|押す']);
    const group = screen.getByRole('group', { name: '追加のメモ 東2局 5巡目 · 打牌の迷い' });
    expect(within(group).getByLabelText('候補')).toHaveValue('6s');
    expect(within(screen.getByRole('article', { name: '追加のメモ' })).getByText('東2局 5巡目 · 打牌の迷い')).toBeInTheDocument();
    expect(picker()).toBeNull();
    // 利用者の操作ではないので、Ctrl+Z では戻らない
    await user.click(document.body);
    await undoKey(user);
    await new Promise((resolve) => setTimeout(resolve, 50));
    expect(store.session(FX5_ID).memos.extras[0]?.decision).toBe('k1h0e5');
    expect(calls(store)).toHaveLength(1);
  });

  it('1 回だけ結びつける: 半荘のページを開き直しても、結びついたものを書き直さない。判断の鍵だけの古いメモ・鍵と位置の両方を持つメモも、そのまま', async () => {
    const both = { id: 'x2', decision: 'k1h0e5', position: { kyoku: 1, honba: 0, junme: 5 }, candidates: 'a', reason: '' };
    const legacy = { id: 'x3', decision: 'k4h2e5', candidates: 'b', reason: '' };
    const { store, reopen } = setup({ session: withExtras(placed({ kyoku: 1, honba: 0, junme: 5 }), both, legacy), report: 'fx5' });
    await tableReady();
    await waitFor(() => expect(store.session(FX5_ID).memos.extras[0]?.decision).toBe('k1h0e5'));
    expect(calls(store)).toEqual(['set-extra:x1:k1h0e5@1.0.5:6s|押す']);
    reopen();
    await tableReady();
    await new Promise((resolve) => setTimeout(resolve, 50));
    expect(calls(store)).toHaveLength(1);
    expect(store.session(FX5_ID).memos.extras.slice(1)).toEqual([both, legacy]);
    expect(screen.getByRole('group', { name: '追加のメモ 南1局2本場 6巡目 · 打牌の迷い' })).toBeInTheDocument();
    expect(picker()).toBeNull();
  });

  it('その巡目に判断が 2 つ（東2局 4巡目 = 打白・鳴かない判断）なら、そのメモのカードに「局面を選んでください」と、その巡目の判断を出す。選ぶまで何も保存しない', async () => {
    const { store } = setup({ session: withExtras(placed({ kyoku: 1, honba: 0, junme: 4 })), report: 'fx5' });
    await tableReady();
    const card = screen.getByRole('article', { name: '追加のメモ' });
    expect(within(card).getByText('東2局 4巡目')).toBeInTheDocument();
    const button = within(card).getByRole('button', { name: '追加のメモの局面を選んでください' });
    expect(button).toHaveTextContent('局面を選んでください');
    await userEvent.setup().click(button);
    expect(pickerMenuItems().map((item) => item.textContent)).toEqual(['東2局 4巡目 · 打白', '東2局 4巡目 · 鳴かない判断']);
    // AI の候補・確率・順位は出ない
    expect(withoutImagesAndFitLine(document.body.innerHTML)).not.toMatch(/\d\s*[%％]|確率|順位|probab|q_value/i);
    expect(calls(store)).toEqual([]);
    expect(store.session(FX5_ID).memos.extras[0]).not.toHaveProperty('decision');
  });

  it('選ぶと、判断の鍵を足して（位置は残す）、カードは選んだ判断の呼び名になり、選ぶ欄は消えて、キーボードの位置は「候補」へ移る。Ctrl+Z で位置だけに戻り、Ctrl+Y で結びつけ直す', async () => {
    const { store, user } = setup({ session: withExtras(placed({ kyoku: 1, honba: 0, junme: 4 })), report: 'fx5' });
    await tableReady();
    await pickFirst(user);
    const linked = { id: 'x1', decision: 'k1h0e3', position: { kyoku: 1, honba: 0, junme: 4 }, candidates: '6s', reason: '押す' };
    await waitFor(() => expect(store.session(FX5_ID).memos.extras).toEqual([linked]));
    expect(calls(store)).toEqual(['set-extra:x1:k1h0e3@1.0.4:6s|押す']);
    const group = await screen.findByRole('group', { name: '追加のメモ 東2局 4巡目 · 打牌の迷い' });
    expect(picker()).toBeNull();
    await waitFor(() => expect(within(group).getByLabelText('候補')).toHaveFocus());
    // 取り消す（位置だけに戻り、選ぶ欄が戻る。2 つの判断があるので、自動では結びつかない）
    await user.click(document.body);
    await undoKey(user);
    await waitFor(() => expect(store.session(FX5_ID).memos.extras).toEqual([{ id: 'x1', position: linked.position, candidates: '6s', reason: '押す' }]));
    await waitFor(() => expect(picker()).not.toBeNull());
    await redoKey(user);
    await waitFor(() => expect(store.session(FX5_ID).memos.extras).toEqual([linked]));
    expect(picker()).toBeNull();
  });

  it('選んだあと、書き直した文は、結びつけた判断を消さずに保存する（局面ごと書き直す）', async () => {
    const { store, user } = setup({ session: withExtras(placed({ kyoku: 1, honba: 0, junme: 4 })), report: 'fx5' });
    await tableReady();
    await pickFirst(user);
    const group = await screen.findByRole('group', { name: '追加のメモ 東2局 4巡目 · 打牌の迷い' });
    await user.type(within(group).getByLabelText('理由（1行）'), 'です{Enter}');
    await waitFor(() => expect(store.session(FX5_ID).memos.extras[0]?.reason).toBe('押すです'));
    expect(store.session(FX5_ID).memos.extras[0]).toMatchObject({ decision: 'k1h0e3', position: { kyoku: 1, honba: 0, junme: 4 } });
  });

  it('その巡目に判断が無いときは、同じ局の判断から選ぶ（東2局 20巡目 → 東2局の 15 の判断）。自動では結びつけない', async () => {
    const { store, user } = setup({ session: withExtras(placed({ kyoku: 1, honba: 0, junme: 20 })), report: 'fx5' });
    await tableReady();
    await user.click(screen.getByRole('button', { name: '追加のメモの局面を選んでください' }));
    const labels = pickerMenuItems().map((item) => item.textContent ?? '');
    expect(labels).toHaveLength(15);
    expect(labels.every((label) => label.startsWith('東2局 '))).toBe(true);
    expect(labels).toContain('東2局 5巡目 · 打6s');
    expect(calls(store)).toEqual([]);
    await user.click(screen.getByRole('menuitemradio', { name: '東2局 5巡目 · 打6s' }));
    await waitFor(() => expect(store.session(FX5_ID).memos.extras[0]).toMatchObject({ decision: 'k1h0e5', position: { kyoku: 1, honba: 0, junme: 20 } }));
  });

  it('その本場に判断が無いときは、同じ局の判断から選ぶ（東3局 0本場 → 東3局1本場の判断。名前に本場が入る）', async () => {
    setup({ session: withExtras(placed({ kyoku: 2, honba: 0, junme: 3 })), report: 'fx5' });
    await tableReady();
    await userEvent.setup().click(screen.getByRole('button', { name: '追加のメモの局面を選んでください' }));
    const labels = pickerMenuItems().map((item) => item.textContent ?? '');
    expect(labels.length).toBeGreaterThan(0);
    expect(labels.every((label) => label.startsWith('東3局1本場 '))).toBe(true);
    expect(labels).toContain('東3局1本場 3巡目 · 打中');
  });

  it('その局に自分の判断が無いときは、選ぶ欄の代わりに、そう伝える（メモは、位置のまま残る）', async () => {
    const { store } = setup({ session: withExtras(placed({ kyoku: 9, honba: 0, junme: 5 })), report: 'fx5' });
    await tableReady();
    expect(screen.getByText('この局には、自分の判断がありません。')).toBeInTheDocument();
    expect(picker()).toBeNull();
    expect(screen.getByText('西2局 5巡目')).toBeInTheDocument();
    expect(calls(store)).toEqual([]);
  });

  it('取り込む前に足したメモ: 取り込んだら、位置に判断が 1 つのメモは自動で結びつき、2 つのメモは「局面を選んでください」になる。選ぶと結びつく', async () => {
    const { store, user, importReport } = setup({ session: recorded() });
    const ID = '20261009-161200';
    // 取り込む前に、2 つ足す（東2局1本場 6巡目 = 判断 1 つ。同 4巡目 = 判断 2 つ）
    for (const [junme, text] of [['6', '南'], ['4', '鳴く']] as const) {
      await user.click(screen.getByRole('button', { name: '迷いマークの無い迷いを足す' }));
      const panel = screen.getByRole('region', { name: '迷いマークの無い迷いを足す' });
      await user.click(within(panel).getByRole('button', { name: '追加するメモの局を選ぶ' }));
      await user.click(screen.getByRole('menuitemradio', { name: '東2局' }));
      await user.clear(within(panel).getByRole('spinbutton', { name: '本場' }));
      await user.type(within(panel).getByRole('spinbutton', { name: '本場' }), '1');
      await user.type(within(panel).getByRole('spinbutton', { name: '巡目' }), junme);
      await user.type(within(panel).getByLabelText('候補'), text);
      await user.click(within(panel).getByRole('button', { name: '足す' }));
      await waitFor(() => expect(screen.queryByRole('region', { name: '迷いマークの無い迷いを足す' })).toBeNull());
    }
    expect(store.session(ID).memos.extras.map((e) => [e.id, e.decision, e.position])).toEqual([
      ['x1', undefined, { kyoku: 1, honba: 1, junme: 6 }],
      ['x2', undefined, { kyoku: 1, honba: 1, junme: 4 }],
    ]);
    expect(picker()).toBeNull();
    // 結果を取り込む
    await importReport();
    await waitFor(() => expect(store.session(ID).memos.extras[0]?.decision).toBe('k1h1e7'));
    expect(store.session(ID).memos.extras[0]?.position).toEqual({ kyoku: 1, honba: 1, junme: 6 });
    expect(store.session(ID).memos.extras[1]?.decision).toBeUndefined();
    await screen.findByRole('group', { name: '追加のメモ 東2局1本場 6巡目 · 打牌の迷い' });
    await user.click(await screen.findByRole('button', { name: '追加のメモの局面を選んでください' }));
    expect(pickerMenuItems().map((item) => item.textContent)).toEqual(['東2局1本場 4巡目 · 打4s', '東2局1本場 4巡目 · 鳴かない判断']);
    await user.click(pickerMenuItems()[1] as HTMLElement);
    await waitFor(() => expect(store.session(ID).memos.extras[1]).toMatchObject({ decision: 'k1h1e5', position: { kyoku: 1, honba: 1, junme: 4 } }));
    expect(picker()).toBeNull();
    // 取り込んだあとに足すときは、これまでどおり、局 → 判断から選ぶ（位置の入力は出ない）
    await user.click(screen.getByRole('button', { name: '迷いマークの無い迷いを足す' }));
    const panel = screen.getByRole('region', { name: '迷いマークの無い迷いを足す' });
    expect(within(panel).getByRole('button', { name: '追加するメモの巡目と判断を選ぶ' })).toBeInTheDocument();
    expect(within(panel).queryByRole('spinbutton')).toBeNull();
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
