/**
 * 解決（F16。ACCEPTANCE の U-41・E-45・D-6 の画面側）と、細かいミス・拮抗の出題（F17。U-42 の出題の見出し）の画面の試験。
 * アプリ全体（App）を、半荘の保存先の偽物と、答えの記録の偽物の上で動かして、使う人と同じ操作で確かめる。
 * 解決の入切は、本物と同じく、保存（`set_resolved`）→ 半荘の一覧の読み直し → 画面の更新、の順で動く。
 */
import { listProblems } from '@jantama/engine';
import { render, screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { FakeSessionStore, local, seedSession } from '../../../tests/fake-sessions';
import { FakeStudyStore, answerRow, gameOf } from '../../../tests/fake-study';
import { fx4Ocr, fx4Session } from '../../../tests/import-fixtures';
import { baseSettings, installTauriMock } from '../../../tests/tauri-mock';
import type { Settings } from '../../api/types';
import { App } from '../App';

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
  vi.useRealTimers();
});

const FX4_ID = '20261009-190953';
const FX1A_ID = '20261009-171200';
const LOAD = { timeout: 20_000 };
const RESOLVED_AT = 1_760_000_000_000;

/** FX-4 の今日の組（細かいミスの迷い 2 が先頭、あとは迷いの順）の判断の鍵。 */
const DAILY = ['k1h0e12', 'k0h0e4', 'k1h1e7', 'k1h1e10', 'k2h1e6'];

interface SetupOptions {
  study?: FakeStudyStore;
  settings?: Partial<Settings>;
  only?: 'both' | 'fx4';
  /** 最初から解決している FX-4 の判断の鍵。 */
  resolved?: readonly string[];
}

function setup(options: SetupOptions = {}) {
  const fx4 = {
    session: fx4Session(FX4_ID, local(2026, 10, 9, 19, 9), {
      report_path: `C:\\data\\games\\${FX4_ID}\\report.json`,
      ocr: fx4Ocr(),
      resolved: { decisions: Object.fromEntries((options.resolved ?? []).map((key) => [key, RESOLVED_AT])) },
    }),
    report: 'fx4' as const,
  };
  const seeds = options.only === 'fx4' ? [fx4] : [fx4, seedSession(local(2026, 10, 9, 17, 12), { id: FX1A_ID, report: 'fx1a' })];
  const sessions = new FakeSessionStore(seeds);
  const study = options.study ?? new FakeStudyStore();
  const mock = installTauriMock({
    settings: { ...baseSettings, ...options.settings },
    handlers: { ...sessions.handlers, ...study.handlers },
  });
  const user = userEvent.setup();
  render(<App />);
  return { user, mock, sessions, study };
}

/** 今日の組を最初から保存しておく答えの記録の偽物（その日の組は入れ替えないので、解決を入れたあとも、組はそのまま）。 */
function dailyStudy(extra: ConstructorParameters<typeof FakeStudyStore>[0] = []) {
  return new FakeStudyStore(extra, { '2026-10-09': DAILY.map((decision_key) => ({ session_id: FX4_ID, decision_key })) });
}

const sideButton = (name: RegExp) => within(screen.getByRole('navigation', { name: 'メイン' })).getByRole('button', { name });
const sideCount = (name: RegExp) => sideButton(name).querySelector('.count')?.textContent ?? null;

async function loaded(count: string | null = '5') {
  await screen.findByRole('navigation', { name: '半荘の一覧' });
  await waitFor(() => expect(sideCount(/^今日の出題/)).toBe(count), LOAD);
}

async function openToday(user: ReturnType<typeof userEvent.setup>) {
  await user.click(sideButton(/^今日の出題/));
  return screen.findByRole('heading', { level: 1, name: '今日の出題' });
}

const todayRows = () => within(screen.getByRole('list', { name: '今日の出題' })).getAllByRole('button');
const resolveButton = () => screen.getByRole('button', { name: '解決' });
const nextButton = (name: string | RegExp = /^(次の問題へ|今日の出題に戻る|解き直しを終える)$/) => screen.queryByRole('button', { name });
const title = () => screen.getByRole('heading', { level: 1 }).textContent ?? '';

async function solve(user: ReturnType<typeof userEvent.setup>, reason = '試験の理由') {
  await screen.findByLabelText('理由（1行）');
  const radios = screen.queryAllByRole('radio');
  if (radios.length > 0) await user.click(radios[0] as HTMLElement);
  else await user.click(screen.getAllByRole('button', { name: /を切る$/ })[0] as HTMLElement);
  await user.type(screen.getByLabelText('理由（1行）'), reason);
  await user.click(screen.getByRole('button', { name: '答え合わせ' }));
  await screen.findByRole('heading', { name: 'AIの評価（Mortal）' });
}

