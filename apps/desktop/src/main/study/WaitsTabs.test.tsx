import type { Decision } from '@jantama/engine';
import { cleanup, screen, waitFor, within } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { renderQuiz } from '../../../tests/study-harness';

// 答え合わせのタブの枠と、タブ「待ちと打点」・待ちの形・符の内訳（F14、E-36〜E-38、U-34。R15-2・R15-3）の画面の試験。
// 中身の正しさ（役・飜・符・点数・待ちの形）は、エンジンの試験（win-value-oracle.test.ts・wait-value.test.ts）が正解表と照らして固定している。
// ここでは、タブが出るところ・出ないところ、キーボード（← → Home End）、表の見え方、符の内訳の重なり、答える前に何も出ないことを確かめる。
// 実ブラウザでの見え方（横スクロール・axe・Tab の順・重なりが窓の中に入る）は、tests/browser/quiz.browser.test.ts が確かめる。
// 場面は、確認シートの見本と同じ（FX-5 の南4局 10巡目のリーチの判断、東4局 8巡目のポンのあとの打牌）。

beforeEach(() => {
  vi.useFakeTimers({ toFake: ['Date'] });
  vi.setSystemTime(new Date(2026, 9, 9, 22, 0, 0));
});

afterEach(() => {
  cleanup();
  vi.useRealTimers();
});

/** FX-5 南4局 10巡目 リーチの判断（聴牌になる切り方が 4 通り。実戦はリーチ、AI は 1s を切る）。 */
const RIICHI = { report: 'fx5' as const, find: (d: Decision) => d.kyokuLabel === '南4局' && d.entryIndex === 10 };
/** FX-5 東4局 8巡目 打牌（白をポンしたあと。実戦は打3m、AI は打5m）。 */
const AFTER_PON = { report: 'fx5' as const, find: (d: Decision) => d.kyokuLabel === '東4局' && d.entryIndex === 8 };
/** FX-5 東4局 8巡目 鳴きの判断（スルーが実戦と AI。チーすると聴牌になる切り方がある）。 */
const CALL = { report: 'fx5' as const, find: (d: Decision) => d.kyokuLabel === '東4局' && d.kind === 'call' && d.junme === 8 };
/** 聴牌にならない判断（FX-1 の最初の判断の 1 つ。既定の場面）。 */
const FAR = { report: 'fx1a' as const };

async function reveal(user: ReturnType<typeof renderQuiz>['user'], pick: () => HTMLElement) {
  await user.click(pick());
  await user.type(screen.getByLabelText('理由（1行）'), '待ちを見て選んだ');
  await user.click(screen.getByRole('button', { name: '答え合わせ' }));
  await screen.findByRole('heading', { name: 'AIの評価（Mortal）' });
}

const tile = (name: string) => () => screen.getAllByRole('button', { name: `${name}を切る` })[0] as HTMLElement;
const option = (id: string) => () => document.querySelector<HTMLElement>(`[data-option="${id}"]`) as HTMLElement;

const tabs = (): HTMLElement[] => screen.queryAllByRole('tab');
const panel = (): HTMLElement => {
  const selected = screen.getByRole('tab', { selected: true });
  return document.getElementById(selected.getAttribute('aria-controls') ?? '') as HTMLElement;
};
/** 要素の文字（牌の画像は、読み上げの名前を、前後に空白を付けて入れる）。 */
const text = (element: Element | null | undefined): string => {
  const parts: string[] = [];
  const walk = (node: Node): void => {
    if (node.nodeType === Node.TEXT_NODE) parts.push(node.textContent ?? '');
    else if (node instanceof HTMLImageElement) parts.push(` ${node.alt} `);
    else node.childNodes.forEach(walk);
  };
  if (element !== null && element !== undefined) walk(element);
  return parts.join('').replace(/\s+/g, ' ').trim();
};

describe('U-34 答える前は、どのタブも、待ちも点も出ない（U-1）', () => {
  it('聴牌になる場面でも、答える前は、タブも待ちと打点の文字も、AI の印（data-ai）も無い。選んだだけ・理由を書いただけでも出ない', async () => {
    const { user } = renderQuiz(AFTER_PON);
    expect(document.querySelector('[data-ai]')).toBeNull();
    expect(screen.queryByRole('tablist')).toBeNull();
    expect(document.body.textContent).not.toMatch(/待ちと打点|受け入れ・役|双碰|嵌張|ダマ|フリテン/);
    await user.click(tile('三萬')());
    await user.type(screen.getByLabelText('理由（1行）'), '途中');
    expect(screen.queryByRole('tablist')).toBeNull();
    expect(document.body.textContent).not.toMatch(/待ちと打点|双碰|嵌張/);
  });
});

