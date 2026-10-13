/**
 * 局の評価の表の行を開いたときの、自分の向聴数の推移（U-36、F14。計算は E-41＝エンジンの my-track.test.ts）の、画面の試験。
 * 半荘の保存先の偽物（FakeSessionStore）の上に、取り込んだ半荘（FX-4。迷い 1〜5 は推定で結びつき、迷い 6 は局だけ分かった）を出して、使う人と同じ操作で確かめる。
 * 実ブラウザでの見え方（横スクロール・axe・Tab の順・390px で行が伸びない）は、tests/browser/hanchan.browser.test.ts。
 */
import { cleanup, render, screen, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { useCallback, useMemo, useState } from 'react';
import { afterEach, describe, expect, it, vi } from 'vitest';

import { FakeSessionStore, REPORT_TEXTS, local } from '../../tests/fake-sessions';
import { fx4Ocr, fx4Session } from '../../tests/import-fixtures';
import { installTauriMock } from '../../tests/tauri-mock';
import type { Links, Rating, SessionRecord } from '../api/types';
import { SessionPage } from './SessionPage';
import { summarizeReportText } from './sessionSummaries';
import { UndoProvider } from './undo/UndoProvider';

vi.mock('@tauri-apps/api/core', () => ({
  invoke: vi.fn(),
  convertFileSrc: (path: string) => `asset://localhost/${encodeURIComponent(path)}`,
}));
vi.mock('@tauri-apps/api/event', () => ({ listen: vi.fn() }));

const ID = '20261009-190953';
const LINKS: Links = { marks: {}, ratings: { '7': 'k0h0', '8': 'k1h0', '9': 'k1h1', '10': 'k2h0', '11': 'k2h1' } };

/** 取り込んだ半荘: FX-4（SessionPage.test.tsx の `imported` と同じ）。 */
function imported(): SessionRecord {
  const base = fx4Session(ID, local(2026, 10, 9, 19, 9), {
    report_path: `C:\\data\\games\\${ID}\\report.json`,
    ocr: fx4Ocr(),
    links: LINKS,
  });
  const ratings: Rating[] = ['fair', 'bad', 'fair', 'bad', 'bad'];
  return { ...base, ratings: base.ratings.map((r, i) => ({ ...r, rating: ratings[i] ?? r.rating })) };
}

interface SetupOptions {
  /** 取り込んだ結果。既定は FX-4。 */
  report?: keyof typeof REPORT_TEXTS;
  /** 大きな不一致の基準（確率）。渡さなければ既定の 5%。 */
  threshold?: number;
}

function setup(options: SetupOptions = {}) {
  const session = imported();
  const report = options.report ?? 'fx4';
  const store = new FakeSessionStore([{ session, report }]);
  installTauriMock({ handlers: store.handlers });
  const user = userEvent.setup();
  function Harness() {
    const [current, setCurrent] = useState(() => store.session(session.id));
    const reload = useCallback(async () => setCurrent(store.session(session.id)), []);
    const summary = useMemo(() => summarizeReportText(REPORT_TEXTS[report]), []);
    return (
      <UndoProvider>
        <SessionPage
          session={current}
          summary={summary}
          onChanged={reload}
          {...(options.threshold === undefined ? {} : { threshold: options.threshold })}
        />
      </UndoProvider>
    );
  }
  render(<Harness />);
  return { user };
}

afterEach(() => {
  cleanup();
  document.body.className = '';
});

const tableReady = () => screen.findByRole('table', { name: '局の評価' });
const rowOf = (table: HTMLElement, label: string) => within(table).getByRole('rowheader', { name: label }).closest('tr') as HTMLElement;
const opener = (table: HTMLElement, label: string) => within(rowOf(table, label)).getByRole('button', { name: label });
const detailOf = (table: HTMLElement, label: string) => rowOf(table, label).nextElementSibling as HTMLElement;
const trackIn = (detail: HTMLElement) => detail.querySelector<HTMLElement>('.hx-trk') as HTMLElement;
const chartOf = (block: HTMLElement) => within(block).getByRole('group', { name: /の向聴数の推移（矢印キーで点を選ぶ）$/ });
const visibleTip = () => [...document.querySelectorAll<HTMLElement>('.wk-tip')].find((tip) => !tip.hidden);
const tipText = () => [visibleTip()?.querySelector('.wk-tip-v')?.textContent, visibleTip()?.querySelector('.wk-tip-l')?.textContent];
const legendOf = (block: HTMLElement) => [...within(block).getByRole('list', { name: '図の印' }).querySelectorAll('li')].map((li) => li.textContent);
const rowsOfTable = (block: HTMLElement) =>
  within(within(block).getByRole('table')).getAllByRole('row').map((row) => [...row.children].map((cell) => cell.textContent));
const KYOKUS = ['東1局', '東2局', '東2局1本場', '東3局', '東3局1本場'];

describe('U-36 局の評価の表の行を開く: 向聴数の推移（F14、E-41、R15-6 の A・提案 7）', () => {
  it('開くまでは何も増えない。開くと、局の結果の手の下に、見出し「向聴数の推移」・折れ線・凡例・「表で見る」が出る。閉じると、また消える', async () => {
    const { user } = setup();
    const table = await tableReady();
    expect(document.querySelector('.hx-trk, .shchart')).toBeNull();
    await user.click(opener(table, '東2局'));
    const detail = detailOf(table, '東2局');
    const block = trackIn(detail);
    expect(block).not.toBeNull();
    // 局の結果の手の、すぐ下
    expect(block.previousElementSibling).toBe(detail.querySelector('[data-kyoku-result]'));
    expect(within(block).getByRole('heading', { level: 4, name: '向聴数の推移' })).toBeInTheDocument();
    expect(within(block).getByRole('button', { name: '向聴数の推移の説明' })).toBeInTheDocument();
    expect(chartOf(block)).toHaveAttribute('aria-label', '東2局の向聴数の推移（矢印キーで点を選ぶ）');
    expect(within(block).getByRole('button', { name: '表で見る' })).toHaveAttribute('aria-expanded', 'false');
    // 閉じている間は、表も無い
    expect(within(block).queryByRole('table')).toBeNull();
    await user.click(opener(table, '東2局'));
    expect(document.querySelector('.hx-trk, .shchart')).toBeNull();
  });

  it('点は、配牌と自分の打牌ごとに 1 つ。迷いは輪、大きな不一致は菱形、聴牌になった打牌は三角で、印のある点にだけ付く', async () => {
    const { user } = setup();
    const table = await tableReady();
    const counts = async (label: string) => {
      await user.click(opener(table, label));
      const block = trackIn(detailOf(table, label));
      return {
        dots: block.querySelectorAll('.shchart-svg .nd, .shchart-svg .tpm').length,
        doubt: block.querySelectorAll('.shchart-svg .dbt').length,
        big: block.querySelectorAll('.shchart-svg .bgm').length,
        tenpai: block.querySelectorAll('.shchart-svg .tpm').length,
      };
    };
    // 迷い（推定）は 1〜5。迷い 6 は、局だけ分かった（巡目が決まらない）ので、折れ線には置かない
    expect(await counts('東1局')).toEqual({ dots: 17, doubt: 1, big: 0, tenpai: 1 });
    expect(await counts('東2局')).toEqual({ dots: 14, doubt: 1, big: 1, tenpai: 0 });
    expect(await counts('東2局1本場')).toEqual({ dots: 10, doubt: 2, big: 2, tenpai: 1 });
    expect(await counts('東3局')).toEqual({ dots: 6, doubt: 0, big: 0, tenpai: 0 });
    expect(await counts('東3局1本場')).toEqual({ dots: 13, doubt: 1, big: 2, tenpai: 0 });
  });

  it('凡例は 3 つ。この局に無い印には「この局は無し」を添える（形だけに頼らない）', async () => {
    const { user } = setup();
    const table = await tableReady();
    await user.click(opener(table, '東3局'));
    expect(legendOf(trackIn(detailOf(table, '東3局')))).toEqual(['迷い（この局は無し）', '大きな不一致（この局は無し）', '聴牌になった打牌（この局は無し）']);
    await user.click(opener(table, '東2局1本場'));
    expect(legendOf(trackIn(detailOf(table, '東2局1本場')))).toEqual(['迷い', '大きな不一致', '聴牌になった打牌']);
    await user.click(opener(table, '東2局'));
    expect(legendOf(trackIn(detailOf(table, '東2局')))).toEqual(['迷い', '大きな不一致', '聴牌になった打牌（この局は無し）']);
  });

  it('折れ線は 1 つの止まり場所（Tab）。矢印キーで点（印のある点を含む）を選ぶと、吹き出し（値が先、名前があと）が出る。Esc で消える', async () => {
    const { user } = setup();
    const table = await tableReady();
    await user.click(opener(table, '東2局'));
    const chart = chartOf(trackIn(detailOf(table, '東2局')));
    expect(chart).toHaveAttribute('tabindex', '0');
    chart.focus();
    expect(visibleTip()).toBeDefined();
    await user.keyboard('{Home}');
    expect(tipText()).toEqual(['2向聴', '配牌']);
    // 11巡目: 迷い 2 と大きな不一致が、同じ点に重なる
    await user.keyboard('{ArrowRight}'.repeat(11));
    expect(tipText()).toEqual(['1向聴・迷い2・大きな不一致', '11巡目 打8p']);
    // 読み上げの欄にも、同じ文
    expect(document.querySelector('.hx-trk [aria-live="polite"]')?.textContent).toBe('1向聴・迷い2・大きな不一致。11巡目 打8p');
    await user.keyboard('{ArrowLeft}');
    expect(tipText()).toEqual(['1向聴', '10巡目 打9s']);
    await user.keyboard('{End}');
    expect(tipText()).toEqual(['1向聴', '13巡目 打8s']);
    await user.keyboard('{Escape}');
    expect(visibleTip()).toBeUndefined();
  });

  it('吹き出しの文: 大きな不一致だけの点・迷いの点・聴牌になった打牌と鳴きの迷い（行動を添える）。名前は「N巡目 打牌」、値は向聴数と印', async () => {
    const { user } = setup();
    const table = await tableReady();
    await user.click(opener(table, '東2局1本場'));
    const chart = chartOf(trackIn(detailOf(table, '東2局1本場')));
    chart.focus();
    await user.keyboard('{Home}');
    expect(tipText()).toEqual(['3向聴', '配牌']);
    await user.keyboard('{ArrowRight}'.repeat(5));
    expect(tipText()).toEqual(['2向聴・大きな不一致', '5巡目 打9s']);
    await user.keyboard('{ArrowRight}');
    expect(tipText()).toEqual(['2向聴・迷い3', '6巡目 打南']);
    await user.keyboard('{ArrowRight}{ArrowRight}');
    expect(tipText()).toEqual(['1向聴・大きな不一致', '8巡目 打4p']);
    await user.keyboard('{End}');
    expect(tipText()).toEqual(['聴牌になった・迷い4（東をポン）', '9巡目 打7p']);
    // 読み上げ用の説明に、全部の点が、名前: 値 の形で書いてある
    const described = document.getElementById(chart.getAttribute('aria-describedby') ?? '') as HTMLElement;
    expect(described.textContent).toContain('配牌: 3向聴');
    expect(described.textContent).toContain('8巡目 打4p: 1向聴・大きな不一致');
    expect(described.textContent).toContain('9巡目 打7p: 聴牌になった・迷い4（東をポン）');
  });

  it('「表で見る」: 押す（Enter・Space）と、図と同じ点の表（巡目・打牌・向聴数・印）が出る。もう一度で閉じる。キーボードの位置はボタンに残る', async () => {
    const { user } = setup();
    const table = await tableReady();
    await user.click(opener(table, '東2局1本場'));
    const block = trackIn(detailOf(table, '東2局1本場'));
    const toggle = within(block).getByRole('button', { name: '表で見る' });
    toggle.focus();
    await user.keyboard('{Enter}');
    expect(toggle).toHaveAttribute('aria-expanded', 'true');
    expect(toggle).toHaveFocus();
    const grid = within(block).getByRole('table', { name: '東2局1本場の向聴数の推移（表）' });
    expect(toggle).toHaveAttribute('aria-controls', grid.id);
    const rows = rowsOfTable(block);
    expect(rows[0]).toEqual(['巡目', '打牌', '向聴数', '印']);
    expect(rows).toHaveLength(11);
    expect(rows[1]).toEqual(['配牌', '—', '3向聴', '—']);
    expect(rows[5]).toEqual(['4巡目', '4s', '2向聴', '—']);
    expect(rows[6]).toEqual(['5巡目', '9s', '2向聴', '大きな不一致']);
    expect(rows[7]).toEqual(['6巡目', '南', '2向聴', '迷い3']);
    expect(rows[9]).toEqual(['8巡目', '4p', '1向聴', '大きな不一致']);
    expect(rows[10]).toEqual(['9巡目', '7p', '聴牌', '聴牌になった・迷い4（東をポン）']);
    // 列の見出しと行の見出し（表として読める）
    expect(within(grid).getAllByRole('columnheader').map((cell) => cell.textContent)).toEqual(['巡目', '打牌', '向聴数', '印']);
    expect(within(grid).getAllByRole('rowheader')).toHaveLength(10);
    await user.keyboard(' ');
    expect(toggle).toHaveAttribute('aria-expanded', 'false');
    expect(toggle).not.toHaveAttribute('aria-controls');
    expect(toggle).toHaveFocus();
    expect(within(block).queryByRole('table')).toBeNull();
  });

  it('表の行と、図の読み上げ用の説明（点ごとの 名前: 値）は、同じ点から作る。表の印は、凡例の 3 つ（迷い・大きな不一致・聴牌になった）のどれかの文字を含む', async () => {
    const { user } = setup();
    const table = await tableReady();
    for (const label of KYOKUS) {
      await user.click(opener(table, label));
      const block = trackIn(detailOf(table, label));
      await user.click(within(block).getByRole('button', { name: '表で見る' }));
      const rows = rowsOfTable(block).slice(1);
      const described = document.getElementById(chartOf(block).getAttribute('aria-describedby') ?? '') as HTMLElement;
      const spoken = (described.textContent ?? '').split('、');
      expect(spoken, label).toHaveLength(rows.length);
      rows.forEach((row, index) => {
        const [turn, discard, shanten, marks] = row as [string, string, string, string];
        const name = discard === '—' ? turn : `${turn} 打${discard}`;
        const value = [marks.includes('聴牌になった') ? '' : shanten, ...(marks === '—' ? [] : [marks])].filter((part) => part !== '').join('・');
        expect(spoken[index], `${label} ${turn}`).toBe(`${name}: ${value}`);
        if (marks !== '—') expect(marks, `${label} ${turn}`).toMatch(/迷い|大きな不一致|聴牌になった/);
      });
    }
  });

  it('迷いの印は、迷いのカードと同じ結びつけの迷い（迷い 1〜5）。巡目が決まっていない迷い 6 は、どの折れ線にも置かない', async () => {
    const { user } = setup();
    const table = await tableReady();
    for (const label of KYOKUS) await user.click(opener(table, label));
    const marks = [...document.querySelectorAll<HTMLElement>('.hx-trk')].flatMap((block) => {
      const described = document.getElementById(chartOf(block).getAttribute('aria-describedby') ?? '') as HTMLElement;
      return [...(described.textContent ?? '').matchAll(/迷い(\d+)/g)].map((m) => Number(m[1]));
    });
    expect(marks.sort()).toEqual([1, 2, 3, 4, 5]);
  });

  it('大きな不一致の基準（設定）を渡すと、菱形の数が変わる。0 なら 1 つも無い。迷いの輪は変わらない', async () => {
    const { user } = setup({ threshold: 0 });
    const table = await tableReady();
    for (const label of KYOKUS) await user.click(opener(table, label));
    expect(document.querySelectorAll('.hx-trk .shchart-svg .bgm')).toHaveLength(0);
    expect(document.querySelectorAll('.hx-trk .shchart-svg .dbt')).toHaveLength(5);
    expect([...document.querySelectorAll('.hx-leg li[data-kind="big"]')].map((li) => li.textContent)).toEqual(Array(5).fill('大きな不一致（この局は無し）'));
  });

  it('AI の候補・確率・順位は出さない（図・凡例・表・説明の文のどこにも。SPEC F3）', async () => {
    const { user } = setup();
    const table = await tableReady();
    await user.click(opener(table, '東2局1本場'));
    const block = trackIn(detailOf(table, '東2局1本場'));
    await user.click(within(block).getByRole('button', { name: '表で見る' }));
    expect(block.textContent).not.toMatch(/確率|順位|%|prob/);
    expect(block.querySelector('[data-ai]')).toBeNull();
  });

  it('別の半荘（流局を含む）でも、打牌のある局は折れ線が出る。配牌が最初の点で、巡目は昇順', async () => {
    const { user } = setup({ report: 'fx1a' });
    const table = await tableReady();
    const labels = (await within(table).findAllByRole('rowheader')).map((h) => h.textContent as string).filter((t) => t !== '半荘全体');
    expect(labels.length).toBeGreaterThanOrEqual(8);
    for (const label of labels) await user.click(opener(table, label));
    const blocks = [...document.querySelectorAll<HTMLElement>('.hx-trk')];
    expect(blocks.length).toBeGreaterThanOrEqual(labels.length - 1);
    for (const block of blocks) {
      const described = document.getElementById(chartOf(block).getAttribute('aria-describedby') ?? '') as HTMLElement;
      const turns = (described.textContent ?? '').split('、').map((part) => part.split(':')[0] as string);
      expect(turns[0]).toBe('配牌');
      const numbers = turns.slice(1).map((turn) => Number(/^(\d+)巡目/.exec(turn)?.[1]));
      expect(numbers.every((n) => Number.isInteger(n))).toBe(true);
      expect(numbers).toEqual([...numbers].sort((a, b) => a - b));
    }
  });
});
