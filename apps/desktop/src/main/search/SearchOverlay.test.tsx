/**
 * 検索の重ね表示の画面（ACCEPTANCE の U-22・U-1）の試験。重ね表示だけを、半荘と問題の一覧を渡して動かす
 * （アプリ全体の中での開閉・戻る進む・見出しは、SearchApp.test.tsx）。
 */
import { render, screen, within, fireEvent } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { local } from '../../../tests/fake-sessions';
import { answerRow } from '../../../tests/fake-study';
import { SEARCH_NOW, SEARCH_SEEDS, searchFixture, type SearchFixture, type SearchSeed } from '../../../tests/search-fixtures';
import type { AnswerRow } from '../../api/types';
import { MAC_STAGE_2_PLATFORM, setPlatform, WINDOWS_PLATFORM } from '../../shared/platform';
import { StudyProvider, type StudyValue } from '../study/StudyProvider';
import { useShortcutsBlocked } from '../undo/shortcutGuard';
import { UndoProvider } from '../undo/UndoProvider';
import { GAME_LIMIT, PROBLEM_LIMIT } from './searchModel';
import { SearchOverlay } from './SearchOverlay';

beforeEach(() => {
  vi.useFakeTimers({ toFake: ['Date'] });
  vi.setSystemTime(SEARCH_NOW);
});

afterEach(() => {
  vi.useRealTimers();
});

interface Options {
  ready?: boolean;
  answers?: AnswerRow[];
  seeds?: readonly SearchSeed[];
}

function studyValue(fixture: SearchFixture, options: Options): StudyValue {
  return {
    ready: options.ready ?? true,
    error: null,
    studyDay: '2026-10-09',
    threshold: 0.05,
    dailyCount: 5,
    highlightDora: false,
    doubtOnly: false,
    answers: options.answers ?? [],
    model: {
      problems: fixture.problems,
      today: { items: [], answered: 0, unanswered: 0, rest: [], undecidedMarks: 0, sessionCount: 0 },
      due: [],
      nextDue: null,
    },
    todayUnanswered: 0,
    dueCount: 0,
    locate: () => null,
    gameState: () => undefined,
    session: () => undefined,
    reloadSessions: () => Promise.resolve(),
    recordAnswer: () => Promise.reject(new Error('使わない')),
    updateNotes: () => Promise.reject(new Error('使わない')),
  };
}

function setup(options: Options = {}) {
  const fixture = searchFixture({ ...(options.seeds ? { seeds: options.seeds } : {}), ...(options.ready === undefined ? {} : { ready: options.ready }) });
  const onOpenGame = vi.fn<(id: string) => void>();
  const onOpenProblem = vi.fn<(id: string, key: string) => void>();
  const onClose = vi.fn<(opened: boolean) => void>();
  const user = userEvent.setup();
  // アプリのキー操作が止まっているかを、押したときに確かめる部品（重ね表示の外に置く）
  const blockedLog: boolean[] = [];
  function Probe() {
    const blocked = useShortcutsBlocked();
    return (
      <button type="button" onClick={() => blockedLog.push(blocked())}>
        probe
      </button>
    );
  }
  const view = render(
    <UndoProvider>
      <StudyProvider value={studyValue(fixture, options)}>
        <Probe />
        <SearchOverlay
          rows={fixture.rows}
          summaries={fixture.summaries}
          now={SEARCH_NOW}
          onOpenGame={onOpenGame}
          onOpenProblem={onOpenProblem}
          onClose={onClose}
        />
      </StudyProvider>
    </UndoProvider>,
  );
  return { user, fixture, onOpenGame, onOpenProblem, onClose, blockedLog, ...view };
}

const dialog = () => screen.getByRole('dialog', { name: '検索' });
const input = () => screen.getByRole('combobox', { name: '半荘と問題を検索' });
const options = () => within(dialog()).queryAllByRole('option');
/** 行の文字。見える並び（各部品の間に空き）に直して読む。 */
const optionText = (el: HTMLElement) =>
  [...el.querySelectorAll('.sx-main > *, .sx-sub, .sx-r > *')]
    .map((part) => (part.textContent ?? '').trim())
    .filter((text) => text !== '')
    .join(' ');
/** 半荘の行の 2 行目の文字。 */
const row2 = (row: HTMLElement) => (row.querySelector('.sx-sub')?.textContent ?? '').trim();
/** 案内の文字（段落とボタンの間に空き）。 */
const blockText = (el: HTMLElement) =>
  [...el.children]
    .map((part) => (part.textContent ?? '').trim())
    .filter((text) => text !== '')
    .join(' ');
const active = () => options().find((o) => o.getAttribute('aria-selected') === 'true');
const groupHeads = () => [...dialog().querySelectorAll('.sx-gh')].map((el) => (el.textContent ?? '').replace(/\s+/g, ' ').trim());
const countLine = () => (dialog().querySelector('.sx-count')?.textContent ?? '').replace(/\s+/g, ' ').trim();

async function type(user: ReturnType<typeof userEvent.setup>, text: string) {
  await user.click(input());
  await user.keyboard(text);
}

