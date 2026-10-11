import { answerOptions, tileKind, type Decision } from '@jantama/engine';
import { cleanup, screen, within } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { answerRow } from '../../../tests/fake-study';
import { decisionOf, renderQuiz } from '../../../tests/study-harness';
import { doraKinds } from './dora';


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
const gate = () => document.getElementById('gate')?.textContent ?? '';
const drawn = () => screen.getByRole('button', { name: '一索（ツモ牌）を切る' });
/** 受け入れ枚数の行（名札で探す。例: 自分・最大）。 */
const ukRow = (tags: string): HTMLElement => {
  const row = [...document.querySelectorAll<HTMLElement>('.uk-open')].find((b) => b.querySelector('.uk-tags')?.textContent === tags);
  if (row === undefined) throw new Error(`受け入れ枚数の行が無い: ${tags}`);
  return row;
};

async function answer(user: ReturnType<typeof renderQuiz>['user'], pick: () => HTMLElement, reason = '受け入れを広く') {
  await user.click(pick());
  await user.type(reasonBox(), reason);
  await user.click(submit());
  await screen.findByRole('heading', { name: 'AIの評価（Mortal）' });
}

describe('U-1 答える前は、AI の候補・確率・順位を DOM に出さない（打牌の判断）', () => {
  it('見出しに実戦の行動（実戦：打3m）。AI の情報は、属性にも文字にも無い', () => {
    renderQuiz();
    expect(screen.getByRole('heading', { level: 1, name: '東4局 13巡目' })).toBeInTheDocument();
    expect(screen.getByText('1シャンテン')).toBeInTheDocument();
    expect(screen.getByText('実戦：打3m')).toBeInTheDocument();
    expect(document.querySelector('[data-ai]')).toBeNull();
    expect(document.body.textContent).not.toMatch(/\d\s*%|Mortal|AIの評価（/);
    expect(document.body.innerHTML).not.toMatch(/data-ai|data-mark|data-ring/);
    // 手牌に印は付かない
    expect(document.querySelector('.mks')?.textContent ?? '').toBe('');
    // 受け入れ枚数・原因・MAKA の欄も、まだ無い
    expect(screen.queryByText('受け入れ枚数')).toBeNull();
    expect(screen.queryByText('MAKA の推した打牌')).toBeNull();
  });

  it('選んだだけ・理由を書いただけの途中でも、AI の情報は出ない', async () => {
    const { user } = renderQuiz();
    await user.click(drawn());
    await user.type(reasonBox(), '受け入れを広く');
    expect(submit()).toBeEnabled();
    expect(document.querySelector('[data-ai]')).toBeNull();
    expect(document.body.textContent).not.toMatch(/\d\s*%|Mortal/);
  });
});

describe('U-2 答え合わせは、答えと理由がそろうまで押せない', () => {
  it('牌・理由の順にそろうと押せる。足りないものを、押せない理由として文で出す', async () => {
    const { user, probe } = renderQuiz();
    expect(submit()).toBeDisabled();
    expect(gate()).toBe('切る牌を選び、理由を1行書くと押せます');
    await user.click(drawn());
    expect(submit()).toBeDisabled();
    expect(gate()).toBe('理由を1行書くと押せます');
    await user.type(reasonBox(), '   ');
    expect(submit()).toBeDisabled();
    await user.clear(reasonBox());
    await user.click(drawn());
    expect(gate()).toBe('切る牌を選び、理由を1行書くと押せます');
    await user.type(reasonBox(), 'まず理由');
    expect(submit()).toBeDisabled();
    expect(gate()).toBe('切る牌を選ぶと押せます');
    // 理由の欄で Enter を押しても、牌が無ければ答え合わせにならない
    await user.type(reasonBox(), '{Enter}');
    expect(probe.recorded).toEqual([]);
    await user.click(drawn());
    expect(submit()).toBeEnabled();
    expect(gate()).toBe('AIの評価が出ます。出したあとは答えを変えられません');
  });

  it('手牌は、Tab の止まり場所が 1 つ。矢印キー・Home・End で牌の間を動き、Space で選ぶ・もう一度で外す', async () => {
    const { user } = renderQuiz();
    const buttons = handButtons();
    expect(buttons).toHaveLength(14);
    expect(buttons.filter((button) => button.tabIndex === 0)).toHaveLength(1);
    expect(buttons[0]?.tabIndex).toBe(0);
    buttons[0]?.focus();
    await user.keyboard('{ArrowRight}');
    expect(buttons[1]).toHaveFocus();
    await user.keyboard('{End}');
    expect(buttons[13]).toHaveFocus();
    await user.keyboard('{ArrowRight}');
    expect(buttons[13]).toHaveFocus();
    await user.keyboard('{Home}');
    expect(buttons[0]).toHaveFocus();
    await user.keyboard(' ');
    expect(buttons[0]).toHaveAttribute('aria-pressed', 'true');
    // 選んだ牌が、Tab の止まり場所
    expect(handButtons().filter((button) => button.tabIndex === 0)).toEqual([buttons[0]]);
    await user.keyboard(' ');
    expect(buttons[0]).toHaveAttribute('aria-pressed', 'false');
    expect(screen.getByText('切る牌を選んでください')).toBeInTheDocument();
  });

  it('選んだ牌が、答えの欄に出る（打3m）', async () => {
    const { user } = renderQuiz();
    await user.click(handButtons()[0] as HTMLElement);
    const pick = document.querySelector('.pick');
    expect(pick?.textContent).toBe('打3m');
  });
});

