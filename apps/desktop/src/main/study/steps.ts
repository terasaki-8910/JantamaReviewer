/**
 * 出題の画面で「前の巡目」「次の巡目」で行き来する盤面（F3: 2〜3巡前から再生できる）。
 *
 * 判断の盤面の 3 巡前から、本人の巡目が替わった最初の盤面（そのツモ・チー・ポンの直後）を 1 つずつ、最後に判断の盤面。
 * 判断より先は見せない（最後の盤面は、判断の盤面と同じ）。巡目が少なくて遡れないときは、あるところから。
 * 牌譜の再生そのものは、エンジンの `framesBeforeDecision`（E-2 で、再生した盤面が記録と一致することを確かめてある）。
 */
import { framesBeforeDecision, type BoardState, type Decision, type ImportedGame } from '@jantama/engine';

/** 何巡前から見せるか。 */
export const TURNS_BEFORE = 3;

/** 戻って見る盤面 1 つと、その盤面の牌譜の位置（`mjai_log` の中の event の位置。他家の手牌を、その時点で開くのに使う）。 */
export interface ReplayStepFrame {
  board: BoardState;
  eventIndex: number;
}

/** 戻って見る盤面（古い順。最後は判断の盤面）と、それぞれの牌譜の位置。 */
export function replayStepFrames(game: ImportedGame, decision: Decision, turnsBefore: number = TURNS_BEFORE): ReplayStepFrame[] {
  const frames = framesBeforeDecision(game, decision, turnsBefore);
  const target = decision.board.junme - turnsBefore;
  const steps: ReplayStepFrame[] = [];
  let lastJunme = -1;
  for (const frame of frames) {
    const board = frame.board;
    if (board.junme >= Math.max(1, target) && board.junme < decision.board.junme && board.junme !== lastJunme) {
      steps.push({ board, eventIndex: frame.eventIndex });
      lastJunme = board.junme;
    }
  }
  return [...steps, { board: decision.board, eventIndex: decision.eventIndex }];
}

export function replaySteps(game: ImportedGame, decision: Decision, turnsBefore: number = TURNS_BEFORE): BoardState[] {
  return replayStepFrames(game, decision, turnsBefore).map((frame) => frame.board);
}

/** 盤面の、河の段の数（6 枚で折り返す。最低 2 段）と、リーチ宣言牌（横向き）があるか。盤面の大きさを、どの巡目でもそろえるのに使う。 */
export function tableExtent(steps: readonly BoardState[]): { rows: number; riichiAny: boolean } {
  let rows = 2;
  let riichiAny = false;
  for (const step of steps) {
    for (const river of step.rivers) {
      rows = Math.max(rows, Math.ceil(river.length / 6));
      if (river.some((tile) => tile.riichi)) riichiAny = true;
    }
  }
  return { rows, riichiAny };
}
