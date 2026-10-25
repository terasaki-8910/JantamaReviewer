/**
 * 半荘のページの「NAGA の結果」の欄（F22 段 2。ACCEPTANCE の U-52 の段 2 の部分）の、画面の試験。
 * 半荘の保存先の偽物（FakeSessionStore）の上で、使う人と同じ操作で確かめる: 欄が出る半荘・出ない半荘、URL を貼って保存、
 * NAGA のサイトでない URL を断る、消す、Ctrl+Z / Ctrl+Y、見出しの「NAGA の結果を開く」、リンクの開き方。
 * 通して見る画面の操作の段のリンクは、replay/ReplayNaga.test.tsx。実ブラウザでの見え方は tests/browser が確かめる。
 */
import { cleanup, render, screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { useCallback, useState } from 'react';
import { describe, expect, it, vi } from 'vitest';

import { FakeSessionStore, REPORT_TEXTS, local } from '../../tests/fake-sessions';
import { fx4Ocr, fx4Session } from '../../tests/import-fixtures';
import { installTauriMock } from '../../tests/tauri-mock';
import type { Links, SessionRecord } from '../api/types';
import { NAGA_URL_INVALID } from './naga';
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
const REPORT_URL = 'https://naga.dmv.nico/htmls/report_viewer.html?report_id=abc';
const SAVED_AT = 1_760_000_000_123;

const LINKS: Links = {
  marks: {},
  ratings: { '7': 'k0h0', '8': 'k1h0', '9': 'k1h1', '10': 'k2h0', '11': 'k2h1' },
};

/** 取り込んだ半荘: FX-4。 */
function imported(overrides: Partial<SessionRecord> = {}): SessionRecord {
  return fx4Session(ID, STARTED, {
    report_path: `C:\\data\\games\\${ID}\\report.json`,
    ocr: fx4Ocr(),
    links: LINKS,
    ...overrides,
  });
}

/** 取り込む前の半荘。 */
const recorded = (): SessionRecord => fx4Session('20261009-161200', local(2026, 10, 9, 16, 12));

const readySummary = (): SummaryState => summarizeReportText(REPORT_TEXTS.fx4);

interface SetupOptions {
  session?: SessionRecord;
  summary?: SummaryState | undefined;
  handlers?: Record<string, (args: unknown) => unknown>;
  doubtOnly?: boolean;
}

function setup(options: SetupOptions = {}) {
  const session = options.session ?? imported();
  const store = new FakeSessionStore([{ session, ...(session.report_path === null ? {} : { report: 'fx4' as const }) }]);
  const mock = installTauriMock({ handlers: { ...store.handlers, ...options.handlers } });
  const user = userEvent.setup();
  const summary = 'summary' in options ? options.summary : session.report_path === null ? undefined : readySummary();
  const doubtOnly = options.doubtOnly === true;

  function Harness() {
    const [current, setCurrent] = useState(() => store.session(session.id));
    const reload = useCallback(async () => setCurrent(store.session(session.id)), []);
    return (
      <UndoProvider>
        <SessionPage session={current} summary={summary} onChanged={reload} doubtOnly={doubtOnly} />
      </UndoProvider>
    );
  }
  render(<Harness />);
  return { store, mock, user };
}

const section = () => screen.getByRole('region', { name: 'NAGA の結果' });
const urlInput = () => screen.getByRole('textbox', { name: 'NAGA の結果の URL' });
const saveButton = () => screen.getByRole('button', { name: '保存' });
const headerLink = () => screen.queryByRole('link', { name: 'NAGA の結果を開く' });
const calls = (mock: ReturnType<typeof setup>['mock']) =>
  mock
    .calls()
    .filter((c) => c.cmd === 'set_naga_url')
    .map((c) => c.args);
const undoKey = (user: ReturnType<typeof userEvent.setup>) => user.keyboard('{Control>}z{/Control}');
const redoKey = (user: ReturnType<typeof userEvent.setup>) => user.keyboard('{Control>}y{/Control}');

/** 結果を読み終えて、局の評価の表が出るまで待つ。 */
const tableReady = () => screen.findByRole('table', { name: '局の評価' });

describe('U-52 「NAGA の結果」の欄が出る半荘', () => {
  it('取り込む前の半荘・結果を読み込んでいる間・結果を読めなかった半荘には、欄も見出しの操作も出ない', () => {
    setup({ session: recorded() });
    expect(screen.queryByRole('heading', { name: 'NAGA の結果' })).toBeNull();
    cleanup();
    render(
      <UndoProvider>
        <SessionPage session={imported({ naga: { url: REPORT_URL, saved_ms: SAVED_AT } })} summary={{ status: 'loading' }} />
      </UndoProvider>,
    );
    expect(screen.queryByRole('heading', { name: 'NAGA の結果' })).toBeNull();
    expect(headerLink()).toBeNull();
    cleanup();
    render(
      <UndoProvider>
        <SessionPage
          session={imported({ naga: { url: REPORT_URL, saved_ms: SAVED_AT } })}
          summary={{ status: 'unavailable', reason: '形が合いません' }}
        />
      </UndoProvider>,
    );
    expect(screen.queryByRole('heading', { name: 'NAGA の結果' })).toBeNull();
    expect(headerLink()).toBeNull();
  });

  it('結果を取り込んだ半荘には、局の評価の表のあとに「NAGA の結果」（h2）。説明のアイコンがあり、URL を貼る欄と「保存」だけ（リンクも「開く」「消す」も無い）', async () => {
    setup();
    await tableReady();
    const heading = screen.getByRole('heading', { level: 2, name: 'NAGA の結果' });
    const table = screen.getByRole('table', { name: '局の評価' });
    // 局の評価の表のあと、ページの終わり
    expect(table.compareDocumentPosition(heading) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy();
    const sections = [...document.querySelectorAll('.detail > section')];
    expect(sections.at(-1)).toBe(section());
    expect(sections.at(-1)?.querySelector('.sec-head h2.sec-title')).toBe(heading);
    // 欄の中身: 入力欄は URL の入力（見本つき）、ボタンは「保存」
    expect(urlInput()).toHaveAttribute('type', 'url');
    expect(urlInput()).toHaveAttribute('placeholder', 'https://naga.dmv.nico/…');
    expect(urlInput()).toHaveValue('');
    expect(saveButton()).toBeEnabled();
    expect(within(section()).queryByRole('link')).toBeNull();
    expect(within(section()).queryByRole('button', { name: '消す' })).toBeNull();
    expect(headerLink()).toBeNull();
    expect(screen.queryByRole('alert')).toBeNull();
  });

  it('説明のアイコン「NAGA の結果の説明」に、貼る URL の説明と、申し込みと支払いは NAGA のページで行うこと', async () => {
    setup();
    await tableReady();
    const tip = within(section()).getByRole('button', { name: 'NAGA の結果の説明' });
    const text = document.getElementById(tip.getAttribute('aria-describedby') ?? '')?.textContent;
    expect(text).toBe(
      'NAGA でこの半荘の牌譜を解析した結果のページの URL を貼っておくと、ここと半荘を通して見る画面から開けます。申し込みと支払いは、NAGA のページで行います。',
    );
  });

  it('迷いだけを記録する設定（F0）でも、欄は出る（〇△✕ やメモとは別のもの）', async () => {
    setup({ doubtOnly: true });
    await tableReady();
    expect(section()).toBeInTheDocument();
  });
});

describe('U-52 NAGA の結果の URL を貼って保存する', () => {
  it('貼って「保存」: 保存の命令が呼ばれ、欄はリンクに替わる（URL のリンク・「開く」・「消す」）。リンクはいつものブラウザで開く形（target=_blank、同じ URL）', async () => {
    const { user, mock, store } = setup();
    await tableReady();
    await user.click(urlInput());
    await user.paste(REPORT_URL);
    await user.click(saveButton());
    await waitFor(() => expect(within(section()).queryByRole('textbox')).toBeNull());
    expect(calls(mock)).toEqual([{ sessionId: ID, url: REPORT_URL }]);
    expect(store.session(ID).naga?.url).toBe(REPORT_URL);
    expect(store.nagaCalls).toEqual([`set:${ID}:${REPORT_URL}`]);
    // 欄の中のリンク（URL そのもの）と、「開く」
    const urlLink = within(section()).getByRole('link', { name: REPORT_URL });
    const openLink = within(section()).getByRole('link', { name: '開く' });
    for (const link of [urlLink, openLink]) {
      expect(link).toHaveAttribute('href', REPORT_URL);
      expect(link).toHaveAttribute('target', '_blank');
      expect(link.getAttribute('rel')).toMatch(/noopener/);
      expect(link.getAttribute('rel')).toMatch(/noreferrer/);
    }
    expect(within(section()).getByRole('button', { name: '消す' })).toBeEnabled();
    expect(within(section()).queryByRole('button', { name: '保存' })).toBeNull();
    // 見出しの操作にも、「NAGA の結果を開く」が出る
    const head = headerLink();
    expect(head).not.toBeNull();
    expect(head).toHaveAttribute('href', REPORT_URL);
    expect(head).toHaveAttribute('target', '_blank');
    expect(head?.closest('.head-actions')).not.toBeNull();
    expect(screen.queryByRole('alert')).toBeNull();
  });

  it('前後の空白は除いて保存する。Enter でも保存できる。保存したあと、キーボードの位置はリンクへ移る', async () => {
    const { user, mock } = setup();
    await tableReady();
    await user.click(urlInput());
    await user.paste(`  ${REPORT_URL}  `);
    await user.keyboard('{Enter}');
    const urlLink = await within(section()).findByRole('link', { name: REPORT_URL });
    expect(calls(mock)).toEqual([{ sessionId: ID, url: REPORT_URL }]);
    expect(urlLink).toHaveFocus();
  });

  it('保存してある半荘は、開いたときから、リンクと見出しの操作が出ている（入力欄は無い）', async () => {
    setup({ session: imported({ naga: { url: REPORT_URL, saved_ms: SAVED_AT } }) });
    await tableReady();
    expect(within(section()).getByRole('link', { name: REPORT_URL })).toHaveAttribute('href', REPORT_URL);
    expect(within(section()).queryByRole('textbox')).toBeNull();
    expect(headerLink()).toHaveAttribute('href', REPORT_URL);
  });
});

describe('U-52 NAGA のサイトでない URL は理由を出して受け付けない', () => {
  it('http・別のサイト・URL でない文字: 「NAGA の結果のページの URL（https://naga.dmv.nico/ で始まるもの）を貼ってください」を出し、何も保存しない。打ち直すと消える', async () => {
    const { user, mock, store } = setup();
    await tableReady();
    for (const bad of [
      'http://naga.dmv.nico/htmls/report_viewer.html?report_id=abc',
      'https://evil.example/htmls/report_viewer.html?report_id=abc',
      'https://naga.dmv.nico.evil.example/htmls/report_viewer.html?report_id=abc',
      'naga だよ',
    ]) {
      await user.clear(urlInput());
      await user.click(urlInput());
      await user.paste(bad);
      await user.click(saveButton());
      expect(screen.getByRole('alert')).toHaveTextContent(
        'NAGA の結果のページの URL（https://naga.dmv.nico/ で始まるもの）を貼ってください',
      );
      expect(screen.getByRole('alert')).toHaveTextContent(NAGA_URL_INVALID);
      expect(urlInput()).toHaveAttribute('aria-invalid', 'true');
      expect(urlInput().getAttribute('aria-describedby')).toBe(screen.getByRole('alert').id);
      expect(urlInput()).toHaveValue(bad);
    }
    expect(calls(mock)).toEqual([]);
    expect(store.session(ID).naga).toBeNull();
    expect(headerLink()).toBeNull();
    expect(within(section()).queryByRole('link')).toBeNull();
    // 打ち直し始めると、理由は消える
    await user.type(urlInput(), 'x');
    expect(screen.queryByRole('alert')).toBeNull();
    expect(urlInput()).not.toHaveAttribute('aria-invalid');
  });

  it('何も貼らずに「保存」を押しても、貼るよう促す（保存の命令は呼ばない）', async () => {
    const { user, mock } = setup();
    await tableReady();
    await user.click(saveButton());
    expect(screen.getByRole('alert')).toHaveTextContent(NAGA_URL_INVALID);
    expect(calls(mock)).toEqual([]);
  });

  it('画面が通した URL を Rust 側が断ったときも、その理由を欄に出す。保存はされず、入力はそのまま残る', async () => {
    const { user, store } = setup({
      handlers: {
        set_naga_url: () => {
          throw 'この URL は受け付けられません（保存先の判断）';
        },
      },
    });
    await tableReady();
    await user.click(urlInput());
    await user.paste(REPORT_URL);
    await user.click(saveButton());
    expect(await screen.findByRole('alert')).toHaveTextContent('この URL は受け付けられません（保存先の判断）');
    expect(store.session(ID).naga).toBeNull();
    expect(urlInput()).toHaveValue(REPORT_URL);
    expect(saveButton()).toBeEnabled();
  });
});

describe('U-52・U-11 消す・取り消す・やり直す', () => {
  it('「消す」: 保存した URL が消え、入力欄に戻る（空）。見出しの操作も消える。キーボードの位置は「NAGA の結果」の見出しへ', async () => {
    const { user, store, mock } = setup({ session: imported({ naga: { url: REPORT_URL, saved_ms: SAVED_AT } }) });
    await tableReady();
    await user.click(within(section()).getByRole('button', { name: '消す' }));
    await waitFor(() => expect(within(section()).queryByRole('link')).toBeNull());
    expect(calls(mock)).toEqual([{ sessionId: ID, url: null }]);
    expect(store.session(ID).naga).toBeNull();
    expect(store.nagaCalls).toEqual([`clear:${ID}`]);
    expect(urlInput()).toHaveValue('');
    expect(headerLink()).toBeNull();
    // 入力欄に位置を置かない（欄の中では、アプリの Ctrl+Z が働かないため）。見出しに置く
    expect(screen.getByRole('heading', { level: 2, name: 'NAGA の結果' })).toHaveFocus();
  });

  it('保存してから Ctrl+Z で保存前（入力欄）に戻り、Ctrl+Y で保存し直す。保存先の命令は、そのたびに呼ばれる', async () => {
    const { user, store, mock } = setup();
    await tableReady();
    await user.click(urlInput());
    await user.paste(REPORT_URL);
    await user.click(saveButton());
    await within(section()).findByRole('link', { name: REPORT_URL });
    await undoKey(user);
    await waitFor(() => expect(within(section()).queryByRole('link')).toBeNull());
    expect(store.session(ID).naga).toBeNull();
    expect(urlInput()).toHaveValue('');
    expect(headerLink()).toBeNull();
    await redoKey(user);
    await within(section()).findByRole('link', { name: REPORT_URL });
    expect(store.session(ID).naga?.url).toBe(REPORT_URL);
    expect(headerLink()).toHaveAttribute('href', REPORT_URL);
    expect(calls(mock)).toEqual([
      { sessionId: ID, url: REPORT_URL },
      { sessionId: ID, url: null },
      { sessionId: ID, url: REPORT_URL },
    ]);
  });

  it('消してから Ctrl+Z で、消す前の URL に戻り、Ctrl+Y でもう一度消える', async () => {
    const { user, store } = setup({ session: imported({ naga: { url: REPORT_URL, saved_ms: SAVED_AT } }) });
    await tableReady();
    await user.click(within(section()).getByRole('button', { name: '消す' }));
    await waitFor(() => expect(within(section()).queryByRole('link')).toBeNull());
    await undoKey(user);
    await within(section()).findByRole('link', { name: REPORT_URL });
    expect(store.session(ID).naga?.url).toBe(REPORT_URL);
    expect(headerLink()).toHaveAttribute('href', REPORT_URL);
    await redoKey(user);
    await waitFor(() => expect(within(section()).queryByRole('link')).toBeNull());
    expect(store.session(ID).naga).toBeNull();
    expect(headerLink()).toBeNull();
  });

  it('消したあと、新しい URL を貼り直して保存でき、Ctrl+Z を 2 回で、消す前の URL まで順に戻る', async () => {
    const other = 'https://naga.dmv.nico/htmls/report_viewer.html?report_id=def';
    const { user, store } = setup({ session: imported({ naga: { url: REPORT_URL, saved_ms: SAVED_AT } }) });
    await tableReady();
    await user.click(within(section()).getByRole('button', { name: '消す' }));
    await user.click(await screen.findByRole('textbox', { name: 'NAGA の結果の URL' }));
    await user.paste(other);
    await user.click(saveButton());
    await within(section()).findByRole('link', { name: other });
    expect(store.session(ID).naga?.url).toBe(other);
    await undoKey(user);
    await waitFor(() => expect(store.session(ID).naga).toBeNull());
    await undoKey(user);
    await within(section()).findByRole('link', { name: REPORT_URL });
    expect(store.session(ID).naga?.url).toBe(REPORT_URL);
  });

  it('保存の命令が失敗したら、積まない: 理由を欄に出し、Ctrl+Z で取り消すものは無い', async () => {
    const { user, mock } = setup({
      session: imported({ naga: { url: REPORT_URL, saved_ms: SAVED_AT } }),
      handlers: {
        set_naga_url: () => {
          throw 'ファイルを書けませんでした: アクセスが拒否されました';
        },
      },
    });
    await tableReady();
    await user.click(within(section()).getByRole('button', { name: '消す' }));
    expect(await screen.findByRole('alert')).toHaveTextContent('ファイルを書けませんでした: アクセスが拒否されました');
    // 消せていないので、リンクはそのまま
    expect(within(section()).getByRole('link', { name: REPORT_URL })).toBeInTheDocument();
    const before = calls(mock).length;
    await undoKey(user);
    expect(calls(mock)).toHaveLength(before);
  });
});
