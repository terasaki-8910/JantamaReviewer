/**
 * 設定の「解析のモデル」の欄（F24、U-54）の文言と、大きさ・出どころの整え方。画面（ReadsModelBlock.tsx）に依存しない。
 */
import type { ReadsModelProgress, ReadsModelStatus } from '../api/reads';

/** 欄の見出し。 */
export const SECTION_TITLE = '解析のモデル';
/** 欄の中の、読みのモデルの行の名前。 */
export const READS_ROW_LABEL = '読みのモデル';

/** 説明のアイコン（InfoTip）の名前と中身。 */
export const READS_HELP_LABEL = '読みのモデルの説明';
export const READS_HELP =
  '他家の聴牌と待ちを読むモデルです（F23）。押したときだけ huggingface.co から取ります。半荘の画面の「読み」で使います。天鳳の牌譜で学習したモデルです。';

/** ボタン。 */
export const DOWNLOAD_LABEL = 'Hugging Face から取る';
export const CHOOSE_LABEL = 'ファイルを選ぶ…';
export const CANCEL_LABEL = '取り消す';
export const DELETE_LABEL = '消す';

/** 状態の行。 */
export const NOT_INSTALLED_TEXT = '入っていません';
export const DOWNLOADING_TEXT = '取っています…';
export const CANCELLING_TEXT = '取り消しています…';
export const CHOOSING_TEXT = '確かめています…';
export const DELETING_TEXT = '消しています…';

/** ファイルを選ぶダイアログ。 */
export const CHOOSE_DIALOG_TITLE = '読みのモデルのファイルを選ぶ';
export const ONNX_FILTER = [{ name: '読みのモデル（ONNX）', extensions: ['onnx'] }];

/** バイト数を MB の文字にする（1 MB は 1,000,000 バイト。4,013,332 バイトのモデルは 4.0 MB）。 */
export function formatMegabytes(bytes: number): string {
  return (bytes / 1_000_000).toFixed(1);
}

/** 入っているときの状態の行。大きさが分かれば添える。 */
export function installedText(bytes: number | null): string {
  return bytes === null ? '入っています' : `入っています（${formatMegabytes(bytes)} MB）`;
}

/** 取っている最中の状態の行。最初の進み具合が届くまでは、数を出さない。大きさを告げられないときは、済んだ分だけ。 */
export function downloadingText(progress: ReadsModelProgress | null): string {
  if (progress === null) return DOWNLOADING_TEXT;
  if (progress.total === null || progress.total <= 0) {
    return `${DOWNLOADING_TEXT} ${formatMegabytes(progress.done)} MB`;
  }
  return `${DOWNLOADING_TEXT} ${formatMegabytes(progress.done)} / ${formatMegabytes(progress.total)} MB`;
}

/** 出どころの 1 行（例: `hhim8826/mortal3-b40c192 · AGPL-3.0 · 天鳳の鳳凰卓 160 万局で学習`）。 */
export function metaText(status: Pick<ReadsModelStatus, 'repo' | 'license' | 'origin'>): string {
  return [status.repo, status.license, status.origin].join(' · ');
}

/** モデルの状態を読めなかったとき。 */
export function loadFailedText(reason: string): string {
  return `読みのモデルの状態を読めませんでした: ${reason}`;
}
