/**
 * AI 一致率・類似度・悪手率（ACCEPTANCE の U-48。SPEC の F18）の、半荘のページの見出しの画面の試験。
 * 半荘の保存先の偽物（FakeSessionStore）の上で、取り込んだ半荘（FX-4 と f9da）と取り込む前の半荘を出して、使う人と同じ操作で確かめる。
 * 値の数え方は、エンジンの ai-metrics.test.ts（E-48）。ここでは、見出しの 1 行の形・説明の文・出る条件を確かめる。
 * 週の集計は week/WeekAiMetrics.test.tsx、実ブラウザの見え方（横スクロール・見出しの右との重なり・色・axe）は tests/browser/hanchan.browser.test.ts。
 */
import { aiMetricsOf, formatRatePercent, formatSimilarity, parseReportText } from '@jantama/engine';
import { act, render, screen, waitFor, within } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { FakeSessionStore, REPORT_TEXTS, local, seedSession, type ReportKey } from '../../tests/fake-sessions';
import { installTauriMock } from '../../tests/tauri-mock';
import type { SessionRecord } from '../api/types';
import { SessionPage } from './SessionPage';
import { summarizeReportText, type SummaryState } from './sessionSummaries';
import { UndoProvider } from './undo/UndoProvider';

vi.mock('@tauri-apps/api/core', () => ({
  invoke: vi.fn(),
  convertFileSrc: (path: string) => `asset://localhost/${encodeURIComponent(path)}`,
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

const LABEL = 'AI との比べ';
const TIP = 'AI 一致率・類似度・悪手率の説明';

/** 取り込んだ半荘（迷いは付けない）。FX-4 は判断 70・一致 62・悪手 5、f9da は判断 178・一致 135・悪手 19（基準 5%）・25（基準 10%）。 */
function imported(key: ReportKey = 'fx4'): SessionRecord {
  return seedSession(local(2026, 10, 9, 19, 9), { id: `g-${key}`, report: key }).session;
}

/** 取り込む前の半荘（迷い 2・評価 1）。 */
const recorded = (): SessionRecord => seedSession(local(2026, 10, 9, 16, 12), { id: 'g-none', marks: 2, ratings: 1 }).session;

const summaryOf = (key: ReportKey = 'fx4'): SummaryState => summarizeReportText(REPORT_TEXTS[key]);

interface SetupOptions {
  session?: SessionRecord;
  /** 取り込んだ結果。既定は FX-4。null なら、結果を読み出せない。 */
  report?: ReportKey | null;
  /** 画面に渡すまとめ。既定は、結果から作ったもの（取り込む前の半荘は無し）。 */
  summary?: SummaryState | undefined;
  doubtOnly?: boolean;
  handlers?: Record<string, (args: unknown) => unknown>;
}

function setup(options: SetupOptions = {}) {
  const key = options.report === undefined ? 'fx4' : options.report;
  const session = options.session ?? imported(key ?? 'fx4');
  const store = new FakeSessionStore([{ session, ...(key === null ? {} : { report: key }) }]);
  const mock = installTauriMock({ handlers: { ...store.handlers, ...options.handlers } });
  const summary = 'summary' in options ? options.summary : session.report_path === null ? undefined : summaryOf(key ?? 'fx4');
  const extra = {
    ...(options.doubtOnly === undefined ? {} : { doubtOnly: options.doubtOnly }),
  };
  const view = render(
    <UndoProvider>
      <SessionPage session={session} summary={summary} {...extra} />
    </UndoProvider>,
  );
  return { ...view, mock };
}

const list = () => screen.queryByRole('list', { name: LABEL });
const tip = () => screen.queryByRole('button', { name: TIP });
const textOf = (element: Element | null) => (element?.textContent ?? '').replace(/\s+/g, ' ').trim();
/** 結果を読み終えて、見出しの 1 行が出るまで待つ。 */
const lineReady = () => screen.findByRole('list', { name: LABEL });
/** 結果の読み込みが終わるのを待つ（出ないことを確かめる前に、読み終えていることを確かめる）。 */
async function settled(mock: ReturnType<typeof installTauriMock>) {
  await waitFor(() => expect(mock.count('read_report')).toBeGreaterThan(0));
  await act(async () => {
    await new Promise((resolve) => setTimeout(resolve, 30));
  });
}

/** 説明の文（半荘の数を入れる）。 */
const hint = (counts: { matches: number; decisions: number; badMoves: number }) =>
  `AI（Mortal）と比べた数です。AI 一致率は、自分の判断のうち、AI の1位と同じだった割合（${counts.matches}/${counts.decisions}）。類似度は、Mortal の Rating と同じ値で、AI の1位なら満点、違えば AI の評価に応じた部分点です（NAGA の類似度に当たります）。悪手率は、実戦の行動の AI の確率が 5% より低かった判断（悪手）の割合（${counts.badMoves}/${counts.decisions}）で、NAGA の悪手と同じ線です。`;

describe('U-48 半荘のページの見出し: AI 一致率・類似度・悪手率', () => {
  it('取り込み済み（FX-4）は、題の下の副題のさらに下に 1 行。「AI 一致率 88.6% · 類似度 93.0 · 悪手率 7.1%」の順で、説明のアイコンが続く', async () => {
    setup();
    const line = await lineReady();
    expect(textOf(line)).toBe('AI 一致率 88.6% · 類似度 93.0 · 悪手率 7.1%');
    expect(within(line).getAllByRole('listitem')).toHaveLength(3);
    // 題 → 副題 → この 1 行（説明のアイコンはその行の中）。見出しの左の欄の中にある
    const left = document.querySelector('.head-l') as HTMLElement;
    expect([...left.children].map((child) => child.tagName + (child.className ? `.${child.className}` : ''))).toEqual([
      'H1.title',
      'P.quiet',
      'DIV.head-metrics',
    ]);
    const row = left.querySelector('.head-metrics') as HTMLElement;
    expect(row.contains(line)).toBe(true);
    expect(row.contains(tip())).toBe(true);
    expect(line.compareDocumentPosition(tip() as HTMLElement) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy();
  });

  it('値は、エンジンの aiMetricsOf と同じ結果の値（取り込んだ結果を読み直した値）。小数第1位まで', async () => {
    setup({ report: 'fx1a' });
    const line = await lineReady();
    const parsed = parseReportText(REPORT_TEXTS.fx1a);
    if (!parsed.ok) throw new Error(parsed.error.message);
    const metrics = aiMetricsOf(parsed.value);
    const values = [...line.querySelectorAll('.metric-val')].map((value) => value.textContent);
    expect(values).toEqual([
      formatRatePercent(metrics.matchRate ?? Number.NaN),
      formatSimilarity(metrics.similarity ?? Number.NaN),
      formatRatePercent(metrics.badMoveRate ?? Number.NaN),
    ]);
    // 判断 178・一致 135・悪手 19
    expect(values).toEqual(['75.8%', '86.7', '10.7%']);
  });

  it('類似度は、見出しの Rating と同じ値', async () => {
    setup();
    const line = await lineReady();
    const rating = screen.getByText('93.0', { selector: '.rate-num' });
    expect(within(line).getByText('93.0')).toBeInTheDocument();
    expect(rating.textContent).toBe(line.querySelectorAll('.metric-val')[1]?.textContent);
  });

  it('ラベルと値が 3 組（ラベル: AI 一致率・類似度・悪手率、値は等幅の数字 .mono）。一覧の名前は「AI との比べ」。区切りは読み上げない', async () => {
    setup();
    const line = await lineReady();
    expect([...line.querySelectorAll('.metric-lbl')].map((label) => label.textContent)).toEqual(['AI 一致率', '類似度', '悪手率']);
    for (const value of line.querySelectorAll('.metric-val')) expect(value).toHaveClass('mono');
    // 区切りの「·」は、読み上げない（見た目だけ）
    const separators = line.querySelectorAll('.metric-sep');
    expect(separators).toHaveLength(2);
    for (const separator of separators) expect(separator).toHaveAttribute('aria-hidden', 'true');
  });

  it('説明のアイコン「AI 一致率・類似度・悪手率の説明」: 3 つの意味と、この半荘の数（62/70・5/70）と設定の基準（5%）が書いてある', async () => {
    setup();
    await lineReady();
    expect(tip()).toHaveAccessibleDescription(hint({ matches: 62, decisions: 70, badMoves: 5 }));
    expect(tip()).toHaveAccessibleDescription(
      'AI（Mortal）と比べた数です。AI 一致率は、自分の判断のうち、AI の1位と同じだった割合（62/70）。類似度は、Mortal の Rating と同じ値で、AI の1位なら満点、違えば AI の評価に応じた部分点です（NAGA の類似度に当たります）。悪手率は、実戦の行動の AI の確率が 5% より低かった判断（悪手）の割合（5/70）で、NAGA の悪手と同じ線です。',
    );
  });

  it('設定の基準を 10% にすると、悪手率と説明の文が変わる（f9da: 悪手 19 → 25、10.7% → 14.0%）。一致率と類似度は変わらない', async () => {
    const view = setup({ report: 'fx1a' });
    const before = await lineReady();
    expect(textOf(before)).toBe('AI 一致率 75.8% · 類似度 86.7 · 悪手率 10.7%');
    expect(tip()).toHaveAccessibleDescription(hint({ matches: 135, decisions: 178, badMoves: 19 }));
    view.unmount();
  });

  it('迷いだけの設定が入でも切でも出る（〇△✕ を使わないため）', async () => {
    const on = setup({ doubtOnly: true });
    expect(textOf(await lineReady())).toBe('AI 一致率 88.6% · 類似度 93.0 · 悪手率 7.1%');
    expect(tip()).not.toBeNull();
    on.unmount();

    setup({ doubtOnly: false });
    expect(textOf(await lineReady())).toBe('AI 一致率 88.6% · 類似度 93.0 · 悪手率 7.1%');
    expect(tip()).not.toBeNull();
  });

  it('取り込む前の半荘には出ない（副題は「取り込み前」のまま）', () => {
    setup({ session: recorded() });
    expect(screen.getByText('取り込み前 · 迷い 2 · 評価 1')).toBeInTheDocument();
    expect(list()).toBeNull();
    expect(tip()).toBeNull();
    expect(document.querySelector('.head-metrics')).toBeNull();
  });

  it('結果を読んでいる間は出ない。読み終えると出る（まとめを読んでいる間も、結果を読んでいる間も）', async () => {
    let release: (text: string) => void = () => undefined;
    const held = new Promise<string>((resolve) => {
      release = resolve;
    });
    // まとめ（一覧の行の分）は読めているが、結果そのものを読んでいる間
    setup({ handlers: { read_report: () => held } });
    expect(list()).toBeNull();
    expect(tip()).toBeNull();
    await act(async () => {
      release(REPORT_TEXTS.fx4);
      await held;
    });
    expect(textOf(await lineReady())).toBe('AI 一致率 88.6% · 類似度 93.0 · 悪手率 7.1%');
  });

  it('まとめを読んでいる間と、まとめが読めなかった半荘には出ない（結果は読めていても。段階の印・Rating が出ないとき）', async () => {
    const loading = setup({ summary: { status: 'loading' } });
    await settled(loading.mock);
    expect(list()).toBeNull();
    expect(tip()).toBeNull();
    expect(document.querySelector('.head .grade')).toBeNull();
    loading.unmount();

    const unreadable = setup({ summary: { status: 'unavailable', reason: '形が合いません' } });
    await settled(unreadable.mock);
    expect(screen.getByText('取り込んだ結果を読めませんでした（形が合いません）')).toBeInTheDocument();
    expect(list()).toBeNull();
    expect(tip()).toBeNull();
  });

  it('結果を読み出せなかった半荘（取り込み済みなのに）には出ない', async () => {
    const { mock } = setup({ report: null, summary: { status: 'unavailable', reason: '取り込んだ結果を読み出せませんでした' } });
    await settled(mock);
    expect(list()).toBeNull();
    expect(tip()).toBeNull();
    // 結果を読めない半荘の画面は、記録した評価の一覧（見出しの 1 行が無いだけで、ほかは変わらない）
    expect(screen.getByRole('heading', { level: 2, name: /^評価（/ })).toBeInTheDocument();
  });
});
