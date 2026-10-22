/**
 * 半荘を通して見る画面（F12。ACCEPTANCE の U-21。場面での答えは U-1〜U-3・U-16、不一致の場面は E-26）の画面の試験。
 * アプリ全体（App）を、半荘の保存先の偽物と、答えの記録の偽物の上で動かして、使う人と同じ操作で確かめる。
 * 実ブラウザでの見え方（横スクロール・axe・描かれた色・キー・外への通信）は、tests/browser/replay.browser.test.ts が確かめる。
 */
import {
  buildReplayTimeline,
  decisionSteps,
  findDecisionByKey,
  nextKyokuStep,
  nextStepIn,
  openHandsAt,
  opponentTracksOf,
  prevStepIn,
  tileKind,
  tileLabel,
} from '@jantama/engine';
import { act, fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { FakeSessionStore, local, seedSession } from '../../../tests/fake-sessions';
import { FakeStudyStore, gameOf } from '../../../tests/fake-study';
import { fx4Ocr, fx4Session } from '../../../tests/import-fixtures';
import { baseSettings, installTauriMock } from '../../../tests/tauri-mock';
import { revealed } from '../../../tests/reveal';
import type { Links, Settings } from '../../api/types';
import { App } from '../App';
import { doraKinds } from '../study/dora';
import { defaultReplayKeys } from './keys';

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
});

afterEach(() => {
  vi.useRealTimers();
});

const FX4_ID = '20261009-190953';
const FX1A_ID = '20261009-171200';
const LOAD = { timeout: 20_000 };

/** ユーザーが本物のデータで選び直した迷いの結びつけ（ACCEPTANCE E-17・E-27）。迷い 6 は、東3局1本場 11巡目の打3m。 */
const USER_LINKS: Links = {
  ratings: {},
  marks: { '1': 'k0h0e4', '2': 'k1h0e12', '3': 'k1h1e7', '4': 'k1h1e10', '5': 'k2h1e6', '6': 'k2h1e14' },
};

/** FX-4（読み取りの写しつき）と、f9da。 */
function seeds(links?: Links) {
  const fx4 = {
    session: fx4Session(FX4_ID, local(2026, 10, 9, 19, 9), {
      report_path: `C:\\data\\games\\${FX4_ID}\\report.json`,
      ocr: fx4Ocr(),
      ...(links === undefined ? {} : { links }),
    }),
    report: 'fx4' as const,
  };
  return [fx4, seedSession(local(2026, 10, 9, 17, 12), { id: FX1A_ID, report: 'fx1a' })];
}

interface SetupOptions {
  study?: FakeStudyStore;
  settings?: Partial<Settings>;
  links?: Links;
  /** 取り込む前の半荘だけにする。 */
  unimported?: boolean;
}

/** 設定の保存の偽物（保存した設定を、次に読むときも返す。アプリを開き直しても残る）。 */
function settingsStore(initial: Settings) {
  let current = initial;
  let failure: string | null = null;
  return {
    get current() {
      return current;
    },
    /** 以降の保存を、この理由で失敗させる（null で元に戻す）。 */
    failWith(reason: string | null) {
      failure = reason;
    },
    handlers: {
      get_settings: () => current,
      set_settings: (args: unknown) => {
        if (failure !== null) throw failure;
        current = (args as { settings: Settings }).settings;
        return current;
      },
    } as Record<string, (args: unknown) => unknown>,
  };
}

function setup(options: SetupOptions = {}) {
  const sessions = new FakeSessionStore(
    options.unimported === true ? [seedSession(local(2026, 10, 9, 19, 9), { marks: 2 })] : seeds(options.links),
  );
  const study = options.study ?? new FakeStudyStore();
  const store = settingsStore({ ...baseSettings, ...options.settings });
  const mock = installTauriMock({ handlers: { ...sessions.handlers, ...study.handlers, ...store.handlers } });
  const user = userEvent.setup();
  const view = render(<App />);
  return { user, mock, sessions, study, store, view };
}

const sideButton = (name: RegExp) => within(screen.getByRole('navigation', { name: 'メイン' })).getByRole('button', { name });
const sideCount = (name: RegExp) => sideButton(name).querySelector('.count')?.textContent ?? null;

/** 出題のデータを読み終えて、サイドバーに数が出るまで待つ。 */
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
const nowText = () => document.querySelector('.now-t')?.textContent ?? '';
const sceneRows = () => [...document.querySelectorAll<HTMLElement>('.sc-row')];
const rest = () => document.querySelector('.scenes-n')?.textContent ?? '';
const reasonBox = () => screen.getByLabelText('理由（1行）');
const answeringState = () => document.querySelector('.qz')?.getAttribute('data-state');
/** 卓と手牌の牌（凡例の見本の牌は除く）。 */
const boardTiles = (selector: string) => [...document.querySelectorAll<HTMLElement>(selector)].filter((tile) => tile.closest('.legend') === null);

/** 押したキーを、いまキーボードの位置があるもの（無ければ body）に送る。 */
function press(init: { code: string; key?: string; shiftKey?: boolean; altKey?: boolean; ctrlKey?: boolean }) {
  const target = document.activeElement ?? document.body;
  let notPrevented = true;
  act(() => {
    notPrevented = fireEvent.keyDown(target, { key: init.key ?? init.code, ...init });
  });
  return notPrevented;
}
const COMMA = { code: 'Comma', key: ',' };
const PERIOD = { code: 'Period', key: '.' };
const arrow = (name: 'Left' | 'Right' | 'Up' | 'Down', shiftKey = false) => ({ code: `Arrow${name}`, key: `Arrow${name}`, shiftKey });

/** FX-4 の時間軸（場面の位置などを、画面と別に、エンジンから求める）。 */
const fx4 = gameOf('fx4');
const timeline = buildReplayTimeline(fx4);
const stepOf = (key: string): number => {
  const decision = findDecisionByKey(fx4, key);
  if (decision === undefined) throw new Error(key);
  return timeline.stepOfDecision.get(decision.index) as number;
};
const titleAt = (g: number): string => {
  const step = timeline.steps[g]!;
  return `${timeline.kyokus[step.kyokuPosition]!.label} ${step.junme > 0 ? `${step.junme}巡目` : '配牌'}`;
};
const posAt = (g: number): string => {
  const step = timeline.steps[g]!;
  return `手 ${step.position + 1} / ${timeline.kyokus[step.kyokuPosition]!.steps.length}`;
};

describe('U-21 入口: 半荘のページの「この半荘を通して見る」と、迷いのカードの「この局面を解く」', () => {
  it('結果を取り込んだ半荘の見出しに「この半荘を通して見る」。押すと、半荘の頭（東1局 配牌）から開く。サイドバーはその半荘に印', async () => {
    const { user } = setup();
    await loaded();
    const button = await screen.findByRole('button', { name: 'この半荘を通して見る' });
    expect(button.closest('.head-actions')).not.toBeNull();
    await user.click(button);
    expect(await screen.findByRole('heading', { level: 1, name: '東1局 配牌' })).toBeInTheDocument();
    expect(pos()).toBe('手 1 / 80');
    expect(nowText()).toBe('東1局が始まりました（親は自分）');
    const current = document.querySelector('.sessions [aria-current="true"]');
    expect(current?.textContent).toContain('19:09');
  });

  it('取り込む前の半荘には、「この半荘を通して見る」も「この局面を解く」も出ない', async () => {
    setup({ unimported: true });
    await screen.findByRole('navigation', { name: '半荘の一覧' });
    await screen.findByRole('heading', { level: 2, name: /迷い/ });
    expect(screen.queryByRole('button', { name: 'この半荘を通して見る' })).toBeNull();
    expect(screen.queryByRole('button', { name: /この局面を解く/ })).toBeNull();
  });

  it('迷いのカードの「この局面を解く」で、そのカードの局面が開く（推定のものも、選んだものも）。局面が決まっていないカードには無い', async () => {
    const { user } = setup();
    await loaded();
    // FX-4 の迷い 1〜5 は推定、迷い 6 は読めない（手で選ぶ）
    expect(screen.getAllByRole('button', { name: /^この局面を解く/ })).toHaveLength(5);
    expect(screen.queryByRole('button', { name: 'この局面を解く（迷い6）' })).toBeNull();
    await user.click(await screen.findByRole('button', { name: 'この局面を解く（迷い3）' }));
    expect(await screen.findByRole('heading', { level: 1, name: '東2局1本場 6巡目' })).toBeInTheDocument();
    expect(chips()).toEqual(['2向聴', '実戦：打南', '迷い3']);
    expect(pos()).toBe('手 30 / 48');
    // 答える前の画面（答えの欄が出ている）
    expect(answeringState()).toBe('answering');
    expect(screen.getByRole('button', { name: '答え合わせ' })).toBeDisabled();
  });

  it('ユーザーが選んだ局面（links.json）があれば、推定ではなく、それを開く（迷い 6 は、東3局1本場 11巡目）', async () => {
    const { user } = setup({ links: USER_LINKS });
    await loaded('5');
    expect(screen.getAllByRole('button', { name: /^この局面を解く/ })).toHaveLength(6);
    await user.click(await screen.findByRole('button', { name: 'この局面を解く（迷い6）' }));
    expect(await screen.findByRole('heading', { level: 1, name: '東3局1本場 11巡目' })).toBeInTheDocument();
    expect(chips()).toEqual(['1向聴', '実戦：打3m', '迷い6']);
    expect(pos()).toBe(posAt(stepOf('k2h1e14')));
  });

  it('← → と Alt+← / Alt+→ で、半荘のページと通して見る画面を行き来する', async () => {
    const { user } = setup();
    await loaded();
    await user.click(await screen.findByRole('button', { name: 'この局面を解く（迷い3）' }));
    await screen.findByRole('region', { name: '半荘を進める' });
    expect(sideButton(/^今日の出題/)).not.toHaveAttribute('aria-current');
    await user.keyboard('{Alt>}{ArrowLeft}{/Alt}');
    expect(await screen.findByRole('button', { name: 'この半荘を通して見る' })).toBeInTheDocument();
    expect(screen.queryByRole('region', { name: '半荘を進める' })).toBeNull();
    await user.click(screen.getByRole('button', { name: '進む' }));
    expect(await screen.findByRole('heading', { level: 1, name: '東2局1本場 6巡目' })).toBeInTheDocument();
    // Alt+← は、通して見る画面の中の「前の手」にはならない（キーの割り当ての対象外）。画面の履歴を戻す
    expect(pos()).toBe('手 30 / 48');
    press({ code: 'ArrowLeft', key: 'ArrowLeft', altKey: true });
    expect(await screen.findByRole('button', { name: 'この半荘を通して見る' })).toBeInTheDocument();
    // Alt+→ で、通して見る画面へ進む（最初に開いた局面から）
    press({ code: 'ArrowRight', key: 'ArrowRight', altKey: true });
    expect(await screen.findByRole('region', { name: '半荘を進める' })).toBeInTheDocument();
    expect(pos()).toBe('手 30 / 48');
  });
});

