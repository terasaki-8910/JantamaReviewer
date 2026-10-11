/**
 * 半荘を通して見る画面（F12）の時間軸（U-21 の計算の側）。
 *
 * 取り込んだ半荘を、局ごとの「手」の列にする。1 手は、全員の打牌と鳴きの 1 つずつ（配牌・自分のツモ・リーチの宣言・カンと、局の終わりも 1 手）。
 * 手のあとの盤面は、牌譜の再生（`replayFrames`。E-2 で、記録と一致することを確かめてある）の盤面そのもの。
 * 判断が起きる event は、すべて手になる（自分のツモ・他家の打牌と暗槓・加槓・自分のチーとポン・自分のリーチ）ので、
 * 自分の判断（`Decision`）は、ちょうど 1 つの手に属する（その手の盤面は、判断の盤面と同じ）。
 * 手にならないもの: 他家のツモ・リーチの成立・ドラの追加・局の終わりの印（盤面には、次の手から反映される）。
 *
 * 画面の「前・次の自分の判断」「前・次の巡目」「前・次の局」は、ここの関数で行き先を決める（純粋な関数。画面に依存しない）。
 */
import type { Decision } from './decision';
import type { ImportedGame } from './import';
import { classifyHandOutcome, type HandOutcomeKind } from './outcome';
import { replayFrames, splitKyokus, type BoardState } from './replay';
import type { EndStatusEvent, MjaiEvent, Seat } from './report-types';

/**
 * 手の種類。
 * - start: 局の始まり（配牌。巡目 0）
 * - tsumo: 自分のツモ（ほかの人のツモは手にならない）
 * - dahai: 打牌（全員）
 * - call: チー・ポン・大明槓（全員）
 * - kan: 暗槓・加槓（全員）
 * - reach: リーチの宣言（全員）
 * - end: 局の終わり（和了・流局。ダブロンでも 1 手）
 */
export type TimelineStepKind = 'start' | 'tsumo' | 'dahai' | 'call' | 'kan' | 'reach' | 'end';

/** 局の結果（本人から見て）。 */
export interface KyokuEnd {
  kind: HandOutcomeKind;
  /** 本人の点数の増減（供託・本場の分を含む）。 */
  delta: number;
  /** 席ごとの点数の増減（和了が複数あるときは合計）。 */
  deltas: number[];
  /** 和了した席（流局は空）。 */
  winners: Seat[];
  /** ロンのとき、放銃した席。ツモ・流局は null。 */
  ronFrom: Seat | null;
}

export interface TimelineStep {
  /** 半荘の中の何手目か（0 から。全局を通した番号）。 */
  index: number;
  /** 何番目の局か（0 から）。 */
  kyokuPosition: number;
  /** 局の中の何手目か（0 から）。 */
  position: number;
  /** mjai_log の中の event の位置。 */
  eventIndex: number;
  event: MjaiEvent;
  kind: TimelineStepKind;
  /** この手を動かした席。局の始まり・終わりは null。 */
  actor: Seat | null;
  /** この手のあとの盤面（牌譜の再生の盤面そのもの）。 */
  board: BoardState;
  /** 本人の巡目（盤面の巡目。0 は配牌）。 */
  junme: number;
  /** この手の盤面で本人がする判断。無ければ null。 */
  decision: Decision | null;
}

export interface TimelineKyoku {
  /** 何番目の局か（0 から）。 */
  position: number;
  /** 局の名前。例: 東2局1本場。 */
  label: string;
  /** 局の最初の手（配牌）の通し番号。 */
  first: number;
  /** 局の最後の手の通し番号。 */
  last: number;
  steps: TimelineStep[];
  /** 局の結果。 */
  end: KyokuEnd;
  /** 巡目ごとの最初の手の通し番号（巡目 → 通し番号）。 */
  turnFirst: ReadonlyMap<number, number>;
}

export interface ReplayTimeline {
  /** レビューした本人の席。 */
  playerId: Seat;
  kyokus: TimelineKyoku[];
  /** すべての手（半荘の順）。 */
  steps: TimelineStep[];
  /** 判断の通し番号（`Decision.index`）→ その判断がある手の通し番号。 */
  stepOfDecision: ReadonlyMap<number, number>;
}

function stepKindOf(event: MjaiEvent, playerId: Seat): TimelineStepKind | null {
  switch (event.type) {
    case 'start_kyoku':
      return 'start';
    case 'tsumo':
      return event.actor === playerId ? 'tsumo' : null;
    case 'dahai':
      return 'dahai';
    case 'chi':
    case 'pon':
    case 'daiminkan':
      return 'call';
    case 'ankan':
    case 'kakan':
      return 'kan';
    case 'reach':
      return 'reach';
    case 'hora':
    case 'ryukyoku':
      return 'end';
    default:
      return null;
  }
}

function actorOf(event: MjaiEvent, kind: TimelineStepKind): Seat | null {
  if (kind === 'start' || kind === 'end') return null;
  return 'actor' in event ? event.actor : null;
}

/** 局の結果（review.kyokus[].end_status）を、本人から見た形にする。 */
export function kyokuEndOf(endStatus: readonly EndStatusEvent[], playerId: Seat): KyokuEnd {
  const outcome = classifyHandOutcome(endStatus, playerId);
  const deltas = [0, 0, 0, 0];
  const winners: Seat[] = [];
  let ronFrom: Seat | null = null;
  for (const status of endStatus) {
    for (let seat = 0; seat < 4; seat++) deltas[seat] = (deltas[seat] as number) + (status.deltas[seat] ?? 0);
    if (status.type !== 'hora') continue;
    if (!winners.includes(status.actor)) winners.push(status.actor);
    if (ronFrom === null && status.target !== status.actor) ronFrom = status.target;
  }
  return { kind: outcome.kind, delta: outcome.delta, deltas, winners, ronFrom };
}

