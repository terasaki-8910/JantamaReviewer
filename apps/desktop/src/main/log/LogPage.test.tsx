/**
 * 検討ログ（ACCEPTANCE の U-29。U-1・U-2・U-4・U-5・D-3 に関わる所）の、画面の試験。
 * アプリ全体（App）を、半荘の保存先の偽物と、答えの記録の偽物の上で動かして、使う人と同じ操作で確かめる。
 * 実ブラウザでの見え方（横スクロール・axe・Tab・牌の画像）は、tests/browser/log.browser.test.ts が確かめる。
 * 行の組み立て・絞り込み・要約・手牌が再生と一致することは、logModel.test.ts（単体）が確かめる。
 */
import {
  actualChoice,
  calledTileOf,
  keyOfDecision,
  replayFrames,
  splitKyokus,
  type Decision,
  type ImportedGame,
  type Tile,
} from '@jantama/engine';
import { cleanup, render, screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { FakeSessionStore, local, seedSession } from '../../../tests/fake-sessions';
import { FakeStudyStore, answerRow, gameOf } from '../../../tests/fake-study';
import { fx4Ocr, fx4Session } from '../../../tests/import-fixtures';
import { baseSettings, installTauriMock } from '../../../tests/tauri-mock';
import type { AnswerRow } from '../../api/types';
import { App } from '../App';
import { tileName, tileSrc } from '../study/tiles';

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
  vi.useRealTimers();
});

const FX4_ID = '20261009-190953';
const FX1A_ID = '20261009-171200';
const LOAD = { timeout: 20_000 };

const fx4 = gameOf('fx4');
const fx1a = gameOf('fx1a');

function seeds() {
  return [
    {
      session: fx4Session(FX4_ID, local(2026, 10, 9, 19, 9), { report_path: `C:\\data\\games\\${FX4_ID}\\report.json`, ocr: fx4Ocr() }),
      report: 'fx4' as const,
    },
    seedSession(local(2026, 10, 9, 17, 12), { id: FX1A_ID, report: 'fx1a' }),
  ];
}

const discards = (game: ImportedGame) => game.decisions.filter((d) => d.kind === 'discard');
const keyOf = (decision: Decision | undefined) => keyOfDecision(decision as Decision);

// 答える問題（FX-4 の打牌 2 つと、鳴き 1 つ。f9da の打牌 3 つ）
const A = discards(fx4)[10] as Decision;
const B = discards(fx4)[25] as Decision;
const CALL = fx4.decisions.find((d) => d.kind === 'call' && calledTileOf(d) !== null) as Decision;
const C = discards(fx1a)[12] as Decision;
const D = discards(fx1a)[30] as Decision;
const E = discards(fx1a)[45] as Decision;

/** MAKA の打牌が Mortal の 1 位と違うように、手牌の中から 1 枚選ぶ。 */
function makaOtherThanTop(decision: Decision): Tile {
  const top = decision.entry.details[0]?.action;
  const topTile = top?.type === 'dahai' ? top.pai.replace('r', '') : '';
  return decision.board.hand.find((tile) => tile.replace('r', '') !== topTile) as Tile;
}

function answer(id: number, sessionId: string, decision: Decision, patch: Partial<AnswerRow>): AnswerRow {
  return answerRow({
    id,
    session_id: sessionId,
    decision_key: keyOf(decision),
    choice: actualChoice(decision),
    ...patch,
  });
}

