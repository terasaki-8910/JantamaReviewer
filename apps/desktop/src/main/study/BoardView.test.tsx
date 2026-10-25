/**
 * 盤面の作業（出題・解き直しの画面）の試験:
 * - U-43 AI の評価の棒（打牌の判断。手牌の上）: 答え合わせのあとだけ。高さ・数字・読み上げの一覧。右の欄の一覧は、打牌の判断では出さない（棒の出ない過去の盤面の間だけは出す）
 * - U-44・U-50 王牌の列とドラ表示牌（卓の中央の箱）、フェルトの卓に名札が無いこと
 * - U-47 答える前の欄の、場面の情報の 1 行（巡目・向聴数・他家の立直）
 * - 盤面の見方（卓の上の右端の説明のアイコン。凡例と「過去の盤面」の旗）
 * 通して見る画面（自分の判断の手番の棒・右の欄の一覧）は、replay/Replay.test.tsx。実ブラウザでの高さ・幅・色は、tests/browser/quiz.browser.test.ts。
 */
import { tileLabel, type BoardState, type Decision, type Tile } from '@jantama/engine';
import { cleanup, render, screen, within } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { answerRow } from '../../../tests/fake-study';
import { revealed } from '../../../tests/reveal';
import { decisionOf, renderQuiz } from '../../../tests/study-harness';
import { Board, boardInfoOf } from './Board';
import { doraOfMarker } from './dora';

/** 試験の「いま」: 2026 年 10 月 9 日 22:00（日付だけ動かす）。 */
beforeEach(() => {
  vi.useFakeTimers({ toFake: ['Date'] });
  vi.setSystemTime(new Date(2026, 9, 9, 22, 0, 0));
});

afterEach(() => {
  cleanup();
  vi.useRealTimers();
});

const handButtons = () => screen.getAllByRole('button', { name: /を切る$/ });
const submit = () => screen.getByRole('button', { name: '答え合わせ' });
const reasonBox = () => screen.getByLabelText('理由（1行）');
/** FX-1 a 東4局 13巡目: ツモ牌は 1s。AI の 1 位は 7s（手牌に 2 枚）。実戦は 3m（手牌に 2 枚）。 */
const drawn = () => screen.getByRole('button', { name: '一索（ツモ牌）を切る' });

async function answer(user: ReturnType<typeof renderQuiz>['user'], pick: () => HTMLElement = drawn) {
  await user.click(pick());
  await user.type(reasonBox(), '受け入れを広く');
  await user.click(submit());
  await revealed();
}

