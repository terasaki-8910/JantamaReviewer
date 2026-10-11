/**
 * 取り込み（F1）の画面に出す言葉のうち、取り込みのページ（ImportPage）と、半荘のページの中の取り込み（TargetImport。U-14）が
 * 同じものを使う部分。画面にも Tauri にも依存しない。
 */
import type { ImportStep, ImportSummary } from './importFlow';
import type { ClipboardProblem } from './useImportFlow';

/** 取り込みの途中で、いま何をしているか（段階ごとの言葉）。 */
export function stepText(step: ImportStep, progress: { done: number; total: number } | null): string {
  switch (step) {
    case 'fetching':
      return '結果を受け取っています';
    case 'checking':
      return '牌譜と検討結果が合うか、確かめています';
    case 'reading':
      return progress && progress.total > 0
        ? `記録した画面から、局と点数を読み取っています（${progress.done} / ${progress.total}）`
        : '記録した画面から、局と点数を読み取っています';
    case 'saving':
      return '保存しています';
  }
}

/** クリップボードに牌譜リンクが無かった理由を、文にする。 */
export function problemText(problem: ClipboardProblem | null): string {
  switch (problem?.kind) {
    case 'empty':
      return 'クリップボードが空です。';
    case 'unreadable':
      return `クリップボードを読めませんでした: ${problem.message}`;
    default:
      return 'クリップボードに、雀魂の牌譜リンクがありません。';
  }
}

/**
 * 取り込んだ迷いマークの結びつけの結果を、文にする（承認済みの見本の書き方に、「推定」を足したもの）。
 * 読めた迷いは、1 位の判断を推定として結びつける。読めなかったものだけが、手で選ぶ。
 */
export function marksText(summary: ImportSummary): string | null {
  if (summary.markCount === 0) return null;
  if (summary.manualMarks === 0) return `（迷い ${summary.markCount} つを、すべて推定で局面に結びつけました）`;
  if (summary.estimatedMarks === 0) {
    return `（局面に結びつけられたものはありません。${summary.manualMarks}つは手で選んでください）`;
  }
  return `（${summary.estimatedMarks}つは推定で局面に結びつけました。${summary.manualMarks}つは手で選んでください）`;
}