describe('U-41 出題の「解決」: 答えの欄の上の段', () => {
  it('答える前から、上の段の先頭に「解決」（押されていない）。次へ進むボタンはまだ無く、AI の情報も無い', async () => {
    const { user } = setup();
    await loaded();
    await openToday(user);
    await user.click(screen.getByRole('button', { name: '出題を始める' }));
    await screen.findByLabelText('理由（1行）');
    const panel = document.getElementById('answer') as HTMLElement;
    expect(panel.firstElementChild).toHaveClass('answer-bar');
    expect(panel.firstElementChild?.firstElementChild).toBe(resolveButton());
    expect(resolveButton()).toHaveAttribute('aria-pressed', 'false');
    expect(resolveButton().querySelector('.ic')).toBeNull();
    expect(nextButton()).toBeNull();
    // U-1: 上の段を足しても、答える前の画面に AI の情報は出ない
    expect(document.querySelector('[data-ai]')).toBeNull();
    expect(document.body.textContent).not.toMatch(/\d\s*%|Mortal/);
  });

  it('答える前に押すと、押された状態（文字は「解決」のまま。チェックの印が付く）になり、次へ進むボタンが出る。もう一度押すと、元に戻って消える', async () => {
    const { user, sessions } = setup();
    await loaded();
    await openToday(user);
    await user.click(screen.getByRole('button', { name: '出題を始める' }));
    await screen.findByLabelText('理由（1行）');
    await user.click(resolveButton());
    await waitFor(() => expect(resolveButton()).toHaveAttribute('aria-pressed', 'true'));
    expect(resolveButton()).toHaveTextContent(/^解決$/);
    expect(resolveButton().querySelector('.ic')).not.toBeNull();
    expect(nextButton('次の問題へ')).toBeInTheDocument();
    expect(nextButton('次の問題へ')?.closest('.answer-bar')).toBe(resolveButton().closest('.answer-bar'));
    // 解決は保存される（半荘のフォルダの resolved.json。時刻つき）
    expect(sessions.resolveCalls).toEqual([`on:${FX4_ID}:k1h0e12`]);
    expect(Object.keys(sessions.session(FX4_ID).resolved.decisions)).toEqual(['k1h0e12']);
    // 答えてはいない（答えの記録も、答える前の欄もそのまま）
    expect(screen.getByRole('button', { name: '答え合わせ' })).toBeDisabled();
    expect(document.querySelector('[data-ai]')).toBeNull();
    // もう一度押すと元に戻り、次へ進むボタンも消える
    await user.click(resolveButton());
    await waitFor(() => expect(resolveButton()).toHaveAttribute('aria-pressed', 'false'));
    expect(nextButton()).toBeNull();
    expect(sessions.resolveCalls).toEqual([`on:${FX4_ID}:k1h0e12`, `off:${FX4_ID}:k1h0e12`]);
    expect(sessions.session(FX4_ID).resolved.decisions).toEqual({});
  });

  it('解決を入れてから「次の問題へ」を押すと、答えないまま次の問題へ進む（答えは保存されない）。サイドバーの数は、解決した分だけ減る', async () => {
    const { user, study } = setup();
    await loaded();
    await openToday(user);
    await user.click(screen.getByRole('button', { name: '出題を始める' }));
    await screen.findByLabelText('理由（1行）');
    expect(title()).toBe('東2局 11巡目');
    await user.click(resolveButton());
    await waitFor(() => expect(sideCount(/^今日の出題/)).toBe('4'));
    await user.click(screen.getByRole('button', { name: '次の問題へ' }));
    // 2 問目（迷い 1）。見出しの「何問目」は、組の位置のまま 2 / 5
    expect(await screen.findByRole('heading', { level: 1, name: '東1局 4巡目' })).toBeInTheDocument();
    expect(document.querySelector('.progress')?.textContent).toBe('2 / 5');
    expect(study.rows).toHaveLength(0);
    expect(resolveButton()).toHaveAttribute('aria-pressed', 'false');
  });

  it('答え合わせのあとも、上の段の先頭に「解決」があり、右に次へ進むボタン。押して入れ切りできる', async () => {
    const { user } = setup();
    await loaded();
    await openToday(user);
    await user.click(screen.getByRole('button', { name: '出題を始める' }));
    await solve(user);
    const bar = document.querySelector('.answer-bar') as HTMLElement;
    expect([...bar.children].map((child) => child.id)).toEqual(['resolve', 'next']);
    expect(resolveButton()).toHaveAttribute('aria-pressed', 'false');
    await user.click(resolveButton());
    await waitFor(() => expect(resolveButton()).toHaveAttribute('aria-pressed', 'true'));
    // 答えた問題は、解決を入れても、答えたまま（解答済み）
    await user.click(sideButton(/^今日の出題/));
    await screen.findByRole('heading', { level: 1, name: '今日の出題' });
    expect(todayRows()[0]).toHaveClass('done');
    expect(todayRows()[0]).toHaveClass('resolved');
  });

  it('Ctrl+Z で解決が戻り、Ctrl+Y でやり直せる（取り消しの履歴に、名前「解決」の命令が積まれる）', async () => {
    const { user, sessions } = setup();
    await loaded();
    await openToday(user);
    await user.click(screen.getByRole('button', { name: '出題を始める' }));
    await screen.findByLabelText('理由（1行）');
    await user.click(resolveButton());
    await waitFor(() => expect(resolveButton()).toHaveAttribute('aria-pressed', 'true'));
    await user.keyboard('{Control>}z{/Control}');
    await waitFor(() => expect(resolveButton()).toHaveAttribute('aria-pressed', 'false'), LOAD);
    expect(nextButton()).toBeNull();
    expect(sessions.session(FX4_ID).resolved.decisions).toEqual({});
    // 取り消した通知
    expect(await screen.findByText('解決を元に戻しました', {}, LOAD)).toBeInTheDocument();
    await user.keyboard('{Control>}y{/Control}');
    await waitFor(() => expect(resolveButton()).toHaveAttribute('aria-pressed', 'true'), LOAD);
    expect(sessions.resolveCalls).toEqual([`on:${FX4_ID}:k1h0e12`, `off:${FX4_ID}:k1h0e12`, `on:${FX4_ID}:k1h0e12`]);
    expect(await screen.findByText('解決をやり直しました', {}, LOAD)).toBeInTheDocument();
  });

  it('最初から解決している問題は、押された状態で開く', async () => {
    const { user } = setup({ study: dailyStudy(), resolved: ['k0h0e4'] });
    await loaded('4');
    await openToday(user);
    await user.click(todayRows()[1] as HTMLElement);
    expect(await screen.findByRole('heading', { level: 1, name: '東1局 4巡目' })).toBeInTheDocument();
    expect(resolveButton()).toHaveAttribute('aria-pressed', 'true');
    expect(nextButton('次の問題へ')).toBeInTheDocument();
  });
});