describe('U-43 AI の評価の棒（打牌の判断。手牌の上）', () => {
  const bars = () => [...document.querySelectorAll<HTMLElement>('.hand .ai-bar')];
  const heightOf = (bar: HTMLElement) => bar.style.getPropertyValue('--h');
  const labelsOf = () => bars().map((bar) => bar.querySelector('.ai-num')?.textContent ?? null);
  const sayings = () => [...screen.getByRole('list', { name: 'AIの評価' }).querySelectorAll('li')].map((li) => li.textContent);

  it('答える前は、棒も数字も一覧も DOM に無い。棒の帯と印の行は、答える前から取ってある（打牌の判断の手牌）', async () => {
    const { user } = renderQuiz();
    expect(bars()).toHaveLength(0);
    expect(screen.queryByRole('list', { name: 'AIの評価' })).toBeNull();
    expect(document.querySelector('.ai-num, .ai-fill, [data-ai]')).toBeNull();
    expect(document.querySelector('.hand-wrap[data-kind="discard"]')).not.toBeNull();
    // 選んだだけ・理由を書いただけの途中でも、出ない
    await user.click(drawn());
    await user.type(reasonBox(), '受け入れを広く');
    expect(bars()).toHaveLength(0);
    expect(document.querySelector('[data-ai]')).toBeNull();
  });

  it('答え合わせのあと、手牌の 1 枚ごとに 1 本。高さは 40px × 確率（0 より大きければ 2px 以上）。AI の 1 位（7s）の 2 枚は強い色の印', async () => {
    const { user } = renderQuiz();
    await answer(user);
    expect(bars()).toHaveLength(14);
    for (const bar of bars()) {
      expect(bar.getAttribute('aria-hidden')).toBe('true');
      expect(bar.getAttribute('data-ai')).toBe('bar');
      expect(bar.closest('.slot')).not.toBeNull();
    }
    // 3m 3m 4m 4m 4m 3p 4p 6p 7p 8p 赤5s 7s 7s と、ツモ牌 1s。7s は 97.7%、1s は 2.3%、ほかはごく小さい確率
    const heights = bars().map(heightOf);
    expect(heights.slice(11, 13)).toEqual(['39px', '39px']);
    expect(heights[13]).toBe('2px');
    expect(heights.slice(0, 11).every((height) => height === '2px')).toBe(true);
    expect(bars().map((bar) => bar.classList.contains('is-top'))).toEqual([...Array(11).fill(false), true, true, false]);
    // ツモ牌の列は、手牌から少し離れている（.slot.draw）。棒も、その列の中
    expect(bars()[13]?.closest('.slot')?.className).toContain('draw');
  });

  it('数字: 確率の上位（7s 97.7%）・自分の答え（ツモ牌 1s 2.3%）・実戦（3m。2 枚のうち左の 1 枚だけ <0.1%）。同じ牌には 1 回だけ', async () => {
    const { user } = renderQuiz();
    await answer(user);
    expect(labelsOf()).toEqual(['<0.1%', null, null, null, null, null, null, null, null, null, null, '97.7%', null, '2.3%']);
  });

  it('自分の答えを替えると、数字の付く牌が替わる（6p を選ぶと、6p に <0.1%）', async () => {
    const { user } = renderQuiz();
    await answer(user, () => screen.getByRole('button', { name: '六筒を切る' }));
    const labels = labelsOf();
    expect(labels[7]).toBe('<0.1%');
    // ツモ牌の 1s は、自分の答えではなくなっても、確率の上位 2 つ目（2.3%）なので、数字が付く
    expect(labels[13]).toBe('2.3%');
    expect(labels[11]).toBe('97.7%');
    expect(labels[0]).toBe('<0.1%');
    expect(labels.filter((label) => label !== null)).toHaveLength(4);
  });

  it('読み上げ用の一覧「AIの評価」: 確率の高い順に「打7s 97.7%」。棒は読み上げず、一覧は手牌の外（手牌は inert のことがある）', async () => {
    const { user } = renderQuiz();
    await answer(user);
    const list = screen.getByRole('list', { name: 'AIの評価' });
    expect(list.getAttribute('data-ai')).toBe('bars-list');
    expect(sayings().slice(0, 3)).toEqual(['打7s 97.7%', '打1s 2.3%', '打6p <0.1%']);
    expect(sayings()).toHaveLength(10);
    expect(list.closest('.hand-wrap')).toBeNull();
    expect(list.className).toContain('sr-only');
  });

  it('右の欄に、AI の評価の一覧は出ない（打牌の判断）。受け入れ枚数・差の原因は出る', async () => {
    const { user } = renderQuiz();
    await answer(user);
    expect(screen.queryByRole('heading', { name: 'AIの評価（Mortal）' })).toBeNull();
    expect(document.querySelector('[data-ai="eval"], [data-ai="candidate"], .bars')).toBeNull();
    expect(screen.getByRole('heading', { name: '受け入れ枚数' })).toBeInTheDocument();
    expect(screen.getByRole('checkbox', { name: '受け入れ枚数' })).toBeInTheDocument();
  });

  it('過去の盤面（前の巡目）では、棒を出さない（その時点の別の手牌のため）。判断の盤面に戻すと、また出る', async () => {
    const { user } = renderQuiz();
    await answer(user);
    await user.click(screen.getByRole('button', { name: /前の巡目/ }));
    expect(bars()).toHaveLength(0);
    expect(screen.queryByRole('list', { name: 'AIの評価' })).toBeNull();
    await user.click(screen.getByRole('button', { name: /次の巡目/ }));
    expect(bars()).toHaveLength(14);
  });

  describe('過去の盤面（前の巡目）では、棒の代わりに、右の欄に評価の一覧を出す', () => {
    /** 右の欄の評価の一覧の行: 印・牌の名前・棒の幅・確率。 */
    const listRows = () =>
      [...document.querySelectorAll<HTMLElement>('#answer [data-ai="candidate"]')].map((row) => ({
        tags: row.querySelector('.btag')?.textContent,
        tile: row.querySelector('.lab img')?.getAttribute('alt'),
        width: (row.querySelector('.fill') as HTMLElement).style.width,
        probability: row.querySelector('.v')?.textContent,
        kind: row.className,
      }));
    const previous = () => screen.getByRole('button', { name: /前の巡目/ });
    const next = () => screen.getByRole('button', { name: /次の巡目/ });

    it('答え合わせのあとに過去の盤面を見ると、一覧が出る（候補ごとの牌・棒・確率と、自分・実戦・AI の印）。判断の盤面に戻すと、一覧は消えて、棒が出る', async () => {
      const { user } = renderQuiz();
      await answer(user);
      // 判断の盤面: 棒だけ。右の欄に一覧は無い
      expect(bars()).toHaveLength(14);
      expect(listRows()).toEqual([]);
      expect(document.querySelector('[data-ai="eval"], .bars')).toBeNull();
      // 過去の盤面: 棒の代わりに、一覧（棒の出ない間も、AI の評価が見られる）
      await user.click(previous());
      expect(bars()).toHaveLength(0);
      const panel = document.querySelector('[data-ai="eval"]') as HTMLElement;
      expect(panel.closest('#answer')).not.toBeNull();
      expect(within(panel).getByRole('heading', { level: 2, name: 'AIの評価（Mortal）' })).toBeInTheDocument();
      // 打牌の判断の形（牌の列が狭い）。確率の高い順に、AI の 1 位（7s）・自分の答え（ツモ牌 1s）・ほかの候補・実戦（3m）
      expect(panel.querySelector('ul.bars')?.classList.contains('call')).toBe(false);
      expect(listRows()).toEqual([
        { tags: 'AI', tile: '七索', width: '97.72%', probability: '97.72%', kind: 'bar top' },
        { tags: '自分', tile: '一索', width: '2.28%', probability: '2.28%', kind: 'bar you' },
        { tags: '', tile: '六筒', width: '0.6%', probability: '<0.01%', kind: 'bar' },
        { tags: '', tile: '七筒', width: '0.6%', probability: '<0.01%', kind: 'bar' },
        { tags: '実戦', tile: '三萬', width: '0.6%', probability: '<0.01%', kind: 'bar act' },
      ]);
      // 判断の盤面に戻すと、一覧は消えて、棒が出る。もう一度過去へ行けば、また出る
      await user.click(next());
      expect(listRows()).toEqual([]);
      expect(document.querySelector('[data-ai="eval"], .bars')).toBeNull();
      expect(bars()).toHaveLength(14);
      await user.click(previous());
      expect(listRows()).toHaveLength(5);
    });

    it('判断の盤面を見ている間は、一覧は出ない（棒だけ）', async () => {
      const { user } = renderQuiz();
      await answer(user);
      expect(bars()).toHaveLength(14);
      expect(listRows()).toEqual([]);
      expect(screen.queryByRole('heading', { name: 'AIの評価（Mortal）' })).toBeNull();
    });

    it('答える前は、過去の盤面を見ても、AI の情報はどこにも出ない（U-1）。選んだだけ・理由を書いただけでも同じ', async () => {
      const { user } = renderQuiz();
      await user.click(drawn());
      await user.type(reasonBox(), '受け入れを広く');
      await user.click(previous());
      expect(screen.getByRole('button', { name: /次の巡目/ })).toBeInTheDocument();
      expect(document.querySelector('.past-flag')).not.toBeNull();
      expect(document.querySelector('[data-ai]')).toBeNull();
      expect(document.querySelector('.bars, .ai-bar, .ai-num')).toBeNull();
      expect(screen.queryByRole('heading', { name: 'AIの評価（Mortal）' })).toBeNull();
      expect(screen.queryByRole('list', { name: 'AIの評価' })).toBeNull();
      expect(document.body.textContent).not.toMatch(/\d\s*%|Mortal/);
    });

    it('解き直しでも、保存してある答えを開いたときでも、過去の盤面では一覧が出る', async () => {
      const review = renderQuiz({ mode: 'review', previousIntervalDays: 3 });
      await answer(review.user);
      await review.user.click(previous());
      expect(bars()).toHaveLength(0);
      expect(listRows()).toHaveLength(5);
      expect(listRows()[0]).toMatchObject({ tags: 'AI', probability: '97.72%' });
      cleanup();
      const user = renderQuiz({
        existing: answerRow({ session_id: 'sess', decision_key: 'k3h0e15', choice: { type: 'dahai', tile: '1s' }, reason: '受け入れを広く' }),
      }).user;
      expect(bars()).toHaveLength(14);
      expect(listRows()).toEqual([]);
      await user.click(previous());
      expect(bars()).toHaveLength(0);
      expect(listRows()).toHaveLength(5);
    });

    it('鳴きの判断は、いつも一覧（過去の盤面でも、判断の盤面でも同じ）', async () => {
      const find = (d: Decision) => d.kind === 'call' && d.kyokuLabel === '東2局1本場' && d.junme === 8;
      const { user } = renderQuiz({ report: 'fx4', find });
      await user.click(screen.getAllByRole('radio')[0] as HTMLElement);
      await user.type(reasonBox(), '役牌');
      await user.click(submit());
      await revealed();
      expect(document.querySelectorAll('[data-ai="candidate"]')).toHaveLength(2);
      await user.click(previous());
      expect(document.querySelectorAll('[data-ai="candidate"]')).toHaveLength(2);
      expect(document.querySelectorAll('ul.bars.call')).toHaveLength(1);
    });
  });

  it('解き直しでも、答え合わせのあとだけ出る', async () => {
    const { user } = renderQuiz({ mode: 'review', previousIntervalDays: 3 });
    expect(bars()).toHaveLength(0);
    expect(document.querySelector('[data-ai]')).toBeNull();
    await answer(user);
    expect(bars()).toHaveLength(14);
    expect(screen.getByRole('list', { name: 'AIの評価' })).toBeInTheDocument();
  });

  it('保存してある答えを開いたとき（答え合わせのあとの形）も、最初から出る', () => {
    renderQuiz({
      existing: answerRow({ session_id: 'sess', decision_key: 'k3h0e15', choice: { type: 'dahai', tile: '1s' }, reason: '受け入れを広く' }),
    });
    expect(bars()).toHaveLength(14);
    expect(bars()[13]?.querySelector('.ai-num')?.textContent).toBe('2.3%');
  });

  it('鳴きの判断は、棒を出さず、右の欄に評価の一覧（ボタンごとの棒）', async () => {
    const find = (d: Decision) => d.kind === 'call' && d.kyokuLabel === '東2局1本場' && d.junme === 8;
    const { user } = renderQuiz({ report: 'fx4', find });
    await user.click(screen.getAllByRole('radio')[0] as HTMLElement);
    await user.type(reasonBox(), '役牌');
    await user.click(submit());
    await revealed();
    expect(bars()).toHaveLength(0);
    expect(screen.queryByRole('list', { name: 'AIの評価' })).toBeNull();
    expect(screen.getByRole('heading', { name: 'AIの評価（Mortal）' })).toBeInTheDocument();
    expect(document.querySelectorAll('[data-ai="candidate"]')).toHaveLength(2);
    // 鳴きの判断の手牌には、棒の帯も印の行も要らない（印は打牌の判断だけ）が、帯は取ってある（盤面の高さは、判断の種類で替わらない）
    expect(document.querySelector('.hand-wrap')?.getAttribute('data-kind')).toBe('call');
  });
});

