/**
 * 半荘を通して見る画面（F12）に出す文言と、局の選択の数。純粋な関数（画面にも Tauri にも依存しない）。
 * 文言は、承認済みの見本（10 回目の replay.js）のとおり。
 */
import {
  countAfter,
  decisionSteps,
  nextKyokuStep,
  nextStepIn,
  nextTurnStep,
  prevKyokuStep,
  prevStepIn,
  prevTurnStep,
  shantenTag,
  tileLabel,
  type Decision,
  type KyokuEnd,
  type MismatchKind,
  type ReplayScene,
  type ReplayTimeline,
  type Seat,
  type TimelineStep,
} from '@jantama/engine';

import { relationName } from '../study/labels';

/** 巡目の言い方。配牌（巡目 0）は「配牌」。 */
export function turnLabel(junme: number): string {
  return junme > 0 ? `${junme}巡目` : '配牌';
}

/** 局の名前の短い書き方（位置の帯の、狭いときの区間の名前）。例: 東2局 → 東2、東2局1本場 → 東2-1。 */
export function kyokuShortLabel(label: string): string {
  const match = /^(.)(\d)局(?:(\d+)本場)?$/.exec(label);
  if (match === null) return label;
  return `${match[1]}${match[2]}${match[3] === undefined ? '' : `-${match[3]}`}`;
}

/** 点の増減の書き方: +1,300 / −1,300（U+2212）/ ±0。 */
export function formatSigned(value: number): string {
  const sign = value > 0 ? '+' : value < 0 ? '−' : '±';
  return `${sign}${Math.abs(value).toLocaleString('ja-JP')}`;
}

/** 本人の席 `me` から見た、席 `seat` の呼び名（自分・下家・対面・上家）。 */
export const seatName = relationName;

/**
 * 「いまの一手」の文。例: 「上家が 發 を切りました（ツモ切り）」「対面が 東 をポンしました」「この局が終わりました」。
 * 局の終わりは、文のあとに結果（`resultText`・点の増減）を別に出す。
 */
export function stepText(step: TimelineStep, me: Seat, kyokuLabel: string): string {
  const event = step.event;
  const who = step.actor === null ? '' : seatName(me, step.actor);
  const tile = (pai: string) => tileLabel(pai);
  switch (event.type) {
    case 'start_kyoku':
      return `${kyokuLabel}が始まりました（親は${seatName(me, event.oya)}）`;
    case 'tsumo':
      return `自分が ${tile(event.pai)} をツモりました`;
    case 'dahai':
      return `${who}が ${tile(event.pai)} を切りました${event.tsumogiri ? '（ツモ切り）' : ''}`;
    case 'reach':
      return `${who}がリーチを宣言しました`;
    case 'chi':
      return `${who}が ${seatName(me, event.target)}の ${tile(event.pai)} をチーしました`;
    case 'pon':
      return `${who}が ${seatName(me, event.target)}の ${tile(event.pai)} をポンしました`;
    case 'daiminkan':
      return `${who}が ${seatName(me, event.target)}の ${tile(event.pai)} を大明槓しました`;
    case 'kakan':
      return `${who}が ${tile(event.pai)} を加槓しました`;
    case 'ankan':
      return `${who}が ${tile(event.consumed[0] ?? '')} を暗槓しました`;
    case 'hora':
      return 'この局が終わりました';
    case 'ryukyoku':
      return '流局しました';
    default:
      return '';
  }
}

/** 局の結果の 1 行。例: 自分の和了（対面から）・放銃: 対面のロン・下家のツモ和了・流局。 */
export function resultText(end: KyokuEnd, me: Seat): string {
  const winners = end.winners.map((seat) => seatName(me, seat)).join('・');
  switch (end.kind) {
    case 'draw':
      return '流局';
    case 'win':
      return `自分の和了${end.ronFrom === null ? '（ツモ）' : `（${seatName(me, end.ronFrom)}から）`}`;
    case 'dealIn':
      return `放銃: ${winners}のロン`;
    case 'othersTsumo':
      return `${winners}のツモ和了`;
    case 'othersRon':
      return `${winners}のロン${end.ronFrom === null ? '' : `（${seatName(me, end.ronFrom)}から）`}`;
  }
}

