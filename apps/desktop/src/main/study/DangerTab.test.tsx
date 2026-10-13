import type { Decision } from '@jantama/engine';
import { cleanup, screen, within } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { renderQuiz } from '../../../tests/study-harness';

// 答え合わせのタブ「守備」（F14、E-39、U-34。R15-2・R15-4。提案 3）の画面の試験。
// 分類の正しさ（現物・スジ・壁・字牌・無スジ。majiang-ai の数値の順との照合）は、エンジンの試験（danger.test.ts）が固定している。
// ここでは、タブが出る場面・出ない場面、答える前に何も出ないこと、キーボード（← → Home End）、欄の中身（見出し・説明・1 行・河・行・印）、
// リーチが 2 人のときの欄の順、鳴きの判断・リーチの判断を確かめる。
// 実ブラウザでの見え方（横スクロール・axe・Tab の順）は tests/browser/quiz.browser.test.ts、通して見る画面で答えた場面は replay の試験。
// 場面は、確認シートの見本と同じもの（FX-5 の東4局 8巡目・東2局 8巡目）と、固定データの別の場面。

beforeEach(() => {
  vi.useFakeTimers({ toFake: ['Date'] });
  vi.setSystemTime(new Date(2026, 9, 9, 22, 0, 0));
});

afterEach(() => {
  cleanup();
  vi.useRealTimers();
});

/** FX-5 東4局 8巡目 打牌（下家のリーチ。白をポンしたあと。実戦は打3m、AI は打5m。聴牌なので待ちと打点のタブも出る）。 */
const REACH_AND_TENPAI = { report: 'fx5' as const, find: (d: Decision) => d.kyokuLabel === '東4局' && d.entryIndex === 8 };
/** FX-5 東2局 8巡目 打牌（対面のリーチ。聴牌ではない。実戦も AI も打9m）。 */
const REACH_ONLY = { report: 'fx5' as const, find: (d: Decision) => d.kyokuLabel === '東2局' && d.entryIndex === 8 };
/** FX-1c 東2局 16巡目 打牌（対面と下家の 2 人がリーチ。対面が先に宣言）。 */
const TWO_RIICHI = { report: 'fx1c' as const, find: (d: Decision) => d.kyokuLabel === '東2局' && d.entryIndex === 19 };
/** FX-1a 南2局1本場 7巡目 鳴きの判断（対面のリーチ）。 */
const CALL = { report: 'fx1a' as const, find: (d: Decision) => d.kyokuLabel === '南2局1本場' && d.entryIndex === 8 };
/** FX-1b 東3局2本場 11巡目 リーチの判断（上家のリーチ。自分は聴牌）。 */
const RIICHI_DECISION = { report: 'fx1b' as const, find: (d: Decision) => d.kyokuLabel === '東3局2本場' && d.entryIndex === 12 };
/** 他家のリーチが無い場面（FX-1a の最初の判断の 1 つ。既定の場面）。 */
const NO_RIICHI = { report: 'fx1a' as const };
/** 聴牌の場面で、他家のリーチが無い（待ちと打点のタブだけ）。FX-5 南4局 10巡目のリーチの判断。 */
const TENPAI_NO_RIICHI = { report: 'fx5' as const, find: (d: Decision) => d.kyokuLabel === '南4局' && d.entryIndex === 10 };

async function reveal(user: ReturnType<typeof renderQuiz>['user'], pick: () => HTMLElement) {
  await user.click(pick());
  await user.type(screen.getByLabelText('理由（1行）'), '守りを見て選んだ');
  await user.click(screen.getByRole('button', { name: '答え合わせ' }));
  await screen.findByRole('heading', { name: 'AIの評価（Mortal）' });
}

const tile = (name: string) => () => screen.getAllByRole('button', { name: `${name}を切る` })[0] as HTMLElement;
const option = (id: string) => () => document.querySelector<HTMLElement>(`[data-option="${id}"]`) as HTMLElement;