describe('U-44 ドラ表示牌と王牌の列（卓の中央の箱）', () => {
  /** 盤面のドラ表示牌だけを替えた盤面（牌の種類の変換を、決まった牌で確かめる）。 */
  function boardWith(markers: Tile[]): BoardState {
    return { ...decisionOf('fx1a', { key: 'k3h0e15' }).board, doraMarkers: markers };
  }
  const renderBoard = (markers: Tile[]) => {
    const step = boardWith(markers);
    return render(
      <Board info={boardInfoOf(step, [step])} step={step} dora={null} hands={{ open: false, available: false, seats: null, onToggle: () => undefined }} />,
    );
  };
  const row = () => document.querySelector('.center .dora') as HTMLElement;
  const wall = () => [...row().querySelectorAll('.wall > .tile')];
  const isBack = (tile: Element) => tile.classList.contains('back');
  const faceUpAt = () => wall().flatMap((tile, index) => (isBack(tile) ? [] : [index]));

  it('王牌の列（7 枚）のすぐ右に「→ ドラ [牌]」。読み上げは「ドラ表示牌 4m、ドラ 5m」。牌の絵は個別には読み上げない', () => {
    renderBoard(['4m']);
    expect(row().getAttribute('role')).toBe('group');
    expect(row().getAttribute('aria-label')).toBe('ドラ表示牌 4m、ドラ 5m');
    expect(row().textContent).toBe('→ドラ');
    expect(wall()).toHaveLength(7);
    expect(row().querySelectorAll('.dora-to .dora-t .tile')).toHaveLength(1);
    expect([...row().querySelectorAll('img')].every((img) => img.getAttribute('alt') === '')).toBe(true);
    expect(row().firstElementChild?.className).toBe('wall');
    expect(row().lastElementChild?.className).toBe('dora-to');
    // 中央の箱の中で、狭いときに隠す「.info」の外にある（狭い卓でも出る）
    expect(row().closest('.info')).toBeNull();
    expect(row().parentElement?.className).toBe('center');
  });

  it('ドラ表示牌は左から 3 枚目（添字 2）だけが表向き。ほかの 6 枚は裏向きで、読み上げない', () => {
    renderBoard(['4m']);
    expect(faceUpAt()).toEqual([2]);
    expect(wall()[2]?.querySelector('img')?.getAttribute('src')).toBe('/tiles/Man4.svg');
    for (const [index, tile] of wall().entries()) {
      if (index === 2) continue;
      expect(isBack(tile), `添字 ${index}`).toBe(true);
      expect(tile.querySelector('img'), `添字 ${index}`).toBeNull();
      expect(tile.getAttribute('aria-hidden'), `添字 ${index}`).toBe('true');
    }
    expect(row().querySelector('.wall')?.getAttribute('aria-hidden')).toBe('true');
  });

  it('カンドラ表示牌は 4 枚目から続けて表向きになり、最大 5 枚。残りは裏向き', () => {
    for (const markers of [
      ['N', 'C'],
      ['1m', '5pr', 'E'],
      ['1m', '5pr', 'E', 'S', 'W'],
    ] as Tile[][]) {
      const { unmount } = renderBoard(markers);
      expect(faceUpAt(), markers.join(',')).toEqual(markers.map((_, offset) => 2 + offset));
      expect(wall().filter(isBack), markers.join(',')).toHaveLength(7 - markers.length);
      expect(row().querySelectorAll('.dora-to .dora-t .tile'), markers.join(',')).toHaveLength(markers.length);
      unmount();
    }
  });

  it('牌の種類の変換: 4m→5m、9m→1m、北→東、中→白、赤5m→6m', () => {
    const cases: Array<[Tile, string]> = [
      ['4m', 'ドラ表示牌 4m、ドラ 5m'],
      ['9m', 'ドラ表示牌 9m、ドラ 1m'],
      ['N', 'ドラ表示牌 北、ドラ 東'],
      ['C', 'ドラ表示牌 中、ドラ 白'],
      ['5mr', 'ドラ表示牌 赤5m、ドラ 6m'],
    ];
    for (const [marker, label] of cases) {
      const { unmount } = renderBoard([marker]);
      expect(row().getAttribute('aria-label'), marker).toBe(label);
      unmount();
    }
  });

  it('カンでドラ表示牌が増えれば、読み上げとドラの牌も 1 枚ずつ対応する', () => {
    const { unmount } = renderBoard(['N', 'C']);
    expect(row().getAttribute('aria-label')).toBe('ドラ表示牌 北・中、ドラ 東・白');
    expect(row().querySelectorAll('.dora-to .dora-t .tile')).toHaveLength(2);
    expect(row().getAttribute('data-n')).toBe('2');
    unmount();
    renderBoard(['1m', '5pr', 'E']);
    expect(row().getAttribute('aria-label')).toBe('ドラ表示牌 1m・赤5p・東、ドラ 2m・6p・南');
    expect(row().querySelectorAll('.dora-to .dora-t .tile')).toHaveLength(3);
    expect(row().getAttribute('data-n')).toBe('3');
    expect(row().style.getPropertyValue('--n')).toBe('3');
  });

  it('出題の画面: 実際のドラ表示牌（FX-1 a 西1局の北・中 → 東・白）が中央の箱に出る。卓の上の 1 行（.info-strip）には、ドラ表示牌が無い', () => {
    const decision = decisionOf('fx1a', { find: (d) => d.board.doraMarkers.length >= 2 });
    renderQuiz({ report: 'fx1a', find: (d) => d.index === decision.index });
    const markers = decision.board.doraMarkers;
    const expected = `ドラ表示牌 ${markers.map((tile) => tileLabel(tile)).join('・')}、ドラ ${markers.map((tile) => tileLabel(doraOfMarker(tile))).join('・')}`;
    expect(row().getAttribute('aria-label')).toBe(expected);
    expect(expected).toBe('ドラ表示牌 北・中、ドラ 東・白');
    expect(faceUpAt()).toEqual([2, 3]);
    const strip = document.querySelector('.info-strip') as HTMLElement;
    expect(strip.querySelector('.dora, .dora-t, .tile')).toBeNull();
    expect(strip.textContent).not.toContain('ドラ');
    // 局・本場・残りは、卓の上の 1 行に残る
    expect(strip.textContent).toMatch(/^西1局\d+本場残り\d+枚$/);
  });

  it('設定「ドラを目立たせる」の黄色は、王牌の列にも右のドラの牌にも付けない', () => {
    renderQuiz({ highlightDora: true });
    expect(document.querySelectorAll('.center .dora .is-dora')).toHaveLength(0);
    expect(document.querySelectorAll('.center .dora .tile').length).toBeGreaterThanOrEqual(8);
  });

  it('4 人の風・親・点数・リーチは、名前の要素を足さず、これまでどおり中央の箱の 4 辺にある', () => {
    renderBoard(['4m']);
    const center = document.querySelector('.table .center') as HTMLElement;
    expect(center.querySelectorAll(':scope > .score')).toHaveLength(4);
    expect([...center.querySelectorAll(':scope > .score')].map((score) => score.className)).toEqual(['score top', 'score left', 'score right', 'score bottom me']);
    expect(center.querySelector('.info .round')?.textContent).toBe('東4局');
    expect(center.querySelector('.info .honba')?.textContent).toMatch(/^\d+本場/);
    expect(center.querySelector('.info .rest')?.textContent).toMatch(/^残り\d+枚$/);
    expect(document.querySelector('.table .plate, .table .plates, .table .nm')).toBeNull();
  });

  it('卓の読み上げ名は変わらない', () => {
    renderBoard(['4m']);
    expect(screen.getByRole('group', { name: '卓（4人の河・副露・点数）' })).toBeInTheDocument();
  });
});