describe('F16 解決した問題: 今日の出題', () => {
  it('組を新しく作るとき、解決した局面は入れない。足りない分は、次の問題で埋める。残りにも出さない', async () => {
    const { user } = setup({ resolved: ['k1h0e12'] });
    await loaded('5');
    await openToday(user);
    const texts = todayRows().map((row) => row.textContent);
    expect(texts).toHaveLength(5);
    // 細かいミスの迷い 2 が除かれ、迷い 1・3・4・5 と、大きな不一致が 1 つ
    expect(texts[0]).toMatch(/^1東1局 4巡目迷い1/);
    expect(texts.some((text) => text?.includes('迷い2'))).toBe(false);
    expect(texts.filter((text) => text?.includes('迷い'))).toHaveLength(4);
    // 問題は 28（迷い 5・不一致 4 + 19）から解決の 1 を引いた 27。組が 5 なので、残りは 22
    expect(screen.getByText('残り22問')).toBeInTheDocument();
  });

  it('組にすでに入っている問題を解決すると、組は変えずに「解決」の印を付けて薄くする。押せば開ける。数と「続きから」と進み具合は、解決を除く', async () => {
    const { user } = setup({ study: dailyStudy(), resolved: ['k1h0e12', 'k1h1e7'] });
    await loaded('3');
    await openToday(user);
    const rows = todayRows();
    expect(rows).toHaveLength(5);
    expect(rows.map((row) => row.classList.contains('resolved'))).toEqual([true, false, true, false, false]);
    expect(rows[0]).toHaveTextContent('解決');
    expect(rows[0]?.querySelector('.st-resolved .ic')).not.toBeNull();
    expect(rows[1]).not.toHaveTextContent('解決');
    // 進み具合は、解決した 2 問を除いた 3 問が分母
    expect(document.querySelector('.nums')?.textContent).toBe('0 / 3 問を解きました（解決 2問を除く）');
    // 「出題を始める」は、解決していない先頭（2 行目）から
    await user.click(screen.getByRole('button', { name: '出題を始める' }));
    expect(await screen.findByRole('heading', { level: 1, name: '東1局 4巡目' })).toBeInTheDocument();
    // 解決した問題も、一覧から開ける。押された状態で開く
    await user.click(sideButton(/^今日の出題/));
    await user.click(todayRows()[0] as HTMLElement);
    expect(await screen.findByRole('heading', { level: 1, name: '東2局 11巡目' })).toBeInTheDocument();
    expect(resolveButton()).toHaveAttribute('aria-pressed', 'true');
  });

  it('組の中の解決した問題は、「次の問題へ」で飛ばす。解決を切ると、また進む先になる', async () => {
    const { user } = setup({ study: dailyStudy(), resolved: ['k0h0e4'] });
    await loaded('4');
    await openToday(user);
    await user.click(todayRows()[0] as HTMLElement);
    await solve(user);
    await user.click(screen.getByRole('button', { name: '次の問題へ' }));
    // 2 問目（迷い 1）は解決しているので、3 問目（迷い 3。東2局1本場 6巡目）へ
    expect(await screen.findByRole('heading', { level: 1, name: '東2局1本場 6巡目' })).toBeInTheDocument();
    expect(document.querySelector('.progress')?.textContent).toBe('3 / 5');
  });

  it('組の最後まで解決した問題を飛ばすと、「今日の出題に戻る」になる', async () => {
    const { user } = setup({ study: dailyStudy(), resolved: ['k1h1e10', 'k2h1e6'] });
    await loaded('3');
    await openToday(user);
    await user.click(todayRows()[2] as HTMLElement);
    await solve(user);
    // 4・5 問目は解決している。前の側の答えていない問題（1 問目）へ戻る
    await user.click(screen.getByRole('button', { name: '次の問題へ' }));
    expect(await screen.findByRole('heading', { level: 1, name: '東2局 11巡目' })).toBeInTheDocument();
    await solve(user);
    expect(screen.getByRole('button', { name: '次の問題へ' })).toBeInTheDocument();
    await user.click(screen.getByRole('button', { name: '次の問題へ' }));
    expect(await screen.findByRole('heading', { level: 1, name: '東1局 4巡目' })).toBeInTheDocument();
    await solve(user);
    expect(screen.getByRole('button', { name: '今日の出題に戻る' })).toBeInTheDocument();
  });

  it('解決を切ると、元に戻る（サイドバーの数も、一覧の印も）', async () => {
    const { user } = setup({ study: dailyStudy(), resolved: ['k0h0e4'] });
    await loaded('4');
    await openToday(user);
    await user.click(todayRows()[1] as HTMLElement);
    await screen.findByLabelText('理由（1行）');
    await user.click(resolveButton());
    await waitFor(() => expect(sideCount(/^今日の出題/)).toBe('5'));
    await user.click(sideButton(/^今日の出題/));
    await screen.findByRole('heading', { level: 1, name: '今日の出題' });
    expect(todayRows().some((row) => row.classList.contains('resolved'))).toBe(false);
    expect(document.querySelector('.nums')?.textContent).toBe('0 / 5 問を解きました');
  });
});

