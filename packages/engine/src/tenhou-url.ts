/**
 * 天鳳牌理のリンクの文字列（E-3、F6）。
 *
 * ここは文字列を作るだけで、通信はしない（リンクは、アプリが既定のブラウザで開く。N-5）。
 * URL の書き方（スキームつきの文字列）をソースに持つので、安全の検査（S-2、apps/desktop/src-tauri/tests/safety.rs）の
 * 許可の一覧に、このファイルを理由つきで載せてある。URL を持つファイルは増やさない
 * （engine のテストが、許可した 2 ファイル以外に URL や雀魂のドメインが無いことを確かめる）。
 */
import { type Tile, toTenhouNotation } from './tiles';

/**
 * 天鳳牌理の URL（`https://tenhou.net/2/?q=<牌理の表記>`）。`tiles` は閉じた手の牌（副露した牌は含めない）。
 * 赤五は普通の五として書く（牌理は赤を区別しない）。
 */
export function tenhouPairiUrl(tiles: readonly Tile[]): string {
  return `https://tenhou.net/2/?q=${toTenhouNotation(tiles)}`;
}
