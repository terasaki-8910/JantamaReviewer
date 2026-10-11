/**
 * 今日の出題・出題・解き直し（ACCEPTANCE の U-9・U-10・U-15・U-16・U-17）の、画面の試験。
 * アプリ全体（App）を、半荘の保存先の偽物と、答えの記録の偽物の上で動かして、使う人と同じ操作で確かめる。
 * 実ブラウザでの見え方（横スクロール・axe・描かれた色）は、tests/browser/quiz.browser.test.ts が確かめる。
 */
import { findDecisionByKey, listProblems } from '@jantama/engine';
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

/** FX-4（読み取りの写しつき。迷い 1〜5 は推定、迷い 6 は読めない）と、f9da（迷いなし）。 */
function seeds(only: 'both' | 'fx4' = 'both') {
  const fx4 = {
    session: fx4Session(FX4_ID, local(2026, 10, 9, 19, 9), { report_path: `C:\\data\\games\\${FX4_ID}\\report.json`, ocr: fx4Ocr() }),
    report: 'fx4' as const,
  };
  return only === 'fx4' ? [fx4] : [fx4, seedSession(local(2026, 10, 9, 17, 12), { id: FX1A_ID, report: 'fx1a' })];
}

interface SetupOptions {
  study?: FakeStudyStore;
  settings?: Partial<Settings>;
  only?: 'both' | 'fx4';
  solvedProblems?: (ids: readonly string[]) => number;
}

function setup(options: SetupOptions = {}) {
  const sessions = new FakeSessionStore(seeds(options.only));
  const study = options.study ?? new FakeStudyStore();
  const mock = installTauriMock({
    settings: { ...baseSettings, ...options.settings },
    handlers: { ...sessions.handlers, ...study.handlers },
  });
  const user = userEvent.setup();
  render(<App solvedProblems={options.solvedProblems} />);
  return { user, mock, sessions, study };
}

const sideButton = (name: RegExp) => within(screen.getByRole('navigation', { name: 'メイン' })).getByRole('button', { name });
const sideCount = (name: RegExp) => sideButton(name).querySelector('.count')?.textContent ?? null;

/** 出題のデータを読み終えて、サイドバーに数が出るまで待つ。 */
async function loaded(count: string | null = '5') {
  await screen.findByRole('navigation', { name: '半荘の一覧' });
  await waitFor(() => expect(sideCount(/^今日の出題/)).toBe(count), LOAD);
}

async function openToday(user: ReturnType<typeof userEvent.setup>) {
  await user.click(sideButton(/^今日の出題/));
  return screen.findByRole('heading', { level: 1, name: '今日の出題' });
}

const todayRows = () => within(screen.getByRole('list', { name: '今日の出題' })).getAllByRole('button');

/** いま出ている問題を、解いて、答え合わせまで進める（打牌は 1 枚目の牌、ほかは 1 つ目のボタン）。 */
async function solve(user: ReturnType<typeof userEvent.setup>, reason = '試験の理由') {
  await screen.findByLabelText('理由（1行）');
  const radios = screen.queryAllByRole('radio');
  if (radios.length > 0) await user.click(radios[0] as HTMLElement);
  else await user.click(screen.getAllByRole('button', { name: /を切る$/ })[0] as HTMLElement);
  await user.type(screen.getByLabelText('理由（1行）'), reason);
  await user.click(screen.getByRole('button', { name: '答え合わせ' }));
  await screen.findByRole('heading', { name: 'AIの評価（Mortal）' });
}

