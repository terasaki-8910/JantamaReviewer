/**
 * サイドバーの見出しの右の組（検索・← →）のショートカットの表示が、OS で変わること（macOS 対応の段階 2）。
 * Windows の書き方（Ctrl+K・Alt+← →）は、これまでどおり。
 */
import { render, screen } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';

import { MAC_STAGE_2_PLATFORM, setPlatform, WINDOWS_PLATFORM } from '../shared/platform';
import { HeaderTools } from './Sidebar';

vi.mock('@tauri-apps/api/core', () => ({ invoke: vi.fn(), convertFileSrc: (path: string) => path }));

afterEach(() => setPlatform(WINDOWS_PLATFORM));

function renderTools() {
  render(
    <HeaderTools
      canGoBack
      canGoForward
      onGoBack={() => undefined}
      onGoForward={() => undefined}
      searchOpen={false}
      onSearch={() => undefined}
    />,
  );
}

describe('ショートカットの表示は OS で変わる', () => {
  it('Windows: Ctrl+K・Alt+← →', () => {
    renderTools();
    const search = screen.getByRole('button', { name: '検索' });
    expect(search).toHaveAttribute('title', '検索（Ctrl+K）');
    expect(search).toHaveAttribute('aria-keyshortcuts', 'Control+K');
    const back = screen.getByRole('button', { name: '戻る' });
    expect(back).toHaveAttribute('title', '戻る（Alt+←）');
    expect(back).toHaveAttribute('aria-keyshortcuts', 'Alt+ArrowLeft');
    const forward = screen.getByRole('button', { name: '進む' });
    expect(forward).toHaveAttribute('title', '進む（Alt+→）');
    expect(forward).toHaveAttribute('aria-keyshortcuts', 'Alt+ArrowRight');
  });

  it('macOS: Cmd+K・Cmd+[ ]', () => {
    setPlatform(MAC_STAGE_2_PLATFORM);
    renderTools();
    const search = screen.getByRole('button', { name: '検索' });
    expect(search).toHaveAttribute('title', '検索（Cmd+K）');
    expect(search).toHaveAttribute('aria-keyshortcuts', 'Meta+K');
    expect(screen.getByRole('button', { name: '戻る' })).toHaveAttribute('title', '戻る（Cmd+[）');
    expect(screen.getByRole('button', { name: '進む' })).toHaveAttribute('title', '進む（Cmd+]）');
  });
});
