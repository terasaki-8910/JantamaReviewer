/**
 * 通して見る画面の「解決」（F16。ACCEPTANCE の U-41・E-45）と、細かいミス・拮抗の場面（F17。U-42）の画面の試験。
 * アプリ全体（App）を、半荘の保存先の偽物と、答えの記録の偽物の上で動かして、使う人と同じ操作で確かめる。
 * 実ブラウザでの見え方（横スクロール・axe・段の高さ）は、tests/browser/replay.browser.test.ts が確かめる。
 */
import { DEFAULT_CONTEST_OPTIONS, buildReplayTimeline, findDecisionByKey, listReplayScenes, type ContestOptions } from '@jantama/engine';
import { act, fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { FakeSessionStore, local, seedSession } from '../../../tests/fake-sessions';
import { FakeStudyStore, gameOf } from '../../../tests/fake-study';
import { fx4Ocr, fx4Session } from '../../../tests/import-fixtures';
import { revealed } from '../../../tests/reveal';
import { baseSettings, installTauriMock } from '../../../tests/tauri-mock';
import type { Links, Settings } from '../../api/types';
import { App } from '../App';
import { FINE_MISS_ONLY_KEY } from './useFineMissOnly';

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
  window.localStorage.clear();
});

afterEach(() => {
  vi.useRealTimers();
  window.localStorage.clear();
});

const FX4_ID = '20261009-190953';
const FX1A_ID = '20261009-171200';
const LOAD = { timeout: 20_000 };
const RESOLVED_AT = 1_760_000_000_000;

/** ユーザーが本物のデータで選び直した迷いの結びつけ（ACCEPTANCE E-17・E-27）。 */
const USER_LINKS: Links = {
  ratings: {},
  marks: { '1': 'k0h0e4', '2': 'k1h0e12', '3': 'k1h1e7', '4': 'k1h1e10', '5': 'k2h1e6', '6': 'k2h1e14' },
};
/** 迷い 1〜6 の順の判断の鍵。 */
const MARK_KEYS = Object.values(USER_LINKS.marks);
/** 迷いの場面（迷い 2 だけが細かいミス）。半荘の順。 */
const DOUBTS = ['k0h0e4', 'k1h0e12', 'k1h1e7', 'k1h1e10', 'k2h1e6', 'k2h1e14'];

/** 差 100 ポイント・1 巡目以降: 2 つ以上の候補がある判断は、すべて拮抗の場面になる（数を増やして確かめるため）。 */
const WIDE: Partial<Settings> = { contest_enabled: true, contest_gap_percent: 100, contest_min_junme: 1 };
const WIDE_OPTIONS: ContestOptions = { ...DEFAULT_CONTEST_OPTIONS, maxGap: 1, minJunme: 1 };

const fx4 = gameOf('fx4');
const timeline = buildReplayTimeline(fx4);
const stepOf = (key: string): number => {
  const decision = findDecisionByKey(fx4, key);
  if (decision === undefined) throw new Error(key);
  return timeline.stepOfDecision.get(decision.index) as number;
};
const posAt = (g: number): string => {
  const step = timeline.steps[g]!;
  return `手 ${step.position + 1} / ${timeline.kyokus[step.kyokuPosition]!.steps.length}`;
};
/** エンジンが数えた、拮抗の場面の鍵（半荘の順）。 */
const contestKeys = (options: ContestOptions): string[] =>
  listReplayScenes(timeline, fx4.decisions, { markKeys: MARK_KEYS, threshold: 0.05, includeAll: false, contest: options })
    .filter((scene) => scene.contest !== null)
    .map((scene) => scene.key);

interface SetupOptions {
  study?: FakeStudyStore;
  settings?: Partial<Settings>;
  /** 最初から解決している FX-4 の判断の鍵。 */
  resolved?: readonly string[];
}

