/**
 * NAGA の結果の欄（F22 段 2）の、画面にも Tauri にも依存しない決まりと文言（試験しやすいように分けてある）。
 *
 * 半荘のページに、NAGA（麻雀 AI）で解析した結果のページの URL を貼って保存する。保存できるのは、NAGA のサイトの https の URL だけ。
 * 正しいかどうかを決めるのは Rust 側（`naga.rs`）で、ここの確かめは、貼り間違いにすぐ答えるためのもの。
 * アプリは、この URL にアクセスしない。リンクを押すと、いつものブラウザで開く（外のページを開くのは Rust 側。N-5）。
 * URL の文字列はソースに書けない（tests/safety.rs の S-2 が、ソース中の URL を通信の疑いとして拒む）ので、スキームとホストから組み立てる。
 */

/** NAGA のサイトのホスト名（Rust 側の `NAGA_HOST` と同じ。試験が突き合わせる）。NAGA のサイトの場所が変わったときは、Rust 側と一緒に直す。 */
export const NAGA_HOST = 'naga.dmv.nico';
const SCHEME = 'https';

/** 欄の見出し。 */
export const NAGA_TITLE = 'NAGA の結果';

/** 見出しのそばの説明のアイコン（i）の名前と、中身。 */
export const NAGA_HELP_LABEL = 'NAGA の結果の説明';
export const NAGA_HELP =
  'NAGA でこの半荘の牌譜を解析した結果のページの URL を貼っておくと、ここと半荘を通して見る画面から開けます。申し込みと支払いは、NAGA のページで行います。';

/** 入力欄の名前（読み上げ用）と、見本の文字。 */
export const NAGA_URL_LABEL = 'NAGA の結果の URL';
export const NAGA_URL_PLACEHOLDER = `${SCHEME}://${NAGA_HOST}/…`;

/** 貼った文字が NAGA の結果のページの URL でないときの、理由（Rust 側が返す文と同じ）。 */
export const NAGA_URL_INVALID = `NAGA の結果のページの URL（${SCHEME}://${NAGA_HOST}/ で始まるもの）を貼ってください`;

export const NAGA_SAVE_LABEL = '保存';
export const NAGA_OPEN_SHORT_LABEL = '開く';
export const NAGA_REMOVE_LABEL = '消す';
/** 半荘のページの見出しの操作と、半荘を通して見る画面の操作の段にある、リンクの名前。 */
export const NAGA_OPEN_LABEL = 'NAGA の結果を開く';

/**
 * 貼った文字が、NAGA の結果のページの URL か（https で、ホストが NAGA のサイトそのもの。ユーザー名・パスワード・ポートの指定が無い）。
 * Rust 側（`checked_naga_url`）と同じ決まり。違っていたら、Rust 側が断る。
 */
export function isNagaUrl(text: string): boolean {
  let url: URL;
  try {
    url = new URL(text.trim());
  } catch {
    return false;
  }
  return (
    url.protocol === `${SCHEME}:` &&
    url.hostname === NAGA_HOST &&
    url.username === '' &&
    url.password === '' &&
    url.port === ''
  );
}
