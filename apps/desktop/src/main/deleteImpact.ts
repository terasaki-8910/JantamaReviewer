/**
 * 半荘を消すときに、確認へ足す「ほかに消えるもの」（U-9）。
 *
 * 解き直し（出題・答え・予定）の記録（`study.sqlite`）に、消す半荘の解いた問題の数を数えてもらう。数が 1 以上なら、確認に
 * 「解いた問題 N問と、その解き直しの予定も消えます」が出る。
 */
import { api } from '../api/tauri';

/** 消す半荘の、解いた問題の数（問題ごとに 1。出題と解き直しを合わせて、答えのある問題の数）。 */
export async function solvedProblemCount(sessionIds: readonly string[]): Promise<number> {
  const counts = await api.countSolved([...sessionIds]);
  return counts.reduce((sum, count) => sum + count.solved, 0);
}

/** 確認に出す、解いた問題の行。無ければ null。 */
export function solvedProblemsLine(count: number): string | null {
  return count > 0 ? `解いた問題 ${count}問と、その解き直しの予定も消えます。` : null;
}
