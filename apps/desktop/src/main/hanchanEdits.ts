/**
 * 半荘のページでの編集（迷いの結びつけ・自分の〇△✕・MAKA の評価）を、取り消せる命令（U-11）にする。
 * 画面にも Tauri にも依存しない（保存の窓口 `EditApi` を渡す。試験では偽物を渡せる）。
 *
 * どの命令も、「元の値」を持つ: 元の値が保存されていなかったときは、取り消すと、保存してあった値ではなく
 * 「保存しない状態」に戻す（結びつけなら自動の結果、評価の上書きならウィジェットで付けた評価、MAKA なら空）。
 * 実行・取り消し・やり直しのたびに、半荘の一覧を読み直して（`reload`）、画面に反映する。
 */
import type { SelfRatingValue } from '../api/types';
import type { UndoCommand } from './undo/undoStack';

/** 保存の窓口（`api` の、この編集が使う部分）。 */
export interface EditApi {
  setMarkLink(sessionId: string, markId: number, decision: string): Promise<void>;
  clearMarkLink(sessionId: string, markId: number): Promise<void>;
  setSelfRating(sessionId: string, kyoku: string, rating: SelfRatingValue): Promise<void>;
  clearSelfRating(sessionId: string, kyoku: string): Promise<void>;
  setMakaGrade(sessionId: string, kyoku: string, grade: string): Promise<void>;
  clearMakaGrade(sessionId: string, kyoku: string): Promise<void>;
  setMakaHanchan(sessionId: string, grade: string): Promise<void>;
  clearMakaHanchan(sessionId: string): Promise<void>;
}

/** 保存したあとに、半荘の一覧を読み直す。 */
export type Reload = () => Promise<void>;

/** 通知の文に使う、自分の評価の言い方。 */
const SELF_RATING_TEXT: Readonly<Record<SelfRatingValue, string>> = {
  good: '〇',
  fair: '△',
  bad: '✕',
  none: 'なし',
};

export interface MarkLinkEdit {
  sessionId: string;
  /** 迷いマークの記録の番号。 */
  markId: number;
  /** 画面に出す迷いの番号（1 から）。 */
  number: number;
  /** 元の保存した値（無ければ undefined）。 */
  before: string | undefined;
  /** 選んだ判断の鍵。 */
  after: string;
  /** 選んだ判断の呼び名（通知に出す）。例: 東2局 11巡目 */
  where: string;
}

/** 迷いマークを、判断に結びつける（候補を選ぶ・局面を手で選ぶ・選び直す）。 */
export function markLinkCommand(api: EditApi, reload: Reload, edit: MarkLinkEdit): UndoCommand {
  const apply = async (value: string | undefined): Promise<void> => {
    if (value === undefined) await api.clearMarkLink(edit.sessionId, edit.markId);
    else await api.setMarkLink(edit.sessionId, edit.markId, value);
    await reload();
  };
  const done = `迷い${edit.number}を${edit.where}の局面に結びつけました`;
  return {
    label: '迷いの結びつけ',
    messages: { run: done, undo: `迷い${edit.number}の結びつけを元に戻しました`, redo: done },
    execute: () => apply(edit.after),
    undo: () => apply(edit.before),
  };
}

export interface SelfRatingEdit {
  sessionId: string;
  /** 局の鍵。 */
  kyoku: string;
  /** 局の名前（通知に出す）。 */
  label: string;
  /** 元の保存した上書き（無ければ undefined）。 */
  before: SelfRatingValue | undefined;
  after: SelfRatingValue;
}

/** 局の自分の〇△✕を付け直す（`none` は「評価なし」）。 */
export function selfRatingCommand(api: EditApi, reload: Reload, edit: SelfRatingEdit): UndoCommand {
  const apply = async (value: SelfRatingValue | undefined): Promise<void> => {
    if (value === undefined) await api.clearSelfRating(edit.sessionId, edit.kyoku);
    else await api.setSelfRating(edit.sessionId, edit.kyoku, value);
    await reload();
  };
  const done = `${edit.label}の自分の評価を${SELF_RATING_TEXT[edit.after]}にしました`;
  return {
    label: '局の評価の付け直し',
    messages: { run: done, undo: `${edit.label}の自分の評価を元に戻しました`, redo: done },
    execute: () => apply(edit.after),
    undo: () => apply(edit.before),
  };
}

export interface MakaEdit {
  sessionId: string;
  /** 局の鍵。半荘全体のときは undefined。 */
  kyoku: string | undefined;
  /** 通知に出す名前。例: 東2局、半荘全体 */
  label: string;
  /** 元の保存した段階（無ければ undefined）。 */
  before: string | undefined;
  /** 入れた段階。undefined は、消した（空にした）こと。 */
  after: string | undefined;
}

/** MAKA の評価（局ごと・半荘全体）を入れる・消す。 */
export function makaCommand(api: EditApi, reload: Reload, edit: MakaEdit): UndoCommand {
  const apply = async (grade: string | undefined): Promise<void> => {
    const { sessionId, kyoku } = edit;
    if (kyoku === undefined) {
      if (grade === undefined) await api.clearMakaHanchan(sessionId);
      else await api.setMakaHanchan(sessionId, grade);
    } else if (grade === undefined) {
      await api.clearMakaGrade(sessionId, kyoku);
    } else {
      await api.setMakaGrade(sessionId, kyoku, grade);
    }
    await reload();
  };
  const done =
    edit.after === undefined ? `${edit.label}の MAKA の入力を消しました` : `${edit.label}の MAKA を ${edit.after} にしました`;
  return {
    label: 'MAKA の評価の入力',
    messages: { run: done, undo: `${edit.label}の MAKA を元に戻しました`, redo: done },
    execute: () => apply(edit.after),
    undo: () => apply(edit.before),
  };
}
