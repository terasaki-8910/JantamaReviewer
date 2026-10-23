/**
 * 迷いのスクショの欄（F12、U-45）の、出題・解き直しの画面の試験:
 * - 迷いマークを結びつけた問題の、答えの欄のいちばん上に出る。出題は答える前から、解き直しは答え合わせのあとだけ（U-1 の考え方。打牌の直後に押したスクショには、実戦の打牌が写るため）
 * - 小さな写真・「迷いN」・推定／選んだの札・スクショから読んだ値・前／次の手へ付け替えるボタン
 * - 付け替えは、半荘のページと同じ保存（set_mark_link。Ctrl+Z で戻る）。出題は、その問題のまま、読み上げの文を出す。端の判断では押せない
 * 通して見る画面（付け替えた先の場面へ移る）と、写真の大きな表示（Esc・外の押下で閉じて、写真へ戻る）は、replay/Replay.test.tsx。
 */
import { invoke } from '@tauri-apps/api/core';
import { listDecisionRefs } from '@jantama/engine';
import { cleanup, screen, waitFor, within } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { local } from '../../../tests/fake-sessions';
import { fx4Ocr, fx4Session } from '../../../tests/import-fixtures';
import { revealed } from '../../../tests/reveal';
import { game, renderQuiz } from '../../../tests/study-harness';
import { installTauriMock, type TauriMock } from '../../../tests/tauri-mock';
import type { Links, SessionRecord } from '../../api/types';

vi.mock('@tauri-apps/api/core', () => ({
  invoke: vi.fn(),
  convertFileSrc: (path: string) => path,
}));
vi.mock('@tauri-apps/api/event', () => ({ listen: vi.fn() }));

/** 試験の「いま」: 2026 年 10 月 9 日 22:00（日付だけ動かす）。 */
beforeEach(() => {
  vi.useFakeTimers({ toFake: ['Date'] });
  vi.setSystemTime(new Date(2026, 9, 9, 22, 0, 0));
});

afterEach(() => {
  cleanup();
  vi.useRealTimers();
});

const refs = listDecisionRefs(game('fx4').report);
const refAt = (key: string) => {
  const at = refs.findIndex((ref) => ref.key === key);
  return { prev: refs[at - 1], here: refs[at], next: refs[at + 1] };
};

/** FX-4 の半荘（迷い 1〜6 の写真と読み取りの写しつき）。`links` は、利用者が選んだ結びつけ。 */
function session(links: Links = { marks: {}, ratings: {} }, edit: (record: SessionRecord) => SessionRecord = (record) => record): SessionRecord {
  return edit(fx4Session('sess', local(2026, 10, 9, 19, 9), { report_path: 'C:\\data\\games\\sess\\report.json', ocr: fx4Ocr(), links }));
}

/** 迷い 3 の問題（FX-4 東2局1本場 6巡目の打牌。推定の結びつけ）。 */
const QUIZ_KEY = 'k1h1e7';

const block = () => document.querySelector<HTMLElement>('[data-shots="block"]');
const submit = () => screen.getByRole('button', { name: '答え合わせ' });

async function answer(user: ReturnType<typeof renderQuiz>['user']) {
  await user.click(screen.getAllByRole('button', { name: /を切る$/ })[5] as HTMLElement);
  await user.type(screen.getByLabelText('理由（1行）'), '形を崩さないほうを残す');
  await user.click(submit());
  await revealed();
}