describe('U-47 場面の情報の 1 行（答える前の欄）', () => {
  const line = () => document.querySelector('.scene-line') as HTMLElement | null;
  const bolds = () => [...(line()?.querySelectorAll('b') ?? [])].map((b) => b.textContent);

  it('「13巡目 · 1向聴 · 他家の立直なし」。見出しと同じ巡目・向聴数。「自分の答え」の見出しの上、欄の最初', () => {
    renderQuiz();
    expect(line()?.textContent).toBe('13巡目 · 1向聴 · 他家の立直なし');
    expect(screen.getByRole('heading', { level: 1, name: '東4局 13巡目' })).toBeInTheDocument();
    expect(screen.getByText('1向聴', { selector: '.q-chip' })).toBeInTheDocument();
    const heading = screen.getByRole('heading', { level: 2, name: '自分の答え' });
    expect(line()?.compareDocumentPosition(heading)).toBe(Node.DOCUMENT_POSITION_FOLLOWING);
    expect(document.querySelector('#answer-form')?.firstElementChild).toBe(line());
    // 数は濃い色の印（b）、そのほかは静かな色
    expect(bolds()).toEqual(['13', '1']);
  });

  it('AI の情報は入れない（確率・順位・data-ai・実戦の行動）', () => {
    renderQuiz();
    expect(line()?.textContent).not.toMatch(/\d\s*%|Mortal|AI|実戦/);
    expect(line()?.querySelector('[data-ai]')).toBeNull();
    expect(document.querySelector('[data-ai]')).toBeNull();
  });

  it('聴牌は「聴牌」。他家が立直していれば「上家が立直（9巡目）」（FX-4 東1局 14巡目）', () => {
    renderQuiz({ report: 'fx4', key: 'k0h0e15' });
    expect(line()?.textContent).toBe('14巡目 · 聴牌 · 上家が立直（9巡目）');
    expect(bolds()).toEqual(['14', '聴牌', '上家', '9']);
  });

  it('立直が 2 人なら、全員（下家・対面・上家の順に「・」でつなぐ）。N巡目は、その人の宣言牌が河の何枚目か', () => {
    renderQuiz({ report: 'fx1c', key: 'k1h0e19' });
    expect(line()?.textContent).toBe('16巡目 · 1向聴 · 下家が立直（15巡目）・対面が立直（8巡目）');
  });

  it('立直が無ければ「他家の立直なし」（聴牌でも）', () => {
    renderQuiz({ report: 'fx4', key: 'k1h1e11' });
    expect(line()?.textContent).toBe('9巡目 · 聴牌 · 他家の立直なし');
  });

  it('鳴きの判断でも出る。答えのボタンの上', () => {
    renderQuiz({ report: 'fx1a', key: 'k5h1e8' });
    expect(line()?.textContent).toBe('7巡目 · 3向聴 · 対面が立直（3巡目）');
    const choices = document.querySelector('.q-choices') as HTMLElement;
    expect(line()?.compareDocumentPosition(choices)).toBe(Node.DOCUMENT_POSITION_FOLLOWING);
    expect(document.querySelector('#answer-form')?.firstElementChild).toBe(line());
  });

  it('解き直しの答える前の欄にも出る（実戦の行動は出さないまま）。答え合わせのあとは、出ない', async () => {
    const { user } = renderQuiz({ mode: 'review', previousIntervalDays: 3 });
    expect(line()?.textContent).toBe('13巡目 · 1向聴 · 他家の立直なし');
    expect(screen.queryByText(/実戦/)).toBeNull();
    await answer(user);
    expect(line()).toBeNull();
  });

  it('過去の盤面（前の巡目）を見ていても、場面の巡目・向聴数のまま', async () => {
    const { user } = renderQuiz();
    await user.click(screen.getByRole('button', { name: /前の巡目/ }));
    expect(line()?.textContent).toBe('13巡目 · 1向聴 · 他家の立直なし');
  });
});