describe('U-21 手の進み方: 1 手・巡目・局の頭と終わり・局の選択', () => {
  it('局の頭は 手 1 / 80。「1手進む」「1手戻る」で 1 手ずつ動き、端では押せない。「いまの一手」に、全員の打牌と鳴きが出る', async () => {
    const { user } = setup();
    await loaded();
    await openReplay(user);
    expect(screen.getByRole('button', { name: '1手戻る' })).toBeDisabled();
    expect(screen.getByRole('button', { name: '局の頭へ' })).toBeDisabled();
    expect(screen.getByRole('button', { name: '前の巡目へ' })).toBeDisabled();
    await user.click(screen.getByRole('button', { name: '1手進む' }));
    expect(pos()).toBe('手 2 / 80');
    expect(title()).toBe('東1局 1巡目');
    expect(nowText()).toBe(`自分が ${tileLabel(timeline.steps[1]!.board.drawn!)} をツモりました`);
    await user.click(screen.getByRole('button', { name: '1手進む' }));
    expect(pos()).toBe('手 3 / 80');
    expect(nowText()).toMatch(/^自分が .+ を切りました/);
    await user.click(screen.getByRole('button', { name: '1手進む' }));
    expect(nowText()).toMatch(/^下家が .+ を切りました/);
    await user.click(screen.getByRole('button', { name: '1手戻る' }));
    expect(pos()).toBe('手 3 / 80');
    expect(document.querySelector('.now-s')?.textContent).toBe('東1局 · 1巡目 · 手 3 / 80');
  });

  it('「次の巡目」は、自分の次の巡目の最初の手。「前の巡目」は、この巡目の最初の手、さらに押すと、ひとつ前の巡目', async () => {
    const { user } = setup();
    await loaded();
    await openReplay(user);
    await user.click(screen.getByRole('button', { name: '次の巡目へ' }));
    expect(title()).toBe('東1局 1巡目');
    expect(pos()).toBe('手 2 / 80');
    await user.click(screen.getByRole('button', { name: '次の巡目へ' }));
    expect(title()).toBe('東1局 2巡目');
    await user.click(screen.getByRole('button', { name: '1手進む' }));
    await user.click(screen.getByRole('button', { name: '前の巡目へ' }));
    expect(title()).toBe('東1局 2巡目');
    const first = timeline.kyokus[0]!.turnFirst.get(2)!;
    expect(pos()).toBe(posAt(first));
    await user.click(screen.getByRole('button', { name: '前の巡目へ' }));
    expect(title()).toBe('東1局 1巡目');
  });

  it('「局の終わり」で、この局の最後の手へ。「この局が終わりました」と、結果（自分の和了（対面から））と点の増減。局の終わりの次の巡目は、次の局の頭', async () => {
    const { user } = setup();
    await loaded();
    await openReplay(user);
    await user.click(screen.getByRole('button', { name: /^局を選ぶ/ }));
    await user.click(screen.getByRole('menuitemradio', { name: /^東2局1本場/ }));
    expect(title()).toBe('東2局1本場 配牌');
    expect(pos()).toBe('手 1 / 48');
    await user.click(screen.getByRole('button', { name: '局の終わりへ' }));
    expect(pos()).toBe('手 48 / 48');
    expect(screen.getByRole('button', { name: '局の終わりへ' })).toBeDisabled();
    expect(screen.getByRole('button', { name: '1手進む' })).toBeEnabled();
    expect(nowText()).toBe('この局が終わりました');
    expect(document.querySelector('.now-res b')?.textContent).toBe('自分の和了（対面から）');
    expect([...document.querySelectorAll('.deltas li')].map((li) => li.textContent)).toEqual([
      '自分 +1,300',
      '下家 ±0',
      '対面 \u22121,300',
      '上家 ±0',
    ]);
    await user.click(screen.getByRole('button', { name: '次の巡目へ' }));
    expect(title()).toBe('東3局 配牌');
    expect(pos()).toBe('手 1 / 26');
  });

  it('局の選択: 局の名前と、その局の迷い・不一致の数。選ぶと、その局の頭へ。Esc で閉じて、押したボタンへ位置が戻る', async () => {
    const { user } = setup({ links: USER_LINKS });
    await loaded('5');
    await openReplay(user);
    const button = screen.getByRole('button', { name: /^局を選ぶ/ });
    await user.click(button);
    const items = within(screen.getByRole('menu', { name: '局を選ぶ' })).getAllByRole('menuitemradio');
    expect(items.map((item) => item.querySelector('span:not(.tick):not(.pi-r)')?.textContent)).toEqual([
      '東1局',
      '東2局',
      '東2局1本場',
      '東3局',
      '東3局1本場',
    ]);
    expect(items.map((item) => item.querySelector('.pi-r')?.textContent ?? '')).toEqual([
      '迷い1',
      '迷い1 · 不一致1',
      '迷い2 · 不一致2',
      '',
      '迷い2 · 不一致2',
    ]);
    expect(items[0]).toHaveAttribute('aria-checked', 'true');
    await user.keyboard('{Escape}');
    expect(screen.queryByRole('menu')).toBeNull();
    expect(button).toHaveFocus();
    await user.click(button);
    await user.click(screen.getByRole('menuitemradio', { name: /^東3局1本場/ }));
    expect(title()).toBe('東3局1本場 配牌');
    expect(screen.getByRole('button', { name: /^局を選ぶ/ })).toHaveTextContent('東3局1本場');
  });

  it('各手の盤面が、牌譜の再生（E-2）と一致する: 河・副露・手牌の枚数と、残り枚数・点数', async () => {
    const { user } = setup();
    await loaded();
    await openReplay(user);
    const me = timeline.playerId;
    const check = (g: number) => {
      const step = timeline.steps[g]!;
      const board = step.board;
      const position = ['bottom', 'right', 'top', 'left'] as const;
      position.forEach((place, offset) => {
        const seat = (me + offset) % 4;
        expect(document.querySelectorAll(`.zone.${place} .rt`).length, `${titleAt(g)} ${place}`).toBe(board.rivers[seat]!.length);
      });
      expect(document.querySelectorAll('.hand .slot').length).toBe(board.hand.length + (board.drawn === null ? 0 : 1));
      expect(document.querySelector('.rest b')?.textContent).toBe(String(board.tilesLeft));
      const scores = [...document.querySelectorAll('.score .pts')].map((el) => el.textContent).sort();
      expect(scores).toEqual(board.scores.map((score) => score.toLocaleString('ja-JP')).sort());
    };
    check(0);
    for (const g of [1, 2, 5, 11, 27, 40]) {
      // キーで先へ進む（1 手ずつ）
      while (pos() !== posAt(g) || title() !== titleAt(g)) press(PERIOD);
      check(g);
    }
  });

  it('直前の打牌は、その席の河の最後の牌に印が付き、凡例に「直前の打牌」が出る。ツモの手・場面では付かない', async () => {
    const { user } = setup();
    await loaded();
    await openReplay(user);
    expect(boardTiles('.tile.latest')).toHaveLength(0);
    expect(screen.queryByText('直前の打牌')).toBeNull();
    await user.click(screen.getByRole('button', { name: '次の巡目へ' })); // 自分のツモ
    expect(boardTiles('.tile.latest')).toHaveLength(0);
    await user.click(screen.getByRole('button', { name: '1手進む' })); // 自分の打牌
    const latest = boardTiles('.tile.latest');
    expect(latest).toHaveLength(1);
    expect(latest[0]?.closest('.zone.bottom')).not.toBeNull();
    expect(screen.getByText('直前の打牌')).toBeInTheDocument();
    expect(latest[0]?.getAttribute('aria-label') ?? latest[0]?.querySelector('img')?.getAttribute('alt') ?? '').toMatch(/（直前の打牌）/);
  });
});