/** 点の増減（自分から、下家・対面・上家の順）。 */
export function deltaItems(end: KyokuEnd, me: Seat): Array<{ name: string; text: string; mine: boolean }> {
  return [0, 1, 2, 3].map((offset) => {
    const seat = ((me + offset) % 4) as Seat;
    return { name: seatName(me, seat), text: `${seatName(me, seat)} ${formatSigned(end.deltas[seat] ?? 0)}`, mine: offset === 0 };
  });
}

/** 不一致の名前。確率が基準未満は「大きな不一致」（R10-4）、AI の1位と違うだけのものは「不一致」。 */
export function mismatchName(kind: MismatchKind): string {
  return kind === 'big' ? '大きな不一致' : '不一致';
}

/** 場面の見出しに出す札（迷いと不一致）。例: 迷い1・2、大きな不一致。 */
export function sceneTags(scene: Pick<ReplayScene, 'doubts' | 'mismatch'>): Array<{ kind: 'doubt' | 'mis'; text: string }> {
  const tags: Array<{ kind: 'doubt' | 'mis'; text: string }> = [];
  if (scene.doubts.length > 0) tags.push({ kind: 'doubt', text: `迷い${scene.doubts.join('・')}` });
  if (scene.mismatch !== null) tags.push({ kind: 'mis', text: mismatchName(scene.mismatch) });
  return tags;
}

/** 場面の一覧の行の 2 行目。例: 打牌 · 1向聴。 */
export function sceneSubText(decision: Pick<Decision, 'kind' | 'shanten'>, kindName: string): string {
  return `${kindName} · ${shantenTag(decision.shanten)}`;
}

/** 局の選択に出す、その局の迷いと不一致の数。例: 迷い1 · 不一致2。無ければ空。 */
export function kyokuCounts(timeline: ReplayTimeline, scenes: readonly ReplayScene[], position: number): string {
  const inKyoku = scenes.filter((scene) => timeline.steps[scene.step]?.kyokuPosition === position);
  const doubts = inKyoku.filter((scene) => scene.doubts.length > 0).length;
  const mismatches = inKyoku.filter((scene) => scene.mismatch !== null).length;
  return [doubts > 0 ? `迷い${doubts}` : '', mismatches > 0 ? `不一致${mismatches}` : ''].filter((text) => text !== '').join(' · ');
}

// ---- 卓の大きさ（窓の高さが足りないとき、小さい配置にする） ----

/**
 * 卓が大きい配置のとき、見出し・操作の段・卓の上の 1 行（盤面の見方）・手牌（と、その上の棒の帯・下の印の行）をのぞいて、卓に使える高さを決める「卓の外の高さ」（px）。
 * replay.css の `.rp` の `--chrome-h` と同じ値（変えるときは両方）。
 */
export const TABLE_CHROME_PX = 476;

/** 手牌の下に残す余白（px）。主の欄の下の余白（28px）のぶん、手牌が窓の下の端にくっつかないように。 */
export const TABLE_BOTTOM_SLACK_PX = 24;

/**
 * 他家の手牌の帯（対面の手牌の上の段）の厚さ（河の牌の幅の何倍か）。quiz.css の `--hk`（`--hf` × 4 / 3）と同じ値。
 * 卓の高さは、この帯 1 本と、その隙間（`--g`）の分だけ高くなる（左右の帯は、幅だけに足す）。
 */
export const TABLE_HAND_BAND = (0.76 * 4) / 3;

/** 大きい配置の卓の、牌の幅の下限（px）。これより小さくなると、卓の中央の文字が重なる（quiz.css の `--rw` の下限と同じ）。 */
export const TABLE_TILE_MIN_PX = 36;