describe('U-34 タブは、その場面に関係があるときだけ出る', () => {
  it('聴牌にならない場面は、タブを出さず、受け入れ枚数の欄と役の欄が、これまでどおり並ぶ', async () => {
    const { user } = renderQuiz(FAR);
    await reveal(user, () => screen.getAllByRole('button', { name: /を切る$/ })[0] as HTMLElement);
    expect(screen.queryByRole('tablist')).toBeNull();
    expect(screen.getByRole('heading', { name: '受け入れ枚数' })).toBeInTheDocument();
    expect(document.querySelector('[data-ai="waits-box"]')).toBeNull();
  });

  it('聴牌になる場面は、既定のタブ「受け入れ・役」と、タブ「待ちと打点」が出る。既定のタブには、受け入れ枚数の欄と役の欄', async () => {
    const { user } = renderQuiz(AFTER_PON);
    await reveal(user, tile('三萬'));
    expect(tabs().map((t) => t.textContent)).toEqual(['受け入れ・役', '待ちと打点']);
    expect(screen.getByRole('tab', { name: '受け入れ・役', selected: true })).toBeInTheDocument();
    expect(screen.getByRole('tablist')).toHaveAccessibleName('答え合わせの内容');
    const shown = panel();
    expect(within(shown).getByRole('heading', { name: '受け入れ枚数' })).toBeInTheDocument();
    expect(within(shown).getByRole('heading', { name: '役' })).toBeInTheDocument();
    // 待ちと打点の中身は、選ぶまで描かない（タブの先）
    expect(document.querySelector('[data-ai="waits-box"]')).toBeNull();
    // タブは、AI の評価の棒の下にあり、差の原因の欄の上にある
    const review = document.getElementById('review') as HTMLElement;
    const order = [...review.querySelectorAll(':scope > .q-sec, :scope > form.q-sec')].map((s) =>
      s.querySelector('[role="tablist"]') !== null ? 'タブ' : (s.querySelector('h2, legend')?.textContent ?? ''),
    );
    expect(order.indexOf('AIの評価（Mortal）')).toBeLessThan(order.indexOf('タブ'));
    expect(order.indexOf('タブ')).toBeLessThan(order.findIndex((t) => t.startsWith('差の原因')));
  });

  it('リーチの判断の場面でも出る。鳴きの判断（スルーで聴牌のまま）でも出る', async () => {
    const riichi = renderQuiz(RIICHI);
    await reveal(riichi.user, option('pass'));
    expect(tabs().map((t) => t.textContent)).toEqual(['受け入れ・役', '待ちと打点']);
    riichi.unmount();
    const call = renderQuiz(CALL);
    await reveal(call.user, option('pass'));
    expect(tabs().map((t) => t.textContent)).toEqual(['受け入れ・役', '待ちと打点']);
  });

  it('解き直し（review）でも、同じ部品が出る（答えが保存してあるとき、答え合わせのあとの形で開く）', async () => {
    const { user } = renderQuiz({ ...AFTER_PON, mode: 'review' });
    await reveal(user, tile('三萬'));
    expect(tabs().map((t) => t.textContent)).toEqual(['受け入れ・役', '待ちと打点']);
  });
});

