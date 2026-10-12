/**
 * 記録の書き出しと読み込み（D-2、R11-14）の、画面の文言と、名前・大きさの整え方。画面（RecordsBlock.tsx）に依存しない。
 * 文言の大半は、承認済みの見本（round11-samples/export-a）のとおり。見本に無い文（読み込み前の確認と、読み込んだあとの知らせの、
 * 取っておく半荘の件数）は、同じ静かな書き方で足していて、`heldSentence`・`importedMessage` にまとめている。
 */
import type { RecordsPreview } from '../api/types';

/** 「含まれるもの」の欄。 */
export const RECORDS_INCLUDES =
  '答え・解き直しの予定・迷いの結びつけ・自分の評価（〇△✕）・MAKA の評価・メモ・週の成績・設定';

/** 含まれないものの注意。 */
export const RECORDS_EXCLUDED =
  'スクショと Mortal の結果は含みません。すべて残すときは、データの保存先のフォルダごと写してください。';

/** 説明のアイコン（InfoTip）の中身。 */
export const RECORDS_HELP =
  '記録をまとめて 1 つのファイル（JSON）に書き出します。書き出したファイルを読み込むと、記録が元に戻ります。';

/** 読み込む前の確認の見出し。 */
export const CONFIRM_TITLE = 'このファイルの記録を読み込みますか';

/** 日付（ローカルの暦）から、書き出すファイルの既定の名前（jantama-records-YYYYMMDD.json）。 */
export function defaultRecordsName(date: Date): string {
  const two = (n: number) => String(n).padStart(2, '0');
  return `jantama-records-${date.getFullYear()}${two(date.getMonth() + 1)}${two(date.getDate())}.json`;
}

/** パスの、ファイルの名前の部分（区切りは \ も / も）。 */
export function fileNameOf(path: string): string {
  const parts = path.split(/[\\/]/);
  return parts[parts.length - 1] ?? path;
}

/** ファイルの大きさを、おおよその値の文にする（「約 0.4 MB」「約 120 KB」）。 */
export function formatSize(bytes: number): string {
  if (bytes < 1024 * 1024) return `約 ${Math.max(1, Math.round(bytes / 1024))} KB`;
  return `約 ${(bytes / (1024 * 1024)).toFixed(1)} MB`;
}

/** 書き出したあとの知らせ。 */
export function exportedMessage(name: string, bytes: number): string {
  return `書き出しました。${name}（${formatSize(bytes)}）`;
}

/** 「（半荘 12・答え 84）」の括弧の中。 */
export function countsText(counts: Pick<RecordsPreview, 'sessions' | 'answers'>): string {
  return `（半荘 ${counts.sessions}・答え ${counts.answers}）`;
}

/** この保存先に半荘のフォルダが無い半荘の件数を、確認に足す 1 文（無ければ null）。 */
export function heldSentence(held: number): string | null {
  return held > 0
    ? `保存先に無い半荘が ${held} 件あります。そのフォルダを保存先に写すと、記録が付きます。`
    : null;
}

/** 読み込んだあとの知らせ。 */
export function importedMessage(report: RecordsPreview): string {
  const base = `読み込みました${countsText(report)}。スクショと Mortal の結果は、データの保存先にあるものを使います。`;
  return report.held > 0
    ? `${base}保存先に無い半荘 ${report.held} 件の記録は、そのフォルダを保存先に写したときに付きます。`
    : base;
}
