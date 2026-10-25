/**
 * アプリ内の更新（F21）の、Rust 側のコマンドの窓口と、やり取りするデータの型。
 * 画面（webview）から通信やインストーラーには触れず、すべてこのコマンド越しに行う。呼べるのは検討画面だけ（ウィジェットは呼ばない）。
 * 型のフィールド名は Rust 側の JSON（snake_case）に合わせている（`src-tauri/src/update/mod.rs`）。
 */
import { invoke } from '@tauri-apps/api/core';

import type { Settings } from './types';

/** 今の版と、更新の仕組みが使える状態か（公開鍵が入っているか）。通信しない。 */
export interface UpdateInfo {
  current_version: string;
  configured: boolean;
}

/** 確かめた結果。`failed` は、確かめられなかった（理由つき）。 */
export type UpdateOutcome =
  | { kind: 'not_configured' }
  | { kind: 'up_to_date' }
  | { kind: 'available'; version: string; notes: string | null; date: string | null }
  | { kind: 'failed'; message: string };

export type UpdateCheck = { current_version: string } & UpdateOutcome;

export const updateApi = {
  /** 今の版と、更新の仕組みが使える状態か。通信しない（設定の「更新」の欄が、最初に読む）。 */
  getUpdateInfo: () => invoke<UpdateInfo>('get_update_info'),
  /** 更新を確かめる。起動のとき（1 回）と、設定の「更新を確かめる」を押したときだけ呼ぶ。失敗は、結果の中に理由を入れて返る。 */
  checkUpdate: () => invoke<UpdateCheck>('check_update'),
  /**
   * 見つけた更新を、ダウンロードして、署名を確かめて、入れ直す。「今すぐ入れ直す」を押したときだけ呼ぶ。
   * Windows では、インストーラーが動いて、アプリが終わる（インストーラーが入れ終えたあとに開き直す）ので、戻ってこない。
   * 記録中・失敗のときは、理由を投げる。
   */
  installUpdate: () => invoke<void>('install_update'),
  /** 「この版は飛ばす」: 版を設定（settings.json）に覚える。同期にも書き出しにも入れない。変わった設定を返す。 */
  skipUpdateVersion: (version: string) => invoke<Settings>('skip_update_version', { version }),
};
