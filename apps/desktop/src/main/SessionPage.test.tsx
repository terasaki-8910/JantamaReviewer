/**
 * 半荘のページ（ACCEPTANCE の U-1・U-8・U-11、SPEC の F3・F9・F10）の、画面の試験。
 * 半荘の保存先の偽物（FakeSessionStore）の上で、取り込んだ半荘（FX-4）と、取り込む前の半荘を出して、使う人と同じ操作で確かめる。
 * 画像の大きな表示（Lightbox）は、ここでは「開く求めが出ること」まで。表示そのものは Lightbox.test.tsx と、App 全体の試験が確かめる。
 * 実ブラウザでの見え方（横スクロール・axe・描かれた色）は、tests/browser/hanchan.browser.test.ts が確かめる。
 */
import { actionLabel, listDecisionRefs, parseReportText, type MortalReport } from '@jantama/engine';
import { cleanup, render, screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { useCallback, useEffect, useMemo, useState } from 'react';
import { beforeEach, describe, expect, it, vi } from 'vitest';

import { FakeSessionStore, REPORT_TEXTS, local } from '../../tests/fake-sessions';
import {
  FX4_TEXT,
  FX5_ID,
  FX5_STARTED,
  FX5_USER_CHOICES,
  OCR_GEOMETRY,
  fx4Ocr,
  fx4Session,
  fx5Ocr,
  fx5Session,
} from '../../tests/import-fixtures';
import { installTauriMock } from '../../tests/tauri-mock';
import { api } from '../api/tauri';
import type { Links, OcrCache, Rating, SessionRecord } from '../api/types';
import { relinkRatings } from './ratingRelink';
import { RereadStore } from './rereadStore';
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

/**
 * 取り込みが保存するとおりの結びつけ（迷いは保存しない。推定は、読み取りの写しと結果から出す。評価 7〜11 は局の順）。
 * 迷い 1〜5 は読めて、1 位が推定になる。迷い 6 は読めないので、手で選ぶ。
 */
const IMPORTED_LINKS: Links = {
  marks: {},
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

/**
 * 迷い 1 の読み取りが、この半荘に合う局が無い（別の半荘のスクショ）半荘: 迷い 1 は、手で選ぶ（理由は no-kyoku）。
 * 局の幅が決まらないので、半荘のすべての判断から選ぶ。（迷い 6 は、前後の評価と迷いから局が分かるので、局だけ分かった迷いになる）
 */
function manualOcr(): OcrCache {
  const cache = fx4Ocr();
  cache.entries['marks/m1.png'] = { lines: ['南 2 局', '余 40', '25000'] };
  return cache;
}
const manualSession = (): SessionRecord => imported({ ocr: manualOcr() });

/** 読み直し（F11、E-27）の偽物の指定。渡すと、画面に読み直しの部品（`RereadStore`）を渡す。 */
interface RereadOptions {
  /** 読み直したあとの写し。既定は、迷い 6 の読み直しの行も入った FX-4 の写し。 */
  fresh?: OcrCache;
  /** これが済むまで、読み直しは終わらない。 */
  hold?: Promise<unknown>;
  /** 読み直しを、この理由で失敗させる。 */
  failWith?: string;
}

interface SetupOptions {
  session?: SessionRecord;
  /** 取り込んだ結果。既定は FX-4。null なら、結果を読み出せない。 */
  report?: keyof typeof REPORT_TEXTS | null;
  /** 画面に渡すまとめ。既定は、結果から作ったもの。 */
  summary?: SummaryState | undefined;
  handlers?: Record<string, (args: unknown) => unknown>;
  reread?: RereadOptions;
  /** 読み直しのあとの、評価の当てはめ直し（E-31）を付ける。渡すと、画面に読み直しの部品（`RereadStore`）を渡す。 */
  relink?: boolean;
}

function setup(options: SetupOptions = {}) {
  const session = options.session ?? imported();
  const store = new FakeSessionStore([{ session, ...(options.report === null ? {} : { report: options.report ?? 'fx4' }) }]);
  const rereadHandlers =
    options.reread === undefined
      ? {}
      : store.rereadHandlers({
          currentGeometry: OCR_GEOMETRY,
          fresh: options.reread.fresh ?? fx4Ocr({ retries: true }),
          ...(options.reread.hold === undefined ? {} : { hold: options.reread.hold }),
          ...(options.reread.failWith === undefined ? {} : { failWith: options.reread.failWith }),
        });
  const mock = installTauriMock({ handlers: { ...store.handlers, ...rereadHandlers, ...options.handlers } });
  const user = userEvent.setup();
  const onOpenImage = vi.fn();
  const summary = 'summary' in options ? options.summary : session.report_path === null ? undefined : summaryOf();
  // 読み直しの部品は、検討画面のシェルと同じく、画面（半荘のページ）より長く生きる（開き直しても、この起動で 1 回だけ）。
  const reloader = { current: async () => undefined as void };
  const rereads =
    options.reread === undefined && options.relink !== true
      ? undefined
      : new RereadStore({
          needed: api.needsOcrReread,
          reread: api.rereadOcr,
          changed: () => reloader.current(),
          ...(options.relink === true ? { relink: (sessionId: string) => relinkRatings(api, sessionId) } : {}),
        });

  function Harness() {
    const [current, setCurrent] = useState(() => store.session(session.id));
    const reload = useCallback(async () => setCurrent(store.session(session.id)), []);
    useEffect(() => {
      reloader.current = reload;
    }, [reload]);
    const stable = useMemo(() => summary, []);
    return (
      <UndoProvider>
        <SessionPage session={current} summary={stable} onChanged={reload} onOpenImage={onOpenImage} rereads={rereads} />
      </UndoProvider>
    );
  }
  let view = render(<Harness />);
  /** 半荘のページを閉じて、開き直す（読み直しの部品は、そのまま）。 */
  const reopen = () => {
    view.unmount();
    view = render(<Harness />);
  };
  return { store, mock, user, onOpenImage, reopen };
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

describe('F9・U-13 迷いのカード（取り込んだあと。FX-4）', () => {
  /** カードの欄の文字を、確かめやすい形で取り出す。 */
  function textsOf(n: number) {
    const c = card(n);
    return {
      what: c.querySelector('.mwhat')?.textContent ?? null,
      read: c.querySelector('.mread')?.textContent ?? null,
      tag: c.querySelector('.tag.est')?.textContent ?? null,
      mine: c.querySelector('.mact > span:not(.tag)')?.textContent ?? null,
      alt: c.querySelector('.malt-lbl')?.textContent ?? null,
      chips: Array.from(c.querySelectorAll('.chip')).map((b) => b.textContent),
    };
  }

  it('どの迷いも、同じ構成: 「迷いN」と時刻 → 2 行目の局面 → スクショから読んだ値 → 状態ごとの欄（推定の印・自分の行動・選び直す）', async () => {
    setup();
    await tableReady();
    for (const n of [1, 2, 3, 4, 5, 6]) {
      const c = card(n);
      const order = Array.from(c.querySelectorAll('.mtop, .mwhat, .mread, .mhow, .msub, .malt, .mctl')).map((el) => el.className.split(' ')[0]);
      expect(order.slice(0, 3), `迷い${n}`).toEqual(['mtop', 'mwhat', 'mread']);
    }
    for (const n of [1, 2, 3, 4, 5]) {
      expect(card(n).querySelector('.mtop + .mwhat + .mread + .msub'), `迷い${n}`).not.toBeNull();
    }
    // 局だけ分かった迷い 6 は、読み取りの下に、局をどう決めたかの 1 文（.mhow）が入る
    expect(card(6).querySelector('.mtop + .mwhat + .mread + .mhow + .mctl')).not.toBeNull();
  });

  it('推定の迷い 1・3（ほかの候補が無い）: 局面・読んだ値・「推定」の印・「自分：実戦の行動」・「選び直す」', async () => {
    setup();
    await tableReady();
    expect(textsOf(1)).toEqual({
      what: '東1局 4巡目 · 打牌の迷い',
      read: 'スクショ: 東1局・残り59・25,000点',
      tag: '推定',
      mine: '自分：打5p',
      alt: null,
      chips: [],
    });
    expect(textsOf(3)).toEqual({
      what: '東2局1本場 6巡目 · 打牌の迷い',
      read: 'スクショ: 東2局・残り47・15,100点',
      tag: '推定',
      mine: '自分：打南',
      alt: null,
      chips: [],
    });
    for (const n of [1, 3]) {
      expect(within(card(n)).getByRole('button', { name: `迷い${n}を選び直す` })).toHaveTextContent('選び直す');
      expect(card(n).querySelector('.sel-btn')).toBeNull();
    }
  });

  it('推定の迷い 2・4・5（近い判断がある）: 2 行目の巡目は「11〜12巡目」の形。「ほかの候補」の札（巡目つきの実戦の行動）が出る', async () => {
    setup();
    await tableReady();
    expect(textsOf(2)).toEqual({
      what: '東2局 11〜12巡目 · 打牌の迷い',
      read: 'スクショ: 東2局・残り23・19,000点',
      tag: '推定',
      mine: '自分：打8p',
      alt: 'ほかの候補',
      chips: ['12巡目 打9m', '11巡目 鳴かない判断'],
    });
    expect(textsOf(4)).toEqual({
      what: '東2局1本場 8〜9巡目 · 鳴きの迷い',
      read: 'スクショ: 東2局・残り35・15,100点',
      tag: '推定',
      mine: '自分：東をポン',
      alt: 'ほかの候補',
      chips: ['9巡目 打7p'],
    });
    expect(textsOf(5)).toEqual({
      what: '東3局1本場 6〜7巡目 · 打牌の迷い',
      read: 'スクショ: 東3局・残り46・4,400点',
      tag: '推定',
      mine: '自分：打9m',
      alt: 'ほかの候補',
      chips: ['7巡目 打1p'],
    });
    const four = within(card(4)).getByRole('group', { name: '迷い4のほかの候補' });
    expect(within(four).getAllByRole('button').map((b) => b.textContent)).toEqual(['9巡目 打7p']);
    // 札は、まだ何も選んでいない（どの札も押されていない）。1 位の推定は札ではなく「自分：」に出ている。
    for (const chip of card(4).querySelectorAll('.chip')) expect(chip).toHaveAttribute('aria-pressed', 'false');
    expect(within(card(4)).queryByText('選んでください')).toBeNull();
    expect(within(card(4)).getByRole('button', { name: '迷い4を選び直す' })).toBeInTheDocument();
  });

  it('U-24 読み取れなかった迷い 6: 局だけ分かる（東3局1本場）。「巡目は決まっていません」・スクショを読めませんでした・局をどう決めたかの 1 文・「手で選ぶ」（局は選んである。判断は局の幅の 17 から）', async () => {
    setup();
    await tableReady();
    const six = card(6);
    expect(textsOf(6)).toMatchObject({ what: '東3局1本場 · 巡目は決まっていません', read: 'スクショを読めませんでした', tag: null, mine: null, chips: [] });
    expect(six.querySelector('.mhow')?.textContent).toBe(
      '東3局1本場の迷い5（19:21:58）と東3局1本場の評価（19:23:54）の間に押したので、東3局1本場です。',
    );
    expect(within(six).getByText('手で選ぶ')).toBeInTheDocument();
    expect(within(six).getByRole('button', { name: '迷い6の局 東3局1本場' })).toBeEnabled();
    expect(within(six).getByRole('button', { name: '迷い6の判断を選ぶ' })).toBeEnabled();
    expect(within(six).queryByRole('button', { name: /選び直す/ })).toBeNull();
    expect(within(six).queryByText('推定')).toBeNull();
  });

  it('手で選ぶ迷い（読み取りが、この半荘のどの局にも合わない）: 局面は決まっていません・読んだ値と理由・「手で選ぶ」（局のメニュー → 判断のメニュー。判断は局を選ぶまで押せない）', async () => {
    setup({ session: manualSession() });
    await tableReady();
    const one = card(1);
    expect(textsOf(1)).toMatchObject({
      what: '局面は決まっていません',
      read: 'スクショ: 南2局・残り40・25,000点 · この半荘に合う局がありません',
      tag: null,
      mine: null,
      chips: [],
    });
    expect(one.querySelector('.mhow')).toBeNull();
    expect(within(one).getByText('手で選ぶ')).toBeInTheDocument();
    expect(within(one).getByRole('button', { name: '迷い1の局を選ぶ' })).toBeEnabled();
    expect(within(one).getByRole('button', { name: '迷い1の判断を選ぶ' })).toBeDisabled();
    expect(within(one).queryByRole('button', { name: /選び直す/ })).toBeNull();
  });

  it('E-20 読み直しの写しがあれば、迷い 6 も推定になる（東3局・残り38枚・4,400点。打北 9巡目。ほかの候補は 8巡目の鳴かない判断）', async () => {
    setup({ session: imported({ ocr: fx4Ocr({ retries: true }) }) });
    await tableReady();
    expect(textsOf(6)).toEqual({
      what: '東3局1本場 8〜9巡目 · 打牌の迷い',
      read: 'スクショ: 東3局・残り38・4,400点',
      tag: '推定',
      mine: '自分：打北',
      alt: 'ほかの候補',
      chips: ['8巡目 鳴かない判断'],
    });
  });

  it('保存した選び（利用者が選んだもの）は推定に勝つ: 「推定」の印と「ほかの候補」は無い。局面は選んだ判断の巡目だけ。読んだ値の 1 行は同じに出る', async () => {
    setup({
      session: imported({ links: { ...IMPORTED_LINKS, marks: { ...IMPORTED_LINKS.marks, '4': 'k1h1e11' } } }),
    });
    await tableReady();
    expect(textsOf(4)).toEqual({
      what: '東2局1本場 9巡目 · 打牌の迷い',
      read: 'スクショ: 東2局・残り35・15,100点',
      tag: null,
      mine: '自分：打7p',
      alt: null,
      chips: [],
    });
    expect(within(card(4)).getByRole('button', { name: '迷い4を選び直す' })).toBeInTheDocument();
  });

  it('結果を読み出せないとき（取り込み済みなのに）は、カードは画像と時刻だけ。記録した評価の一覧を出す', async () => {
    setup({ report: null, summary: { status: 'unavailable', reason: '取り込んだ結果を読み出せませんでした' } });
    await screen.findByRole('list', { name: '局の評価の一覧' });
    expect(card(1).querySelector('.mwhat, .mread, .msub, .mctl')).toBeNull();
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
  it('ほかの候補の札を押すと、その判断に結びつけて保存する。カードは「利用者が選んだ」形（「推定」の印・札が消える）になり、キーボードの位置は「選び直す」へ', async () => {
    const { user, mock } = setup();
    await tableReady();
    await user.click(within(card(4)).getByRole('button', { name: '9巡目 打7p' }));
    await waitFor(() => expect(within(card(4)).getByText('自分：打7p')).toBeInTheDocument());
    expect(calls(mock, 'set_mark_link')).toEqual([{ sessionId: ID, markId: 4, decision: 'k1h1e11' }]);
    expect(within(card(4)).getByText('東2局1本場 9巡目 · 打牌の迷い')).toBeInTheDocument();
    expect(within(card(4)).queryByText('推定')).toBeNull();
    expect(card(4).querySelector('.chip, .malt')).toBeNull();
    expect(within(card(4)).getByRole('button', { name: '迷い4を選び直す' })).toHaveFocus();
  });

  it('Ctrl+Z で前の状態（推定）に戻り（保存を消す）、Ctrl+Y でもう一度選ぶ（U-11）', async () => {
    const { user, mock, store } = setup();
    await tableReady();
    await user.click(within(card(5)).getByRole('button', { name: '7巡目 打1p' }));
    await waitFor(() => expect(within(card(5)).getByText('自分：打1p')).toBeInTheDocument());
    expect(store.session(ID).links.marks['5']).toBe('k2h1e7');

    await undoKey(user);
    await waitFor(() => expect(within(card(5)).getByText('推定')).toBeInTheDocument());
    expect(calls(mock, 'clear_mark_link')).toEqual([{ sessionId: ID, markId: 5 }]);
    expect(store.session(ID).links.marks['5']).toBeUndefined();
    expect(within(card(5)).getByText('自分：打9m')).toBeInTheDocument();
    expect(within(card(5)).getByRole('button', { name: '7巡目 打1p' })).toBeInTheDocument();

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
    await user.click(within(card(4)).getByRole('button', { name: '迷い4を選び直す' }));
    // 推定の 1 位（東をポン）が押された形で、ほかの候補と一緒に並ぶ（巡目つき）。
    const chips = within(card(4)).getAllByRole('button', { pressed: true });
    expect(chips.map((b) => b.textContent)).toEqual(['8巡目 東をポン']);
    expect(within(card(4)).getAllByRole('button').filter((b) => b.classList.contains('chip')).map((b) => b.textContent)).toEqual([
      '8巡目 東をポン',
      '9巡目 打7p',
    ]);
    await user.click(within(card(4)).getByRole('button', { name: '9巡目 打7p' }));
    await waitFor(() => expect(within(card(4)).getByText('自分：打7p')).toBeInTheDocument());
    expect(store.session(ID).links.marks['4']).toBe('k1h1e11');

    // 利用者が選んだあとの「選び直す」でも、同じ札が並ぶ（押されているのは、選んだ判断）。
    await user.click(within(card(4)).getByRole('button', { name: '迷い4を選び直す' }));
    expect(within(card(4)).getAllByRole('button', { pressed: true }).map((b) => b.textContent)).toEqual(['9巡目 打7p']);
    await user.click(within(card(4)).getByRole('button', { name: '8巡目 東をポン' }));
    await waitFor(() => expect(within(card(4)).getByText('自分：東をポン')).toBeInTheDocument());
    expect(store.session(ID).links.marks['4']).toBe('k1h1e10');

    await undoKey(user);
    await waitFor(() => expect(within(card(4)).getByText('自分：打7p')).toBeInTheDocument());
    expect(calls(mock, 'set_mark_link').at(-1)).toEqual({ sessionId: ID, markId: 4, decision: 'k1h1e11' });
    expect(store.session(ID).links.marks['4']).toBe('k1h1e11');
  });

  it('推定の 1 位（自分：…）を、そのまま選んで確かめることもできる: 「選び直す」→ 同じ札を押すと、保存して「推定」の印が外れる', async () => {
    const { user, mock, store } = setup();
    await tableReady();
    await user.click(within(card(4)).getByRole('button', { name: '迷い4を選び直す' }));
    await user.click(within(card(4)).getByRole('button', { name: '8巡目 東をポン' }));
    await waitFor(() => expect(within(card(4)).queryByText('推定')).toBeNull());
    expect(calls(mock, 'set_mark_link')).toEqual([{ sessionId: ID, markId: 4, decision: 'k1h1e10' }]);
    expect(store.session(ID).links.marks['4']).toBe('k1h1e10');
    expect(within(card(4)).getByText('東2局1本場 8巡目 · 鳴きの迷い')).toBeInTheDocument();
  });

  it('「選び直す」→「やめる」: 何も保存せず、元の表示（推定）に戻る', async () => {
    const { user, mock } = setup();
    await tableReady();
    await user.click(within(card(1)).getByRole('button', { name: '迷い1を選び直す' }));
    expect(within(card(1)).getByText('手で選ぶ')).toBeInTheDocument();
    // いまの局が選んである。判断のメニューにも、いまの判断が印の付いた形で出る。
    expect(within(card(1)).getByRole('button', { name: '迷い1の局 東1局' })).toBeInTheDocument();
    await user.click(within(card(1)).getByRole('button', { name: '迷い1の選び直しをやめる' }));
    expect(within(card(1)).getByText('自分：打5p')).toBeInTheDocument();
    expect(within(card(1)).getByText('推定')).toBeInTheDocument();
    expect(within(card(1)).getByRole('button', { name: '迷い1を選び直す' })).toHaveFocus();
    expect(calls(mock, 'set_mark_link')).toEqual([]);
  });

  it('局面を手で選ぶ（迷い 1）: 局を選ぶと判断のメニューが使え、判断を選ぶと保存する。Ctrl+Z で、手で選ぶ状態に戻る', async () => {
    const { user, mock, store } = setup({ session: manualSession() });
    await tableReady();
    const one = card(1);
    await user.click(within(one).getByRole('button', { name: '迷い1の局を選ぶ' }));
    const kyokuMenu = screen.getByRole('menu', { name: '迷い1の局' });
    expect(within(kyokuMenu).getAllByRole('menuitemradio').map((i) => i.textContent)).toEqual([
      '東1局',
      '東2局',
      '東2局1本場',
      '東3局',
      '東3局1本場',
    ]);
    await user.click(within(kyokuMenu).getByRole('menuitemradio', { name: '東3局1本場' }));
    expect(screen.queryByRole('menu')).toBeNull();
    expect(within(one).getByRole('button', { name: '迷い1の局 東3局1本場' })).toHaveFocus();
    expect(calls(mock, 'set_mark_link')).toEqual([]); // 局を選んだだけでは、保存しない

    const decisionButton = within(one).getByRole('button', { name: '迷い1の判断を選ぶ' });
    expect(decisionButton).toBeEnabled();
    await user.click(decisionButton);
    const decisionMenu = screen.getByRole('menu', { name: '迷い1の判断' });
    expect(within(decisionMenu).getAllByRole('menuitemradio')).toHaveLength(17);
    await user.click(within(decisionMenu).getByRole('menuitemradio', { name: '9巡目 · 打北' }));

    await waitFor(() => expect(within(one).getByText('自分：打北')).toBeInTheDocument());
    expect(calls(mock, 'set_mark_link')).toEqual([{ sessionId: ID, markId: 1, decision: 'k2h1e10' }]);
    expect(within(one).getByText('東3局1本場 9巡目 · 打牌の迷い')).toBeInTheDocument();
    expect(within(one).queryByText('推定')).toBeNull();
    expect(store.session(ID).links.marks['1']).toBe('k2h1e10');

    await undoKey(user);
    await waitFor(() => expect(within(one).getByText('局面は決まっていません')).toBeInTheDocument());
    expect(calls(mock, 'clear_mark_link')).toEqual([{ sessionId: ID, markId: 1 }]);
  });

  it('U-24 局だけ分かった迷い（迷い 6）から判断を選ぶ: 局の幅の中の判断（東3局1本場の 17）だけが並ぶ。選ぶと保存して、カードは選んだ形になる。Ctrl+Z で、局だけ分かった状態に戻る', async () => {
    const { user, mock, store } = setup();
    await tableReady();
    const six = card(6);
    // 局のメニューには、局の幅の中の局（東3局1本場）だけ
    await user.click(within(six).getByRole('button', { name: '迷い6の局 東3局1本場' }));
    expect(within(screen.getByRole('menu', { name: '迷い6の局' })).getAllByRole('menuitemradio').map((i) => i.textContent)).toEqual(['東3局1本場']);
    await user.keyboard('{Escape}');
    await user.click(within(six).getByRole('button', { name: '迷い6の判断を選ぶ' }));
    const decisionMenu = screen.getByRole('menu', { name: '迷い6の判断' });
    expect(within(decisionMenu).getAllByRole('menuitemradio')).toHaveLength(17);
    await user.click(within(decisionMenu).getByRole('menuitemradio', { name: '11巡目 · 打3m' }));

    await waitFor(() => expect(within(six).getByText('自分：打3m')).toBeInTheDocument());
    expect(calls(mock, 'set_mark_link')).toEqual([{ sessionId: ID, markId: 6, decision: 'k2h1e14' }]);
    expect(store.session(ID).links.marks['6']).toBe('k2h1e14');
    // 利用者が選んだ形: 局と巡目、「選び直す」。局をどう決めたかの 1 文は、もう出ない
    expect(within(six).getByText('東3局1本場 11巡目 · 打牌の迷い')).toBeInTheDocument();
    expect(six.querySelector('.mhow')).toBeNull();
    expect(within(six).getByRole('button', { name: '迷い6を選び直す' })).toHaveFocus();

    await undoKey(user);
    await waitFor(() => expect(within(six).getByText('東3局1本場 · 巡目は決まっていません')).toBeInTheDocument());
    expect(calls(mock, 'clear_mark_link')).toEqual([{ sessionId: ID, markId: 6 }]);
    expect(six.querySelector('.mhow')).not.toBeNull();
  });

  it('「選び直す」の札のとなりの「手で選ぶ」で、手で選ぶ欄に替わる。「候補から選ぶ」で札に戻る（保存はしない）', async () => {
    const { user, mock } = setup();
    await tableReady();
    await user.click(within(card(5)).getByRole('button', { name: '迷い5を選び直す' }));
    await user.click(within(card(5)).getByRole('button', { name: '迷い5の局面を手で選ぶ' }));
    expect(within(card(5)).getByText('手で選ぶ')).toBeInTheDocument();
    expect(within(card(5)).queryByText('選んでください')).toBeNull();
    // 2 行目は、推定のまま（選び直しの途中で、まだ何も決めていない）。
    expect(within(card(5)).getByText('東3局1本場 6〜7巡目 · 打牌の迷い')).toBeInTheDocument();
    await user.click(within(card(5)).getByRole('button', { name: '迷い5の候補から選ぶ' }));
    expect(within(card(5)).getByText('選んでください')).toBeInTheDocument();
    expect(calls(mock, 'set_mark_link')).toEqual([]);
  });

  it('決まっている判断を選び直して、同じ判断を選んだときは、保存し直さない（利用者が選んだものを、もう一度選んだとき）', async () => {
    const { user, mock } = setup({
      session: imported({ links: { ...IMPORTED_LINKS, marks: { '1': 'k0h0e4' } } }),
    });
    await tableReady();
    await user.click(within(card(1)).getByRole('button', { name: '迷い1を選び直す' }));
    await user.click(within(card(1)).getByRole('button', { name: '迷い1の判断 4巡目 · 打5p' }));
    await user.click(screen.getByRole('menuitemradio', { name: '4巡目 · 打5p' }));
    expect(calls(mock, 'set_mark_link')).toEqual([]);
    expect(within(card(1)).getByText('自分：打5p')).toBeInTheDocument();
  });

  it('保存できなかったときは、選ぶ前の欄のまま（推定のまま。取り消せるものも増えない）', async () => {
    const { user } = setup({
      handlers: {
        set_mark_link: () => {
          throw '保存できませんでした';
        },
      },
    });
    await tableReady();
    await user.click(within(card(4)).getByRole('button', { name: '9巡目 打7p' }));
    await waitFor(() => expect(within(card(4)).getByText('推定')).toBeInTheDocument());
    expect(within(card(4)).getByText('自分：東をポン')).toBeInTheDocument();
    await undoKey(user);
    expect(within(card(4)).getByText('自分：東をポン')).toBeInTheDocument();
  });

  it('メニューは Esc で閉じ、何も保存しない。キーボードの位置は開いたボタンへ戻る', async () => {
    const { user, mock } = setup();
    await tableReady();
    const open = within(card(6)).getByRole('button', { name: '迷い6の局 東3局1本場' });
    await user.click(open);
    expect(screen.getByRole('menu', { name: '迷い6の局' })).toBeInTheDocument();
    await user.keyboard('{Escape}');
    expect(screen.queryByRole('menu')).toBeNull();
    expect(open).toHaveFocus();
    expect(calls(mock, 'set_mark_link')).toEqual([]);
  });
});

describe('F9 画像を大きく表示する求め', () => {
  it('カードの画像を押すと、画像のある迷いの一覧と、押した迷いの位置を渡す。説明は「迷いN · 局 · 巡目 · 種類（· 推定）」と時刻', async () => {
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
      caption: '迷い3 · 東2局1本場 · 6巡目 · 打牌の迷い · 推定',
      time: '19:17:37',
    });
    expect(request.items.map((i) => i.caption)).toEqual([
      '迷い1 · 東1局 · 4巡目 · 打牌の迷い · 推定',
      '迷い2 · 東2局 · 11〜12巡目 · 打牌の迷い · 推定',
      '迷い3 · 東2局1本場 · 6巡目 · 打牌の迷い · 推定',
      '迷い4 · 東2局1本場 · 8〜9巡目 · 鳴きの迷い · 推定',
      '迷い5 · 東3局1本場 · 6〜7巡目 · 打牌の迷い · 推定',
      '迷い6 · 東3局1本場 · 巡目は決まっていません',
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
    const { user } = setup({ session: manualSession() });
    const table = await tableReady();
    const check = () => {
      const html = withoutImageUrls(document.body.innerHTML);
      expect(html).not.toMatch(/data-ai/i);
      expect(html).not.toMatch(/\d\s*[%％]|確率|順位|probab|\bprob\b|q_value/i);
    };
    await user.click(within(card(1)).getByRole('button', { name: '迷い1の局を選ぶ' }));
    check();
    await user.click(screen.getByRole('menuitemradio', { name: '東2局' }));
    await user.click(within(card(1)).getByRole('button', { name: '迷い1の判断を選ぶ' }));
    check();
    await user.click(screen.getByRole('menuitemradio', { name: '8巡目 · 打4s' }));
    await waitFor(() => expect(within(card(1)).getByText('自分：打4s')).toBeInTheDocument());
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
    const { user } = setup({ session: manualSession() });
    await tableReady();
    let checkedPicks = 0;
    for (let position = 0; position < report.review.kyokus.length; position += 1) {
      const kyokuLabel = refs.find((r) => r.kyokuPosition === position)?.kyokuLabel ?? '';
      await user.click(within(card(1)).getByRole('button', { name: /^迷い1の局/ }));
      await user.click(screen.getByRole('menuitemradio', { name: kyokuLabel }));
      await user.click(within(card(1)).getByRole('button', { name: /^迷い1の判断/ }));
      const menu = screen.getByRole('menu', { name: '迷い1の判断' });
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

/** 前の作り方（v1）で読んだ写し: 1 回目の読み取りだけ（迷い 6 は読めない）。決まりの名前が、いまの作り方と違う。 */
const OLD_OCR: OcrCache = { ...fx4Ocr(), geometry: 'center-v1-lanczos3x' };
/** 迷い 6 に、ユーザーが選んだ判断: 東3局1本場 11巡目 打3m（残り29）。読み直しで 東3局・残り38 と読めると、離れている。 */
const MARK6_FAR = 'k2h1e14';
const FAR_LINKS: Links = { ...IMPORTED_LINKS, marks: { '6': MARK6_FAR } };
const FAR_LINE = 'スクショの値（残り38）と離れています。選んだ局面は残り29です。';

function deferred(): { promise: Promise<void>; resolve: () => void } {
  let resolve!: () => void;
  const promise = new Promise<void>((done) => {
    resolve = done;
  });
  return { promise, resolve };
}

describe('F9・E-27・U-13 離れている（読み直したあとの FX-4 の迷い 6）', () => {
  const farSetup = (links: Links = FAR_LINKS, ocr: OcrCache = fx4Ocr({ retries: true })) =>
    setup({ session: imported({ ocr, links }) });
  const lineOf = (n: number) => card(n).querySelector('.mfar');
  const chipsOf = (n: number) => Array.from(card(n).querySelectorAll('.chip')).map((b) => b.textContent);

  it('迷い 6: 「自分：打3m」の下に、警告のアイコンと「スクショの値（残り38）と離れています。選んだ局面は残り29です。」。ほかの候補は、推定（打北）が先で「（推定）」つき', async () => {
    farSetup();
    await tableReady();
    const six = card(6);
    expect(six.querySelector('.mwhat')?.textContent).toBe('東3局1本場 11巡目 · 打牌の迷い');
    expect(six.querySelector('.mread')?.textContent).toBe('スクショ: 東3局・残り38・4,400点');
    expect(six.querySelector('.mact > span:not(.tag)')?.textContent).toBe('自分：打3m');
    expect(six.querySelector('.tag.est')).toBeNull(); // 利用者が選んだもの: 「推定」の印は付けない
    const line = lineOf(6);
    expect(line?.textContent).toBe(FAR_LINE);
    // 警告のアイコンは、線の絵（色は文字と同じ）。読み上げない。
    const icon = line?.querySelector('svg.ic');
    expect(icon).not.toBeNull();
    expect(icon).toHaveAttribute('aria-hidden', 'true');
    // 並び: 1 行目 → 局面 → 読んだ値 → 自分 → 離れている → ほかの候補
    expect(six.querySelector('.mtop + .mwhat + .mread + .msub + .mfar + .malt')).not.toBeNull();
    expect(six.querySelector('.malt-lbl')?.textContent).toBe('ほかの候補');
    const group = within(six).getByRole('group', { name: '迷い6のほかの候補' });
    expect(within(group).getAllByRole('button').map((b) => b.textContent)).toEqual(['9巡目 打北（推定）', '8巡目 鳴かない判断']);
    for (const chip of group.querySelectorAll('.chip')) expect(chip).toHaveAttribute('aria-pressed', 'false');
    expect(within(six).getByRole('button', { name: '迷い6を選び直す' })).toBeInTheDocument();
  });

  it('離れていない迷い（1〜5）は、これまでどおり: 1 行は無く、推定の迷いのほかの候補の札に「（推定）」は付かない', async () => {
    farSetup();
    await tableReady();
    for (const n of [1, 2, 3, 4, 5]) {
      expect(lineOf(n), `迷い${n}`).toBeNull();
      expect(card(n).querySelector('.tag.est')?.textContent, `迷い${n}`).toBe('推定');
    }
    expect([1, 2, 3, 4, 5].map(chipsOf)).toEqual([
      [],
      ['12巡目 打9m', '11巡目 鳴かない判断'],
      [],
      ['9巡目 打7p'],
      ['7巡目 打1p'],
    ]);
  });

  it('ユーザーが選んだ判断（E-17）にした迷い 1〜5 は、選んでいても離れていない（1 行は無い）', async () => {
    const marks = { '1': 'k0h0e4', '2': 'k1h0e12', '3': 'k1h1e7', '4': 'k1h1e10', '5': 'k2h1e6' };
    farSetup({ ...IMPORTED_LINKS, marks });
    await tableReady();
    for (const n of [1, 2, 3, 4, 5, 6]) expect(lineOf(n), `迷い${n}`).toBeNull();
  });

  it('読み取りと違う局の判断を選んだ迷いは、局の名前を書く: 「スクショの値（東3局・残り46）と離れています。選んだ局面は東2局1本場です。」', async () => {
    farSetup({ ...IMPORTED_LINKS, marks: { '5': 'k1h1e7' } });
    await tableReady();
    expect(lineOf(5)?.textContent).toBe('スクショの値（東3局・残り46）と離れています。選んだ局面は東2局1本場です。');
    expect(card(5).querySelector('.mact > span:not(.tag)')?.textContent).toBe('自分：打南');
    expect(chipsOf(5)).toEqual(['6巡目 打9m（推定）', '7巡目 打1p']);
    expect(lineOf(6)).toBeNull(); // 迷い 6 は、選んでいない（推定のまま）
  });

  it('読み直しの前（迷い 6 が読めない写し）は、選んだ判断があっても、離れているとは出さない', async () => {
    farSetup(FAR_LINKS, fx4Ocr());
    await tableReady();
    expect(lineOf(6)).toBeNull();
    expect(card(6).querySelector('.mread')?.textContent).toBe('スクショを読めませんでした');
    expect(card(6).querySelector('.mact > span:not(.tag)')?.textContent).toBe('自分：打3m');
    expect(chipsOf(6)).toEqual([]);
  });

  it('推定の札を押すと、その判断に替わって保存する（links.json）。1 行も札も消え、「自分：打北」。Ctrl+Z で選んでいた判断に戻り、1 行も札も戻る（U-11）。Ctrl+Y でもう一度', async () => {
    const { user, mock, store } = farSetup();
    await tableReady();
    await user.click(within(card(6)).getByRole('button', { name: '9巡目 打北（推定）' }));
    await waitFor(() => expect(within(card(6)).getByText('自分：打北')).toBeInTheDocument());
    expect(calls(mock, 'set_mark_link')).toEqual([{ sessionId: ID, markId: 6, decision: 'k2h1e10' }]);
    expect(store.session(ID).links.marks['6']).toBe('k2h1e10');
    expect(lineOf(6)).toBeNull();
    expect(card(6).querySelector('.chip, .malt')).toBeNull();
    expect(within(card(6)).queryByText('推定')).toBeNull(); // 利用者が選んだもの: 印は付けない
    expect(within(card(6)).getByRole('button', { name: '迷い6を選び直す' })).toHaveFocus();

    await undoKey(user);
    await waitFor(() => expect(within(card(6)).getByText('自分：打3m')).toBeInTheDocument());
    expect(calls(mock, 'set_mark_link').at(-1)).toEqual({ sessionId: ID, markId: 6, decision: MARK6_FAR });
    expect(store.session(ID).links.marks['6']).toBe(MARK6_FAR);
    expect(lineOf(6)?.textContent).toBe(FAR_LINE);
    expect(chipsOf(6)).toEqual(['9巡目 打北（推定）', '8巡目 鳴かない判断']);

    await redoKey(user);
    await waitFor(() => expect(within(card(6)).getByText('自分：打北')).toBeInTheDocument());
    expect(store.session(ID).links.marks['6']).toBe('k2h1e10');
  });

  it('ほかの候補の札（8巡目 鳴かない判断）を押しても、その判断に替わる', async () => {
    const { user, mock } = farSetup();
    await tableReady();
    await user.click(within(card(6)).getByRole('button', { name: '8巡目 鳴かない判断' }));
    await waitFor(() => expect(within(card(6)).getByText('自分：鳴かない判断')).toBeInTheDocument());
    expect(calls(mock, 'set_mark_link')).toEqual([{ sessionId: ID, markId: 6, decision: 'k2h1e9' }]);
    expect(lineOf(6)).toBeNull();
    expect(card(6).querySelector('.mwhat')?.textContent).toBe('東3局1本場 8巡目 · 鳴きの迷い');
  });

  it('「選び直す」: 札（先頭に「（推定）」）が出る。どれも押されていない。「やめる」で、1 行と札が出ていた形に戻り、何も保存しない', async () => {
    const { user, mock } = farSetup();
    await tableReady();
    await user.click(within(card(6)).getByRole('button', { name: '迷い6を選び直す' }));
    expect(lineOf(6)).toBeNull();
    expect(chipsOf(6)).toEqual(['9巡目 打北（推定）', '8巡目 鳴かない判断']);
    expect(within(card(6)).queryAllByRole('button', { pressed: true })).toHaveLength(0);
    expect(within(card(6)).getByText('選んでください')).toBeInTheDocument();
    await user.click(within(card(6)).getByRole('button', { name: '迷い6の選び直しをやめる' }));
    expect(lineOf(6)?.textContent).toBe(FAR_LINE);
    expect(chipsOf(6)).toEqual(['9巡目 打北（推定）', '8巡目 鳴かない判断']);
    expect(calls(mock, 'set_mark_link')).toEqual([]);
  });

  it('この画面に AI の答えは出ない: 1 行にも札にも、確率・順位・AI の第 1 位は無い（U-1）', async () => {
    farSetup();
    await tableReady();
    const html = document.body.innerHTML.replace(/ src="[^"]*"/g, '');
    expect(html).not.toMatch(/data-ai/i);
    expect(html).not.toMatch(/\d\s*[%％]|確率|順位|probab|\bprob\b|q_value/i);
    expect(lineOf(6)?.textContent).not.toMatch(/AI|確率|順位/);
  });
});

describe('F11・E-27・U-23 前の作り方で読んだ半荘の読み直し', () => {
  const REREAD_STATUS = 'スクショを新しい読み取りで読み直しています';
  const statusLine = () => screen.queryByRole('status');
  const staleSession = () => imported({ ocr: OLD_OCR, links: FAR_LINKS });
  const LINK_COMMANDS = ['set_mark_link', 'clear_mark_link', 'replace_links', 'set_rating_link', 'clear_rating_link'];

  it('開くと 1 回だけ読み直す: 読み直している間は、前の読み取りの値で描いて、静かな 1 行を出す。済んだら、新しい読み取りの値で描き直して、1 行を消す', async () => {
    const hold = deferred();
    const { store, mock } = setup({ session: staleSession(), reread: { hold: hold.promise } });
    const linksBefore = structuredClone(store.session(ID).links);
    await tableReady();

    // 読み直している間
    expect(await screen.findByRole('status')).toHaveTextContent(REREAD_STATUS);
    expect(screen.getAllByRole('status')).toHaveLength(1);
    expect(calls(mock, 'needs_ocr_reread')).toEqual([{ sessionId: ID }]);
    expect(calls(mock, 'reread_ocr')).toEqual([{ sessionId: ID }]);
    // 前の読み取り（1 回目だけ）の値: 迷い 6 は読めず、離れているとも出ない。選んだ判断は、そのまま。
    expect(card(6).querySelector('.mread')?.textContent).toBe('スクショを読めませんでした');
    expect(card(6).querySelector('.mfar')).toBeNull();
    expect(card(6).querySelector('.mact > span:not(.tag)')?.textContent).toBe('自分：打3m');
    expect(card(1).querySelector('.mread')?.textContent).toBe('スクショ: 東1局・残り59・25,000点');

    hold.resolve();
    await waitFor(() => expect(statusLine()).toBeNull());
    // 新しい読み取りの値で描き直した: 迷い 6 が 東3局・残り38・4400点 と読めて、選んだ判断が離れていると分かる。
    expect(card(6).querySelector('.mread')?.textContent).toBe('スクショ: 東3局・残り38・4,400点');
    expect(card(6).querySelector('.mfar')?.textContent).toBe(FAR_LINE);
    expect(Array.from(card(6).querySelectorAll('.chip')).map((b) => b.textContent)).toEqual(['9巡目 打北（推定）', '8巡目 鳴かない判断']);
    expect(store.session(ID).ocr?.geometry).toBe(OCR_GEOMETRY);

    // 読み直しは 1 回だけ。結びつけ（links.json）は、保存し直さず、変わっていない。
    expect(calls(mock, 'reread_ocr')).toHaveLength(1);
    expect(store.session(ID).links).toEqual(linksBefore);
    for (const cmd of LINK_COMMANDS) expect(calls(mock, cmd), cmd).toEqual([]);
  });

  it('読み直している間も、画面は使える: 前の値のまま「ほかの候補」の札から選べて、保存できる', async () => {
    const hold = deferred();
    const { user, mock } = setup({ session: staleSession(), reread: { hold: hold.promise } });
    await tableReady();
    await screen.findByRole('status');
    await user.click(within(card(4)).getByRole('button', { name: '9巡目 打7p' }));
    await waitFor(() => expect(within(card(4)).getByText('自分：打7p')).toBeInTheDocument());
    expect(calls(mock, 'set_mark_link')).toEqual([{ sessionId: ID, markId: 4, decision: 'k1h1e11' }]);
    hold.resolve();
    await waitFor(() => expect(statusLine()).toBeNull());
    // 読み直しのあとも、選んだ判断は残る。
    expect(within(card(4)).getByText('自分：打7p')).toBeInTheDocument();
  });

  it('ページを閉じて開き直しても、この起動の間は、もう読み直さない（読み直している最中に戻ったときは、状態の 1 行が出る）', async () => {
    const hold = deferred();
    const { mock, reopen } = setup({ session: staleSession(), reread: { hold: hold.promise } });
    await tableReady();
    await screen.findByRole('status');
    // 読み直している最中に、ページを閉じて開き直す。
    reopen();
    await tableReady();
    expect(await screen.findByRole('status')).toHaveTextContent(REREAD_STATUS);
    expect(calls(mock, 'reread_ocr')).toHaveLength(1);
    hold.resolve();
    await waitFor(() => expect(statusLine()).toBeNull());
    // 済んだあとに開き直しても、確かめもしない。
    reopen();
    await tableReady();
    expect(statusLine()).toBeNull();
    expect(calls(mock, 'needs_ocr_reread')).toHaveLength(1);
    expect(calls(mock, 'reread_ocr')).toHaveLength(1);
    expect(card(6).querySelector('.mfar')?.textContent).toBe(FAR_LINE);
  });

  it('いまの作り方で読んだ半荘は、読み直さない: 状態の 1 行は出ず、読み直しは呼ばれない', async () => {
    const { mock } = setup({ session: imported({ ocr: fx4Ocr({ retries: true }), links: FAR_LINKS }), reread: {} });
    await tableReady();
    await waitFor(() => expect(calls(mock, 'needs_ocr_reread')).toEqual([{ sessionId: ID }]));
    expect(statusLine()).toBeNull();
    expect(calls(mock, 'reread_ocr')).toEqual([]);
    expect(card(6).querySelector('.mfar')?.textContent).toBe(FAR_LINE);
  });

  it('読み取りの写しが無い半荘・取り込む前の半荘は、確かめもしない', async () => {
    const withoutOcr = setup({ session: imported({ ocr: null }), reread: {} });
    await tableReady();
    expect(calls(withoutOcr.mock, 'needs_ocr_reread')).toEqual([]);
    expect(calls(withoutOcr.mock, 'reread_ocr')).toEqual([]);
    expect(statusLine()).toBeNull();
    cleanup();

    const notImported = setup({ session: recorded(), reread: {} });
    expect(calls(notImported.mock, 'needs_ocr_reread')).toEqual([]);
    expect(calls(notImported.mock, 'reread_ocr')).toEqual([]);
  });

  it('読み直しに失敗したときは、前の読み取りのまま: 状態の 1 行は消え、画面の値は変わらず、もう一度は試さない（開き直しても）。links.json も変わらない', async () => {
    const { store, mock, reopen } = setup({
      session: staleSession(),
      reread: { failWith: '日本語の文字認識が使えません' },
    });
    const linksBefore = structuredClone(store.session(ID).links);
    await tableReady();
    await waitFor(() => expect(calls(mock, 'reread_ocr')).toHaveLength(1));
    await waitFor(() => expect(statusLine()).toBeNull());
    expect(card(6).querySelector('.mread')?.textContent).toBe('スクショを読めませんでした');
    expect(card(6).querySelector('.mfar')).toBeNull();
    expect(store.session(ID).ocr).toEqual(OLD_OCR);
    expect(store.session(ID).links).toEqual(linksBefore);

    reopen();
    await tableReady();
    expect(statusLine()).toBeNull();
    expect(calls(mock, 'needs_ocr_reread')).toHaveLength(1);
    expect(calls(mock, 'reread_ocr')).toHaveLength(1);
    for (const cmd of LINK_COMMANDS) expect(calls(mock, cmd), cmd).toEqual([]);
  });

  it('状態の 1 行は、見出し「迷い（6）」のとなり（同じ行の中）。見出しの名前は変わらない', async () => {
    const hold = deferred();
    setup({ session: staleSession(), reread: { hold: hold.promise } });
    await tableReady();
    const line = await screen.findByRole('status');
    const heading = screen.getByRole('heading', { level: 2, name: '迷い（6）' });
    expect(line.parentElement).toBe(heading.parentElement);
    expect(line).toHaveClass('quiet');
    hold.resolve();
    await waitFor(() => expect(statusLine()).toBeNull());
    expect(screen.getByRole('heading', { level: 2, name: '迷い（6）' })).toBeInTheDocument();
  });

  it('この画面に AI の答えは出ない: 読み直している間も、済んだあとも（U-1）', async () => {
    const hold = deferred();
    setup({ session: staleSession(), reread: { hold: hold.promise } });
    await tableReady();
    await screen.findByRole('status');
    const check = () => {
      const html = document.body.innerHTML.replace(/ src="[^"]*"/g, '');
      expect(html).not.toMatch(/data-ai/i);
      expect(html).not.toMatch(/\d\s*[%％]|確率|順位|probab|\bprob\b|q_value/i);
    };
    check();
    hold.resolve();
    await waitFor(() => expect(statusLine()).toBeNull());
    check();
  });
});

// ---- FX-5（10月11日の半荘）----

/** 取り込んだ FX-5 の半荘。ユーザーの本物の links.json（前の当てはめ方で作った評価。評価の版は無い）と、表で付け直した南4局の △ を持つ。 */
const FX5_OLD_RATINGS: Record<string, string> = {
  '1': 'k0h0',
  '5': 'k1h0',
  '7': 'k2h0',
  '11': 'k2h1',
  '12': 'k3h0',
  '15': 'k3h1',
  '18': 'k4h2',
  '20': 'k5h0',
  '22': 'k6h0',
};
function fx5Imported(overrides: Partial<SessionRecord> = {}): SessionRecord {
  return fx5Session(FX5_ID, FX5_STARTED, {
    report_path: `C:\\data\\games\\${FX5_ID}\\report.json`,
    ocr: fx5Ocr(),
    links: { marks: {}, ratings: {} },
    ...overrides,
  });
}

describe('U-24 局だけ分かった迷いと、崩れた読み取りの迷いのカード（FX-5）', () => {
  const setupFx5 = (session: SessionRecord = fx5Imported(), more: Partial<SetupOptions> = {}) =>
    setup({ session, report: 'fx5', summary: summaryOf('fx5'), ...more });
  /** カードの欄の文字を、確かめやすい形で取り出す。 */
  function textsOf(n: number) {
    const c = card(n);
    return {
      what: c.querySelector('.mwhat')?.textContent ?? null,
      read: c.querySelector('.mread')?.textContent ?? null,
      how: c.querySelector('.mhow')?.textContent ?? null,
      tag: c.querySelector('.tag.est')?.textContent ?? null,
      mine: c.querySelector('.mact > span:not(.tag)')?.textContent ?? null,
    };
  }

  it('局だけ分かった迷い（15:38:10 = 迷い3、15:42:37 = 迷い5）: 局の名前と「巡目は決まっていません」・読んだ値・局をどう決めたかの 1 文。推定の印は無い', async () => {
    setupFx5();
    await tableReady();
    expect(textsOf(3)).toEqual({
      what: '東2局 · 巡目は決まっていません',
      read: 'スクショ: 風は読めず・2局・残りは読めず・25,000点',
      how: '局の名前の一部が読めなかったので、読めた部分と点数から、東2局です。',
      tag: null,
      mine: null,
    });
    expect(textsOf(5)).toEqual({
      what: '東4局 · 巡目は決まっていません',
      read: 'スクショを読めませんでした',
      how: '東3局1本場の評価（15:41:44）と東4局の迷い6（15:42:52）の間に押したので、東4局です。',
      tag: null,
      mine: null,
    });
  });

  it('局だけ分かった迷いは、局の幅の中の判断を並べて選べる: 局は選んである。判断のメニューは、その局の判断だけ（迷い3は東2局の15、迷い5は東4局の16）', async () => {
    const { user } = setupFx5();
    await tableReady();
    for (const [n, kyoku, count] of [
      [3, '東2局', 15],
      [5, '東4局', 16],
    ] as const) {
      const c = card(n);
      expect(within(c).getByText('手で選ぶ')).toBeInTheDocument();
      await user.click(within(c).getByRole('button', { name: `迷い${n}の局 ${kyoku}` }));
      expect(within(screen.getByRole('menu', { name: `迷い${n}の局` })).getAllByRole('menuitemradio').map((i) => i.textContent)).toEqual([kyoku]);
      await user.keyboard('{Escape}');
      await user.click(within(c).getByRole('button', { name: `迷い${n}の判断を選ぶ` }));
      const menu = screen.getByRole('menu', { name: `迷い${n}の判断` });
      expect(within(menu).getAllByRole('menuitemradio'), `迷い${n}`).toHaveLength(count);
      await user.keyboard('{Escape}');
    }
  });

  it('ユーザーが選んだとおりの判断（15:38:10 は東2局8巡目の打9m）を選ぶと、保存して、選んだ形（局と巡目・自分の行動・選び直す）になる。局をどう決めたかの 1 文は消える', async () => {
    const { user, mock, store } = setupFx5();
    await tableReady();
    await user.click(within(card(3)).getByRole('button', { name: '迷い3の判断を選ぶ' }));
    await user.click(screen.getByRole('menuitemradio', { name: '8巡目 · 打9m' }));
    await waitFor(() => expect(within(card(3)).getByText('自分：打9m')).toBeInTheDocument());
    expect(calls(mock, 'set_mark_link')).toEqual([{ sessionId: FX5_ID, markId: 4, decision: 'k1h0e8' }]);
    expect(store.session(FX5_ID).links.marks['4']).toBe('k1h0e8');
    expect(textsOf(3)).toEqual({
      what: '東2局 8巡目 · 打牌の迷い',
      read: 'スクショ: 風は読めず・2局・残りは読めず・25,000点',
      how: null,
      tag: null,
      mine: '自分：打9m',
    });
  });

  it('崩れた読み取りで局が決まり、残り枚数も読めた迷い（15:37:02 = 迷い1）は、推定が付く（ユーザーが選んだ 5巡目 の打6s）。局の決め方の 1 文も付く', async () => {
    setupFx5();
    await tableReady();
    expect(textsOf(1)).toEqual({
      what: '東2局 5巡目 · 打牌の迷い',
      read: 'スクショ: 風は読めず・2局・残り50・25,000点',
      how: '局の名前の一部が読めなかったので、読めた部分と点数から、東2局です。',
      tag: '推定',
      mine: '自分：打6s',
    });
    expect(textsOf(8).mine).toBe('自分：打1s'); // 15:50:36（南1局2本場 3巡目。ユーザーが選んだ判断）
    expect(textsOf(13).mine).toBe('自分：打2p'); // 16:03:19（南4局 6巡目のリーチ。ユーザーが選んだ判断）
    expect(textsOf(13).read).toBe('スクショ: 南・局の番号は読めず・残り49・28,500点');
  });

  it('すべて読めた迷い（15:37:25 = 迷い2）には、局の決め方の 1 文は付かない（これまでどおり）', async () => {
    setupFx5();
    await tableReady();
    expect(textsOf(2)).toMatchObject({ what: '東2局 6巡目 · 打牌の迷い', read: 'スクショ: 東2局・残り46・25,000点', how: null, tag: '推定' });
  });

  it('ユーザーが選んだ迷いは、選んだ形のまま（局の決め方の 1 文は付かない）。局だけ分かった迷いを選ぶと、ほかの迷いの局の幅も変わらない', async () => {
    setupFx5(fx5Imported({ links: { marks: { ...FX5_USER_CHOICES }, ratings: {} } }));
    await tableReady();
    expect(textsOf(5)).toEqual({
      what: '東4局 5巡目 · 打牌の迷い',
      read: 'スクショを読めませんでした',
      how: null,
      tag: null,
      mine: '自分：打2s',
    });
    expect(textsOf(1).how).toBeNull();
    expect(textsOf(1).tag).toBeNull();
  });

  it('画像の大きな表示の説明も、局だけ分かった迷いは「局 · 巡目は決まっていません」', async () => {
    const { user, onOpenImage } = setupFx5();
    await tableReady();
    await user.click(within(card(5)).getByRole('button', { name: '迷い5の画像を大きく見る' }));
    const request = onOpenImage.mock.calls[0]?.[0] as { items: Array<{ caption: string }>; start: number };
    expect(request.items).toHaveLength(13);
    expect(request.items[4]?.caption).toBe('迷い5 · 東4局 · 巡目は決まっていません');
    expect(request.items[2]?.caption).toBe('迷い3 · 東2局 · 巡目は決まっていません');
  });

  it('この画面に AI の答えは出ない: 局だけ分かった迷い・崩れた読み取りの迷いの文にも、確率・順位は無い（U-1）', async () => {
    const { user } = setupFx5();
    await tableReady();
    await user.click(within(card(5)).getByRole('button', { name: '迷い5の判断を選ぶ' }));
    const html = document.body.innerHTML.replace(/ src="[^"]*"/g, '');
    expect(html).not.toMatch(/data-ai/i);
    expect(html).not.toMatch(/\d\s*[%％]|確率|順位|probab|\bprob\b|q_value/i);
  });
});

describe('E-31 前の当てはめ方で作った評価の結びつけを、半荘の画面を開いたときに、1 回だけ当てはめ直す（FX-5）', () => {
  /** 局の評価の表の、局ごとの自分の評価（ボタンの名前）。 */
  const selfLabels = (table: HTMLElement) =>
    within(table)
      .getAllByRole('row')
      .slice(1, 11)
      .map((row) => within(row).getByRole('button', { name: /の自分の評価/ }).getAttribute('aria-label'));
  /** ユーザーの本物の状態: 前の当てはめ方で作った評価（東3局1本場から後が 1 局ずつ前にずれている）と、表で付け直した南4局の △。 */
  const oldSession = (): SessionRecord =>
    fx5Imported({
      links: { marks: { ...FX5_USER_CHOICES }, ratings: { ...FX5_OLD_RATINGS } },
      self_ratings: { kyokus: { k7h0: 'fair' } },
    });

  const BEFORE = [
    '東1局の自分の評価（△）',
    '東2局の自分の評価（△）',
    '東3局の自分の評価（〇）',
    '東3局1本場の自分の評価（✕）',
    '東4局の自分の評価（〇）',
    '東4局1本場の自分の評価（△）',
    '南1局2本場の自分の評価（✕）',
    '南2局の自分の評価（〇）',
    '南3局の自分の評価（✕）',
    '南4局の自分の評価（△）',
  ];
  const AFTER = [
    '東1局の自分の評価（△）',
    '東2局の自分の評価（△）',
    '東3局の自分の評価を付ける',
    '東3局1本場の自分の評価（〇）',
    '東4局の自分の評価（✕）',
    '東4局1本場の自分の評価（〇）',
    '南1局2本場の自分の評価（△）',
    '南2局の自分の評価（✕）',
    '南3局の自分の評価（〇）',
    '南4局の自分の評価（△）', // 表で付け直した △（ウィジェットの✕は、上書きされる）
  ];

  it('開くと当てはめ直して保存する: 表の評価が 東1局 △・東2局 △・東3局 空・東3局1本場 〇・東4局 ✕・東4局1本場 〇・南1局2本場 △・南2局 ✕・南3局 〇・南4局 △（自分で付け直した）になる', async () => {
    // 当てはめ直しを付けないと、保存してある（前の当てはめ方の）評価の局のまま
    setup({ session: oldSession(), report: 'fx5', summary: summaryOf('fx5') });
    expect(selfLabels(await tableReady())).toEqual(BEFORE);
    cleanup();

    const { mock, store } = setup({ session: oldSession(), report: 'fx5', summary: summaryOf('fx5'), relink: true });
    await tableReady();
    await waitFor(() => expect(calls(mock, 'replace_rating_links')).toHaveLength(1));
    expect(calls(mock, 'replace_rating_links')[0]).toEqual({
      sessionId: FX5_ID,
      ratings: { '1': 'k0h0', '5': 'k1h0', '7': 'k2h1', '11': 'k3h0', '12': 'k3h1', '15': 'k4h2', '18': 'k5h0', '20': 'k6h0', '22': 'k7h0' },
      version: 2,
    });
    await waitFor(() => expect(selfLabels(screen.getByRole('table', { name: '局の評価' }))).toEqual(AFTER));
    expect(store.session(FX5_ID).links.ratings_version).toBe(2);
  });

  it('迷いの結びつけ（links.marks）と、表で付け直した〇△✕（self-ratings）は変わらない。迷いの結びつけの保存の命令は呼ばない', async () => {
    const { mock, store } = setup({ session: oldSession(), report: 'fx5', summary: summaryOf('fx5'), relink: true });
    await tableReady();
    await waitFor(() => expect(calls(mock, 'replace_rating_links')).toHaveLength(1));
    await waitFor(() => expect(selfLabels(screen.getByRole('table', { name: '局の評価' }))).toEqual(AFTER));
    expect(store.session(FX5_ID).links.marks).toEqual({ ...FX5_USER_CHOICES });
    expect(store.session(FX5_ID).self_ratings).toEqual({ kyokus: { k7h0: 'fair' } });
    for (const command of ['set_mark_link', 'clear_mark_link', 'replace_links', 'set_rating_link', 'clear_rating_link', 'set_self_rating', 'clear_self_rating']) {
      expect(calls(mock, command), command).toEqual([]);
    }
  });

  it('開き直しても（この起動の間）、もう一度は当てはめない。アプリを起動し直しても（保存した版が新しい）、当てはめない', async () => {
    const first = setup({ session: oldSession(), report: 'fx5', summary: summaryOf('fx5'), relink: true });
    await tableReady();
    await waitFor(() => expect(calls(first.mock, 'replace_rating_links')).toHaveLength(1));
    await waitFor(() => expect(selfLabels(screen.getByRole('table', { name: '局の評価' }))).toEqual(AFTER));
    first.reopen();
    await tableReady();
    await new Promise((resolve) => setTimeout(resolve, 30));
    expect(calls(first.mock, 'replace_rating_links')).toHaveLength(1);

    // 起動し直し: 保存した記録（評価の結びつけと版）のまま、新しい読み直しの部品で開く
    const saved = first.store.session(FX5_ID);
    cleanup();
    const second = setup({ session: saved, report: 'fx5', summary: summaryOf('fx5'), relink: true });
    const table = await tableReady();
    await new Promise((resolve) => setTimeout(resolve, 30));
    expect(calls(second.mock, 'replace_rating_links')).toEqual([]);
    expect(selfLabels(table)).toEqual(AFTER);
  });

  it('当てはめ方の版が新しい半荘・取り込む前の半荘・評価が無い半荘は、当てはめ直さない（保存の命令を呼ばない）', async () => {
    const fresh = setup({
      session: fx5Imported({ links: { marks: {}, ratings: { ...FX5_OLD_RATINGS }, ratings_version: 2 } }),
      report: 'fx5',
      summary: summaryOf('fx5'),
      relink: true,
    });
    await tableReady();
    await new Promise((resolve) => setTimeout(resolve, 30));
    expect(calls(fresh.mock, 'replace_rating_links')).toEqual([]);
    cleanup();

    const noRatings = setup({ session: fx5Imported({ ratings: [], rating_count: 0 }), report: 'fx5', summary: summaryOf('fx5'), relink: true });
    await tableReady();
    await new Promise((resolve) => setTimeout(resolve, 30));
    expect(calls(noRatings.mock, 'replace_rating_links')).toEqual([]);
    cleanup();

    const before = setup({ session: recorded(), relink: true });
    await new Promise((resolve) => setTimeout(resolve, 30));
    expect(calls(before.mock, 'replace_rating_links')).toEqual([]);
  });

  it('読み取りの写しが無い半荘（文字認識を使えなかった）も、迷いの選びと押した順で、評価を当てはめ直す', async () => {
    const noOcr = setup({ session: { ...oldSession(), ocr: null }, report: 'fx5', summary: summaryOf('fx5'), relink: true });
    await tableReady();
    await waitFor(() => expect(calls(noOcr.mock, 'replace_rating_links')).toHaveLength(1));
    expect(calls(noOcr.mock, 'replace_rating_links')[0]).toMatchObject({ sessionId: FX5_ID, version: 2 });
    expect(calls(noOcr.mock, 'needs_ocr_reread')).toEqual([]); // 写しが無いので、読み直しは確かめない
  });

  it('当てはめ直しに失敗しても、画面は前の評価のまま使える（理由は出さない。繰り返さない）', async () => {
    const { mock } = setup({
      session: oldSession(),
      report: 'fx5',
      summary: summaryOf('fx5'),
      relink: true,
      handlers: {
        replace_rating_links: () => {
          throw '保存できませんでした';
        },
      },
    });
    const table = await tableReady();
    await waitFor(() => expect(calls(mock, 'replace_rating_links')).toHaveLength(1));
    await new Promise((resolve) => setTimeout(resolve, 30));
    expect(selfLabels(table)).toEqual(BEFORE);
    expect(calls(mock, 'replace_rating_links')).toHaveLength(1);
  });
});
