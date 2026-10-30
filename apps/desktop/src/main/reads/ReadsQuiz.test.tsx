/**
 * 読み（F23。ACCEPTANCE の U-53・U-1）の、出題・解き直しの画面の試験。
 * 出題の画面（QuizScreen）を、読みのコマンドの偽物（tests/reads-backend.ts）の上で動かす。
 * 判断は FX-4 の 8 巡目（東1局。牌譜の位置 88。下家・対面・上家のうち、上家がリーチ中に自分が打つ場面）で、読みは本物の出力（reads-fx4.json）。
 * 実ブラウザでの見え方（幅・色・重なり・axe）は、tests/browser/reads.browser.test.ts が確かめる。
 */
import { tileKind, tileLabel, type Decision } from '@jantama/engine';
import { act, fireEvent, screen, waitFor, within } from '@testing-library/react';
import { beforeEach, describe, expect, it, vi } from 'vitest';

import { gameOf } from '../../../tests/fake-study';
import { readsBackend, type ReadsBackendOptions } from '../../../tests/reads-backend';
import { fx4Reads } from '../../../tests/reads-fixtures';
import { revealed } from '../../../tests/reveal';
import { renderQuiz } from '../../../tests/study-harness';
import { installTauriMock } from '../../../tests/tauri-mock';
import type { ReadsProgress } from '../../api/reads';
import { tileName } from '../study/tiles';

vi.mock('@tauri-apps/api/core', () => ({
  invoke: vi.fn(),
  convertFileSrc: (path: string) => path,
}));
vi.mock('@tauri-apps/api/event', () => ({ listen: vi.fn() }));

const real = fx4Reads();
const game = gameOf('fx4');
/** 上家（席 3）がリーチ中に、自分が打つ場面（牌譜の位置 88）。 */
const EVENT = 88;
const isRiichiDecision = (decision: Decision) => decision.eventIndex === EVENT;
const moment = real.moments.find((item) => item.event_index === EVENT)!;
const decision = game.decisions.find(isRiichiDecision)!;
const pct = (probability: number) => Math.round(probability * 100);

/** 読みのコマンド（設定の読み出し `get_settings` は、入切の好みを知るために、答える前から呼ぶ。読みそのものは、答えたあとにだけ）。 */
const COMMANDS = ['read_reads', 'get_reads_model', 'compute_reads', 'set_reads_visible'] as const;

beforeEach(() => {
  vi.useRealTimers();
});

/** 読みのコマンドの偽物を入れて、出題の画面を描く。 */
function open(options: ReadsBackendOptions & { mode?: 'quiz' | 'review'; openModelSettings?: () => void } = {}) {
  const backend = readsBackend({ stored: real, ...options });
  const mock = installTauriMock({ handlers: backend.handlers });
  const view = renderQuiz({
    report: 'fx4',
    find: isRiichiDecision,
    mode: options.mode ?? 'quiz',
    ...(options.openModelSettings === undefined ? {} : { openModelSettings: options.openModelSettings }),
  });
  return { backend, mock, ...view };
}

/** 牌を選び、理由を書き、答え合わせまで進める。 */
async function answer(view: ReturnType<typeof open>) {
  await view.user.click(screen.getAllByRole('button', { name: /を切る$/ }).at(-1) as HTMLElement);
  await view.user.type(screen.getByLabelText('理由（1行）'), '待ちを避けて');
  await view.user.click(screen.getByRole('button', { name: '答え合わせ' }));
  await revealed();
  // 設定を読めると、切り替えが出る（読めるまでは出さない）
  await screen.findByRole('button', { name: '読み' });
}

const toggle = () => screen.getByRole('button', { name: '読み' });
const cells = () => [...document.querySelectorAll<HTMLButtonElement>('.rd-cell')];
const waitForCells = () => waitFor(() => expect(cells().length).toBeGreaterThan(0));
const popover = () => screen.getByRole('dialog', { name: /だれかが待っている確率/ });
const chipOf = (position: 'left' | 'top' | 'right') => document.querySelector<HTMLElement>(`.score.${position} .rd-tp`);

