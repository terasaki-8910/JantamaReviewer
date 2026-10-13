import { openHandsAt, type Decision } from '@jantama/engine';
import { cleanup, screen, within } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { game, renderQuiz } from '../../../tests/study-harness';

// 答え合わせのタブ「他家の手牌」（F14、E-40、U-34・U-35。R15-2・R15-5。提案 5）の画面の試験。
// 他家の手牌と待ちの正しさは、エンジンの試験（open-hands.test.ts）が、majiang-core の待ちと、承認済みの見本の値で固めている。
// ここでは、答える前は DOM のどこにも無いこと（U-1・U-35）、答えたあとはどの場面にも出ること、キーボード、欄の中身（人ごとの札・手牌・副露・待ち・点・符の内訳）を確かめる。
// 実ブラウザでの見え方（横スクロール・axe・Tab の順）は tests/browser/replay.browser.test.ts、通して見る画面の開閉は replay の試験。

beforeEach(() => {
  vi.useFakeTimers({ toFake: ['Date'] });
  vi.setSystemTime(new Date(2026, 9, 9, 22, 0, 0));
});

afterEach(() => {
  cleanup();
  vi.useRealTimers();
});

/** FX-4 東3局 5巡目 打牌（見本: 親（対面）が 4s・7s 待ちの聴牌（ダマ）。実戦は 4s のツモ切りで放銃）。 */
const DEAL_IN = { report: 'fx4' as const, find: (d: Decision) => d.kyokuLabel === '東3局' && d.entryIndex === 4 };
/** FX-4 東1局 14巡目 打牌（見本: 上家がリーチ、發の単騎待ち）。 */
const RIICHI = { report: 'fx4' as const, find: (d: Decision) => d.kyokuLabel === '東1局' && d.entryIndex === 13 };
/** 他家の副露がある場面（FX-4 の最初のもの）。 */
const WITH_MELD = {
  report: 'fx4' as const,
  find: (d: Decision) => d.kind === 'discard' && openHandsAt(game('fx4'), d.kyokuPosition, d.eventIndex).some((s) => s.melds.length > 0 && s.hand.length > 0),
};

async function reveal(user: ReturnType<typeof renderQuiz>['user'], pick: () => HTMLElement) {
  await user.click(pick());
  await user.type(screen.getByLabelText('理由（1行）'), '待ちを見て選んだ');
  await user.click(screen.getByRole('button', { name: '答え合わせ' }));
  await screen.findByRole('heading', { name: 'AIの評価（Mortal）' });
}

const firstTile = () => screen.getAllByRole('button', { name: /を切る$/ })[0] as HTMLElement;
const tabs = (): HTMLElement[] => screen.queryAllByRole('tab');
const tabNames = (): string[] => tabs().map((t) => t.textContent ?? '');

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

async function openTab(user: ReturnType<typeof renderQuiz>['user']) {
  await user.click(screen.getByRole('tab', { name: '他家の手牌' }));
  return document.querySelector('[data-ai="open-hands"]') as HTMLElement;
}

describe('U-35 答える前は、他家の手牌も、そのタブも、DOM に無い（U-1）', () => {
  it('答える前は、タブも、他家の手牌の文字も、手牌の牌も、data-ai も無い。選んだだけ・理由を書いただけでも出ない', async () => {
    const { user } = renderQuiz(DEAL_IN);
    const clean = () => {
      expect(document.querySelector('[data-ai]')).toBeNull();
      expect(screen.queryByRole('tablist')).toBeNull();
      expect(document.querySelector('.oh-list, .oh-row, .oh-hand')).toBeNull();
      expect(document.body.textContent).not.toMatch(/他家の手牌|聴牌していません|切る前の手/);
    };
    clean();
    await user.click(firstTile());
    await user.type(screen.getByLabelText('理由（1行）'), '途中');
    clean();
  });
});

