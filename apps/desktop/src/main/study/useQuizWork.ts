/**
 * 出題 1 問の作業の状態（手牌・選んだ牌・答え合わせのあとの印・鳴きの選択肢が使う牌・答えの状態）。
 * 出題（`QuizScreen`）と、半荘を通して見る画面の場面（`SceneWork`）が、同じ動きで使う。
 *
 * - `board` は、手牌を出す盤面。過去の盤面（`past`）は、手牌を押せず、鳴く牌も出さない（出題の「前の巡目」）
 * - 答え（打牌なら牌、ほかはボタン）と理由・答え合わせは `useQuizAnswer`（U-1・U-2）
 */
import {
  answerOptions,
  calledTileOf,
  keyOfDecision,
  problemId,
  type AnswerOption,
  type BoardState,
  type Decision,
  type QuizChoice,
  type Seat,
  type Tile as TileCode,
} from '@jantama/engine';
import { useCallback, useMemo, useRef, useState } from 'react';

import type { AnswerMode, AnswerRow } from '../../api/types';
import { handBars, type HandBars } from './aiBars';
import type { ResolveControl } from './AnswerBar';
import { doraKinds } from './dora';
import type { HandItem, HandMark } from './Hand';
import { buildHandItems, handMarks, usedIndices } from './handMarks';
import { relationName } from './labels';
import { useStudy } from './StudyProvider';
import { useQuizAnswer, type QuizAnswer, type QuizDraftStore } from './useQuizAnswer';

const NO_MARKS: ReadonlyMap<number, HandMark> = new Map();
const NO_USED: ReadonlySet<number> = new Set();

export interface QuizWorkParams {
  decision: Decision;
  sessionId: string;
  mode: AnswerMode;
  /** 手牌を出す盤面。 */
  board: BoardState;
  /** 過去の盤面か（手牌を押せない）。 */
  past: boolean;
  /** すでに答えた問題（あれば、答え合わせのあとの形で始める）。 */
  existing: AnswerRow | null;
  previousIntervalDays: number | null;
  /** 答えの下書きの置き場（通して見る画面が、場面を離れて戻っても、下書きを残すため）。 */
  draft?: QuizDraftStore;
}

export interface QuizWorkState {
  quiz: QuizAnswer;
  options: readonly AnswerOption[];
  /** 他家の打牌への判断で、鳴く牌。 */
  called: TileCode | null;
  /** 鳴く牌を打った席。 */
  calledSeat: Seat | null;
  /** 鳴く牌を打った人の呼び名（対面など）。 */
  calledFrom: string | null;
  items: readonly HandItem[];
  /** ドラ表示牌が指す牌の種類。設定が切のときは null。 */
  dora: ReadonlySet<number> | null;
  revealed: boolean;
  marks: ReadonlyMap<number, HandMark>;
  /**
   * 手牌の上の AI の評価の棒。打牌の判断の答え合わせのあと（過去の盤面を除く）だけ。それまでは null（U-1）。
   * 過去の盤面の間は、答えの欄に評価の一覧を出す（`AnswerPanel` の `past`）。
   */
  bars: HandBars | null;
  used: ReadonlySet<number>;
  /** 手牌の中で選んでいる牌の位置。 */
  selected: number | null;
  onPick: (index: number) => void;
  /** 打牌の答えで、選んでいる牌。 */
  pickedTile: TileCode | null;
  /** 正解とする確率の下限。 */
  threshold: number;
  /** この局面の「解決」の入切（F16）。 */
  resolve: ResolveControl;
}

/** 下書きの答え（牌）が、手牌の何枚目か（同じ牌があれば、いちばん左）。 */
function selectedIndexOf(items: readonly HandItem[], choice: QuizChoice | null): number | null {
  if (choice === null || choice.type !== 'dahai') return null;
  const index = items.findIndex((item) => !item.called && item.tile === choice.tile);
  return index < 0 ? null : index;
}

