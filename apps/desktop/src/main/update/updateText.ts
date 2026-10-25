/**
 * アプリ内の更新（F21）の画面の文言。更新の帯（検討画面の上）と、設定の「更新」の欄が使う。
 */

// ---- 更新の帯 ----

/** 帯の名前（読み上げ用）。 */
export const BANNER_LABEL = 'アプリの更新';

export function foundText(version: string): string {
  return `新しい版 ${version} があります`;
}

export const INSTALLING_TEXT = '新しい版を入れています…';

export const INSTALL_LABEL = '今すぐ入れ直す';
export const LATER_LABEL = 'あとで';
export const SKIP_LABEL = 'この版は飛ばす';

/** 記録中に、「今すぐ入れ直す」が押せない理由。Rust 側の断りの文（`RECORDING_MESSAGE`）と同じ。 */
export const RECORDING_REASON = '記録中は入れ直せません（対局のあとで）';

export function installFailedText(reason: string): string {
  return `入れ直せませんでした: ${reason}`;
}

export function skipFailedText(reason: string): string {
  return `この版を飛ばす設定を保存できませんでした: ${reason}`;
}

// ---- 設定の「更新」の欄 ----

export const UPDATE_TITLE = '更新';
export const ROW_CURRENT = '今の版';
export const ROW_RESULT = '確かめた結果';
export const CHECK_LABEL = '更新を確かめる';

export const NOT_CHECKED_TEXT = 'まだ確かめていません';
export const CHECKING_TEXT = '確かめています…';
export const UP_TO_DATE_TEXT = '最新です';
export const NOT_CONFIGURED_TEXT = '更新の仕組みがまだ設定されていません';
export const FAILED_TEXT = '確かめられませんでした';

/** 「新しい版」を「あとで」にしたとき・飛ばす設定にしたときの、結果の行に足す一言。 */
export const LATER_NOTE = '（あとで入れ直します）';
export const SKIPPED_NOTE = '（この版は飛ばす設定です）';
