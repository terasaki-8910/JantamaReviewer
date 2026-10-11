import { api } from '../api/tauri';
import type { MemoEntry } from '../api/types';
import { MemoFields } from './MemoFields';
import { markMemoCommand } from './memoEdits';
import { useUndo } from './undo/UndoProvider';

/**
 * 迷いマーク 1 つのメモの欄（「候補」「理由（1行）」。F4、U-28）。保存先は、半荘のフォルダの `memos.json`（迷いマークの番号ごと）。
 * 迷いのカードの中と、半荘を通して見る画面の迷いの場面（答える前）が使う。
 * 欄の外へ出たとき・Enter で、取り消せる命令にして保存し（U-11）、保存したあとに `reload` で半荘の一覧を読み直す。
 */
interface MarkMemoFieldsProps {
  sessionId: string;
  /** 迷いマークの記録の番号（保存の鍵）。 */
  markId: number;
  /** 画面に出す迷いの番号（1 から）。 */
  number: number;
  /** 保存してあるメモ。無ければ undefined。 */
  saved: MemoEntry | undefined;
  /** 保存したあとに、半荘の一覧を読み直す。 */
  reload: () => Promise<void>;
  /** 「理由」の欄の名前（`MemoFields` を見る）。 */
  reasonLabel?: string;
}

export function MarkMemoFields({ sessionId, markId, number, saved, reload, reasonLabel }: MarkMemoFieldsProps) {
  const undo = useUndo();
  return (
    <MemoFields
      name={`迷い${number}のメモ`}
      saved={saved}
      {...(reasonLabel === undefined ? {} : { reasonLabel })}
      onPersist={async (after) => {
        if (after === undefined) await api.clearMemo(sessionId, markId);
        else await api.setMemo(sessionId, markId, after);
      }}
      onCommit={(before, after) => undo.run(markMemoCommand(api, reload, { sessionId, markId, number, before, after }))}
    />
  );
}