const tabs = (): HTMLElement[] => screen.queryAllByRole('tab');
const tabNames = (): string[] => tabs().map((t) => t.textContent ?? '');
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

/** 答えたあと、タブ「守備」を選ぶ。 */
async function openDanger(user: ReturnType<typeof renderQuiz>['user']) {
  await user.click(screen.getByRole('tab', { name: '守備' }));
  return document.querySelector('[data-ai="danger-box"]') as HTMLElement;
}

describe('U-34 答える前は、守備のタブも、分類も、AI の印も、DOM に無い（U-1）', () => {
  it('他家のリーチがある場面でも、答える前は、タブも守備の目安の文字も data-ai も無い。選んだだけ・理由を書いただけでも出ない', async () => {
    const { user } = renderQuiz(REACH_AND_TENPAI);
    expect(document.querySelector('[data-ai]')).toBeNull();
    expect(screen.queryByRole('tablist')).toBeNull();
    expect(document.body.textContent).not.toMatch(/守備の目安|形式的な分類|現物|無スジ/);
    await user.click(tile('三萬')());
    await user.type(screen.getByLabelText('理由（1行）'), '途中');
    expect(screen.queryByRole('tablist')).toBeNull();
    expect(document.body.textContent).not.toMatch(/守備の目安|現物|無スジ/);
    expect(document.querySelector('[data-ai]')).toBeNull();
  });
});

describe('U-34 守備のタブは、他家のリーチがある場面だけ出る', () => {
  it('他家のリーチが無い場面は、守備のタブを出さない（聴牌の場面なら、待ちと打点のタブだけ。リーチが無く聴牌でもない場面は、タブの並びも無い）', async () => {
    const plain = renderQuiz(NO_RIICHI);
    await reveal(plain.user, () => screen.getAllByRole('button', { name: /を切る$/ })[0] as HTMLElement);
    // 他家の手牌のタブは、答えたあとのどの場面にも付く（OpenHands.test.tsx）
    expect(tabNames()).toEqual(['受け入れ・役', '他家の手牌']);
    expect(document.querySelector('[data-ai="danger-box"]')).toBeNull();
    expect(document.body.textContent).not.toContain('守備の目安');
    plain.unmount();
    const tenpai = renderQuiz(TENPAI_NO_RIICHI);
    await reveal(tenpai.user, option('pass'));
    expect(tabNames()).toEqual(['受け入れ・役', '待ちと打点', '他家の手牌']);
  });

  it('他家のリーチがある場面は、既定のタブ「受け入れ・役」と、守備。聴牌なら、待ちと打点の次に守備（作る順・並べる順は 受け入れ・役、待ちと打点、守備）', async () => {
    const only = renderQuiz(REACH_ONLY);
    await reveal(only.user, tile('九萬'));
    expect(tabNames()).toEqual(['受け入れ・役', '守備', '他家の手牌']);
    expect(screen.getByRole('tab', { name: '受け入れ・役', selected: true })).toBeInTheDocument();
    // 中身は、選ぶまで描かない
    expect(document.querySelector('[data-ai="danger-box"]')).toBeNull();
    only.unmount();
    const both = renderQuiz(REACH_AND_TENPAI);
    await reveal(both.user, tile('三萬'));
    expect(tabNames()).toEqual(['受け入れ・役', '待ちと打点', '守備', '他家の手牌']);
  });

  it('鳴きの判断（対面のリーチ）でも、リーチの判断（上家のリーチ）でも出る。解き直し（review）でも同じ部品', async () => {
    const call = renderQuiz(CALL);
    await reveal(call.user, option('pass'));
    expect(tabNames()).toContain('守備');
    call.unmount();
    const riichi = renderQuiz(RIICHI_DECISION);
    await reveal(riichi.user, option('pass'));
    expect(tabNames()).toEqual(['受け入れ・役', '待ちと打点', '守備', '他家の手牌']);
    riichi.unmount();
    const again = renderQuiz({ ...REACH_ONLY, mode: 'review' });
    await reveal(again.user, tile('九萬'));
    expect(tabNames()).toEqual(['受け入れ・役', '守備', '他家の手牌']);
  });
});