/** 今週（10/5〜）の 4 問と、先週の 2 問。A には、あとから別の答えを重ねてある（行は、いちばん新しい答え）。 */
function answers(): AnswerRow[] {
  return [
    answer(1, FX4_ID, A, {
      mode: 'quiz',
      answered_at: local(2026, 10, 9, 20, 0),
      correct: false,
      causes: ['defense', 'ukeire'],
      principle: 'リーチが無いときは、受け入れを優先する',
      reason: '守備を考えて、切りたかった',
      duration_ms: 62_000,
      reselect_count: 2,
      interval_days: 1,
      due_date: '2026-10-10',
    }),
    answer(2, FX4_ID, A, { mode: 'quiz', answered_at: local(2026, 10, 9, 19, 50), correct: true, reason: '前の答え', due_date: '2026-10-10' }),
    answer(3, FX4_ID, B, {
      mode: 'quiz',
      answered_at: local(2026, 10, 8, 21, 0),
      correct: true,
      causes: ['shape'],
      principle: '形を崩さないほうを残す',
      reason: '形を見た',
      duration_ms: 38_000,
      due_date: '2026-10-09',
    }),
    answer(4, FX4_ID, CALL, {
      mode: 'quiz',
      answered_at: local(2026, 10, 7, 20, 0),
      correct: true,
      reason: '鳴いて進める',
      duration_ms: 50_000,
      reselect_count: 1,
      due_date: '2026-10-08',
    }),
    answer(5, FX1A_ID, C, {
      mode: 'review',
      answered_at: local(2026, 10, 8, 22, 0),
      correct: false,
      reason: '解き直しの答え',
      duration_ms: 30_000,
      maka_move: makaOtherThanTop(C),
      interval_days: 1,
      due_date: '2026-10-09',
    }),
    answer(6, FX1A_ID, D, { mode: 'quiz', answered_at: local(2026, 10, 2, 20, 0), correct: true, reason: '先週の答え', due_date: '2026-10-03' }),
    answer(7, FX1A_ID, E, { mode: 'quiz', answered_at: local(2026, 10, 1, 20, 0), correct: false, reason: '先週の間違い', due_date: '2026-10-02' }),
  ];
}

function setup(options: { study?: FakeStudyStore } = {}) {
  const sessions = new FakeSessionStore(seeds());
  const study = options.study ?? new FakeStudyStore(answers());
  const mock = installTauriMock({
    settings: { ...baseSettings },
    handlers: { ...sessions.handlers, ...study.handlers },
  });
  const user = userEvent.setup();
  const view = render(<App />);
  return { user, mock, sessions, study, view };
}

type User = ReturnType<typeof userEvent.setup>;

const navButton = (name: RegExp) => within(screen.getByRole('navigation', { name: 'メイン' })).getByRole('button', { name });
const sideCount = () => navButton(/^今日の出題/).querySelector('.count')?.textContent ?? null;
const list = () => screen.getByRole('list', { name: '答えた問題' });
const rowButtons = () => [...(screen.queryByRole('list', { name: '答えた問題' })?.querySelectorAll<HTMLButtonElement>('button.lrow') ?? [])];
const text = (el: Element | null | undefined) => (el?.textContent ?? '').replace(/\s+/g, ' ').trim();
const summary = () => text(screen.getByRole('status'));
const filterButton = (name: RegExp) => within(screen.getByRole('group', { name: '絞り込み' })).getByRole('button', { name });

async function openLog(user: User) {
  await screen.findByRole('navigation', { name: '半荘の一覧' });
  await waitFor(() => expect(sideCount()).not.toBeNull(), LOAD);
  await user.click(navButton(/^ログ/));
  await screen.findByRole('heading', { level: 1, name: 'ログ' });
  await waitFor(() => expect(rowButtons().length).toBeGreaterThan(0), LOAD);
}