describe('U-1・U-53 答える前は、読みの切り替えも数も札も DOM に無く、読みのコマンドも呼ばない', () => {
  for (const mode of ['quiz', 'review'] as const) {
    it(`${mode === 'quiz' ? '出題' : '解き直し'}: 答える前（牌を選び、理由を書いたあとも）は、どこにも無い。設定が「入」でも同じ`, async () => {
      const view = open({ visible: true, mode });
      const absent = () => {
        expect(screen.queryByRole('button', { name: '読み' })).toBeNull();
        expect(screen.queryByRole('button', { name: '読みの説明' })).toBeNull();
        expect(document.querySelector('.rd-cell, .rd-tp, .reads-group, .rd-status, #rdpop')).toBeNull();
        expect(document.querySelector('[data-ai]')).toBeNull();
        expect(document.body.textContent).not.toMatch(/\d\s*%|Mortal/);
        expect(document.body.textContent).not.toContain('だれかが待っている確率');
        for (const command of COMMANDS) expect(view.mock.count(command), command).toBe(0);
      };
      absent();
      await view.user.click(screen.getAllByRole('button', { name: /を切る$/ }).at(-1) as HTMLElement);
      await view.user.type(screen.getByLabelText('理由（1行）'), '待ちを避けて');
      absent();
      // 手牌は、答えの牌を選ぶボタンのまま（数の帯も、読みの数の押せる部品も無い）
      expect(screen.getAllByRole('button', { name: /を切る$/ }).length).toBeGreaterThan(0);
    });
  }

  it('答え合わせのあとに、切り替えが出る。そのとき初めて、設定と読みを読む', async () => {
    const view = open({ visible: true });
    await answer(view);
    expect(toggle()).toHaveAttribute('aria-pressed', 'true');
    await waitForCells();
    expect(view.mock.count('read_reads')).toBe(1);
    expect(view.mock.count('get_settings')).toBeGreaterThanOrEqual(1);
    // 解き直しも、答え合わせのあとに出る
  });

  it('解き直し: 答え合わせのあとに、切り替えと読みが出る', async () => {
    const view = open({ visible: true, mode: 'review' });
    await answer(view);
    expect(toggle()).toHaveAttribute('aria-pressed', 'true');
    await waitForCells();
    expect(cells().length).toBe(decision.board.hand.length + (decision.board.drawn === null ? 0 : 1));
  });
});

