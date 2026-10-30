import { act } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { focusSettingsSection, MODEL_SECTION_HEADING } from './settingsLink';

beforeEach(() => {
  vi.useFakeTimers();
});

afterEach(() => {
  vi.useRealTimers();
  document.body.replaceChildren();
});

function heading(tag: string, text: string): HTMLElement {
  const element = document.createElement(tag);
  element.textContent = text;
  return element;
}

describe('F23 設定の「解析のモデル」の欄へ移る', () => {
  it('見出しの名前は「解析のモデル」（設定のページに、もう 1 つの作業者が足す欄の見出し）', () => {
    expect(MODEL_SECTION_HEADING).toBe('解析のモデル');
  });

  it('見出しがもう描かれていれば、見える所へ動かして、キーボードの位置を移す（見出しは止まり場所ではないので、移せるようにする）', () => {
    const target = heading('h2', '解析のモデル');
    target.scrollIntoView = vi.fn();
    document.body.append(heading('h2', '更新'), target);
    focusSettingsSection(MODEL_SECTION_HEADING);
    expect(target.getAttribute('tabindex')).toBe('-1');
    expect(target).toHaveFocus();
    expect(target.scrollIntoView).toHaveBeenCalledTimes(1);
  });

  it('見出しが描かれるまで待つ（設定のページは、設定を読み終えてから欄を描く）。現れたら移って、待つのをやめる', async () => {
    focusSettingsSection(MODEL_SECTION_HEADING);
    const target = heading('h3', ' 解析のモデル ');
    target.scrollIntoView = vi.fn();
    await act(async () => {
      document.body.append(target);
      await Promise.resolve();
    });
    expect(target).toHaveFocus();
    expect(target.scrollIntoView).toHaveBeenCalledTimes(1);
  });

  it('見出しの文字が違うものには移らない。待つのをやめる関数を呼ぶと、あとで現れても移らない', async () => {
    const stop = focusSettingsSection(MODEL_SECTION_HEADING);
    const other = heading('h2', '解析のモデルの説明');
    const late = heading('h2', '解析のモデル');
    await act(async () => {
      document.body.append(other);
      await Promise.resolve();
    });
    expect(other).not.toHaveFocus();
    stop();
    await act(async () => {
      document.body.append(late);
      await Promise.resolve();
    });
    expect(late).not.toHaveFocus();
  });

  it('5 秒たっても見出しが現れなければ、あきらめる（あとで現れても移らない）', async () => {
    focusSettingsSection(MODEL_SECTION_HEADING);
    act(() => {
      vi.advanceTimersByTime(5001);
    });
    const late = heading('h2', '解析のモデル');
    await act(async () => {
      document.body.append(late);
      await Promise.resolve();
    });
    expect(late).not.toHaveFocus();
  });
});