describe('U-3 答え合わせ（打牌の判断）', () => {
  it('答えを保存し、AI の評価・受け入れ枚数・差の原因・学んだ原則・MAKA・次へ を、この順に出す。キーボードの位置は答えの見出しへ', async () => {
    const { user, probe } = renderQuiz();
    vi.setSystemTime(new Date(2026, 9, 9, 22, 0, 38));
    await answer(user, drawn);
    expect(probe.recorded).toHaveLength(1);
    expect(probe.recorded[0]).toMatchObject({
      session_id: 'sess',
      decision_key: 'k3h0e15',
      mode: 'quiz',
      choice: { type: 'dahai', tile: '1s' },
      reason: '受け入れを広く',
      reselect_count: 0,
      interval_days: 1,
      due_date: '2026-10-10',
    });
    expect(screen.getByRole('heading', { level: 2, name: '自分の答え' })).toHaveFocus();
    // 順番
    const review = document.getElementById('review') as HTMLElement;
    const text = review.textContent ?? '';
    const order = ['自分の答え', 'AIの評価（Mortal）', '受け入れ枚数', '差の原因', '学んだ原則（1行）', 'MAKA の推した打牌', '次の問題へ'].map((title) =>
      text.indexOf(title),
    );
    expect(order.every((at) => at >= 0)).toBe(true);
    expect([...order].sort((a, b) => a - b)).toEqual(order);
    // 自分の答え・理由・答えるまでの時間・選び直し
    expect(within(review).getByText('受け入れを広く')).toBeInTheDocument();
    expect(review.querySelector('.meta')?.textContent).toMatch(/^答えるまで \d:\d\d · 選び直し 0回$/);
    expect(review.querySelector('.what')?.textContent).toBe('自分打1s');
    // AI の評価: 候補ごとの棒と確率。答え合わせのあとは data-ai がある
    expect(document.querySelectorAll('[data-ai="candidate"]').length).toBeGreaterThanOrEqual(4);
    const percents = [...document.querySelectorAll('[data-ai="candidate"] .v')].map((v) => v.textContent);
    expect(percents.every((value) => /^(\d+\.\d\d%|<0\.01%)$/.test(value ?? ''))).toBe(true);
    expect(document.querySelector('[data-ai="eval"]')).not.toBeNull();
    expect(document.querySelector('[data-ai="ukeire-box"]')).not.toBeNull();
    // 答える前の欄は消えて、手牌は押せない
    expect(screen.queryByRole('button', { name: '答え合わせ' })).toBeNull();
    for (const button of handButtons()) expect(button).toBeDisabled();
  });

  it('手牌の印: 自分（1s）・実戦（3m。2 枚のうち左の 1 枚に文字）・AI（7s）。文字は 1 回ずつ', async () => {
    const { user } = renderQuiz();
    await answer(user, drawn);
    const marked = [...document.querySelectorAll('.slot[data-mark]')].map((slot) => slot.getAttribute('data-mark'));
    expect(marked).toEqual(['act', 'act', 'top', 'top', 'you']);
    const labels = [...document.querySelectorAll('.mks .mk')].map((mk) => mk.textContent);
    expect(labels.sort()).toEqual(['AI', '実戦', '自分'].sort());
    expect(document.querySelector('.slot[data-mark="you"]')?.getAttribute('data-ring')).toBe('you');
    // 読み上げの名前に、印が入る
    expect(screen.getByRole('button', { name: '一索（ツモ牌）（自分）' })).toBeDisabled();
  });

  it('答えを選び直した回数が、答えるまでの時間のとなりに出る（3m → 1s で 1 回）', async () => {
    const { user, probe } = renderQuiz();
    await user.click(handButtons()[0] as HTMLElement);
    await user.click(drawn());
    await user.type(reasonBox(), '考え直した');
    await user.click(submit());
    await screen.findByRole('heading', { name: 'AIの評価（Mortal）' });
    expect(document.querySelector('.meta')?.textContent).toMatch(/選び直し 1回$/);
    expect(probe.recorded[0]?.reselect_count).toBe(1);
  });

  it('保存できなかったら、答える前の画面のまま、理由を出す（AI の評価は出さない）。もう一度押せる', async () => {
    const record = vi.fn(async () => {
      throw new Error('ディスクがいっぱいです');
    });
    const { user } = renderQuiz({ record });
    await user.click(drawn());
    await user.type(reasonBox(), '試験');
    await user.click(submit());
    expect(await screen.findByText('答えを保存できませんでした: ディスクがいっぱいです')).toBeInTheDocument();
    expect(document.querySelector('[data-ai]')).toBeNull();
    expect(submit()).toBeEnabled();
    expect(submit()).toHaveFocus();
  });
});

