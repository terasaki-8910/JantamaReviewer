/**
 * 迷いマークを、判断に結びつけ直す（候補を選ぶ・局面を手で選ぶ・選び直す・前後の手に付け替える）操作。
 * 保存して、取り消せる命令（U-11）にする。半荘のページ（`SessionPage`）と、出題・通して見る画面の「迷いのスクショ」の欄が、同じ操作を使う。
 * 失敗は、取り消しの積み重ねの知らせが通知に出す（ここでは握りつぶさず、呼び出し元へ返す）。
 */
import type { DecisionRef } from '@jantama/engine';
import { useCallback } from 'react';

import { api } from '../api/tauri';
import { markLinkCommand, type Reload } from './hanchanEdits';
import type { ResolvedMark } from './markCards';
import { useUndo } from './undo/UndoProvider';

/** `item` の迷いを `ref` の判断に結びつける（保存のあと `reload` で半荘の一覧を読み直す）。 */
export type ChooseDecision = (item: ResolvedMark, ref: DecisionRef) => Promise<void>;

export function useMarkLink(sessionId: string, reload: Reload): ChooseDecision {
  const undo = useUndo();
  return useCallback(
    (item, ref) =>
      undo.run(
        markLinkCommand(api, reload, {
          sessionId,
          markId: item.markId,
          number: item.number,
          before: item.stored,
          after: ref.key,
          where: `${ref.kyokuLabel} ${ref.junme}巡目`,
        }),
      ),
    [undo, sessionId, reload],
  );
}