describe('U-15 サイドバーの今日の出題・解き直し', () => {
  it('今日の出題の数（まだ解いていない問題）と、解き直しの数（今日が期限）を、行の右に出す。読み込みが終わるまでは出さない', async () => {
    setup();
    await screen.findByRole('navigation', { name: '半荘の一覧' });
    expect(sideCount(/^今日の出題/)).toBeNull();
    await loaded('5');
    expect(sideCount(/^解き直し/)).toBe('0');
    // ログは押せる（数は無い）。週の集計は、まだ押せない
    expect(sideButton(/^ログ/)).not.toHaveAttribute('aria-disabled');
    expect(sideButton(/^ログ/).querySelector('.count')).toBeNull();
    expect(sideButton(/^週の集計/)).toHaveAttribute('aria-disabled', 'true');
  });

  it('今日の組は、読み込みが終わったとき、その日のうちに 1 回だけ保存する（開き直しても同じ）', async () => {
    const { study } = setup();
    await loaded();
    await waitFor(() => expect(study.daily.get('2026-10-09')).toHaveLength(5), LOAD);
    const saved = study.daily.get('2026-10-09');
    expect(saved?.every((item) => item.session_id === FX4_ID)).toBe(true);
  });

  it('保存してある組は、そのまま使う（問題の一覧が替わっても、入れ替えない）', async () => {
    const keys = ['k1h0e12', 'k1h1e9'];
    const study = new FakeStudyStore([], { '2026-10-09': keys.map((decision_key) => ({ session_id: FX4_ID, decision_key })) });
    const { user } = setup({ study });
    await loaded('2');
    await openToday(user);
    expect(todayRows()).toHaveLength(2);
    expect(screen.getByText('0', { selector: '.nums b' })).toBeInTheDocument();
    expect(document.querySelector('.nums')?.textContent).toBe('0 / 2 問を解きました');
  });
});

describe('U-15 今日の出題の一覧', () => {
  it('今日の問題 5 つ（局・巡目・迷いの印・種類・シャンテン数・どの半荘か）と、解いた数と、出題を始めるボタン', async () => {
    const { user } = setup();
    await loaded();
    await openToday(user);
    expect(document.querySelector('.nums')?.textContent).toBe('0 / 5 問を解きました');
    expect(screen.getByRole('button', { name: '出題を始める' })).toBeInTheDocument();
    const rows = todayRows();
    expect(rows).toHaveLength(5);
    // FX-4 の迷い 1〜5（推定で結びついたもの）。局・巡目の順は、迷いの順
    const texts = rows.map((row) => row.textContent);
    expect(texts).toEqual([
      expect.stringMatching(/^1東1局 4巡目迷い1打牌 · 1シャンテン · 10月9日 19:09 の半荘$/),
      expect.stringMatching(/^2東2局 11巡目迷い2打牌 · 1シャンテン · 10月9日 19:09 の半荘$/),
      expect.stringMatching(/^3東2局1本場 6巡目迷い3打牌 · 2シャンテン · 10月9日 19:09 の半荘$/),
      expect.stringMatching(/^4東2局1本場 8巡目迷い4鳴き · 1シャンテン · 10月9日 19:09 の半荘$/),
      expect.stringMatching(/^5東3局1本場 6巡目迷い5打牌 · 2シャンテン · 10月9日 19:09 の半荘$/),
    ]);
    // 解答済みの印も、次の印も、まだ無い
    expect(rows.some((row) => row.className.includes('done') || row.className.includes('next'))).toBe(false);
    // 組の説明の 1 行
    expect(document.querySelector('.q-rule')?.textContent).toBe(
      '10月9日の半荘から5問。迷いに結びついた局面を先に入れ、足りない分を、AIとの差が大きい順に入れています。1日に出す数は設定で変えられます。',
    );
  });

  it('答える前の一覧に、AI の候補・確率・順位は出さない（U-1。並べ替えの確率も出さない）', async () => {
    const { user } = setup();
    await loaded();
    await openToday(user);
    expect(document.querySelector('[data-ai]')).toBeNull();
    expect(document.body.textContent).not.toMatch(/\d\s*%|Mortal/);
    expect(document.body.innerHTML).not.toMatch(/data-ai/);
  });

  it('今日の分のほかは「残り N問」に畳む（開けば、並ぶ）。結びつけが決まっていない迷いの数と、半荘のページで決めると入ることを出す', async () => {
    const { user } = setup();
    await loaded();
    await openToday(user);
    const rest = document.querySelector('details.qrest') as HTMLDetailsElement;
    // FX-4 の不一致 4 件と、f9da の不一致 19 件
    expect(within(rest).getByText('残り23問')).toBeInTheDocument();
    expect(rest.open).toBe(false);
    await user.click(within(rest).getByText('残り23問'));
    expect(rest.open).toBe(true);
    const items = within(screen.getByRole('list', { name: '残りの出題' })).getAllByRole('button');
    expect(items).toHaveLength(23);
    expect(items[0]?.textContent).toMatch(/^6/);
    // 残りの行に、迷いの印は無い（迷いの問題は、先に今日の組に入る）
    expect(rest.querySelector('.q-tag')).toBeNull();
    expect(screen.getByText('迷い1件は、どの局面か決まっていません。半荘のページで選ぶと、ここに入ります。')).toBeInTheDocument();
  });

  it('出す問題が無いときは、その旨を出す（結果を取り込んだ半荘が無い）', async () => {
    const sessions = new FakeSessionStore([seedSession(local(2026, 10, 9, 19, 9), { marks: 2 })]);
    installTauriMock({ handlers: { ...sessions.handlers, ...new FakeStudyStore().handlers } });
    const user = userEvent.setup();
    render(<App />);
    await waitFor(() => expect(sideCount(/^今日の出題/)).toBe('0'), LOAD);
    await openToday(user);
    expect(screen.getByText(/出す問題がありません。/)).toBeInTheDocument();
  });
});

