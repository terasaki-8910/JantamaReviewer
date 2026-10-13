/**
 * OS ごとの違い（macOS 対応の段階 2）。起動のとき 1 回、Rust から OS の名前と使える機能を受け取り（`loadPlatform`）、
 * 画面の出し分け（設定ページの行・ショートカットの表示と、macOS の分のキー操作）に使う。
 *
 * 受け取る前と、受け取れなかったとき（画面の試験の偽物など）は、Windows として扱う（これまでの動きと同じ）。
 * 窓を作る前に 1 回決まるだけの値なので、React の状態にはしない。
 */
import { api } from '../api/tauri';
import type { PlatformInfo } from '../api/types';

/** Windows の分（既定）。すべての機能が使える。 */
export const WINDOWS_PLATFORM: PlatformInfo = {
  os: 'windows',
  features: { widget: true, button_hook: true, capture: true, ocr: true, helper: true },
};

/** macOS の段階 2 の分（検討画面だけ）。画面の試験が使う。実際の値は Rust が決める（`platform/mac/mod.rs`）。 */
export const MAC_STAGE_2_PLATFORM: PlatformInfo = {
  os: 'macos',
  features: { widget: false, button_hook: false, capture: false, ocr: false, helper: false },
};

let current: PlatformInfo = WINDOWS_PLATFORM;

/** いまの OS の名前と、使える機能。 */
export function platform(): PlatformInfo {
  return current;
}

/** OS の情報を決める（起動のときと、画面の試験で使う）。 */
export function setPlatform(info: PlatformInfo): void {
  current = info;
}

/** 受け取った値が、OS の情報の形か。 */
function isPlatformInfo(value: unknown): value is PlatformInfo {
  if (typeof value !== 'object' || value === null) return false;
  const { os, features } = value as { os?: unknown; features?: unknown };
  if (os !== 'windows' && os !== 'macos') return false;
  if (typeof features !== 'object' || features === null) return false;
  return ['widget', 'button_hook', 'capture', 'ocr', 'helper'].every(
    (name) => typeof (features as Record<string, unknown>)[name] === 'boolean',
  );
}

/** OS の情報の答えを待つ上限（ミリ秒）。答えが来なくても、画面が描けないままにならないようにする。 */
const LOAD_TIMEOUT_MS = 3000;

/** Rust から OS の情報を受け取って決める。受け取れなかったとき・答えが遅いときは、Windows のまま（画面は描けるようにする）。 */
export async function loadPlatform(): Promise<PlatformInfo> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    const waited = new Promise<undefined>((resolve) => {
      timer = setTimeout(() => resolve(undefined), LOAD_TIMEOUT_MS);
    });
    const info: unknown = await Promise.race([api.getPlatformInfo(), waited]);
    if (isPlatformInfo(info)) current = info;
  } catch {
    // 受け取れなくても、画面は描く。
  } finally {
    clearTimeout(timer);
  }
  return current;
}

export function isMac(): boolean {
  return current.os === 'macos';
}

/** 「いつもの修飾キー」の名前（Windows は Ctrl、macOS は Cmd）。表示用。 */
export function modKeyName(): 'Ctrl' | 'Cmd' {
  return isMac() ? 'Cmd' : 'Ctrl';
}

/** 「Ctrl+K」「Cmd+K」のような、修飾キー付きのショートカットの表示。 */
export function modShortcut(key: string): string {
  return `${modKeyName()}+${key}`;
}

/** `aria-keyshortcuts` の書き方（Windows は Control+、macOS は Meta+）。 */
export function ariaModShortcut(key: string): string {
  return `${isMac() ? 'Meta' : 'Control'}+${key}`;
}

/** 画面の戻る・進むのショートカット（表示と読み上げ）。Windows は Alt+← →、macOS は Cmd+[ ]。 */
export function historyShortcut(direction: 'back' | 'forward'): { label: string; aria: string } {
  const back = direction === 'back';
  if (isMac()) {
    return back ? { label: 'Cmd+[', aria: 'Meta+[' } : { label: 'Cmd+]', aria: 'Meta+]' };
  }
  return back
    ? { label: 'Alt+←', aria: 'Alt+ArrowLeft' }
    : { label: 'Alt+→', aria: 'Alt+ArrowRight' };
}

/**
 * 画面の戻る・進むのキーか（押したキーの向きを返す。違えば null）。Windows は Alt+← →（これまでどおり）。
 * macOS は Cmd+[ と Cmd+]（macOS の「戻る」「進む」の習慣）。Alt+← → は使わない: macOS では Option+← → が、
 * 入力欄の中の「単語ごとの移動」なので、奪うと、メモを書いている最中に画面が戻ってしまう。
 * Shift・Ctrl・Option が付いたものは別の操作。
 */
export function historyKeyDirection(
  event: Pick<KeyboardEvent, 'key' | 'altKey' | 'ctrlKey' | 'metaKey' | 'shiftKey'>,
): 'back' | 'forward' | null {
  if (isMac()) {
    if (event.metaKey && !event.altKey && !event.ctrlKey && !event.shiftKey) {
      if (event.key === '[') return 'back';
      if (event.key === ']') return 'forward';
    }
    return null;
  }
  if (event.altKey && !event.ctrlKey && !event.metaKey && !event.shiftKey) {
    if (event.key === 'ArrowLeft') return 'back';
    if (event.key === 'ArrowRight') return 'forward';
  }
  return null;
}
