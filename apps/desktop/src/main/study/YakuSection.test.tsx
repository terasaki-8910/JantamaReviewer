import { keyOfDecision, type Decision } from '@jantama/engine';
import { cleanup, screen, within } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { answerRow } from '../../../tests/fake-study';
import { decisionOf, renderQuiz } from '../../../tests/study-harness';

// 役の欄（F13・U-33。R14-1）の画面の試験。中身の正しさ（役・近い役・警告・まとめ）は、エンジンの試験（yaku-view.test.ts）が固定している。
// ここでは、欄が出るところ・出ないところ、行動ごとの行、まとめ、警告の見え方（文字と枠）、説明のアイコンを確かめる。
// 場面は、確認シートの見本と同じ（FX-4 の東2局1本場 8巡目の打牌と東の鳴き、東3局1本場 11巡目のチー）。

beforeEach(() => {
  vi.useFakeTimers({ toFake: ['Date'] });
  vi.setSystemTime(new Date(2026, 9, 9, 22, 0, 0));
});

afterEach(() => {
  cleanup();
  vi.useRealTimers();
});

/** FX-4 東2局1本場 8巡目 打牌（実戦は打4p、AI は打7p）。 */
const DISCARD = { report: 'fx4' as const, find: (d: Decision) => d.kyokuLabel === '東2局1本場' && d.entryIndex === 9 };
/** 同じ局の、東のポン・スルー（実戦と AI はポン）。 */
const PON = { report: 'fx4' as const, find: (d: Decision) => d.kyokuLabel === '東2局1本場' && d.entryIndex === 10 };
/** FX-4 東3局1本場 11巡目 チー（5s 7s）・チー（7s 8s）・スルー（実戦と AI はスルー）。 */
const CHI = { report: 'fx4' as const, find: (d: Decision) => d.kyokuLabel === '東3局1本場' && d.entryIndex === 15 };

const yakuBox = (): HTMLElement => {
  const box = document.querySelector<HTMLElement>('[data-ai="yaku-box"]');
  if (box === null) throw new Error('役の欄が無い');
  return box;
};
const rows = (): HTMLElement[] => [...yakuBox().querySelectorAll<HTMLElement>('li.yk-row')];
const tagsOf = (row: HTMLElement): string => row.querySelector('.yk-tags')?.textContent ?? '';
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
/** 行の中の、見出し（dt）の次の欄（dd）の文字。 */
const groupOf = (row: HTMLElement, title: string): HTMLElement => {
  const dt = [...row.querySelectorAll('dt')].find((d) => d.textContent === title);
  const dd = dt?.parentElement?.querySelector('dd');
  if (dd === null || dd === undefined) throw new Error(`${title} の欄が無い`);
  return dd;
};

async function reveal(user: ReturnType<typeof renderQuiz>['user'], pick: () => HTMLElement) {
  await user.click(pick());
  await user.type(screen.getByLabelText('理由（1行）'), '役を見て選んだ');
  await user.click(screen.getByRole('button', { name: '答え合わせ' }));
  await screen.findByRole('heading', { name: 'AIの評価（Mortal）' });
}

const tile = (name: string) => () => screen.getAllByRole('button', { name: `${name}を切る` })[0] as HTMLElement;
const option = (id: string) => () => document.querySelector<HTMLElement>(`[data-option="${id}"]`) as HTMLElement;

describe('U-33 欄「役」は、答え合わせのあとにだけ出る（U-1）', () => {
  it('答える前: 欄も、役の文字も、AI の印（data-ai）も無い。選んだだけ・理由を書いただけでも出ない', async () => {
    const { user } = renderQuiz(DISCARD);
    expect(document.querySelector('[data-ai]')).toBeNull();
    expect(screen.queryByRole('heading', { name: '役' })).toBeNull();
    expect(document.body.textContent).not.toMatch(/確定している役|近い役|役無し/);
    await user.click(tile('四筒')());
    await user.type(screen.getByLabelText('理由（1行）'), '途中');
    expect(document.querySelector('[data-ai="yaku-box"]')).toBeNull();
    expect(document.body.textContent).not.toMatch(/確定している役|近い役/);
  });

  it('答え合わせのあと: 受け入れ枚数の欄のすぐ下に、見出し「役」と説明のアイコンがある。欄は AI の情報なので data-ai を持つ', async () => {
    const { user } = renderQuiz(DISCARD);
    await reveal(user, tile('四筒'));
    // 答えたあとは、いつも「他家の手牌」のタブが付くので、受け入れ枚数の欄と役の欄は、既定のタブの欄の中に並ぶ
    const panel = within(document.getElementById('review') as HTMLElement).getByRole('tabpanel');
    const sections = [...panel.querySelectorAll(':scope > .q-sec, :scope > form.q-sec')];
    const titles = sections.map((s) => s.querySelector('h2')?.textContent);
    const at = titles.indexOf('受け入れ枚数');
    expect(at).toBeGreaterThanOrEqual(0);
    expect(titles[at + 1]).toBe('役');
    expect(sections[at + 1]).toBe(yakuBox());
    expect(within(yakuBox()).getByRole('heading', { level: 2, name: '役' })).toBeInTheDocument();
    expect(within(yakuBox()).getByRole('button', { name: '役の欄の説明' })).toBeInTheDocument();
    for (const row of rows()) expect(row).toHaveAttribute('data-ai', 'yaku');
  });

  it('説明の文は、本文に出さず、(i) に乗せる・選ぶと重ねて出る。Esc で閉じる（R11-1）', async () => {
    const { user } = renderQuiz(DISCARD);
    await reveal(user, tile('四筒'));
    expect(yakuBox().textContent).not.toContain('どう和了っても付く役です');
    expect(screen.queryByRole('tooltip')).toBeNull();
    const icon = within(yakuBox()).getByRole('button', { name: '役の欄の説明' });
    await user.hover(icon);
    expect(screen.getByRole('tooltip')).toHaveTextContent('確定している役は、その行動のあとの手が、どう和了っても付く役です');
    expect(screen.getByRole('tooltip')).toHaveTextContent('立直・門前清自摸和・ドラは数えません');
    await user.keyboard('{Escape}');
    expect(screen.queryByRole('tooltip')).toBeNull();
  });
});