describe('U-21 既定のキー（R10-3）', () => {
  it(', . で 1 手戻る・進む（全員の打牌と鳴きを 1 つずつ）', async () => {
    const { user } = setup();
    await loaded();
    await openReplay(user);
    press(PERIOD);
    press(PERIOD);
    expect(pos()).toBe('手 3 / 80');
    press(COMMA);
    expect(pos()).toBe('手 2 / 80');
    press(COMMA);
    press(COMMA);
    expect(pos()).toBe('手 1 / 80');
    // 局をまたいで戻る・進む（手の通し番号で 1 つずつ）
    await user.click(screen.getByRole('button', { name: /^局を選ぶ/ }));
    await user.click(screen.getByRole('menuitemradio', { name: /^東2局(?!\d)/ }));
    press(COMMA);
    expect(title()).toMatch(/^東1局 /);
    expect(pos()).toBe('手 80 / 80');
    press(PERIOD);
    expect(title()).toBe('東2局 配牌');
  });

  it('← → は前・次の自分の判断（鳴きを含む）。判断の無い手からも、いまより前・後の判断へ。端では動かない', async () => {
    const { user } = setup();
    await loaded();
    await openReplay(user);
    const stops = decisionSteps(timeline);
    press(arrow('Right'));
    expect(title()).toBe(titleAt(stops[0]!));
    expect(pos()).toBe(posAt(stops[0]!));
    expect(nowText()).toMatch(/^自分が .+ をツモりました/);
    expect(document.querySelector('.now-d')?.textContent).toMatch(/^自分の判断の場面です（/);
    press(arrow('Right'));
    expect(pos()).toBe(posAt(stops[1]!));
    press(arrow('Left'));
    expect(pos()).toBe(posAt(stops[0]!));
    press(arrow('Left'));
    expect(pos()).toBe(posAt(stops[0]!));
    // 判断の無い手から
    press(PERIOD);
    expect(timeline.steps[stops[0]! + 1]!.decision).toBeNull();
    press(arrow('Right'));
    expect(pos()).toBe(posAt(nextStepIn(stops, stops[0]! + 1)!));
    // 鳴きの判断にも止まる（東2局1本場 8巡目の東のポン。迷いの場面）
    const call = stepOf('k1h1e10');
    expect(stops).toContain(call);
    expect(prevStepIn(stops, call)).not.toBeNull();
  });

  it('↑ ↓ は前・次の不一致（大きな不一致）。Shift+↑ ↓ は前・次の迷い。Shift+← → は前・次の局の頭', async () => {
    const { user } = setup({ links: USER_LINKS });
    await loaded('5');
    await openReplay(user);
    const mismatches = ['k1h0e12', 'k1h1e6', 'k1h1e9', 'k2h1e2', 'k2h1e16'];
    for (const key of mismatches) {
      press(arrow('Down'));
      expect(title()).toBe(titleAt(stepOf(key)));
      expect(pos()).toBe(posAt(stepOf(key)));
    }
    press(arrow('Down'));
    expect(pos()).toBe(posAt(stepOf('k2h1e16')));
    press(arrow('Up'));
    expect(pos()).toBe(posAt(stepOf('k2h1e2')));
    const doubts = ['k0h0e4', 'k1h0e12', 'k1h1e7', 'k1h1e10', 'k2h1e6', 'k2h1e14'];
    // 最初に戻って、迷いを順に
    await user.click(screen.getByRole('button', { name: '局の頭へ' }));
    press(arrow('Left', true));
    press(arrow('Left', true));
    press(arrow('Left', true));
    press(arrow('Left', true));
    expect(title()).toBe('東1局 配牌');
    for (const key of doubts) {
      press(arrow('Down', true));
      expect(pos(), key).toBe(posAt(stepOf(key)));
      expect(title(), key).toBe(titleAt(stepOf(key)));
    }
    press(arrow('Up', true));
    expect(pos()).toBe(posAt(stepOf('k2h1e6')));
    // 局: 最後の局には、次の局が無い（動かない）。前の局の頭へ、次の局の頭へ
    press(arrow('Right', true));
    expect(pos()).toBe(posAt(stepOf('k2h1e6')));
    press(arrow('Left', true));
    expect(title()).toBe('東3局 配牌');
    press(arrow('Right', true));
    expect(title()).toBe(titleAt(nextKyokuStep(timeline, timeline.kyokus[3]!.first)!));
    expect(title()).toBe('東3局1本場 配牌');
    expect(pos()).toBe('手 1 / 61');
  });

  it('U-21 Home は局の頭、End は局の終わり（R11-4）。端では動かず、押したキーは窓のスクロールを止める', async () => {
    const { user } = setup();
    await loaded();
    await openReplay(user);
    const HOME = { code: 'Home', key: 'Home' };
    const END = { code: 'End', key: 'End' };
    // 局の頭では、Home は何も動かさない
    expect(press(HOME)).toBe(false);
    expect(pos()).toBe('手 1 / 80');
    // 数手進んでから Home: この局の頭へ
    press(PERIOD);
    press(PERIOD);
    press(PERIOD);
    expect(pos()).toBe('手 4 / 80');
    press(HOME);
    expect(title()).toBe('東1局 配牌');
    expect(pos()).toBe('手 1 / 80');
    // End: この局の最後の手へ（結果が出る）。もう一度押しても動かない
    expect(press(END)).toBe(false);
    expect(pos()).toBe('手 80 / 80');
    expect(nowText()).toBe('この局が終わりました');
    press(END);
    expect(pos()).toBe('手 80 / 80');
    // 次の局でも、その局の頭・終わり
    press(PERIOD);
    expect(title()).toBe('東2局 配牌');
    press(PERIOD);
    press(PERIOD);
    press(END);
    expect(title()).toMatch(/^東2局 /);
    expect(pos()).toBe(`手 ${timeline.kyokus[1]!.steps.length} / ${timeline.kyokus[1]!.steps.length}`);
    press(HOME);
    expect(title()).toBe('東2局 配牌');
    expect(pos()).toBe('手 1 / ' + timeline.kyokus[1]!.steps.length);
    // ボタンと同じ動き（局の頭へ・局の終わりへ）。ボタンの title にキーが出る
    expect(screen.getByRole('button', { name: '局の頭へ' })).toHaveAttribute('title', '局の頭へ（Home）');
    expect(screen.getByRole('button', { name: '局の終わりへ' })).toHaveAttribute('title', '局の終わりへ（End）');
  });

  it('U-21 Home・End を利用者が外していれば（保存してある設定の null）、外れたまま。キーを押しても何も動かない', async () => {
    const { user } = setup({ settings: { replay_keys: { ...defaultReplayKeys(), kyoku_start: null, kyoku_end: null } } });
    await loaded();
    await openReplay(user);
    press(PERIOD);
    press(PERIOD);
    expect(press({ code: 'Home', key: 'Home' })).toBe(true);
    expect(press({ code: 'End', key: 'End' })).toBe(true);
    expect(pos()).toBe('手 3 / 80');
    await user.click(screen.getByRole('button', { name: 'キーの一覧と割り当て' }));
    const dialog = screen.getByRole('dialog', { name: 'キーの一覧と割り当て' });
    const key = (label: string) =>
      (within(dialog).getByText(label, { selector: '.kp-name' }).closest('li') as HTMLElement).querySelector('.kp-key')?.textContent;
    expect(key('局の頭')).toBe('なし');
    expect(key('局の終わり')).toBe('なし');
  });

  it('U-21 保存してある設定に局の頭・終わりの値が無ければ、Home・End が既定で入る。ほかの操作が Home を使っていれば、局の頭は割り当て無し', async () => {
    const withoutThem = { ...defaultReplayKeys(), step_back: 'KeyJ' } as Record<string, string | null>;
    delete withoutThem.kyoku_start;
    delete withoutThem.kyoku_end;
    const first = setup({ settings: { replay_keys: withoutThem } });
    await loaded();
    await openReplay(first.user);
    press(PERIOD);
    press(PERIOD);
    press({ code: 'KeyJ', key: 'j' });
    expect(pos()).toBe('手 2 / 80');
    press({ code: 'Home', key: 'Home' });
    expect(pos()).toBe('手 1 / 80');
    press({ code: 'End', key: 'End' });
    expect(pos()).toBe('手 80 / 80');
    first.view.unmount();

    const taken = { ...defaultReplayKeys(), next_turn: 'Home' } as Record<string, string | null>;
    delete taken.kyoku_start;
    delete taken.kyoku_end;
    const second = setup({ settings: { replay_keys: taken } });
    await loaded();
    await openReplay(second.user);
    press(PERIOD);
    press(PERIOD);
    expect(title()).toBe('東1局 1巡目');
    press({ code: 'Home', key: 'Home' }); // 次の巡目（局の頭ではない）
    expect(title()).toBe('東1局 2巡目');
    press({ code: 'End', key: 'End' });
    expect(pos()).toBe('手 80 / 80');
  });

  it('巡目の移動は、既定ではボタンだけ（キーを押しても動かない）。Alt+← → は取らない', async () => {
    const { user } = setup();
    await loaded();
    await openReplay(user);
    for (const code of ['BracketRight', 'BracketLeft', 'KeyN', 'KeyP', 'PageDown', 'PageUp']) {
      press({ code });
      expect(pos(), code).toBe('手 1 / 80');
    }
    press({ code: 'ArrowRight', key: 'ArrowRight', altKey: true });
    expect(pos()).toBe('手 1 / 80');
    press({ code: 'KeyK', key: 'k', ctrlKey: true });
    expect(pos()).toBe('手 1 / 80');
  });

  it('割り当てたキーは、窓のスクロールなどの既定の動きを止める。割り当てていないキーは止めない', async () => {
    const { user } = setup();
    await loaded();
    await openReplay(user);
    expect(press(arrow('Down'))).toBe(false);
    expect(press(COMMA)).toBe(false);
    expect(press({ code: 'KeyQ', key: 'q' })).toBe(true);
  });

  it('文字を打つ欄・メニュー・ダイアログの中では、キーは何もしない（理由の欄に , . を打てる）', async () => {
    const { user } = setup({ links: USER_LINKS });
    await loaded('5');
    await user.click(await screen.findByRole('button', { name: 'この局面を解く（迷い3）' }));
    await screen.findByLabelText('理由（1行）');
    const before = pos();
    await user.click(reasonBox());
    await user.keyboard('a,b.c');
    expect(reasonBox()).toHaveValue('a,b.c');
    press(arrow('Right'));
    press(arrow('Down'));
    expect(pos()).toBe(before);
    // メニュー（局の選択）が開いている間は、矢印はメニューの中で動く
    await user.click(screen.getByRole('button', { name: /^局を選ぶ/ }));
    await user.keyboard('{ArrowDown}');
    expect(pos()).toBe(before);
    await user.keyboard('{Escape}');
    expect(pos()).toBe(before);
    // キーの一覧（ダイアログ）の中でも、何もしない
    await user.click(screen.getByRole('button', { name: 'キーの一覧と割り当て' }));
    const dialog = screen.getByRole('dialog', { name: 'キーの一覧と割り当て' });
    await user.click(within(dialog).getByRole('button', { name: '閉じる' }));
    expect(pos()).toBe(before);
  });

  it('手牌の牌にキーボードの位置があるとき、← → は牌の移動のまま（通して見る画面は動かない）。↑ ↓ と , . と Shift+矢印は、通して見る画面の操作', async () => {
    const { user } = setup({ links: USER_LINKS });
    await loaded('5');
    await user.click(await screen.findByRole('button', { name: 'この局面を解く（迷い3）' }));
    await screen.findByLabelText('理由（1行）');
    const stop = document.querySelector<HTMLElement>('.hand .tile-btn[tabindex="0"]')!;
    stop.focus();
    const here = pos();
    await user.keyboard('{ArrowRight}');
    expect(pos()).toBe(here);
    expect(document.activeElement).not.toBe(stop);
    expect(document.activeElement?.closest('.hand')).not.toBeNull();
    // , は 1 手戻る
    press(COMMA);
    expect(pos()).toBe(posAt(stepOf('k1h1e7') - 1));
  });

  it('U-21 手牌の牌にキーボードの位置があるとき、Home・End は牌の移動のまま（局の頭・局の終わりへは行かない）。位置の帯でも、帯の Home・End が先', async () => {
    const { user } = setup({ links: USER_LINKS });
    await loaded('5');
    await user.click(await screen.findByRole('button', { name: 'この局面を解く（迷い3）' }));
    await screen.findByLabelText('理由（1行）');
    const stop = document.querySelector<HTMLElement>('.hand .tile-btn[tabindex="0"]')!;
    stop.focus();
    const here = pos();
    const tiles = [...document.querySelectorAll<HTMLElement>('.hand .tile-btn')].filter((tile) => !(tile as HTMLButtonElement).disabled);
    expect(tiles.length).toBeGreaterThan(2);
    expect(press({ code: 'End', key: 'End' })).toBe(false);
    expect(pos()).toBe(here);
    expect(document.activeElement).toBe(tiles[tiles.length - 1]);
    press({ code: 'Home', key: 'Home' });
    expect(pos()).toBe(here);
    expect(document.activeElement).toBe(tiles[0]);
    // 手牌から外れると（見出しなど）、Home は局の頭へ
    (document.activeElement as HTMLElement).blur();
    press({ code: 'Home', key: 'Home' });
    expect(pos()).toBe('手 1 / 48');
    // 位置の帯（スライダー）では、帯の Home・End（半荘の頭・終わり）
    const track = screen.getByRole('slider', { name: '半荘の中の位置（左右の矢印で1手ずつ）' });
    track.focus();
    press({ code: 'End', key: 'End' });
    expect(track).toHaveAttribute('aria-valuenow', '289');
    press({ code: 'Home', key: 'Home' });
    expect(track).toHaveAttribute('aria-valuenow', '1');
  });
});