describe('U-53 切り替え: 設定から始まり、押すと保存し、キーでも切り替わる', () => {
  it('設定に項目が無ければ切で始まる。切のあいだは、読みを読まない。押すと保存して数が出て、もう一度押すと消える', async () => {
    const view = open();
    await answer(view);
    expect(toggle()).toHaveAttribute('aria-pressed', 'false');
    expect(toggle().querySelector('svg')).toBeNull();
    expect(cells()).toHaveLength(0);
    expect(view.mock.count('read_reads')).toBe(0);
    await view.user.click(toggle());
    expect(toggle()).toHaveAttribute('aria-pressed', 'true');
    expect(view.mock.calls().filter((call) => call.cmd === 'set_reads_visible').map((call) => call.args)).toEqual([{ visible: true }]);
    await waitForCells();
    expect(chipOf('left')).not.toBeNull();
    await view.user.click(toggle());
    expect(toggle()).toHaveAttribute('aria-pressed', 'false');
    expect(view.mock.calls().filter((call) => call.cmd === 'set_reads_visible').map((call) => call.args)).toEqual([{ visible: true }, { visible: false }]);
    expect(cells()).toHaveLength(0);
    expect(chipOf('left')).toBeNull();
    // 入れ直しても、読みは読み直さない（この画面の間は覚えている）
    await view.user.click(toggle());
    await waitForCells();
    expect(view.mock.count('read_reads')).toBe(1);
  });

  it('保存した値が次の画面でも残る: 入で保存して画面を作り直すと、最初から入（設定の reads_visible から始まる）', async () => {
    const first = open();
    await answer(first);
    await first.user.click(toggle());
    await waitForCells();
    expect(first.backend.state.visible).toBe(true);
    first.unmount();
    // 保存した設定（reads_visible: true）を読んで始まる
    const mock = installTauriMock({ handlers: first.backend.handlers });
    const second = renderQuiz({ report: 'fx4', find: isRiichiDecision });
    await answer({ user: second.user } as ReturnType<typeof open>);
    expect(toggle()).toHaveAttribute('aria-pressed', 'true');
    await waitForCells();
    expect(mock.count('set_reads_visible')).toBe(0);
  });

  it('保存できなかったときは、元に戻して、理由を知らせる（role=alert）', async () => {
    const view = open();
    view.backend.handlers.set_reads_visible = () => {
      throw 'ディスクがいっぱいです';
    };
    await answer(view);
    await view.user.click(toggle());
    expect(await screen.findByRole('alert')).toHaveTextContent('「読み」の入切を保存できませんでした: ディスクがいっぱいです');
    expect(toggle()).toHaveAttribute('aria-pressed', 'false');
    expect(cells()).toHaveLength(0);
  });

  it('キー（既定は R）で切り替わる。答える前は働かない。文字を打つ欄・吹き出しの中・押しっぱなしの繰り返しでは働かない', async () => {
    const view = open();
    const press = (init: { code: string; key: string; repeat?: boolean }) => {
      const target = document.activeElement ?? document.body;
      let accepted = true;
      act(() => {
        accepted = fireEvent.keyDown(target, init);
      });
      return accepted;
    };
    // 答える前: 何も起きない
    press({ code: 'KeyR', key: 'r' });
    expect(view.mock.count('set_reads_visible')).toBe(0);
    // 理由の欄の中でも、働かない
    await view.user.click(screen.getAllByRole('button', { name: /を切る$/ }).at(-1) as HTMLElement);
    await view.user.type(screen.getByLabelText('理由（1行）'), 'r');
    expect(screen.getByLabelText('理由（1行）')).toHaveValue('r');
    expect(view.mock.count('set_reads_visible')).toBe(0);
    await view.user.click(screen.getByRole('button', { name: '答え合わせ' }));
    await revealed();
    await waitFor(() => expect(view.mock.count('get_settings')).toBeGreaterThan(0));
    // 設定のキーの割り当てを読み終えてから
    await waitFor(() => expect(toggle()).toBeInTheDocument());
    (document.activeElement as HTMLElement | null)?.blur();
    press({ code: 'KeyR', key: 'r' });
    await waitForCells();
    expect(toggle()).toHaveAttribute('aria-pressed', 'true');
    press({ code: 'KeyR', key: 'r', repeat: true });
    expect(toggle()).toHaveAttribute('aria-pressed', 'true');
    // 吹き出しの中では、働かない
    await view.user.click(cells()[0] as HTMLElement);
    const dialog = popover();
    expect(dialog).toHaveFocus();
    press({ code: 'KeyR', key: 'r' });
    expect(toggle()).toHaveAttribute('aria-pressed', 'true');
    await view.user.keyboard('{Escape}');
    (document.activeElement as HTMLElement | null)?.blur();
    press({ code: 'KeyR', key: 'r' });
    await waitFor(() => expect(toggle()).toHaveAttribute('aria-pressed', 'false'));
    expect(view.mock.calls().filter((call) => call.cmd === 'set_reads_visible').map((call) => call.args)).toEqual([{ visible: true }, { visible: false }]);
  });

  it('説明のアイコン「読みの説明」に、待たれる確率であること・ロンできるかは含まないこと・モデルの出どころが書いてある', async () => {
    const view = open({ visible: true });
    await answer(view);
    const icon = screen.getByRole('button', { name: '読みの説明' });
    await view.user.click(icon);
    const tip = document.getElementById(icon.getAttribute('aria-describedby') as string) as HTMLElement;
    expect(tip.textContent).toBe(
      '読み: 他家がその牌を待っている確率（3 人のどれか）。ロンできるか（役・フリテン）は含みません。天鳳の鳳凰卓で学習したモデル（hhim8826/mortal3-b40c192）の推定で、外れることもあります。',
    );
  });
});

describe('F23 手牌の下の帯の取り方（画面の根の data-reads）', () => {
  const root = () => document.querySelector('.qz') as HTMLElement;

  it('入切の好みが切の画面は、帯を取らない（これまでと同じ高さ）。入にすると取り、切っても、画面を離れるまで取ったまま', async () => {
    const view = open({ visible: false });
    await waitFor(() => expect(view.mock.count('get_settings')).toBeGreaterThan(0));
    expect(root().getAttribute('data-reads')).toBeNull();
    await answer(view);
    expect(root().getAttribute('data-reads')).toBeNull();
    await view.user.click(toggle());
    await waitForCells();
    expect(root().getAttribute('data-reads')).toBe('on');
    await view.user.click(toggle());
    expect(cells()).toHaveLength(0);
    expect(root().getAttribute('data-reads')).toBe('on');
  });

  it('好みが入の画面は、答える前から帯を取る（答え合わせで卓が動かない）。読みのコマンドは、答えるまで呼ばない', async () => {
    const view = open({ visible: true });
    await waitFor(() => expect(root().getAttribute('data-reads')).toBe('on'));
    expect(view.mock.count('read_reads')).toBe(0);
    expect(document.querySelector('.rd-cell, [data-ai]')).toBeNull();
    await answer(view);
    expect(root().getAttribute('data-reads')).toBe('on');
  });
});