describe('U-45 迷いのスクショの欄: 出す場面', () => {
  it('出題: 迷いマークを結びつけた問題は、答える前から、答えの欄のいちばん上に出る。場面の 1 行・答えの欄より前', () => {
    renderQuiz({ report: 'fx4', key: QUIZ_KEY, session: session() });
    const shots = block() as HTMLElement;
    expect(shots).not.toBeNull();
    expect(within(shots).getByRole('heading', { level: 2, name: '迷いのスクショ' })).toBeInTheDocument();
    expect(document.querySelector('.answer-scroll')?.firstElementChild).toBe(shots);
    expect(shots.compareDocumentPosition(document.querySelector('.scene-line') as HTMLElement)).toBe(Node.DOCUMENT_POSITION_FOLLOWING);
  });

  it('答え合わせのあとも、答えの欄のいちばん上（上の段の「次の問題へ」の下、答えの内容の上）', async () => {
    const { user } = renderQuiz({ report: 'fx4', key: QUIZ_KEY, session: session() });
    await answer(user);
    const shots = block() as HTMLElement;
    expect(shots).not.toBeNull();
    expect(document.querySelector('.answer-scroll')?.firstElementChild).toBe(shots);
    expect(shots.compareDocumentPosition(document.getElementById('review') as HTMLElement)).toBe(Node.DOCUMENT_POSITION_FOLLOWING);
    expect(document.querySelector('.answer')?.firstElementChild).toHaveClass('answer-bar');
  });

  it('迷いマークの結びつかない問題（大きな不一致だけ）には、出ない', () => {
    renderQuiz({ report: 'fx4', key: 'k1h1e9', session: session() });
    expect(block()).toBeNull();
    expect(screen.queryByText('迷いのスクショ')).toBeNull();
  });

  it('迷いマークの無い半荘（迷いの記録が無い）には、出ない', () => {
    renderQuiz({ report: 'fx4', key: QUIZ_KEY });
    expect(block()).toBeNull();
  });

  it('解き直しでは、答える前は DOM に無い。答え合わせのあとに出る', async () => {
    const { user } = renderQuiz({ report: 'fx4', key: QUIZ_KEY, session: session(), mode: 'review', previousIntervalDays: 3 });
    expect(block()).toBeNull();
    expect(document.querySelector('[data-shot], .mthumb, .shot')).toBeNull();
    expect(document.body.textContent).not.toContain('迷いのスクショ');
    await answer(user);
    expect(block()).not.toBeNull();
    expect(screen.getByRole('button', { name: '迷い3の画像を大きく見る' })).toBeInTheDocument();
  });

  it('AI の情報は含まない（確率・順位・data-ai）。答える前から出してよい', () => {
    renderQuiz({ report: 'fx4', key: QUIZ_KEY, session: session() });
    const shots = block() as HTMLElement;
    expect(shots.querySelector('[data-ai]')).toBeNull();
    expect(shots.textContent).not.toMatch(/\d\s*%|Mortal|AI/);
    expect(document.querySelector('[data-ai]')).toBeNull();
  });
});