function setup(options: SetupOptions = {}) {
  const fx4Seed = {
    session: fx4Session(FX4_ID, local(2026, 10, 9, 19, 9), {
      report_path: `C:\\data\\games\\${FX4_ID}\\report.json`,
      ocr: fx4Ocr(),
      links: USER_LINKS,
      resolved: { decisions: Object.fromEntries((options.resolved ?? []).map((key) => [key, RESOLVED_AT])) },
    }),
    report: 'fx4' as const,
  };
  const sessions = new FakeSessionStore([fx4Seed, seedSession(local(2026, 10, 9, 17, 12), { id: FX1A_ID, report: 'fx1a' })]);
  const study = options.study ?? new FakeStudyStore();
  const mock = installTauriMock({
    settings: { ...baseSettings, ...options.settings },
    handlers: { ...sessions.handlers, ...study.handlers },
  });
  const user = userEvent.setup();
  const view = render(<App />);
  return { user, mock, sessions, study, view };
}

const sideButton = (name: RegExp) => within(screen.getByRole('navigation', { name: 'メイン' })).getByRole('button', { name });
const sideCount = (name: RegExp) => sideButton(name).querySelector('.count')?.textContent ?? null;

async function loaded(count: string | null = '5') {
  await screen.findByRole('navigation', { name: '半荘の一覧' });
  await waitFor(() => expect(sideCount(/^今日の出題/)).toBe(count), LOAD);
}

async function openReplay(user: ReturnType<typeof userEvent.setup>) {
  await user.click(await screen.findByRole('button', { name: 'この半荘を通して見る' }));
  await screen.findByRole('region', { name: '半荘を進める' });
}

const title = () => screen.getByRole('heading', { level: 1 }).textContent ?? '';
const pos = () => (document.getElementById('pos')?.textContent ?? '').replace(/\s+/g, ' ').trim();
const chips = () => [...document.querySelectorAll('.q-chips .q-chip')].map((chip) => chip.textContent);
const sceneRows = () => [...document.querySelectorAll<HTMLElement>('.sc-row')];
const sceneRow = (key: string) => document.querySelector<HTMLElement>(`.sc-row[data-key="${key}"]`) as HTMLElement;
const pin = (key: string, kind: 'dbt' | 'mis' | 'cst') => document.querySelector<HTMLElement>(`.pin.${kind}[data-key="${key}"]`);
const group = (kind: 'mismatch' | 'doubt' | 'contest') => document.querySelector<HTMLElement>(`.jump[data-kind="${kind}"]`) as HTMLElement;
const jumpButton = (kind: 'mismatch' | 'doubt' | 'contest', which: 'prev' | 'next') =>
  within(group(kind)).getByRole('button', { name: which === 'prev' ? /^前の/ : /^次の/ });
const resolveButton = () => screen.getByRole('button', { name: '解決' });
const answeringState = () => document.querySelector('.qz')?.getAttribute('data-state');

function press(init: { code: string; key?: string; shiftKey?: boolean }) {
  const target = document.activeElement ?? document.body;
  act(() => {
    fireEvent.keyDown(target, { key: init.key ?? init.code, ...init });
  });
}

