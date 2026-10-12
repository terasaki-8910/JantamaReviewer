/**
 * 終局直後のメモ（F4、U-28）の書き換えを、取り消せる命令（U-11）にする。
 * 画面にも Tauri にも依存しない（保存の窓口 `MemoApi` を渡す。試験では偽物を渡せる）。
 *
 * どの命令も「元の値」を持つ。元のメモが無かったときは、取り消すと、メモを消す（空のメモは持たない）。
 * 実行・取り消し・やり直しのたびに、半荘の一覧を読み直して（`reload`）、画面に反映する。
 * メモの文字を打つ欄の中では、欄そのものの取り消しが先に働く（`UndoProvider` は、文字を打つ欄にキーボードの位置があるとき動かない）。
 * 欄の外へ出たとき（と Enter）に、それまでに打った分を 1 つの命令として積む。
 */
import type { ExtraMemo, ExtraMemoPlace, MemoEntry } from '../api/types';
import { placeOf } from './memos';
import type { UndoCommand } from './undo/undoStack';

/** 保存の窓口（`api` の、メモが使う部分）。 */
export interface MemoApi {
  setMemo(sessionId: string, markId: number, memo: MemoEntry): Promise<void>;
  clearMemo(sessionId: string, markId: number): Promise<void>;
  setExtraMemo(sessionId: string, id: string, place: ExtraMemoPlace, memo: MemoEntry): Promise<void>;
  clearExtraMemo(sessionId: string, id: string): Promise<void>;
}

/** 保存したあとに、半荘の一覧を読み直す。 */
export type Reload = () => Promise<void>;

export interface MarkMemoEdit {
  sessionId: string;
  /** 迷いマークの記録の番号（保存の鍵）。 */
  markId: number;
  /** 画面に出す迷いの番号（1 から。通知に出す）。 */
  number: number;
  /** 元のメモ（無ければ undefined）。 */
  before: MemoEntry | undefined;
  /** 書いたメモ。undefined は、メモを消したこと（「候補」も「理由」も空）。 */
  after: MemoEntry | undefined;
}

/** 迷いマークのメモを書く・書き直す・空にして消す。 */
export function markMemoCommand(api: MemoApi, reload: Reload, edit: MarkMemoEdit): UndoCommand {
  const apply = async (memo: MemoEntry | undefined): Promise<void> => {
    if (memo === undefined) await api.clearMemo(edit.sessionId, edit.markId);
    else await api.setMemo(edit.sessionId, edit.markId, memo);
    await reload();
  };
  const name = `迷い${edit.number}のメモ`;
  return {
    label: 'メモの入力',
    messages: { undo: `${name}を元に戻しました`, redo: `${name}をやり直しました` },
    execute: () => apply(edit.after),
    undo: () => apply(edit.before),
  };
}

export interface ExtraMemoEdit {
  sessionId: string;
  /** メモの名前（`x1` など）。 */
  id: string;
  /** 元のメモ（足す前は undefined）。 */
  before: ExtraMemo | undefined;
  /** 書いたメモ（消したときは undefined）。 */
  after: ExtraMemo | undefined;
  /**
   * 局面を選んで結びつけたときの、選んだ判断の呼び名（通知に出す。例: 東3局 9巡目）。渡すと、「局面を選ぶ」操作の命令になる
   * （`before` は位置だけのメモ、`after` は判断の鍵を足したメモ）。
   */
  link?: string;
}

/**
 * 迷いマークの無い迷いのメモを、足す・書き直す・局面を選んで結びつける・消す。
 * どの保存も、メモ全体（局面・候補・理由）を書き直す。元の値も、その時点のメモ全体を持つ。
 */
export function extraMemoCommand(api: MemoApi, reload: Reload, edit: ExtraMemoEdit): UndoCommand {
  const apply = async (memo: ExtraMemo | undefined): Promise<void> => {
    if (memo === undefined) await api.clearExtraMemo(edit.sessionId, edit.id);
    else await api.setExtraMemo(edit.sessionId, edit.id, placeOf(memo), { candidates: memo.candidates, reason: memo.reason });
    await reload();
  };
  if (edit.link !== undefined) {
    const done = `追加のメモを${edit.link}の局面に結びつけました`;
    return {
      label: '追加のメモの局面を選ぶ',
      messages: { run: done, undo: '追加のメモの結びつけを元に戻しました', redo: done },
      execute: () => apply(edit.after),
      undo: () => apply(edit.before),
    };
  }
  const adding = edit.before === undefined;
  const removing = edit.after === undefined;
  const run = adding ? '迷いマークの無い迷いのメモを足しました' : removing ? '追加のメモを消しました' : undefined;
  return {
    label: adding ? '追加のメモを足す' : removing ? '追加のメモを消す' : 'メモの入力',
    messages: {
      ...(run === undefined ? {} : { run, redo: run }),
      undo: adding ? '追加のメモを足したことを元に戻しました' : removing ? '追加のメモを元に戻しました' : '追加のメモの入力を元に戻しました',
      ...(run === undefined ? { redo: '追加のメモの入力をやり直しました' } : {}),
    },
    execute: () => apply(edit.after),
    undo: () => apply(edit.before),
  };
}