describe('U-34 タブのキーボード（守備を含む 4 つ）', () => {
  it('→ で守備まで。端では反対の端へ。Home・End。選ぶと守備の欄が出て、キーボードの位置も移る', async () => {
    const { user } = renderQuiz(REACH_AND_TENPAI);
    await reveal(user, tile('三萬'));
    const [first, second, third, fourth] = tabs() as [HTMLElement, HTMLElement, HTMLElement, HTMLElement];
    first.focus();
    await user.keyboard('{ArrowRight}{ArrowRight}');
    expect(third).toHaveAttribute('aria-selected', 'true');
    expect(third).toHaveFocus();
    expect(document.querySelector('[data-ai="danger-box"]')).not.toBeNull();
    // 守備の欄を選んでいる間、待ちと打点の欄は描かない
    expect(document.querySelector('[data-ai="waits-box"]')).toBeNull();
    await user.keyboard('{ArrowRight}');
    expect(fourth).toHaveAttribute('aria-selected', 'true');
    await user.keyboard('{ArrowRight}');
    expect(first).toHaveAttribute('aria-selected', 'true');
    await user.keyboard('{ArrowLeft}');
    expect(fourth).toHaveAttribute('aria-selected', 'true');
    await user.keyboard('{Home}');
    expect(first).toHaveFocus();
    await user.keyboard('{End}');
    expect(fourth).toHaveFocus();
    await user.keyboard('{ArrowLeft}{ArrowLeft}');
    expect(second).toHaveAttribute('aria-selected', 'true');
  });

  it('Tab は、守備のタブから、欄の中（説明のアイコン）へ進む', async () => {
    const { user } = renderQuiz(REACH_ONLY);
    await reveal(user, tile('九萬'));
    const [first, second] = tabs() as [HTMLElement, HTMLElement];
    first.focus();
    await user.keyboard('{ArrowRight}');
    expect(second).toHaveFocus();
    await user.tab();
    expect(screen.getByRole('button', { name: '守備の目安の説明' })).toHaveFocus();
  });
});