describe('U-22: 開いた状態', () => {
  it('ダイアログ（モーダル）で、検索欄にキーボードの位置がある。入力欄は、日本語の入力の候補や赤い波線を出さない', () => {
    setup();
    const d = dialog();
    expect(d).toHaveAttribute('aria-modal', 'true');
    expect(input()).toHaveFocus();
    expect(input()).toHaveAttribute('placeholder', '半荘・問題を探す（日付・卓・局・メモ）');
    expect(input()).toHaveAttribute('spellcheck', 'false');
    expect(input()).toHaveAttribute('autocomplete', 'off');
    expect(document.body).toHaveClass('sx-open');
  });

  it('見本のとおりの部品: 「Esc」の印・種類（半荘・問題）・段階・期間・迷いあり・未解答・並べ替え・キー操作の一覧', () => {
    setup();
    const d = within(dialog());
    expect(d.getByRole('button', { name: 'Esc で閉じる' })).toHaveTextContent('Esc');
    const filters = within(d.getByRole('group', { name: '絞り込み' }));
    expect(filters.getAllByRole('button').map((b) => b.getAttribute('aria-label') ?? b.textContent)).toEqual([
      '半荘',
      '問題',
      '段階：すべて',
      '期間：すべて',
      '迷いあり',
      '未解答',
    ]);
    expect(filters.getByText('種類')).toBeInTheDocument();
    expect(d.getByRole('button', { name: '並べ替え：新しい順' })).toBeInTheDocument();
    const keys = within(d.getByRole('list', { name: 'キー操作' })).getAllByRole('listitem');
    expect(keys.map((li) => li.textContent)).toEqual(['↑↓選ぶ', 'Enter開く', 'Esc閉じる', 'CtrlK開く・閉じる']);
    expect(within(d.getByRole('list', { name: 'キー操作' })).getAllByText(/^(↑|↓|Enter|Esc|Ctrl|K)$/, { selector: 'kbd' })).toHaveLength(6);
    // 検索語が無いときは、消すボタンは無い。条件が無いときは、「条件を解除」も無い
    expect(d.queryByRole('button', { name: '検索語を消す' })).toBeNull();
    expect(d.queryByRole('button', { name: '条件を解除' })).toBeNull();
  });

  it('検索語が空のとき: 半荘 5・問題 6 まで出し、残りは「すべて表示（あと N件）」。件数と、半荘・問題の見出し', () => {
    const { fixture } = setup();
    const problems = fixture.problems.length;
    expect(groupHeads()).toEqual(['半荘 · 7件', `問題 · ${problems}件`]);
    expect(options()).toHaveLength(GAME_LIMIT + PROBLEM_LIMIT);
    const more = 7 - GAME_LIMIT + (problems - PROBLEM_LIMIT);
    expect(countLine()).toBe(`半荘 7 · 問題 ${problems}すべて表示（あと${more}件）`);
    expect(within(dialog()).getByRole('button', { name: `すべて表示（あと${more}件）` })).toBeInTheDocument();
    expect(screen.getByRole('status')).toHaveTextContent(`${7 + problems}件の結果`);
  });

  it('1 つ目の行が選ばれている。行の先頭に、半荘か問題かの言葉がある（読み上げ用）', () => {
    setup();
    const first = options()[0] as HTMLElement;
    expect(active()).toBe(first);
    expect(input()).toHaveAttribute('aria-activedescendant', first.id);
    expect(options().filter((o) => o.getAttribute('aria-selected') === 'true')).toHaveLength(1);
    expect(optionText(first)).toMatch(/^半荘 19:09/);
    expect(optionText(options()[GAME_LIMIT] as HTMLElement)).toMatch(/^問題 /);
  });

  it('半荘の行: 開始時刻・段階・Rating・日付と卓・2 行目（メモ、無ければ要約）・迷いの数・問題の数と未解答の数', () => {
    const { fixture } = setup();
    const rows = options();
    const g1 = rows[0] as HTMLElement;
    expect(optionText(g1)).toBe(
      `半荘 19:09 S- 93.0 10月9日（本日） · 玉の間・南 放銃を見直す 迷い3 問題 ${fixture.problems.filter((p) => p.sessionId === 'g1').length} · 未解答 ${fixture.problems.filter((p) => p.sessionId === 'g1').length}`,
    );
    expect(g1.querySelector('.grade')).toHaveAttribute('data-grade', 'S-');
    // メモが無い半荘は、要約。昨日の行には（昨日）
    const g3 = rows[2] as HTMLElement;
    expect(optionText(g3)).toBe('半荘 21:40 S- 91.9 10月8日（昨日） · 玉の間・南 16局 · 南4局2本場で終了 問題 15 · 未解答 15');
    // 日付が今日・昨日でない行は、（）が付かない
    expect(optionText(rows[4] as HTMLElement)).toBe('半荘 22:10 A+ 90.2 10月7日 · 玉の間・南 13局 · 南4局で終了 迷い2 問題 18 · 未解答 18');
  });

  it('取り込み前の半荘の行: 段階の代わりに「取り込み前」と、迷いの数（問題は出さない）', () => {
    setup();
    // g7 は 6 つ目: 新しい順の 6 番目の半荘（5 件までは畳まれている）
    const user = userEvent.setup();
    return user.click(within(dialog()).getByRole('button', { name: /^すべて表示/ })).then(() => {
      const g7 = options().find((o) => /取り込み前/.test(optionText(o))) as HTMLElement;
      expect(optionText(g7)).toBe('半荘 22:05 取り込み前 10月2日 迷い1');
      expect(g7.querySelector('.grade.ghost')).not.toBeNull();
    });
  });

  it('問題の行: 局と巡目・種類・向聴数・どの半荘か・解答の状態。迷いの問題には迷いの番号', () => {
    setup();
    const problemRows = options().slice(GAME_LIMIT);
    // 新しい順の先頭は、いちばん新しい半荘（g1）の問題。確率の低い順
    const first = problemRows[0] as HTMLElement;
    expect(optionText(first)).toMatch(
      /^問題 東\d局(\d本場)? \d+巡目 (迷い\d )?(打牌|鳴き|リーチ|和了|カン) · (\d+向聴|聴牌) · 10月9日 19:09 の半荘 未解答$/,
    );
    expect(problemRows.every((row) => /(未解答|解答済み)$/.test(optionText(row)))).toBe(true);
    // 迷いの問題には「迷い N」（今日の出題の行と同じ言い方）。大きな不一致の問題には付かない
    const lines = problemRows.map((row) => optionText(row));
    expect(lines.some((line) => /迷い\d/.test(line))).toBe(true);
    expect(lines.some((line) => !/迷い\d/.test(line))).toBe(true);
  });
});

