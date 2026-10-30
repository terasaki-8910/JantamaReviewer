/**
 * 説明のアイコン（InfoTip。U-25、R11-1）の部品の試験。
 * 実ブラウザでの置き場所（窓の中に収まる・説明している物にかからない・axe）は、tests/browser/infotip.browser.test.ts が確かめる。
 */
import { act, fireEvent, render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import axe from 'axe-core';
import { describe, expect, it, vi } from 'vitest';

import { InfoTip, Tip } from './InfoTip';

const TEXT = '行を押すと、受け入れ牌と枚数・残りの一覧を開きます。';

function setup() {
  const user = userEvent.setup();
  const view = render(
    <div>
      <h2>受け入れ枚数</h2>
      <InfoTip label="受け入れ枚数の操作の説明" id="the-tip">
        {TEXT}
      </InfoTip>
      <button type="button">ほかのボタン</button>
    </div>,
  );
  const icon = screen.getByRole('button', { name: '受け入れ枚数の操作の説明' });
  return { user, view, icon };
}

const tip = () => screen.queryByRole('tooltip');

describe('U-25 説明のアイコン: 名前と、説明の文', () => {
  it('アイコンは、名前のあるボタン。説明の文は、閉じている間は出ない（見えない）が、アイコンの読み上げの説明になる', () => {
    const { icon } = setup();
    expect(icon).toHaveAccessibleName('受け入れ枚数の操作の説明');
    expect(icon).toHaveAccessibleDescription(TEXT);
    expect(icon).toHaveAttribute('type', 'button');
    expect(tip()).toBeNull();
    // 文は、DOM にはある（hidden）。説明したい物（行など）が、同じ id で読み上げの説明にできる
    const hidden = document.getElementById('the-tip');
    expect(hidden).not.toBeNull();
    expect(hidden).toHaveAttribute('role', 'tooltip');
    expect(hidden).toHaveAttribute('hidden');
    expect(hidden).toHaveTextContent(TEXT);
  });

  it('本文の流れ（見出しのそば）には、説明の文を置かない。重なりは、body の直下に描く（欄の container-type の影響を受けない）', () => {
    const { view } = setup();
    const pop = document.getElementById('the-tip') as HTMLElement;
    expect(pop.parentElement).toBe(document.body);
    expect(view.container.textContent).not.toContain('一覧を開きます');
  });
});

describe('U-25 説明のアイコン: マウスを乗せると出る', () => {
  it('乗せると重なって出る。離すと、少し待って閉じる。重なりの中へ渡っても閉じない', async () => {
    const { user, icon } = setup();
    await user.hover(icon);
    expect(tip()).toHaveTextContent(TEXT);
    expect(tip()).toBeVisible();
    // 重なりの中へマウスを動かす（アイコンを離れても、閉じない）
    await user.unhover(icon);
    await user.hover(tip() as HTMLElement);
    await new Promise((resolve) => setTimeout(resolve, 350));
    expect(tip()).not.toBeNull();
    // 離すと閉じる
    await user.unhover(tip() as HTMLElement);
    await waitFor(() => expect(tip()).toBeNull());
  });

  it('押すと、出したままにする（マウスを離しても閉じない）。もう一度押すか、外を押すと閉じる', async () => {
    const { user, icon } = setup();
    await user.hover(icon);
    await user.click(icon);
    await user.unhover(icon);
    await new Promise((resolve) => setTimeout(resolve, 350));
    expect(tip()).not.toBeNull();
    await user.click(icon);
    expect(tip()).toBeNull();
    // 外を押して閉じる
    await user.click(icon);
    expect(tip()).not.toBeNull();
    await user.click(screen.getByRole('heading', { name: '受け入れ枚数' }));
    expect(tip()).toBeNull();
  });

  it('タッチでは、押すと開く（乗せる動きは使わない）', async () => {
    const { icon } = setup();
    fireEvent.pointerEnter(icon, { pointerType: 'touch' });
    expect(tip()).toBeNull();
    fireEvent.click(icon);
    expect(tip()).not.toBeNull();
    fireEvent.click(icon);
    expect(tip()).toBeNull();
  });
});

describe('U-25 説明のアイコン: キーボードで選ぶと出る', () => {
  it('Tab で位置が来ると出て、外れると閉じる', async () => {
    const { user, icon } = setup();
    await user.tab();
    expect(icon).toHaveFocus();
    expect(tip()).toHaveTextContent(TEXT);
    await user.tab();
    expect(screen.getByRole('button', { name: 'ほかのボタン' })).toHaveFocus();
    expect(tip()).toBeNull();
    // 戻ると、また出る
    await user.tab({ shift: true });
    expect(icon).toHaveFocus();
    expect(tip()).not.toBeNull();
  });

  it('マウスを離した直後に Tab で位置が来ても、離したときの「閉じる」で閉じない', async () => {
    const { user, icon } = setup();
    await user.hover(icon);
    await user.keyboard('{Escape}');
    expect(tip()).toBeNull();
    // 離して、閉じるまでの猶予（220ms）の間に、キーボードで位置を移す
    await user.unhover(icon);
    await user.tab();
    expect(icon).toHaveFocus();
    expect(tip()).not.toBeNull();
    await new Promise((resolve) => setTimeout(resolve, 350));
    expect(tip()).not.toBeNull();
  });

  it('Esc で閉じる。位置はアイコンに残る。Enter（Space）で開き直せて、もう一度押すと閉じる', async () => {
    const { user, icon } = setup();
    await user.tab();
    expect(tip()).not.toBeNull();
    await user.keyboard('{Escape}');
    expect(tip()).toBeNull();
    expect(icon).toHaveFocus();
    await user.keyboard('{Enter}');
    expect(tip()).not.toBeNull();
    await user.keyboard('{Enter}');
    expect(tip()).toBeNull();
    await user.keyboard(' ');
    expect(tip()).not.toBeNull();
    await user.keyboard('{Escape}');
    expect(tip()).toBeNull();
  });

  it('マウスを乗せて出したものも、Esc で閉じる（位置がアイコンに無くても）。Esc は、ほかの動き（背景の閉じるなど）には渡らない', async () => {
    const { user, icon } = setup();
    let reached = false;
    const listener = () => {
      reached = true;
    };
    document.addEventListener('keydown', listener);
    try {
      await user.hover(icon);
      expect(tip()).not.toBeNull();
      await user.keyboard('{Escape}');
      expect(tip()).toBeNull();
      expect(reached).toBe(false);
      // 出ていないときの Esc は、そのまま渡る
      await user.unhover(icon);
      await user.keyboard('{Escape}');
      expect(reached).toBe(true);
    } finally {
      document.removeEventListener('keydown', listener);
    }
  });

  it('スクロールと窓の大きさの変化では、置き直す（開いたまま）。アイコンが窓の外へ出たら閉じる', async () => {
    const { user, icon } = setup();
    await user.hover(icon);
    expect(tip()).not.toBeNull();
    // キーボードで選んだとき、開いたあとにブラウザが起こすスクロールで、閉じてはいけない
    act(() => {
      document.dispatchEvent(new Event('scroll'));
    });
    expect(tip()).not.toBeNull();
    act(() => {
      window.dispatchEvent(new Event('resize'));
    });
    expect(tip()).not.toBeNull();
    // アイコンが窓の外（下）へ出た
    const spy = vi.spyOn(icon, 'getBoundingClientRect').mockReturnValue({ top: 5000, bottom: 5030, left: 10, right: 40, width: 30, height: 30, x: 10, y: 5000, toJSON: () => ({}) });
    act(() => {
      document.dispatchEvent(new Event('scroll'));
    });
    expect(tip()).toBeNull();
    spy.mockRestore();
    // 窓の大きさが変わって、アイコンが窓の外へ出た
    await user.click(icon);
    expect(tip()).not.toBeNull();
    vi.spyOn(icon, 'getBoundingClientRect').mockReturnValue({ top: 5000, bottom: 5030, left: 10, right: 40, width: 30, height: 30, x: 10, y: 5000, toJSON: () => ({}) });
    act(() => {
      window.dispatchEvent(new Event('resize'));
    });
    expect(tip()).toBeNull();
  });

  it('置き直すとき、位置（left・top）を書き直す。上に入らないときは下（data-side）', async () => {
    const { user, icon } = setup();
    // アイコンが窓の上の端にある（上に出す場所が無い）
    vi.spyOn(icon, 'getBoundingClientRect').mockReturnValue({ top: 2, bottom: 32, left: 100, right: 130, width: 30, height: 30, x: 100, y: 2, toJSON: () => ({}) });
    await user.hover(icon);
    const pop = tip() as HTMLElement;
    expect(pop.dataset.side).toBe('below');
    expect(pop.style.top).not.toBe('');
    // アイコンが窓の中ほどにある: 上
    vi.spyOn(icon, 'getBoundingClientRect').mockReturnValue({ top: 400, bottom: 430, left: 100, right: 130, width: 30, height: 30, x: 100, y: 400, toJSON: () => ({}) });
    act(() => {
      document.dispatchEvent(new Event('scroll'));
    });
    expect(pop.dataset.side).toBe('above');
    expect(Number.parseFloat(pop.style.top)).toBeLessThan(400);
    expect(Number.parseFloat(pop.style.left)).toBeGreaterThanOrEqual(8);
  });
});

describe('U-25 説明のアイコン: axe', () => {
  it('開いているときも、閉じているときも、axe の重大な違反が無い', async () => {
    const { user, icon } = setup();
    const serious = async () => {
      const result = await axe.run(document.body, {
        // jsdom では色が計算できない。色の検査は、実ブラウザの試験（tests/browser/infotip.browser.test.ts）で行う
        rules: { 'color-contrast': { enabled: false } },
      });
      return result.violations.filter((v) => v.impact === 'serious' || v.impact === 'critical').map((v) => `${v.id}: ${v.nodes.map((n) => n.html).join(' ')}`);
    };
    expect(await serious()).toEqual([]);
    await user.hover(icon);
    expect(tip()).not.toBeNull();
    expect(await serious()).toEqual([]);
  });
});

describe('Tip（符の数のように、アイコン以外の文字から出す重なり。F14）', () => {
  function setupFu() {
    const user = userEvent.setup();
    render(
      <p>
        <Tip wrapperClassName="wt-fu-wrap" triggerClassName="wt-fu" triggerLabel="40符の内訳（六索 ダマ ロン）" triggerContent="40符" popClassName="wt-fu-pop" id="fu-tip">
          <span>40符の内訳</span> <span>副底 20</span>
        </Tip>
        <button type="button">ほかのボタン</button>
      </p>,
    );
    return { user, fu: screen.getByRole('button', { name: '40符の内訳（六索 ダマ ロン）' }) };
  }

  it('出す元は、文字（40符）のボタン。重なりは、読み上げの説明で、閉じている間は出ない', () => {
    const { fu } = setupFu();
    expect(fu).toHaveTextContent('40符');
    expect(fu).toHaveAccessibleDescription('40符の内訳 副底 20');
    expect(tip()).toBeNull();
    expect(document.getElementById('fu-tip')).toHaveClass('infotip-pop', 'wt-fu-pop');
  });

  it('乗せると出て、離すと閉じる。Tab で位置が来ると出て、Esc で閉じる。外れると閉じる', async () => {
    const { user, fu } = setupFu();
    await user.hover(fu);
    expect(tip()).toHaveTextContent('副底 20');
    await user.unhover(fu);
    await waitFor(() => expect(tip()).toBeNull());
    await user.tab();
    expect(fu).toHaveFocus();
    expect(tip()).toHaveTextContent('40符の内訳');
    await user.keyboard('{Escape}');
    expect(tip()).toBeNull();
    await user.tab();
    expect(tip()).toBeNull();
  });
});
