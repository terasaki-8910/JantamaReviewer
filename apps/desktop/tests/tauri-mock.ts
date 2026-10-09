/**
 * Tauri の API を差し替えるテスト用の道具。
 * 使うテストのファイルの先頭で、次の 2 つを宣言しておく（vi.mock はファイルごとに巻き上げられるため）:
 *
 *   vi.mock('@tauri-apps/api/core', () => ({ invoke: vi.fn(), convertFileSrc: ... }));
 *   vi.mock('@tauri-apps/api/event', () => ({ listen: vi.fn() }));
 */
import { invoke } from '@tauri-apps/api/core';
import { listen } from '@tauri-apps/api/event';
import { vi } from 'vitest';

import type { AppState, SessionRecord, Settings } from '../src/api/types';

export const baseState: AppState = {
  status: 'recording',
  session_id: '20261009-161200',
  mark_count: 2,
  ratings: ['good', 'fair', 'good', 'good'],
  next_hand: 5,
  can_undo: true,
  error: null,
};

export const baseSettings: Settings = {
  trigger: { kind: 'mouse_x1' },
  orientation: 'vertical',
  widget_position: null,
  sound: true,
  capture_keywords: ['雀魂', 'Mahjong Soul'],
  data_dir: 'C:\\Users\\test\\JantamaReviewerData',
};

/**
 * 画面が「いま描いている背景の色」として知らせてくる CSS の色の文字列（getComputedStyle が返す形）の見本。
 * テストのデータで、画面の色ではない（src の中には色の値を書けないので、ここに置く）。
 */
export const PAGE_BACKGROUNDS = {
  light: 'rgb(244, 244, 244)',
  dark: 'rgb(18, 18, 18)',
  surface: 'rgb(28, 28, 28)',
} as const;

type Handler = (event: { payload: unknown }) => void;

export interface TauriMock {
  /** `state-changed` などのイベントを、登録された受け手に送る。 */
  emit: (event: string, payload: unknown) => void;
  /** 呼ばれたコマンド（名前と引数）。 */
  calls: () => Array<{ cmd: string; args: unknown }>;
  /** 呼ばれた回数。 */
  count: (cmd: string) => number;
}

export interface TauriMockOptions {
  state?: AppState;
  settings?: Settings;
  sessions?: SessionRecord[];
  startupNote?: string | null;
  /** コマンドごとの返り値・エラーの上書き。関数なら引数を受けて返す（reject させたいときは throw）。 */
  handlers?: Record<string, (args: unknown) => unknown>;
}

/** invoke と listen を、与えた値を返す偽物にする。 */
export function installTauriMock(options: TauriMockOptions = {}): TauriMock {
  const state = options.state ?? baseState;
  const settings = options.settings ?? baseSettings;
  const listeners = new Map<string, Set<Handler>>();
  const calls: Array<{ cmd: string; args: unknown }> = [];

  vi.mocked(invoke).mockReset();
  vi.mocked(listen).mockReset();

  vi.mocked(invoke).mockImplementation(async (cmd: string, args?: unknown) => {
    calls.push({ cmd, args });
    const custom = options.handlers?.[cmd];
    if (custom) return custom(args);
    switch (cmd) {
      case 'get_state':
      case 'add_mark':
      case 'add_rating':
      case 'undo':
      case 'new_session':
        return state;
      case 'get_settings':
        return settings;
      case 'set_settings':
        return (args as { settings: Settings }).settings;
      case 'set_orientation':
        return { ...settings, orientation: (args as { orientation: Settings['orientation'] }).orientation };
      case 'list_sessions':
        return options.sessions ?? [];
      case 'get_startup_note':
        return options.startupNote ?? null;
      default:
        return undefined;
    }
  });

  vi.mocked(listen).mockImplementation(async (event: string, handler: unknown) => {
    const set = listeners.get(event) ?? new Set<Handler>();
    set.add(handler as Handler);
    listeners.set(event, set);
    return () => {
      set.delete(handler as Handler);
    };
  });

  return {
    emit: (event, payload) => {
      listeners.get(event)?.forEach((handler) => handler({ payload }));
    },
    calls: () => [...calls],
    count: (cmd) => calls.filter((c) => c.cmd === cmd).length,
  };
}