describe('F14 タブ「守備」の欄（東4局 8巡目。下家のリーチ。実戦と自分は打3m、AI は打5m）', () => {
  async function open() {
    const view = renderQuiz(REACH_AND_TENPAI);
    await reveal(view.user, tile('三萬'));
    const box = await openDanger(view.user);
    return { ...view, box };
  }

  it('見出しは「守備の目安（形式的な分類です。AI の確率ではありません）」。5 つの分類の説明は、説明のアイコンに置く（本文に出さず、乗せると重ねて出る）', async () => {
    const { user, box } = await open();
    expect(within(box).getByRole('heading', { level: 2, name: '守備の目安（形式的な分類です。AI の確率ではありません）' })).toBeInTheDocument();
    expect(box.textContent).not.toContain('両面で待たれる形が');
    await user.hover(within(box).getByRole('button', { name: '守備の目安の説明' }));
    const tip = screen.getByRole('tooltip');
    expect(tip).toHaveTextContent('形式的な分類です。AI の確率ではありません。');
    for (const label of ['現物:', 'スジ:', '壁:', '字牌:', '無スジ:']) expect(tip).toHaveTextContent(label);
    expect(tip).toHaveTextContent('副露の多い染め手・ドラ待ち・巡目は見ていません');
  });

  it('欄の頭の 1 行: リーチした人・比べる打牌（自分・実戦と AI）の分類・現物の牌', async () => {
    const { box } = await open();
    const line = box.querySelector('.dg-line');
    expect(text(line)).toBe('下家がリーチ 自分・実戦 打3m 無スジ（両面が残る） AI 打5m 無スジ（中張牌） 現物: 8p・9p');
  });

  it('河（リーチ宣言牌には印）と、牌ごとの行。現物には補足（河にある・リーチ後に通った）。印は比べる打牌の行に付く', async () => {
    const { box } = await open();
    expect(text(box.querySelector('.dg-opp .nm'))).toBe('下家がリーチ（河。太い枠がリーチ宣言牌）');
    const river = [...box.querySelectorAll<HTMLImageElement>('.dg-river img')].map((img) => img.alt);
    expect(river.filter((alt) => alt.includes('リーチ宣言牌'))).toHaveLength(1);
    expect(river.at(-1)).toContain('リーチ宣言牌');
    const rows = [...box.querySelectorAll<HTMLElement>('.dg-row')].map((row) => text(row));
    expect(rows).toEqual([
      '三萬 無スジ 両面が残る 自分・実戦',
      '五萬 無スジ 中張牌 AI',
      '六萬 無スジ 中張牌',
      '三筒 無スジ 両面が残る',
      '四筒 無スジ 中張牌',
      '五筒 無スジ 中張牌',
      '七筒 無スジ 両面が残る',
      '八筒 現物 下家の河にある',
      '九筒 現物 下家のリーチ後に通った',
    ]);
    // 比べる打牌の行だけが目立つ
    expect([...box.querySelectorAll('.dg-row.picked')]).toHaveLength(2);
    // 印の色: 自分・実戦は「自分」の色、AI は AI の色（待ちと打点・受け入れ枚数の欄と同じ分け方）
    expect(box.querySelector('.dg-row .mk.you')?.textContent).toBe('自分・実戦');
    expect(box.querySelector('.dg-row .mk.top')?.textContent).toBe('AI');
  });

  it('分類の札は 3 通り: 現物は塗り（safe）、無スジは濃い枠（risky）、そのほか（スジ・壁・字牌）は薄い枠（mid）。AI の確率や % は出さない', async () => {
    const { box } = await open();
    const kinds = [...box.querySelectorAll('.dg-c')].map((c) => `${c.textContent}:${[...c.classList].filter((x) => x !== 'dg-c').join('')}`);
    expect(kinds.filter((k) => k.startsWith('現物'))).toEqual(['現物:safe', '現物:safe']);
    expect(kinds.filter((k) => k.startsWith('無スジ')).every((k) => k === '無スジ:risky')).toBe(true);
    expect(box.textContent).not.toMatch(/%|確率が|放銃率/);
  });

  it('行は一覧（ul・li）で、読み上げの名前がある。牌は画像（名前つき）', async () => {
    const { box } = await open();
    const list = within(box).getByRole('list', { name: '下家に対する、切る牌ごとの守備の目安' });
    expect(within(list).getAllByRole('listitem')).toHaveLength(9);
    expect(within(list).getAllByRole('img').map((img) => img.getAttribute('alt'))[0]).toBe('三萬');
  });
});

describe('F14 タブ「守備」: スジ・現物の混ざる場面（東2局 8巡目。対面のリーチ）', () => {
  it('9m はスジ（6萬が現物）、7p・9p は現物。実戦も AI も自分も 9m なので、1 つの行に「自分・実戦・AI」', async () => {
    const { user } = renderQuiz(REACH_ONLY);
    await reveal(user, tile('九萬'));
    const box = await openDanger(user);
    expect(text(box.querySelector('.dg-line'))).toBe('対面がリーチ 自分・実戦・AI 打9m スジ（6萬が現物） 現物: 7p・9p');
    const picked = box.querySelector('.dg-row.picked') as HTMLElement;
    expect(text(picked)).toBe('九萬 スジ 6萬が現物 自分・実戦・AI');
    expect(picked.querySelector('.dg-c')).toHaveClass('mid');
    expect(box.querySelector('.dg-row.picked .mk')).toHaveClass('you');
  });

  it('自分の答えが実戦・AI と違えば、その行に「自分」だけ、別の行に「実戦・AI」', async () => {
    const { user } = renderQuiz(REACH_ONLY);
    await reveal(user, tile('四萬'));
    const box = await openDanger(user);
    expect(text(box.querySelector('.dg-line'))).toMatch(/^対面がリーチ 自分 打4m 無スジ（中張牌） 実戦・AI 打9m スジ（6萬が現物） 現物: 7p・9p$/);
    expect([...box.querySelectorAll('.dg-row.picked')]).toHaveLength(2);
  });
});