describe('U-21 キーの説明と割り当ての変更（アイコンを押すか、マウスを乗せる）', () => {
  const dialog = () => screen.getByRole('dialog', { name: 'キーの一覧と割り当て' });
  const rowOf = (label: string) => within(dialog()).getByText(label, { selector: '.kp-name' }).closest('li') as HTMLElement;

  it('キーボードのアイコンを押すと、すべての操作とそのキーの一覧が出る。もう一度押す・Esc・閉じる・外を押すで閉じる', async () => {
    const { user } = setup();
    await loaded();
    await openReplay(user);
    const icon = screen.getByRole('button', { name: 'キーの一覧と割り当て' });
    expect(icon).toHaveAttribute('aria-expanded', 'false');
    expect(screen.queryByRole('dialog')).toBeNull();
    await user.click(icon);
    expect(icon).toHaveAttribute('aria-expanded', 'true');
    const rows = [...dialog().querySelectorAll('.kp-row')];
    expect(rows).toHaveLength(14);
    const text = (label: string) => rowOf(label).querySelector('.kp-key')?.textContent;
    expect(text('1手戻る')).toBe(',');
    expect(text('1手進む')).toBe('.');
    expect(text('前の自分の判断')).toBe('←');
    expect(text('次の自分の判断')).toBe('→');
    expect(text('前の不一致')).toBe('↑');
    expect(text('次の不一致')).toBe('↓');
    expect(text('前の迷い')).toBe('Shift↑');
    expect(text('次の迷い')).toBe('Shift↓');
    expect(text('前の局')).toBe('Shift←');
    expect(text('次の局')).toBe('Shift→');
    expect(text('前の巡目')).toBe('なし');
    expect(text('次の巡目')).toBe('なし');
    expect(text('局の頭')).toBe('Home');
    expect(text('局の終わり')).toBe('End');
    // もう一度押すと閉じる
    await user.click(icon);
    expect(screen.queryByRole('dialog')).toBeNull();
    // Esc で閉じて、アイコンへ位置が戻る
    await user.click(icon);
    await user.keyboard('{Escape}');
    expect(screen.queryByRole('dialog')).toBeNull();
    expect(icon).toHaveFocus();
    // 閉じるボタン
    await user.click(icon);
    await user.click(within(dialog()).getByRole('button', { name: '閉じる' }));
    expect(screen.queryByRole('dialog')).toBeNull();
    // 外を押すと閉じる
    await user.click(icon);
    await user.click(screen.getByRole('heading', { level: 1 }));
    expect(screen.queryByRole('dialog')).toBeNull();
  });

  it('マウスを乗せると出る。離すと閉じる。押して出したものは、マウスを離しても出したまま。出ている間も、キーは使える', async () => {
    const { user } = setup();
    await loaded();
    await openReplay(user);
    const icon = screen.getByRole('button', { name: 'キーの一覧と割り当て' });
    await user.hover(icon);
    expect(dialog()).toBeInTheDocument();
    // 一覧の中へマウスを動かしても、閉じない
    await user.hover(within(dialog()).getByRole('button', { name: '1手戻るのキーを変更' }));
    await new Promise((resolve) => setTimeout(resolve, 400));
    expect(screen.queryByRole('dialog')).not.toBeNull();
    press(PERIOD);
    expect(pos()).toBe('手 2 / 80');
    await user.unhover(within(dialog()).getByRole('button', { name: '1手戻るのキーを変更' }));
    await waitFor(() => expect(screen.queryByRole('dialog')).toBeNull());
    // 押して出したものは、マウスを離しても出たまま
    await user.click(icon);
    await user.unhover(icon);
    await new Promise((resolve) => setTimeout(resolve, 400));
    expect(screen.queryByRole('dialog')).not.toBeNull();
  });

  it('「変更」を押して、新しいキーを押すと、そのキーになる。古いキーは使えなくなり、新しいキーが使える。設定に保存して、開き直しても残る', async () => {
    const { user, mock, store } = setup();
    await loaded();
    await openReplay(user);
    await user.click(screen.getByRole('button', { name: 'キーの一覧と割り当て' }));
    await user.click(within(dialog()).getByRole('button', { name: '1手戻るのキーを変更' }));
    expect(within(dialog()).getByText('新しいキーを押してください')).toBeInTheDocument();
    press({ code: 'KeyJ', key: 'j' });
    expect(within(dialog()).queryByText('新しいキーを押してください')).toBeNull();
    await waitFor(() => expect(store.current.replay_keys.step_back).toBe('KeyJ'));
    await waitFor(() => expect(rowOf('1手戻る').querySelector('.kp-key')?.textContent).toBe('J'));
    // 保存した設定は、ほかの設定と、ほかのキーを変えない
    const saved = mock.calls().filter((c) => c.cmd === 'set_settings');
    expect(saved).toHaveLength(1);
    expect((saved[0]!.args as { settings: Settings }).settings).toMatchObject({
      daily_count: 5,
      replay_keys: { ...defaultReplayKeys(), step_back: 'KeyJ' },
    });
    await user.click(within(dialog()).getByRole('button', { name: '閉じる' }));
    press(PERIOD);
    press(PERIOD);
    expect(pos()).toBe('手 3 / 80');
    press(COMMA); // 古いキーは、もう何もしない
    expect(pos()).toBe('手 3 / 80');
    press({ code: 'KeyJ', key: 'j' });
    expect(pos()).toBe('手 2 / 80');
  });

  it('変えたキーは、アプリを開き直しても残る（設定ファイルから読む）', async () => {
    const first = setup({ settings: { replay_keys: { ...defaultReplayKeys(), step_forward: 'KeyL', step_back: 'KeyJ' } } });
    await loaded();
    await openReplay(first.user);
    press({ code: 'KeyL', key: 'l' });
    expect(pos()).toBe('手 2 / 80');
    press({ code: 'KeyJ', key: 'j' });
    expect(pos()).toBe('手 1 / 80');
    press(PERIOD);
    expect(pos()).toBe('手 1 / 80');
    await first.user.click(screen.getByRole('button', { name: 'キーの一覧と割り当て' }));
    expect(rowOf('1手進む').querySelector('.kp-key')?.textContent).toBe('L');
  });

  it('同じキーを別の操作に割り当てようとすると、割り当てずに、どの操作が使っているかを出す（入れ替えない）。保存もしない', async () => {
    const { user, mock, store } = setup();
    await loaded();
    await openReplay(user);
    await user.click(screen.getByRole('button', { name: 'キーの一覧と割り当て' }));
    await user.click(within(dialog()).getByRole('button', { name: '次の巡目のキーを変更' }));
    press(arrow('Right'));
    const alert = within(dialog()).getByRole('alert');
    expect(alert).toHaveTextContent('→ は、すでに「次の自分の判断」に使っています。先に「次の自分の判断」のキーを変えてください。');
    // まだキーを待っている（別のキーを押せる）。割り当ては、どちらも元のまま
    expect(rowOf('次の巡目').querySelector('.kp-key')?.textContent).toBe('新しいキーを押してください');
    expect(rowOf('次の自分の判断').querySelector('.kp-key')?.textContent).toBe('→');
    expect(mock.count('set_settings')).toBe(0);
    expect(store.current.replay_keys).toEqual(defaultReplayKeys());
    // 使っていないキーなら、割り当てられる。理由の文は消える
    press({ code: 'KeyH', key: 'h' });
    expect(within(dialog()).getByRole('alert')).toBeEmptyDOMElement();
    await waitFor(() => expect(store.current.replay_keys.next_turn).toBe('KeyH'));
    await waitFor(() => expect(rowOf('次の巡目').querySelector('.kp-key')?.textContent).toBe('H'));
    expect(rowOf('次の自分の判断').querySelector('.kp-key')?.textContent).toBe('→');
    // 巡目の移動にも、キーを足せた
    await user.click(within(dialog()).getByRole('button', { name: '閉じる' }));
    press({ code: 'KeyH', key: 'h' });
    expect(title()).toBe('東1局 1巡目');
    expect(pos()).toBe('手 2 / 80');
  });

  it('割り当てられないキー（Alt+←・Ctrl+K・Ctrl+Z・Tab・Enter・Space）は、理由を出して断る。Esc は、変更をやめる', async () => {
    const { user, mock } = setup();
    await loaded();
    await openReplay(user);
    await user.click(screen.getByRole('button', { name: 'キーの一覧と割り当て' }));
    await user.click(within(dialog()).getByRole('button', { name: '前の巡目のキーを変更' }));
    for (const init of [
      { code: 'ArrowLeft', key: 'ArrowLeft', altKey: true },
      { code: 'KeyK', key: 'k', ctrlKey: true },
      { code: 'KeyZ', key: 'z', ctrlKey: true },
      { code: 'KeyY', key: 'y', ctrlKey: true },
      { code: 'Tab', key: 'Tab' },
      { code: 'Enter', key: 'Enter' },
      { code: 'Space', key: ' ' },
    ]) {
      press(init);
      expect(within(dialog()).getByRole('alert')).toHaveTextContent('割り当てられません');
      expect(within(dialog()).getByText('新しいキーを押してください')).toBeInTheDocument();
    }
    press({ code: 'F5', key: 'F5' });
    expect(within(dialog()).getByRole('alert')).toHaveTextContent('F5 は、割り当てられないキーです');
    expect(mock.count('set_settings')).toBe(0);
    press({ code: 'Escape', key: 'Escape' });
    expect(within(dialog()).queryByText('新しいキーを押してください')).toBeNull();
    expect(screen.queryByRole('dialog')).not.toBeNull();
    expect(within(dialog()).getByRole('alert')).toBeEmptyDOMElement();
    // 変更のあいだの Alt+← は、画面の戻るにもならない（キーを受けるだけ）
    expect(screen.queryByRole('region', { name: '半荘を進める' })).not.toBeNull();
  });

  it('「外す」で、その操作はボタンだけになる。「既定に戻す」で、すべて既定のキーに戻る', async () => {
    const { user, store } = setup({ settings: { replay_keys: { ...defaultReplayKeys(), step_back: 'KeyJ', next_turn: 'KeyL' } } });
    await loaded();
    await openReplay(user);
    await user.click(screen.getByRole('button', { name: 'キーの一覧と割り当て' }));
    expect(within(dialog()).getByRole('button', { name: '既定に戻す' })).toBeEnabled();
    await user.click(within(dialog()).getByRole('button', { name: '1手進むのキーを外す' }));
    await waitFor(() => expect(store.current.replay_keys.step_forward).toBeNull());
    expect(rowOf('1手進む').querySelector('.kp-key')?.textContent).toBe('なし');
    expect(within(dialog()).queryByRole('button', { name: '1手進むのキーを外す' })).toBeNull();
    await user.click(within(dialog()).getByRole('button', { name: '既定に戻す' }));
    await waitFor(() => expect(store.current.replay_keys).toEqual(defaultReplayKeys()));
    expect(rowOf('1手戻る').querySelector('.kp-key')?.textContent).toBe(',');
    expect(rowOf('次の巡目').querySelector('.kp-key')?.textContent).toBe('なし');
    expect(within(dialog()).getByRole('button', { name: '既定に戻す' })).toBeDisabled();
  });

  it('保存できなかったときは、その理由を出して、キーは変えない', async () => {
    const { user, store } = setup();
    await loaded();
    await openReplay(user);
    store.failWith('ディスクがいっぱいです');
    await user.click(screen.getByRole('button', { name: 'キーの一覧と割り当て' }));
    await user.click(within(dialog()).getByRole('button', { name: '1手戻るのキーを変更' }));
    press({ code: 'KeyJ', key: 'j' });
    expect(await within(dialog()).findByText('ディスクがいっぱいです')).toBeInTheDocument();
    expect(rowOf('1手戻る').querySelector('.kp-key')?.textContent).toBe(',');
    expect(store.current.replay_keys.step_back).toBe('Comma');
    // 古いキーのまま使える
    await user.click(within(dialog()).getByRole('button', { name: '閉じる' }));
    press(PERIOD);
    press(COMMA);
    expect(pos()).toBe('手 1 / 80');
  });

  it('ボタンの title には、いまのキーが出る（割り当てを変えると変わる）', async () => {
    const { user } = setup({ settings: { replay_keys: { ...defaultReplayKeys(), step_back: 'Shift+KeyJ' } } });
    await loaded();
    await openReplay(user);
    expect(screen.getByRole('button', { name: '1手戻る' })).toHaveAttribute('title', '1手戻る（Shift+J）');
    expect(screen.getByRole('button', { name: '1手進む' })).toHaveAttribute('title', '1手進む（.）');
    expect(screen.getByRole('button', { name: '次の巡目へ' })).toHaveAttribute('title', '次の巡目へ');
  });
});