describe('U-34 タブのキーボード（WAI-ARIA のタブ）', () => {
  it('タブは tablist の中の tab で、選んでいるタブだけが Tab の止まり場所。tabpanel と、aria-controls・aria-labelledby でつながる', async () => {
    const { user } = renderQuiz(AFTER_PON);
    await reveal(user, tile('三萬'));
    const [first, second] = tabs() as [HTMLElement, HTMLElement];
    expect(first).toHaveAttribute('aria-selected', 'true');
    expect(first).toHaveAttribute('tabindex', '0');
    expect(second).toHaveAttribute('aria-selected', 'false');
    expect(second).toHaveAttribute('tabindex', '-1');
    for (const t of [first, second]) {
      const target = document.getElementById(t.getAttribute('aria-controls') ?? '') as HTMLElement;
      expect(target).toHaveAttribute('role', 'tabpanel');
      expect(target).toHaveAttribute('aria-labelledby', t.id);
    }
    // 選んでいないタブの欄は、隠れていて、中身が無い
    expect(document.getElementById(second.getAttribute('aria-controls') ?? '')).toHaveAttribute('hidden');
  });

  it('→ で次のタブを選んで、キーボードの位置も移す。← で戻る。端では反対の端へ。Home・End で最初・最後', async () => {
    const { user } = renderQuiz(AFTER_PON);
    await reveal(user, tile('三萬'));
    const [first, second] = tabs() as [HTMLElement, HTMLElement];
    first.focus();
    await user.keyboard('{ArrowRight}');
    expect(second).toHaveAttribute('aria-selected', 'true');
    expect(second).toHaveFocus();
    expect(second).toHaveAttribute('tabindex', '0');
    expect(first).toHaveAttribute('tabindex', '-1');
    // 選ぶと、待ちと打点の欄が出る
    expect(within(panel()).getByRole('heading', { name: '待ちと打点・待ちの形・符' })).toBeInTheDocument();
    await user.keyboard('{ArrowRight}');
    expect(first).toHaveAttribute('aria-selected', 'true');
    expect(first).toHaveFocus();
    await user.keyboard('{ArrowLeft}');
    expect(second).toHaveAttribute('aria-selected', 'true');
    await user.keyboard('{Home}');
    expect(first).toHaveAttribute('aria-selected', 'true');
    expect(first).toHaveFocus();
    await user.keyboard('{End}');
    expect(second).toHaveAttribute('aria-selected', 'true');
    expect(second).toHaveFocus();
    // 押して選ぶこともできる
    await user.click(first);
    expect(first).toHaveAttribute('aria-selected', 'true');
  });

  it('矢印・Home・End は、画面のキー（通して見る画面の前・次の判断など）に渡さない（preventDefault）。Shift・Alt・Ctrl 付きは触らない', async () => {
    const { user } = renderQuiz(AFTER_PON);
    await reveal(user, tile('三萬'));
    const [first, second] = tabs() as [HTMLElement, HTMLElement];
    first.focus();
    for (const key of ['ArrowRight', 'ArrowLeft', 'Home', 'End']) {
      const event = new KeyboardEvent('keydown', { key, bubbles: true, cancelable: true });
      first.dispatchEvent(event);
      expect(event.defaultPrevented, key).toBe(true);
    }
    const alt = new KeyboardEvent('keydown', { key: 'ArrowRight', altKey: true, bubbles: true, cancelable: true });
    first.dispatchEvent(alt);
    expect(alt.defaultPrevented).toBe(false);
    const shift = new KeyboardEvent('keydown', { key: 'ArrowRight', shiftKey: true, bubbles: true, cancelable: true });
    first.dispatchEvent(shift);
    expect(shift.defaultPrevented).toBe(false);
    expect(second).toHaveAttribute('aria-selected', 'false');
    void user;
  });

  it('Tab は、タブから、選んでいるタブの欄の中身へ進む（選んでいないタブには止まらない）', async () => {
    const { user } = renderQuiz(AFTER_PON);
    await reveal(user, tile('三萬'));
    const [first, second] = tabs() as [HTMLElement, HTMLElement];
    first.focus();
    await user.tab();
    expect(second).not.toHaveFocus();
    expect(panel().contains(document.activeElement)).toBe(true);
  });
});