describe('F16 解決した問題: 解き直し', () => {
  /** FX-4 の問題の先頭から 3 つを、期限が今日（10/09）の答えとして保存済みにする。 */
  function dueStudy() {
    const game = gameOf('fx4');
    const problems = listProblems([{ sessionId: FX4_ID, startedMs: local(2026, 10, 9, 19, 9), game, markKeys: [] }], { threshold: 0.05 });
    const picked = problems.slice(0, 3);
    return {
      picked,
      study: new FakeStudyStore(
        picked.map((problem, index) =>
          answerRow({
            id: index + 1,
            session_id: FX4_ID,
            decision_key: problem.key,
            answered_at: 1_000 * (index + 1),
            due_date: '2026-10-09',
            interval_days: 3,
          }),
        ),
      ),
    };
  }

  it('解決した問題は、解き直しの列に出ない。数も減る。切ると、元の期限で戻る', async () => {
    const { study, picked } = dueStudy();
    const { user, sessions } = setup({ study, only: 'fx4', resolved: [picked[1]?.key ?? ''] });
    await waitFor(() => expect(sideCount(/^解き直し/)).toBe('2'), LOAD);
    await user.click(sideButton(/^解き直し/));
    await screen.findByLabelText('理由（1行）');
    expect(document.querySelector('.kicker')?.textContent).toBe('解き直し · 今日の期限 2問');
    expect(document.querySelector('.progress')?.textContent).toBe('1 / 2');
    // 解き直しの画面にも「解決」がある。押すと、その問題の解決が入り、数も減る
    expect(resolveButton()).toHaveAttribute('aria-pressed', 'false');
    await user.click(resolveButton());
    await waitFor(() => expect(sideCount(/^解き直し/)).toBe('1'));
    expect(Object.keys(sessions.session(FX4_ID).resolved.decisions)).toHaveLength(2);
    // 取り消す（解決を切る）と、元の期限のまま、列に戻る
    await user.keyboard('{Control>}z{/Control}');
    await waitFor(() => expect(sideCount(/^解き直し/)).toBe('2'));
  });

  it('解き直しの途中で解決を入れて「次の問題へ」を押すと、次へ進む。解決した問題は、列の後ろにあっても飛ばす', async () => {
    const { study } = dueStudy();
    const { user } = setup({ study, only: 'fx4' });
    await waitFor(() => expect(sideCount(/^解き直し/)).toBe('3'), LOAD);
    await user.click(sideButton(/^解き直し/));
    await screen.findByLabelText('理由（1行）');
    expect(document.querySelector('.progress')?.textContent).toBe('1 / 3');
    // 答えないまま解決して、次へ（答え合わせの前でも、次へ進むボタンが出る）
    await user.click(resolveButton());
    await waitFor(() => expect(screen.getByRole('button', { name: '次の問題へ' })).toBeInTheDocument());
    await user.click(screen.getByRole('button', { name: '次の問題へ' }));
    await waitFor(() => expect(document.querySelector('.progress')?.textContent).toBe('2 / 3'));
    // 答えは作られない（解決しただけ）
    expect(study.rows).toHaveLength(3);
    expect(resolveButton()).toHaveAttribute('aria-pressed', 'false');
  });
});

