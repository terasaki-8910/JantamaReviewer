import { opponentTracksOf, openHandsAt, type Decision } from '@jantama/engine';
import { cleanup, screen, within } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { game, renderQuiz } from '../../../tests/study-harness';
import { revealed } from '../../../tests/reveal';
import { replayStepFrames } from './steps';

// 他家の手牌（F14、E-40・E-43、U-34・U-35・U-38。R15-2・R15-5・R16-7）の、出題・解き直しの画面の試験。
// 手牌は、盤面の他家の河の外側に、裏向きで置く。どれか 1 人の手牌を押す（クリック・Enter・Space）と、3 人分が表向きに開き、もう一度押すと閉じる。
// 河を押しても開かない。答えるまでは押せず、表の牌は DOM にも無い（U-1・U-35）。開いているあいだ、答えの欄の上に「他家の手牌」の欄
// （席の札・聴牌になった巡目の 1 行・向聴数の折れ線・待ちと点。牌の並びは盤面だけ）が出る。
// 他家の手牌と待ちの正しさは、エンジンの試験（open-hands.test.ts）が、majiang-core の待ちと、承認済みの見本の値で固めている。
// 聴牌になった巡目の印（枠・1 行・折れ線・帯の目盛り。U-38）は、開いているときだけ DOM にある。帯の目盛りは、通して見る画面の試験（Replay.test.tsx）。
// 実ブラウザでの見え方（横スクロール・axe・Tab の順・盤面と欄が重ならない）は tests/browser/replay.browser.test.ts。

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
/** 早い巡の打牌の場面（FX-1a。他家は、まだ誰も聴牌になっていない）。 */
const EARLY = {
  report: 'fx1a' as const,
  find: (d: Decision) => d.kind === 'discard' && opponentTracksOf(game('fx1a'), d.kyokuPosition).seats.every((track) => track.marks.every((mark) => mark.eventIndex > d.eventIndex)),
};

async function reveal(user: ReturnType<typeof renderQuiz>['user'], pick: () => HTMLElement) {
  await user.click(pick());
  await user.type(screen.getByLabelText('理由（1行）'), '待ちを見て選んだ');
  await user.click(screen.getByRole('button', { name: '答え合わせ' }));
  await revealed();
}

const firstTile = () => screen.getAllByRole('button', { name: /を切る$/ })[0] as HTMLElement;
const hands = (): HTMLButtonElement[] => [...document.querySelectorAll<HTMLButtonElement>('.ohand')];
const block = () => document.querySelector<HTMLElement>('[data-open-hands="block"]');
const tabNames = (): string[] => screen.queryAllByRole('tab').map((t) => t.textContent ?? '');

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

/** 盤面の他家の手牌の、人ごとの（裏向きの牌の数・表向きの牌の数・ツモ牌の数）。下家・対面・上家の順。 */
const onBoard = () =>
  ['right', 'top', 'left'].map((position) => {
    const zone = document.querySelector(`.hzone.${position}`) as HTMLElement;
    return {
      backs: zone.querySelectorAll('.tile.back').length,
      faces: zone.querySelectorAll('.tile img').length,
      drawn: zone.querySelectorAll('.hdraw').length,
    };
  });

/** エンジンから求めた、その時点の他家の手牌（画面と別の経路）。 */
const expectedAt = (report: Parameters<typeof game>[0], kyokuPosition: number, eventIndex: number) =>
  openHandsAt(game(report), kyokuPosition, eventIndex).map((seat) => ({ faces: seat.hand.length + (seat.drawn === null ? 0 : 1), drawn: seat.drawn === null ? 0 : 1 }));

const facesAndDrawn = () => onBoard().map((s) => ({ faces: s.faces, drawn: s.drawn }));

describe('U-35 答える前は、押せず、表の牌は DOM に無い（U-1）', () => {
  it('盤面には、他家 3 人の裏向きの手牌のボタンがある。押せない（disabled）。表の牌・他家の手牌の欄・AI の印は無い。選んだだけ・理由を書いただけでも同じ', async () => {
    const { user, decision } = renderQuiz(DEAL_IN);
    const clean = () => {
      expect(hands()).toHaveLength(3);
      for (const button of hands()) {
        expect(button).toBeDisabled();
        expect(button).toHaveAccessibleName('他家の手牌を開く');
        expect(button).toHaveAccessibleDescription(/答えを出すまで開けません/);
        expect(button).toHaveAttribute('aria-pressed', 'false');
        expect(button.querySelectorAll('img')).toHaveLength(0);
      }
      expect(block()).toBeNull();
      expect(document.querySelector('[data-ai]')).toBeNull();
      expect(document.querySelector('.oh-list, .oh-row, .oh-hand, .tile.tp, .tp-line, .shchart, .hands-hint')).toBeNull();
      expect(document.body.textContent).not.toMatch(/他家の手牌は、押すと|聴牌していません|切る前の手/);
      // 裏向きの牌の数は、盤面の枚数のとおり（牌そのものは無い）
      expect(onBoard().map((s) => s.backs)).toEqual([1, 2, 3].map((offset) => decision.board.handCounts[(decision.board.playerId + offset) % 4]));
    };
    clean();
    await user.click(hands()[0] as HTMLElement);
    clean();
    await user.click(firstTile());
    await user.type(screen.getByLabelText('理由（1行）'), '途中');
    clean();
    await user.click(hands()[1] as HTMLElement);
    clean();
  });
});

