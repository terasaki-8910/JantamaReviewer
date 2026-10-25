/**
 * 半荘の NAGA の結果の URL の保存・消去（F22 段 2）を、取り消せる命令（U-11）にする。Ctrl+Z で戻り、Ctrl+Y でやり直せる。
 * 画面にも Tauri にも依存しない（保存の窓口 `NagaApi` を渡す。試験では偽物を渡せる）。
 * 実行・取り消し・やり直しのたびに、半荘の一覧を読み直して（`reload`）、画面に反映する。
 */
import type { UndoCommand } from './undo/undoStack';

/** 保存の窓口（`api` の、この編集が使う部分）。 */
export interface NagaApi {
  setNagaUrl(sessionId: string, url: string | null): Promise<void>;
}

export interface NagaEdit {
  sessionId: string;
  /** 直す前に保存してあった URL（無ければ null）。 */
  before: string | null;
  /** 直したあとの URL。null は、消すこと。 */
  after: string | null;
}

/** NAGA の結果の URL を保存する・消す。取り消すと、前の URL（無ければ、無い状態）に戻る。 */
export function nagaCommand(api: NagaApi, reload: () => Promise<void>, edit: NagaEdit): UndoCommand {
  const apply = async (url: string | null): Promise<void> => {
    await api.setNagaUrl(edit.sessionId, url);
    await reload();
  };
  const removing = edit.after === null;
  const done = removing ? 'NAGA の結果を消しました' : 'NAGA の結果を保存しました';
  return {
    label: removing ? 'NAGA の結果の削除' : 'NAGA の結果の保存',
    messages: {
      run: done,
      undo: removing ? 'NAGA の結果の削除を元に戻しました' : 'NAGA の結果の保存を元に戻しました',
      redo: done,
    },
    execute: () => apply(edit.after),
    undo: () => apply(edit.before),
  };
}