describe('U-21 位置の帯と場面の一覧（迷い・不一致）', () => {
  it('場面の一覧: 10 か所（迷い 6・不一致 5。迷い 2 は不一致でもある）。局・巡目・種類・向聴数・未解答と、札。0 / 10 解答済み', async () => {
    const { user } = setup({ links: USER_LINKS });
    await loaded('5');
    await openReplay(user);
    expect(rest()).toBe('0 / 10 解答済み');
    const rows = sceneRows();
    expect(rows).toHaveLength(10);
    expect(rows.map((row) => row.querySelector('.sc-where b')?.textContent)).toEqual([
      '東1局 4巡目',
      '東2局 11巡目',
      '東2局1本場 5巡目',
      '東2局1本場 6巡目',
      '東2局1本場 8巡目',
      '東2局1本場 8巡目',
      '東3局1本場 3巡目',
      '東3局1本場 6巡目',
      '東3局1本場 11巡目',
      '東3局1本場 12巡目',
    ]);
    expect(rows[0]?.querySelector('.sc-sub')?.textContent).toBe('打牌 · 1向聴 · 未解答');
    expect(rows[5]?.querySelector('.sc-sub')?.textContent).toBe('鳴き · 1向聴 · 未解答');
    expect(rows.map((row) => [...row.querySelectorAll('.tag')].map((tag) => tag.textContent))).toEqual([
      ['迷い1'],
      ['迷い2', '大きな不一致'],
      ['大きな不一致'],
      ['迷い3'],
      ['大きな不一致'],
      ['迷い4'],
      ['大きな不一致'],
      ['迷い5'],
      ['迷い6'],
      ['大きな不一致'],
    ]);
    // 操作の説明は、本文に出さず、見出しのそばの (i) に乗せるか選ぶと、重ねて出る（U-25）
    const panel = document.querySelector('.scenes-h') as HTMLElement;
    expect(panel.textContent).not.toContain('場面を押すと');
    expect(screen.queryByRole('tooltip')).toBeNull();
    const icon = within(panel).getByRole('button', { name: '場面の一覧の操作の説明' });
    expect(icon.closest('.sec-head')?.querySelector('h2')?.textContent).toBe('この半荘の場面');
    expect(screen.getByRole('list', { name: '場面の一覧' })).toHaveAccessibleDescription(
      '場面を押すと、その場面へ飛びます。場面に着くまで、AIの答えは出ません。',
    );
    await user.hover(icon);
    expect(screen.getByRole('tooltip')).toHaveTextContent('場面を押すと、その場面へ飛びます。場面に着くまで、AIの答えは出ません。');
    await user.keyboard('{Escape}');
    expect(screen.queryByRole('tooltip')).toBeNull();
    await user.unhover(icon);
    // 場面を押すと、その場面へ飛ぶ。答えの欄が出る
    await user.click(rows[3] as HTMLElement);
    expect(title()).toBe('東2局1本場 6巡目');
    expect(chips()).toEqual(['2向聴', '実戦：打南', '迷い3']);
    expect(document.querySelector('.scenes')).toBeNull();
  });

  it('位置の帯: 帯の上に迷いの丸 6、下に不一致のひし形 5。印を押すとその場面へ。いまの場面の印に輪が付く（迷い 2 は、丸もひし形も）', async () => {
    const { user } = setup({ links: USER_LINKS });
    await loaded('5');
    await openReplay(user);
    const pins = [...document.querySelectorAll<HTMLElement>('.pin')];
    expect(pins.filter((pin) => pin.classList.contains('dbt'))).toHaveLength(6);
    expect(pins.filter((pin) => pin.classList.contains('mis'))).toHaveLength(5);
    expect(pins.filter((pin) => pin.classList.contains('small'))).toHaveLength(0);
    expect(document.querySelectorAll('.tl-pins.up .pin.dbt')).toHaveLength(6);
    expect(document.querySelectorAll('.tl-pins.down .pin.mis')).toHaveLength(5);
    expect(pins.map((pin) => pin.getAttribute('aria-label'))).toContain('迷い2 東2局 11巡目 打牌（大きな不一致でもある）');
    await user.click(document.querySelector('.pin[data-key="k1h0e12"]') as HTMLElement);
    expect(title()).toBe('東2局 11巡目');
    expect([...document.querySelectorAll('.pin[aria-current="true"]')].map((pin) => pin.className)).toHaveLength(2);
    expect(chips()).toEqual(['1向聴', '実戦：打8p', '迷い2', '大きな不一致']);
    await user.click(document.querySelector('.pin[data-key="k2h1e14"]') as HTMLElement);
    expect(title()).toBe('東3局1本場 11巡目');
    expect(document.querySelectorAll('.pin[aria-current="true"]')).toHaveLength(1);
  });

  it('位置の帯は、スライダー（通し番号・場面の名前）。Home・End・← → で動く', async () => {
    const { user } = setup({ links: USER_LINKS });
    await loaded('5');
    await openReplay(user);
    const track = screen.getByRole('slider', { name: '半荘の中の位置（左右の矢印で1手ずつ）' });
    expect(track).toHaveAttribute('aria-valuemin', '1');
    expect(track).toHaveAttribute('aria-valuemax', '289');
    expect(track).toHaveAttribute('aria-valuenow', '1');
    expect(track).toHaveAttribute('aria-valuetext', '東1局 配牌（手 1 / 80）');
    track.focus();
    await user.keyboard('{End}');
    expect(track).toHaveAttribute('aria-valuenow', '289');
    expect(track).toHaveAttribute('aria-valuetext', '東3局1本場 12巡目（手 61 / 61）'.replace('12巡目', title().replace('東3局1本場 ', '')));
    await user.keyboard('{Home}');
    expect(track).toHaveAttribute('aria-valuenow', '1');
    await user.keyboard('{ArrowRight}');
    expect(track).toHaveAttribute('aria-valuenow', '2');
    await user.keyboard('{ArrowLeft}');
    expect(track).toHaveAttribute('aria-valuenow', '1');
    // 局ごとの区間（局の名前）
    expect([...document.querySelectorAll('.tl-seg .long')].map((el) => el.textContent)).toEqual([
      '東1局',
      '東2局',
      '東2局1本場',
      '東3局',
      '東3局1本場',
    ]);
    expect([...document.querySelectorAll('.tl-seg .short')].map((el) => el.textContent)).toEqual(['東1', '東2', '東2-1', '東3', '東3-1']);
  });

  it('次の迷いへ ×6 で、迷いの場面を順に開く（あと 5 … 0）。最後の迷いのあとは押せない。前の迷いで戻る', async () => {
    const { user } = setup({ links: USER_LINKS });
    await loaded('5');
    await openReplay(user);
    expect(screen.getByText('自分の迷い', { exact: false }).closest('.jump')).toHaveTextContent('6か所');
    const next = () => screen.getByRole('button', { name: /^次の迷いへ/ });
    const want = ['k0h0e4', 'k1h0e12', 'k1h1e7', 'k1h1e10', 'k2h1e6', 'k2h1e14'];
    for (const [index, key] of want.entries()) {
      expect(next().querySelector('.jc')?.textContent).toBe(String(6 - index));
      await user.click(next());
      expect(pos()).toBe(posAt(stepOf(key)));
      expect(answeringState()).toBe('answering');
    }
    expect(next()).toBeDisabled();
    expect(next()).toHaveAttribute('title', 'これ以降の迷いはありません');
    for (const key of want.slice(0, 5).reverse()) {
      await user.click(screen.getByRole('button', { name: '前の迷いへ' }));
      expect(pos()).toBe(posAt(stepOf(key)));
    }
    expect(screen.getByRole('button', { name: '前の迷いへ' })).toBeDisabled();
  });

  it('次の不一致へ ×5 で、大きな不一致の場面を順に開き、最後は押せない。名前は「大きな不一致 5か所」', async () => {
    const { user } = setup({ links: USER_LINKS });
    await loaded('5');
    await openReplay(user);
    const row = document.querySelector('.jump[data-kind="mismatch"]') as HTMLElement;
    expect(row).toHaveTextContent('大きな不一致 5か所');
    const want = ['k1h0e12', 'k1h1e6', 'k1h1e9', 'k2h1e2', 'k2h1e16'];
    for (const [index, key] of want.entries()) {
      expect(within(row).getByRole('button', { name: /^次の不一致へ/ }).querySelector('.jc')?.textContent).toBe(String(5 - index));
      await user.click(within(row).getByRole('button', { name: /^次の不一致へ/ }));
      expect(pos()).toBe(posAt(stepOf(key)));
    }
    expect(within(row).getByRole('button', { name: /^次の不一致へ/ })).toBeDisabled();
  });
});

