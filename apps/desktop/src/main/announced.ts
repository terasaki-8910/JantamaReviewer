/**
 * 「この半荘を取り込みますか」と知らせた牌譜 ID の記憶（E-15）。同じ牌譜 ID は一度しか知らせない。
 *
 * アプリを閉じて開き直しても、クリップボードに同じリンクが残っていれば、また知らせてしまう。それを避けるため、
 * 知らせた牌譜 ID をこの窓の localStorage に覚える（画面ごとの便利のためだけの記憶。読めなくても、動きは変わらない）。
 * 覚えるのは牌譜 ID だけ（アカウントを特定できる `_a<数字>` は含まない。エンジンの `PaipuLink.paipuId`）。
 */

export const ANNOUNCED_STORAGE_KEY = 'jr-announced-paipu';

/** 覚えておく牌譜 ID の数の上限。古いものから忘れる。 */
export const ANNOUNCED_LIMIT = 200;

/** 覚えている牌譜 ID（古い順）。無い・読めないときは空。 */
export function loadAnnouncedIds(): string[] {
  try {
    const text = window.localStorage.getItem(ANNOUNCED_STORAGE_KEY);
    if (text === null) return [];
    const value: unknown = JSON.parse(text);
    return Array.isArray(value) ? value.filter((v): v is string => typeof v === 'string') : [];
  } catch {
    // 記憶が使えなくても、画面は動く。
    return [];
  }
}

/** 牌譜 ID を覚える。上限を超えたら、古いものから忘れる。覚えられなくても、何もしない。 */
export function saveAnnouncedIds(ids: readonly string[]): void {
  try {
    window.localStorage.setItem(ANNOUNCED_STORAGE_KEY, JSON.stringify(ids.slice(-ANNOUNCED_LIMIT)));
  } catch {
    // 覚えられないだけ。
  }
}