describe('U-18 受け入れ枚数の行と小窓', () => {
  it('行は、手牌だけで数えた枚数（16枚）と、小さく「残り10」。同じ打牌は 1 行（自分・実戦・AI・最大）', async () => {
    const { user } = renderQuiz();
    await answer(user, drawn);
    const rows = [...document.querySelectorAll('[data-ai="ukeire"]')];
    // 自分 1s（最大）・実戦 3m・AI 7s
    expect(rows.map((row) => row.querySelector('.uk-tags')?.textContent)).toEqual(['自分・最大', '実戦', 'AI']);
    const mine = rows[0] as HTMLElement;
    // 「16枚」の右に、小さく「残り10」（手牌だけの枚数 16 のうち、場に見えている牌を除いて、あと 10 枚）
    expect(mine.querySelector('.uk-n')?.textContent).toBe('16枚 残り10');
    expect(mine.querySelector('.uk-rem')?.textContent).toBe('残り10');
    expect(mine.querySelector('.uk-sh')?.textContent).toBe('1シャンテン');
    // 実戦の 3m は 2 シャンテン（枚数で比べられない旨の注）
    expect(rows[1]?.querySelector('.uk-sh')?.textContent).toBe('2シャンテン');
    expect(screen.getByText('シャンテン数が違う打牌は、受け入れ枚数では比べられません。')).toBeInTheDocument();
    expect(screen.getByText('AIの打牌のほうが受け入れが少ない → 形の質・打点・守備のどれかで差がついた')).toBeInTheDocument();
    // 天鳳牌理へのリンク（外部のページを新しい窓で開かない。既定のブラウザは、本体が開く）
    const link = screen.getByRole('link', { name: /天鳳牌理で見る/ });
    expect(link).toHaveAttribute('href', 'https://tenhou.net/2/?q=33444m34678p1577s');
    expect(link).toHaveAttribute('rel', 'noopener noreferrer');
  });

  it('行を押すと小窓が開く: 受け入れ牌ごとの枚数と残り・合計の行・注。Esc で閉じて、キーボードの位置は押した行へ戻る', async () => {
    const { user } = renderQuiz();
    await answer(user, drawn);
    const row = ukRow('自分・最大');
    // 押すと開くことは、行の説明で伝える（名前は、見えている文字のとおり）
    expect(row).toHaveAccessibleDescription('行を押すと、受け入れ牌と枚数・残りの一覧を開きます。');
    expect(row).toHaveAttribute('aria-haspopup', 'dialog');
    expect(row).toHaveAttribute('aria-expanded', 'false');
    await user.click(row);
    const dialog = screen.getByRole('dialog');
    expect(row).toHaveAttribute('aria-expanded', 'true');
    expect(dialog.querySelector('.up-sum')?.textContent).toBe('1シャンテン・受け入れ 16枚（5種類）・残り 10枚');
    const items = [...dialog.querySelectorAll('.ut-list > li')].map((li) => li.textContent);
    expect(items).toHaveLength(5);
    // 受け入れ牌ごとに、枚数と残り（3m 2枚・残り2、2p 4枚・残り4、5p 4枚・残り4、6s 4枚・残り0、7s 2枚・残り0）
    expect(items).toEqual(['2枚残り2', '4枚残り4', '4枚残り4', '4枚残り0', '2枚残り0']);
    expect(
      within(dialog).getByText('枚数は自分の手牌だけで数えた数です（天鳳牌理と同じ）。残りは、場に見えている牌（全員の河・副露・ドラ表示牌）も除いた数です。'),
    ).toBeInTheDocument();
    // 1 シャンテンの打牌には、「2シャンテンからの先」の欄は無い
    expect(within(dialog).queryByRole('tab')).toBeNull();
    // 小窓にキーボードの位置が移る
    expect(dialog).toHaveFocus();
    await user.keyboard('{Escape}');
    expect(screen.queryByRole('dialog')).toBeNull();
    expect(row).toHaveFocus();
    expect(row).toHaveAttribute('aria-expanded', 'false');
  });

  it('小窓の外を押すと閉じる。同じ行をもう一度押しても閉じる', async () => {
    const { user } = renderQuiz();
    await answer(user, drawn);
    const row = ukRow('自分・最大');
    await user.click(row);
    expect(screen.getByRole('dialog')).toBeInTheDocument();
    await user.click(screen.getByRole('heading', { name: 'AIの評価（Mortal）' }));
    expect(screen.queryByRole('dialog')).toBeNull();
    await user.click(row);
    expect(screen.getByRole('dialog')).toBeInTheDocument();
    await user.click(row);
    expect(screen.queryByRole('dialog')).toBeNull();
    // 閉じるボタン
    await user.click(row);
    await user.click(within(screen.getByRole('dialog')).getByRole('button', { name: '閉じる' }));
    expect(screen.queryByRole('dialog')).toBeNull();
    expect(row).toHaveFocus();
  });

  it('打牌のあとが 2 シャンテンの行だけ、「2シャンテンからの先」の欄がある（E-23: 48枚・14種類・平均 19.3・最大 33）', async () => {
    const { user } = renderQuiz();
    await user.click(handButtons()[0] as HTMLElement); // 3m（実戦と同じ。2 シャンテンになる）
    await user.type(reasonBox(), '試験');
    await user.click(submit());
    await screen.findByRole('heading', { name: 'AIの評価（Mortal）' });
    await user.click(ukRow('自分・実戦'));
    const dialog = screen.getByRole('dialog');
    const tabs = within(dialog).getAllByRole('tab');
    expect(tabs.map((tab) => tab.textContent)).toEqual(['受け入れ牌', '2シャンテンからの先']);
    expect(tabs[0]).toHaveAttribute('aria-selected', 'true');
    // この打牌は、枚数で比べられない注
    expect(within(dialog).getByText(/この打牌は2シャンテンです（いちばん進む打牌は1シャンテン）/)).toBeInTheDocument();
    await user.click(tabs[1] as HTMLElement);
    expect(tabs[1]).toHaveAttribute('aria-selected', 'true');
    const panel = within(dialog).getByRole('tabpanel');
    expect(panel.querySelector('.up-sum')?.textContent).toBe('1シャンテンに進む牌 48枚（14種類）');
    expect(panel.querySelector('.up-sum2')?.textContent).toContain('平均 19.3枚・最大 33枚');
    expect(panel.querySelectorAll('tbody tr')).toHaveLength(14);
    // 矢印キーでタブを動かせる
    tabs[1]?.focus();
    await user.keyboard('{ArrowLeft}');
    expect(tabs[0]).toHaveFocus();
    expect(tabs[0]).toHaveAttribute('aria-selected', 'true');
  });

  it('自分の打牌との違い: 同じシャンテン数どうしの行は、自分にだけ・相手にだけの牌を出す', async () => {
    const { user } = renderQuiz();
    await answer(user, drawn);
    await user.click(ukRow('AI'));
    const dialog = screen.getByRole('dialog');
    const diff = dialog.querySelector('.up-diff');
    expect(diff?.textContent).toMatch(/自分の打牌との違い/);
    expect(diff?.textContent).toMatch(/AIの打牌だけ|自分の打牌だけ/);
  });
});