describe('U-16 出題と答え合わせ（今日の出題を順に解く）', () => {
  it('「出題を始める」で 1 問目が開く。見出しに 1 / 5 と、局・巡目・実戦の行動・迷いの印', async () => {
    const { user } = setup();
    await loaded();
    await openToday(user);
    await user.click(screen.getByRole('button', { name: '出題を始める' }));
    expect(await screen.findByRole('heading', { level: 1, name: '東1局 4巡目' })).toBeInTheDocument();
    expect(document.querySelector('.progress')?.textContent).toBe('1 / 5');
    const chips = [...document.querySelectorAll('.q-chips .q-chip')].map((chip) => chip.textContent);
    expect(chips).toEqual(['1シャンテン', '実戦：打5p', '迷い1']);
    // サイドバーは、今日の出題に印
    expect(sideButton(/^今日の出題/)).toHaveAttribute('aria-current', 'page');
  });

  it('答えると、サイドバーの数が減り、答えは保存される。「次の問題へ」で、今日の次の問題へ（2 / 5）', async () => {
    const { user, study } = setup();
    await loaded();
    await openToday(user);
    await user.click(screen.getByRole('button', { name: '出題を始める' }));
    await solve(user);
    expect(study.rows).toHaveLength(1);
    expect(study.rows[0]).toMatchObject({ session_id: FX4_ID, mode: 'quiz', reason: '試験の理由', interval_days: 1, due_date: '2026-10-10' });
    expect(study.rows[0]?.shown_at).toBeGreaterThan(0);
    await waitFor(() => expect(sideCount(/^今日の出題/)).toBe('4'));
    await user.click(screen.getByRole('button', { name: '次の問題へ' }));
    expect(await screen.findByRole('heading', { level: 1, name: '東2局 11巡目' })).toBeInTheDocument();
    expect(document.querySelector('.progress')?.textContent).toBe('2 / 5');
    // 新しい問題は、答える前の画面（AI の情報は無い。理由の欄は空）
    expect(document.querySelector('[data-ai]')).toBeNull();
    expect(screen.getByLabelText('理由（1行）')).toHaveValue('');
    // 「次の問題へ」を押したあと、キーボードの位置は、次の問題の最初の操作へ
    await waitFor(() => expect(document.activeElement?.closest('.hand, .q-choices')).not.toBeNull());
  });

  it('一覧に戻ると、解いた数・解答済みの印・「続きから（2問目）」・次の行の印が出る。答えた問題を押すと、保存した答えが開く', async () => {
    const { user } = setup();
    await loaded();
    await openToday(user);
    await user.click(screen.getByRole('button', { name: '出題を始める' }));
    await solve(user, '最初の理由');
    await user.click(sideButton(/^今日の出題/));
    await screen.findByRole('heading', { level: 1, name: '今日の出題' });
    expect(document.querySelector('.nums')?.textContent).toBe('1 / 5 問を解きました');
    expect(screen.getByRole('button', { name: '続きから（2問目）' })).toBeInTheDocument();
    const rows = todayRows();
    expect(rows[0]).toHaveClass('done');
    expect(rows[0]).toHaveTextContent('解答済み');
    expect(rows[1]).toHaveClass('next');
    expect(rows[1]).toHaveTextContent('次はここから');
    // 答えた問題: 保存した答えが、答え合わせのあとの形で開く
    await user.click(rows[0] as HTMLElement);
    expect(await screen.findByText('最初の理由')).toBeInTheDocument();
    expect(document.querySelector('.qz')?.getAttribute('data-state')).toBe('revealed');
    expect(screen.queryByRole('button', { name: '答え合わせ' })).toBeNull();
  });

  it('「続きから」は、まだ答えていない先頭の問題を開く', async () => {
    const { user } = setup();
    await loaded();
    await openToday(user);
    // 2 問目を、先に解く
    await user.click(todayRows()[1] as HTMLElement);
    await solve(user);
    await user.click(sideButton(/^今日の出題/));
    await screen.findByRole('heading', { level: 1, name: '今日の出題' });
    expect(todayRows()[1]).toHaveClass('done');
    expect(todayRows()[0]).toHaveClass('next');
    await user.click(screen.getByRole('button', { name: '続きから（1問目）' }));
    expect(await screen.findByRole('heading', { level: 1, name: '東1局 4巡目' })).toBeInTheDocument();
  });

  it('5 問とも解くと、最後の問題の次は「今日の出題に戻る」。一覧は 5 / 5 で、始めるボタンは無い', async () => {
    const { user } = setup();
    await loaded();
    await openToday(user);
    await user.click(screen.getByRole('button', { name: '出題を始める' }));
    for (let n = 1; n <= 4; n += 1) {
      await solve(user);
      await user.click(screen.getByRole('button', { name: '次の問題へ' }));
      await waitFor(() => expect(document.querySelector('.progress')?.textContent).toBe(`${n + 1} / 5`));
    }
    await solve(user);
    expect(screen.queryByRole('button', { name: '次の問題へ' })).toBeNull();
    await user.click(screen.getByRole('button', { name: '今日の出題に戻る' }));
    expect(await screen.findByRole('heading', { level: 1, name: '今日の出題' })).toBeInTheDocument();
    expect(document.querySelector('.nums')?.textContent).toBe('5 / 5 問を解きました');
    expect(screen.queryByRole('button', { name: /出題を始める|続きから/ })).toBeNull();
    expect(sideCount(/^今日の出題/)).toBe('0');
  });

  it('残りから解いた問題（追加）は、今日の組の数を変えず、残りから減る。見出しに「何問目」は出さない。次は、今日の組の答えていない問題', async () => {
    const { user, study } = setup();
    await loaded();
    await openToday(user);
    await user.click(within(document.querySelector('details.qrest') as HTMLElement).getByText('残り23問'));
    const extra = within(screen.getByRole('list', { name: '残りの出題' })).getAllByRole('button')[0] as HTMLElement;
    await user.click(extra);
    await screen.findByLabelText('理由（1行）');
    expect(document.querySelector('.progress')).toBeNull();
    await solve(user);
    expect(study.rows).toHaveLength(1);
    expect(study.rows[0]?.mode).toBe('quiz');
    // 今日の組に答えていない問題が残っているので、「次の問題へ」は、その先頭へ
    await user.click(screen.getByRole('button', { name: '次の問題へ' }));
    expect(await screen.findByRole('heading', { level: 1, name: '東1局 4巡目' })).toBeInTheDocument();
    expect(document.querySelector('.progress')?.textContent).toBe('1 / 5');
    await user.click(sideButton(/^今日の出題/));
    await screen.findByRole('heading', { level: 1, name: '今日の出題' });
    expect(document.querySelector('.nums')?.textContent).toBe('0 / 5 問を解きました');
    expect(screen.getByText('残り22問')).toBeInTheDocument();
    // 今日の出題の数は、組の分のまま
    expect(sideCount(/^今日の出題/)).toBe('5');
  });

  it('保存できなかったら、答える前の画面のまま理由を出す（AI の評価も、サイドバーの数も変えない）', async () => {
    const { user, study } = setup();
    await loaded();
    await openToday(user);
    await user.click(screen.getByRole('button', { name: '出題を始める' }));
    study.failNextRecord = 'ディスクがいっぱいです';
    await screen.findByLabelText('理由（1行）');
    await user.click(screen.getAllByRole('button', { name: /を切る$/ })[0] as HTMLElement);
    await user.type(screen.getByLabelText('理由（1行）'), '試験');
    await user.click(screen.getByRole('button', { name: '答え合わせ' }));
    expect(await screen.findByText('答えを保存できませんでした: ディスクがいっぱいです')).toBeInTheDocument();
    expect(document.querySelector('[data-ai]')).toBeNull();
    expect(sideCount(/^今日の出題/)).toBe('5');
    expect(study.rows).toHaveLength(0);
    // 押し直すと、通る
    await user.click(screen.getByRole('button', { name: '答え合わせ' }));
    await screen.findByRole('heading', { name: 'AIの評価（Mortal）' });
    expect(study.rows).toHaveLength(1);
  });

  it('鳴きの判断（迷い4）は、ポン・スルーのボタンで解ける。保存される答えは、ボタンの鍵', async () => {
    const { user, study } = setup();
    await loaded();
    await openToday(user);
    await user.click(todayRows()[3] as HTMLElement);
    expect(await screen.findByRole('heading', { level: 1, name: '東2局1本場 8巡目' })).toBeInTheDocument();
    expect(screen.getAllByRole('radio').map((radio) => radio.querySelector('.c-name')?.textContent)).toEqual(['ポン', 'スルー']);
    await solve(user);
    expect(study.rows[0]?.choice).toEqual({ type: 'option', id: 'pon' });
    expect(document.querySelector('[data-ai="ukeire-box"]')).toBeNull();
  });
});