describe('F14 タブ「守備」: リーチが 2 人のとき、人ごとの欄を宣言した順に', () => {
  it('対面（先に宣言）、下家の順。人ごとに河と行が別。分類は人ごと', async () => {
    const { user } = renderQuiz(TWO_RIICHI);
    await reveal(user, () => screen.getAllByRole('button', { name: /を切る$/ })[0] as HTMLElement);
    const box = await openDanger(user);
    const sections = [...box.querySelectorAll<HTMLElement>('.dg-sec')];
    expect(sections).toHaveLength(2);
    expect(sections.map((s) => s.getAttribute('aria-label'))).toEqual(['対面のリーチに対する、切る牌ごとの守備の目安', '下家のリーチに対する、切る牌ごとの守備の目安']);
    expect(sections.map((s) => text(s.querySelector('.dg-line'))).map((t) => t.split(' ')[0])).toEqual(['対面がリーチ', '下家がリーチ']);
    expect(sections.map((s) => text(s.querySelector('.nm')))).toEqual(['対面がリーチ（河。太い枠がリーチ宣言牌）', '下家がリーチ（河。太い枠がリーチ宣言牌）']);
    // 同じ牌の並び。分類は人ごとに違いうる
    const rows = sections.map((s) => [...s.querySelectorAll('.dg-row')].map((r) => text(r.querySelector('img'))));
    expect(rows[0]).toEqual(rows[1]);
    // 人ごとの現物（河とリーチ後に通った牌）が違う
    const genbutsu = sections.map((s) => text(s.querySelector('.dg-line')).replace(/^.*現物: /, ''));
    expect(genbutsu[0]).not.toBe(genbutsu[1]);
  });
});

describe('F14 タブ「守備」: 鳴きの判断（鳴いたあとに切れる牌）と、リーチの判断', () => {
  it('鳴きの判断は、鳴いたあとに切れる牌の分類。打牌の印は付かない。注の一文が出る', async () => {
    const { user } = renderQuiz(CALL);
    await reveal(user, option('pass'));
    const box = await openDanger(user);
    expect(box.querySelector('.dg-after')?.textContent).toBe('鳴いたあとに切れる牌の分類です。');
    expect(box.querySelectorAll('.dg-row').length).toBeGreaterThan(0);
    expect(box.querySelector('.dg-row.picked')).toBeNull();
    expect(box.querySelector('.mk')).toBeNull();
    // 比べる打牌が無いので、頭の 1 行は、リーチした人と現物だけ
    expect(text(box.querySelector('.dg-line'))).toMatch(/^対面がリーチ 現物: /);
  });

  it('リーチの判断は、実戦（リーチしなかったときの打牌）と AI の打牌に印。鳴いたあとの注は出ない', async () => {
    const { user } = renderQuiz(RIICHI_DECISION);
    await reveal(user, option('pass'));
    const box = await openDanger(user);
    expect(box.querySelector('.dg-after')).toBeNull();
    expect(text(box.querySelector('.dg-line'))).toMatch(/^上家がリーチ 実戦・AI 打9p .*現物: /);
    expect([...box.querySelectorAll('.dg-row.picked')]).toHaveLength(1);
    expect(box.querySelector('.dg-row.picked .mk')?.textContent).toBe('実戦・AI');
  });
});
