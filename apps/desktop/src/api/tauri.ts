/**
 * Rust 側のコマンドとイベントの窓口。
 * 画面（webview）から通信やファイルには触れず、すべてこのコマンド越しに行う。
 */
import { invoke } from '@tauri-apps/api/core';
import { listen, type UnlistenFn } from '@tauri-apps/api/event';

import type { AppState, Orientation, Rating, SessionRecord, Settings } from './types';

/** 記録の状態が変わったときのイベント名（Rust の `EVENT_STATE_CHANGED`）。 */
export const EVENT_STATE_CHANGED = 'state-changed';
/** 設定が変わったときのイベント名（Rust の `EVENT_SETTINGS_CHANGED`）。 */
export const EVENT_SETTINGS_CHANGED = 'settings-changed';

export const api = {
  getState: () => invoke<AppState>('get_state'),
  /** ウィジェットの「迷い」ボタン。割り当てたボタンと同じ記録をつくる。 */
  addMark: () => invoke<AppState>('add_mark'),
  addRating: (rating: Rating) => invoke<AppState>('add_rating', { rating }),
  undo: () => invoke<AppState>('undo'),
  newSession: () => invoke<AppState>('new_session'),
  getSettings: () => invoke<Settings>('get_settings'),
  setSettings: (settings: Settings) => invoke<Settings>('set_settings', { settings }),
  setOrientation: (orientation: Orientation) =>
    invoke<Settings>('set_orientation', { orientation }),
  openMainWindow: () => invoke<void>('open_main_window'),
  listSessions: () => invoke<SessionRecord[]>('list_sessions'),
  getStartupNote: () => invoke<string | null>('get_startup_note'),
  showWidgetMenu: () => invoke<void>('show_widget_menu'),
  /**
   * 最初の絵を描き終えたことを知らせる（N-7）。窓は隠したまま作られ、これを受けた Rust 側が
   * 窓の背景色を `background`（いま描いている背景の色。CSS の色の文字列）にそろえてから見せる。
   */
  windowReady: (background: string) => invoke<void>('window_ready', { background }),
  /** 開発者ツールを開く。`tauri dev` のときだけ開く（N-12）。 */
  openDevtools: () => invoke<void>('open_devtools'),
  /** テーマが変わったときに、窓の背景色を画面の色にそろえさせる（N-7）。 */
  setWindowBackground: (background: string) =>
    invoke<void>('set_window_background', { background }),
};

export function onStateChanged(handler: (state: AppState) => void): Promise<UnlistenFn> {
  return listen<AppState>(EVENT_STATE_CHANGED, (event) => handler(event.payload));
}

export function onSettingsChanged(handler: (settings: Settings) => void): Promise<UnlistenFn> {
  return listen<Settings>(EVENT_SETTINGS_CHANGED, (event) => handler(event.payload));
}

/** コマンドが返したエラー（Rust の String）を、画面に出す文にする。 */
export function errorMessage(error: unknown): string {
  if (typeof error === 'string') return error;
  if (error instanceof Error) return error.message;
  return String(error);
}