describe('U-20 差の原因・U-11 取り消し', () => {
  it('5 つのチェックボックス。いくつでも選べて、選んだものが保存される', async () => {
    const { user, probe } = renderQuiz();
    await answer(user, drawn);
    const boxes = screen.getAllByRole('checkbox');
    expect(boxes.map((box) => box.getAttribute('value'))).toEqual(['ukeire', 'shape', 'value', 'defense', 'other']);
    expect(screen.getByRole('checkbox', { name: '受け入れ枚数' })).not.toBeChecked();
    await user.click(screen.getByRole('checkbox', { name: '打点' }));
    await user.click(screen.getByRole('checkbox', { name: '受け入れ枚数' }));
    expect(screen.getByRole('checkbox', { name: '打点' })).toBeChecked();
    expect(screen.getByRole('checkbox', { name: '受け入れ枚数' })).toBeChecked();
    // 保存は、選んだ順でなく、決まった順
    expect(probe.notes.map((call) => call.patch)).toEqual([{ causes: ['value'] }, { causes: ['ukeire', 'value'] }]);
    // 外す
    await user.click(screen.getByRole('checkbox', { name: '打点' }));
    expect(screen.getByRole('checkbox', { name: '打点' })).not.toBeChecked();
    expect(probe.notes.at(-1)?.patch).toEqual({ causes: ['ukeire'] });
  });

  it('Ctrl+Z で直前の選び方に戻り、Ctrl+Y でやり直せる（画面のチェックも追う）', async () => {
    const { user, probe } = renderQuiz();
    await answer(user, drawn);
    await user.click(screen.getByRole('checkbox', { name: '形の質' }));
    await user.click(screen.getByRole('checkbox', { name: '守備' }));
    expect(probe.notes.at(-1)?.patch).toEqual({ causes: ['shape', 'defense'] });
    await user.keyboard('{Control>}z{/Control}');
    await vi.waitFor(() => expect(probe.notes.at(-1)?.patch).toEqual({ causes: ['shape'] }));
    await vi.waitFor(() => expect(screen.getByRole('checkbox', { name: '守備' })).not.toBeChecked());
    expect(screen.getByRole('checkbox', { name: '形の質' })).toBeChecked();
    await user.keyboard('{Control>}y{/Control}');
    await vi.waitFor(() => expect(screen.getByRole('checkbox', { name: '守備' })).toBeChecked());
    expect(probe.notes.at(-1)?.patch).toEqual({ causes: ['shape', 'defense'] });
  });

  it('答えそのものは、Ctrl+Z で戻らない（答え合わせのあとの答えは取り消せない。U-11）', async () => {
    const { user, probe } = renderQuiz();
    await answer(user, drawn);
    await user.keyboard('{Control>}z{/Control}');
    expect(probe.notes).toEqual([]);
    expect(screen.getByRole('heading', { name: 'AIの評価（Mortal）' })).toBeInTheDocument();
    expect(probe.recorded).toHaveLength(1);
  });

  it('文字を打つ欄（学んだ原則）にいるときは、アプリの取り消しは働かない', async () => {
    const { user, probe } = renderQuiz();
    await answer(user, drawn);
    await user.click(screen.getByRole('checkbox', { name: '打点' }));
    await user.type(screen.getByLabelText('学んだ原則（1行）'), '先に孤立牌');
    const before = probe.notes.length;
    await user.keyboard('{Control>}z{/Control}');
    expect(probe.notes).toHaveLength(before);
    expect(screen.getByRole('checkbox', { name: '打点' })).toBeChecked();
  });

  it('原因の保存に失敗したら、チェックは元に戻る（失敗の知らせは、取り消しの積み重ねの通知に出る）', async () => {
    let fail = false;
    const { user } = renderQuiz({
      updateNotes: async () => {
        if (fail) throw new Error('保存できません');
      },
    });
    await answer(user, drawn);
    fail = true;
    await user.click(screen.getByRole('checkbox', { name: '打点' }));
    await vi.waitFor(() => expect(screen.getByRole('checkbox', { name: '打点' })).not.toBeChecked());
  });
});