describe('盤面の見方（卓の上の右端の説明のアイコン）', () => {
  it('凡例は、卓の下ではなく、説明のアイコンの重なりの中。アイコンの名前は「盤面の見方」。押すと凡例が出る', async () => {
    const { user } = renderQuiz();
    const tools = document.querySelector('.board-col > .board-tools') as HTMLElement;
    expect(tools).not.toBeNull();
    // 卓より前（上）にある
    expect(tools.compareDocumentPosition(document.querySelector('.table-wrap') as HTMLElement)).toBe(Node.DOCUMENT_POSITION_FOLLOWING);
    expect(document.querySelector('.board-col > .legend, .board-col > .hands-hint')).toBeNull();
    const button = within(tools).getByRole('button', { name: '盤面の見方' });
    const pop = document.querySelector('.legend-pop') as HTMLElement;
    expect(pop.hasAttribute('hidden')).toBe(true);
    await user.click(button);
    expect(pop.hasAttribute('hidden')).toBe(false);
    expect([...pop.querySelectorAll('.legend li')].map((li) => li.textContent)).toContain('ツモ切り');
    // 「ドラ」の見本は、設定「ドラを目立たせる」が切のとき出さない
    expect(pop.querySelector('.lg-dora')).toBeNull();
  });

  it('「過去の盤面」の旗は、見ているときだけ、説明の外に文字で出る', async () => {
    const { user } = renderQuiz();
    expect(document.querySelector('.past-flag')).toBeNull();
    await user.click(screen.getByRole('button', { name: /前の巡目/ }));
    const flag = document.querySelector('.board-tools > .past-flag') as HTMLElement;
    expect(flag.textContent).toBe('過去の盤面');
    expect(flag.closest('.legend-pop')).toBeNull();
    await user.click(screen.getByRole('button', { name: /次の巡目/ }));
    expect(document.querySelector('.past-flag')).toBeNull();
  });
});

describe('手牌の一覧（棒の帯を足したあとも）', () => {
  it('手牌の牌のボタンは、これまでどおり（13 枚 + ツモ牌）。棒の読み上げの一覧は、牌のボタンに混ざらない', () => {
    renderQuiz();
    expect(handButtons()).toHaveLength(14);
  });
});