describe('U-22: 検索語と、当たった文字の印', () => {
  it('東4局: 東4局を持つ半荘と、東4局の問題。当たった文字に下線の印（mark）が付く。件数が変わる', async () => {
    const { user, fixture } = setup();
    await type(user, '東4局');
    const found = fixture.problems.filter((p) => p.decision.kyokuLabel.startsWith('東4局'));
    // g1（FX-4）は東4局を持たない。ほかの 5 半荘は持つ
    expect(groupHeads()).toEqual(['半荘 · 5件', `問題 · ${found.length}件`]);
    expect(countLine()).toMatch(new RegExp(`^半荘 5 · 問題 ${found.length}`));
    const marks = [...dialog().querySelectorAll('mark.hit')].map((m) => m.textContent);
    expect(marks.length).toBeGreaterThan(5);
    expect(marks.every((text) => text === '東4局')).toBe(true);
    // 半荘の行は、局の名前で当たったので、2 行目（要約）に印は無い。問題の行は、題名の先頭に印
    const problem = options().find((o) => /^問題 /.test(optionText(o))) as HTMLElement;
    expect(problem.querySelector('.t mark.hit')?.textContent).toBe('東4局');
    expect(screen.getByRole('button', { name: '検索語を消す' })).toBeInTheDocument();
    expect(screen.getByRole('status')).toHaveTextContent(`${5 + found.length}件の結果`);
  });

  it('局の名前で当たった半荘は、2 行目に当たった局を添える（印つき）。3 つまで、残りは「ほか N局」。2 行目に出ている局だけなら、添えない', async () => {
    const { user } = setup();
    await type(user, '東4局');
    const rows = options().filter((o) => /^半荘 /.test(optionText(o)));
    expect(rows.map((row) => row.querySelector('.s-time')?.textContent)).toEqual(['17:12', '21:40', '20:55', '22:10', '20:12']);
    // f9da（17:12）: 2 行目はメモ。当たった局が、そのあとに続く
    expect(row2(rows[0] as HTMLElement)).toBe('3mを切った場面が悪かった · 局: 東4局、東4局1本場');
    // メモの無い半荘（21:40）は、要約のあとに続く
    expect(row2(rows[1] as HTMLElement)).toBe('16局 · 南4局2本場で終了 · 局: 東4局、東4局1本場');
    // 東4局が 4 つ続く半荘（20:55）: 3 つまで出して、残りの数
    expect(row2(rows[2] as HTMLElement)).toBe('親番で押しすぎた · 局: 東4局、東4局1本場、東4局2本場 ほか1局');
    expect([...(rows[0] as HTMLElement).querySelectorAll('.sx-sub mark.hit')].map((m) => m.textContent)).toEqual(['東4局', '東4局']);
    // 2 行目の要約にすでに出ている局（南4局）で探したときは、その半荘には添えない（当たった局が、すべて 2 行目に出ているため）
    await user.clear(input());
    await user.keyboard('南4局');
    const south = options().filter((o) => /^半荘 /.test(optionText(o)));
    const plain = south.find((row) => row.querySelector('.s-time')?.textContent === '20:12') as HTMLElement;
    expect(row2(plain)).toBe('15局 · 南4局で終了');
    expect([...plain.querySelectorAll('.sx-sub mark.hit')].map((m) => m.textContent)).toEqual(['南4局']);
  });

  it('日付 10/9: 画面に出ている「10月9日」に印が付く（文字がそのまま入っていなくても）。昨日・今日は、（昨日）（本日）の文字に印', async () => {
    const { user } = setup();
    await type(user, '10/9');
    const dates = [...dialog().querySelectorAll('.sx-main .t mark.hit')].map((m) => m.textContent);
    expect(dates).toEqual(['10月9日', '10月9日']);
    expect(groupHeads()[0]).toBe('半荘 · 2件');
    await user.clear(input());
    await user.keyboard('昨日');
    const yesterday = [...dialog().querySelectorAll('.sx-main .t mark.hit')].map((m) => m.textContent);
    expect(yesterday).toEqual(['昨日', '昨日']);
    await user.clear(input());
    await user.keyboard('今日');
    expect([...dialog().querySelectorAll('.sx-main .t mark.hit')].map((m) => m.textContent)).toEqual(['本日', '本日']);
  });

  it('卓の名前・メモの文字にも印が付く。空白で区切った語は、すべてに当たる行だけ', async () => {
    const { user } = setup();
    await type(user, '玉の間 親番');
    expect(groupHeads()[0]).toBe('半荘 · 1件');
    expect([...dialog().querySelectorAll('mark.hit')].map((m) => m.textContent)).toEqual(expect.arrayContaining(['玉の間', '親番']));
    expect(optionText(options()[0] as HTMLElement)).toContain('親番で押しすぎた');
  });

  it('全角で打っても当たる（１０／７）。検索語を消すボタンで空に戻り、検索欄にキーボードの位置が戻る', async () => {
    const { user, fixture } = setup();
    await type(user, '１０／７');
    expect(groupHeads()[0]).toBe('半荘 · 1件');
    await user.click(screen.getByRole('button', { name: '検索語を消す' }));
    expect(input()).toHaveValue('');
    expect(input()).toHaveFocus();
    expect(groupHeads()).toEqual(['半荘 · 7件', `問題 · ${fixture.problems.length}件`]);
  });

  it('当たる行が無いとき: 検索語を入れた案内と「検索語と条件を解除」（押すと空に戻って、検索欄へ）', async () => {
    const { user, fixture } = setup();
    await type(user, '東5局');
    expect(options()).toHaveLength(0);
    expect(countLine()).toBe('半荘 0 · 問題 0');
    const empty = dialog().querySelector('.sx-empty') as HTMLElement;
    expect(blockText(empty)).toBe('「東5局」に当てはまる半荘・問題はありません。 検索語を短くするか、絞り込みを外してください。 検索語と条件を解除');
    expect(input()).not.toHaveAttribute('aria-activedescendant');
    expect(input()).toHaveAttribute('aria-expanded', 'false');
    await user.click(within(empty).getByRole('button', { name: '検索語と条件を解除' }));
    expect(input()).toHaveValue('');
    expect(input()).toHaveFocus();
    expect(dialog().querySelector('.sx-empty')).toBeNull();
    expect(groupHeads()).toEqual(['半荘 · 7件', `問題 · ${fixture.problems.length}件`]);
  });

  it('語が無く、条件だけで当たる行が無いときは「この条件に」。条件を外すと、元に戻る', async () => {
    const { user } = setup({ seeds: [{ id: 'g2', at: local(2026, 10, 9, 17, 12), report: 'fx1a' }] });
    await user.click(screen.getByRole('button', { name: '迷いあり' }));
    expect(options()).toHaveLength(0);
    expect(blockText(dialog().querySelector('.sx-empty') as HTMLElement)).toContain('この条件に当てはまる半荘・問題はありません。');
    await user.click(screen.getByRole('button', { name: '条件を解除' }));
    expect(options().length).toBeGreaterThan(0);
  });

  it('半荘がひとつも無いときは、その案内（解除のボタンは出さない）', () => {
    setup({ seeds: [] });
    const empty = dialog().querySelector('.sx-empty') as HTMLElement;
    expect(blockText(empty)).toBe('まだ半荘がありません。 ウィジェットで記録するか、検討結果を取り込むと、ここで探せます。');
    expect(within(empty).queryByRole('button')).toBeNull();
  });
});

