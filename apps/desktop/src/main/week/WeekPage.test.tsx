/**
 * 週の集計（ACCEPTANCE の U-30、R11-12。D-2・D-3 に関わる所）の、画面の試験。
 * アプリ全体（App）を、半荘の保存先の偽物と、答えの記録（週の成績・重点を含む）の偽物の上で動かして、使う人と同じ操作で確かめる。
 * 数え方（週の区切り・割合・一致率・ずれ）は weekModel.test.ts・weekSource.test.ts（単体）、保存は src-tauri の study の試験、
 * 実ブラウザでの見え方（横スクロール・axe・Tab・幅 390px）は tests/browser/week.browser.test.ts が確かめる。
 */
import { RATING_LINK_VERSION, actualChoice, calledTileOf, keyOfDecision, type Decision, type ImportedGame } from '@jantama/engine';
import { act, cleanup, render, screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { FakeSessionStore, local, seedSession, type ReportKey } from '../../../tests/fake-sessions';
import { FakeStudyStore, answerRow, gameOf } from '../../../tests/fake-study';
import { fx4Ocr, fx4Session } from '../../../tests/import-fixtures';
import { baseSettings, installTauriMock } from '../../../tests/tauri-mock';
import type { AnswerRow, Links, SessionRecord, Settings } from '../../api/types';
import { App } from '../App';
import { phasesOf } from '../log/logModel';

vi.mock('@tauri-apps/api/core', () => ({
  invoke: vi.fn(),
  convertFileSrc: (path: string) => path,
}));
vi.mock('@tauri-apps/api/event', () => ({ listen: vi.fn() }));
vi.mock('@tauri-apps/plugin-dialog', () => ({ open: vi.fn() }));

/** 試験の「いま」: 2026 年 10 月 9 日（金）22:00。今週は 10 月 5 日（月）から、先週は 9 月 28 日から。 */
beforeEach(() => {
  vi.useFakeTimers({ toFake: ['Date'] });
  vi.setSystemTime(new Date(2026, 9, 9, 22, 0, 0));
});

afterEach(() => {
  cleanup();
  vi.useRealTimers();
});

const FX4_ID = '20261009-190953';
const FX1A_ID = '20261002-171200';
const LOAD = { timeout: 20_000 };
/** 取り込みが保存するとおりの結びつけ（当てはめ方の版つき。版が古いと、半荘のページを開いたとき、当てはめ直される）。 */
const LINKS: Links = {
  marks: {},
  ratings: { '7': 'k0h0', '8': 'k1h0', '9': 'k1h1', '10': 'k2h0', '11': 'k2h1' },
  ratings_version: RATING_LINK_VERSION,
};

const fx4Game = gameOf('fx4');
const fx1aGame = gameOf('fx1a');
const discards = (game: ImportedGame) => game.decisions.filter((d) => d.kind === 'discard');
const keyOf = (decision: Decision | undefined) => keyOfDecision(decision as Decision);

// 答える問題（FX-4 の打牌 3 つと鳴き 1 つ。f9da の打牌 4 つ）
const A = discards(fx4Game)[10] as Decision;
const B = discards(fx4Game)[25] as Decision;
const CALL = fx4Game.decisions.find((d) => d.kind === 'call' && calledTileOf(d) !== null) as Decision;
const BOUNDARY = discards(fx4Game)[12] as Decision;
const C = discards(fx1aGame)[12] as Decision;
const D = discards(fx1aGame)[30] as Decision;
const E = discards(fx1aGame)[45] as Decision;

/** FX-4 の半荘（10/9 19:09）。自分の〇△✕: 東1局 △・東2局 ✕・東2局1本場 △・東3局 ✕・東3局1本場 ✕（AI 基準は S+・S-・A・S・S-。A だけが△の帯で、あとは〇の帯）。 */
function fx4(): SessionRecord {
  const base = fx4Session(FX4_ID, local(2026, 10, 9, 19, 9), {
    report_path: `C:\\data\\games\\${FX4_ID}\\report.json`,
    ocr: fx4Ocr(),
    links: LINKS,
  });
  const ratings = ['fair', 'bad', 'fair', 'bad', 'bad'] as const;
  return { ...base, ratings: base.ratings.map((r, i) => ({ ...r, rating: ratings[i] ?? r.rating })) };
}

const fx1a = () => seedSession(local(2026, 10, 2, 17, 12), { id: FX1A_ID, report: 'fx1a' });

function answer(id: number, sessionId: string, decision: Decision, patch: Partial<AnswerRow>): AnswerRow {
  return answerRow({ id, session_id: sessionId, decision_key: keyOf(decision), choice: actualChoice(decision), ...patch });
}

/**
 * 今週（10/5〜10/11）4 問: 出題 3・解き直し 1、正解 2。原因は 受け入れ 2・形 1・守備 1。
 * 先週（9/28〜10/4）3 問: 全部出題、正解 2。原因は 打点 2・その他 1。月曜の午前 3 時 59 分の答えは、先週に入る。
 */
function answers(): AnswerRow[] {
  return [
    answer(1, FX4_ID, A, { mode: 'quiz', answered_at: local(2026, 10, 9, 20, 0), correct: false, causes: ['defense', 'ukeire'] }),
    answer(2, FX4_ID, B, { mode: 'quiz', answered_at: local(2026, 10, 8, 21, 0), correct: true, causes: ['shape'] }),
    answer(3, FX4_ID, CALL, { mode: 'quiz', answered_at: local(2026, 10, 7, 20, 0), correct: true, causes: [] }),
    answer(4, FX1A_ID, C, { mode: 'review', answered_at: local(2026, 10, 8, 22, 0), correct: false, causes: ['ukeire'] }),
    answer(5, FX1A_ID, D, { mode: 'quiz', answered_at: local(2026, 10, 2, 20, 0), correct: true, causes: ['value'] }),
    answer(6, FX1A_ID, E, { mode: 'quiz', answered_at: local(2026, 10, 1, 20, 0), correct: false, causes: ['value', 'other'] }),
    answer(7, FX4_ID, BOUNDARY, { mode: 'quiz', answered_at: local(2026, 10, 5, 3, 59), correct: true, causes: [] }),
  ];
}

interface Options {
  /** 半荘（既定は FX-4 と f9da）。 */
  sessions?: Array<{ session: SessionRecord; report?: ReportKey }>;
  answers?: AnswerRow[];
  study?: FakeStudyStore;
  handlers?: Record<string, (args: unknown) => unknown>;
  /** 設定の上書き（迷いだけを記録する設定を入にするときなど）。 */
  settings?: Partial<Settings>;
}

function setup(options: Options = {}) {
  const store = new FakeSessionStore(options.sessions ?? [{ session: fx4(), report: 'fx4' }, fx1a()]);
  const study = options.study ?? new FakeStudyStore(options.answers ?? answers());
  const mock = installTauriMock({
    settings: { ...baseSettings, ...options.settings },
    handlers: { ...store.handlers, ...study.handlers, ...options.handlers },
  });
  const user = userEvent.setup();
  render(<App />);
  return { store, study, user, mock };
}

/** サイドバーの「週の集計」を押して、ページが数を出すまで待つ。 */
async function openWeek(user: ReturnType<typeof userEvent.setup>) {
  await screen.findByRole('navigation', { name: '半荘の一覧' });
  await user.click(screen.getByRole('button', { name: '週の集計' }));
  await screen.findByRole('heading', { level: 1, name: '週の集計' });
  await screen.findByRole('list', { name: /の数$/ }, LOAD);
}

const textOf = (element: Element | null) => (element?.textContent ?? '').replace(/\s+/g, ' ').trim();
const tiles = () => within(screen.getByRole('list', { name: /の数$/ })).getAllByRole('listitem').map((li) => textOf(li));
const range = () => textOf(document.querySelector('.wk-range'));
const prevButton = () => screen.getByRole('button', { name: '前の週' });
const nextButton = () => screen.getByRole('button', { name: '次の週' });
const tip = () => document.querySelector<HTMLElement>('.wk-tip');
const tipText = () => {
  const el = tip();
  return el === null || el.hidden ? null : textOf(el.querySelector('.wk-tip-v')) + ' | ' + textOf(el.querySelector('.wk-tip-l'));
};
const figure = (id: string) => document.querySelector<HTMLElement>(`figure[data-fig="${id}"]`) as HTMLElement;
const section = (name: string) => screen.getByRole('heading', { level: 2, name }).closest('section') as HTMLElement;
const barRows = () =>
  within(screen.getByRole('list', { name: /の差の原因$/ }))
    .getAllByRole('listitem')
    .map((li) => textOf(li));

describe('U-30 週の切り替え（月曜から日曜。今週が最初）', () => {
  it('サイドバーの「週の集計」から開く。最初は今週: 10月5日（月）〜10月11日（日）に「今週」の印。→ は押せず、← は押せる', async () => {
    const { user } = setup();
    await openWeek(user);
    expect(screen.getByRole('button', { name: '週の集計' })).toHaveAttribute('aria-current', 'page');
    expect(range()).toBe('10月5日（月）〜10月11日（日）');
    expect(screen.getByText('今週', { selector: '.tag' })).toBeInTheDocument();
    expect(screen.getByRole('heading', { level: 2, name: '今週の数' })).toBeInTheDocument();
    expect(nextButton()).toBeDisabled();
    expect(prevButton()).toBeEnabled();
    expect(screen.getByRole('group', { name: '週を選ぶ' })).toBeInTheDocument();
  });

  it('← で前の週（9月28日〜10月4日）。「今週」の印は消え、→ が押せる。→ で今週に戻る', async () => {
    const { user } = setup();
    await openWeek(user);
    await user.click(prevButton());
    expect(range()).toBe('9月28日（月）〜10月4日（日）');
    expect(screen.queryByText('今週', { selector: '.tag' })).toBeNull();
    expect(screen.getByRole('heading', { level: 2, name: 'この週の数' })).toBeInTheDocument();
    expect(nextButton()).toBeEnabled();
    await user.click(nextButton());
    expect(range()).toBe('10月5日（月）〜10月11日（日）');
    expect(nextButton()).toBeDisabled();
    expect(screen.getByText('今週', { selector: '.tag' })).toBeInTheDocument();
  });

  it('← は、記録のあるいちばん古い週まで（答え・半荘・迷いマークの週）。そこで ← は使えなくなり、キーボードの位置は → へ移る', async () => {
    const { user } = setup();
    await openWeek(user);
    act(() => prevButton().focus());
    await user.keyboard('{Enter}');
    expect(range()).toBe('9月28日（月）〜10月4日（日）');
    // いちばん古い記録（10/1 の答え・10/2 の半荘）が 9/28 の週。それより前へは行けない
    expect(prevButton()).toBeDisabled();
    await waitFor(() => expect(nextButton()).toHaveFocus());
  });

  it('記録が今週だけなら、先週（答えの無い週）までは ← で見られる', async () => {
    const { user } = setup({ sessions: [{ session: fx4(), report: 'fx4' }], answers: answers().slice(0, 4).filter((a) => a.session_id === FX4_ID) });
    await openWeek(user);
    expect(prevButton()).toBeEnabled();
    await user.click(prevButton());
    expect(range()).toBe('9月28日（月）〜10月4日（日）');
    expect(prevButton()).toBeDisabled();
  });

  it('Alt+← は、週ではなく、画面の戻る（週の集計を開く前の画面）', async () => {
    const { user } = setup();
    await openWeek(user);
    await user.click(prevButton());
    await user.keyboard('{Alt>}{ArrowLeft}{/Alt}');
    await screen.findByRole('heading', { level: 1, name: /10月9日/ });
    await user.keyboard('{Alt>}{ArrowRight}{/Alt}');
    await screen.findByRole('heading', { level: 1, name: '週の集計' });
    // 開き直した週の集計は、今週から
    expect(range()).toBe('10月5日（月）〜10月11日（日）');
  });
});

describe('U-30 今週の数・差の原因の割合（局面に対する割合。2 つ付いた局面は両方に数える）', () => {
  it('今週の数: 解いた問題（出題・解き直し）・正解率・迷いマーク・半荘', async () => {
    const { user } = setup();
    await openWeek(user);
    const [solved, rate, marks, games] = tiles();
    expect(solved).toBe('解いた問題4問出題 3・解き直し 1');
    expect(rate).toBe('正解率50%2 / 4問');
    expect(marks).toMatch(/^迷いマーク6うち答えたもの \d+$/);
    expect(games).toBe('半荘1取り込んだ半荘');
  });

  it('差の原因は、答えた局面に対する割合（受け入れ 50%・形 25%・守備 25%）と、局面の数。合計が 100% を超えるので、そのことは説明のアイコンにある', async () => {
    const { user } = setup();
    await openWeek(user);
    expect(barRows()).toEqual([
      '受け入れ枚数50%（2局面）',
      '形の質25%（1局面）',
      '打点0%（0局面）',
      '守備25%（1局面）',
      'その他0%（0局面）',
    ]);
    // 説明の文は、本文には出ず、見出しのそばの説明のアイコン（R11-1）にある
    const causes = section('差の原因');
    const icon = within(causes).getByRole('button', { name: '差の原因の割合の説明' });
    const sentence =
      '今週答えた 4局面のうち、それぞれの原因が付いた局面の割合です。1つの局面に原因が2つ付くと両方に数えるので、合計は100%を超えます。';
    expect(causes.querySelector('.wk-note')).toBeNull();
    expect(icon).toHaveAccessibleDescription(sentence);
    expect(document.querySelector('.infotip-pop')?.textContent).toBeTruthy();
    // 合計は 100% を超える（50 + 25 + 0 + 25 + 0 = 100 ではなく、原因が 2 つ付いた局面があるので、数の合計は答えた局面より多い）
    const counts = [2, 1, 0, 1, 0];
    expect(counts.reduce((sum, n) => sum + n, 0)).toBeGreaterThan(4 - 1);
  });

  it('1 つの局面に原因が 2 つ付くと両方に数える: 先週の 3 問は、打点 2・その他 1 で、割合は 67%・33%', async () => {
    const { user } = setup();
    await openWeek(user);
    await user.click(prevButton());
    expect(tiles()[0]).toBe('解いた問題3問出題 3・解き直し 0');
    expect(barRows()).toEqual([
      '受け入れ枚数0%（0局面）',
      '形の質0%（0局面）',
      '打点67%（2局面）',
      '守備0%（0局面）',
      'その他33%（1局面）',
    ]);
  });

  it('日の区切りは午前 4 時: 月曜（10/5）の午前 3 時 59 分の答えは先週に入る', async () => {
    const { user } = setup();
    await openWeek(user);
    // 今週の 4 問に、午前 3 時 59 分の答え（f の 7 番）は入らない
    expect(tiles()[0]).toBe('解いた問題4問出題 3・解き直し 1');
    await user.click(prevButton());
    expect(tiles()[0]).toBe('解いた問題3問出題 3・解き直し 0');
  });

  it('直近 8 週の推移: 原因ごとの小さな線が 5 つ。縦の目盛りは、どれも同じ。今週の値は「今週 50%」', async () => {
    const { user } = setup();
    await openWeek(user);
    const multi = within(figure('multi'));
    // 先週の「打点」が 67% なので、縦の目盛りは 0〜80%（60% を超える週があれば広げる。5 つの図で同じ）
    expect(textOf(figure('multi').querySelector('figcaption'))).toBe('直近8週の推移縦の目盛りは、どの図も 0〜80%。淡い帯が今週です');
    const names = multi.getAllByRole('listitem').map((li) => textOf(li.querySelector('.wk-smallh')));
    expect(names).toEqual(['受け入れ枚数今週 50%', '形の質今週 25%', '打点今週 0%', '守備今週 25%', 'その他今週 0%']);
    for (const name of ['受け入れ枚数', '形の質', '打点', '守備', 'その他']) {
      expect(multi.getByRole('group', { name: `${name}の割合（直近8週）（矢印キーで週を選ぶ）` })).toBeInTheDocument();
    }
    // 縦軸の目盛りは、どれも 0%・40%・80%、左右の端の週は 8/17 と 10/5
    for (const axis of figure('multi').querySelectorAll('.lc-y')) expect(textOf(axis)).toBe('0%40%80%');
    for (const edge of figure('multi').querySelectorAll('.lc-x')) expect([...edge.children].map((c) => textOf(c))).toEqual(['8/17', '10/5']);
  });

  it('縦軸は、ふだん 0〜60%（どの週も 60% 以下）。60% を超える週があれば 80%・100% に広げる（5 つの図で同じ）', async () => {
    const calm = setup({ answers: answers().slice(0, 4) });
    await openWeek(calm.user);
    expect(textOf(figure('multi').querySelector('figcaption'))).toBe('直近8週の推移縦の目盛りは、どの図も 0〜60%。淡い帯が今週です');
    for (const axis of figure('multi').querySelectorAll('.lc-y')) expect(textOf(axis)).toBe('0%30%60%');
    cleanup();

    // 今週 3 問すべてに「受け入れ枚数」が付く（100%）
    const many = [
      answer(1, FX4_ID, A, { answered_at: local(2026, 10, 9, 20, 0), causes: ['ukeire'] }),
      answer(2, FX4_ID, B, { answered_at: local(2026, 10, 8, 20, 0), causes: ['ukeire'] }),
      answer(3, FX4_ID, CALL, { answered_at: local(2026, 10, 7, 20, 0), causes: ['ukeire'] }),
    ];
    const { user } = setup({ answers: many });
    await openWeek(user);
    expect(textOf(figure('multi').querySelector('figcaption'))).toContain('0〜100%');
    for (const axis of figure('multi').querySelectorAll('.lc-y')) expect(textOf(axis)).toBe('0%50%100%');
  });

  it('局面の種類: 6 つの種類ごとに、問題の数と正解率。種類は重なる（説明のアイコンにある）', async () => {
    const { user } = setup();
    await openWeek(user);
    const table = within(section('局面の種類')).getByRole('table', { name: '局面の種類ごとの問題の数と正解率' });
    const rows = within(table).getAllByRole('row').slice(1);
    expect(rows.map((r) => textOf(r.querySelector('th')))).toEqual(['2向聴以上', '1向聴', '聴牌', '鳴き', '押し引き', '序盤']);
    // 期待値は、今週の 4 問の局面（検討ログと同じ規則）から数える
    const week = [
      { decision: A, correct: false },
      { decision: B, correct: true },
      { decision: CALL, correct: true },
      { decision: C, correct: false },
    ];
    for (const row of rows) {
      const id = textOf(row.querySelector('th'));
      const hit = week.filter((w) => (phasesOf(w.decision.shanten, w.decision.tags) as readonly string[]).includes(id));
      const right = hit.filter((w) => w.correct).length;
      expect(textOf(row.querySelector('td.num')), id).toBe(`${hit.length}問`);
      expect(textOf(row.querySelector('.wk-rate .num')), id).toBe(hit.length === 0 ? '—' : `${Math.round((right / hit.length) * 100)}%`);
    }
    expect(
      within(section('局面の種類')).getByRole('button', { name: '局面の種類の説明' }),
    ).toHaveAccessibleDescription('種類は重なります（1向聴の序盤の問題は、両方に数えます）。');
  });
});

describe('U-30 局の評価: 一致率と、結果ごとのずれ', () => {
  it('自分の〇△✕と AI 基準を比べた 5 局は、東2局1本場（△と A）だけが同じ帯で、一致 1 局の 20%。結果ごとのずれは 自分の和了 0.0・放銃 -2.0・流局 —・他家の和了 -1.5', async () => {
    const { user } = setup();
    await openWeek(user);
    const evaluation = section('局の評価');
    const agree = figure('agree');
    expect(textOf(agree.querySelector('.wk-big .k'))).toBe('自分の〇△✕が AI 基準と合った割合');
    expect(textOf(agree.querySelector('.wk-big .v'))).toBe('20%');
    expect(textOf(agree.querySelector('.wk-big .s'))).toBe('5局のうち 1局が一致');
    const dots = figure('dots');
    const rows = [...dots.querySelectorAll('.dp-row')].map((r) => textOf(r));
    expect(rows).toEqual(['自分の和了1局0.0', '放銃2局−2.0', '流局0局', '他家の和了2局−1.5']);
    expect(textOf(dots.querySelector('.dp-dir'))).toBe('AIより低く付けた ← → AIより高く付けた');
    expect(textOf(evaluation.querySelector('.wk-note'))).toBe('和了できなかった局（放銃・他家の和了）を、AI より平均 1.8 段階低く付けています');
    // 説明の文は、説明のアイコンにある
    expect(within(evaluation).getByRole('button', { name: '一致率とずれの説明' })).toHaveAccessibleDescription(
      '〇を3・△を2・✕を1として、自分の評価から AI 基準の評価を引いた平均です。AI 基準は、S を〇、A を△、B 以下を✕として数えます。0 は AI と同じ評価です。',
    );
  });

  it('表で付け直した自分の評価が、一致率に反映される（〇に付け直した局は、AI 基準が S なので同じ帯で、一致）', async () => {
    const edited: SessionRecord = { ...fx4(), self_ratings: { kyokus: { k0h0: 'good', k2h0: 'good' } } };
    const { user } = setup({ sessions: [{ session: edited, report: 'fx4' }, fx1a()] });
    await openWeek(user);
    // 東1局 〇（S+）・東2局 ✕（S-）・東2局1本場 △（A）・東3局 〇（S）・東3局1本場 ✕（S-）。一致は 東1局・東2局1本場・東3局 の 3 局
    expect(textOf(figure('agree').querySelector('.wk-big .v'))).toBe('60%');
    expect(textOf(figure('agree').querySelector('.wk-big .s'))).toBe('5局のうち 3局が一致');
  });

  it('評価を付けた局が無い週は、「この週は、評価を付けた局がありません。」と一致率の線だけ（先週）', async () => {
    const { user } = setup();
    await openWeek(user);
    await user.click(prevButton());
    expect(screen.getByText('この週は、評価を付けた局がありません。')).toBeInTheDocument();
    expect(textOf(figure('agree').querySelector('.wk-big .v'))).toBe('—');
    expect(textOf(figure('agree').querySelector('.wk-big .s'))).toBe('この週は評価を付けた局がありません');
    expect(document.querySelector('figure[data-fig="dots"]')).toBeNull();
  });
});

describe('U-46 迷いだけを記録する設定が入のとき、一致率と結果ごとのずれを出さない', () => {
  it('「局の評価」の区画（一致率・結果ごとのずれ・説明のアイコン・それぞれの「表で見る」）が無い。ほかの区画は、そのまま出る', async () => {
    const { user } = setup({ settings: { doubt_only: true } });
    await openWeek(user);
    expect(screen.queryByRole('heading', { level: 2, name: '局の評価' })).toBeNull();
    expect(document.querySelector('figure[data-fig="agree"]')).toBeNull();
    expect(document.querySelector('figure[data-fig="dots"]')).toBeNull();
    expect(screen.queryByRole('button', { name: '一致率とずれの説明' })).toBeNull();
    expect(screen.queryByText('自分の〇△✕が AI 基準と合った割合')).toBeNull();
    expect(screen.queryByText(/AIより低く付けた/)).toBeNull();
    // 残るのは 3 つの図（差の原因の横棒と推移・成績）。「表で見る」も 3 つ
    const figs = [...document.querySelectorAll('figure[data-fig]')].map((f) => f.getAttribute('data-fig'));
    expect(figs.sort()).toEqual(['bars', 'multi', 'rec']);
    expect(screen.getAllByRole('button', { name: '表で見る' })).toHaveLength(3);
    expect(tiles()).toHaveLength(4);
    expect(screen.getByRole('heading', { level: 2, name: '局面の種類' })).toBeInTheDocument();
    expect(screen.getByRole('heading', { level: 2, name: '成績（手入力）' })).toBeInTheDocument();
    expect(screen.getByRole('heading', { level: 2, name: '来週の重点' })).toBeInTheDocument();
    // 区画の順は、今週の数・差の原因・局面の種類・成績・来週の重点（局の評価が抜けるだけ）
    const headings = [...document.querySelectorAll('.page h2.sec-title')].map((h) => textOf(h));
    expect(headings).toEqual(['今週の数', '差の原因', '局面の種類', '成績（手入力）', '取り込んだ半荘から数えた値（参考）', '来週の重点']);
  });

  it('設定を切ると、元どおり出る（付け直した評価も、一致率に反映されたまま）。入れ直すと、また隠れる', async () => {
    const edited: SessionRecord = { ...fx4(), self_ratings: { kyokus: { k0h0: 'good', k2h0: 'good' } } };
    const { user, mock } = setup({ sessions: [{ session: edited, report: 'fx4' }, fx1a()], settings: { doubt_only: true } });
    await openWeek(user);
    expect(document.querySelector('figure[data-fig="agree"]')).toBeNull();
    act(() => {
      mock.emit('settings-changed', { ...baseSettings, doubt_only: false } satisfies Settings);
    });
    await waitFor(() => expect(document.querySelector('figure[data-fig="agree"]')).not.toBeNull());
    expect(textOf(figure('agree').querySelector('.wk-big .v'))).toBe('60%');
    expect(textOf(figure('dots').querySelector('.dp-dir'))).toBe('AIより低く付けた ← → AIより高く付けた');
    expect(screen.getByRole('heading', { level: 2, name: '局の評価' })).toBeInTheDocument();
    expect(screen.getAllByRole('button', { name: '表で見る' })).toHaveLength(5);
    act(() => {
      mock.emit('settings-changed', { ...baseSettings, doubt_only: true } satisfies Settings);
    });
    await waitFor(() => expect(document.querySelector('figure[data-fig="agree"]')).toBeNull());
    expect(screen.queryByRole('heading', { level: 2, name: '局の評価' })).toBeNull();
  });

  it('週を替えても（評価を付けた局が無い先週でも）、局の評価の区画は出ない', async () => {
    const { user } = setup({ settings: { doubt_only: true } });
    await openWeek(user);
    await user.click(prevButton());
    expect(screen.queryByText('この週は、評価を付けた局がありません。')).toBeNull();
    expect(document.querySelector('figure[data-fig="agree"]')).toBeNull();
    expect(range()).toBe('9月28日（月）〜10月4日（日）');
  });
});

describe('U-30 図の吹き出し（マウス・キーボード）と「表で見る」', () => {
  it('小さな折れ線は、1 つの Tab の止まり場所。選ぶと今週の吹き出し、← で前の週、もう一度 ← でデータの無い週。Esc で閉じる', async () => {
    const { user } = setup();
    await openWeek(user);
    const plot = within(figure('multi')).getByRole('group', { name: '受け入れ枚数の割合（直近8週）（矢印キーで週を選ぶ）' });
    expect(plot).toHaveAttribute('tabindex', '0');
    expect(tipText()).toBeNull();
    act(() => plot.focus());
    expect(tipText()).toBe('50%（2局面） | 受け入れ枚数・10月5日の週');
    await user.keyboard('{ArrowLeft}');
    expect(tipText()).toBe('0%（0局面） | 受け入れ枚数・9月28日の週');
    await user.keyboard('{ArrowLeft}');
    expect(tipText()).toBe('データなし | 受け入れ枚数・9月21日の週');
    await user.keyboard('{Home}');
    expect(tipText()).toBe('データなし | 受け入れ枚数・8月17日の週');
    await user.keyboard('{End}');
    expect(tipText()).toBe('50%（2局面） | 受け入れ枚数・10月5日の週');
    await user.keyboard('{Escape}');
    expect(tipText()).toBeNull();
    // 選んでいる週の点が、図に出る（十字線と点）
    act(() => plot.blur());
    expect(tipText()).toBeNull();
  });

  it('横棒も 1 つの止まり場所。矢印キーで棒を選ぶと、同じ吹き出しが出る（値が先、名前があと）', async () => {
    const { user } = setup();
    await openWeek(user);
    const bars = screen.getByRole('group', { name: '差の原因の割合（矢印キーで選ぶ）' });
    act(() => bars.focus());
    expect(tipText()).toBe('50%（2局面） | 受け入れ枚数・10月5日の週');
    await user.keyboard('{ArrowDown}');
    expect(tipText()).toBe('25%（1局面） | 形の質・10月5日の週');
    await user.keyboard('{ArrowUp}{ArrowUp}');
    expect(tipText()).toBe('0%（0局面） | その他・10月5日の週');
    expect(document.querySelector('.wk-bar[data-active="true"] .nm')?.textContent).toBe('その他');
    act(() => bars.blur());
    expect(tipText()).toBeNull();
    expect(document.querySelector('.wk-bar[data-active="true"]')).toBeNull();
  });

  it('点の図も 1 つの止まり場所。選ぶと「平均 0.0 段階」と結果・局数が出る。マウスを乗せても同じ', async () => {
    const { user } = setup();
    await openWeek(user);
    const dots = screen.getByRole('group', { name: '結果ごとのずれ（矢印キーで選ぶ）' });
    act(() => dots.focus());
    expect(tipText()).toBe('平均 0.0 段階 | 自分の和了・1局');
    await user.keyboard('{ArrowDown}');
    expect(tipText()).toBe('平均 −2.0 段階 | 放銃・2局');
    await user.keyboard('{ArrowDown}');
    expect(tipText()).toBe('— | 流局・0局');
    act(() => dots.blur());
    const lanes = document.querySelectorAll('.dp-lane');
    await user.hover(lanes[3] as Element);
    expect(tipText()).toBe('平均 −1.5 段階 | 他家の和了・2局');
    await user.unhover(lanes[3] as Element);
    expect(tipText()).toBeNull();
  });

  it('マウスを乗せた横棒にも、吹き出しが出る。離すと消える', async () => {
    const { user } = setup();
    await openWeek(user);
    const bar = screen.getByRole('list', { name: '今週の差の原因' }).querySelectorAll('.wk-bar')[1] as Element;
    await user.hover(bar);
    expect(tipText()).toBe('25%（1局面） | 形の質・10月5日の週');
    await user.unhover(bar);
    expect(tipText()).toBeNull();
  });

  it('吹き出しの数字は、キーボードで選んだときに読み上げの欄（aria-live）にも出る。吹き出しそのものは読み上げない', async () => {
    const { user } = setup();
    await openWeek(user);
    expect(tip()).toHaveAttribute('aria-hidden', 'true');
    const bars = screen.getByRole('group', { name: '差の原因の割合（矢印キーで選ぶ）' });
    act(() => bars.focus());
    await waitFor(() => expect(document.querySelector('[aria-live="polite"].sr-only')?.textContent).toContain('50%（2局面）'));
  });

  it('どの図にも「表で見る」がある（5 つ）。押すと同じ数の表に替わり、「グラフで見る」でもとに戻る', async () => {
    const { user } = setup();
    await openWeek(user);
    const figs = [...document.querySelectorAll('figure[data-fig]')].map((f) => f.getAttribute('data-fig'));
    expect(figs.sort()).toEqual(['agree', 'bars', 'dots', 'multi', 'rec']);
    const expectations: Record<string, { caption: string; head: string[]; first: string[] }> = {
      bars: { caption: '原因ごとの割合と局面の数', head: ['原因', '割合', '局面の数'], first: ['受け入れ枚数', '50%', '2局面'] },
      multi: {
        caption: '原因ごとの直近8週の割合（かっこは局面の数）',
        head: ['週', '受け入れ枚数', '形の質', '打点', '守備', 'その他'],
        first: ['8/17の週', '—', '—', '—', '—', '—'],
      },
      agree: { caption: '一致率の直近8週', head: ['週', '一致率'], first: ['8/17の週', '—'] },
      dots: { caption: '局の結果ごとの、自分の評価と AI 基準の差の平均（段階）', head: ['結果', '局数', '差の平均（段階）'], first: ['自分の和了', '1局', '0.0'] },
      rec: {
        caption: '週ごとの成績（直近8週）',
        head: ['週', '4位率', '放銃率', '平均順位', '和了率', '副露率', '立直率'],
        first: ['8/17の週', '—', '—', '—', '—', '—', '—'],
      },
    };
    for (const id of figs as string[]) {
      const fig = within(figure(id));
      const toggle = fig.getByRole('button', { name: '表で見る' });
      expect(toggle).toHaveAttribute('aria-pressed', 'false');
      await user.click(toggle);
      const expected = expectations[id] as (typeof expectations)[string];
      const table = fig.getByRole('table', { name: expected.caption });
      expect(within(table).getAllByRole('columnheader').map((h) => textOf(h))).toEqual(expected.head);
      const first = within(table).getAllByRole('row')[1] as HTMLElement;
      expect([...first.children].map((c) => textOf(c))).toEqual(expected.first);
      expect(figure(id)).toHaveAttribute('data-view', 'table');
      const back = fig.getByRole('button', { name: 'グラフで見る' });
      expect(back).toHaveAttribute('aria-pressed', 'true');
      await user.click(back);
      expect(fig.queryByRole('table')).toBeNull();
      expect(figure(id)).toHaveAttribute('data-view', 'chart');
    }
  });

  it('「表で見る」の表は、今週の行を太字にする。割合の表の最後の行は今週（8 行目）', async () => {
    const { user } = setup();
    await openWeek(user);
    await user.click(within(figure('multi')).getByRole('button', { name: '表で見る' }));
    const rows = within(figure('multi')).getAllByRole('row').slice(1);
    expect(rows).toHaveLength(8);
    expect(rows.map((r) => r.className)).toEqual(['', '', '', '', '', '', '', 'cur']);
    expect(textOf(rows[7]?.querySelector('th') ?? null)).toBe('10/5の週');
    expect([...(rows[7] as HTMLElement).children].map((c) => textOf(c))).toEqual(['10/5の週', '50%（2）', '25%（1）', '0%（0）', '25%（1）', '0%（0）']);
    expect([...(rows[6] as HTMLElement).children].map((c) => textOf(c))).toEqual(['9/28の週', '0%（0）', '0%（0）', '67%（2）', '0%（0）', '33%（1）']);
  });

  it('表で見ていても、週を替えると、表のまま（図の表示は、週をまたいで残る）', async () => {
    const { user } = setup();
    await openWeek(user);
    await user.click(within(figure('bars')).getByRole('button', { name: '表で見る' }));
    await user.click(prevButton());
    expect(figure('bars')).toHaveAttribute('data-view', 'table');
    expect(within(figure('bars')).getAllByRole('row')[3]).toHaveTextContent('打点67%2局面');
  });
});

describe('U-30 答えの無い週', () => {
  const onlyThisWeek = () => ({
    sessions: [{ session: fx4(), report: 'fx4' as const }],
    answers: [answer(1, FX4_ID, A, { answered_at: local(2026, 10, 9, 20, 0), correct: true, causes: ['shape'] })],
  });

  it('数は 0 と —、原因・局面・評価の区画は「答えた問題がありません」「評価を付けた局がありません」。直近 8 週の線は出し、成績の欄は空', async () => {
    const { user } = setup(onlyThisWeek());
    await openWeek(user);
    await user.click(prevButton());
    expect(range()).toBe('9月28日（月）〜10月4日（日）');
    expect(tiles()).toEqual(['解いた問題0問出題 0・解き直し 0', '正解率—まだ答えがありません', '迷いマーク0', '半荘0']);
    expect(screen.getAllByText('この週は、答えた問題がありません。')).toHaveLength(2);
    expect(screen.getByText('この週は、評価を付けた局がありません。')).toBeInTheDocument();
    expect(document.querySelector('figure[data-fig="bars"]')).toBeNull();
    expect(document.querySelector('.wk-tbl')).toBeNull();
    // 直近 8 週の推移は、5 つの線をそのまま出す（今週の帯だけ。点は無い）
    expect(within(figure('multi')).getAllByRole('group')).toHaveLength(5);
    expect(figure('multi').querySelectorAll('.dot.cur')).toHaveLength(0);
    expect(figure('multi').querySelectorAll('.band')).toHaveLength(5);
    for (const input of document.querySelectorAll<HTMLInputElement>('.wk-recc input')) expect(input.value).toBe('');
    // 説明のアイコン（差の原因・局面の種類）は、空の週には出さない
    expect(screen.queryByRole('button', { name: '差の原因の割合の説明' })).toBeNull();
    expect(screen.queryByRole('button', { name: '局面の種類の説明' })).toBeNull();
  });

  it('答えが 1 つも無く、半荘も無くても、今週の空の形で開ける（0 と —）', async () => {
    const { user } = setup({ sessions: [], answers: [] });
    await screen.findByText('半荘がありません', { selector: 'h1' }, LOAD);
    await user.click(screen.getByRole('button', { name: '週の集計' }));
    await screen.findByRole('heading', { level: 1, name: '週の集計' });
    await screen.findByRole('list', { name: '今週の数' }, LOAD);
    expect(tiles()[0]).toBe('解いた問題0問出題 0・解き直し 0');
    expect(screen.getAllByText('この週は、答えた問題がありません。')).toHaveLength(2);
    expect(range()).toBe('10月5日（月）〜10月11日（日）');
  });
});

describe('D-3 消した半荘（ごみ箱の中）の答えと半荘は、数えない', () => {
  it('半荘を消すと、その半荘の答え・迷いマーク・評価・半荘の数が、週の集計から外れる', async () => {
    const { user } = setup();
    await openWeek(user);
    expect(tiles()[0]).toBe('解いた問題4問出題 3・解き直し 1');
    await user.click(within(screen.getByRole('navigation', { name: '半荘の一覧' })).getByRole('button', { name: /19:09 の半荘のメニュー/ }));
    await user.click(screen.getByRole('menuitem', { name: '削除' }));
    await user.click(await screen.findByRole('button', { name: '削除' }));
    // 今週の答えは、f9da の 1 つ（解き直し）だけになる
    await waitFor(() => expect(tiles()[0]).toBe('解いた問題1問出題 0・解き直し 1'), LOAD);
    expect(tiles()[2]).toBe('迷いマーク0');
    expect(tiles()[3]).toBe('半荘0');
    expect(barRows()).toEqual([
      '受け入れ枚数100%（1局面）',
      '形の質0%（0局面）',
      '打点0%（0局面）',
      '守備0%（0局面）',
      'その他0%（0局面）',
    ]);
    // 評価（FX-4 の局）も外れる
    expect(screen.getByText('この週は、評価を付けた局がありません。')).toBeInTheDocument();
  });
});

describe('U-30 成績（手入力）と来週の重点: 入れて、保存して、開き直しても残る', () => {
  const field = (name: string) => screen.getByRole('textbox', { name });

  it('成績は 6 つの欄（4位率・放銃率・平均順位・和了率・副露率・立直率）。説明は説明のアイコンにある', async () => {
    const { user } = setup();
    await openWeek(user);
    const record = section('成績（手入力）');
    expect(within(record).getAllByRole('textbox').map((input) => input.getAttribute('id') && textOf(record.querySelector(`label[for="${input.id}"]`)))).toEqual([
      '4位率',
      '放銃率',
      '平均順位',
      '和了率',
      '副露率',
      '立直率',
    ]);
    expect(within(record).getByRole('button', { name: '成績の入れ方の説明' })).toHaveAccessibleDescription('雀魂の成績の画面を見て入れます。');
    expect(record.querySelector('.wk-note')).toBeNull();
    for (const input of within(record).getAllByRole('textbox')) {
      expect(input).toHaveAttribute('autocomplete', 'off');
      expect(input).toHaveAttribute('spellcheck', 'false');
    }
  });

  it('数を入れて欄を離れる（または Enter）と保存する。「保存しました」が出て、保存した形に整う（20 → 20.0）', async () => {
    const { user, study } = setup();
    await openWeek(user);
    await user.type(field('4位率'), '20.4');
    await user.tab();
    await screen.findByText('保存しました');
    expect(study.weeks.get('2026-10-05')).toEqual({ week: '2026-10-05', stats: { rank4: 20.4 }, focus: '' });
    await user.type(field('平均順位'), '２．４１{Enter}');
    await waitFor(() => expect(study.weeks.get('2026-10-05')?.stats).toEqual({ rank4: 20.4, avg: 2.41 }), LOAD);
    await user.type(field('和了率'), '22');
    await user.tab();
    await waitFor(() => expect(study.weeks.get('2026-10-05')?.stats.win).toBe(22), LOAD);
    expect(field('和了率')).toHaveValue('22.0');
    expect(field('平均順位')).toHaveValue('2.41');
    // 入力が始まると「保存しました」は消える
    await user.type(field('副露率'), '3');
    expect(screen.queryByText('保存しました')).toBeNull();
  });

  it('数でない・範囲の外は、理由を出して保存しない。直すと、理由は消えて保存される', async () => {
    const { user, study } = setup();
    await openWeek(user);
    await user.type(field('4位率'), '101');
    await user.tab();
    const alert = await screen.findByRole('alert');
    expect(alert).toHaveTextContent('4位率は、0 から 100 の数で入れてください');
    expect(field('4位率')).toHaveAttribute('aria-invalid', 'true');
    expect(field('4位率')).toHaveAccessibleDescription('4位率は、0 から 100 の数で入れてください');
    expect(study.weekCalls).toEqual([]);
    await user.clear(field('4位率'));
    await user.type(field('4位率'), 'abc');
    await user.tab();
    expect(await screen.findByRole('alert')).toHaveTextContent('4位率は、数で入れてください（小数は 2 桁まで）');
    await user.clear(field('4位率'));
    await user.type(field('4位率'), '18.5');
    await user.tab();
    await waitFor(() => expect(screen.queryByRole('alert')).toBeNull());
    expect(study.weeks.get('2026-10-05')?.stats.rank4).toBe(18.5);
    await user.type(field('平均順位'), '4.5');
    await user.tab();
    expect(await screen.findByRole('alert')).toHaveTextContent('平均順位は、1 から 4 の数で入れてください');
    expect(study.weekCalls).toHaveLength(1);
  });

  it('保存できなかったときは、理由を出す（入れた文字は残る）。ほかの欄の保存は、続けられる', async () => {
    const { user, study } = setup();
    await openWeek(user);
    study.failNextWeek = '保存先がいっぱいです';
    await user.type(field('4位率'), '20');
    await user.tab();
    expect(await screen.findByRole('alert')).toHaveTextContent('保存先がいっぱいです');
    expect(field('4位率')).toHaveValue('20');
    expect(screen.queryByText('保存しました')).toBeNull();
    await user.type(field('放銃率'), '11.6');
    await user.tab();
    await waitFor(() => expect(study.weeks.get('2026-10-05')?.stats).toEqual({ deal: 11.6 }), LOAD);
  });

  it('欄を空にすると、その成績を消す。成績も重点も空になると、その週の記録ごと消える', async () => {
    const { user, study } = setup();
    await openWeek(user);
    await user.type(field('4位率'), '20');
    await user.tab();
    await waitFor(() => expect(study.weeks.size).toBe(1), LOAD);
    await user.clear(field('4位率'));
    await user.tab();
    await waitFor(() => expect(study.weeks.size).toBe(0), LOAD);
  });

  it('開き直しても、入れた成績と重点が残る（保存した記録から、欄に入る）', async () => {
    const first = setup();
    await openWeek(first.user);
    await first.user.type(field('4位率'), '20.4');
    await first.user.tab();
    await first.user.type(field('平均順位'), '2.41');
    await first.user.tab();
    await first.user.type(screen.getByRole('textbox', { name: '来週の重点（任意。1〜3行）' }), '受け入れを数える。{Enter}鳴く前に打点を確認する。');
    await first.user.tab();
    await waitFor(() => expect(first.study.weeks.get('2026-10-05')?.focus).toBe('受け入れを数える。\n鳴く前に打点を確認する。'), LOAD);
    cleanup();

    // 同じ保存先（偽物）で、アプリを開き直す
    const store = new FakeSessionStore([{ session: fx4(), report: 'fx4' }, fx1a()]);
    installTauriMock({ handlers: { ...store.handlers, ...first.study.handlers } });
    const user = userEvent.setup();
    render(<App />);
    await openWeek(user);
    await waitFor(() => expect(field('4位率')).toHaveValue('20.4'), LOAD);
    expect(field('平均順位')).toHaveValue('2.41');
    expect(field('和了率')).toHaveValue('');
    expect(screen.getByRole('textbox', { name: '来週の重点（任意。1〜3行）' })).toHaveValue('受け入れを数える。\n鳴く前に打点を確認する。');
    // 成績の小さな線に、入れた値が出る（今週の点と吹き出し）
    const plot = within(section('成績（手入力）')).getByRole('group', { name: '4位率（直近8週）（矢印キーで週を選ぶ）' });
    act(() => plot.focus());
    expect(tipText()).toBe('20.4% | 4位率・10月5日の週');
    // 表で見ると、同じ値
    await user.click(within(figure('rec')).getByRole('button', { name: '表で見る' }));
    const last = within(figure('rec')).getAllByRole('row')[8] as HTMLElement;
    expect([...last.children].map((c) => textOf(c))).toEqual(['10/5の週', '20.4%', '—', '2.41位', '—', '—', '—']);
    // 表を見ている間も、入力欄は残る
    expect(field('4位率')).toHaveValue('20.4');
  });

  it('重点は 1〜3 行（任意）。4 行は断る。保存は欄を離れたとき。空にすると、書いていないことになる', async () => {
    const { user, study } = setup();
    await openWeek(user);
    const focus = () => screen.getByRole('textbox', { name: '来週の重点（任意。1〜3行）' });
    await user.type(focus(), 'a{Enter}b{Enter}c{Enter}d');
    await user.tab();
    expect(await screen.findByRole('alert')).toHaveTextContent('重点は 3 行までです');
    expect(study.weekCalls).toEqual([]);
    await user.clear(focus());
    await user.type(focus(), 'a{Enter}{Enter}  b  {Enter}c');
    await user.tab();
    await waitFor(() => expect(study.weeks.get('2026-10-05')?.focus).toBe('a\nb\nc'), LOAD);
    expect(focus()).toHaveValue('a\nb\nc');
    await user.clear(focus());
    await user.tab();
    await waitFor(() => expect(study.weeks.size).toBe(0), LOAD);
  });

  it('先週に書いた重点が、来週の重点の欄の上に出る（先週に何も書いていなければ出ない）', async () => {
    const { user, study } = setup();
    await openWeek(user);
    expect(screen.queryByText('先週に書いた重点')).toBeNull();
    // 先週（9/28 の週）の重点を書く
    await user.click(prevButton());
    await user.type(screen.getByRole('textbox', { name: '来週の重点（任意。1〜3行）' }), '押し引きは、リーチの現物から探す。');
    await user.tab();
    await waitFor(() => expect(study.weeks.get('2026-09-28')?.focus).toBe('押し引きは、リーチの現物から探す。'), LOAD);
    expect(screen.queryByText('先週に書いた重点')).toBeNull();
    await user.click(nextButton());
    const prev = screen.getByText('先週に書いた重点').closest('.wk-prev') as HTMLElement;
    expect(textOf(prev)).toBe('先週に書いた重点押し引きは、リーチの現物から探す。');
    // 来週の重点の欄は、今週のぶん（空）で、先週の重点は、その上にある
    const field2 = screen.getByRole('textbox', { name: '来週の重点（任意。1〜3行）' });
    expect(field2).toHaveValue('');
    expect(prev.compareDocumentPosition(field2) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy();
  });

  it('成績・重点が読めなかったときは、理由を出し、入力欄は出さない（読めていない値を、空の欄から上書きしないため）', async () => {
    const { user } = setup({
      handlers: {
        list_weeks: () => {
          throw 'ファイルを開けません';
        },
      },
    });
    await openWeek(user);
    expect(await screen.findByText(/成績と重点を読めませんでした: ファイルを開けません/)).toBeInTheDocument();
    expect(screen.queryByRole('textbox', { name: '4位率' })).toBeNull();
    expect(screen.queryByRole('textbox', { name: '来週の重点（任意。1〜3行）' })).toBeNull();
  });
});

describe('R11-1 操作の説明の文は、本文に出さず、説明のアイコン（i）に載せる', () => {
  it('週の集計の説明（差の原因・局面の種類・局の評価・成績の入れ方）は、どれも見出しのそばの説明のアイコン。本文の段落には無い', async () => {
    const { user } = setup();
    await openWeek(user);
    for (const label of ['差の原因の割合の説明', '局面の種類の説明', '一致率とずれの説明', '成績の入れ方の説明']) {
      expect(screen.getByRole('button', { name: label }), label).toBeInTheDocument();
    }
    expect(document.querySelectorAll('.wk-note.quiet')).toHaveLength(0);
    // 本文（説明の重なり以外）に、説明の文は出ない
    const page = document.querySelector('.page') as HTMLElement;
    expect(textOf(page)).not.toContain('1つの局面に原因が2つ付くと');
    expect(textOf(page)).not.toContain('雀魂の成績の画面を見て入れます');
    expect(textOf(page)).not.toContain('種類は重なります');
    expect(textOf(page)).not.toContain('〇を3・△を2・✕を1として');
  });
});