describe('U-41 通して見る画面の「解決」', () => {
  it('場面に着くと、答えの欄の上の段の先頭に「解決」。答える前は次へ進むボタンが無く、AI の情報も無い。押すと入り、次の場面へのボタンが出る', async () => {
    const { user, sessions } = setup();
    await loaded();
    await openReplay(user);
    // 場面にいない手には、答えの欄が無いので「解決」も無い
    expect(screen.queryByRole('button', { name: '解決' })).toBeNull();
    await user.click(sceneRow('k1h1e7'));
    expect(pos()).toBe(posAt(stepOf('k1h1e7')));
    const bar = document.querySelector('.answer-bar') as HTMLElement;
    expect(bar.firstElementChild).toBe(resolveButton());
    expect(resolveButton()).toHaveAttribute('aria-pressed', 'false');
    expect(screen.queryByRole('button', { name: '次の場面へ' })).toBeNull();
    expect(document.querySelector('[data-ai]')).toBeNull();
    expect(document.body.textContent).not.toMatch(/\d\s*%|Mortal|AIの評価/);
    await user.click(resolveButton());
    await waitFor(() => expect(resolveButton()).toHaveAttribute('aria-pressed', 'true'));
    expect(resolveButton()).toHaveTextContent(/^解決$/);
    expect(resolveButton().querySelector('.ic')).not.toBeNull();
    expect(screen.getByRole('button', { name: '次の場面へ' })).toBeInTheDocument();
    expect(answeringState()).toBe('answering');
    expect(sessions.resolveCalls).toEqual([`on:${FX4_ID}:k1h1e7`]);
    // 位置の帯の印と場面の一覧の行は、薄くなる（印は押せる）
    expect(pin('k1h1e7', 'dbt')).toHaveAttribute('data-resolved', '1');
    expect(pin('k1h1e7', 'dbt')?.getAttribute('aria-label')).toBe('迷い3 東2局1本場 6巡目 打牌（解決）');
    expect(pin('k1h0e12', 'dbt')).toHaveAttribute('data-resolved', '0');
    // もう一度押すと元に戻る
    await user.click(resolveButton());
    await waitFor(() => expect(resolveButton()).toHaveAttribute('aria-pressed', 'false'));
    expect(screen.queryByRole('button', { name: '次の場面へ' })).toBeNull();
    expect(pin('k1h1e7', 'dbt')).toHaveAttribute('data-resolved', '0');
  });

  it('解決した場面は、場面の一覧に「解決」の印つきで残る。位置の帯の印も、一覧の行も、押すと開く', async () => {
    const { user } = setup({ resolved: ['k1h1e7'] });
    await loaded();
    await openReplay(user);
    const row = sceneRow('k1h1e7');
    expect(row).toHaveAttribute('data-resolved', '1');
    expect(row.querySelector('.sc-st.resolved')?.textContent).toBe('解決');
    expect(row.querySelector('.sc-sub')?.textContent).toBe('打牌 · 2向聴 · 未解答 · 解決');
    expect(sceneRow('k1h0e12')).toHaveAttribute('data-resolved', '0');
    expect(sceneRow('k1h0e12').querySelector('.sc-st.resolved')).toBeNull();
    expect(sceneRows()).toHaveLength(10);
    await user.click(row);
    expect(pos()).toBe(posAt(stepOf('k1h1e7')));
    expect(resolveButton()).toHaveAttribute('aria-pressed', 'true');
    // 位置の帯の印から開く
    await user.click(pin('k1h0e12', 'dbt') as HTMLElement);
    await user.click(pin('k1h1e7', 'dbt') as HTMLElement);
    expect(pos()).toBe(posAt(stepOf('k1h1e7')));
    expect(pin('k1h1e7', 'dbt')).toHaveAttribute('aria-current', 'true');
  });

  it('前・次の迷い・不一致と、キー（Shift+↑ ↓、↑ ↓）は、解決した場面で止まらない。数と「あと N か所」からも除く', async () => {
    const { user } = setup({ resolved: ['k1h1e7', 'k1h1e6'] });
    await loaded();
    await openReplay(user);
    // 迷い 6 か所のうち、迷い 3 を解決: 5 か所。大きな不一致 5 か所のうち、東2局1本場 5巡目を解決: 4 か所
    expect(group('doubt')).toHaveTextContent('自分の迷い 5か所');
    expect(group('mismatch')).toHaveTextContent('大きな不一致 4か所');
    expect(jumpButton('doubt', 'next').querySelector('.jc')?.textContent).toBe('5');
    expect(jumpButton('mismatch', 'next').querySelector('.jc')?.textContent).toBe('4');
    const want = ['k0h0e4', 'k1h0e12', 'k1h1e10', 'k2h1e6', 'k2h1e14'];
    for (const [index, key] of want.entries()) {
      expect(jumpButton('doubt', 'next').querySelector('.jc')?.textContent).toBe(String(5 - index));
      await user.click(jumpButton('doubt', 'next'));
      expect(pos()).toBe(posAt(stepOf(key)));
    }
    expect(jumpButton('doubt', 'next')).toBeDisabled();
    // 前へ戻っても、解決した場面（迷い 3）では止まらない: 迷い 6 → 5 → 4 のあと、迷い 3 を飛ばして迷い 2
    await user.click(jumpButton('doubt', 'prev'));
    await user.click(jumpButton('doubt', 'prev'));
    expect(pos()).toBe(posAt(stepOf('k1h1e10')));
    await user.click(jumpButton('doubt', 'prev'));
    expect(pos()).toBe(posAt(stepOf('k1h0e12')));
    // 不一致: ↓ で、解決していない 4 か所を順に（半荘の順。迷い 2 の場面も不一致）
    press({ code: 'Home', key: 'Home' });
    const seen: string[] = [];
    for (let i = 0; i < 4; i += 1) {
      press({ code: 'ArrowDown' });
      seen.push(pos());
    }
    expect(seen).toEqual(['k1h0e12', 'k1h1e9', 'k2h1e2', 'k2h1e16'].map((key) => posAt(stepOf(key))));
    const before = pos();
    press({ code: 'ArrowDown' });
    expect(pos()).toBe(before);
  });

  it('「次の場面へ」は、解決した場面を飛ばす。解決を入れた直後にも押せる', async () => {
    const { user } = setup({ resolved: ['k1h1e7'] });
    await loaded();
    await openReplay(user);
    // 東2局1本場 5巡目（不一致）に着いて、解決を入れ、「次の場面へ」を押す。次は 6巡目（迷い 3）だが、解決しているので、8巡目へ
    await user.click(sceneRow('k1h1e6'));
    await user.click(resolveButton());
    await waitFor(() => expect(resolveButton()).toHaveAttribute('aria-pressed', 'true'));
    await user.click(screen.getByRole('button', { name: '次の場面へ' }));
    expect(pos()).toBe(posAt(stepOf('k1h1e9')));
    expect(title()).toBe('東2局1本場 8巡目');
    expect(resolveButton()).toHaveAttribute('aria-pressed', 'false');
  });

  it('Ctrl+Z で、場面の解決が戻る（取り消しの履歴）。位置の帯の印も元に戻る', async () => {
    const { user } = setup();
    await loaded();
    await openReplay(user);
    await user.click(sceneRow('k2h1e6'));
    await user.click(resolveButton());
    await waitFor(() => expect(pin('k2h1e6', 'dbt')).toHaveAttribute('data-resolved', '1'));
    expect(group('doubt')).toHaveTextContent('自分の迷い 5か所');
    await user.keyboard('{Control>}z{/Control}');
    await waitFor(() => expect(pin('k2h1e6', 'dbt')).toHaveAttribute('data-resolved', '0'));
    expect(group('doubt')).toHaveTextContent('自分の迷い 6か所');
    expect(resolveButton()).toHaveAttribute('aria-pressed', 'false');
    await user.keyboard('{Control>}y{/Control}');
    await waitFor(() => expect(resolveButton()).toHaveAttribute('aria-pressed', 'true'));
  });

  it('局の選択の数に、解決した場面の数が出る（解決した場面は、迷いなどの数から除く）', async () => {
    const { user } = setup({ resolved: ['k1h1e7'] });
    await loaded();
    await openReplay(user);
    await user.click(screen.getByRole('button', { name: /^局を選ぶ/ }));
    const items = within(screen.getByRole('menu', { name: '局を選ぶ' })).getAllByRole('menuitemradio');
    expect(items.map((item) => item.querySelector('.pi-r')?.textContent ?? '')).toEqual([
      '迷い1',
      '迷い1 · 細かいミス1 · 不一致1',
      // 東2局1本場: 迷い 3（解決）・迷い 4・不一致 2 → 迷い 1、不一致 2、解決 1
      '迷い1 · 不一致2 · 解決1',
      '',
      '迷い2 · 不一致2',
    ]);
  });
});