describe('U-22: ↑ ↓ と Enter、マウス', () => {
  it('↓ ↑ で選ぶ行が動く（検索欄にキーボードの位置を残したまま、aria-activedescendant で示す）。端では反対の端へ回る', async () => {
    const { user } = setup();
    const total = options().length;
    await user.keyboard('{ArrowDown}{ArrowDown}');
    expect(options().indexOf(active() as HTMLElement)).toBe(2);
    expect(input()).toHaveFocus();
    expect(input()).toHaveAttribute('aria-activedescendant', (active() as HTMLElement).id);
    await user.keyboard('{ArrowUp}');
    expect(options().indexOf(active() as HTMLElement)).toBe(1);
    await user.keyboard('{ArrowUp}{ArrowUp}');
    // 先頭から ↑ で、最後の行へ
    expect(options().indexOf(active() as HTMLElement)).toBe(total - 1);
    await user.keyboard('{ArrowDown}');
    expect(options().indexOf(active() as HTMLElement)).toBe(0);
    await user.keyboard('{Control>}{End}{/Control}');
    expect(options().indexOf(active() as HTMLElement)).toBe(total - 1);
    await user.keyboard('{Control>}{Home}{/Control}');
    expect(options().indexOf(active() as HTMLElement)).toBe(0);
  });

  it('検索語を変えると、選びは先頭に戻る', async () => {
    const { user } = setup();
    await user.keyboard('{ArrowDown}{ArrowDown}{ArrowDown}');
    await user.keyboard('玉の間');
    expect(options().indexOf(active() as HTMLElement)).toBe(0);
  });

  it('Enter: 選んでいる半荘の行を開く（半荘の名前を渡して、重ね表示を閉じる）', async () => {
    const { user, onOpenGame, onClose } = setup();
    await user.keyboard('{ArrowDown}{Enter}');
    expect(onOpenGame).toHaveBeenCalledWith('g2');
    expect(onClose).toHaveBeenCalledWith(true);
  });

  it('Enter: 選んでいる問題の行を開く（半荘の名前と判断の鍵を渡す）', async () => {
    const { user, onOpenProblem, onClose, fixture } = setup();
    await user.keyboard('{ArrowUp}{Enter}');
    // 最後の行は、問題の最後（新しい順の最後）
    const shown = options();
    expect(shown.at(-1)).toBe(active());
    expect(onOpenProblem).toHaveBeenCalledTimes(1);
    const [sessionId, key] = onOpenProblem.mock.calls[0] as [string, string];
    expect(fixture.problems.some((p) => p.sessionId === sessionId && p.key === key)).toBe(true);
    expect(onClose).toHaveBeenCalledWith(true);
  });

  it('当たる行が無いとき、Enter は何もしない', async () => {
    const { user, onOpenGame, onOpenProblem, onClose } = setup();
    await type(user, '東5局');
    await user.keyboard('{Enter}');
    expect(onOpenGame).not.toHaveBeenCalled();
    expect(onOpenProblem).not.toHaveBeenCalled();
    expect(onClose).not.toHaveBeenCalled();
  });

  it('日本語の入力の変換中の Enter・Esc・↓ は、変換のためのもの（行を開かない・閉じない・選びを動かさない）', async () => {
    const { user, onOpenGame, onClose } = setup();
    await user.click(input());
    fireEvent.keyDown(input(), { key: 'Enter', isComposing: true });
    fireEvent.keyDown(input(), { key: 'Enter', keyCode: 229 });
    fireEvent.keyDown(input(), { key: 'Escape', isComposing: true });
    fireEvent.keyDown(input(), { key: 'ArrowDown', isComposing: true });
    expect(onOpenGame).not.toHaveBeenCalled();
    expect(onClose).not.toHaveBeenCalled();
    expect(options().indexOf(active() as HTMLElement)).toBe(0);
  });

  it('行を押すと開く。マウスを動かすと、その行が選ばれる（キーボードの位置は、検索欄のまま）', async () => {
    const { user, onOpenGame } = setup();
    const rows = options();
    await user.hover(rows[3] as HTMLElement);
    expect(active()).toBe(rows[3]);
    expect(input()).toHaveFocus();
    await user.click(rows[3] as HTMLElement);
    expect(onOpenGame).toHaveBeenCalledWith('g4');
    expect(input()).toHaveFocus();
  });

  it('問題の行を押すと、半荘の名前と判断の鍵で開く', async () => {
    const { user, onOpenProblem } = setup();
    const problemRow = options()[GAME_LIMIT] as HTMLElement;
    await user.click(problemRow);
    expect(onOpenProblem).toHaveBeenCalledTimes(1);
    expect(onOpenProblem.mock.calls[0]?.[0]).toBe('g1');
  });
});