describe('U-21 場面で答える（U-1・U-2・U-3・U-16）', () => {
  it('答える前の DOM に、AI の候補・確率・順位は無い（全 10 場面で。不一致の印と、実戦の行動は出る）', async () => {
    const { user } = setup({ links: USER_LINKS });
    await loaded('5');
    await openReplay(user);
    const keys = ['k0h0e4', 'k1h0e12', 'k1h1e6', 'k1h1e7', 'k1h1e9', 'k1h1e10', 'k2h1e2', 'k2h1e6', 'k2h1e14', 'k2h1e16'];
    // 最初の場面の前（browse）にも無い
    expect(document.querySelector('[data-ai]')).toBeNull();
    expect(document.body.textContent).not.toMatch(/\d\s*%|Mortal/);
    for (const key of keys) {
      press(arrow('Down', true)); // 迷いへ（無ければ、そのまま）
      await user.click(sceneRows().length > 0 ? sceneRows()[0]! : document.createElement('button'));
      await user.click(document.querySelector(`.pin[data-key="${key}"]`) as HTMLElement);
      expect(pos(), key).toBe(posAt(stepOf(key)));
      expect(answeringState(), key).toBe('answering');
      expect(document.querySelector('[data-ai]'), key).toBeNull();
      expect(document.body.innerHTML, key).not.toMatch(/data-ai|data-mark|data-ring/);
      expect(document.body.textContent, key).not.toMatch(/\d\s*%|Mortal|AIの評価/);
      expect(chips().some((chip) => chip?.startsWith('実戦：')), key).toBe(true);
    }
  });

  it('打牌の場面（迷い3）: 牌を選ぶと答え合わせが押せる。答え合わせで、AI の評価・受け入れ枚数・原因・MAKA が出る。答えは出題と同じに保存される', async () => {
    const { user, study } = setup({ links: USER_LINKS });
    await loaded('5');
    await user.click(await screen.findByRole('button', { name: 'この局面を解く（迷い3）' }));
    await screen.findByLabelText('理由（1行）');
    const submit = () => screen.getByRole('button', { name: '答え合わせ' });
    expect(submit()).toBeDisabled();
    expect(document.getElementById('gate')?.textContent).toBe('切る牌を選ぶと押せます');
    await user.click(screen.getAllByRole('button', { name: /を切る$/ })[5] as HTMLElement);
    await user.type(reasonBox(), '形を崩さないほうを残す');
    expect(submit()).toBeEnabled();
    await user.click(submit());
    await revealed();
    expect(answeringState()).toBe('revealed');
    expect(study.rows).toHaveLength(1);
    expect(study.rows[0]).toMatchObject({
      session_id: FX4_ID,
      decision_key: 'k1h1e7',
      mode: 'quiz',
      reason: '形を崩さないほうを残す',
      interval_days: 1,
      due_date: '2026-10-10',
    });
    expect(study.rows[0]?.shown_at).toBeGreaterThan(0);
    // AI の評価: 打牌の判断は、手牌の上の棒（右の欄に一覧は出さない。U-43）
    expect(document.querySelectorAll('.hand [data-ai="bar"]').length).toBeGreaterThanOrEqual(13);
    expect(document.querySelectorAll('.ai-bar .ai-num').length).toBeGreaterThanOrEqual(3);
    expect(document.querySelector('[data-ai="eval"]')).toBeNull();
    expect(document.querySelectorAll('[data-ai="candidate"]')).toHaveLength(0);
    expect(document.querySelectorAll('.uk-open').length).toBeGreaterThanOrEqual(2);
    // 役の欄（U-33）: 出題と同じ部品が、受け入れ枚数の欄の下に出る
    expect(screen.getByRole('heading', { name: '役' })).toBeInTheDocument();
    expect(document.querySelector('[data-ai="ukeire-box"] + [data-ai="yaku-box"]')).not.toBeNull();
    await user.click(screen.getByRole('button', { name: /^役$/ }));
    expect(document.querySelectorAll('[data-ai="yaku-box"] li.yk-row').length).toBeGreaterThanOrEqual(1);
    expect(screen.getByRole('button', { name: '次の場面へ' })).toBeInTheDocument();
    // 今日の出題でも、答えたことになる（サイドバーの数が減る）
    await waitFor(() => expect(sideCount(/^今日の出題/)).toBe('4'));
    // 位置の帯の印は、中を抜く。場面の名前に「解答済み」
    expect(document.querySelector('.pin[data-key="k1h1e7"]')?.getAttribute('data-done')).toBe('1');
    expect(document.querySelector('.pin[data-key="k1h1e7"]')?.getAttribute('aria-label')).toMatch(/（解答済み）$/);
  });

  it('U-11: Ctrl+Z・Ctrl+Y は、通して見る画面の操作ではない。答え合わせのあとの答えは、Ctrl+Z でも戻らない', async () => {
    const { user, study } = setup({ links: USER_LINKS });
    await loaded('5');
    await user.click(await screen.findByRole('button', { name: 'この局面を解く（迷い3）' }));
    await screen.findByLabelText('理由（1行）');
    await user.click(screen.getAllByRole('button', { name: /を切る$/ })[5] as HTMLElement);
    await user.type(reasonBox(), '形を崩さない');
    await user.click(screen.getByRole('button', { name: '答え合わせ' }));
    await revealed();
    const here = pos();
    press({ code: 'KeyZ', key: 'z', ctrlKey: true });
    press({ code: 'KeyY', key: 'y', ctrlKey: true });
    press({ code: 'KeyZ', key: 'Z', ctrlKey: true, shiftKey: true });
    expect(pos()).toBe(here);
    expect(answeringState()).toBe('revealed');
    expect(study.rows).toHaveLength(1);
    await waitFor(() => expect(sideCount(/^今日の出題/)).toBe('4'));
  });

  it('答えた場面を離れて戻ると、答え合わせのあとの形で開く（保存した答え・理由・AI の評価）。ほかの手を見ている間は、AI の情報は出ない', async () => {
    const { user } = setup({ links: USER_LINKS });
    await loaded('5');
    await user.click(await screen.findByRole('button', { name: 'この局面を解く（迷い3）' }));
    await screen.findByLabelText('理由（1行）');
    await user.click(screen.getAllByRole('button', { name: /を切る$/ })[5] as HTMLElement);
    await user.type(reasonBox(), '形を崩さない');
    await user.click(screen.getByRole('button', { name: '答え合わせ' }));
    await revealed();
    press(PERIOD);
    expect(answeringState()).toBe('browse');
    expect(document.querySelector('[data-ai]')).toBeNull();
    expect(screen.queryByRole('heading', { name: '役' })).toBeNull();
    expect(rest()).toBe('1 / 10 解答済み');
    expect(document.querySelectorAll('.sc-row[data-done="1"]')).toHaveLength(1);
    press(COMMA);
    expect(answeringState()).toBe('revealed');
    expect(screen.getByText('形を崩さない')).toBeInTheDocument();
    expect(document.querySelectorAll('.hand [data-ai="bar"]').length).toBeGreaterThanOrEqual(13);
    // 戻ると、役の欄も出る（ほかの手を見ている間は、欄が DOM に無い）
    expect(screen.getByRole('heading', { name: '役' })).toBeInTheDocument();
    expect(screen.queryByRole('button', { name: '答え合わせ' })).toBeNull();
  });

  it('次の迷いへ・次の不一致へ は、答えた場面も通る（答えた場面は、答え合わせのあとの形で開く）。答えていない次の場面には、AI の情報は出ない', async () => {
    const { user } = setup({ links: USER_LINKS });
    await loaded('5');
    await user.click(await screen.findByRole('button', { name: 'この局面を解く（迷い3）' }));
    await screen.findByLabelText('理由（1行）');
    await user.click(screen.getAllByRole('button', { name: /を切る$/ })[5] as HTMLElement);
    await user.type(reasonBox(), '形を崩さない');
    await user.click(screen.getByRole('button', { name: '答え合わせ' }));
    await revealed();
    // 前の迷い（迷い 2）→ 次の迷い（迷い 3。答えた場面）
    await user.click(screen.getByRole('button', { name: '前の迷いへ' }));
    expect(pos()).toBe(posAt(stepOf('k1h0e12')));
    expect(document.querySelector('[data-ai]')).toBeNull();
    await user.click(screen.getByRole('button', { name: /^次の迷いへ/ }));
    expect(pos()).toBe(posAt(stepOf('k1h1e7')));
    expect(answeringState()).toBe('revealed');
    await user.click(screen.getByRole('button', { name: /^次の迷いへ/ }));
    expect(pos()).toBe(posAt(stepOf('k1h1e10')));
    expect(answeringState()).toBe('answering');
    expect(document.querySelector('[data-ai]')).toBeNull();
    // 「次の場面へ」は、答えた場面のあと、次の場面（不一致でも）へ
    await user.click(screen.getByRole('button', { name: /^前の迷いへ/ }));
    expect(answeringState()).toBe('revealed');
    await user.click(screen.getByRole('button', { name: '次の場面へ' }));
    expect(pos()).toBe(posAt(stepOf('k1h1e9')));
    expect(chips()).toContain('大きな不一致');
  });

  it('鳴きの場面（迷い4。東をポン）: ポン・スルーのボタンで答える。保存される答えは、ボタンの鍵', async () => {
    const { user, study } = setup({ links: USER_LINKS });
    await loaded('5');
    await user.click(await screen.findByRole('button', { name: 'この局面を解く（迷い4）' }));
    expect(await screen.findByRole('heading', { level: 1, name: '東2局1本場 8巡目' })).toBeInTheDocument();
    expect(screen.getAllByRole('radio').map((radio) => radio.querySelector('.c-name')?.textContent)).toEqual(['ポン', 'スルー']);
    // 鳴ける牌（他家の打牌）の印が付く
    expect(document.querySelector('.hand .tile.target')).not.toBeNull();
    expect(document.querySelector('.zone .tile.target')).not.toBeNull();
    expect(document.querySelector('.tile.latest')).toBeNull();
    await user.click(screen.getAllByRole('radio')[0] as HTMLElement);
    await user.type(reasonBox(), '鳴いて進める');
    await user.click(screen.getByRole('button', { name: '答え合わせ' }));
    await revealed();
    expect(study.rows[0]).toMatchObject({ decision_key: 'k1h1e10', mode: 'quiz', choice: { type: 'option', id: 'pon' } });
  });

  it('U-34 答えた場面（迷い4。東をポン、聴牌になる）にタブが出る。答える前は出ない。タブの矢印は、場面の移動（← →）に渡さない', async () => {
    const { user } = setup({ links: USER_LINKS });
    await loaded('5');
    await user.click(await screen.findByRole('button', { name: 'この局面を解く（迷い4）' }));
    expect(await screen.findByRole('heading', { level: 1, name: '東2局1本場 8巡目' })).toBeInTheDocument();
    // 答える前: タブも、待ちと打点も、DOM に無い（U-1）
    expect(screen.queryByRole('tablist')).toBeNull();
    expect(document.body.textContent).not.toMatch(/待ちと打点|受け入れ・役|双碰|嵌張/);
    await user.click(screen.getAllByRole('radio')[0] as HTMLElement);
    await user.type(reasonBox(), '鳴いて進める');
    await user.click(screen.getByRole('button', { name: '答え合わせ' }));
    await revealed();
    expect(screen.getAllByRole('tab').map((tab) => tab.textContent)).toEqual(['受け入れ・役', '待ちと打点']);
    // 選ぶと、待ちと打点の表（ポンのあとに切る牌ごと）
    const [first, second] = screen.getAllByRole('tab') as [HTMLElement, HTMLElement];
    first.focus();
    await user.keyboard('{ArrowRight}');
    expect(second).toHaveAttribute('aria-selected', 'true');
    expect(second).toHaveFocus();
    expect(document.querySelectorAll('[data-ai="waits"]').length).toBeGreaterThanOrEqual(1);
    expect(document.querySelector('[data-ai="waits"] .wt-h')?.textContent).toMatch(/^ポン/);
    // ← → は、前・次の自分の判断への移動にも割り当てられている。タブが受けたキーは、場面を動かさない
    expect(screen.getByRole('heading', { level: 1, name: '東2局1本場 8巡目' })).toBeInTheDocument();
    await user.keyboard('{Home}');
    expect(first).toHaveAttribute('aria-selected', 'true');
    expect(screen.getByRole('heading', { level: 1, name: '東2局1本場 8巡目' })).toBeInTheDocument();
  });

  it('U-34 答えた場面（迷い1。東1局 14巡目、上家のリーチ中）に守備のタブが出る。答える前は出ない。場面を離れて戻ると、答えた場面に守備のタブがある', async () => {
    // 迷い 1 を、上家がリーチしている場面（FX-4 東1局 e15）に結びつけ直す
    const links: Links = { ratings: {}, marks: { ...USER_LINKS.marks, '1': 'k0h0e15' } };
    const { user } = setup({ links });
    await loaded(null);
    await user.click(await screen.findByRole('button', { name: 'この局面を解く（迷い1）' }));
    expect(await screen.findByRole('heading', { level: 1, name: '東1局 14巡目' })).toBeInTheDocument();
    // 答える前: タブも、守備の目安も、分類も、DOM に無い（U-1）
    expect(screen.queryByRole('tablist')).toBeNull();
    expect(document.body.textContent).not.toMatch(/守備の目安|形式的な分類|無スジ/);
    expect(document.querySelector('[data-ai]')).toBeNull();
    await user.click(screen.getAllByRole('button', { name: /を切る$/ })[0] as HTMLElement);
    await user.type(reasonBox(), '現物を切る');
    await user.click(screen.getByRole('button', { name: '答え合わせ' }));
    await revealed();
    const names = () => screen.getAllByRole('tab').map((tab) => tab.textContent);
    expect(names()).toEqual(['受け入れ・役', '待ちと打点', '守備']);
    // 守備のタブを → を 2 回で選ぶ。← → Home End は、場面の移動に渡さない
    const [first, , third] = screen.getAllByRole('tab') as [HTMLElement, HTMLElement, HTMLElement];
    first.focus();
    await user.keyboard('{ArrowRight}{ArrowRight}');
    expect(third).toHaveAttribute('aria-selected', 'true');
    const box = document.querySelector('[data-ai="danger-box"]') as HTMLElement;
    expect(box.querySelector('.dg-line')?.textContent).toMatch(/^上家がリーチ/);
    expect(screen.getByRole('heading', { level: 1, name: '東1局 14巡目' })).toBeInTheDocument();
    await user.keyboard('{Home}');
    expect(first).toHaveAttribute('aria-selected', 'true');
    expect(screen.getByRole('heading', { level: 1, name: '東1局 14巡目' })).toBeInTheDocument();
    // 場面を離れて戻ると、答え合わせのあとの形で開く（守備のタブも出る）
    await user.click(screen.getByRole('button', { name: /^次の迷いへ/ }));
    expect(pos()).toBe(posAt(stepOf('k1h0e12')));
    expect(document.querySelector('[data-ai]')).toBeNull();
    await user.click(screen.getByRole('button', { name: /^前の迷いへ/ }));
    expect(pos()).toBe(posAt(stepOf('k0h0e15')));
    expect(answeringState()).toBe('revealed');
    expect(names()).toEqual(['受け入れ・役', '待ちと打点', '守備']);
  });

  it('答えの下書き（選んだ牌・理由）は、場面を離れても残り、戻ると続きから。保存できていない間は、答えていないまま', async () => {
    const { user, study } = setup({ links: USER_LINKS });
    await loaded('5');
    await user.click(await screen.findByRole('button', { name: 'この局面を解く（迷い3）' }));
    await screen.findByLabelText('理由（1行）');
    await user.click(screen.getAllByRole('button', { name: /を切る$/ })[2] as HTMLElement);
    await user.type(reasonBox(), '途中の理由');
    // 1 手戻って（盤面を見直して）、また 1 手進む
    await user.click(screen.getByRole('button', { name: '1手戻る' }));
    expect(answeringState()).toBe('browse');
    expect(study.rows).toHaveLength(0);
    await user.click(screen.getByRole('button', { name: '1手進む' }));
    expect(answeringState()).toBe('answering');
    expect(reasonBox()).toHaveValue('途中の理由');
    expect(screen.getAllByRole('button', { name: /を切る$/ })[2]).toHaveAttribute('aria-pressed', 'true');
    expect(screen.getByRole('button', { name: '答え合わせ' })).toBeEnabled();
    // 別の場面の下書きとは混ざらない
    press(arrow('Down', true));
    expect(reasonBox()).toHaveValue('');
  });

  it('答えるまでの時間は、場面を最初に見せたときから数える（途中で離れても、続きから）', async () => {
    vi.useRealTimers();
    vi.useFakeTimers({ toFake: ['Date'] });
    vi.setSystemTime(new Date(2026, 9, 9, 22, 0, 0));
    const { user, study } = setup({ links: USER_LINKS });
    await loaded('5');
    await user.click(await screen.findByRole('button', { name: 'この局面を解く（迷い3）' }));
    await screen.findByLabelText('理由（1行）');
    await user.click(screen.getAllByRole('button', { name: /を切る$/ })[5] as HTMLElement);
    await user.click(screen.getByRole('button', { name: '1手戻る' }));
    vi.setSystemTime(new Date(2026, 9, 9, 22, 1, 30));
    await user.click(screen.getByRole('button', { name: '1手進む' }));
    await user.type(reasonBox(), '理由');
    await user.click(screen.getByRole('button', { name: '答え合わせ' }));
    await revealed();
    expect(study.rows[0]!.duration_ms).toBeGreaterThanOrEqual(90_000);
  });
});