describe('学んだ原則・MAKA の推した打牌（E-14）', () => {
  it('学んだ原則は、欄の外へ出たときに保存する。同じ文を 2 度は保存しない（次へ進むときにも保存する）', async () => {
    const { user, probe } = renderQuiz();
    await answer(user, drawn);
    await user.type(screen.getByLabelText('学んだ原則（1行）'), '  孤立牌を先に切る ');
    await user.tab();
    await vi.waitFor(() => expect(probe.notes).toEqual([{ id: 100, patch: { principle: '孤立牌を先に切る' } }]));
    await user.click(screen.getByRole('button', { name: '次の問題へ' }));
    await vi.waitFor(() => expect(probe.onNext).toHaveBeenCalledTimes(1));
    expect(probe.notes).toHaveLength(1);
  });

  it('「次の問題へ」は、書きかけの原則を保存してから進む。保存できなければ進まず、理由を出す', async () => {
    let fail = true;
    const { user, probe } = renderQuiz({
      updateNotes: async () => {
        if (fail) throw new Error('保存できません');
      },
    });
    await answer(user, drawn);
    await user.type(screen.getByLabelText('学んだ原則（1行）'), 'メモ');
    await user.click(screen.getByRole('button', { name: '次の問題へ' }));
    expect(await screen.findByText('学んだ原則を保存できませんでした: 保存できません')).toBeInTheDocument();
    expect(probe.onNext).not.toHaveBeenCalled();
    fail = false;
    await user.click(screen.getByRole('button', { name: '次の問題へ' }));
    await vi.waitFor(() => expect(probe.onNext).toHaveBeenCalledTimes(1));
  });

  it('MAKA の欄は、閉じたまま。入れなくても進める。打牌を選ぶと、Mortal の 1 位と同じか・食い違いかが出る', async () => {
    const { user, probe } = renderQuiz();
    await answer(user, drawn);
    const details = document.querySelector('details.q-maka') as HTMLDetailsElement;
    expect(details.open).toBe(false);
    expect(screen.getByRole('button', { name: '次の問題へ' })).toBeEnabled();
    await user.click(within(details).getByText('MAKA の推した打牌'));
    expect(details.open).toBe(true);
    expect(within(details).getByText('入れなくても先へ進めます。MAKA は、自分の答えを出したあとに見てください。')).toBeInTheDocument();
    // 手牌の種類（赤五は普通の五）が 1 つずつ並ぶ
    const tiles = within(details).getAllByRole('button');
    expect(tiles).toHaveLength(10);
    await user.click(within(details).getByRole('button', { name: '七索' }));
    expect(details.querySelector('.maka-note')?.textContent).toBe('MAKA：打7sMortal の1位と同じ');
    expect(within(details).getByRole('button', { name: '七索' })).toHaveAttribute('aria-pressed', 'true');
    await user.click(within(details).getByRole('button', { name: '三萬' }));
    expect(details.querySelector('.maka-note')?.textContent).toBe('MAKA：打3mMortal の1位（打7s）と食い違い');
    expect(probe.notes.map((call) => call.patch)).toEqual([{ maka_move: '7s' }, { maka_move: '3m' }]);
    // もう一度押すと外れる。取り消すと前の入力に戻る
    await user.click(within(details).getByRole('button', { name: '三萬' }));
    expect(details.querySelector('.maka-note')?.textContent).toContain('入れなくても');
    expect(probe.notes.at(-1)?.patch).toEqual({ maka_move: null });
  });
});

describe('F3 巡目を戻して見る（2〜3 巡前から）', () => {
  it('「前の巡目」「次の巡目」で盤面を行き来する。過去の盤面は手牌を押せず、「過去の盤面」の印が出る。判断より先へは進めない', async () => {
    const { user } = renderQuiz();
    const turn = () => document.querySelector('.turn')?.textContent;
    const prev = screen.getByRole('button', { name: /前の巡目/ });
    const next = screen.getByRole('button', { name: /次の巡目/ });
    expect(turn()).toBe('13巡目');
    expect(prev).toBeEnabled();
    expect(next).toBeDisabled();
    await user.click(prev);
    expect(turn()).toBe('12巡目');
    expect(document.querySelector('.board-col')?.getAttribute('data-view')).toBe('past');
    expect(document.querySelector('.hand-wrap')?.hasAttribute('inert')).toBe(true);
    // 見出しの局・巡目は、問題のまま
    expect(screen.getByRole('heading', { level: 1, name: '東4局 13巡目' })).toBeInTheDocument();
    await user.click(prev);
    await user.click(prev);
    expect(turn()).toBe('10巡目');
    expect(prev).toBeDisabled();
    // 端で押せなくなったとき、キーボードの位置は、もう一方のボタンへ
    expect(next).toHaveFocus();
    await user.click(next);
    await user.click(next);
    await user.click(next);
    expect(turn()).toBe('13巡目');
    expect(document.querySelector('.board-col')?.getAttribute('data-view')).toBe('now');
    expect(document.querySelector('.hand-wrap')?.hasAttribute('inert')).toBe(false);
  });

  it('過去の盤面にいる間に牌を選んでも、答えにならない（判断の盤面の手牌だけが答えになる）', async () => {
    const { user } = renderQuiz();
    await user.click(screen.getByRole('button', { name: /前の巡目/ }));
    // 過去の盤面の手牌は、牌のボタンにならない
    expect(screen.queryAllByRole('button', { name: /を切る$/ })).toHaveLength(0);
    expect(submit()).toBeDisabled();
  });
});