describe('U-29 ログの画面（サイドバー・行・要約）', () => {
  it('サイドバーの「ログ」は押せる。押すと本文が替わり、aria-current が付く', async () => {
    const { user } = setup();
    await screen.findByRole('navigation', { name: '半荘の一覧' });
    expect(navButton(/^ログ/)).not.toHaveAttribute('aria-disabled');
    expect(navButton(/^ログ/)).not.toHaveAttribute('aria-current');
    await openLog(user);
    expect(navButton(/^ログ/)).toHaveAttribute('aria-current', 'page');
    expect(navButton(/^今日の出題/)).not.toHaveAttribute('aria-current');
  });

  it('既定は今週: 答えた問題が 1 問 1 行（同じ問題は最後の答えだけ）。新しく答えた順', async () => {
    const { user } = setup();
    await openLog(user);
    const rows = rowButtons();
    // 今週: A（最後の答え）・C（解き直し）・B・CALL
    expect(rows).toHaveLength(4);
    expect(rows.map((row) => row.getAttribute('data-problem'))).toEqual([
      `${FX4_ID}/${keyOf(A)}`,
      `${FX1A_ID}/${keyOf(C)}`,
      `${FX4_ID}/${keyOf(B)}`,
      `${FX4_ID}/${keyOf(CALL)}`,
    ]);
    // 最初の行: 答えた日・種類・局と巡目・半荘・種類と印・不正解・原因・原則・時間と選び直し・次の解き直し
    const first = rows[0] as HTMLElement;
    expect(text(first.querySelector('.l-date'))).toBe('10月9日');
    expect(text(first.querySelector('.l-mode'))).toBe('出題');
    expect(text(first.querySelector('.l-t'))).toBe(`${A.kyokuLabel} ${A.junme}巡目`);
    expect(text(first.querySelector('.l-l2'))).toBe('10月9日 19:09 の半荘');
    expect([...first.querySelectorAll('.l-l1 .q-tag')].map((tag) => text(tag))[0]).toBe('打牌');
    expect(text(first.querySelector('.l-res'))).toBe('不正解');
    expect([...first.querySelectorAll('.lchip')].map((chip) => text(chip))).toEqual(['守備', '受け入れ枚数']);
    expect(text(first.querySelector('.l-pr'))).toBe('原則 リーチが無いときは、受け入れを優先する');
    expect(text(first.querySelector('.l-time'))).toBe('答えるまで 1:02 · 選び直し 2回');
    expect(text(first.querySelector('.l-next'))).toBe('次の解き直し 10月10日');
    // 解き直しの行は、種類が「解き直し」。期限が今日なら、次の解き直しは「今日」
    const review = rows[1] as HTMLElement;
    expect(text(review.querySelector('.l-mode'))).toBe('解き直し');
    expect(text(review.querySelector('.l-next'))).toBe('次の解き直し 今日');
    // 原因も原則も無い行は、その段を出さない
    expect(review.querySelector('.l-l3')).toBeNull();
  });

  it('絞り込みは 1 行に、期間・種類・局面・原因・結果の順。要約は行と合う（今週: 4 問）', async () => {
    const { user } = setup();
    await openLog(user);
    const group = screen.getByRole('group', { name: '絞り込み' });
    const buttons = within(group).getAllByRole('button');
    expect(buttons.map((button) => text(button))).toEqual(['期間 今週', '種類 すべて', '局面 すべて', '原因 すべて', '結果 すべて']);
    // 1 行に並ぶ（jsdom には配置が無いので、同じ入れ物の直下に、この順で並ぶことを見る。実際の並びは実ブラウザの検査）
    expect(buttons.every((button) => button.parentElement === group)).toBe(true);
    // 4 問・正解 2 問（B・CALL）= 50%・答えるまでの平均 (62+38+50+30)/4 = 45 秒・選び直しあり 2 問（A・CALL）・MAKA と食い違い 1 問（C）
    expect(summary()).toBe('4問・正解 50%・答えるまで 平均 0:45・選び直しあり 2問・MAKA と食い違い 1問');
    // 食い違いの行にだけ、印が付く
    const marked = rowButtons().filter((row) => row.querySelector('.q-tag.maka') !== null);
    expect(marked).toHaveLength(1);
    expect(marked[0]?.getAttribute('data-problem')).toBe(`${FX1A_ID}/${keyOf(C)}`);
    expect(text(marked[0]?.querySelector('.q-tag.maka'))).toBe('MAKA と食い違い');
  });
});

