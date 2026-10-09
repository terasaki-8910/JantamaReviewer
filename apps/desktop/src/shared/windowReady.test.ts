import { invoke } from '@tauri-apps/api/core';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { installTauriMock, PAGE_BACKGROUNDS } from '../../tests/tauri-mock';
import {
  nextPaint,
  readPageBackground,
  reportBackground,
  resetWindowReadyForTest,
  signalWindowReady,
} from './windowReady';

vi.mock('@tauri-apps/api/core', () => ({ invoke: vi.fn(), convertFileSrc: (p: string) => p }));
vi.mock('@tauri-apps/api/event', () => ({ listen: vi.fn() }));

beforeEach(() => {
  resetWindowReadyForTest();
  document.body.style.background = '';
});

afterEach(() => {
  document.body.style.background = '';
  vi.restoreAllMocks();
});

describe('N-7: 窓を見せる知らせ', () => {
  it('readPageBackground: body が描いている背景の色（CSS の色の文字列）を返す', () => {
    document.body.style.background = PAGE_BACKGROUNDS.light;
    expect(readPageBackground()).toBe(PAGE_BACKGROUNDS.light);
    document.body.style.background = PAGE_BACKGROUNDS.dark;
    expect(readPageBackground()).toBe(PAGE_BACKGROUNDS.dark);
  });

  it('nextPaint: 描画の合図が来なくても、一定の時間で先へ進む', async () => {
    const raf = vi.spyOn(window, 'requestAnimationFrame').mockImplementation(() => 0);
    const started = performance.now();
    await nextPaint(30);
    expect(raf).toHaveBeenCalled();
    expect(performance.now() - started).toBeGreaterThanOrEqual(25);
  });

  it('signalWindowReady: 描き終えたあとに、そのときの背景の色を添えて、1 回だけ知らせる', async () => {
    const mock = installTauriMock();
    document.body.style.background = PAGE_BACKGROUNDS.surface;
    await signalWindowReady();
    await signalWindowReady();
    const calls = mock.calls().filter((c) => c.cmd === 'window_ready');
    expect(calls).toHaveLength(1);
    expect(calls[0]?.args).toEqual({ background: PAGE_BACKGROUNDS.surface });
  });

  it('signalWindowReady: 知らせるのは、描画を待ったあと（呼んだ直後には送らない）', async () => {
    const mock = installTauriMock();
    const pending = signalWindowReady();
    expect(mock.count('window_ready')).toBe(0);
    await pending;
    expect(mock.count('window_ready')).toBe(1);
  });

  it('signalWindowReady: 送れなくても例外にしない（理由はコンソールに残す）', async () => {
    installTauriMock({
      handlers: {
        window_ready: () => {
          throw new Error('送れない');
        },
      },
    });
    const log = vi.spyOn(console, 'error').mockImplementation(() => {});
    await expect(signalWindowReady()).resolves.toBeUndefined();
    expect(log).toHaveBeenCalled();
  });

  it('reportBackground: テーマが変わったあとの背景の色を知らせる', async () => {
    const mock = installTauriMock();
    document.body.style.background = PAGE_BACKGROUNDS.light;
    await reportBackground();
    document.body.style.background = PAGE_BACKGROUNDS.dark;
    await reportBackground();
    const calls = mock.calls().filter((c) => c.cmd === 'set_window_background');
    expect(calls.map((c) => c.args)).toEqual([
      { background: PAGE_BACKGROUNDS.light },
      { background: PAGE_BACKGROUNDS.dark },
    ]);
    expect(vi.mocked(invoke)).toHaveBeenCalled();
  });
});