/** 取り込んだ半荘の時間軸を作る。牌譜を局ごとに再生し直す（E-2 と同じ再生）。 */
export function buildReplayTimeline(game: ImportedGame): ReplayTimeline {
  const { playerId } = game;
  const logs = splitKyokus(game.report.mjai_log);
  const byEvent = new Map<number, Decision>();
  for (const decision of game.decisions) byEvent.set(decision.eventIndex, decision);

  const steps: TimelineStep[] = [];
  const stepOfDecision = new Map<number, number>();
  const kyokus: TimelineKyoku[] = [];

  for (const imported of game.kyokus) {
    const log = logs[imported.position];
    if (log === undefined) throw new RangeError(`${imported.position + 1}局目が牌譜にありません`);
    const first = steps.length;
    const mine: TimelineStep[] = [];
    let ended = false;
    for (const frame of replayFrames(log, playerId)) {
      if (ended) break;
      const kind = stepKindOf(frame.event, playerId);
      if (kind === null) continue;
      if (kind === 'end') ended = true;
      const decision = byEvent.get(frame.eventIndex) ?? null;
      const step: TimelineStep = {
        index: first + mine.length,
        kyokuPosition: imported.position,
        position: mine.length,
        eventIndex: frame.eventIndex,
        event: frame.event,
        kind,
        actor: actorOf(frame.event, kind),
        board: frame.board,
        junme: frame.board.junme,
        decision,
      };
      mine.push(step);
      if (decision !== null) stepOfDecision.set(decision.index, step.index);
    }
    const turnFirst = new Map<number, number>();
    for (const step of mine) if (!turnFirst.has(step.junme)) turnFirst.set(step.junme, step.index);
    const endStatus = game.report.review.kyokus[imported.position]?.end_status ?? [];
    steps.push(...mine);
    kyokus.push({
      position: imported.position,
      label: imported.label,
      first,
      last: steps.length - 1,
      steps: mine,
      end: kyokuEndOf(endStatus, playerId),
      turnFirst,
    });
  }
  return { playerId, kyokus, steps, stepOfDecision };
}

// ---- 行き先の決め方（純粋な関数。`from` は、いま見ている手の通し番号。行き先が無ければ null） ----

/** 昇順の通し番号の列で、`from` より後ろの最初のもの。 */
export function nextStepIn(sorted: readonly number[], from: number): number | null {
  for (const value of sorted) if (value > from) return value;
  return null;
}

/** 昇順の通し番号の列で、`from` より前の最後のもの。 */
export function prevStepIn(sorted: readonly number[], from: number): number | null {
  for (let i = sorted.length - 1; i >= 0; i--) {
    const value = sorted[i] as number;
    if (value < from) return value;
  }
  return null;
}

/** 昇順の通し番号の列で、`from` より後ろにあるものの数。 */
export function countAfter(sorted: readonly number[], from: number): number {
  return sorted.filter((value) => value > from).length;
}

/** 自分の判断がある手の通し番号（昇順。鳴き・リーチ・カン・和了の判断も含む）。 */
export function decisionSteps(timeline: ReplayTimeline): number[] {
  return timeline.steps.filter((step) => step.decision !== null).map((step) => step.index);
}

/**
 * 次の巡目の最初の手。この局に次の巡目が無ければ、次の局の頭。半荘の終わりなら null。
 * 巡目は、本人のツモとチー・ポンで 1 つずつ進む（ほかの人の打牌は、そのとき本人の巡目の中）。
 */
export function nextTurnStep(timeline: ReplayTimeline, from: number): number | null {
  const step = timeline.steps[from];
  if (step === undefined) return null;
  const kyoku = timeline.kyokus[step.kyokuPosition];
  if (kyoku === undefined) return null;
  const next = kyoku.turnFirst.get(step.junme + 1);
  if (next !== undefined) return next;
  return timeline.kyokus[kyoku.position + 1]?.first ?? null;
}

/**
 * 前の巡目の最初の手。この巡目の途中なら、この巡目の最初の手。局の頭からは、前の局のいちばん後ろの巡目の最初の手。
 * 半荘の頭なら null。
 */
export function prevTurnStep(timeline: ReplayTimeline, from: number): number | null {
  const step = timeline.steps[from];
  if (step === undefined) return null;
  const kyoku = timeline.kyokus[step.kyokuPosition];
  if (kyoku === undefined) return null;
  const first = kyoku.turnFirst.get(step.junme) ?? kyoku.first;
  if (from > first) return first;
  if (step.junme > 0) return kyoku.turnFirst.get(step.junme - 1) ?? kyoku.first;
  const before = timeline.kyokus[kyoku.position - 1];
  if (before === undefined) return null;
  const latest = Math.max(...before.turnFirst.keys());
  return before.turnFirst.get(latest) ?? before.first;
}

/** 次の局の頭。最後の局なら null。 */
export function nextKyokuStep(timeline: ReplayTimeline, from: number): number | null {
  const step = timeline.steps[from];
  if (step === undefined) return null;
  return timeline.kyokus[step.kyokuPosition + 1]?.first ?? null;
}

/** 前の局の頭。最初の局なら null。 */
export function prevKyokuStep(timeline: ReplayTimeline, from: number): number | null {
  const step = timeline.steps[from];
  if (step === undefined) return null;
  return timeline.kyokus[step.kyokuPosition - 1]?.first ?? null;
}