describe('E-26・R10-4 「AI の1位と違う判断も、不一致として出す」', () => {
  it('切（既定）: 不一致は大きな不一致 5 か所。印は丸 6 とひし形 5 だけ', async () => {
    const { user } = setup({ links: USER_LINKS });
    await loaded('5');
    await openReplay(user);
    expect(document.querySelector('.jump[data-kind="mismatch"]')).toHaveTextContent('大きな不一致 5か所');
    expect(document.querySelectorAll('.pin.mis')).toHaveLength(5);
    expect(document.querySelectorAll('.pin.small')).toHaveLength(0);
    expect(sceneRows()).toHaveLength(10);
  });

  it('入: AI の1位と違う判断すべて（FX-4 は 8）が不一致の場面になる。増えた分は小さなひし形・一覧に「不一致」。↑ ↓ もそこに止まる', async () => {
    const { user } = setup({ links: USER_LINKS, settings: { show_all_mismatches: true } });
    await loaded('5');
    await openReplay(user);
    expect(document.querySelector('.jump[data-kind="mismatch"]')).toHaveTextContent('不一致 8か所');
    expect(document.querySelectorAll('.pin.mis')).toHaveLength(8);
    expect(document.querySelectorAll('.pin.mis.small')).toHaveLength(3);
    expect(document.querySelectorAll('.pin.dbt')).toHaveLength(6);
    // 迷いの数は変わらない。場面は、10 から増える（増えた 3 つのうち、迷いと重なるものは増えない）
    expect(sceneRows().length).toBeGreaterThan(10);
    const tags = sceneRows().flatMap((row) => [...row.querySelectorAll('.tag')].map((tag) => tag.textContent));
    expect(tags.filter((tag) => tag === '大きな不一致')).toHaveLength(5);
    expect(tags.filter((tag) => tag === '不一致')).toHaveLength(3);
    // ↓ で、8 か所すべてに止まる（半荘の順）
    const seen: string[] = [];
    for (let i = 0; i < 8; i += 1) {
      press(arrow('Down'));
      seen.push(`${pos()}|${title()}`);
    }
    expect(new Set(seen).size).toBe(8);
    const before = pos();
    press(arrow('Down'));
    expect(pos()).toBe(before);
    // 増えた分の場面でも、答えられる（答える前は、AI の情報は無い）
    const extra = document.querySelector<HTMLElement>('.pin.mis.small');
    await user.click(extra as HTMLElement);
    expect(answeringState()).toBe('answering');
    expect(chips().at(-1)).toBe('不一致');
    expect(document.querySelector('[data-ai]')).toBeNull();
    expect(screen.getByRole('button', { name: '答え合わせ' })).toBeDisabled();
  });

  it('出題の基準（今日の出題・残りの問題の数）は、この設定では変わらない', async () => {
    const { user } = setup({ settings: { show_all_mismatches: true } });
    await loaded('5');
    await user.click(sideButton(/^今日の出題/));
    await screen.findByRole('heading', { level: 1, name: '今日の出題' });
    expect(within(document.querySelector('details.qrest') as HTMLElement).getByText('残り23問')).toBeInTheDocument();
  });
});

describe('U-19 ドラを目立たせる（通して見る画面）', () => {
  /** その手の盤面で、手牌（ツモ牌を含む）のうち、ドラ表示牌が指す牌の枚数。 */
  const doraInHand = (g: number): number => {
    const { hand, drawn, doraMarkers } = timeline.steps[g]!.board;
    const kinds = doraKinds(doraMarkers);
    return [...hand, ...(drawn === null ? [] : [drawn])].filter((tile) => kinds.has(tileKind(tile))).length;
  };
  // FX-4 東2局1本場 6巡目（迷い 3）: 手牌に、ドラ表示牌が指す 3p がある
  const KEY = 'k1h1e6';

  it('切（既定）: 場面でも、盤面を見ているだけの手でも、どの牌にも is-dora は付かない', async () => {
    const { user } = setup({ links: USER_LINKS });
    await loaded('5');
    await openReplay(user);
    await user.click(document.querySelector(`.pin[data-key="${KEY}"]`) as HTMLElement);
    expect(answeringState()).toBe('answering');
    expect(document.querySelector('.qz')?.getAttribute('data-dora')).toBe('off');
    expect(boardTiles('.is-dora')).toHaveLength(0);
    press(COMMA);
    expect(answeringState()).toBe('browse');
    expect(document.querySelector('.qz')?.getAttribute('data-dora')).toBe('off');
    expect(boardTiles('.is-dora')).toHaveLength(0);
  });

  it('入: ドラ表示牌が指す牌にだけ is-dora が付く（手牌は枚数も一致）。鳴かれた牌とドラ表示牌には付けない。付いた牌は「（ドラ）」と読み上げる', async () => {
    const { user } = setup({ links: USER_LINKS, settings: { highlight_dora: true } });
    await loaded('5');
    await openReplay(user);
    await user.click(document.querySelector(`.pin[data-key="${KEY}"]`) as HTMLElement);
    const g = stepOf(KEY);
    expect(doraInHand(g)).toBeGreaterThan(0);
    // 場面（答える画面）
    expect(answeringState()).toBe('answering');
    expect(document.querySelector('.qz')?.getAttribute('data-dora')).toBe('on');
    expect(document.querySelectorAll('.hand .tile-btn.is-dora')).toHaveLength(doraInHand(g));
    // 盤面を見ているだけの手（1 手前）
    press(COMMA);
    expect(answeringState()).toBe('browse');
    expect(document.querySelector('.qz')?.getAttribute('data-dora')).toBe('on');
    expect(document.querySelectorAll('.hand .is-dora')).toHaveLength(doraInHand(g - 1));
    const tinted = boardTiles('.is-dora');
    expect(tinted.length).toBeGreaterThan(0);
    expect(tinted.some((tile) => tile.classList.contains('called'))).toBe(false);
    expect(document.querySelector('.dora-t .is-dora, .info-strip .is-dora')).toBeNull();
    for (const tile of tinted) {
      const label = tile.getAttribute('aria-label') ?? tile.querySelector('img')?.getAttribute('alt') ?? '';
      expect(label).toMatch(/（ドラ）/);
    }
  });
});