describe('U-16 鳴き（チー・ポン・スルー）の判断', () => {
  // FX-4 東2局1本場 8巡目: 対面の東をポンするか、スルーするか（実戦はポン）
  const find = (d: Decision) => d.kind === 'call' && d.kyokuLabel === '東2局1本場' && d.junme === 8;
  const options = (): HTMLElement[] => screen.getAllByRole('radio');

  it('雀魂と同じ並びのボタン（ポン・スルー）で答える。AI の順位は出さない。鳴く牌は手牌の右に離して置く', async () => {
    renderQuiz({ report: 'fx4', find });
    expect(screen.getByText('実戦：東をポン')).toBeInTheDocument();
    const radios = options();
    expect(radios.map((radio) => radio.querySelector('.c-name')?.textContent)).toEqual(['ポン', 'スルー']);
    expect(radios.map((radio) => radio.getAttribute('aria-checked'))).toEqual(['false', 'false']);
    expect(radios[0]?.getAttribute('aria-label')).toBe('東をポン');
    // 鳴く牌と、持ち主の呼び名
    expect(document.querySelector('.cap-top')?.textContent).toBe('対面の打牌');
    // 手牌の右の鳴く牌と、答えのボタンの中の鳴く牌
    expect(screen.getAllByRole('img', { name: '東（対面の打牌）' })).toHaveLength(2);
    expect(screen.getByText('鳴ける牌')).toBeInTheDocument();
    expect(document.querySelector('[data-ai]')).toBeNull();
    expect(gate()).toBe('ポン・スルーのどちらかを選び、理由を1行書くと押せます');
  });

  it('1 つの radiogroup。矢印キーは動かすだけ（選ぶのは Space）で、通り道で選び直しの回数を増やさない。Tab の止まり場所は 1 つ', async () => {
    const { user, probe } = renderQuiz({ report: 'fx4', find });
    const [pon, pass] = options() as [HTMLElement, HTMLElement];
    expect(screen.getByRole('radiogroup')).toBeInTheDocument();
    expect(pon.tabIndex).toBe(0);
    expect(pass.tabIndex).toBe(-1);
    pon.focus();
    await user.keyboard('{ArrowDown}');
    expect(pass).toHaveFocus();
    expect(pass).toHaveAttribute('aria-checked', 'false');
    await user.keyboard('{ArrowUp}');
    expect(pon).toHaveFocus();
    await user.keyboard('{Enter}');
    expect(pon).toHaveAttribute('aria-checked', 'true');
    // 選んだものが、Tab の止まり場所
    expect(options().map((radio) => radio.tabIndex)).toEqual([0, -1]);
    await user.type(reasonBox(), '門前を保つ');
    await user.click(pass);
    await user.click(pon);
    await user.click(submit());
    await screen.findByRole('heading', { name: 'AIの評価（Mortal）' });
    expect(probe.recorded[0]?.reselect_count).toBe(2);
    expect(probe.recorded[0]?.choice).toEqual({ type: 'option', id: 'pon' });
  });

  it('選ぶと、手牌から出す牌が持ち上がる（ポンは東 2 枚）。スルーは何も持ち上げない', async () => {
    const { user } = renderQuiz({ report: 'fx4', find });
    const [pon, pass] = options() as [HTMLElement, HTMLElement];
    await user.click(pon);
    expect(document.querySelectorAll('.slot[data-use]')).toHaveLength(2);
    await user.click(pass);
    expect(document.querySelectorAll('.slot[data-use]')).toHaveLength(0);
  });

  it('答え合わせ: AI の評価はボタンごとの棒（ポン・スルー）。受け入れ枚数・MAKA は出さない', async () => {
    const { user } = renderQuiz({ report: 'fx4', find });
    await user.click(options()[0] as HTMLElement);
    await user.type(reasonBox(), '東は役牌');
    await user.click(submit());
    await screen.findByRole('heading', { name: 'AIの評価（Mortal）' });
    const bars = [...document.querySelectorAll('[data-ai="candidate"]')];
    expect(bars.map((bar) => bar.querySelector('.lab b')?.textContent).sort()).toEqual(['スルー', 'ポン']);
    expect(bars.find((bar) => bar.querySelector('.lab b')?.textContent === 'ポン')?.querySelector('.btag')?.textContent).toMatch(/自分/);
    expect(document.querySelector('[data-ai="ukeire-box"]')).toBeNull();
    expect(screen.queryByText('MAKA の推した打牌')).toBeNull();
    expect(screen.getByRole('checkbox', { name: '受け入れ枚数' })).toBeInTheDocument();
    expect(document.querySelector('.what')?.textContent).toBe('自分東をポン');
  });
});