/**
 * 窓の高さがこれより低いとき、卓を小さい配置にする（局・本場・残り・ドラ表示牌を卓の上の 1 行にして、牌を小さくする）。
 * 大きい配置は、窓の高さから牌の幅を決めるが、下限（36px）より小さくはできないので、河の段が多い局ほど高い窓が要る。
 * `rows` は河の段の数（6 枚で折り返す。最低 2）、`riichiAny` はリーチ宣言牌（横向き）の分の余白があるか（quiz.css の `--kwy`・`--cwy` と同じ式）。
 */
export function compactBelowHeight(rows: number, riichiAny: boolean): number {
  // 高さ: --kwy = --kw + --g（手牌の帯の隙間）、--cwy = --cw + --hk（手牌の帯）
  const kw = 2 * 12 + 4 * 8 + 2 * rows + 3 + 8;
  const cw = 6 + (rows * 8) / 3 + (riichiAny ? 1 / 3 : 0) + TABLE_HAND_BAND;
  return Math.ceil(TABLE_CHROME_PX + kw + TABLE_TILE_MIN_PX * cw + TABLE_BOTTOM_SLACK_PX);
}

// ---- 行き先（どの操作も、いまの手 `g` からの行き先の手の通し番号。無ければ null） ----

/** 迷い・不一致・自分の判断がある手の通し番号（昇順）。 */
export interface ReplayStops {
  decisions: number[];
  doubts: number[];
  mismatches: number[];
}

export function replayStops(timeline: ReplayTimeline, scenes: readonly ReplayScene[]): ReplayStops {
  return {
    decisions: decisionSteps(timeline),
    doubts: scenes.filter((scene) => scene.doubts.length > 0).map((scene) => scene.step),
    mismatches: scenes.filter((scene) => scene.mismatch !== null).map((scene) => scene.step),
  };
}

/** 操作ごとの行き先。キーの操作の名前（`ReplayAction`）と同じ並びの名前。 */
export interface ReplayNav {
  step_back: number | null;
  step_forward: number | null;
  prev_decision: number | null;
  next_decision: number | null;
  prev_mismatch: number | null;
  next_mismatch: number | null;
  prev_doubt: number | null;
  next_doubt: number | null;
  prev_kyoku: number | null;
  next_kyoku: number | null;
  prev_turn: number | null;
  next_turn: number | null;
  kyoku_start: number | null;
  kyoku_end: number | null;
  /** これより後ろの迷い・不一致の数（「次の…へ」の数）。 */
  doubtsAhead: number;
  mismatchesAhead: number;
}

export function replayNav(timeline: ReplayTimeline, stops: ReplayStops, g: number): ReplayNav {
  const step = timeline.steps[g];
  const kyoku = step === undefined ? undefined : timeline.kyokus[step.kyokuPosition];
  const last = timeline.steps.length - 1;
  return {
    step_back: g > 0 ? g - 1 : null,
    step_forward: g < last ? g + 1 : null,
    prev_decision: prevStepIn(stops.decisions, g),
    next_decision: nextStepIn(stops.decisions, g),
    prev_mismatch: prevStepIn(stops.mismatches, g),
    next_mismatch: nextStepIn(stops.mismatches, g),
    prev_doubt: prevStepIn(stops.doubts, g),
    next_doubt: nextStepIn(stops.doubts, g),
    prev_kyoku: prevKyokuStep(timeline, g),
    next_kyoku: nextKyokuStep(timeline, g),
    prev_turn: prevTurnStep(timeline, g),
    next_turn: nextTurnStep(timeline, g),
    kyoku_start: kyoku === undefined || g === kyoku.first ? null : kyoku.first,
    kyoku_end: kyoku === undefined || g === kyoku.last ? null : kyoku.last,
    doubtsAhead: countAfter(stops.doubts, g),
    mismatchesAhead: countAfter(stops.mismatches, g),
  };
}
