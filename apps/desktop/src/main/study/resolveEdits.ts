/**
 * 局面の「解決」の入れ切り（F16）を、取り消せる命令（U-11）にする。Ctrl+Z で戻り、Ctrl+Y でやり直せる（入と切が入れ替わる）。
 * 画面にも Tauri にも依存しない（保存の窓口 `ResolveApi` を渡す。試験では偽物を渡せる）。
 * 実行・取り消し・やり直しのたびに、半荘の一覧を読み直して（`reload`）、画面に反映する。
 */
import type { UndoCommand } from '../undo/undoStack';

/** 保存の窓口（`api` の、この編集が使う部分）。 */
export interface ResolveApi {
  setResolved(sessionId: string, decisionKey: string, resolved: boolean): Promise<void>;
}

export interface ResolveEdit {
  sessionId: string;
  /** 判断の鍵。 */
  key: string;
  /** 直す前に、解決していたか。 */
  before: boolean;
  /** 直したあとの形（入れるなら true）。 */
  after: boolean;
}

/** 局面の解決を入れる・切る。取り消すと、前の形に戻る。 */
export function resolveCommand(api: ResolveApi, reload: () => Promise<void>, edit: ResolveEdit): UndoCommand {
  const apply = async (resolved: boolean): Promise<void> => {
    await api.setResolved(edit.sessionId, edit.key, resolved);
    await reload();
  };
  return {
    label: '解決',
    messages: {
      undo: edit.after ? '解決を元に戻しました' : '解決の取り消しを元に戻しました',
      redo: edit.after ? '解決をやり直しました' : '解決の取り消しをやり直しました',
    },
    execute: () => apply(edit.after),
    undo: () => apply(edit.before),
  };
}
