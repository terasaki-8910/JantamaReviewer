/**
 * 答える前の欄の、場面の情報の 1 行（F3、U-47）: 自分の巡目・向聴数（場面の向聴数。見出しの札と同じ）・他家の立直。
 * 例: 「12巡目 · 1向聴 · 対面が立直（9巡目）」「5巡目 · 聴牌 · 他家の立直なし」。
 * どれも答える前に出してよい情報で、AI の情報は入れない（U-1）。画面にも Tauri にも依存しない純粋な関数。
 */
import { shantenTag, type BoardState, type Decision, type Seat } from '@jantama/engine';

import { relationName } from './labels';

/** 立直している他家 1 人。 */
export interface RiichiOpponent {
  seat: Seat;
  /** 本人から見た呼び名（下家・対面・上家）。 */
  relation: string;
  /**
   * 何巡目に立直したか: 立直の宣言牌が、その人の河の何枚目か（左から数えて。鳴かれた牌も数える）。
   * 他家が聴牌した巡目（F14）の「N巡目」と同じ数え方。宣言牌がまだ河に無いときは null。
   */
  junme: number | null;
}

/** 立直している他家を、下家・対面・上家の順に返す。立直していなければ空。 */
export function riichiOpponents(board: Pick<BoardState, 'playerId' | 'riichi' | 'rivers'>): RiichiOpponent[] {
  const out: RiichiOpponent[] = [];
  for (const offset of [1, 2, 3]) {
    const seat = ((board.playerId + offset) % 4) as Seat;
    if ((board.riichi[seat] ?? 'none') === 'none') continue;
    const at = (board.rivers[seat] ?? []).findIndex((tile) => tile.riichi);
    out.push({ seat, relation: relationName(board.playerId, seat), junme: at < 0 ? null : at + 1 });
  }
  return out;
}

/** 他家の立直の言い方: 無ければ「他家の立直なし」、あれば「対面が立直（9巡目）」（2 人以上は「・」でつなぐ）。 */
export function riichiText(board: Pick<BoardState, 'playerId' | 'riichi' | 'rivers'>): string {
  const opponents = riichiOpponents(board);
  if (opponents.length === 0) return '他家の立直なし';
  return opponents.map((opponent) => `${opponent.relation}が立直${opponent.junme === null ? '' : `（${opponent.junme}巡目）`}`).join('・');
}

/** 1 行の中身（巡目・向聴数・他家の立直）。見出しの巡目と向聴数の札と同じ言い方。 */
export interface SceneLine {
  junme: string;
  shanten: string;
  riichi: string;
}

export function sceneLine(decision: Pick<Decision, 'junme' | 'shanten' | 'board'>): SceneLine {
  return {
    junme: `${decision.junme}巡目`,
    shanten: shantenTag(decision.shanten),
    riichi: riichiText(decision.board),
  };
}

/** 1 行の文字（項目を「 · 」でつなぐ）。 */
export function sceneLineText(line: SceneLine): string {
  return [line.junme, line.shanten, line.riichi].join(' · ');
}