describe('U-42 細かいミスの迷いの印と「細かいミスだけ」', () => {
  it('迷いの印は丸。細かいミス（迷い 2）だけ四角。名前にも「細かいミス」が入る', async () => {
    const { user } = setup();
    await loaded();
    await openReplay(user);
    expect(document.querySelectorAll('.tl-pins.up .pin.dbt')).toHaveLength(6);
    expect([...document.querySelectorAll('.pin.dbt.sq')].map((p) => p.getAttribute('data-key'))).toEqual(['k1h0e12']);
    expect(pin('k1h0e12', 'dbt')?.getAttribute('aria-label')).toBe('迷い2（細かいミス） 東2局 11巡目 打牌（大きな不一致でもある）');
    expect(pin('k0h0e4', 'dbt')?.getAttribute('aria-label')).toBe('迷い1 東1局 4巡目 打牌');
    // 答える前から分かる。場面の一覧にも札が出て、場面に着いた見出しにも札が出る（AI の情報は無い）
    expect(sceneRow('k1h0e12').querySelector('.sc-tags')?.textContent).toBe('迷い2細かいミス大きな不一致');
    await user.click(pin('k1h0e12', 'dbt') as HTMLElement);
    expect(chips()).toEqual(['1向聴', '実戦：打8p', '迷い2', '細かいミス', '大きな不一致']);
    expect(document.querySelector('[data-ai]')).toBeNull();
  });

  it('迷いの段に「細かいミスだけ」の切り替え（既定は切）。入れると、前・次の迷いと迷いの数が、細かいミスだけになる', async () => {
    const { user } = setup();
    await loaded();
    await openReplay(user);
    const toggle = () => within(group('doubt')).getByRole('button', { name: '細かいミスだけ' });
    expect(toggle()).toHaveAttribute('aria-pressed', 'false');
    expect(toggle().querySelector('.ic')).toBeNull();
    expect(group('doubt')).toHaveTextContent('自分の迷い 6か所');
    expect(window.localStorage.getItem(FINE_MISS_ONLY_KEY)).toBeNull();
    expect(sceneRows()).toHaveLength(10);
    await user.click(toggle());
    expect(toggle()).toHaveAttribute('aria-pressed', 'true');
    expect(toggle().querySelector('.ic')).not.toBeNull();
    expect(group('doubt')).toHaveTextContent('自分の迷い 1か所');
    expect(jumpButton('doubt', 'next').querySelector('.jc')?.textContent).toBe('1');
    expect(window.localStorage.getItem(FINE_MISS_ONLY_KEY)).toBe('1');
    // 次の迷いは、細かいミスの場面（迷い 2）にだけ止まる。そのあとは無い。前も無い
    await user.click(jumpButton('doubt', 'next'));
    expect(pos()).toBe(posAt(stepOf('k1h0e12')));
    expect(jumpButton('doubt', 'next')).toBeDisabled();
    expect(jumpButton('doubt', 'prev')).toBeDisabled();
    // キー（Shift+↑ ↓）も同じ
    press({ code: 'Home', key: 'Home' });
    press({ code: 'ArrowDown', shiftKey: true });
    expect(pos()).toBe(posAt(stepOf('k1h0e12')));
    press({ code: 'ArrowDown', shiftKey: true });
    expect(pos()).toBe(posAt(stepOf('k1h0e12')));
    // ほかの迷いの印は、そのまま（止まらないだけ）
    expect(document.querySelectorAll('.tl-pins.up .pin.dbt')).toHaveLength(6);
    // 切に戻すと、6 か所
    await user.click(toggle());
    expect(toggle()).toHaveAttribute('aria-pressed', 'false');
    expect(group('doubt')).toHaveTextContent('自分の迷い 6か所');
    expect(window.localStorage.getItem(FINE_MISS_ONLY_KEY)).toBe('0');
  });

  it('切り替えは、覚えておく（開き直しても入のまま）。保存領域が使えなくても、動く', async () => {
    window.localStorage.setItem(FINE_MISS_ONLY_KEY, '1');
    const first = setup();
    await loaded();
    await openReplay(first.user);
    expect(within(group('doubt')).getByRole('button', { name: '細かいミスだけ' })).toHaveAttribute('aria-pressed', 'true');
    expect(group('doubt')).toHaveTextContent('自分の迷い 1か所');
    first.view.unmount();
    // 読み書きできない保存領域でも、画面は動く（切のまま。押すと入る）
    const getItem = vi.spyOn(Storage.prototype, 'getItem').mockImplementation(() => {
      throw new Error('使えません');
    });
    const setItem = vi.spyOn(Storage.prototype, 'setItem').mockImplementation(() => {
      throw new Error('使えません');
    });
    try {
      const second = setup();
      await loaded();
      await openReplay(second.user);
      const toggle = within(group('doubt')).getByRole('button', { name: '細かいミスだけ' });
      expect(toggle).toHaveAttribute('aria-pressed', 'false');
      await second.user.click(toggle);
      expect(toggle).toHaveAttribute('aria-pressed', 'true');
      expect(group('doubt')).toHaveTextContent('自分の迷い 1か所');
    } finally {
      getItem.mockRestore();
      setItem.mockRestore();
    }
  });

  it('解決した細かいミスは、「細かいミスだけ」でも止まらない（0 か所）', async () => {
    window.localStorage.setItem(FINE_MISS_ONLY_KEY, '1');
    const { user } = setup({ resolved: ['k1h0e12'] });
    await loaded();
    await openReplay(user);
    expect(group('doubt')).toHaveTextContent('自分の迷い 0か所');
    expect(jumpButton('doubt', 'next')).toBeDisabled();
  });
});