describe('U-29・R11-11 行の手牌（プレビュー。答えを出さなくても出る）', () => {
  function replayedBoard(game: ImportedGame, decision: Decision) {
    const kyoku = splitKyokus(game.report.mjai_log)[decision.kyokuPosition];
    if (kyoku === undefined) throw new Error('局が無い');
    const frame = replayFrames(kyoku, game.playerId)[decision.eventIndex - kyoku.startIndex];
    if (frame === undefined) throw new Error('場面が無い');
    return frame.board;
  }

  const rowOf = (sessionId: string, decision: Decision) =>
    rowButtons().find((row) => row.getAttribute('data-problem') === `${sessionId}/${keyOf(decision)}`) as HTMLElement;

  it('打牌の判断: 手牌 13 枚とツモ牌が、牌譜を再生した盤面と同じ並びで、小さな牌の画像になる。ツモ牌は離れる', async () => {
    const { user } = setup();
    await openLog(user);
    for (const [sessionId, game, decision] of [
      [FX4_ID, fx4, A],
      [FX4_ID, fx4, B],
      [FX1A_ID, fx1a, C],
    ] as const) {
      const board = replayedBoard(game, decision);
      const hand = rowOf(sessionId, decision).querySelector('.l-hand') as HTMLElement;
      const images = [...hand.querySelectorAll('.l-hs:not(.l-meld) img')];
      const expected = [...board.hand, ...(board.drawn === null ? [] : [board.drawn])];
      expect(images.map((img) => img.getAttribute('src'))).toEqual(expected.map((tile) => tileSrc(tile)));
      // 手牌 + ツモ牌 + 副露の牌が、14 枚（暗槓・明槓・加槓があれば、その分だけ増える）
      expect(images.length + board.melds[game.playerId]!.reduce((n, meld) => n + meld.consumed.length + 1, 0)).toBeGreaterThanOrEqual(14);
      // 1 つの画像として読み上げる（牌の名前を並べた文。副露があれば、そのあとに）
      expect(hand).toHaveAttribute('role', 'img');
      expect(hand.getAttribute('aria-label')).toMatch(
        new RegExp(`^手牌 ${board.hand.map((tile) => tileName(tile)).join('・')}、ツモ牌 ${tileName(board.drawn as Tile)}(、副露 .+)?$`),
      );
      // ツモ牌は、手牌から離れている（最後の手牌のあと）
      const slots = [...hand.querySelectorAll('.l-hs:not(.l-meld)')];
      expect(slots.filter((slot) => slot.classList.contains('gap'))).toEqual([slots.at(-1)]);
      // 副露は、その右に、副露の数だけ
      expect(hand.querySelectorAll('.l-meld .meld')).toHaveLength(board.melds[game.playerId]!.length);
      expect(hand.hasAttribute('data-called')).toBe(false);
    }
  });

  it('鳴きの判断: 手牌と、鳴く牌（他家の打牌。「下家の打牌」などの印つき）。ツモ牌は無い', async () => {
    const { user } = setup();
    await openLog(user);
    const board = replayedBoard(fx4, CALL);
    const hand = rowOf(FX4_ID, CALL).querySelector('.l-hand') as HTMLElement;
    const called = calledTileOf(CALL) as Tile;
    expect([...hand.querySelectorAll('.l-hs:not(.l-meld) img')].map((img) => img.getAttribute('src'))).toEqual(
      [...board.hand, called].map((tile) => tileSrc(tile)),
    );
    expect(hand.hasAttribute('data-called')).toBe(true);
    expect(text(hand.querySelector('.l-cap'))).toMatch(/^(下家|対面|上家)の打牌$/);
    expect(hand.getAttribute('aria-label')).toMatch(new RegExp(`、(下家|対面|上家)の打牌 ${tileName(called)}(、副露 .+)?$`));
    expect(hand.getAttribute('aria-label')).not.toContain('ツモ牌');
    expect(hand.querySelector('.tile.target')).not.toBeNull();
  });

  it('手牌は「答えを出す」が切のときも、入のときも出る。牌の画像に代わりの文字は付けない（1 つの画像として読み上げる）', async () => {
    const { user } = setup();
    await openLog(user);
    expect(rowButtons().every((row) => row.querySelector('.l-hand img') !== null)).toBe(true);
    await user.click(screen.getByRole('checkbox', { name: '答えを出す' }));
    expect(rowButtons().every((row) => row.querySelector('.l-hand img') !== null)).toBe(true);
    for (const img of list().querySelectorAll('.l-hand .l-hs:not(.l-meld) img')) expect(img.getAttribute('alt')).toBe('');
  });
});