describe('U-45 迷いのスクショの欄: 中身', () => {
  it('小さな写真（押せる。名前「迷い3の画像を大きく見る」）・「迷い3」・札「推定」・スクショから読んだ値（迷いのカードと同じ書き方）', () => {
    renderQuiz({ report: 'fx4', key: QUIZ_KEY, session: session() });
    const shots = block() as HTMLElement;
    const item = shots.querySelector('.shot') as HTMLElement;
    const thumb = within(item).getByRole('button', { name: '迷い3の画像を大きく見る' });
    expect(thumb.className).toBe('mthumb');
    expect(within(thumb).getByRole('img', { name: '迷い3のスクリーンショット' })).toHaveAttribute('src', 'C:\\data\\games\\sess\\marks\\m3.png');
    expect(item.querySelector('.shot-n')?.textContent).toBe('迷い3');
    expect(item.querySelector('.tag.est')?.textContent).toBe('推定');
    expect(item.querySelector('.shot-read')?.textContent).toBe('スクショ: 東2局・残り47・15,100点');
    expect(within(item).getByRole('button', { name: '迷い3を前の手に付け替える' })).toHaveTextContent('前の手に付け替える');
    expect(within(item).getByRole('button', { name: '迷い3を次の手に付け替える' })).toHaveTextContent('次の手に付け替える');
  });

  it('利用者が選んだ結びつけは、札「選んだ」（推定ではない）', () => {
    renderQuiz({ report: 'fx4', key: QUIZ_KEY, session: session({ marks: { '3': QUIZ_KEY }, ratings: {} }) });
    const item = block()?.querySelector('.shot') as HTMLElement;
    expect(item.querySelector('.tag.est')).toBeNull();
    expect(within(item).getByText('選んだ')).toBeInTheDocument();
  });

  it('同じ判断に結びつく迷いが 2 つ以上あれば、迷いの番号の順に並ぶ', () => {
    renderQuiz({ report: 'fx4', key: QUIZ_KEY, session: session({ marks: { '5': QUIZ_KEY, '2': QUIZ_KEY }, ratings: {} }) });
    const items = [...(block()?.querySelectorAll('.shot') ?? [])];
    expect(items.map((item) => item.querySelector('.shot-n')?.textContent)).toEqual(['迷い2', '迷い3', '迷い5']);
    expect(items.map((item) => item.querySelector('.tag')?.textContent)).toEqual(['選んだ', '推定', '選んだ']);
  });

  it('スクショが無い迷い（撮れなかった）は、迷いのカードと同じ「画像なし」の箱', () => {
    renderQuiz({
      report: 'fx4',
      key: QUIZ_KEY,
      session: session(undefined, (record) => ({
        ...record,
        marks: record.marks.map((mark) => (mark.id === 3 ? { ...mark, screenshot_path: null, capture_error: '撮れませんでした' } : mark)),
      })),
    });
    const item = block()?.querySelector('.shot') as HTMLElement;
    expect(item.querySelector('.mthumb')).toBeNull();
    const empty = item.querySelector('.mthumb-empty') as HTMLElement;
    expect(empty.textContent).toBe('画像なし');
    expect(empty.getAttribute('title')).toBe('撮れませんでした');
    // 値と付け替えのボタンは、写真が無くても出る
    expect(item.querySelector('.shot-read')?.textContent).toContain('スクショ: 東2局');
    expect(within(item).getByRole('button', { name: '迷い3を次の手に付け替える' })).toBeEnabled();
  });
});

