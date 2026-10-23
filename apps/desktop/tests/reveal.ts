/**
 * 画面の試験の道具（試験のデータで、画面の部品ではない）: 答え合わせのあとの画面になるまで待つ。
 * 答え合わせのあとの答えの欄には、見出し「自分の答え」（`#reveal-h`）が出る。打牌の判断は、AI の評価を手牌の上の棒で出すので、
 * 右の欄に見出し「AIの評価（Mortal）」は無い（鳴き・リーチ・和了・カンの判断には、ある）。
 */
import { waitFor } from '@testing-library/react';

export async function revealed(): Promise<HTMLElement> {
  return waitFor(() => {
    const heading = document.getElementById('reveal-h');
    if (heading === null) throw new Error('答え合わせのあとの画面になっていません');
    return heading;
  });
}