describe('U-17 解き直し', () => {
  /** FX-4 の問題のうち、先頭から 3 つを、期限の違う答えとして保存済みにする（古い順に 10/07・10/08・10/09 が期限）。 */
  function dueStudy() {
    const game = gameOf('fx4');
    const problems = listProblems([{ sessionId: FX4_ID, startedMs: local(2026, 10, 9, 19, 9), game, markKeys: [] }], { threshold: 0.05 });
    const picked = problems.slice(0, 3);
    const due = ['2026-10-09', '2026-10-07', '2026-10-08'];
    const intervals = [3, 1, 7];
    return {
      picked,
      study: new FakeStudyStore(
        picked.map((problem, index) =>
          answerRow({
            id: index + 1,
            session_id: FX4_ID,
            decision_key: problem.key,
            answered_at: 1_000 * (index + 1),
            due_date: due[index] ?? '2026-10-09',
            interval_days: intervals[index] ?? 1,
          }),
        ),
      ),
    };
  }

  it('数（今日が期限の問題）が、サイドバーに出る。期限の古い順に、1 問ずつ。見出しは「解き直し · 今日の期限 3問」と 1 / 3', async () => {
    const { study, picked } = dueStudy();
    const { user } = setup({ study, only: 'fx4' });
    await waitFor(() => expect(sideCount(/^解き直し/)).toBe('3'), LOAD);
    await user.click(sideButton(/^解き直し/));
    await screen.findByLabelText('理由（1行）');
    expect(document.querySelector('.kicker')?.textContent).toBe('解き直し · 今日の期限 3問');
    expect(document.querySelector('.progress')?.textContent).toBe('1 / 3');
    expect(sideButton(/^解き直し/)).toHaveAttribute('aria-current', 'page');
    // いちばん古い期限（10/07）の問題が先頭
    const first = picked[1];
    const decision = findDecisionByKey(gameOf('fx4'), first?.key ?? '');
    expect(screen.getByRole('heading', { level: 1 })).toHaveTextContent(`${decision?.kyokuLabel} ${decision?.junme}巡目`);
  });

  it('実戦の行動と AI の答えは、答え合わせまで画面にも DOM にも出さない。理由は必須', async () => {
    const { study } = dueStudy();
    const { user } = setup({ study, only: 'fx4' });
    await waitFor(() => expect(sideCount(/^解き直し/)).toBe('3'), LOAD);
    await user.click(sideButton(/^解き直し/));
    await screen.findByLabelText('理由（1行）');
    expect(screen.queryByText(/実戦/)).toBeNull();
    expect(document.querySelector('[data-ai]')).toBeNull();
    expect(document.body.innerHTML).not.toMatch(/data-ai|data-mark/);
    expect(document.body.textContent).not.toMatch(/\d\s*%|Mortal|実戦/);
    expect(screen.getByRole('button', { name: '答え合わせ' })).toBeDisabled();
    await user.click(screen.getAllByRole('button', { name: /を切る$/ })[0] as HTMLElement);
    expect(screen.getByRole('button', { name: '答え合わせ' })).toBeDisabled();
    expect(document.getElementById('gate')?.textContent).toBe('理由を1行書くと押せます');
  });

  it('答え合わせで、正解かと、次の解き直しの日・間隔を出す。解き直しの答えも保存される（mode は review）', async () => {
    const { study } = dueStudy();
    const { user } = setup({ study, only: 'fx4' });
    await waitFor(() => expect(sideCount(/^解き直し/)).toBe('3'), LOAD);
    await user.click(sideButton(/^解き直し/));
    await solve(user, '解き直しの理由');
    const verdict = document.querySelector('[data-ai="verdict"]') as HTMLElement;
    expect(['ok', 'ng']).toContain(verdict.getAttribute('data-result'));
    expect(verdict.querySelector('.v-line')?.textContent).toMatch(/^次の解き直し \d+日後（\d+月\d+日）$/);
    const saved = study.rows[3];
    expect(saved).toMatchObject({ mode: 'review', session_id: FX4_ID, reason: '解き直しの理由' });
    // 前の答えの間隔（10/07 の答え = 1 日）から、次の予定が決まる
    expect(saved?.interval_days).toBe(saved?.correct ? 3 : 1);
    // サイドバーの数が減る
    await waitFor(() => expect(sideCount(/^解き直し/)).toBe('2'));
  });

  it('最後まで解くと、結果（何問中、正解いくつ）と、次の解き直しの日を出す。最後の問題のボタンは「解き直しを終える」', async () => {
    const { study } = dueStudy();
    const { user } = setup({ study, only: 'fx4' });
    await waitFor(() => expect(sideCount(/^解き直し/)).toBe('3'), LOAD);
    await user.click(sideButton(/^解き直し/));
    for (let n = 1; n <= 2; n += 1) {
      await solve(user);
      await user.click(screen.getByRole('button', { name: '次の問題へ' }));
      await waitFor(() => expect(document.querySelector('.progress')?.textContent).toBe(`${n + 1} / 3`));
    }
    await solve(user);
    await user.click(screen.getByRole('button', { name: '解き直しを終える' }));
    expect(await screen.findByText(/今日の解き直しは、終わりました（3問のうち、正解 \d問）。/)).toBeInTheDocument();
    expect(screen.getByText(/次の解き直しは、10月1[0-6]日です。/)).toBeInTheDocument();
    expect(sideCount(/^解き直し/)).toBe('0');
  });

  it('今日が期限の問題が無いときは、その旨と、次の解き直しの日（あれば）を出す', async () => {
    const game = gameOf('fx4');
    const [first] = listProblems([{ sessionId: FX4_ID, startedMs: 0, game, markKeys: [] }], { threshold: 0.05 });
    const study = new FakeStudyStore([
      answerRow({ session_id: FX4_ID, decision_key: first?.key ?? 'k0h0e0', due_date: '2026-10-12', interval_days: 3 }),
    ]);
    const { user } = setup({ study, only: 'fx4' });
    await waitFor(() => expect(sideCount(/^解き直し/)).toBe('0'), LOAD);
    await user.click(sideButton(/^解き直し/));
    expect(await screen.findByText(/今日が期限の解き直しはありません。次の解き直しは、10月12日です。/)).toBeInTheDocument();
  });

  it('午前 4 時までは、前の日として数える（3 時半の「今日」は 10 月 9 日。10 月 10 日が期限の問題はまだ出ない）', async () => {
    const game = gameOf('fx4');
    const [first] = listProblems([{ sessionId: FX4_ID, startedMs: 0, game, markKeys: [] }], { threshold: 0.05 });
    const study = new FakeStudyStore([answerRow({ session_id: FX4_ID, decision_key: first?.key ?? 'k0h0e0', due_date: '2026-10-10' })]);
    vi.setSystemTime(new Date(2026, 9, 10, 3, 30, 0));
    setup({ study, only: 'fx4' });
    await waitFor(() => expect(sideCount(/^今日の出題/)).not.toBeNull(), LOAD);
    expect(sideCount(/^解き直し/)).toBe('0');
  });
});