describe('U-53 手牌の牌の下の数と、他家の席の札', () => {
  it('牌ごとに 1 つ、整数の % の数（0.5% 未満は 0）。確率 10% 以上の数は濃い（ink）。帯の長さは確率 25% で全幅。名前は牌ごとの読み上げ', async () => {
    const view = open({ visible: true });
    await answer(view);
    await waitForCells();
    const items = [...decision.board.hand, ...(decision.board.drawn === null ? [] : [decision.board.drawn])];
    expect(cells()).toHaveLength(items.length);
    const buttons = cells();
    items.forEach((tile, index) => {
      const probability = moment.any_wait[tileKind(tile)] as number;
      const cell = buttons[index] as HTMLElement;
      expect(cell.querySelector('.rd-n')?.textContent, tile).toBe(String(pct(probability)));
      expect(cell.getAttribute('aria-label'), tile).toBe(`${tileName(tile)} の読み: だれかが待っている確率 ${pct(probability)}%`);
      expect(cell.classList.contains('is-strong'), tile).toBe(probability >= 0.1);
      const width = (cell.querySelector('.rd-fill') as HTMLElement).style.width;
      expect(Number.parseFloat(width), tile).toBeCloseTo(Math.min(probability / 0.25, 1) * 100, 0);
    });
    // 10% 以上の牌がある（この場面は、リーチ中の上家の待ちが濃い）
    expect(buttons.some((cell) => cell.classList.contains('is-strong'))).toBe(true);
  });

  it('0.5% 未満の牌の数は「0」で、帯は小さい。ちょうど 0.5% なら「1」。10% ちょうどから濃い', async () => {
    const edited = structuredClone(real);
    const at = edited.moments.find((item) => item.event_index === EVENT)!;
    const tiles = [...decision.board.hand, ...(decision.board.drawn === null ? [] : [decision.board.drawn])];
    // 手牌の、重ならない 4 種類の牌に、境の値を入れる
    const kinds = [...new Set(tiles.map((tile) => tileKind(tile)))];
    expect(kinds.length).toBeGreaterThanOrEqual(4);
    const values = [0.004, 0.005, 0.1, 0.0999];
    values.forEach((value, index) => {
      at.any_wait[kinds[index] as number] = value;
    });
    const view = open({ visible: true, stored: edited });
    await answer(view);
    await waitForCells();
    const shownOf = (kind: number) => {
      const cell = cells()[tiles.findIndex((tile) => tileKind(tile) === kind)] as HTMLElement;
      return { n: cell.querySelector('.rd-n')?.textContent, strong: cell.classList.contains('is-strong'), width: (cell.querySelector('.rd-fill') as HTMLElement).style.width };
    };
    expect(shownOf(kinds[0] as number)).toEqual({ n: '0', strong: false, width: '1.6%' });
    expect(shownOf(kinds[1] as number)).toMatchObject({ n: '1', strong: false });
    expect(shownOf(kinds[2] as number)).toEqual({ n: '10', strong: true, width: '40%' });
    expect(shownOf(kinds[3] as number)).toMatchObject({ n: '10', strong: false });
  });

  it('牌の下の数は、牌の絵と別のボタン。手牌の牌（答えのボタン）は、押せないまま。吹き出しは、数を押したときだけ開く', async () => {
    const view = open({ visible: true });
    await answer(view);
    await waitForCells();
    for (const tile of screen.getAllByRole('button', { name: /（.*）$|を切る$/ }).filter((button) => button.classList.contains('tile-btn'))) {
      expect(tile).toBeDisabled();
    }
    expect(document.getElementById('rdpop')).toBeNull();
    await view.user.click(document.querySelector('.hand .tile-btn') as HTMLElement);
    expect(document.getElementById('rdpop')).toBeNull();
  });

  it('他家の席に「聴牌 N%」の札が出る（下家・対面・上家の、それぞれの席に）。名前は全部、文字は中央の箱の幅で隠れる', async () => {
    const view = open({ visible: true });
    await answer(view);
    await waitForCells();
    const byStep = new Map(moment.opponents.map((opponent) => [opponent.step, opponent]));
    const expected = { right: byStep.get(1)!, top: byStep.get(2)!, left: byStep.get(3)! };
    for (const position of ['right', 'top', 'left'] as const) {
      const chip = chipOf(position) as HTMLElement;
      expect(chip, position).not.toBeNull();
      expect(chip.getAttribute('aria-label'), position).toBe(`聴牌 ${pct(expected[position].tenpai)}%`);
      expect(chip.textContent, position).toBe(`聴牌 ${pct(expected[position].tenpai)}%`);
      expect(chip.querySelector('.rd-tp-w')).not.toBeNull();
    }
    expect(chipOf('left')?.getAttribute('aria-label')).toBe('聴牌 100%');
    // 自分の席には札が無い
    expect(document.querySelector('.score.bottom .rd-tp')).toBeNull();
    expect(document.querySelectorAll('.rd-tp')).toHaveLength(3);
  });

  it('過去の盤面（前の巡目）を見ている間は、数も札も出ない（切り替えは残る）。判断の盤面に戻ると、また出る', async () => {
    const view = open({ visible: true });
    await answer(view);
    await waitForCells();
    await view.user.click(screen.getByRole('button', { name: /前の巡目/ }));
    expect(cells()).toHaveLength(0);
    expect(document.querySelector('.rd-tp')).toBeNull();
    expect(toggle()).toHaveAttribute('aria-pressed', 'true');
    await view.user.click(screen.getByRole('button', { name: /次の巡目/ }));
    await waitForCells();
    expect(document.querySelectorAll('.rd-tp')).toHaveLength(3);
  });

  it('読みの場面が無い判断（他家の打牌への鳴きの判断）は、切り替えだけが残り、数も札も出ない', async () => {
    const backend = readsBackend({ stored: real, visible: true });
    const mock = installTauriMock({ handlers: backend.handlers });
    const view = renderQuiz({ report: 'fx4', find: (d) => d.kind === 'call' && !real.moments.some((item) => item.event_index === d.eventIndex) });
    const buttons = screen.getAllByRole('radio');
    await view.user.click(buttons[0] as HTMLElement);
    await view.user.type(screen.getByLabelText('理由（1行）'), '理由');
    await view.user.click(screen.getByRole('button', { name: '答え合わせ' }));
    await revealed();
    await waitFor(() => expect(mock.count('read_reads')).toBe(1));
    expect(toggle()).toHaveAttribute('aria-pressed', 'true');
    expect(cells()).toHaveLength(0);
    expect(document.querySelector('.rd-tp')).toBeNull();
  });
});