describe('U-35 答えたあと: 1 人の手牌を押すと 3 人分が開く。もう一度押すと閉じる', () => {
  it('既定は閉じている（裏向き）。凡例の下に、押すと開く旨の 1 行。押すと 3 人とも表向きになり、「他家の手牌」の欄が出る。もう一度押すと閉じる', async () => {
    const { user, decision } = renderQuiz(DEAL_IN);
    await reveal(user, firstTile);
    expect(hands()).toHaveLength(3);
    for (const button of hands()) {
      expect(button).toBeEnabled();
      expect(button).toHaveAccessibleName('他家の手牌を開く');
    }
    expect(block()).toBeNull();
    expect(document.querySelector('.hands-hint')?.textContent).toBe('他家の手牌は、押すと3人とも開きます（もう一度押すと閉じます）');
    // 1 人（上家）の手牌を押すと、3 人分が開く
    await user.click(hands()[2] as HTMLElement);
    for (const button of hands()) {
      expect(button).toHaveAccessibleName('他家の手牌を閉じる');
      expect(button).toHaveAttribute('aria-pressed', 'true');
      expect(button.querySelectorAll('.tile.back')).toHaveLength(0);
    }
    expect(facesAndDrawn()).toEqual(expectedAt('fx4', decision.kyokuPosition, decision.eventIndex));
    expect(block()).not.toBeNull();
    expect([...(block() as HTMLElement).querySelectorAll('.oh-row .oh-hd b')].map((b) => b.textContent)).toEqual(['下家', '対面', '上家']);
    // もう一度（別の人の手牌を）押すと、3 人分が閉じる
    await user.click(hands()[0] as HTMLElement);
    for (const button of hands()) expect(button).toHaveAccessibleName('他家の手牌を開く');
    expect(block()).toBeNull();
    expect(document.querySelector('.tile.tp, .tp-line, .shchart')).toBeNull();
    expect(onBoard().every((s) => s.faces === 0 && s.backs > 0)).toBe(true);
  });

  it('河を押しても、開かない（河は、手牌のボタンの外）', async () => {
    const { user } = renderQuiz(DEAL_IN);
    await reveal(user, firstTile);
    for (const river of document.querySelectorAll<HTMLElement>('.zone .river .rt')) expect(river.closest('.ohand')).toBeNull();
    await user.click(document.querySelector('.zone.top .river .rt') as HTMLElement);
    await user.click(document.querySelector('.zone.right .river .rt') as HTMLElement);
    expect(block()).toBeNull();
    for (const button of hands()) expect(button).toHaveAttribute('aria-pressed', 'false');
  });

  it('キーボード: 手牌のボタンは Enter で開き、Space で閉じる。開いているときのボタンの説明に、その人の手牌が書いてある（読み上げ用）', async () => {
    const { user } = renderQuiz(DEAL_IN);
    await reveal(user, firstTile);
    const second = hands()[1] as HTMLButtonElement;
    second.focus();
    expect(second).toHaveFocus();
    await user.keyboard('{Enter}');
    expect(block()).not.toBeNull();
    expect(hands()[1]).toHaveAccessibleName('他家の手牌を閉じる');
    expect(hands()[1]).toHaveFocus();
    expect(hands()[1]).toHaveAccessibleDescription(/^対面の手牌: .+押すと、他家 3 人の手牌が閉じます$/);
    await user.keyboard(' ');
    expect(block()).toBeNull();
    expect(hands()[1]).toHaveAccessibleName('他家の手牌を開く');
    expect(hands()[1]).toHaveAccessibleDescription(/^対面の手牌（裏向き \d+枚）。押すと、他家 3 人の手牌が開きます$/);
    await user.keyboard('{Enter}');
    expect(hands()[1]).toHaveAttribute('aria-pressed', 'true');
  });

  it('他家の副露は、盤面の副露の置き場のまま。手牌（閉じた部分）の枚数は、副露の分だけ減る。ツモ牌は少し離す', async () => {
    const { user, decision } = renderQuiz(WITH_MELD);
    await reveal(user, firstTile);
    // 閉じているときの、裏向きの牌と、ツモ牌の離し方も、盤面の枚数のとおり
    const before = onBoard();
    expect(before.map((s) => s.backs)).toEqual([1, 2, 3].map((offset) => decision.board.handCounts[(decision.board.playerId + offset) % 4]));
    expect(before.map((s) => s.drawn)).toEqual([1, 2, 3].map((offset) => (decision.board.handDrawn[(decision.board.playerId + offset) % 4] ? 1 : 0)));
    await user.click(hands()[0] as HTMLElement);
    const seats = openHandsAt(game('fx4'), decision.kyokuPosition, decision.eventIndex);
    expect(onBoard().map((s) => s.faces)).toEqual(seats.map((seat) => seat.hand.length + (seat.drawn === null ? 0 : 1)));
    expect(facesAndDrawn()).toEqual(expectedAt('fx4', decision.kyokuPosition, decision.eventIndex));
    expect(document.querySelector('.corner .melds .meld')).not.toBeNull();
    // 「他家の手牌」の欄に、牌の並びは出さない（盤面に出ている）
    expect((block() as HTMLElement).querySelector('.oh-hand, .oh-tiles, .oh-melds')).toBeNull();
  });

  it('巡目を戻って見る（過去の盤面）でも、開いたまま。その時点の他家の手牌に替わる。画面を作り直す（別の問題へ）と、閉じに戻る', async () => {
    const { user, decision, unmount } = renderQuiz(DEAL_IN);
    await reveal(user, firstTile);
    await user.click(hands()[0] as HTMLElement);
    const frames = replayStepFrames(game('fx4'), decision);
    expect(frames.length).toBeGreaterThan(2);
    await user.click(screen.getByRole('button', { name: '前の巡目' }));
    expect(hands()[0]).toHaveAccessibleName('他家の手牌を閉じる');
    expect(facesAndDrawn()).toEqual(expectedAt('fx4', decision.kyokuPosition, (frames[frames.length - 2] as { eventIndex: number }).eventIndex));
    await user.click(screen.getByRole('button', { name: '前の巡目' }));
    expect(facesAndDrawn()).toEqual(expectedAt('fx4', decision.kyokuPosition, (frames[frames.length - 3] as { eventIndex: number }).eventIndex));
    expect(block()).not.toBeNull();
    unmount();
    renderQuiz(DEAL_IN);
    for (const button of hands()) expect(button).toHaveAccessibleName('他家の手牌を開く');
    expect(block()).toBeNull();
  });

  it('答え合わせのタブに、「他家の手牌」は無い（R16-7）。解き直し（review）でも、答えるまで押せず、答えたあとに、盤面の手牌で開く', async () => {
    const plain = renderQuiz(EARLY);
    await reveal(plain.user, firstTile);
    expect(tabNames()).not.toContain('他家の手牌');
    plain.unmount();
    const again = renderQuiz({ ...DEAL_IN, mode: 'review' });
    expect(hands().every((button) => button.disabled)).toBe(true);
    await reveal(again.user, firstTile);
    expect(tabNames()).not.toContain('他家の手牌');
    await again.user.click(hands()[1] as HTMLElement);
    expect(block()).not.toBeNull();
  });
});