describe('U-9 削除の確認に、解いた問題の数', () => {
  const menuOf = (row: HTMLElement) => within(row.closest('li') as HTMLElement).getByRole('button', { name: /のメニュー/ });

  it('答えの記録に数えてもらう。解いた問題があれば、その数（問題ごとに 1。出題と解き直しは同じ問題）が確認に出る', async () => {
    const game = gameOf('fx4');
    const problems = listProblems([{ sessionId: FX4_ID, startedMs: 0, game, markKeys: [] }], { threshold: 0.05 });
    const [a, b] = problems;
    const study = new FakeStudyStore([
      answerRow({ id: 1, session_id: FX4_ID, decision_key: a?.key ?? '' }),
      answerRow({ id: 2, session_id: FX4_ID, decision_key: b?.key ?? '' }),
      // 同じ問題の解き直しは、数え直さない
      answerRow({ id: 3, session_id: FX4_ID, decision_key: a?.key ?? '', mode: 'review' }),
    ]);
    const { user } = setup({ study });
    await loaded('5');
    const listNav = screen.getByRole('navigation', { name: '半荘の一覧' });
    const fx4Row = within(listNav).getAllByRole('button', { name: /^\d\d:\d\d/ })[0] as HTMLElement;
    await user.click(menuOf(fx4Row));
    await user.click(within(screen.getByRole('menu')).getByRole('menuitem', { name: '削除' }));
    const dialog = screen.getByRole('alertdialog');
    await waitFor(() => expect(dialog).toHaveTextContent('解いた問題 2問と、その解き直しの予定も消えます。'));
    expect(dialog).toHaveTextContent('記録とスクショも消えます。');
  });

  it('答えの記録が無い半荘は、その行を出さない。消すと、その半荘の問題は、今日の出題にも解き直しにも出ない', async () => {
    const { user } = setup();
    await loaded('5');
    const listNav = screen.getByRole('navigation', { name: '半荘の一覧' });
    const fx4Row = within(listNav).getAllByRole('button', { name: /^\d\d:\d\d/ })[0] as HTMLElement;
    await user.click(menuOf(fx4Row));
    await user.click(within(screen.getByRole('menu')).getByRole('menuitem', { name: '削除' }));
    const dialog = screen.getByRole('alertdialog');
    expect(dialog).not.toHaveTextContent('解いた問題');
    await user.click(within(dialog).getByRole('button', { name: '削除' }));
    // FX-4 の問題が消えて、組は f9da だけ（残っている組は、保存済みの組のうち見つかるもの）
    await waitFor(() => expect(sideCount(/^今日の出題/)).toBe('0'), LOAD);
  });
});