describe('F17 出題の見出しの札', () => {
  it('細かいミスの問題の見出しに「細かいミス」（迷いの札と同じ形）。ほかの迷いには出ない', async () => {
    const { user } = setup();
    await loaded();
    await openToday(user);
    await user.click(screen.getByRole('button', { name: '出題を始める' }));
    await screen.findByLabelText('理由（1行）');
    const chips = () => [...document.querySelectorAll('.q-chips .q-chip')].map((chip) => ({ text: chip.textContent, doubt: chip.classList.contains('is-doubt') }));
    expect(chips()).toEqual([
      { text: '1向聴', doubt: false },
      { text: '実戦：打8p', doubt: false },
      { text: '迷い2', doubt: true },
      { text: '細かいミス', doubt: true },
    ]);
    await user.click(resolveButton());
    await user.click(await screen.findByRole('button', { name: '次の問題へ' }));
    expect(await screen.findByRole('heading', { level: 1, name: '東1局 4巡目' })).toBeInTheDocument();
    expect(chips().map((chip) => chip.text)).toEqual(['1向聴', '実戦：打5p', '迷い1']);
  });

  it('拮抗の問題の見出しに「拮抗」。今日の出題では、大きな不一致のあと（最後）に入る', async () => {
    // 差の基準を 100 ポイント・1 巡目以降にして、2 つ以上の候補がある判断はすべて拮抗にする
    const { user } = setup({
      only: 'fx4',
      settings: { contest_enabled: true, contest_gap_percent: 100, contest_min_junme: 1 },
    });
    await screen.findByRole('navigation', { name: '半荘の一覧' });
    await waitFor(() => expect(sideCount(/^今日の出題/)).toBe('5'), LOAD);
    await openToday(user);
    // 残りの末尾に、拮抗の問題がある（迷い 5 と不一致 4 を除いた分が、拮抗）
    await user.click(within(document.querySelector('details.qrest') as HTMLElement).getByText(/^残り\d+問$/));
    const rest = within(screen.getByRole('list', { name: '残りの出題' })).getAllByRole('button');
    expect(rest.length).toBeGreaterThan(4);
    const last = rest[rest.length - 1] as HTMLElement;
    await user.click(last);
    await screen.findByLabelText('理由（1行）');
    expect([...document.querySelectorAll('.q-chips .q-chip')].some((chip) => chip.textContent === '拮抗' && chip.classList.contains('is-mis'))).toBe(true);
  });
});
