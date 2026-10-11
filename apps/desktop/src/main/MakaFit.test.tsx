/**
 * MAKA の当てはめの見込み（ACCEPTANCE の U-31、R11-13。E-13 の値）の、画面の試験。
 * アプリ全体（App）を、半荘の保存先の偽物の上で動かして、使う人と同じ操作で確かめる。
 * 見込みの計算・当てはめ直し・基礎の記録は、packages/engine（maka-fit.test.ts）と makaFit.test.ts（単体）が確かめる。
 * 実ブラウザでの見え方（横スクロール・axe・Tab・幅 390px）は、tests/browser/hanchan.browser.test.ts が確かめる。
 */
import { fitMaka, percentOf, predictGrade, type Grade } from '@jantama/engine';
import { render, screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { FakeSessionStore, REPORT_TEXTS, local, seedSession } from '../../tests/fake-sessions';
import { FX4_TEXT, fx4Ocr, fx4Session } from '../../tests/import-fixtures';
import { installTauriMock } from '../../tests/tauri-mock';
import type { Links, SessionRecord } from '../api/types';
import { App } from './App';
import { summarizeReportText } from './sessionSummaries';

vi.mock('@tauri-apps/api/core', () => ({
  invoke: vi.fn(),
  convertFileSrc: (path: string) => `asset://localhost/${encodeURIComponent(path)}`,
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

const ID = '20261009-190953';
const FX1A_ID = '20261009-171200';
const LOAD = { timeout: 20_000 };
const LINKS: Links = {
  marks: {},
  ratings: { '7': 'k0h0', '8': 'k1h0', '9': 'k1h1', '10': 'k2h0', '11': 'k2h1' },
};

/** 取り込み済みの FX-4 の半荘（5 局。基礎には無い半荘）。 */
function fx4(overrides: Partial<SessionRecord> = {}): SessionRecord {
  return fx4Session(ID, local(2026, 10, 9, 19, 9), {
    report_path: `C:\\data\\games\\${ID}\\report.json`,
    ocr: fx4Ocr(),
    links: LINKS,
    ...overrides,
  });
}

function setup(sessions: Array<{ session: SessionRecord; report: 'fx4' | 'fx1a' }>) {
  const store = new FakeSessionStore(sessions);
  installTauriMock({ handlers: store.handlers });
  const user = userEvent.setup();
  render(<App />);
  return { store, user };
}

const FIT_LINE_START =
  'MAKA の評価 67局ぶんで合わせた見込み: ぴったり 34%・±1段階以内 66%（1半荘ずつ外して確かめた値。MAKA の評価を入れるたびに合わせ直します）';

const fitLine = () => (document.getElementById('fit-line')?.textContent ?? '').replace(/\s+/g, ' ').trim();
const tableOf = () => screen.findByRole('table', { name: '局の評価' });

/** 表の「局」の行の、AI 基準の段階（バッジの文字）。 */
function aiGradeOf(table: HTMLElement, label: string): string | undefined {
  const row = within(table).getByRole('rowheader', { name: label }).closest('tr') as HTMLElement;
  return row.querySelector('td[data-label="AI 基準"] .grade')?.textContent ?? undefined;
}

/** FX-4 の MAKA の入力を、エンジンで当てはめ直した見込みと段階（画面と同じ入力から）。 */
function expectedAfter(label: string, grade: Grade) {
  const state = summarizeReportText(FX4_TEXT);
  if (state.status !== 'ready') throw new Error('読めない');
  const kyokus = state.summary.kyokus.map((k) => ({ label: k.label, score: (k.rating as number) * 100 }));
  const target = kyokus.find((k) => k.label === label);
  if (target === undefined) throw new Error(label);
  const fit = fitMaka([{ sessionId: ID, ...target, grade }], [{ sessionId: ID, kyokus }]);
  return {
    fit,
    gradeOf: (rating: number) => predictGrade(fit.model, rating * 100),
    summary: state.summary,
  };
}

describe('U-31 局の評価の表の下の、MAKA の当てはめの見込み', () => {
  it('MAKA の評価を入れていないと、67局・ぴったり 34%・±1段階以内 66%（E-13）。文は、承認済みの見本のとおり。「合わせ直しました」は出ない', async () => {
    setup([{ session: fx4(), report: 'fx4' }]);
    const table = await tableOf();
    expect(fitLine()).toBe(FIT_LINE_START);
    // 表の下（旗の説明のあと）にあり、説明のアイコン（情報の印）が前に付く
    const line = document.getElementById('fit-line') as HTMLElement;
    expect(table.compareDocumentPosition(line) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy();
    expect(line.querySelector('.fit-ic svg')).not.toBeNull();
    expect(screen.queryByText('合わせ直しました')).toBeNull();
    // 数字（局数・割合）は太字
    expect([...line.querySelectorAll('b')].map((b) => b.textContent)).toEqual(['67', '34%', '66%']);
  });

  it('MAKA の評価を 1 つ入れると、数字が合わせ直した値に替わり、「合わせ直しました」が出る。AI 基準の段階（局ごとも、半荘全体も、一覧も）も、新しい当てはめになる', async () => {
    const { user, store } = setup([{ session: fx4(), report: 'fx4' }]);
    const table = await tableOf();
    const sidebarRow = () => within(screen.getByRole('navigation', { name: '半荘の一覧' })).getByRole('button', { name: /^19:09/ });
    const before = expectedAfter('東2局', 'S').summary;
    expect(aiGradeOf(table, '東2局')).toBe(before.kyokus[1]?.grade);
    expect(before.grade).toBe('S-');
    expect(sidebarRow().querySelector('.grade')?.textContent).toBe('S-');
    expect(document.querySelector('.head-score .grade')?.textContent).toBe('S-');

    // 東2局（Rating 91.6）の MAKA を S+ と入れる（半荘全体の段階が S- から S に替わる入力）
    await user.click(within(table).getByRole('button', { name: '東2局の MAKA を入力' }));
    await user.click(screen.getByRole('menuitemradio', { name: 'S+' }));
    const expected = expectedAfter('東2局', 'S+');
    const exact = percentOf(expected.fit.exact);
    const near = percentOf(expected.fit.withinOne);
    expect([exact, near]).toEqual([34, 65]);
    await waitFor(
      () => expect(fitLine()).toBe(`MAKA の評価 68局ぶんで合わせた見込み: ぴったり ${exact}%・±1段階以内 ${near}%（1半荘ずつ外して確かめた値。MAKA の評価を入れるたびに合わせ直します）`),
      LOAD,
    );
    const done = await screen.findByRole('status');
    expect(done).toHaveTextContent('合わせ直しました');
    expect(store.session(ID).maka.kyokus).toEqual({ k1h0: 'S+' });

    // 段階は、新しい当てはめのもの
    await waitFor(() => expect(document.querySelector('.head-score .grade')?.textContent).toBe(expected.gradeOf(expected.summary.rating as number)));
    expect(document.querySelector('.head-score .grade')?.textContent).toBe('S');
    for (const [i, kyoku] of expected.summary.kyokus.entries()) {
      expect(aiGradeOf(table, kyoku.label), kyoku.label).toBe(expected.gradeOf(kyoku.rating as number));
      expect(aiGradeOf(table, kyoku.label), `${i}`).toBeDefined();
    }
    expect(aiGradeOf(table, '東2局')).toBe('S');
    expect(aiGradeOf(table, '東3局1本場')).toBe('S');
    expect(within(table).getByRole('row', { name: /半荘全体/ }).querySelector('td[data-label="AI 基準"] .grade')?.textContent).toBe('S');
    expect(sidebarRow().querySelector('.grade')?.textContent).toBe('S');
    // Rating は変わらない
    expect(document.querySelector('.head-score .rate-num')?.textContent).toBe('93.0');
  });

  it('評価を替える・取り消す（Ctrl+Z）たびに、数字が合わせ直した値になる。消すと基礎の 67局に戻る（「合わせ直しました」は出たまま）', async () => {
    const { user, store } = setup([{ session: fx4(), report: 'fx4' }]);
    const table = await tableOf();
    await user.click(within(table).getByRole('button', { name: '東2局の MAKA を入力' }));
    await user.click(screen.getByRole('menuitemradio', { name: 'S+' }));
    await waitFor(() => expect(fitLine()).toContain('68局ぶん'), LOAD);
    // 同じ局の評価を E に替える: 局数は同じ 68局で、数字が替わる（ぴったり 37%・±1段階以内 63%）
    await user.click(within(table).getByRole('button', { name: '東2局の MAKA S+' }));
    await user.click(screen.getByRole('menuitemradio', { name: 'E' }));
    const changed = expectedAfter('東2局', 'E');
    expect([percentOf(changed.fit.exact), percentOf(changed.fit.withinOne)]).toEqual([37, 63]);
    await waitFor(() => expect(fitLine()).toContain('ぴったり 37%・±1段階以内 63%'), LOAD);
    expect(fitLine()).toContain('68局ぶん');
    // 消す（「なし」）と、基礎の 67局
    await user.click(within(table).getByRole('button', { name: '東2局の MAKA E' }));
    await user.click(screen.getByRole('menuitemradio', { name: 'なし' }));
    await waitFor(() => expect(fitLine()).toBe(FIT_LINE_START), LOAD);
    expect(store.session(ID).maka.kyokus).toEqual({});
    expect(screen.getByRole('status')).toHaveTextContent('合わせ直しました');
    // 段階も、基礎の当てはめのものに戻る
    expect(document.querySelector('.head-score .grade')?.textContent).toBe('S-');
    // Ctrl+Z で、消す前（E）に戻る
    await user.keyboard('{Control>}z{/Control}');
    await waitFor(() => expect(fitLine()).toContain('ぴったり 37%・±1段階以内 63%'), LOAD);
  });

  it('入れてある評価は、開き直したときの数に入る（67局 + 入れた局数）。「合わせ直しました」は、自分で入れたときだけ出る', async () => {
    const session = fx4({ maka: { kyokus: { k0h0: 'S', k1h0: 'A' } } });
    setup([{ session, report: 'fx4' }]);
    await tableOf();
    await waitFor(() => expect(fitLine()).toContain('MAKA の評価 69局ぶんで合わせた見込み'), LOAD);
    expect(screen.queryByText('合わせ直しました')).toBeNull();
  });

  it('基礎と同じ半荘（f9da…）の局に入れた評価は、基礎の記録を置き換える: 局数は 67局のまま、数字だけが替わる', async () => {
    const own = seedSession(local(2026, 10, 9, 17, 12), { id: FX1A_ID, report: 'fx1a' }).session;
    const { user } = setup([{ session: own, report: 'fx1a' }]);
    const table = await tableOf();
    expect(fitLine()).toBe(FIT_LINE_START);
    // 東2局の MAKA は、基礎では S。D と入れ直す
    await user.click(within(table).getByRole('button', { name: '東2局の MAKA を入力' }));
    await user.click(screen.getByRole('menuitemradio', { name: 'D' }));
    await waitFor(() => expect(screen.getByRole('status')).toHaveTextContent('合わせ直しました'), LOAD);
    const state = summarizeReportText(REPORT_TEXTS.fx1a);
    if (state.status !== 'ready') throw new Error('読めない');
    const kyokus = state.summary.kyokus.map((k) => ({ label: k.label, score: (k.rating as number) * 100 }));
    const expected = fitMaka([{ sessionId: FX1A_ID, ...(kyokus[1] as { label: string; score: number }), grade: 'D' }], [{ sessionId: FX1A_ID, kyokus }]);
    expect(expected.recordCount).toBe(67);
    expect(expected.replacedCount).toBe(1);
    expect(fitLine()).toBe(
      `MAKA の評価 67局ぶんで合わせた見込み: ぴったり ${percentOf(expected.exact)}%・±1段階以内 ${percentOf(expected.withinOne)}%（1半荘ずつ外して確かめた値。MAKA の評価を入れるたびに合わせ直します）`,
    );
  });

  it('消した半荘（ごみ箱の中）の評価は、数に入らない', async () => {
    const withGrade = fx4({ maka: { kyokus: { k0h0: 'S' } } });
    const other = seedSession(local(2026, 10, 8, 21, 40), { id: '20261008-214000', report: 'fx1b' }).session;
    const store = new FakeSessionStore([
      { session: withGrade, report: 'fx4' },
      { session: other, report: 'fx1b' },
    ]);
    installTauriMock({ handlers: store.handlers });
    const user = userEvent.setup();
    render(<App />);
    await tableOf();
    await waitFor(() => expect(fitLine()).toContain('68局ぶん'), LOAD);
    // 評価を入れた半荘を消す（確認で「削除」）
    const list = screen.getByRole('navigation', { name: '半荘の一覧' });
    await user.click(within(list).getByRole('button', { name: /19:09 の半荘のメニュー/ }));
    await user.click(screen.getByRole('menuitem', { name: '削除' }));
    await user.click(await screen.findByRole('button', { name: '削除' }));
    await waitFor(() => expect(screen.queryByRole('heading', { level: 1, name: /19:09/ })).toBeNull(), LOAD);
    // 開いた別の半荘（評価なし）の見込みは、基礎の 67局
    await screen.findByRole('table', { name: '局の評価' });
    await waitFor(() => expect(fitLine()).toBe(FIT_LINE_START), LOAD);
  });
});