describe('U-22: 閉じる', () => {
  it('Esc で閉じる（閉じたあとのキーボードの位置は、呼ぶ側が戻す）。結果を開いたのではない', async () => {
    const { user, onClose } = setup();
    await user.keyboard('{Escape}');
    expect(onClose).toHaveBeenCalledWith(false);
  });

  it('「Esc」の印・背景の押下でも閉じる。ダイアログの中の押下では閉じない。文字を選ぶ操作（押し始めが中）では閉じない', async () => {
    const { user, onClose } = setup();
    await user.click(screen.getByRole('button', { name: 'Esc で閉じる' }));
    expect(onClose).toHaveBeenCalledTimes(1);
    const backdrop = dialog().parentElement as HTMLElement;
    await user.click(dialog());
    expect(onClose).toHaveBeenCalledTimes(1);
    // 中で押し始めて、背景で離しても閉じない
    fireEvent.mouseDown(dialog());
    fireEvent.click(backdrop);
    expect(onClose).toHaveBeenCalledTimes(1);
    await user.click(backdrop);
    expect(onClose).toHaveBeenCalledTimes(2);
  });

  it('押した物が消えて、キーボードの位置がどこにも無くなっても、Esc で閉じられる（ページ全体でキーを受ける）', async () => {
    const { user, onClose } = setup();
    (document.activeElement as HTMLElement).blur();
    expect(document.body).toHaveFocus();
    await user.keyboard('{Escape}');
    expect(onClose).toHaveBeenCalledWith(false);
  });

  it('Tab は、ダイアログの中だけを回る（最後から先頭へ、先頭から最後へ）', async () => {
    const { user } = setup();
    const d = dialog();
    const stops = () =>
      [...d.querySelectorAll<HTMLElement>('button:not([disabled]), input:not([disabled]), [tabindex="0"]')];
    const all = stops();
    expect(all[0]).toBe(input());
    (all.at(-1) as HTMLElement).focus();
    await user.tab();
    expect(input()).toHaveFocus();
    await user.tab({ shift: true });
    expect(all.at(-1)).toHaveFocus();
    // 順に Tab を押すと、中の部品すべてに止まる（結果の欄も）
    input().focus();
    const seen = new Set<Element | null>();
    for (let i = 0; i < all.length + 2; i += 1) {
      await user.tab();
      seen.add(document.activeElement);
      expect(d.contains(document.activeElement)).toBe(true);
    }
    for (const stop of all) expect(seen.has(stop)).toBe(true);
  });
});