describe('U-42 拮抗の場面', () => {
  it('切（試験の見本）: 拮抗の段そのものを出さない。印も札も無い。段は、不一致と迷いの 2 つ', async () => {
    const { user } = setup();
    await loaded();
    await openReplay(user);
    expect(document.querySelector('.jump[data-kind="contest"]')).toBeNull();
    expect([...document.querySelectorAll('.pb-jumps .jump')].map((el) => el.getAttribute('data-kind'))).toEqual(['mismatch', 'doubt']);
    expect(screen.queryByRole('button', { name: /^次の拮抗へ/ })).toBeNull();
    expect(document.querySelectorAll('.pin.cst')).toHaveLength(0);
  });

  it('入: 段は、不一致・迷い・拮抗の順の 3 つ', async () => {
    const { user } = setup({ settings: WIDE });
    await loaded();
    await openReplay(user);
    expect([...document.querySelectorAll('.pb-jumps .jump')].map((el) => el.getAttribute('data-kind'))).toEqual(['mismatch', 'doubt', 'contest']);
  });

  it('入: 「拮抗 N か所」の段と前・次。印は帯の下の短い横棒（ひし形と同じ段）。次の拮抗へ ×N で順に開き、最後は押せない', async () => {
    const keys = contestKeys(WIDE_OPTIONS);
    expect(keys.length).toBeGreaterThan(20);
    const { user } = setup({ settings: WIDE });
    await loaded();
    await openReplay(user);
    expect(group('contest')).toHaveTextContent(`拮抗 ${keys.length}か所`);
    expect(group('contest').getAttribute('role')).toBe('group');
    expect(group('contest').getAttribute('aria-label')).toBe('拮抗の場面へ飛ぶ');
    expect(jumpButton('contest', 'next').querySelector('.jc')?.textContent).toBe(String(keys.length));
    // 印: 下の段に、横棒（.cst）。名前に「拮抗」
    expect(document.querySelectorAll('.tl-pins.down .pin.cst')).toHaveLength(keys.length);
    expect(document.querySelectorAll('.tl-pins.up .pin.cst')).toHaveLength(0);
    const first = pin(keys[0] as string, 'cst');
    expect(first?.getAttribute('aria-label')).toMatch(/^拮抗 .+局 \d+巡目 /);
    // 前・次を順に（先頭から 5 か所）
    for (const [index, key] of keys.slice(0, 5).entries()) {
      expect(jumpButton('contest', 'next').querySelector('.jc')?.textContent).toBe(String(keys.length - index));
      await user.click(jumpButton('contest', 'next'));
      expect(pos()).toBe(posAt(stepOf(key)));
      expect(answeringState()).toBe('answering');
      // 答える前に AI の情報は出さない（U-1）。見出しに「拮抗」
      expect(document.querySelector('[data-ai]')).toBeNull();
      expect(document.body.textContent).not.toMatch(/\d\s*%|Mortal|AIの評価/);
      expect(chips()).toContain('拮抗');
    }
    await user.click(jumpButton('contest', 'prev'));
    expect(pos()).toBe(posAt(stepOf(keys[3] as string)));
    // 最後まで進むと、次は押せない
    const last = keys[keys.length - 1] as string;
    await user.click(pin(last, 'cst') as HTMLElement);
    expect(jumpButton('contest', 'next')).toBeDisabled();
    expect(jumpButton('contest', 'next')).toHaveAttribute('title', 'これ以降の拮抗はありません');
  });

  it('キーは、既定では何も割り当てない。キーの一覧で割り当てると、そのキーで前・次の拮抗へ飛べる', async () => {
    const keys = contestKeys(WIDE_OPTIONS);
    const { user } = setup({ settings: WIDE });
    await loaded();
    await openReplay(user);
    press({ code: 'KeyJ', key: 'j' });
    expect(pos()).toBe('手 1 / 80');
    await user.click(screen.getByRole('button', { name: 'キーの一覧と割り当て' }));
    const dialog = screen.getByRole('dialog', { name: 'キーの一覧と割り当て' });
    const row = within(dialog).getByText('次の拮抗', { selector: '.kp-name' }).closest('li') as HTMLElement;
    expect(row.querySelector('.kp-key')?.textContent).toBe('なし');
    await user.click(within(row).getByRole('button', { name: '次の拮抗のキーを変更' }));
    await user.keyboard('j');
    await waitFor(() => expect(row.querySelector('.kp-key')?.textContent).toBe('J'));
    await user.click(within(dialog).getByRole('button', { name: '閉じる' }));
    press({ code: 'KeyJ', key: 'j' });
    expect(pos()).toBe(posAt(stepOf(keys[0] as string)));
  });

  it('「次の場面へ」も、拮抗の場面で止まる（迷いでも不一致でもない拮抗の場面）', async () => {
    const keys = contestKeys(WIDE_OPTIONS);
    const plain = new Set([...DOUBTS, 'k1h1e6', 'k1h1e9', 'k2h1e2', 'k2h1e16']);
    const onlyContest = keys.filter((key) => !plain.has(key));
    expect(onlyContest.length).toBeGreaterThan(5);
    const { user } = setup({ settings: WIDE });
    await loaded();
    await openReplay(user);
    await user.click(pin(onlyContest[0] as string, 'cst') as HTMLElement);
    // 答えて、「次の場面へ」。次の場面は、半荘の順の次（迷いでも不一致でも拮抗でも）
    await screen.findByLabelText('理由（1行）');
    await user.click(screen.getAllByRole('button', { name: /を切る$/ })[0] as HTMLElement);
    await user.type(screen.getByLabelText('理由（1行）'), '拮抗');
    await user.click(screen.getByRole('button', { name: '答え合わせ' }));
    await revealed();
    await user.click(screen.getByRole('button', { name: '次の場面へ' }));
    const scenes = listReplayScenes(timeline, fx4.decisions, { markKeys: MARK_KEYS, threshold: 0.05, includeAll: false, contest: WIDE_OPTIONS });
    const here = stepOf(onlyContest[0] as string);
    const next = scenes.find((scene) => scene.step > here);
    expect(pos()).toBe(posAt(next?.step ?? -1));
  });

  it('場面の一覧と局の選択に、拮抗が出る（「迷い1 · 拮抗2」の形）。札は「拮抗」', async () => {
    const keys = contestKeys(WIDE_OPTIONS);
    const { user } = setup({ settings: WIDE });
    await loaded();
    await openReplay(user);
    const tagsOf = (key: string) => [...sceneRow(key).querySelectorAll('.tag')].map((tag) => tag.textContent);
    expect(tagsOf(keys[0] as string)).toContain('拮抗');
    expect(sceneRows().length).toBeGreaterThan(20);
    await user.click(screen.getByRole('button', { name: /^局を選ぶ/ }));
    const hints = within(screen.getByRole('menu', { name: '局を選ぶ' }))
      .getAllByRole('menuitemradio')
      .map((item) => item.querySelector('.pi-r')?.textContent ?? '');
    expect(hints[0]).toMatch(/^迷い1 · .*拮抗\d+$/);
    expect(hints.every((hint) => hint.includes('拮抗'))).toBe(true);
  });

  it('設定を変えると、拮抗の場面の数が変わる（差の値・条件の入切・巡目・出す／出さない）', async () => {
    const { user, mock } = setup();
    await loaded();
    await openReplay(user);
    const settings = (patch: Partial<Settings>): Settings => ({ ...baseSettings, ...patch });
    const countOf = () => {
      const el = document.querySelector('.jump[data-kind="contest"]');
      return el === null ? 0 : Number(/(\d+)か所/.exec(el.textContent ?? '')?.[1]);
    };
    const emit = async (patch: Partial<Settings>) => {
      act(() => mock.emit('settings-changed', settings(patch)));
    };
    expect(countOf()).toBe(0);
    // 出す + 差 100 ポイント + 1 巡目以降: エンジンが数えた数
    await emit(WIDE);
    await waitFor(() => expect(countOf()).toBe(contestKeys(WIDE_OPTIONS).length));
    // 差を小さくすると、減る
    const narrow = { ...WIDE_OPTIONS, maxGap: 0.5 };
    await emit({ ...WIDE, contest_gap_percent: 50 });
    await waitFor(() => expect(countOf()).toBe(contestKeys(narrow).length));
    expect(contestKeys(narrow).length).toBeLessThan(contestKeys(WIDE_OPTIONS).length);
    // 巡目を上げると、さらに減る（12 巡目以降 + 他家のリーチ・2 副露）
    const late = { ...narrow, minJunme: 12 };
    await emit({ ...WIDE, contest_gap_percent: 50, contest_min_junme: 12 });
    await waitFor(() => expect(countOf()).toBe(contestKeys(late).length));
    // 3 つの条件を全部切ると、0 か所
    await emit({ ...WIDE, contest_by_junme: false, contest_after_riichi: false, contest_two_calls: false });
    await waitFor(() => expect(countOf()).toBe(0));
    // 出さない: 段そのものが消え、印も無い
    await emit({ ...WIDE, contest_enabled: false });
    await waitFor(() => expect(document.querySelector('.jump[data-kind="contest"]')).toBeNull());
    expect(document.querySelectorAll('.pin.cst')).toHaveLength(0);
  });

  it('今日の出題には、拮抗の問題が大きな不一致のあとに入る（出す設定のとき）。出さない設定では入らない', async () => {
    const { user } = setup({ settings: WIDE });
    await loaded('5');
    await user.click(sideButton(/^今日の出題/));
    await screen.findByRole('heading', { level: 1, name: '今日の出題' });
    const rest = within(document.querySelector('details.qrest') as HTMLElement).getByText(/^残り\d+問$/);
    // 迷い 5 + 大きな不一致（FX-4 の 4 + f9da の 19）= 28 のほかに、拮抗がある
    expect(Number(/\d+/.exec(rest.textContent ?? '')?.[0])).toBeGreaterThan(23);
  });
});
