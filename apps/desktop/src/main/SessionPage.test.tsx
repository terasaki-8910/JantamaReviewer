/**
 * 半荘のページ（ACCEPTANCE の U-1・U-8・U-11、SPEC の F3・F9・F10）の、画面の試験。
 * 半荘の保存先の偽物（FakeSessionStore）の上で、取り込んだ半荘（FX-4）と、取り込む前の半荘を出して、使う人と同じ操作で確かめる。
 * 画像の大きな表示（Lightbox）は、ここでは「開く求めが出ること」まで。表示そのものは Lightbox.test.tsx と、App 全体の試験が確かめる。
 * 実ブラウザでの見え方（横スクロール・axe・描かれた色）は、tests/browser/hanchan.browser.test.ts が確かめる。
 */
import { actionLabel, listDecisionRefs, parseReportText, type MortalReport } from '@jantama/engine';
import { render, screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { useCallback, useMemo, useState } from 'react';
import { beforeEach, describe, expect, it, vi } from 'vitest';

import { FakeSessionStore, REPORT_TEXTS, local } from '../../tests/fake-sessions';
import { FX4_TEXT, fx4Ocr, fx4Session } from '../../tests/import-fixtures';
import { installTauriMock } from '../../tests/tauri-mock';
import type { Links, Rating, SessionRecord } from '../api/types';
import { SessionPage } from './SessionPage';
import { summarizeReportText, type SummaryState } from './sessionSummaries';
import { UndoProvider } from './undo/UndoProvider';

vi.mock('@tauri-apps/api/core', () => ({
  invoke: vi.fn(),
  convertFileSrc: (path: string) => `asset://localhost/${encodeURIComponent(path)}`,
}));
vi.mock('@tauri-apps/api/event', () => ({ listen: vi.fn() }));

const ID = '20261009-190953';
const STARTED = local(2026, 10, 9, 19, 9);

/** 取り込みが保存するとおりの結びつけ（迷い 1〜3 は 1 つに決まって保存、評価 7〜11 は局の順）。 */
const IMPORTED_LINKS: Links = {
  marks: { '1': 'k0h0e4', '2': 'k1h0e13', '3': 'k1h1e7' },
  ratings: { '7': 'k0h0', '8': 'k1h0', '9': 'k1h1', '10': 'k2h0', '11': 'k2h1' },
};

/** 取り込んだ半荘: FX-4。ウィジェットの評価は、局の順に △・✕・△・✕・✕。 */
function imported(overrides: Partial<SessionRecord> = {}): SessionRecord {
  const base = fx4Session(ID, STARTED, {
    report_path: `C:\\data\\games\\${ID}\\report.json`,
    ocr: fx4Ocr(),
    links: IMPORTED_LINKS,
    ...overrides,
  });
  const ratings: Rating[] = ['fair', 'bad', 'fair', 'bad', 'bad'];
  return { ...base, ratings: base.ratings.map((r, i) => ({ ...r, rating: ratings[i] ?? r.rating })) };
}

/** 取り込む前の半荘: 迷い 2（1 つは画像なし）と評価 3。 */
function recorded(): SessionRecord {
  const base = fx4Session('20261009-161200', local(2026, 10, 9, 16, 12));
  const [first, second] = base.marks;
  return {
    ...base,
    mark_count: 2,
    marks: [
      { ...(first as SessionRecord['marks'][number]), t_ms: local(2026, 10, 9, 16, 14, 32) },
      {
        ...(second as SessionRecord['marks'][number]),
        t_ms: local(2026, 10, 9, 16, 20, 5),
        screenshot: null,
        capture: null,
        capture_error: '画面を撮れませんでした',
        screenshot_path: null,
      },
    ],
    rating_count: 3,
    ratings: [
      { id: 7, t_ms: local(2026, 10, 9, 16, 15, 0), rating: 'good', hand: 1 },
      { id: 9, t_ms: local(2026, 10, 9, 16, 22, 0), rating: 'bad', hand: 2 },
      { id: 11, t_ms: local(2026, 10, 9, 16, 30, 0), rating: 'fair', hand: 3 },
    ],
  };
}

const summaryOf = (key: keyof typeof REPORT_TEXTS = 'fx4'): SummaryState => summarizeReportText(REPORT_TEXTS[key]);

interface SetupOptions {
  session?: SessionRecord;
  /** 取り込んだ結果。既定は FX-4。null なら、結果を読み出せない。 */
  report?: keyof typeof REPORT_TEXTS | null;
  /** 画面に渡すまとめ。既定は、結果から作ったもの。 */
  summary?: SummaryState | undefined;
  handlers?: Record<string, (args: unknown) => unknown>;
}

function setup(options: SetupOptions = {}) {
  const session = options.session ?? imported();
  const store = new FakeSessionStore([{ session, ...(options.report === null ? {} : { report: options.report ?? 'fx4' }) }]);
  const mock = installTauriMock({ handlers: { ...store.handlers, ...options.handlers } });
  const user = userEvent.setup();
  const onOpenImage = vi.fn();
  const summary = 'summary' in options ? options.summary : session.report_path === null ? undefined : summaryOf();

  function Harness() {
    const [current, setCurrent] = useState(() => store.session(session.id));
    const reload = useCallback(async () => setCurrent(store.session(session.id)), []);
    const stable = useMemo(() => summary, []);
    return (
      <UndoProvider>
        <SessionPage session={current} summary={stable} onChanged={reload} onOpenImage={onOpenImage} />
      </UndoProvider>
    );
  }
  render(<Harness />);
  return { store, mock, user, onOpenImage };
}

/** 結果を読み終えて、局の評価の表が出るまで待つ。 */
const tableReady = () => screen.findByRole('table', { name: '局の評価' });

const card = (n: number) => screen.getByRole('article', { name: `迷い${n}` });
const calls = (mock: ReturnType<typeof setup>['mock'], cmd: string) =>
  mock.calls().filter((c) => c.cmd === cmd).map((c) => c.args);
const undoKey = (user: ReturnType<typeof userEvent.setup>) => user.keyboard('{Control>}z{/Control}');
const redoKey = (user: ReturnType<typeof userEvent.setup>) => user.keyboard('{Control>}y{/Control}');

beforeEach(() => {
  document.body.className = '';
});

describe('U-8 半荘のページの見出し', () => {
  it('取り込み前は、見出しは日時だけ。「取り込み前」と、迷いと評価の数。段階の印は出さない', () => {
    setup({ session: recorded() });
    expect(screen.getByRole('heading', { level: 1, name: '10月9日(金) 16:12' })).toBeInTheDocument();
    expect(screen.getByText('取り込み前 · 迷い 2 · 評価 3')).toBeInTheDocument();
    expect(document.querySelector('.grade')).toBeNull();
  });

  it('取り込み済みは、見出しに卓、右に段階の印（大）と Rating。「5局 · 東3局1本場で終了」', async () => {
    setup();
    await tableReady();
    expect(screen.getByRole('heading', { level: 1, name: '10月9日(金) 19:09 · 玉の間・南' })).toBeInTheDocument();
    expect(screen.getByText('5局 · 東3局1本場で終了')).toBeInTheDocument();
    const summary = summaryOf();
    const badge = document.querySelector('.head .grade.lg');
    expect(badge).not.toBeNull();
    expect(badge?.textContent).toBe(summary.status === 'ready' ? summary.summary.grade : '');
    expect(screen.getByText('93.0', { selector: '.rate-num' })).toBeInTheDocument();
    expect(screen.getByText('Rating')).toBeInTheDocument();
  });

  it('結果を読んでいる間は、迷いと評価の数。読めなかったときは、理由を添える。どちらも段階の印は出さない', () => {
    const { unmount } = render(
      <UndoProvider>
        <SessionPage session={imported()} summary={{ status: 'loading' }} />
      </UndoProvider>,
    );
    expect(screen.getByText('迷い 6 · 評価 5')).toBeInTheDocument();
    expect(document.querySelector('.grade')).toBeNull();
    unmount();
    render(
      <UndoProvider>
        <SessionPage session={imported()} summary={{ status: 'unavailable', reason: '形が合いません' }} />
      </UndoProvider>,
    );
    expect(screen.getByText('取り込んだ結果を読めませんでした（形が合いません）')).toBeInTheDocument();
    expect(document.querySelector('.grade')).toBeNull();
  });
});

describe('F9 迷いのカード（取り込む前）', () => {
  it('「迷いN」と時刻と画像だけ。結びつけの欄（局面・候補・選び直す）は出さない', () => {
    setup({ session: recorded() });
    const list = screen.getByRole('list', { name: '迷いマークの一覧' });
    expect(screen.getByRole('heading', { level: 2, name: '迷い（2）' })).toBeInTheDocument();
    expect(within(list).getAllByRole('article')).toHaveLength(2);
    const first = card(1);
    expect(within(first).getByRole('heading', { level: 3, name: '迷い1' })).toBeInTheDocument();
    expect(within(first).getByText('16:14:32')).toBeInTheDocument();
    const image = within(first).getByAltText('迷い1のスクリーンショット');
    expect(image).toHaveAttribute('src', `asset://localhost/${encodeURIComponent('C:\\data\\games\\20261009-161200\\marks\\m1.png')}`);
    expect(image).toHaveAttribute('draggable', 'false');
    expect(within(first).getByRole('button', { name: '迷い1の画像を大きく見る' })).toBeInTheDocument();
    expect(first.querySelector('.mwhat, .msub, .mctl')).toBeNull();
    expect(screen.queryByRole('button', { name: /選び直す|手で選ぶ/ })).toBeNull();
  });

  it('画像を撮れなかった迷いは、同じ大きさの「画像なし」の箱（押せない）。時刻は残す', () => {
    setup({ session: recorded() });
    const second = card(2);
    expect(within(second).getByText('画像なし')).toBeInTheDocument();
    expect(within(second).getByText('16:20:05')).toBeInTheDocument();
    expect(within(second).queryByRole('button')).toBeNull();
  });

  it('評価は、押した順に、何局目かと〇△✕の一覧（局の評価の表は出さない）', () => {
    setup({ session: recorded() });
    expect(screen.getByRole('heading', { level: 2, name: '評価（3）' })).toBeInTheDocument();
    const list = screen.getByRole('list', { name: '局の評価の一覧' });
    const rows = within(list).getAllByRole('listitem');
    expect(rows).toHaveLength(3);
    expect(rows[0]).toHaveTextContent('1局目');
    expect(within(rows[0] as HTMLElement).getByRole('img', { name: '〇' })).toBeInTheDocument();
    expect(rows[1]).toHaveTextContent('2局目');
    expect(within(rows[1] as HTMLElement).getByRole('img', { name: '✕' })).toBeInTheDocument();
    expect(rows[2]).toHaveTextContent('3局目');
    expect(within(rows[2] as HTMLElement).getByRole('img', { name: '△' })).toBeInTheDocument();
    expect(rows[0]).toHaveTextContent('16:15:00');
    expect(screen.queryByRole('table')).toBeNull();
  });

  it('記録が何も無い半荘は、短い文で示す', () => {
    const empty: SessionRecord = { ...recorded(), marks: [], ratings: [], mark_count: 0, rating_count: 0 };
    setup({ session: empty });
    expect(screen.getByText('迷いの記録はありません。')).toBeInTheDocument();
    expect(screen.getByText('評価はまだありません。')).toBeInTheDocument();
  });
});

describe('F9 迷いのカード（取り込んだあと。FX-4）', () => {
  it('決まっている迷い 1・2・3: 「局 巡目 · 種類」と「自分：実戦の行動」（自分がした行動だけ）と「選び直す」', async () => {
    setup();
    await tableReady();
    expect(within(card(1)).getByText('東1局 4巡目 · 打牌の迷い')).toBeInTheDocument();
    expect(within(card(1)).getByText('自分：打5p')).toBeInTheDocument();
    expect(within(card(2)).getByText('東2局 11巡目 · 鳴きの迷い')).toBeInTheDocument();
    expect(within(card(2)).getByText('自分：鳴かない判断')).toBeInTheDocument();
    expect(within(card(3)).getByText('東2局1本場 6巡目 · 打牌の迷い')).toBeInTheDocument();
    expect(within(card(3)).getByText('自分：打南')).toBeInTheDocument();
    for (const n of [1, 2, 3]) {
      expect(within(card(n)).getByRole('button', { name: `迷い${n}を選び直す` })).toHaveTextContent('選び直す');
      expect(card(n).querySelector('.chip, .sel-btn')).toBeNull();
    }
  });

  it('候補が複数の迷い 4・5: 1 行目に候補の数、候補の札（実戦の行動）と「選んでください」', async () => {
    setup();
    await tableReady();
    expect(within(card(4)).getByText('東2局1本場 · 候補が3つ')).toBeInTheDocument();
    const four = within(card(4)).getByRole('group', { name: '迷い4の候補' });
    expect(within(four).getAllByRole('button').map((b) => b.textContent)).toEqual(['東をポン', '打7p', '和了']);
    expect(within(card(4)).getByText('選んでください')).toBeInTheDocument();
    expect(within(card(5)).getByText('東3局1本場 · 候補が2つ')).toBeInTheDocument();
    expect(
      within(within(card(5)).getByRole('group', { name: '迷い5の候補' }))
        .getAllByRole('button')
        .map((b) => b.textContent),
    ).toEqual(['打9m', '打1p']);
    // まだ何も選んでいない（どの札も押されていない）。
    for (const chip of card(4).querySelectorAll('.chip')) expect(chip).toHaveAttribute('aria-pressed', 'false');
    expect(within(card(4)).queryByRole('button', { name: /選び直す/ })).toBeNull();
  });

  it('読み取れなかった迷い 6: 「読み取れませんでした」と「局面を手で選ぶ」（局のメニュー・判断のメニュー。判断は局を選ぶまで押せない）', async () => {
    setup();
    await tableReady();
    const six = card(6);
    expect(within(six).getByText('読み取れませんでした')).toBeInTheDocument();
    expect(within(six).getByText('局面を手で選ぶ')).toBeInTheDocument();
    expect(within(six).getByRole('button', { name: '迷い6の局を選ぶ' })).toBeEnabled();
    expect(within(six).getByRole('button', { name: '迷い6の判断を選ぶ' })).toBeDisabled();
    expect(within(six).queryByRole('button', { name: /選び直す/ })).toBeNull();
  });

  it('保存した選びは、自動の結果に勝つ: 迷い 4 に保存してあれば、決まっている', async () => {
    setup({
      session: imported({ links: { ...IMPORTED_LINKS, marks: { ...IMPORTED_LINKS.marks, '4': 'k1h1e11' } } }),
    });
    await tableReady();
    expect(within(card(4)).getByText('東2局1本場 9巡目 · 打牌の迷い')).toBeInTheDocument();
    expect(within(card(4)).getByText('自分：打7p')).toBeInTheDocument();
    expect(within(card(4)).queryByText('選んでください')).toBeNull();
  });

  it('結果を読み出せないとき（取り込み済みなのに）は、カードは画像と時刻だけ。記録した評価の一覧を出す', async () => {
    setup({ report: null, summary: { status: 'unavailable', reason: '取り込んだ結果を読み出せませんでした' } });
    await screen.findByRole('list', { name: '局の評価の一覧' });
    expect(card(1).querySelector('.mwhat, .msub, .mctl')).toBeNull();
    expect(screen.queryByRole('table')).toBeNull();
    expect(screen.getByRole('heading', { level: 2, name: '評価（5）' })).toBeInTheDocument();
  });

  it('結果を読んでいる間は、局の評価の欄に「読み込んでいます。」', () => {
    setup({ handlers: { read_report: () => new Promise(() => undefined) } });
    expect(screen.getByRole('heading', { level: 2, name: '局の評価' })).toBeInTheDocument();
    expect(screen.getByText('読み込んでいます。')).toBeInTheDocument();
    expect(screen.queryByRole('table')).toBeNull();
  });
});

describe('F9・U-11 迷いを選ぶ（保存して、取り消せる）', () => {
  it('候補の札を押すと、その判断に結びつけて保存する。カードは「決まっている」の形になり、キーボードの位置は「選び直す」へ', async () => {
    const { user, mock } = setup();
    await tableReady();
    await user.click(within(card(4)).getByRole('button', { name: '打7p' }));
    await waitFor(() => expect(within(card(4)).getByText('自分：打7p')).toBeInTheDocument());
    expect(calls(mock, 'set_mark_link')).toEqual([{ sessionId: ID, markId: 4, decision: 'k1h1e11' }]);
    expect(within(card(4)).getByText('東2局1本場 9巡目 · 打牌の迷い')).toBeInTheDocument();
    expect(within(card(4)).queryByText('選んでください')).toBeNull();
    expect(within(card(4)).getByRole('button', { name: '迷い4を選び直す' })).toHaveFocus();
  });

  it('Ctrl+Z で前の状態（まだ選んでいない）に戻り（保存を消す）、Ctrl+Y でもう一度選ぶ（U-11）', async () => {
    const { user, mock, store } = setup();
    await tableReady();
    await user.click(within(card(5)).getByRole('button', { name: '打1p' }));
    await waitFor(() => expect(within(card(5)).getByText('自分：打1p')).toBeInTheDocument());
    expect(store.session(ID).links.marks['5']).toBe('k2h1e7');

    await undoKey(user);
    await waitFor(() => expect(within(card(5)).getByText('選んでください')).toBeInTheDocument());
    expect(calls(mock, 'clear_mark_link')).toEqual([{ sessionId: ID, markId: 5 }]);
    expect(store.session(ID).links.marks['5']).toBeUndefined();
    expect(within(card(5)).queryByText(/自分：/)).toBeNull();

    await redoKey(user);
    await waitFor(() => expect(within(card(5)).getByText('自分：打1p')).toBeInTheDocument());
    expect(calls(mock, 'set_mark_link')).toEqual([
      { sessionId: ID, markId: 5, decision: 'k2h1e7' },
      { sessionId: ID, markId: 5, decision: 'k2h1e7' },
    ]);
  });

  it('「選び直す」: 自動の候補があれば札が出て（いまの判断が押された形）、別の札を押すと保存し直す。Ctrl+Z で前の判断に戻る', async () => {
    const { user, mock, store } = setup();
    await tableReady();
    await user.click(within(card(4)).getByRole('button', { name: '東をポン' }));
    await waitFor(() => expect(within(card(4)).getByText('自分：東をポン')).toBeInTheDocument());

    await user.click(within(card(4)).getByRole('button', { name: '迷い4を選び直す' }));
    const chips = within(card(4)).getAllByRole('button', { pressed: true });
    expect(chips.map((b) => b.textContent)).toEqual(['東をポン']);
    await user.click(within(card(4)).getByRole('button', { name: '和了' }));
    await waitFor(() => expect(within(card(4)).getByText('自分：和了')).toBeInTheDocument());
    expect(store.session(ID).links.marks['4']).toBe('k1h1e12');

    await undoKey(user);
    await waitFor(() => expect(within(card(4)).getByText('自分：東をポン')).toBeInTheDocument());
    expect(calls(mock, 'set_mark_link').at(-1)).toEqual({ sessionId: ID, markId: 4, decision: 'k1h1e10' });
    expect(store.session(ID).links.marks['4']).toBe('k1h1e10');
  });

  it('「選び直す」→「やめる」: 何も保存せず、元の表示に戻る', async () => {
    const { user, mock } = setup();
    await tableReady();
    await user.click(within(card(1)).getByRole('button', { name: '迷い1を選び直す' }));
    expect(within(card(1)).getByText('局面を手で選ぶ')).toBeInTheDocument();
    // いまの局が選んである。判断のメニューにも、いまの判断が印の付いた形で出る。
    expect(within(card(1)).getByRole('button', { name: '迷い1の局 東1局' })).toBeInTheDocument();
    await user.click(within(card(1)).getByRole('button', { name: 'やめる' }));
    expect(within(card(1)).getByText('自分：打5p')).toBeInTheDocument();
    expect(within(card(1)).getByRole('button', { name: '迷い1を選び直す' })).toHaveFocus();
    expect(calls(mock, 'set_mark_link')).toEqual([]);
  });

  it('局面を手で選ぶ（迷い 6）: 局を選ぶと判断のメニューが使え、判断を選ぶと保存する。Ctrl+Z で、読み取れなかった状態に戻る', async () => {
    const { user, mock, store } = setup();
    await tableReady();
    const six = card(6);
    await user.click(within(six).getByRole('button', { name: '迷い6の局を選ぶ' }));
    const kyokuMenu = screen.getByRole('menu', { name: '迷い6の局' });
    expect(within(kyokuMenu).getAllByRole('menuitemradio').map((i) => i.textContent)).toEqual([
      '東1局',
      '東2局',
      '東2局1本場',
      '東3局',
      '東3局1本場',
    ]);
    await user.click(within(kyokuMenu).getByRole('menuitemradio', { name: '東3局1本場' }));
    expect(screen.queryByRole('menu')).toBeNull();
    expect(within(six).getByRole('button', { name: '迷い6の局 東3局1本場' })).toHaveFocus();
    expect(calls(mock, 'set_mark_link')).toEqual([]); // 局を選んだだけでは、保存しない

    const decisionButton = within(six).getByRole('button', { name: '迷い6の判断を選ぶ' });
    expect(decisionButton).toBeEnabled();
    await user.click(decisionButton);
    const decisionMenu = screen.getByRole('menu', { name: '迷い6の判断' });
    expect(within(decisionMenu).getAllByRole('menuitemradio')).toHaveLength(17);
    await user.click(within(decisionMenu).getByRole('menuitemradio', { name: '9巡目 · 打北' }));

    await waitFor(() => expect(within(six).getByText('自分：打北')).toBeInTheDocument());
    expect(calls(mock, 'set_mark_link')).toEqual([{ sessionId: ID, markId: 6, decision: 'k2h1e10' }]);
    expect(within(six).getByText('東3局1本場 9巡目 · 打牌の迷い')).toBeInTheDocument();
    expect(store.session(ID).links.marks['6']).toBe('k2h1e10');

    await undoKey(user);
    await waitFor(() => expect(within(six).getByText('読み取れませんでした')).toBeInTheDocument());
    expect(calls(mock, 'clear_mark_link')).toEqual([{ sessionId: ID, markId: 6 }]);
  });

  it('候補の札のとなりの「手で選ぶ」で、手で選ぶ欄に替わる。「候補から選ぶ」で札に戻る（保存はしない）', async () => {
    const { user, mock } = setup();
    await tableReady();
    await user.click(within(card(5)).getByRole('button', { name: '迷い5の局面を手で選ぶ' }));
    expect(within(card(5)).getByText('局面を手で選ぶ')).toBeInTheDocument();
    expect(within(card(5)).queryByText('選んでください')).toBeNull();
    // 1 行目は、候補の言い方のまま（読み取れなかったのではない）。
    expect(within(card(5)).getByText('東3局1本場 · 候補が2つ')).toBeInTheDocument();
    await user.click(within(card(5)).getByRole('button', { name: '候補から選ぶ' }));
    expect(within(card(5)).getByText('選んでください')).toBeInTheDocument();
    expect(calls(mock, 'set_mark_link')).toEqual([]);
  });

  it('決まっている判断を選び直して、同じ判断を選んだときは、保存し直さない', async () => {
    const { user, mock } = setup();
    await tableReady();
    await user.click(within(card(1)).getByRole('button', { name: '迷い1を選び直す' }));
    await user.click(within(card(1)).getByRole('button', { name: '迷い1の判断 4巡目 · 打5p' }));
    await user.click(screen.getByRole('menuitemradio', { name: '4巡目 · 打5p' }));
    expect(calls(mock, 'set_mark_link')).toEqual([]);
    expect(within(card(1)).getByText('自分：打5p')).toBeInTheDocument();
  });

  it('保存できなかったときは、選ぶ前の欄のまま（取り消せるものも増えない）', async () => {
    const { user } = setup({
      handlers: {
        set_mark_link: () => {
          throw '保存できませんでした';
        },
      },
    });
    await tableReady();
    await user.click(within(card(4)).getByRole('button', { name: '打7p' }));
    await waitFor(() => expect(within(card(4)).getByText('選んでください')).toBeInTheDocument());
    expect(within(card(4)).queryByText(/自分：/)).toBeNull();
    await undoKey(user);
    expect(within(card(4)).getByText('選んでください')).toBeInTheDocument();
  });

  it('メニューは Esc で閉じ、何も保存しない。キーボードの位置は開いたボタンへ戻る', async () => {
    const { user, mock } = setup();
    await tableReady();
    const open = within(card(6)).getByRole('button', { name: '迷い6の局を選ぶ' });
    await user.click(open);
    expect(screen.getByRole('menu', { name: '迷い6の局' })).toBeInTheDocument();
    await user.keyboard('{Escape}');
    expect(screen.queryByRole('menu')).toBeNull();
    expect(open).toHaveFocus();
    expect(calls(mock, 'set_mark_link')).toEqual([]);
  });
});

describe('F9 画像を大きく表示する求め', () => {
  it('カードの画像を押すと、画像のある迷いの一覧と、押した迷いの位置を渡す。説明は「迷いN · 局 · 巡目 · 種類」と時刻', async () => {
    const { user, onOpenImage } = setup();
    await tableReady();
    await user.click(within(card(3)).getByRole('button', { name: '迷い3の画像を大きく見る' }));
    expect(onOpenImage).toHaveBeenCalledTimes(1);
    const request = onOpenImage.mock.calls[0]?.[0] as { items: Array<Record<string, string>>; start: number; opener: HTMLElement };
    expect(request.items).toHaveLength(6);
    expect(request.start).toBe(2);
    expect(request.opener).toBe(within(card(3)).getByRole('button', { name: '迷い3の画像を大きく見る' }));
    expect(request.items[2]).toEqual({
      src: `asset://localhost/${encodeURIComponent('C:\\data\\games\\20261009-190953\\marks\\m3.png')}`,
      alt: '迷い3のスクリーンショット',
      caption: '迷い3 · 東2局1本場 · 6巡目 · 打牌の迷い',
      time: '19:17:37',
    });
    expect(request.items.map((i) => i.caption)).toEqual([
      '迷い1 · 東1局 · 4巡目 · 打牌の迷い',
      '迷い2 · 東2局 · 11巡目 · 鳴きの迷い',
      '迷い3 · 東2局1本場 · 6巡目 · 打牌の迷い',
      '迷い4 · 東2局1本場 · 候補が3つ',
      '迷い5 · 東3局1本場 · 候補が2つ',
      '迷い6 · 読み取れませんでした',
    ]);
  });

  it('画像を撮れなかった迷いは、大きな表示の一覧に入らない（前・次で飛ばす）。押した迷いの位置は、その一覧の中の位置', async () => {
    const base = imported();
    const marks = base.marks.map((m, i) => (i === 1 ? { ...m, screenshot: null, screenshot_path: null } : m));
    const { user, onOpenImage } = setup({ session: { ...base, marks } });
    await tableReady();
    await user.click(within(card(3)).getByRole('button', { name: '迷い3の画像を大きく見る' }));
    const request = onOpenImage.mock.calls[0]?.[0] as { items: unknown[]; start: number };
    expect(request.items).toHaveLength(5);
    expect(request.start).toBe(1);
  });

  it('取り込む前の半荘でも開ける。説明は「迷いN」だけ', async () => {
    const { user, onOpenImage } = setup({ session: recorded() });
    await user.click(within(card(1)).getByRole('button', { name: '迷い1の画像を大きく見る' }));
    const request = onOpenImage.mock.calls[0]?.[0] as { items: Array<{ caption: string; time: string }> };
    expect(request.items).toHaveLength(1);
    expect(request.items[0]).toMatchObject({ caption: '迷い1', time: '16:14:32' });
  });
});

describe('F10 局の評価の表（FX-4）', () => {
  it('局・結果・点・自分・AI 基準・MAKA の列。1 行 = 1 局と、最後に半荘全体', async () => {
    setup();
    const table = await tableReady();
    expect(within(table).getAllByRole('columnheader').map((h) => h.textContent)).toEqual([
      '局',
      '結果',
      '点',
      '自分',
      'AI 基準',
      'MAKA',
    ]);
    const rows = within(table).getAllByRole('row').slice(1);
    expect(rows).toHaveLength(6);
    const text = (row: HTMLElement) => within(row).getAllByRole('cell').map((c) => c.textContent);
    expect(within(rows[0] as HTMLElement).getByRole('rowheader')).toHaveTextContent('東1局');
    expect(text(rows[0] as HTMLElement)[0]).toBe('他家のツモ');
    expect(text(rows[0] as HTMLElement)[1]).toBe('\u22126,000');
    expect(within(rows[2] as HTMLElement).getByRole('rowheader')).toHaveTextContent('東2局1本場');
    expect(text(rows[2] as HTMLElement).slice(0, 2)).toEqual(['和了', '+1,300']);
    expect(text(rows[3] as HTMLElement).slice(0, 2)).toEqual(['放銃', '\u221212,000']);
    expect(within(rows[5] as HTMLElement).getByRole('rowheader')).toHaveTextContent('半荘全体');
  });

  it('AI 基準: 局の段階（段階の印）と Rating。半荘全体の行は、見出しと同じ段階と Rating', async () => {
    setup();
    const table = await tableReady();
    const badges = Array.from(table.querySelectorAll('tbody .grade')).map((b) => [b.textContent, b.getAttribute('data-grade')]);
    expect(badges).toEqual([
      ['S+', 'S+'],
      ['S-', 'S-'],
      ['A', 'A'],
      ['S', 'S'],
      ['S-', 'S-'],
    ]);
    expect(Array.from(table.querySelectorAll('tbody .ai .mono')).map((e) => e.textContent)).toEqual([
      '100.0',
      '91.6',
      '86.5',
      '94.6',
      '91.6',
    ]);
    const footer = table.querySelector('tfoot .ai') as HTMLElement;
    expect(footer.querySelector('.grade')?.textContent).toBe('S-');
    expect(footer.querySelector('.mono')?.textContent).toBe('93.0');
  });

  it('自分の〇△✕は、ウィジェットの評価を局に当てはめたもの。AI 基準と大きく違う局（東2局・東3局・東3局1本場）に旗、下に注意書き', async () => {
    setup();
    const table = await tableReady();
    const rows = within(table).getAllByRole('row').slice(1, 6);
    const selfOf = (row: HTMLElement) => within(row).getByRole('button', { name: /の自分の評価/ }).getAttribute('aria-label');
    expect(rows.map((r) => selfOf(r))).toEqual([
      '東1局の自分の評価（△）',
      '東2局の自分の評価（✕）',
      '東2局1本場の自分の評価（△）',
      '東3局の自分の評価（✕）',
      '東3局1本場の自分の評価（✕）',
    ]);
    const flagged = rows.map((r) => within(r).queryByRole('img', { name: 'AI 基準と大きく違います' }) !== null);
    expect(flagged).toEqual([false, true, false, true, true]);
    expect(screen.getByText('結果が悪かった局を低く付けていないか')).toBeInTheDocument();
  });

  it('旗が 1 つも無いときは、注意書きも出さない', async () => {
    const base = imported();
    setup({ session: { ...base, ratings: base.ratings.map((r) => ({ ...r, rating: 'good' as const })) } });
    const table = await tableReady();
    expect(within(table).queryByRole('img', { name: 'AI 基準と大きく違います' })).toBeNull();
    expect(screen.queryByText('結果が悪かった局を低く付けていないか')).toBeNull();
  });

  it('局の評価が無い（押し忘れた）局は、点線の「付ける」。MAKA は、点線の「入力」', async () => {
    const base = imported();
    const links: Links = { ...IMPORTED_LINKS, ratings: { ...IMPORTED_LINKS.ratings, '9': '' } };
    setup({ session: { ...base, links } });
    const table = await tableReady();
    const row = within(table).getAllByRole('row')[3] as HTMLElement; // 東2局1本場
    const make = within(row).getByRole('button', { name: '東2局1本場の自分の評価を付ける' });
    expect(make).toHaveTextContent('付ける');
    expect(make).toHaveClass('ghost');
    expect(within(row).getByRole('button', { name: '東2局1本場の MAKA を入力' })).toHaveTextContent('入力');
    expect(screen.getByText('ウィジェットで付けた評価のうち、1件は、どの局にも当てはまりませんでした')).toBeInTheDocument();
  });

  it('自分の評価を付け直す: 押すと〇・△・✕・なしのメニュー。選ぶと保存して、表と旗が変わる（東2局の✕を〇にすると、旗が消える）', async () => {
    const { user, mock, store } = setup();
    const table = await tableReady();
    const button = within(table).getByRole('button', { name: '東2局の自分の評価（✕）' });
    await user.click(button);
    const menu = screen.getByRole('menu', { name: '東2局の自分の評価' });
    const items = within(menu).getAllByRole('menuitemradio');
    expect(items.map((i) => i.textContent)).toEqual(['〇', '△', '✕', 'なし']);
    expect(items.map((i) => i.getAttribute('aria-checked'))).toEqual(['false', 'false', 'true', 'false']);
    await user.click(within(menu).getByRole('menuitemradio', { name: '〇' }));

    await waitFor(() => expect(within(table).getByRole('button', { name: '東2局の自分の評価（〇）' })).toBeInTheDocument());
    expect(calls(mock, 'set_self_rating')).toEqual([{ sessionId: ID, kyoku: 'k1h0', rating: 'good' }]);
    expect(store.session(ID).self_ratings.kyokus).toEqual({ k1h0: 'good' });
    const row = within(table).getAllByRole('row')[2] as HTMLElement;
    expect(within(row).queryByRole('img', { name: 'AI 基準と大きく違います' })).toBeNull();
    // キーボードの位置は、押したボタンへ戻る。
    expect(within(table).getByRole('button', { name: '東2局の自分の評価（〇）' })).toHaveFocus();
  });

  it('Ctrl+Z で前の評価（ウィジェットで付けた✕）に戻り、Ctrl+Y でもう一度〇にする', async () => {
    const { user, mock, store } = setup();
    const table = await tableReady();
    await user.click(within(table).getByRole('button', { name: '東2局の自分の評価（✕）' }));
    await user.click(screen.getByRole('menuitemradio', { name: '〇' }));
    await waitFor(() => expect(store.session(ID).self_ratings.kyokus.k1h0).toBe('good'));

    await undoKey(user);
    await waitFor(() => expect(within(table).getByRole('button', { name: '東2局の自分の評価（✕）' })).toBeInTheDocument());
    expect(calls(mock, 'clear_self_rating')).toEqual([{ sessionId: ID, kyoku: 'k1h0' }]);
    expect(store.session(ID).self_ratings.kyokus).toEqual({});
    expect(
      within(within(table).getAllByRole('row')[2] as HTMLElement).queryByRole('img', { name: 'AI 基準と大きく違います' }),
    ).not.toBeNull();

    await redoKey(user);
    await waitFor(() => expect(within(table).getByRole('button', { name: '東2局の自分の評価（〇）' })).toBeInTheDocument());
    expect(calls(mock, 'set_self_rating')).toHaveLength(2);
  });

  it('「なし」を選ぶと、評価なし（点線の「付ける」）になる。もう一度付けるには、メニューから選ぶ', async () => {
    const { user, mock } = setup();
    const table = await tableReady();
    await user.click(within(table).getByRole('button', { name: '東3局の自分の評価（✕）' }));
    await user.click(screen.getByRole('menuitemradio', { name: 'なし' }));
    await waitFor(() => expect(within(table).getByRole('button', { name: '東3局の自分の評価を付ける' })).toBeInTheDocument());
    expect(calls(mock, 'set_self_rating')).toEqual([{ sessionId: ID, kyoku: 'k2h0', rating: 'none' }]);
    // 評価なしにした局に、旗は付かない。
    expect(
      within(within(table).getAllByRole('row')[4] as HTMLElement).queryByRole('img', { name: 'AI 基準と大きく違います' }),
    ).toBeNull();
    await user.click(within(table).getByRole('button', { name: '東3局の自分の評価を付ける' }));
    await user.click(screen.getByRole('menuitemradio', { name: '△' }));
    await waitFor(() => expect(within(table).getByRole('button', { name: '東3局の自分の評価（△）' })).toBeInTheDocument());
  });

  it('いまと同じ評価を選んでも、保存しない（取り消しの積み重ねにも載らない）', async () => {
    const { user, mock } = setup();
    const table = await tableReady();
    await user.click(within(table).getByRole('button', { name: '東2局の自分の評価（✕）' }));
    await user.click(screen.getByRole('menuitemradio', { name: '✕' }));
    expect(calls(mock, 'set_self_rating')).toEqual([]);
    await undoKey(user);
    expect(calls(mock, 'clear_self_rating')).toEqual([]);
  });

  it('MAKA: 「入力」を押すと、なし＋14 段階のメニュー。選ぶと保存して、段階の文字になる', async () => {
    const { user, mock, store } = setup();
    const table = await tableReady();
    await user.click(within(table).getByRole('button', { name: '東1局の MAKA を入力' }));
    const menu = screen.getByRole('menu', { name: '東1局の MAKA' });
    expect(within(menu).getAllByRole('menuitemradio').map((i) => i.textContent)).toEqual([
      'なし',
      'S+',
      'S',
      'S-',
      'A+',
      'A',
      'A-',
      'B+',
      'B',
      'B-',
      'C+',
      'C',
      'C-',
      'D',
      'E',
    ]);
    await user.click(within(menu).getByRole('menuitemradio', { name: 'C-' }));
    await waitFor(() => expect(within(table).getByRole('button', { name: '東1局の MAKA C-' })).toBeInTheDocument());
    expect(calls(mock, 'set_maka_grade')).toEqual([{ sessionId: ID, kyoku: 'k0h0', grade: 'C-' }]);
    expect(store.session(ID).maka.kyokus).toEqual({ k0h0: 'C-' });
    expect(within(table).getByRole('button', { name: '東1局の MAKA C-' })).toHaveTextContent('C-');
  });

  it('MAKA を「なし」にすると消す。Ctrl+Z で前の段階に戻る。同じ段階を選んでも保存しない', async () => {
    const base = imported();
    const { user, mock, store } = setup({ session: { ...base, maka: { kyokus: { k0h0: 'B' }, hanchan: 'A+' } } });
    const table = await tableReady();
    await user.click(within(table).getByRole('button', { name: '東1局の MAKA B' }));
    await user.click(screen.getByRole('menuitemradio', { name: 'B' }));
    expect(calls(mock, 'set_maka_grade')).toEqual([]);

    await user.click(within(table).getByRole('button', { name: '東1局の MAKA B' }));
    await user.click(screen.getByRole('menuitemradio', { name: 'なし' }));
    await waitFor(() => expect(within(table).getByRole('button', { name: '東1局の MAKA を入力' })).toBeInTheDocument());
    expect(calls(mock, 'clear_maka_grade')).toEqual([{ sessionId: ID, kyoku: 'k0h0' }]);

    await undoKey(user);
    await waitFor(() => expect(within(table).getByRole('button', { name: '東1局の MAKA B' })).toBeInTheDocument());
    expect(calls(mock, 'set_maka_grade')).toEqual([{ sessionId: ID, kyoku: 'k0h0', grade: 'B' }]);
    expect(store.session(ID).maka).toEqual({ kyokus: { k0h0: 'B' }, hanchan: 'A+' });
  });

  it('半荘全体の MAKA: 半荘全体の行から入れる・消す（局とは別の保存）。Ctrl+Z で戻る', async () => {
    const { user, mock, store } = setup();
    const table = await tableReady();
    await user.click(within(table).getByRole('button', { name: '半荘全体の MAKA を入力' }));
    await user.click(screen.getByRole('menuitemradio', { name: 'A+' }));
    await waitFor(() => expect(within(table).getByRole('button', { name: '半荘全体の MAKA A+' })).toBeInTheDocument());
    expect(calls(mock, 'set_maka_hanchan')).toEqual([{ sessionId: ID, grade: 'A+' }]);
    expect(store.session(ID).maka.hanchan).toBe('A+');
    await undoKey(user);
    await waitFor(() => expect(within(table).getByRole('button', { name: '半荘全体の MAKA を入力' })).toBeInTheDocument());
    expect(calls(mock, 'clear_maka_hanchan')).toEqual([{ sessionId: ID }]);
  });

  it('上書きと MAKA が保存してある半荘を開くと、その値が出る', async () => {
    const base = imported();
    setup({
      session: {
        ...base,
        self_ratings: { kyokus: { k0h0: 'good', k1h0: 'none' } },
        maka: { kyokus: { k1h0: 'S', k2h1: 'E' } },
      },
    });
    const table = await tableReady();
    expect(within(table).getByRole('button', { name: '東1局の自分の評価（〇）' })).toBeInTheDocument();
    expect(within(table).getByRole('button', { name: '東2局の自分の評価を付ける' })).toBeInTheDocument();
    expect(within(table).getByRole('button', { name: '東2局の MAKA S' })).toBeInTheDocument();
    expect(within(table).getByRole('button', { name: '東3局1本場の MAKA E' })).toBeInTheDocument();
  });
});

describe('U-1・F3 この画面に AI の答えは出さない（答えを書くまで隠す）', () => {
  const parsed = parseReportText(FX4_TEXT);
  if (!parsed.ok) throw new Error(parsed.error.message);
  const report: MortalReport = parsed.value;
  const refs = listDecisionRefs(report);
  const refByKey = new Map(refs.map((r) => [r.key, r] as const));

  const withoutImageUrls = (html: string) => html.replace(/ src="[^"]*"/g, '');

  /** 判断 1 つについて、AI の第 1 位の行動の名前（`expected`）。 */
  function aiPickOf(key: string): string {
    const ref = refByKey.get(key);
    if (!ref) throw new Error(`判断が無い: ${key}`);
    const entry = report.review.kyokus[ref.kyokuPosition]?.entries[ref.entryIndex];
    if (!entry) throw new Error(`記録が無い: ${key}`);
    return actionLabel(entry.expected, ref.kind);
  }

  it('取り込んだ半荘のページに、data-ai の属性も、確率らしい文字（%・確率・順位・prob・q_value）も無い', async () => {
    setup();
    await tableReady();
    const root = document.body;
    // 画像の場所（asset の URL は、% で符号化された文字を含む）は、確率の検査から外す。
    const html = withoutImageUrls(root.innerHTML);
    expect(html).not.toMatch(/data-ai/i);
    expect(html).not.toMatch(/\d\s*[%％]/);
    expect(html).not.toMatch(/確率|順位|probab|\bprob\b|q_value|q-value|expected|rank/i);
    for (const element of root.querySelectorAll('*')) {
      for (const name of element.getAttributeNames()) {
        expect(name, `${element.tagName}.${element.className}`).not.toMatch(/^data-ai|prob|rank|expected/i);
      }
    }
  });

  it('メニューを開いた状態（局・判断・MAKA）にも、選んだあとにも、AI の答えは出ない', async () => {
    const { user } = setup();
    const table = await tableReady();
    const check = () => {
      const html = withoutImageUrls(document.body.innerHTML);
      expect(html).not.toMatch(/data-ai/i);
      expect(html).not.toMatch(/\d\s*[%％]|確率|順位|probab|\bprob\b|q_value/i);
    };
    await user.click(within(card(6)).getByRole('button', { name: '迷い6の局を選ぶ' }));
    check();
    await user.click(screen.getByRole('menuitemradio', { name: '東2局' }));
    await user.click(within(card(6)).getByRole('button', { name: '迷い6の判断を選ぶ' }));
    check();
    await user.click(screen.getByRole('menuitemradio', { name: '8巡目 · 打4s' }));
    await waitFor(() => expect(within(card(6)).getByText('自分：打4s')).toBeInTheDocument());
    check();
    await user.click(within(table).getByRole('button', { name: '東1局の MAKA を入力' }));
    check();
  });

  it('カードに出る行動の名前は、自分が実際にした行動だけ。同じ判断で AI が第 1 位にした別の行動の名前は出ない', async () => {
    // AI の第 1 位が、実戦の行動と違う判断を 6 つ選んで、迷い 1〜6 に結びつけてある半荘を出す。
    const differing = refs
      .filter((r) => {
        const entry = report.review.kyokus[r.kyokuPosition]?.entries[r.entryIndex];
        return entry !== undefined && !entry.is_equal && aiPickOf(r.key) !== r.actionLabel;
      })
      .slice(0, 6);
    expect(differing).toHaveLength(6);
    const marks = Object.fromEntries(differing.map((r, i) => [String(i + 1), r.key]));
    setup({ session: imported({ links: { marks, ratings: IMPORTED_LINKS.ratings } }) });
    await tableReady();
    differing.forEach((ref, i) => {
      const text = card(i + 1).textContent ?? '';
      expect(text).toContain(`自分：${ref.actionLabel}`);
      expect(text, `迷い${i + 1}・判断 ${ref.key}・AI の第 1 位 ${aiPickOf(ref.key)}`).not.toContain(aiPickOf(ref.key));
    });
  });

  it('「局面を手で選ぶ」の判断のメニューは、半荘の全判断（70）を出すが、どれも自分が実際にした行動の名前だけ（AI の第 1 位は出ない）', async () => {
    const { user } = setup();
    await tableReady();
    let checkedPicks = 0;
    for (let position = 0; position < report.review.kyokus.length; position += 1) {
      const kyokuLabel = refs.find((r) => r.kyokuPosition === position)?.kyokuLabel ?? '';
      await user.click(within(card(6)).getByRole('button', { name: /^迷い6の局/ }));
      await user.click(screen.getByRole('menuitemradio', { name: kyokuLabel }));
      await user.click(within(card(6)).getByRole('button', { name: /^迷い6の判断/ }));
      const menu = screen.getByRole('menu', { name: '迷い6の判断' });
      const text = menu.textContent ?? '';
      const keys = refs.filter((r) => r.kyokuPosition === position).map((r) => r.key);
      expect(within(menu).getAllByRole('menuitemradio')).toHaveLength(keys.length);
      const shown = new Set(keys.map((key) => refByKey.get(key)?.actionLabel));
      for (const key of keys) {
        const ai = aiPickOf(key);
        if (shown.has(ai)) continue;
        checkedPicks += 1;
        expect(text, `判断 ${key}・AI の第 1 位 ${ai}`).not.toContain(`· ${ai}`);
      }
      await user.keyboard('{Escape}');
    }
    expect(checkedPicks).toBeGreaterThan(0);
  });
});
