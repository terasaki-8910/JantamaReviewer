/**
 * 設定の「同期」の欄（F15、D-4）の、画面の文言と、状態の文の作り方。画面（SyncBlock.tsx）に依存しない。
 * 文言は、設定の「記録の書き出し」（recordsText.ts）と同じ、静かな書き方にそろえている。
 * トークンの文字は、ここにも画面にも持たない（貼った 1 回だけ、保存のコマンドに渡す。保管庫に入るのは Rust 側）。
 */
import type { SyncStatus } from '../api/types';
import { formatSessionShort } from './format';

export const SYNC_TITLE = '同期';

/** 説明のアイコン（InfoTip）の中身。 */
export const SYNC_HELP =
  '記録を、Windows と Mac の間で、Turso Cloud を通して同期します。手元の記録は、ふだんどおり手元に残り、同期は裏で行います。つながらないときも使えて、つながったときに続きを同期します。スクショ・ウィジェットの記録・文字認識の写しは、同期しません。';

export const URL_LABEL = '同期先の DB の URL';
export const URL_HELP = 'Turso で作った DB の URL（libsql:// で始まるもの）を貼ります。';
export const URL_PLACEHOLDER = 'libsql://…turso.io';

export const TOKEN_LABEL = 'トークン';
export const TOKEN_HELP =
  'DB 用のトークンを貼ります。この PC の資格情報の保管庫（Windows の資格情報マネージャー、Mac のキーチェーン）にだけ入り、ファイルにも、画面にも、ログにも残しません。貼ったあと、この欄は空に戻ります。';
export const TOKEN_PLACEHOLDER_SAVED = '保存済み（貼り直すと置き換わります）';
export const TOKEN_PLACEHOLDER_EMPTY = 'トークンを貼る';

export const SAVE_LABEL = '接続を保存';
export const SAVED_MESSAGE = '接続を保存しました';
export const NOTHING_TO_SAVE = 'URL かトークンを貼ってください';

export const ENABLE_LABEL = 'この端末で同期する';
export const ENABLE_NEEDS_SETUP = '先に、URL とトークンを保存してください';

export const ROW_TARGET = '同期先';
export const ROW_TOKEN = 'トークン';
export const ROW_STATE = '状態';
export const ROW_DEVICE = '端末の名前';
export const TARGET_NONE = '未設定';
export const TOKEN_SAVED = 'この PC の保管庫に保存済み';
export const TOKEN_NOT_SAVED = '未保存';

export const SYNC_NOW_LABEL = '今すぐ同期';
export const REBUILD_LABEL = '同期用の DB を作り直す';
export const DISCONNECT_LABEL = 'この端末の同期を切る';
export const ALLOW_DELETE_LABEL = '削除をそのまま同期する';

export const REBUILD_TITLE = '同期用の DB を作り直しますか';
export const REBUILD_DESCRIPTION =
  '同期用の DB の中身を全部消して、この端末の記録から入れ直します。ほかの端末は、次の同期で気づいて、入れ直した内容に合わせます。この端末の記録は変わりません。';
export const REBUILD_CONFIRM = '作り直す';

export const DISCONNECT_TITLE = 'この端末の同期を切りますか';
export const DISCONNECT_DESCRIPTION =
  'この端末に貼ったトークンと、同期用の作業ファイルを消します。この端末の記録と、同期用の DB（ほかの端末の分）は、そのままです。';
export const DISCONNECT_CONFIRM = '同期を切る';

export const ALLOW_DELETE_TITLE = '削除をそのまま同期しますか';
export const ALLOW_DELETE_DESCRIPTION =
  '消えている記録の削除を、そのまま同期します。消した記録は、元には戻せません。';
export const ALLOW_DELETE_CONFIRM = 'そのまま同期する';

export const CANCEL_LABEL = 'やめる';

/** 「最後の同期: 10月13日 22:10」。まだ同期していなければ null。 */
export function lastSyncText(status: Pick<SyncStatus, 'last_ok_ms'>, now: number = Date.now()): string | null {
  return status.last_ok_ms === null ? null : `最後の同期: ${formatSessionShort(status.last_ok_ms, now)}`;
}

/** 状態の行の文と、その種類（失敗・要確認は、強く出す）。 */
export interface StateLine {
  text: string;
  tone: 'quiet' | 'busy' | 'problem';
}

/** 同期用の URL と、使う設定になっているか（状態の文を決めるため）。 */
function configured(status: SyncStatus): boolean {
  return status.url_host !== '';
}

export function stateLine(status: SyncStatus, now: number = Date.now()): StateLine {
  const last = lastSyncText(status, now);
  switch (status.state) {
    case 'off':
      return { text: configured(status) ? '同期していません' : 'まだ設定していません', tone: 'quiet' };
    case 'idle':
      return { text: last ?? 'まだ同期していません', tone: 'quiet' };
    case 'syncing':
      return { text: '同期しています…', tone: 'busy' };
    case 'offline':
      return {
        text: `同期先につながりません。つながったときに、続きを同期します${last === null ? '' : `（${last}）`}`,
        tone: 'quiet',
      };
    case 'attention':
    case 'error':
      return { text: status.message ?? '同期できませんでした', tone: 'problem' };
  }
}