describe('U-35 他家の手牌（通して見る画面。R15-5・R16-7: 盤面の手牌を押すと、3 人分が開く。答える場面は、答えるまで押せない）', () => {
  const handButtons = () => [...document.querySelectorAll<HTMLButtonElement>('.ohand')];
  const block = () => document.querySelector('[data-open-hands="block"]');
  const rows = () => [...document.querySelectorAll<HTMLElement>('.oh-row')];
  /** 盤面に出ている他家の手牌の、人ごとの（表の牌の数・ツモ牌の数）。下家・対面・上家の順。 */
  const shown = () =>
    ['right', 'top', 'left'].map((position) => {
      const zone = document.querySelector(`.hzone.${position}`) as HTMLElement;
      return { faces: zone.querySelectorAll('.tile img').length, drawn: zone.querySelectorAll('.hdraw').length };
    });
  /** 盤面の裏向きの牌の数（人ごと）。 */
  const backs = () => ['right', 'top', 'left'].map((position) => document.querySelectorAll(`.hzone.${position} .tile.back`).length);
  /** エンジンから求めた、その手の他家の手牌（画面と別の経路）。 */
  const expected = (g: number) => {
    const step = timeline.steps[g]!;
    return openHandsAt(fx4, step.kyokuPosition, step.eventIndex).map((seat) => ({ faces: seat.hand.length + (seat.drawn === null ? 0 : 1), drawn: seat.drawn === null ? 0 : 1 }));
  };
  const noFaceUp = () => {
    expect(block()).toBeNull();
    expect(document.querySelector('.oh-list, .oh-row, .oh-hand, .tile.tp, .tp-line, .shchart, .tk, .tl-note')).toBeNull();
    expect(shown().every((s) => s.faces === 0)).toBe(true);
    for (const button of handButtons()) expect(button.querySelectorAll('img')).toHaveLength(0);
    expect(document.body.textContent).not.toMatch(/聴牌していません|切る前の手|に聴牌（|他家が聴牌になった/);
  };
  /** 東1局の終わりの手の通し番号。 */
  const kyokuEnd = () => timeline.kyokus[0]!.last;
  const press1 = async (user: ReturnType<typeof userEvent.setup>, at = 0) => user.click(handButtons()[at] as HTMLElement);

  it('操作の段に「他家の手牌を開く」のボタン・説明のアイコンは無い。盤面の他家 3 人の手牌（裏向き）が、押せるボタンとして、凡例の下の 1 行つきである。既定は閉じている', async () => {
    const { user } = setup({ links: USER_LINKS });
    await loaded('5');
    await openReplay(user);
    const bar = document.querySelector('.pbar') as HTMLElement;
    expect(within(bar).queryByRole('button', { name: /他家の手牌/ })).toBeNull();
    expect(bar.querySelector('#b-openhands, .pb-open')).toBeNull();
    expect(handButtons()).toHaveLength(3);
    for (const button of handButtons()) {
      expect(button).toBeEnabled();
      expect(button).toHaveAccessibleName('他家の手牌を開く');
      expect(button.closest('.pbar')).toBeNull();
    }
    expect(document.querySelector('.hands-hint')?.textContent).toBe('他家の手牌は、押すと3人とも開きます（もう一度押すと閉じます）');
    noFaceUp();
    // 配牌の盤面: 全員 13 枚の裏向き
    expect(backs()).toEqual([13, 13, 13]);
  });

  it('1 人の手牌を押すと、他家 3 人（下家・対面・上家）の手牌が開く。もう一度押すと、3 人分が閉じる。河を押しても開かない', async () => {
    const { user } = setup({ links: USER_LINKS });
    await loaded('5');
    await openReplay(user);
    await user.click(document.querySelector('.zone.top .river') as HTMLElement);
    await user.click(document.querySelector('.zone.left .river') as HTMLElement);
    noFaceUp();
    await press1(user, 1);
    for (const button of handButtons()) {
      expect(button).toHaveAccessibleName('他家の手牌を閉じる');
      expect(button).toHaveAttribute('aria-pressed', 'true');
    }
    expect(rows().map((row) => row.querySelector('.oh-hd b')?.textContent)).toEqual(['下家', '対面', '上家']);
    expect(shown()).toEqual(expected(0));
    await press1(user, 2);
    for (const button of handButtons()) expect(button).toHaveAccessibleName('他家の手牌を開く');
    noFaceUp();
  });

  it('開いたまま手を進めても、開いたまま。その手の他家の手牌に替わる（巡目・局をまたいでも）。「他家の手牌」の欄は、右の欄の上', async () => {
    const { user } = setup({ links: USER_LINKS });
    await loaded('5');
    await openReplay(user);
    await press1(user);
    const snapshots = new Set<string>();
    for (let g = 0; g < 14; g++) {
      expect(handButtons()[0], `手 ${g}`).toHaveAccessibleName('他家の手牌を閉じる');
      expect(shown(), `手 ${g}`).toEqual(expected(g));
      snapshots.add(JSON.stringify(shown()) + rows().map((row) => row.textContent).join('|'));
      press(PERIOD);
      // 場面の手は、答える場面なので、この範囲には無い
      expect(answeringState()).toBe('browse');
    }
    // 手を進めると、他家の手牌の欄も動く（同じ表示のままではない）
    expect(snapshots.size).toBeGreaterThan(5);
    // 右の欄の上に、他家の手牌の欄（下の「いまの一手」の前）
    const answer = document.querySelector('section.answer') as HTMLElement;
    expect(answer.firstElementChild).toBe(block());
    // 局の終わり・次の局の頭
    await user.click(screen.getByRole('button', { name: '局の終わりへ' }));
    expect(shown()).toEqual(expected(kyokuEnd()));
    expect(nowText()).toBe('この局が終わりました');
    press(PERIOD);
    expect(handButtons()[0]).toHaveAccessibleName('他家の手牌を閉じる');
    expect(shown()).toEqual(expected(kyokuEnd() + 1));
  });

  it('キーボード: 手牌のボタンは Enter・Space で開閉できる（フォーカスは、そのボタンのまま）', async () => {
    const { user } = setup({ links: USER_LINKS });
    await loaded('5');
    await openReplay(user);
    handButtons()[1]?.focus();
    await user.keyboard('{Enter}');
    expect(block()).not.toBeNull();
    expect(handButtons()[1]).toHaveFocus();
    await user.keyboard(' ');
    expect(block()).toBeNull();
    expect(handButtons()[1]).toHaveFocus();
    await user.keyboard('{Enter}');
    expect(handButtons()[1]).toHaveAttribute('aria-pressed', 'true');
  });

  it('答える場面（迷い・不一致）では、答えるまで押せず、表の牌は DOM にも出ない（開いたまま着いても）。答えると押せて、開いたままなら出る。答え合わせのタブに「他家の手牌」は無い', async () => {
    const { user, study } = setup({ links: USER_LINKS });
    await loaded('5');
    await openReplay(user);
    await press1(user);
    expect(block()).not.toBeNull();
    // 場面へ飛ぶ（迷い 3。答える前）
    await user.click(document.querySelector('.pin[data-key="k1h1e7"]') as HTMLElement);
    expect(answeringState()).toBe('answering');
    for (const button of handButtons()) {
      expect(button).toBeDisabled();
      expect(button).toHaveAccessibleName('他家の手牌を開く');
    }
    noFaceUp();
    expect(document.querySelector('.hands-hint')).toBeNull();
    // 答えるまで、選んだだけ・理由を書いただけでも出ない
    await user.click(screen.getAllByRole('button', { name: /を切る$/ })[0] as HTMLElement);
    await user.type(reasonBox(), '孤立牌を切る');
    for (const button of handButtons()) expect(button).toBeDisabled();
    noFaceUp();
    await user.click(screen.getByRole('button', { name: '答え合わせ' }));
    await revealed();
    expect(study.rows).toHaveLength(1);
    // 答えたあと: 押せる。開いたままなので、盤面に表向きで出て、欄が出る（答えの欄の上）。タブには出ない
    for (const button of handButtons()) {
      expect(button).toBeEnabled();
      expect(button).toHaveAccessibleName('他家の手牌を閉じる');
    }
    const g = stepOf('k1h1e7');
    expect(block()).not.toBeNull();
    expect(shown()).toEqual(expected(g));
    expect(screen.queryAllByRole('tab').map((tab) => tab.textContent)).not.toContain('他家の手牌');
    expect(document.querySelector('.hands-hint')).not.toBeNull();
    // 閉じる・開く
    await press1(user, 2);
    expect(block()).toBeNull();
    for (const button of handButtons()) expect(button).toHaveAccessibleName('他家の手牌を開く');
    await press1(user, 0);
    expect(block()).not.toBeNull();
    // 1 手戻っても、開いたまま
    press(COMMA);
    expect(answeringState()).toBe('browse');
    expect(handButtons()[0]).toHaveAccessibleName('他家の手牌を閉じる');
    expect(shown()).toEqual(expected(g - 1));
  });

  it('開く前に着いた答える場面は、答えるまで開けない。答えたあとに開くと、出る。答えていない次の場面へ移ると、また出なくなる', async () => {
    const { user } = setup({ links: USER_LINKS });
    await loaded('5');
    await openReplay(user);
    await user.click(document.querySelector('.pin[data-key="k1h1e7"]') as HTMLElement);
    for (const button of handButtons()) expect(button).toBeDisabled();
    noFaceUp();
    await user.click(screen.getAllByRole('button', { name: /を切る$/ })[0] as HTMLElement);
    await user.type(reasonBox(), '孤立牌を切る');
    await user.click(screen.getByRole('button', { name: '答え合わせ' }));
    await revealed();
    expect(block()).toBeNull();
    await press1(user);
    expect(shown()).toEqual(expected(stepOf('k1h1e7')));
    // 次の場面（答えていない）へ
    await user.click(screen.getByRole('button', { name: /^次の不一致へ/ }));
    expect(answeringState()).toBe('answering');
    for (const button of handButtons()) expect(button).toBeDisabled();
    noFaceUp();
  });

  it('この画面を離れると、閉じに戻る（開いたまま、半荘のページへ戻って、また通して見る画面を開くと、閉じている）', async () => {
    const { user } = setup({ links: USER_LINKS });
    await loaded('5');
    await openReplay(user);
    await press1(user);
    expect(block()).not.toBeNull();
    press({ code: 'ArrowLeft', key: 'ArrowLeft', altKey: true });
    await user.click(await screen.findByRole('button', { name: 'この半荘を通して見る' }));
    await screen.findByRole('region', { name: '半荘を進める' });
    for (const button of handButtons()) expect(button).toHaveAccessibleName('他家の手牌を開く');
    noFaceUp();
  });
});

describe('U-38 他家が聴牌した巡目（通して見る画面。R16-7 の A）: 開いているときだけ、枠・凡例・1 行・折れ線・位置の帯の目盛りが出る', () => {
  const handButtons = () => [...document.querySelectorAll<HTMLButtonElement>('.ohand')];
  const allMarks = () =>
    fx4.kyokus.flatMap((kyoku) => opponentTracksOf(fx4, kyoku.position).seats.flatMap((track) => track.marks.map((mark) => ({ kyoku: kyoku.position, seat: track.seat, ...mark }))));
  const ticks = () => [...document.querySelectorAll<HTMLElement>('.tl-track .tk')];

  it('閉じているときは、どれも DOM に無い（枠・凡例の項目・1 行・折れ線・位置の帯の目盛りと、その 1 行）。開くと出て、閉じると消える', async () => {
    const { user } = setup({ links: USER_LINKS });
    await loaded('5');
    await openReplay(user);
    await user.click(screen.getByRole('button', { name: '局の終わりへ' }));
    const none = () => {
      expect(document.querySelector('.tile.tp, .tp-line, .shchart, .tk, .tl-note')).toBeNull();
      expect(document.querySelector('.legend .tile.tp')).toBeNull();
      expect([...document.querySelectorAll<HTMLImageElement>('.river img')].some((img) => img.alt.includes('聴牌になった打牌'))).toBe(false);
    };
    none();
    await user.click(handButtons()[0] as HTMLElement);
    // 枠: 東1局の、局の終わりまでの印（河の位置 n - 1）
    const endEvent = timeline.steps[timeline.kyokus[0]!.last]!.eventIndex;
    const here = allMarks().filter((mark) => mark.kyoku === 0 && mark.eventIndex <= endEvent);
    expect(here.length).toBeGreaterThan(0);
    expect(document.querySelectorAll('.river .tile.tp')).toHaveLength(here.length);
    expect(document.querySelector('.legend .tile.tp')).not.toBeNull();
    // 1 行と折れ線（3 人分）
    expect(document.querySelectorAll('.oh-row .tp-line')).toHaveLength(3);
    expect(document.querySelectorAll('.oh-row .shchart')).toHaveLength(3);
    // 位置の帯の目盛り: 半荘の全部の印の数。この局のものは cur
    expect(ticks()).toHaveLength(allMarks().length);
    expect(ticks().filter((tick) => tick.classList.contains('cur'))).toHaveLength(allMarks().filter((mark) => mark.kyoku === 0).length);
    const note = document.querySelector('.tl-note') as HTMLElement;
    expect(note.textContent).toContain(`この半荘で ${allMarks().length} か所`);
    expect(note.textContent).toMatch(/この局: .*\d巡目/);
    for (const tick of ticks()) expect(tick).toHaveAttribute('aria-hidden', 'true');
    // 閉じると、また消える
    await user.click(handButtons()[1] as HTMLElement);
    none();
  });

  it('枠と 1 行は「いまの手まで」。聴牌になった打牌の手に着くと出て、1 手戻ると消える（まだ聴牌していません → N巡目に聴牌）', async () => {
    const { user } = setup({ links: USER_LINKS });
    await loaded('5');
    await openReplay(user);
    await user.click(handButtons()[0] as HTMLElement);
    const mark = allMarks().find((m) => m.kyoku === 0) as ReturnType<typeof allMarks>[number];
    const g = timeline.steps.find((s) => s.eventIndex === mark.eventIndex)!.index;
    const markedUpTo = (which: number) => allMarks().filter((m) => m.kyoku === 0 && m.eventIndex <= timeline.steps[which]!.eventIndex).length;
    // その 1 手前まで進める
    await user.click(screen.getByRole('button', { name: '局の頭へ' }));
    for (let at = 0; at < g - 1; at++) press(PERIOD);
    expect(pos()).toBe(posAt(g - 1));
    expect(document.querySelectorAll('.river .tile.tp')).toHaveLength(markedUpTo(g - 1));
    const lineOf = (seat: number) => document.querySelector(`.oh-row[data-seat="${seat}"] .tp-line`)?.textContent ?? '';
    const before = lineOf(mark.seat);
    expect(before).not.toMatch(new RegExp(`^(再び)?${mark.n}巡目に聴牌（`));
    // その手
    press(PERIOD);
    expect(pos()).toBe(posAt(g));
    expect(markedUpTo(g)).toBe(markedUpTo(g - 1) + 1);
    expect(document.querySelectorAll('.river .tile.tp')).toHaveLength(markedUpTo(g));
    expect(lineOf(mark.seat)).toMatch(new RegExp(`^(再び)?${mark.n}巡目に聴牌（`));
    // 戻ると、また元の 1 行・枠
    press(COMMA);
    expect(lineOf(mark.seat)).toBe(before);
    expect(document.querySelectorAll('.river .tile.tp')).toHaveLength(markedUpTo(g - 1));
  });

  it('答える場面の答える前は、開いたままでも、枠・1 行・折れ線・位置の帯の目盛りも出ない（聴牌の情報は、他家の手牌と同じに、答えるまで隠す）', async () => {
    const { user } = setup({ links: USER_LINKS });
    await loaded('5');
    await openReplay(user);
    await user.click(handButtons()[0] as HTMLElement);
    expect(ticks().length).toBeGreaterThan(0);
    await user.click(document.querySelector('.pin[data-key="k1h1e7"]') as HTMLElement);
    expect(answeringState()).toBe('answering');
    expect(document.querySelector('.tile.tp, .tp-line, .shchart, .tk, .tl-note')).toBeNull();
    expect(document.querySelector('.legend .tile.tp')).toBeNull();
    await user.click(screen.getAllByRole('button', { name: /を切る$/ })[0] as HTMLElement);
    await user.type(reasonBox(), '孤立牌を切る');
    await user.click(screen.getByRole('button', { name: '答え合わせ' }));
    await revealed();
    expect(ticks().length).toBe(allMarks().length);
    expect(document.querySelectorAll('.oh-row .tp-line')).toHaveLength(3);
  });
});