describe('U-53 手牌の牌の下の数を押すと吹き出しが出る', () => {
  const nameOf = (step: 1 | 2 | 3) => ({ 1: '下家', 2: '対面', 3: '上家' })[step];
  const opponentOf = (step: 1 | 2 | 3) => moment.opponents.find((opponent) => opponent.step === step)!;
  const cellFor = (tile: string) => cells().find((cell) => cell.getAttribute('aria-label')?.startsWith(`${tileName(tile)} の読み`)) as HTMLButtonElement;

  it('見出しは「牌 だれかが待っている確率 N%」。他家ごとに 1 行（名前・リーチ・聴牌・この牌・守備の目安）が、下家・対面・上家の順に出る', async () => {
    const view = open({ visible: true });
    await answer(view);
    await waitForCells();
    const tile = '5s';
    const kind = tileKind(tile);
    await view.user.click(cellFor(tile));
    const dialog = popover();
    expect(dialog).toHaveFocus();
    expect(cellFor(tile)).toHaveAttribute('aria-expanded', 'true');
    expect(dialog.querySelector('h3')?.textContent).toBe(`だれかが待っている確率 ${pct(moment.any_wait[kind] as number)}%`);
    expect(within(dialog).getByRole('heading', { level: 3 })).toHaveAccessibleName(`${tileName(tile)}だれかが待っている確率 ${pct(moment.any_wait[kind] as number)}%`);
    const lines = [...dialog.querySelectorAll('.rd-opp')];
    expect(lines.map((line) => line.querySelector('.rd-opp-name')?.textContent)).toEqual(['下家', '対面', '上家（リーチ）']);
    for (const step of [1, 2, 3] as const) {
      const header = lines[step - 1]!.querySelector('.rd-opp-h') as HTMLElement;
      const opponent = opponentOf(step);
      const texts = [...header.querySelectorAll('.rd-opp-n')].map((node) => node.textContent);
      expect(texts, nameOf(step)).toEqual([`聴牌 ${pct(opponent.tenpai)}%`, `この牌 ${pct(opponent.waits[kind] as number)}%`]);
    }
    // 守備の目安は、リーチした上家にだけ（5 つのどれか）
    expect(lines[0]!.querySelector('.dg-c')).toBeNull();
    expect(lines[1]!.querySelector('.dg-c')).toBeNull();
    expect(['現物', '字牌', '壁', 'スジ', '無スジ']).toContain(lines[2]!.querySelector('.dg-c')?.textContent);
  });

  it('読み直した他家（リーチ）には、効いた捨て牌（2 つまで）・読みの上位・実際の待ちが出る。読み直していない他家には出ない', async () => {
    const view = open({ visible: true });
    await answer(view);
    await waitForCells();
    await view.user.click(cellFor('5s'));
    const dialog = popover();
    const lines = [...dialog.querySelectorAll('.rd-opp')];
    // 上家（リーチ）: 5 巡目の 3s と 3 巡目の 9p（本物の読みの値）
    expect(lines[2]!.querySelectorAll('.rd-opp-d p')).toHaveLength(3);
    expect(lines[2]!.querySelector('.rd-opp-d')?.textContent).toContain('効いた捨て牌: 5 巡目の 3s（無ければ 16%）、3 巡目の 9p（無ければ 11%）');
    const top = opponentOf(3).top_waits.map((entry) => `${tileLabel(entry.tile)} ${pct(entry.p)}%`).join(' · ');
    expect(lines[2]!.textContent).toContain(`上家の読みの上位: ${top}`);
    expect(top.split(' · ')).toHaveLength(5);
    expect(lines[2]!.textContent).toContain('上家の実際の待ち: 發');
    // 聴牌の確率が低い下家・対面は、読み直していない
    expect(lines[0]!.querySelector('.rd-opp-d')).toBeNull();
    expect(lines[1]!.querySelector('.rd-opp-d')).toBeNull();
  });

  it('捨て牌が牌の確率を大きく動かさないときは「大きく動かす捨て牌なし」。数牌の呼び名は 5p の形、字牌は漢字', async () => {
    const view = open({ visible: true });
    await answer(view);
    await waitForCells();
    const none = [...decision.board.hand, ...(decision.board.drawn === null ? [] : [decision.board.drawn])].find(
      (tile) => opponentOf(3).reasons[tile.replace(/r$/, '')] === undefined,
    ) as string;
    await view.user.click(cellFor(none));
    const detail = [...popover().querySelectorAll('.rd-opp')][2]!.querySelector('.rd-opp-d') as HTMLElement;
    expect(detail.textContent).toContain('大きく動かす捨て牌なし');
    expect(detail.textContent).not.toContain('効いた捨て牌');
  });

  it('聴牌していなかったときの実際の待ちは「聴牌していなかった」。リーチしていなくても聴牌の確率が 50% 以上の他家には、リーチの人と同じ行が出る（守備の目安は無い）', async () => {
    // 牌譜の位置 120 の場面は、対面が聴牌 52%（リーチではない）で、実際に聴牌している。ここでは待ちを空にして、聴牌していなかった場合を確かめる
    const edited = structuredClone(real);
    const at = edited.moments.find((item) => item.event_index === 120)!;
    at.opponents.find((opponent) => opponent.step === 2)!.actual_waits = [];
    const backend = readsBackend({ stored: edited, visible: true });
    const mock = installTauriMock({ handlers: backend.handlers });
    const decision120 = game.decisions.find((d) => d.eventIndex === 120)!;
    const view = renderQuiz({ report: 'fx4', find: (d) => d.eventIndex === 120 });
    await view.user.click(screen.getAllByRole('button', { name: /を切る$/ }).at(-1) as HTMLElement);
    await view.user.type(screen.getByLabelText('理由（1行）'), '理由');
    await view.user.click(screen.getByRole('button', { name: '答え合わせ' }));
    await revealed();
    await waitFor(() => expect(mock.count('read_reads')).toBe(1));
    await waitForCells();
    const first = cells()[0] as HTMLButtonElement;
    await view.user.click(first);
    const lines = [...popover().querySelectorAll('.rd-opp')];
    expect(decision120.board.riichi[2]).toBe('none');
    expect(lines[1]!.querySelector('.rd-opp-name')?.textContent).toBe('対面');
    expect(lines[1]!.querySelector('.dg-c')).toBeNull();
    expect(lines[1]!.querySelector('.rd-opp-d')?.textContent).toContain('対面の実際の待ち: 聴牌していなかった');
    expect(lines[1]!.querySelector('.rd-opp-d')?.textContent).toContain('対面の読みの上位:');
    // リーチしている上家の行は、守備の目安つき
    expect(lines[2]!.querySelector('.dg-c')).not.toBeNull();
  });

  it('Esc で閉じて、キーボードの位置は押した数へ戻る。外を押しても閉じる。別の数を押すと、その牌の吹き出しに替わる。同じ数をもう一度押すと閉じる', async () => {
    const view = open({ visible: true });
    await answer(view);
    await waitForCells();
    const [a, b] = cells() as [HTMLButtonElement, HTMLButtonElement];
    await view.user.click(a);
    expect(popover()).toBeInTheDocument();
    await view.user.keyboard('{Escape}');
    expect(document.getElementById('rdpop')).toBeNull();
    expect(a).toHaveFocus();
    expect(a).toHaveAttribute('aria-expanded', 'false');
    // 外を押すと閉じる
    await view.user.click(a);
    expect(popover()).toBeInTheDocument();
    await view.user.click(screen.getByRole('heading', { level: 1 }));
    expect(document.getElementById('rdpop')).toBeNull();
    // 別の数を押すと、替わる
    await view.user.click(a);
    const first = popover().getAttribute('aria-labelledby');
    await view.user.click(b);
    await waitFor(() => expect(b).toHaveAttribute('aria-expanded', 'true'));
    expect(a).toHaveAttribute('aria-expanded', 'false');
    expect(document.querySelectorAll('#rdpop')).toHaveLength(1);
    expect(popover().querySelector('h3')?.textContent).toBe(`だれかが待っている確率 ${pctOfCell(b)}%`);
    expect(first).not.toBeNull();
    // 同じ数をもう一度押すと閉じる
    await view.user.click(b);
    expect(document.getElementById('rdpop')).toBeNull();
    // 閉じるボタン
    await view.user.click(a);
    await view.user.click(within(popover()).getByRole('button', { name: '閉じる' }));
    expect(document.getElementById('rdpop')).toBeNull();
    expect(a).toHaveFocus();
  });

  it('切り替えを切ると、開いていた吹き出しも消える', async () => {
    const view = open({ visible: true });
    await answer(view);
    await waitForCells();
    await view.user.click(cells()[0] as HTMLElement);
    expect(popover()).toBeInTheDocument();
    await view.user.click(toggle());
    expect(document.getElementById('rdpop')).toBeNull();
    expect(cells()).toHaveLength(0);
  });
});