describe('U-22: 絞り込み（種類・段階・期間・迷いあり・未解答）', () => {
  it('種類: 問題だけ・半荘だけ・両方。押している間は aria-pressed。「条件を解除」で全部外れる', async () => {
    const { user, fixture } = setup();
    const gameChip = screen.getByRole('button', { name: '半荘' });
    const problemChip = screen.getByRole('button', { name: '問題' });
    await user.click(problemChip);
    expect(problemChip).toHaveAttribute('aria-pressed', 'true');
    expect(groupHeads()).toEqual([`問題 · ${fixture.problems.length}件`]);
    await user.click(gameChip);
    expect(groupHeads()).toEqual(['半荘 · 7件', `問題 · ${fixture.problems.length}件`]);
    await user.click(problemChip);
    expect(groupHeads()).toEqual(['半荘 · 7件']);
    await user.click(screen.getByRole('button', { name: '条件を解除' }));
    expect(gameChip).toHaveAttribute('aria-pressed', 'false');
    expect(screen.queryByRole('button', { name: '条件を解除' })).toBeNull();
    expect(groupHeads()).toEqual(['半荘 · 7件', `問題 · ${fixture.problems.length}件`]);
    // 押したチップに、キーボードの位置が残っている（絞り込んでも、位置が消えない）
    await user.click(gameChip);
    expect(gameChip).toHaveFocus();
  });

  it('「条件を解除」は、押すと消えるので、キーボードの位置は検索欄へ移る（位置が失われない）', async () => {
    const { user, onClose } = setup();
    await user.click(screen.getByRole('button', { name: '迷いあり' }));
    const clear = screen.getByRole('button', { name: '条件を解除' });
    clear.focus();
    await user.keyboard('{Enter}');
    expect(screen.queryByRole('button', { name: '条件を解除' })).toBeNull();
    expect(input()).toHaveFocus();
    await user.keyboard('{Escape}');
    expect(onClose).toHaveBeenCalledWith(false);
  });

  it('迷いあり: 迷いのある半荘と、迷いの問題。未解答: まだ答えていない問題と半荘（答えると、その問題は出ない）', async () => {
    const { user } = setup();
    await user.click(screen.getByRole('button', { name: '迷いあり' }));
    expect(groupHeads()).toEqual(['半荘 · 3件', '問題 · 5件']);
    expect(options().filter((o) => /^問題 /.test(optionText(o))).every((o) => /迷い\d/.test(optionText(o)))).toBe(true);
    await user.click(screen.getByRole('button', { name: '迷いあり' }));
    await user.click(screen.getByRole('button', { name: '未解答' }));
    expect(groupHeads()[0]).toBe('半荘 · 6件');
  });

  it('未解答: 答えた問題は出ない。答えた問題の行は「解答済み」と、学んだ原則（原則: …）を出し、原則の文字でも見つかる', async () => {
    const base = searchFixture();
    const target = base.problems.find((p) => p.sessionId === 'g2' && p.decision.kyokuLabel === '東4局' && p.decision.junme === 13);
    const answers = [answerRow({ id: 1, session_id: 'g2', decision_key: target?.key ?? '', principle: '受け入れを数えてから切る' })];
    const { user, fixture } = setup({ answers });
    await user.click(screen.getByRole('button', { name: '問題' }));
    await user.click(screen.getByRole('button', { name: '未解答' }));
    expect(groupHeads()).toEqual([`問題 · ${fixture.problems.length - 1}件`]);
    await user.click(screen.getByRole('button', { name: '未解答' }));
    await user.click(input());
    await user.keyboard('受け入れ');
    const row = options()[0] as HTMLElement;
    expect(optionText(row)).toBe('問題 東4局 13巡目 打牌 · 1向聴 · 10月9日 17:12 の半荘 · 原則: 受け入れを数えてから切る 解答済み');
    expect([...row.querySelectorAll('mark.hit')].map((m) => m.textContent)).toEqual(['受け入れ']);
  });

  it('段階: 半荘の一覧と同じ選び方（すべて・A 以下・B 以下・C 以下）。A 以下 = A+ から下', async () => {
    const { user } = setup();
    const chip = () => screen.getByRole('button', { name: /^段階：/ });
    await user.click(chip());
    const menu = screen.getByRole('menu', { name: '段階で絞り込む' });
    expect(within(menu).getAllByRole('menuitemradio').map((item) => item.textContent)).toEqual(['すべて', 'A 以下', 'B 以下', 'C 以下']);
    await user.click(within(menu).getByRole('menuitemradio', { name: 'A 以下' }));
    expect(chip()).toHaveAccessibleName('段階：A 以下');
    expect(chip()).toHaveFocus();
    // g1・g3 は S-。A 以下は、A+ から下の 4 半荘
    expect(groupHeads()[0]).toBe('半荘 · 4件');
    await user.click(chip());
    await user.click(screen.getByRole('menuitemradio', { name: 'B 以下' }));
    expect(options()).toHaveLength(0);
  });

  it('期間: すべて・本日・昨日まで・7日以内・30日以内', async () => {
    const { user } = setup();
    const chip = () => screen.getByRole('button', { name: /^期間：/ });
    await user.click(chip());
    const menu = screen.getByRole('menu', { name: '期間で絞り込む' });
    expect(within(menu).getAllByRole('menuitemradio').map((item) => item.textContent)).toEqual(['すべて', '本日', '昨日まで', '7日以内', '30日以内']);
    await user.click(within(menu).getByRole('menuitemradio', { name: '本日' }));
    expect(chip()).toHaveAccessibleName('期間：本日');
    expect(groupHeads()[0]).toBe('半荘 · 2件');
    await user.click(chip());
    await user.click(screen.getByRole('menuitemradio', { name: '7日以内' }));
    expect(groupHeads()[0]).toBe('半荘 · 6件');
    // 絞り込んだ状態でも、チップには「かかっている」印（is-on）
    expect(chip()).toHaveClass('is-on');
  });

  it('メニューは、キーボードだけで選べる（↓ で動かして Enter）。選んだあと、キーボードの位置はチップへ戻る。Esc は、メニューだけを閉じる', async () => {
    const { user, onClose } = setup();
    await user.click(screen.getByRole('button', { name: /^期間：/ }));
    await user.keyboard('{ArrowDown}{Enter}');
    expect(screen.getByRole('button', { name: '期間：本日' })).toHaveFocus();
    expect(groupHeads()[0]).toBe('半荘 · 2件');
    await user.keyboard('{Enter}');
    expect(screen.getByRole('menu', { name: '期間で絞り込む' })).toBeInTheDocument();
    await user.keyboard('{Escape}');
    expect(screen.queryByRole('menu')).toBeNull();
    expect(onClose).not.toHaveBeenCalled();
    expect(screen.getByRole('button', { name: '期間：本日' })).toHaveFocus();
    // もう一度 Esc で、重ね表示が閉じる
    await user.keyboard('{Escape}');
    expect(onClose).toHaveBeenCalledWith(false);
  });

  it('組み合わせられる（検索語・種類・段階・期間・迷いあり）。検索語の絞りと条件の絞りは、別々に外せる', async () => {
    const { user } = setup();
    await type(user, '玉の間');
    await user.click(screen.getByRole('button', { name: '迷いあり' }));
    await user.click(screen.getByRole('button', { name: /^期間：/ }));
    await user.click(screen.getByRole('menuitemradio', { name: '本日' }));
    expect(groupHeads()).toEqual(['半荘 · 1件', '問題 · 3件']);
    await user.click(screen.getByRole('button', { name: '条件を解除' }));
    expect(input()).toHaveValue('玉の間');
    expect(groupHeads()[0]).toBe('半荘 · 6件');
  });
});