describe('U-10 戻る・進む（出題の画面）', () => {
  it('今日の出題 → 出題 → 解き直し を、← → と Alt+← / Alt+→ で行き来する。同じ画面は重ねない', async () => {
    const { user } = setup();
    await loaded();
    await openToday(user);
    await user.click(screen.getByRole('button', { name: '出題を始める' }));
    await screen.findByLabelText('理由（1行）');
    await user.click(sideButton(/^解き直し/));
    expect(await screen.findByText(/今日が期限の解き直しはありません。/)).toBeInTheDocument();
    await user.keyboard('{Alt>}{ArrowLeft}{/Alt}');
    expect(await screen.findByRole('heading', { level: 1, name: '東1局 4巡目' })).toBeInTheDocument();
    await user.keyboard('{Alt>}{ArrowLeft}{/Alt}');
    expect(await screen.findByRole('heading', { level: 1, name: '今日の出題' })).toBeInTheDocument();
    await user.click(screen.getByRole('button', { name: '進む' }));
    expect(await screen.findByRole('heading', { level: 1, name: '東1局 4巡目' })).toBeInTheDocument();
    // 開き直したその問題は、また答える前の画面（答えていない）
    expect(screen.getByLabelText('理由（1行）')).toHaveValue('');
  });

  it('消した半荘の出題は、戻る・進むで飛ばす', async () => {
    const { user } = setup();
    await loaded();
    await openToday(user);
    await user.click(screen.getByRole('button', { name: '出題を始める' }));
    await screen.findByLabelText('理由（1行）');
    await user.click(sideButton(/^解き直し/));
    await screen.findByText(/今日が期限の解き直しはありません。/);
    // FX-4 を消す
    const listNav = screen.getByRole('navigation', { name: '半荘の一覧' });
    const fx4Row = within(listNav).getAllByRole('button', { name: /^\d\d:\d\d/ })[0] as HTMLElement;
    await user.click(within(fx4Row.closest('li') as HTMLElement).getByRole('button', { name: /のメニュー/ }));
    await user.click(within(screen.getByRole('menu')).getByRole('menuitem', { name: '削除' }));
    await user.click(within(screen.getByRole('alertdialog')).getByRole('button', { name: '削除' }));
    await waitFor(() => expect(within(listNav).getAllByRole('button', { name: /^\d\d:\d\d/ })).toHaveLength(1));
    // 戻ると、消した半荘の出題を飛ばして、今日の出題へ
    await user.keyboard('{Alt>}{ArrowLeft}{/Alt}');
    expect(await screen.findByRole('heading', { level: 1, name: '今日の出題' })).toBeInTheDocument();
  });
});