describe('U-25・U-29 「答えを出す」の説明は、説明のアイコン（i）', () => {
  const HINT = 'あとで解き直すときに答えが見えてしまわないよう、ふだんは隠します。';

  it('説明の文は、本文に出さない。「答えを出す」のすぐ右の (i) に、マウスを乗せるかキーボードで選ぶと、重ねて出る。Esc で閉じる', async () => {
    const { user } = setup();
    await openLog(user);
    const bar = document.querySelector('.lbar') as HTMLElement;
    expect(bar.textContent).not.toContain('ふだんは隠します');
    expect(document.querySelector('p.quiet#log-answers-help')).toBeNull();
    expect(screen.queryByRole('tooltip')).toBeNull();
    const toggle = screen.getByRole('checkbox', { name: '答えを出す' });
    const icon = within(bar).getByRole('button', { name: '「答えを出す」の説明' });
    // (i) は、チェックのすぐ右（同じ行の中）
    expect(toggle.closest('.lans')).toBe(icon.closest('.lans'));
    expect(toggle.closest('label')?.nextElementSibling).toBe(icon.closest('.infotip'));
    // チェックは、同じ文を読み上げの説明として持つ
    expect(toggle).toHaveAccessibleDescription(HINT);
    await user.hover(icon);
    expect(screen.getByRole('tooltip')).toHaveTextContent(HINT);
    await user.keyboard('{Escape}');
    expect(screen.queryByRole('tooltip')).toBeNull();
    await user.unhover(icon);
    // キーボードで選ぶ: Tab で、チェックの次に (i)
    toggle.focus();
    await user.tab();
    expect(icon).toHaveFocus();
    expect(screen.getByRole('tooltip')).toHaveTextContent(HINT);
    await user.keyboard('{Escape}');
    expect(screen.queryByRole('tooltip')).toBeNull();
  });
});

describe('U-29・U-1 「答えを出す」（既定は切）', () => {
  it('切のとき、自分・実戦・AI の1位は DOM に無い。入れると全部の行に出て、切るとまた無くなる', async () => {
    const { user } = setup();
    await openLog(user);
    const toggle = screen.getByRole('checkbox', { name: '答えを出す' });
    expect(toggle).not.toBeChecked();
    // DOM に無い（隠しているだけではない）。答えの文字も、AI の候補も確率も出ていない
    expect(list().querySelector('.l-ans')).toBeNull();
    expect(list().textContent).not.toMatch(/自分|実戦|AI の1位/);
    expect(document.body.innerHTML).not.toMatch(/data-ai|Mortal/);
    expect(list()).toHaveAttribute('data-ans', 'off');

    await user.click(toggle);
    expect(toggle).toBeChecked();
    const answers = [...list().querySelectorAll('.l-ans')];
    expect(answers).toHaveLength(4);
    for (const el of answers) {
      expect([...el.querySelectorAll('.l-ak')].map((k) => text(k))).toEqual(['自分', '実戦', 'AI の1位']);
    }
    // 最初の行（A）: 実戦の行動（打牌）と、自分の答え（実戦と同じ牌を選んだ答えにしてある）
    const first = answers[0] as HTMLElement;
    expect(text(first.querySelector('.l-a.you'))).toMatch(/^自分 打\S+$/);
    expect(text(first.querySelector('.l-a.act'))).toMatch(/^実戦 打\S+$/);
    expect(text(first.querySelector('.l-a.top'))).toMatch(/^AI の1位 打\S+$/);
    expect(text(first.querySelector('.l-a.you')).replace('自分 ', '')).toBe(text(first.querySelector('.l-a.act')).replace('実戦 ', ''));
    // 鳴きの判断の答えは、ボタンの言い方（例: 東をポン・スルー）
    const call = answers[3] as HTMLElement;
    expect(text(call.querySelector('.l-a.you'))).toMatch(/^自分 (.+をチー（.+）|.+をポン|.+をカン|スルー)$/);

    await user.click(toggle);
    expect(toggle).not.toBeChecked();
    expect(list().querySelector('.l-ans')).toBeNull();
    expect(list().textContent).not.toMatch(/自分|実戦|AI の1位/);
  });

  it('ログから問題を開いて戻っても、「答えを出す」と絞り込みは、そのまま。起動し直す（開き直す）と、切に戻る', async () => {
    const { user, view } = setup();
    await openLog(user);
    await user.click(screen.getByRole('checkbox', { name: '答えを出す' }));
    await user.click(filterButton(/^結果/));
    await user.click(screen.getByRole('menuitemcheckbox', { name: /^不正解/ }));
    await user.keyboard('{Escape}');
    expect(rowButtons()).toHaveLength(2);
    await user.click(rowButtons()[0] as HTMLElement);
    await screen.findByRole('heading', { level: 1, name: `${A.kyokuLabel} ${A.junme}巡目` });
    await user.keyboard('{Alt>}{ArrowLeft}{/Alt}');
    await screen.findByRole('heading', { level: 1, name: 'ログ' });
    expect(screen.getByRole('checkbox', { name: '答えを出す' })).toBeChecked();
    expect(filterButton(/^結果/)).toHaveTextContent('不正解');
    expect(rowButtons()).toHaveLength(2);
    // 開き直す: 答えの記録は残っていて、「答えを出す」と絞り込みは最初に戻る
    view.unmount();
    cleanup();
    const second = userEvent.setup();
    render(<App />);
    await openLog(second);
    expect(rowButtons()).toHaveLength(4);
    expect(screen.getByRole('checkbox', { name: '答えを出す' })).not.toBeChecked();
    expect(list().querySelector('.l-ans')).toBeNull();
  });
});