describe('F14 タブ「待ちと打点」の表（ポンのあとの打牌。副露した手）', () => {
  async function open() {
    const view = renderQuiz(AFTER_PON);
    await reveal(view.user, tile('三萬'));
    await view.user.click(screen.getByRole('tab', { name: '待ちと打点' }));
    return view;
  }

  it('見出しと説明のアイコン。説明の文は、本文に出さず、乗せると重ねて出る', async () => {
    const { user } = await open();
    const box = document.querySelector('[data-ai="waits-box"]') as HTMLElement;
    expect(within(box).getByRole('heading', { level: 2, name: '待ちと打点・待ちの形・符' })).toBeInTheDocument();
    expect(box.textContent).not.toContain('裏ドラ・一発・海底');
    await user.hover(within(box).getByRole('button', { name: '待ちと打点の説明' }));
    const tip = screen.getByRole('tooltip');
    expect(tip).toHaveTextContent('裏ドラ・一発・海底などは数えていません');
    expect(tip).toHaveTextContent('和了牌が赤のときの赤ドラも数えません');
    expect(tip).toHaveTextContent('雀魂の規則（切り上げ満貫なし・喰いタンあり・赤ドラ各 1 枚）で計算しています');
    expect(tip).toHaveTextContent('符の数にマウスを乗せると、内訳が出ます');
  });

  it('比べる打牌ごとに表: 自分・実戦の打3m（双碰 5m・6m）と、AI の打5m（嵌張 4m）。AI の確率は出さない', async () => {
    await open();
    const tables = [...document.querySelectorAll<HTMLElement>('[data-ai="waits"]')];
    expect(tables).toHaveLength(2);
    const heads = tables.map((t) => text(t.querySelector('.wt-h')));
    expect(heads[0]).toBe('打 三萬 自分・実戦 双碰 待ち2種・残り4枚');
    expect(heads[1]).toBe('打 五萬 AI 嵌張 待ち1種・残り3枚');
    expect(document.querySelector('.wt-h')?.textContent).not.toMatch(/%|確率/);
    const rows = [...(tables[0] as HTMLElement).querySelectorAll('tbody tr')];
    expect(rows).toHaveLength(2);
    // 行: 待ち牌と残り・形・どちらでも付く役・ダマ・リーチ
    const first = rows[0] as HTMLElement;
    expect(text(first.querySelector('th'))).toBe('五萬 残り2枚');
    expect(text(first.querySelector('td.shape'))).toBe('双碰');
    expect(text(first.querySelector('td.yaku'))).toBe('役牌 白 1飜 赤ドラ 1');
    // ロン 2,000（2 飜 30 符）・ツモ 500・1,000（2 飜 30 符）。副露した手は、リーチを出さない
    expect(text(first.querySelector('td.dama .wt-p:nth-child(1)'))).toBe('ロン 2,000 2飜 30符');
    expect(text(first.querySelector('td.dama .wt-p:nth-child(2)'))).toBe('ツモ 500・1,000 2飜 30符');
    expect(text(first.querySelector('td.riichi'))).toBe('副露しているので、リーチはできません');
  });

  it('表の見出し（列）は、待ち・形・役（どちらでも付く）・ダマ・リーチ。表には名前（読み上げ）がある', async () => {
    await open();
    const table = document.querySelector('.wt-tbl') as HTMLElement;
    expect([...table.querySelectorAll('thead th')].map((th) => th.textContent)).toEqual(['待ち', '形', '役（どちらでも付く）', 'ダマ', 'リーチ']);
    expect(table.querySelector('caption')?.textContent).toMatch(/の待ちごとの役と点数$/);
  });
});

