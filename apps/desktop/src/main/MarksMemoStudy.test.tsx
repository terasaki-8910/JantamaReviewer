/**
 * 終局直後のメモ（F4、U-28）が、答える画面に出る所の画面の試験:
 * - 出題・解き直しの答え合わせのあと、自分の答えの下に「終局直後のメモ」が出る。答える前は DOM に無い（U-1）
 * - 半荘を通して見る画面の迷いの場面では、答える前にメモを書ける・直せる（迷いのカードと同じ保存先）。答えたあとは、書き換えられず、自分の答えの下に出る
 * 半荘のページの列・メモの欄・追加のメモは、MarksMemo.test.tsx。
 */
import { invoke } from '@tauri-apps/api/core';
import { act, cleanup, render, screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { FakeSessionStore, local, seedSession } from '../../tests/fake-sessions';
import { FakeStudyStore, answerRow } from '../../tests/fake-study';
import { fx4Ocr, fx4Session } from '../../tests/import-fixtures';
import { renderQuiz } from '../../tests/study-harness';
import { baseSettings, installTauriMock } from '../../tests/tauri-mock';
import { revealed } from '../../tests/reveal';
import type { Links, Memos, SessionRecord, Settings } from '../api/types';
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
});

afterEach(() => {
  cleanup();
  vi.useRealTimers();
});

const LOAD = { timeout: 20_000 };

// ---- 出題・解き直しの答え合わせのあと ----

/** FX-1a の東4局 13巡目（k3h0e15）に、迷い 1（保存した選び）と迷い 2（結びつけ無し）がある半荘。 */
function quizSession(memos: Memos, links: Links = { marks: { '1': 'k3h0e15' }, ratings: {} }): SessionRecord {
  const { session } = seedSession(local(2026, 10, 9, 17, 12), { id: 'sess', marks: 2, report: 'fx1a' });
  return { ...session, links, memos };
}

const MEMO: Memos = { marks: { '1': { candidates: '南・6m', reason: '東を残して形を整えたい' } }, extras: [] };

const handButtons = () => screen.getAllByRole('button', { name: /を切る$/ });
const drawn = () => screen.getByRole('button', { name: '一索（ツモ牌）を切る' });
const submit = () => screen.getByRole('button', { name: '答え合わせ' });
const memoBlock = () => document.querySelector('[data-memo="shown"]');

async function answer(user: ReturnType<typeof renderQuiz>['user']) {
  await user.click(drawn());
  await user.type(screen.getByLabelText('理由（1行）'), '受け入れを広く');
  await user.click(submit());
  await revealed();
}

