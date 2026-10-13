import { invoke } from '@tauri-apps/api/core';
import { afterEach, describe, expect, it, vi } from 'vitest';

import {
  ariaModShortcut,
  historyKeyDirection,
  historyShortcut,
  isMac,
  loadPlatform,
  MAC_STAGE_2_PLATFORM,
  modKeyName,
  modShortcut,
  platform,
  setPlatform,
  WINDOWS_PLATFORM,
} from './platform';

vi.mock('@tauri-apps/api/core', () => ({ invoke: vi.fn() }));

afterEach(() => {
  setPlatform(WINDOWS_PLATFORM);
  vi.mocked(invoke).mockReset();
});

function key(
  name: string,
  modifiers: Partial<Record<'altKey' | 'ctrlKey' | 'metaKey' | 'shiftKey', boolean>> = {},
) {
  return { key: name, altKey: false, ctrlKey: false, metaKey: false, shiftKey: false, ...modifiers };
}

describe('OS の情報の受け取り（macOS 対応の段階 2）', () => {
  it('受け取る前は Windows として扱う（これまでの動きと同じ）', () => {
    expect(platform()).toEqual(WINDOWS_PLATFORM);
    expect(isMac()).toBe(false);
    expect(WINDOWS_PLATFORM.features).toEqual({
      widget: true,
      button_hook: true,
      capture: true,
      ocr: true,
      helper: true,
    });
  });

  it('Rust が返した OS の情報を、そのまま使う（`get_platform_info` を 1 回呼ぶ）', async () => {
    vi.mocked(invoke).mockResolvedValue(MAC_STAGE_2_PLATFORM);
    expect(await loadPlatform()).toEqual(MAC_STAGE_2_PLATFORM);
    expect(invoke).toHaveBeenCalledWith('get_platform_info');
    expect(invoke).toHaveBeenCalledTimes(1);
    expect(isMac()).toBe(true);
    expect(platform().features.widget).toBe(false);
  });

  it('形の違う答え・失敗のときは、Windows のまま（画面は描ける）', async () => {
    const replies = [
      undefined,
      null,
      'macos',
      { os: 'linux', features: {} },
      { os: 'macos' },
      { os: 'macos', features: { widget: 1 } },
    ];
    for (const reply of replies) {
      vi.mocked(invoke).mockResolvedValue(reply);
      expect(await loadPlatform()).toEqual(WINDOWS_PLATFORM);
    }
    vi.mocked(invoke).mockRejectedValue(new Error('呼べない'));
    expect(await loadPlatform()).toEqual(WINDOWS_PLATFORM);
    expect(isMac()).toBe(false);
  });
});

describe('ショートカットの表示', () => {
  it('Windows: Ctrl・Control・Alt+← →', () => {
    expect(modKeyName()).toBe('Ctrl');
    expect(modShortcut('K')).toBe('Ctrl+K');
    expect(ariaModShortcut('Z')).toBe('Control+Z');
    expect(historyShortcut('back')).toEqual({ label: 'Alt+←', aria: 'Alt+ArrowLeft' });
    expect(historyShortcut('forward')).toEqual({ label: 'Alt+→', aria: 'Alt+ArrowRight' });
  });

  it('macOS: Cmd・Meta・Cmd+[ ]（Alt+← → も使える）', () => {
    setPlatform(MAC_STAGE_2_PLATFORM);
    expect(modKeyName()).toBe('Cmd');
    expect(modShortcut('K')).toBe('Cmd+K');
    expect(ariaModShortcut('Z')).toBe('Meta+Z');
    expect(historyShortcut('back').label).toBe('Cmd+[');
    expect(historyShortcut('forward').label).toBe('Cmd+]');
    expect(historyShortcut('back').aria).toContain('Alt+ArrowLeft');
  });
});

describe('画面の戻る・進むのキー', () => {
  it('Windows: Alt+← → だけ。修飾キーが増えたもの・Cmd+[ ] は何でもない', () => {
    expect(historyKeyDirection(key('ArrowLeft', { altKey: true }))).toBe('back');
    expect(historyKeyDirection(key('ArrowRight', { altKey: true }))).toBe('forward');
    expect(historyKeyDirection(key('ArrowLeft'))).toBeNull();
    expect(historyKeyDirection(key('ArrowLeft', { altKey: true, shiftKey: true }))).toBeNull();
    expect(historyKeyDirection(key('ArrowLeft', { altKey: true, ctrlKey: true }))).toBeNull();
    expect(historyKeyDirection(key('ArrowLeft', { altKey: true, metaKey: true }))).toBeNull();
    expect(historyKeyDirection(key('[', { metaKey: true }))).toBeNull();
    expect(historyKeyDirection(key(']', { metaKey: true }))).toBeNull();
    expect(historyKeyDirection(key('ArrowUp', { altKey: true }))).toBeNull();
  });

  it('macOS: Alt+← → に加えて Cmd+[ ]。Shift・Ctrl・Option が付いたものは別の操作', () => {
    setPlatform(MAC_STAGE_2_PLATFORM);
    expect(historyKeyDirection(key('ArrowLeft', { altKey: true }))).toBe('back');
    expect(historyKeyDirection(key('[', { metaKey: true }))).toBe('back');
    expect(historyKeyDirection(key(']', { metaKey: true }))).toBe('forward');
    expect(historyKeyDirection(key('[', { metaKey: true, shiftKey: true }))).toBeNull();
    expect(historyKeyDirection(key('[', { metaKey: true, altKey: true }))).toBeNull();
    expect(historyKeyDirection(key('[', { metaKey: true, ctrlKey: true }))).toBeNull();
    expect(historyKeyDirection(key('['))).toBeNull();
  });
});
