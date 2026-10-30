/**
 * 読み（F23。ACCEPTANCE の U-53・U-1）の、半荘を通して見る画面の試験。
 * アプリ全体（App）を、半荘の保存先・答えの記録・読みのコマンドの偽物の上で動かして、使う人と同じ操作で確かめる。
 * 半荘は FX-4。読みは本物の出力（reads-fx4.json）。局 0 の 88・96・104・112・120 は、上家（席 3）がリーチ中に自分が打つ場面。
 * 出題・解き直しの画面は ReadsQuiz.test.tsx。実ブラウザでの見え方は tests/browser/reads.browser.test.ts。
 */
import { buildReplayTimeline, tileKind } from '@jantama/engine';
import { act, fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { FakeSessionStore, local, seedSession } from '../../../tests/fake-sessions';
import { FakeStudyStore, gameOf } from '../../../tests/fake-study';
import { fx4Ocr, fx4Session } from '../../../tests/import-fixtures';
import { readsBackend, type ReadsBackendOptions } from '../../../tests/reads-backend';
import { fx4Reads } from '../../../tests/reads-fixtures';
import { installTauriMock } from '../../../tests/tauri-mock';
import { App } from '../App';

vi.mock('@tauri-apps/api/core', () => ({
  invoke: vi.fn(),
  convertFileSrc: (path: string) => path,
}));
vi.mock('@tauri-apps/api/event', () => ({ listen: vi.fn() }));
vi.mock('@tauri-apps/plugin-dialog', () => ({ open: vi.fn() }));

beforeEach(() => {
  vi.useFakeTimers({ toFake: ['Date'] });
  vi.setSystemTime(new Date(2026, 9, 9, 22, 0, 0));
});

afterEach(() => {
  vi.useRealTimers();
});

const FX4_ID = '20261009-190953';
const LOAD = { timeout: 20_000 };
const real = fx4Reads();
const game = gameOf('fx4');
const timeline = buildReplayTimeline(game);
const stepOfEvent = (eventIndex: number): number => (timeline.steps.find((step) => step.eventIndex === eventIndex) as { index: number }).index;

const pct = (probability: number) => Math.round(probability * 100);

function setup(options: ReadsBackendOptions = {}) {
  const sessions = new FakeSessionStore([
    {
      session: fx4Session(FX4_ID, local(2026, 10, 9, 19, 9), { report_path: `C:\\data\\games\\${FX4_ID}\\report.json`, ocr: fx4Ocr() }),
      report: 'fx4',
    },
    seedSession(local(2026, 10, 9, 17, 12), { id: '20261009-171200', report: 'fx1a' }),
  ]);
  const study = new FakeStudyStore();
  const backend = readsBackend({ stored: real, ...options });
  const mock = installTauriMock({ handlers: { ...sessions.handlers, ...study.handlers, ...backend.handlers } });
  const user = userEvent.setup();
  const view = render(<App />);
  return { user, mock, backend, sessions, study, view };
}

const sideCount = (name: RegExp) =>
  within(screen.getByRole('navigation', { name: 'メイン' })).getByRole('button', { name }).querySelector('.count')?.textContent ?? null;

async function loaded() {
  await screen.findByRole('navigation', { name: '半荘の一覧' });
  await waitFor(() => expect(sideCount(/^今日の出題/)).not.toBeNull(), LOAD);
}

async function openReplay(user: ReturnType<typeof userEvent.setup>) {
  await user.click(await screen.findByRole('button', { name: 'この半荘を通して見る' }));
  await screen.findByRole('region', { name: '半荘を進める' });
  // 設定を読めると、切り替えが出る（読めるまでは出さない）
  await screen.findByRole('button', { name: '読み' });
}

function press(init: { code: string; key?: string; repeat?: boolean }) {
  const target = document.activeElement ?? document.body;
  act(() => {
    fireEvent.keyDown(target, { key: init.key ?? init.code, ...init });
  });
}
const PERIOD = { code: 'Period', key: '.' };
const KEY_R = { code: 'KeyR', key: 'r' };

/** 牌譜の位置 `eventIndex` の手まで、1 手ずつ進める。 */
function goToEvent(eventIndex: number) {
  const target = stepOfEvent(eventIndex);
  for (let count = 0; count < target; count += 1) press(PERIOD);
  expect(document.getElementById('pos')?.textContent?.replace(/\s+/g, ' ').trim()).toBe(
    `手 ${timeline.steps[target]!.position + 1} / ${timeline.kyokus[timeline.steps[target]!.kyokuPosition]!.steps.length}`,
  );
}

const toggle = () => screen.getByRole('button', { name: '読み' });
const cells = () => [...document.querySelectorAll<HTMLButtonElement>('.rd-cell')];
const chips = () => [...document.querySelectorAll<HTMLElement>('.rd-tp')];
const waitForCells = () => waitFor(() => expect(cells().length).toBeGreaterThan(0));

describe('U-53 通して見る画面: 「読み」の切り替えは操作の段にあり、盤面を見ているだけの手にある', () => {
  it('悪手・迷いの段の右に、「細かいミスだけ」と同じ見た目で置く。入切は aria-pressed。説明のアイコンが隣にある。設定に項目が無ければ切', async () => {
    const { user, mock } = setup();
    await loaded();
    await openReplay(user);
    const group = document.querySelector('.pb-jumps .pb-reads') as HTMLElement;
    expect(group).not.toBeNull();
    expect(group.closest('.pb-jumps')?.lastElementChild).toBe(group);
    // 悪手・迷いの段は 2 つのまま（読みは「飛ぶ」段ではない）
    expect([...document.querySelectorAll('.pb-jumps .jump')].map((el) => el.getAttribute('data-kind'))).toEqual(['mismatch', 'doubt']);
    const button = within(group).getByRole('button', { name: '読み' });
    expect(button).toHaveAttribute('aria-pressed', 'false');
    expect(button.className).toBe('btn sm fm-toggle');
    expect(button.getAttribute('title')).toContain('（R）');
    expect(within(group).getByRole('button', { name: '読みの説明' })).toBeInTheDocument();
    // 半荘の頭（配牌）には読みの場面が無いが、切り替えは残る
    expect(cells()).toHaveLength(0);
    // 切のあいだは、読みを読まない
    expect(mock.count('read_reads')).toBe(0);
    await user.click(button);
    expect(button).toHaveAttribute('aria-pressed', 'true');
    expect(button.querySelector('svg')).not.toBeNull();
    expect(mock.calls().filter((call) => call.cmd === 'set_reads_visible').map((call) => call.args)).toEqual([{ visible: true }]);
    await waitFor(() => expect(mock.count('read_reads')).toBe(1));
    expect(mock.calls().find((call) => call.cmd === 'read_reads')?.args).toEqual({ sessionId: FX4_ID });
  });

  it('設定の「入」から始まる。自分のツモの手に、手牌の下の数と他家の席の札が出る。読みの場面が無い手（配牌・他家の打牌）では、数も札も出ず、切り替えだけが残る', async () => {
    const { user } = setup({ visible: true });
    await loaded();
    await openReplay(user);
    expect(toggle()).toHaveAttribute('aria-pressed', 'true');
    expect(cells()).toHaveLength(0);
    // 自分の最初のツモ（読みの場面 1 つ目）
    await user.click(screen.getByRole('button', { name: '1手進む' }));
    await waitForCells();
    expect(chips()).toHaveLength(3);
    // 自分の打牌・他家の打牌の手には、読みの場面が無い
    await user.click(screen.getByRole('button', { name: '1手進む' }));
    expect(cells()).toHaveLength(0);
    expect(chips()).toHaveLength(0);
    expect(toggle()).toBeInTheDocument();
    await user.click(screen.getByRole('button', { name: '1手進む' }));
    expect(cells()).toHaveLength(0);
    await user.click(screen.getByRole('button', { name: '1手戻る' }));
    await user.click(screen.getByRole('button', { name: '1手戻る' }));
    await waitForCells();
  });

  it('他家（上家）がリーチ中に自分が打つ場面: 数・札の値が、本物の読みと合う。リーチした上家の席の札は 100%', async () => {
    const { user } = setup({ visible: true });
    await loaded();
    await openReplay(user);
    goToEvent(88);
    await waitForCells();
    const moment = real.moments.find((item) => item.event_index === 88)!;
    const step = timeline.steps[stepOfEvent(88)]!;
    const items = [...step.board.hand, ...(step.board.drawn === null ? [] : [step.board.drawn])];
    expect(cells()).toHaveLength(items.length);
    cells().forEach((cell, index) => {
      expect(cell.querySelector('.rd-n')?.textContent).toBe(String(pct(moment.any_wait[tileKind(items[index]!)] as number)));
    });
    const byStep = new Map(moment.opponents.map((opponent) => [opponent.step, opponent]));
    expect(document.querySelector('.score.left .rd-tp')?.getAttribute('aria-label')).toBe(`聴牌 ${pct(byStep.get(3)!.tenpai)}%`);
    expect(document.querySelector('.score.top .rd-tp')?.getAttribute('aria-label')).toBe(`聴牌 ${pct(byStep.get(2)!.tenpai)}%`);
    expect(document.querySelector('.score.right .rd-tp')?.getAttribute('aria-label')).toBe(`聴牌 ${pct(byStep.get(1)!.tenpai)}%`);
    // 数を押すと、この場面の吹き出し（上家のリーチ・守備の目安・実際の待ち）が出る
    await user.click(cells()[0] as HTMLElement);
    const dialog = await screen.findByRole('dialog', { name: /だれかが待っている確率/ });
    expect(within(dialog).getByText('上家（リーチ）')).toBeInTheDocument();
    expect(dialog.textContent).toContain('上家の実際の待ち: 發');
    // 吹き出しの中では、手を進めるキーは働かない。外から手を進めると、吹き出しは閉じる（見せる場面が替わるため）
    press(PERIOD);
    expect(document.getElementById('rdpop')).not.toBeNull();
    act(() => {
      fireEvent.keyDown(document.body, { code: 'Period', key: '.' });
    });
    await waitFor(() => expect(document.getElementById('rdpop')).toBeNull());
  });

  it('切り替えは、切にすると、数も札も消える。キー（R）でも切り替わる（割り当ての表にある操作）。押しっぱなしの繰り返しでは働かない', async () => {
    const { user, mock } = setup({ visible: true });
    await loaded();
    await openReplay(user);
    goToEvent(88);
    await waitForCells();
    await user.click(toggle());
    expect(toggle()).toHaveAttribute('aria-pressed', 'false');
    expect(cells()).toHaveLength(0);
    expect(chips()).toHaveLength(0);
    (document.activeElement as HTMLElement).blur();
    press(KEY_R);
    await waitFor(() => expect(toggle()).toHaveAttribute('aria-pressed', 'true'));
    await waitForCells();
    press({ ...KEY_R, repeat: true });
    expect(toggle()).toHaveAttribute('aria-pressed', 'true');
    press(KEY_R);
    await waitFor(() => expect(toggle()).toHaveAttribute('aria-pressed', 'false'));
    expect(mock.calls().filter((call) => call.cmd === 'set_reads_visible').map((call) => call.args)).toEqual([
      { visible: false },
      { visible: true },
      { visible: false },
    ]);
  });
});

describe('U-1・U-53 答える場面は、答えるまで、読みの切り替えも数も札も DOM に無い', () => {
  /** 悪手の場面（FX-4 の最初の悪手。局 0 の 4 手目付近）へ、「次の悪手へ」で飛ぶ。 */
  async function gotoMismatch(user: ReturnType<typeof userEvent.setup>) {
    await user.click(screen.getByRole('button', { name: /^次の悪手へ/ }));
    await waitFor(() => expect(document.querySelector('.qz')?.getAttribute('data-state')).toBe('answering'));
  }

  it('設定が「入」でも、答える前の場面には、切り替え・説明のアイコン・数・札・状態の行・読みのコマンドの呼び出しが無い。答えると、切り替えが出る', async () => {
    const { user, mock } = setup({ visible: true });
    await loaded();
    await openReplay(user);
    await waitFor(() => expect(mock.count('read_reads')).toBe(1));
    await gotoMismatch(user);
    expect(screen.queryByRole('button', { name: '読み' })).toBeNull();
    expect(screen.queryByRole('button', { name: '読みの説明' })).toBeNull();
    expect(document.querySelector('.pb-reads, .reads-group, .rd-cell, .rd-tp, .rd-status, #rdpop')).toBeNull();
    expect(document.querySelector('[data-ai]')).toBeNull();
    expect(document.body.textContent).not.toMatch(/\d\s*%|Mortal/);
    // 答える前の場面で R を押しても、何も起きない
    (document.activeElement as HTMLElement).blur();
    press(KEY_R);
    expect(mock.count('set_reads_visible')).toBe(0);
    // 答えると、切り替えが出る
    await user.click(screen.getAllByRole('button', { name: /を切る$/ }).at(-1) as HTMLElement);
    await user.type(screen.getByLabelText('理由（1行）'), '理由');
    await user.click(screen.getByRole('button', { name: '答え合わせ' }));
    await waitFor(() => expect(document.getElementById('reveal-h')).not.toBeNull());
    expect(await screen.findByRole('button', { name: '読み' })).toHaveAttribute('aria-pressed', 'true');
    // 答えたあとの場面では、R で切り替わる
    (document.activeElement as HTMLElement).blur();
    press(KEY_R);
    await waitFor(() => expect(toggle()).toHaveAttribute('aria-pressed', 'false'));
    expect(mock.count('set_reads_visible')).toBe(1);
  });

  it('迷いのカードの「この局面を解く」で、答える場面から開いたときは、答えるまで、読みのコマンドを 1 つも呼ばない', async () => {
    const { user, mock } = setup({ visible: true });
    await loaded();
    await user.click(await screen.findByRole('button', { name: 'この局面を解く（迷い3）' }));
    await screen.findByRole('region', { name: '半荘を進める' });
    expect(document.querySelector('.qz')?.getAttribute('data-state')).toBe('answering');
    expect(screen.queryByRole('button', { name: '読み' })).toBeNull();
    expect(document.querySelector('[data-ai]')).toBeNull();
    for (const command of ['read_reads', 'get_reads_model', 'compute_reads', 'set_reads_visible']) expect(mock.count(command), command).toBe(0);
    await user.click(screen.getAllByRole('button', { name: /を切る$/ }).at(-1) as HTMLElement);
    await user.type(screen.getByLabelText('理由（1行）'), '理由');
    await user.click(screen.getByRole('button', { name: '答え合わせ' }));
    await waitFor(() => expect(document.getElementById('reveal-h')).not.toBeNull());
    await waitFor(() => expect(mock.count('read_reads')).toBe(1));
  });

  it('答えた場面を離れて、盤面を見ているだけの手へ行くと、切り替えは残る。答える前の場面へ行くと、また無い', async () => {
    const { user } = setup({ visible: true });
    await loaded();
    await openReplay(user);
    await gotoMismatch(user);
    expect(screen.queryByRole('button', { name: '読み' })).toBeNull();
    await user.click(screen.getByRole('button', { name: '1手進む' }));
    expect(await screen.findByRole('button', { name: '読み' })).toBeInTheDocument();
    await user.click(screen.getByRole('button', { name: '1手戻る' }));
    expect(screen.queryByRole('button', { name: '読み' })).toBeNull();
  });
});

describe('U-53 用意の様子（通して見る画面）', () => {
  it('読みが無ければ計算する: 右の欄の上に進み具合。終わると行は消えて、数が出る', async () => {
    const { user, backend, mock } = setup({ visible: true, stored: null });
    await loaded();
    await openReplay(user);
    const status = await screen.findByText(/読みを計算しています/);
    expect(status.closest('.answer')).not.toBeNull();
    await waitFor(() => expect(backend.state.computeCalls).toBe(1));
    act(() => mock.emit('reads-progress', { session_id: FX4_ID, done: 64, total: 117 }));
    await waitFor(() => expect(status).toHaveTextContent('読みを計算しています… 64/117'));
    act(() => backend.state.release?.());
    await waitFor(() => expect(screen.queryByText(/読みを計算しています/)).toBeNull());
    goToEvent(88);
    await waitForCells();
  });

  it('モデルが入っていないとき: 案内と「設定を開く」。押すと設定のページが開く', async () => {
    const { user } = setup({ visible: true, stored: null, installed: false });
    await loaded();
    await openReplay(user);
    expect(await screen.findByText(/読みのモデルが入っていません。/)).toBeInTheDocument();
    await user.click(screen.getByRole('button', { name: '設定を開く' }));
    expect(await screen.findByRole('heading', { level: 1, name: '設定' })).toBeInTheDocument();
    expect(screen.queryByRole('region', { name: '半荘を進める' })).toBeNull();
  });

  it('失敗したら、理由つきの知らせと「もう一度」', async () => {
    const { user, backend } = setup({ visible: true, stored: null });
    await loaded();
    await openReplay(user);
    await waitFor(() => expect(backend.state.computeCalls).toBe(1));
    act(() => backend.state.fail?.('エンジンを起こせませんでした'));
    const alert = await screen.findByRole('alert');
    expect(alert).toHaveTextContent('読みを出せませんでした: エンジンを起こせませんでした');
    await user.click(within(alert).getByRole('button', { name: 'もう一度' }));
    await waitFor(() => expect(backend.state.computeCalls).toBe(2));
    act(() => backend.state.release?.());
    await waitFor(() => expect(screen.queryByRole('alert')).toBeNull());
  });
});