describe('U-22: 並べ方（新しい順・古い順・Rating が低い順・AI との差が大きい順）', () => {
  async function choose(user: ReturnType<typeof userEvent.setup>, name: string) {
    await user.click(screen.getByRole('button', { name: /^並べ替え：/ }));
    const menu = screen.getByRole('menu', { name: '並べ替え' });
    expect(within(menu).getAllByRole('menuitemradio').map((item) => item.textContent)).toEqual([
      '新しい順',
      '古い順',
      'Rating が低い順',
      'AI との差が大きい順',
    ]);
    await user.click(within(menu).getByRole('menuitemradio', { name }));
    expect(screen.getByRole('button', { name: `並べ替え：${name}` })).toHaveFocus();
  }
  const gameTimes = () => options().filter((o) => /^半荘 /.test(optionText(o))).map((o) => o.querySelector('.s-time')?.textContent);

  it('古い順・Rating が低い順', async () => {
    const { user } = setup();
    expect(gameTimes()).toEqual(['19:09', '17:12', '21:40', '20:55', '22:10']);
    await choose(user, '古い順');
    expect(gameTimes()).toEqual(['22:05', '20:12', '22:10', '20:55', '21:40']);
    await choose(user, 'Rating が低い順');
    // 83.3（20:55）・86.7（17:12）・87.3（20:12）・90.2（22:10）・91.9（21:40）
    expect(gameTimes()).toEqual(['20:55', '17:12', '20:12', '22:10', '21:40']);
  });

  it('AI との差が大きい順: 問題は、AI が実戦の行動に付けた確率の低い順。確率・割合・順位は、画面にも DOM にも出ない（U-1・U-22）', async () => {
    const { user, fixture } = setup();
    await choose(user, 'AI との差が大きい順');
    const lowest = [...fixture.problems].sort((a, b) => a.probability - b.probability || b.startedMs - a.startedMs || a.decision.index - b.decision.index);
    const firstProblem = options().find((o) => /^問題 /.test(optionText(o))) as HTMLElement;
    const top = lowest[0];
    expect(top).toBeDefined();
    expect(firstProblem.querySelector('.t')?.textContent).toBe(`${top?.decision.kyokuLabel} ${top?.decision.junme}巡目`);
    const text = dialog().textContent ?? '';
    expect(text).not.toMatch(/\d\s*[%％]|確率|順位|Mortal/);
    const html = dialog().innerHTML;
    expect(html).not.toMatch(/data-ai|probability|確率/);
    // 並べ替えを選ぶ前の画面にも、無い
    expect(screen.queryByText(/%/)).toBeNull();
  });

  it('答える前の問題の行に、AI の候補・確率・順位が無い（実戦の行動・自分の答えも出さない）', () => {
    setup();
    const rows = options().filter((o) => /^問題 /.test(optionText(o)));
    for (const row of rows) {
      expect(row.querySelector('[data-ai]')).toBeNull();
      expect(optionText(row)).not.toMatch(/実戦|打\d|AI/);
    }
  });
});