describe('F14 リーチの判断（南4局 10巡目）: 聴牌になる切り方すべて。ダマとリーチ。多面張', () => {
  async function open() {
    const view = renderQuiz(RIICHI);
    await reveal(view.user, option('pass'));
    await view.user.click(screen.getByRole('tab', { name: '待ちと打点' }));
    return view;
  }

  it('聴牌になる 4 通りの切り方。待ちも点も同じ 1s と 4s は 1 つの表にまとまり、見出しに「（待ちも点も同じ）」。3 種類以上の待ちの手は「多面張」（強調の札）、嵌張の手は 1 語', async () => {
    await open();
    const tables = [...document.querySelectorAll<HTMLElement>('[data-ai="waits"]')];
    expect(tables.map((t) => text(t.querySelector('.wt-h')))).toEqual([
      '打 一索 AI ・ 打 四索 （待ちも点も同じ） 多面張 待ち3種・残り6枚',
      '打 六索 候補 嵌張 待ち1種・残り4枚',
      '打 九索 候補 嵌張 待ち1種・残り4枚',
    ]);
    expect(tables[0]?.querySelector('.wt-h .wt-shape')).toHaveClass('wide');
    expect(tables[1]?.querySelector('.wt-h .wt-shape')).not.toHaveClass('wide');
  });

  it('リーチの欄は、ロンとツモ、ダマとの差。点数はダマと同じ表の中に並ぶ', async () => {
    await open();
    const row = document.querySelector('[data-ai="waits"] tbody tr') as HTMLElement;
    expect(text(row.querySelector('td.dama .wt-p:nth-child(1)'))).toBe('ロン 8,000 4飜 40符 満貫');
    expect(text(row.querySelector('td.dama .wt-p:nth-child(2)'))).toBe('ツモ 2,000・4,000 5飜 30符 満貫');
    expect(text(row.querySelector('td.riichi .wt-p:nth-child(1)'))).toBe('ロン 8,000 5飜 40符 満貫');
    expect(text(row.querySelector('td.riichi .wt-p:nth-child(2)'))).toBe('ツモ 3,000・6,000 6飜 30符 跳満');
    expect(text(row.querySelector('td.riichi .wt-diff'))).toBe('ダマとの差: ロン ±0・ツモ +4,000');
    expect(text(row.querySelector('td.yaku'))).toBe('一盃口 1飜 混一色 3飜');
  });

  it('符は「40符」のように数だけ。マウスを乗せると内訳が重なって出る（副底・門前ロン・ロンで完成した明刻・連風牌の雀頭）。離すと閉じる', async () => {
    const { user } = await open();
    const row = document.querySelector('[data-ai="waits"] tbody tr') as HTMLElement;
    const fu = within(row.querySelector('td.dama') as HTMLElement).getAllByRole('button', { name: /符の内訳/ })[0] as HTMLElement;
    expect(fu).toHaveTextContent(/^40符$/);
    expect(fu).toHaveAccessibleName('40符の内訳（六索 ダマ ロン）');
    // 閉じている間は、内訳の文字が画面（本文）に出ない
    expect(screen.queryByRole('tooltip')).toBeNull();
    expect(row.textContent).not.toContain('副底');
    await user.hover(fu);
    const tip = screen.getByRole('tooltip');
    expect(text(tip.querySelector('.fp-t'))).toBe('40符の内訳');
    expect([...tip.querySelectorAll('.fp-r')].map((r) => text(r))).toEqual(['副底 20', '門前ロン 10', '明刻（中張牌・ロンで完成） 2', '連風牌の雀頭 4']);
    expect(text(tip.querySelector('.fp-sum'))).toBe('合計 36 を 10 符単位に切り上げ 40符');
    expect(text(tip.querySelector('.fp-n'))).toBe('ロンで完成した刻子は、明刻として数える（暗刻の半分の符）');
    // 重なりは body の直下（本文の container-type の影響を受けない）
    expect(tip.parentElement).toBe(document.body);
    await user.unhover(fu);
    await waitFor(() => expect(screen.queryByRole('tooltip')).toBeNull(), { timeout: 2000 });
  });

  it('符は、Tab の止まり場所で、読み上げの説明が内訳になる（キーボードで選んだときの重なりは、Tip の試験と、実ブラウザの検査）', async () => {
    const { user } = await open();
    const row = document.querySelector('[data-ai="waits"] tbody tr') as HTMLElement;
    const fu = within(row.querySelector('td.dama') as HTMLElement).getAllByRole('button', { name: /符の内訳/ })[0] as HTMLElement;
    expect(fu).toHaveAccessibleDescription(/^40符の内訳 副底 20 門前ロン 10 明刻（中張牌・ロンで完成） 2 連風牌の雀頭 4 合計 36 を 10 符単位に切り上げ 40符/);
    // ページの先頭から Tab で進めると、符に届く
    (document.activeElement as HTMLElement | null)?.blur();
    let presses = 0;
    while (document.activeElement !== fu && presses < 80) {
      await user.tab();
      presses++;
    }
    expect(fu).toHaveFocus();
  });

  it('ロンできない待ち（役が無い）には内訳が無い。ロンは「役なし（ロンできない）」', async () => {
    const { user } = renderQuiz({ report: 'fx5' as const, find: (d: Decision) => d.kyokuLabel === '南4局' && d.entryIndex === 5 });
    await reveal(user, option('pass'));
    await user.click(screen.getByRole('tab', { name: '待ちと打点' }));
    const rows = [...document.querySelectorAll<HTMLElement>('[data-ai="waits"] tbody tr')];
    expect(rows).toHaveLength(2);
    expect(text((rows[0] as HTMLElement).querySelector('td.dama .wt-p:nth-child(1)'))).toBe('ロン 役なし （ロンできない）');
    expect(text((rows[0] as HTMLElement).querySelector('td.yaku'))).toBe('役なし');
    expect(text((rows[0] as HTMLElement).querySelector('td.riichi .wt-diff'))).toBe('ダマとの差: ダマはロンできない・ツモ +900');
    expect(text((rows[1] as HTMLElement).querySelector('td.shape'))).toBe('両面');
  });
});

describe('F14 鳴きの判断のタブ: スルーと、チーのあとの打牌', () => {
  it('スルー（いまの手の待ち）と、チーして切る牌ごとの表。印の無いボタンは「候補」', async () => {
    const { user } = renderQuiz(CALL);
    await reveal(user, option('pass'));
    await user.click(screen.getByRole('tab', { name: '待ちと打点' }));
    const heads = [...document.querySelectorAll<HTMLElement>('[data-ai="waits"] .wt-h')].map((h) => text(h));
    expect(heads.some((h) => /^スルー 自分・実戦・AI /.test(h))).toBe(true);
    expect(heads.some((h) => /^チー .* → 打 .* 候補 /.test(h))).toBe(true);
  });
});