describe('U-29 絞り込み', () => {
  it('結果: 「不正解」を選ぶと、その行だけになる。要約も絞り込んだ行から数える。メニューは押しても閉じない（いくつでも選べる）', async () => {
    const { user } = setup();
    await openLog(user);
    const button = filterButton(/^結果/);
    expect(button).toHaveAttribute('aria-haspopup', 'menu');
    await user.click(button);
    const menu = screen.getByRole('menu', { name: '結果' });
    const items = within(menu).getAllByRole('menuitemcheckbox');
    // 並びと、選んだときの数（今週の行のうち）
    expect(items.map((item) => text(item))).toEqual(['正解2', '不正解2']);
    await user.click(items[1] as HTMLElement);
    // 押しても閉じない。選んだ印が付く
    expect(screen.getByRole('menu', { name: '結果' })).toBeInTheDocument();
    expect(screen.getByRole('menuitemcheckbox', { name: /^不正解/ })).toHaveAttribute('aria-checked', 'true');
    expect(rowButtons().map((row) => text(row.querySelector('.l-res')))).toEqual(['不正解', '不正解']);
    expect(summary()).toBe('2問・正解 0%・答えるまで 平均 0:46・選び直しあり 1問・MAKA と食い違い 1問');
    // 両方選ぶと、どちらも出る
    await user.click(screen.getByRole('menuitemcheckbox', { name: /^正解/ }));
    expect(rowButtons()).toHaveLength(4);
    await user.keyboard('{Escape}');
    expect(screen.queryByRole('menu')).toBeNull();
    // 選んでいる値が、ボタンに出る（2 つなら「2つ」）。かかっているものは印（on）
    expect(filterButton(/^結果/)).toHaveTextContent('2つ');
    expect(filterButton(/^結果/)).toHaveClass('on');
    expect(filterButton(/^結果/)).toHaveFocus();
  });

  it('原因・種類・局面: 項目どうしは「すべて」、項目の中は「どれか」。「解除」で、すべてはずれる', async () => {
    const { user } = setup();
    await openLog(user);
    // 原因: 形の質 → B だけ
    await user.click(filterButton(/^原因/));
    expect(within(screen.getByRole('menu', { name: '原因' })).getAllByRole('menuitemcheckbox').map((item) => text(item))).toEqual([
      '受け入れ枚数1',
      '形の質1',
      '打点0',
      '守備1',
      'その他0',
    ]);
    await user.click(screen.getByRole('menuitemcheckbox', { name: /^形の質/ }));
    await user.keyboard('{Escape}');
    expect(rowButtons().map((row) => row.getAttribute('data-problem'))).toEqual([`${FX4_ID}/${keyOf(B)}`]);
    expect(filterButton(/^原因/)).toHaveTextContent('形の質');
    // 種類: 鳴き → 形の質の行（打牌）は外れ、0 行
    await user.click(filterButton(/^種類/));
    expect(within(screen.getByRole('menu', { name: '種類' })).getAllByRole('menuitemcheckbox').map((item) => text(item))).toEqual([
      '打牌1',
      '鳴き0',
      'リーチ0',
      '和了0',
      'カン0',
    ]);
    await user.click(screen.getByRole('menuitemcheckbox', { name: /^鳴き/ }));
    await user.keyboard('{Escape}');
    expect(rowButtons()).toHaveLength(0);
    expect(summary()).toBe('0問');
    // 空の形（絞り込みを解除）から戻す。期間も「すべて」になる
    await user.click(screen.getByRole('button', { name: '絞り込みを解除' }));
    expect(rowButtons()).toHaveLength(6);
    expect(filterButton(/^期間/)).toHaveTextContent('すべて');
    expect(screen.queryByRole('button', { name: '解除' })).toBeNull();
    // 局面: 鳴き（鳴きの判断）
    await user.click(filterButton(/^局面/));
    expect(within(screen.getByRole('menu', { name: '局面' })).getAllByRole('menuitemcheckbox').map((item) => text(item).replace(/\d+$/, ''))).toEqual([
      '2向聴以上',
      '1向聴',
      '聴牌',
      '鳴き',
      '押し引き',
      '序盤',
    ]);
    await user.click(screen.getByRole('menuitemcheckbox', { name: /^鳴き/ }));
    await user.keyboard('{Escape}');
    expect(rowButtons().map((row) => row.getAttribute('data-problem'))).toEqual([`${FX4_ID}/${keyOf(CALL)}`]);
    // 「解除」は、かかっている間だけ出る。押すと、種類・局面・原因・結果が外れる（期間は、そのまま）
    await user.click(screen.getByRole('button', { name: '解除' }));
    expect(rowButtons()).toHaveLength(6);
    expect(filterButton(/^局面/)).toHaveTextContent('すべて');
    expect(filterButton(/^期間/)).toHaveTextContent('すべて');
    expect(screen.queryByRole('button', { name: '解除' })).toBeNull();
  });

  it('期間: 今週・先週・30日・すべて（月曜から）。メニューに、期間ごとの問題の数を出す', async () => {
    const { user } = setup();
    await openLog(user);
    await user.click(filterButton(/^期間/));
    const menu = screen.getByRole('menu', { name: '期間' });
    const items = within(menu).getAllByRole('menuitemradio');
    expect(items.map((item) => text(item))).toEqual(['今週4問', '先週2問', '30日6問', 'すべて6問']);
    expect(items[0]).toHaveAttribute('aria-checked', 'true');
    await user.click(items[1] as HTMLElement);
    // 選ぶと閉じる（期間は 1 つ）。先週の 2 問
    expect(screen.queryByRole('menu')).toBeNull();
    expect(filterButton(/^期間/)).toHaveTextContent('先週');
    expect(rowButtons().map((row) => text(row.querySelector('.l-date')))).toEqual(['10月2日', '10月1日']);
    expect(summary()).toBe('2問・正解 50%・答えるまで 平均 0:38・選び直しあり 0問・MAKA と食い違い 0問');
    await user.click(filterButton(/^期間/));
    await user.click(screen.getByRole('menuitemradio', { name: /^すべて/ }));
    expect(rowButtons()).toHaveLength(6);
  });
});