describe('U-33 打牌の判断: 自分・実戦・AI の行動ごとの行。中身が全部同じなら 1 つにまとめる', () => {
  it('実戦と同じ打4p を選ぶと、自分・実戦（打4p）と AI（打7p）は近い役が同じなので、1 つにまとまる', async () => {
    const { user } = renderQuiz(DISCARD);
    await reveal(user, tile('四筒'));
    expect(rows()).toHaveLength(1);
    const row = rows()[0] as HTMLElement;
    expect(tagsOf(row)).toBe('どの行動でも同じ');
    // まとめたときは、行動の見出し（打牌・向聴数）を出さない
    expect(row.querySelector('.yk-dis')).toBeNull();
    expect(row.querySelector('.yk-sh')).toBeNull();
    expect(text(groupOf(row, '確定している役'))).toBe('なし');
    const near = [...groupOf(row, '近い役').querySelectorAll('.yk-item')];
    expect(near.map((item) => item.querySelector('.q-tag')?.textContent)).toEqual(['役牌 東（場風）', '断幺九']);
    expect(text(near[0]?.querySelector('.yk-d'))).toBe('東 東 が2枚。あと1枚（ポンかツモ）で付く');
    // 近い役の説明に、牌が画像で出る（東の牌 2 枚）
    expect(near[0]?.querySelectorAll('.yk-tiles img')).toHaveLength(2);
    expect(near[0]?.querySelector('img')?.getAttribute('alt')).toBe('東');
    // 門前の一言（薄い字の注）
    expect(text(row.querySelector('.yk-note'))).toBe('門前: 立直・門前清自摸和が使える');
  });

  it('東を切ると、近い役の中身が変わる（東が 1 枚に減る）ので、自分・実戦・AI の 3 行に分かれる。行ごとに、向聴数と見出し', async () => {
    const { user } = renderQuiz(DISCARD);
    await reveal(user, tile('東'));
    expect(rows().map(tagsOf)).toEqual(['自分', '実戦', 'AI']);
    expect(rows().map((r) => r.className)).toEqual(['yk-row you', 'yk-row act', 'yk-row top']);
    expect(rows().map((r) => text(r.querySelector('.yk-dis')))).toEqual(['打 東', '打 四筒', '打 七筒']);
    expect(rows().map((r) => text(r.querySelector('.yk-sh')))).toEqual(['2向聴', '1向聴', '1向聴']);
    // 自分（東を切る）: 断幺九が先、東は 1 枚（あと 2 枚）
    const mine = rows()[0] as HTMLElement;
    const near = [...groupOf(mine, '近い役').querySelectorAll('.yk-item')];
    expect(near.map((item) => item.querySelector('.q-tag')?.textContent)).toEqual(['断幺九', '役牌 東（場風）']);
    expect(text(near[1]?.querySelector('.yk-d'))).toBe('東 が1枚。あと2枚そろえると付く');
    // 近い役の行は 2 行まで
    for (const row of rows()) expect(groupOf(row, '近い役').querySelectorAll('.yk-item').length).toBeLessThanOrEqual(2);
  });
});