describe('U-28 答え合わせのあとの「終局直後のメモ」（出題）', () => {
  it('答える前は、メモの見出しも文も、DOM に無い。メモを書く欄も出ない', () => {
    renderQuiz({ session: quizSession(MEMO) });
    expect(screen.getByLabelText('理由（1行）')).toBeInTheDocument();
    expect(memoBlock()).toBeNull();
    expect(screen.queryByRole('heading', { name: '終局直後のメモ' })).toBeNull();
    expect(document.body.textContent).not.toContain('南・6m');
    expect(document.body.textContent).not.toContain('東を残して形を整えたい');
    expect(screen.queryByLabelText('候補')).toBeNull();
    // 選んだだけ・理由を書いただけの途中でも、出ない
    expect(document.querySelector('[data-memo]')).toBeNull();
  });

  it('答え合わせのあと、自分の答えの下・受け入れ枚数の上に出る。「候補」と「理由」の文だけで、書き換える欄は無い', async () => {
    const { user } = renderQuiz({ session: quizSession(MEMO) });
    await user.click(drawn());
    await user.type(screen.getByLabelText('理由（1行）'), '受け入れを広く');
    expect(memoBlock()).toBeNull();
    await user.click(submit());
    await revealed();
    const block = memoBlock() as HTMLElement;
    expect(block).not.toBeNull();
    expect(within(block).getByRole('heading', { level: 2, name: '終局直後のメモ' })).toBeInTheDocument();
    expect([...block.querySelectorAll('dt')].map((dt) => dt.textContent)).toEqual(['候補', '理由']);
    expect([...block.querySelectorAll('dd')].map((dd) => dd.textContent)).toEqual(['南・6m', '東を残して形を整えたい']);
    expect(block.querySelector('input, textarea, button')).toBeNull();
    expect(block.hasAttribute('data-ai')).toBe(false);
    // 順番: 自分の答え → 終局直後のメモ → 受け入れ枚数（打牌の判断の AI の評価は、手牌の上の棒。右の欄に一覧は無い）
    const mine = screen.getByRole('heading', { level: 2, name: '自分の答え' });
    const next = screen.getByRole('heading', { name: '受け入れ枚数' });
    expect(mine.compareDocumentPosition(block) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy();
    expect(block.compareDocumentPosition(next) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy();
    expect(screen.queryByRole('heading', { name: 'AIの評価（Mortal）' })).toBeNull();
  });

  it('その問題に結びつく迷いのメモだけを出す。ほかの迷いのメモ・結びついていない迷いのメモは出ない', async () => {
    const memos: Memos = {
      marks: { '1': { candidates: 'この問題', reason: '' }, '2': { candidates: 'ほかの迷い', reason: '' } },
      extras: [{ id: 'x1', decision: 'k0h0e1', candidates: 'ほかの判断', reason: '' }],
    };
    const { user } = renderQuiz({ session: quizSession(memos) });
    await answer(user);
    expect([...(memoBlock() as HTMLElement).querySelectorAll('dd')].map((dd) => dd.textContent)).toEqual(['この問題']);
    expect(document.body.textContent).not.toContain('ほかの迷い');
    expect(document.body.textContent).not.toContain('ほかの判断');
  });

  it('迷いマークの無い迷いのメモ（その判断の鍵）も出す。メモが 2 つ以上あるときは、「迷い1」「追加のメモ」の名前を付ける', async () => {
    const memos: Memos = {
      marks: { '1': { candidates: 'a', reason: '' } },
      extras: [{ id: 'x1', decision: 'k3h0e15', candidates: '', reason: '押すか引くか' }],
    };
    const { user } = renderQuiz({ session: quizSession(memos) });
    await answer(user);
    const block = memoBlock() as HTMLElement;
    expect([...block.querySelectorAll('.memo-from')].map((p) => p.textContent)).toEqual(['迷い1', '追加のメモ']);
    expect([...block.querySelectorAll('dt')].map((dt) => dt.textContent)).toEqual(['候補', '理由']);
    expect([...block.querySelectorAll('dd')].map((dd) => dd.textContent)).toEqual(['a', '押すか引くか']);
  });

  const extraWrites = () => vi.mocked(invoke).mock.calls.filter(([command]) => String(command).includes('extra_memo'));
  const ddTexts = () => [...(memoBlock() as HTMLElement).querySelectorAll('dd')].map((dd) => dd.textContent);

  it('位置だけの追加のメモ（判断の鍵がまだ無い）は、半荘のページを開かなくても、位置（東4局 13巡目）に自分の判断がちょうど 1 つ（打3m）なら、その問題の答え合わせのあとに出る（出題・解き直し）。答える前は出ず、何も保存しない', async () => {
    const only: Memos = { marks: {}, extras: [{ id: 'x1', position: { kyoku: 3, honba: 0, junme: 13 }, candidates: '位置から', reason: '押す' }] };
    vi.mocked(invoke).mockClear();
    const first = renderQuiz({ session: quizSession(only) });
    expect(memoBlock()).toBeNull();
    expect(document.body.textContent).not.toContain('位置から');
    await answer(first.user);
    expect(ddTexts()).toEqual(['位置から', '押す']);
    cleanup();
    const review = renderQuiz({ mode: 'review', previousIntervalDays: 1, session: quizSession(only) });
    expect(memoBlock()).toBeNull();
    await answer(review.user);
    expect(ddTexts()).toEqual(['位置から', '押す']);
    // 出すだけで、保存はしない（結びつけは、半荘のページを開いたときにする）
    expect(extraWrites()).toEqual([]);
  });

  it('位置の判断が 2 つ以上（東4局 7巡目 = 打南・鳴かない判断）の位置だけのメモ・位置に判断が無い（同じ局の別の巡目）メモ・ほかの位置のメモは、この問題の答え合わせのあとにも出ない', async () => {
    const memos: Memos = {
      marks: {},
      extras: [
        { id: 'x1', position: { kyoku: 3, honba: 0, junme: 7 }, candidates: '2つある', reason: '' },
        { id: 'x2', position: { kyoku: 3, honba: 0, junme: 25 }, candidates: '巡目が無い', reason: '' },
        { id: 'x3', position: { kyoku: 3, honba: 0, junme: 12 }, candidates: 'ほかの巡目', reason: '' },
        { id: 'x4', position: { kyoku: 3, honba: 1, junme: 13 }, candidates: 'ほかの本場', reason: '' },
      ],
    };
    vi.mocked(invoke).mockClear();
    const { user } = renderQuiz({ session: quizSession(memos) });
    await answer(user);
    expect(memoBlock()).toBeNull();
    expect(screen.queryByRole('heading', { name: '終局直後のメモ' })).toBeNull();
    for (const text of ['2つある', '巡目が無い', 'ほかの巡目', 'ほかの本場']) expect(document.body.textContent).not.toContain(text);
    expect(extraWrites()).toEqual([]);
    cleanup();
    // 判断が 2 つの位置の問題（東4局 7巡目の打南 = k3h0e6。答えた形で開く）にも、選ばれるまで出ない
    const existing = answerRow({ id: 3, session_id: 'sess', decision_key: 'k3h0e6', choice: { type: 'dahai', tile: 'S' }, reason: '前に書いた理由' });
    renderQuiz({ existing, key: 'k3h0e6', session: quizSession(memos) });
    expect(document.querySelector('.qz')?.getAttribute('data-state')).toBe('revealed');
    expect(memoBlock()).toBeNull();
    expect(document.body.textContent).not.toContain('2つある');
  });

  it('判断の鍵が付いたメモは、位置が残っていても、鍵に従って出る。位置だけのメモと鍵つきのメモは、足した順に並ぶ', async () => {
    const position = { kyoku: 3, honba: 0, junme: 13 };
    const linked: Memos = { marks: {}, extras: [{ id: 'x1', decision: 'k3h0e15', position, candidates: '鍵あり', reason: '押す' }] };
    const first = renderQuiz({ session: quizSession(linked) });
    await answer(first.user);
    expect(ddTexts()).toEqual(['鍵あり', '押す']);
    cleanup();
    // 位置は 13巡目でも、鍵が別の判断（k3h0e14）なら、この問題には出ない
    const elsewhere: Memos = { marks: {}, extras: [{ id: 'x1', decision: 'k3h0e14', position, candidates: '別の判断', reason: '' }] };
    const second = renderQuiz({ session: quizSession(elsewhere) });
    await answer(second.user);
    expect(memoBlock()).toBeNull();
    cleanup();
    const mixed: Memos = {
      marks: {},
      extras: [
        { id: 'x1', decision: 'k3h0e15', candidates: '先', reason: '' },
        { id: 'x2', position, candidates: '後', reason: '' },
      ],
    };
    const third = renderQuiz({ session: quizSession(mixed) });
    await answer(third.user);
    expect(ddTexts()).toEqual(['先', '後']);
  });

  it('メモが 1 つだけのとき、名前は付けない。メモの無い問題には、見出しも出ない', async () => {
    const { user } = renderQuiz({ session: quizSession(MEMO) });
    await answer(user);
    expect((memoBlock() as HTMLElement).querySelector('.memo-from')).toBeNull();
    cleanup();
    const none = renderQuiz({ session: quizSession({ marks: {}, extras: [] }) });
    await answer(none.user);
    expect(memoBlock()).toBeNull();
    expect(screen.queryByRole('heading', { name: '終局直後のメモ' })).toBeNull();
  });

  it('保存してある答えから、答え合わせのあとの形で開いたときも、メモが出る', () => {
    const existing = answerRow({ id: 3, session_id: 'sess', decision_key: 'k3h0e15', choice: { type: 'dahai', tile: '1s' }, reason: '前に書いた理由' });
    renderQuiz({ existing, session: quizSession(MEMO) });
    expect(document.querySelector('.qz')?.getAttribute('data-state')).toBe('revealed');
    expect([...(memoBlock() as HTMLElement).querySelectorAll('dd')].map((dd) => dd.textContent)).toEqual(['南・6m', '東を残して形を整えたい']);
  });

  it('結びつけが無い迷い（読み取りも保存した選びも無い）のメモは、どの問題にも出ない', async () => {
    const { user } = renderQuiz({ session: quizSession(MEMO, { marks: {}, ratings: {} }) });
    await answer(user);
    expect(memoBlock()).toBeNull();
  });
});

describe('U-28 答え合わせのあとの「終局直後のメモ」（解き直し）', () => {
  it('解き直しでも、答える前は DOM に無く、答え合わせのあとの自分の答えの下に出る', async () => {
    const { user } = renderQuiz({ mode: 'review', previousIntervalDays: 1, session: quizSession(MEMO) });
    expect(memoBlock()).toBeNull();
    expect(document.body.textContent).not.toContain('南・6m');
    await answer(user);
    expect([...(memoBlock() as HTMLElement).querySelectorAll('dd')].map((dd) => dd.textContent)).toEqual(['南・6m', '東を残して形を整えたい']);
    expect(handButtons().length).toBeGreaterThan(0);
  });
});

// ---- 半荘を通して見る画面 ----

const FX4_ID = '20261009-190953';
const FX1A_ID = '20261009-171200';
/** ユーザーが選び直した迷いの結びつけ。迷い 3 は、東2局1本場 6巡目（k1h1e7）の打牌の判断。迷い 4 は、同 8巡目の東をポンする判断。 */
const USER_LINKS: Links = {
  ratings: {},
  marks: { '1': 'k0h0e4', '2': 'k1h0e12', '3': 'k1h1e7', '4': 'k1h1e10', '5': 'k2h1e6', '6': 'k2h1e14' },
};

function replaySetup(
  memos: Memos = { marks: {}, extras: [] },
  overrides: Record<string, (args: unknown) => unknown> = {},
  settings: Partial<Settings> = {},
) {
  const fx4 = {
    session: fx4Session(FX4_ID, local(2026, 10, 9, 19, 9), {
      report_path: `C:\\data\\games\\${FX4_ID}\\report.json`,
      ocr: fx4Ocr(),
      links: USER_LINKS,
      memos,
    }),
    report: 'fx4' as const,
  };
  const sessions = new FakeSessionStore([fx4, seedSession(local(2026, 10, 9, 17, 12), { id: FX1A_ID, report: 'fx1a' })]);
  const study = new FakeStudyStore();
  const mock = installTauriMock({
    settings: { ...baseSettings, ...settings },
    handlers: { ...sessions.handlers, ...study.handlers, ...overrides },
  });
  const user = userEvent.setup();
  render(<App />);
  return { user, mock, sessions, study };
}

const sideCount = (name: RegExp) =>
  within(screen.getByRole('navigation', { name: 'メイン' })).getByRole('button', { name }).querySelector('.count')?.textContent ?? null;

async function loaded() {
  await screen.findByRole('navigation', { name: '半荘の一覧' });
  await waitFor(() => expect(sideCount(/^今日の出題/)).toBe('5'), LOAD);
}

/** 迷いのカードの「この局面を解く」で、通して見る画面をその場面で開く。 */
async function openScene(user: ReturnType<typeof userEvent.setup>, number: number) {
  await user.click(await screen.findByRole('button', { name: `この局面を解く（迷い${number}）` }));
  await screen.findByLabelText('理由（1行）');
}

const memoEditor = () => document.querySelector('[data-memo="editor"]') as HTMLElement | null;

describe('U-28 半荘を通して見る画面の迷いの場面（FX-4 の迷い 3）', () => {
  it('答える前に、その迷いのメモの欄がある（候補・理由）。迷いのカードに書いたメモが入っている。AI の情報は出ない', async () => {
    const { user } = replaySetup({ marks: { '3': { candidates: '南・6m', reason: '東を残したい' } }, extras: [] });
    await loaded();
    await openScene(user, 3);
    const editor = memoEditor() as HTMLElement;
    expect(editor).not.toBeNull();
    expect(within(editor).getByRole('heading', { level: 2, name: '終局直後のメモ' })).toBeInTheDocument();
    const group = within(editor).getByRole('group', { name: '迷い3のメモ' });
    expect(within(group).getByLabelText('候補')).toHaveValue('南・6m');
    // 答えの欄の「理由（1行）」と名前が重ならないよう、メモのほうは「理由」
    expect(within(group).getByLabelText('理由')).toHaveValue('東を残したい');
    expect(screen.getAllByLabelText('理由（1行）')).toHaveLength(1);
    expect(document.querySelector('[data-ai]')).toBeNull();
    expect(document.body.textContent).not.toMatch(/\d\s*%|Mortal|AIの評価/);
  });

  it('書いて欄の外へ出ると、迷いのカードと同じ保存先（記録の番号）に保存する。取り込んだ半荘のページに戻ると、カードに入っている', async () => {
    const { user, sessions } = replaySetup();
    await loaded();
    await openScene(user, 3);
    const group = within(memoEditor() as HTMLElement).getByRole('group', { name: '迷い3のメモ' });
    await user.type(within(group).getByLabelText('候補'), '3m・6p');
    await user.type(within(group).getByLabelText('理由'), '速さ{Enter}');
    await waitFor(() => expect(sessions.session(FX4_ID).memos.marks['3']).toEqual({ candidates: '3m・6p', reason: '速さ' }));
    // 答える欄には、何も入らない
    expect(screen.getByLabelText('理由（1行）')).toHaveValue('');
    // 迷いのカードに戻る（サイドバーの半荘の行）と、同じメモが入っている
    await user.click(document.querySelector(`[data-open="${FX4_ID}"]`) as HTMLElement);
    const card = await screen.findByRole('article', { name: '迷い3' });
    expect(within(card).getByLabelText('候補')).toHaveValue('3m・6p');
    expect(within(card).getByLabelText('理由（1行）')).toHaveValue('速さ');
  });

  it('答えると、メモは書き換えられなくなり、自分の答えの下に読むだけで出る。受け入れ枚数は、そのあとに出る（AI の評価は、手牌の上の棒）', async () => {
    const { user } = replaySetup({ marks: { '3': { candidates: '南・6m', reason: '東を残したい' } }, extras: [] });
    await loaded();
    await openScene(user, 3);
    expect(memoEditor()).not.toBeNull();
    await user.click(screen.getAllByRole('button', { name: /を切る$/ })[5] as HTMLElement);
    await user.type(screen.getByLabelText('理由（1行）'), '形を崩さないほうを残す');
    await user.click(screen.getByRole('button', { name: '答え合わせ' }));
    await revealed();
    // 書く欄は消え、読むだけの欄に替わる
    expect(memoEditor()).toBeNull();
    expect(screen.queryByLabelText('候補')).toBeNull();
    const block = document.querySelector('[data-memo="shown"]') as HTMLElement;
    expect([...block.querySelectorAll('dd')].map((dd) => dd.textContent)).toEqual(['南・6m', '東を残したい']);
    expect(block.querySelector('input, textarea')).toBeNull();
    const mine = screen.getByRole('heading', { level: 2, name: '自分の答え' });
    const next = screen.getByRole('heading', { name: '受け入れ枚数' });
    expect(mine.compareDocumentPosition(block) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy();
    expect(block.compareDocumentPosition(next) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy();
  });

  it('答える直前に書いたメモも、答えたあとに出る（欄の外へ出る前に答え合わせを押しても、落とさない）', async () => {
    const { user, sessions } = replaySetup();
    await loaded();
    await openScene(user, 3);
    const group = within(memoEditor() as HTMLElement).getByRole('group', { name: '迷い3のメモ' });
    await user.type(within(group).getByLabelText('候補'), '打3m');
    await user.click(screen.getAllByRole('button', { name: /を切る$/ })[5] as HTMLElement);
    await user.type(screen.getByLabelText('理由（1行）'), '形を崩さない');
    await user.click(screen.getByRole('button', { name: '答え合わせ' }));
    await revealed();
    await waitFor(() => expect(sessions.session(FX4_ID).memos.marks['3']).toEqual({ candidates: '打3m', reason: '' }));
    await waitFor(() => {
      const block = document.querySelector('[data-memo="shown"]') as HTMLElement | null;
      expect(block?.querySelector('dd')?.textContent).toBe('打3m');
    });
  });

  it('メモを書いていない迷いの場面は、答えたあとも、メモの見出しは出ない', async () => {
    const { user } = replaySetup();
    await loaded();
    await openScene(user, 3);
    await user.click(screen.getAllByRole('button', { name: /を切る$/ })[5] as HTMLElement);
    await user.type(screen.getByLabelText('理由（1行）'), '形を崩さない');
    await user.click(screen.getByRole('button', { name: '答え合わせ' }));
    await revealed();
    expect(document.querySelector('[data-memo]')).toBeNull();
  });

  it('位置だけの追加のメモ（東2局1本場 6巡目）は、半荘のページが、その位置の判断（迷い 3 の場面）に結びつけたあと、答え合わせのあとに出る。答える前は出ない', async () => {
    const memos: Memos = { marks: {}, extras: [{ id: 'x1', position: { kyoku: 1, honba: 1, junme: 6 }, candidates: '位置から', reason: '速さ' }] };
    const { user, sessions } = replaySetup(memos);
    await loaded();
    // 半荘のページを開いたとき、位置に判断が 1 つ（打南）なので、判断の鍵が付く
    await waitFor(() => expect(sessions.session(FX4_ID).memos.extras[0]?.decision).toBe('k1h1e7'), LOAD);
    await openScene(user, 3);
    expect(document.body.textContent).not.toContain('位置から');
    await user.click(screen.getAllByRole('button', { name: /を切る$/ })[5] as HTMLElement);
    await user.type(screen.getByLabelText('理由（1行）'), '形を崩さない');
    await user.click(screen.getByRole('button', { name: '答え合わせ' }));
    await revealed();
    const block = document.querySelector('[data-memo="shown"]') as HTMLElement;
    expect([...block.querySelectorAll('dd')].map((dd) => dd.textContent)).toEqual(['位置から', '速さ']);
  });

  it('結びつけを保存できないときも（半荘のページの結びつけが失敗しても）、位置だけのメモは、位置の判断が 1 つなら、答え合わせのあとに出る。位置の判断が 2 つのメモは、出ない。保存はしない', async () => {
    const memos: Memos = {
      marks: {},
      extras: [
        { id: 'x1', position: { kyoku: 1, honba: 1, junme: 6 }, candidates: '位置から', reason: '速さ' },
        { id: 'x2', position: { kyoku: 1, honba: 1, junme: 4 }, candidates: '2つある', reason: '' },
      ],
    };
    const writes: unknown[] = [];
    const { user, sessions } = replaySetup(memos, {
      set_extra_memo: (args) => {
        writes.push(args);
        throw '保存できません';
      },
    });
    await loaded();
    await openScene(user, 3);
    // 保存は失敗した（試みた）が、保存先は位置だけのまま
    await waitFor(() => expect(writes.length).toBeGreaterThan(0), LOAD);
    expect(sessions.session(FX4_ID).memos.extras.every((e) => e.decision === undefined)).toBe(true);
    await user.click(screen.getAllByRole('button', { name: /を切る$/ })[5] as HTMLElement);
    await user.type(screen.getByLabelText('理由（1行）'), '形を崩さない');
    await user.click(screen.getByRole('button', { name: '答え合わせ' }));
    await revealed();
    const block = document.querySelector('[data-memo="shown"]') as HTMLElement;
    expect([...block.querySelectorAll('dd')].map((dd) => dd.textContent)).toEqual(['位置から', '速さ']);
    expect(document.body.textContent).not.toContain('2つある');
  });

  it('迷いではない場面（不一致だけの場面）には、メモの欄は出ない', async () => {
    const { user } = replaySetup();
    await loaded();
    await user.click(await screen.findByRole('button', { name: 'この半荘を通して見る' }));
    await screen.findByRole('region', { name: '半荘を進める' });
    // 不一致だけの場面（迷いの結びつけが無い判断）
    await user.click(document.querySelector('.pin[data-key="k1h1e6"]') as HTMLElement);
    await screen.findByLabelText('理由（1行）');
    expect(document.querySelector('.q-chips .is-doubt')).toBeNull();
    expect(memoEditor()).toBeNull();
    expect(screen.queryByLabelText('候補')).toBeNull();
  });

  it('迷いが 2 つ結びついた場面は、迷いごとにメモの欄が並ぶ', async () => {
    // 迷い 4 も、迷い 3 と同じ判断（k1h1e7）にした半荘
    const links: Links = { ...USER_LINKS, marks: { ...USER_LINKS.marks, '4': 'k1h1e7' } };
    const fx4 = fx4Session(FX4_ID, local(2026, 10, 9, 19, 9), {
      report_path: `C:\\data\\games\\${FX4_ID}\\report.json`,
      ocr: fx4Ocr(),
      links,
    });
    const sessions = new FakeSessionStore([{ session: fx4, report: 'fx4' }]);
    const study = new FakeStudyStore();
    installTauriMock({ handlers: { ...sessions.handlers, ...study.handlers } });
    const user = userEvent.setup();
    render(<App />);
    await screen.findByRole('navigation', { name: '半荘の一覧' });
    await waitFor(() => expect(sideCount(/^今日の出題/)).not.toBeNull(), LOAD);
    await openScene(user, 3);
    const groups = within(memoEditor() as HTMLElement).getAllByRole('group');
    expect(groups.map((g) => g.getAttribute('aria-label'))).toEqual(['迷い3のメモ', '迷い4のメモ']);
    // 保存の鍵は、それぞれの迷いの番号
    await user.type(within(groups[1] as HTMLElement).getByLabelText('候補'), '東をポン{Enter}');
    await waitFor(() => expect(sessions.session(FX4_ID).memos.marks['4']).toEqual({ candidates: '東をポン', reason: '' }));
    expect(sessions.session(FX4_ID).memos.marks['3']).toBeUndefined();
  });

  it('U-11: 場面で書いたメモも、欄の外では Ctrl+Z で取り消せる（欄の中では、欄の取り消し）', async () => {
    const { user, sessions } = replaySetup();
    await loaded();
    await openScene(user, 3);
    const group = within(memoEditor() as HTMLElement).getByRole('group', { name: '迷い3のメモ' });
    await user.type(within(group).getByLabelText('候補'), '打3m{Enter}');
    await waitFor(() => expect(sessions.session(FX4_ID).memos.marks['3']?.candidates).toBe('打3m'));
    // 場面の画面のキーは、Ctrl+Z を何にも使わない。欄の外で押すと、メモの入力が戻る
    (document.activeElement as HTMLElement | null)?.blur();
    await act(async () => {
      document.body.dispatchEvent(new KeyboardEvent('keydown', { key: 'z', code: 'KeyZ', ctrlKey: true, bubbles: true, cancelable: true }));
    });
    await waitFor(() => expect(sessions.session(FX4_ID).memos.marks['3']).toBeUndefined());
    await waitFor(() => expect(within(group).getByLabelText('候補')).toHaveValue(''));
  });
});

// ---- 迷いだけを記録する設定が入のとき（F0、U-46）----

describe('U-46 迷いだけの画面: 通して見る画面の迷いの場面と、答え合わせのあとのメモ', () => {
  const MEMO3: Memos = { marks: { '3': { candidates: '南・6m', reason: '東を残したい' } }, extras: [] };

  /** 迷い 3 の場面で、打牌を 1 つ選んで答え合わせまで進める。 */
  async function answerScene(user: ReturnType<typeof userEvent.setup>) {
    await user.click(screen.getAllByRole('button', { name: /を切る$/ })[5] as HTMLElement);
    await user.type(screen.getByLabelText('理由（1行）'), '形を崩さない');
    await user.click(screen.getByRole('button', { name: '答え合わせ' }));
    await revealed();
  }

  it('迷いの場面に、答える前のメモの欄（候補・理由）が無い。書いてあるメモの文字も出ない。場面そのものは、答えられる', async () => {
    const { user } = replaySetup(MEMO3, {}, { doubt_only: true });
    await loaded();
    await openScene(user, 3);
    expect(memoEditor()).toBeNull();
    expect(screen.queryByRole('group', { name: '迷い3のメモ' })).toBeNull();
    expect(screen.queryByLabelText('候補')).toBeNull();
    expect(screen.queryByRole('heading', { level: 2, name: '終局直後のメモ' })).toBeNull();
    // 答えの欄の「理由（1行）」は 1 つだけ
    expect(screen.getAllByLabelText('理由（1行）')).toHaveLength(1);
    expect(document.body.textContent).not.toContain('東を残したい');
    expect(document.querySelector('[data-memo]')).toBeNull();
    // 場面は迷いの場面のまま（答えて、答え合わせを押せる）
    expect(document.querySelector('.q-chips .is-doubt')).not.toBeNull();
    expect(screen.getByRole('button', { name: '答え合わせ' })).toBeInTheDocument();
  });

  it('迷いが 2 つ結びついた場面でも、メモの欄は並ばない', async () => {
    const links: Links = { ...USER_LINKS, marks: { ...USER_LINKS.marks, '4': 'k1h1e7' } };
    const fx4 = fx4Session(FX4_ID, local(2026, 10, 9, 19, 9), {
      report_path: `C:\\data\\games\\${FX4_ID}\\report.json`,
      ocr: fx4Ocr(),
      links,
    });
    const sessions = new FakeSessionStore([{ session: fx4, report: 'fx4' }]);
    installTauriMock({
      settings: { ...baseSettings, doubt_only: true },
      handlers: { ...sessions.handlers, ...new FakeStudyStore().handlers },
    });
    const user = userEvent.setup();
    render(<App />);
    await screen.findByRole('navigation', { name: '半荘の一覧' });
    await waitFor(() => expect(sideCount(/^今日の出題/)).not.toBeNull(), LOAD);
    await openScene(user, 3);
    expect(memoEditor()).toBeNull();
    expect(screen.queryAllByRole('group', { name: /^迷い\d+のメモ$/ })).toHaveLength(0);
  });

  it('答えると、書いてあるメモは、自分の答えの下に読むだけで出る（答え合わせのあとのメモは、設定にかかわらず、書いてあれば出す）', async () => {
    const { user } = replaySetup(MEMO3, {}, { doubt_only: true });
    await loaded();
    await openScene(user, 3);
    expect(document.querySelector('[data-memo]')).toBeNull();
    await answerScene(user);
    const block = document.querySelector('[data-memo="shown"]') as HTMLElement;
    expect(within(block).getByRole('heading', { level: 2, name: '終局直後のメモ' })).toBeInTheDocument();
    expect([...block.querySelectorAll('dd')].map((dd) => dd.textContent)).toEqual(['南・6m', '東を残したい']);
    expect(block.querySelector('input, textarea')).toBeNull();
    expect(memoEditor()).toBeNull();
  });

  it('位置だけの追加のメモ（東2局1本場 6巡目）も、書いてあれば、答えたあとに出る（迷いだけでは、半荘のページが結びつけを保存しない）', async () => {
    const memos: Memos = { marks: {}, extras: [{ id: 'x1', position: { kyoku: 1, honba: 1, junme: 6 }, candidates: '位置から', reason: '速さ' }] };
    const writes: unknown[] = [];
    const { user, sessions } = replaySetup(
      memos,
      {
        set_extra_memo: (args) => {
          writes.push(args);
          return undefined;
        },
      },
      { doubt_only: true },
    );
    await loaded();
    await openScene(user, 3);
    await answerScene(user);
    const block = document.querySelector('[data-memo="shown"]') as HTMLElement;
    expect([...block.querySelectorAll('dd')].map((dd) => dd.textContent)).toEqual(['位置から', '速さ']);
    // 出すだけ。結びつけの保存はしていない（追加のメモの欄が、画面に無いため）
    expect(writes).toEqual([]);
    expect(sessions.session(FX4_ID).memos.extras[0]?.decision).toBeUndefined();
  });

  it('設定を切ると（settings-changed）、答える前の迷いの場面に、メモの欄が出る。書いてあったメモが入っている。入れ直すと消える', async () => {
    const { user, mock } = replaySetup(MEMO3, {}, { doubt_only: true });
    await loaded();
    await openScene(user, 3);
    expect(memoEditor()).toBeNull();
    act(() => {
      mock.emit('settings-changed', { ...baseSettings, doubt_only: false } satisfies Settings);
    });
    await waitFor(() => expect(memoEditor()).not.toBeNull());
    const group = within(memoEditor() as HTMLElement).getByRole('group', { name: '迷い3のメモ' });
    expect(within(group).getByLabelText('候補')).toHaveValue('南・6m');
    expect(within(group).getByLabelText('理由')).toHaveValue('東を残したい');
    act(() => {
      mock.emit('settings-changed', { ...baseSettings, doubt_only: true } satisfies Settings);
    });
    await waitFor(() => expect(memoEditor()).toBeNull());
    expect(screen.queryByLabelText('候補')).toBeNull();
  });

  it('切のとき（これまでの画面）は、迷いの場面に、メモの欄がある', async () => {
    const { user } = replaySetup(MEMO3, {}, { doubt_only: false });
    await loaded();
    await openScene(user, 3);
    expect(memoEditor()).not.toBeNull();
    expect(screen.getByRole('group', { name: '迷い3のメモ' })).toBeInTheDocument();
  });

  it('出題・解き直しの答え合わせのあとの「終局直後のメモ」も、書いてあれば出る（迷いだけの設定でも）', async () => {
    const { user } = renderQuiz({ doubtOnly: true, session: quizSession(MEMO) });
    expect(memoBlock()).toBeNull();
    await answer(user);
    expect([...(memoBlock() as HTMLElement).querySelectorAll('dd')].map((dd) => dd.textContent)).toEqual(['南・6m', '東を残して形を整えたい']);
    cleanup();
    const review = renderQuiz({ doubtOnly: true, mode: 'review', previousIntervalDays: 1, session: quizSession(MEMO) });
    expect(memoBlock()).toBeNull();
    await answer(review.user);
    expect([...(memoBlock() as HTMLElement).querySelectorAll('dd')].map((dd) => dd.textContent)).toEqual(['南・6m', '東を残して形を整えたい']);
  });
});
