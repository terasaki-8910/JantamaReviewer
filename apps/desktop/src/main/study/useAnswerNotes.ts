/**
 * 答え合わせのあとに直す欄（差の原因・学んだ原則・MAKA の推した打牌）の状態と保存。
 *
 * - 差の原因・MAKA の打牌は、直すたびに、取り消せる命令として積む（U-11）。表に出す値は、保存した答え（`StudyProvider` の答えの一覧）から
 *   読む。取り消しは画面の外（Ctrl+Z）からも来るので、手元に写しを持たない。保存が返るまでの間だけ、直した値を先に見せる
 * - 学んだ原則は文字を打つ欄。欄の外へ出たとき（と、次の問題へ進むとき）に保存する
 */
import { CAUSE_CHOICES } from '@jantama/engine';
import { useCallback, useRef, useState } from 'react';

import { errorMessage } from '../../api/tauri';
import type { AnswerRow } from '../../api/types';
import { useUndo } from '../undo/UndoProvider';
import { causesCommand, makaMoveCommand } from './answerEdits';
import { useStudy } from './StudyProvider';

export interface NotesState {
  causes: readonly string[];
  makaMove: string | null;
  principle: string;
  setPrinciple: (value: string) => void;
  toggleCause: (id: string, checked: boolean) => void;
  setMakaMove: (move: string | null) => void;
  /** 学んだ原則を保存する。保存できなければ false（理由は `error`）。 */
  commitPrinciple: () => Promise<boolean>;
  /** 保存できなかった理由。 */
  error: string | null;
}

export function useAnswerNotes(row: AnswerRow): NotesState {
  const { answers, updateNotes } = useStudy();
  const undo = useUndo();
  const current = answers.find((answer) => answer.id === row.id) ?? row;
  const [causesDraft, setCausesDraft] = useState<readonly string[] | null>(null);
  const [makaDraft, setMakaDraft] = useState<{ move: string | null } | null>(null);
  const [principle, setPrinciple] = useState(current.principle);
  const [error, setError] = useState<string | null>(null);

  const causes = causesDraft ?? current.causes;
  const makaMove = makaDraft === null ? current.maka_move : makaDraft.move;

  const toggleCause = useCallback(
    (id: string, checked: boolean) => {
      const before = causesDraft ?? current.causes;
      const after = CAUSE_CHOICES.map((cause) => cause.id as string).filter((cause) =>
        cause === id ? checked : before.includes(cause),
      );
      if (after.length === before.length && after.every((cause, index) => cause === before[index])) return;
      setCausesDraft(after);
      // 失敗の知らせは、取り消しの積み重ねが通知に出す。ここでは、先に見せた値を戻すだけ
      undo
        .run(causesCommand(updateNotes, { id: row.id, before, after }))
        .catch(() => undefined)
        .finally(() => setCausesDraft(null));
    },
    [causesDraft, current.causes, row.id, undo, updateNotes],
  );

  const setMakaMove = useCallback(
    (move: string | null) => {
      const before = makaDraft === null ? current.maka_move : makaDraft.move;
      if (move === before) return;
      setMakaDraft({ move });
      undo
        .run(makaMoveCommand(updateNotes, { id: row.id, before, after: move }))
        .catch(() => undefined)
        .finally(() => setMakaDraft(null));
    },
    [current.maka_move, makaDraft, row.id, undo, updateNotes],
  );

  // 学んだ原則の保存は、1 つずつ順に行う（欄の外へ出たときと、次へ進むときが続いても、同じ文を 2 度保存しない）
  const savedPrinciple = useRef(row.principle);
  const queue = useRef<Promise<boolean>>(Promise.resolve(true));
  const commitPrinciple = useCallback((): Promise<boolean> => {
    const run = async (): Promise<boolean> => {
      const next = principle.trim();
      if (next === savedPrinciple.current) return true;
      try {
        await updateNotes(row.id, { principle: next });
        savedPrinciple.current = next;
        setError(null);
        return true;
      } catch (failure) {
        setError(`学んだ原則を保存できませんでした: ${errorMessage(failure)}`);
        return false;
      }
    };
    queue.current = queue.current.then(run, run);
    return queue.current;
  }, [principle, row.id, updateNotes]);

  return { causes, makaMove, principle, setPrinciple, toggleCause, setMakaMove, commitPrinciple, error };
}