describe('U-29 行を開く・空の形', () => {
  it('行を押す（Enter でも）と、その問題が、保存した答えで開く（答え合わせのあとの形）', async () => {
    const { user } = setup();
    await openLog(user);
    // キーボードで: 最初の行に移って Enter
    (rowButtons()[0] as HTMLElement).focus();
    await user.keyboard('{Enter}');
    await screen.findByRole('heading', { level: 1, name: `${A.kyokuLabel} ${A.junme}巡目` });
    // 保存した理由が出て、答えは変えられない（答える前の欄は無い）。理由は、前の答え（id 2）ではなく最後の答え（id 1）
    expect(await screen.findByText('守備を考えて、切りたかった')).toBeInTheDocument();
    expect(screen.queryByText('前の答え')).toBeNull();
    expect(screen.queryByLabelText('理由（1行）')).toBeNull();
  });

  it('解き直しで答えた問題の行は、解き直しの答えで開く（前の出題の答えではない）', async () => {
    const { user } = setup();
    await openLog(user);
    await user.click(rowButtons()[1] as HTMLElement);
    await screen.findByRole('heading', { level: 1, name: `${C.kyokuLabel} ${C.junme}巡目` });
    expect(await screen.findByText('解き直しの答え')).toBeInTheDocument();
    expect(document.querySelector('[data-ai="verdict"]')).not.toBeNull();
    expect(document.querySelector('.kicker')?.textContent).toBe('解き直し');
  });

  it('戻る（Alt+←）でログに戻り、← → のボタンでも行き来できる', async () => {
    const { user } = setup();
    await openLog(user);
    await user.click(rowButtons()[2] as HTMLElement);
    await screen.findByRole('heading', { level: 1, name: `${B.kyokuLabel} ${B.junme}巡目` });
    const history = screen.getByRole('group', { name: '画面の履歴' });
    await user.click(within(history).getByRole('button', { name: '戻る' }));
    await screen.findByRole('heading', { level: 1, name: 'ログ' });
    expect(rowButtons()).toHaveLength(4);
    await user.keyboard('{Alt>}{ArrowRight}{/Alt}');
    await screen.findByRole('heading', { level: 1, name: `${B.kyokuLabel} ${B.junme}巡目` });
  });

  it('答えた問題が 1 つも無いときは、ログの空の形（絞り込みの欄も、答えを出すの欄も出さない）', async () => {
    const { user } = setup({ study: new FakeStudyStore([]) });
    await openLog2(user);
    expect(screen.getByText(/答えた問題がまだありません/)).toBeInTheDocument();
    expect(screen.queryByRole('group', { name: '絞り込み' })).toBeNull();
    expect(screen.queryByRole('checkbox', { name: '答えを出す' })).toBeNull();
    expect(screen.queryByRole('list', { name: '答えた問題' })).toBeNull();
  });

  it('条件に合う問題が無いときは、その旨と「絞り込みを解除」（期間も「すべて」に戻る）', async () => {
    // 答えは、先週のものだけ。既定の「今週」では 0 件
    const study = new FakeStudyStore(answers().filter((row) => row.answered_at < local(2026, 10, 5)));
    const { user } = setup({ study });
    await openLog2(user);
    expect(screen.getByText('この条件に合う問題はありません。')).toBeInTheDocument();
    expect(summary()).toBe('0問');
    expect(screen.queryByRole('list', { name: '答えた問題' })).toBeNull();
    await user.click(screen.getByRole('button', { name: '絞り込みを解除' }));
    expect(rowButtons()).toHaveLength(2);
    expect(filterButton(/^期間/)).toHaveTextContent('すべて');
    expect(screen.queryByText('この条件に合う問題はありません。')).toBeNull();
  });

  it('D-3: 半荘を消すと、その半荘の問題はログから消える。元に戻す（Ctrl+Z）と、また出る', async () => {
    const { user } = setup();
    await openLog(user);
    expect(rowButtons().map((row) => row.getAttribute('data-problem')?.split('/')[0])).toContain(FX1A_ID);
    const listNav = screen.getByRole('navigation', { name: '半荘の一覧' });
    // 17:12（f9da）の半荘を消す
    const rows = within(listNav).getAllByRole('button', { name: /^\d\d:\d\d/ });
    const f9da = rows.find((row) => /17:12/.test(row.textContent ?? '')) as HTMLElement;
    await user.click(within(f9da.closest('li') as HTMLElement).getByRole('button', { name: /のメニュー/ }));
    await user.click(within(screen.getByRole('menu')).getByRole('menuitem', { name: '削除' }));
    await user.click(within(screen.getByRole('alertdialog')).getByRole('button', { name: '削除' }));
    await waitFor(() => expect(within(listNav).getAllByRole('button', { name: /^\d\d:\d\d/ })).toHaveLength(1));
    await waitFor(() => expect(rowButtons()).toHaveLength(3));
    expect(rowButtons().every((row) => row.getAttribute('data-problem')?.startsWith(FX4_ID))).toBe(true);
    await user.keyboard('{Control>}z{/Control}');
    await waitFor(() => expect(rowButtons()).toHaveLength(4), LOAD);
  });
});

/** 空の形のとき（行が 0）の、開き方。 */
async function openLog2(user: User) {
  await screen.findByRole('navigation', { name: '半荘の一覧' });
  await waitFor(() => expect(sideCount()).not.toBeNull(), LOAD);
  await user.click(navButton(/^ログ/));
  await screen.findByRole('heading', { level: 1, name: 'ログ' });
}