describe('U-22: 「すべて表示（あと N件）」', () => {
  it('押すと、すべて出る。「上位だけ表示」で、切った表示に戻る', async () => {
    const { user, fixture } = setup();
    await user.click(within(dialog()).getByRole('button', { name: /^すべて表示/ }));
    expect(options()).toHaveLength(7 + fixture.problems.length);
    expect(within(dialog()).queryByRole('button', { name: /^すべて表示/ })).toBeNull();
    await user.click(within(dialog()).getByRole('button', { name: '上位だけ表示' }));
    expect(options()).toHaveLength(GAME_LIMIT + PROBLEM_LIMIT);
  });

  it('キーボードで押しても、同じボタンにキーボードの位置が残る（名前だけが変わる）。そのまま Esc で閉じられる', async () => {
    const { user, fixture, onClose } = setup();
    const more = within(dialog()).getByRole('button', { name: /^すべて表示/ });
    more.focus();
    await user.keyboard('{Enter}');
    const collapse = within(dialog()).getByRole('button', { name: '上位だけ表示' });
    expect(collapse).toBe(more);
    expect(collapse).toHaveFocus();
    expect(options()).toHaveLength(7 + fixture.problems.length);
    await user.keyboard('{Enter}');
    expect(within(dialog()).getByRole('button', { name: /^すべて表示/ })).toHaveFocus();
    await user.keyboard('{Escape}');
    expect(onClose).toHaveBeenCalledWith(false);
  });

  it('検索語を変えると、また切った表示に戻る（すべて表示は、その検索語の間だけ）', async () => {
    const { user } = setup();
    await user.click(within(dialog()).getByRole('button', { name: /^すべて表示/ }));
    await type(user, '玉の間');
    expect(options()).toHaveLength(GAME_LIMIT + PROBLEM_LIMIT);
  });
});

describe('U-22: 問題を読み込んでいる間', () => {
  it('半荘は探せる。問題の数は「読み込み中」と出し、問題の行は出さない。当たる行が無いときは、読み込み中と伝える', async () => {
    const { user } = setup({ ready: false });
    expect(countLine()).toBe('半荘 7 · 問題 読み込み中すべて表示（あと2件）');
    expect(groupHeads()).toEqual(['半荘 · 7件']);
    // 半荘の行の右に「問題 0」とは出さない
    expect(options().every((o) => !/問題 \d/.test(optionText(o)))).toBe(true);
    await type(user, '東5局');
    expect(blockText(dialog().querySelector('.sx-empty') as HTMLElement)).toContain('問題を読み込んでいます。読み終えると、問題も探せます。');
  });
});

describe('U-22: 開いている間のアプリのキー操作（Ctrl+Z・Alt+← など）の停止', () => {
  it('開いている間は、アプリのキー操作を止める。閉じたら（外したら）、また動く', () => {
    const { blockedLog, unmount } = setup();
    fireEvent.click(screen.getByRole('button', { name: 'probe' }));
    expect(blockedLog).toEqual([true]);
    unmount();
  });

  it('重ね表示を外すと、止めていたキー操作が動く', () => {
    const fixture = searchFixture();
    const log: boolean[] = [];
    function Probe() {
      const blocked = useShortcutsBlocked();
      return (
        <button type="button" onClick={() => log.push(blocked())}>
          probe
        </button>
      );
    }
    function Harness({ open }: { open: boolean }) {
      return (
        <UndoProvider>
          <StudyProvider value={studyValue(fixture, {})}>
            <Probe />
            {open && (
              <SearchOverlay rows={fixture.rows} summaries={fixture.summaries} now={SEARCH_NOW} onOpenGame={vi.fn()} onOpenProblem={vi.fn()} onClose={vi.fn()} />
            )}
          </StudyProvider>
        </UndoProvider>
      );
    }
    const { rerender } = render(<Harness open />);
    fireEvent.click(screen.getByRole('button', { name: 'probe' }));
    rerender(<Harness open={false} />);
    fireEvent.click(screen.getByRole('button', { name: 'probe' }));
    expect(log).toEqual([true, false]);
    expect(document.body).not.toHaveClass('sx-open');
  });

  it('部品は 1 つずつ: 検索欄（combobox）・結果の一覧（listbox）', () => {
    setup();
    expect(screen.getAllByRole('combobox')).toHaveLength(1);
    expect(screen.getAllByRole('listbox')).toHaveLength(1);
    expect(SEARCH_SEEDS).toHaveLength(7);
  });
});

describe('macOS: Cmd の組み合わせ（段階 2）', () => {
  afterEach(() => setPlatform(WINDOWS_PLATFORM));

  it('Cmd+↑ ↓ で、先頭・末尾の行へ行く。「Cmd」の印が出る', async () => {
    setPlatform(MAC_STAGE_2_PLATFORM);
    const { user } = setup();
    const total = options().length;
    expect(within(dialog()).getByText('Cmd')).toBeInTheDocument();
    expect(within(dialog()).queryByText('Ctrl')).toBeNull();
    await user.keyboard('{Meta>}{ArrowDown}{/Meta}');
    expect(options().indexOf(active() as HTMLElement)).toBe(total - 1);
    await user.keyboard('{Meta>}{ArrowUp}{/Meta}');
    expect(options().indexOf(active() as HTMLElement)).toBe(0);
    // Ctrl+Home / Ctrl+End も、これまでどおり使える
    await user.keyboard('{Control>}{End}{/Control}');
    expect(options().indexOf(active() as HTMLElement)).toBe(total - 1);
  });

  it('Windows では、Cmd（Win キー）+↓ は、ただの ↓（1 つ進むだけ）。印は「Ctrl」', async () => {
    const { user } = setup();
    expect(within(dialog()).getByText('Ctrl')).toBeInTheDocument();
    await user.keyboard('{Meta>}{ArrowDown}{/Meta}');
    expect(options().indexOf(active() as HTMLElement)).toBe(1);
  });
});