/** 数のボタンの数（整数の %）。 */
function pctOfCell(cell: HTMLElement): string {
  return cell.querySelector('.rd-n')?.textContent ?? '';
}

describe('U-53 キーボード: Tab で数に届き、Enter で吹き出しを開き、Esc で閉じる', () => {
  it('Tab の止まり場所は数の組の中で 1 つ。矢印キーと Home・End で動く。Enter で開いて、Esc で閉じると、押した数へ戻る', async () => {
    const view = open({ visible: true });
    await answer(view);
    await waitForCells();
    expect(cells().filter((cell) => cell.tabIndex === 0)).toHaveLength(1);
    // 切り替えから Tab で進んで、数の止まり場所に届く
    toggle().focus();
    let reached: Element | null = null;
    for (let count = 0; count < 12 && reached === null; count += 1) {
      await view.user.tab();
      if (document.activeElement?.classList.contains('rd-cell') === true) reached = document.activeElement;
    }
    expect(reached).not.toBeNull();
    const stop = reached as HTMLButtonElement;
    expect(stop.tabIndex).toBe(0);
    const all = cells();
    const index = all.indexOf(stop);
    await view.user.keyboard('{ArrowRight}');
    expect(all[Math.min(index + 1, all.length - 1)]).toHaveFocus();
    await view.user.keyboard('{End}');
    expect(all.at(-1)).toHaveFocus();
    await view.user.keyboard('{Home}');
    expect(all[0]).toHaveFocus();
    // 動いたあとは、そこが止まり場所
    expect(cells().filter((cell) => cell.tabIndex === 0)).toEqual([all[0]]);
    await view.user.keyboard('{Enter}');
    expect(popover()).toHaveFocus();
    await view.user.keyboard('{Escape}');
    expect(document.getElementById('rdpop')).toBeNull();
    expect(all[0]).toHaveFocus();
    // 吹き出しの端から Tab で出ると、閉じて、押した数へ戻る
    await view.user.keyboard('{Enter}');
    expect(popover()).toBeInTheDocument();
    await view.user.tab({ shift: true });
    expect(document.getElementById('rdpop')).toBeNull();
    expect(all[0]).toHaveFocus();
  });
});

