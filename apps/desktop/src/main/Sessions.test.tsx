/**
 * 半荘の一覧・検索と絞り込み・削除と元に戻す・戻る進む・取り消しのキー（ACCEPTANCE の U-8〜U-12）の、画面の試験。
 * アプリ全体（App）を、半荘の保存先の偽物（FakeSessionStore）の上で動かして、使う人と同じ操作で確かめる。
 * 実ブラウザでの見え方（横スクロール・axe・描かれた色）は、tests/browser が確かめる。
 */
import { fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import {
  FakeSessionStore,
  REPORT_TEXTS,
  local,
  seedSession,
  type ReportKey,
} from '../../tests/fake-sessions';
import { installTauriMock } from '../../tests/tauri-mock';
import { App } from './App';
import { summarizeReportText } from './sessionSummaries';

vi.mock('@tauri-apps/api/core', () => ({
  invoke: vi.fn(),
  convertFileSrc: (path: string) => path,
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

/** 承認済みの見本（8 回目のシート）と同じ形の 8 半荘。ids は新しい順に a〜h。 */
const SEED = [
  { key: 'a', at: local(2026, 10, 9, 19, 9), marks: 6, report: 'fx4' },
  { key: 'b', at: local(2026, 10, 8, 21, 40), marks: 3, report: 'fx1a' },
  { key: 'c', at: local(2026, 10, 8, 20, 55), marks: 0, report: 'fx1b' },
  { key: 'd', at: local(2026, 10, 7, 22, 10), marks: 2, report: undefined },
  { key: 'e', at: local(2026, 10, 7, 21, 15), marks: 0, report: 'fx1c' },
  { key: 'f', at: local(2026, 10, 4, 20, 12), marks: 1, report: 'fx1d' },
  { key: 'g', at: local(2026, 10, 4, 19, 30), marks: 0, report: undefined },
  { key: 'h', at: local(2026, 10, 2, 22, 48), marks: 0, report: 'fx1e' },
] as const satisfies ReadonlyArray<{ key: string; at: number; marks: number; report: ReportKey | undefined }>;

type Key = (typeof SEED)[number]['key'];

function seeds() {
  return SEED.map((s) => seedSession(s.at, { marks: s.marks, ...(s.report ? { report: s.report } : {}) }));
}

const idOf = (key: Key) => seeds()[SEED.findIndex((s) => s.key === key)]?.session.id as string;

/** 結果から求めた、その半荘の段階と Rating（画面の行と合わせる）。 */
function summaryOf(key: Key) {
  const report = SEED.find((s) => s.key === key)?.report;
  if (!report) return null;
  const state = summarizeReportText(REPORT_TEXTS[report]);
  if (state.status !== 'ready') throw new Error('結果を読めない');
  return state.summary;
}

function setup(options: { solvedProblems?: (ids: readonly string[]) => number } = {}) {
  const store = new FakeSessionStore(seeds());
  const mock = installTauriMock({ handlers: store.handlers });
  const user = userEvent.setup();
  const view = render(<App solvedProblems={options.solvedProblems} />);
  return { store, mock, user, view };
}

const listNav = () => screen.getByRole('navigation', { name: '半荘の一覧' });
const rowButtons = () => within(listNav()).queryAllByRole('button', { name: /^\d\d:\d\d/ });
const rowOf = (key: Key) => {
  const at = SEED.findIndex((s) => s.key === key);
  return within(listNav()).getAllByRole('button', { name: /^\d\d:\d\d/ })[at] as HTMLElement;
};
const rowByTime = (time: string) => within(listNav()).getByRole('button', { name: new RegExp(`^${time}`) });
/** 選択モードでは、行は「開く」のボタンではなく、チェックの欄になる。 */
const rowCheck = (time: string) => within(listNav()).getByRole('checkbox', { name: new RegExp(`^${time}`) });
const visibleTimes = () => rowButtons().map((b) => b.textContent?.slice(0, 5));

/** 一覧が読めて、結果を取り込んだ半荘の段階の印が出そろうまで待つ。 */
async function ready() {
  await screen.findByRole('heading', { level: 1, name: /10月9日/ });
  const imported = SEED.filter((s) => s.report).length;
  await waitFor(() => expect(within(listNav()).getAllByText(/^[SABCDE][+-]?$/)).toHaveLength(imported));
}

/** 通知（見える部分）の文。読み上げ用の欄にも同じ文が入るので、通知の中だけを見る。 */
const toastText = () => document.querySelector('.toast .toast-t')?.textContent ?? null;
const toastShows = (text: string) => waitFor(() => expect(toastText()).toBe(text));

const menuOf = (row: HTMLElement) => within(row.closest('li') as HTMLElement).getByRole('button', { name: /のメニュー/ });

describe('U-8: 半荘の一覧', () => {
  it('日付ごと（本日・昨日・M月D日）に、新しい順。行に 開始時刻・段階・Rating（小数第 1 位）・迷いの数', async () => {
    setup();
    await ready();
    const headings = within(listNav()).getAllByRole('heading', { level: 3 });
    expect(headings.map((h) => h.textContent)).toEqual(['本日', '昨日', '10月7日', '10月4日', '10月2日']);
    expect(visibleTimes()).toEqual(['19:09', '21:40', '20:55', '22:10', '21:15', '20:12', '19:30', '22:48']);
    const a = summaryOf('a');
    expect(rowOf('a')).toHaveTextContent(`19:09 ${a?.grade} ${a?.ratingText} 迷い6`);
    expect(a?.ratingText).toBe('93.0');
    const b = summaryOf('b');
    expect(rowOf('b')).toHaveTextContent(`21:40 ${b?.grade} ${b?.ratingText} 迷い3`);
    expect(b?.ratingText).toBe('86.7');
    // 迷いが 0 の行には、迷いの文字を出さない。
    expect(rowOf('c').textContent).not.toContain('迷い');
    // 段階の印は、本物の部品（data-grade）。
    expect(within(rowOf('a')).getByText(String(a?.grade))).toHaveAttribute('data-grade', String(a?.grade));
  });

  it('結果を取り込む前の半荘は、段階と Rating の代わりに「取り込み前」と出す', async () => {
    setup();
    await ready();
    expect(rowOf('d')).toHaveTextContent('22:10 取り込み前 迷い2');
    expect(rowOf('g')).toHaveTextContent('19:30 取り込み前');
    expect(within(rowOf('d')).queryByText(/^[SABCDE][+-]?$/)).toBeNull();
  });

  it('結果は、取り込んだ半荘だけを、1 回ずつ読む（一覧のまとめ用と、出題用）。見ている半荘のページだけ、自分の分をもう 1 回。一覧が読み直されても、読み直さない', async () => {
    const { mock } = setup();
    await ready();
    await waitFor(() => expect(mock.count('read_report')).toBe(SEED.filter((s) => s.report).length * 2 + 1));
    const reads = mock.calls().filter((c) => c.cmd === 'read_report');
    const ids = reads.map((c) => (c.args as { sessionId: string }).sessionId);
    const importedIds = SEED.filter((s) => s.report).map((s) => idOf(s.key));
    expect([...new Set(ids)].sort()).toEqual([...importedIds].sort());
    // 一覧のまとめ用が、取り込んだ半荘ごとに 1 回。出題（牌譜を再生した結果）用が、同じく 1 回。見ている半荘（最初は a）のページが、
    // 迷いの結びつけと局の評価の表のために、自分の分を 1 回。
    expect(ids.filter((id) => id !== idOf('a'))).toHaveLength((importedIds.length - 1) * 2);
    expect(ids.filter((id) => id === idOf('a'))).toHaveLength(3);
    const before = mock.count('read_report');
    mock.emit('state-changed', {});
    await waitFor(() => expect(mock.count('list_sessions')).toBeGreaterThanOrEqual(2));
    await new Promise((resolve) => setTimeout(resolve, 20));
    expect(mock.count('read_report')).toBe(before);
  });

  it('半荘を押すと、その半荘の画面が右に出る（行に印が付く）。見出しに卓・段階・Rating', async () => {
    const { user } = setup();
    await ready();
    expect(rowOf('a')).toHaveAttribute('aria-current', 'true');
    await user.click(rowOf('b'));
    expect(await screen.findByRole('heading', { level: 1, name: /10月8日\(木\) 21:40/ })).toBeInTheDocument();
    expect(rowOf('b')).toHaveAttribute('aria-current', 'true');
    expect(rowOf('a')).not.toHaveAttribute('aria-current');
    const main = screen.getByRole('main');
    expect(within(main).getByText('86.7', { selector: '.rate-num' })).toBeInTheDocument();
    expect(within(main).getByText('Rating')).toBeInTheDocument();
    // 取り込み前の半荘。
    await user.click(rowOf('d'));
    expect(await screen.findByRole('heading', { level: 1, name: /10月7日\(水\) 22:10/ })).toBeInTheDocument();
    expect(within(main).getByText('取り込み前 · 迷い 2 · 評価 0')).toBeInTheDocument();
    expect(within(main).queryByText('Rating')).toBeNull();
  });

  it('一覧を読み終えるまでは、「半荘がありません」と出さない（読んだあとに半荘があるのに、一瞬そう見えないように）', async () => {
    let finish: (value: unknown) => void = () => undefined;
    const store = new FakeSessionStore(seeds());
    installTauriMock({
      handlers: {
        ...store.handlers,
        list_sessions: () =>
          new Promise((resolve) => {
            finish = resolve;
          }),
      },
    });
    render(<App />);
    await new Promise((resolve) => setTimeout(resolve, 30));
    expect(screen.queryByText('半荘がありません')).toBeNull();
    expect(screen.queryByRole('heading', { level: 1, name: '半荘がありません' })).toBeNull();
    expect(within(listNav()).queryByRole('searchbox')).toBeNull();
    finish(store.handlers.list_sessions?.(undefined));
    await screen.findByRole('heading', { level: 1, name: /10月9日/ });
    expect(screen.queryByText('半荘がありません')).toBeNull();
  });

  it('結果を読めなかった半荘は、その行に「結果を読めません」と出す（一覧は止まらない）', async () => {
    const store = new FakeSessionStore(seeds());
    installTauriMock({
      handlers: {
        ...store.handlers,
        read_report: (args: unknown) => {
          const id = (args as { sessionId: string }).sessionId;
          return id === idOf('b') ? '{"not":"a report"}' : store.handlers.read_report?.(args);
        },
      },
    });
    render(<App />);
    await screen.findByRole('heading', { level: 1, name: /10月9日/ });
    await waitFor(() => expect(rowOf('b')).toHaveTextContent('21:40 結果を読めません 迷い3'));
    await waitFor(() => expect(within(rowOf('a')).getByText('93.0')).toBeInTheDocument());
  });
});

describe('U-12: 検索と段階の絞り込み', () => {
  it('検索欄（日付・卓・メモ）の語で絞り込む。件数と「解除」の行が出て、解除で全部に戻り、キーボードの位置は検索欄に移る', async () => {
    const { user } = setup();
    await ready();
    const search = screen.getByRole('searchbox', { name: '半荘を検索（日付・卓・メモ）' });
    expect(search).toHaveAttribute('placeholder', '日付・卓・メモ');
    expect(within(listNav()).queryByRole('button', { name: '解除' })).toBeNull();

    await user.type(search, '昨日');
    expect(visibleTimes()).toEqual(['21:40', '20:55']);
    expect(within(listNav()).getByText('「昨日」 2件')).toBeInTheDocument();
    await user.type(search, '{Control>}a{/Control}{Backspace}10/7');
    expect(visibleTimes()).toEqual(['22:10', '21:15']);

    await user.click(within(listNav()).getByRole('button', { name: '解除' }));
    expect(visibleTimes()).toHaveLength(8);
    expect(search).toHaveValue('');
    expect(search).toHaveFocus();
    expect(within(listNav()).queryByRole('button', { name: '解除' })).toBeNull();
  });

  it('卓の名前（玉の間）・日付の言い方（10月7日・全角）・メモの文字（まだ無い）の口。当たる半荘が無ければ、その旨と「解除」を出す', async () => {
    const { user } = setup();
    await ready();
    const search = screen.getByRole('searchbox');
    await user.type(search, '玉の間');
    // 卓は、取り込んだ結果から（取り込み前の半荘は、卓が分からないので当たらない）。
    const rooms = SEED.filter((s) => s.report && summaryOf(s.key)?.room?.includes('玉の間')).map((s) => s.key);
    expect(visibleTimes()).toHaveLength(rooms.length);
    await user.clear(search);
    await user.type(search, '１０月７日');
    expect(visibleTimes()).toEqual(['22:10', '21:15']);
    await user.clear(search);
    await user.type(search, 'zzzzz');
    expect(within(listNav()).getByText('一致する半荘がありません')).toBeInTheDocument();
    expect(within(listNav()).getByText('「zzzzz」 0件')).toBeInTheDocument();
    // 当たらないときは、選択の入口を出さない（操作の相手が無いのに、ボタンが残らない）。
    expect(within(listNav()).queryByRole('button', { name: '選択' })).toBeNull();
    await user.click(within(listNav()).getByRole('button', { name: '解除' }));
    expect(visibleTimes()).toHaveLength(8);
  });

  it('Esc で検索の語を消す。× のボタンでも消える（キーボードの位置は検索欄に残る）', async () => {
    const { user } = setup();
    await ready();
    const search = screen.getByRole('searchbox');
    await user.type(search, '昨日');
    await user.keyboard('{Escape}');
    expect(search).toHaveValue('');
    expect(visibleTimes()).toHaveLength(8);
    await user.type(search, '昨日');
    await user.click(screen.getByRole('button', { name: '検索語を消す' }));
    expect(search).toHaveValue('');
    expect(search).toHaveFocus();
    expect(screen.queryByRole('button', { name: '検索語を消す' })).toBeNull();
  });

  it('「段階」のメニューは すべて / A 以下 / B 以下 / C 以下（範囲つき）。選ぶと絞り込み、件数と「解除」が出る。ボタンの名前に値が付く', async () => {
    const { user } = setup();
    await ready();
    const stageButton = screen.getByRole('button', { name: '段階（すべて）' });
    await user.click(stageButton);
    const menu = screen.getByRole('menu', { name: '段階で絞り込む' });
    const items = within(menu).getAllByRole('menuitemradio');
    expect(items.map((i) => i.textContent)).toEqual(['すべてS+〜E', 'A 以下A+〜E', 'B 以下B+〜E', 'C 以下C+〜E']);
    expect(items.map((i) => i.getAttribute('aria-checked'))).toEqual(['true', 'false', 'false', 'false']);
    expect(items[0]).toHaveFocus();

    await user.click(items[1] as HTMLElement);
    expect(screen.queryByRole('menu')).toBeNull();
    expect(stageButton).toHaveFocus();
    expect(screen.getByRole('button', { name: '段階（A 以下）' })).toBe(stageButton);
    // A 以下 = A+〜E。段階がまだ無い（取り込み前の）半荘は出ない。
    const below = SEED.filter((s) => {
      const grade = summaryOf(s.key)?.grade;
      return grade !== undefined && grade !== null && !['S+', 'S', 'S-'].includes(grade);
    });
    expect(rowButtons()).toHaveLength(below.length);
    for (const button of rowButtons()) {
      expect(button.textContent).not.toContain('取り込み前');
      expect(button.textContent).not.toMatch(/ S[+-]? /);
    }
    expect(within(listNav()).getByText(`A 以下 ${below.length}件`)).toBeInTheDocument();

    // すべてに戻すと、件数の行も消える。
    await user.click(stageButton);
    await user.click(within(screen.getByRole('menu')).getByRole('menuitemradio', { name: /^すべて/ }));
    expect(rowButtons()).toHaveLength(8);
    expect(within(listNav()).queryByText(/件$/)).toBeNull();
  });

  it('段階のメニューは、キーボードだけで開いて選べる（Enter で開く・↓ で動く・Enter で選ぶ・Esc で閉じてボタンに戻る）', async () => {
    const { user } = setup();
    await ready();
    const stageButton = screen.getByRole('button', { name: /^段階/ });
    stageButton.focus();
    await user.keyboard('{Enter}');
    const menu = screen.getByRole('menu');
    expect(within(menu).getAllByRole('menuitemradio')[0]).toHaveFocus();
    await user.keyboard('{ArrowDown}{ArrowDown}');
    expect(within(menu).getAllByRole('menuitemradio')[2]).toHaveFocus();
    await user.keyboard('{End}');
    expect(within(menu).getAllByRole('menuitemradio')[3]).toHaveFocus();
    await user.keyboard('{ArrowDown}');
    expect(within(menu).getAllByRole('menuitemradio')[0]).toHaveFocus();
    await user.keyboard('{Escape}');
    expect(screen.queryByRole('menu')).toBeNull();
    expect(stageButton).toHaveFocus();
    await user.keyboard('{Enter}{ArrowDown}{Enter}');
    expect(screen.getByRole('button', { name: '段階（A 以下）' })).toHaveFocus();
  });

  it('検索と段階は組み合わせられる。件数の行は 「A 以下 · 「昨日」 N件」。当たらなければ、その旨と「解除」', async () => {
    const { user } = setup();
    await ready();
    await user.type(screen.getByRole('searchbox'), '昨日');
    await user.click(screen.getByRole('button', { name: /^段階/ }));
    await user.click(within(screen.getByRole('menu')).getByRole('menuitemradio', { name: /^A 以下/ }));
    // 昨日の 2 つは、どちらも A 以下（A と A+）。
    expect(visibleTimes()).toEqual(['21:40', '20:55']);
    expect(within(listNav()).getByText('A 以下 · 「昨日」 2件')).toBeInTheDocument();
    await user.click(screen.getByRole('button', { name: /^段階/ }));
    await user.click(within(screen.getByRole('menu')).getByRole('menuitemradio', { name: /^B 以下/ }));
    expect(rowButtons()).toHaveLength(0);
    expect(within(listNav()).getByText('B 以下 · 「昨日」 0件')).toBeInTheDocument();
    expect(within(listNav()).getByText('一致する半荘がありません')).toBeInTheDocument();
    await user.click(within(listNav()).getByRole('button', { name: '解除' }));
    expect(visibleTimes()).toHaveLength(8);
    expect(screen.getByRole('button', { name: '段階（すべて）' })).toBeInTheDocument();
  });

  it('絞り込んで見えなくなった半荘は、選択（選択モードのチェック）から外れる。見えない半荘は消さない', async () => {
    const { user, store } = setup();
    await ready();
    await user.click(within(listNav()).getByRole('button', { name: '選択' }));
    await user.click(rowCheck('21:40'));
    await user.click(rowCheck('22:10'));
    expect(within(listNav()).getByText('2件を選択中')).toBeInTheDocument();
    await user.type(screen.getByRole('searchbox'), '昨日');
    expect(within(listNav()).getByText('1件を選択中')).toBeInTheDocument();
    // 解除しても、外れた選択は戻らない。
    await user.click(within(listNav()).getByRole('button', { name: '解除' }));
    expect(within(listNav()).getByText('1件を選択中')).toBeInTheDocument();
    await user.click(within(listNav()).getByRole('button', { name: '削除' }));
    expect(screen.getByRole('alertdialog')).toHaveTextContent('1件の半荘を削除します。');
    await user.click(within(screen.getByRole('alertdialog')).getByRole('button', { name: '削除' }));
    await waitFor(() => expect(store.log).toEqual([`delete:${idOf('b')}`]));
  });

  it('いま開いている半荘が絞り込みで見えなくなっても、本文はそのまま（選択モードのチェックだけが外れる）', async () => {
    const { user } = setup();
    await ready();
    await user.type(screen.getByRole('searchbox'), '昨日');
    expect(screen.getByRole('heading', { level: 1, name: /10月9日/ })).toBeInTheDocument();
    expect(visibleTimes()).toEqual(['21:40', '20:55']);
  });
});

describe('U-9: 削除（行の「…」・選択）', () => {
  it('行の「…」のメニューは 開く / 削除。確認には件数が出る。確定する前は、何も消えない', async () => {
    const { user, store } = setup();
    await ready();
    await user.click(menuOf(rowOf('d')));
    const menu = screen.getByRole('menu', { name: '半荘のメニュー' });
    expect(within(menu).getAllByRole('menuitem').map((i) => i.textContent)).toEqual(['開く', '削除']);
    expect(within(menu).getAllByRole('menuitem')[0]).toHaveFocus();
    await user.click(within(menu).getByRole('menuitem', { name: '削除' }));

    const dialog = screen.getByRole('alertdialog');
    expect(dialog).toHaveAttribute('aria-modal', 'true');
    expect(within(dialog).getByRole('heading', { name: '1件の半荘を削除します。' })).toBeInTheDocument();
    expect(dialog).toHaveAccessibleDescription('記録とスクショも消えます。アプリを閉じるまでは元に戻せます。');
    expect(within(dialog).getAllByRole('button').map((b) => b.textContent)).toEqual(['削除', 'キャンセル']);
    expect(within(dialog).getByRole('button', { name: 'キャンセル' })).toHaveFocus();
    expect(document.querySelector('.app')).toHaveAttribute('inert');
    expect(store.log).toEqual([]);
  });

  it('Esc・背景の押下・キャンセルのどれでも、何も消えずに閉じて、キーボードの位置は「…」に戻る', async () => {
    const { user, store } = setup();
    await ready();
    const more = menuOf(rowOf('d'));
    for (const how of ['escape', 'backdrop', 'cancel'] as const) {
      await user.click(more);
      await user.click(within(screen.getByRole('menu')).getByRole('menuitem', { name: '削除' }));
      const dialog = screen.getByRole('alertdialog');
      if (how === 'escape') await user.keyboard('{Escape}');
      else if (how === 'backdrop') await user.click(dialog.parentElement as HTMLElement);
      else await user.click(within(dialog).getByRole('button', { name: 'キャンセル' }));
      expect(screen.queryByRole('alertdialog'), how).toBeNull();
      expect(document.querySelector('.app'), how).not.toHaveAttribute('inert');
      await waitFor(() => expect(more, how).toHaveFocus());
      expect(rowButtons(), how).toHaveLength(8);
    }
    expect(store.log).toEqual([]);
  });

  it('確認の中の押下（ダイアログそのもの）では閉じない。Tab は 2 つのボタンの間だけを回る', async () => {
    const { user } = setup();
    await ready();
    await user.click(menuOf(rowOf('d')));
    await user.click(within(screen.getByRole('menu')).getByRole('menuitem', { name: '削除' }));
    const dialog = screen.getByRole('alertdialog');
    const cancel = within(dialog).getByRole('button', { name: 'キャンセル' });
    const confirm = within(dialog).getByRole('button', { name: '削除' });
    expect(cancel).toHaveFocus();
    // ダイアログの中の文字を押しても、閉じない（文字を選ぶだけ）。
    await user.click(within(dialog).getByRole('heading'));
    expect(screen.getByRole('alertdialog')).toBeInTheDocument();
    // Tab は、ダイアログの外へ出ずに、2 つのボタンの間を回る。
    await user.tab();
    expect(confirm).toHaveFocus();
    await user.tab();
    expect(cancel).toHaveFocus();
    await user.tab();
    expect(confirm).toHaveFocus();
    await user.tab({ shift: true });
    expect(cancel).toHaveFocus();
    await user.tab({ shift: true });
    expect(confirm).toHaveFocus();
  });

  it('確定すると一覧から消え、通知に「N件の半荘を削除しました」と「元に戻す」が出る。押すと元の位置に戻る', async () => {
    const { user, store } = setup();
    await ready();
    await user.click(menuOf(rowOf('c')));
    await user.click(within(screen.getByRole('menu')).getByRole('menuitem', { name: '削除' }));
    await user.click(within(screen.getByRole('alertdialog')).getByRole('button', { name: '削除' }));

    await toastShows('1件の半荘を削除しました');
    expect(store.log).toEqual([`delete:${idOf('c')}`]);
    expect(store.trashedIds).toEqual([idOf('c')]);
    await waitFor(() => expect(visibleTimes()).toEqual(['19:09', '21:40', '22:10', '21:15', '20:12', '19:30', '22:48']));
    const undo = screen.getByRole('button', { name: '元に戻す' });
    expect(undo).toHaveAttribute('aria-keyshortcuts', 'Control+Z');
    expect(undo).toHaveAttribute('title', '元に戻す（Ctrl+Z）');

    await user.click(undo);
    await toastShows('1件の半荘を元に戻しました');
    await waitFor(() => expect(visibleTimes()).toEqual(['19:09', '21:40', '20:55', '22:10', '21:15', '20:12', '19:30', '22:48']));
    expect(store.log).toEqual([`delete:${idOf('c')}`, `restore:${idOf('c')}`]);
    // 取り消したあとの通知には、「元に戻す」は出ない。押して消えたボタンから、キーボードの位置が消えず、「選択」に移る。
    expect(screen.queryByRole('button', { name: '元に戻す' })).toBeNull();
    await waitFor(() => expect(within(listNav()).getByRole('button', { name: '選択' })).toHaveFocus());
  });

  it('Ctrl+Z でも元に戻り、Ctrl+Y でやり直せる。通知を閉じたあとも、Ctrl+Z は効く（アプリを閉じるまで戻せる）', async () => {
    const { user, store } = setup();
    await ready();
    await user.click(menuOf(rowOf('c')));
    await user.click(within(screen.getByRole('menu')).getByRole('menuitem', { name: '削除' }));
    await user.click(within(screen.getByRole('alertdialog')).getByRole('button', { name: '削除' }));
    await toastShows('1件の半荘を削除しました');
    // 通知を閉じる（8 秒たって消えたのと同じ）。
    await user.click(screen.getByRole('button', { name: '閉じる' }));
    expect(document.querySelector('.toast')).toBeNull();
    expect(screen.queryByRole('button', { name: '元に戻す' })).toBeNull();
    await waitFor(() => expect(visibleTimes()).toHaveLength(7));

    await user.keyboard('{Control>}z{/Control}');
    await waitFor(() => expect(visibleTimes()).toHaveLength(8));
    await toastShows('1件の半荘を元に戻しました');

    await user.keyboard('{Control>}y{/Control}');
    await waitFor(() => expect(visibleTimes()).toHaveLength(7));
    await toastShows('1件の半荘を削除しました');
    expect(store.log).toEqual([
      `delete:${idOf('c')}`,
      `restore:${idOf('c')}`,
      `delete:${idOf('c')}`,
    ]);
    // 戻すものが無くなったあとの Ctrl+Z は、何もしない。
    await user.keyboard('{Control>}z{/Control}');
    await waitFor(() => expect(visibleTimes()).toHaveLength(8));
    await user.keyboard('{Control>}z{/Control}');
    expect(store.log).toHaveLength(4);
    expect(visibleTimes()).toHaveLength(8);
  });

  it('文字を打つ欄（検索）の中の Ctrl+Z は、その欄の取り消しに任せて、削除を戻さない', async () => {
    const { user, store } = setup();
    await ready();
    await user.click(menuOf(rowOf('c')));
    await user.click(within(screen.getByRole('menu')).getByRole('menuitem', { name: '削除' }));
    await user.click(within(screen.getByRole('alertdialog')).getByRole('button', { name: '削除' }));
    await toastShows('1件の半荘を削除しました');
    await waitFor(() => expect(visibleTimes()).toHaveLength(7));
    const search = screen.getByRole('searchbox');
    await user.click(search);
    await user.keyboard('{Control>}z{/Control}');
    expect(store.log).toEqual([`delete:${idOf('c')}`]);
    expect(visibleTimes()).toHaveLength(7);
    // 欄の外に出れば、効く。
    screen.getByRole('button', { name: '設定' }).focus();
    await user.keyboard('{Control>}z{/Control}');
    await waitFor(() => expect(visibleTimes()).toHaveLength(8));
  });

  it('「選択」で複数を選んで、まとめて消せる。確認に件数。全部選ぶチェックと「N件を選択中」', async () => {
    const { user, store } = setup();
    await ready();
    await user.click(within(listNav()).getByRole('button', { name: '選択' }));
    const bar = within(listNav()).getByRole('group', { name: '半荘を選択' });
    const master = within(bar).getByRole('checkbox', { name: '表示中の半荘をすべて選択' });
    expect(master).toHaveFocus();
    expect(within(bar).getByText('0件を選択中')).toBeInTheDocument();
    const del = within(bar).getByRole('button', { name: '削除' });
    expect(del).toBeDisabled();
    expect(del).toHaveAttribute('aria-keyshortcuts', 'Delete');
    expect(within(bar).getByRole('button', { name: 'キャンセル' })).toBeInTheDocument();
    // 行はチェックになる（開く・「…」は出ない）。
    expect(within(listNav()).queryByRole('button', { name: /のメニュー/ })).toBeNull();
    expect(within(listNav()).getAllByRole('checkbox')).toHaveLength(9);

    await user.click(master);
    expect(within(bar).getByText('8件を選択中')).toBeInTheDocument();
    await user.click(master);
    expect(within(bar).getByText('0件を選択中')).toBeInTheDocument();
    await user.click(rowCheck('20:55'));
    await user.click(rowCheck('21:15'));
    expect(within(bar).getByText('2件を選択中')).toBeInTheDocument();
    expect(master).toBePartiallyChecked();

    await user.click(del);
    expect(screen.getByRole('alertdialog')).toHaveTextContent('2件の半荘を削除します。');
    expect(within(bar).getByRole('button', { name: '削除' })).toBeInTheDocument();
    await user.click(within(screen.getByRole('alertdialog')).getByRole('button', { name: '削除' }));
    await toastShows('2件の半荘を削除しました');
    expect(store.log).toEqual([`delete:${idOf('c')},${idOf('e')}`]);
    await waitFor(() => expect(visibleTimes()).toEqual(['19:09', '21:40', '22:10', '20:12', '19:30', '22:48']));
    // 選択モードは終わり、キーボードの位置は「選択」に戻る。
    expect(within(listNav()).queryByRole('group', { name: '半荘を選択' })).toBeNull();
    await waitFor(() => expect(within(listNav()).getByRole('button', { name: '選択' })).toHaveFocus());

    await user.click(screen.getByRole('button', { name: '元に戻す' }));
    await waitFor(() => expect(visibleTimes()).toHaveLength(8));
  });

  it('選択モードのキー: Ctrl+A ですべて選ぶ・Delete で確認・Esc で選択をやめて「選択」に戻る', async () => {
    const { user } = setup();
    await ready();
    await user.click(within(listNav()).getByRole('button', { name: '選択' }));
    await user.keyboard('{Control>}a{/Control}');
    expect(within(listNav()).getByText('8件を選択中')).toBeInTheDocument();
    await user.keyboard('{Delete}');
    expect(screen.getByRole('alertdialog')).toHaveTextContent('8件の半荘を削除します。');
    await user.keyboard('{Escape}');
    expect(screen.queryByRole('alertdialog')).toBeNull();
    // 確認だけが閉じて、選択はそのまま。キーボードの位置は「削除」に戻る。
    expect(within(listNav()).getByText('8件を選択中')).toBeInTheDocument();
    await waitFor(() => expect(within(listNav()).getByRole('button', { name: '削除' })).toHaveFocus());
    await user.keyboard('{Escape}');
    expect(within(listNav()).queryByRole('group', { name: '半荘を選択' })).toBeNull();
    expect(within(listNav()).getByRole('button', { name: '選択' })).toHaveFocus();
  });

  it('チェックの行は、行のどこを押しても切り替わる。矢印で行から行へ動け、Space で選べる', async () => {
    const { user } = setup();
    await ready();
    await user.click(within(listNav()).getByRole('button', { name: '選択' }));
    const boxes = () => within(listNav()).getAllByRole('checkbox').slice(1);
    boxes()[0]?.focus();
    await user.keyboard(' ');
    expect(boxes()[0]).toBeChecked();
    await user.keyboard('{ArrowDown} ');
    expect(boxes()[1]).toBeChecked();
    expect(within(listNav()).getByText('2件を選択中')).toBeInTheDocument();
    await user.keyboard('{ArrowUp}');
    expect(boxes()[0]).toHaveFocus();
  });

  it('いま開いている半荘を消すと、隣の半荘に移る。元に戻すと、その半荘に戻る', async () => {
    const { user } = setup();
    await ready();
    await user.click(rowOf('b'));
    await screen.findByRole('heading', { level: 1, name: /10月8日\(木\) 21:40/ });
    await user.click(menuOf(rowOf('b')));
    await user.click(within(screen.getByRole('menu')).getByRole('menuitem', { name: '削除' }));
    await user.click(within(screen.getByRole('alertdialog')).getByRole('button', { name: '削除' }));
    // 消した半荘の次（古いほう）。
    expect(await screen.findByRole('heading', { level: 1, name: /10月8日\(木\) 20:55/ })).toBeInTheDocument();
    await user.click(screen.getByRole('button', { name: '元に戻す' }));
    expect(await screen.findByRole('heading', { level: 1, name: /10月8日\(木\) 21:40/ })).toBeInTheDocument();
    expect(rowByTime('21:40')).toHaveAttribute('aria-current', 'true');
  });

  it('見ている半荘ではない半荘を消したあと元に戻しても、いま見ている半荘は変わらない', async () => {
    const { user } = setup();
    await ready();
    await user.click(menuOf(rowOf('c')));
    await user.click(within(screen.getByRole('menu')).getByRole('menuitem', { name: '削除' }));
    await user.click(within(screen.getByRole('alertdialog')).getByRole('button', { name: '削除' }));
    await toastShows('1件の半荘を削除しました');
    await waitFor(() => expect(visibleTimes()).toHaveLength(7));
    expect(screen.getByRole('heading', { level: 1, name: /10月9日/ })).toBeInTheDocument();
    await user.click(rowOf('b'));
    await user.keyboard('{Control>}z{/Control}');
    await waitFor(() => expect(visibleTimes()).toHaveLength(8));
    expect(screen.getByRole('heading', { level: 1, name: /10月8日\(木\) 21:40/ })).toBeInTheDocument();
  });

  it('全部消すと、本文も一覧も「半荘がありません」になり、← → は押せない。キーボードの位置は「元に戻す」へ。戻すと全部戻る', async () => {
    const { user } = setup();
    await ready();
    await user.click(within(listNav()).getByRole('button', { name: '選択' }));
    await user.click(within(listNav()).getByRole('checkbox', { name: '表示中の半荘をすべて選択' }));
    await user.click(within(listNav()).getByRole('button', { name: '削除' }));
    await user.click(within(screen.getByRole('alertdialog')).getByRole('button', { name: '削除' }));
    await toastShows('8件の半荘を削除しました');
    expect(await screen.findByRole('heading', { level: 1, name: '半荘がありません' })).toBeInTheDocument();
    expect(within(listNav()).getByText('半荘がありません')).toBeInTheDocument();
    expect(within(listNav()).queryByRole('searchbox')).toBeNull();
    expect(within(listNav()).queryByRole('button', { name: '選択' })).toBeNull();
    expect(screen.getByRole('button', { name: '戻る' })).toBeDisabled();
    expect(screen.getByRole('button', { name: '進む' })).toBeDisabled();
    const undo = screen.getByRole('button', { name: '元に戻す' });
    await waitFor(() => expect(undo).toHaveFocus());

    await user.keyboard('{Enter}');
    await waitFor(() => expect(visibleTimes()).toHaveLength(8));
    expect(await screen.findByRole('heading', { level: 1, name: /10月9日\(金\) 19:09/ })).toBeInTheDocument();
  });

  it('消せなかったときは、理由を通知に出して、一覧は変えない。キーボードの位置は、確認を開いた所に戻る', async () => {
    const { user, store } = setup();
    await ready();
    store.failNextDelete = 'フォルダを移せませんでした: 開いているファイルがあります';
    const more = menuOf(rowOf('c'));
    await user.click(more);
    await user.click(within(screen.getByRole('menu')).getByRole('menuitem', { name: '削除' }));
    await user.click(within(screen.getByRole('alertdialog')).getByRole('button', { name: '削除' }));
    await toastShows('半荘の削除ができませんでした: フォルダを移せませんでした: 開いているファイルがあります');
    expect(visibleTimes()).toHaveLength(8);
    expect(screen.queryByRole('button', { name: '元に戻す' })).toBeNull();
    await waitFor(() => expect(more).toHaveFocus());
    // 失敗した削除は積まれていないので、Ctrl+Z は何も戻さない。
    await user.keyboard('{Control>}z{/Control}');
    expect(store.log).toEqual([`delete:${idOf('c')}`]);
  });

  it('元に戻せなかったときも、理由を通知に出す（積み重ねは変えない。直せばもう一度戻せる）', async () => {
    const { user, store } = setup();
    await ready();
    await user.click(menuOf(rowOf('c')));
    await user.click(within(screen.getByRole('menu')).getByRole('menuitem', { name: '削除' }));
    await user.click(within(screen.getByRole('alertdialog')).getByRole('button', { name: '削除' }));
    await toastShows('1件の半荘を削除しました');
    store.failNextRestore = '元の場所に同じ名前の半荘があるため、戻せません';
    await user.click(screen.getByRole('button', { name: '元に戻す' }));
    await toastShows('元に戻せませんでした: 元の場所に同じ名前の半荘があるため、戻せません');
    expect(visibleTimes()).toHaveLength(7);
    await user.keyboard('{Control>}z{/Control}');
    await waitFor(() => expect(visibleTimes()).toHaveLength(8));
  });

  it('解いた問題があれば、確認にその数が出る（数は答えの記録に数えてもらう。ここでは、数を返す関数を渡す）', async () => {
    const { user } = setup({ solvedProblems: (ids) => ids.length * 4 });
    await ready();
    await user.click(menuOf(rowOf('c')));
    await user.click(within(screen.getByRole('menu')).getByRole('menuitem', { name: '削除' }));
    const dialog = screen.getByRole('alertdialog');
    expect(dialog).toHaveTextContent('解いた問題 4問と、その解き直しの予定も消えます。');
    expect(dialog).toHaveTextContent('記録とスクショも消えます。');
    await user.keyboard('{Escape}');
  });

  it('解いた問題が無いときは、その行を出さない', async () => {
    const { user } = setup();
    await ready();
    await user.click(menuOf(rowOf('c')));
    await user.click(within(screen.getByRole('menu')).getByRole('menuitem', { name: '削除' }));
    expect(screen.getByRole('alertdialog')).not.toHaveTextContent('解いた問題');
  });

  it('行のメニューは、右クリック・Menu キーでも開く。→ で行の「…」へ、← で行へ戻る。「開く」で、その半荘を開く', async () => {
    const { user } = setup();
    await ready();
    fireEvent.contextMenu(rowOf('d'));
    const menu = await screen.findByRole('menu', { name: '半荘のメニュー' });
    expect(within(menu).getAllByRole('menuitem').map((i) => i.textContent)).toEqual(['開く', '削除']);
    await user.keyboard('{Escape}');
    expect(menuOf(rowOf('d'))).toHaveFocus();

    rowOf('e').focus();
    await user.keyboard('{ArrowRight}');
    expect(menuOf(rowOf('e'))).toHaveFocus();
    await user.keyboard('{ArrowDown}');
    expect(menuOf(rowOf('f'))).toHaveFocus();
    await user.keyboard('{ArrowLeft}');
    expect(rowOf('f')).toHaveFocus();

    await user.click(menuOf(rowOf('d')));
    await user.click(within(screen.getByRole('menu')).getByRole('menuitem', { name: '開く' }));
    expect(await screen.findByRole('heading', { level: 1, name: /10月7日\(水\) 22:10/ })).toBeInTheDocument();
    expect(rowOf('d')).toHaveFocus();
  });
});

describe('U-10: 戻る・進む', () => {
  it('開いた半荘・設定・取り込みを、← → と Alt+← / Alt+→ で行き来する。行き先が無い向きのボタンは押せない', async () => {
    const { user } = setup();
    await ready();
    const back = screen.getByRole('button', { name: '戻る' });
    const forward = screen.getByRole('button', { name: '進む' });
    expect(back).toBeDisabled();
    expect(forward).toBeDisabled();
    expect(back).toHaveAttribute('aria-keyshortcuts', 'Alt+ArrowLeft');
    expect(forward).toHaveAttribute('aria-keyshortcuts', 'Alt+ArrowRight');

    await user.click(rowOf('d'));
    await user.click(screen.getByRole('button', { name: '設定' }));
    await screen.findByRole('heading', { level: 1, name: '設定' });
    expect(back).toBeEnabled();
    expect(forward).toBeDisabled();

    await user.click(back);
    expect(await screen.findByRole('heading', { level: 1, name: /10月7日\(水\) 22:10/ })).toBeInTheDocument();
    expect(forward).toBeEnabled();
    await user.keyboard('{Alt>}{ArrowLeft}{/Alt}');
    expect(await screen.findByRole('heading', { level: 1, name: /10月9日\(金\) 19:09/ })).toBeInTheDocument();
    expect(back).toBeDisabled();
    expect(rowOf('a')).toHaveAttribute('aria-current', 'true');
    await user.keyboard('{Alt>}{ArrowRight}{/Alt}');
    expect(await screen.findByRole('heading', { level: 1, name: /10月7日\(水\) 22:10/ })).toBeInTheDocument();
    await user.click(forward);
    expect(await screen.findByRole('heading', { level: 1, name: '設定' })).toBeInTheDocument();
    expect(forward).toBeDisabled();
  });

  it('途中で新しい画面へ移ると、先の履歴は捨てる', async () => {
    const { user } = setup();
    await ready();
    await user.click(rowOf('b'));
    await user.click(rowOf('c'));
    await user.click(screen.getByRole('button', { name: '戻る' }));
    await user.click(screen.getByRole('button', { name: '戻る' }));
    expect(screen.getByRole('button', { name: '進む' })).toBeEnabled();
    await user.click(rowOf('e'));
    expect(screen.getByRole('button', { name: '進む' })).toBeDisabled();
  });

  it('消した半荘は飛ばす（消したあとの ← は、消していない前の画面へ）。元に戻すと、また行ける', async () => {
    const { user } = setup();
    await ready();
    await user.click(rowOf('b'));
    await user.click(rowOf('c'));
    await user.click(screen.getByRole('button', { name: '設定' }));
    // b を消す。
    await user.click(menuOf(rowOf('b')));
    await user.click(within(screen.getByRole('menu')).getByRole('menuitem', { name: '削除' }));
    await user.click(within(screen.getByRole('alertdialog')).getByRole('button', { name: '削除' }));
    await toastShows('1件の半荘を削除しました');
    await waitFor(() => expect(visibleTimes()).toHaveLength(7));
    // 設定 → c → （b は飛ばす）→ a。
    await user.click(screen.getByRole('button', { name: '戻る' }));
    expect(await screen.findByRole('heading', { level: 1, name: /10月8日\(木\) 20:55/ })).toBeInTheDocument();
    await user.click(screen.getByRole('button', { name: '戻る' }));
    expect(await screen.findByRole('heading', { level: 1, name: /10月9日\(金\) 19:09/ })).toBeInTheDocument();
    expect(screen.getByRole('button', { name: '戻る' })).toBeDisabled();
    // 元に戻すと、b の項目にも行ける。
    await user.keyboard('{Control>}z{/Control}');
    await waitFor(() => expect(visibleTimes()).toHaveLength(8));
    await user.click(rowOf('a'));
    await user.keyboard('{Alt>}{ArrowRight}{/Alt}');
    expect(await screen.findByRole('heading', { level: 1, name: /10月8日\(木\) 21:40/ })).toBeInTheDocument();
  });

  it('端に着いて押せなくなった ← にキーボードの位置が残らない（もう一方のボタンか、いま開いている行へ移る）', async () => {
    const { user } = setup();
    await ready();
    await user.click(rowOf('b'));
    const back = screen.getByRole('button', { name: '戻る' });
    await user.click(back);
    expect(back).toBeDisabled();
    expect(document.activeElement).not.toBe(document.body);
    expect(screen.getByRole('button', { name: '進む' })).toHaveFocus();
  });

  it('マウスの戻る・進むのボタン（迷いマークのボタンと重なる）には、何も割り当てない', async () => {
    const { user } = setup();
    await ready();
    await user.click(rowOf('b'));
    await user.click(rowOf('c'));
    const back = screen.getByRole('button', { name: '戻る' });
    const before = screen.getByRole('heading', { level: 1 }).textContent;
    for (const button of [3, 4]) {
      for (const type of ['mousedown', 'mouseup', 'auxclick', 'click', 'pointerdown', 'pointerup']) {
        const init = { button, bubbles: true, cancelable: true };
        const target = screen.getByRole('main');
        target.dispatchEvent(type.startsWith('pointer') ? new PointerEvent(type, init) : new MouseEvent(type, init));
        document.body.dispatchEvent(new MouseEvent(type, init));
      }
    }
    expect(screen.getByRole('heading', { level: 1 }).textContent).toBe(before);
    expect(back).toBeEnabled();
    expect(screen.getByRole('button', { name: '進む' })).toBeDisabled();
  });

  it('メニューや確認が開いている間は、Alt+← は動かさない', async () => {
    const { user } = setup();
    await ready();
    await user.click(rowOf('b'));
    await user.click(menuOf(rowOf('c')));
    expect(screen.getByRole('menu')).toBeInTheDocument();
    await user.keyboard('{Alt>}{ArrowLeft}{/Alt}');
    expect(screen.getByRole('heading', { level: 1, name: /10月8日\(木\) 21:40/ })).toBeInTheDocument();
    await user.keyboard('{Escape}');
    await user.keyboard('{Alt>}{ArrowLeft}{/Alt}');
    expect(await screen.findByRole('heading', { level: 1, name: /10月9日/ })).toBeInTheDocument();
  });
});