describe('U-33 鳴きの判断: チー・ポン・スルーを並べる。副露して役が無い行動の警告は、文字と枠で分かる', () => {
  it('東のポン・スルー: スルーを選ぶと、ポン（実戦・AI）とスルー（自分）の 2 行。ポンは役牌 東（場風）が確定（1飜（副露））', async () => {
    const { user } = renderQuiz(PON);
    await reveal(user, option('pass'));
    expect(rows().map(tagsOf)).toEqual(['実戦・AI', '自分']);
    expect(rows().map((r) => text(r.querySelector('.yk-dis')))).toEqual(['ポン 東 東 東', 'スルー']);
    const pon = rows()[0] as HTMLElement;
    expect(text(groupOf(pon, '確定している役'))).toBe('役牌 東（場風）1飜（副露）');
    expect(groupOf(pon, '確定している役').querySelector('.q-tag')?.className).toContain('sure');
    expect(text(pon.querySelector('.yk-sh'))).toBe('切れば聴牌');
    // 鳴いて門前を崩す一言と、聴牌になる切り方（役が付かない待ちは ×）
    const notes = text(pon.querySelector('.yk-note'));
    expect(notes).toContain('門前を崩す: 立直・門前清自摸和・平和・一盃口が付かなくなる');
    expect(notes).toContain('聴牌になる切り方: 打');
    expect(notes).toContain('（×は役が付かない待ち）');
    // スルーは、門前のまま。東の対子が近い役
    const pass = rows()[1] as HTMLElement;
    expect(text(groupOf(pass, '確定している役'))).toBe('なし');
    expect(groupOf(pass, '近い役').querySelector('.q-tag')?.textContent).toBe('役牌 東（場風）');
    expect(text(pass.querySelector('.yk-note'))).toContain('門前: 立直・門前清自摸和が使える');
  });

  it('チー（5s 7s）: 切れば聴牌でも、待ちがどれも役無し。札「役無し」（濃い枠）と太字の文で警告する。スルーは警告が無い', async () => {
    const { user } = renderQuiz(CHI);
    await reveal(user, option('chi:5s+7s'));
    // ボタンの並び（チー・チー・スルー）。自分・実戦・AI の行動を含め、印の無いチーは「候補」
    expect(rows().map(tagsOf)).toEqual(['自分', '候補', '実戦・AI']);
    expect(rows().map((r) => text(r.querySelector('.yk-dis')))).toEqual(['チー 五索 六索 七索', 'チー 六索 七索 八索', 'スルー']);
    const dead = rows()[0] as HTMLElement;
    const chip = groupOf(dead, '確定している役').querySelector('.q-tag');
    expect(chip?.textContent).toBe('役無し');
    expect(chip?.className).toContain('none');
    const explanation = groupOf(dead, '確定している役').querySelector('.yk-d');
    expect(explanation?.className).toContain('strong');
    expect(text(explanation)).toContain('役無し聴牌にしかならない。待ち');
    expect(text(explanation)).toContain('のどれでも、役が付かないので和了れない');
    expect(text(dead.querySelector('.yk-sh'))).toBe('切れば聴牌');
    // 警告の文字は、色以外（札の名前「役無し」・太字）でも伝わる。確定している役の札（sure）は付かない
    expect(groupOf(dead, '確定している役').querySelector('.q-tag.sure')).toBeNull();
    // チー（7s 8s）: 役はまだ確定していない（近い役を保てば付く）。強い警告ではなく、薄い注で伝える
    const open = rows()[1] as HTMLElement;
    expect(text(groupOf(open, '確定している役'))).toBe('なし');
    expect(open.querySelector('.q-tag.none')).toBeNull();
    expect(text(open.querySelector('.yk-note'))).toContain('副露した手の役は、まだ確定していない（近い役を保てば付く）');
    // スルー: 門前のまま。警告は無い
    const pass = rows()[2] as HTMLElement;
    expect(pass.querySelector('.q-tag.none')).toBeNull();
    expect(text(groupOf(pass, '確定している役'))).toBe('なし');
  });

  it('ポンもスルーも、確定している役・近い役・警告が同じ中身にならないので、まとまらない（まとまるのは、中身が全部同じときだけ）', async () => {
    const { user } = renderQuiz(PON);
    await reveal(user, option('pon'));
    expect(rows()).toHaveLength(2);
    expect(rows().map(tagsOf)).toEqual(['自分・実戦・AI', '候補']);
  });
});

describe('U-33 出題・解き直し・保存済みの答えを開いたとき', () => {
  it('解き直し: 答え合わせのあとに、同じ欄が出る。答える前には出ない', async () => {
    const { user } = renderQuiz({ ...DISCARD, mode: 'review', previousIntervalDays: 3 });
    expect(document.querySelector('[data-ai="yaku-box"]')).toBeNull();
    await reveal(user, tile('四筒'));
    expect(yakuBox()).toBeInTheDocument();
    expect(rows().length).toBeGreaterThanOrEqual(1);
  });

  it('保存してある答えを開くと、はじめから答え合わせのあとの形で、欄が出る', () => {
    const key = keyOfDecision(decisionOf(DISCARD.report, { find: DISCARD.find }));
    renderQuiz({
      ...DISCARD,
      existing: answerRow({ session_id: 'sess', decision_key: key, choice: { type: 'dahai', tile: '4p' }, reason: '保存済み' }),
    });
    expect(yakuBox()).toBeInTheDocument();
    expect(tagsOf(rows()[0] as HTMLElement)).toBe('どの行動でも同じ');
  });
});