describe('「他家の手牌」の欄（開いているときだけ。牌の並びは盤面）', () => {
  async function open(options: Parameters<typeof renderQuiz>[0]) {
    const view = renderQuiz(options);
    await reveal(view.user, firstTile);
    await view.user.click(hands()[0] as HTMLElement);
    return { ...view, box: block() as HTMLElement };
  }

  it('見出し・説明のアイコン・下家／対面／上家の 3 人の行。席の札（風・親・リーチ）。牌の並び（.oh-hand）は出さない', async () => {
    const { box } = await open(DEAL_IN);
    expect(within(box).getByRole('heading', { level: 2, name: '他家の手牌' })).toBeInTheDocument();
    expect(within(box).getByRole('button', { name: '他家の手牌の説明' })).toBeInTheDocument();
    const rows = [...box.querySelectorAll<HTMLElement>('.oh-row')];
    expect(rows.map((row) => row.querySelector('.oh-hd b')?.textContent)).toEqual(['下家', '対面', '上家']);
    const chips = (row: Element | undefined) => [...(row?.querySelectorAll('.oh-hd .q-tag') ?? [])].map((chip) => chip.textContent);
    expect(chips(rows[0])).toEqual(['北家']);
    expect(chips(rows[1])).toEqual(['東家', '親']);
    expect(box.querySelector('.oh-hand, .oh-tiles')).toBeNull();
  });

  it('説明のアイコン: 手牌は盤面にあること、残り・点の数え方、聴牌の印と折れ線の見方を書く（乗せると重ねて出る）', async () => {
    const { user, box } = await open(DEAL_IN);
    expect(box.textContent).not.toContain('場に見えていない枚数');
    await user.hover(within(box).getByRole('button', { name: '他家の手牌の説明' }));
    const tip = screen.getByRole('tooltip');
    expect(tip).toHaveTextContent('手牌の牌は、盤面の、他家の河の外側に出ています');
    expect(tip).toHaveTextContent('場に見えていない枚数');
    expect(tip).toHaveTextContent('聴牌になった打牌は、河の枠（右上の三角つき）と、この欄の 1 行で示します');
    expect(tip).toHaveTextContent('折れ線は、その人が切るたびの向聴数で、▲ が聴牌になった打牌です');
  });

  it('見本の場面（東3局 5巡目）: 対面は親で、4s は残り 1・4飜 50符 12,000、7s は残り 4・役なし。ほかの 2 人は聴牌していない', async () => {
    const { box } = await open(DEAL_IN);
    const [down, across, up] = [...box.querySelectorAll('.oh-row')] as HTMLElement[];
    const waits = text(across?.querySelector('.oh-w'));
    expect(waits).toContain('待ち');
    expect(waits).toContain('四索 両面・残り1・4飜 50符 12,000');
    expect(waits).toContain('七索 両面・残り4・役なし');
    // 聴牌していない人は、1 行が「まだ聴牌していません（n向聴）」。「聴牌していません」だけの行は、重ねて出さない
    expect(text(down?.querySelector('.tp-line'))).toMatch(/^まだ聴牌していません（\d向聴）$/);
    expect(text(up?.querySelector('.tp-line'))).toMatch(/^まだ聴牌していません（\d向聴）$/);
    expect(down?.querySelector('.oh-no')).toBeNull();
    expect(up?.querySelector('.oh-no')).toBeNull();
  });

  it('リーチしている人には「リーチ」の札。立直で数えた点が出る（見本: 上家の發の単騎は、残り 2・4飜 25符 6,400）', async () => {
    const { box } = await open(RIICHI);
    const up = [...box.querySelectorAll('.oh-row')].at(-1) as HTMLElement;
    expect([...up.querySelectorAll('.oh-hd .q-tag')].map((chip) => chip.textContent)).toContain('リーチ');
    expect(text(up.querySelector('.oh-w'))).toContain('發 単騎・残り2・4飜 25符 6,400');
  });

  it('符の数にマウスを乗せると、内訳が重なって出る（待ちと打点・局の結果の手と同じ部品）', async () => {
    const { user, box } = await open(DEAL_IN);
    const fu = within(box).getByRole('button', { name: /^50符の内訳/ });
    await user.hover(fu);
    expect(screen.getByRole('tooltip')).toHaveTextContent('50符の内訳');
    await user.keyboard('{Escape}');
    expect(screen.queryByRole('tooltip')).toBeNull();
  });
});