describe('U-45 迷いのスクショの欄: 前の手・次の手に付け替える（半荘のページと同じ保存。取り消せる）', () => {
  let mock: TauriMock;
  beforeEach(() => {
    mock = installTauriMock({ handlers: { set_mark_link: () => undefined, clear_mark_link: () => undefined } });
  });
  const saves = () => mock.calls().filter((call) => call.cmd === 'set_mark_link' || call.cmd === 'clear_mark_link');
  const live = () => document.querySelector('[data-live="relinked"]') as HTMLElement;

  it('「次の手に付け替える」: 次の判断の鍵で保存する（ユーザーの選び）。その問題のまま、読み上げの文を出す。キーボードの位置は答えの欄へ', async () => {
    const { user } = renderQuiz({ report: 'fx4', key: QUIZ_KEY, session: session() });
    const { next } = refAt(QUIZ_KEY);
    expect(next).toBeDefined();
    await user.click(screen.getByRole('button', { name: '迷い3を次の手に付け替える' }));
    await waitFor(() => expect(live().textContent).toBe(`迷い3を${next?.label}に付け替えました`));
    expect(saves()).toEqual([{ cmd: 'set_mark_link', args: { sessionId: 'sess', markId: 3, decision: next?.key } }]);
    // 問題は、そのまま（見出しも、答える前の欄も）
    expect(screen.getByRole('heading', { level: 1, name: '東2局1本場 6巡目' })).toBeInTheDocument();
    expect(screen.getByRole('button', { name: '答え合わせ' })).toBeDisabled();
    expect(live().getAttribute('aria-live')).toBe('polite');
    expect(document.getElementById('answer')).toHaveFocus();
  });

  it('「前の手に付け替える」: 前の判断の鍵で保存する', async () => {
    const { user } = renderQuiz({ report: 'fx4', key: QUIZ_KEY, session: session() });
    const { prev } = refAt(QUIZ_KEY);
    await user.click(screen.getByRole('button', { name: '迷い3を前の手に付け替える' }));
    await waitFor(() => expect(saves()).toHaveLength(1));
    expect(saves()[0]).toEqual({ cmd: 'set_mark_link', args: { sessionId: 'sess', markId: 3, decision: prev?.key } });
    await waitFor(() => expect(live().textContent).toBe(`迷い3を${prev?.label}に付け替えました`));
  });

  it('Ctrl+Z で、付け替える前に戻る: 保存した選びが無かった（推定）なら、選びを消す。あったなら、前の選びに戻す', async () => {
    const first = renderQuiz({ report: 'fx4', key: QUIZ_KEY, session: session() });
    await first.user.click(screen.getByRole('button', { name: '迷い3を次の手に付け替える' }));
    await waitFor(() => expect(saves()).toHaveLength(1));
    await first.user.keyboard('{Control>}z{/Control}');
    await waitFor(() => expect(saves()).toHaveLength(2));
    expect(saves()[1]).toEqual({ cmd: 'clear_mark_link', args: { sessionId: 'sess', markId: 3 } });
    // やり直し
    await first.user.keyboard('{Control>}y{/Control}');
    await waitFor(() => expect(saves()).toHaveLength(3));
    expect(saves()[2]?.cmd).toBe('set_mark_link');
    first.unmount();

    mock = installTauriMock({ handlers: { set_mark_link: () => undefined, clear_mark_link: () => undefined } });
    const second = renderQuiz({ report: 'fx4', key: QUIZ_KEY, session: session({ marks: { '3': QUIZ_KEY }, ratings: {} }) });
    await second.user.click(screen.getByRole('button', { name: '迷い3を前の手に付け替える' }));
    await waitFor(() => expect(saves()).toHaveLength(1));
    await second.user.keyboard('{Control>}z{/Control}');
    await waitFor(() => expect(saves()).toHaveLength(2));
    expect(saves()[1]).toEqual({ cmd: 'set_mark_link', args: { sessionId: 'sess', markId: 3, decision: QUIZ_KEY } });
  });

  it('最初の判断では「前の手に」、最後の判断では「次の手に」が押せない', () => {
    const first = refs[0]!;
    const last = refs.at(-1)!;
    const edge = renderQuiz({ report: 'fx4', key: first.key, session: session({ marks: { '1': first.key }, ratings: {} }) });
    expect(screen.getByRole('button', { name: '迷い1を前の手に付け替える' })).toBeDisabled();
    expect(screen.getByRole('button', { name: '迷い1を次の手に付け替える' })).toBeEnabled();
    edge.unmount();
    renderQuiz({ report: 'fx4', key: last.key, session: session({ marks: { '6': last.key }, ratings: {} }) });
    expect(screen.getByRole('button', { name: '迷い6を前の手に付け替える' })).toBeEnabled();
    expect(screen.getByRole('button', { name: '迷い6を次の手に付け替える' })).toBeDisabled();
  });

  it('保存できなかったら、読み上げの文は出さず、ボタンはもう一度押せる', async () => {
    mock = installTauriMock({
      handlers: {
        set_mark_link: () => {
          throw new Error('保存できません');
        },
      },
    });
    const { user } = renderQuiz({ report: 'fx4', key: QUIZ_KEY, session: session() });
    await user.click(screen.getByRole('button', { name: '迷い3を次の手に付け替える' }));
    await waitFor(() => expect(vi.mocked(invoke)).toHaveBeenCalledWith('set_mark_link', expect.anything()));
    await waitFor(() => expect(screen.getByRole('button', { name: '迷い3を次の手に付け替える' })).toBeEnabled());
    expect(live().textContent).toBe('');
    expect(screen.getByRole('button', { name: '迷い3を前の手に付け替える' })).toBeEnabled();
  });

  it('答え合わせのあとにも付け替えられる。答えと理由は、そのまま', async () => {
    const { user, probe } = renderQuiz({ report: 'fx4', key: QUIZ_KEY, session: session() });
    await answer(user);
    await user.click(screen.getByRole('button', { name: '迷い3を次の手に付け替える' }));
    await waitFor(() => expect(saves()).toHaveLength(1));
    expect(probe.recorded).toHaveLength(1);
    expect(document.getElementById('reveal-h')).not.toBeNull();
  });
});