describe('U-16 リーチ・和了・カンの判断も、雀魂と同じ並びのボタンで答える', () => {
  const labelsOf = () => screen.getAllByRole('radio').map((radio) => radio.querySelector('.c-name')?.textContent);

  it('リーチ: リーチ → しない', () => {
    renderQuiz({ report: 'fx1a', key: 'k1h0e10' });
    expect(labelsOf()).toEqual(['リーチ', 'しない']);
    expect(screen.getByText(/^実戦：リーチ$/)).toBeInTheDocument();
    expect(gate()).toBe('リーチ・しないのどちらかを選び、理由を1行書くと押せます');
    // 鳴く牌は無い（自分の手番）。ツモ牌は右端
    expect(document.querySelector('.cap-top')).toBeNull();
  });

  it('和了: ツモ（またはロン）→ スキップ', () => {
    const win = decisionOf('fx1a', { key: 'k1h0e11' });
    const first = answerOptions(win)[0];
    expect(['ツモ', 'ロン']).toContain(first?.label);
    renderQuiz({ report: 'fx1a', key: 'k1h0e11' });
    expect(labelsOf()).toEqual([first?.label, 'スキップ']);
  });

  it('カン: カン → しない（暗槓・加槓。手牌から出す牌が見える）', async () => {
    const { user } = renderQuiz({ report: 'fx1a', key: 'k4h0e9' });
    expect(labelsOf()).toEqual(['カン', 'しない']);
    await user.click(screen.getAllByRole('radio')[0] as HTMLElement);
    expect(document.querySelectorAll('.slot[data-use]').length).toBeGreaterThan(0);
  });

  it('リーチの答え合わせ: 棒は「リーチ」「しない」。受け入れ枚数は出さない。実戦の行動は見出しに', async () => {
    const { user, probe } = renderQuiz({ report: 'fx1a', key: 'k1h0e10' });
    await user.click(screen.getAllByRole('radio')[0] as HTMLElement);
    await user.type(reasonBox(), '良形のテンパイ');
    await user.click(submit());
    await screen.findByRole('heading', { name: 'AIの評価（Mortal）' });
    expect(probe.recorded[0]?.choice).toEqual({ type: 'option', id: 'reach' });
    const labels = [...document.querySelectorAll('[data-ai="candidate"] .lab b')].map((b) => b.textContent);
    expect(labels).toEqual(expect.arrayContaining(['リーチ', 'しない']));
    expect(document.querySelector('[data-ai="ukeire-box"]')).toBeNull();
  });
});

describe('U-17 解き直し', () => {
  it('実戦の行動と AI の答えは、答え合わせまで画面にも DOM にも出さない。見出しに「解き直し · 今日の期限」と 1 / 6', () => {
    renderQuiz({ mode: 'review', previousIntervalDays: 3, progress: { current: 1, total: 6 } });
    expect(document.querySelector('.kicker')?.textContent).toBe('解き直し · 今日の期限 6問');
    expect(document.querySelector('.progress')?.textContent).toBe('1 / 6');
    expect(screen.queryByText(/実戦/)).toBeNull();
    expect(document.querySelector('[data-ai]')).toBeNull();
    expect(document.body.innerHTML).not.toMatch(/data-ai|data-mark/);
    expect(document.body.textContent).not.toMatch(/\d\s*%|Mortal|実戦/);
    // 理由が必須
    expect(submit()).toBeDisabled();
  });

  it('不正解: 結果・確率の文・次の解き直しの日と間隔（1日に戻る）。間違えた答えの確率を出す', async () => {
    const { user, probe } = renderQuiz({ mode: 'review', previousIntervalDays: 7 });
    await user.click(handButtons()[5] as HTMLElement); // 3p など、AI が選ばない牌
    await user.type(reasonBox(), '試験');
    await user.click(submit());
    await screen.findByRole('heading', { name: 'AIの評価（Mortal）' });
    const verdict = document.querySelector('[data-ai="verdict"]') as HTMLElement;
    expect(verdict.getAttribute('data-result')).toBe(probe.recorded[0]?.correct ? 'ok' : 'ng');
    expect(verdict.querySelector('.v-badge')?.textContent).toBe(probe.recorded[0]?.correct ? '正解' : '不正解');
    expect(verdict.querySelector('.v-text')?.textContent).toMatch(/ は AI が (\d+\.\d\d%|<0\.01%) の確率で選ぶ手です5%以上なら正解$/);
    if (probe.recorded[0]?.correct === false) {
      expect(verdict.querySelector('.v-line')?.textContent).toBe('次の解き直し 1日後（10月10日）');
      expect(verdict.querySelector('.v-why')?.textContent).toBe('間違えたので、間隔を 1日に戻します');
    }
    // 見出しの「実戦」は、答え合わせのあとの評価に出る（AI の評価の棒）
    expect(screen.getAllByText('実戦', { exact: false }).length).toBeGreaterThan(0);
  });

  it('正解: 間隔が伸びる（3日 → 7日。10月9日の 7日後は 10月16日）', async () => {
    const { user } = renderQuiz({ mode: 'review', previousIntervalDays: 3 });
    // 打7s は、この場面で AI が選ぶ手（打1s は 2.28% で、正解の基準 5% に届かない）
    await user.click(screen.getAllByRole('button', { name: '七索を切る' })[0] as HTMLElement);
    await user.type(reasonBox(), '孤立牌を切る');
    await user.click(submit());
    await screen.findByRole('heading', { name: 'AIの評価（Mortal）' });
    const verdict = document.querySelector('[data-ai="verdict"]') as HTMLElement;
    expect(verdict.getAttribute('data-result')).toBe('ok');
    expect(verdict.querySelector('.v-badge')?.textContent).toBe('正解');
    expect(verdict.querySelector('.v-line')?.textContent).toBe('次の解き直し 7日後（10月16日）');
    expect(verdict.querySelector('.v-why')?.textContent).toBe('間隔 3日 → 7日');
  });

  it('正解でも選び直したら、間隔は伸ばさない', async () => {
    const { user } = renderQuiz({ mode: 'review', previousIntervalDays: 3 });
    await user.click(handButtons()[0] as HTMLElement);
    await user.click(screen.getAllByRole('button', { name: '七索を切る' })[0] as HTMLElement);
    await user.type(reasonBox(), '考え直した');
    await user.click(submit());
    await screen.findByRole('heading', { name: 'AIの評価（Mortal）' });
    const verdict = document.querySelector('[data-ai="verdict"]') as HTMLElement;
    expect(verdict.getAttribute('data-result')).toBe('ok');
    expect(verdict.querySelector('.v-line')?.textContent).toBe('次の解き直し 3日後（10月12日）');
    expect(verdict.querySelector('.v-why')?.textContent).toBe('答えを選び直したので、間隔は伸ばしません（3日のまま）');
  });
});