describe('U-38 聴牌になった巡目: 開いているときだけ、枠・凡例・1 行・折れ線が DOM にある（R16-7 の A）', () => {
  it('閉じているときは、どれも DOM に無い。開くと、聴牌になった打牌の枠（河）・凡例の項目・人ごとの 1 行と折れ線が出る。閉じると、また消える', async () => {
    const { user, decision } = renderQuiz(DEAL_IN);
    await reveal(user, firstTile);
    const none = () => {
      expect(document.querySelector('.tile.tp, .tp-line, .tp-key, .shchart, .tk')).toBeNull();
      expect(document.querySelector('.legend .tile.tp')).toBeNull();
      expect(document.body.textContent).not.toMatch(/聴牌になった|に聴牌（|聴牌していません/);
      expect([...document.querySelectorAll<HTMLImageElement>('.river img')].some((img) => img.alt.includes('聴牌になった打牌'))).toBe(false);
    };
    none();
    await user.click(hands()[0] as HTMLElement);
    // 枠: エンジンの印のうち、いまの手までのもの（河の位置 n - 1）
    const tracks = opponentTracksOf(game('fx4'), decision.kyokuPosition);
    const marks = tracks.seats.flatMap((track) => track.marks.filter((mark) => mark.eventIndex <= decision.eventIndex));
    expect(marks.length).toBeGreaterThan(0);
    expect(document.querySelectorAll('.river .tile.tp')).toHaveLength(marks.length);
    expect([...document.querySelectorAll<HTMLImageElement>('.river .tile.tp img')].every((img) => img.alt.includes('（聴牌になった打牌）'))).toBe(true);
    expect(document.querySelector('.legend .tile.tp')).not.toBeNull();
    expect(text(document.querySelector('.legend'))).toContain('聴牌になった打牌');
    // 人ごとの 1 行と折れ線（3 人分）
    expect(document.querySelectorAll('.oh-row .tp-line')).toHaveLength(3);
    expect(document.querySelectorAll('.oh-row .shchart')).toHaveLength(3);
    await user.click(hands()[1] as HTMLElement);
    none();
  });

  it('見本の場面（東3局 5巡目）: 対面の 1 行は「3巡目に聴牌（4sをツモって 打6p・手出し） 待ち 4s・7s」。聴牌の人の 1 行には三角の印。ほかの人は印が無い', async () => {
    const { user } = renderQuiz(DEAL_IN);
    await reveal(user, firstTile);
    await user.click(hands()[0] as HTMLElement);
    const [down, across, up] = [...(block() as HTMLElement).querySelectorAll('.oh-row')] as HTMLElement[];
    expect(text(across?.querySelector('.tp-line'))).toBe('3巡目に聴牌（4sをツモって 打6p・手出し） 待ち 4s・7s');
    expect(across?.querySelector('.tp-line .tp-key')).not.toBeNull();
    expect(down?.querySelector('.tp-line .tp-key')).toBeNull();
    expect(up?.querySelector('.tp-line .tp-key')).toBeNull();
    // 河の枠は、対面の河の 3 枚目（その人の 3 枚目の打牌）だけ
    const marked = [...document.querySelectorAll('.zone.top .river .rt')].map((item) => item.querySelector('.tile.tp') !== null);
    expect(marked.filter(Boolean)).toHaveLength(1);
    expect(marked.indexOf(true)).toBe(2);
  });

  it('向聴数の折れ線: 人ごとに 1 つの止まり場所（Tab）。矢印キーで点を選ぶと吹き出し（値が先、名前があと）が出る。Esc で消える', async () => {
    const { user } = renderQuiz(DEAL_IN);
    await reveal(user, firstTile);
    await user.click(hands()[0] as HTMLElement);
    const charts = screen.getAllByRole('group', { name: /の向聴数の推移（矢印キーで点を選ぶ）$/ });
    expect(charts.map((chart) => chart.getAttribute('aria-label'))).toEqual([
      '下家の向聴数の推移（矢印キーで点を選ぶ）',
      '対面の向聴数の推移（矢印キーで点を選ぶ）',
      '上家の向聴数の推移（矢印キーで点を選ぶ）',
    ]);
    const across = charts[1] as HTMLElement;
    expect(across).toHaveAttribute('tabindex', '0');
    // 読み上げ用の説明に、点ごとの値が書いてある
    const described = document.getElementById(across.getAttribute('aria-describedby') ?? '') as HTMLElement;
    expect(described.textContent).toContain('配牌: ');
    expect(described.textContent).toContain('3枚目 打6p（手出し）: 聴牌');
    across.focus();
    const tip = document.querySelector<HTMLElement>('.wk-tip') as HTMLElement;
    expect(tip.hidden).toBe(false);
    await user.keyboard('{Home}');
    expect(tip.querySelector('.wk-tip-l')?.textContent).toBe('配牌');
    expect(tip.querySelector('.wk-tip-v')?.textContent).toMatch(/^(聴牌|\d向聴)$/);
    await user.keyboard('{End}');
    expect(tip.querySelector('.wk-tip-l')?.textContent).toMatch(/^\d+枚目 打/);
    await user.keyboard('{Escape}');
    expect(tip.hidden).toBe(true);
  });

  it('聴牌していない人ばかり（早い巡目）でも、1 行と折れ線は出る。印（枠・三角）は出ない', async () => {
    const { user } = renderQuiz(EARLY);
    await reveal(user, firstTile);
    await user.click(hands()[0] as HTMLElement);
    expect(document.querySelectorAll('.oh-row .tp-line')).toHaveLength(3);
    // 河の枠も、1 行の三角も無い（凡例の項目は、開いているあいだ、いつも出る）
    expect(document.querySelector('.river .tile.tp, .tp-key')).toBeNull();
    for (const line of document.querySelectorAll('.oh-row .tp-line')) expect(text(line)).toMatch(/^まだ聴牌していません（\d向聴）$/);
  });
});