export function useQuizWork({ decision, sessionId, mode, board, past, existing, previousIntervalDays, draft }: QuizWorkParams): QuizWorkState {
  const study = useStudy();
  const quiz = useQuizAnswer({
    decision,
    sessionId,
    mode,
    threshold: study.threshold,
    previousIntervalDays,
    existing,
    record: study.recordAnswer,
    draft,
  });

  const options = useMemo(() => answerOptions(decision), [decision]);
  // 他家の打牌への判断（鳴き・ロン）で、鳴く牌。手牌の右に離して置く
  const called = decision.kind === 'discard' ? null : calledTileOf(decision);
  const calledSeat = called === null ? null : (decision.entry.last_actor as Seat);

  const items = useMemo(() => buildHandItems(board, past ? null : called), [board, past, called]);
  const [selected, setSelected] = useState<number | null>(() => selectedIndexOf(items, quiz.choice));
  const dora = useMemo(() => (study.highlightDora ? doraKinds(board.doraMarkers) : null), [study.highlightDora, board]);
  const revealed = quiz.stage === 'revealed';

  const marks = useMemo(() => {
    const { choice, model } = quiz;
    if (!revealed || past || decision.kind !== 'discard' || model === null) return NO_MARKS;
    if (choice === null || choice.type !== 'dahai') return NO_MARKS;
    const actual = decision.entry.actual;
    return handMarks(items, {
      you: choice.tile,
      act: model.actualTile,
      top: model.topTile,
      actTsumogiri: actual.type === 'dahai' && actual.tsumogiri,
    });
  }, [revealed, past, decision, items, quiz]);

  const answered = quiz.choice;
  const bars = useMemo(() => {
    if (!revealed || past || decision.kind !== 'discard') return null;
    if (answered === null || answered.type !== 'dahai') return null;
    return handBars(items, decision.entry, answered.tile);
  }, [revealed, past, decision, items, answered]);

  const used = useMemo(() => {
    const { choice } = quiz;
    if (past || choice === null || choice.type !== 'option') return NO_USED;
    const option = options.find((candidate) => candidate.id === choice.id);
    return option === undefined ? NO_USED : usedIndices(items, option.use);
  }, [past, quiz, options, items]);

  const { choose } = quiz;
  const stage = quiz.stage;
  const onPick = useCallback(
    (index: number) => {
      if (past || stage !== 'answering') return;
      const item = items[index];
      if (item === undefined || item.called) return;
      if (selected === index) {
        setSelected(null);
        choose(null);
      } else {
        setSelected(index);
        choose({ type: 'dahai', tile: item.tile });
      }
    },
    [past, stage, items, selected, choose],
  );

  const pickedTile = quiz.choice !== null && quiz.choice.type === 'dahai' ? quiz.choice.tile : null;
  const calledFrom = calledSeat === null ? null : relationName(decision.board.playerId, calledSeat);

  // 解決の入切（F16）。いまの形は、保存した解決（半荘の一覧）から読む。保存が済むまでの間の押し直しは、受け付けない
  const resolvedNow = study.resolvedIds.has(problemId({ sessionId, key: keyOfDecision(decision) }));
  const { setResolved } = study;
  const saving = useRef(false);
  const toggleResolve = useCallback(() => {
    if (saving.current) return;
    saving.current = true;
    void setResolved(sessionId, keyOfDecision(decision), !resolvedNow).finally(() => {
      saving.current = false;
    });
  }, [setResolved, sessionId, decision, resolvedNow]);
  const resolve = useMemo<ResolveControl>(() => ({ on: resolvedNow, toggle: toggleResolve }), [resolvedNow, toggleResolve]);

  return {
    quiz,
    options,
    called,
    calledSeat,
    calledFrom,
    items,
    dora,
    revealed,
    marks,
    bars,
    used,
    selected,
    onPick,
    pickedTile,
    threshold: study.threshold,
    resolve,
  };
}
