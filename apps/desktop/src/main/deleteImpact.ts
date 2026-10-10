/**
 * 半荘を消すときに、確認へ足す「ほかに消えるもの」（U-9）。
 *
 * 解き直し（出題・答え・予定）の記録（SQLite のクイズの DB）は、まだ無い。できたら、`solvedProblemCount` が、消す半荘の
 * 解いた問題の数を返すようにする。数が 1 以上なら、確認に「解いた問題 N問と、その解き直しの予定も消えます」が出る。
 */
export function solvedProblemCount(_sessionIds: readonly string[]): number {
  return 0;
}

/** 確認に出す、解いた問題の行。無ければ null。 */
export function solvedProblemsLine(count: number): string | null {
  return count > 0 ? `解いた問題 ${count}問と、その解き直しの予定も消えます。` : null;
}