describe('U-53 用意の様子: 計算の進み具合・モデルが無いとき・失敗', () => {
  const progress = (done: number, total: number, sessionId = 'sess'): ReadsProgress => ({ session_id: sessionId, done, total });

  it('読みが無ければ計算する: 「読みを計算しています… 64/117」（aria-live の polite）。この半荘の進み具合だけを出す。終わると数が出て、行は消える', async () => {
    const view = open({ visible: true, stored: null });
    await answer(view);
    const status = await screen.findByText(/読みを計算しています/);
    expect(status).toHaveAttribute('aria-live', 'polite');
    expect(status).not.toHaveAttribute('role');
    await waitFor(() => expect(view.backend.state.computeCalls).toBe(1));
    act(() => view.mock.emit('reads-progress', progress(64, 117)));
    await waitFor(() => expect(status).toHaveTextContent('読みを計算しています… 64/117'));
    act(() => view.mock.emit('reads-progress', progress(5, 9, 'other-session')));
    expect(status).toHaveTextContent('読みを計算しています… 64/117');
    expect(cells()).toHaveLength(0);
    act(() => view.backend.state.release?.());
    await waitForCells();
    expect(screen.queryByText(/読みを計算しています/)).toBeNull();
    expect(view.mock.count('compute_reads')).toBe(1);
    expect(view.mock.calls().find((call) => call.cmd === 'compute_reads')?.args).toEqual({ sessionId: 'sess' });
  });

  it('モデルが入っていないとき: 「読みのモデルが入っていません。」と「設定を開く」。計算はしない。ボタンで設定の「解析のモデル」へ', async () => {
    const openModelSettings = vi.fn();
    const view = open({ visible: true, stored: null, installed: false, openModelSettings });
    await answer(view);
    expect(await screen.findByText(/読みのモデルが入っていません。/)).toBeInTheDocument();
    await view.user.click(screen.getByRole('button', { name: '設定を開く' }));
    expect(openModelSettings).toHaveBeenCalledTimes(1);
    expect(view.mock.count('compute_reads')).toBe(0);
    expect(cells()).toHaveLength(0);
    // 切り替えは入のまま（モデルを入れたあとに戻ると、読みが出る）
    expect(toggle()).toHaveAttribute('aria-pressed', 'true');
  });

  it('設定を開く関数が無い所（シェルの外）では、案内の文だけで、ボタンは出さない', async () => {
    const view = open({ visible: true, stored: null, installed: false });
    await answer(view);
    expect(await screen.findByText(/読みのモデルが入っていません。/)).toBeInTheDocument();
    expect(screen.queryByRole('button', { name: '設定を開く' })).toBeNull();
  });

  it('失敗したら、理由つきの知らせ（role=alert）と「もう一度」。押すと、もう一度用意する', async () => {
    const view = open({ visible: true, stored: null });
    await answer(view);
    await waitFor(() => expect(view.backend.state.computeCalls).toBe(1));
    act(() => view.backend.state.fail?.('エンジンが止まりました（内部エラー）'));
    const alert = await screen.findByRole('alert');
    expect(alert).toHaveTextContent('読みを出せませんでした: エンジンが止まりました（内部エラー）');
    expect(cells()).toHaveLength(0);
    await view.user.click(within(alert).getByRole('button', { name: 'もう一度' }));
    await waitFor(() => expect(view.backend.state.computeCalls).toBe(2));
    expect(screen.queryByRole('alert')).toBeNull();
    act(() => view.backend.state.release?.());
    await waitForCells();
    expect(view.mock.count('compute_reads')).toBe(2);
  });

  it('保存してある読みを読めなかったときも、同じ（理由つきの知らせとやり直し）', async () => {
    const view = open({ visible: true });
    let calls = 0;
    view.backend.handlers.read_reads = () => {
      calls += 1;
      if (calls === 1) throw '読み出せませんでした: 形が違います';
      return JSON.stringify(real);
    };
    await answer(view);
    const alert = await screen.findByRole('alert');
    expect(alert).toHaveTextContent('読みを出せませんでした: 読み出せませんでした: 形が違います');
    await view.user.click(within(alert).getByRole('button', { name: 'もう一度' }));
    await waitForCells();
    expect(calls).toBe(2);
  });
});