describe('U-34 タブ「他家の手牌」は、答えたあとの、どの場面にも出る', () => {
  it('答えたあと、いちばん右のタブとして出る（聴牌でも、リーチがあっても、何もなくても）。解き直し（review）でも出る', async () => {
    const plain = renderQuiz({ report: 'fx1a' });
    await reveal(plain.user, firstTile);
    expect(tabNames()).toEqual(['受け入れ・役', '他家の手牌']);
    plain.unmount();
    const riichi = renderQuiz(RIICHI);
    await reveal(riichi.user, firstTile);
    expect(tabNames().at(-1)).toBe('他家の手牌');
    riichi.unmount();
    const again = renderQuiz({ ...DEAL_IN, mode: 'review' });
    await reveal(again.user, firstTile);
    expect(tabNames().at(-1)).toBe('他家の手牌');
  });

  it('中身は、タブを選ぶまで描かない。選ぶと、見出しと説明のアイコン、下家・対面・上家の 3 人の行が出る。矢印キーで選べて、キーボードの位置も移る', async () => {
    const { user } = renderQuiz(DEAL_IN);
    await reveal(user, firstTile);
    expect(document.querySelector('[data-ai="open-hands"]')).toBeNull();
    const all = tabs();
    all[0]?.focus();
    await user.keyboard('{End}');
    const last = all.at(-1) as HTMLElement;
    expect(last).toHaveAccessibleName('他家の手牌');
    expect(last).toHaveAttribute('aria-selected', 'true');
    expect(last).toHaveFocus();
    const box = document.querySelector('[data-ai="open-hands"]') as HTMLElement;
    expect(within(box).getByRole('heading', { level: 2, name: '他家の手牌' })).toBeInTheDocument();
    expect(within(box).getByRole('button', { name: '他家の手牌の説明' })).toBeInTheDocument();
    const rows = [...box.querySelectorAll('.oh-row')];
    expect(rows.map((row) => row.querySelector('.oh-hd b')?.textContent)).toEqual(['下家', '対面', '上家']);
    // 手牌は、聴牌していない人も、13 枚（切ったあとの手）
    for (const row of rows) expect(row.querySelectorAll('.oh-hand .tile')).toHaveLength(13);
  });

  it('見本の場面（東3局 5巡目）: 対面は親で、4s は残り 1・4飜 50符 12,000、7s は残り 4・役なし。ほかの 2 人は「聴牌していません」', async () => {
    const { user } = renderQuiz(DEAL_IN);
    await reveal(user, firstTile);
    const box = await openTab(user);
    const [down, across, up] = [...box.querySelectorAll('.oh-row')] as HTMLElement[];
    const chips = (row: Element | undefined) => [...(row?.querySelectorAll('.oh-hd .q-tag') ?? [])].map((chip) => chip.textContent);
    expect(chips(down)).toEqual(['北家']);
    expect(text(down)).toContain('聴牌していません');
    expect(chips(across)).toEqual(['東家', '親']);
    const waits = text(across?.querySelector('.oh-w'));
    expect(waits).toContain('待ち');
    expect(waits).toContain('四索 両面・残り1・4飜 50符 12,000');
    expect(waits).toContain('七索 両面・残り4・役なし');
    expect(text(up)).toContain('聴牌していません');
  });

  it('リーチしている人には「リーチ」の札。立直で数えた点が出る（見本: 上家の發の単騎は、残り 2・4飜 25符 6,400）', async () => {
    const { user } = renderQuiz(RIICHI);
    await reveal(user, firstTile);
    const box = await openTab(user);
    const up = [...box.querySelectorAll('.oh-row')].at(-1) as HTMLElement;
    expect([...up.querySelectorAll('.oh-hd .q-tag')].map((chip) => chip.textContent)).toContain('リーチ');
    expect(text(up.querySelector('.oh-w'))).toContain('發 単騎・残り2・4飜 25符 6,400');
  });

  it('符の数にマウスを乗せると、内訳が重なって出る（待ちと打点・局の結果の手と同じ部品）', async () => {
    const { user } = renderQuiz(DEAL_IN);
    await reveal(user, firstTile);
    const box = await openTab(user);
    const fu = within(box).getByRole('button', { name: /^50符の内訳/ });
    await user.hover(fu);
    expect(screen.getByRole('tooltip')).toHaveTextContent('50符の内訳');
    await user.keyboard('{Escape}');
    expect(screen.queryByRole('tooltip')).toBeNull();
  });

  it('他家の副露は、手牌の右に、盤面と同じ並べ方（.meld）で出る。副露の分だけ手牌の枚数は減る', async () => {
    const { user, decision } = renderQuiz(WITH_MELD);
    await reveal(user, firstTile);
    const box = await openTab(user);
    const seats = openHandsAt(game('fx4'), decision.kyokuPosition, decision.eventIndex);
    const rows = [...box.querySelectorAll('.oh-row')];
    seats.forEach((seat, index) => {
      const row = rows[index] as HTMLElement;
      expect(row.querySelectorAll('.oh-melds .meld')).toHaveLength(seat.melds.length);
      expect(row.querySelectorAll('.oh-tiles:not(.gap) .tile')).toHaveLength(seat.hand.length);
    });
    expect(box.querySelector('.oh-melds .meld')).not.toBeNull();
  });
});