describe('すでに答えた問題を開く', () => {
  it('保存してある答えから、答え合わせのあとの形で開く（理由・時間・選び直しの回数・原因）。キーボードの位置は奪わない', () => {
    const existing = answerRow({
      id: 3,
      session_id: 'sess',
      decision_key: 'k3h0e15',
      choice: { type: 'dahai', tile: '1s' },
      reason: '前に書いた理由',
      duration_ms: 42_000,
      reselect_count: 2,
      causes: ['value', 'shape'],
      principle: '孤立牌から',
    });
    renderQuiz({ existing });
    expect(document.querySelector('.qz')?.getAttribute('data-state')).toBe('revealed');
    expect(screen.getByText('前に書いた理由')).toBeInTheDocument();
    expect(document.querySelector('.meta')?.textContent).toBe('答えるまで 0:42 · 選び直し 2回');
    expect(screen.getByRole('checkbox', { name: '形の質' })).toBeChecked();
    expect(screen.getByRole('checkbox', { name: '打点' })).toBeChecked();
    expect(screen.getByRole('checkbox', { name: '守備' })).not.toBeChecked();
    expect(screen.getByLabelText('学んだ原則（1行）')).toHaveValue('孤立牌から');
    expect(screen.getByRole('heading', { level: 2, name: '自分の答え' })).not.toHaveFocus();
    expect(screen.queryByRole('button', { name: '答え合わせ' })).toBeNull();
  });
});

describe('U-19 ドラを目立たせる', () => {
  const kindsOf = (decision: Decision) => doraKinds(decision.board.doraMarkers);

  it('既定は切: ページの印は off。どの牌にも is-dora が付かない', () => {
    renderQuiz();
    expect(document.querySelector('.qz')?.getAttribute('data-dora')).toBe('off');
    // 凡例の見本（設定が切のときは、CSS で隠す）のほかには付かない
    expect([...document.querySelectorAll('.is-dora')].filter((tile) => tile.closest('.legend') === null)).toEqual([]);
    expect(document.querySelector('.lg-dora')).not.toBeNull();
  });

  it('入にすると: ドラ表示牌が指す牌（手牌・河・副露）にだけ is-dora。ドラ表示牌そのものと、鳴かれて薄くなった牌には付けない', () => {
    // FX-4 東2局1本場 6巡目: 手牌に、ドラ表示牌が指す 3p がある
    const { decision } = renderQuiz({ report: 'fx4', key: 'k1h1e6', highlightDora: true });
    expect(document.querySelector('.qz')?.getAttribute('data-dora')).toBe('on');
    const kinds = kindsOf(decision);
    expect(kinds.size).toBeGreaterThan(0);
    const dora = [...document.querySelectorAll('.is-dora')].filter((tile) => tile.closest('.legend') === null);
    expect(dora.length).toBeGreaterThan(0);
    // ドラ表示牌（中央の箱・上の 1 行）は付けない
    expect(document.querySelector('.dora-t .is-dora, .info-strip .is-dora')).toBeNull();
    // 鳴かれた牌（薄い牌）には付けない
    expect(document.querySelector('.called.is-dora')).toBeNull();
    // 付いた牌は、読み上げに「（ドラ）」が入る
    for (const tile of dora) {
      const label = tile.getAttribute('aria-label') ?? tile.querySelector('img')?.getAttribute('alt') ?? '';
      expect(label).toMatch(/（ドラ）/);
    }
    // 手牌で付く牌は、ドラ表示牌が指す種類の牌とちょうど同じ（ツモ牌を含む）
    const { hand, drawn } = decision.board;
    const expected = [...hand, ...(drawn === null ? [] : [drawn])].filter((tile) => kinds.has(tileKind(tile))).length;
    expect(expected).toBeGreaterThan(0);
    expect(document.querySelectorAll('.hand .tile-btn.is-dora')).toHaveLength(expected);
    for (const button of document.querySelectorAll('.hand .tile-btn.is-dora')) {
      expect(button.getAttribute('aria-label')).toMatch(/（ドラ）/);
    }
  });
});
